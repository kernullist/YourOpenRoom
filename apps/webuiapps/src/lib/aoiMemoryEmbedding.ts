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
