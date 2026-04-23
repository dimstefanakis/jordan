/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { ASSISTANT_NAME, STORE_DIR } from '../src/config.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

export const ASSISTANT_NAME_PLACEHOLDER = '{{ASSISTANT_NAME}}';

const LEGACY_ASSISTANT_NAMES = ['Jordan', 'Nora'];

export function resolveRegistrationFolder(
  args: Pick<RegisterArgs, 'jid' | 'folder' | 'channel' | 'isMain'>,
  existingMainOwnerJid?: string,
): string {
  if (
    args.isMain &&
    args.channel === 'slack' &&
    args.folder === 'slack_main' &&
    (!existingMainOwnerJid || existingMainOwnerJid === args.jid)
  ) {
    return 'main';
  }

  return args.folder;
}

export function applyAssistantNameTemplate(
  content: string,
  assistantName: string,
): string {
  let next = content.replaceAll(ASSISTANT_NAME_PLACEHOLDER, assistantName);

  for (const legacyName of LEGACY_ASSISTANT_NAMES) {
    next = next.replaceAll(legacyName, assistantName);
  }

  return next;
}

export function upsertAssistantNameEnv(
  envContent: string,
  assistantName: string,
): string {
  if (envContent.includes('ASSISTANT_NAME=')) {
    return envContent.replace(
      /^ASSISTANT_NAME=.*$/m,
      `ASSISTANT_NAME="${assistantName}"`,
    );
  }

  const suffix = envContent.endsWith('\n') || envContent.length === 0 ? '' : '\n';
  return `${envContent}${suffix}ASSISTANT_NAME="${assistantName}"\n`;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: ASSISTANT_NAME,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = (args[++i] || '').trim() || ASSISTANT_NAME;
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.jid || !parsed.name || !parsed.trigger || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  logger.info(parsed, 'Registering channel');

  // Ensure data and store directories exist (store/ may not exist on
  // fresh installs that skip WhatsApp auth, which normally creates it)
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Write to SQLite using parameterized queries (no SQL injection)
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const timestamp = new Date().toISOString();
  const requiresTriggerInt = parsed.requiresTrigger ? 1 : 0;

  const db = new Database(dbPath);
  // Ensure schema exists
  db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1,
    is_main INTEGER DEFAULT 0
  )`);

  const isMainInt = parsed.isMain ? 1 : 0;
  const existingMainOwner = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .get('main') as { jid: string } | undefined;
  const resolvedFolder = resolveRegistrationFolder(
    parsed,
    existingMainOwner?.jid,
  );

  if (!isValidGroupFolder(resolvedFolder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (resolvedFolder !== parsed.folder) {
    logger.info(
      {
        requestedFolder: parsed.folder,
        resolvedFolder,
        channel: parsed.channel,
        isMain: parsed.isMain,
      },
      'Normalized registration folder',
    );
  }

  db.prepare(
    `INSERT OR REPLACE INTO registered_groups
     (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    parsed.jid,
    parsed.name,
    resolvedFolder,
    parsed.trigger,
    timestamp,
    requiresTriggerInt,
    isMainInt,
  );

  db.close();
  logger.info('Wrote registration to SQLite');

  // Create group folders
  fs.mkdirSync(path.join(projectRoot, 'groups', resolvedFolder, 'logs'), {
    recursive: true,
  });

  const assistantName = parsed.assistantName.trim() || ASSISTANT_NAME;
  let nameUpdated = false;

  logger.info({ assistantName }, 'Applying assistant name');

  const mdFiles = new Set([
    path.join(projectRoot, 'groups', 'main', 'CLAUDE.md'),
    path.join(projectRoot, 'groups', 'global', 'CLAUDE.md'),
    path.join(projectRoot, 'groups', resolvedFolder, 'CLAUDE.md'),
  ]);

  for (const mdFile of mdFiles) {
    if (!fs.existsSync(mdFile)) continue;

    const content = fs.readFileSync(mdFile, 'utf-8');
    const nextContent = applyAssistantNameTemplate(content, assistantName);
    if (nextContent === content) continue;

    fs.writeFileSync(mdFile, nextContent);
    logger.info({ file: mdFile }, 'Updated CLAUDE.md');
    nameUpdated = true;
  }

  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const nextEnvContent = upsertAssistantNameEnv(envContent, assistantName);
    if (nextEnvContent !== envContent) {
      fs.writeFileSync(envFile, nextEnvContent);
      nameUpdated = true;
    }
  } else {
    fs.writeFileSync(envFile, `ASSISTANT_NAME="${assistantName}"\n`);
    nameUpdated = true;
  }
  logger.info('Set ASSISTANT_NAME in .env');

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: resolvedFolder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
