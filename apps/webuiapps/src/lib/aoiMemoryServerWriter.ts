import * as fs from 'fs';
import { dirname, join } from 'path';
import {
  buildAoiKiraAutomationMemoryCandidates,
  makeAoiKiraAutomationEpisodeId,
  makeAoiResearchRunEpisodeId,
  normalizeAoiProjectKey,
  normalizeAoiSessionPathForStorage,
  sanitizeAoiProcedureContent,
  truncateAoiMemoryContent,
  type AoiKiraAutomationEvent,
  type AoiKiraAutomationMemoryContext,
  type AoiMemoryCandidate,
  type AoiMemoryEntry,
  type AoiMemoryEpisode,
} from './aoiMemoryShared';
import type { AoiResearchManifest } from './aoiResearchTypes';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';

const AOI_MEMORY_ROOT = 'aoi/memory-v2';

type AoiMemoryEpisodeInput = Omit<
  AoiMemoryEpisode,
  'version' | 'id' | 'sessionPath' | 'createdAt'
> & {
  id?: string;
  createdAt?: number;
};

function clampScore(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMemoryContent(value: string): string {
  return truncateAoiMemoryContent(value).toLowerCase();
}

function formatAoiMemoryDate(timestamp: number | undefined): string {
  const date =
    typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeTags(values: unknown, maxItems = 8): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const item = normalizeWhitespace(value).toLowerCase().slice(0, 48);
    if (item) seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function normalizeEntities(values: unknown, maxItems = 10): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const item = normalizeWhitespace(value).slice(0, 80);
    if (item) seen.add(item);
    if (seen.size >= maxItems) break;
  }
  return [...seen];
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(
    new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, 'i'),
  );
  return match?.[1]?.trim() || '';
}

function stripMarkdownLine(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/^\s*[-*]\s+/u, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[(S\d{2,3})\]/g, '$1')
      .replace(/[*_>#]/g, ''),
  );
}

