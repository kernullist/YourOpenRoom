import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import {
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { buildAoiInterestProfileFromMemories } from './aoiInterestProfile';
import type {
  AoiAutonomyRisk,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiInterestTopicSource,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCooldownEntry,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefDeliveryMode,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFeedbackCategory,
  AoiProactiveBriefIndex,
  AoiProactiveBriefIndexEntry,
  AoiProactiveBriefSource,
  AoiProactiveBriefStatus,
} from './aoiAutonomyTypes';

const MAX_PROACTIVE_BRIEF_INDEX_ITEMS = 200;
const MAX_PROACTIVE_BRIEF_FEEDBACK_ITEMS = 500;
const DEFAULT_BRIEF_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_PROFILE_LABEL = 'Interest Topic';

export interface AoiProactiveBriefPaths {
  root: string;
  profile: string;
  briefsDir: string;
  index: string;
  candidatesDir: string;
  feedbackDir: string;
  cooldowns: string;
}

export interface AoiInterestProfileRebuildInput {
  sessionsDir: string;
  sessionPath: string;
  memories: AoiMemoryEntry[];
  now?: number;
  persist?: boolean;
}

export interface AoiProactiveBriefUpsertResult {
  candidate: AoiProactiveBriefCandidate;
  created: boolean;
  dedupeKey: string;
  replacedCandidateId?: string;
}

export interface AoiProactiveBriefCooldownInput {
  cooldownKey: string;
  topicId?: string;
  nextAllowedAt: number;
  reason: string;
  sourceBriefIds?: string[];
  now?: number;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function ensureDirectory(fileOrDirectory: string, isFile = false): void {
  fs.mkdirSync(isFile ? dirname(fileOrDirectory) : fileOrDirectory, { recursive: true });
}

function writeJsonAtomic(root: string, filePath: string, value: unknown): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved proactive brief path escaped the autonomy root.');
  }
  ensureDirectory(filePath, true);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function listJsonFiles<T>(directory: string): T[] {
  try {
    if (!fs.existsSync(directory)) {
      return [];
    }
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJson<T>(join(directory, entry.name)))
      .filter((item): item is T => item !== null);
  } catch {
    return [];
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalizeWhitespace(redactAoiSensitiveContent(value)).slice(0, maxChars);
  return normalized || undefined;
}

function normalizeRequiredText(value: unknown, fallback: string, maxChars: number): string {
  return normalizeText(value, maxChars) ?? fallback;
}

function clampScore(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeStringList(value: unknown, maxItems = 24, maxChars = 180): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = normalizeText(item, maxChars);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeTopicKey(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#._ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function makeStableId(prefix: string, value: string): string {
  return `${prefix}-${hashText(value)}`;
}

function normalizeAutonomyId(value: unknown, fallbackPrefix: string, fallbackSeed: string): string {
  if (isValidAoiAutonomyId(value)) {
    return value;
  }
  return makeStableId(fallbackPrefix, fallbackSeed);
}

function normalizeRisk(value: unknown): AoiAutonomyRisk {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'low';
}

function isBriefStatus(value: unknown): value is AoiProactiveBriefStatus {
  return (
    value === 'candidate' ||
    value === 'shown' ||
    value === 'accepted' ||
    value === 'dismissed' ||
    value === 'archived' ||
    value === 'expired' ||
    value === 'blocked'
  );
}

function isDeliveryMode(value: unknown): value is AoiProactiveBriefDeliveryMode {
  return (
    value === 'dashboard' || value === 'digest' || value === 'inline_card' || value === 'chat_hook'
  );
}

function isFeedbackCategory(value: unknown): value is AoiProactiveBriefFeedbackCategory {
  return (
    value === 'useful' ||
    value === 'not_useful' ||
    value === 'show_more' ||
    value === 'show_less' ||
    value === 'wrong_topic' ||
    value === 'wrong_timing' ||
    value === 'too_frequent' ||
    value === 'stale' ||
    value === 'unsafe'
  );
}

function normalizeTopicSource(value: unknown): AoiInterestTopicSource {
  if (
    value === 'memory' ||
    value === 'manual' ||
    value === 'feedback' ||
    value === 'research_run' ||
    value === 'project_context'
  ) {
    return value;
  }
  return 'memory';
}

function normalizeDeliveryModes(value: unknown): AoiProactiveBriefDeliveryMode[] {
  if (!Array.isArray(value)) {
    return ['dashboard'];
  }
  const modes = value.filter(isDeliveryMode);
  return modes.length > 0 ? [...new Set(modes)] : ['dashboard'];
}

function resolveSessionPath(value: string): string {
  const sessionPath = normalizeAoiAutonomySessionPath(value);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return sessionPath;
}

export function resolveAoiProactiveBriefPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiProactiveBriefPaths {
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const autonomyPaths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const paths = {
    root: autonomyPaths.root,
    profile: autonomyPaths.proactiveInterestProfile,
    briefsDir: autonomyPaths.proactiveBriefsDir,
    index: autonomyPaths.proactiveBriefsIndex,
    candidatesDir: autonomyPaths.proactiveBriefCandidatesDir,
    feedbackDir: autonomyPaths.proactiveBriefFeedbackDir,
    cooldowns: autonomyPaths.proactiveBriefCooldowns,
  };

  for (const target of [
    paths.profile,
    paths.briefsDir,
    paths.index,
    paths.candidatesDir,
    paths.feedbackDir,
    paths.cooldowns,
  ]) {
    if (!isPathInsideRoot(paths.root, target)) {
      throw new Error('Resolved proactive brief path escaped the autonomy root.');
    }
  }

  return paths;
}

function normalizeInterestTopic(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiInterestTopic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiInterestTopic>;
  const label = normalizeRequiredText(raw.label, DEFAULT_PROFILE_LABEL, 80);
  if (containsAoiSensitiveContent(label)) {
    return null;
  }
  const normalizedLabel =
    normalizeText(raw.normalizedLabel, 100) ?? normalizeTopicKey(label) ?? 'interest-topic';
  const id = normalizeAutonomyId(raw.id, 'aoi-interest', `${sessionPath}:${normalizedLabel}`);
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);
  return {
    version: 1,
    id,
    sessionPath,
    label,
    normalizedLabel,
    aliases: normalizeStringList(raw.aliases, 12, 80),
    source: normalizeTopicSource(raw.source),
    memoryIds: normalizeStringList(raw.memoryIds, 24, 120),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24, 180),
    confidence: clampScore(raw.confidence, 0.55),
    importance: clampScore(raw.importance, 0.5),
    noveltyPreference: clampScore(raw.noveltyPreference, 0.5),
    currentInfoPreference: clampScore(raw.currentInfoPreference, 0.55),
    muted: raw.muted === true,
    pinned: raw.pinned === true,
    cooldownKey:
      normalizeText(raw.cooldownKey, 120) ?? `interest:${normalizedLabel || 'interest-topic'}`,
    createdAt,
    updatedAt,
  };
}

