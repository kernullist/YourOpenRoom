import { describe, expect, it, vi } from 'vitest';
import {
  attachAoiMemoryEmbeddings,
  cosineSimilarity,
  createAoiEmbeddingProviderFromConfig,
  createAoiGeminiEmbeddingProvider,
  createAoiOpenAiCompatibleEmbeddingProvider,
  embedAoiQuery,
  lexicalOverlapScore,
  scoreAoiMemoryRelevance,
  selectRelevantAoiMemoriesByEmbedding,
} from '../aoiMemoryEmbedding';
import {
  AOI_EMBEDDING_DEFAULT_BASE_URL,
  AOI_EMBEDDING_DEFAULT_MODEL,
  normalizeAoiEmbeddingConfig,
} from '../configPersistence';
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

describe('lexicalOverlapScore', () => {
  it('is high when the query tokens are fully contained in the content', () => {
    expect(lexicalOverlapScore('deploy script', 'how to deploy the script safely')).toBe(1);
  });
  it('is 0 when there is no shared token', () => {
    expect(lexicalOverlapScore('alpha beta', 'gamma delta')).toBe(0);
  });
  it('is 0 when either side has no usable tokens', () => {
    expect(lexicalOverlapScore('', 'anything here')).toBe(0);
    expect(lexicalOverlapScore('anything here', '   ')).toBe(0);
    // Single-char tokens are dropped (2-char minimum).
    expect(lexicalOverlapScore('a', 'a b c')).toBe(0);
  });
  it('tokenizes Korean and other Unicode scripts', () => {
    expect(lexicalOverlapScore('배포 스크립트', '배포 자동화 스크립트 가이드')).toBeGreaterThan(0);
  });
  it('is case-insensitive', () => {
    expect(lexicalOverlapScore('Deploy', 'deploy now')).toBe(1);
  });
});

describe('scoreAoiMemoryRelevance', () => {
  it('takes the stronger of lexical and semantic', () => {
    // No token overlap but identical embeddings -> semantic dominates.
    const score = scoreAoiMemoryRelevance({
      query: 'totally different words',
      content: 'unrelated content tokens',
      embedding: [1, 0, 0],
      queryEmbedding: [1, 0, 0],
    });
    expect(score).toBeCloseTo(1);
  });
  it('reduces to lexical when there is no usable embedding pair', () => {
    const withMismatch = scoreAoiMemoryRelevance({
      query: 'deploy script',
      content: 'deploy the script',
      embedding: [1, 0],
      queryEmbedding: [1, 0, 0],
    });
    const lexicalOnly = scoreAoiMemoryRelevance({
      query: 'deploy script',
      content: 'deploy the script',
    });
    expect(withMismatch).toBe(lexicalOnly);
    expect(lexicalOnly).toBe(1);
  });
  it('ignores a negative cosine (semantic floor is 0)', () => {
    const score = scoreAoiMemoryRelevance({
      query: 'no shared tokens',
      content: 'entirely other',
      embedding: [1, 0],
      queryEmbedding: [-1, 0],
    });
    expect(score).toBe(0);
  });
});

describe('selectRelevantAoiMemoriesByEmbedding', () => {
  const mem = (content: string, embedding?: number[]) => ({ content, embedding });

  it('ranks by fused relevance and respects the limit', () => {
    const memories = [
      mem('an unrelated note about lunch'),
      mem('the deploy script lives in scripts/deploy.sh'),
      mem('another deploy note for the script'),
    ];
    const out = selectRelevantAoiMemoriesByEmbedding(memories, 'deploy script', { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.content.includes('deploy'))).toBe(true);
  });

  it('uses semantic similarity to surface a paraphrase with no shared tokens', () => {
    const memories = [
      mem('completely irrelevant filler', [0, 1, 0]),
      mem('paraphrased target with different words', [1, 0, 0]),
    ];
    const out = selectRelevantAoiMemoriesByEmbedding(memories, 'the original phrasing', {
      queryEmbedding: [1, 0, 0],
      limit: 1,
    });
    expect(out[0].content).toBe('paraphrased target with different words');
  });

  it('drops zero-relevance memories when minScore is above 0', () => {
    const memories = [mem('deploy script note'), mem('unrelated lunch plan')];
    const out = selectRelevantAoiMemoriesByEmbedding(memories, 'deploy script', {
      limit: 5,
      minScore: 0.01,
    });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('deploy script note');
  });

  it('is a stable lexical top-K when no embeddings are present', () => {
    const memories = [mem('first match deploy'), mem('second match deploy')];
    const out = selectRelevantAoiMemoriesByEmbedding(memories, 'deploy', { limit: 5 });
    expect(out.map((m) => m.content)).toEqual(['first match deploy', 'second match deploy']);
  });

  it('returns [] for a non-positive limit or no memories', () => {
    expect(selectRelevantAoiMemoriesByEmbedding([mem('x')], 'x', { limit: 0 })).toEqual([]);
    expect(selectRelevantAoiMemoriesByEmbedding([], 'x')).toEqual([]);
  });
});

