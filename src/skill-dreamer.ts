import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  SKILL_DREAMER_AUTOPROMOTE,
  SKILL_DREAMER_BACKFILL_ON_FIRST_RUN,
  SKILL_DREAMER_ENABLED,
  SKILL_DREAMER_MIN_HOURS,
  SKILL_DREAMER_MIN_OUTCOMES,
  SKILL_DREAMER_MODEL,
  SKILL_DREAMER_POLL_INTERVAL,
  SKILL_DREAMER_RETENTION_DAYS,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  WritableProjectMount,
} from './container-runner.js';
import {
  getAgentTaskOutcomesSince,
  getLatestAgentTaskOutcomeCompletedAt,
  getRouterState,
  getSession,
  setRouterState,
  setSession,
} from './db.js';
import { assertValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { escapeXml, formatOutbound } from './router.js';
import { AgentTaskOutcome, RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

export const SKILL_DREAMER_NAME = 'Skill Dreamer';
export const SKILL_DREAMER_GROUP_FOLDER = 'skill-dreamer';
export const SKILL_DREAMER_CHAT_JID = 'internal:skill-dreamer';
export const SKILL_DREAMER_CURSOR_KEY =
  'skill_dreamer.last_processed_completed_at';
export const SKILL_DREAMER_LAST_RUN_AT_KEY = 'skill_dreamer.last_run_at';
export const SKILL_DREAMER_ROOT = path.join(
  process.cwd(),
  '.nanoclaw',
  'skill-dreams',
);

const SKILL_DREAMER_CLOSE_SENTINEL = path.join(
  resolveGroupIpcPath(SKILL_DREAMER_GROUP_FOLDER),
  'input',
  '_close',
);
const SKILL_DREAMER_BATCH_LIMIT = 80;
const PROMPT_SNIPPET_LIMIT = 3_500;
const ACTIVE_SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_SKILL_MD_CHARS = 100_000;
const MAX_SKILL_FILE_BYTES = 1_048_576;
const MAX_SKILL_TOTAL_BYTES = 2 * 1_048_576;
const ALLOWED_SKILL_CHILDREN = new Set([
  'SKILL.md',
  'EVIDENCE.md',
  'references',
  'templates',
  'scripts',
  'assets',
]);
const SUPPORTING_DIRS = new Set([
  'references',
  'templates',
  'scripts',
  'assets',
]);

export type SkillDreamActionKind =
  | 'promoted'
  | 'patched'
  | 'rejected'
  | 'skipped';

export interface SkillDreamAction {
  kind: SkillDreamActionKind;
  skillName: string;
  sourcePath: string;
  targetPath?: string;
  reason: string;
  at: string;
}

interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  name?: string;
  description?: string;
}

export interface ApplySkillDreamOptions {
  dreamRoot?: string;
  activeSkillsDir?: string;
  autoPromote?: boolean;
  retentionDays?: number;
  now?: Date;
}

export interface SkillSummary {
  name: string;
  description: string;
  filePath: string;
}

interface SkillDreamRunResult {
  summary: string;
  changedFiles: string[];
}

export interface SkillDreamerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const SKILL_DREAMER_GROUP: RegisteredGroup = {
  name: SKILL_DREAMER_NAME,
  folder: SKILL_DREAMER_GROUP_FOLDER,
  trigger: '@SkillDreamer',
  added_at: new Date(0).toISOString(),
  requiresTrigger: false,
  isMain: true,
  containerConfig: {
    timeout: 45 * 60 * 1000,
  },
};

let skillDreamerWatcherRunning = false;
let skillDreamerRunInFlight = false;

export function shouldRunSkillDreamer(
  pendingOutcomeCount: number,
  lastRunAt: string | undefined,
  nowMs: number,
  minOutcomes: number,
  minHours: number,
): boolean {
  if (pendingOutcomeCount <= 0) return false;
  if (pendingOutcomeCount >= minOutcomes) return true;
  if (!lastRunAt) return false;

  const lastRunMs = Date.parse(lastRunAt);
  if (Number.isNaN(lastRunMs)) return false;

  return nowMs - lastRunMs >= minHours * 3_600_000;
}

function truncateForPrompt(value: string | null): string {
  if (!value) return '';
  if (value.length <= PROMPT_SNIPPET_LIMIT) return value;
  return `${value.slice(0, PROMPT_SNIPPET_LIMIT)}\n[truncated]`;
}

function renderOutcomes(outcomes: AgentTaskOutcome[]): string {
  const lines = outcomes.map((outcome) => {
    const attrs = [
      `id="${outcome.id ?? ''}"`,
      `source="${escapeXml(outcome.source)}"`,
      `group_folder="${escapeXml(outcome.group_folder)}"`,
      `chat_jid="${escapeXml(outcome.chat_jid)}"`,
      `status="${escapeXml(outcome.status)}"`,
      `started_at="${escapeXml(outcome.started_at)}"`,
      `completed_at="${escapeXml(outcome.completed_at)}"`,
      `duration_ms="${outcome.duration_ms}"`,
    ];
    if (outcome.task_id) {
      attrs.push(`task_id="${escapeXml(outcome.task_id)}"`);
    }

    return [
      `  <outcome ${attrs.join(' ')}>`,
      `    <prompt>${escapeXml(truncateForPrompt(outcome.prompt))}</prompt>`,
      `    <result>${escapeXml(truncateForPrompt(outcome.result))}</result>`,
      '  </outcome>',
    ].join('\n');
  });

  return ['<successful_outcomes>', ...lines, '</successful_outcomes>'].join(
    '\n',
  );
}

function readFrontmatterField(content: string, field: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';

  const fieldMatch = match[1].match(
    new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm'),
  );
  return fieldMatch?.[1]?.replace(/^['"]|['"]$/g, '').trim() || '';
}

function collectSkillSummaries(root: string): SkillSummary[] {
  if (!fs.existsSync(root)) return [];

  const summaries: SkillSummary[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      summaries.push({
        name: readFrontmatterField(content, 'name') || path.basename(dir),
        description: readFrontmatterField(content, 'description'),
        filePath: `/workspace/project/${path.relative(process.cwd(), fullPath)}`,
      });
    }
  };

  visit(root);
  return summaries.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function renderSkillSummaries(
  title: string,
  summaries: SkillSummary[],
): string[] {
  if (summaries.length === 0) return [title, '- none'];

  return [
    title,
    ...summaries.map(
      (summary) =>
        `- \`${summary.name}\` (${summary.filePath}) — ${summary.description || 'no description'}`,
    ),
  ];
}

export function buildSkillDreamPrompt(
  outcomes: AgentTaskOutcome[],
  activeSkills: SkillSummary[] = collectSkillSummaries(
    path.join(process.cwd(), 'container', 'skills'),
  ),
  draftSkills: SkillSummary[] = collectSkillSummaries(
    path.join(SKILL_DREAMER_ROOT, 'drafts'),
  ),
): string {
  return [
    '# Skill Dreamer: Autonomous Procedural Memory',
    '',
    'Role:',
    '- You are Skill Dreamer, a background reflective pass over recent successful agent outcomes. Your job is to preserve reusable procedures as skills only when there is strong evidence that the workflow will help future agent runs.',
    '',
    'Inputs:',
    '- Active skills already available to the main agent',
    '- Existing pending dream drafts',
    '- Recent successful task outcomes with prompt/result snippets',
    '',
    'Output channels:',
    '- Write new skill candidates to the writable filesystem paths below',
    '- Return the exact final text sections requested at the end of this prompt',
    '- The host runtime will validate your filesystem output and autonomously promote valid candidates into active skills',
    '',
    ...renderSkillSummaries('Active skills:', activeSkills),
    '',
    ...renderSkillSummaries('Existing draft skills:', draftSkills),
    '',
    'Writable workspace:',
    '- Draft new active skills under `/workspace/project/.nanoclaw/skill-dreams/drafts/<skill-name>/SKILL.md`',
    '- Draft active skill replacements under `/workspace/project/.nanoclaw/skill-dreams/patches/<skill-name>/SKILL.md`',
    '- For every draft or patch, write `/workspace/project/.nanoclaw/skill-dreams/{drafts|patches}/<skill-name>/EVIDENCE.md` with outcome ids, dates, and the reason this procedure is reusable',
    '- Optional supporting files may live only in `references/`, `templates/`, `scripts/`, or `assets/` inside that skill directory',
    '',
    'Validation contract:',
    '- Every generated `SKILL.md` must have frontmatter with `name` and `description`',
    '- `name` must match the directory name and use only lowercase letters, numbers, dots, underscores, and hyphens',
    '- Do not set `allowed-tools` or any other permission-escalation frontmatter',
    '- Do not create symlinks or files outside the allowed skill directory structure',
    '- Do not include secrets, API keys, private identifiers, raw logs, or unnecessary personal data',
    '',
    'Hard boundaries:',
    '- Do not edit `/workspace/project/container/skills` directly',
    '- Do not edit CLAUDE.md memory files or the company graph',
    '- Do not create drafts for one-off tickets, transient bugs, raw support facts, or simple tasks',
    '- Prefer patch proposals over duplicate new skills when an active or draft skill already covers the workflow',
    '',
    'Promotion criteria for draft skills:',
    '- Prefer at least two successful outcomes with the same durable workflow',
    '- A single outcome is enough only when it contains a non-trivial, clearly reusable procedure with concrete commands, tools, pitfalls, and verification steps',
    '- A good skill has narrow trigger conditions, numbered procedure steps, pitfalls, and verification',
    '',
    'Example:',
    '- If outcomes 41 and 44 both show the same safe incident investigation workflow, write `/workspace/project/.nanoclaw/skill-dreams/drafts/incident-investigation/SKILL.md` and an adjacent `EVIDENCE.md` that cites outcomes 41 and 44',
    '',
    'When no draft or patch proposal is justified, leave the filesystem unchanged.',
    '',
    `Recent successful outcomes (${outcomes.length}, oldest to newest):`,
    renderOutcomes(outcomes),
    '',
    'When you finish, respond with exactly these sections:',
    'Status: created_drafts | updated_drafts | no_changes | needs_human',
    'Why:',
    'Drafts:',
    'Patch proposals:',
    'Summary:',
  ].join('\n');
}

function ensureSkillDreamRoot(): void {
  fs.mkdirSync(path.join(SKILL_DREAMER_ROOT, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(SKILL_DREAMER_ROOT, 'patches'), { recursive: true });
}

function getSkillDreamWritableMounts(): WritableProjectMount[] {
  return [
    {
      hostPath: path.relative(process.cwd(), SKILL_DREAMER_ROOT),
      containerPath: '/workspace/project/.nanoclaw/skill-dreams',
    },
  ];
}

function ensureSkillDreamOutputDirs(root: string): void {
  fs.mkdirSync(path.join(root, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive', 'promoted'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive', 'patched'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive', 'backups'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rejected'), { recursive: true });
}

function displayPath(absolutePath: string): string {
  const relative = path.relative(process.cwd(), absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}

function safeArchiveName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .slice(0, 64) || 'skill'
  );
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function uniquePath(targetPath: string): string {
  if (!fs.existsSync(targetPath)) return targetPath;

  for (let i = 2; i < 1_000; i += 1) {
    const candidate = `${targetPath}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not find unique path for ${targetPath}`);
}

function listChildDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function isProbablyText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 4_096).includes(0);
}

function secretScanErrors(filePath: string, buffer: Buffer): string[] {
  if (!isProbablyText(buffer)) return [];

  const content = buffer.toString('utf8');
  const errors: string[] = [];
  const patterns = [
    {
      label: 'private key',
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    },
    {
      label: 'API key',
      regex: /\bsk-(?:ant-[a-zA-Z0-9_-]{20,}|[a-zA-Z0-9_-]{32,})\b/,
    },
    {
      label: 'GitHub token',
      regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/,
    },
    {
      label: 'Slack token',
      regex: /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/,
    },
    {
      label: 'Google API key',
      regex: /\bAIza[0-9A-Za-z_-]{30,}\b/,
    },
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(content)) {
      errors.push(
        `${displayPath(filePath)} appears to contain a ${pattern.label}`,
      );
    }
  }

  const placeholderRe =
    /(placeholder|example|redacted|dummy|changeme|your[_-]?|xxx|\*\*\*|<[^>]+>)/i;
  const assignmentRe =
    /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{16,})["']?/gi;
  let match: RegExpExecArray | null;
  while ((match = assignmentRe.exec(content))) {
    const lineStart = content.lastIndexOf('\n', match.index) + 1;
    const lineEnd = content.indexOf('\n', match.index);
    const line = content.slice(
      lineStart,
      lineEnd === -1 ? content.length : lineEnd,
    );
    if (!placeholderRe.test(line)) {
      errors.push(
        `${displayPath(filePath)} appears to contain a secret assignment`,
      );
      break;
    }
  }

  return errors;
}

function validateSkillDirectory(
  skillDir: string,
  expectedName?: string,
): SkillValidationResult {
  const errors: string[] = [];
  const rootStat = fs.existsSync(skillDir) ? fs.lstatSync(skillDir) : null;
  if (!rootStat) {
    return {
      valid: false,
      errors: [`${displayPath(skillDir)} does not exist`],
    };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      valid: false,
      errors: [`${displayPath(skillDir)} must be a real directory`],
    };
  }

  const skillPath = path.join(skillDir, 'SKILL.md');
  let skillContent = '';
  if (!fs.existsSync(skillPath)) {
    errors.push('SKILL.md is required');
  } else {
    const skillStat = fs.lstatSync(skillPath);
    if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
      errors.push('SKILL.md must be a regular file');
    } else if (skillStat.size > MAX_SKILL_MD_CHARS) {
      errors.push(`SKILL.md must be ${MAX_SKILL_MD_CHARS} bytes or less`);
    } else {
      skillContent = fs.readFileSync(skillPath, 'utf8');
      if (skillContent.length > MAX_SKILL_MD_CHARS) {
        errors.push(
          `SKILL.md must be ${MAX_SKILL_MD_CHARS} characters or less`,
        );
      }
    }
  }

  const frontmatterMatch = skillContent.match(
    /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/,
  );
  const frontmatter = frontmatterMatch?.[1] || '';
  const body = frontmatterMatch?.[2] || '';
  if (!frontmatterMatch) {
    errors.push('SKILL.md must start with YAML frontmatter');
  }
  if (!body.trim()) {
    errors.push(
      'SKILL.md must include procedural instructions after frontmatter',
    );
  }
  if (/^allowed-tools\s*:/im.test(frontmatter)) {
    errors.push('generated skills may not declare allowed-tools');
  }

  const name = readFrontmatterField(skillContent, 'name');
  const description = readFrontmatterField(skillContent, 'description');
  if (!name) {
    errors.push('frontmatter name is required');
  } else {
    if (!SKILL_NAME_RE.test(name)) {
      errors.push(`frontmatter name "${name}" must match ${SKILL_NAME_RE}`);
    }
    if (expectedName && name !== expectedName) {
      errors.push(
        `frontmatter name "${name}" must match directory "${expectedName}"`,
      );
    }
  }
  if (!description) {
    errors.push('frontmatter description is required');
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `frontmatter description must be ${MAX_DESCRIPTION_LENGTH} characters or less`,
    );
  }

  let totalBytes = 0;
  const visit = (dir: string, isRoot: boolean) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        errors.push(`${displayPath(fullPath)} must not be a symlink`);
        continue;
      }

      if (isRoot && !ALLOWED_SKILL_CHILDREN.has(entry.name)) {
        errors.push(`${displayPath(fullPath)} is not an allowed skill child`);
        continue;
      }

      if (stat.isDirectory()) {
        if (isRoot && !SUPPORTING_DIRS.has(entry.name)) {
          errors.push(
            `${displayPath(fullPath)} is not an allowed supporting directory`,
          );
          continue;
        }
        visit(fullPath, false);
        continue;
      }

      if (!stat.isFile()) {
        errors.push(
          `${displayPath(fullPath)} must be a regular file or directory`,
        );
        continue;
      }

      totalBytes += stat.size;
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        errors.push(
          `${displayPath(fullPath)} must be ${MAX_SKILL_FILE_BYTES} bytes or less`,
        );
        continue;
      }

      errors.push(...secretScanErrors(fullPath, fs.readFileSync(fullPath)));
    }
  };

  visit(skillDir, true);
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    errors.push(
      `skill directory must be ${MAX_SKILL_TOTAL_BYTES} bytes or less`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    name,
    description,
  };
}

