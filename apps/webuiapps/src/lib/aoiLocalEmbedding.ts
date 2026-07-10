import { createHash } from 'crypto';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';

// Dependency-free, offline, deterministic embedding provider (P4.4).
//
// The whole semantic memory layer (consolidation + max(lexical,semantic) recall)
// is silently disabled without a cloud embedding key -- a fresh install gets none
// of it. This hashing bag-of-words embedder gives EVERY memory a real vector with
// no network and no dependencies, so the keyless default is no longer dark.
// Quality is lexical-grade (cosine tracks token overlap), NOT true semantics -- a
// cloud key still yields better embeddings and stays the opt-in for that -- but it
// never leaves the machine and never no-ops.

const LOCAL_EMBED_DIM = 256;
export const AOI_LOCAL_EMBEDDING_MODEL = 'aoi-local-hash-v1';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ가-힣]+/i)
    .filter((token) => token.length > 1);
}

// 32-bit unsigned hash of a token from its SHA-1 digest (stable across runs/hosts).
function hashToken(token: string): number {
  const digest = createHash('sha1').update(token).digest();
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

// Deterministic hashed bag-of-words vector, L2-normalized so cosine is well-defined.
// A per-token sign bit lets distinct tokens partially cancel, adding a little
// discrimination over pure additive counts. Empty/short input -> a zero vector
// (cosineSimilarity treats it as "no signal", falling back to lexical scoring).
export function embedAoiTextLocally(text: string, dim = LOCAL_EMBED_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const index = hash % dim;
    const sign = (hash >> 8) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function createAoiLocalEmbeddingProvider(): AoiEmbeddingProvider {
  return {
    model: AOI_LOCAL_EMBEDDING_MODEL,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => embedAoiTextLocally(text));
    },
  };
}
