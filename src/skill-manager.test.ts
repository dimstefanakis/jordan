import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manageSkill } from './skill-manager.js';

let tempRoot: string;
let activeSkillsDir: string;
let historyRoot: string;

function skillContent(
  name: string,
  body = '1. Do the reusable thing.\n',
): string {
  return [
    '---',
    `name: ${name}`,
    `description: Reusable ${name} workflow`,
    '---',
    '',
    body,
  ].join('\n');
}

function manage(
  request: Parameters<typeof manageSkill>[0],
): ReturnType<typeof manageSkill> {
  return manageSkill(request, {
    activeSkillsDir,
    historyRoot,
    now: new Date('2026-04-14T12:00:00.000Z'),
  });
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
  activeSkillsDir = path.join(tempRoot, 'container', 'skills');
  historyRoot = path.join(tempRoot, '.nanoclaw', 'skill-manage');
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('manageSkill', () => {
  it('creates a validated active skill', () => {
    const result = manage({
      action: 'create',
      name: 'repeatable-debugging',
      content: skillContent(
        'repeatable-debugging',
        '1. Gather the trace.\n2. Reproduce the failure.\n',
      ),
    });

    expect(result.success).toBe(true);
    const skillPath = path.join(
      activeSkillsDir,
      'repeatable-debugging',
      'SKILL.md',
    );
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('Gather the trace');
  });

  it('rejects skills that request tool permissions', () => {
    const result = manage({
      action: 'create',
      name: 'unsafe-skill',
      content: [
        '---',
        'name: unsafe-skill',
        'description: Unsafe workflow',
        'allowed-tools: Bash',
        '---',
        '',
        '1. Do the thing.',
      ].join('\n'),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('allowed-tools');
    expect(
      fs.existsSync(path.join(activeSkillsDir, 'unsafe-skill', 'SKILL.md')),
    ).toBe(false);
  });

  it('patches a skill and keeps a backup', () => {
    const createResult = manage({
      action: 'create',
      name: 'patch-me',
      content: skillContent('patch-me', '1. Use the old workflow.\n'),
    });
    expect(createResult.success).toBe(true);

    const patchResult = manage({
      action: 'patch',
      name: 'patch-me',
      old_string: 'old workflow',
      new_string: 'new workflow',
    });

    expect(patchResult.success).toBe(true);
    expect(patchResult.backupPath).toContain('skill-manage/backups');
    expect(
      fs.readFileSync(
        path.join(activeSkillsDir, 'patch-me', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('new workflow');

    const backupsDir = path.join(historyRoot, 'backups');
    const backupNames = fs.readdirSync(backupsDir);
    expect(backupNames).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(backupsDir, backupNames[0], 'SKILL.md'),
        'utf8',
      ),
    ).toContain('old workflow');
  });

  it('rolls back a rejected supporting file write', () => {
    expect(
      manage({
        action: 'create',
        name: 'supporting-files',
        content: skillContent('supporting-files'),
      }).success,
    ).toBe(true);

    const result = manage({
      action: 'write_file',
      name: 'supporting-files',
      file_path: 'references/token.md',
      file_content: 'api_key: abcdefghijklmnopqrstuvwxyz123456',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('restored backup');
    expect(
      fs.existsSync(
        path.join(
          activeSkillsDir,
          'supporting-files',
          'references',
          'token.md',
        ),
      ),
    ).toBe(false);
  });

  it('deletes a skill while retaining a backup', () => {
    expect(
      manage({
        action: 'create',
        name: 'remove-me',
        content: skillContent('remove-me'),
      }).success,
    ).toBe(true);

    const result = manage({
      action: 'delete',
      name: 'remove-me',
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(activeSkillsDir, 'remove-me'))).toBe(false);
    expect(result.backupPath).toContain('skill-manage/backups');
    const backupsDir = path.join(historyRoot, 'backups');
    expect(fs.readdirSync(backupsDir)).toHaveLength(1);
  });
});
