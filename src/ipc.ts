import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { REFLECT_GROUP_FOLDER } from './reflect.js';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  isSkillManageAction,
  manageSkill,
  SkillManageRequest,
  SkillManageResult,
} from './skill-manager.js';
import {
  RegisteredGroup,
  SendFileOptions,
  SendMessageOptions,
  SendReactionOptions,
} from './types.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<void>;
  sendReaction: (
    jid: string,
    emoji: string,
    options: SendReactionOptions,
  ) => Promise<void>;
  sendFile: (
    jid: string,
    filePath: string,
    options?: SendFileOptions,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  askAtlas: (
    sourceGroup: string,
    instruction: string,
    context?: string,
  ) => Promise<string>;
  manageSkill?: (request: SkillManageRequest) => SkillManageResult;
}

let ipcWatcherRunning = false;

function isIpcTargetAuthorized(
  sourceGroup: string,
  isMain: boolean,
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  const targetGroup = registeredGroups[chatJid];
  return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
}

function isAtlasRequestAuthorized(
  sourceGroup: string,
  isMain: boolean,
): boolean {
  return isMain || sourceGroup === REFLECT_GROUP_FOLDER;
}

export function resolveHostGroupFilePath(
  sourceGroup: string,
  containerPath: string,
): string {
  const groupRoot = resolveGroupFolderPath(sourceGroup);
  const groupRootRealPath = fs.realpathSync(groupRoot);
  const normalized = containerPath.replace(/\\/g, '/');

  if (normalized === '/workspace/group') {
    throw new Error('File path must point to a file under /workspace/group');
  }

  if (!normalized.startsWith('/workspace/group/')) {
    throw new Error(
      `File path must stay under /workspace/group: ${containerPath}`,
    );
  }

  const relativePosix = path.posix.relative('/workspace/group', normalized);
  if (
    !relativePosix ||
    relativePosix.startsWith('../') ||
    path.posix.isAbsolute(relativePosix)
  ) {
    throw new Error(`Unsafe file path: ${containerPath}`);
  }

  const relativePath = relativePosix.split('/').join(path.sep);
  const hostPath = path.resolve(groupRoot, relativePath);
  const relativeHost = path.relative(groupRoot, hostPath);
  if (relativeHost.startsWith('..') || path.isAbsolute(relativeHost)) {
    throw new Error(`File path escapes group root: ${containerPath}`);
  }
  if (!fs.existsSync(hostPath)) {
    throw new Error(`File does not exist: ${containerPath}`);
  }
  const hostRealPath = fs.realpathSync(hostPath);
  const relativeRealHost = path.relative(groupRootRealPath, hostRealPath);
  if (relativeRealHost.startsWith('..') || path.isAbsolute(relativeRealHost)) {
    throw new Error(`Resolved file path escapes group root: ${containerPath}`);
  }
  return hostPath;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const chatJid =
                typeof data.chatJid === 'string' ? data.chatJid : undefined;
              if (!chatJid) {
                throw new Error('IPC message missing chatJid');
              }

              if (
                !isIpcTargetAuthorized(
                  sourceGroup,
                  isMain,
                  chatJid,
                  registeredGroups,
                )
              ) {
                logger.warn(
                  { chatJid, sourceGroup, type: data.type },
                  'Unauthorized IPC message attempt blocked',
                );
                fs.unlinkSync(filePath);
                continue;
              }

              if (data.type === 'message' && typeof data.text === 'string') {
                await deps.sendMessage(chatJid, data.text, {
                  threadTs:
                    typeof data.threadTs === 'string'
                      ? data.threadTs
                      : undefined,
                });
                logger.info({ chatJid, sourceGroup }, 'IPC message sent');
              } else if (
                data.type === 'reaction' &&
                typeof data.emoji === 'string' &&
                typeof data.messageId === 'string'
              ) {
                await deps.sendReaction(chatJid, data.emoji, {
                  messageId: data.messageId,
                });
                logger.info(
                  { chatJid, sourceGroup, messageId: data.messageId },
                  'IPC reaction sent',
                );
              } else if (
                data.type === 'file' &&
                typeof data.filePath === 'string'
              ) {
                const hostFilePath = resolveHostGroupFilePath(
                  sourceGroup,
                  data.filePath,
                );
                await deps.sendFile(chatJid, hostFilePath, {
                  threadTs:
                    typeof data.threadTs === 'string'
                      ? data.threadTs
                      : undefined,
                  title:
                    typeof data.title === 'string' ? data.title : undefined,
                  initialComment:
                    typeof data.initialComment === 'string'
                      ? data.initialComment
                      : undefined,
                  filename:
                    typeof data.filename === 'string'
                      ? data.filename
                      : undefined,
                });
                logger.info(
                  { chatJid, sourceGroup, filePath: data.filePath },
                  'IPC file sent',
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    requestId?: string;
    instruction?: string;
    context?: string;
    action?: unknown;
    content?: unknown;
    file_path?: unknown;
    file_content?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    replace_all?: unknown;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  const writeResponse = (requestId: string, payload: object): void => {
    const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    const responsePath = path.join(responsesDir, `${requestId}.json`);
    const tempPath = `${responsePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, responsePath);
  };

  switch (data.type) {
    case 'ask_atlas':
      if (
        typeof data.requestId !== 'string' ||
        typeof data.instruction !== 'string'
      ) {
        logger.warn({ data }, 'Invalid ask_atlas IPC payload');
        return;
      }

      if (!isAtlasRequestAuthorized(sourceGroup, isMain)) {
        writeResponse(data.requestId, {
          error: 'Atlas can only be called from the main group or Reflect.',
        });
        logger.warn(
          { sourceGroup, requestId: data.requestId },
          'Unauthorized ask_atlas IPC task blocked',
        );
        return;
      }

      try {
        const text = await deps.askAtlas(
          sourceGroup,
          data.instruction,
          typeof data.context === 'string' ? data.context : undefined,
        );
        writeResponse(data.requestId, { text });
        logger.info(
          { sourceGroup, requestId: data.requestId },
          'Atlas response written via IPC',
        );
      } catch (err) {
        const error =
          err instanceof Error ? err.message : 'Atlas request failed';
        writeResponse(data.requestId, { error });
        logger.error(
          { err, sourceGroup, requestId: data.requestId },
          'Failed to process ask_atlas IPC task',
        );
      }
      return;

    case 'skill_manage':
      if (typeof data.requestId !== 'string') {
        logger.warn({ data }, 'Invalid skill_manage IPC payload');
        return;
      }

      if (!isMain) {
        writeResponse(data.requestId, {
          success: false,
          error: 'skill_manage can only be called from the main group.',
        });
        logger.warn(
          { sourceGroup, requestId: data.requestId },
          'Unauthorized skill_manage IPC task blocked',
        );
        return;
      }

      if (!isSkillManageAction(data.action) || typeof data.name !== 'string') {
        writeResponse(data.requestId, {
          success: false,
          error: 'skill_manage requires a valid action and skill name.',
        });
        logger.warn({ data }, 'Invalid skill_manage IPC payload');
        return;
      }

      try {
        const result = (deps.manageSkill || manageSkill)({
          action: data.action,
          name: data.name,
          content: typeof data.content === 'string' ? data.content : undefined,
          file_path:
            typeof data.file_path === 'string' ? data.file_path : undefined,
          file_content:
            typeof data.file_content === 'string'
              ? data.file_content
              : undefined,
          old_string:
            typeof data.old_string === 'string' ? data.old_string : undefined,
          new_string:
            typeof data.new_string === 'string' ? data.new_string : undefined,
          replace_all:
            typeof data.replace_all === 'boolean'
              ? data.replace_all
              : undefined,
        });

        writeResponse(data.requestId, result);
        logger.info(
          { sourceGroup, requestId: data.requestId, action: data.action },
          'skill_manage response written via IPC',
        );
      } catch (err) {
        const error =
          err instanceof Error ? err.message : 'skill_manage request failed';
        writeResponse(data.requestId, {
          success: false,
          error,
        });
        logger.error(
          { err, sourceGroup, requestId: data.requestId },
          'Failed to process skill_manage IPC task',
        );
      }
      return;

    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
