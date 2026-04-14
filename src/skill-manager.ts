import fs from 'fs';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import { logger } from './logger.js';

export const ACTIVE_SKILLS_DIR = path.join(
  process.cwd(),
  'container',
  'skills',
);
export const SKILL_MANAGE_ROOT = path.join(
  process.cwd(),
  '.nanoclaw',
  'skill-manage',
);

export const SKILL_MANAGE_ACTIONS = [
  'create',
  'edit',
  'patch',
  'delete',
  'write_file',
  'remove_file',
] as const;

export type SkillManageAction = (typeof SKILL_MANAGE_ACTIONS)[number];

export interface SkillManageRequest {
  action: SkillManageAction;
  name: string;
  content?: string;
  file_path?: string;
  file_content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

export interface SkillManageResult {
  success: boolean;
  message?: string;
  error?: string;
  path?: string;
  backupPath?: string;
  filesModified?: string[];
  availableFiles?: string[];
}

export interface SkillManageOptions {
  activeSkillsDir?: string;
  historyRoot?: string;
  now?: Date;
}

interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  name?: string;
  description?: string;
}

interface SkillManageRecord {
  action: SkillManageAction;
  skillName: string;
  success: boolean;
  message?: string;
  error?: string;
  path?: string;
  backupPath?: string;
  filesModified?: string[];
  at: string;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_SKILL_MD_CHARS = 100_000;
const MAX_SKILL_FILE_BYTES = 1_048_576;
const MAX_SKILL_TOTAL_BYTES = 2 * 1_048_576;
const ALLOWED_SKILL_CHILDREN = new Set([
  'SKILL.md',
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

export function isSkillManageAction(
  value: unknown,
): value is SkillManageAction {
  return (
    typeof value === 'string' &&
    (SKILL_MANAGE_ACTIONS as readonly string[]).includes(value)
  );
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

function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Skill name "${name}" must match ${SKILL_NAME_RE} and be 64 characters or less`,
    );
  }
}

function assertUnderRoot(root: string, candidate: string): void {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes skills root: ${candidate}`);
  }
}

function readFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  rawFrontmatter: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: {},
      body: '',
      rawFrontmatter: '',
    };
  }

  const parsed = parseYaml(match[1]) as unknown;
  return {
    frontmatter:
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: match[2],
    rawFrontmatter: match[1],
  };
}

