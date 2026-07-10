import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';
import type { AoiMemoryEntry } from './aoiMemoryShared';

// P4.4: make the keyless / embedding state observable to the operator.
//
// The offline local embedder (aoiLocalEmbedding) and the embed sweep already keep
// the keyless default non-dark, but there was no way to SEE the state: is an
// embedding provider configured at all, and how many active memories still lack a
// vector (i.e. are lexical-only for recall)? Without that an operator cannot tell a
// healthy "everything embedded" store from a silently key-less, fully-lexical one.
//
// This is a pure, READ-ONLY reporter -- it never embeds, writes, or mutates. The
// pending predicate is deliberately identical to embedAndPersistServerAoiMemories'
// backfill selector (active && no vector) so the reported pendingCount is exactly
// what a sweep would pick up; the two cannot drift.

export interface AoiMemoryEmbeddingStatus {
  // Whether a real embedding provider (an API key, or the opt-in local embedder)
  // resolved. false -> recall is lexical-only and pendingCount is expected to be the
  // whole active set.
  providerConfigured: boolean;
  // The resolved provider's model id (e.g. the key-based model, or the local model),
  // or null when no provider is configured.
  providerModel: string | null;
  activeCount: number;
  embeddedCount: number;
  pendingCount: number;
}

// True when an ACTIVE memory has no usable vector -- the exact selector the embed
// backfill uses, so the count matches what a sweep would embed.
function isAoiMemoryPendingEmbedding(memory: AoiMemoryEntry): boolean {
  return (
    memory.status === 'active' &&
    (!Array.isArray(memory.embedding) || memory.embedding.length === 0)
  );
}

// Pure reporter: count active / embedded / pending over an already-loaded memory set
// against an already-resolved provider. No I/O, so the contract is unit-testable in
// isolation.
export function summarizeAoiMemoryEmbeddingStatus(
  memories: AoiMemoryEntry[],
  provider: Pick<AoiEmbeddingProvider, 'model'> | null,
): AoiMemoryEmbeddingStatus {
  let activeCount = 0;
  let pendingCount = 0;
  for (const memory of memories) {
    if (memory.status !== 'active') {
      continue;
    }
    activeCount += 1;
    if (isAoiMemoryPendingEmbedding(memory)) {
      pendingCount += 1;
    }
  }
  return {
    providerConfigured: provider !== null,
    providerModel: provider ? provider.model : null,
    activeCount,
    embeddedCount: activeCount - pendingCount,
    pendingCount,
  };
}

// Server wrapper: load the shared memory store and resolve the provider (from the
// config file / env, unless one is injected for tests), then summarize. Read-only.
export function loadAoiMemoryEmbeddingStatus(
  sessionsDir: string,
  options: {
    configFile?: string;
    env?: Record<string, string | undefined>;
    provider?: AoiEmbeddingProvider | null;
  } = {},
): AoiMemoryEmbeddingStatus {
  const provider =
    options.provider !== undefined
      ? options.provider
      : createServerAoiEmbeddingProvider({
          ...(options.configFile ? { configFile: options.configFile } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
  const memories = loadServerAoiMemories(sessionsDir);
  return summarizeAoiMemoryEmbeddingStatus(memories, provider);
}
