import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createAoiLocalEmbeddingProvider, embedAoiTextLocally } from '../aoiLocalEmbedding';
import { AOI_LOCAL_EMBEDDING_MODEL } from '../aoiLocalEmbeddingCore';
import {
  createAoiLocalEmbeddingBrowserProvider,
  embedAoiTextLocallyInBrowser,
} from '../aoiLocalEmbeddingBrowser';
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

describe('browser local embedder (crypto.subtle twin)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('produces byte-identical vectors to the node implementation', async () => {
    // The parity contract: a memory embedded by the server sweep must fuse with
    // a query embedded in the browser under the same aoi-local-hash-v1 model.
    vi.stubGlobal('crypto', webcrypto);
    const samples = [
      'Windows kernel anti-cheat driver',
      '커널 드라이버 IRQL 검증 이슈',
      'fromis_9 Supersonic playlist',
      'mixed 한글 english tokens 123',
    ];
    for (const text of samples) {
      expect(await embedAoiTextLocallyInBrowser(text)).toEqual(embedAoiTextLocally(text));
    }
  });

  it('exposes the same model id and embeds a batch', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const provider = createAoiLocalEmbeddingBrowserProvider();
    expect(provider?.model).toBe(AOI_LOCAL_EMBEDDING_MODEL);
    const vectors = await provider!.embed(['kernel driver', 'anti-cheat']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual(embedAoiTextLocally('kernel driver'));
  });

  it('returns null when Web Crypto is unavailable so recall stays lexical-only', () => {
    vi.stubGlobal('crypto', undefined);
    expect(createAoiLocalEmbeddingBrowserProvider()).toBeNull();
  });
});