function readFrontmatterField(content: string, field: string): string {
  try {
    const { frontmatter } = readFrontmatter(content);
    const value = frontmatter[field];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
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

  let parsedFrontmatter: ReturnType<typeof readFrontmatter> | null = null;
  try {
    parsedFrontmatter = readFrontmatter(skillContent);
  } catch (error) {
    errors.push(
      `SKILL.md frontmatter must be valid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!skillContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)) {
    errors.push('SKILL.md must start with YAML frontmatter');
  }
  if (!parsedFrontmatter?.body.trim()) {
    errors.push(
      'SKILL.md must include procedural instructions after frontmatter',
    );
  }
  if (/^allowed-tools\s*:/im.test(parsedFrontmatter?.rawFrontmatter || '')) {
    errors.push('agent-managed skills may not declare allowed-tools');
  }

  const name =
    typeof parsedFrontmatter?.frontmatter.name === 'string'
      ? parsedFrontmatter.frontmatter.name.trim()
      : '';
  const description =
    typeof parsedFrontmatter?.frontmatter.description === 'string'
      ? parsedFrontmatter.frontmatter.description.trim()
      : '';
  if (!name) {
    errors.push('frontmatter name is required');
  } else {
    if (!SKILL_NAME_RE.test(name)) {
      errors.push(`frontmatter name "${name}" must match ${SKILL_NAME_RE}`);
    }
    if (expectedName && name !== expectedName) {
      errors.push(
        `frontmatter name "${name}" must match requested skill "${expectedName}"`,
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
      if (entry.name.startsWith('.')) {
        errors.push(`${displayPath(fullPath)} must not be hidden`);
        continue;
      }
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

function listSkillDirs(activeSkillsDir: string): string[] {
  if (!fs.existsSync(activeSkillsDir)) return [];

  const skillDirs: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) continue;
      if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
        skillDirs.push(fullPath);
        continue;
      }
      visit(fullPath);
    }
  };

  visit(activeSkillsDir);
  return skillDirs.sort();
}

function findActiveSkillDir(activeSkillsDir: string, name: string): string {
  assertSkillName(name);
  fs.mkdirSync(activeSkillsDir, { recursive: true });

  const matches = listSkillDirs(activeSkillsDir).filter((skillDir) => {
    if (path.basename(skillDir) === name) return true;
    const skillPath = path.join(skillDir, 'SKILL.md');
    const skillName = readFrontmatterField(
      fs.readFileSync(skillPath, 'utf8'),
      'name',
    );
    return skillName === name;
  });

  if (matches.length === 0) {
    throw new Error(`Active skill "${name}" was not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Active skill "${name}" is ambiguous: ${matches
        .map(displayPath)
        .join(', ')}`,
    );
  }

  return matches[0];
}

function assertSkillDoesNotExist(activeSkillsDir: string, name: string): void {
  try {
    const existing = findActiveSkillDir(activeSkillsDir, name);
    throw new Error(
      `Active skill "${name}" already exists at ${displayPath(existing)}`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Active skill "${name}" was not found`
    ) {
      return;
    }
    throw error;
  }
}

function resolveSupportingFilePath(skillDir: string, filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe skill file path: ${filePath}`);
  }

  const parts = normalized.split('/');
  if (parts.includes('..') || parts.some((part) => !part || part === '.')) {
    throw new Error(`Unsafe skill file path: ${filePath}`);
  }
  if (!SUPPORTING_DIRS.has(parts[0])) {
    throw new Error(
      `Supporting files must live under ${[...SUPPORTING_DIRS].join(', ')}`,
    );
  }

  const resolved = path.resolve(skillDir, ...parts);
  assertUnderRoot(skillDir, resolved);
  if (resolved === path.join(skillDir, 'SKILL.md')) {
    throw new Error('Use edit or patch to change SKILL.md');
  }
  return resolved;
}

function resolvePatchTargetPath(skillDir: string, filePath?: string): string {
  if (!filePath || filePath === 'SKILL.md') {
    return path.join(skillDir, 'SKILL.md');
  }
  return resolveSupportingFilePath(skillDir, filePath);
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

function restoreBackup(activeSkillDir: string, backupPath: string): void {
  fs.rmSync(activeSkillDir, { recursive: true, force: true });
  fs.cpSync(backupPath, activeSkillDir, { recursive: true });
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function assertSkillContent(
  name: string,
  content: unknown,
  historyRoot: string,
): string {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is required');
  }
  if (content.length > MAX_SKILL_MD_CHARS) {
    throw new Error(`content must be ${MAX_SKILL_MD_CHARS} characters or less`);
  }

  const tempRoot = fs.mkdtempSync(path.join(historyRoot, 'validate-'));
  try {
    const tempSkillDir = path.join(tempRoot, name);
    fs.mkdirSync(tempSkillDir, { recursive: true });
    fs.writeFileSync(path.join(tempSkillDir, 'SKILL.md'), content);
    const validation = validateSkillDirectory(tempSkillDir, name);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  return content;
}

function assertSupportingContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new Error('file_content is required');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new Error(
      `file_content must be ${MAX_SKILL_FILE_BYTES} bytes or less`,
    );
  }
  return content;
}

function cleanEmptyParents(childPath: string, stopDir: string): void {
  let current = path.dirname(childPath);
  const stop = path.resolve(stopDir);
  while (current !== stop && current.startsWith(stop)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function appendManageIndex(
  historyRoot: string,
  record: SkillManageRecord,
): void {
  fs.mkdirSync(historyRoot, { recursive: true });
  const indexPath = path.join(historyRoot, 'index.json');
  const records: SkillManageRecord[] = [];
  if (fs.existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        records?: SkillManageRecord[];
      };
      if (Array.isArray(parsed.records)) records.push(...parsed.records);
    } catch (error) {
      logger.warn(
        { err: error, path: indexPath },
        'Failed to parse skill_manage index',
      );
    }
  }

  fs.writeFileSync(
    indexPath,
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: record.at,
        records: [...records, record].slice(-500),
      },
      null,
      2,
    )}\n`,
  );
}