function extractResearchFindings(reportMarkdown: string): string[] {
  const section = extractMarkdownSection(reportMarkdown, 'Key Findings');
  const source = section || reportMarkdown;
  const findings: string[] = [];
  for (const line of source.split(/\r?\n/u)) {
    const cleaned = stripMarkdownLine(line);
    if (cleaned.length < 16) continue;
    if (/^https?:\/\//i.test(cleaned)) continue;
    findings.push(cleaned.slice(0, 150));
    if (findings.length >= 2) break;
  }
  return findings;
}

function extractResearchTopicTags(manifest: AoiResearchManifest): string[] {
  const text = `${manifest.request} ${manifest.reportTitle || ''}`.toLowerCase();
  const tags = ['research', 'aoi-research', 'completed'];
  const topicMap: Array<[RegExp, string]> = [
    [/\bwindows\b|윈도우/u, 'windows'],
    [/\bkernel\b|커널/u, 'kernel'],
    [/\bdriver\b|드라이버/u, 'driver'],
    [/\bsecurity\b|보안/u, 'security'],
    [/\banti-?cheat\b|안티치트/u, 'anti-cheat'],
    [/\bcve\b/u, 'cve'],
    [/\bbyovd\b/u, 'byovd'],
  ];
  for (const [pattern, tag] of topicMap) {
    if (pattern.test(text)) {
      tags.push(tag);
    }
    if (tags.length >= 8) break;
  }
  return tags;
}

function buildAoiResearchMemoryContent(
  manifest: AoiResearchManifest,
  reportMarkdown: string | undefined,
): string {
  const title = manifest.reportTitle || manifest.plan?.title || manifest.request || manifest.id;
  const completedDate = formatAoiMemoryDate(
    manifest.completedAt ?? manifest.updatedAt ?? manifest.createdAt,
  );
  const findings = extractResearchFindings(reportMarkdown || '');
  const details = [
    findings.length ? `Findings: ${findings.join('; ')}` : null,
    `accepted=${manifest.sourceCounts.accepted}`,
    typeof manifest.claimCount === 'number' ? `claims=${manifest.claimCount}` : null,
    `run=${manifest.id}`,
  ].filter((item): item is string => Boolean(item));
  return truncateAoiMemoryContent(
    `Aoi completed research "${title}" on ${completedDate}. ${details.join('. ')}.`,
  );
}

export function buildAoiResearchMemoryCandidates(params: {
  manifest: AoiResearchManifest;
  reportMarkdown?: string;
}): AoiMemoryCandidate[] {
  const { manifest, reportMarkdown } = params;
  if (manifest.status !== 'completed') {
    return [];
  }

  const title = manifest.reportTitle || manifest.plan?.title || manifest.request || manifest.id;
  const blockingCount = (manifest.verificationWarnings || []).filter(
    (warning) => warning.severity === 'blocking',
  ).length;
  const warningCount = manifest.warnings?.length ?? 0;
  return [
    {
      scope: 'agent',
      type: 'fact',
      content: buildAoiResearchMemoryContent(manifest, reportMarkdown),
      importance: 0.88,
      confidence: blockingCount > 0 ? 0.66 : warningCount > 0 ? 0.76 : 0.84,
      permanent: true,
      tags: extractResearchTopicTags(manifest),
      entities: [
        title,
        manifest.request,
        manifest.id,
        formatAoiMemoryDate(manifest.completedAt ?? manifest.updatedAt ?? manifest.createdAt),
        ...(manifest.plan?.searchQueries || []).slice(0, 3),
      ],
    },
  ];
}

function normalizeAoiMemoryCandidate(candidate: AoiMemoryCandidate): AoiMemoryCandidate | null {
  const content =
    candidate.type === 'procedure'
      ? sanitizeAoiProcedureContent(candidate.content)
      : truncateAoiMemoryContent(candidate.content);
  if (content.length < 8) return null;
  const permanent = Boolean(candidate.permanent);
  const tags = normalizeTags([...(permanent ? ['permanent'] : []), ...(candidate.tags ?? [])]);
  return {
    scope: candidate.scope ?? 'user',
    type: candidate.type,
    content,
    importance: clampScore(candidate.importance ?? 0.65, 0.65),
    confidence: clampScore(candidate.confidence ?? 0.7, 0.7),
    projectKey: normalizeAoiProjectKey(candidate.projectKey),
    tags,
    entities: normalizeEntities(candidate.entities),
    ...(permanent ? { permanent: true } : {}),
    ...(!permanent && candidate.expiresAt && Number.isFinite(candidate.expiresAt)
      ? { expiresAt: candidate.expiresAt }
      : {}),
  };
}

function conflictKeyForContent(content: string): string | null {
  const normalized = content.toLowerCase();
  if (/the user's name is\b/.test(normalized) || /user name\b/.test(normalized)) {
    return 'user.name';
  }
  if (/preferred name\b/.test(normalized)) {
    return 'user.preferred_name';
  }
  return null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function makeServerMemoryId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mergeServerAoiMemoryCandidates(
  existing: AoiMemoryEntry[],
  candidates: AoiMemoryCandidate[],
  params: { sessionPath: string; episodeId: string; now?: number },
): { memories: AoiMemoryEntry[]; changedIds: string[] } {
  const now = params.now ?? Date.now();
  const next = existing.map((memory) => ({ ...memory }));
  const changedIds = new Set<string>();

  for (const rawCandidate of candidates) {
    const candidate = normalizeAoiMemoryCandidate(rawCandidate);
    if (!candidate) continue;

    const normalizedContent = normalizeMemoryContent(candidate.content);
    const duplicate = next.find(
      (memory) => memory.status === 'active' && memory.normalizedContent === normalizedContent,
    );
    if (duplicate) {
      const episodeAlreadySeen = duplicate.sourceEpisodeIds.includes(params.episodeId);
      const nextImportance = Math.max(duplicate.importance, candidate.importance ?? 0.65);
      const nextConfidence = Math.max(duplicate.confidence, candidate.confidence ?? 0.7);
      const nextSourceEpisodeIds = Array.from(
        new Set([...duplicate.sourceEpisodeIds, params.episodeId]),
      );
      const nextTags = Array.from(new Set([...duplicate.tags, ...(candidate.tags ?? [])])).slice(
        0,
        8,
      );
      const nextEntities = Array.from(
        new Set([...duplicate.entities, ...(candidate.entities ?? [])]),
      ).slice(0, 10);
      const nextProjectKey = duplicate.projectKey ?? candidate.projectKey;
      const nextPermanent = Boolean(duplicate.permanent || candidate.permanent);
      const shouldClearExpiresAt = nextPermanent && duplicate.expiresAt !== undefined;
      const changed =
        !episodeAlreadySeen ||
        duplicate.importance !== nextImportance ||
        duplicate.confidence !== nextConfidence ||
        duplicate.projectKey !== nextProjectKey ||
        Boolean(duplicate.permanent) !== nextPermanent ||
        shouldClearExpiresAt ||
        !arraysEqual(duplicate.sourceEpisodeIds, nextSourceEpisodeIds) ||
        !arraysEqual(duplicate.tags, nextTags) ||
        !arraysEqual(duplicate.entities, nextEntities);

      if (changed) {
        duplicate.importance = nextImportance;
        duplicate.confidence = nextConfidence;
        if (!episodeAlreadySeen) {
          duplicate.hits += 1;
        }
        duplicate.updatedAt = now;
        duplicate.sourceEpisodeIds = nextSourceEpisodeIds;
        duplicate.tags = nextTags;
        duplicate.entities = nextEntities;
        duplicate.projectKey = nextProjectKey;
        if (nextPermanent) {
          duplicate.permanent = true;
          delete duplicate.expiresAt;
        }
        changedIds.add(duplicate.id);
      }
      continue;
    }

    const conflictKey = conflictKeyForContent(candidate.content);
    const supersedes: string[] = [];
    if (conflictKey) {
      const hasProtectedPermanentConflict = next.some(
        (memory) =>
          memory.status === 'active' &&
          memory.permanent &&
          !candidate.permanent &&
          conflictKeyForContent(memory.content) === conflictKey,
      );
      if (hasProtectedPermanentConflict) {
        continue;
      }

      for (const memory of next) {
        if (memory.status !== 'active') continue;
        if (conflictKeyForContent(memory.content) !== conflictKey) continue;
        memory.status = 'superseded';
        memory.updatedAt = now;
        supersedes.push(memory.id);
        changedIds.add(memory.id);
      }
    }

    const entry: AoiMemoryEntry = {
      version: 2,
      id: makeServerMemoryId('aoi_mem'),
      scope: candidate.scope ?? 'user',
      type: candidate.type,
      status: 'active',
      content: candidate.content,
      normalizedContent,
      importance: candidate.importance ?? 0.65,
      confidence: candidate.confidence ?? 0.7,
      hits: 1,
      createdAt: now,
      updatedAt: now,
      sourceEpisodeIds: [params.episodeId],
      sessionPath: params.sessionPath,
      ...(candidate.projectKey ? { projectKey: candidate.projectKey } : {}),
      tags: candidate.tags ?? [],
      entities: candidate.entities ?? [],
      ...(candidate.permanent ? { permanent: true } : {}),
      ...(!candidate.permanent && candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
      ...(supersedes.length > 0 ? { supersedes } : {}),
    };
    next.push(entry);
    changedIds.add(entry.id);
  }

  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return { memories: next, changedIds: [...changedIds] };
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf-8');
}

function listJsonFiles(dirPath: string): string[] {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function memoryFilePath(sessionsDir: string, id: string): string {
  return join(sessionsDir, AOI_MEMORY_ROOT, 'memories', `${id}.json`);
}

function episodeFilePath(sessionsDir: string, sessionPath: string, id: string): string {
  return join(
    sessionsDir,
    AOI_MEMORY_ROOT,
    'episodes',
    normalizeAoiSessionPathForStorage(sessionPath),
    `${id}.json`,
  );
}

export function loadServerAoiMemories(sessionsDir: string): AoiMemoryEntry[] {
  return listJsonFiles(join(sessionsDir, AOI_MEMORY_ROOT, 'memories'))
    .map((filePath) => readJsonFile<AoiMemoryEntry>(filePath))
    .filter((memory): memory is AoiMemoryEntry => Boolean(memory?.id && memory?.content))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const MAX_SERVER_EMBED_BATCH = 32;

// Embed active server memories that still lack a vector (best-effort, bounded), so
// server-side semantic recall has embeddings to fuse. Rewrites only memories that
// gain an embedding; a provider failure yields empty vectors and is skipped, so
// this never throws into the autonomy loop. Idempotent -- already-embedded memories
// are skipped, so repeated calls converge and then no-op.
export async function embedAndPersistServerAoiMemories(
  sessionsDir: string,
  provider: AoiEmbeddingProvider,
  options: { max?: number } = {},
): Promise<{ embeddedCount: number; pendingCount: number }> {
  const max = Math.max(1, Math.min(options.max ?? MAX_SERVER_EMBED_BATCH, MAX_SERVER_EMBED_BATCH));
  const memories = loadServerAoiMemories(sessionsDir);
  const pending = memories.filter(
    (memory) =>
      memory.status === 'active' &&
      (!Array.isArray(memory.embedding) || memory.embedding.length === 0),
  );
  if (pending.length === 0) {
    return { embeddedCount: 0, pendingCount: 0 };
  }
  const batch = pending.slice(0, max);
  let vectors: number[][];
  try {
    vectors = await provider.embed(batch.map((memory) => memory.content));
  } catch {
    return { embeddedCount: 0, pendingCount: pending.length };
  }
  let embeddedCount = 0;
  batch.forEach((memory, index) => {
    const vector = vectors[index];
    if (Array.isArray(vector) && vector.length > 0) {
      writeJsonFile(memoryFilePath(sessionsDir, memory.id), {
        ...memory,
        embedding: vector,
        embeddingModel: provider.model,
      });
      embeddedCount += 1;
    }
  });
  return { embeddedCount, pendingCount: pending.length - embeddedCount };
}

export function saveServerAoiMemoryEpisode(
  sessionsDir: string,
  sessionPath: string,
  episode: AoiMemoryEpisodeInput,
): AoiMemoryEpisode {
  const { id, createdAt, ...episodeBody } = episode;
  const item: AoiMemoryEpisode = {
    version: 1,
    id: id ?? makeServerMemoryId('aoi_ep'),
    sessionPath,
    createdAt: createdAt ?? Date.now(),
    ...episodeBody,
  };
  writeJsonFile(episodeFilePath(sessionsDir, sessionPath, item.id), item);
  return item;
}

export function saveServerAoiMemoryCandidates(
  sessionsDir: string,
  sessionPath: string,
  candidates: AoiMemoryCandidate[],
  episodeId: string,
): AoiMemoryEntry[] {
  const existing = loadServerAoiMemories(sessionsDir);
  const merged = mergeServerAoiMemoryCandidates(existing, candidates, { sessionPath, episodeId });
  const changed = merged.memories.filter((memory) => merged.changedIds.includes(memory.id));
  for (const memory of changed) {
    writeJsonFile(memoryFilePath(sessionsDir, memory.id), memory);
  }
  return merged.memories;
}

export function syncAoiMemoryFromKiraAutomationEventServer(
  sessionsDir: string,
  sessionPath: string,
  event: AoiKiraAutomationEvent,
  context?: AoiKiraAutomationMemoryContext,
): AoiMemoryEntry[] {
  const candidates = buildAoiKiraAutomationMemoryCandidates(event, context);
  if (candidates.length === 0) {
    return loadServerAoiMemories(sessionsDir);
  }

  const episodeInput: AoiMemoryEpisodeInput = {
    id: makeAoiKiraAutomationEpisodeId(event.id),
    source: 'kira_automation',
    userMessage: `Kira automation ${event.type}: ${event.title}`,
    assistantMessage: event.message,
    toolCalls: ['kira_automation'],
    outcome: event.type,
  };
  if (Number.isFinite(event.createdAt)) {
    episodeInput.createdAt = event.createdAt;
  }

  const episode = saveServerAoiMemoryEpisode(sessionsDir, sessionPath, episodeInput);
  return saveServerAoiMemoryCandidates(sessionsDir, sessionPath, candidates, episode.id);
}

export function syncAoiMemoryFromResearchRunServer(
  sessionsDir: string,
  manifest: AoiResearchManifest,
  options?: { reportMarkdown?: string },
): AoiMemoryEntry[] {
  const candidates = buildAoiResearchMemoryCandidates({
    manifest,
    reportMarkdown: options?.reportMarkdown,
  });
  if (candidates.length === 0) {
    return loadServerAoiMemories(sessionsDir);
  }

  const episode = saveServerAoiMemoryEpisode(sessionsDir, manifest.sessionPath, {
    id: makeAoiResearchRunEpisodeId(manifest.id),
    source: 'research_run',
    userMessage: manifest.request,
    assistantMessage: truncateAoiMemoryContent(
      `Research completed: ${manifest.reportTitle || manifest.plan?.title || manifest.id}`,
    ),
    toolCalls: ['start_research'],
    createdAt: manifest.completedAt ?? manifest.updatedAt,
    outcome: 'completed',
  });
  return saveServerAoiMemoryCandidates(sessionsDir, manifest.sessionPath, candidates, episode.id);
}
