import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only by the
// credential proxy or container-runner, never exposed broadly to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ATLAS_MODEL',
  'REFLECT_ENABLED',
  'REFLECT_MIN_HOURS',
  'REFLECT_MIN_MESSAGES',
  'REFLECT_MODEL',
  'REFLECT_POLL_INTERVAL_MS',
  'SLACK_ONLY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Jordan';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const ATLAS_MODEL =
  process.env.ATLAS_MODEL || envConfig.ATLAS_MODEL || 'claude-sonnet-4-6';
export const REFLECT_ENABLED =
  (process.env.REFLECT_ENABLED || envConfig.REFLECT_ENABLED || 'true') ===
  'true';
export const REFLECT_MIN_HOURS = Math.max(
  1,
  parseInt(
    process.env.REFLECT_MIN_HOURS || envConfig.REFLECT_MIN_HOURS || '24',
    10,
  ) || 24,
);
export const REFLECT_MIN_MESSAGES = Math.max(
  1,
  parseInt(
    process.env.REFLECT_MIN_MESSAGES || envConfig.REFLECT_MIN_MESSAGES || '20',
    10,
  ) || 20,
);
export const REFLECT_MODEL =
  process.env.REFLECT_MODEL || envConfig.REFLECT_MODEL || 'claude-sonnet-4-6';
export const REFLECT_POLL_INTERVAL = parseInt(
  process.env.REFLECT_POLL_INTERVAL_MS ||
    envConfig.REFLECT_POLL_INTERVAL_MS ||
    '1800000',
  10,
);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const SLACK_ONLY =
  (process.env.SLACK_ONLY || envConfig.SLACK_ONLY) === 'true';
