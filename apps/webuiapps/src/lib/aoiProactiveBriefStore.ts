import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import {
  appendAoiFollowThroughEvent,
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { buildAoiFollowThroughEventFromProactiveBriefFeedback } from './aoiFollowThroughLearning';
import { buildAoiInterestProfileFromMemories } from './aoiInterestProfile';
import {
  classifyAoiProactiveBriefMediaKind,
  deriveAoiProactiveBriefMediaBucket,
} from './aoiProactiveMediaKind';
import type {
  AoiAutonomyRisk,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiInterestTopicSource,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCalibrationInbox,
  AoiProactiveBriefCalibrationInboxItem,
  AoiProactiveBriefCalibrationLabel,
  AoiProactiveBriefCalibrationLabelIndex,
  AoiProactiveBriefCalibrationLabelIndexEntry,
  AoiProactiveBriefCalibrationLabelRecord,
  AoiProactiveBriefCalibrationTuning,
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
export const AOI_PROACTIVE_FIELD_EVENT_AUDIT_TAIL_LIMIT = 500;
const MAX_PROACTIVE_BRIEF_FIELD_EVENT_INDEX_ITEMS = AOI_PROACTIVE_FIELD_EVENT_AUDIT_TAIL_LIMIT;
const MAX_PROACTIVE_BRIEF_CALIBRATION_LABEL_INDEX_ITEMS = 1000;
const MAX_PROACTIVE_BRIEF_CALIBRATION_INBOX_ITEMS = 80;
const DEFAULT_BRIEF_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_PROFILE_LABEL = 'Interest Topic';
const TOO_FREQUENT_CALIBRATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STALE_CALIBRATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const UNSAFE_CALIBRATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const AOI_PROACTIVE_FIELD_EVENT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

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
  fieldEventCompaction: string;
  fieldMetrics: string;
  calibrationLabelsDir: string;
  calibrationLabelIndex: string;
  calibrationLabelRecordsDir: string;
  calibrationTuning: string;
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

export interface AoiProactiveBriefCalibrationLabelInput {
  sessionPath: string;
  fieldEventId: string;
  label: AoiProactiveBriefCalibrationLabel;
  actor?: 'user' | 'system';
  note?: string;
  evidenceRefs?: string[];
  now?: number;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function isRealPathInsideRoot(root: string, target: string): boolean {
  try {
    if (!fs.existsSync(root) || !fs.existsSync(target)) {
      return false;
    }
    return isPathInsideRoot(fs.realpathSync(root), fs.realpathSync(target));
  } catch {
    return false;
  }
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
    value === 'wrong_source' ||
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
    fieldEventCompaction: join(autonomyPaths.proactiveBriefFieldEventsDir, 'compaction.json'),
    fieldMetrics: autonomyPaths.proactiveBriefFieldMetrics,
    calibrationLabelsDir: autonomyPaths.proactiveBriefCalibrationLabelsDir,
    calibrationLabelIndex: autonomyPaths.proactiveBriefCalibrationLabelIndex,
    calibrationLabelRecordsDir: autonomyPaths.proactiveBriefCalibrationLabelRecordsDir,
    calibrationTuning: autonomyPaths.proactiveBriefCalibrationTuning,
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
    paths.fieldEventCompaction,
    paths.fieldMetrics,
    paths.calibrationLabelsDir,
    paths.calibrationLabelIndex,
    paths.calibrationLabelRecordsDir,
    paths.calibrationTuning,
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
    ...(raw.interestKind === 'professional' || raw.interestKind === 'personal'
      ? { interestKind: raw.interestKind }
      : {}),
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
  const host = normalizeText(raw.host, 120) ?? parsed.hostname;
  const canonicalUrl = parsed.toString();
  const storedMediaKind =
    raw.mediaKind === 'video' ||
    raw.mediaKind === 'podcast' ||
    raw.mediaKind === 'music' ||
    raw.mediaKind === 'article'
      ? raw.mediaKind
      : undefined;
  return {
    title,
    url: canonicalUrl,
    host,
    ...(normalizeText(raw.publishedAt, 64)
      ? { publishedAt: normalizeText(raw.publishedAt, 64) }
      : {}),
    retrievedAt: normalizeTimestamp(raw.retrievedAt, now),
    snippet,
    // Preserve a valid stored kind; backfill legacy sources by classifying.
    mediaKind:
      storedMediaKind ??
      classifyAoiProactiveBriefMediaKind({ url: canonicalUrl, host, title, snippet }),
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
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    NonNullable<AoiProactiveBriefCandidate['freshness']>
  >;
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
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    NonNullable<AoiProactiveBriefCandidate['delivery']>
  >;
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
  const sources = normalizeBriefSources(raw.sources, now);
  const storedMediaBucket =
    raw.mediaBucket === 'watch' ||
    raw.mediaBucket === 'listen' ||
    raw.mediaBucket === 'read' ||
    raw.mediaBucket === 'mixed'
      ? raw.mediaBucket
      : undefined;
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
    sources,
    // Preserve a valid stored bucket; otherwise derive from the source kinds.
    mediaBucket: storedMediaBucket ?? deriveAoiProactiveBriefMediaBucket(sources),
    // Preserved so companion copy keeps its reason; legacy records simply have
    // none and fall back to the professional phrasing.
    ...(raw.interestKind === 'professional' || raw.interestKind === 'personal'
      ? { interestKind: raw.interestKind }
      : {}),
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
      : listJsonFiles<unknown>(paths.fieldEventRecordsDir)
          .map((event) => normalizeAoiProactiveBriefFieldEvent(event, normalizedSessionPath, now))
          .filter((event): event is AoiProactiveBriefFieldEvent => event !== null)
          .map(fieldEventIndexEntry)
          .sort(
            (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
          )
          .slice(0, MAX_PROACTIVE_BRIEF_FIELD_EVENT_INDEX_ITEMS);
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    entries,
  };
}

interface AoiProactiveFieldEventCompactionState {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  compactedEventCount: number;
  compactedRecordFingerprints: string[];
  kindCounts: Record<string, number>;
  deliveryModeCounts: Record<string, number>;
  redactedEventCount: number;
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

function normalizePositiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeAggregateCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (/^[a-z0-9_]{1,80}$/i.test(key)) {
      output[key] = normalizePositiveCount(count);
    }
  }
  return output;
}

function loadProactiveFieldEventCompaction(
  paths: AoiProactiveBriefPaths,
  sessionPath: string,
  now: number,
): AoiProactiveFieldEventCompactionState {
  const raw = readJson<Partial<AoiProactiveFieldEventCompactionState>>(paths.fieldEventCompaction);
  if (raw?.version !== 1 || raw.sessionPath !== sessionPath) {
    return {
      version: 1,
      sessionPath,
      updatedAt: now,
      compactedEventCount: 0,
      compactedRecordFingerprints: [],
      kindCounts: {},
      deliveryModeCounts: {},
      redactedEventCount: 0,
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
      actionAuthority: 'display_only',
      mutationCount: 0,
    };
  }
  return {
    version: 1,
    sessionPath,
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
    compactedEventCount: normalizePositiveCount(raw.compactedEventCount),
    compactedRecordFingerprints: Array.isArray(raw.compactedRecordFingerprints)
      ? raw.compactedRecordFingerprints
          .filter(
            (fingerprint): fingerprint is string =>
              typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint),
          )
          .slice(-20_000)
      : [],
    kindCounts: normalizeAggregateCounts(raw.kindCounts),
    deliveryModeCounts: normalizeAggregateCounts(raw.deliveryModeCounts),
    redactedEventCount: normalizePositiveCount(raw.redactedEventCount),
    privateLeakCount: normalizePositiveCount(raw.privateLeakCount),
    unauthorizedMutationCount: normalizePositiveCount(raw.unauthorizedMutationCount),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function compactUnindexedProactiveFieldEvents(params: {
  paths: AoiProactiveBriefPaths;
  sessionPath: string;
  retainedIds: ReadonlySet<string>;
  now: number;
}): void {
  if (!fs.existsSync(params.paths.fieldEventRecordsDir)) {
    return;
  }
  if (!isRealPathInsideRoot(params.paths.root, params.paths.fieldEventRecordsDir)) {
    throw new Error('Proactive field event records escaped through a symbolic link.');
  }
  const state = loadProactiveFieldEventCompaction(params.paths, params.sessionPath, params.now);
  let compactedEventCount = 0;
  let redactedEventCount = 0;
  let privateLeakCount = 0;
  let unauthorizedMutationCount = 0;
  const kindCounts = { ...state.kindCounts };
  const deliveryModeCounts = { ...state.deliveryModeCounts };
  const alreadyCounted = new Set(state.compactedRecordFingerprints);
  const newlyCompactedFingerprints: string[] = [];
  const recordsToDelete: string[] = [];

  for (const entry of fs.readdirSync(params.paths.fieldEventRecordsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const id = entry.name.slice(0, -'.json'.length);
    if (!isValidAoiAutonomyId(id) || params.retainedIds.has(id)) {
      continue;
    }
    const filePath = join(params.paths.fieldEventRecordsDir, entry.name);
    if (!isPathInsideRoot(params.paths.root, filePath)) {
      continue;
    }
    if (!isRealPathInsideRoot(params.paths.fieldEventRecordsDir, filePath)) {
      continue;
    }
    const event = normalizeAoiProactiveBriefFieldEvent(
      readJson<unknown>(filePath),
      params.sessionPath,
      params.now,
    );
    if (!event) {
      continue;
    }
    recordsToDelete.push(filePath);
    const recordFingerprint = createHash('sha256').update(id).digest('hex');
    if (alreadyCounted.has(recordFingerprint)) {
      continue;
    }
    newlyCompactedFingerprints.push(recordFingerprint);
    compactedEventCount += 1;
    kindCounts[event.kind] = (kindCounts[event.kind] ?? 0) + 1;
    const deliveryMode = event.deliveryMode ?? 'none';
    deliveryModeCounts[deliveryMode] = (deliveryModeCounts[deliveryMode] ?? 0) + 1;
    if (event.privacy.redacted) {
      redactedEventCount += 1;
    }
    if (event.privacy.privateLeakDetected) {
      privateLeakCount += 1;
    }
    if (event.privacy.unauthorizedMutationDetected) {
      unauthorizedMutationCount += 1;
    }
  }

  if (compactedEventCount > 0) {
    writeJsonAtomic(params.paths.root, params.paths.fieldEventCompaction, {
      ...state,
      updatedAt: params.now,
      compactedEventCount: state.compactedEventCount + compactedEventCount,
      compactedRecordFingerprints: [
        ...state.compactedRecordFingerprints,
        ...newlyCompactedFingerprints,
      ].slice(-20_000),
      kindCounts,
      deliveryModeCounts,
      redactedEventCount: state.redactedEventCount + redactedEventCount,
      privateLeakCount: state.privateLeakCount + privateLeakCount,
      unauthorizedMutationCount: state.unauthorizedMutationCount + unauthorizedMutationCount,
    } satisfies AoiProactiveFieldEventCompactionState);
  }
  for (const filePath of recordsToDelete) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // The aggregate was checkpointed first. A later retention pass retries deletion.
    }
  }
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
  if (index.entries.length > normalized.entries.length) {
    compactUnindexedProactiveFieldEvents({
      paths,
      sessionPath: normalizedSessionPath,
      retainedIds: new Set(normalized.entries.map((entry) => entry.id)),
      now: normalized.updatedAt,
    });
  }
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
  let staleCurrentClaimCount = 0;
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
    if (
      event.freshness.stale &&
      (event.kind === 'shown_dashboard' ||
        event.kind === 'shown_digest' ||
        event.kind === 'shown_inline' ||
        event.kind === 'chat_hook_offered' ||
        event.kind === 'expanded' ||
        event.kind === 'source_opened')
    ) {
      staleCurrentClaimCount += 1;
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
    staleCurrentClaimCount,
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

const CALIBRATION_LABELS: readonly AoiProactiveBriefCalibrationLabel[] = [
  'useful',
  'show_more',
  'show_less',
  'too_frequent',
  'wrong_topic',
  'wrong_source',
  'wrong_timing',
  'stale',
  'unsafe',
  'mute_topic',
  'pin_topic',
];

function isCalibrationLabel(value: unknown): value is AoiProactiveBriefCalibrationLabel {
  return CALIBRATION_LABELS.includes(value as AoiProactiveBriefCalibrationLabel);
}

function emptyCalibrationLabelDistribution(): Record<AoiProactiveBriefCalibrationLabel, number> {
  return CALIBRATION_LABELS.reduce(
    (out, label) => {
      out[label] = 0;
      return out;
    },
    {} as Record<AoiProactiveBriefCalibrationLabel, number>,
  );
}

function calibrationLabelIndexEntry(
  label: AoiProactiveBriefCalibrationLabelRecord,
): AoiProactiveBriefCalibrationLabelIndexEntry {
  return {
    id: label.id,
    fieldEventId: label.fieldEventId,
    label: label.label,
    createdAt: label.createdAt,
    ...(label.briefId ? { briefId: label.briefId } : {}),
    ...(label.topicId ? { topicId: label.topicId } : {}),
  };
}

function normalizeCalibrationLabelIndexEntry(
  value: unknown,
  now: number,
): AoiProactiveBriefCalibrationLabelIndexEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefCalibrationLabelIndexEntry>;
  if (
    !isValidAoiAutonomyId(raw.id) ||
    !isValidAoiAutonomyId(raw.fieldEventId) ||
    !isCalibrationLabel(raw.label)
  ) {
    return null;
  }
  return {
    id: raw.id,
    fieldEventId: raw.fieldEventId,
    label: raw.label,
    createdAt: normalizeTimestamp(raw.createdAt, now),
    ...(normalizeText(raw.briefId, 120) ? { briefId: normalizeText(raw.briefId, 120) } : {}),
    ...(normalizeText(raw.topicId, 120) ? { topicId: normalizeText(raw.topicId, 120) } : {}),
  };
}

function loadAoiProactiveBriefCalibrationLabelIndex(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefCalibrationLabelIndex {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiProactiveBriefCalibrationLabelIndex>>(
    paths.calibrationLabelIndex,
  );
  const entries =
    parsed?.version === 1 && Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => normalizeCalibrationLabelIndexEntry(entry, now))
          .filter((entry): entry is AoiProactiveBriefCalibrationLabelIndexEntry => entry !== null)
          .sort(
            (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
          )
          .slice(0, MAX_PROACTIVE_BRIEF_CALIBRATION_LABEL_INDEX_ITEMS)
      : [];
  return {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    entries,
  };
}

function saveAoiProactiveBriefCalibrationLabelIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiProactiveBriefCalibrationLabelIndex,
): AoiProactiveBriefCalibrationLabelIndex {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const normalized: AoiProactiveBriefCalibrationLabelIndex = {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: index.updatedAt,
    entries: index.entries
      .map((entry) => normalizeCalibrationLabelIndexEntry(entry, index.updatedAt))
      .filter((entry): entry is AoiProactiveBriefCalibrationLabelIndexEntry => entry !== null)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, MAX_PROACTIVE_BRIEF_CALIBRATION_LABEL_INDEX_ITEMS),
  };
  writeJsonAtomic(paths.root, paths.calibrationLabelIndex, normalized);
  return normalized;
}

function normalizeAoiProactiveBriefCalibrationLabelRecord(
  value: unknown,
  sessionPathFallback?: string,
  now = Date.now(),
): AoiProactiveBriefCalibrationLabelRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefCalibrationLabelRecord>;
  const sessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath ?? sessionPathFallback ?? '');
  if (
    !sessionPath ||
    !isValidAoiAutonomyId(raw.id) ||
    !isValidAoiAutonomyId(raw.fieldEventId) ||
    !isCalibrationLabel(raw.label)
  ) {
    return null;
  }
  return {
    version: 1,
    id: raw.id,
    sessionPath,
    fieldEventId: raw.fieldEventId,
    ...(normalizeText(raw.briefId, 120) ? { briefId: normalizeText(raw.briefId, 120) } : {}),
    ...(normalizeText(raw.topicId, 120) ? { topicId: normalizeText(raw.topicId, 120) } : {}),
    label: raw.label,
    actor: raw.actor === 'system' ? 'system' : 'user',
    ...(normalizeText(raw.note, 240) ? { note: normalizeText(raw.note, 240) } : {}),
    ...(isDeliveryMode(raw.deliveryMode) ? { deliveryMode: raw.deliveryMode } : {}),
    ...(normalizeText(raw.policyReason, 180)
      ? { policyReason: normalizeText(raw.policyReason, 180) }
      : {}),
    sourceRefs: normalizeStringList(raw.sourceRefs, 16, 180),
    sourceHosts: normalizeStringList(raw.sourceHosts, 12, 120),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24, 180),
    createdAt: normalizeTimestamp(raw.createdAt, now),
  };
}