export function normalizeAoiInterestProfileRecord(
  value: unknown,
  sessionPath: string,
  now = Date.now(),
): AoiInterestProfile {
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      version: 1,
      sessionPath: normalizedSessionPath,
      topics: [],
      generatedAt: now,
      sourceMemoryCount: 0,
      warnings: ['profile_record_missing_or_malformed'],
    };
  }
  const raw = value as Partial<AoiInterestProfile>;
  const topics = Array.isArray(raw.topics)
    ? raw.topics
        .map((topic) => normalizeInterestTopic(topic, normalizedSessionPath, now))
        .filter((topic): topic is AoiInterestTopic => topic !== null)
        .sort(
          (left, right) =>
            right.importance - left.importance ||
            right.confidence - left.confidence ||
            left.normalizedLabel.localeCompare(right.normalizedLabel),
        )
        .slice(0, 50)
    : [];
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    topics,
    generatedAt: normalizeTimestamp(raw.generatedAt, now),
    sourceMemoryCount:
      typeof raw.sourceMemoryCount === 'number' && Number.isFinite(raw.sourceMemoryCount)
        ? Math.max(0, Math.round(raw.sourceMemoryCount))
        : new Set(topics.flatMap((topic) => topic.memoryIds)).size,
    warnings: normalizeStringList(raw.warnings, 20, 160),
  };
}

