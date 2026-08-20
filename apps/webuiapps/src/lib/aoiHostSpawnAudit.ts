// Aoi host-bridge spawn audit (spawn-audit persistence): the ownership record of
// processes Aoi itself started, so the kill capability can reclaim an
// Aoi-spawned pid (aoiHostProcessSpawn header; docs/aoi-host-access-design.md).
//
// Why this exists: evaluateAoiHostKillPolicy treats a pid as killable when it is
// on the operator kill-allowlist OR when Aoi spawned it. Without a persisted
// record of spawned pids, "kill of own spawn" could never fire. This module IS
// that record. It is a HINT that widens killability; the kill runner still
// re-verifies pid + image + start time (TOCTOU) before terminating, so a reused
// pid whose image/start-time no longer matches is refused regardless of this
// audit.
//
// Safety posture:
//   - Bounded rolling store (TTL + cap); machine-scoped under
//     ~/.openroom/host-bridge/spawn-audit.json.
//   - Metadata only: pid, image basename, spawn time. No command line.
//
// Server-only (fs). The prune shaping is pure and exported for testing.
import { withAoiHostStoreLock } from './aoiHostStoreLock';
import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

const HOST_BRIDGE_DIR = 'host-bridge';
const SPAWN_AUDIT_FILE = 'spawn-audit.json';
const MAX_ENTRIES = 256;
// A spawned process is assumed reclaimable for this long. The kill runner's
// TOCTOU re-check (pid + image + start time) is the real guard against pid
// reuse; this TTL only bounds the audit so it cannot grow without limit.
const ENTRY_TTL_MS = 12 * 60 * 60 * 1000;

export interface AoiHostSpawnAuditEntry {
  pid: number;
  imageName: string;
  spawnedAt: number;
}

interface AoiHostSpawnAuditStoreData {
  version: 1;
  entries: AoiHostSpawnAuditEntry[];
  updatedAt: number;
}

function normalizeImageName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const lastSegment = value.split(/[\\/]/).pop() ?? value;
  return lastSegment.trim().slice(0, 120);
}

function isEntry(value: unknown): value is AoiHostSpawnAuditEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<AoiHostSpawnAuditEntry>;
  return (
    typeof entry.pid === 'number' &&
    Number.isFinite(entry.pid) &&
    entry.pid > 0 &&
    typeof entry.imageName === 'string' &&
    typeof entry.spawnedAt === 'number' &&
    Number.isFinite(entry.spawnedAt)
  );
}

// Keep only unexpired entries, one per pid (newest wins), newest-bounded. Pure.
export function pruneAoiHostSpawnAuditEntries(
  entries: readonly AoiHostSpawnAuditEntry[],
  now: number,
): AoiHostSpawnAuditEntry[] {
  const byPid = new Map<number, AoiHostSpawnAuditEntry>();
  for (const entry of entries) {
    if (!isEntry(entry) || now - entry.spawnedAt >= ENTRY_TTL_MS) {
      continue;
    }
    const existing = byPid.get(entry.pid);
    if (!existing || entry.spawnedAt > existing.spawnedAt) {
      byPid.set(entry.pid, entry);
    }
  }
  return [...byPid.values()]
    .sort((left, right) => left.spawnedAt - right.spawnedAt)
    .slice(-MAX_ENTRIES);
}

function resolveStorePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, SPAWN_AUDIT_FILE);
}

function loadStore(openroomHome: string): AoiHostSpawnAuditStoreData {
  try {
    const filePath = resolveStorePath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { version: 1, entries: [], updatedAt: 0 };
    }
    const raw = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as Partial<AoiHostSpawnAuditStoreData>;
    const entries = Array.isArray(raw.entries) ? raw.entries.filter(isEntry) : [];
    return {
      version: 1,
      entries,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch {
    return { version: 1, entries: [], updatedAt: 0 };
  }
}

function saveStore(openroomHome: string, store: AoiHostSpawnAuditStoreData): void {
  const filePath = resolveStorePath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// Record one Aoi-spawned process. Load + append + prune + persist. Returns the
// new entry count. A non-positive pid is ignored (nothing to reclaim), leaving
// the store unchanged.
export function recordAoiHostSpawnedProcess(
  openroomHome: string,
  spawned: { pid: number; imageName: string },
  now: number,
): number {
  if (typeof spawned.pid !== 'number' || !Number.isFinite(spawned.pid) || spawned.pid <= 0) {
    return loadAoiHostSpawnedPids(openroomHome, now).length;
  }
  // Under the store lock. A dropped append is not merely a missing log line:
  // this set is what the kill policy consults to permit reclaiming a process
  // Aoi spawned, so losing an entry loses the permission with it.
  return withAoiHostStoreLock(openroomHome, 'spawn-audit', () => {
    const store = loadStore(openroomHome);
    const entries = pruneAoiHostSpawnAuditEntries(
      [
        ...store.entries,
        { pid: spawned.pid, imageName: normalizeImageName(spawned.imageName), spawnedAt: now },
      ],
      now,
    );
    saveStore(openroomHome, { version: 1, entries, updatedAt: now });
    return entries.length;
  });
}

// The active set of pids Aoi has spawned (pruned). This is what the kill policy
// consults to permit reclaiming an Aoi-spawned process.
export function loadAoiHostSpawnedPids(openroomHome: string, now: number): number[] {
  const store = loadStore(openroomHome);
  const entries = pruneAoiHostSpawnAuditEntries(store.entries, now);
  return entries.map((entry) => entry.pid);
}