describe('attachAoiMemoryEmbeddings', () => {
  it('attaches a vector to a memory that lacks one', async () => {
    const memories: Array<{ content: string; embedding?: number[] }> = [{ content: 'hello world' }];
    await attachAoiMemoryEmbeddings(memories, {
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    });
    expect(memories[0].embedding).toEqual([1, 0, 0]);
  });

  it('skips a memory that already carries a vector', async () => {
    const memories: Array<{ content: string; embedding?: number[] }> = [
      { content: 'x', embedding: [9, 9] },
    ];
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    await attachAoiMemoryEmbeddings(memories, { embed });
    expect(memories[0].embedding).toEqual([9, 9]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('is a no-op without a provider', async () => {
    const memories = [{ content: 'x' } as { content: string; embedding?: number[] }];
    await attachAoiMemoryEmbeddings(memories, null);
    expect(memories[0].embedding).toBeUndefined();
  });

  it('leaves memories unembedded when the provider throws', async () => {
    const memories = [{ content: 'x' } as { content: string; embedding?: number[] }];
    await attachAoiMemoryEmbeddings(memories, {
      embed: async () => {
        throw new Error('boom');
      },
    });
    expect(memories[0].embedding).toBeUndefined();
  });
});

describe('embedAoiQuery', () => {
  it('returns a vector for non-empty input', async () => {
    expect(await embedAoiQuery('hi', { embed: async () => [[1, 2]] })).toEqual([1, 2]);
  });

  it('returns null for empty input, a missing provider, an empty vector, or a failure', async () => {
    expect(await embedAoiQuery('   ', { embed: async () => [[1]] })).toBeNull();
    expect(await embedAoiQuery('hi', null)).toBeNull();
    expect(await embedAoiQuery('hi', { embed: async () => [[]] })).toBeNull();
    expect(
      await embedAoiQuery('hi', {
        embed: async () => {
          throw new Error('x');
        },
      }),
    ).toBeNull();
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

describe('createAoiOpenAiCompatibleEmbeddingProvider', () => {
  it('returns empty vectors on a failed response without throwing', async () => {
    const provider = createAoiOpenAiCompatibleEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => ({ ok: false }) as Response) as typeof fetch,
    });
    expect(await provider.embed(['hello'])).toEqual([[]]);
  });

  it('skips blank inputs and position-maps results by index', async () => {
    let sentBody: { input?: string[]; model?: string } = {};
    const provider = createAoiOpenAiCompatibleEmbeddingProvider({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/text-embedding-3-small',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body ?? '{}'));
        return {
          ok: true,
          json: async () => ({
            data: [
              { index: 1, embedding: [0.4, 0.5] },
              { index: 0, embedding: [0.1, 0.2] },
            ],
          }),
        } as unknown as Response;
      }) as typeof fetch,
    });
    const out = await provider.embed(['alpha', '   ', 'beta']);
    expect(sentBody.input).toEqual(['alpha', 'beta']);
    expect(sentBody.model).toBe('openai/text-embedding-3-small');
    // Returned index 0 -> 'alpha' (position 0); index 1 -> 'beta' (position 2);
    // the blank middle input stays an empty vector.
    expect(out).toEqual([[0.1, 0.2], [], [0.4, 0.5]]);
  });

  it('makes no request and returns empties when every input is blank', async () => {
    const fetchImpl = vi.fn();
    const provider = createAoiOpenAiCompatibleEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await provider.embed(['', '  '])).toEqual([[], []]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('normalizeAoiEmbeddingConfig', () => {
  it('returns null when no key is set', () => {
    expect(normalizeAoiEmbeddingConfig(null)).toBeNull();
    expect(normalizeAoiEmbeddingConfig({ apiKey: '   ' })).toBeNull();
  });

  it('defaults baseUrl and model to OpenRouter when only a key is given', () => {
    const config = normalizeAoiEmbeddingConfig({ apiKey: 'sk-or-test' });
    expect(config).toEqual({
      apiKey: 'sk-or-test',
      baseUrl: AOI_EMBEDDING_DEFAULT_BASE_URL,
      model: AOI_EMBEDDING_DEFAULT_MODEL,
    });
  });

  it('preserves an explicit baseUrl and model', () => {
    const config = normalizeAoiEmbeddingConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-large',
    });
    expect(config).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-large',
    });
  });
});

describe('createAoiEmbeddingProviderFromConfig', () => {
  it('returns null without a key', () => {
    expect(createAoiEmbeddingProviderFromConfig(null)).toBeNull();
    expect(createAoiEmbeddingProviderFromConfig({ apiKey: '  ' })).toBeNull();
  });

  it('builds a provider that calls the configured baseUrl and model', async () => {
    let calledUrl = '';
    let sentModel = '';
    const provider = createAoiEmbeddingProviderFromConfig(
      {
        apiKey: 'sk-or-test',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/text-embedding-3-small',
      },
      {
        fetchImpl: (async (url: string, init?: RequestInit) => {
          calledUrl = url;
          sentModel = JSON.parse(String(init?.body ?? '{}')).model;
          return {
            ok: true,
            json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
          } as unknown as Response;
        }) as typeof fetch,
      },
    );
    expect(provider).not.toBeNull();
    const out = await provider?.embed(['hello']);
    expect(calledUrl).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(sentModel).toBe('openai/text-embedding-3-small');
    expect(out).toEqual([[0.1, 0.2]]);
  });
});
