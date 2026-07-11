// P4.5: a rebuildable, self-healing memory index that ends the per-turn FULL SCAN of the
// memories directory for metadata + count queries.
//
// Every recall/enumeration today reads AND JSON-parses every memory file (see
// loadServerAoiMemories); as the durable store grows -- and it only grows, since deletes
// are soft (archived/superseded) -- that is a wall. This index caches per-memory METADATA
// (status/scope/type/tags/sources/updatedAt + hasEmbedding) keyed by the file's cheap
// stat signature (mtimeMs + size). A query filters the index (no body reads) and then reads
// ONLY the matched candidate bodies.
//
// Safety -- the index NEVER gates or hides a real memory:
//   * It is DERIVED and fully rebuildable from the per-memory files, which stay
//     authoritative.
//   * It SELF-HEALS on every load: the directory is listed (filenames + stat only), any file
//     that is new or whose mtimeMs|size changed is re-read and re-indexed, and ids whose file
//     vanished are dropped. So after loadOrRefreshAoiMemoryIndex the index is consistent with
//     the current on-disk set -- a stale index cannot exclude a memory.
//   * Callers keep the full scan as a fallback (a corrupt index just costs one rebuild).
//
// Server-only (fs). Pure helpers (buildAoiMemoryIndexEntry / indexEntryMatchesCriteria /
// sortAoiMemoryIndexEntries) are unit-testable without the filesystem.
import * as fs from 'fs';
import { basename, dirname, join } from 'path';
import {
  deriveAoiMemorySources,
  type AoiMemoryEntry,
  type AoiMemoryScope,
  type AoiMemorySourceCategory,
  type AoiMemoryStatus,
  type AoiMemoryType,
} from './aoiMemoryShared';
import {
  loadServerAoiMemories,
  loadServerAoiMemoriesByIds,
  resolveAoiMemoriesDir,
} from './aoiMemoryServerWriter';

export interface AoiMemoryIndexEntry {
  id: string;
  // Cheap file freshness signature (from statSync, no body read). A change in either
  // invalidates the cached metadata and forces a re-read.
  mtimeMs: number;
  size: number;
  updatedAt: number;
  status: AoiMemoryStatus;
  scope: AoiMemoryScope;
  type: AoiMemoryType;
  tags: string[];
  // Precomputed so a source query never needs the body.
  sources: AoiMemorySourceCategory[];
  projectKey?: string;
  sessionPath?: string;
  hasEmbedding: boolean;
  embeddingModel?: string;
}

export interface AoiMemoryIndex {
  version: 1;
  updatedAt: number;
  entries: AoiMemoryIndexEntry[];
}

const AOI_MEMORY_INDEX_VERSION = 1 as const;
const AOI_MEMORY_INDEX_FILE = 'index.json';

// Derive the index entry for one memory (pure).
export function buildAoiMemoryIndexEntry(
  memory: AoiMemoryEntry,
  stat: { mtimeMs: number; size: number },
): AoiMemoryIndexEntry {
  const entry: AoiMemoryIndexEntry = {
    id: memory.id,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    updatedAt: typeof memory.updatedAt === 'number' ? memory.updatedAt : 0,
    status: memory.status,
    scope: memory.scope,
    type: memory.type,
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    sources: deriveAoiMemorySources(memory),
    hasEmbedding: Array.isArray(memory.embedding) && memory.embedding.length > 0,
  };
  if (typeof memory.projectKey === 'string') {
    entry.projectKey = memory.projectKey;
  }
  if (typeof memory.sessionPath === 'string') {
    entry.sessionPath = memory.sessionPath;
  }
  if (typeof memory.embeddingModel === 'string') {
    entry.embeddingModel = memory.embeddingModel;
  }
  return entry;
}

// Deterministic recency order with a stable id tiebreaker, so the index yields the SAME
// ordering as the full-scan sort even when updatedAt ties (readdir order is otherwise
// arbitrary).
export function sortAoiMemoryIndexEntries(entries: AoiMemoryIndexEntry[]): AoiMemoryIndexEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

