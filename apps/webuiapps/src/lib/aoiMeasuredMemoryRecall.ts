import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';
import { AOI_LOCAL_EMBEDDING_MODEL } from './aoiLocalEmbeddingCore';
import {
  recordAoiMemoryRecallTrial,
  type AoiMemoryRecallTrial,
  type AoiMemoryRetrievalPath,
} from './aoiMemoryRecallDiagnostics';
import { selectAoiMemoriesForPrompt } from './aoiMemoryManager';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';

export async function runAoiMeasuredMemoryRecall(params: {
  sessionsDir: string;
  sessionPath: string;
  query: string;
  expectedMemoryIds: string[];
  provider?: AoiEmbeddingProvider | null;
  limit?: number;
  now?: number;
}): Promise<AoiMemoryRecallTrial> {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const provider = params.provider ?? null;
  let queryEmbedding: number[] | null = null;
  if (provider) {
    try {
      const vectors = await provider.embed([params.query]);
      queryEmbedding = Array.isArray(vectors[0]) && vectors[0].length > 0 ? vectors[0] : null;
    } catch {
      queryEmbedding = null;
    }
  }
  const memories = loadServerAoiMemories(params.sessionsDir).filter(
    (memory) => memory.sessionPath === sessionPath,
  );
  const selected = selectAoiMemoriesForPrompt(memories, params.query, {
    now: params.now,
    limit: Math.max(1, Math.min(params.limit ?? 5, 10)),
    ...(queryEmbedding ? { queryEmbedding } : {}),
    ...(provider ? { queryEmbeddingModel: provider.model } : {}),
  });
  const semanticCandidateAvailable = Boolean(
    queryEmbedding &&
    memories.some(
      (memory) =>
        Array.isArray(memory.embedding) &&
        memory.embedding.length === queryEmbedding?.length &&
        (!memory.embeddingModel || memory.embeddingModel === provider?.model),
    ),
  );
  const retrievalPath: AoiMemoryRetrievalPath = semanticCandidateAvailable
    ? provider?.model === AOI_LOCAL_EMBEDDING_MODEL
      ? 'local_semantic'
      : 'provider_semantic'
    : 'lexical_only';
  return recordAoiMemoryRecallTrial({
    sessionsDir: params.sessionsDir,
    sessionPath,
    query: params.query,
    retrievalPath,
    candidateCount: memories.filter((memory) => memory.status === 'active').length,
    selectedMemoryIds: selected.map((memory) => memory.id),
    expectedMemoryIds: params.expectedMemoryIds,
    createdAt: params.now,
  });
}
