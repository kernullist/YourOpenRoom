import type { ToolDef } from './llmClient';

import * as idb from './diskStorage';

type CheckpointScope = 'ide' | 'app_storage';

interface CheckpointFileEntry {
  scope: CheckpointScope;
  path: string;
  content: string | null;
}

interface WorkspaceCheckpoint {
  id: string;
  name: string;
  scope: CheckpointScope;
  roots: string[];
  files: CheckpointFileEntry[];
  createdAt: number;
}

const TOOL_NAME = 'workspace_checkpoint';
const CHECKPOINT_DIR = 'tooling/checkpoints';

function normalizePath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

async function listCheckpointFiles(): Promise<string[]> {
  const result = await idb.listFiles(CHECKPOINT_DIR);
  return result.files
    .filter((entry) => entry.type === 0 && entry.path.endsWith('.json'))
    .map((entry) => entry.path.replace(/\\/g, '/'));
}

async function loadCheckpoint(path: string): Promise<WorkspaceCheckpoint | null> {
  const content = await idb.getFile(path);
  if (content === null || content === undefined) return null;
  try {
    return (typeof content === 'string' ? JSON.parse(content) : content) as WorkspaceCheckpoint;
  } catch {
    return null;
  }
}

async function walkAppStorageFiles(root: string): Promise<CheckpointFileEntry[]> {
  const normalizedRoot = normalizePath(root);
  const pending = [normalizedRoot];
  const visited = new Set<string>();
  const files: CheckpointFileEntry[] = [];

  while (pending.length > 0) {
    const current = pending.shift() ?? '';
    if (visited.has(current)) continue;
    visited.add(current);
    const result = await idb.listFiles(current || '/');
    if (result.not_exists) {
      files.push({ scope: 'app_storage', path: normalizedRoot, content: null });
      continue;
    }

    for (const entry of result.files) {
      const normalizedPath = entry.path.replace(/\\/g, '/');
      if (entry.type === 1) {
        pending.push(normalizedPath);
        continue;
      }
      const content = await idb.getFile(normalizedPath);
      files.push({
        scope: 'app_storage',
        path: normalizedPath,
        content:
          content === null || content === undefined
            ? null
            : typeof content === 'string'
              ? content
              : JSON.stringify(content, null, 2),
      });
    }
  }

  return files;
}

async function walkIdeFiles(root: string): Promise<CheckpointFileEntry[]> {
  const normalizedRoot = normalizePath(root);
  const pending = [normalizedRoot];
  const visited = new Set<string>();
  const files: CheckpointFileEntry[] = [];

  while (pending.length > 0) {
    const current = pending.shift() ?? '';
    if (visited.has(current)) continue;
    visited.add(current);
    const url = new URL('/api/openvscode/list', window.location.origin);
    if (current) url.searchParams.set('path', current);
    const res = await fetch(url.toString());
    if (!res.ok) {
      files.push({ scope: 'ide', path: normalizedRoot, content: null });
      continue;
    }
    const data = (await res.json()) as {
      entries?: Array<{ path: string; type: 'file' | 'directory' }>;
    };
    for (const entry of data.entries || []) {
      if (entry.type === 'directory') {
        pending.push(entry.path);
        continue;
      }
      const fileUrl = new URL('/api/openvscode/file', window.location.origin);
      fileUrl.searchParams.set('path', entry.path);
      const fileRes = await fetch(fileUrl.toString());
      if (!fileRes.ok) {
        files.push({ scope: 'ide', path: entry.path, content: null });
        continue;
      }
      const fileData = (await fileRes.json()) as { content: string };
      files.push({ scope: 'ide', path: entry.path, content: fileData.content });
    }
  }

  return files;
}

async function captureCheckpointFiles(scope: CheckpointScope, roots: string[]): Promise<CheckpointFileEntry[]> {
  const allFiles: CheckpointFileEntry[] = [];
  for (const root of roots) {
    const rootPath = normalizePath(root);
    const files =
      scope === 'ide' ? await walkIdeFiles(rootPath) : await walkAppStorageFiles(rootPath);
    allFiles.push(...files);
  }
  const unique = new Map<string, CheckpointFileEntry>();
  for (const file of allFiles) unique.set(`${file.scope}:${file.path}`, file);
  return [...unique.values()];
}

async function saveCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<void> {
  await idb.putTextFilesByJSON({
    files: [
      {
        path: CHECKPOINT_DIR,
        name: `${checkpoint.id}.json`,
        content: JSON.stringify(checkpoint, null, 2),
      },
    ],
  });
}

