import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';

vi.mock('./container-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...actual,
    runContainerAgent: vi.fn(async (_group, _input, _onProcess, onOutput) => {
      await onOutput?.({ status: 'success', result: 'agent woke up' });
      return { status: 'success', result: 'agent woke up' };
    }),
  };
});

import { runContainerAgent } from './container-runner.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('runs command tasks silently when there is no stdout', async () => {
    const enqueuePromise: Promise<void>[] = [];
    const sendMessage = vi.fn(async () => {});

    createTask({
      id: 'command-silent',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'Only wake if there is output',
      runner: 'command',
      command: 'true',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    startSchedulerLoop({
      registeredGroups: () => ({
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          const promise = fn();
          enqueuePromise.push(promise);
          return promise;
        },
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await Promise.all(enqueuePromise);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(runContainerAgent).not.toHaveBeenCalled();
    expect(getTaskById('command-silent')?.status).toBe('completed');
  });

  it('lets command task JSON stdout wake an agent', async () => {
    vi.mocked(runContainerAgent).mockClear();
    const enqueuePromise: Promise<void>[] = [];
    const sendMessage = vi.fn(async () => {});

    createTask({
      id: 'command-wake',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'Default wake prompt',
      runner: 'command',
      command:
        'printf \'{"wake_agent":true,"prompt":"Investigate the changed thing","send_message":"Change detected"}\\n\'',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    startSchedulerLoop({
      registeredGroups: () => ({
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          const promise = fn();
          enqueuePromise.push(promise);
          return promise;
        },
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await Promise.all(enqueuePromise);

    expect(sendMessage).toHaveBeenCalledWith('other@g.us', 'Change detected');
    expect(runContainerAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: 'Investigate the changed thing',
        isScheduledTask: true,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(getTaskById('command-wake')?.status).toBe('completed');
  });
});
