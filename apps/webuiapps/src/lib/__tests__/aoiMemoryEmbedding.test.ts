import { describe, expect, it } from 'vitest';
import { cosineSimilarity, createAoiGeminiEmbeddingProvider } from '../aoiMemoryEmbedding';
import { scoreAoiMemoryForQuery, type AoiMemoryEntry } from '../aoiMemoryManager';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it('is 0 for mismatched or empty vectors', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('scoreAoiMemoryForQuery semantic fusion', () => {
  const makeMemory = (over: Partial<AoiMemoryEntry>): AoiMemoryEntry =>
    ({
      version: 2,
      id: 'm',
      scope: 'session',
      type: 'fact',
      status: 'active',
      content: 'totally unrelated tokens here',
      normalizedContent: 'totally unrelated tokens here',
      importance: 0.5,
      confidence: 0.8,
      hits: 0,
      createdAt: 0,
      updatedAt: 0,
      sourceEpisodeIds: [],
      tags: [],
      entities: [],
      ...over,
    }) as AoiMemoryEntry;

  it('boosts a memory that is semantically similar despite no token overlap', () => {
    const queryEmbedding = [1, 0, 0];
    const withEmbedding = makeMemory({ embedding: [1, 0, 0] });
    const withoutEmbedding = makeMemory({});
    const scoreWith = scoreAoiMemoryForQuery(
      withEmbedding,
      'query with no shared words',
      0,
      queryEmbedding,
    );
    const scoreWithout = scoreAoiMemoryForQuery(
      withoutEmbedding,
      'query with no shared words',
      0,
      queryEmbedding,
    );
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });

  it('falls back to lexical scoring unchanged when there is no query embedding', () => {
    const withEmbedding = makeMemory({ embedding: [1, 0, 0] });
    const withoutEmbedding = makeMemory({});
    const a = scoreAoiMemoryForQuery(withEmbedding, 'query with no shared words', 0);
    const b = scoreAoiMemoryForQuery(withoutEmbedding, 'query with no shared words', 0);
    expect(a).toBe(b);
  });
});

describe('createAoiGeminiEmbeddingProvider', () => {
  it('returns empty vectors on a failed response without throwing', async () => {
    const provider = createAoiGeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => ({ ok: false }) as Response) as typeof fetch,
    });
    expect(await provider.embed(['hello'])).toEqual([[]]);
  });

  it('parses embedding values from a successful response', async () => {
    const provider = createAoiGeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        ({
          ok: true,
          json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }),
        }) as unknown as Response) as typeof fetch,
    });
    expect(await provider.embed(['hello'])).toEqual([[0.1, 0.2, 0.3]]);
  });
});
