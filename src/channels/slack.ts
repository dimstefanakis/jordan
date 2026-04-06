import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { storeMessage, updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  SendFileOptions,
  SendMessageOptions,
  SendReactionOptions,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const OWN_MESSAGE_CACHE_TTL_MS = 15 * 60 * 1000;
const IGNORED_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'message_changed',
  'message_deleted',
  'message_replied',
  'pinned_item',
  'unpinned_item',
]);

// Bolt delivers all message subtypes via app.event('message'). We ignore only known
// noisy/system subtypes and keep anything with meaningful text, files, or attachments.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

interface SlackFileLike {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  file_access?: string;
}

interface SlackAttachmentLike {
  fallback?: string;
  pretext?: string;
  title?: string;
  title_link?: string;
  text?: string;
  from_url?: string;
  image_url?: string;
  thumb_url?: string;
  service_name?: string;
}

type SlackMessageEventLike = HandledMessageEvent & {
  subtype?: string;
  hidden?: boolean;
  channel: string;
  channel_type?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFileLike[];
  attachments?: SlackAttachmentLike[];
};

export type SlackChannelOpts = ChannelOpts;

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private botId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    options?: SendMessageOptions;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private recentOwnMessageIds = new Map<string, number>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }
    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      const msg = event as SlackMessageEventLike;
      if (!this.shouldHandleMessage(msg)) return;

      // Threaded replies stay in the channel's conversation state, but retain
      // their thread_ts so outbound responses can route back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group) return;

      const isOwnBotMessage = this.isOwnBotMessage(msg);

      let senderName: string;
      if (isOwnBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.username ||
          msg.bot_id ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text ?? '';
      if (this.botUserId && msg.subtype !== 'bot_message') {
        const mentionPattern = `<@${this.botUserId}>`;
        if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      content = await this.buildMessageContent(msg, group.folder, content);
      if (!content) return;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        thread_ts: msg.thread_ts || undefined,
        is_from_me: isOwnBotMessage,
        is_bot_message: isOwnBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = (auth as { bot_id?: string }).bot_id;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn(
        { err },
        'Connected to Slack but failed to get bot user ID',
      );
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text, options });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.postMessage(channelId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.postMessage(
            channelId,
            text.slice(i, i + MAX_MESSAGE_LENGTH),
            options,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, options });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async sendReaction(
    jid: string,
    emoji: string,
    options: SendReactionOptions,
  ): Promise<void> {
    if (!this.connected) {
      throw new Error('Slack is not connected');
    }

    const channelId = jid.replace(/^slack:/, '');
    const name = emoji.replace(/^:|:$/g, '').trim();
    if (!name) throw new Error('Reaction emoji is required');

    await this.app.client.reactions.add({
      channel: channelId,
      name,
      timestamp: options.messageId,
    });

    logger.info(
      { jid, messageId: options.messageId, emoji: name },
      'Slack reaction sent',
    );
  }

  async sendFile(
    jid: string,
    filePath: string,
    options?: SendFileOptions,
  ): Promise<void> {
    if (!this.connected) {
      throw new Error('Slack is not connected');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const channelId = jid.replace(/^slack:/, '');
    const filename = options?.filename || path.basename(filePath);

    const baseUploadArgs = {
      channel_id: channelId,
      file: filePath,
      filename,
    };
    const sharedArgs = {
      ...(options?.title ? { title: options.title } : {}),
      ...(options?.initialComment
        ? { initial_comment: options.initialComment }
        : {}),
    };

    if (options?.threadTs) {
      await this.app.client.files.uploadV2({
        ...baseUploadArgs,
        ...sharedArgs,
        thread_ts: options.threadTs,
      });
    } else {
      await this.app.client.files.uploadV2({
        ...baseUploadArgs,
        ...sharedArgs,
      });
    }

    logger.info({ jid, filePath, filename }, 'Slack file uploaded');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async syncGroups(_force: boolean): Promise<void> {
    await this.syncChannelMetadata();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(
    userId: string,
  ): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.postMessage(channelId, item.text, item.options);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  private async postMessage(
    channelId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(options?.threadTs ? { thread_ts: options.threadTs } : {}),
    });
    if (typeof result.ts === 'string') {
      this.rememberOwnMessageId(result.ts);
      storeMessage({
        id: result.ts,
        chat_jid: `slack:${channelId}`,
        sender: this.botUserId || this.botId || '',
        sender_name: ASSISTANT_NAME,
        content: text,
        timestamp: new Date(parseFloat(result.ts) * 1000).toISOString(),
        thread_ts: options?.threadTs,
        is_from_me: true,
        is_bot_message: true,
      });
    }
  }

  private isOwnBotMessage(msg: SlackMessageEventLike): boolean {
    if (this.isRecentlySentOwnMessage(msg.ts)) return true;
    if (msg.user && this.botUserId && msg.user === this.botUserId) return true;
    if (msg.bot_id && this.botId && msg.bot_id === this.botId) return true;
    // If auth.test() failed or omitted bot_id, conservatively treat anonymous
    // bot_message payloads as our own to avoid self-trigger loops.
    if (msg.subtype === 'bot_message' && msg.bot_id && !this.botId) return true;
    return false;
  }

  private shouldHandleMessage(msg: SlackMessageEventLike): boolean {
    if (msg.hidden) return false;
    if (msg.subtype && IGNORED_SUBTYPES.has(msg.subtype)) return false;
    return this.hasMeaningfulContent(msg);
  }

  private hasMeaningfulContent(msg: SlackMessageEventLike): boolean {
    return Boolean(
      (msg.text && msg.text.trim()) ||
        (msg.files && msg.files.length > 0) ||
        (msg.attachments && msg.attachments.length > 0),
    );
  }

  private async buildMessageContent(
    msg: SlackMessageEventLike,
    groupFolder: string,
    baseText: string,
  ): Promise<string> {
    const sections: string[] = [];
    const text = baseText;
    if (text.trim()) sections.push(text);

    const fileLines = await this.describeFiles(msg.files || [], groupFolder);
    const attachmentLines = this.describeAttachments(msg.attachments || []);
    const leadingAttachmentTrigger =
      !text.trim() &&
      attachmentLines.length > 0 &&
      TRIGGER_PATTERN.test(attachmentLines[0].trim())
        ? attachmentLines.shift()
        : !text.trim()
          ? this.findLeadingAttachmentTrigger(msg.attachments || [])
          : undefined;

    if (leadingAttachmentTrigger) {
      sections.push(leadingAttachmentTrigger);
    }

    if (fileLines.length > 0) {
      sections.push(`Slack files:\n${fileLines.map((line) => `- ${line}`).join('\n')}`);
    }

    if (attachmentLines.length > 0) {
      sections.push(
        `Slack attachments:\n${attachmentLines.map((line) => `- ${line}`).join('\n')}`,
      );
    }

    return sections.join('\n\n');
  }

  private async describeFiles(
    files: SlackFileLike[],
    groupFolder: string,
  ): Promise<string[]> {
    const lines: string[] = [];

    for (const file of files) {
      const details = await this.resolveFileDetails(file, groupFolder);
      const parts = [details.label];
      if (details.mimetype) parts.push(details.mimetype);
      if (typeof details.size === 'number') parts.push(`${details.size} bytes`);
      if (details.savedPath) parts.push(`saved to ${details.savedPath}`);
      if (details.note) parts.push(details.note);
      if (details.permalink) parts.push(`link: ${details.permalink}`);
      lines.push(parts.join(' — '));
    }

    return lines;
  }

  private async resolveFileDetails(
    file: SlackFileLike,
    groupFolder: string,
  ): Promise<{
    label: string;
    mimetype?: string;
    size?: number;
    savedPath?: string;
    permalink?: string;
    note?: string;
  }> {
    const fileId = file.id || 'slack-file';
    const filename = this.sanitizeFileName(
      file.name || file.title || `${fileId}.bin`,
    );
    const label = `File "${filename}"`;
    const download = await this.downloadFileIfNeeded(file, groupFolder, filename);

    return {
      label,
      mimetype: file.mimetype || file.filetype,
      size: file.size,
      savedPath: download.savedPath,
      permalink: file.permalink,
      note: download.note,
    };
  }

  private async downloadFileIfNeeded(
    file: SlackFileLike,
    groupFolder: string,
    filename: string,
  ): Promise<{ savedPath?: string; note?: string }> {
    const fileId = this.sanitizeFileName(file.id || 'slack-file');
    const relativePath = path.join('incoming', 'slack', fileId, filename);
    const hostPath = path.join(resolveGroupFolderPath(groupFolder), relativePath);
    const containerPath = this.toContainerGroupPath(relativePath);

    if (fs.existsSync(hostPath)) {
      return { savedPath: containerPath };
    }

    if (typeof file.size === 'number' && file.size > MAX_DOWNLOAD_BYTES) {
      return {
        note: `not downloaded (over ${MAX_DOWNLOAD_BYTES} bytes limit)`,
      };
    }

    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      return {
        note:
          file.file_access === 'check_file_info'
            ? 'not downloaded (Slack requires additional file lookup)'
            : 'not downloaded (no download URL available)',
      };
    }

    try {
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${this.botToken}`,
        },
      });

      if (!response.ok) {
        return {
          note: `download failed (${response.status} ${response.statusText})`,
        };
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_DOWNLOAD_BYTES) {
        return {
          note: `not downloaded (over ${MAX_DOWNLOAD_BYTES} bytes limit)`,
        };
      }

      fs.writeFileSync(hostPath, buffer);
      return { savedPath: containerPath };
    } catch (err) {
      logger.warn(
        { err, fileId: file.id, groupFolder },
        'Failed to download Slack file',
      );
      return { note: 'download failed' };
    }
  }

  private describeAttachments(attachments: SlackAttachmentLike[]): string[] {
    return attachments
      .map((attachment) => {
        const parts = [
          attachment.title,
          attachment.pretext,
          attachment.text,
          attachment.fallback,
        ]
          .map((value) => this.normalizeSummaryText(value))
          .filter(Boolean);

        const meta = [
          attachment.service_name ? `service: ${attachment.service_name}` : null,
          attachment.title_link || attachment.from_url
            ? `link: ${attachment.title_link || attachment.from_url}`
            : null,
          attachment.image_url ? `image: ${attachment.image_url}` : null,
          attachment.thumb_url ? `thumbnail: ${attachment.thumb_url}` : null,
        ].filter(Boolean);

        const combined = [...parts, ...meta].join(' — ');
        return combined || null;
      })
      .filter((line): line is string => Boolean(line));
  }

  private findLeadingAttachmentTrigger(
    attachments: SlackAttachmentLike[],
  ): string | undefined {
    for (const attachment of attachments) {
      const fields = [
        attachment.title,
        attachment.pretext,
        attachment.text,
        attachment.fallback,
      ];
      for (const field of fields) {
        const normalized = this.normalizeSummaryText(field);
        if (normalized && TRIGGER_PATTERN.test(normalized.trim())) {
          return normalized;
        }
      }
    }
    return undefined;
  }

  private normalizeSummaryText(text?: string): string {
    if (!text) return '';
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private rememberOwnMessageId(messageId: string): void {
    this.pruneRecentOwnMessageIds();
    this.recentOwnMessageIds.set(
      messageId,
      Date.now() + OWN_MESSAGE_CACHE_TTL_MS,
    );
  }

  private isRecentlySentOwnMessage(messageId: string): boolean {
    this.pruneRecentOwnMessageIds();
    const expiresAt = this.recentOwnMessageIds.get(messageId);
    return typeof expiresAt === 'number' && expiresAt > Date.now();
  }

  private pruneRecentOwnMessageIds(): void {
    const now = Date.now();
    for (const [messageId, expiresAt] of this.recentOwnMessageIds.entries()) {
      if (expiresAt <= now) {
        this.recentOwnMessageIds.delete(messageId);
      }
    }
  }

  private sanitizeFileName(name: string): string {
    const normalized = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || 'file';
  }

  private toContainerGroupPath(relativePath: string): string {
    const posixPath = relativePath.split(path.sep).join('/');
    return `/workspace/group/${posixPath}`;
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
    return null;
  }
  return new SlackChannel(opts);
});
