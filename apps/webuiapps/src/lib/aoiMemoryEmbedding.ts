// Semantic-memory primitives. Recall was previously keyword/recency only;
// these add an embedding layer so paraphrases and cross-lingual queries that
// share no tokens can still retrieve the right memory. Provider calls are
// best-effort: any failure yields an empty vector and the caller falls back to
// lexical scoring, so embeddings never block capture or recall.

export const AOI_DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';

export interface AoiEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

// Cosine similarity in [-1, 1]; returns 0 for empty or mismatched vectors so a
// missing/partial embedding degrades gracefully to "no semantic signal".
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index];
    const y = b[index];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Tokenize for lexical overlap. Unicode-aware (\p{L}/\p{N}) so Korean/CJK and
// Latin both tokenize; the {1,} tail enforces a 2-char minimum to drop noise.
// Mirrors the per-engine tokenizers (aoiContextRouter / aoiAutonomyEngine) so a
// fused relevance score lines up with the lexical behaviour those engines
// already use.
function tokenizeForRelevance(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{1,}/gu) ?? []) {
    tokens.add(token);
  }
  return tokens;
}

// Lexical overlap in [0, 1]: shared tokens over the smaller token set, so a
// short query fully contained in a long memory still scores high. Returns 0 when
// either side has no tokens.
export function lexicalOverlapScore(query: string, content: string): number {
  const queryTokens = tokenizeForRelevance(query);
  if (queryTokens.size === 0) {
    return 0;
  }
  const contentTokens = tokenizeForRelevance(content);
  if (contentTokens.size === 0) {
    return 0;
  }
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      matches += 1;
    }
  }
  const score = matches / Math.max(1, Math.min(queryTokens.size, contentTokens.size));
  return score < 0 ? 0 : score > 1 ? 1 : score;
}

export interface AoiMemoryRelevanceInput {
  query: string;
  content: string;
  embedding?: number[] | null;
  queryEmbedding?: number[] | null;
}

// Fuse lexical overlap and semantic cosine into one [0, 1] relevance, taking the
// stronger of the two so neither signal is lost: cosine catches paraphrases and
// cross-lingual matches that share no tokens, lexical catches exact terms the
// embedding may blur. Reduces to pure lexical when there is no usable embedding
// pair (missing vector or a dimension mismatch). Pure + server-safe: this is the
// shared scorer for engines that rank memories by query relevance, mirroring the
// `max(lexical, semantic)` fusion already used by `scoreAoiMemoryForQuery`.
export function scoreAoiMemoryRelevance(input: AoiMemoryRelevanceInput): number {
  const lexical = lexicalOverlapScore(input.query, input.content);
  const semantic =
    input.queryEmbedding &&
    input.embedding &&
    input.embedding.length > 0 &&
    input.embedding.length === input.queryEmbedding.length
      ? Math.max(0, cosineSimilarity(input.embedding, input.queryEmbedding))
      : 0;
  return Math.max(lexical, semantic);
}

// Rank memories by fused relevance to a query and return the top `limit`. Pure +
// structurally typed so both the browser and server AoiMemoryEntry shapes work.
// Ties break by input order (stable). With no query embedding (or memories that
// carry no vectors) this is a lexical top-K, so it is safe to call before the
// embedding layer is configured. `minScore` (default 0) lets a caller drop
// zero-relevance memories; because the ranked list is descending, the first item
// below the floor ends the scan.
export function selectRelevantAoiMemoriesByEmbedding<
  T extends { content: string; embedding?: number[] },
