import { describe, expect, it } from 'vitest';

import { isValidGroupFolder } from './group-folder.js';
import { getSessionNamespace } from './session-namespace.js';

describe('getSessionNamespace', () => {
  it('reuses the group folder when no thread is present', () => {
    expect(getSessionNamespace('slack_support')).toBe('slack_support');
  });

  it('reuses the same namespace for thread replies in the same channel', () => {
    expect(getSessionNamespace('slack_support', '1704067200.000000')).toBe(
      'slack_support',
    );
  });

  it('reuses the same namespace across different Slack threads', () => {
    expect(getSessionNamespace('slack_support', '1704067200.000000')).toBe(
      getSessionNamespace('slack_support', '1704067201.000000'),
    );
  });

  it('stays within the group-folder safety rules', () => {
    const namespace = getSessionNamespace('slack_support');

    expect(isValidGroupFolder(namespace)).toBe(true);
  });
});