function validateActiveOrRollback(
  skillDir: string,
  skillName: string,
  backupPath: string,
): void {
  const validation = validateSkillDirectory(skillDir, skillName);
  if (validation.valid) return;

  restoreBackup(skillDir, backupPath);
  throw new Error(
    `skill validation failed; restored backup: ${validation.errors.join('; ')}`,
  );
}

function createSkill(
  request: SkillManageRequest,
  activeSkillsDir: string,
  historyRoot: string,
  now: Date,
): SkillManageResult {
  assertSkillName(request.name);
  const content = assertSkillContent(
    request.name,
    request.content,
    historyRoot,
  );
  assertSkillDoesNotExist(activeSkillsDir, request.name);

  const targetDir = path.join(activeSkillsDir, request.name);
  assertUnderRoot(activeSkillsDir, targetDir);
  if (fs.existsSync(targetDir)) {
    throw new Error(`Target skill directory already exists: ${targetDir}`);
  }

  const tempParent = path.join(historyRoot, 'tmp');
  fs.mkdirSync(tempParent, { recursive: true });
  const tempDir = fs.mkdtempSync(
    path.join(tempParent, `${safeArchiveName(request.name)}-create-`),
  );
  try {
    fs.writeFileSync(path.join(tempDir, 'SKILL.md'), content);
    const validation = validateSkillDirectory(tempDir, request.name);
    if (!validation.valid) {
      throw new Error(validation.errors.join('; '));
    }
    fs.renameSync(tempDir, targetDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    success: true,
    message: `Created active skill "${request.name}".`,
    path: displayPath(targetDir),
    filesModified: [displayPath(path.join(targetDir, 'SKILL.md'))],
  };
}

function editSkill(
  request: SkillManageRequest,
  activeSkillsDir: string,
  historyRoot: string,
  now: Date,
): SkillManageResult {
  assertSkillName(request.name);
  const content = assertSkillContent(
    request.name,
    request.content,
    historyRoot,
  );
  const skillDir = findActiveSkillDir(activeSkillsDir, request.name);
  const backupPath = backupActiveSkillDir(
    skillDir,
    path.join(historyRoot, 'backups'),
    request.name,
    now,
  );

  const skillPath = path.join(skillDir, 'SKILL.md');
  writeFileAtomic(skillPath, content);
  validateActiveOrRollback(skillDir, request.name, backupPath);

  return {
    success: true,
    message: `Edited active skill "${request.name}".`,
    path: displayPath(skillDir),
    backupPath: displayPath(backupPath),
    filesModified: [displayPath(skillPath)],
  };
}

function patchSkill(
  request: SkillManageRequest,
  activeSkillsDir: string,
  historyRoot: string,
  now: Date,
): SkillManageResult {
  assertSkillName(request.name);
  if (typeof request.old_string !== 'string' || request.old_string === '') {
    throw new Error('old_string is required and must not be empty');
  }
  if (typeof request.new_string !== 'string') {
    throw new Error('new_string is required');
  }

  const skillDir = findActiveSkillDir(activeSkillsDir, request.name);
  const targetPath = resolvePatchTargetPath(skillDir, request.file_path);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(`Patch target does not exist: ${displayPath(targetPath)}`);
  }

  const original = fs.readFileSync(targetPath, 'utf8');
  const occurrences = original.split(request.old_string).length - 1;
  if (occurrences === 0) {
    throw new Error('old_string was not found in the target file');
  }
  if (occurrences > 1 && !request.replace_all) {
    throw new Error(
      `old_string occurs ${occurrences} times; set replace_all to true or provide a more specific old_string`,
    );
  }

  const next = request.replace_all
    ? original.split(request.old_string).join(request.new_string)
    : original.replace(request.old_string, request.new_string);
  const backupPath = backupActiveSkillDir(
    skillDir,
    path.join(historyRoot, 'backups'),
    request.name,
    now,
  );

  writeFileAtomic(targetPath, next);
  validateActiveOrRollback(skillDir, request.name, backupPath);

  return {
    success: true,
    message: `Patched active skill "${request.name}".`,
    path: displayPath(skillDir),
    backupPath: displayPath(backupPath),
    filesModified: [displayPath(targetPath)],
  };
}

