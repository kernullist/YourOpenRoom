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
  AoiProactiveBriefFieldEvent,
  AoiProactiveBriefFieldEventIndex,
  AoiProactiveBriefFieldEventIndexEntry,
  AoiProactiveBriefFieldEventKind,
  AoiProactiveBriefFieldMetrics,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFeedbackCategory,
  AoiProactiveBriefIndex,
  AoiProactiveBriefIndexEntry,
  AoiProactiveBriefSource,
  AoiProactiveBriefStatus,
} from './aoiAutonomyTypes';
import type {
  AoiProactiveBriefDeliveryDecision,
  AoiProactiveBriefDeliverySuppressionReason,
} from './aoiProactiveBriefPolicy';

const MAX_PROACTIVE_BRIEF_INDEX_ITEMS = 200;
const MAX_PROACTIVE_BRIEF_FEEDBACK_ITEMS = 500;
const MAX_PROACTIVE_BRIEF_FIELD_EVENT_INDEX_ITEMS = 500;
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
  fieldEventsDir: string;
  fieldEventIndex: string;
  fieldEventRecordsDir: string;
  fieldMetrics: string;
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

export interface AoiProactiveBriefFieldEventInput {
  kind: AoiProactiveBriefFieldEventKind;
  sessionPath: string;
  briefId?: string;
  topicId?: string;
  feedbackId?: string;
  feedbackCategory?: AoiProactiveBriefFeedbackCategory;
  deliveryMode?: AoiProactiveBriefDeliveryMode;
  policyReason?: string;
  suppressionReasons?: string[];
  title?: string;
  summary?: string;
  sourceRefs?: string[];
  sourceHosts?: string[];
  evidenceRefs?: string[];
  freshness?: Partial<AoiProactiveBriefFieldEvent['freshness']>;
  privacy?: Partial<AoiProactiveBriefFieldEvent['privacy']>;
  dedupeKey?: string;
  createdAt?: number;
}

export interface AoiProactiveBriefDeliveryFieldEventInput {
  sessionsDir: string;
  sessionPath: string;
  candidates: AoiProactiveBriefCandidate[];
  decisions: AoiProactiveBriefDeliveryDecision[];
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
  const normalized = normalizeWhitespace(
    redactAoiSensitiveContent(value)
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
      .replace(
        /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g,
        '[redacted-path]',
      ),
  ).slice(0, maxChars);
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
    value === 'unsafe' ||
    value === 'mute_topic' ||
    value === 'pin_topic' ||
    value === 'archive_brief' ||
    value === 'open_sources' ||
    value === 'expand_summary'
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
    fieldEventsDir: autonomyPaths.proactiveBriefFieldEventsDir,
    fieldEventIndex: autonomyPaths.proactiveBriefFieldEventIndex,
    fieldEventRecordsDir: autonomyPaths.proactiveBriefFieldEventRecordsDir,
    fieldMetrics: autonomyPaths.proactiveBriefFieldMetrics,
  };

  for (const target of [
    paths.profile,
    paths.briefsDir,
    paths.index,
    paths.candidatesDir,
    paths.feedbackDir,
    paths.cooldowns,
    paths.fieldEventsDir,
    paths.fieldEventIndex,
    paths.fieldEventRecordsDir,
    paths.fieldMetrics,
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

function isFieldEventKind(value: unknown): value is AoiProactiveBriefFieldEventKind {
  return (
    value === 'candidate_created' ||
    value === 'shown_dashboard' ||
    value === 'shown_digest' ||
    value === 'shown_inline' ||
    value === 'chat_hook_offered' ||
    value === 'expanded' ||
    value === 'source_opened' ||
    value === 'feedback_recorded' ||
    value === 'suppressed_quiet_mode' ||
    value === 'suppressed_cooldown' ||
    value === 'suppressed_stale_source' ||
    value === 'suppressed_no_opt_in' ||
    value === 'suppressed_budget' ||
    value === 'suppressed_no_topics' ||
    value === 'expired' ||
    value === 'archived'
  );
}

function normalizeFieldEventIndexEntry(
  value: unknown,
  now: number,
): AoiProactiveBriefFieldEventIndexEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefFieldEventIndexEntry>;
  if (!isValidAoiAutonomyId(raw.id) || !isFieldEventKind(raw.kind)) {
    return null;
  }
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  return {
    id: raw.id,
    kind: raw.kind,
    createdAt,
    ...(normalizeText(raw.briefId, 120) ? { briefId: normalizeText(raw.briefId, 120) } : {}),
    ...(normalizeText(raw.topicId, 120) ? { topicId: normalizeText(raw.topicId, 120) } : {}),
    ...(normalizeText(raw.feedbackId, 120)
      ? { feedbackId: normalizeText(raw.feedbackId, 120) }
      : {}),
    ...(isDeliveryMode(raw.deliveryMode) ? { deliveryMode: raw.deliveryMode } : {}),
    ...(normalizeText(raw.dedupeKey, 260) ? { dedupeKey: normalizeText(raw.dedupeKey, 260) } : {}),
  };
}

function loadAoiProactiveBriefFieldEventIndex(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefFieldEventIndex {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const parsed = readJson<Partial<AoiProactiveBriefFieldEventIndex>>(paths.fieldEventIndex);
  const entries =
    parsed?.version === 1 && Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => normalizeFieldEventIndexEntry(entry, now))
          .filter((entry): entry is AoiProactiveBriefFieldEventIndexEntry => entry !== null)
          .sort(
            (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
          )
          .slice(0, MAX_PROACTIVE_BRIEF_FIELD_EVENT_INDEX_ITEMS)
      : [];
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    entries,
  };
}

function saveAoiProactiveBriefFieldEventIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiProactiveBriefFieldEventIndex,
): AoiProactiveBriefFieldEventIndex {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const normalized: AoiProactiveBriefFieldEventIndex = {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: index.updatedAt,
    entries: index.entries
      .map((entry) => normalizeFieldEventIndexEntry(entry, index.updatedAt))
      .filter((entry): entry is AoiProactiveBriefFieldEventIndexEntry => entry !== null)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, MAX_PROACTIVE_BRIEF_FIELD_EVENT_INDEX_ITEMS),
  };
  writeJsonAtomic(paths.root, paths.fieldEventIndex, normalized);
  return normalized;
}

