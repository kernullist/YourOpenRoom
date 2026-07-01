import { describe, expect, it } from 'vitest';
import {
  AOI_CONSOLIDATION_COSINE_THRESHOLD,
  consolidateAoiMemories,
} from '../aoiMemoryConsolidation';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

// Vectors chosen so cosine to A=[1,0,0] is: B identical -> 1.0; C ~0.99; D 0.6.
const VEC_A = [1, 0, 0];
const VEC_B = [1, 0, 0];
const VEC_C = [0.99, 0.14, 0];
const VEC_D = [0.6, 0.8, 0];

let idCounter = 0;

function mem(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  idCounter += 1;
  return {
    version: 2,
    id: partial.id ?? `mem_${idCounter}`,
    scope: 'agent',
    type: 'fact',
    status: 'active',
    content: `content ${idCounter}`,
    normalizedContent: `content ${idCounter}`,
    importance: 0.7,
    confidence: 0.7,
    hits: 1,
    createdAt: 1000,
    updatedAt: 1000,
    sourceEpisodeIds: [`ep_${idCounter}`],
    tags: [],
    entities: [],
    embedding: VEC_A,
    embeddingModel: 'test-model',
    ...partial,
  };
}

const NOW = 5000;

describe('consolidateAoiMemories', () => {
  it('collapses near-duplicate active memories into the highest-importance canonical', () => {
    const canonicalSeed = mem({
      id: 'canon',
      importance: 0.9,
      confidence: 0.8,
      hits: 2,
      tags: ['kira', 'completed'],
      entities: ['ProjectX'],
      sourceEpisodeIds: ['ep_canon'],
      embedding: VEC_A,
    });
    const dupA = mem({
      id: 'dupA',
      importance: 0.7,
      confidence: 0.85,
      hits: 3,
      tags: ['kira', 'reviewed'],
      entities: ['ProjectX', 'file.ts'],
      sourceEpisodeIds: ['ep_dupA'],
      embedding: VEC_B,
    });
    const dupB = mem({
      id: 'dupB',
      importance: 0.6,
      confidence: 0.6,
      hits: 1,
      tags: ['kira'],
      entities: ['tool.exe'],
      sourceEpisodeIds: ['ep_dupB'],
      embedding: VEC_C,
    });

    const result = consolidateAoiMemories([dupB, canonicalSeed, dupA], { now: NOW });

    expect(result.clusterCount).toBe(1);
    expect(result.supersededCount).toBe(2);
    expect(new Set(result.changedIds)).toEqual(new Set(['canon', 'dupA', 'dupB']));

    const byId = new Map(result.memories.map((memory) => [memory.id, memory]));
    const canon = byId.get('canon');
    expect(canon).toBeDefined();
    expect(canon?.status).toBe('active');
    expect(canon?.content).toBe(canonicalSeed.content); // content unchanged (no synthesis)
    expect(canon?.importance).toBe(0.9); // max
    expect(canon?.confidence).toBeCloseTo(0.85); // max across the cluster
    expect(canon?.hits).toBe(2 + 3 + 1); // sum of absorbed hits
    expect(canon?.updatedAt).toBe(NOW);
    expect(new Set(canon?.tags)).toEqual(new Set(['kira', 'completed', 'reviewed']));
    expect(new Set(canon?.entities)).toEqual(new Set(['ProjectX', 'file.ts', 'tool.exe']));
    expect(new Set(canon?.sourceEpisodeIds)).toEqual(new Set(['ep_canon', 'ep_dupA', 'ep_dupB']));
    expect(new Set(canon?.supersedes)).toEqual(new Set(['dupA', 'dupB']));

    expect(byId.get('dupA')?.status).toBe('superseded');
    expect(byId.get('dupA')?.updatedAt).toBe(NOW);
    expect(byId.get('dupB')?.status).toBe('superseded');
  });

  it('leaves dissimilar memories untouched (below the cosine threshold)', () => {
    const a = mem({ id: 'a', embedding: VEC_A });
    const b = mem({ id: 'b', embedding: VEC_D }); // cosine 0.6 < 0.90

    const result = consolidateAoiMemories([a, b], { now: NOW });

    expect(result.clusterCount).toBe(0);
    expect(result.changedIds).toEqual([]);
    expect(result.memories.every((memory) => memory.status === 'active')).toBe(true);
  });

  it('never consolidates permanent memories', () => {
    const a = mem({ id: 'a', permanent: true, embedding: VEC_A });
    const b = mem({ id: 'b', permanent: true, embedding: VEC_B });

    const result = consolidateAoiMemories([a, b], { now: NOW });

    expect(result.clusterCount).toBe(0);
    expect(result.changedIds).toEqual([]);
  });

  it('skips memories without a usable embedding vector', () => {
    const a = mem({ id: 'a', embedding: VEC_A });
    const b = mem({ id: 'b', embedding: [] }); // no vector
    const c = mem({ id: 'c', embedding: undefined }); // no vector

    const result = consolidateAoiMemories([a, b, c], { now: NOW });

    expect(result.clusterCount).toBe(0);
    expect(result.changedIds).toEqual([]);
  });

  it('skips memories missing an embedding model id', () => {
    const a = mem({ id: 'a', embedding: VEC_A, embeddingModel: undefined });
    const b = mem({ id: 'b', embedding: VEC_B, embeddingModel: undefined });

    const result = consolidateAoiMemories([a, b], { now: NOW });

    expect(result.clusterCount).toBe(0);
  });

  it('does not cluster vectors from different embedding models', () => {
    const a = mem({ id: 'a', embedding: VEC_A, embeddingModel: 'model-1' });
    const b = mem({ id: 'b', embedding: VEC_B, embeddingModel: 'model-2' });

    const result = consolidateAoiMemories([a, b], { now: NOW });

    expect(result.clusterCount).toBe(0);
  });

  it('does not cluster across scope, type, or projectKey', () => {
    const scopeSplit = consolidateAoiMemories(
      [mem({ id: 'a', scope: 'agent' }), mem({ id: 'b', scope: 'user' })],
      { now: NOW },
    );
    expect(scopeSplit.clusterCount).toBe(0);

    const typeSplit = consolidateAoiMemories(
      [mem({ id: 'a', type: 'fact' }), mem({ id: 'b', type: 'preference' })],
      { now: NOW },
    );
    expect(typeSplit.clusterCount).toBe(0);

    const projectSplit = consolidateAoiMemories(
      [
        mem({ id: 'a', scope: 'project', projectKey: 'alpha' }),
        mem({ id: 'b', scope: 'project', projectKey: 'beta' }),
      ],
      { now: NOW },
    );
    expect(projectSplit.clusterCount).toBe(0);
  });

  it('honors the maxClusters bound, leaving later clusters for a future pass', () => {
    const cluster1 = [
      mem({ id: 'a1', scope: 'agent', type: 'fact', embedding: VEC_A }),
      mem({ id: 'a2', scope: 'agent', type: 'fact', embedding: VEC_B }),
    ];
    const cluster2 = [
      mem({ id: 'b1', scope: 'user', type: 'fact', embedding: VEC_A }),
      mem({ id: 'b2', scope: 'user', type: 'fact', embedding: VEC_B }),
    ];

    const result = consolidateAoiMemories([...cluster1, ...cluster2], {
      now: NOW,
      maxClusters: 1,
    });

    expect(result.clusterCount).toBe(1);
    expect(result.supersededCount).toBe(1);
  });

  it('honors the maxClusterSize cap, leaving the overflow member active for a later pass', () => {
    const members = [
      mem({ id: 'm1', importance: 0.9, embedding: VEC_A }),
      mem({ id: 'm2', importance: 0.8, embedding: VEC_B }),
      mem({ id: 'm3', importance: 0.7, embedding: VEC_C }),
    ];

    const result = consolidateAoiMemories(members, { now: NOW, maxClusterSize: 2 });

    expect(result.clusterCount).toBe(1);
    expect(result.supersededCount).toBe(1); // seed + 1 absorbed; 1 stays active
    const active = result.memories.filter((memory) => memory.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('is idempotent: a second pass over the collapsed output is a no-op', () => {
    const members = [
      mem({ id: 'a', importance: 0.9, embedding: VEC_A }),
      mem({ id: 'b', importance: 0.7, embedding: VEC_B }),
    ];

    const first = consolidateAoiMemories(members, { now: NOW });
    expect(first.clusterCount).toBe(1);

    const second = consolidateAoiMemories(first.memories, { now: NOW + 100 });
    expect(second.clusterCount).toBe(0);
    expect(second.changedIds).toEqual([]);
  });

  it('inherits the absorbed entries own supersedes provenance chain', () => {
    const canonical = mem({ id: 'canon', importance: 0.9, embedding: VEC_A });
    const absorbed = mem({
      id: 'dup',
      importance: 0.7,
      embedding: VEC_B,
      supersedes: ['ancestor-1', 'ancestor-2'],
    });

    const result = consolidateAoiMemories([canonical, absorbed], { now: NOW });

    const canon = result.memories.find((memory) => memory.id === 'canon');
    expect(new Set(canon?.supersedes)).toEqual(new Set(['dup', 'ancestor-1', 'ancestor-2']));
  });

  it('caps unioned tags and entities like the merge path', () => {
    const canonical = mem({
      id: 'canon',
      importance: 0.9,
      embedding: VEC_A,
      tags: ['t1', 't2', 't3', 't4', 't5'],
      entities: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
    });
    const absorbed = mem({
      id: 'dup',
      importance: 0.7,
      embedding: VEC_B,
      tags: ['t6', 't7', 't8', 't9', 't10'],
      entities: ['e7', 'e8', 'e9', 'e10', 'e11', 'e12'],
    });

    const result = consolidateAoiMemories([canonical, absorbed], { now: NOW });

    const canon = result.memories.find((memory) => memory.id === 'canon');
    expect(canon?.tags).toHaveLength(8);
    expect(canon?.entities).toHaveLength(10);
  });

  it('returns a stable no-op for empty or single-memory input', () => {
    expect(consolidateAoiMemories([], { now: NOW }).clusterCount).toBe(0);
    expect(consolidateAoiMemories([mem({ id: 'solo' })], { now: NOW }).changedIds).toEqual([]);
  });

  it('breaks canonical ties by confidence, then recency', () => {
    // Equal importance; higher confidence should win the canonical slot.
    const lowConfidence = mem({
      id: 'z-low',
      importance: 0.8,
      confidence: 0.6,
      embedding: VEC_A,
    });
    const highConfidence = mem({
      id: 'a-high',
      importance: 0.8,
      confidence: 0.9,
      embedding: VEC_B,
    });

    const result = consolidateAoiMemories([lowConfidence, highConfidence], { now: NOW });

    expect(result.memories.find((memory) => memory.id === 'a-high')?.status).toBe('active');
    expect(result.memories.find((memory) => memory.id === 'z-low')?.status).toBe('superseded');

    // Equal importance AND confidence; the more recent updatedAt wins.
    const older = mem({
      id: 'older',
      importance: 0.8,
      confidence: 0.7,
      updatedAt: 1000,
      embedding: VEC_A,
    });
    const newer = mem({
      id: 'newer',
      importance: 0.8,
      confidence: 0.7,
      updatedAt: 2000,
      embedding: VEC_B,
    });

    const recencyResult = consolidateAoiMemories([older, newer], { now: NOW });
    expect(recencyResult.memories.find((memory) => memory.id === 'newer')?.status).toBe('active');
    expect(recencyResult.memories.find((memory) => memory.id === 'older')?.status).toBe(
      'superseded',
    );
  });

  it('exposes a conservative default threshold', () => {
    expect(AOI_CONSOLIDATION_COSINE_THRESHOLD).toBe(0.9);
  });
});
