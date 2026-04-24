/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const threadTs = process.env.NANOCLAW_THREAD_TS || undefined;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

type IpcToolResponse = {
  text?: string;
  error?: string;
  success?: boolean;
  message?: string;
  path?: string;
  backupPath?: string;
  filesModified?: string[];
};

function resolveWorkspaceGroupFile(filePath: string): string {
  const normalized = path.resolve(filePath);
  if (
    normalized !== '/workspace/group' &&
    !normalized.startsWith('/workspace/group/')
  ) {
    throw new Error('File path must stay under /workspace/group');
  }
  if (!fs.existsSync(normalized)) {
    throw new Error(`File not found: ${normalized}`);
  }
  const stat = fs.statSync(normalized);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${normalized}`);
  }
  return normalized;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

async function waitForIpcResponse(
  requestId: string,
  timeoutMs?: number,
): Promise<IpcToolResponse> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);

  while (true) {
    if (fs.existsSync(responsePath)) {
      try {
        const payload = JSON.parse(fs.readFileSync(responsePath, 'utf-8')) as {
          text?: string;
          error?: string;
          success?: boolean;
          message?: string;
          path?: string;
          backupPath?: string;
          filesModified?: string[];
        };
        fs.unlinkSync(responsePath);
        return payload;
      } catch (err) {
        try {
          fs.unlinkSync(responsePath);
        } catch {
          /* ignore */
        }
        throw err;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutMs -= 500;
      if (timeoutMs <= 0) {
        throw new Error('Timed out waiting for IPC response');
      }
    }
  }
}

const server = new McpServer({
  name: 'jordan',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      threadTs,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'add_reaction',
  'Add a reaction to a specific chat message. Use the message ID from the transcript <message id="..."> attribute.',
  {
    message_id: z.string().describe('The message ID/timestamp to react to'),
    emoji: z
      .string()
      .describe(
        'Emoji name to use, with or without colons (e.g. robot_face or :robot_face:)',
      ),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'reaction',
      chatJid,
      messageId: args.message_id,
      emoji: args.emoji,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'Reaction sent.' }] };
  },
);

server.tool(
  'send_file',
  'Upload a file from /workspace/group into the current chat. Use this for images, CSVs, reports, and other artifacts you created locally.',
  {
    file_path: z
      .string()
      .describe('Absolute path to a file under /workspace/group'),
    title: z.string().optional().describe('Optional Slack title for the file'),
    initial_comment: z
      .string()
      .optional()
      .describe('Optional message text to accompany the file'),
    filename: z
      .string()
      .optional()
      .describe('Optional filename override shown in Slack'),
  },
  async (args) => {
    const filePath = resolveWorkspaceGroupFile(args.file_path);

    writeIpcFile(MESSAGES_DIR, {
      type: 'file',
      chatJid,
      threadTs,
      filePath,
      title: args.title || undefined,
      initialComment: args.initial_comment || undefined,
      filename: args.filename || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'File sent.' }] };
  },
);

if (isMain) {
  server.tool(
    'ask_atlas',
    'Ask Atlas to update the shared knowledge graph. Atlas is the knowledge maintainer — he reads the current docs, follows the conventions, and makes the edit. Use this when you learn something that should become durable organizational knowledge: product behavior, support policy, operational procedures, concept definitions, or corrections to existing docs. Atlas will decide where to place it and how to structure it.',
    {
      instruction: z
        .string()
        .describe(
          'What to update in the shared knowledge graph — be specific about the fact, behavior, or policy change',
        ),
      context: z
        .string()
        .optional()
        .describe(
          'Supporting detail: conversation excerpts, user reports, decisions, or what you already know',
        ),
    },
    async (args) => {
      const requestId = `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'ask_atlas',
        requestId,
        instruction: args.instruction,
        context: args.context || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const response = await waitForIpcResponse(requestId);
      if (response.error) {
        return {
          content: [{ type: 'text' as const, text: response.error }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: response.text || 'Atlas had no changes to make.',
          },
        ],
      };
    },
  );

  server.tool(
    'skill_manage',
    `Create, edit, patch, or delete active agent skills. Use this when a workflow has proven reusable, when you just overcame a tricky repeated failure, or when a skill you relied on is stale or incomplete.

This is direct active skill mutation, not a draft proposal. The host validates every change, blocks permission-escalation frontmatter, scans for secrets, writes an audit record, and keeps backups for rollback.

Actions:
create - add a new top-level active skill at container/skills/<name>/SKILL.md.
edit - replace an existing skill's SKILL.md.
patch - replace exact text in SKILL.md or a supporting file.
delete - remove an existing skill while keeping a backup.
write_file - write a supporting file under references/, templates/, scripts/, or assets/.
remove_file - remove a supporting file under references/, templates/, scripts/, or assets/.

Use create only for durable procedures, not one-off facts. Prefer patch/edit when an existing skill already covers the workflow.`,
    {
      action: z.enum([
        'create',
        'edit',
        'patch',
        'delete',
        'write_file',
        'remove_file',
      ]),
      name: z
        .string()
        .describe(
          'Skill name from frontmatter, lowercase letters/numbers/dots/underscores/hyphens only, e.g. "incident-investigation"',
        ),
      content: z
        .string()
        .optional()
        .describe(
          'Full SKILL.md content for create or edit. Must include YAML frontmatter with name and description.',
        ),
      file_path: z
        .string()
        .optional()
        .describe(
          'For patch/write_file/remove_file. Use "SKILL.md" or a supporting path under references/, templates/, scripts/, or assets/.',
        ),
      file_content: z
        .string()
        .optional()
        .describe('File content for write_file. Text files only.'),
      old_string: z
        .string()
        .optional()
        .describe(
          'Exact text to replace for patch. Must be unique unless replace_all is true.',
        ),
      new_string: z
        .string()
        .optional()
        .describe('Replacement text for patch. May be empty to delete text.'),
      replace_all: z
        .boolean()
        .default(false)
        .describe('For patch only. Replace every occurrence of old_string.'),
    },
    async (args) => {
      const requestId = `skill-manage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'skill_manage',
        requestId,
        action: args.action,
        name: args.name,
        content: args.content || undefined,
        file_path: args.file_path || undefined,
        file_content: args.file_content ?? undefined,
        old_string: args.old_string || undefined,
        new_string: args.new_string ?? undefined,
        replace_all: args.replace_all,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const response = await waitForIpcResponse(requestId);
      if (response.error || response.success === false) {
        return {
          content: [
            {
              type: 'text' as const,
              text: response.error || 'skill_manage request failed.',
            },
          ],
          isError: true,
        };
      }

      const details = [
        response.message || 'skill_manage request completed.',
        response.path ? `Path: ${response.path}` : '',
        response.backupPath ? `Backup: ${response.backupPath}` : '',
        response.filesModified?.length
          ? `Files modified:\n${response.filesModified.map((file) => `- ${file}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: details }],
      };
    },
  );
}

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'schedule_command_task',
  `Schedule a cron/interval/once command job that runs without waking an agent unless its output asks for one. Main group only.

The command runs from the target group's workspace by default. Use this for cheap polling scripts such as Python, Node, bash, git checks, or health checks.

STDOUT CONTRACT:
• Print nothing to complete silently.
• Print plain text to send that text to the chat.
• Print JSON like {"wake_agent":true,"prompt":"Investigate this change","send_message":"Change detected"} to wake an agent.

For Python scripts, prefer commands like: python3 jobs/check.py`,
  {
    command: z
      .string()
      .describe('Shell command to run, e.g. "python3 jobs/check.py"'),
    prompt: z
      .string()
      .describe(
        'Default prompt to use if wake_agent_on_output is true and stdout is plain text.',
      ),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('isolated'),
    command_cwd: z
      .string()
      .optional()
      .describe('Optional cwd under /workspace/group. Defaults to group root.'),
    command_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1000)
      .optional()
      .describe('Command timeout in milliseconds. Defaults to 5 minutes.'),
    wake_agent_on_output: z
      .boolean()
      .default(false)
      .describe('Wake an agent when stdout is non-empty plain text.'),
    target_group_jid: z
      .string()
      .optional()
      .describe('(Main group only) JID of the group to schedule for.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can schedule command tasks.',
          },
        ],
        isError: true,
      };
    }

    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    } else {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'schedule_command_task',
      taskId,
      command: args.command,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'isolated',
      command_cwd: args.command_cwd || undefined,
      command_timeout_ms: args.command_timeout_ms || undefined,
      wake_agent_on_output: args.wake_agent_on_output,
      targetJid: args.target_group_jid || chatJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Command task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
