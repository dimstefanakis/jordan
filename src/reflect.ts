import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  REFLECT_ENABLED,
  REFLECT_MIN_HOURS,
  REFLECT_MIN_MESSAGES,
  REFLECT_MODEL,
  REFLECT_POLL_INTERVAL,
  GROUPS_DIR,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  WritableProjectMount,
} from './container-runner.js';
import {
  getAllChats,
  getReflectMessagesSince,
  getLatestMessageTimestampForChats,
  getRouterState,
  getSession,
  setRouterState,
  setSession,
} from './db.js';
import { assertValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { escapeXml, formatOutbound } from './router.js';
import { NewMessage, RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

export const REFLECT_NAME = 'Reflect';
export const REFLECT_GROUP_FOLDER = 'reflect';
export const REFLECT_CHAT_JID = 'internal:reflect';
export const REFLECT_CURSOR_KEY = 'reflect.last_processed_timestamp';
export const REFLECT_LAST_RUN_AT_KEY = 'reflect.last_run_at';

const REFLECT_CLOSE_SENTINEL = path.join(
  resolveGroupIpcPath(REFLECT_GROUP_FOLDER),
  'input',
  '_close',
);
const REFLECT_BATCH_LIMIT = 200;

export interface ReflectDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ReflectTarget {
  folder: string;
  filePath: string;
  scope: string;
}

interface ReflectRunResult {
  summary: string;
  changedFiles: string[];
}

export function shouldRunReflect(
  pendingMessageCount: number,
  lastRunAt: string | undefined,
  nowMs: number,
  minMessages: number,
  minHours: number,
): boolean {
  if (pendingMessageCount <= 0) return false;
  if (pendingMessageCount >= minMessages) return true;
  if (!lastRunAt) return false;

  const lastRunMs = Date.parse(lastRunAt);
  if (Number.isNaN(lastRunMs)) return false;

  return nowMs - lastRunMs >= minHours * 3_600_000;
}

const REFLECT_GROUP: RegisteredGroup = {
  name: REFLECT_NAME,
  folder: REFLECT_GROUP_FOLDER,
  trigger: '@Reflect',
  added_at: new Date(0).toISOString(),
  requiresTrigger: false,
  isMain: true,
  containerConfig: {
    timeout: 45 * 60 * 1000,
  },
};

let reflectWatcherRunning = false;
let reflectRunInFlight = false;

function classifySender(message: NewMessage): string {
  if (message.sender.startsWith('internal:')) return 'internal';
  if (message.is_bot_message || message.is_from_me) return 'assistant';
  return 'human';
}

function buildChatNameMap(): Map<string, string> {
  return new Map(getAllChats().map((chat) => [chat.jid, chat.name]));
}

function findGroupFolderForChat(
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string {
  return registeredGroups[chatJid]?.folder || 'unregistered';
}

function renderRecentActivity(
  messages: NewMessage[],
  registeredGroups: Record<string, RegisteredGroup>,
): string {
  const chatNames = buildChatNameMap();

  const lines = messages.map((message) => {
    const attrs = [
      `group_folder="${escapeXml(
        findGroupFolderForChat(message.chat_jid, registeredGroups),
      )}"`,
      `chat_jid="${escapeXml(message.chat_jid)}"`,
      `chat_name="${escapeXml(chatNames.get(message.chat_jid) || message.chat_jid)}"`,
      `sender="${escapeXml(message.sender_name)}"`,
      `sender_kind="${classifySender(message)}"`,
      `time="${escapeXml(message.timestamp)}"`,
      `scope="${message.thread_ts && message.thread_ts !== message.id ? 'thread' : 'main'}"`,
    ];

    if (message.thread_ts) {
      attrs.push(`thread_ts="${escapeXml(message.thread_ts)}"`);
    }

    return `  <message ${attrs.join(' ')}>${escapeXml(message.content)}</message>`;
  });

  return ['<recent_activity>', ...lines, '</recent_activity>'].join('\n');
}

function getReflectTargets(): ReflectTarget[] {
  const targets: ReflectTarget[] = [];

  const mainClaudePath = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
  if (fs.existsSync(mainClaudePath)) {
    targets.push({
      folder: 'main',
      filePath: '/workspace/group/CLAUDE.md',
      scope: 'Jordan main Slack/admin lane memory',
    });
  }

  if (!fs.existsSync(GROUPS_DIR)) return targets;

  const folders = fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (folder) =>
        folder !== 'main' &&
        folder !== REFLECT_GROUP_FOLDER &&
        folder !== 'company_graph',
    )
    .sort();

  for (const folder of folders) {
    const claudePath = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) continue;

    targets.push({
      folder,
      filePath: `/workspace/project/groups/${folder}/CLAUDE.md`,
      scope:
        folder === 'global'
          ? 'shared/company memory across assistant surfaces'
          : `${folder} lane memory`,
    });
  }

  return targets;
}

function getReflectWritableMounts(
  targets: ReflectTarget[],
): WritableProjectMount[] {
  const mounts: WritableProjectMount[] = [];

  for (const target of targets) {
    if (target.folder === 'main') continue;

    const hostPath = path.join('groups', target.folder);
    const absoluteHostPath = path.join(GROUPS_DIR, target.folder);
    if (!fs.existsSync(absoluteHostPath)) continue;

    mounts.push({
      hostPath,
      containerPath: `/workspace/project/groups/${target.folder}`,
    });
  }

  return mounts;
}

function snapshotTargets(targets: ReflectTarget[]): Map<string, string> {
  const snapshot = new Map<string, string>();

  for (const target of targets) {
    const hostPath = path.join(GROUPS_DIR, target.folder, 'CLAUDE.md');
    if (!fs.existsSync(hostPath)) continue;
    const hash = createHash('sha1')
      .update(fs.readFileSync(hostPath))
      .digest('hex');
    snapshot.set(hostPath, hash);
  }

  return snapshot;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed = new Set<string>();

  for (const key of before.keys()) {
    if (before.get(key) !== after.get(key)) changed.add(key);
  }
  for (const key of after.keys()) {
    if (before.get(key) !== after.get(key)) changed.add(key);
  }

  return [...changed]
    .sort()
    .map((absolutePath) => path.relative(process.cwd(), absolutePath));
}

export function buildReflectPrompt(
  messages: NewMessage[],
  registeredGroups: Record<string, RegisteredGroup>,
  targets: ReflectTarget[],
): string {
  const targetLines = targets.map(
    (target) => `- \`${target.filePath}\` — ${target.scope}`,
  );

  return [
    '# Reflect: Memory Consolidation',
    '',
    `You are performing a reflect — a reflective pass over Jordan's CLAUDE memory files. Synthesize what you've learned recently into durable, well-scoped notes so future sessions can orient quickly.`,
    '',
    'Memory targets:',
    ...targetLines,
    '',
    'Recent activity stream: see the XML block below. It includes chat discussions, Jordan replies, and Atlas updates.',
    '',
    '---',
    '',
    '## Phase 1 - Orient',
    '',
    '- Read each target CLAUDE file before editing it so you improve what already exists rather than creating duplicates',
    '- Focus especially on the existing `### Reflect Notes` section and the marker block inside it',
    '- Keep each target scoped correctly: `main` for Jordan lane memory and `global` for cross-surface memory',
    '- Treat the company graph as canonical for durable product knowledge; memory files should hold concise reminders, boundaries, and workflow cues, not long duplicate docs',
    '',
    '## Phase 2 - Gather recent signal',
    '',
    '- Use the recent activity stream below as the primary source of new signal',
    '- Prioritize repeated patterns, durable clarifications, stable teammate conventions, and code-confirmed behavior over one-off conversation details',
    '- If code truth matters, inspect `/workspace/project` directly before writing memory',
    '- If durable product/process knowledge belongs in the company graph, call `ask_atlas` so the graph is updated alongside memory when needed',
    "- Don't exhaustively investigate every message; look for things that already seem worth remembering",
    '',
    '## Phase 3 - Consolidate',
    '',
    '- Update only the bounded `<!-- REFLECT:START -->` and `<!-- REFLECT:END -->` blocks when they exist',
    '- If a relevant CLAUDE file truly needs a background-maintained block and does not have one yet, add a small `### Reflect Notes` section near its memory area instead of rewriting the whole file',
    '- Merge new signal into existing bullets rather than creating near-duplicates',
    '- Convert relative dates into absolute dates when the date matters later',
    '- Do not store one-off ticket facts, temporary incidents, raw transcript dumps, or secrets',
    '',
    '## Phase 4 - Prune and align',
    '',
    '- Remove stale or contradicted notes when stronger evidence exists',
    '- Keep the notes concise and durable rather than exhaustive',
    '- Resolve scope drift: move cross-surface guidance into `global`, keep lane-specific guidance out of shared memory',
    '- Do not rewrite unrelated prompt instructions or broad sections of the CLAUDE files',
    '',
    `## Recent activity (${messages.length} messages, oldest to newest)`,
    renderRecentActivity(messages, registeredGroups),
    '',
    'When you finish, respond with exactly these sections:',
    'Status: updated | no_changes | needs_human',
    'Why:',
    'Code inspected: yes | no',
    'Atlas consulted: yes | no',
    'Changed files:',
    'Summary:',
  ].join('\n');
}

async function stopRunningContainer(
  containerName: string | null,
): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(REFLECT_CLOSE_SENTINEL), {
      recursive: true,
    });
    fs.writeFileSync(REFLECT_CLOSE_SENTINEL, '');
  } catch (error) {
    logger.debug(
      { err: error, path: REFLECT_CLOSE_SENTINEL },
      'Failed to write Reflect close sentinel',
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));

  if (!containerName) return;

  try {
    await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', containerName],
      { timeout: 10_000 },
    );
  } catch (error) {
    logger.debug({ err: error, containerName }, 'Fast Reflect stop failed');
    try {
      await execFileAsync(CONTAINER_RUNTIME_BIN, ['kill', containerName], {
        timeout: 10_000,
      });
    } catch (killError) {
      logger.debug(
        { err: killError, containerName },
        'Failed to kill Reflect container after first result',
      );
    }
  }
}

