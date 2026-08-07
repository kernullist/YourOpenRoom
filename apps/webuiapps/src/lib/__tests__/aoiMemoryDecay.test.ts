import { describe, expect, it } from 'vitest';
import {
  AOI_DECAY_DEFAULT_CONFIDENCE_FLOOR,
  AOI_DECAY_DEFAULT_MAX_AGE_MS,
  applyAoiMemoryDecay,
  fingerprintAoiMemoryDecaySelection,
  selectAoiMemoryDecayCandidates,
  unarchiveAoiMemories,
} from '../aoiMemoryDecay';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

let seq = 0;

function mem(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  seq += 1;
  return {
    version: 2,
    id: partial.id ?? `mem_${seq}`,
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: `content ${seq}`,
    normalizedContent: `content ${seq}`,
    importance: 0.5,
    confidence: 0.3,
    hits: 1,
    createdAt: 0,
    updatedAt: 0,
    sourceEpisodeIds: [`ep_${seq}`],
    tags: [],
    entities: [],
    ...partial,
  };
}

// Explicit thresholds so the tests do not depend on the 90-day defaults.
const OPTS = { now: 10_000, maxAgeMs: 1_000, confidenceFloor: 0.5, maxHits: 1 };

function ids(candidates: ReturnType<typeof selectAoiMemoryDecayCandidates>): string[] {
  return candidates.map((c) => c.memory.id);
}

