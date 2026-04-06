import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import { resolveHostGroupFilePath } from './ipc.js';

const TEST_GROUP = 'ipc_test_group';
const GROUP_ROOT = path.join(GROUPS_DIR, TEST_GROUP);
const TMP_ROOT = path.join(process.cwd(), '.tmp-ipc-paths');

afterEach(() => {
  fs.rmSync(GROUP_ROOT, { recursive: true, force: true });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('resolveHostGroupFilePath', () => {
  it('rejects symlinks that resolve outside the group root', () => {
    fs.mkdirSync(GROUP_ROOT, { recursive: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });

    const outsideFile = path.join(TMP_ROOT, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, path.join(GROUP_ROOT, 'leak.txt'));

    expect(() =>
      resolveHostGroupFilePath(TEST_GROUP, '/workspace/group/leak.txt'),
    ).toThrow(/Resolved file path escapes group root/);
  });

  it('allows files that stay within the group root after resolution', () => {
    fs.mkdirSync(path.join(GROUP_ROOT, 'docs'), { recursive: true });

    const targetFile = path.join(GROUP_ROOT, 'docs', 'notes.txt');
    fs.writeFileSync(targetFile, 'hello');
    fs.symlinkSync(targetFile, path.join(GROUP_ROOT, 'notes-link.txt'));

    expect(
      resolveHostGroupFilePath(TEST_GROUP, '/workspace/group/notes-link.txt'),
    ).toBe(path.join(GROUP_ROOT, 'notes-link.txt'));
  });
});
