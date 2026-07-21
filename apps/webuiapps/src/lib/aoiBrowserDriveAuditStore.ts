// Aoi browser-drive step audit store (P2.4a): the durable ledger of what Aoi did on
// the operator's OWN browser. Because a browser ACT is irreversible and runs on the
// user's real logged-in sessions, every driven step must leave an after-the-fact
// record: the action, the outcome, and REFS to a before/after screenshot + DOM
// snapshot. The bytes are large, so they live as separate files on disk; THIS store
// keeps only small entries pointing at those refs (like spawn-audit keeps pids, not
// process memory).
//
// Bounded rolling ledger (TTL + cap), machine-scoped under
// ~/.openroom/host-bridge/browser-drive-audit.json. Server-only (fs); the prune
// shaping is pure and exported for testing. Inert until P2.4b's audit observer + the
// runner write to it.

import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

const HOST_BRIDGE_DIR = 'host-bridge';
const AUDIT_FILE = 'browser-drive-audit.json';
const MAX_ENTRIES = 500;
// The ledger is a record, not a live control surface, so a generous TTL is fine;
// it only bounds unbounded growth.
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 240;

export type AoiBrowserDriveAuditCategory = 'read' | 'act' | 'forbidden';

export interface AoiBrowserDriveAuditEntry {
  version: 1;
  id: string;
  // Groups every step of ONE execute call so a run can be reconstructed in order.
  runId: string;
  stepIndex: number;
  actionKind: string;
  // Short human-facing summary, e.g. "click #buy on example.com".
  actionSummary: string;
  category: AoiBrowserDriveAuditCategory;
  ok: boolean;
  stopReason?: string;
  // True when an ACT was authorized by a standing grant (P3.1) rather than a fresh
  // per-action approval -- marks an autonomous act in the ledger.
  viaStanding?: boolean;
  url: string;
  beforeScreenshotRef?: string;
  afterScreenshotRef?: string;
  beforeDomRef?: string;
  afterDomRef?: string;
  recordedAt: number;
}

export interface AoiBrowserDriveAuditStoreData {
  version: 1;
  entries: AoiBrowserDriveAuditEntry[];
  updatedAt: number;
}

export const DEFAULT_AOI_BROWSER_DRIVE_AUDIT_STORE: AoiBrowserDriveAuditStoreData = {
  version: 1,
  entries: [],
  updatedAt: 0,
};

function clampText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function optionalRef(value: unknown): string | undefined {
  const ref = clampText(value, 300);
  return ref ? ref : undefined;
}

function normalizeCategory(value: unknown): AoiBrowserDriveAuditCategory {
  return value === 'act' || value === 'forbidden' ? value : 'read';
}

export function normalizeAoiBrowserDriveAuditEntry(raw: unknown): AoiBrowserDriveAuditEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Partial<AoiBrowserDriveAuditEntry>;
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.stepIndex !== 'number' ||
    !Number.isFinite(value.stepIndex) ||
    typeof value.recordedAt !== 'number' ||
    !Number.isFinite(value.recordedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    runId: value.runId.slice(0, 80),
    stepIndex: Math.trunc(value.stepIndex),
    actionKind: clampText(value.actionKind, 40),
    actionSummary: clampText(value.actionSummary),
    category: normalizeCategory(value.category),
    ok: value.ok === true,
    ...(typeof value.stopReason === 'string'
      ? { stopReason: clampText(value.stopReason, 60) }
      : {}),
    ...(value.viaStanding === true ? { viaStanding: true } : {}),
    url: clampText(value.url, 300),
    ...(optionalRef(value.beforeScreenshotRef)
      ? { beforeScreenshotRef: optionalRef(value.beforeScreenshotRef) }
      : {}),
    ...(optionalRef(value.afterScreenshotRef)
      ? { afterScreenshotRef: optionalRef(value.afterScreenshotRef) }
      : {}),
    ...(optionalRef(value.beforeDomRef) ? { beforeDomRef: optionalRef(value.beforeDomRef) } : {}),
    ...(optionalRef(value.afterDomRef) ? { afterDomRef: optionalRef(value.afterDomRef) } : {}),
    recordedAt: value.recordedAt,
  };
}

// Drop expired entries and cap to the newest MAX_ENTRIES (chronological). Pure.
export function pruneAoiBrowserDriveAuditEntries(
  entries: readonly unknown[],
  now: number,
): AoiBrowserDriveAuditEntry[] {
  const normalized: AoiBrowserDriveAuditEntry[] = [];
  for (const candidate of entries) {
    const entry = normalizeAoiBrowserDriveAuditEntry(candidate);
    if (entry && now - entry.recordedAt < ENTRY_TTL_MS) {
      normalized.push(entry);
    }
  }
  return normalized.sort((left, right) => left.recordedAt - right.recordedAt).slice(-MAX_ENTRIES);
}

