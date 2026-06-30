import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { isIP } from 'net';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { redactAoiSensitiveContent } from './aoiMemoryShared';
import {
  appendAoiFollowThroughEvent,
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { buildAoiFollowThroughEventFromTrendDelivery } from './aoiFollowThroughLearning';
import type {
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiOperatorHealthCapability,
  AoiOperatorHealthSeverity,
  AoiProactiveBriefCalibrationTuning,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefFieldMetrics,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefSource,
  AoiProactiveTrendAdvisorReadiness,
  AoiProactiveTrendAdvisorState,
  AoiProactiveTrendDeliveryAuditSummary,
  AoiProactiveTrendDeliveryMode,
  AoiProactiveTrendDeliveryControls,
  AoiProactiveTrendDeliveryEvent,
  AoiProactiveTrendDeliveryEventIndex,
  AoiProactiveTrendDeliveryEventIndexEntry,
  AoiProactiveTrendDeliveryEventKind,
  AoiProactiveTrendInterestDrift,
  AoiProactiveTrendInterestDriftStatus,
  AoiProactiveTrendNovelty,
  AoiProactiveTrendNoveltyStatus,
  AoiProactiveTrendOpinionCard,
  AoiProactiveTrendSnapshot,
  AoiProactiveTrendSnapshotFreshness,
  AoiProactiveTrendSnapshotIndex,
  AoiProactiveTrendSnapshotIndexEntry,
  AoiProactiveTrendSourceQuality,
  AoiProactiveTrendSourceQualityStatus,
  AoiProactiveTrendWatchCadence,
  AoiProactiveTrendWatchProfile,
  AoiProactiveTrendWatchTopic,
} from './aoiAutonomyTypes';
import type {
  AoiProactiveBriefDiagnostic,
  AoiProactiveBriefDiagnosticCode,
} from './aoiProactiveBriefReplay';

const MAX_WATCH_TOPICS = 32;
const MAX_WATCH_QUERIES = 6;
const MAX_TREND_SNAPSHOT_INDEX_ITEMS = 120;
const MAX_TREND_DELIVERY_EVENT_INDEX_ITEMS = 240;
const MAX_TREND_STATE_SNAPSHOTS = 24;
const MAX_TREND_STATE_DELIVERY_EVENTS = 12;
const MAX_TREND_OPINION_CARDS = 6;
const DEFAULT_TREND_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_DIRECT_CHAT_FIELD_SAMPLE_COUNT = 3;
const RECENT_TREND_REPEAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TREND_DELIVERY_EVENT_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;

export interface AoiProactiveTrendPaths {
  root: string;
  trendsDir: string;
  watchProfile: string;
  snapshotsDir: string;
  snapshotIndex: string;
  deliveryEventsDir: string;
  deliveryEventIndex: string;
  deliveryEventRecordsDir: string;
}

export interface BuildAoiProactiveTrendAdvisorStateInput {
  sessionsDir?: string;
  sessionPath: string;
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  candidates?: AoiProactiveBriefCandidate[];
  existingSnapshots?: AoiProactiveTrendSnapshot[];
  existingDeliveryEvents?: AoiProactiveTrendDeliveryEvent[];
  feedback?: AoiProactiveBriefFeedback[];
  fieldMetrics?: AoiProactiveBriefFieldMetrics | null;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  now?: number;
  persist?: boolean;
  sourceStaleAfterMs?: number;
  // P3-2a: when the per-day direct-chat budget is exhausted (decided server-side on the
  // background path), suppress the direct_chat delivery mode so a would-be direct chat
  // falls through to an inline card. Default/false -> unchanged (byte-identical) behavior.
  directChatBudgetExhausted?: boolean;
  // P3-2b: when a user-return lull relief was granted (decided server-side on the background
  // path: explicit opt-in + idle within the active window + P3-2a budget room), relax the
  // direct-chat confidence floor by a bounded delta. Default/false -> byte-identical behavior.
  directChatConfidenceFloorRelief?: boolean;
}

export interface BuildAoiProactiveTrendAdvisorDiagnosticsInput {
  state?: AoiProactiveTrendAdvisorState | null;
  tavilyConfigured?: boolean;
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
    throw new Error('Resolved proactive trend path escaped the autonomy root.');
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return normalizeWhitespace(
    redactAoiSensitiveContent(value)
      .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
      .replace(
        /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g,
        '[redacted-path]',
      ),
  ).slice(0, maxChars);
}

function normalizeStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = sanitizeText(item, maxChars);
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

function clampScore(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, Number(value.toFixed(3))));
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function makeStableId(prefix: string, seed: string): string {
  return `${prefix}-${stableHash(seed)}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function resolveSessionPath(value: string): string {
  const sessionPath = normalizeAoiAutonomySessionPath(value);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return sessionPath;
}

export function resolveAoiProactiveTrendPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiProactiveTrendPaths {
  const normalizedSessionPath = resolveSessionPath(sessionPath);
  const autonomyPaths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const paths: AoiProactiveTrendPaths = {
    root: autonomyPaths.root,
    trendsDir: autonomyPaths.proactiveTrendsDir,
    watchProfile: autonomyPaths.proactiveTrendWatchProfile,
    snapshotsDir: autonomyPaths.proactiveTrendSnapshotsDir,
    snapshotIndex: autonomyPaths.proactiveTrendSnapshotIndex,
    deliveryEventsDir: autonomyPaths.proactiveTrendDeliveryEventsDir,
    deliveryEventIndex: autonomyPaths.proactiveTrendDeliveryEventIndex,
    deliveryEventRecordsDir: autonomyPaths.proactiveTrendDeliveryEventRecordsDir,
  };
  for (const target of [
    paths.trendsDir,
    paths.watchProfile,
    paths.snapshotsDir,
    paths.snapshotIndex,
    paths.deliveryEventsDir,
    paths.deliveryEventIndex,
    paths.deliveryEventRecordsDir,
  ]) {
    if (!isPathInsideRoot(paths.root, target)) {
      throw new Error('Resolved proactive trend path escaped the autonomy root.');
    }
  }
  return paths;
}

function normalizeHost(value: unknown): string | null {
  const normalized = sanitizeText(value, 120)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    ?.replace(/[^a-z0-9.-]/g, '');
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 100);
}

function normalizeUrlSource(value: unknown, now: number): AoiProactiveBriefSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveBriefSource>;
  const urlText = sanitizeText(raw.url, 500);
  if (!urlText) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.password) {
    return null;
  }
  const host = normalizeHost(parsed.hostname || parsed.host);
  if (!host) {
    return null;
  }
  const publishedAt = sanitizeText(raw.publishedAt, 64);
  return {
    title: sanitizeText(raw.title, 160) || host,
    url: parsed.toString(),
    host,
    ...(publishedAt ? { publishedAt } : {}),
    retrievedAt: normalizeTimestamp(raw.retrievedAt, now),
    snippet: sanitizeText(raw.snippet, 500),
  };
}

function normalizeSources(value: unknown, now: number): AoiProactiveBriefSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byUrl = new Map<string, AoiProactiveBriefSource>();
  for (const item of value) {
    const source = normalizeUrlSource(item, now);
    if (!source) {
      continue;
    }
    byUrl.set(source.url.toLowerCase(), source);
    if (byUrl.size >= 12) {
      break;
    }
  }
  return [...byUrl.values()];
}

function normalizeRisk(value: unknown): AoiAutonomyRisk {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'low';
}

function normalizeFreshness(value: unknown): AoiProactiveTrendSnapshotFreshness {
  if (value === 'fresh' || value === 'unknown' || value === 'stale') {
    return value;
  }
  return 'unknown';
}

function normalizeNoveltyStatus(value: unknown): AoiProactiveTrendNoveltyStatus {
  if (value === 'new' || value === 'repeat' || value === 'weak' || value === 'stale') {
    return value;
  }
  return 'new';
}

function normalizeDeliveryMode(value: unknown): AoiProactiveTrendDeliveryMode {
  if (
    value === 'dashboard' ||
    value === 'quiet_notification' ||
    value === 'inline_card' ||
    value === 'direct_chat' ||
    value === 'blocked'
  ) {
    return value;
  }
  return 'dashboard';
}

export function isAoiProactiveTrendDeliveryEventKind(
  value: unknown,
): value is AoiProactiveTrendDeliveryEventKind {
  return (
    value === 'inline_card_shown' ||
    value === 'direct_chat_offered' ||
    value === 'delivery_suppressed'
  );
}

function normalizeDeliveryEventKind(value: unknown): AoiProactiveTrendDeliveryEventKind {
  return isAoiProactiveTrendDeliveryEventKind(value) ? value : 'delivery_suppressed';
}

function normalizeSourceQualityStatus(value: unknown): AoiProactiveTrendSourceQualityStatus {
  if (value === 'strong' || value === 'acceptable' || value === 'weak' || value === 'blocked') {
    return value;
  }
  return 'weak';
}

function normalizeInterestDriftStatus(value: unknown): AoiProactiveTrendInterestDriftStatus {
  if (value === 'aligned' || value === 'watch' || value === 'drifting' || value === 'muted') {
    return value;
  }
  return 'watch';
}

function normalizeNovelty(value: unknown, fallbackScore: number): AoiProactiveTrendNovelty {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiProactiveTrendNovelty>)
      : {};
  const status = normalizeNoveltyStatus(raw.status);
  return {
    version: 1,
    status,
    score: clampScore(raw.score, fallbackScore),
    reason:
      sanitizeText(raw.reason, 260) ||
      (status === 'new' ? 'No recent matching trend snapshot was found.' : 'Novelty was inferred.'),
    matchedSnapshotIds: normalizeStringList(raw.matchedSnapshotIds, 8, 120),
    sourceOverlapCount:
      typeof raw.sourceOverlapCount === 'number' && Number.isFinite(raw.sourceOverlapCount)
        ? Math.max(0, Math.round(raw.sourceOverlapCount))
        : 0,
  };
}

function normalizeSourceQuality(
  value: unknown,
  fallback: AoiProactiveTrendSourceQuality,
): AoiProactiveTrendSourceQuality {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  const raw = value as Partial<AoiProactiveTrendSourceQuality>;
  const status = normalizeSourceQualityStatus(raw.status);
  return {
    version: 1,
    status,
    score: clampScore(raw.score, fallback.score),
    independentHostCount:
      typeof raw.independentHostCount === 'number' && Number.isFinite(raw.independentHostCount)
        ? Math.max(0, Math.round(raw.independentHostCount))
        : fallback.independentHostCount,
    freshSourceCount:
      typeof raw.freshSourceCount === 'number' && Number.isFinite(raw.freshSourceCount)
        ? Math.max(0, Math.round(raw.freshSourceCount))
        : fallback.freshSourceCount,
    publicSourceCount:
      typeof raw.publicSourceCount === 'number' && Number.isFinite(raw.publicSourceCount)
        ? Math.max(0, Math.round(raw.publicSourceCount))
        : fallback.publicSourceCount,
    evidenceRefCount:
      typeof raw.evidenceRefCount === 'number' && Number.isFinite(raw.evidenceRefCount)
        ? Math.max(0, Math.round(raw.evidenceRefCount))
        : fallback.evidenceRefCount,
    reasons: normalizeStringList(raw.reasons, 8, 120),
    blockedReasons: normalizeStringList(raw.blockedReasons, 8, 120),
  };
}

function normalizeInterestDrift(value: unknown): AoiProactiveTrendInterestDrift {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      version: 1,
      status: 'watch',
      score: 0.5,
      positiveFeedbackCount: 0,
      negativeFeedbackCount: 0,
      reasons: ['legacy_snapshot_without_interest_drift'],
      evidenceRefs: [],
    };
  }
  const raw = value as Partial<AoiProactiveTrendInterestDrift>;
  return {
    version: 1,
    status: normalizeInterestDriftStatus(raw.status),
    score: clampScore(raw.score, 0.5),
    positiveFeedbackCount:
      typeof raw.positiveFeedbackCount === 'number' && Number.isFinite(raw.positiveFeedbackCount)
        ? Math.max(0, Math.round(raw.positiveFeedbackCount))
        : 0,
    negativeFeedbackCount:
      typeof raw.negativeFeedbackCount === 'number' && Number.isFinite(raw.negativeFeedbackCount)
        ? Math.max(0, Math.round(raw.negativeFeedbackCount))
        : 0,
    reasons: normalizeStringList(raw.reasons, 8, 120),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 12, 180),
  };
}

function normalizeDeliveryControls(
  value: unknown,
  fallbackDedupeKey: string,
  now: number,
): AoiProactiveTrendDeliveryControls {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      version: 1,
      dedupeKey: fallbackDedupeKey,
      duplicateBlocked: false,
      reasons: [],
      evidenceRefs: [`trend-control:${stableHash(fallbackDedupeKey)}`],
    };
  }
  const raw = value as Partial<AoiProactiveTrendDeliveryControls>;
  const dedupeKey = sanitizeText(raw.dedupeKey, 240) || fallbackDedupeKey;
  const quietUntil = normalizeTimestamp(raw.quietUntil, 0);
  const snoozedUntil = normalizeTimestamp(raw.snoozedUntil, 0);
  return {
    version: 1,
    dedupeKey,
    duplicateBlocked: raw.duplicateBlocked === true,
    ...(quietUntil > now ? { quietUntil } : {}),
    ...(snoozedUntil > now ? { snoozedUntil } : {}),
    reasons: normalizeStringList(raw.reasons, 12, 120),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 12, 180),
  };
}

function topicCadence(topic: AoiInterestTopic): AoiProactiveTrendWatchCadence {
  if (topic.currentInfoPreference >= 0.78 || topic.pinned) {
    return 'daily';
  }
  if (topic.currentInfoPreference >= 0.45) {
    return 'weekly';
  }
  return 'manual';
}

function trendQueryTerms(topic: AoiInterestTopic): string[] {
  const seeds = unique([
    topic.label,
    ...topic.aliases,
    `${topic.label} latest research`,
    `${topic.label} security trend`,
    `${topic.label} technical writeup`,
    `${topic.label} case study`,
  ]);
  return seeds
    .map((item) => sanitizeText(item, 120))
    .filter(Boolean)
    .slice(0, MAX_WATCH_QUERIES);
}

function watchFromTopic(topic: AoiInterestTopic, now: number): AoiProactiveTrendWatchTopic {
  const normalizedLabel = sanitizeText(topic.normalizedLabel || topic.label, 120).toLowerCase();
  const evidenceRefs = unique([
    `interest-topic:${topic.id}`,
    ...topic.evidenceRefs.map((ref) => sanitizeText(ref, 180)).filter(Boolean),
  ]).slice(0, 12);
  return {
    version: 1,
    id: makeStableId('aoi-trend-watch', `${topic.sessionPath}:${topic.id}:${normalizedLabel}`),
    topicId: topic.id,
    topicLabel: sanitizeText(topic.label, 80) || 'Interest topic',
    normalizedLabel: normalizedLabel || sanitizeText(topic.label, 120).toLowerCase(),
    aliases: normalizeStringList(topic.aliases, 12, 80),
    watchQueries: trendQueryTerms(topic),
    preferredSourceHosts: [],
    cadence: topicCadence(topic),
    noveltyThreshold: clampScore(0.75 - topic.noveltyPreference * 0.35, 0.5),
    directChatSensitivity: clampScore(
      (topic.importance + topic.confidence + topic.currentInfoPreference) / 3,
      0.5,
    ),
    muted: topic.muted,
    pinned: topic.pinned,
    confidence: clampScore(topic.confidence, 0.55),
    evidenceRefs,
    createdAt: normalizeTimestamp(topic.createdAt, now),
    updatedAt: normalizeTimestamp(topic.updatedAt, now),
  };
}

function feedbackForWatchTopic(
  feedback: AoiProactiveBriefFeedback[],
  topicId: string,
  now: number,
): AoiProactiveBriefFeedback[] {
  const threshold = now - 30 * 24 * 60 * 60 * 1000;
  return feedback.filter((item) => item.topicId === topicId && item.createdAt >= threshold);
}

function calibrateWatchFromFeedback(params: {
  watch: AoiProactiveTrendWatchTopic;
  feedback: AoiProactiveBriefFeedback[];
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  now: number;
}): AoiProactiveTrendWatchTopic {
  const topicFeedback = feedbackForWatchTopic(params.feedback, params.watch.topicId, params.now);
  const positiveCount = topicFeedback.filter(
    (item) =>
      item.category === 'useful' ||
      item.category === 'show_more' ||
      item.category === 'open_sources' ||
      item.category === 'expand_summary' ||
      item.category === 'pin_topic',
  ).length;
  const negativeCount = topicFeedback.filter(
    (item) =>
      item.category === 'not_useful' ||
      item.category === 'show_less' ||
      item.category === 'too_frequent' ||
      item.category === 'wrong_timing' ||
      item.category === 'wrong_topic' ||
      item.category === 'stale' ||
      item.category === 'unsafe' ||
      item.category === 'mute_topic' ||
      item.category === 'archive_brief',
  ).length;
  const tuning = params.calibrationTuning?.topicTuning[params.watch.topicId];
  const pinned =
    params.watch.pinned ||
    topicFeedback.some((item) => item.category === 'pin_topic') ||
    tuning?.pinned === true;
  const muted =
    params.watch.muted ||
    topicFeedback.some((item) => item.category === 'mute_topic') ||
    tuning?.muted === true ||
    tuning?.directChatBlocked === true;
  let cadence = params.watch.cadence;
  if (pinned || positiveCount >= Math.max(1, negativeCount + 1)) {
    cadence = 'daily';
  } else if (negativeCount > positiveCount && cadence === 'daily') {
    cadence = 'weekly';
  } else if (negativeCount >= positiveCount + 2) {
    cadence = 'manual';
  }
  return {
    ...params.watch,
    cadence,
    noveltyThreshold: clampScore(
      params.watch.noveltyThreshold +
        negativeCount * 0.08 -
        positiveCount * 0.04 +
        (tuning?.preferDigestOrDashboard ? 0.1 : 0),
      params.watch.noveltyThreshold,
    ),
    directChatSensitivity: clampScore(
      params.watch.directChatSensitivity +
        positiveCount * 0.06 -
        negativeCount * 0.1 -
        (tuning?.directChatBlocked ? 0.25 : 0),
      params.watch.directChatSensitivity,
    ),
    muted,
    pinned,
    evidenceRefs: unique([
      ...params.watch.evidenceRefs,
      ...topicFeedback.map((item) => `feedback:${item.id}`),
      ...(tuning?.evidenceRefs ?? []),
    ]).slice(0, 16),
    updatedAt: params.now,
  };
}

export function buildAoiProactiveTrendWatchProfile(params: {
  sessionPath: string;
  profile?: AoiInterestProfile | null;
  feedback?: AoiProactiveBriefFeedback[];
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  now?: number;
}): AoiProactiveTrendWatchProfile {
  const now = params.now ?? Date.now();
  const sessionPath = resolveSessionPath(params.sessionPath);
  const topics = (params.profile?.topics ?? [])
    .slice()
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.importance - left.importance ||
        right.currentInfoPreference - left.currentInfoPreference ||
        right.confidence - left.confidence ||
        left.normalizedLabel.localeCompare(right.normalizedLabel),
    )
    .slice(0, MAX_WATCH_TOPICS);
  const topicWatches = topics.map((topic) =>
    calibrateWatchFromFeedback({
      watch: watchFromTopic(topic, now),
      feedback: params.feedback ?? [],
      calibrationTuning: params.calibrationTuning,
      now,
    }),
  );
  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    sourceTopicCount: params.profile?.topics.length ?? 0,
    topicWatches,
    evidenceRefs: unique(topicWatches.flatMap((watch) => watch.evidenceRefs)).slice(0, 24),
  };
}

function normalizeWatchTopic(value: unknown, now: number): AoiProactiveTrendWatchTopic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveTrendWatchTopic>;
  if (!isValidAoiAutonomyId(raw.id) || !sanitizeText(raw.topicId, 120)) {
    return null;
  }
  const topicLabel = sanitizeText(raw.topicLabel, 80) || 'Interest topic';
  return {
    version: 1,
    id: raw.id,
    topicId: sanitizeText(raw.topicId, 120),
    topicLabel,
    normalizedLabel:
      sanitizeText(raw.normalizedLabel, 120).toLowerCase() || topicLabel.toLowerCase(),
    aliases: normalizeStringList(raw.aliases, 12, 80),
    watchQueries: normalizeStringList(raw.watchQueries, MAX_WATCH_QUERIES, 120),
    preferredSourceHosts: normalizeStringList(raw.preferredSourceHosts, 12, 120),
    cadence:
      raw.cadence === 'daily' || raw.cadence === 'weekly' || raw.cadence === 'manual'
        ? raw.cadence
        : 'weekly',
    noveltyThreshold: clampScore(raw.noveltyThreshold, 0.5),
    directChatSensitivity: clampScore(raw.directChatSensitivity, 0.5),
    muted: raw.muted === true,
    pinned: raw.pinned === true,
    confidence: clampScore(raw.confidence, 0.55),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 16, 180),
    createdAt: normalizeTimestamp(raw.createdAt, now),
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
  };
}

function normalizeWatchProfile(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiProactiveTrendWatchProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveTrendWatchProfile>;
  const normalizedSessionPath = resolveSessionPath(raw.sessionPath ?? sessionPath);
  const topicWatches = Array.isArray(raw.topicWatches)
    ? raw.topicWatches
        .map((watch) => normalizeWatchTopic(watch, now))
        .filter((watch): watch is AoiProactiveTrendWatchTopic => watch !== null)
        .slice(0, MAX_WATCH_TOPICS)
    : [];
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    generatedAt: normalizeTimestamp(raw.generatedAt, now),
    sourceTopicCount:
      typeof raw.sourceTopicCount === 'number' && Number.isFinite(raw.sourceTopicCount)
        ? Math.max(0, Math.round(raw.sourceTopicCount))
        : topicWatches.length,
    topicWatches,
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24, 180),
  };
}

export function saveAoiProactiveTrendWatchProfile(
  sessionsDir: string,
  sessionPath: string,
  profile: AoiProactiveTrendWatchProfile,
): AoiProactiveTrendWatchProfile {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  const normalized = normalizeWatchProfile(profile, sessionPath, profile.generatedAt) ?? profile;
  writeJsonAtomic(paths.root, paths.watchProfile, normalized);
  return normalized;
}

export function loadAoiProactiveTrendWatchProfile(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveTrendWatchProfile | null {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  return normalizeWatchProfile(readJson<unknown>(paths.watchProfile), sessionPath, now);
}

function newestSourceTime(candidate: AoiProactiveBriefCandidate): number | null {
  const values = [
    candidate.freshness.newestSourceAt,
    ...candidate.sources.map((source) => source.publishedAt),
  ].filter((value): value is string => Boolean(value));
  let newest = 0;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      newest = Math.max(newest, parsed);
    }
  }
  return newest > 0 ? newest : null;
}

function candidateFreshness(
  candidate: AoiProactiveBriefCandidate,
  now: number,
  staleAfterMs: number,
): AoiProactiveTrendSnapshotFreshness {
  if (candidate.freshness.cannotKnow.some((item) => /stale|freshness window/i.test(item))) {
    return 'stale';
  }
  const newest = newestSourceTime(candidate);
  if (!newest) {
    return 'unknown';
  }
  return now - newest > staleAfterMs ? 'stale' : 'fresh';
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function ipv4InRange(ip: string, base: string, prefixBits: number): boolean {
  const value = ipv4ToNumber(ip);
  const baseValue = ipv4ToNumber(base);
  if (value === null || baseValue === null) {
    return false;
  }
  const size = 2 ** (32 - prefixBits);
  return value >= baseValue && value < baseValue + size;
}

function isPrivateOrLocalHost(host: string): boolean {
  const normalized = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  const ipKind = isIP(normalized);
  if (ipKind === 4) {
    return (
      ipv4InRange(normalized, '0.0.0.0', 8) ||
      ipv4InRange(normalized, '10.0.0.0', 8) ||
      ipv4InRange(normalized, '100.64.0.0', 10) ||
      ipv4InRange(normalized, '127.0.0.0', 8) ||
      ipv4InRange(normalized, '169.254.0.0', 16) ||
      ipv4InRange(normalized, '172.16.0.0', 12) ||
      ipv4InRange(normalized, '192.168.0.0', 16) ||
      ipv4InRange(normalized, '198.18.0.0', 15) ||
      ipv4InRange(normalized, '224.0.0.0', 4) ||
      ipv4InRange(normalized, '240.0.0.0', 4)
    );
  }
  if (ipKind === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      (normalized.startsWith('::ffff:') && isPrivateOrLocalHost(normalized.slice('::ffff:'.length)))
    );
  }
  return false;
}

function sourceTime(source: AoiProactiveBriefSource): number | null {
  if (source.publishedAt) {
    const parsed = Date.parse(source.publishedAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return typeof source.retrievedAt === 'number' && Number.isFinite(source.retrievedAt)
    ? source.retrievedAt
    : null;
}

function buildSourceQuality(params: {
  sources: AoiProactiveBriefSource[];
  evidenceRefs: string[];
  freshness: AoiProactiveTrendSnapshotFreshness;
  now: number;
  staleAfterMs: number;
}): AoiProactiveTrendSourceQuality {
  const publicSources = params.sources.filter((source) => !isPrivateOrLocalHost(source.host));
  const independentHostCount = unique(publicSources.map((source) => source.host)).length;
  const freshSourceCount = publicSources.filter((source) => {
    const time = sourceTime(source);
    return time !== null && params.now - time <= params.staleAfterMs;
  }).length;
  const evidenceRefCount = params.evidenceRefs.length;
  const sourceShapeCount = publicSources.filter(
    (source) => sanitizeText(source.title, 120) && sanitizeText(source.snippet, 120),
  ).length;
  const publicRatio = params.sources.length > 0 ? publicSources.length / params.sources.length : 0;
  const hostScore =
    independentHostCount >= 3
      ? 1
      : independentHostCount >= 2
        ? 0.86
        : independentHostCount === 1
          ? 0.38
          : 0;
  const freshnessScore = publicSources.length > 0 ? freshSourceCount / publicSources.length : 0;
  const evidenceScore = Math.min(1, evidenceRefCount / 3);
  const shapeScore = publicSources.length > 0 ? sourceShapeCount / publicSources.length : 0;
  const stalePenalty =
    params.freshness === 'stale' ? 0.22 : params.freshness === 'unknown' ? 0.08 : 0;
  const score = clampScore(
    hostScore * 0.38 +
      freshnessScore * 0.24 +
      evidenceScore * 0.22 +
      shapeScore * 0.1 +
      publicRatio * 0.06 -
      stalePenalty,
    0,
  );
  const reasons: string[] = [];
  const blockedReasons: string[] = [];
  if (publicSources.length === 0) {
    blockedReasons.push('no_public_sources');
  }
  if (evidenceRefCount === 0) {
    blockedReasons.push('missing_evidence_refs');
  }
  if (independentHostCount < 2) {
    reasons.push('single_independent_host');
  }
  if (freshSourceCount < Math.min(2, publicSources.length)) {
    reasons.push('fresh_source_coverage_low');
  }
  if (params.freshness === 'stale') {
    reasons.push('stale_source_window');
  }
  if (evidenceRefCount < 2) {
    reasons.push('low_evidence_ref_count');
  }
  let status: AoiProactiveTrendSourceQualityStatus = 'strong';
  if (blockedReasons.length > 0) {
    status = 'blocked';
  } else if (score < 0.62 || independentHostCount < 2) {
    status = 'weak';
  } else if (score < 0.82) {
    status = 'acceptable';
  }
  return {
    version: 1,
    status,
    score,
    independentHostCount,
    freshSourceCount,
    publicSourceCount: publicSources.length,
    evidenceRefCount,
    reasons: unique(reasons).slice(0, 8),
    blockedReasons: unique(blockedReasons).slice(0, 8),
  };
}

function sourceEvidenceStrong(sourceQuality: AoiProactiveTrendSourceQuality): boolean {
  return sourceQuality.status === 'strong';
}

function trendDedupeKey(params: {
  candidate: AoiProactiveBriefCandidate;
  sources: AoiProactiveBriefSource[];
  topicId: string;
}): string {
  const explicit = sanitizeText(params.candidate.dedupeKey, 240);
  if (explicit) {
    return explicit;
  }
  const urls = params.sources
    .map((source) => source.url.toLowerCase())
    .sort()
    .join('|');
  return `trend:${params.topicId}:${stableHash(
    `${normalizedTrendTitle(params.candidate.title)}:${urls}`,
  )}`;
}

function matchingDedupeSnapshots(params: {
  existingSnapshots: AoiProactiveTrendSnapshot[];
  topicId: string;
  dedupeKey: string;
  now: number;
}): AoiProactiveTrendSnapshot[] {
  return params.existingSnapshots.filter((snapshot) => {
    if (
      snapshot.topicId !== params.topicId ||
      snapshot.expiresAt <= params.now ||
      params.now - snapshot.updatedAt > RECENT_TREND_REPEAT_WINDOW_MS
    ) {
      return false;
    }
    return snapshot.delivery.controls?.dedupeKey === params.dedupeKey;
  });
}

function matchingDeliveryEvents(params: {
  existingDeliveryEvents: AoiProactiveTrendDeliveryEvent[];
  dedupeKey: string;
  now: number;
}): AoiProactiveTrendDeliveryEvent[] {
  return params.existingDeliveryEvents.filter((event) => {
    if (
      event.dedupeKey !== params.dedupeKey ||
      params.now - event.createdAt > RECENT_TREND_REPEAT_WINDOW_MS
    ) {
      return false;
    }
    return event.kind === 'inline_card_shown' || event.kind === 'direct_chat_offered';
  });
}

function recentFeedback(
  feedback: AoiProactiveBriefFeedback[],
  candidate: AoiProactiveBriefCandidate,
  now: number,
): AoiProactiveBriefFeedback[] {
  const threshold = now - 14 * 24 * 60 * 60 * 1000;
  return feedback.filter(
    (item) =>
      item.createdAt >= threshold &&
      (item.briefId === candidate.id || item.topicId === candidate.topicId),
  );
}

function buildDeliveryControls(params: {
  candidate: AoiProactiveBriefCandidate;
  sources: AoiProactiveBriefSource[];
  topicId: string;
  existingSnapshots: AoiProactiveTrendSnapshot[];
  existingDeliveryEvents: AoiProactiveTrendDeliveryEvent[];
  feedback: AoiProactiveBriefFeedback[];
  now: number;
}): AoiProactiveTrendDeliveryControls {
  const dedupeKey = trendDedupeKey({
    candidate: params.candidate,
    sources: params.sources,
    topicId: params.topicId,
  });
  const duplicates = matchingDedupeSnapshots({
    existingSnapshots: params.existingSnapshots,
    topicId: params.topicId,
    dedupeKey,
    now: params.now,
  });
  const deliveryEvents = matchingDeliveryEvents({
    existingDeliveryEvents: params.existingDeliveryEvents,
    dedupeKey,
    now: params.now,
  });
  const feedback = recentFeedback(params.feedback, params.candidate, params.now);
  let quietUntil = 0;
  let snoozedUntil = 0;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  if (duplicates.length > 0) {
    reasons.push('duplicate_trend_delivery');
    evidenceRefs.push(...duplicates.map((snapshot) => `trend-duplicate:${snapshot.id}`));
  }
  if (deliveryEvents.length > 0) {
    reasons.push('duplicate_trend_delivery');
    reasons.push('delivery_event_recently_recorded');
    evidenceRefs.push(...deliveryEvents.map((event) => `trend-delivery-event:${event.id}`));
  }
  for (const item of feedback) {
    evidenceRefs.push(`feedback:${item.id}`);
    if (item.category === 'too_frequent') {
      quietUntil = Math.max(quietUntil, item.createdAt + 24 * 60 * 60 * 1000);
      reasons.push('quiet_control_too_frequent');
    }
    if (item.category === 'wrong_timing') {
      quietUntil = Math.max(quietUntil, item.createdAt + 12 * 60 * 60 * 1000);
      reasons.push('quiet_control_wrong_timing');
    }
    if (item.category === 'show_less') {
      quietUntil = Math.max(quietUntil, item.createdAt + 6 * 60 * 60 * 1000);
      reasons.push('quiet_control_show_less');
    }
    if (item.category === 'archive_brief') {
      snoozedUntil = Math.max(snoozedUntil, item.createdAt + 7 * 24 * 60 * 60 * 1000);
      reasons.push('trend_snoozed_by_archive');
    }
    if (item.category === 'mute_topic') {
      snoozedUntil = Math.max(snoozedUntil, item.createdAt + 30 * 24 * 60 * 60 * 1000);
      reasons.push('trend_snoozed_by_topic_mute');
    }
  }
  if (quietUntil > params.now) {
    reasons.push('trend_quiet_control_active');
  }
  if (snoozedUntil > params.now) {
    reasons.push('trend_snoozed');
  }
  return {
    version: 1,
    dedupeKey,
    duplicateBlocked: duplicates.length > 0 || deliveryEvents.length > 0,
    ...(quietUntil > params.now ? { quietUntil } : {}),
    ...(snoozedUntil > params.now ? { snoozedUntil } : {}),
    reasons: unique(reasons).slice(0, 12),
    evidenceRefs: unique([
      `trend-control:${stableHash(dedupeKey)}`,
      ...evidenceRefs.map((ref) => sanitizeText(ref, 180)).filter(Boolean),
    ]).slice(0, 12),
  };
}

function buildInterestDrift(params: {
  candidate: AoiProactiveBriefCandidate;
  watch: AoiProactiveTrendWatchTopic | null;
  feedback: AoiProactiveBriefFeedback[];
  policy?: AoiAutonomyPolicy | null;
  now: number;
}): AoiProactiveTrendInterestDrift {
  const feedback = recentFeedback(params.feedback, params.candidate, params.now);
  const positiveCategories = new Set([
    'useful',
    'show_more',
    'open_sources',
    'expand_summary',
    'pin_topic',
  ]);
  const negativeCategories = new Set([
    'not_useful',
    'show_less',
    'wrong_topic',
    'wrong_timing',
    'too_frequent',
    'stale',
    'unsafe',
    'mute_topic',
    'archive_brief',
  ]);
  const positiveFeedbackCount = feedback.filter((item) =>
    positiveCategories.has(item.category),
  ).length;
  const negativeFeedbackCount = feedback.filter((item) =>
    negativeCategories.has(item.category),
  ).length;
  const wrongTopicCount = feedback.filter((item) => item.category === 'wrong_topic').length;
  const muted =
    params.watch?.muted === true ||
    params.policy?.proactiveBriefing.topicControls[params.candidate.topicId]?.muted === true ||
    feedback.some((item) => item.category === 'mute_topic');
  const baseScore = params.watch ? params.watch.confidence : 0.28;
  const score = clampScore(
    baseScore +
      positiveFeedbackCount * 0.08 -
      negativeFeedbackCount * 0.09 -
      wrongTopicCount * 0.18 -
      (params.watch ? 0 : 0.3) -
      (muted ? 0.5 : 0),
    baseScore,
  );
  const reasons: string[] = [];
  let status: AoiProactiveTrendInterestDriftStatus = 'aligned';
  if (!params.watch) {
    reasons.push('missing_watch_topic');
  }
  if (wrongTopicCount > 0) {
    reasons.push('wrong_topic_feedback');
  }
  if (negativeFeedbackCount > positiveFeedbackCount) {
    reasons.push('negative_feedback_dominates');
  }
  if (muted) {
    status = 'muted';
    reasons.push('topic_muted');
  } else if (!params.watch || wrongTopicCount > positiveFeedbackCount || score < 0.46) {
    status = 'drifting';
  } else if (negativeFeedbackCount > positiveFeedbackCount || score < 0.68) {
    status = 'watch';
  }
  return {
    version: 1,
    status,
    score,
    positiveFeedbackCount,
    negativeFeedbackCount,
    reasons: unique(reasons).slice(0, 8),
    evidenceRefs: unique([
      ...(params.watch?.evidenceRefs ?? []),
      ...feedback.map((item) => `feedback:${item.id}`),
    ]).slice(0, 12),
  };
}

function normalizedTrendTitle(value: string): string {
  return sanitizeText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceUrlSet(sources: AoiProactiveBriefSource[]): Set<string> {
  return new Set(sources.map((source) => source.url.toLowerCase()).filter(Boolean));
}

function sourceOverlapCount(
  left: AoiProactiveBriefSource[],
  right: AoiProactiveBriefSource[],
): number {
  const leftUrls = sourceUrlSet(left);
  let overlap = 0;
  for (const source of right) {
    if (leftUrls.has(source.url.toLowerCase())) {
      overlap += 1;
    }
  }
  return overlap;
}

function titleLooksRepeated(left: string, right: string): boolean {
  const leftTitle = normalizedTrendTitle(left);
  const rightTitle = normalizedTrendTitle(right);
  if (!leftTitle || !rightTitle) {
    return false;
  }
  return (
    leftTitle === rightTitle || leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle)
  );
}

function computeTrendNovelty(params: {
  candidate: AoiProactiveBriefCandidate;
  sources: AoiProactiveBriefSource[];
  existingSnapshots: AoiProactiveTrendSnapshot[];
  freshness: AoiProactiveTrendSnapshotFreshness;
  sourceStrong: boolean;
  watch: AoiProactiveTrendWatchTopic | null;
  now: number;
}): AoiProactiveTrendNovelty {
  const topicSnapshots = params.existingSnapshots.filter(
    (snapshot) =>
      snapshot.topicId === params.candidate.topicId &&
      snapshot.expiresAt > params.now &&
      params.now - snapshot.updatedAt <= RECENT_TREND_REPEAT_WINDOW_MS,
  );
  const matches = topicSnapshots.filter((snapshot) => {
    if (snapshot.candidateId && snapshot.candidateId === params.candidate.id) {
      return true;
    }
    if (sourceOverlapCount(snapshot.sources, params.sources) > 0) {
      return true;
    }
    return titleLooksRepeated(snapshot.title, params.candidate.title);
  });
  const overlapCount = matches.reduce(
    (total, snapshot) => total + sourceOverlapCount(snapshot.sources, params.sources),
    0,
  );
  let status: AoiProactiveTrendNoveltyStatus = 'new';
  let reason = 'No recent matching trend snapshot was found for this watch topic.';
  let score = clampScore(params.candidate.score, 0.5);
  if (params.freshness === 'stale') {
    status = 'stale';
    reason = 'Source evidence is stale, so Aoi should not treat this as a current trend.';
    score = clampScore(score - 0.35, 0.35);
  } else if (!params.sourceStrong) {
    status = 'weak';
    reason = 'The trend signal has weak source coverage and should stay low interruption.';
    score = clampScore(score - 0.22, 0.45);
  } else if (matches.length > 0) {
    status = 'repeat';
    reason = `Matches ${matches.length} recent trend snapshot(s); avoid repeating the same item.`;
    score = clampScore(score - 0.42, 0.35);
  } else if (params.watch && score < params.watch.noveltyThreshold) {
    status = 'weak';
    reason = `Novelty score ${score.toFixed(2)} is below the watch threshold ${params.watch.noveltyThreshold.toFixed(2)}.`;
  }
  return {
    version: 1,
    status,
    score,
    reason,
    matchedSnapshotIds: matches.map((snapshot) => snapshot.id).slice(0, 8),
    sourceOverlapCount: overlapCount,
  };
}

// P3-2b: on a user-return lull the auto trend advisor may relax the direct-chat confidence
// floor by this bounded delta, with a hard lower bound so the floor can never drop below
// DIRECT_CHAT_CONFIDENCE_FLOOR_HARD_MIN. The relief only ever removes the confidence_below_floor
// reason; every other gate stays unchanged, so a trend reaches direct chat only when confidence
// was its SOLE remaining blocker. Eligibility (background path, explicit opt-in, idle window,
// P3-2a budget room) is decided server-side in aoiAutonomyScheduler; this is just the bound.
const DIRECT_CHAT_CONFIDENCE_FLOOR_RELIEF_DELTA = 0.05;
const DIRECT_CHAT_CONFIDENCE_FLOOR_HARD_MIN = 0.5;

function directChatBlockReasons(params: {
  candidate: AoiProactiveBriefCandidate;
  watch: AoiProactiveTrendWatchTopic | null;
  policy?: AoiAutonomyPolicy | null;
  readiness: AoiProactiveTrendAdvisorReadiness;
  feedback: AoiProactiveBriefFeedback[];
  freshness: AoiProactiveTrendSnapshotFreshness;
  sourceQuality: AoiProactiveTrendSourceQuality;
  sourceStrong: boolean;
  controls: AoiProactiveTrendDeliveryControls;
  interestDrift: AoiProactiveTrendInterestDrift;
  novelty: AoiProactiveTrendNovelty;
  directChatBudgetExhausted?: boolean;
  directChatConfidenceFloorRelief?: boolean;
  now: number;
}): string[] {
  const reasons: string[] = [];
  if (params.policy?.enabled !== true || params.policy.proactiveSuggestionsEnabled !== true) {
    reasons.push('policy_disabled');
  }
  if (params.policy?.proactiveBriefing.enabled !== true) {
    reasons.push('proactive_briefing_disabled');
  }
  if (params.policy?.proactiveBriefing.directChatHookOptIn !== true) {
    reasons.push('direct_chat_not_opted_in');
  }
  if (!params.readiness.directChatReady) {
    reasons.push(...params.readiness.directChatBlockedReasons);
  }
  if (!params.candidate.delivery.allowedModes.includes('chat_hook')) {
    reasons.push('chat_hook_mode_not_allowed');
  }
  if (!params.watch) {
    reasons.push('wrong_topic_or_missing_watch');
  }
  if (
    params.watch?.muted ||
    params.policy?.proactiveBriefing.topicControls[params.candidate.topicId]?.muted
  ) {
    reasons.push('topic_muted');
  }
  if (params.freshness === 'stale') {
    reasons.push('stale_source');
  }
  if (!params.sourceStrong) {
    reasons.push('weak_source_evidence');
    reasons.push(`source_quality_${params.sourceQuality.status}`);
  }
  if (params.sourceQuality.status === 'blocked') {
    reasons.push(...params.sourceQuality.blockedReasons);
  }
  if (params.controls.duplicateBlocked) {
    reasons.push('duplicate_trend_delivery');
  }
  if (params.controls.quietUntil && params.controls.quietUntil > params.now) {
    reasons.push('trend_quiet_control_active');
  }
  if (params.controls.snoozedUntil && params.controls.snoozedUntil > params.now) {
    reasons.push('trend_snoozed');
  }
  // P3-2a: a spent per-day direct-chat budget blocks direct chat for this trend. The reason
  // intentionally matches none of deliveryModeForTrend's "blocked"/"dashboard"/hard-block
  // patterns, so an otherwise-strong trend falls through to an inline card (still surfaced,
  // not an interruption) rather than being demoted to dashboard.
  if (params.directChatBudgetExhausted === true) {
    reasons.push('direct_chat_daily_budget_exhausted');
  }
  if (params.interestDrift.status === 'muted') {
    reasons.push('topic_muted');
  } else if (params.interestDrift.status === 'drifting') {
    reasons.push('interest_drift_detected');
  } else if (params.interestDrift.status === 'watch') {
    reasons.push('interest_drift_watch');
  }
  if (params.novelty.status === 'repeat') {
    reasons.push('repeat_trend_snapshot');
  }
  if (params.novelty.status === 'weak') {
    reasons.push('novelty_below_threshold');
  }
  const baseConfidenceFloor = Math.max(0.55, params.policy?.confidenceFloor ?? 0.55);
  // P3-2b: when the server-side gate granted a user-return lull relief, lower the direct-chat
  // confidence floor by a bounded delta (never below the hard min). Off -> byte-identical floor.
  const confidenceFloor =
    params.directChatConfidenceFloorRelief === true
      ? Math.max(
          DIRECT_CHAT_CONFIDENCE_FLOOR_HARD_MIN,
          baseConfidenceFloor - DIRECT_CHAT_CONFIDENCE_FLOOR_RELIEF_DELTA,
        )
      : baseConfidenceFloor;
  if (params.candidate.confidence < confidenceFloor) {
    reasons.push('confidence_below_floor');
  }
  for (const item of recentFeedback(params.feedback, params.candidate, params.now)) {
    if (item.category === 'wrong_topic') {
      reasons.push('wrong_topic_feedback');
    }
    if (item.category === 'too_frequent' || item.category === 'wrong_timing') {
      reasons.push('too_frequent_or_wrong_timing_feedback');
    }
    if (item.category === 'stale') {
      reasons.push('stale_feedback');
    }
    if (item.category === 'unsafe') {
      reasons.push('unsafe_feedback');
    }
  }
  return unique(reasons);
}

function confidenceLabel(score: number): string {
  if (score >= 0.8) {
    return `High (${score.toFixed(2)})`;
  }
  if (score >= 0.62) {
    return `Medium (${score.toFixed(2)})`;
  }
  return `Low (${score.toFixed(2)})`;
}

function freshnessLabel(freshness: AoiProactiveTrendSnapshotFreshness): string {
  if (freshness === 'fresh') {
    return 'Fresh source evidence';
  }
  if (freshness === 'stale') {
    return 'Stale source evidence';
  }
  return 'Freshness unknown';
}

function noveltyLabel(novelty: AoiProactiveTrendNovelty): string {
  if (novelty.status === 'new') {
    return `New signal (${novelty.score.toFixed(2)})`;
  }
  if (novelty.status === 'repeat') {
    return `Repeated signal (${novelty.score.toFixed(2)})`;
  }
  if (novelty.status === 'stale') {
    return `Stale signal (${novelty.score.toFixed(2)})`;
  }
  return `Weak signal (${novelty.score.toFixed(2)})`;
}

function sourceQualityLabel(sourceQuality: AoiProactiveTrendSourceQuality): string {
  return `Source ${sourceQuality.status} (${sourceQuality.score.toFixed(2)}, ${sourceQuality.independentHostCount} hosts)`;
}

function interestDriftLabel(interestDrift: AoiProactiveTrendInterestDrift): string {
  if (interestDrift.status === 'aligned') {
    return `Interest aligned (${interestDrift.score.toFixed(2)})`;
  }
  if (interestDrift.status === 'muted') {
    return `Interest muted (${interestDrift.score.toFixed(2)})`;
  }
  if (interestDrift.status === 'drifting') {
    return `Interest drift (${interestDrift.score.toFixed(2)})`;
  }
  return `Interest watch (${interestDrift.score.toFixed(2)})`;
}

function controlSummary(controls: AoiProactiveTrendDeliveryControls): string {
  const active = controls.reasons.filter((reason) =>
    /duplicate|quiet_control_active|snoozed/.test(reason),
  );
  if (active.length === 0) {
    return 'No active quiet, snooze, or duplicate suppression.';
  }
  return `Controls active: ${active.slice(0, 3).join(', ')}.`;
}

function deliveryModeForTrend(params: {
  candidate: AoiProactiveBriefCandidate;
  novelty: AoiProactiveTrendNovelty;
  freshness: AoiProactiveTrendSnapshotFreshness;
  sourceStrong: boolean;
  blockReasons: string[];
}): AoiProactiveTrendDeliveryMode {
  if (params.blockReasons.length === 0) {
    return 'direct_chat';
  }
  if (
    params.blockReasons.some((reason) =>
      /trend_snoozed|topic_muted|unsafe|no_public_sources/.test(reason),
    )
  ) {
    return 'blocked';
  }
  if (
    params.blockReasons.some((reason) =>
      /duplicate_trend_delivery|trend_quiet_control_active/.test(reason),
    )
  ) {
    return 'dashboard';
  }
  if (params.freshness === 'stale' || params.novelty.status === 'stale') {
    return 'dashboard';
  }
  if (!params.sourceStrong || params.novelty.status === 'weak') {
    return 'dashboard';
  }
  if (params.novelty.status === 'repeat') {
    return 'quiet_notification';
  }
  const hardBlock = params.blockReasons.some((reason) =>
    /policy_disabled|proactive_briefing_disabled|topic_muted|wrong_topic|unsafe|stale_feedback|private|unauthorized|chat_hook_mode_not_allowed|duplicate_trend_delivery|trend_quiet_control_active|interest_drift|source_quality_blocked/.test(
      reason,
    ),
  );
  if (hardBlock) {
    return 'dashboard';
  }
  if (params.candidate.delivery.allowedModes.includes('inline_card')) {
    return 'inline_card';
  }
  return 'quiet_notification';
}

function deliverySummary(params: {
  mode: AoiProactiveTrendDeliveryMode;
  novelty: AoiProactiveTrendNovelty;
  blockReasons: string[];
}): string {
  if (params.mode === 'direct_chat') {
    return 'Ready for direct chat because opt-in, field evidence, source, and novelty gates passed.';
  }
  if (params.mode === 'inline_card') {
    return 'Prepared as an inline card because the trend is new, source-backed, and direct chat is still gated.';
  }
  if (params.mode === 'quiet_notification') {
    return 'Kept as a quiet notification because it is relevant but should not interrupt chat.';
  }
  if (params.mode === 'blocked') {
    return `Blocked: ${params.blockReasons.slice(0, 3).join(', ') || params.novelty.reason}.`;
  }
  return `Dashboard only: ${params.blockReasons.slice(0, 3).join(', ') || params.novelty.reason}.`;
}

function buildChatHookText(params: {
  topicLabel: string;
  title: string;
  myTake: string;
  sourceHosts: string[];
}): string {
  const hosts = params.sourceHosts.slice(0, 3).join(', ') || 'public sources';
  return `Aoi trend signal for ${params.topicLabel}: ${params.title}. My take: ${params.myTake} Sources: ${hosts}.`;
}

export function buildAoiProactiveTrendFollowUpPrompts(
  card: Pick<
    AoiProactiveTrendOpinionCard,
    'title' | 'topicLabel' | 'sourceHosts' | 'suggestedNextAction'
  >,
): string[] {
  const title = sanitizeText(card.title, 120) || 'this trend';
  const topicLabel = sanitizeText(card.topicLabel, 80) || 'this topic';
  const sourceHint = card.sourceHosts.slice(0, 2).join(', ') || 'the source evidence';
  return unique(
    [
      `Aoi, dig deeper into "${title}" and compare the strongest evidence.`,
      `Aoi, open the source evidence for "${title}" from ${sourceHint}.`,
      `Aoi, turn this ${topicLabel} trend into a short research plan.`,
      sanitizeText(card.suggestedNextAction, 160)
        ? `Aoi, help me act on this: ${sanitizeText(card.suggestedNextAction, 160)}`
        : '',
    ].filter(Boolean),
  ).slice(0, 4);
}

function findWatchForCandidate(
  watchProfile: AoiProactiveTrendWatchProfile,
  candidate: AoiProactiveBriefCandidate,
): AoiProactiveTrendWatchTopic | null {
  const normalizedCandidateLabel = sanitizeText(candidate.topicLabel, 120).toLowerCase();
  return (
    watchProfile.topicWatches.find((watch) => watch.topicId === candidate.topicId) ??
    watchProfile.topicWatches.find((watch) => watch.normalizedLabel === normalizedCandidateLabel) ??
    null
  );
}

function snapshotOpinionFields(params: {
  candidate: AoiProactiveBriefCandidate;
  freshness: AoiProactiveTrendSnapshotFreshness;
  sourceStrong: boolean;
}): Pick<
  AoiProactiveTrendSnapshot,
  'whatChanged' | 'whyItMatters' | 'myTake' | 'suggestedNextAction'
> {
  const candidate = params.candidate;
  const topic = sanitizeText(candidate.topicLabel, 80) || 'this interest';
  const novelty = sanitizeText(candidate.noveltyReason, 260);
  const summary = sanitizeText(candidate.summary || candidate.hook, 360);
  const whyForOperator = sanitizeText(candidate.whyForOperator, 260);
  const whatChanged =
    novelty || summary || `A source-backed scout surfaced a new item related to ${topic}.`;
  const whyItMatters =
    whyForOperator ||
    `This maps to an interest Aoi already tracks for ${topic}, so it is worth keeping on the dashboard.`;
  let myTake =
    'This is worth parking as a watch item first: useful signal, but not enough to interrupt by itself.';
  let suggestedNextAction =
    'Open the listed sources when convenient and mark the card useful or noisy.';
  if (params.freshness === 'stale') {
    myTake =
      'I would not act on this as current information until the scout refreshes the source evidence.';
    suggestedNextAction =
      'Run the scout again or wait for the next budgeted refresh before acting.';
  } else if (!params.sourceStrong) {
    myTake =
      'This is a weak signal until a second independent source or stronger evidence appears.';
    suggestedNextAction = 'Keep it visible on the dashboard, but avoid direct chat escalation.';
  } else if (candidate.confidence >= 0.8 && candidate.score >= 0.75) {
    myTake =
      'This looks like a good short-review candidate: it has source support and matches the saved interest profile.';
    suggestedNextAction = 'Skim the sources and mark useful if the angle is actually relevant.';
  }
  return {
    whatChanged: sanitizeText(whatChanged, 320),
    whyItMatters: sanitizeText(whyItMatters, 320),
    myTake: sanitizeText(myTake, 320),
    suggestedNextAction: sanitizeText(suggestedNextAction, 240),
  };
}

export function buildAoiProactiveTrendAdvisorReadiness(params: {
  sessionPath: string;
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  feedback?: AoiProactiveBriefFeedback[];
  fieldMetrics?: AoiProactiveBriefFieldMetrics | null;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  now?: number;
}): AoiProactiveTrendAdvisorReadiness {
  const now = params.now ?? Date.now();
  const fieldMetrics = params.fieldMetrics ?? null;
  const feedback = params.feedback ?? [];
  const blockers: string[] = [];
  const evidenceRefs: string[] = [];
  const sampleCount = fieldMetrics?.eventCount ?? 0;

  if (params.policy?.enabled !== true || params.policy.proactiveSuggestionsEnabled !== true) {
    blockers.push('policy_disabled');
  }
  if (params.policy?.proactiveBriefing.enabled !== true) {
    blockers.push('proactive_briefing_disabled');
  }
  if ((params.profile?.topics.length ?? 0) === 0) {
    blockers.push('interest_profile_empty');
  }
  if (params.policy?.proactiveBriefing.directChatHookOptIn !== true) {
    blockers.push('direct_chat_not_opted_in');
  }
  if (sampleCount < MIN_DIRECT_CHAT_FIELD_SAMPLE_COUNT) {
    blockers.push('field_evidence_missing');
  }
  if (
    (fieldMetrics?.privateLeakCount ?? 0) > 0 ||
    (fieldMetrics?.unauthorizedMutationCount ?? 0) > 0
  ) {
    blockers.push('private_or_unauthorized_field_event');
  }
  if ((fieldMetrics?.staleCurrentClaimCount ?? 0) > 0) {
    blockers.push('stale_current_claim');
  }
  if (
    (fieldMetrics?.unsafeCount ?? 0) > 0 ||
    (params.calibrationTuning?.unsafeLabelCount ?? 0) > 0
  ) {
    blockers.push('unsafe_feedback');
  }
  if (
    feedback.some((item) => item.category === 'too_frequent' || item.category === 'wrong_timing')
  ) {
    blockers.push('recent_timing_feedback');
  }
  if (fieldMetrics?.evidenceRefs.length) {
    evidenceRefs.push(...fieldMetrics.evidenceRefs);
  }
  if (params.calibrationTuning?.evidenceRefs.length) {
    evidenceRefs.push(...params.calibrationTuning.evidenceRefs);
  }

  const uniqueBlockers = unique(blockers);
  const directChatReady = uniqueBlockers.length === 0;
  const status =
    params.policy?.enabled !== true ||
    params.policy.proactiveSuggestionsEnabled !== true ||
    params.policy.proactiveBriefing.enabled !== true ||
    (params.profile?.topics.length ?? 0) === 0
      ? 'not_configured'
      : directChatReady
        ? 'ready'
        : uniqueBlockers.some((reason) =>
              /private|unauthorized|unsafe|stale_current_claim/.test(reason),
            )
          ? 'blocked'
          : 'measuring';
  return {
    version: 1,
    status,
    sampleCount,
    directChatReady,
    directChatBlockedReasons: uniqueBlockers,
    summary: directChatReady
      ? 'Trend advisor cards can be delivered quietly; direct chat is eligible when each card also passes evidence gates.'
      : 'Trend advisor can prepare dashboard opinion cards, but direct chat stays blocked until policy, field evidence, and feedback gates pass.',
    evidenceRefs: unique([
      `trend-readiness:${params.sessionPath}:${now}`,
      ...evidenceRefs.map((ref) => sanitizeText(ref, 180)).filter(Boolean),
    ]).slice(0, 16),
  };
}

export function buildAoiProactiveTrendSnapshotFromCandidate(params: {
  sessionPath: string;
  candidate: AoiProactiveBriefCandidate;
  watch: AoiProactiveTrendWatchTopic | null;
  readiness: AoiProactiveTrendAdvisorReadiness;
  feedback?: AoiProactiveBriefFeedback[];
  policy?: AoiAutonomyPolicy | null;
  existingSnapshots?: AoiProactiveTrendSnapshot[];
  existingDeliveryEvents?: AoiProactiveTrendDeliveryEvent[];
  now?: number;
  sourceStaleAfterMs?: number;
  directChatBudgetExhausted?: boolean;
  directChatConfidenceFloorRelief?: boolean;
}): AoiProactiveTrendSnapshot | null {
  const now = params.now ?? Date.now();
  const candidate = params.candidate;
  const sources = normalizeSources(candidate.sources, now);
  const evidenceRefs = unique([
    `brief:${candidate.id}`,
    ...candidate.evidenceRefs.map((ref) => sanitizeText(ref, 180)).filter(Boolean),
    ...sources.map((source) => `source:${source.host}`),
  ]).slice(0, 24);
  if (sources.length === 0 || evidenceRefs.length === 0) {
    return null;
  }
  const freshness = candidateFreshness(
    candidate,
    now,
    params.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS,
  );
  const sourceQuality = buildSourceQuality({
    sources,
    evidenceRefs,
    freshness,
    now,
    staleAfterMs: params.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS,
  });
  const sourceStrong = sourceEvidenceStrong(sourceQuality);
  const novelty = computeTrendNovelty({
    candidate,
    sources,
    existingSnapshots: params.existingSnapshots ?? [],
    freshness,
    sourceStrong,
    watch: params.watch,
    now,
  });
  const topicId = params.watch?.topicId ?? sanitizeText(candidate.topicId, 120);
  const topicLabel = params.watch?.topicLabel ?? sanitizeText(candidate.topicLabel, 80);
  const controls = buildDeliveryControls({
    candidate,
    sources,
    topicId,
    existingSnapshots: params.existingSnapshots ?? [],
    existingDeliveryEvents: params.existingDeliveryEvents ?? [],
    feedback: params.feedback ?? [],
    now,
  });
  const interestDrift = buildInterestDrift({
    candidate,
    watch: params.watch,
    feedback: params.feedback ?? [],
    policy: params.policy,
    now,
  });
  const blockReasons = directChatBlockReasons({
    candidate,
    watch: params.watch,
    policy: params.policy,
    readiness: params.readiness,
    feedback: params.feedback ?? [],
    freshness,
    sourceQuality,
    sourceStrong,
    controls,
    interestDrift,
    novelty,
    directChatBudgetExhausted: params.directChatBudgetExhausted,
    directChatConfidenceFloorRelief: params.directChatConfidenceFloorRelief,
    now,
  });
  const opinion = snapshotOpinionFields({ candidate, freshness, sourceStrong });
  const confidence = clampScore(
    candidate.confidence +
      (sourceStrong ? 0.04 : sourceQuality.status === 'acceptable' ? -0.05 : -0.15) +
      (freshness === 'fresh' ? 0.04 : freshness === 'stale' ? -0.24 : -0.08) +
      (params.watch ? 0.04 : -0.2) +
      (interestDrift.status === 'aligned' ? 0.03 : interestDrift.status === 'watch' ? -0.08 : -0.2),
    0.55,
  );
  const deliveryMode = deliveryModeForTrend({
    candidate,
    novelty,
    freshness,
    sourceStrong,
    blockReasons,
  });
  const sourceHosts = unique(sources.map((source) => source.host)).slice(0, 6);
  const chatHookText =
    deliveryMode === 'direct_chat'
      ? buildChatHookText({
          topicLabel: topicLabel || 'Interest topic',
          title: sanitizeText(candidate.title, 160) || 'Source-backed trend item',
          myTake: opinion.myTake,
          sourceHosts,
        })
      : undefined;
  return {
    version: 1,
    id: makeStableId('aoi-trend', `${params.sessionPath}:${topicId}:${candidate.id}`),
    sessionPath: resolveSessionPath(params.sessionPath),
    topicId,
    topicLabel: topicLabel || 'Interest topic',
    candidateId: candidate.id,
    title: sanitizeText(candidate.title, 160) || 'Source-backed trend item',
    ...opinion,
    confidence,
    noveltyScore: clampScore(candidate.score, 0.5),
    novelty,
    risk: normalizeRisk(candidate.risk),
    freshness,
    sourceQuality,
    interestDrift,
    sources,
    delivery: {
      mode: deliveryMode,
      summary: deliverySummary({ mode: deliveryMode, novelty, blockReasons }),
      directChatAllowed: blockReasons.length === 0,
      directChatBlockedReasons: blockReasons,
      controls,
      ...(chatHookText ? { chatHookText } : {}),
      evidenceRefs: unique([
        `trend-delivery:${deliveryMode}`,
        `trend-novelty:${novelty.status}`,
        `trend-source-quality:${sourceQuality.status}`,
        `trend-interest-drift:${interestDrift.status}`,
        ...novelty.matchedSnapshotIds.map((id) => `trend-repeat:${id}`),
        ...controls.evidenceRefs.slice(0, 4),
      ]).slice(0, 12),
    },
    evidenceRefs: unique([
      ...evidenceRefs,
      `trend-source-quality:${sourceQuality.status}:${sourceQuality.score.toFixed(2)}`,
      `trend-interest-drift:${interestDrift.status}:${interestDrift.score.toFixed(2)}`,
      ...controls.evidenceRefs.slice(0, 4),
    ]).slice(0, 28),
    createdAt: normalizeTimestamp(candidate.createdAt, now),
    updatedAt: now,
    expiresAt: normalizeTimestamp(candidate.expiresAt, now + DEFAULT_TREND_TTL_MS),
  };
}

function normalizeSnapshot(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiProactiveTrendSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveTrendSnapshot>;
  const normalizedSessionPath = resolveSessionPath(raw.sessionPath ?? sessionPath);
  if (!isValidAoiAutonomyId(raw.id)) {
    return null;
  }
  const topicId = sanitizeText(raw.topicId, 120);
  if (!topicId) {
    return null;
  }
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);
  const noveltyScore = clampScore(raw.noveltyScore, 0.5);
  const novelty = normalizeNovelty(raw.novelty, noveltyScore);
  const deliveryMode = normalizeDeliveryMode(raw.delivery?.mode);
  const freshness = normalizeFreshness(raw.freshness);
  const sources = normalizeSources(raw.sources, now);
  const evidenceRefs = normalizeStringList(raw.evidenceRefs, 28, 180);
  const fallbackSourceQuality = buildSourceQuality({
    sources,
    evidenceRefs,
    freshness,
    now,
    staleAfterMs: DEFAULT_SOURCE_STALE_AFTER_MS,
  });
  const sourceQuality = normalizeSourceQuality(raw.sourceQuality, fallbackSourceQuality);
  const fallbackDedupeKey = `trend:${topicId}:${stableHash(
    `${normalizedTrendTitle(sanitizeText(raw.title, 160))}:${sources
      .map((source) => source.url.toLowerCase())
      .sort()
      .join('|')}`,
  )}`;
  const controls = normalizeDeliveryControls(raw.delivery?.controls, fallbackDedupeKey, now);
  return {
    version: 1,
    id: raw.id,
    sessionPath: normalizedSessionPath,
    topicId,
    topicLabel: sanitizeText(raw.topicLabel, 80) || 'Interest topic',
    ...(sanitizeText(raw.candidateId, 120)
      ? { candidateId: sanitizeText(raw.candidateId, 120) }
      : {}),
    title: sanitizeText(raw.title, 160) || 'Source-backed trend item',
    whatChanged: sanitizeText(raw.whatChanged, 320),
    whyItMatters: sanitizeText(raw.whyItMatters, 320),
    myTake: sanitizeText(raw.myTake, 320),
    suggestedNextAction: sanitizeText(raw.suggestedNextAction, 240),
    confidence: clampScore(raw.confidence, 0.5),
    noveltyScore,
    novelty,
    risk: normalizeRisk(raw.risk),
    freshness,
    sourceQuality,
    interestDrift: normalizeInterestDrift(raw.interestDrift),
    sources,
    delivery: {
      mode: deliveryMode,
      summary:
        sanitizeText(raw.delivery?.summary, 260) ||
        deliverySummary({
          mode: deliveryMode,
          novelty,
          blockReasons: normalizeStringList(raw.delivery?.directChatBlockedReasons, 16, 120),
        }),
      directChatAllowed: raw.delivery?.directChatAllowed === true,
      directChatBlockedReasons: normalizeStringList(
        raw.delivery?.directChatBlockedReasons,
        16,
        120,
      ),
      controls,
      ...(sanitizeText(raw.delivery?.chatHookText, 360)
        ? { chatHookText: sanitizeText(raw.delivery?.chatHookText, 360) }
        : {}),
      evidenceRefs: normalizeStringList(raw.delivery?.evidenceRefs, 12, 180),
    },
    evidenceRefs,
    createdAt,
    updatedAt,
    expiresAt: normalizeTimestamp(raw.expiresAt, createdAt + DEFAULT_TREND_TTL_MS),
  };
}

function snapshotIndexEntry(
  snapshot: AoiProactiveTrendSnapshot,
): AoiProactiveTrendSnapshotIndexEntry {
  return {
    id: snapshot.id,
    topicId: snapshot.topicId,
    topicLabel: snapshot.topicLabel,
    title: snapshot.title,
    ...(snapshot.candidateId ? { candidateId: snapshot.candidateId } : {}),
    freshness: snapshot.freshness,
    confidence: snapshot.confidence,
    noveltyStatus: snapshot.novelty.status,
    deliveryMode: snapshot.delivery.mode,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    expiresAt: snapshot.expiresAt,
  };
}

function normalizeSnapshotIndexEntry(
  value: unknown,
  now: number,
): AoiProactiveTrendSnapshotIndexEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveTrendSnapshotIndexEntry>;
  if (!isValidAoiAutonomyId(raw.id)) {
    return null;
  }
  const topicId = sanitizeText(raw.topicId, 120);
  if (!topicId) {
    return null;
  }
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  const updatedAt = normalizeTimestamp(raw.updatedAt, createdAt);
  return {
    id: raw.id,
    topicId,
    topicLabel: sanitizeText(raw.topicLabel, 80) || 'Interest topic',
    title: sanitizeText(raw.title, 160) || 'Source-backed trend item',
    ...(sanitizeText(raw.candidateId, 120)
      ? { candidateId: sanitizeText(raw.candidateId, 120) }
      : {}),
    freshness: normalizeFreshness(raw.freshness),
    confidence: clampScore(raw.confidence, 0.5),
    noveltyStatus: normalizeNoveltyStatus(raw.noveltyStatus),
    deliveryMode: normalizeDeliveryMode(raw.deliveryMode),
    createdAt,
    updatedAt,
    expiresAt: normalizeTimestamp(raw.expiresAt, createdAt + DEFAULT_TREND_TTL_MS),
  };
}

export function loadAoiProactiveTrendSnapshotIndex(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveTrendSnapshotIndex {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiProactiveTrendSnapshotIndex>>(paths.snapshotIndex);
  const entries =
    parsed?.version === 1 && Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => normalizeSnapshotIndexEntry(entry, now))
          .filter((entry): entry is AoiProactiveTrendSnapshotIndexEntry => entry !== null)
          .filter((entry) => entry.expiresAt > now)
          .sort(
            (left, right) => right.updatedAt - left.updatedAt || right.confidence - left.confidence,
          )
          .slice(0, MAX_TREND_SNAPSHOT_INDEX_ITEMS)
      : [];
  return {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    entries,
  };
}

function saveSnapshotIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiProactiveTrendSnapshotIndex,
): AoiProactiveTrendSnapshotIndex {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  const normalized: AoiProactiveTrendSnapshotIndex = {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: index.updatedAt,
    entries: index.entries
      .map((entry) => normalizeSnapshotIndexEntry(entry, index.updatedAt))
      .filter((entry): entry is AoiProactiveTrendSnapshotIndexEntry => entry !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.confidence - left.confidence)
      .slice(0, MAX_TREND_SNAPSHOT_INDEX_ITEMS),
  };
  writeJsonAtomic(paths.root, paths.snapshotIndex, normalized);
  return normalized;
}

export function upsertAoiProactiveTrendSnapshot(
  sessionsDir: string,
  snapshot: AoiProactiveTrendSnapshot,
  now = Date.now(),
): AoiProactiveTrendSnapshot {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, snapshot.sessionPath);
  const normalized = normalizeSnapshot(snapshot, snapshot.sessionPath, now);
  if (!normalized) {
    throw new Error('Invalid proactive trend snapshot.');
  }
  writeJsonAtomic(paths.root, join(paths.snapshotsDir, `${normalized.id}.json`), normalized);
  const index = loadAoiProactiveTrendSnapshotIndex(sessionsDir, normalized.sessionPath, now);
  const entries = [
    snapshotIndexEntry(normalized),
    ...index.entries.filter((entry) => entry.id !== normalized.id),
  ].slice(0, MAX_TREND_SNAPSHOT_INDEX_ITEMS);
  saveSnapshotIndex(sessionsDir, normalized.sessionPath, {
    version: 1,
    sessionPath: normalized.sessionPath,
    updatedAt: now,
    entries,
  });
  return normalized;
}

function loadSnapshotById(
  sessionsDir: string,
  sessionPath: string,
  snapshotId: string,
  now: number,
): AoiProactiveTrendSnapshot | null {
  if (!isValidAoiAutonomyId(snapshotId)) {
    return null;
  }
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  return normalizeSnapshot(
    readJson<unknown>(join(paths.snapshotsDir, `${snapshotId}.json`)),
    sessionPath,
    now,
  );
}

export function loadAoiProactiveTrendSnapshots(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveTrendSnapshot[] {
  const index = loadAoiProactiveTrendSnapshotIndex(sessionsDir, sessionPath, now);
  return index.entries
    .map((entry) => loadSnapshotById(sessionsDir, sessionPath, entry.id, now))
    .filter((snapshot): snapshot is AoiProactiveTrendSnapshot => snapshot !== null)
    .filter((snapshot) => snapshot.expiresAt > now)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.confidence - left.confidence)
    .slice(0, MAX_TREND_STATE_SNAPSHOTS);
}

function trendDeliveryEventFilePath(paths: AoiProactiveTrendPaths, eventId: string): string {
  if (!isValidAoiAutonomyId(eventId)) {
    throw new Error('Invalid proactive trend delivery event id.');
  }
  return join(paths.deliveryEventRecordsDir, `${eventId}.json`);
}

function snapshotSourceHosts(snapshot: AoiProactiveTrendSnapshot): string[] {
  return unique(snapshot.sources.map((source) => sanitizeText(source.host, 120)).filter(Boolean));
}

function deliveryEventIndexEntry(
  event: AoiProactiveTrendDeliveryEvent,
): AoiProactiveTrendDeliveryEventIndexEntry {
  return {
    id: event.id,
    kind: event.kind,
    snapshotId: event.snapshotId,
    ...(event.candidateId ? { candidateId: event.candidateId } : {}),
    topicId: event.topicId,
    deliveryMode: event.deliveryMode,
    dedupeKey: event.dedupeKey,
    createdAt: event.createdAt,
  };
}

function normalizeDeliveryEvent(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiProactiveTrendDeliveryEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveTrendDeliveryEvent>;
  if (!isValidAoiAutonomyId(raw.id)) {
    return null;
  }
  const snapshotId = sanitizeText(raw.snapshotId, 120);
  const topicId = sanitizeText(raw.topicId, 120);
  const dedupeKey = sanitizeText(raw.dedupeKey, 240);
  if (!snapshotId || !topicId || !dedupeKey) {
    return null;
  }
  const createdAt = normalizeTimestamp(raw.createdAt, now);
  return {
    version: 1,
    id: raw.id,
    sessionPath: resolveSessionPath(raw.sessionPath || sessionPath),
    kind: normalizeDeliveryEventKind(raw.kind),
    snapshotId,
    ...(sanitizeText(raw.candidateId, 120)
      ? { candidateId: sanitizeText(raw.candidateId, 120) }
      : {}),
    topicId,
    topicLabel: sanitizeText(raw.topicLabel, 80) || 'Interest topic',
    deliveryMode: normalizeDeliveryMode(raw.deliveryMode),
    dedupeKey,
    title: sanitizeText(raw.title, 160) || 'Source-backed trend item',
    sourceQualityStatus: normalizeSourceQualityStatus(raw.sourceQualityStatus),
    interestDriftStatus: normalizeInterestDriftStatus(raw.interestDriftStatus),
    suppressionReasons: normalizeStringList(raw.suppressionReasons, 12, 120),
    sourceHosts: normalizeStringList(raw.sourceHosts, 8, 120),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 16, 180),
    createdAt,
  };
}

function normalizeDeliveryEventIndexEntry(
  value: unknown,
  now: number,
): AoiProactiveTrendDeliveryEventIndexEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiProactiveTrendDeliveryEventIndexEntry>;
  if (!isValidAoiAutonomyId(raw.id)) {
    return null;
  }
  const snapshotId = sanitizeText(raw.snapshotId, 120);
  const topicId = sanitizeText(raw.topicId, 120);
  const dedupeKey = sanitizeText(raw.dedupeKey, 240);
  if (!snapshotId || !topicId || !dedupeKey) {
    return null;
  }
  return {
    id: raw.id,
    kind: normalizeDeliveryEventKind(raw.kind),
    snapshotId,
    ...(sanitizeText(raw.candidateId, 120)
      ? { candidateId: sanitizeText(raw.candidateId, 120) }
      : {}),
    topicId,
    deliveryMode: normalizeDeliveryMode(raw.deliveryMode),
    dedupeKey,
    createdAt: normalizeTimestamp(raw.createdAt, now),
  };
}

export function loadAoiProactiveTrendDeliveryEventIndex(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveTrendDeliveryEventIndex {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiProactiveTrendDeliveryEventIndex>>(paths.deliveryEventIndex);
  const retentionThreshold = now - TREND_DELIVERY_EVENT_RETENTION_MS;
  const entries =
    parsed?.version === 1 && Array.isArray(parsed.entries)
      ? parsed.entries
          .map((entry) => normalizeDeliveryEventIndexEntry(entry, now))
          .filter((entry): entry is AoiProactiveTrendDeliveryEventIndexEntry => entry !== null)
          .filter((entry) => entry.createdAt >= retentionThreshold)
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, MAX_TREND_DELIVERY_EVENT_INDEX_ITEMS)
      : [];
  return {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: normalizeTimestamp(parsed?.updatedAt, 0),
    entries,
  };
}

function saveDeliveryEventIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiProactiveTrendDeliveryEventIndex,
): AoiProactiveTrendDeliveryEventIndex {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  const retentionThreshold = index.updatedAt - TREND_DELIVERY_EVENT_RETENTION_MS;
  const normalized: AoiProactiveTrendDeliveryEventIndex = {
    version: 1,
    sessionPath: resolveSessionPath(sessionPath),
    updatedAt: index.updatedAt,
    entries: index.entries
      .map((entry) => normalizeDeliveryEventIndexEntry(entry, index.updatedAt))
      .filter((entry): entry is AoiProactiveTrendDeliveryEventIndexEntry => entry !== null)
      .filter((entry) => entry.createdAt >= retentionThreshold)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_TREND_DELIVERY_EVENT_INDEX_ITEMS),
  };
  writeJsonAtomic(paths.root, paths.deliveryEventIndex, normalized);
  return normalized;
}

function loadDeliveryEventById(
  sessionsDir: string,
  sessionPath: string,
  eventId: string,
  now: number,
): AoiProactiveTrendDeliveryEvent | null {
  const paths = resolveAoiProactiveTrendPaths(sessionsDir, sessionPath);
  if (!isValidAoiAutonomyId(eventId)) {
    return null;
  }
  return normalizeDeliveryEvent(
    readJson<Partial<AoiProactiveTrendDeliveryEvent>>(trendDeliveryEventFilePath(paths, eventId)),
    sessionPath,
    now,
  );
}

export function loadAoiProactiveTrendDeliveryEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiProactiveTrendDeliveryEvent[] {
  const index = loadAoiProactiveTrendDeliveryEventIndex(sessionsDir, sessionPath, now);
  const retentionThreshold = now - TREND_DELIVERY_EVENT_RETENTION_MS;
  return index.entries
    .map((entry) => loadDeliveryEventById(sessionsDir, sessionPath, entry.id, now))
    .filter((event): event is AoiProactiveTrendDeliveryEvent => event !== null)
    .filter((event) => event.createdAt >= retentionThreshold)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_TREND_STATE_DELIVERY_EVENTS);
}

export function recordAoiProactiveTrendDeliveryEventFromSnapshot(params: {
  sessionsDir: string;
  snapshot: AoiProactiveTrendSnapshot;
  kind: AoiProactiveTrendDeliveryEventKind;
  suppressionReasons?: string[];
  now?: number;
}): AoiProactiveTrendDeliveryEvent {
  const now = params.now ?? Date.now();
  const normalized = normalizeSnapshot(params.snapshot, params.snapshot.sessionPath, now);
  if (!normalized) {
    throw new Error('Invalid proactive trend snapshot.');
  }
  const kind = normalizeDeliveryEventKind(params.kind);
  const eventId = makeStableId(
    'aoi-trend-delivery',
    `${normalized.sessionPath}:${kind}:${normalized.delivery.controls.dedupeKey}`,
  );
  const existing = loadDeliveryEventById(params.sessionsDir, normalized.sessionPath, eventId, now);
  if (existing) {
    return existing;
  }
  const paths = resolveAoiProactiveTrendPaths(params.sessionsDir, normalized.sessionPath);
  const event = normalizeDeliveryEvent(
    {
      version: 1,
      id: eventId,
      sessionPath: normalized.sessionPath,
      kind,
      snapshotId: normalized.id,
      ...(normalized.candidateId ? { candidateId: normalized.candidateId } : {}),
      topicId: normalized.topicId,
      topicLabel: normalized.topicLabel,
      deliveryMode: normalized.delivery.mode,
      dedupeKey: normalized.delivery.controls.dedupeKey,
      title: normalized.title,
      sourceQualityStatus: normalized.sourceQuality.status,
      interestDriftStatus: normalized.interestDrift.status,
      suppressionReasons:
        params.suppressionReasons ??
        normalized.delivery.directChatBlockedReasons.concat(normalized.delivery.controls.reasons),
      sourceHosts: snapshotSourceHosts(normalized),
      evidenceRefs: unique([
        `trend-snapshot:${normalized.id}`,
        ...normalized.delivery.evidenceRefs,
        ...normalized.evidenceRefs.slice(0, 8),
      ]),
      createdAt: now,
    },
    normalized.sessionPath,
    now,
  );
  if (!event) {
    throw new Error('Invalid proactive trend delivery event.');
  }
  writeJsonAtomic(paths.root, trendDeliveryEventFilePath(paths, event.id), event);
  const index = loadAoiProactiveTrendDeliveryEventIndex(
    params.sessionsDir,
    normalized.sessionPath,
    now,
  );
  saveDeliveryEventIndex(params.sessionsDir, normalized.sessionPath, {
    version: 1,
    sessionPath: normalized.sessionPath,
    updatedAt: now,
    entries: [
      deliveryEventIndexEntry(event),
      ...index.entries.filter((entry) => entry.id !== event.id),
    ],
  });
  try {
    appendAoiFollowThroughEvent(
      params.sessionsDir,
      buildAoiFollowThroughEventFromTrendDelivery(event, now),
      now,
    );
  } catch {
    // Follow-through learning must not block trend delivery audit recording.
  }
  return event;
}

export function buildAoiProactiveTrendDeliveryAuditSummary(
  events: AoiProactiveTrendDeliveryEvent[],
): AoiProactiveTrendDeliveryAuditSummary {
  return {
    version: 1,
    inlineShownCount: events.filter((event) => event.kind === 'inline_card_shown').length,
    directChatOfferedCount: events.filter((event) => event.kind === 'direct_chat_offered').length,
    suppressedCount: events.filter((event) => event.kind === 'delivery_suppressed').length,
    ...(events[0]?.createdAt ? { latestEventAt: events[0].createdAt } : {}),
    evidenceRefs: events
      .flatMap((event) => [`trend-delivery-event:${event.id}`, ...event.evidenceRefs.slice(0, 2)])
      .slice(0, 12),
  };
}

function cardFromSnapshot(snapshot: AoiProactiveTrendSnapshot): AoiProactiveTrendOpinionCard {
  const sourceHosts = unique(snapshot.sources.map((source) => source.host)).slice(0, 6);
  const card: AoiProactiveTrendOpinionCard = {
    version: 1,
    id: makeStableId('aoi-trend-card', `${snapshot.id}:${snapshot.updatedAt}`),
    snapshotId: snapshot.id,
    ...(snapshot.candidateId ? { candidateId: snapshot.candidateId } : {}),
    topicId: snapshot.topicId,
    topicLabel: snapshot.topicLabel,
    title: snapshot.title,
    whatChanged: snapshot.whatChanged,
    whyItMatters: snapshot.whyItMatters,
    myTake: snapshot.myTake,
    suggestedNextAction: snapshot.suggestedNextAction,
    confidenceLabel: confidenceLabel(snapshot.confidence),
    freshnessLabel: freshnessLabel(snapshot.freshness),
    noveltyLabel: noveltyLabel(snapshot.novelty),
    sourceQualityLabel: sourceQualityLabel(snapshot.sourceQuality),
    interestDriftLabel: interestDriftLabel(snapshot.interestDrift),
    deliveryMode: snapshot.delivery.mode,
    deliverySummary: snapshot.delivery.summary,
    controlSummary: controlSummary(snapshot.delivery.controls),
    sourceHosts,
    sources: snapshot.sources.slice(0, 6),
    followUpPrompts: [],
    directChatAllowed: snapshot.delivery.directChatAllowed,
    directChatBlockedReasons: snapshot.delivery.directChatBlockedReasons,
    ...(snapshot.delivery.controls.quietUntil
      ? { quietUntil: snapshot.delivery.controls.quietUntil }
      : {}),
    ...(snapshot.delivery.controls.snoozedUntil
      ? { snoozedUntil: snapshot.delivery.controls.snoozedUntil }
      : {}),
    ...(snapshot.delivery.chatHookText ? { chatHookText: snapshot.delivery.chatHookText } : {}),
    evidenceRefs: snapshot.evidenceRefs.slice(0, 16),
    createdAt: snapshot.updatedAt,
  };
  return {
    ...card,
    followUpPrompts: buildAoiProactiveTrendFollowUpPrompts(card),
  };
}

function countByStatus<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function buildAoiProactiveTrendAdvisorState(
  input: BuildAoiProactiveTrendAdvisorStateInput,
): AoiProactiveTrendAdvisorState {
  const now = input.now ?? Date.now();
  const sessionPath = resolveSessionPath(input.sessionPath);
  const persist = input.persist !== false && Boolean(input.sessionsDir);
  const watchProfile = buildAoiProactiveTrendWatchProfile({
    sessionPath,
    profile: input.profile,
    feedback: input.feedback,
    calibrationTuning: input.calibrationTuning,
    now,
  });
  const readiness = buildAoiProactiveTrendAdvisorReadiness({
    sessionPath,
    policy: input.policy,
    profile: input.profile,
    feedback: input.feedback,
    fieldMetrics: input.fieldMetrics,
    calibrationTuning: input.calibrationTuning,
    now,
  });

  if (persist && input.sessionsDir) {
    saveAoiProactiveTrendWatchProfile(input.sessionsDir, sessionPath, watchProfile);
  }

  const existingSnapshots =
    input.existingSnapshots ??
    (persist && input.sessionsDir
      ? loadAoiProactiveTrendSnapshots(input.sessionsDir, sessionPath, now)
      : []);
  const existingDeliveryEvents =
    input.existingDeliveryEvents ??
    (persist && input.sessionsDir
      ? loadAoiProactiveTrendDeliveryEvents(input.sessionsDir, sessionPath, now)
      : []);

  const snapshotsFromCandidates = (input.candidates ?? [])
    .map((candidate) =>
      buildAoiProactiveTrendSnapshotFromCandidate({
        sessionPath,
        candidate,
        watch: findWatchForCandidate(watchProfile, candidate),
        readiness,
        feedback: input.feedback,
        policy: input.policy,
        existingSnapshots,
        existingDeliveryEvents,
        now,
        sourceStaleAfterMs: input.sourceStaleAfterMs,
        directChatBudgetExhausted: input.directChatBudgetExhausted,
        directChatConfidenceFloorRelief: input.directChatConfidenceFloorRelief,
      }),
    )
    .filter((snapshot): snapshot is AoiProactiveTrendSnapshot => snapshot !== null);

  if (persist && input.sessionsDir) {
    for (const snapshot of snapshotsFromCandidates) {
      upsertAoiProactiveTrendSnapshot(input.sessionsDir, snapshot, now);
    }
  }

  const storedSnapshots =
    persist && input.sessionsDir
      ? loadAoiProactiveTrendSnapshots(input.sessionsDir, sessionPath, now)
      : existingSnapshots;
  const byId = new Map<string, AoiProactiveTrendSnapshot>();
  for (const snapshot of [...storedSnapshots, ...snapshotsFromCandidates]) {
    if (snapshot.expiresAt > now) {
      byId.set(snapshot.id, snapshot);
    }
  }
  const snapshots = [...byId.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.confidence - left.confidence)
    .slice(0, MAX_TREND_STATE_SNAPSHOTS);
  const opinionCards = snapshots
    .filter((snapshot) => snapshot.sources.length > 0 && snapshot.evidenceRefs.length > 0)
    .map(cardFromSnapshot)
    .slice(0, MAX_TREND_OPINION_CARDS);
  const inlineCard =
    opinionCards.find((card) => card.deliveryMode === 'inline_card') ??
    opinionCards.find((card) => card.deliveryMode === 'quiet_notification') ??
    undefined;
  const directChatCard =
    opinionCards.find((card) => card.deliveryMode === 'direct_chat' && card.chatHookText) ??
    undefined;
  const chatHook = directChatCard?.chatHookText;
  const deliveryControlBlockedReasons = unique(
    snapshots.flatMap((snapshot) =>
      snapshot.delivery.controls.reasons.filter((reason) =>
        /duplicate|delivery_event_recently_recorded|quiet_control_active|snoozed/.test(reason),
      ),
    ),
  ).slice(0, 16);
  const recentDeliveryEvents = existingDeliveryEvents.slice(0, MAX_TREND_STATE_DELIVERY_EVENTS);
  const deliveryAuditSummary = buildAoiProactiveTrendDeliveryAuditSummary(recentDeliveryEvents);

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    watchProfile,
    snapshots,
    opinionCards,
    quietNotificationCount: opinionCards.filter(
      (card) => card.deliveryMode === 'quiet_notification' || card.deliveryMode === 'inline_card',
    ).length,
    directChatHookCount: opinionCards.filter((card) => card.deliveryMode === 'direct_chat').length,
    sourceQualityCounts: countByStatus(snapshots.map((snapshot) => snapshot.sourceQuality.status)),
    interestDriftCounts: countByStatus(snapshots.map((snapshot) => snapshot.interestDrift.status)),
    deliveryControlBlockedReasons,
    recentDeliveryEvents,
    deliveryAuditSummary,
    ...(inlineCard ? { inlineCard } : {}),
    ...(directChatCard && chatHook ? { directChatCard, chatHook } : {}),
    readiness,
    evidenceRefs: unique([
      ...watchProfile.evidenceRefs,
      ...readiness.evidenceRefs,
      ...snapshots.flatMap((snapshot) => snapshot.evidenceRefs.slice(0, 4)),
    ]).slice(0, 32),
  };
}

function diagnostic(params: {
  code: AoiProactiveBriefDiagnosticCode;
  severity: AoiOperatorHealthSeverity;
  capability: AoiOperatorHealthCapability;
  summary: string;
  cannotKnow: string;
  evidenceRefs: string[];
  observedAt: number;
}): AoiProactiveBriefDiagnostic {
  return {
    version: 1,
    code: params.code,
    severity: params.severity,
    capability: params.capability,
    summary: sanitizeText(params.summary, 260),
    cannotKnow: sanitizeText(params.cannotKnow, 260),
    evidenceRefs: unique(
      params.evidenceRefs.map((ref) => sanitizeText(ref, 180)).filter(Boolean),
    ).slice(0, 12),
    observedAt: params.observedAt,
  };
}

export function buildAoiProactiveTrendAdvisorDiagnostics(
  input: BuildAoiProactiveTrendAdvisorDiagnosticsInput,
): AoiProactiveBriefDiagnostic[] {
  const now = input.now ?? Date.now();
  const state = input.state ?? null;
  if (!state) {
    return [];
  }
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  if (state.watchProfile.topicWatches.length === 0) {
    diagnostics.push(
      diagnostic({
        code: 'trend_watch_profile_empty',
        severity: 'info',
        capability: 'memory',
        summary: 'Trend advisor has no eligible interest watches yet.',
        cannotKnow:
          'Aoi cannot choose proactive trend topics until an interest profile exists from memory or explicit feedback.',
        evidenceRefs: ['trend-advisor:watch-profile'],
        observedAt: state.generatedAt || now,
      }),
    );
  }
  if (
    input.tavilyConfigured !== true &&
    state.watchProfile.topicWatches.some((watch) => watch.cadence !== 'manual')
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_provider_missing',
        severity: 'warning',
        capability: 'research',
        summary:
          'Trend advisor can build local watch profiles, but fresh public scouting is not configured.',
        cannotKnow:
          'Aoi cannot know current public trends for these interests without a configured current-info provider.',
        evidenceRefs: ['trend-advisor:provider', ...state.watchProfile.evidenceRefs.slice(0, 4)],
        observedAt: state.generatedAt || now,
      }),
    );
  }
  if (state.snapshots.some((snapshot) => snapshot.freshness === 'stale')) {
    diagnostics.push(
      diagnostic({
        code: 'trend_snapshot_stale',
        severity: 'warning',
        capability: 'research',
        summary: 'At least one trend snapshot is stale and is blocked from direct chat.',
        cannotKnow:
          'Aoi cannot present stale source evidence as a latest trend until the scout refreshes it.',
        evidenceRefs: state.snapshots
          .filter((snapshot) => snapshot.freshness === 'stale')
          .flatMap((snapshot) => snapshot.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (
    state.snapshots.some((snapshot) =>
      snapshot.delivery.directChatBlockedReasons.includes('weak_source_evidence'),
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_weak_evidence',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Some trend opinion cards remain dashboard-only because source evidence is weak.',
        cannotKnow:
          'Aoi cannot justify direct chat from weak or single-source evidence even when the topic matches interest memory.',
        evidenceRefs: state.snapshots.flatMap((snapshot) => snapshot.evidenceRefs.slice(0, 2)),
        observedAt: now,
      }),
    );
  }
  if (
    state.snapshots.some(
      (snapshot) =>
        snapshot.sourceQuality.status === 'weak' || snapshot.sourceQuality.status === 'blocked',
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_source_quality_weak',
        severity: 'info',
        capability: 'replay_evaluation',
        summary:
          'Some trend cards remain low-interruption because source quality scoring is weak or blocked.',
        cannotKnow:
          'Aoi cannot safely promote weak, private, or poorly corroborated source evidence into proactive chat.',
        evidenceRefs: state.snapshots
          .filter(
            (snapshot) =>
              snapshot.sourceQuality.status === 'weak' ||
              snapshot.sourceQuality.status === 'blocked',
          )
          .flatMap((snapshot) => snapshot.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (state.snapshots.some((snapshot) => snapshot.novelty.status === 'repeat')) {
    diagnostics.push(
      diagnostic({
        code: 'trend_repeat_snapshot',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Some trend snapshots repeat recent evidence and are suppressed from direct chat.',
        cannotKnow:
          'Aoi cannot treat repeated source URLs or titles as new trends until fresh evidence appears.',
        evidenceRefs: state.snapshots
          .filter((snapshot) => snapshot.novelty.status === 'repeat')
          .flatMap((snapshot) => snapshot.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (state.snapshots.some((snapshot) => snapshot.delivery.controls.duplicateBlocked)) {
    diagnostics.push(
      diagnostic({
        code: 'trend_duplicate_suppressed',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Duplicate trend delivery was suppressed before reaching chat or notification.',
        cannotKnow:
          'Aoi cannot assume the operator wants repeated delivery of the same trend without fresh evidence or feedback.',
        evidenceRefs: state.snapshots
          .filter((snapshot) => snapshot.delivery.controls.duplicateBlocked)
          .flatMap((snapshot) => snapshot.delivery.controls.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (state.recentDeliveryEvents.length > 0) {
    diagnostics.push(
      diagnostic({
        code: 'trend_delivery_audit_ready',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Trend delivery audit trail is recording actual inline and chat exposure.',
        cannotKnow:
          'Aoi cannot prove a trend was surfaced across app restarts unless delivery events are recorded at the UI boundary.',
        evidenceRefs: state.deliveryAuditSummary.evidenceRefs,
        observedAt: state.deliveryAuditSummary.latestEventAt ?? now,
      }),
    );
  }
  if (
    state.snapshots.some((snapshot) =>
      snapshot.delivery.controls.reasons.includes('delivery_event_recently_recorded'),
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_delivery_audit_duplicate_suppressed',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'A previously recorded trend delivery suppressed a repeated chat or card offer.',
        cannotKnow:
          'Aoi cannot repeat the same trend just because the app restarted when a delivery event already proves it was surfaced.',
        evidenceRefs: state.snapshots
          .filter((snapshot) =>
            snapshot.delivery.controls.reasons.includes('delivery_event_recently_recorded'),
          )
          .flatMap((snapshot) => snapshot.delivery.controls.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (
    state.snapshots.some(
      (snapshot) =>
        Boolean(snapshot.delivery.controls.quietUntil) ||
        Boolean(snapshot.delivery.controls.snoozedUntil),
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_quiet_control_active',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Trend quiet or snooze controls are actively suppressing interruption.',
        cannotKnow:
          'Aoi cannot interrupt during an active quiet or snooze window unless the operator changes feedback controls.',
        evidenceRefs: state.snapshots.flatMap((snapshot) =>
          snapshot.delivery.controls.evidenceRefs.slice(0, 2),
        ),
        observedAt: now,
      }),
    );
  }
  if (state.snapshots.some((snapshot) => snapshot.interestDrift.status === 'watch')) {
    diagnostics.push(
      diagnostic({
        code: 'trend_interest_drift_watch',
        severity: 'info',
        capability: 'memory',
        summary: 'Some trend topics need additional feedback before direct chat escalation.',
        cannotKnow:
          'Aoi cannot know whether this interest is still strongly desired until more operator feedback is recorded.',
        evidenceRefs: state.snapshots
          .filter((snapshot) => snapshot.interestDrift.status === 'watch')
          .flatMap((snapshot) => snapshot.interestDrift.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (
    state.snapshots.some(
      (snapshot) =>
        snapshot.interestDrift.status === 'drifting' || snapshot.interestDrift.status === 'muted',
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_interest_drift_detected',
        severity: 'warning',
        capability: 'memory',
        summary: 'Some trend topics appear drifted or muted and are blocked from proactive chat.',
        cannotKnow:
          'Aoi cannot safely assume a drifted or muted topic remains worth direct interruption.',
        evidenceRefs: state.snapshots
          .filter(
            (snapshot) =>
              snapshot.interestDrift.status === 'drifting' ||
              snapshot.interestDrift.status === 'muted',
          )
          .flatMap((snapshot) => snapshot.interestDrift.evidenceRefs.slice(0, 3)),
        observedAt: now,
      }),
    );
  }
  if (
    input.tavilyConfigured === true &&
    state.snapshots.some((snapshot) => snapshot.sourceQuality.status === 'strong')
  ) {
    diagnostics.push(
      diagnostic({
        code: 'trend_provider_smoke_ready',
        severity: 'info',
        capability: 'research',
        summary: 'Current-info provider evidence can feed source-backed trend snapshots.',
        cannotKnow:
          'Aoi still cannot know future trend changes after the last provider retrieval timestamp.',
        evidenceRefs: state.snapshots
          .filter((snapshot) => snapshot.sourceQuality.status === 'strong')
          .flatMap((snapshot) => snapshot.evidenceRefs.slice(0, 3)),
        observedAt: state.generatedAt || now,
      }),
    );
  }
  if (state.quietNotificationCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'trend_quiet_notification_ready',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: `${state.quietNotificationCount} trend item(s) are ready for quiet notification or inline card delivery.`,
        cannotKnow:
          'Aoi still cannot know whether the operator wants stronger interruption without direct-chat readiness and feedback.',
        evidenceRefs: state.opinionCards
          .filter(
            (card) =>
              card.deliveryMode === 'quiet_notification' || card.deliveryMode === 'inline_card',
          )
          .flatMap((card) => card.evidenceRefs.slice(0, 2)),
        observedAt: state.generatedAt || now,
      }),
    );
  }
  if (state.opinionCards.length > 0) {
    diagnostics.push(
      diagnostic({
        code: 'trend_opinion_cards_ready',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: `${state.opinionCards.length} source-backed trend opinion card(s) are ready for quiet dashboard delivery.`,
        cannotKnow:
          'Aoi still cannot know whether the operator wants a direct interruption without opt-in and field readiness.',
        evidenceRefs: state.opinionCards.flatMap((card) => card.evidenceRefs.slice(0, 2)),
        observedAt: state.generatedAt || now,
      }),
    );
  }
  if (state.directChatHookCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'trend_direct_chat_ready',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: `${state.directChatHookCount} trend item(s) can be delivered through direct chat.`,
        cannotKnow:
          'Aoi cannot know the operator will value the interruption until feedback is recorded after delivery.',
        evidenceRefs: state.directChatCard?.evidenceRefs ?? state.readiness.evidenceRefs,
        observedAt: state.generatedAt || now,
      }),
    );
  }
  if (!state.readiness.directChatReady) {
    diagnostics.push(
      diagnostic({
        code: 'trend_direct_chat_not_ready',
        severity: state.readiness.status === 'blocked' ? 'warning' : 'info',
        capability: 'replay_evaluation',
        summary:
          'Trend advisor direct chat remains blocked by policy, field evidence, or feedback gates.',
        cannotKnow:
          'Aoi cannot safely initiate unsolicited trend chat until direct chat readiness passes and each card has strong source evidence.',
        evidenceRefs: state.readiness.evidenceRefs,
        observedAt: state.generatedAt || now,
      }),
    );
  }
  return diagnostics;
}
