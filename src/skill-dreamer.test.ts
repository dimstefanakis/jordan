import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  applySkillDreamOutputs,
  buildSkillDreamPrompt,
  shouldRunSkillDreamer,
} from './skill-dreamer.js';
import { AgentTaskOutcome } from './types.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const tmpRoot of tmpRoots.splice(0)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function outcome(overrides: Partial<AgentTaskOutcome> = {}): AgentTaskOutcome {
  return {
    id: 1,
    source: 'message',
    group_folder: 'main',
    chat_jid: 'slack:main',
    prompt: 'User asked for another payout discrepancy investigation.',
    result:
      'Checked the read-only MCP schema, queried aggregate payout state, then summarized the safe next steps.',
    status: 'success',
    started_at: '2026-04-13T10:00:00.000Z',
    completed_at: '2026-04-13T10:03:00.000Z',
    duration_ms: 180_000,
    ...overrides,
  };
}

function makeTmpRoot(): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dreamer-'));
  tmpRoots.push(tmpRoot);
  return tmpRoot;
}

function writeSkill(
  skillDir: string,
  name: string,
  description = 'Use for reusable diagnostic workflows.',
  body = '1. Gather context.\n2. Run the verified checks.\n3. Summarize the result.',
): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
  fs.writeFileSync(
    path.join(skillDir, 'EVIDENCE.md'),
    '- outcome 1 showed this workflow was repeatable.\n',
  );
}

describe('buildSkillDreamPrompt', () => {
  it('builds an autonomous procedural memory prompt', () => {
    const prompt = buildSkillDreamPrompt(
      [
        outcome(),
        outcome({
          id: 2,
          prompt: 'User asked for the same payout discrepancy investigation.',
          completed_at: '2026-04-13T11:03:00.000Z',
        }),
      ],
      [
        {
          name: 'internal-data-analysis',
          description: 'Use for internal data analysis workflows.',
          filePath:
            '/workspace/project/container/skills/internal-data-analysis/SKILL.md',
        },
      ],
      [],
    );

    expect(prompt).toContain('# Skill Dreamer: Autonomous Procedural Memory');
    expect(prompt).toContain(
      '/workspace/project/.nanoclaw/skill-dreams/drafts',
    );
    expect(prompt).toContain(
      '/workspace/project/.nanoclaw/skill-dreams/patches',
    );
    expect(prompt).toContain(
      'The host runtime will validate your filesystem output and autonomously promote valid candidates',
    );
    expect(prompt).toContain(
      'Do not edit `/workspace/project/container/skills` directly',
    );
    expect(prompt).toContain('Prefer at least two successful outcomes');
    expect(prompt).toContain('internal-data-analysis');
    expect(prompt).toContain('<successful_outcomes>');
    expect(prompt).toContain('id="2"');
    expect(prompt).toContain('Status: created_drafts | updated_drafts');
  });
});

