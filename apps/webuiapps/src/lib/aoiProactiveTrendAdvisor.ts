import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { redactAoiSensitiveContent } from './aoiMemoryShared';
import {
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
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
  AoiProactiveTrendOpinionCard,
  AoiProactiveTrendSnapshot,
  AoiProactiveTrendSnapshotFreshness,
  AoiProactiveTrendSnapshotIndex,
  AoiProactiveTrendSnapshotIndexEntry,
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
const MAX_TREND_STATE_SNAPSHOTS = 24;
const MAX_TREND_OPINION_CARDS = 6;
const DEFAULT_TREND_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_DIRECT_CHAT_FIELD_SAMPLE_COUNT = 3;

export interface AoiProactiveTrendPaths {
  root: string;
  trendsDir: string;
  watchProfile: string;
  snapshotsDir: string;
  snapshotIndex: string;
}

export interface BuildAoiProactiveTrendAdvisorStateInput {
  sessionsDir?: string;
  sessionPath: string;
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  candidates?: AoiProactiveBriefCandidate[];
  feedback?: AoiProactiveBriefFeedback[];
  fieldMetrics?: AoiProactiveBriefFieldMetrics | null;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  now?: number;
  persist?: boolean;
  sourceStaleAfterMs?: number;
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
  };
  for (const target of [
    paths.trendsDir,
    paths.watchProfile,
    paths.snapshotsDir,
    paths.snapshotIndex,
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

export function buildAoiProactiveTrendWatchProfile(params: {
  sessionPath: string;
  profile?: AoiInterestProfile | null;
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
  const topicWatches = topics.map((topic) => watchFromTopic(topic, now));
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

function sourceEvidenceStrong(sources: AoiProactiveBriefSource[], evidenceRefs: string[]): boolean {
  return sources.length >= 2 && evidenceRefs.length > 0;
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

function directChatBlockReasons(params: {
  candidate: AoiProactiveBriefCandidate;
  watch: AoiProactiveTrendWatchTopic | null;
  policy?: AoiAutonomyPolicy | null;
  readiness: AoiProactiveTrendAdvisorReadiness;
  feedback: AoiProactiveBriefFeedback[];
  freshness: AoiProactiveTrendSnapshotFreshness;
  sourceStrong: boolean;
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
  }
  if (params.candidate.confidence < Math.max(0.55, params.policy?.confidenceFloor ?? 0.55)) {
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
  now?: number;
  sourceStaleAfterMs?: number;
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
  const sourceStrong = sourceEvidenceStrong(sources, evidenceRefs);
  const blockReasons = directChatBlockReasons({
    candidate,
    watch: params.watch,
    policy: params.policy,
    readiness: params.readiness,
    feedback: params.feedback ?? [],
    freshness,
    sourceStrong,
    now,
  });
  const topicId = params.watch?.topicId ?? sanitizeText(candidate.topicId, 120);
  const topicLabel = params.watch?.topicLabel ?? sanitizeText(candidate.topicLabel, 80);
  const opinion = snapshotOpinionFields({ candidate, freshness, sourceStrong });
  const confidence = clampScore(
    candidate.confidence +
      (sourceStrong ? 0.04 : -0.15) +
      (freshness === 'fresh' ? 0.04 : freshness === 'stale' ? -0.24 : -0.08) +
      (params.watch ? 0.04 : -0.2),
    0.55,
  );
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
    risk: normalizeRisk(candidate.risk),
    freshness,
    sources,
    delivery: {
      directChatAllowed: blockReasons.length === 0,
      directChatBlockedReasons: blockReasons,
    },
    evidenceRefs,
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
    noveltyScore: clampScore(raw.noveltyScore, 0.5),
    risk: normalizeRisk(raw.risk),
    freshness: normalizeFreshness(raw.freshness),
    sources: normalizeSources(raw.sources, now),
    delivery: {
      directChatAllowed: raw.delivery?.directChatAllowed === true,
      directChatBlockedReasons: normalizeStringList(
        raw.delivery?.directChatBlockedReasons,
        16,
        120,
      ),
    },
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24, 180),
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

function cardFromSnapshot(snapshot: AoiProactiveTrendSnapshot): AoiProactiveTrendOpinionCard {
  const sourceHosts = unique(snapshot.sources.map((source) => source.host)).slice(0, 6);
  return {
    version: 1,
    id: makeStableId('aoi-trend-card', `${snapshot.id}:${snapshot.updatedAt}`),
    snapshotId: snapshot.id,
    topicId: snapshot.topicId,
    topicLabel: snapshot.topicLabel,
    title: snapshot.title,
    whatChanged: snapshot.whatChanged,
    whyItMatters: snapshot.whyItMatters,
    myTake: snapshot.myTake,
    suggestedNextAction: snapshot.suggestedNextAction,
    confidenceLabel: confidenceLabel(snapshot.confidence),
    freshnessLabel: freshnessLabel(snapshot.freshness),
    sourceHosts,
    directChatAllowed: snapshot.delivery.directChatAllowed,
    directChatBlockedReasons: snapshot.delivery.directChatBlockedReasons,
    evidenceRefs: snapshot.evidenceRefs.slice(0, 16),
    createdAt: snapshot.updatedAt,
  };
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

  const snapshotsFromCandidates = (input.candidates ?? [])
    .map((candidate) =>
      buildAoiProactiveTrendSnapshotFromCandidate({
        sessionPath,
        candidate,
        watch: findWatchForCandidate(watchProfile, candidate),
        readiness,
        feedback: input.feedback,
        policy: input.policy,
        now,
        sourceStaleAfterMs: input.sourceStaleAfterMs,
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
      : [];
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

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    watchProfile,
    snapshots,
    opinionCards,
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