describe('selectAoiMemoryDecayCandidates', () => {
  it('selects an expired active memory (reason: expired)', () => {
    const m = mem({ id: 'exp', updatedAt: 9_999, confidence: 0.9, hits: 50, expiresAt: 5_000 });
    const [candidate] = selectAoiMemoryDecayCandidates([m], OPTS);
    expect(candidate?.memory.id).toBe('exp');
    expect(candidate?.reasons).toEqual(['expired']);
  });

  it('selects an aged + low-confidence + rarely-used memory', () => {
    const m = mem({ id: 'aged', updatedAt: 0, confidence: 0.3, hits: 1 });
    const [candidate] = selectAoiMemoryDecayCandidates([m], OPTS);
    expect(candidate?.memory.id).toBe('aged');
    expect(new Set(candidate?.reasons)).toEqual(new Set(['aged', 'low_confidence', 'low_hits']));
  });

  it('treats a recently RECALLED memory as in use, not aged out', () => {
    // Captured long ago and never re-captured, but Aoi keeps pulling it into
    // prompts -- forgetting it would delete something demonstrably useful.
    const recalled = mem({ id: 'recalled', updatedAt: 0, confidence: 0.3, hits: 1 });
    recalled.lastAccessedAt = 9_800;
    expect(ids(selectAoiMemoryDecayCandidates([recalled], OPTS))).toEqual([]);

    // Frequently recalled also clears the low-hits half on its own.
    const hot = mem({ id: 'hot', updatedAt: 0, confidence: 0.3, hits: 1 });
    hot.recallHits = 9;
    expect(ids(selectAoiMemoryDecayCandidates([hot], OPTS))).toEqual([]);

    // An old recall does not rescue it forever.
    const stale = mem({ id: 'stale', updatedAt: 0, confidence: 0.3, hits: 1 });
    stale.lastAccessedAt = 100;
    expect(ids(selectAoiMemoryDecayCandidates([stale], OPTS))).toEqual(['stale']);
  });

  it('requires ALL of aged, low-confidence, and low-hits (AND)', () => {
    // aged + low-confidence but well-used -> not a candidate
    expect(
      selectAoiMemoryDecayCandidates(
        [mem({ id: 'used', updatedAt: 0, confidence: 0.3, hits: 5 })],
        OPTS,
      ),
    ).toEqual([]);
    // aged + rarely-used but confident -> not a candidate
    expect(
      selectAoiMemoryDecayCandidates(
        [mem({ id: 'conf', updatedAt: 0, confidence: 0.9, hits: 1 })],
        OPTS,
      ),
    ).toEqual([]);
    // low-confidence + rarely-used but recent -> not a candidate
    expect(
      selectAoiMemoryDecayCandidates(
        [mem({ id: 'recent', updatedAt: 9_999, confidence: 0.3, hits: 1 })],
        OPTS,
      ),
    ).toEqual([]);
  });

  it('never selects permanent or non-active memories', () => {
    const permanent = mem({ id: 'perm', updatedAt: 0, confidence: 0.1, hits: 0, permanent: true });
    const superseded = mem({
      id: 'sup',
      updatedAt: 0,
      confidence: 0.1,
      hits: 0,
      status: 'superseded',
    });
    const archived = mem({ id: 'arc', updatedAt: 0, confidence: 0.1, hits: 0, status: 'archived' });
    const expiredPermanent = mem({
      id: 'expperm',
      permanent: true,
      expiresAt: 1,
      updatedAt: 9_999,
    });
    expect(
      selectAoiMemoryDecayCandidates([permanent, superseded, archived, expiredPermanent], OPTS),
    ).toEqual([]);
  });

  it('orders oldest-first (updatedAt asc, id tiebreak) and caps at max', () => {
    const a = mem({ id: 'a', updatedAt: 300, confidence: 0.1, hits: 0 });
    const b = mem({ id: 'b', updatedAt: 100, confidence: 0.1, hits: 0 });
    const c = mem({ id: 'c', updatedAt: 100, confidence: 0.1, hits: 0 });
    const result = selectAoiMemoryDecayCandidates([a, b, c], { ...OPTS, max: 2 });
    // updatedAt 100 (b, c by id) come before 300 (a); capped to 2.
    expect(ids(result)).toEqual(['b', 'c']);
  });

  it('exposes conservative defaults', () => {
    expect(AOI_DECAY_DEFAULT_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    expect(AOI_DECAY_DEFAULT_CONFIDENCE_FLOOR).toBe(0.5);
  });

  it('applies the conservative defaults when thresholds are omitted', () => {
    const now = 200 * 24 * 60 * 60 * 1000; // 200 days
    // ~200 days old (> 90d default), confidence 0.3 (< 0.5 default), hits 1 (<= 1 default).
    const stale = mem({ id: 'stale', updatedAt: 0, confidence: 0.3, hits: 1 });
    const fresh = mem({ id: 'fresh', updatedAt: now - 1_000, confidence: 0.9, hits: 10 });
    expect(ids(selectAoiMemoryDecayCandidates([stale, fresh], { now }))).toEqual(['stale']);
  });
});

describe('fingerprintAoiMemoryDecaySelection', () => {
  it('is deterministic, order-independent, and set-based (dedupes)', () => {
    expect(fingerprintAoiMemoryDecaySelection(['a', 'b'])).toBe(
      fingerprintAoiMemoryDecaySelection(['b', 'a']),
    );
    expect(fingerprintAoiMemoryDecaySelection(['a', 'a', 'b'])).toBe(
      fingerprintAoiMemoryDecaySelection(['a', 'b']),
    );
  });

  it('differs when the set differs', () => {
    expect(fingerprintAoiMemoryDecaySelection(['a', 'b'])).not.toBe(
      fingerprintAoiMemoryDecaySelection(['a', 'c']),
    );
    // The empty set has a stable fingerprint too.
    expect(fingerprintAoiMemoryDecaySelection([])).toBe(fingerprintAoiMemoryDecaySelection([]));
  });
});

describe('applyAoiMemoryDecay', () => {
  it('flips active memories in the id set to archived and skips the rest', () => {
    const active = mem({ id: 'a', status: 'active' });
    const already = mem({ id: 'b', status: 'superseded' });
    const other = mem({ id: 'c', status: 'active' });
    const result = applyAoiMemoryDecay([active, already, other], ['a', 'b', 'unknown'], 9_000);

    expect(result.changedIds).toEqual(['a']); // only the active 'a'; 'b' non-active, 'unknown' absent
    const byId = new Map(result.memories.map((m) => [m.id, m]));
    expect(byId.get('a')?.status).toBe('archived');
    expect(byId.get('a')?.updatedAt).toBe(9_000);
    expect(byId.get('b')?.status).toBe('superseded'); // untouched
    expect(byId.get('c')?.status).toBe('active'); // not in the set
  });

  it('does not mutate the input array or entries', () => {
    const active = mem({ id: 'a', status: 'active', updatedAt: 1 });
    const input = [active];
    applyAoiMemoryDecay(input, ['a'], 9_000);
    expect(active.status).toBe('active'); // original entry untouched
    expect(active.updatedAt).toBe(1);
  });
});

describe('unarchiveAoiMemories', () => {
  it('restores archived memories to active and skips non-archived', () => {
    const archived = mem({ id: 'a', status: 'archived' });
    const active = mem({ id: 'b', status: 'active' });
    const result = unarchiveAoiMemories([archived, active], ['a', 'b'], 9_000);

    expect(result.changedIds).toEqual(['a']); // only the archived 'a'
    const byId = new Map(result.memories.map((m) => [m.id, m]));
    expect(byId.get('a')?.status).toBe('active');
    expect(byId.get('a')?.updatedAt).toBe(9_000);
    expect(byId.get('b')?.status).toBe('active'); // was already active, untouched
  });

  it('round-trips with applyAoiMemoryDecay', () => {
    const m = mem({ id: 'a', status: 'active' });
    const archived = applyAoiMemoryDecay([m], ['a'], 100);
    expect(archived.memories[0].status).toBe('archived');
    const restored = unarchiveAoiMemories(archived.memories, ['a'], 200);
    expect(restored.memories[0].status).toBe('active');
  });
});