>(
  memories: readonly T[],
  query: string,
  options?: { queryEmbedding?: number[] | null; limit?: number; minScore?: number },
): T[] {
  const limit = options?.limit ?? 8;
  if (limit <= 0 || memories.length === 0) {
    return [];
  }
  const queryEmbedding = options?.queryEmbedding ?? null;
  const minScore = options?.minScore ?? 0;
  const scored = memories.map((memory, index) => ({
    memory,
    index,
    score: scoreAoiMemoryRelevance({
      query,
      content: memory.content,
      embedding: memory.embedding,
      queryEmbedding,
    }),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: T[] = [];
  for (const item of scored) {
    if (selected.length >= limit) {
      break;
    }
    if (item.score < minScore) {
      break;
    }
    selected.push(item.memory);
  }
  return selected;
}

// Best-effort: embed the `content` of any memory that lacks a vector and attach
// it in place. Memories that already carry a vector are left untouched (merge
// keeps content identical for reinforced duplicates, so an existing vector still
// matches). A provider failure leaves memories unembedded -- scoring then falls
// back to lexical. Structurally typed so it serves both the browser and server
// AoiMemoryEntry shapes.
export async function attachAoiMemoryEmbeddings<
  T extends { content: string; embedding?: number[] },
>(memories: T[], provider: AoiEmbeddingProvider | null | undefined): Promise<T[]> {
  if (!provider) {
    return memories;
  }
  const targets = memories.filter(
    (memory) => memory.content && (!memory.embedding || memory.embedding.length === 0),
  );
  if (targets.length === 0) {
    return memories;
  }
  try {
    const vectors = await provider.embed(targets.map((memory) => memory.content));
    targets.forEach((memory, index) => {
      const vector = vectors[index];
      if (Array.isArray(vector) && vector.length > 0) {
        memory.embedding = vector;
      }
    });
  } catch {
    // Best-effort: leave memories without vectors so capture never blocks.
  }
  return memories;
}

// Embed a recall query. Returns null on empty input, a missing provider, or any
// failure so the caller silently falls back to lexical-only ranking.
export async function embedAoiQuery(
  query: string,
  provider: AoiEmbeddingProvider | null | undefined,
): Promise<number[] | null> {
  if (!provider) {
    return null;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const [vector] = await provider.embed([trimmed]);
    return Array.isArray(vector) && vector.length > 0 ? vector : null;
  } catch {
    return null;
  }
}

export const AOI_DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

// OpenAI-compatible /v1/embeddings provider. Works with OpenAI directly
// (baseUrl https://api.openai.com/v1, model text-embedding-3-small) and with any
// OpenAI-compatible host that exposes /embeddings -- notably OpenRouter
// (baseUrl https://openrouter.ai/api/v1, model openai/text-embedding-3-small) and
// local llama.cpp servers. Best-effort like the Gemini provider: a failed
// request or empty input yields [] for the affected items and never throws.
export function createAoiOpenAiCompatibleEmbeddingProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}): AoiEmbeddingProvider {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = options.model ?? AOI_DEFAULT_OPENAI_EMBEDDING_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const results: number[][] = texts.map(() => []);
      // The endpoint rejects empty strings, so only send non-empty inputs and
      // map each returned vector back to its original position.
      const nonEmpty: Array<{ position: number; text: string }> = [];
      texts.forEach((text, position) => {
        const trimmed = text.trim();
        if (trimmed) {
          nonEmpty.push({ position, text: trimmed });
        }
      });
      if (nonEmpty.length === 0) {
        return results;
      }
      try {
        const response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            ...(options.headers ?? {}),
          },
          body: JSON.stringify({ model, input: nonEmpty.map((item) => item.text) }),
        });
        if (!response.ok) {
          return results;
        }
        const json = (await response.json()) as OpenAiEmbeddingResponse;
        const data = Array.isArray(json.data) ? json.data : [];
        data.forEach((item, order) => {
          const mapped = nonEmpty[typeof item.index === 'number' ? item.index : order];
          if (mapped && Array.isArray(item.embedding) && item.embedding.length > 0) {
            results[mapped.position] = item.embedding;
          }
        });
      } catch {
        // Best-effort: leave the affected items as empty vectors.
      }
      return results;
    },
  };
}

// Build an embedding provider from a saved config (the Aoi settings field).
// Returns null when no key is set, so capture/recall stay lexical. Defaults to
// the OpenAI-compatible provider, which covers OpenRouter / OpenAI / local hosts;
// baseUrl/model are expected to be pre-defaulted by the config normalizer.
export function createAoiEmbeddingProviderFromConfig(
  config: { apiKey?: string; baseUrl?: string; model?: string } | null | undefined,
  options?: { fetchImpl?: typeof fetch },
): AoiEmbeddingProvider | null {
  const apiKey = config?.apiKey?.trim();
  if (!apiKey) {
    return null;
  }
  return createAoiOpenAiCompatibleEmbeddingProvider({
    apiKey,
    ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config?.model ? { model: config.model } : {}),
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

interface GeminiEmbeddingResponse {
  embedding?: { values?: number[] };
}

// Google Gemini text-embedding provider. Embeds one text per request and
// returns [] for any item that fails, so a partial outage never throws.
export function createAoiGeminiEmbeddingProvider(options: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): AoiEmbeddingProvider {
  const model = options.model ?? AOI_DEFAULT_EMBEDDING_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      for (const text of texts) {
        const trimmed = text.trim();
        if (!trimmed) {
          results.push([]);
          continue;
        }
        try {
          const response = await fetchImpl(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(options.apiKey)}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: `models/${model}`,
                content: { parts: [{ text: trimmed }] },
              }),
            },
          );
          if (!response.ok) {
            results.push([]);
            continue;
          }
          const json = (await response.json()) as GeminiEmbeddingResponse;
          const values = json.embedding?.values;
          results.push(Array.isArray(values) ? values : []);
        } catch {
          results.push([]);
        }
      }
      return results;
    },
  };
}