function normalizeFieldEventFreshness(
  value: Partial<AoiProactiveBriefFieldEvent['freshness']> | undefined,
  now: number,
): AoiProactiveBriefFieldEvent['freshness'] {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    ...(typeof raw.searchedAt === 'number' && Number.isFinite(raw.searchedAt)
      ? { searchedAt: Math.max(0, raw.searchedAt) }
      : {}),
    ...(normalizeText(raw.newestSourceAt, 64)
      ? { newestSourceAt: normalizeText(raw.newestSourceAt, 64) }
      : {}),
    cannotKnow: normalizeStringList(raw.cannotKnow, 12, 240),
    stale:
      raw.stale === true ||
      normalizeStringList(raw.cannotKnow, 12, 240).some((item) =>
        /stale|freshness window/i.test(item),
      ) ||
      (typeof raw.searchedAt === 'number' &&
        Number.isFinite(raw.searchedAt) &&
        raw.searchedAt > now),
  };
}

function normalizeFieldEventPrivacy(params: {
  rawText: string;
  input?: Partial<AoiProactiveBriefFieldEvent['privacy']>;
}): AoiProactiveBriefFieldEvent['privacy'] {
  const hasSensitiveText = containsAoiSensitiveContent(params.rawText);
  const hasPrivatePath =
    /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/.test(params.rawText) ||
    /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/.test(params.rawText);
  return {
    redacted: params.input?.redacted === true || hasSensitiveText || hasPrivatePath,
    privateLeakDetected: params.input?.privateLeakDetected === true,
    unauthorizedMutationDetected: params.input?.unauthorizedMutationDetected === true,
    redactionReasons: [
      ...new Set([
        ...(hasSensitiveText ? ['sensitive_text_redacted'] : []),
        ...(hasPrivatePath ? ['private_path_redacted'] : []),
        ...normalizeStringList(params.input?.redactionReasons, 12, 120),
      ]),
    ],
  };
}