function deleteSkill(
  request: SkillManageRequest,
  activeSkillsDir: string,
  historyRoot: string,
  now: Date,
): SkillManageResult {
  assertSkillName(request.name);
  const skillDir = findActiveSkillDir(activeSkillsDir, request.name);
  const backupPath = backupActiveSkillDir(
    skillDir,
    path.join(historyRoot, 'backups'),
    request.name,
    now,
  );

  fs.rmSync(skillDir, { recursive: true, force: true });
  cleanEmptyParents(skillDir, activeSkillsDir);

  return {
    success: true,
    message: `Deleted active skill "${request.name}". Backup retained.`,
    path: displayPath(skillDir),
    backupPath: displayPath(backupPath),
  };
}

function writeSupportingFile(
  request: SkillManageRequest,
  activeSkillsDir: string,
  historyRoot: string,
  now: Date,
): SkillManageResult {
  assertSkillName(request.name);
  if (typeof request.file_path !== 'string') {
    throw new Error('file_path is required');
  }
  const content = assertSupportingContent(request.file_content);
  const skillDir = findActiveSkillDir(activeSkillsDir, request.name);
  const targetPath = resolveSupportingFilePath(skillDir, request.file_path);
  const backupPath = backupActiveSkillDir(
    skillDir,
    path.join(historyRoot, 'backups'),
    request.name,
    now,
  );

  writeFileAtomic(targetPath, content);
  validateActiveOrRollback(skillDir, request.name, backupPath);

  return {
    success: true,
    message: `Wrote supporting file for active skill "${request.name}".`,
    path: displayPath(skillDir),
    backupPath: displayPath(backupPath),
    filesModified: [displayPath(targetPath)],
  };
}

function removeSupportingFile(
  request: SkillManageRequest,
  activeSkillsDir: string,
  historyRoot: string,
  now: Date,
): SkillManageResult {
  assertSkillName(request.name);
  if (typeof request.file_path !== 'string') {
    throw new Error('file_path is required');
  }

  const skillDir = findActiveSkillDir(activeSkillsDir, request.name);
  const targetPath = resolveSupportingFilePath(skillDir, request.file_path);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(
      `Supporting file does not exist: ${displayPath(targetPath)}`,
    );
  }

  const backupPath = backupActiveSkillDir(
    skillDir,
    path.join(historyRoot, 'backups'),
    request.name,
    now,
  );

  fs.unlinkSync(targetPath);
  cleanEmptyParents(targetPath, skillDir);
  validateActiveOrRollback(skillDir, request.name, backupPath);

  return {
    success: true,
    message: `Removed supporting file for active skill "${request.name}".`,
    path: displayPath(skillDir),
    backupPath: displayPath(backupPath),
    filesModified: [displayPath(targetPath)],
  };
}

export function manageSkill(
  request: SkillManageRequest,
  options: SkillManageOptions = {},
): SkillManageResult {
  const activeSkillsDir = options.activeSkillsDir || ACTIVE_SKILLS_DIR;
  const historyRoot = options.historyRoot || SKILL_MANAGE_ROOT;
  const now = options.now || new Date();
  let result: SkillManageResult;

  try {
    fs.mkdirSync(activeSkillsDir, { recursive: true });
    fs.mkdirSync(historyRoot, { recursive: true });

    switch (request.action) {
      case 'create':
        result = createSkill(request, activeSkillsDir, historyRoot, now);
        break;
      case 'edit':
        result = editSkill(request, activeSkillsDir, historyRoot, now);
        break;
      case 'patch':
        result = patchSkill(request, activeSkillsDir, historyRoot, now);
        break;
      case 'delete':
        result = deleteSkill(request, activeSkillsDir, historyRoot, now);
        break;
      case 'write_file':
        result = writeSupportingFile(
          request,
          activeSkillsDir,
          historyRoot,
          now,
        );
        break;
      case 'remove_file':
        result = removeSupportingFile(
          request,
          activeSkillsDir,
          historyRoot,
          now,
        );
        break;
      default:
        result = {
          success: false,
          error: `Unsupported skill_manage action: ${(request as { action?: unknown }).action}`,
        };
    }
  } catch (error) {
    result = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    appendManageIndex(historyRoot, {
      action: request.action,
      skillName: request.name,
      success: result.success,
      message: result.message,
      error: result.error,
      path: result.path,
      backupPath: result.backupPath,
      filesModified: result.filesModified,
      at: now.toISOString(),
    });
  } catch (error) {
    logger.warn(
      { err: error, historyRoot },
      'Failed to write skill_manage index',
    );
  }

  return result;
}