function indexFilePath(sessionsDir: string): string {
  // The index sits beside the memories/ directory (aoi/memory-v2/index.json).
  return join(dirname(resolveAoiMemoriesDir(sessionsDir)), AOI_MEMORY_INDEX_FILE);
}

interface MemoryFileStat {
  id: string;
  mtimeMs: number;
  size: number;
}

// Cheap directory scan: filenames + stat (mtimeMs, size) only -- NO body reads.
function statMemoryFiles(sessionsDir: string): MemoryFileStat[] {
  const dir = resolveAoiMemoriesDir(sessionsDir);
  let names: string[];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return [];
    }
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: MemoryFileStat[] = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(join(dir, name));
      out.push({ id: basename(name, '.json'), mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // A file that vanished mid-scan is simply skipped.
    }
  }
  return out;
}

function readIndexFile(sessionsDir: string): AoiMemoryIndex | null {
  try {
    const raw = fs.readFileSync(indexFilePath(sessionsDir), 'utf-8');
    const parsed = JSON.parse(raw) as AoiMemoryIndex;
    if (parsed && parsed.version === AOI_MEMORY_INDEX_VERSION && Array.isArray(parsed.entries)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeIndexFile(sessionsDir: string, index: AoiMemoryIndex): void {
  const filePath = indexFilePath(sessionsDir);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(index), 'utf-8');
}

// Load the index, self-healing it against the current on-disk memory files: reuse cached
// entries whose (mtimeMs, size) still match, re-read only new/changed files, and drop ids
// whose file is gone. Persists the refreshed index when anything changed. `now` stamps the
// index's updatedAt (cosmetic); it defaults to Date.now() but is injectable for tests.
export function loadOrRefreshAoiMemoryIndex(
  sessionsDir: string,
  now: number = Date.now(),
): AoiMemoryIndex {
  const stats = statMemoryFiles(sessionsDir);
  const prior = readIndexFile(sessionsDir);
  const priorById = new Map<string, AoiMemoryIndexEntry>(
    (prior?.entries ?? []).map((entry) => [entry.id, entry]),
  );
  const entries: AoiMemoryIndexEntry[] = [];
  const staleIds: string[] = [];
  let changed = false;
  for (const stat of stats) {
    const priorEntry = priorById.get(stat.id);
    if (priorEntry && priorEntry.mtimeMs === stat.mtimeMs && priorEntry.size === stat.size) {
      entries.push(priorEntry);
    } else {
      staleIds.push(stat.id);
      changed = true;
    }
  }
  // Re-read ONLY the new/changed bodies (the whole point: not the full store).
  if (staleIds.length > 0) {
    const statById = new Map(stats.map((stat) => [stat.id, stat]));
    for (const memory of loadServerAoiMemoriesByIds(sessionsDir, staleIds)) {
      const stat = statById.get(memory.id);
      if (stat) {
        entries.push(buildAoiMemoryIndexEntry(memory, stat));
      }
    }
  }
  // A removed file leaves its prior entry unmatched -> the entry set shrank.
  if (!prior || entries.length !== priorById.size) {
    changed = true;
  }
  const index: AoiMemoryIndex = {
    version: AOI_MEMORY_INDEX_VERSION,
    updatedAt: now,
    entries: sortAoiMemoryIndexEntries(entries),
  };
  if (changed) {
    try {
      writeIndexFile(sessionsDir, index);
    } catch {
      // Index persistence is best-effort; the in-memory index is still correct and the
      // caller's full-scan fallback covers a never-persisted index.
    }
  }
  return index;
}

// Force a full rebuild from the authoritative per-memory files (ignores any cached index).
export function rebuildAoiMemoryIndex(
  sessionsDir: string,
  now: number = Date.now(),
): AoiMemoryIndex {
  const stats = statMemoryFiles(sessionsDir);
  const statById = new Map(stats.map((stat) => [stat.id, stat]));
  const entries: AoiMemoryIndexEntry[] = [];
  for (const memory of loadServerAoiMemoriesByIds(
    sessionsDir,
    stats.map((stat) => stat.id),
  )) {
    const stat = statById.get(memory.id);
    if (stat) {
      entries.push(buildAoiMemoryIndexEntry(memory, stat));
    }
  }
  const index: AoiMemoryIndex = {
    version: AOI_MEMORY_INDEX_VERSION,
    updatedAt: now,
    entries: sortAoiMemoryIndexEntries(entries),
  };
  try {
    writeIndexFile(sessionsDir, index);
  } catch {
    // Best-effort persistence.
  }
  return index;
}

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

// Metadata-only criteria the index can evaluate WITHOUT a body. Mirrors the ledger's
// memoryMatchesCriteria field-for-field (status/scope/type/source/tags/projectKey/
// sessionPath) so an index-filtered set equals the full-scan-filtered set.
export interface AoiMemoryIndexCriteria {
  status?: AoiMemoryStatus | AoiMemoryStatus[];
  scope?: AoiMemoryScope | AoiMemoryScope[];
  type?: AoiMemoryType | AoiMemoryType[];
  source?: AoiMemorySourceCategory | AoiMemorySourceCategory[];
  tags?: string[];
  projectKey?: string;
  sessionPath?: string;
}

export function indexEntryMatchesCriteria(
  entry: AoiMemoryIndexEntry,
  criteria: AoiMemoryIndexCriteria,
  statuses: AoiMemoryStatus[],
): boolean {
  if (!statuses.includes(entry.status)) {
    return false;
  }
  const scopes = toArray(criteria.scope);
  if (scopes && !scopes.includes(entry.scope)) {
    return false;
  }
  const types = toArray(criteria.type);
  if (types && !types.includes(entry.type)) {
    return false;
  }
  const sources = toArray(criteria.source);
  if (sources && !sources.some((source) => entry.sources.includes(source))) {
    return false;
  }
  if (criteria.tags && criteria.tags.length > 0) {
    if (!criteria.tags.every((tag) => entry.tags.includes(tag))) {
      return false;
    }
  }
  if (criteria.projectKey !== undefined && entry.projectKey !== criteria.projectKey) {
    return false;
  }
  if (criteria.sessionPath !== undefined && entry.sessionPath !== criteria.sessionPath) {
    return false;
  }
  return true;
}

// The index-selected candidate ids (recency-ordered) for a metadata criteria. The ledger
// reads only these bodies.
export function selectAoiMemoryIndexIds(
  index: AoiMemoryIndex,
  criteria: AoiMemoryIndexCriteria,
  statuses: AoiMemoryStatus[],
): string[] {
  return sortAoiMemoryIndexEntries(
    index.entries.filter((entry) => indexEntryMatchesCriteria(entry, criteria, statuses)),
  ).map((entry) => entry.id);
}

// P4.5: the recall hot-path loader. Returns the ACTIVE memories (recency-ordered) by reading
// ONLY the active bodies the index selects -- so the accumulating archived/superseded bodies
// are never read/parsed on a recall tick. Identical result to
// `loadServerAoiMemories().filter(status === 'active')`, and falls back to exactly that on
// any index error, so it never hides a live memory. Callers keep their own `active` filter,
// so correctness holds even if the index misbehaves.
export function loadActiveAoiMemoriesViaIndex(sessionsDir: string): AoiMemoryEntry[] {
  try {
    const index = loadOrRefreshAoiMemoryIndex(sessionsDir);
    const ids = selectAoiMemoryIndexIds(index, {}, ['active']);
    return loadServerAoiMemoriesByIds(sessionsDir, ids);
  } catch {
    return loadServerAoiMemories(sessionsDir).filter((memory) => memory.status === 'active');
  }
}
