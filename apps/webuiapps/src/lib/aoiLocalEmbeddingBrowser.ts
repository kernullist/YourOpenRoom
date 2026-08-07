import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';
import {
  AOI_LOCAL_EMBEDDING_MODEL,
  AOI_LOCAL_EMBED_DIM,
  buildAoiLocalEmbeddingVector,
  foldAoiLocalEmbeddingDigest,
  tokenizeAoiLocalEmbedding,
} from './aoiLocalEmbeddingCore';

// Browser twin of aoiLocalEmbedding (P4.4). Same hashed bag-of-words algorithm,
// but the SHA-1 primitive comes from Web Crypto instead of node:crypto -- the
// node module must never be imported by browser code (its `crypto` import
// breaks the client bundle). A parity test asserts both sides produce
// byte-identical vectors, which the embeddingModel compatibility guard relies
// on: a memory embedded by the server sweep must fuse with a query embedded
// here.
//
// Purpose: without a cloud embedding key the CHAT side had no query vectors at
// all, so recall stayed lexical even after the server sweep embedded the store.
// This provider makes keyless recall semantic-capable end to end.

const textEncoder = new TextEncoder();

// Token hashes are stable, so a small cache spares repeated subtle.digest round
// trips for common tokens. Bounded to keep a long session from growing it.
const MAX_TOKEN_HASH_CACHE = 4096;
const tokenHashCache = new Map<string, number>();

async function hashTokenBrowser(subtle: SubtleCrypto, token: string): Promise<number> {
  const cached = tokenHashCache.get(token);
  if (cached !== undefined) {
    return cached;
  }
  const digest = new Uint8Array(await subtle.digest('SHA-1', textEncoder.encode(token)));
  const hash = foldAoiLocalEmbeddingDigest(digest);
  if (tokenHashCache.size >= MAX_TOKEN_HASH_CACHE) {
    tokenHashCache.clear();
  }
  tokenHashCache.set(token, hash);
  return hash;
}

export async function embedAoiTextLocallyInBrowser(
  text: string,
  dim = AOI_LOCAL_EMBED_DIM,
): Promise<number[]> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return new Array<number>(dim).fill(0);
  }
  const tokens = tokenizeAoiLocalEmbedding(text);
  const tokenHashes: number[] = [];
  for (const token of tokens) {
    tokenHashes.push(await hashTokenBrowser(subtle, token));
  }
  return buildAoiLocalEmbeddingVector(tokenHashes, dim);
}

// Returns null when Web Crypto is unavailable (non-secure context, very old
// browser) so callers keep the existing "no provider -> lexical-only" path
// instead of storing useless zero vectors.
export function createAoiLocalEmbeddingBrowserProvider(): AoiEmbeddingProvider | null {
  if (!globalThis.crypto?.subtle) {
    return null;
  }
  return {
    model: AOI_LOCAL_EMBEDDING_MODEL,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (const text of texts) {
        vectors.push(await embedAoiTextLocallyInBrowser(text));
      }
      return vectors;
    },
  };
}
