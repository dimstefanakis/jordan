import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { ATLAS_MODEL } from './config.js';
import {
  runContainerAgent,
  type ReadonlyProjectMount,
  type WritableProjectMount,
} from './container-runner.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getSession, setSession } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import type { RegisteredGroup } from './types.js';

const execFileAsync = promisify(execFile);

export const COMPANY_GRAPH_GROUP_FOLDER = 'company_graph';
export const COMPANY_GRAPH_CHAT_JID = 'internal:company-graph';
export const COMPANY_GRAPH_NAME = 'Atlas';

export const COMPANY_GRAPH_GROUP: RegisteredGroup = {
  name: COMPANY_GRAPH_NAME,
  folder: COMPANY_GRAPH_GROUP_FOLDER,
  trigger: '@Atlas',
  added_at: new Date(0).toISOString(),
  requiresTrigger: false,
  containerConfig: {
    timeout: 45 * 60 * 1000,
  },
};

const COMPANY_GRAPH_DOCS_ROOT = path.join(
  process.cwd(),
  'docs',
  'company-graph',
);
const COMPANY_GRAPH_CLOSE_SENTINEL = path.join(
  resolveGroupIpcPath(COMPANY_GRAPH_GROUP_FOLDER),
  'input',
  '_close',
);

export interface CompanyGraphUpdateResult {
  summary: string;
  changedFiles: string[];
}

let companyGraphWriteTail: Promise<void> = Promise.resolve();

export async function runWithCompanyGraphWriteLock<T>(
  reason: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = companyGraphWriteTail;
  let release = (): void => {};
  companyGraphWriteTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  logger.debug({ reason }, 'Acquired company graph write lock');

  try {
    return await task();
  } finally {
    release();
    logger.debug({ reason }, 'Released company graph write lock');
  }
}

function getCompanyGraphReadonlyMounts(): ReadonlyProjectMount[] {
  const mounts: ReadonlyProjectMount[] = [];
  const mainKnowledgePath = path.join('groups', 'main', 'knowledge');

  if (fs.existsSync(path.join(process.cwd(), mainKnowledgePath))) {
    mounts.push({
      hostPath: mainKnowledgePath,
      containerPath: '/workspace/project/groups/main/knowledge',
    });
  }

  return mounts;
}

function getCompanyGraphWritableMounts(): WritableProjectMount[] {
  return [
    {
      hostPath: path.join('docs', 'company-graph'),
      containerPath: '/workspace/project/docs/company-graph',
    },
  ];
}

function snapshotCompanyGraph(): Map<string, string> {
  const snapshot = new Map<string, string>();

  if (!fs.existsSync(COMPANY_GRAPH_DOCS_ROOT)) {
    return snapshot;
  }

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('._')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(COMPANY_GRAPH_DOCS_ROOT, fullPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      snapshot.set(relativePath, content);
    }
  };

  walk(COMPANY_GRAPH_DOCS_ROOT);
  return snapshot;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed = new Set<string>();

  for (const key of before.keys()) {
    if (before.get(key) !== after.get(key)) changed.add(key);
  }
  for (const key of after.keys()) {
    if (before.get(key) !== after.get(key)) changed.add(key);
  }

  return [...changed].sort();
}

async function stopRunningContainer(containerName: string | null): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(COMPANY_GRAPH_CLOSE_SENTINEL), {
      recursive: true,
    });
    fs.writeFileSync(COMPANY_GRAPH_CLOSE_SENTINEL, '');
  } catch (error) {
    logger.debug(
      { err: error, path: COMPANY_GRAPH_CLOSE_SENTINEL },
      'Failed to write company graph close sentinel',
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));

  if (!containerName) return;

  try {
    await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', containerName],
      { timeout: 10_000 },
    );
  } catch (error) {
    logger.debug(
      { err: error, containerName },
      'Fast company graph stop failed',
    );
    try {
      await execFileAsync(CONTAINER_RUNTIME_BIN, ['kill', containerName], {
        timeout: 10_000,
      });
    } catch (killError) {
      logger.debug(
        { err: killError, containerName },
        'Failed to kill company graph container after first result',
      );
    }
  }
}