describe('applySkillDreamOutputs', () => {
  it('promotes a valid draft into active skills and archives the source', () => {
    const tmpRoot = makeTmpRoot();
    const dreamRoot = path.join(tmpRoot, 'dreams');
    const activeSkillsDir = path.join(tmpRoot, 'active-skills');
    const skillName = 'reusable-debug-workflow';
    writeSkill(path.join(dreamRoot, 'drafts', skillName), skillName);
    fs.mkdirSync(path.join(dreamRoot, 'drafts', skillName, 'references'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dreamRoot, 'drafts', skillName, 'references', 'notes.md'),
      'Verification notes.\n',
    );

    const actions = applySkillDreamOutputs({
      dreamRoot,
      activeSkillsDir,
      now: new Date('2026-04-14T10:00:00.000Z'),
      retentionDays: 30,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'promoted',
      skillName,
      reason: 'validated new reusable skill draft',
    });
    expect(
      fs.existsSync(path.join(activeSkillsDir, skillName, 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(activeSkillsDir, skillName, 'EVIDENCE.md')),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(activeSkillsDir, skillName, 'references', 'notes.md'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(dreamRoot, 'drafts', skillName))).toBe(
      false,
    );
    expect(
      fs.readdirSync(path.join(dreamRoot, 'archive', 'promoted')),
    ).toHaveLength(1);

    const index = JSON.parse(
      fs.readFileSync(path.join(dreamRoot, 'index.json'), 'utf8'),
    ) as { actions: Array<{ kind: string; skillName: string }> };
    expect(index.actions.at(-1)).toMatchObject({ kind: 'promoted', skillName });
  });

  it('rejects unsafe drafts instead of promoting them', () => {
    const tmpRoot = makeTmpRoot();
    const dreamRoot = path.join(tmpRoot, 'dreams');
    const activeSkillsDir = path.join(tmpRoot, 'active-skills');
    const skillName = 'unsafe-workflow';
    writeSkill(
      path.join(dreamRoot, 'drafts', skillName),
      skillName,
      'Use for unsafe test workflows.',
      '1. Never put real secrets in generated skills.\n2. token = "sk-ant-123456789012345678901234567890"\n',
    );

    const actions = applySkillDreamOutputs({
      dreamRoot,
      activeSkillsDir,
      now: new Date('2026-04-14T10:00:00.000Z'),
      retentionDays: 30,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('rejected');
    expect(actions[0].reason).toContain('API key');
    expect(
      fs.existsSync(path.join(activeSkillsDir, skillName, 'SKILL.md')),
    ).toBe(false);
    expect(fs.readdirSync(path.join(dreamRoot, 'rejected'))).toHaveLength(1);
  });

  it('applies a valid patch with a backup of the previous active skill', () => {
    const tmpRoot = makeTmpRoot();
    const dreamRoot = path.join(tmpRoot, 'dreams');
    const activeSkillsDir = path.join(tmpRoot, 'active-skills');
    const skillName = 'existing-workflow';
    writeSkill(
      path.join(activeSkillsDir, skillName),
      skillName,
      'Use for existing workflows.',
      '1. Old behavior.\n',
    );
    writeSkill(
      path.join(dreamRoot, 'patches', skillName),
      skillName,
      'Use for existing workflows with production-ready checks.',
      '1. New behavior.\n2. Verify it.\n',
    );

    const actions = applySkillDreamOutputs({
      dreamRoot,
      activeSkillsDir,
      now: new Date('2026-04-14T10:00:00.000Z'),
      retentionDays: 30,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'patched', skillName });
    const activeSkill = fs.readFileSync(
      path.join(activeSkillsDir, skillName, 'SKILL.md'),
      'utf8',
    );
    expect(activeSkill).toContain('New behavior');
    expect(activeSkill).not.toContain('Old behavior');

    const backupNames = fs.readdirSync(
      path.join(dreamRoot, 'archive', 'backups'),
    );
    expect(backupNames).toHaveLength(1);
    const backupSkill = fs.readFileSync(
      path.join(dreamRoot, 'archive', 'backups', backupNames[0], 'SKILL.md'),
      'utf8',
    );
    expect(backupSkill).toContain('Old behavior');
    expect(
      fs.readdirSync(path.join(dreamRoot, 'archive', 'patched')),
    ).toHaveLength(1);
  });
});

describe('shouldRunSkillDreamer', () => {
  it('runs when pending outcomes reach the threshold', () => {
    expect(
      shouldRunSkillDreamer(6, '2026-04-12T10:00:00.000Z', Date.now(), 6, 24),
    ).toBe(true);
  });

  it('runs when enough time has passed and there is pending activity', () => {
    expect(
      shouldRunSkillDreamer(
        1,
        '2026-04-12T10:00:00.000Z',
        new Date('2026-04-13T10:00:01.000Z').getTime(),
        6,
        24,
      ),
    ).toBe(true);
  });

  it('does not run without successful outcomes', () => {
    expect(
      shouldRunSkillDreamer(
        0,
        '2026-04-12T10:00:00.000Z',
        new Date('2026-04-13T10:00:01.000Z').getTime(),
        6,
        24,
      ),
    ).toBe(false);
  });
});
