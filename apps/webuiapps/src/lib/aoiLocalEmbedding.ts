import { createHash } from 'crypto';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';
import {
  AOI_LOCAL_EMBEDDING_MODEL,
  AOI_LOCAL_EMBED_DIM,
  buildAoiLocalEmbeddingVector,
  foldAoiLocalEmbeddingDigest,
  tokenizeAoiLocalEmbedding,
} from './aoiLocalEmbeddingCore';

// Dependency-free, offline, deterministic embedding provider (P4.4) -- node side.
//
// The whole semantic memory layer (consolidation + max(lexical,semantic) recall)
// is silently disabled without a cloud embedding key -- a fresh install gets none
// of it. This hashing bag-of-words embedder gives EVERY memory a real vector with
// no network and no dependencies, so the keyless default is no longer dark.
// Quality is lexical-grade (cosine tracks token overlap), NOT true semantics -- a
// cloud key still yields better embeddings and stays the opt-in for that -- but it
// never leaves the machine and never no-ops.
//
// The algorithm lives in aoiLocalEmbeddingCore; only the SHA-1 primitive is
// node-specific. The browser twin is aoiLocalEmbeddingBrowser (crypto.subtle),
// pinned to this implementation by a vector-parity test.

export { AOI_LOCAL_EMBEDDING_MODEL };

// 32-bit unsigned hash of a token from its SHA-1 digest (stable across runs/hosts).
function hashToken(token: string): number {
  const digest = createHash('sha1').update(token).digest();
  return foldAoiLocalEmbeddingDigest(digest);
}

export function embedAoiTextLocally(text: string, dim = AOI_LOCAL_EMBED_DIM): number[] {
  const tokenHashes = tokenizeAoiLocalEmbedding(text).map((token) => hashToken(token));
  return buildAoiLocalEmbeddingVector(tokenHashes, dim);
}

export function createAoiLocalEmbeddingProvider(): AoiEmbeddingProvider {
  return {
    model: AOI_LOCAL_EMBEDDING_MODEL,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => embedAoiTextLocally(text));
    },
  };
}