async function createCheckpoint(options: {
  name?: string;
  scope: CheckpointScope;
  roots: string[];
}): Promise<WorkspaceCheckpoint> {
  const checkpoint: WorkspaceCheckpoint = {
    id: `checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: options.name?.trim() || 'Workspace checkpoint',
    scope: options.scope,
    roots: options.roots.map(normalizePath),
    files: await captureCheckpointFiles(options.scope, options.roots),
    createdAt: Date.now(),
  };
  await saveCheckpoint(checkpoint);
  return checkpoint;
}

async function restoreCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<void> {
  const groupedByRoot = new Map<string, CheckpointFileEntry[]>();
  for (const file of checkpoint.files) {
    const root = checkpoint.roots.find((item) => file.path === item || file.path.startsWith(`${item}/`)) || checkpoint.roots[0] || '';
    if (!groupedByRoot.has(root)) groupedByRoot.set(root, []);
    groupedByRoot.get(root)!.push(file);
  }

  for (const [root, files] of groupedByRoot) {
    if (checkpoint.scope === 'app_storage') {
      const currentFiles = await walkAppStorageFiles(root);
      const currentSet = new Set(currentFiles.map((file) => file.path));
      const snapshotSet = new Set(files.map((file) => file.path));
      for (const path of currentSet) {
        if (!snapshotSet.has(path)) {
          await idb.deleteFilesByPaths({ file_paths: [path] });
        }
      }
      for (const file of files) {
        if (file.content === null) continue;
        const parts = file.path.split('/');
        const name = parts.pop() || file.path;
        const dir = parts.join('/');
        await idb.putTextFilesByJSON({ files: [{ path: dir || undefined, name, content: file.content }] });
      }
    } else {
      const currentFiles = await walkIdeFiles(root);
      const currentSet = new Set(currentFiles.map((file) => file.path));
      const snapshotSet = new Set(files.map((file) => file.path));
      for (const path of currentSet) {
        if (!snapshotSet.has(path)) {
          const fileUrl = new URL('/api/openvscode/file', window.location.origin);
          await fetch(fileUrl.toString(), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
        }
      }
      for (const file of files) {
        if (file.content === null) continue;
        const fileUrl = new URL('/api/openvscode/file', window.location.origin);
        await fetch(fileUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: file.path, content: file.content }),
        });
      }
    }
  }
}

export function getCheckpointToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Create, list, restore, or delete reusable checkpoints for IDE or app-storage files.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['create', 'list', 'restore', 'delete'],
              description: 'Checkpoint operation mode',
            },
            scope: {
              type: 'string',
              enum: ['ide', 'app_storage'],
              description: 'Checkpoint scope for create operations',
            },
            name: {
              type: 'string',
              description: 'Optional checkpoint name for create operations',
            },
            roots: {
              type: 'array',
              items: { type: 'string' },
              description: 'One or more relative file or directory roots to snapshot',
            },
            checkpoint_id: {
              type: 'string',
              description: 'Existing checkpoint ID for restore or delete operations',
            },
          },
          required: ['mode'],
        },
      },
    },
  ];
}

export function isCheckpointTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeCheckpointTool(params: Record<string, unknown>): Promise<string> {
  const mode = String(params.mode || '').trim();
  if (mode === 'list') {
    const items = await Promise.all((await listCheckpointFiles()).map(loadCheckpoint));
    return JSON.stringify({
      checkpoints: items.filter((item): item is WorkspaceCheckpoint => item !== null).map((item) => ({
        id: item.id,
        name: item.name,
        scope: item.scope,
        roots: item.roots,
        createdAt: item.createdAt,
        fileCount: item.files.length,
      })),
    });
  }

  if (mode === 'create') {
    const scope =
      params.scope === 'ide' ? 'ide' : params.scope === 'app_storage' ? 'app_storage' : '';
    const roots = Array.isArray(params.roots)
      ? params.roots.map((item) => String(item)).filter(Boolean)
      : [];
    if (!scope) return 'error: scope is required for create';
    if (roots.length === 0) return 'error: roots is required for create';
    const checkpoint = await createCheckpoint({
      scope,
      roots,
      name: typeof params.name === 'string' ? params.name : undefined,
    });
    return JSON.stringify({
      id: checkpoint.id,
      name: checkpoint.name,
      scope: checkpoint.scope,
      roots: checkpoint.roots,
      fileCount: checkpoint.files.length,
      createdAt: checkpoint.createdAt,
    });
  }

  const checkpointId = String(params.checkpoint_id || '').trim();
  if (!checkpointId) return 'error: checkpoint_id is required';
  const checkpointPath = `${CHECKPOINT_DIR}/${checkpointId}.json`;
  const checkpoint = await loadCheckpoint(checkpointPath);
  if (!checkpoint) return `error: checkpoint ${checkpointId} not found`;

  if (mode === 'restore') {
    await restoreCheckpoint(checkpoint);
    return JSON.stringify({
      restored: true,
      checkpoint_id: checkpoint.id,
      scope: checkpoint.scope,
      roots: checkpoint.roots,
      fileCount: checkpoint.files.length,
    });
  }

  if (mode === 'delete') {
    await idb.deleteFilesByPaths({ file_paths: [checkpointPath] });
    return JSON.stringify({ deleted: true, checkpoint_id: checkpoint.id });
  }

  return `error: unsupported checkpoint mode ${mode}`;
}

export async function createAutofixCheckpoint(command: string, directory = ''): Promise<string> {
  const checkpoint = await createCheckpoint({
    scope: 'ide',
    roots: [directory || ''],
    name: `Autofix checkpoint for ${command}`,
  });
  return checkpoint.id;
}
