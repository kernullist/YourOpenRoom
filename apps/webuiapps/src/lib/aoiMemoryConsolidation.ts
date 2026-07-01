// Memory consolidation (P4-a): deterministic near-duplicate collapse.
//
// Recall accretes many near-duplicate active memories (the kira/research streams
// especially -- each run writes a similar "Kira completed project work ..." /
// "Aoi completed research ..." entry that the exact-normalizedContent dedup does
// NOT catch because a detail differs). Left unbounded, these near-dups crowd out
// other sources in the query-ranked, capped recall consumers.
//
// This collapses a cluster of near-duplicate ACTIVE memories into the strongest
// existing member (the "canonical"): the canonical absorbs the others' tags,
// entities, source episodes, hit counts, and the max importance/confidence, and
// records them in its supersedes[]; the others flip to status 'superseded'. It is
// PURELY deterministic and NON-destructive:
//   - No synthetic text -- the canonical keeps its own content verbatim, so there
//     is no fabrication surface (LLM summarization is a separate opt-in path).
//   - Superseded originals are only status-flipped, never deleted -- the server
//     writer keeps their files on disk, so the collapse is reversible.
//   - Requires embeddings: only memories that carry a model-compatible vector are
//     clustered (cosine); a memory without a vector is skipped until the embed
//     backfill/sweep gives it one. No key -> no vectors -> a no-op, so lexical
//     recall is unaffected and the embedding key stays the true opt-in.
//
// Pure + server-safe (no fs): the server writer owns load/persist; this module
// only shapes the next in-memory memory list. Structurally it mirrors
// mergeServerAoiMemoryCandidates' { memories, changedIds } contract so the two
// never drift in how they report what changed.

import { cosineSimilarity } from './aoiMemoryEmbedding';
import type { AoiMemoryEntry } from './aoiMemoryShared';

// A near-duplicate threshold high enough that only genuine restatements collapse
// (0.90 cosine); combined with the same-(scope,type,projectKey,model) bucketing
// below, this keeps distinct facts -- even ones sharing heavy boilerplate -- apart.
export const AOI_CONSOLIDATION_COSINE_THRESHOLD = 0.9;

const DEFAULT_MIN_CLUSTER_SIZE = 2;
const DEFAULT_MAX_CLUSTER_SIZE = 5;
const DEFAULT_MAX_CLUSTERS = 8;
const MAX_TAGS = 8;
const MAX_ENTITIES = 10;

export interface ConsolidateAoiMemoriesOptions {
  now: number;
  cosineThreshold?: number;
  minClusterSize?: number;
  maxClusterSize?: number;
  // Upper bound on how many clusters a single pass collapses, so one call can
  // never rewrite the whole store; leftovers converge over later passes.
  maxClusters?: number;
}

export interface ConsolidateAoiMemoriesResult {
  memories: AoiMemoryEntry[];
  changedIds: string[];
  clusterCount: number;
  supersededCount: number;
}

// Consolidation only touches ACTIVE, non-permanent memories that carry a usable
// embedding vector + model id. Permanent memories (e.g. research) are protected
// -- mirroring the merge machinery's existing permanent-conflict guard -- and a
// vector-less memory waits for the embed backfill before it becomes eligible.
function isConsolidationEligible(memory: AoiMemoryEntry): boolean {
  return (
    memory.status === 'active' &&
    !memory.permanent &&
    Array.isArray(memory.embedding) &&
    memory.embedding.length > 0 &&
    typeof memory.embeddingModel === 'string' &&
    memory.embeddingModel.length > 0
  );
}

// Bucket key: only memories that share scope, type, projectKey, AND embedding
// model may cluster. Same scope/type keeps a preference from collapsing into a
// fact; same projectKey stops two different Kira projects from merging on shared
// boilerplate; same model keeps cosine comparing vectors from one space. The '|'
// separator is safe -- scope/type are enums and projectKey is sanitized to
// [A-Za-z0-9._-]. (projectKey is undefined for non-project scopes, so those
// naturally bucket together.)
function bucketKey(memory: AoiMemoryEntry): string {
  return `${memory.scope}|${memory.type}|${memory.projectKey ?? ''}|${memory.embeddingModel ?? ''}`;
}