export function loadAoiInterestProfile(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiInterestProfile {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const parsed = readJson<unknown>(paths.profile);
  if (parsed === null && !fs.existsSync(paths.profile)) {
    return {
      version: 1,
      sessionPath: normalizedSessionPath,
      topics: [],
      generatedAt: now,
      sourceMemoryCount: 0,
      warnings: [],
    };
  }
  return normalizeAoiInterestProfileRecord(parsed, normalizedSessionPath, now);
}

export function saveAoiInterestProfile(
  sessionsDir: string,
  sessionPath: string,
  profile: unknown,
  now = Date.now(),
): AoiInterestProfile {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalized = normalizeAoiInterestProfileRecord(profile, sessionPath, now);
  writeJsonAtomic(paths.root, paths.profile, normalized);
  return normalized;
}

export function rebuildAndSaveAoiInterestProfile(
  input: AoiInterestProfileRebuildInput,
): AoiInterestProfile {
  const now = input.now ?? Date.now();
  const profile = buildAoiInterestProfileFromMemories({
    sessionPath: input.sessionPath,
    memories: input.memories,
    now,
  });
  if (input.persist === false) {
    return profile;
  }
  return saveAoiInterestProfile(input.sessionsDir, input.sessionPath, profile, now);
}

function normalizeBriefSource(value: unknown, now: number): AoiProactiveBriefSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefSource>;
  const url = normalizeText(raw.url, 500);
  if (!url) {
    return null;
  }
  if (containsAoiSensitiveContent(url)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password || containsAoiSensitiveContent(parsed.search)) {
    return null;
  }

  const title = normalizeRequiredText(raw.title, parsed.hostname, 160);
  const snippet = normalizeRequiredText(raw.snippet, '', 500);
  return {
    title,
    url: parsed.toString(),
    host: normalizeText(raw.host, 120) ?? parsed.hostname,
    ...(normalizeText(raw.publishedAt, 64)
      ? { publishedAt: normalizeText(raw.publishedAt, 64) }
      : {}),
    retrievedAt: normalizeTimestamp(raw.retrievedAt, now),
    snippet,
  };
}

function normalizeBriefSources(value: unknown, now: number): AoiProactiveBriefSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byUrl = new Map<string, AoiProactiveBriefSource>();
  for (const source of value) {
    const normalized = normalizeBriefSource(source, now);
    if (!normalized) {
      continue;
    }
    byUrl.set(normalized.url.toLowerCase(), normalized);
    if (byUrl.size >= 12) {
      break;
    }
  }
  return [...byUrl.values()];
}

function normalizeFreshness(
  value: Partial<AoiProactiveBriefCandidate>['freshness'],
  now: number,
): AoiProactiveBriefCandidate['freshness'] {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    searchedAt: normalizeTimestamp(raw.searchedAt, now),
    ...(normalizeText(raw.newestSourceAt, 64)
      ? { newestSourceAt: normalizeText(raw.newestSourceAt, 64) }
      : {}),
    cannotKnow: normalizeStringList(raw.cannotKnow, 12, 240),
  };
}