function copyPromotableSkillDir(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(
    path.join(sourceDir, 'SKILL.md'),
    path.join(targetDir, 'SKILL.md'),
  );

  for (const supportingDir of SUPPORTING_DIRS) {
    const sourceChild = path.join(sourceDir, supportingDir);
    if (!fs.existsSync(sourceChild)) continue;

    const targetChild = path.join(targetDir, supportingDir);
    fs.rmSync(targetChild, { recursive: true, force: true });
    fs.cpSync(sourceChild, targetChild, { recursive: true });
  }
}

function archiveGeneratedDir(
  sourceDir: string,
  archiveParent: string,
  skillName: string,
  now: Date,
): string {
  fs.mkdirSync(archiveParent, { recursive: true });
  const destination = uniquePath(
    path.join(
      archiveParent,
      `${safeArchiveName(skillName)}-${timestampSlug(now)}`,
    ),
  );
  fs.renameSync(sourceDir, destination);
  return destination;
}

function backupActiveSkillDir(
  activeSkillDir: string,
  backupParent: string,
  skillName: string,
  now: Date,
): string {
  fs.mkdirSync(backupParent, { recursive: true });
  const destination = uniquePath(
    path.join(
      backupParent,
      `${safeArchiveName(skillName)}-${timestampSlug(now)}`,
    ),
  );
  fs.cpSync(activeSkillDir, destination, { recursive: true });
  return destination;
}