function loadCalibrationLabelById(
  sessionsDir: string,
  sessionPath: string,
  labelId: string,
  now: number,
): AoiProactiveBriefCalibrationLabelRecord | null {
  if (!isValidAoiAutonomyId(labelId)) {
    return null;
  }
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  return normalizeAoiProactiveBriefCalibrationLabelRecord(
    readJson<unknown>(join(paths.calibrationLabelRecordsDir, `${labelId}.json`)),
    sessionPath,
    now,
  );
}

export function loadAoiProactiveBriefCalibrationLabels(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefCalibrationLabelRecord[] {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const index = loadAoiProactiveBriefCalibrationLabelIndex(sessionsDir, sessionPath, now);
  const indexed = index.entries
    .map((entry) => loadCalibrationLabelById(sessionsDir, sessionPath, entry.id, now))
    .filter((label): label is AoiProactiveBriefCalibrationLabelRecord => label !== null);
  if (indexed.length > 0 || index.updatedAt > 0) {
    return indexed.sort(
      (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    );
  }
  return listJsonFiles<unknown>(paths.calibrationLabelRecordsDir)
    .map((label) => normalizeAoiProactiveBriefCalibrationLabelRecord(label, sessionPath, now))
    .filter((label): label is AoiProactiveBriefCalibrationLabelRecord => label !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_PROACTIVE_BRIEF_CALIBRATION_LABEL_INDEX_ITEMS);
}

function createCalibrationLabelId(params: {
  sessionPath: string;
  fieldEventId: string;
  label: AoiProactiveBriefCalibrationLabel;
  now: number;
  sequence: number;
  note?: string;
}): string {
  return `aoi-brief-calibration-${params.now.toString(36)}-${hashText(
    `${params.sessionPath}:${params.fieldEventId}:${params.label}:${params.now}:${params.sequence}:${params.note ?? ''}`,
  )}`;
}

function clampDelta(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}

function sourceHostKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function incrementCalibrationLabelCount(
  counts: Partial<Record<AoiProactiveBriefCalibrationLabel, number>>,
  label: AoiProactiveBriefCalibrationLabel,
): void {
  counts[label] = (counts[label] ?? 0) + 1;
}

export function buildAoiProactiveBriefCalibrationTuning(
  sessionPath: string,
  labels: AoiProactiveBriefCalibrationLabelRecord[],
  now = Date.now(),
): AoiProactiveBriefCalibrationTuning {
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const scopedLabels = labels
    .filter((item) => item.sessionPath === normalizedSessionPath)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const labelDistribution = emptyCalibrationLabelDistribution();
  const topicTuning: AoiProactiveBriefCalibrationTuning['topicTuning'] = {};
  const sourceTuning: AoiProactiveBriefCalibrationTuning['sourceTuning'] = {};

  for (const label of scopedLabels) {
    labelDistribution[label.label] += 1;
    if (label.topicId) {
      const current =
        topicTuning[label.topicId] ??
        ({
          version: 1,
          topicId: label.topicId,
          labelCounts: {},
          scoreDelta: 0,
          confidenceDelta: 0,
          sourcePreferenceDelta: 0,
          chatHookThresholdDelta: 0,
          cooldownMs: 0,
          directChatBlocked: false,
          preferDigestOrDashboard: false,
          muted: false,
          pinned: false,
          conservativeReasons: [],
          evidenceRefs: [],
          updatedAt: 0,
        } satisfies AoiProactiveBriefCalibrationTuning['topicTuning'][string]);
      incrementCalibrationLabelCount(current.labelCounts, label.label);
      current.evidenceRefs = [
        ...new Set([
          ...current.evidenceRefs,
          `proactive-brief-calibration:${label.id}`,
          ...label.evidenceRefs,
        ]),
      ].slice(0, 24);
      current.updatedAt = Math.max(current.updatedAt, label.createdAt);
      if (label.label === 'useful' || label.label === 'show_more') {
        current.scoreDelta += 0.08;
        current.confidenceDelta += 0.04;
        current.sourcePreferenceDelta += 0.06;
      }
      if (label.label === 'pin_topic') {
        current.scoreDelta += 0.1;
        current.confidenceDelta += 0.04;
        current.pinned = true;
        current.muted = false;
        current.conservativeReasons = current.conservativeReasons.filter(
          (reason) => reason !== 'muted',
        );
        current.directChatBlocked = current.conservativeReasons.some(
          (reason) => reason === 'wrong_timing' || reason === 'stale' || reason === 'unsafe',
        );
      }
      if (label.label === 'show_less') {
        current.scoreDelta -= 0.1;
        current.chatHookThresholdDelta += 0.06;
      }
      if (label.label === 'too_frequent') {
        current.chatHookThresholdDelta += 0.14;
        current.cooldownMs = Math.max(current.cooldownMs, TOO_FREQUENT_CALIBRATION_COOLDOWN_MS);
        current.preferDigestOrDashboard = true;
        current.conservativeReasons.push('too_frequent');
      }
      if (label.label === 'wrong_topic') {
        current.scoreDelta -= 0.18;
        current.confidenceDelta -= 0.16;
        current.sourcePreferenceDelta -= 0.08;
        current.conservativeReasons.push('wrong_topic');
      }
      if (label.label === 'wrong_source') {
        current.sourcePreferenceDelta -= 0.18;
        current.chatHookThresholdDelta += 0.12;
        current.preferDigestOrDashboard = true;
        current.conservativeReasons.push('wrong_source');
      }
      if (label.label === 'wrong_timing') {
        current.chatHookThresholdDelta += 0.18;
        current.preferDigestOrDashboard = true;
        current.directChatBlocked = true;
        current.conservativeReasons.push('wrong_timing');
      }
      if (label.label === 'stale') {
        current.scoreDelta -= 0.12;
        current.sourcePreferenceDelta -= 0.12;
        current.chatHookThresholdDelta += 0.2;
        current.cooldownMs = Math.max(current.cooldownMs, STALE_CALIBRATION_COOLDOWN_MS);
        current.directChatBlocked = true;
        current.preferDigestOrDashboard = true;
        current.conservativeReasons.push('stale');
      }
      if (label.label === 'unsafe') {
        current.scoreDelta -= 0.28;
        current.confidenceDelta -= 0.2;
        current.chatHookThresholdDelta += 0.28;
        current.cooldownMs = Math.max(current.cooldownMs, UNSAFE_CALIBRATION_COOLDOWN_MS);
        current.directChatBlocked = true;
        current.preferDigestOrDashboard = true;
        current.conservativeReasons.push('unsafe');
      }
      if (label.label === 'mute_topic') {
        current.muted = true;
        current.pinned = false;
        current.directChatBlocked = true;
        current.conservativeReasons.push('muted');
      }
      current.scoreDelta = clampDelta(current.scoreDelta, -0.6, 0.35);
      current.confidenceDelta = clampDelta(current.confidenceDelta, -0.5, 0.25);
      current.sourcePreferenceDelta = clampDelta(current.sourcePreferenceDelta, -0.5, 0.35);
      current.chatHookThresholdDelta = clampDelta(current.chatHookThresholdDelta, 0, 0.45);
      current.conservativeReasons = [...new Set(current.conservativeReasons)].slice(0, 12);
      topicTuning[label.topicId] = current;
    }

    for (const host of label.sourceHosts.map(sourceHostKey).filter(Boolean)) {
      const current =
        sourceTuning[host] ??
        ({
          version: 1,
          host,
          labelCounts: {},
          preferenceDelta: 0,
          directChatBlocked: false,
          staleBlocked: false,
          unsafeBlocked: false,
          evidenceRefs: [],
          updatedAt: 0,
        } satisfies AoiProactiveBriefCalibrationTuning['sourceTuning'][string]);
      incrementCalibrationLabelCount(current.labelCounts, label.label);
      current.evidenceRefs = [
        ...new Set([
          ...current.evidenceRefs,
          `proactive-brief-calibration:${label.id}`,
          ...label.evidenceRefs,
        ]),
      ].slice(0, 24);
      current.updatedAt = Math.max(current.updatedAt, label.createdAt);
      if (label.label === 'useful' || label.label === 'show_more' || label.label === 'pin_topic') {
        current.preferenceDelta += 0.08;
      }
      if (
        label.label === 'show_less' ||
        label.label === 'wrong_topic' ||
        label.label === 'wrong_source' ||
        label.label === 'wrong_timing' ||
        label.label === 'too_frequent'
      ) {
        current.preferenceDelta -= 0.06;
      }
      if (label.label === 'wrong_source') {
        current.preferenceDelta -= 0.18;
        current.directChatBlocked = true;
      }
      if (label.label === 'stale') {
        current.preferenceDelta -= 0.14;
        current.directChatBlocked = true;
        current.staleBlocked = true;
      }
      if (label.label === 'unsafe') {
        current.preferenceDelta -= 0.24;
        current.directChatBlocked = true;
        current.unsafeBlocked = true;
      }
      if (label.label === 'mute_topic') {
        current.directChatBlocked = true;
      }
      if (label.label === 'pin_topic' && !current.staleBlocked && !current.unsafeBlocked) {
        current.directChatBlocked = false;
      }
      current.preferenceDelta = clampDelta(current.preferenceDelta, -0.6, 0.35);
      sourceTuning[host] = current;
    }
  }

  const labelCount = scopedLabels.length;
  const unsafeLabelCount = labelDistribution.unsafe;
  const staleLabelCount = labelDistribution.stale;
  const status = unsafeLabelCount > 0 ? 'blocked' : labelCount > 0 ? 'tuning_active' : 'no_labels';
  const directChatBlockedTopics = Object.values(topicTuning).filter(
    (item) => item.directChatBlocked || item.muted,
  ).length;
  const directChatBlockedSources = Object.values(sourceTuning).filter(
    (item) => item.directChatBlocked,
  ).length;
  const summaryLabels = [
    labelCount > 0
      ? `${labelCount} calibration label${labelCount === 1 ? '' : 's'} applied`
      : 'No proactive brief calibration labels yet',
    directChatBlockedTopics > 0
      ? `${directChatBlockedTopics} topic${directChatBlockedTopics === 1 ? '' : 's'} tighten direct chat`
      : '',
    directChatBlockedSources > 0
      ? `${directChatBlockedSources} source${directChatBlockedSources === 1 ? '' : 's'} tighten direct chat`
      : '',
    staleLabelCount > 0 ? `${staleLabelCount} stale label${staleLabelCount === 1 ? '' : 's'}` : '',
    unsafeLabelCount > 0
      ? `${unsafeLabelCount} unsafe label${unsafeLabelCount === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean);
  const evidenceRefs = [
    ...new Set(
      scopedLabels.flatMap((label) => [
        `proactive-brief-calibration:${label.id}`,
        ...label.evidenceRefs,
      ]),
    ),
  ].slice(0, 24);

  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    generatedAt: now,
    status,
    labelCount,
    labelDistribution,
    unsafeLabelCount,
    staleLabelCount,
    tooFrequentLabelCount: labelDistribution.too_frequent,
    wrongTimingLabelCount: labelDistribution.wrong_timing,
    mutedTopicCount: Object.values(topicTuning).filter((item) => item.muted).length,
    pinnedTopicCount: Object.values(topicTuning).filter((item) => item.pinned).length,
    topicTuning,
    sourceTuning,
    summaryLabels,
    evidenceRefs,
  };
}

function saveAoiProactiveBriefCalibrationTuning(
  sessionsDir: string,
  sessionPath: string,
  tuning: AoiProactiveBriefCalibrationTuning,
): AoiProactiveBriefCalibrationTuning {
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  writeJsonAtomic(paths.root, paths.calibrationTuning, tuning);
  return tuning;
}

export function loadAoiProactiveBriefCalibrationTuning(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveBriefCalibrationTuning {
  return buildAoiProactiveBriefCalibrationTuning(
    sessionPath,
    loadAoiProactiveBriefCalibrationLabels(sessionsDir, sessionPath, now),
    now,
  );
}

export function recordAoiProactiveBriefCalibrationLabel(
  sessionsDir: string,
  input: AoiProactiveBriefCalibrationLabelInput,
): AoiProactiveBriefCalibrationLabelRecord {
  const now = input.now ?? Date.now();
  const sessionPath = resolveSessionPath(input.sessionPath);
  if (!isCalibrationLabel(input.label)) {
    throw new Error('Unsupported proactive brief calibration label.');
  }
  const fieldEvent = loadFieldEventById(sessionsDir, sessionPath, input.fieldEventId, now);
  if (!fieldEvent) {
    throw new Error('Proactive brief field event was not found.');
  }
  const paths = resolveAoiProactiveBriefPaths(sessionsDir, sessionPath);
  const index = loadAoiProactiveBriefCalibrationLabelIndex(sessionsDir, sessionPath, now);
  const rawRecord = {
    version: 1,
    id: createCalibrationLabelId({
      sessionPath,
      fieldEventId: fieldEvent.id,
      label: input.label,
      now,
      sequence: index.entries.length + 1,
      note: input.note,
    }),
    sessionPath,
    fieldEventId: fieldEvent.id,
    briefId: fieldEvent.briefId,
    topicId: fieldEvent.topicId,
    label: input.label,
    actor: input.actor ?? 'user',
    note: input.note,
    deliveryMode: fieldEvent.deliveryMode,
    policyReason: fieldEvent.policyReason,
    sourceRefs: fieldEvent.sourceRefs,
    sourceHosts: fieldEvent.sourceHosts,
    evidenceRefs: [
      `proactive-brief-field-event:${fieldEvent.id}`,
      ...fieldEvent.evidenceRefs,
      ...(input.evidenceRefs ?? []),
    ],
    createdAt: now,
  };
  const record = normalizeAoiProactiveBriefCalibrationLabelRecord(rawRecord, sessionPath, now);
  if (!record) {
    throw new Error('Invalid proactive brief calibration label.');
  }
  writeJsonAtomic(paths.root, join(paths.calibrationLabelRecordsDir, `${record.id}.json`), record);
  const nextIndex = saveAoiProactiveBriefCalibrationLabelIndex(sessionsDir, sessionPath, {
    version: 1,
    sessionPath,
    updatedAt: now,
    entries: [calibrationLabelIndexEntry(record), ...index.entries],
  });
  const indexedLabels = nextIndex.entries
    .map((entry) => loadCalibrationLabelById(sessionsDir, sessionPath, entry.id, now))
    .filter((item): item is AoiProactiveBriefCalibrationLabelRecord => item !== null);
  saveAoiProactiveBriefCalibrationTuning(
    sessionsDir,
    sessionPath,
    buildAoiProactiveBriefCalibrationTuning(sessionPath, indexedLabels, now),
  );
  return record;
}

function labelsForFieldEvent(
  labels: AoiProactiveBriefCalibrationLabelRecord[],
  fieldEventId: string,
): AoiProactiveBriefCalibrationLabelRecord[] {
  return labels
    .filter((label) => label.fieldEventId === fieldEventId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function isCalibrationReviewableEvent(event: AoiProactiveBriefFieldEvent): boolean {
  if (event.kind === 'candidate_created') {
    return false;
  }
  if (event.kind === 'feedback_recorded') {
    return Boolean(event.feedbackCategory && isCalibrationLabel(event.feedbackCategory));
  }
  return (
    event.kind === 'shown_dashboard' ||
    event.kind === 'shown_digest' ||
    event.kind === 'shown_inline' ||
    event.kind === 'chat_hook_offered' ||
    event.kind === 'expanded' ||
    event.kind === 'source_opened' ||
    event.kind.startsWith('suppressed_') ||
    event.kind === 'expired' ||
    event.kind === 'archived'
  );
}

function sourceFreshnessLabel(event: AoiProactiveBriefFieldEvent): string {
  const searchedAt =
    typeof event.freshness.searchedAt === 'number'
      ? new Date(event.freshness.searchedAt).toISOString().slice(0, 16).replace('T', ' ')
      : 'unknown';
  const newest = event.freshness.newestSourceAt ?? 'unknown';
  return `${event.freshness.stale ? 'stale' : 'freshness tracked'}; searched ${searchedAt}; newest ${newest}`;
}

function suggestedCalibrationLabels(
  event: AoiProactiveBriefFieldEvent,
): AoiProactiveBriefCalibrationLabel[] {
  if (event.kind === 'suppressed_stale_source' || event.freshness.stale) {
    return ['stale', 'wrong_timing', 'show_less', 'unsafe'];
  }
  if (event.kind === 'suppressed_quiet_mode' || event.kind === 'suppressed_no_opt_in') {
    return ['wrong_timing', 'show_less', 'useful'];
  }
  if (event.kind === 'suppressed_cooldown' || event.kind === 'suppressed_budget') {
    return ['too_frequent', 'wrong_timing', 'show_less'];
  }
  if (event.kind === 'suppressed_no_topics') {
    return ['wrong_topic', 'show_less', 'mute_topic'];
  }
  if (event.kind === 'feedback_recorded' && event.feedbackCategory) {
    return [event.feedbackCategory as AoiProactiveBriefCalibrationLabel].filter(isCalibrationLabel);
  }
  return [
    'useful',
    'show_more',
    'show_less',
    'too_frequent',
    'wrong_topic',
    'wrong_source',
    'wrong_timing',
  ];
}

function makeCalibrationInboxItem(
  event: AoiProactiveBriefFieldEvent,
  labels: AoiProactiveBriefCalibrationLabelRecord[],
): AoiProactiveBriefCalibrationInboxItem {
  const latest = labels[labels.length - 1];
  const labelState = labels.some((label) => label.label === 'unsafe')
    ? 'unsafe_flagged'
    : labels.length > 0
      ? 'labeled'
      : 'unlabeled';
  const whyNow = normalizeRequiredText(
    event.policyReason || event.suppressionReasons.join(', ') || event.kind.replace(/_/g, ' '),
    event.kind.replace(/_/g, ' '),
    220,
  );
  const whyRelevant = normalizeRequiredText(
    event.summary || event.title || event.briefId || 'No compact explanation attached.',
    'No compact explanation attached.',
    260,
  );
  const evidenceRefs = [
    ...new Set([
      `proactive-brief-field-event:${event.id}`,
      ...event.evidenceRefs,
      ...labels.flatMap((label) => [
        `proactive-brief-calibration:${label.id}`,
        ...label.evidenceRefs,
      ]),
    ]),
  ].slice(0, 24);
  return {
    version: 1,
    id: `aoi-brief-calibration-item-${hashText(event.id)}`,
    sessionPath: event.sessionPath,
    fieldEventId: event.id,
    fieldEventKind: event.kind,
    fieldEventAt: event.createdAt,
    ...(event.briefId ? { briefId: event.briefId } : {}),
    ...(event.topicId ? { topicId: event.topicId } : {}),
    ...(event.deliveryMode ? { deliveryMode: event.deliveryMode } : {}),
    title: normalizeRequiredText(event.title, event.kind.replace(/_/g, ' '), 160),
    whyNow,
    whyRelevant,
    sourceFreshness: sourceFreshnessLabel(event),
    cannotKnowLabels: event.freshness.cannotKnow,
    sourceRefs: event.sourceRefs,
    sourceHosts: event.sourceHosts,
    ...(event.policyReason ? { policyReason: event.policyReason } : {}),
    labels,
    labelState,
    ...(latest ? { latestLabel: latest.label, latestLabelAt: latest.createdAt } : {}),
    suggestedLabels: suggestedCalibrationLabels(event),
    priorityScore:
      (labelState === 'unlabeled' ? 100 : labelState === 'unsafe_flagged' ? 70 : 20) +
      (event.kind.startsWith('suppressed_') ? 18 : 0) +
      (event.freshness.stale ? 16 : 0),
    evidenceRefs,
  };
}

export function buildAoiProactiveBriefCalibrationInbox(
  sessionPath: string,
  events: AoiProactiveBriefFieldEvent[],
  labels: AoiProactiveBriefCalibrationLabelRecord[],
  now = Date.now(),
  limit = MAX_PROACTIVE_BRIEF_CALIBRATION_INBOX_ITEMS,
): AoiProactiveBriefCalibrationInbox {
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const items = events
    .filter(
      (event) => event.sessionPath === normalizedSessionPath && isCalibrationReviewableEvent(event),
    )
    .map((event) => makeCalibrationInboxItem(event, labelsForFieldEvent(labels, event.id)))
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        right.fieldEventAt - left.fieldEventAt ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(1, Math.min(limit, MAX_PROACTIVE_BRIEF_CALIBRATION_INBOX_ITEMS)));
  const matchedLabels = items.flatMap((item) => item.labels);
  const evidenceRefs = [
    ...new Set([
      ...items.flatMap((item) => item.evidenceRefs),
      ...matchedLabels.flatMap((label) => label.evidenceRefs),
    ]),
  ].slice(0, 24);
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    generatedAt: now,
    inboxCount: items.length,
    unlabeledCount: items.filter((item) => item.labelState === 'unlabeled').length,
    labeledCount: items.filter((item) => item.labelState !== 'unlabeled').length,
    labelCount: matchedLabels.length,
    unsafeLabelCount: matchedLabels.filter((label) => label.label === 'unsafe').length,
    staleLabelCount: matchedLabels.filter((label) => label.label === 'stale').length,
    items,
    evidenceRefs,
  };
}

export function loadAoiProactiveBriefCalibrationInbox(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_PROACTIVE_BRIEF_CALIBRATION_INBOX_ITEMS,
): AoiProactiveBriefCalibrationInbox {
  return buildAoiProactiveBriefCalibrationInbox(
    sessionPath,
    loadAoiProactiveBriefFieldEvents(sessionsDir, sessionPath, now),
    loadAoiProactiveBriefCalibrationLabels(sessionsDir, sessionPath, now),
    now,
    limit,
  );
}

function calibrationTargetEventForFeedback(
  sessionsDir: string,
  feedback: AoiProactiveBriefFeedback,
): AoiProactiveBriefFieldEvent | null {
  const events = loadAoiProactiveBriefFieldEvents(
    sessionsDir,
    feedback.sessionPath,
    feedback.createdAt,
  ).filter((event) => event.briefId === feedback.briefId && event.createdAt <= feedback.createdAt);
  const preferred = events.find(
    (event) =>
      event.kind !== 'feedback_recorded' &&
      (event.kind.startsWith('shown_') ||
        event.kind.startsWith('suppressed_') ||
        event.kind === 'expanded' ||
        event.kind === 'source_opened' ||
        event.kind === 'archived' ||
        event.kind === 'expired'),
  );
  if (preferred) {
    return preferred;
  }
  return (
    events.find(
      (event) => event.kind === 'feedback_recorded' && event.feedbackId === feedback.id,
    ) ??
    events[0] ??
    null
  );
}

function recordCalibrationLabelForFeedback(
  sessionsDir: string,
  feedback: AoiProactiveBriefFeedback,
): AoiProactiveBriefCalibrationLabelRecord | null {
  if (!isCalibrationLabel(feedback.category)) {
    return null;
  }
  const targetEvent = calibrationTargetEventForFeedback(sessionsDir, feedback);
  if (!targetEvent) {
    return null;
  }
  return recordAoiProactiveBriefCalibrationLabel(sessionsDir, {
    sessionPath: feedback.sessionPath,
    fieldEventId: targetEvent.id,
    label: feedback.category,
    note: feedback.note,
    evidenceRefs: [`feedback:${feedback.id}`],
    now: feedback.createdAt,
  });
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

function proactiveFieldEventDedupeFingerprint(event: AoiProactiveBriefFieldEvent): string {
  return hashText(
    JSON.stringify([
      event.kind,
      event.briefId ?? '',
      event.topicId ?? '',
      event.feedbackId ?? '',
      event.deliveryMode ?? '',
      event.dedupeKey ?? '',
      [...event.sourceRefs].sort(),
      [...event.evidenceRefs].sort(),
    ]),
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
  const eventFingerprint = proactiveFieldEventDedupeFingerprint(event);
  const existingEvent = dedupeKey
    ? index.entries
        .filter(
          (entry) =>
            entry.dedupeKey === dedupeKey &&
            entry.kind === event.kind &&
            Math.abs(entry.createdAt - event.createdAt) <=
              AOI_PROACTIVE_FIELD_EVENT_DEDUPE_WINDOW_MS,
        )
        .map((entry) => loadFieldEventById(sessionsDir, sessionPath, entry.id, now))
        .find(
          (candidate): candidate is AoiProactiveBriefFieldEvent =>
            candidate !== null &&
            proactiveFieldEventDedupeFingerprint(candidate) === eventFingerprint,
        )
    : undefined;
  if (existingEvent) {
    return existingEvent;
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

function directChatSuppressionReasonsForShownMode(
  mode: AoiProactiveBriefDeliveryMode | null,
  decision: AoiProactiveBriefDeliveryDecision,
): string[] {
  if (!mode || mode === 'chat_hook' || decision.chatHook.allowed) {
    return [];
  }
  return [
    ...new Set(
      decision.chatHook.reasons.filter(
        (reason) =>
          reason === 'chat_hook_not_opted_in' ||
          reason === 'quiet_mode_suppresses_chat_hook' ||
          reason === 'chat_hook_mode_not_allowed' ||
          reason === 'stale_source' ||
          reason === 'topic_cooldown_active' ||
          reason === 'global_cooldown_active' ||
          reason === 'recent_negative_feedback' ||
          reason === 'calibration_stale_direct_chat_block' ||
          reason === 'calibration_unsafe_direct_chat_block' ||
          reason === 'calibration_timing_prefers_digest',
      ),
    ),
  ];
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
    const directChatSuppressionReasons = directChatSuppressionReasonsForShownMode(mode, decision);
    const policyReason = mode
      ? directChatSuppressionReasons.length > 0
        ? `${mode}_allowed; direct_chat_suppressed:${directChatSuppressionReasons.join(',')}`
        : `${mode}_allowed`
      : reasons[0];
    events.push(
      recordAoiProactiveBriefFieldEvent(input.sessionsDir, {
        ...candidateFieldEventInput(candidate, kind, now),
        deliveryMode: mode ?? undefined,
        policyReason,
        suppressionReasons: mode ? directChatSuppressionReasons : reasons,
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
  recordCalibrationLabelForFeedback(sessionsDir, normalized);
  try {
    appendAoiFollowThroughEvent(
      sessionsDir,
      buildAoiFollowThroughEventFromProactiveBriefFeedback(normalized, normalized.createdAt),
      normalized.createdAt,
    );
  } catch {
    // Follow-through learning must not block explicit proactive feedback recording.
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