function normalizeDelivery(
  value: Partial<AoiProactiveBriefCandidate>['delivery'],
): AoiProactiveBriefCandidate['delivery'] {
  const raw = value && typeof value === 'object' ? value : {};
  const allowedModes = normalizeDeliveryModes(raw.allowedModes);
  const selectedMode = isDeliveryMode(raw.selectedMode) ? raw.selectedMode : undefined;
  return {
    allowedModes,
    ...(selectedMode && allowedModes.includes(selectedMode) ? { selectedMode } : {}),
    ...(typeof raw.quietModeSuppressed === 'boolean'
      ? { quietModeSuppressed: raw.quietModeSuppressed }
      : {}),
    ...(typeof raw.lastShownAt === 'number' && Number.isFinite(raw.lastShownAt)
      ? { lastShownAt: Math.max(0, raw.lastShownAt) }
      : {}),
  };
}

export function createAoiProactiveBriefDedupeKey(candidate: AoiProactiveBriefCandidate): string {
  const titleHash = hashText(normalizeWhitespace(candidate.title).toLowerCase());
  const sourceHash = hashText(
    candidate.sources
      .map((source) => source.url.toLowerCase())
      .sort()
      .join('|'),
  );
  const cooldownHash = hashText(candidate.cooldownKey);
  return `brief:${candidate.topicId}:${titleHash}:${sourceHash}:${cooldownHash}`;
}

export function normalizeAoiProactiveBriefCandidate(
  value: unknown,
  sessionPathFallback?: string,
  now = Date.now(),
): AoiProactiveBriefCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefCandidate>;
  const sessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath ?? sessionPathFallback ?? '');
  if (!sessionPath) {
    return null;
  }
  const topicLabel = normalizeRequiredText(raw.topicLabel, DEFAULT_PROFILE_LABEL, 80);
  const topicKey = normalizeTopicKey(topicLabel);
  const topicId = normalizeAutonomyId(raw.topicId, 'aoi-interest', `${sessionPath}:${topicKey}`);
  const title = normalizeRequiredText(raw.title, 'Untitled proactive brief', 160);
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);
  const expiresAt = normalizeTimestamp(raw.expiresAt, createdAt + DEFAULT_BRIEF_TTL_MS);
  const candidate: AoiProactiveBriefCandidate = {
    version: 1,
    id: normalizeAutonomyId(raw.id, 'aoi-brief', `${sessionPath}:${topicId}:${title}`),
    sessionPath,
    topicId,
    topicLabel,
    status: isBriefStatus(raw.status) ? raw.status : 'candidate',
    title,
    hook: normalizeRequiredText(raw.hook, title, 220),
    summary: normalizeRequiredText(raw.summary, '', 1000),
    whyForOperator: normalizeRequiredText(raw.whyForOperator, '', 500),
    noveltyReason: normalizeRequiredText(raw.noveltyReason, '', 360),
    sources: normalizeBriefSources(raw.sources, now),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24, 180),
    memoryIds: normalizeStringList(raw.memoryIds, 24, 120),
    ...(normalizeText(raw.researchRunId, 120)
      ? { researchRunId: normalizeText(raw.researchRunId, 120) }
      : {}),
    score: clampScore(raw.score, 0.5),
    confidence: clampScore(raw.confidence, 0.55),
    risk: normalizeRisk(raw.risk),
    freshness: normalizeFreshness(raw.freshness, now),
    delivery: normalizeDelivery(raw.delivery),
    cooldownKey: normalizeRequiredText(raw.cooldownKey, `topic:${topicId}`, 160),
    createdAt,
    updatedAt,
    expiresAt,
  };
  const dedupeKey =
    normalizeText(raw.dedupeKey, 260) ?? createAoiProactiveBriefDedupeKey(candidate);
  return {
    ...candidate,
    dedupeKey,
  };
}

