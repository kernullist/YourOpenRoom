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
