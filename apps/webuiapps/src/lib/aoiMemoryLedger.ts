// Unified memory ledger query/enumeration API (P4-d).
//
// Chat, Kira automation, and research memories all live in ONE on-disk server
// store (loadServerAoiMemories reads the shared memories dir), so a single query
// surface can span all three streams. This centralises the ad-hoc
// `loadServerAoiMemories().filter(...)` patterns behind one criteria object and
// adds the `source` dimension (derived, see deriveAoiMemorySources) as a queryable
// facet plus a store-wide enumeration for observability.
//
// Additive + READ-ONLY: it changes no runtime behavior and writes nothing -- it is
// a query layer over the existing store, for future consumers ((b) decay policy,
// operator observability). Server-only (loadServerAoiMemories imports fs).

import {
  deriveAoiMemorySources,
  type AoiMemoryEntry,
  type AoiMemoryScope,
  type AoiMemorySourceCategory,
  type AoiMemoryStatus,
  type AoiMemoryType,
} from './aoiMemoryShared';
import { loadServerAoiMemories, loadServerAoiMemoriesByIds } from './aoiMemoryServerWriter';
import { selectRelevantAoiMemoriesByEmbedding } from './aoiMemoryEmbedding';
import {
  loadOrRefreshAoiMemoryIndex,
  selectAoiMemoryIndexIds,
  type AoiMemoryIndexEntry,
} from './aoiMemoryIndex';

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

export interface AoiMemoryQueryCriteria {
  // Origin category (membership): a memory matches if ANY of its derived sources is
  // in the requested set.
  source?: AoiMemorySourceCategory | AoiMemorySourceCategory[];
  // Defaults to 'active' (the recall default). Pass explicitly (or an array) to
  // include superseded / archived memories.
  status?: AoiMemoryStatus | AoiMemoryStatus[];
  scope?: AoiMemoryScope | AoiMemoryScope[];
  type?: AoiMemoryType | AoiMemoryType[];
  // AND semantics: the memory must carry EVERY listed tag.
  tags?: string[];
  projectKey?: string;
  // Exact match on the owning session path.
  sessionPath?: string;
  // When set, the result is relevance-ranked (lexical, or fused with the semantic
  // score when queryEmbedding is supplied) instead of recency-ordered.
  text?: string;
  queryEmbedding?: number[] | null;
  queryEmbeddingModel?: string | null;
  limit?: number;
}

function memoryMatchesCriteria(
  memory: AoiMemoryEntry,
  criteria: AoiMemoryQueryCriteria,
  statuses: AoiMemoryStatus[],
): boolean {
  if (!statuses.includes(memory.status)) {
    return false;
  }
  const scopes = toArray(criteria.scope);
  if (scopes && !scopes.includes(memory.scope)) {
    return false;
  }
  const types = toArray(criteria.type);
  if (types && !types.includes(memory.type)) {
    return false;
  }
  const sources = toArray(criteria.source);
  if (sources) {
    const memorySources = deriveAoiMemorySources(memory);
    if (!sources.some((source) => memorySources.includes(source))) {
      return false;
    }
  }
  if (criteria.tags && criteria.tags.length > 0) {
    if (!criteria.tags.every((tag) => memory.tags.includes(tag))) {
      return false;
    }
  }
  if (criteria.projectKey !== undefined && memory.projectKey !== criteria.projectKey) {
    return false;
  }
  if (criteria.sessionPath !== undefined && memory.sessionPath !== criteria.sessionPath) {
    return false;
  }
  return true;
}

// Metadata-filter the store via the P4.5 index (reads ONLY the matched candidate bodies),
// falling back to the authoritative full scan on any index error. Returns the matched
// memories in recency order, identical to the full-scan filter.
function matchAoiMemoriesViaIndex(
  sessionsDir: string,
  criteria: AoiMemoryQueryCriteria,
  statuses: AoiMemoryStatus[],
): AoiMemoryEntry[] {
  try {
    const index = loadOrRefreshAoiMemoryIndex(sessionsDir);
    const ids = selectAoiMemoryIndexIds(index, criteria, statuses);
    // Read only the candidate bodies, preserving the index's recency order.
    return loadServerAoiMemoriesByIds(sessionsDir, ids);
  } catch {
    // Fail-safe: the full scan stays authoritative, so a broken index never hides a memory.
    return loadServerAoiMemories(sessionsDir).filter((memory) =>
      memoryMatchesCriteria(memory, criteria, statuses),
    );
  }
}