function normalizeBriefIndexEntry(value: unknown, now: number): AoiProactiveBriefIndexEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefIndexEntry>;
  if (!isValidAoiAutonomyId(raw.id)) {
    return null;
  }
  const topicId = normalizeText(raw.topicId, 120);
  const cooldownKey = normalizeText(raw.cooldownKey, 160);
  const title = normalizeText(raw.title, 160);
  const dedupeKey = normalizeText(raw.dedupeKey, 260);
  if (!topicId || !cooldownKey || !title || !dedupeKey) {
    return null;
  }
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);
  return {
    id: raw.id,
    topicId,
    cooldownKey,
    status: isBriefStatus(raw.status) ? raw.status : 'candidate',
    title,
    dedupeKey,
    createdAt,
    updatedAt,
    expiresAt: normalizeTimestamp(raw.expiresAt, createdAt + DEFAULT_BRIEF_TTL_MS),
  };
}

export function loadAoiProactiveBriefIndex(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefIndex {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const parsed = readJson<Partial<AoiProactiveBriefIndex>>(paths.index);
  const entries =
    parsed?.version === 1 && Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => normalizeBriefIndexEntry(entry, now))
          .filter((entry): entry is AoiProactiveBriefIndexEntry => entry !== null)
          .sort(
            (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
          )
          .slice(0, MAX_PROACTIVE_BRIEF_INDEX_ITEMS)
      : [];
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    entries,
  };
}

function saveAoiProactiveBriefIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiProactiveBriefIndex,
): AoiProactiveBriefIndex {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const normalized: AoiProactiveBriefIndex = {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: index.updatedAt,
    entries: index.entries
      .map((entry) => normalizeBriefIndexEntry(entry, index.updatedAt))
      .filter((entry): entry is AoiProactiveBriefIndexEntry => entry !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, MAX_PROACTIVE_BRIEF_INDEX_ITEMS),
  };
  writeJsonAtomic(paths.root, paths.index, normalized);
  return normalized;
}

function loadCandidateById(
  sessionsDir: string,
  sessionPath: string,
  candidateId: string,
  now: number,
): AoiProactiveBriefCandidate | null {
  if (!isValidAoiAutonomyId(candidateId)) {
    return null;
  }
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  return normalizeAoiProactiveBriefCandidate(
    readJson<unknown>(join(paths.candidatesDir, `${candidateId}.json`)),
    sessionPath,
    now,
  );
}

