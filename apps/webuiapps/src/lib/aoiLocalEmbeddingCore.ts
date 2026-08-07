// Environment-agnostic core of the offline local embedder (P4.4).
//
// The node and browser providers must produce BYTE-IDENTICAL vectors for the
// same text or the embeddingModel compatibility guard silently zeroes semantic
// similarity between a memory embedded by one side and a query embedded by the
// other. Everything except the SHA-1 primitive lives here; each environment
// supplies its own hash (node:crypto vs crypto.subtle) and a parity test pins
// the two implementations together.

export const AOI_LOCAL_EMBEDDING_MODEL = 'aoi-local-hash-v1';
export const AOI_LOCAL_EMBED_DIM = 256;

export function tokenizeAoiLocalEmbedding(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ가-힣]+/i)
    .filter((token) => token.length > 1);
}

// 32-bit unsigned token hash from the first four bytes of a SHA-1 digest,
// matching the historical node implementation exactly.
export function foldAoiLocalEmbeddingDigest(digest: Uint8Array): number {
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

// Deterministic hashed bag-of-words vector, L2-normalized so cosine is
// well-defined. A per-token sign bit lets distinct tokens partially cancel,
// adding a little discrimination over pure additive counts. Empty/short input
// yields a zero vector (cosineSimilarity treats it as "no signal").
export function buildAoiLocalEmbeddingVector(
  tokenHashes: readonly number[],
  dim = AOI_LOCAL_EMBED_DIM,
): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const hash of tokenHashes) {
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