function normalizeAoiProactiveBriefFieldEvent(
  value: unknown,
  sessionPathFallback?: string,
  now = Date.now(),
): AoiProactiveBriefFieldEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefFieldEvent>;
  const sessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath ?? sessionPathFallback ?? '');
  if (!sessionPath || !isValidAoiAutonomyId(raw.id) || !isFieldEventKind(raw.kind)) {
    return null;
  }
  const title = normalizeText(raw.title, 160);
  const summary = normalizeText(raw.summary, 420);
  const suppressionReasons = normalizeStringList(raw.suppressionReasons, 12, 120);
  const sourceRefs = normalizeStringList(raw.sourceRefs, 16, 180);
  const sourceHosts = normalizeStringList(raw.sourceHosts, 12, 120);
  const evidenceRefs = normalizeStringList(raw.evidenceRefs, 24, 180);
  const rawText = JSON.stringify({
    briefId: raw.briefId,
    topicId: raw.topicId,
    feedbackId: raw.feedbackId,
    policyReason: raw.policyReason,
    title: raw.title,
    summary: raw.summary,
    suppressionReasons: raw.suppressionReasons,
    sourceRefs: raw.sourceRefs,
    sourceHosts: raw.sourceHosts,
    evidenceRefs: raw.evidenceRefs,
    freshness: raw.freshness,
    dedupeKey: raw.dedupeKey,
  });
  return {
    version: 1,
    id: raw.id,
    sessionPath,
    kind: raw.kind,
    ...(normalizeText(raw.briefId, 120) ? { briefId: normalizeText(raw.briefId, 120) } : {}),
    ...(normalizeText(raw.topicId, 120) ? { topicId: normalizeText(raw.topicId, 120) } : {}),
    ...(normalizeText(raw.feedbackId, 120)
      ? { feedbackId: normalizeText(raw.feedbackId, 120) }
      : {}),
    ...(isFeedbackCategory(raw.feedbackCategory) ? { feedbackCategory: raw.feedbackCategory } : {}),
    ...(isDeliveryMode(raw.deliveryMode) ? { deliveryMode: raw.deliveryMode } : {}),
    ...(normalizeText(raw.policyReason, 180)
      ? { policyReason: normalizeText(raw.policyReason, 180) }
      : {}),
    suppressionReasons,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    sourceRefs,
    sourceHosts,
    evidenceRefs,
    freshness: normalizeFieldEventFreshness(raw.freshness, now),
    privacy: normalizeFieldEventPrivacy({
      rawText,
      input: raw.privacy,
    }),
    ...(normalizeText(raw.dedupeKey, 260) ? { dedupeKey: normalizeText(raw.dedupeKey, 260) } : {}),
    createdAt: normalizeTimestamp(raw.createdAt, now),
  };
}

function fieldEventIndexEntry(
  event: AoiProactiveBriefFieldEvent,
): AoiProactiveBriefFieldEventIndexEntry {
  return {
    id: event.id,
    kind: event.kind,
    createdAt: event.createdAt,
    ...(event.briefId ? { briefId: event.briefId } : {}),
    ...(event.topicId ? { topicId: event.topicId } : {}),
    ...(event.feedbackId ? { feedbackId: event.feedbackId } : {}),
    ...(event.deliveryMode ? { deliveryMode: event.deliveryMode } : {}),
    ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
  };
}

function loadFieldEventById(
  sessionsDir: string,
  sessionPath: string,
  eventId: string,
  now: number,
): AoiProactiveBriefFieldEvent | null {
  if (!isValidAoiAutonomyId(eventId)) {
    return null;
  }
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  return normalizeAoiProactiveBriefFieldEvent(
    readJson<unknown>(join(paths.fieldEventRecordsDir, `${eventId}.json`)),
    sessionPath,
    now,
  );
}

export function loadAoiProactiveBriefFieldEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefFieldEvent[] {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const index = loadAoiProactiveBriefFieldEventIndex(sessionsDir, sessionPath, now);
  const indexed = index.entries
    .map((entry) => loadFieldEventById(sessionsDir, sessionPath, entry.id, now))
    .filter((event): event is AoiProactiveBriefFieldEvent => event !== null);
  if (indexed.length > 0 || index.updatedAt > 0) {
    return indexed.sort(
      (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    );
  }
  return listJsonFiles<unknown>(paths.fieldEventRecordsDir)
    .map((event) => normalizeAoiProactiveBriefFieldEvent(event, sessionPath, now))
    .filter((event): event is AoiProactiveBriefFieldEvent => event !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_PROACTIVE_BRIEF_FIELD_EVENT_INDEX_ITEMS);
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function buildAoiProactiveBriefFieldMetrics(
  sessionPath: string,
  events: AoiProactiveBriefFieldEvent[],
  now = Date.now(),
): AoiProactiveBriefFieldMetrics {
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const suppressionCounts: Record<string, number> = {};
  const shownByDeliveryMode: Record<AoiProactiveBriefDeliveryMode, number> = {
    dashboard: 0,
    digest: 0,
    inline_card: 0,
    chat_hook: 0,
  };
  let consideredCount = 0;
  let shownCount = 0;
  let expandedCount = 0;
  let sourceOpenedCount = 0;
  let feedbackRecordedCount = 0;
  let usefulCount = 0;
  let tooFrequentCount = 0;
  let wrongTopicCount = 0;
  let wrongTimingCount = 0;
  let staleCount = 0;
  let unsafeCount = 0;
  let privateLeakCount = 0;
  let unauthorizedMutationCount = 0;
  let directChatHookCount = 0;

  for (const event of events) {
    if (event.kind === 'candidate_created') {
      consideredCount += 1;
    }
    if (
      event.kind === 'shown_dashboard' ||
      event.kind === 'shown_digest' ||
      event.kind === 'shown_inline' ||
      event.kind === 'chat_hook_offered'
    ) {
      shownCount += 1;
      if (event.deliveryMode) {
        shownByDeliveryMode[event.deliveryMode] += 1;
      }
    }
    if (event.kind === 'expanded') {
      expandedCount += 1;
    }
    if (event.kind === 'source_opened') {
      sourceOpenedCount += 1;
    }
    if (event.kind === 'feedback_recorded') {
      feedbackRecordedCount += 1;
    }
    if (event.kind === 'chat_hook_offered' || event.deliveryMode === 'chat_hook') {
      directChatHookCount += 1;
    }
    if (event.kind.startsWith('suppressed_')) {
      incrementCount(suppressionCounts, event.kind);
    }
    for (const reason of event.suppressionReasons) {
      incrementCount(suppressionCounts, reason);
    }
    if (event.feedbackCategory === 'useful') {
      usefulCount += 1;
    }
    if (event.feedbackCategory === 'too_frequent') {
      tooFrequentCount += 1;
    }
    if (event.feedbackCategory === 'wrong_topic') {
      wrongTopicCount += 1;
    }
    if (event.feedbackCategory === 'wrong_timing') {
      wrongTimingCount += 1;
    }
    if (
      event.feedbackCategory === 'stale' ||
      event.kind === 'suppressed_stale_source' ||
      event.freshness.stale
    ) {
      staleCount += 1;
    }
    if (event.feedbackCategory === 'unsafe') {
      unsafeCount += 1;
    }
    if (event.privacy.privateLeakDetected) {
      privateLeakCount += 1;
    }
    if (event.privacy.unauthorizedMutationDetected) {
      unauthorizedMutationCount += 1;
    }
  }

  const eventCount = events.length;
  const status =
    privateLeakCount > 0 || unauthorizedMutationCount > 0
      ? 'blocked'
      : eventCount > 0
        ? 'field_events_recorded'
        : 'not_field_tested';
  const evidenceRefs = [
    ...new Set(
      events.flatMap((event) => [`proactive-brief-field-event:${event.id}`, ...event.evidenceRefs]),
    ),
  ].slice(0, 24);
  const lastEventAt = events
    .map((event) => event.createdAt)
    .filter((createdAt) => createdAt > 0)
    .sort((left, right) => right - left)[0];

  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    generatedAt: now,
    status,
    eventCount,
    consideredCount,
    shownCount,
    shownByDeliveryMode,
    expandedCount,
    sourceOpenedCount,
    feedbackRecordedCount,
    usefulCount,
    tooFrequentCount,
    wrongTopicCount,
    wrongTimingCount,
    staleCount,
    unsafeCount,
    suppressionCounts,
    privateLeakCount,
    unauthorizedMutationCount,
    directChatHookCount,
    ...(lastEventAt ? { lastEventAt } : {}),
    evidenceRefs,
  };
}

function saveAoiProactiveBriefFieldMetrics(
  sessionsDir: string,
  sessionPath: string,
  metrics: AoiProactiveBriefFieldMetrics,
): AoiProactiveBriefFieldMetrics {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  writeJsonAtomic(paths.root, paths.fieldMetrics, metrics);
  return metrics;
}

export function loadAoiProactiveBriefFieldMetrics(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefFieldMetrics {
  return buildAoiProactiveBriefFieldMetrics(
    sessionPath,
    loadAoiProactiveBriefFieldEvents(sessionsDir, sessionPath, now),
    now,
  );
}

function createFieldEventId(params: {
  prefix: string;
  now: number;
  sequence: number;
  seed: string;
}): string {
  const sequence = Math.max(1, params.sequence).toString(36);
  return `${params.prefix}-${params.now.toString(36)}-${sequence}-${hashText(params.seed)}`.slice(
    0,
    127,
  );
}

export function recordAoiProactiveBriefFieldEvent(
  sessionsDir: string,
  input: AoiProactiveBriefFieldEventInput,
): AoiProactiveBriefFieldEvent {
  const now = input.createdAt ?? Date.now();
  const sessionPath = resolveSessionPath(input.sessionPath);
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const index = loadAoiProactiveBriefFieldEventIndex(sessionsDir, sessionPath, now);
  const dedupeKey = normalizeText(input.dedupeKey, 260);
  const existingEntry = dedupeKey
    ? index.entries.find((entry) => entry.dedupeKey === dedupeKey)
    : undefined;
  const existingEvent = existingEntry
    ? loadFieldEventById(sessionsDir, sessionPath, existingEntry.id, now)
    : null;
  if (existingEvent) {
    return existingEvent;
  }
  const eventId = createFieldEventId({
    prefix: 'aoi-brief-field',
    now,
    sequence: index.entries.length + 1,
    seed: [
      sessionPath,
      input.kind,
      input.briefId ?? '',
      input.topicId ?? '',
      input.feedbackId ?? '',
      dedupeKey ?? '',
    ].join(':'),
  });
  const event = normalizeAoiProactiveBriefFieldEvent(
    {
      version: 1,
      id: eventId,
      ...input,
      sessionPath,
      ...(dedupeKey ? { dedupeKey } : {}),
      createdAt: now,
    },
    sessionPath,
    now,
  );
  if (!event) {
    throw new Error('Invalid proactive brief field event.');
  }
  writeJsonAtomic(paths.root, join(paths.fieldEventRecordsDir, `${event.id}.json`), event);
  const nextIndex = saveAoiProactiveBriefFieldEventIndex(sessionsDir, sessionPath, {
    version: 1,
    sessionPath,
    updatedAt: now,
    entries: [
      fieldEventIndexEntry(event),
      ...index.entries.filter((entry) => entry.id !== event.id),
    ],
  });
  const indexedEvents = nextIndex.entries
    .map((entry) => loadFieldEventById(sessionsDir, sessionPath, entry.id, now))
    .filter((item): item is AoiProactiveBriefFieldEvent => item !== null);
  saveAoiProactiveBriefFieldMetrics(
    sessionsDir,
    sessionPath,
    buildAoiProactiveBriefFieldMetrics(sessionPath, indexedEvents, now),
  );
  return event;
}

function fieldEventSources(candidate: AoiProactiveBriefCandidate): {
  sourceRefs: string[];
  sourceHosts: string[];
} {
  const sourceHosts = [...new Set(candidate.sources.map((source) => source.host).filter(Boolean))];
  return {
    sourceRefs: [
      ...new Set([
        ...candidate.sources.map((source) => `source:${source.host}`),
        ...candidate.sources.map((source) => source.url),
      ]),
    ].slice(0, 16),
    sourceHosts: sourceHosts.slice(0, 12),
  };
}

function candidateFieldEventInput(
  candidate: AoiProactiveBriefCandidate,
  kind: AoiProactiveBriefFieldEventKind,
  now: number,
): AoiProactiveBriefFieldEventInput {
  const sources = fieldEventSources(candidate);
  return {
    kind,
    sessionPath: candidate.sessionPath,
    briefId: candidate.id,
    topicId: candidate.topicId,
    title: candidate.title,
    summary: `${candidate.hook} ${candidate.whyForOperator}`.trim(),
    sourceRefs: sources.sourceRefs,
    sourceHosts: sources.sourceHosts,
    evidenceRefs: candidate.evidenceRefs,
    freshness: {
      searchedAt: candidate.freshness.searchedAt,
      newestSourceAt: candidate.freshness.newestSourceAt,
      cannotKnow: candidate.freshness.cannotKnow,
    },
    dedupeKey: `${kind}:${candidate.id}`,
    createdAt: now,
  };
}

function suppressionKindForDecision(
  decision: AoiProactiveBriefDeliveryDecision,
): AoiProactiveBriefFieldEventKind {
  const reasons: AoiProactiveBriefDeliverySuppressionReason[] = [
    ...decision.suppressionReasons,
    ...Object.values(decision.modeReasons).flat(),
    ...decision.chatHook.reasons,
  ];
  if (
    reasons.some(
      (reason) =>
        reason === 'quiet_mode_suppresses_chat_hook' ||
        reason === 'quiet_mode_suppresses_inline_card',
    )
  ) {
    return 'suppressed_quiet_mode';
  }
  if (
    reasons.some(
      (reason) => reason === 'topic_cooldown_active' || reason === 'global_cooldown_active',
    )
  ) {
    return 'suppressed_cooldown';
  }
  if (reasons.includes('stale_source')) {
    return 'suppressed_stale_source';
  }
  if (
    reasons.some(
      (reason) =>
        reason === 'missing_sources' ||
        reason === 'topic_muted' ||
        reason === 'candidate_not_active' ||
        reason === 'confidence_below_policy_floor',
    )
  ) {
    return 'suppressed_no_topics';
  }
  if (reasons.includes('chat_hook_not_opted_in')) {
    return 'suppressed_no_opt_in';
  }
  return 'suppressed_budget';
}

function shownKindForMode(mode: AoiProactiveBriefDeliveryMode): AoiProactiveBriefFieldEventKind {
  if (mode === 'digest') {
    return 'shown_digest';
  }
  if (mode === 'inline_card') {
    return 'shown_inline';
  }
  if (mode === 'chat_hook') {
    return 'chat_hook_offered';
  }
  return 'shown_dashboard';
}

export function recordAoiProactiveBriefDeliveryFieldEvents(
  input: AoiProactiveBriefDeliveryFieldEventInput,
): AoiProactiveBriefFieldEvent[] {
  const now = input.now ?? Date.now();
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const events: AoiProactiveBriefFieldEvent[] = [];
  for (const decision of input.decisions) {
    const candidate = byId.get(decision.candidateId);
    if (!candidate) {
      continue;
    }
    const mode = decision.chatHook.allowed
      ? 'chat_hook'
      : (decision.selectedMode ?? (decision.compactCardVisible ? 'dashboard' : null));
    const reasons = [
      ...new Set([
        ...decision.suppressionReasons,
        ...Object.values(decision.modeReasons).flat(),
        ...decision.chatHook.reasons,
      ]),
    ];
    const kind = mode ? shownKindForMode(mode) : suppressionKindForDecision(decision);
    const policyReason = mode ? `${mode}_allowed` : reasons[0];
    events.push(
      recordAoiProactiveBriefFieldEvent(input.sessionsDir, {
        ...candidateFieldEventInput(candidate, kind, now),
        deliveryMode: mode ?? undefined,
        policyReason,
        suppressionReasons: mode ? [] : reasons,
        dedupeKey: `${kind}:${candidate.id}:${mode ?? (reasons.join('|') || 'policy')}`,
      }),
    );
  }
  return events;
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
  if (!existingEntry && storedCandidate.status === 'candidate') {
    recordAoiProactiveBriefFieldEvent(
      sessionsDir,
      candidateFieldEventInput(storedCandidate, 'candidate_created', now),
    );
  }

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
    recordAoiProactiveBriefFieldEvent(
      sessionsDir,
      candidateFieldEventInput(expired, 'expired', now),
    );
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
  recordAoiProactiveBriefFieldEvent(sessionsDir, {
    kind: 'feedback_recorded',
    sessionPath: normalized.sessionPath,
    briefId: normalized.briefId,
    topicId: normalized.topicId,
    feedbackId: normalized.id,
    feedbackCategory: normalized.category,
    summary: normalized.note,
    evidenceRefs: [`feedback:${normalized.id}`],
    dedupeKey: `feedback_recorded:${normalized.id}`,
    createdAt: normalized.createdAt,
  });
  const candidate = loadCandidateById(
    sessionsDir,
    normalized.sessionPath,
    normalized.briefId,
    normalized.createdAt,
  );
  const actionKind =
    normalized.category === 'expand_summary'
      ? 'expanded'
      : normalized.category === 'open_sources'
        ? 'source_opened'
        : normalized.category === 'archive_brief'
          ? 'archived'
          : null;
  if (actionKind) {
    recordAoiProactiveBriefFieldEvent(sessionsDir, {
      ...(candidate
        ? candidateFieldEventInput(candidate, actionKind, normalized.createdAt)
        : {
            kind: actionKind,
            sessionPath: normalized.sessionPath,
            briefId: normalized.briefId,
            topicId: normalized.topicId,
            createdAt: normalized.createdAt,
          }),
      feedbackId: normalized.id,
      feedbackCategory: normalized.category,
      evidenceRefs: [...new Set([...(candidate?.evidenceRefs ?? []), `feedback:${normalized.id}`])],
      dedupeKey: `${actionKind}:${normalized.id}`,
    });
  }
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