export function buildAtlasInstructionPrompt(
  instruction: string,
  context?: string,
): string {
  return [
    'Jordan (or another teammate) is asking you to update the company graph.',
    '',
    'Your job is to update `/workspace/project/docs/company-graph` based on the instruction below.',
    '',
    'Required workflow:',
    '1. Read `docs/company-graph/_conventions.md` for structure rules, family definitions, and chapter templates.',
    '2. Read the current company graph docs most relevant to the instruction.',
    '3. Check `groups/main/knowledge/` when the instruction references raw notes, drafts, or source material that has not been normalized yet.',
    '4. Decide where the knowledge belongs using the decision tree in `_conventions.md`.',
    '5. Make the update: edit an existing chapter, create a new one, or split an overloaded one.',
    '6. If you add or rename chapters, also update `graph/manifest.yaml`, `graph/nodes.yaml`, and any relevant `graph/edges.yaml`, `graph/source-map.yaml`, or `graph/support-intents.yaml` entries.',
    '7. Keep the graph factual and durable. Do not invent temporary states, unsupported UI labels, or policies that are not grounded in the instruction or existing docs.',
    '',
    'Important guardrails:',
    '- Follow the chapter template for the target family as defined in `_conventions.md`.',
    '- Prefer minimal, durable edits over broad rewrites.',
    '- Do not add temporary knowledge such as active incidents, debugging notes, or short-lived workarounds.',
    '- If the instruction is too vague to act on safely, leave the graph unchanged and explain why.',
    '',
    'When you finish, respond with exactly these sections:',
    'Status: updated | no_changes | needs_human',
    'Why:',
    'Changed files:',
    'Summary:',
    '',
    'Instruction:',
    instruction.trim(),
    context?.trim() ? `\nContext:\n${context.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runAtlasInstruction(
  instruction: string,
  context?: string,
): Promise<CompanyGraphUpdateResult> {
  return runWithCompanyGraphWriteLock('ask_atlas', async () => {
    const before = snapshotCompanyGraph();
    const prompt = buildAtlasInstructionPrompt(instruction, context);
    const sessionId = getSession(COMPANY_GRAPH_GROUP_FOLDER);
    let settled = false;
    let containerName: string | null = null;

    const summary = await new Promise<string>((resolve, reject) => {
      void runContainerAgent(
        COMPANY_GRAPH_GROUP,
        {
          prompt,
          sessionId,
          sessionNamespace: COMPANY_GRAPH_GROUP_FOLDER,
          groupFolder: COMPANY_GRAPH_GROUP.folder,
          chatJid: COMPANY_GRAPH_CHAT_JID,
          isMain: false,
          assistantName: COMPANY_GRAPH_NAME,
          model: ATLAS_MODEL,
          readonlyProjectMounts: getCompanyGraphReadonlyMounts(),
          writableProjectMounts: getCompanyGraphWritableMounts(),
        },
        (_proc, spawnedContainerName) => {
          containerName = spawnedContainerName;
        },
        async (output) => {
          if (output.newSessionId) {
            setSession(COMPANY_GRAPH_GROUP_FOLDER, output.newSessionId);
          }

          if (settled) return;

          if (output.status === 'error') {
            settled = true;
            await stopRunningContainer(containerName);
            reject(new Error(output.error || 'Atlas failed'));
            return;
          }

          if (output.result !== null) {
            settled = true;
            await stopRunningContainer(containerName);
            resolve(formatOutbound(output.result).trim());
          }
        },
      )
        .then(async (output) => {
          if (output.newSessionId) {
            setSession(COMPANY_GRAPH_GROUP_FOLDER, output.newSessionId);
          }

          if (settled) return;
          settled = true;

          if (output.status === 'error') {
            reject(new Error(output.error || 'Atlas failed'));
            return;
          }

          await stopRunningContainer(containerName);
          resolve(formatOutbound(output.result || '').trim());
        })
        .catch(async (error) => {
          if (settled) return;
          settled = true;
          await stopRunningContainer(containerName);
          reject(error);
        });
    });

    const after = snapshotCompanyGraph();
    return {
      summary,
      changedFiles: diffSnapshots(before, after),
    };
  });
}

export async function askAtlas(
  instruction: string,
  context?: string,
): Promise<string> {
  const result = await runAtlasInstruction(instruction, context);
  return result.summary;
}