// Total, deterministic ordering: strongest first by importance, then confidence,
// then recency, then id (ascending) as a stable final tiebreak so clustering and
// canonical selection are reproducible across runs.
function compareForCanonical(a: AoiMemoryEntry, b: AoiMemoryEntry): number {
  if (b.importance !== a.importance) {
    return b.importance - a.importance;
  }
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Fold the absorbed near-duplicates into the canonical in place and flip each
// absorbed entry to 'superseded'. Union tags/entities/sourceEpisodeIds (capped
// like the merge path), inherit each absorbed entry's own supersedes[] so the
// provenance chain is preserved, take the max importance/confidence, and sum the
// hit counts. Returns the ids that were superseded.
function collapseCluster(
  canonical: AoiMemoryEntry,
  absorbed: AoiMemoryEntry[],
  now: number,
): string[] {
  const tags = new Set(canonical.tags);
  const entities = new Set(canonical.entities);
  const sourceEpisodeIds = new Set(canonical.sourceEpisodeIds);
  const supersedes = new Set(canonical.supersedes ?? []);
  let importance = canonical.importance;
  let confidence = canonical.confidence;
  let absorbedHits = 0;
  const supersededIds: string[] = [];

  for (const other of absorbed) {
    other.tags.forEach((tag) => tags.add(tag));
    other.entities.forEach((entity) => entities.add(entity));
    other.sourceEpisodeIds.forEach((id) => sourceEpisodeIds.add(id));
    (other.supersedes ?? []).forEach((id) => supersedes.add(id));
    supersedes.add(other.id);
    importance = Math.max(importance, other.importance);
    confidence = Math.max(confidence, other.confidence);
    absorbedHits += Math.max(0, other.hits);
    other.status = 'superseded';
    other.updatedAt = now;
    supersededIds.push(other.id);
  }

  canonical.tags = [...tags].slice(0, MAX_TAGS);
  canonical.entities = [...entities].slice(0, MAX_ENTITIES);
  canonical.sourceEpisodeIds = [...sourceEpisodeIds];
  canonical.supersedes = [...supersedes];
  canonical.importance = importance;
  canonical.confidence = confidence;
  canonical.hits += absorbedHits;
  canonical.updatedAt = now;
  return supersededIds;
}

export function consolidateAoiMemories(
  memories: readonly AoiMemoryEntry[],
  options: ConsolidateAoiMemoriesOptions,
): ConsolidateAoiMemoriesResult {
  const now = options.now;
  const threshold = options.cosineThreshold ?? AOI_CONSOLIDATION_COSINE_THRESHOLD;
  const minClusterSize = Math.max(2, options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE);
  const maxClusterSize = Math.max(
    minClusterSize,
    options.maxClusterSize ?? DEFAULT_MAX_CLUSTER_SIZE,
  );
  const maxClusters = Math.max(1, options.maxClusters ?? DEFAULT_MAX_CLUSTERS);

  const next = memories.map((memory) => ({ ...memory }));
  const changedIds = new Set<string>();
  let clusterCount = 0;
  let supersededCount = 0;

  const buckets = new Map<string, AoiMemoryEntry[]>();
  for (const memory of next) {
    if (!isConsolidationEligible(memory)) {
      continue;
    }
    const key = bucketKey(memory);
    const list = buckets.get(key);
    if (list) {
      list.push(memory);
    } else {
      buckets.set(key, [memory]);
    }
  }

  // Deterministic bucket order so the maxClusters cap always keeps the same
  // clusters when the store exceeds one pass.
  const orderedKeys = [...buckets.keys()].sort();
  for (const key of orderedKeys) {
    if (clusterCount >= maxClusters) {
      break;
    }
    const members = buckets.get(key);
    if (!members || members.length < minClusterSize) {
      continue;
    }
    // Strongest-first: the first unassigned member is the cluster seed and, being
    // ahead of every remaining member in this order, is always the canonical.
    members.sort(compareForCanonical);
    const assigned = new Set<string>();

    for (const seed of members) {
      if (clusterCount >= maxClusters) {
        break;
      }
      if (assigned.has(seed.id) || !seed.embedding) {
        continue;
      }
      // Gather unassigned near-duplicates by cosine-to-seed (a centroid-free,
      // single-seed grouping so similarity is never transitive/chained), most
      // similar first, capped to the cluster size.
      const near = members
        .filter(
          (candidate) =>
            candidate.id !== seed.id &&
            !assigned.has(candidate.id) &&
            Array.isArray(candidate.embedding) &&
            candidate.embedding.length > 0,
        )
        .map((candidate) => ({
          candidate,
          similarity: cosineSimilarity(seed.embedding as number[], candidate.embedding as number[]),
        }))
        .filter((scored) => scored.similarity >= threshold)
        .sort(
          (left, right) =>
            right.similarity - left.similarity ||
            compareForCanonical(left.candidate, right.candidate),
        );
      if (near.length === 0) {
        continue;
      }

      const absorbed = near.slice(0, maxClusterSize - 1).map((scored) => scored.candidate);
      assigned.add(seed.id);
      for (const entry of absorbed) {
        assigned.add(entry.id);
      }
      const supersededIds = collapseCluster(seed, absorbed, now);
      changedIds.add(seed.id);
      for (const id of supersededIds) {
        changedIds.add(id);
      }
      supersededCount += supersededIds.length;
      clusterCount += 1;
    }
  }

  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return { memories: next, changedIds: [...changedIds], clusterCount, supersededCount };
}
