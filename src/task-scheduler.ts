import { ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logAgentTaskOutcome,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const execAsync = promisify(exec);
const COMMAND_TASK_MAX_BUFFER = 1024 * 1024;
const DEFAULT_COMMAND_TASK_TIMEOUT_MS = 5 * 60_000;

type CommandTaskPayload = {
  wake_agent?: boolean;
  prompt?: string;
  send_message?: string;
  context_mode?: 'group' | 'isolated';
};

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function resolveCommandCwd(task: ScheduledTask, groupDir: string): string {
  const requested = task.command_cwd?.trim();
  const cwd = requested
    ? path.isAbsolute(requested)
      ? requested
      : path.resolve(groupDir, requested)
    : groupDir;
  if (!fs.existsSync(cwd)) {
    throw new Error(`Command cwd does not exist: ${requested}`);
  }
  const resolved = fs.realpathSync(cwd);
  const root = fs.realpathSync(groupDir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Command cwd must stay inside the group folder');
  }
  return resolved;
}

function parseCommandPayload(stdout: string): CommandTaskPayload | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CommandTaskPayload;
    }
  } catch {
    /* plain stdout is a valid notification/wake signal */
  }
  return null;
}

async function wakeAgentFromCommandTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  group: RegisteredGroup,
  prompt: string,
  contextMode: 'group' | 'isolated',
): Promise<string | null> {
  let result: string | null = null;
  let error: string | null = null;
  const sessions = deps.getSessions();
  const sessionId =
    contextMode === 'group' ? sessions[task.group_folder] : undefined;

  const output = await runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      isMain: group.isMain === true,
      isScheduledTask: true,
      assistantName: ASSISTANT_NAME,
    },
    (proc, containerName) =>
      deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
    async (streamedOutput: ContainerOutput) => {
      if (streamedOutput.result) {
        result = streamedOutput.result;
        await deps.sendMessage(task.chat_jid, streamedOutput.result);
        deps.queue.closeStdin(task.chat_jid);
      }
      if (streamedOutput.status === 'success') {
        deps.queue.notifyIdle(task.chat_jid);
        deps.queue.closeStdin(task.chat_jid);
      }
      if (streamedOutput.status === 'error') {
        error = streamedOutput.error || 'Unknown error';
      }
    },
  );

  if (output.status === 'error') {
    throw new Error(output.error || error || 'Agent wake failed');
  }
  return output.result || result;
}

async function runCommandTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  group: RegisteredGroup,
  groupDir: string,
  startedAt: string,
  startTime: number,
): Promise<void> {
  let result: string | null = null;
  let error: string | null = null;

  try {
    const command = task.command?.trim();
    if (!command) {
      throw new Error('Command task is missing a command');
    }

    const cwd = resolveCommandCwd(task, groupDir);
    const timeout =
      task.command_timeout_ms && task.command_timeout_ms > 0
        ? task.command_timeout_ms
        : DEFAULT_COMMAND_TASK_TIMEOUT_MS;

    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: COMMAND_TASK_MAX_BUFFER,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        SHELL: process.env.SHELL,
        TZ: process.env.TZ,
        NANOCLAW_GROUP_FOLDER: task.group_folder,
        NANOCLAW_CHAT_JID: task.chat_jid,
      },
    });

    const stdoutText = stdout.trim();
    const stderrText = stderr.trim();
    const payload = parseCommandPayload(stdoutText);

    if (payload?.send_message) {
      await deps.sendMessage(task.chat_jid, payload.send_message);
      result = payload.send_message;
    } else if (stdoutText && !payload) {
      await deps.sendMessage(task.chat_jid, stdoutText);
      result = stdoutText;
    } else {
      result = stderrText || 'Command completed';
    }

    const shouldWake =
      payload?.wake_agent || (!!stdoutText && !!task.wake_agent_on_output);
    if (shouldWake) {
      const wakePrompt =
        payload?.prompt ||
        `${task.prompt}\n\nCommand output:\n${stdoutText || result || 'No output.'}`;
      const wakeResult = await wakeAgentFromCommandTask(
        task,
        deps,
        group,
        wakePrompt,
        payload?.context_mode || task.context_mode || 'isolated',
      );
      if (wakeResult) result = wakeResult;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Command task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });
  logAgentTaskOutcome({
    source: 'scheduled_task',
    group_folder: task.group_folder,
    chat_jid: task.chat_jid,
    task_id: task.id,
    prompt: task.command || task.prompt,
    result: error ? error : result,
    status: error ? 'error' : 'success',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  if (task.runner === 'command') {
    await runCommandTask(task, deps, group, groupDir, startedAt, startTime);
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });
  logAgentTaskOutcome({
    source: 'scheduled_task',
    group_folder: task.group_folder,
    chat_jid: task.chat_jid,
    task_id: task.id,
    prompt: task.prompt,
    result: error ? error : result,
    status: error ? 'error' : 'success',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    schedulerTimer = setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerRunning = false;
}
