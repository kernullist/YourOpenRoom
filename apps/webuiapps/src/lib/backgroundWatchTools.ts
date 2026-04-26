import type { ToolDef } from './llmClient';

import * as idb from './diskStorage';
import { getSessionPath } from './sessionPath';

export interface BackgroundWatch {
  id: string;
  scope: 'ide' | 'app_storage';
  directory: string;
  label: string;
  poll_interval_ms: number;
  last_signature: string | null;
  last_checked_at: number;
  triggered_count: number;
  created_at: number;
}

const TOOL_NAME = 'background_watch';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 3_000;
const MAX_POLL_INTERVAL_MS = 60_000;

function getStorageKey(): string {
  return `openroom-background-watches:${getSessionPath() || 'global'}`;
}

function normalizeDirectory(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function loadWatches(): BackgroundWatch[] {
  try {
    const raw = localStorage.getItem(getStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackgroundWatch[]) : [];
  } catch {
    return [];
  }
}

function saveWatches(watches: BackgroundWatch[]): void {
  try {
    localStorage.setItem(getStorageKey(), JSON.stringify(watches));
  } catch {
    // ignore
  }
}

async function captureAppStorageSignature(directory: string): Promise<string> {
  const root = normalizeDirectory(directory);
  const pending = [root];
  const visited = new Set<string>();
  const entries: string[] = [];

  while (pending.length > 0) {
    const currentDir = pending.shift() ?? '';
    if (visited.has(currentDir)) continue;
    visited.add(currentDir);
    const result = await idb.listFiles(currentDir || '/');
    if (result.not_exists) continue;

    for (const entry of result.files) {
      const normalizedPath = entry.path.replace(/\\/g, '/');
      entries.push(`${normalizedPath}:${entry.type}:${entry.size ?? 0}`);
      if (entry.type === 1) pending.push(normalizedPath);
    }
  }

  return entries.sort().join('|');
}

async function captureIdeSignature(directory: string): Promise<string> {
  const root = normalizeDirectory(directory);
  const pending = [root];
  const visited = new Set<string>();
  const entries: string[] = [];

  while (pending.length > 0) {
    const currentDir = pending.shift() ?? '';
    if (visited.has(currentDir)) continue;
    visited.add(currentDir);

    const url = new URL('/api/openvscode/list', window.location.origin);
    if (currentDir) url.searchParams.set('path', currentDir);
    const res = await fetch(url.toString());
    if (!res.ok) continue;
    const data = (await res.json()) as {
      entries?: Array<{ path: string; type: 'file' | 'directory'; size: number; modifiedAt: number }>;
    };
    for (const entry of data.entries || []) {
      entries.push(`${entry.path}:${entry.type}:${entry.size}:${entry.modifiedAt}`);
      if (entry.type === 'directory') pending.push(entry.path);
    }
  }

  return entries.sort().join('|');
}

export async function captureBackgroundWatchSignature(watch: Pick<BackgroundWatch, 'scope' | 'directory'>): Promise<string> {
  if (watch.scope === 'ide') {
    return captureIdeSignature(watch.directory);
  }
  return captureAppStorageSignature(watch.directory);
}

export async function createBackgroundWatch(params: {
  scope: 'ide' | 'app_storage';
  directory: string;
  label?: string;
  poll_interval_ms?: number;
}): Promise<BackgroundWatch> {
  const watches = loadWatches();
  const watch: BackgroundWatch = {
    id: `watch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    scope: params.scope,
    directory: normalizeDirectory(params.directory),
    label: params.label?.trim() || params.directory.trim() || params.scope,
    poll_interval_ms: Math.min(
      MAX_POLL_INTERVAL_MS,
      Math.max(MIN_POLL_INTERVAL_MS, Math.floor(params.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS)),
    ),
    last_signature: null,
    last_checked_at: 0,
    triggered_count: 0,
    created_at: Date.now(),
  };
  watch.last_signature = await captureBackgroundWatchSignature(watch);
  watch.last_checked_at = Date.now();
  watches.push(watch);
  saveWatches(watches);
  return watch;
}

export function removeBackgroundWatch(watchId: string): boolean {
  const watches = loadWatches();
  const next = watches.filter((watch) => watch.id !== watchId);
  saveWatches(next);
  return next.length !== watches.length;
}

export function listBackgroundWatches(): BackgroundWatch[] {
  return loadWatches();
}

export function clearBackgroundWatchesForTests(): void {
  saveWatches([]);
}

export async function pollBackgroundWatches(): Promise<
  Array<{ watch: BackgroundWatch; changed: boolean; previous_signature: string | null }>
> {
  const watches = loadWatches();
  const now = Date.now();
  const results: Array<{ watch: BackgroundWatch; changed: boolean; previous_signature: string | null }> = [];
  let hasChanges = false;

  for (const watch of watches) {
    if (now - watch.last_checked_at < watch.poll_interval_ms) continue;
    const previousSignature = watch.last_signature;
    const nextSignature = await captureBackgroundWatchSignature(watch);
    const changed = previousSignature !== null && previousSignature !== nextSignature;
    watch.last_signature = nextSignature;
    watch.last_checked_at = now;
    if (changed) {
      watch.triggered_count += 1;
      hasChanges = true;
      results.push({ watch: { ...watch }, changed, previous_signature: previousSignature });
    }
  }

  if (hasChanges || watches.length > 0) {
    saveWatches(watches);
  }

  return results;
}

export function getBackgroundWatchToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Create, list, or remove a background watch for the IDE workspace or app storage directories.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['create', 'list', 'remove'],
              description: 'Watch operation',
            },
            scope: {
              type: 'string',
              enum: ['ide', 'app_storage'],
              description: 'Watch target scope for create operations',
            },
            directory: {
              type: 'string',
              description: 'Directory relative to the chosen scope root',
            },
            label: {
              type: 'string',
              description: 'Optional human-friendly label',
            },
            watch_id: {
              type: 'string',
              description: 'Existing watch ID for remove operations',
            },
            poll_interval_ms: {
              type: 'number',
              description: 'Optional polling interval in milliseconds',
            },
          },
          required: ['mode'],
        },
      },
    },
  ];
}

export function isBackgroundWatchTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeBackgroundWatchTool(params: Record<string, unknown>): Promise<string> {
  const mode = String(params.mode || '').trim();
  if (mode === 'list') {
    return JSON.stringify({ watches: listBackgroundWatches() });
  }

  if (mode === 'remove') {
    const watchId = String(params.watch_id || '').trim();
    if (!watchId) return 'error: watch_id is required for remove';
    return JSON.stringify({ removed: removeBackgroundWatch(watchId), watch_id: watchId });
  }

  if (mode === 'create') {
    const scope = params.scope === 'ide' ? 'ide' : params.scope === 'app_storage' ? 'app_storage' : '';
    const directory = String(params.directory || '').trim();
    if (!scope) return 'error: scope is required for create';
    if (!directory) return 'error: directory is required for create';

    const watch = await createBackgroundWatch({
      scope,
      directory,
      label: typeof params.label === 'string' ? params.label : undefined,
      poll_interval_ms:
        typeof params.poll_interval_ms === 'number'
          ? params.poll_interval_ms
          : Number.parseInt(String(params.poll_interval_ms || ''), 10),
    });
    return JSON.stringify(watch);
  }

  return `error: unsupported background_watch mode ${mode}`;
}