export function loadAoiProactiveBriefCandidates(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefCandidate[] {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const index = loadAoiProactiveBriefIndex(sessionsDir, sessionPath, now);
  const indexed = index.entries
    .map((entry) => loadCandidateById(sessionsDir, sessionPath, entry.id, now))
    .filter((candidate): candidate is AoiProactiveBriefCandidate => candidate !== null);
  if (indexed.length > 0 || index.updatedAt > 0) {
    return indexed;
  }
  return listJsonFiles<unknown>(paths.candidatesDir)
    .map((candidate) => normalizeAoiProactiveBriefCandidate(candidate, sessionPath, now))
    .filter((candidate): candidate is AoiProactiveBriefCandidate => candidate !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .slice(0, MAX_PROACTIVE_BRIEF_INDEX_ITEMS);
}

export function upsertAoiProactiveBriefCandidate(
  sessionsDir: string,
  value: unknown,
  now = Date.now(),
): AoiProactiveBriefUpsertResult {
  const candidate = normalizeAoiProactiveBriefCandidate(value, undefined, now);
  if (!candidate) {
    throw new Error('Invalid proactive brief candidate.');
  }
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, candidate.sessionPath);
  const index = loadAoiProactiveBriefIndex(sessionsDir, candidate.sessionPath, now);
  const dedupeKey = createAoiProactiveBriefDedupeKey(candidate);
  const existingEntry = index.entries.find(
    (entry) => entry.id === candidate.id || entry.dedupeKey === dedupeKey,
  );
  const existingCandidate = existingEntry
    ? loadCandidateById(sessionsDir, candidate.sessionPath, existingEntry.id, now)
    : null;
  const storedCandidate: AoiProactiveBriefCandidate = {
    ...candidate,
    id: existingEntry?.id ?? candidate.id,
    dedupeKey,
    createdAt: existingCandidate?.createdAt ?? existingEntry?.createdAt ?? candidate.createdAt,
    updatedAt: now,
  };
  const nextEntry: AoiProactiveBriefIndexEntry = {
    id: storedCandidate.id,
    topicId: storedCandidate.topicId,
    cooldownKey: storedCandidate.cooldownKey,
    status: storedCandidate.status,
    title: storedCandidate.title,
    dedupeKey,
    createdAt: storedCandidate.createdAt,
    updatedAt: storedCandidate.updatedAt,
    expiresAt: storedCandidate.expiresAt,
  };
  const nextEntries = [
    nextEntry,
    ...index.entries.filter(
      (entry) => entry.id !== storedCandidate.id && entry.dedupeKey !== dedupeKey,
    ),
  ]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .slice(0, MAX_PROACTIVE_BRIEF_INDEX_ITEMS);

  writeJsonAtomic(
    paths.root,
    join(paths.candidatesDir, `${storedCandidate.id}.json`),
    storedCandidate,
  );
  saveAoiProactiveBriefIndex(sessionsDir, storedCandidate.sessionPath, {
    version: 1,
    sessionPath: storedCandidate.sessionPath,
    updatedAt: now,
    entries: nextEntries,
  });

  return {
    candidate: storedCandidate,
    created: !existingEntry,
    dedupeKey,
    ...(existingEntry && existingEntry.id !== candidate.id
      ? { replacedCandidateId: existingEntry.id }
      : {}),
  };
}

export function expireStaleAoiProactiveBriefCandidates(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefCandidate[] {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const candidates = loadAoiProactiveBriefCandidates(sessionsDir, sessionPath, now);
  const updated = candidates.map((candidate) => {
    if (
      candidate.expiresAt > now ||
      candidate.status === 'expired' ||
      candidate.status === 'archived' ||
      candidate.status === 'accepted'
    ) {
      return candidate;
    }
    const expired: AoiProactiveBriefCandidate = {
      ...candidate,
      status: 'expired',
      updatedAt: now,
    };
    writeJsonAtomic(paths.root, join(paths.candidatesDir, `${expired.id}.json`), expired);
    return expired;
  });
  saveAoiProactiveBriefIndex(sessionsDir, sessionPath, {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: now,
    entries: updated.map((candidate) => ({
      id: candidate.id,
      topicId: candidate.topicId,
      cooldownKey: candidate.cooldownKey,
      status: candidate.status,
      title: candidate.title,
      dedupeKey: candidate.dedupeKey ?? createAoiProactiveBriefDedupeKey(candidate),
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      expiresAt: candidate.expiresAt,
    })),
  });
  return updated;
}

function normalizeFeedback(
  value: unknown,
  sessionPathFallback?: string,
): AoiProactiveBriefFeedback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefFeedback>;
  const sessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath ?? sessionPathFallback ?? '');
  if (!sessionPath || !isFeedbackCategory(raw.category)) {
    return null;
  }
  const briefId = normalizeText(raw.briefId, 120);
  const topicId = normalizeText(raw.topicId, 120);
  if (!briefId || !topicId) {
    return null;
  }
  return {
    version: 1,
    id: normalizeAutonomyId(
      raw.id,
      'aoi-brief-feedback',
      `${sessionPath}:${briefId}:${raw.category}`,
    ),
    briefId,
    topicId,
    sessionPath,
    category: raw.category,
    ...(normalizeText(raw.note, 240) ? { note: normalizeText(raw.note, 240) } : {}),
    createdAt: normalizeTimestamp(raw.createdAt, Date.now()),
  };
}

export function recordAoiProactiveBriefFeedback(
  sessionsDir: string,
  feedback: unknown,
): AoiProactiveBriefFeedback {
  const normalized = normalizeFeedback(feedback);
  if (!normalized) {
    throw new Error('Invalid proactive brief feedback.');
  }
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, normalized.sessionPath);
  writeJsonAtomic(paths.root, join(paths.feedbackDir, `${normalized.id}.json`), normalized);
  return normalized;
}

