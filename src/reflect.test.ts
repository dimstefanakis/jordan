import { beforeEach, describe, expect, it } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import { buildReflectPrompt, shouldRunReflect } from './reflect.js';
import { _initTestDatabase, storeChatMetadata } from './db.js';
import { NewMessage, RegisteredGroup } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('buildReflectPrompt', () => {
  it('builds a phase-based prompt that constrains edits to Reflect marker blocks', () => {
    storeChatMetadata(
      'slack:main',
      '2026-03-31T10:00:00.000Z',
      'main',
      'slack',
    );

    const groups: Record<string, RegisteredGroup> = {
      'slack:main': {
        name: 'main',
        folder: 'main',
        trigger: `@${ASSISTANT_NAME}`,
        added_at: '2026-03-31T10:00:00.000Z',
        isMain: true,
        requiresTrigger: false,
      },
    };
    const messages: NewMessage[] = [
      {
        id: '1704067200.000000',
        chat_jid: 'slack:main',
        sender: 'U1',
        sender_name: 'Alice',
        content: 'This referral answer keeps coming up.',
        timestamp: '2026-03-31T10:00:01.000Z',
      },
      {
        id: '1704067201.000000',
        chat_jid: 'slack:main',
        sender: 'internal:company-graph',
        sender_name: 'Atlas',
        content:
          '[Internal note from Atlas]\nThe support workflow chapter was updated.',
        timestamp: '2026-03-31T10:00:02.000Z',
        is_from_me: false,
      },
      {
        id: '1704067202.000000',
        chat_jid: 'slack:main',
        sender: 'U2',
        sender_name: 'Bob',
        content: 'Can you add that to the thread notes?',
        timestamp: '2026-03-31T10:00:03.000Z',
        thread_ts: '1704067200.000000',
      },
    ];

    const prompt = buildReflectPrompt(messages, groups, [
      {
        folder: 'main',
        filePath: '/workspace/group/CLAUDE.md',
        scope: `${ASSISTANT_NAME} main Slack/admin lane memory`,
      },
      {
        folder: 'global',
        filePath: '/workspace/project/groups/global/CLAUDE.md',
        scope: 'shared/global memory across assistant surfaces',
      },
    ]);

    expect(prompt).toContain('# Reflect: Memory Consolidation');
    expect(prompt).toContain('## Phase 1 - Orient');
    expect(prompt).toContain('## Phase 2 - Gather recent signal');
    expect(prompt).toContain('## Phase 3 - Consolidate');
    expect(prompt).toContain('## Phase 4 - Prune and align');
    expect(prompt).toContain('<!-- REFLECT:START -->');
    expect(prompt).toContain('ask_atlas');
    expect(prompt).toContain('/workspace/project');
    expect(prompt).toContain('/workspace/group/CLAUDE.md');
    expect(prompt).toContain('/workspace/project/groups/global/CLAUDE.md');
    expect(prompt).toContain('sender_kind="internal"');
    expect(prompt).toContain('scope="thread"');
    expect(prompt).toContain('group_folder="main"');
    expect(prompt).toContain('chat_name="main"');
  });
});

describe('shouldRunReflect', () => {
  it('runs when pending messages reach the message threshold', () => {
    expect(
      shouldRunReflect(20, '2026-03-30T10:00:00.000Z', Date.now(), 20, 24),
    ).toBe(true);
  });

  it('runs when enough time has passed and there is pending activity', () => {
    expect(
      shouldRunReflect(
        3,
        '2026-03-30T10:00:00.000Z',
        new Date('2026-03-31T10:00:01.000Z').getTime(),
        20,
        24,
      ),
    ).toBe(true);
  });

  it('does not run early when both thresholds are still below target', () => {
    expect(
      shouldRunReflect(
        3,
        '2026-03-31T00:00:00.000Z',
        new Date('2026-03-31T12:00:00.000Z').getTime(),
        20,
        24,
      ),
    ).toBe(false);
  });

  it('does not run when there is no pending activity', () => {
    expect(
      shouldRunReflect(
        0,
        '2026-03-30T10:00:00.000Z',
        new Date('2026-03-31T12:00:00.000Z').getTime(),
        20,
        24,
      ),
    ).toBe(false);
  });
});
