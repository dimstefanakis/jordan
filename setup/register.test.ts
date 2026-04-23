import { describe, it, expect, beforeEach } from 'vitest';

import Database from 'better-sqlite3';

import {
  applyAssistantNameTemplate,
  ASSISTANT_NAME_PLACEHOLDER,
  resolveRegistrationFolder,
  upsertAssistantNameEnv,
} from './register.js';

/**
 * Tests for the register step.
 *
 * Verifies: parameterized SQL (no injection), file templating,
 * apostrophe in names, .env updates.
 */

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
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
  return db;
}

describe('parameterized SQL registration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('registers a group with parameterized query', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '123@g.us',
      'Test Group',
      'test-group',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT * FROM registered_groups WHERE jid = ?')
      .get('123@g.us') as {
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      requires_trigger: number;
    };

    expect(row.jid).toBe('123@g.us');
    expect(row.name).toBe('Test Group');
    expect(row.folder).toBe('test-group');
    expect(row.trigger_pattern).toBe('@Andy');
    expect(row.requires_trigger).toBe(1);
  });

  it('handles apostrophes in group names safely', () => {
    const name = "O'Brien's Group";

    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '456@g.us',
      name,
      'obriens-group',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
    );

    const row = db
      .prepare('SELECT name FROM registered_groups WHERE jid = ?')
      .get('456@g.us') as {
      name: string;
    };

    expect(row.name).toBe(name);
  });

  it('prevents SQL injection in JID field', () => {
    const maliciousJid = "'; DROP TABLE registered_groups; --";

    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(maliciousJid, 'Evil', 'evil', '@Andy', '2024-01-01T00:00:00.000Z', 1);

    // Table should still exist and have the row
    const count = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as {
      count: number;
    };
    expect(count.count).toBe(1);

    const row = db.prepare('SELECT jid FROM registered_groups').get() as {
      jid: string;
    };
    expect(row.jid).toBe(maliciousJid);
  });

  it('handles requiresTrigger=false', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '789@s.whatsapp.net',
      'Personal',
      'main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
    );

    const row = db
      .prepare('SELECT requires_trigger FROM registered_groups WHERE jid = ?')
      .get('789@s.whatsapp.net') as { requires_trigger: number };

    expect(row.requires_trigger).toBe(0);
  });

  it('stores is_main flag', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      '789@s.whatsapp.net',
      'Personal',
      'whatsapp_main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      0,
      1,
    );

    const row = db
      .prepare('SELECT is_main FROM registered_groups WHERE jid = ?')
      .get('789@s.whatsapp.net') as { is_main: number };

    expect(row.is_main).toBe(1);
  });

  it('defaults is_main to 0', () => {
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      '123@g.us',
      'Some Group',
      'whatsapp_some-group',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT is_main FROM registered_groups WHERE jid = ?')
      .get('123@g.us') as { is_main: number };

    expect(row.is_main).toBe(0);
  });

  it('upserts on conflict', () => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    );

    stmt.run(
      '123@g.us',
      'Original',
      'main',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );
    stmt.run(
      '123@g.us',
      'Updated',
      'main',
      '@Bot',
      '2024-02-01T00:00:00.000Z',
      0,
    );

    const rows = db.prepare('SELECT * FROM registered_groups').all();
    expect(rows).toHaveLength(1);

    const row = rows[0] as {
      name: string;
      trigger_pattern: string;
      requires_trigger: number;
    };
    expect(row.name).toBe('Updated');
    expect(row.trigger_pattern).toBe('@Bot');
    expect(row.requires_trigger).toBe(0);
  });
});

describe('resolveRegistrationFolder', () => {
  it('normalizes slack_main to main for Slack main registration when main is free', () => {
    expect(
      resolveRegistrationFolder({
        jid: 'slack:C123',
        folder: 'slack_main',
        channel: 'slack',
        isMain: true,
      }),
    ).toBe('main');
  });

  it('keeps slack_main when main is already owned by another jid', () => {
    expect(
      resolveRegistrationFolder(
        {
          jid: 'slack:C123',
          folder: 'slack_main',
          channel: 'slack',
          isMain: true,
        },
        'other-main-jid',
      ),
    ).toBe('slack_main');
  });

  it('leaves non-main Slack folders unchanged', () => {
    expect(
      resolveRegistrationFolder({
        jid: 'slack:C123',
        folder: 'slack_reports',
        channel: 'slack',
        isMain: false,
      }),
    ).toBe('slack_reports');
  });
});

describe('file templating', () => {
  it('replaces assistant placeholder tokens in CLAUDE.md content', () => {
    const content = `# ${ASSISTANT_NAME_PLACEHOLDER}\n\nYou are ${ASSISTANT_NAME_PLACEHOLDER}, a personal assistant.`;

    expect(applyAssistantNameTemplate(content, 'Nova')).toBe(
      '# Nova\n\nYou are Nova, a personal assistant.',
    );
  });

  it('replaces legacy Jordan and Nora template text', () => {
    const content =
      "# Jordan\n\nYou are Jordan.\n\nNora's shared memory stays scoped.";

    const rendered = applyAssistantNameTemplate(content, 'Nova');
    expect(rendered).toContain('# Nova');
    expect(rendered).toContain('You are Nova.');
    expect(rendered).toContain("Nova's shared memory stays scoped.");
  });

  it('updates .env ASSISTANT_NAME line', () => {
    const envContent = 'SOME_KEY=value\nASSISTANT_NAME="Andy"\nOTHER=test';

    expect(upsertAssistantNameEnv(envContent, 'Nova')).toContain(
      'ASSISTANT_NAME="Nova"',
    );
  });

  it('appends ASSISTANT_NAME to .env if not present', () => {
    expect(upsertAssistantNameEnv('SOME_KEY=value\n', 'Nova')).toContain(
      'ASSISTANT_NAME="Nova"',
    );
  });
});
