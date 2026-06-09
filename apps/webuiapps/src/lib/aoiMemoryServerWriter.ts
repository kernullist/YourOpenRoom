import * as fs from 'fs';
import { dirname, join } from 'path';
import {
  buildAoiKiraAutomationMemoryCandidates,
  makeAoiKiraAutomationEpisodeId,
  normalizeAoiProjectKey,
  normalizeAoiSessionPathForStorage,
  truncateAoiMemoryContent,
  type AoiKiraAutomationEvent,
  type AoiKiraAutomationMemoryContext,
  type AoiMemoryCandidate,
  type AoiMemoryEntry,
  type AoiMemoryEpisode,
} from './aoiMemoryShared';

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

function normalizeAoiMemoryCandidate(candidate: AoiMemoryCandidate): AoiMemoryCandidate | null {
  const content = truncateAoiMemoryContent(candidate.content);
  if (content.length < 8) return null;
  return {
    scope: candidate.scope ?? 'user',
    type: candidate.type,
    content,
    importance: clampScore(candidate.importance ?? 0.65, 0.65),
    confidence: clampScore(candidate.confidence ?? 0.7, 0.7),
    projectKey: normalizeAoiProjectKey(candidate.projectKey),
    tags: normalizeTags(candidate.tags),
    entities: normalizeEntities(candidate.entities),
    ...(candidate.expiresAt && Number.isFinite(candidate.expiresAt)
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
      const changed =
        !episodeAlreadySeen ||
        duplicate.importance !== nextImportance ||
        duplicate.confidence !== nextConfidence ||
        duplicate.projectKey !== nextProjectKey ||
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
        changedIds.add(duplicate.id);
      }
      continue;
    }

    const conflictKey = conflictKeyForContent(candidate.content);
    const supersedes: string[] = [];
    if (conflictKey) {
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
      ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
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
