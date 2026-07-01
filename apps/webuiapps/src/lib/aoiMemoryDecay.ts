// Memory decay / forgetting (P4-b): the ONLY destructive-adjacent memory op.
//
// Left unbounded, the active server memory set grows forever. This selects
// low-value ACTIVE memories -- expired, or old + low-confidence + rarely-used --
// as candidates to ARCHIVE (soft-delete). It is deliberately conservative and
// NON-destructive:
//   - Soft-delete ONLY: archiving flips status to 'archived'; the memory file is
//     kept on disk (the server writer never deletes), and unarchive restores it.
//     There is NO hard delete.
//   - Permanent memories are NEVER candidates (protected, like consolidation).
//   - NO self-activation: this module only SELECTS + shapes; the writer's archive
//     call requires an explicit operator-approved id set bound by a content-addressed
//     fingerprint (see aoiMemoryServerWriter). The dry-run selection is read-only.
//   - Archived memories are already excluded by every recall consumer (they filter
//     status === 'active'), so archiving actually stops a memory surfacing.
//
// Pure + server-safe (no fs): the server writer owns load/persist and the approval
// gate; this module only computes candidates and the next in-memory list, mirroring
// the { memories, changedIds } contract used by the merge/consolidation paths.

import type { AoiMemoryEntry } from './aoiMemoryShared';

// Conservative defaults: only clearly-stale, clearly-low-value memories qualify.
// All overridable by the caller (and, later, the operator UI).
export const AOI_DECAY_DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const AOI_DECAY_DEFAULT_CONFIDENCE_FLOOR = 0.5;
export const AOI_DECAY_DEFAULT_MAX_HITS = 1;
export const AOI_DECAY_DEFAULT_MAX_PER_PASS = 64;

export type AoiMemoryDecayReason = 'expired' | 'aged' | 'low_confidence' | 'low_hits';

export interface AoiMemoryDecayOptions {
  now: number;
  maxAgeMs?: number;
  confidenceFloor?: number;
  maxHits?: number;
  // Upper bound on candidates returned per pass (bounds one archive batch).
  max?: number;
}

interface ResolvedDecayOptions {
  maxAgeMs: number;
  confidenceFloor: number;
  maxHits: number;
  max: number;
}

function resolveDecayOptions(options: AoiMemoryDecayOptions): ResolvedDecayOptions {
  return {
    maxAgeMs: options.maxAgeMs ?? AOI_DECAY_DEFAULT_MAX_AGE_MS,
    confidenceFloor: options.confidenceFloor ?? AOI_DECAY_DEFAULT_CONFIDENCE_FLOOR,
    maxHits: options.maxHits ?? AOI_DECAY_DEFAULT_MAX_HITS,
    max: Math.max(1, options.max ?? AOI_DECAY_DEFAULT_MAX_PER_PASS),
  };
}

// Evaluate one memory against the decay policy. A candidate is an ACTIVE,
// non-permanent memory that is either past its explicit TTL (expiresAt), OR
// simultaneously old, low-confidence, AND rarely used. Returns the matched
// reasons (empty when not a candidate). Shared by selection + the dry-run report
// so the two never drift.
export function evaluateAoiMemoryDecayCandidate(
  memory: AoiMemoryEntry,
  resolved: ResolvedDecayOptions,
  now: number,
): AoiMemoryDecayReason[] {
  if (memory.status !== 'active' || memory.permanent) {
    return [];
  }
  const reasons: AoiMemoryDecayReason[] = [];
  if (typeof memory.expiresAt === 'number' && memory.expiresAt <= now) {
    reasons.push('expired');
  }
  const aged = now - memory.updatedAt > resolved.maxAgeMs;
  const lowConfidence = memory.confidence < resolved.confidenceFloor;
  const lowHits = memory.hits <= resolved.maxHits;
  if (aged && lowConfidence && lowHits) {
    reasons.push('aged', 'low_confidence', 'low_hits');
  }
  return reasons;
}

export interface AoiMemoryDecayCandidate {
  memory: AoiMemoryEntry;
  reasons: AoiMemoryDecayReason[];
}

// Select decay candidates, oldest-first (updatedAt asc, then id asc for a stable
// total order), capped at `max`. Pure + read-only over the input.
export function selectAoiMemoryDecayCandidates(
  memories: readonly AoiMemoryEntry[],
  options: AoiMemoryDecayOptions,
): AoiMemoryDecayCandidate[] {
  const resolved = resolveDecayOptions(options);
  const now = options.now;
  const matched: AoiMemoryDecayCandidate[] = [];
  for (const memory of memories) {
    const reasons = evaluateAoiMemoryDecayCandidate(memory, resolved, now);
    if (reasons.length > 0) {
      matched.push({ memory, reasons });
    }
  }
  matched.sort((a, b) => {
    if (a.memory.updatedAt !== b.memory.updatedAt) {
      return a.memory.updatedAt - b.memory.updatedAt;
    }
    return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
  });
  return matched.slice(0, resolved.max);
}

// Content-addressed fingerprint of a candidate id SET (deduped + sorted, so it is
// order-independent). FNV-1a/32 hex -- deterministic and dependency-free; it only
// needs to detect that the approved set differs from what was reviewed, and archive
// is a recoverable soft-delete, so a cryptographic hash is unnecessary.
export function fingerprintAoiMemoryDecaySelection(ids: readonly string[]): string {
  const joined = [...new Set(ids)].sort().join('\n');
  let hash = 2166136261;
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface AoiMemoryDecayMutationResult {
  memories: AoiMemoryEntry[];
  changedIds: string[];
}

// Archive (soft-delete) the given ids: flip ACTIVE -> 'archived' in place on a
// shallow clone. Only active memories in the id set are touched (a non-active or
// unknown id is skipped defensively), so the caller can pass a slightly stale set
// without corrupting anything. Never deletes.
export function applyAoiMemoryDecay(
  memories: readonly AoiMemoryEntry[],
  ids: readonly string[],
  now: number,
): AoiMemoryDecayMutationResult {
  const target = new Set(ids);
  const changedIds: string[] = [];
  const next = memories.map((memory) => {
    if (target.has(memory.id) && memory.status === 'active') {
      changedIds.push(memory.id);
      return { ...memory, status: 'archived' as const, updatedAt: now };
    }
    return memory;
  });
  return { memories: next, changedIds };
}

// Recovery: flip ARCHIVED -> 'active' for the given ids (skip non-archived). The
// inverse of applyAoiMemoryDecay, so an archived memory is fully restorable.
export function unarchiveAoiMemories(
  memories: readonly AoiMemoryEntry[],
  ids: readonly string[],
  now: number,
): AoiMemoryDecayMutationResult {
  const target = new Set(ids);
  const changedIds: string[] = [];
  const next = memories.map((memory) => {
    if (target.has(memory.id) && memory.status === 'archived') {
      changedIds.push(memory.id);
      return { ...memory, status: 'active' as const, updatedAt: now };
    }
    return memory;
  });
  return { memories: next, changedIds };
}