export function loadAoiProactiveBriefFeedback(
  sessionsDir: string,
  sessionPath: string,
): AoiProactiveBriefFeedback[] {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  return listJsonFiles<unknown>(paths.feedbackDir)
    .map((feedback) => normalizeFeedback(feedback, sessionPath))
    .filter((feedback): feedback is AoiProactiveBriefFeedback => feedback !== null)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_PROACTIVE_BRIEF_FEEDBACK_ITEMS);
}

function normalizeCooldownEntry(
  value: unknown,
  now: number,
): AoiProactiveBriefCooldownEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefCooldownEntry>;
  const cooldownKey = normalizeText(raw.cooldownKey, 160);
  if (!cooldownKey) {
    return null;
  }
  return {
    version: 1,
    cooldownKey,
    ...(normalizeText(raw.topicId, 120) ? { topicId: normalizeText(raw.topicId, 120) } : {}),
    nextAllowedAt: normalizeTimestamp(raw.nextAllowedAt, now),
    reason: normalizeRequiredText(raw.reason, 'cooldown', 180),
    sourceBriefIds: normalizeStringList(raw.sourceBriefIds, 24, 120),
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
  };
}

export function loadAoiProactiveBriefCooldownState(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefCooldownState {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiProactiveBriefCooldownState>>(paths.cooldowns);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const cooldowns: Record<string, AoiProactiveBriefCooldownEntry> = {};
  if (
    parsed?.cooldowns &&
    typeof parsed.cooldowns === 'object' &&
    !Array.isArray(parsed.cooldowns)
  ) {
    for (const value of Object.values(parsed.cooldowns)) {
      const normalized = normalizeCooldownEntry(value, now);
      if (normalized) {
        cooldowns[normalized.cooldownKey] = normalized;
      }
    }
  }
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    cooldowns,
  };
}

export function saveAoiProactiveBriefCooldownState(
  sessionsDir: string,
  sessionPath: string,
  state: unknown,
  now = Date.now(),
): AoiProactiveBriefCooldownState {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const input =
    state && typeof state === 'object' && !Array.isArray(state)
      ? (state as Partial<AoiProactiveBriefCooldownState>)
      : {};
  const cooldowns: Record<string, AoiProactiveBriefCooldownEntry> = {};
  if (input.cooldowns && typeof input.cooldowns === 'object' && !Array.isArray(input.cooldowns)) {
    for (const value of Object.values(input.cooldowns)) {
      const normalized = normalizeCooldownEntry(value, now);
      if (normalized) {
        cooldowns[normalized.cooldownKey] = normalized;
      }
    }
  }
  const normalized: AoiProactiveBriefCooldownState = {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: normalizeTimestamp(input.updatedAt, now),
    cooldowns,
  };
  writeJsonAtomic(paths.root, paths.cooldowns, normalized);
  return normalized;
}

export function upsertAoiProactiveBriefCooldown(
  sessionsDir: string,
  sessionPath: string,
  input: AoiProactiveBriefCooldownInput,
): AoiProactiveBriefCooldownState {
  const now = input.now ?? Date.now();
  const state = loadAoiProactiveBriefCooldownState(sessionsDir, sessionPath, now);
  const entry = normalizeCooldownEntry(
    {
      version: 1,
      cooldownKey: input.cooldownKey,
      topicId: input.topicId,
      nextAllowedAt: input.nextAllowedAt,
      reason: input.reason,
      sourceBriefIds: input.sourceBriefIds,
      updatedAt: now,
    },
    now,
  );
  if (!entry) {
    throw new Error('Invalid proactive brief cooldown.');
  }
  return saveAoiProactiveBriefCooldownState(
    sessionsDir,
    sessionPath,
    {
      ...state,
      updatedAt: now,
      cooldowns: {
        ...state.cooldowns,
        [entry.cooldownKey]: entry,
      },
    },
    now,
  );
}