async function runReflect(
  messages: NewMessage[],
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<ReflectRunResult> {
  const targets = getReflectTargets();
  const before = snapshotTargets(targets);
  const prompt = buildReflectPrompt(messages, registeredGroups, targets);
  const sessionId = getSession(REFLECT_GROUP_FOLDER);
  let settled = false;
  let containerName: string | null = null;

  const summary = await new Promise<string>((resolve, reject) => {
    void runContainerAgent(
      REFLECT_GROUP,
      {
        prompt,
        sessionId,
        sessionNamespace: REFLECT_GROUP_FOLDER,
        groupFolder: REFLECT_GROUP.folder,
        chatJid: REFLECT_CHAT_JID,
        isMain: true,
        assistantName: REFLECT_NAME,
        model: REFLECT_MODEL,
        writableProjectMounts: getReflectWritableMounts(targets),
      },
      (_proc, spawnedContainerName) => {
        containerName = spawnedContainerName;
      },
      async (output: ContainerOutput) => {
        if (output.newSessionId) {
          setSession(REFLECT_GROUP_FOLDER, output.newSessionId);
        }

        if (settled) return;

        if (output.status === 'error') {
          settled = true;
          await stopRunningContainer(containerName);
          reject(new Error(output.error || 'Reflect failed'));
          return;
        }

        if (output.result !== null) {
          settled = true;
          await stopRunningContainer(containerName);
          resolve(formatOutbound(output.result).trim());
        }
      },
    )
      .then(async (output) => {
        if (output.newSessionId) {
          setSession(REFLECT_GROUP_FOLDER, output.newSessionId);
        }

        if (settled) return;
        settled = true;

        if (output.status === 'error') {
          reject(new Error(output.error || 'Reflect failed'));
          return;
        }

        await stopRunningContainer(containerName);
        resolve(formatOutbound(output.result || '').trim());
      })
      .catch(async (error) => {
        if (settled) return;
        settled = true;
        await stopRunningContainer(containerName);
        reject(error);
      });
  });

  const after = snapshotTargets(targets);
  return {
    summary,
    changedFiles: diffSnapshots(before, after),
  };
}

async function tickReflect(
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  const chatJids = Object.keys(registeredGroups);
  if (chatJids.length === 0) return;

  const cursor = getRouterState(REFLECT_CURSOR_KEY) || '';
  if (!cursor) {
    const latestTimestamp = getLatestMessageTimestampForChats(chatJids);
    if (latestTimestamp) {
      setRouterState(REFLECT_CURSOR_KEY, latestTimestamp);
      setRouterState(REFLECT_LAST_RUN_AT_KEY, new Date().toISOString());
      logger.info(
        { latestTimestamp },
        'Initialized Reflect cursor without backfilling history',
      );
    }
    return;
  }

  const messages = getReflectMessagesSince(
    chatJids,
    cursor,
    REFLECT_BATCH_LIMIT,
  );
  const lastRunAt = getRouterState(REFLECT_LAST_RUN_AT_KEY);
  const shouldRun = shouldRunReflect(
    messages.length,
    lastRunAt,
    Date.now(),
    REFLECT_MIN_MESSAGES,
    REFLECT_MIN_HOURS,
  );
  if (!shouldRun) return;
  if (reflectRunInFlight) {
    logger.debug('Reflect run already in flight, skipping overlapping tick');
    return;
  }

  reflectRunInFlight = true;
  try {
    const result = await runReflect(messages, registeredGroups);
    const newestTimestamp = messages[messages.length - 1]?.timestamp;
    if (newestTimestamp) {
      setRouterState(REFLECT_CURSOR_KEY, newestTimestamp);
    }
    setRouterState(REFLECT_LAST_RUN_AT_KEY, new Date().toISOString());

    logger.info(
      {
        lastRunAt,
        messageCount: messages.length,
        changedFiles: result.changedFiles,
        newestTimestamp,
      },
      'Reflect completed',
    );
    if (result.summary) {
      logger.debug({ summary: result.summary }, 'Reflect summary');
    }
  } finally {
    reflectRunInFlight = false;
  }
}

export function startReflect(deps: ReflectDeps): void {
  if (!REFLECT_ENABLED) {
    logger.info('Reflect disabled');
    return;
  }
  if (reflectWatcherRunning) {
    logger.debug('Reflect already running, skipping duplicate start');
    return;
  }

  assertValidGroupFolder(REFLECT_GROUP_FOLDER);
  reflectWatcherRunning = true;

  const tick = async () => {
    try {
      await tickReflect(deps.registeredGroups());
    } catch (err) {
      logger.error({ err }, 'Reflect tick failed');
    }

    setTimeout(tick, REFLECT_POLL_INTERVAL);
  };

  void tick();
  logger.info(
    {
      minHours: REFLECT_MIN_HOURS,
      pollIntervalMs: REFLECT_POLL_INTERVAL,
      minMessages: REFLECT_MIN_MESSAGES,
    },
    'Reflect started',
  );
}
