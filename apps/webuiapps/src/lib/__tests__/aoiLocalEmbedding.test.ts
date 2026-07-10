import { describe, expect, it } from 'vitest';
import {
  AOI_LOCAL_EMBEDDING_MODEL,
  createAoiLocalEmbeddingProvider,
  embedAoiTextLocally,
} from '../aoiLocalEmbedding';
import { cosineSimilarity } from '../aoiMemoryEmbedding';
import { createServerAoiEmbeddingProvider } from '../aoiMemoryEmbeddingServer';

describe('embedAoiTextLocally()', () => {
  it('is deterministic and L2-normalized', () => {
    const a = embedAoiTextLocally('Windows kernel anti-cheat driver');
    const b = embedAoiTextLocally('Windows kernel anti-cheat driver');
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('scores overlapping text higher than unrelated text (lexical-grade cosine)', () => {
    const query = embedAoiTextLocally('kernel driver memory protection');
    const related = embedAoiTextLocally('kernel driver memory telemetry');
    const unrelated = embedAoiTextLocally('cooking pasta recipe for dinner');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('returns a zero vector for empty / too-short input', () => {
    expect(embedAoiTextLocally('   a  ').every((value) => value === 0)).toBe(true);
    expect(embedAoiTextLocally('').every((value) => value === 0)).toBe(true);
  });
});

describe('createAoiLocalEmbeddingProvider()', () => {
  it('exposes the local model and embeds a batch offline', async () => {
    const provider = createAoiLocalEmbeddingProvider();
    expect(provider.model).toBe(AOI_LOCAL_EMBEDDING_MODEL);
    const vectors = await provider.embed(['kernel driver', 'anti-cheat']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(256);
  });
});

describe('createServerAoiEmbeddingProvider local fallback (P4.4)', () => {
  it('returns the offline local provider when opted in and no cloud key is set', () => {
    const provider = createServerAoiEmbeddingProvider({ env: { AOI_LOCAL_EMBEDDER: '1' } });
    expect(provider?.model).toBe(AOI_LOCAL_EMBEDDING_MODEL);
  });

  it('stays null (lexical fallback) when the local embedder is not opted in', () => {
    expect(createServerAoiEmbeddingProvider({ env: {} })).toBeNull();
  });
});
