import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import {
  appendAoiRunLedgerEvent,
  createAoiRunLedgerEntry,
  finalizeAoiRunLedgerEntry,
  upsertAoiRunLedgerEntry,
  type AoiRunLedgerData,
  type AoiRunLedgerEntry,
  type AoiRunLedgerEventType,
  type AoiRunStatus,
} from './aoiRunLedger';

const LEDGER_FILE_NAME = 'runs.json';
const LEDGER_DIR_NAME = 'aoi-run-ledger';

function normalizeSessionPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) {
    return null;
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveLedgerFile(
  sessionsDir: string,
  sessionPath: string,
): {
  sessionPath: string;
  filePath: string;
} {
  const normalizedSessionPath = normalizeSessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(sessionsRoot, normalizedSessionPath, LEDGER_DIR_NAME, LEDGER_FILE_NAME);
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi run ledger path escaped the sessions directory.');
  }
  return {
    sessionPath: normalizedSessionPath,
    filePath,
  };
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function loadServerAoiRunLedger(
  sessionsDir: string,
  sessionPath: string,
): AoiRunLedgerEntry[] {
  const resolved = resolveLedgerFile(sessionsDir, sessionPath);
  const data = readJson<Partial<AoiRunLedgerData>>(resolved.filePath);
  if (!data || data.version !== 1 || !Array.isArray(data.runs)) {
    return [];
  }
  return data.runs
    .filter((entry): entry is AoiRunLedgerEntry => Boolean(entry && entry.version === 1))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function recordServerAoiRunLedgerEvent(params: {
  sessionsDir: string;
  sessionPath: string;
  type: AoiRunLedgerEventType;
  message: string;
  goalSummary: string;
  toolNames?: string[];
  status?: AoiRunStatus;
  now?: number;
}): AoiRunLedgerEntry {
  const resolved = resolveLedgerFile(params.sessionsDir, params.sessionPath);
  const now = params.now ?? Date.now();
  const current = loadServerAoiRunLedger(params.sessionsDir, resolved.sessionPath);
  const started = createAoiRunLedgerEntry({
    goal: {
      summary: params.goalSummary,
      sourceMessage: params.message,
      createdAt: now,
    },
    modelRoute: 'main',
    includeAppTools: false,
    exposedToolNames: params.toolNames ?? [],
    createdAt: now,
  });
  const withEvent = appendAoiRunLedgerEvent(started, {
    type: params.type,
    message: params.message,
    toolNames: params.toolNames,
    createdAt: now,
  });
  const finalized = finalizeAoiRunLedgerEntry(
    withEvent,
    params.status ?? 'completed',
    params.message,
  );
  const data: AoiRunLedgerData = {
    version: 1,
    savedAt: now,
    runs: upsertAoiRunLedgerEntry(current, finalized),
  };
  writeJsonAtomic(resolved.filePath, data);
  return finalized;
}
