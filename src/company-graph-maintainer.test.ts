import { describe, expect, it } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import {
  buildAtlasInstructionPrompt,
  runWithCompanyGraphWriteLock,
} from './company-graph-maintainer.js';

describe('buildAtlasInstructionPrompt', () => {
  it('builds an atlas prompt with clear workflow and output requirements', () => {
    const prompt = buildAtlasInstructionPrompt(
      'Document the new onboarding review workflow.',
      'The team agreed this should live under operations.',
    );

    expect(prompt).toContain(
      `${ASSISTANT_NAME} (or another teammate) is asking you to update the shared knowledge graph.`,
    );
    expect(prompt).toContain('docs/company-graph/_conventions.md');
    expect(prompt).toContain('groups/main/knowledge/');
    expect(prompt).toContain('Status: updated | no_changes | needs_human');
    expect(prompt).toContain('Summary:');
    expect(prompt).toContain(
      'Context:\nThe team agreed this should live under operations.',
    );
  });
});

describe('runWithCompanyGraphWriteLock', () => {
  it('serializes company graph write tasks', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = runWithCompanyGraphWriteLock('first', async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
      return 'first';
    });

    const second = runWithCompanyGraphWriteLock('second', async () => {
      order.push('second-start');
      order.push('second-end');
      return 'second';
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  });

  it('releases the write lock after a failed task', async () => {
    const order: string[] = [];

    const first = runWithCompanyGraphWriteLock('first', async () => {
      order.push('first');
      throw new Error('boom');
    });

    const second = runWithCompanyGraphWriteLock('second', async () => {
      order.push('second');
      return 'ok';
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });
});