function appendDreamIndex(root: string, actions: SkillDreamAction[]): void {
  if (actions.length === 0) return;

  const indexPath = path.join(root, 'index.json');
  const existingActions: SkillDreamAction[] = [];
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        actions?: SkillDreamAction[];
      };
      if (Array.isArray(parsed.actions))
        existingActions.push(...parsed.actions);
    } catch (error) {
      logger.warn(
        { err: error, path: indexPath },
        'Failed to parse Skill Dreamer index',
      );
    }
  }

  const nextActions = [...existingActions, ...actions].slice(-200);
  fs.writeFileSync(
    indexPath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: actions[actions.length - 1]?.at || new Date().toISOString(),
        actions: nextActions,
      },
      null,
      2,
    )}\n`,
  );
}

function pruneOldChildren(
  root: string,
  retentionDays: number,
  now: Date,
): void {
  if (!fs.existsSync(root)) return;

  const cutoffMs = now.getTime() - retentionDays * 24 * 3_600_000;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    const stat = fs.lstatSync(fullPath);
    if (stat.mtimeMs >= cutoffMs) continue;
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

function rejectSkillDream(
  actions: SkillDreamAction[],
  sourceDir: string,
  rejectedDir: string,
  skillName: string,
  reason: string,
  now: Date,
): void {
  const destination = archiveGeneratedDir(
    sourceDir,
    rejectedDir,
    skillName,
    now,
  );
  actions.push({
    kind: 'rejected',
    skillName,
    sourcePath: displayPath(sourceDir),
    targetPath: displayPath(destination),
    reason,
    at: now.toISOString(),
  });
}

export function applySkillDreamOutputs(
  options: ApplySkillDreamOptions = {},
): SkillDreamAction[] {
  const dreamRoot = options.dreamRoot || SKILL_DREAMER_ROOT;
  const activeSkillsDir = options.activeSkillsDir || ACTIVE_SKILLS_DIR;
  const autoPromote = options.autoPromote ?? SKILL_DREAMER_AUTOPROMOTE;
  const retentionDays = options.retentionDays ?? SKILL_DREAMER_RETENTION_DAYS;
  const now = options.now || new Date();
  const actions: SkillDreamAction[] = [];

  ensureSkillDreamOutputDirs(dreamRoot);
  fs.mkdirSync(activeSkillsDir, { recursive: true });

  if (!autoPromote) {
    return actions;
  }

  const draftsDir = path.join(dreamRoot, 'drafts');
  const patchesDir = path.join(dreamRoot, 'patches');
  const promotedArchiveDir = path.join(dreamRoot, 'archive', 'promoted');
  const patchedArchiveDir = path.join(dreamRoot, 'archive', 'patched');
  const backupsArchiveDir = path.join(dreamRoot, 'archive', 'backups');
  const rejectedDir = path.join(dreamRoot, 'rejected');

  for (const draftDir of listChildDirs(draftsDir)) {
    const expectedName = path.basename(draftDir);
    const validation = validateSkillDirectory(draftDir, expectedName);
    const skillName =
      validation.name && SKILL_NAME_RE.test(validation.name)
        ? validation.name
        : expectedName;
    const reason = validation.errors.join('; ');
    const activeSkillDir = path.join(activeSkillsDir, skillName);

    if (!validation.valid) {
      rejectSkillDream(actions, draftDir, rejectedDir, skillName, reason, now);
      continue;
    }
    if (fs.existsSync(activeSkillDir)) {
      rejectSkillDream(
        actions,
        draftDir,
        rejectedDir,
        skillName,
        'active skill already exists; use a patch proposal',
        now,
      );
      continue;
    }

    copyPromotableSkillDir(draftDir, activeSkillDir);
    const destination = archiveGeneratedDir(
      draftDir,
      promotedArchiveDir,
      skillName,
      now,
    );
    actions.push({
      kind: 'promoted',
      skillName,
      sourcePath: displayPath(draftDir),
      targetPath: displayPath(activeSkillDir),
      reason: 'validated new reusable skill draft',
      at: now.toISOString(),
    });
    logger.info(
      {
        skillName,
        archivePath: displayPath(destination),
        activeSkillDir: displayPath(activeSkillDir),
      },
      'Skill Dreamer promoted draft skill',
    );
  }

  for (const patchDir of listChildDirs(patchesDir)) {
    const expectedName = path.basename(patchDir);
    const validation = validateSkillDirectory(patchDir, expectedName);
    const skillName =
      validation.name && SKILL_NAME_RE.test(validation.name)
        ? validation.name
        : expectedName;
    const activeSkillDir = path.join(activeSkillsDir, skillName);

    if (!validation.valid) {
      rejectSkillDream(
        actions,
        patchDir,
        rejectedDir,
        skillName,
        validation.errors.join('; '),
        now,
      );
      continue;
    }
    if (!fs.existsSync(activeSkillDir)) {
      rejectSkillDream(
        actions,
        patchDir,
        rejectedDir,
        skillName,
        'active skill does not exist; use a new draft instead',
        now,
      );
      continue;
    }

    const backupPath = backupActiveSkillDir(
      activeSkillDir,
      backupsArchiveDir,
      skillName,
      now,
    );
    copyPromotableSkillDir(patchDir, activeSkillDir);
    const destination = archiveGeneratedDir(
      patchDir,
      patchedArchiveDir,
      skillName,
      now,
    );
    actions.push({
      kind: 'patched',
      skillName,
      sourcePath: displayPath(patchDir),
      targetPath: displayPath(activeSkillDir),
      reason: `validated replacement; backup at ${displayPath(backupPath)}`,
      at: now.toISOString(),
    });
    logger.info(
      {
        skillName,
        archivePath: displayPath(destination),
        backupPath: displayPath(backupPath),
        activeSkillDir: displayPath(activeSkillDir),
      },
      'Skill Dreamer applied skill patch',
    );
  }

  appendDreamIndex(dreamRoot, actions);
  pruneOldChildren(promotedArchiveDir, retentionDays, now);
  pruneOldChildren(patchedArchiveDir, retentionDays, now);
  pruneOldChildren(backupsArchiveDir, retentionDays, now);
  pruneOldChildren(rejectedDir, retentionDays, now);

  return actions;
}

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(root)) return snapshot;

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const hash = createHash('sha1')
        .update(fs.readFileSync(fullPath))
        .digest('hex');
      snapshot.set(fullPath, hash);
    }
  };

  visit(root);
  return snapshot;
}

function snapshotTrees(roots: string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const root of roots) {
    for (const [filePath, hash] of snapshotTree(root)) {
      snapshot.set(filePath, hash);
    }
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

async function stopRunningContainer(
  containerName: string | null,
): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(SKILL_DREAMER_CLOSE_SENTINEL), {
      recursive: true,
    });
    fs.writeFileSync(SKILL_DREAMER_CLOSE_SENTINEL, '');
  } catch (error) {
    logger.debug(
      { err: error, path: SKILL_DREAMER_CLOSE_SENTINEL },
      'Failed to write Skill Dreamer close sentinel',
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
    logger.debug(
      { err: error, containerName },
      'Fast Skill Dreamer stop failed',
    );
    try {
      await execFileAsync(CONTAINER_RUNTIME_BIN, ['kill', containerName], {
        timeout: 10_000,
      });
    } catch (killError) {
      logger.debug(
        { err: killError, containerName },
        'Failed to kill Skill Dreamer container after first result',
      );
    }
  }
}

async function runSkillDreamer(
  outcomes: AgentTaskOutcome[],
): Promise<SkillDreamRunResult> {
  ensureSkillDreamRoot();

  const before = snapshotTrees([SKILL_DREAMER_ROOT, ACTIVE_SKILLS_DIR]);
  const prompt = buildSkillDreamPrompt(outcomes);
  const sessionId = getSession(SKILL_DREAMER_GROUP_FOLDER);
  let settled = false;
  let containerName: string | null = null;

  const summary = await new Promise<string>((resolve, reject) => {
    void runContainerAgent(
      SKILL_DREAMER_GROUP,
      {
        prompt,
        sessionId,
        sessionNamespace: SKILL_DREAMER_GROUP_FOLDER,
        groupFolder: SKILL_DREAMER_GROUP.folder,
        chatJid: SKILL_DREAMER_CHAT_JID,
        isMain: true,
        assistantName: SKILL_DREAMER_NAME,
        model: SKILL_DREAMER_MODEL,
        writableProjectMounts: getSkillDreamWritableMounts(),
      },
      (_proc, spawnedContainerName) => {
        containerName = spawnedContainerName;
      },
      async (output: ContainerOutput) => {
        if (output.newSessionId) {
          setSession(SKILL_DREAMER_GROUP_FOLDER, output.newSessionId);
        }

        if (settled) return;

        if (output.status === 'error') {
          settled = true;
          await stopRunningContainer(containerName);
          reject(new Error(output.error || 'Skill Dreamer failed'));
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
          setSession(SKILL_DREAMER_GROUP_FOLDER, output.newSessionId);
        }

        if (settled) return;
        settled = true;

        if (output.status === 'error') {
          reject(new Error(output.error || 'Skill Dreamer failed'));
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

  const actions = applySkillDreamOutputs();
  const after = snapshotTrees([SKILL_DREAMER_ROOT, ACTIVE_SKILLS_DIR]);
  if (actions.length > 0) {
    logger.info({ actions }, 'Skill Dreamer applied generated skill outputs');
  }
  return {
    summary,
    changedFiles: diffSnapshots(before, after),
  };
}

async function tickSkillDreamer(): Promise<void> {
  const cursor = getRouterState(SKILL_DREAMER_CURSOR_KEY) || '';
  if (!cursor && !SKILL_DREAMER_BACKFILL_ON_FIRST_RUN) {
    const latestCompletedAt = getLatestAgentTaskOutcomeCompletedAt('success');
    if (latestCompletedAt) {
      setRouterState(SKILL_DREAMER_CURSOR_KEY, latestCompletedAt);
      setRouterState(SKILL_DREAMER_LAST_RUN_AT_KEY, new Date().toISOString());
      logger.info(
        { latestCompletedAt },
        'Initialized Skill Dreamer cursor without backfilling history',
      );
    }
    return;
  }
  if (!cursor && SKILL_DREAMER_BACKFILL_ON_FIRST_RUN) {
    logger.info('Skill Dreamer first run backfill enabled');
  }

  const outcomes = getAgentTaskOutcomesSince(
    cursor,
    SKILL_DREAMER_BATCH_LIMIT,
    'success',
  );
  const lastRunAt = getRouterState(SKILL_DREAMER_LAST_RUN_AT_KEY);
  const shouldRun = shouldRunSkillDreamer(
    outcomes.length,
    lastRunAt,
    Date.now(),
    SKILL_DREAMER_MIN_OUTCOMES,
    SKILL_DREAMER_MIN_HOURS,
  );
  if (!shouldRun) return;
  if (skillDreamerRunInFlight) {
    logger.debug(
      'Skill Dreamer run already in flight, skipping overlapping tick',
    );
    return;
  }

  skillDreamerRunInFlight = true;
  try {
    const result = await runSkillDreamer(outcomes);
    const newestCompletedAt = outcomes[outcomes.length - 1]?.completed_at;
    if (newestCompletedAt) {
      setRouterState(SKILL_DREAMER_CURSOR_KEY, newestCompletedAt);
    }
    setRouterState(SKILL_DREAMER_LAST_RUN_AT_KEY, new Date().toISOString());

    logger.info(
      {
        lastRunAt,
        outcomeCount: outcomes.length,
        changedFiles: result.changedFiles,
        newestCompletedAt,
      },
      'Skill Dreamer completed',
    );
    if (result.summary) {
      logger.debug({ summary: result.summary }, 'Skill Dreamer summary');
    }
  } finally {
    skillDreamerRunInFlight = false;
  }
}

export function startSkillDreamer(_deps: SkillDreamerDeps): void {
  if (!SKILL_DREAMER_ENABLED) {
    logger.info('Skill Dreamer disabled');
    return;
  }
  if (skillDreamerWatcherRunning) {
    logger.debug('Skill Dreamer already running, skipping duplicate start');
    return;
  }

  assertValidGroupFolder(SKILL_DREAMER_GROUP_FOLDER);
  skillDreamerWatcherRunning = true;

  const tick = async () => {
    try {
      await tickSkillDreamer();
    } catch (err) {
      logger.error({ err }, 'Skill Dreamer tick failed');
    }

    setTimeout(tick, SKILL_DREAMER_POLL_INTERVAL);
  };

  void tick();
  logger.info(
    {
      minHours: SKILL_DREAMER_MIN_HOURS,
      minOutcomes: SKILL_DREAMER_MIN_OUTCOMES,
      pollIntervalMs: SKILL_DREAMER_POLL_INTERVAL,
      autoPromote: SKILL_DREAMER_AUTOPROMOTE,
      backfillOnFirstRun: SKILL_DREAMER_BACKFILL_ON_FIRST_RUN,
      retentionDays: SKILL_DREAMER_RETENTION_DAYS,
      draftsDir: path.relative(process.cwd(), SKILL_DREAMER_ROOT),
      activeSkillsDir: path.relative(process.cwd(), ACTIVE_SKILLS_DIR),
    },
    'Skill Dreamer started',
  );
}