// Query the whole server memory store by the given criteria. Defaults to status
// 'active'. With `text` the result is relevance-ranked and capped to `limit` (or
// the full matched set when no limit); otherwise it is recency-ordered
// (updatedAt desc) and sliced to `limit`. P4.5: the metadata filter runs against the
// rebuildable index so only the matched candidate bodies are read, not the whole store.
export function queryAoiMemories(
  sessionsDir: string,
  criteria: AoiMemoryQueryCriteria = {},
): AoiMemoryEntry[] {
  const statuses = toArray(criteria.status) ?? ['active'];
  const matched = matchAoiMemoriesViaIndex(sessionsDir, criteria, statuses);
  if (criteria.text && criteria.text.trim()) {
    return selectRelevantAoiMemoriesByEmbedding(matched, criteria.text, {
      queryEmbedding: criteria.queryEmbedding ?? null,
      queryEmbeddingModel: criteria.queryEmbeddingModel ?? null,
      limit: criteria.limit ?? matched.length,
    });
  }
  if (typeof criteria.limit === 'number') {
    return matched.slice(0, Math.max(0, criteria.limit));
  }
  return matched;
}

export interface AoiMemoryLedgerSummary {
  total: number;
  bySource: Record<AoiMemorySourceCategory, number>;
  byStatus: Record<AoiMemoryStatus, number>;
  byScope: Record<AoiMemoryScope, number>;
  byType: Record<AoiMemoryType, number>;
}

// One facet of the store used for counting -- satisfied by BOTH an index entry (metadata,
// no body) and a full memory, so the summary path and its fallback share one counter.
interface AoiMemoryLedgerFacet {
  status: AoiMemoryStatus;
  scope: AoiMemoryScope;
  type: AoiMemoryType;
  sources: AoiMemorySourceCategory[];
}

function summarizeAoiMemoryFacets(facets: readonly AoiMemoryLedgerFacet[]): AoiMemoryLedgerSummary {
  const bySource: Record<AoiMemorySourceCategory, number> = {
    chat: 0,
    automation: 0,
    research: 0,
  };
  const byStatus: Record<AoiMemoryStatus, number> = { active: 0, superseded: 0, archived: 0 };
  const byScope: Record<AoiMemoryScope, number> = { user: 0, agent: 0, session: 0, project: 0 };
  const byType: Record<AoiMemoryType, number> = {
    fact: 0,
    preference: 0,
    decision: 0,
    event: 0,
    procedure: 0,
    action: 0,
    emotion: 0,
  };
  for (const facet of facets) {
    byStatus[facet.status] += 1;
    byScope[facet.scope] += 1;
    byType[facet.type] += 1;
    for (const source of facet.sources) {
      bySource[source] += 1;
    }
  }
  return { total: facets.length, bySource, byStatus, byScope, byType };
}

// Enumerate the whole store for observability -- counts across EVERY status (a full
// ledger view, not just active). bySource uses membership, so a multi-source memory
// counts in each of its categories and bySource may sum to more than `total`;
// byStatus / byScope / byType are exclusive and sum to `total`. P4.5: served from the index
// (status/scope/type/sources are all cached) so NO memory body is read, falling back to the
// full scan on any index error.
export function summarizeAoiMemoryLedger(sessionsDir: string): AoiMemoryLedgerSummary {
  try {
    const index = loadOrRefreshAoiMemoryIndex(sessionsDir);
    return summarizeAoiMemoryFacets(
      index.entries.map((entry: AoiMemoryIndexEntry) => ({
        status: entry.status,
        scope: entry.scope,
        type: entry.type,
        sources: entry.sources,
      })),
    );
  } catch {
    return summarizeAoiMemoryFacets(
      loadServerAoiMemories(sessionsDir).map((memory) => ({
        status: memory.status,
        scope: memory.scope,
        type: memory.type,
        sources: deriveAoiMemorySources(memory),
      })),
    );
  }
}