export function normalizeAoiBrowserDriveAuditStore(raw: unknown): AoiBrowserDriveAuditStoreData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_AUDIT_STORE, entries: [] };
  }
  const value = raw as Partial<AoiBrowserDriveAuditStoreData>;
  const entries = Array.isArray(value.entries) ? value.entries : [];
  return {
    version: 1,
    entries: entries
      .map((entry) => normalizeAoiBrowserDriveAuditEntry(entry))
      .filter((entry): entry is AoiBrowserDriveAuditEntry => entry !== null)
      .slice(-MAX_ENTRIES),
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

// Append one audit entry to a store snapshot (pure): normalizes, appends, prunes.
export function appendAoiBrowserDriveAuditEntry(
  store: AoiBrowserDriveAuditStoreData | null | undefined,
  input: Omit<AoiBrowserDriveAuditEntry, 'version' | 'id' | 'recordedAt'>,
  now: number,
  idSuffix: string,
): { store: AoiBrowserDriveAuditStoreData; entry: AoiBrowserDriveAuditEntry } {
  const base = normalizeAoiBrowserDriveAuditStore(store);
  const entry: AoiBrowserDriveAuditEntry = {
    version: 1,
    id: `aoi-bd-audit-${now.toString(36)}-${idSuffix}`,
    runId: clampText(input.runId, 80) || 'run',
    stepIndex: Math.trunc(input.stepIndex),
    actionKind: clampText(input.actionKind, 40),
    actionSummary: clampText(input.actionSummary),
    category: normalizeCategory(input.category),
    ok: input.ok === true,
    ...(input.stopReason ? { stopReason: clampText(input.stopReason, 60) } : {}),
    ...(input.viaStanding === true ? { viaStanding: true } : {}),
    url: clampText(input.url, 300),
    ...(input.beforeScreenshotRef
      ? { beforeScreenshotRef: optionalRef(input.beforeScreenshotRef) }
      : {}),
    ...(input.afterScreenshotRef
      ? { afterScreenshotRef: optionalRef(input.afterScreenshotRef) }
      : {}),
    ...(input.beforeDomRef ? { beforeDomRef: optionalRef(input.beforeDomRef) } : {}),
    ...(input.afterDomRef ? { afterDomRef: optionalRef(input.afterDomRef) } : {}),
    recordedAt: now,
  };
  const entries = pruneAoiBrowserDriveAuditEntries([...base.entries, entry], now);
  return { store: { version: 1, entries, updatedAt: now }, entry };
}

// --- Persistence -------------------------------------------------------------

export function resolveAoiBrowserDriveAuditStorePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, AUDIT_FILE);
}

export function loadAoiBrowserDriveAuditStore(openroomHome: string): AoiBrowserDriveAuditStoreData {
  try {
    const filePath = resolveAoiBrowserDriveAuditStorePath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_BROWSER_DRIVE_AUDIT_STORE, entries: [] };
    }
    return normalizeAoiBrowserDriveAuditStore(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_AUDIT_STORE, entries: [] };
  }
}

export function saveAoiBrowserDriveAuditStore(
  openroomHome: string,
  store: AoiBrowserDriveAuditStoreData,
): AoiBrowserDriveAuditStoreData {
  const normalized = normalizeAoiBrowserDriveAuditStore(store);
  const filePath = resolveAoiBrowserDriveAuditStorePath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}

// Append + persist one entry (load, append, prune, save). Returns the entry count.
export function recordAoiBrowserDriveAuditEntry(
  openroomHome: string,
  input: Omit<AoiBrowserDriveAuditEntry, 'version' | 'id' | 'recordedAt'>,
  now: number,
): number {
  const appended = appendAoiBrowserDriveAuditEntry(
    loadAoiBrowserDriveAuditStore(openroomHome),
    input,
    now,
    randomUUID().slice(0, 8),
  );
  saveAoiBrowserDriveAuditStore(openroomHome, appended.store);
  return appended.store.entries.length;
}

// The pruned audit entries, oldest-first (for a future audit UI / a run recap).
export function loadAoiBrowserDriveAuditEntries(
  openroomHome: string,
  now: number,
): AoiBrowserDriveAuditEntry[] {
  return pruneAoiBrowserDriveAuditEntries(loadAoiBrowserDriveAuditStore(openroomHome).entries, now);
}
