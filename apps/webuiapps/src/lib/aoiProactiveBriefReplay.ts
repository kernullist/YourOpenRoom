import { DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import type {
  AoiAutonomySchedulerState,
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiOperatorHealthCapability,
  AoiOperatorHealthSeverity,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCalibrationLabel,
  AoiProactiveBriefCalibrationLabelRecord,
  AoiProactiveBriefCalibrationTuning,
  AoiProactiveBriefCooldownEntry,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefFieldEvent,
  AoiProactiveBriefFieldMetrics,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFeedbackCategory,
} from './aoiAutonomyTypes';
import { redactAoiSensitiveContent } from './aoiMemoryShared';
import {
  AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
  planAoiProactiveBriefTopics,
  type AoiProactiveBriefSkippedTopic,
} from './aoiProactiveBriefPlanner';
import {
  decideAoiProactiveBriefDelivery,
  type AoiProactiveBriefDeliveryContext,
  type AoiProactiveBriefDeliveryDecision,
  type AoiProactiveBriefDeliverySuppressionReason,
} from './aoiProactiveBriefPolicy';
import {
  scoutAoiProactiveBriefTopic,
  type AoiProactiveBriefRawSearchResult,
  type AoiProactiveBriefSearchAdapter,
  type AoiProactiveBriefSourceFreshness,
} from './aoiProactiveBriefResearch';
import { buildAoiProactiveBriefPanelModel } from './aoiProactiveBriefUi';

const DEFAULT_NOW = Date.parse('2026-06-19T00:00:00.000Z');
const DEFAULT_SESSION_PATH = 'aoi/default';
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type AoiProactiveBriefReplayScenario =
  | 'fresh_public_sources'
  | 'tavily_missing'
  | 'quiet_mode'
  | 'too_frequent_feedback'
  | 'stale_sources'
  | 'private_memory_excluded'
  | 'useful_feedback_with_cooldown'
  | 'wrong_topic_feedback';

export type AoiProactiveBriefReplayMetricName =
  | 'candidate_precision'
  | 'source_freshness'
  | 'interruption_policy'
  | 'feedback_adaptation'
  | 'privacy_redaction'
  | 'no_fabricated_current_info';

export type AoiProactiveBriefDiagnosticCode =
  | 'tavily_unavailable'
  | 'source_freshness_stale'
  | 'no_eligible_topics'
  | 'all_topics_muted'
  | 'cooldown_suppressed_all_candidates'
  | 'direct_chat_disabled_by_policy'
  | 'field_not_tested'
  | 'field_private_leak_detected'
  | 'field_unauthorized_mutation_detected'
  | 'field_stale_current_claim_detected'
  | 'field_readiness_measuring'
  | 'field_readiness_ready'
  | 'field_direct_chat_not_ready'
  | 'field_replay_candidates_ready'
  | 'calibration_not_labeled'
  | 'calibration_tuning_active'
  | 'calibration_stale_direct_chat_block'
  | 'calibration_unsafe_label_blocker'
  | 'scout_provider_missing'
  | 'scout_provider_failed'
  | 'scout_network_disabled'
  | 'scout_budget_exhausted'
  | 'scout_no_eligible_topics'
  | 'scout_all_topics_muted'
  | 'scout_cooldown_active'
  | 'scout_quiet_window_active'
  | 'scout_direct_chat_disabled'
  | 'scout_unsafe_label_blocker'
  | 'scout_stale_source_blocker'
  | 'scout_no_candidate';

export interface AoiProactiveBriefReplayMetric {
  name: AoiProactiveBriefReplayMetricName;
  passed: boolean;
  expected: string;
  actual: string;
  evidenceRefs: string[];
}

export interface AoiProactiveBriefDiagnostic {
  version: 1;
  code: AoiProactiveBriefDiagnosticCode;
  severity: AoiOperatorHealthSeverity;
  capability: AoiOperatorHealthCapability;
  summary: string;
  cannotKnow: string;
  evidenceRefs: string[];
  observedAt: number;
}

export interface AoiProactiveBriefReplayCandidateSummary {
  id: string;
  topicId: string;
  topicLabel: string;
  title: string;
  sourceCount: number;
  sourceHosts: string[];
  freshnessCannotKnow: string[];
  selectedMode: AoiProactiveBriefDeliveryDecision['selectedMode'];
  deliveryScore: number;
  chatHookAllowed: boolean;
  chatHookReasons: AoiProactiveBriefDeliverySuppressionReason[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReplayReport {
  version: 1;
  fixtureId: string;
  title: string;
  scenario: AoiProactiveBriefReplayScenario;
  generatedAt: number;
  passed: boolean;
  summary: string;
  metrics: AoiProactiveBriefReplayMetric[];
  candidates: AoiProactiveBriefReplayCandidateSummary[];
  candidateCount: number;
  visibleCardCount: number;
  warningLabels: string[];
  diagnosticLabels: AoiProactiveBriefDiagnosticCode[];
  diagnostics: AoiProactiveBriefDiagnostic[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReplayFixture {
  id: string;
  title: string;
  scenario: AoiProactiveBriefReplayScenario;
  now?: number;
  profile: AoiInterestProfile;
  policy?: AoiAutonomyPolicy;
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState;
  context?: AoiProactiveBriefDeliveryContext;
  searchResults?: AoiProactiveBriefRawSearchResult[];
  searchWarning?: string;
  skipSearch?: boolean;
  sourceStaleAfterMs?: number;
  directCandidates?: AoiProactiveBriefCandidate[];
  expectedPrivateTextAbsent?: string[];
}

export type AoiProactiveBriefReplayDraftStatus =
  | 'promoted_candidate'
  | 'blocked_private_leak'
  | 'blocked_unauthorized_mutation'
  | 'blocked_stale_current_claim'
  | 'blocked_unlabeled'
  | 'blocked_no_field_event'
  | 'blocked_no_source_evidence'
  | 'blocked_replay_failed';

export interface AoiProactiveBriefReplayFixtureDraft {
  version: 1;
  id: string;
  sessionPath: string;
  fieldEventId: string;
  calibrationLabelId: string;
  label: AoiProactiveBriefCalibrationLabel;
  status: AoiProactiveBriefReplayDraftStatus;
  fixture: AoiProactiveBriefReplayFixture;
  validation: {
    deterministicClock: boolean;
    noNetworkDependency: boolean;
    rawPrivateTextAbsent: boolean;
    hasSourceEvidence: boolean;
    expectedOutcome: string;
    blockers: string[];
  };
  redaction: {
    applied: boolean;
    removedPrivateFieldCount: number;
    removedRefs: string[];
  };
  evidenceRefs: string[];
  createdAt: number;
}

export interface BuildAoiProactiveBriefReplayPromotionDraftsInput {
  sessionPath: string;
  events: AoiProactiveBriefFieldEvent[];
  labels: AoiProactiveBriefCalibrationLabelRecord[];
  candidates?: AoiProactiveBriefCandidate[];
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  now?: number;
  maxDrafts?: number;
}

export type AoiProactiveBriefReadinessStatus =
  | 'ready'
  | 'blocked'
  | 'not_field_tested'
  | 'measuring';

export type AoiProactiveBriefDirectChatReadiness =
  | 'eligible_opt_in'
  | 'disabled_by_policy'
  | 'not_field_tested'
  | 'blocked_private_or_unsafe'
  | 'blocked_stale_current_claim'
  | 'lowered_by_feedback'
  | 'measuring';

export type AoiProactiveBriefCurrentProviderFreshnessState =
  | 'configured'
  | 'missing_provider'
  | 'not_required'
  | 'unknown';

export interface AoiProactiveBriefReadinessGate {
  id: string;
  status: 'pass' | 'warn' | 'block';
  summary: string;
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReadinessSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  status: AoiProactiveBriefReadinessStatus;
  sampleCount: number;
  minimumSampleCount: number;
  counts: {
    useful: number;
    tooFrequent: number;
    wrongTopic: number;
    wrongTiming: number;
    stale: number;
    unsafe: number;
    privateLeak: number;
    unauthorizedMutation: number;
    staleCurrentClaim: number;
  };
  suppressionCounts: Record<string, number>;
  replayPromotionCandidateCount: number;
  directChatReadiness: AoiProactiveBriefDirectChatReadiness;
  currentProviderFreshnessState: AoiProactiveBriefCurrentProviderFreshnessState;
  gates: AoiProactiveBriefReadinessGate[];
  summary: string;
  evidenceRefs: string[];
}

export interface BuildAoiProactiveBriefReadinessSummaryInput {
  sessionPath: string;
  metrics?: AoiProactiveBriefFieldMetrics | null;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  replayDrafts?: AoiProactiveBriefReplayFixtureDraft[];
  policy?: AoiAutonomyPolicy | null;
  tavilyConfigured?: boolean;
  now?: number;
  minimumSampleCount?: number;
}

export interface BuildAoiProactiveBriefDiagnosticsInput {
  profile?: AoiInterestProfile | null;
  candidates?: AoiProactiveBriefCandidate[];
  decisions?: AoiProactiveBriefDeliveryDecision[];
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState | null;
  scoutWarnings?: string[];
  skippedTopics?: AoiProactiveBriefSkippedTopic[];
  sourceFreshness?: AoiProactiveBriefSourceFreshness[];
  now?: number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

const MIN_FIELD_READINESS_SAMPLE_COUNT = 3;
const MAX_PROMOTED_REPLAY_DRAFTS = 8;

function stableHashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalizeReplayWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeReplayText(value: string | undefined, maxChars: number): string {
  const redacted = redactAoiSensitiveContent(value ?? '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
    .replace(/(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g, '[redacted-path]')
    .replace(
      /\b(?:raw|full|private|secret)[^.!?\n]{0,120}\b(?:body|note|message|mail|email)[^.!?\n]*/gi,
      '[redacted-private-note]',
    );
  const normalized = normalizeReplayWhitespace(redacted);
  return normalized.slice(0, maxChars);
}

function extractPrivateFragments(value: string): string[] {
  const fragments = new Set<string>();
  const patterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g,
    /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g,
    /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/gi,
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*['"]?[^'"\s,;]{4,}/gi,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (match[0] && !/redacted/i.test(match[0])) {
        fragments.add(match[0]);
      }
    }
  }
  return [...fragments].slice(0, 24);
}

function sanitizeHost(value: string | undefined): string | null {
  const normalized = normalizeReplayWhitespace(value ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    ?.replace(/[^a-z0-9.-]/g, '');
  if (
    !normalized ||
    normalized === 'localhost' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.endsWith('.local')
  ) {
    return null;
  }
  return normalized.slice(0, 80);
}

function hostFromRef(value: string): string | null {
  try {
    if (/^https?:\/\//i.test(value)) {
      return sanitizeHost(new URL(value).host);
    }
  } catch {
    return null;
  }
  const sourceHost = value.match(/^source:([^:/\s]+)/i)?.[1];
  return sanitizeHost(sourceHost);
}

function sourceHostsForReplay(
  event: AoiProactiveBriefFieldEvent,
  candidate: AoiProactiveBriefCandidate | null,
): string[] {
  return unique([
    ...((candidate?.sources.map((source) => sanitizeHost(source.host)).filter(Boolean) ??
      []) as string[]),
    ...event.sourceHosts.map(sanitizeHost).filter((host): host is string => Boolean(host)),
    ...event.sourceRefs.map(hostFromRef).filter((host): host is string => Boolean(host)),
  ]).slice(0, 4);
}

function sanitizeReplayRef(value: string): string {
  const host = hostFromRef(value);
  if (host) {
    return `source:${host}:field-fixture`;
  }
  if (/^memory:/i.test(value) || /^aoi-memory/i.test(value)) {
    return 'memory:redacted-field-signal';
  }
  if (/(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/)/.test(value)) {
    return 'field:redacted-path';
  }
  const redacted = sanitizeReplayText(value, 120);
  return redacted || 'field:redacted-ref';
}

function sanitizeReplayRefs(values: string[], maxItems: number): string[] {
  return unique(values.map(sanitizeReplayRef)).slice(0, maxItems);
}

function replaySourceForHost(params: {
  host: string;
  seed: string;
  title?: string;
  snippet?: string;
  now: number;
  newestSourceAt?: string;
}): AoiProactiveBriefCandidate['sources'][number] {
  return {
    title: sanitizeReplayText(params.title, 120) || `Field replay source for ${params.host}`,
    url: `https://${params.host}/aoi-replay/${stableHashText(params.seed)}`,
    host: params.host,
    publishedAt: params.newestSourceAt,
    retrievedAt: params.now,
    snippet:
      sanitizeReplayText(params.snippet, 220) ||
      'Redacted field fixture metadata for a proactive brief source.',
  };
}

function labelToFeedbackCategory(
  label: AoiProactiveBriefCalibrationLabel,
): AoiProactiveBriefFeedbackCategory {
  return label;
}

function labelExpectedOutcome(label: AoiProactiveBriefCalibrationLabel): string {
  switch (label) {
    case 'useful':
    case 'show_more':
    case 'pin_topic':
      return 'Positive feedback keeps the source-backed candidate replayable while policy gates stay active.';
    case 'too_frequent':
      return 'Too-frequent feedback keeps cooldown or recent-negative suppression active.';
    case 'wrong_topic':
      return 'Wrong-topic feedback lowers delivery relevance under deterministic replay.';
    case 'wrong_timing':
      return 'Wrong-timing feedback lowers direct interruption confidence.';
    case 'stale':
      return 'Stale feedback blocks direct chat until fresh evidence is available.';
    case 'unsafe':
      return 'Unsafe feedback blocks direct chat escalation for affected topics or sources.';
    case 'show_less':
    case 'mute_topic':
      return 'Negative preference feedback keeps delivery conservative.';
    default:
      return 'The labeled field example remains replayable without live network access.';
  }
}

function scenarioForLabel(
  label: AoiProactiveBriefCalibrationLabel,
  providerMissing: boolean,
): AoiProactiveBriefReplayScenario {
  if (providerMissing) {
    return 'tavily_missing';
  }
  if (label === 'stale' || label === 'unsafe') {
    return 'stale_sources';
  }
  if (label === 'wrong_topic') {
    return 'wrong_topic_feedback';
  }
  if (label === 'useful' || label === 'show_more' || label === 'pin_topic') {
    return 'useful_feedback_with_cooldown';
  }
  return 'too_frequent_feedback';
}

function eventMadeStaleCurrentClaim(event: AoiProactiveBriefFieldEvent): boolean {
  return (
    event.freshness.stale &&
    (event.kind === 'shown_dashboard' ||
      event.kind === 'shown_digest' ||
      event.kind === 'shown_inline' ||
      event.kind === 'chat_hook_offered' ||
      event.kind === 'expanded' ||
      event.kind === 'source_opened')
  );
}

function eventLooksProviderMissing(event: AoiProactiveBriefFieldEvent): boolean {
  const text = [
    event.policyReason ?? '',
    ...event.suppressionReasons,
    ...event.freshness.cannotKnow,
    event.summary ?? '',
  ].join(' ');
  return /tavily|provider|current-info|current information|cannot refresh|missing/i.test(text);
}

function replayTopicForField(
  event: AoiProactiveBriefFieldEvent,
  label: AoiProactiveBriefCalibrationLabelRecord,
  candidate: AoiProactiveBriefCandidate | null,
  now: number,
): AoiInterestTopic {
  const topicId =
    candidate?.topicId ??
    label.topicId ??
    event.topicId ??
    `aoi-interest-field-${stableHashText(event.id)}`;
  return makeTopic({
    id: topicId,
    sessionPath: event.sessionPath,
    label:
      sanitizeReplayText(candidate?.topicLabel ?? event.topicId ?? label.topicId, 80) ||
      'Field Replay Topic',
    normalizedLabel:
      sanitizeReplayText(
        candidate?.topicLabel ?? event.topicId ?? label.topicId,
        80,
      ).toLowerCase() || 'field replay topic',
    aliases: [],
    memoryIds: candidate?.memoryIds.length ? ['memory-redacted-field-signal'] : [],
    evidenceRefs: sanitizeReplayRefs(
      [...(candidate?.evidenceRefs ?? []), ...event.evidenceRefs, ...label.evidenceRefs],
      8,
    ),
    confidence: candidate?.confidence ?? 0.76,
    importance: 0.74,
    pinned: label.label === 'pin_topic',
    muted: label.label === 'mute_topic',
    cooldownKey: candidate?.cooldownKey ?? `interest:${topicId}`,
    createdAt: Math.min(event.createdAt, label.createdAt, now),
    updatedAt: Math.max(event.createdAt, label.createdAt, now),
  });
}

function sanitizedCandidateForReplay(params: {
  event: AoiProactiveBriefFieldEvent;
  label: AoiProactiveBriefCalibrationLabelRecord;
  candidate: AoiProactiveBriefCandidate | null;
  now: number;
}): AoiProactiveBriefCandidate {
  const { event, label, candidate, now } = params;
  const topic = replayTopicForField(event, label, candidate, now);
  const hosts = sourceHostsForReplay(event, candidate);
  const stale = event.freshness.stale || label.label === 'stale' || label.label === 'unsafe';
  const newestSourceAt = stale
    ? new Date(now - DEFAULT_SOURCE_STALE_AFTER_MS - 60_000).toISOString()
    : (event.freshness.newestSourceAt ??
      candidate?.freshness.newestSourceAt ??
      new Date(now - 86_400_000).toISOString());
  const sources = hosts.map((host, index) =>
    replaySourceForHost({
      host,
      seed: `${event.id}:${label.id}:${host}:${index}`,
      title: candidate?.sources[index]?.title ?? event.title,
      snippet: candidate?.sources[index]?.snippet ?? event.summary,
      now,
      newestSourceAt,
    }),
  );
  const title =
    sanitizeReplayText(candidate?.title ?? event.title, 120) || 'Redacted field replay brief';
  const summary =
    sanitizeReplayText(candidate?.summary ?? event.summary, 240) ||
    'Redacted field replay summary generated from proactive brief metadata.';
  const hook =
    sanitizeReplayText(candidate?.hook ?? event.summary ?? event.title, 140) ||
    'A source-backed proactive brief is ready for review.';

  return {
    version: 1,
    id: `aoi-brief-field-replay-${stableHashText(`${event.id}:${label.id}`)}`,
    sessionPath: event.sessionPath,
    topicId: topic.id,
    topicLabel: topic.label,
    status: 'candidate',
    title,
    hook,
    summary,
    whyForOperator:
      sanitizeReplayText(candidate?.whyForOperator, 180) ||
      `This field example was labeled ${label.label} by the operator.`,
    noveltyReason:
      sanitizeReplayText(candidate?.noveltyReason, 180) ||
      'The replay keeps only redacted source metadata from the field event.',
    sources,
    evidenceRefs: unique([
      ...sources.map((source) => `source:${source.host}:field-fixture`),
      ...sanitizeReplayRefs(
        [...event.evidenceRefs, ...label.evidenceRefs, ...(candidate?.evidenceRefs ?? [])],
        12,
      ),
    ]).slice(0, 16),
    memoryIds: candidate?.memoryIds.length ? ['memory-redacted-field-signal'] : [],
    score: label.label === 'wrong_topic' ? 0.58 : (candidate?.score ?? 0.82),
    confidence: label.label === 'wrong_topic' ? 0.62 : (candidate?.confidence ?? 0.84),
    risk: label.label === 'unsafe' ? 'medium' : (candidate?.risk ?? 'low'),
    freshness: {
      searchedAt: event.freshness.searchedAt ?? candidate?.freshness.searchedAt ?? event.createdAt,
      newestSourceAt,
      cannotKnow: unique([
        ...event.freshness.cannotKnow.map((item) => sanitizeReplayText(item, 140)).filter(Boolean),
        ...(candidate?.freshness.cannotKnow
          .map((item) => sanitizeReplayText(item, 140))
          .filter(Boolean) ?? []),
        ...(stale ? ['Field label requires fresh evidence before direct chat.'] : []),
      ]).slice(0, 8),
    },
    delivery: {
      allowedModes: candidate?.delivery.allowedModes ?? [
        'dashboard',
        'digest',
        'inline_card',
        'chat_hook',
      ],
    },
    cooldownKey: candidate?.cooldownKey ?? topic.cooldownKey,
    dedupeKey: `field-replay:${stableHashText(`${event.id}:${label.id}`)}`,
    createdAt: event.createdAt,
    updatedAt: now,
    expiresAt: now + 14 * 24 * 60 * 60 * 1000,
  };
}

function feedbackForCalibrationLabel(params: {
  label: AoiProactiveBriefCalibrationLabelRecord;
  candidate: AoiProactiveBriefCandidate;
  now: number;
}): AoiProactiveBriefFeedback {
  return {
    version: 1,
    id: `aoi-feedback-field-replay-${stableHashText(params.label.id)}`,
    briefId: params.candidate.id,
    topicId: params.candidate.topicId,
    sessionPath: params.label.sessionPath,
    category: labelToFeedbackCategory(params.label.label),
    createdAt: Math.min(params.label.createdAt, params.now - 60_000),
  };
}

function cooldownStateForReplayLabel(params: {
  label: AoiProactiveBriefCalibrationLabelRecord;
  candidate: AoiProactiveBriefCandidate;
  now: number;
}): AoiProactiveBriefCooldownState {
  const needsCooldown = new Set<AoiProactiveBriefCalibrationLabel>([
    'useful',
    'show_more',
    'too_frequent',
    'wrong_timing',
    'stale',
    'unsafe',
    'show_less',
    'mute_topic',
  ]).has(params.label.label);
  const entries = needsCooldown
    ? [
        makeCooldownEntry({
          cooldownKey: params.candidate.cooldownKey,
          topicId: params.candidate.topicId,
          nextAllowedAt: params.now + 60 * 60 * 1000,
          reason: `field:${params.label.label}`,
          sourceBriefIds: [params.candidate.id],
          now: params.now,
        }),
      ]
    : [];
  return {
    version: 1,
    sessionPath: params.label.sessionPath,
    updatedAt: params.now,
    cooldowns: Object.fromEntries(entries.map((entry) => [entry.cooldownKey, entry])),
  };
}

function replayBlockerStatus(blockers: string[]): AoiProactiveBriefReplayDraftStatus {
  if (blockers.includes('private_leak')) {
    return 'blocked_private_leak';
  }
  if (blockers.includes('unauthorized_mutation')) {
    return 'blocked_unauthorized_mutation';
  }
  if (blockers.includes('stale_current_claim')) {
    return 'blocked_stale_current_claim';
  }
  if (blockers.includes('unlabeled')) {
    return 'blocked_unlabeled';
  }
  if (blockers.includes('no_field_event')) {
    return 'blocked_no_field_event';
  }
  if (blockers.includes('no_source_evidence')) {
    return 'blocked_no_source_evidence';
  }
  if (blockers.length > 0) {
    return 'blocked_replay_failed';
  }
  return 'promoted_candidate';
}

export function buildAoiProactiveBriefReplayPromotionDrafts(
  input: BuildAoiProactiveBriefReplayPromotionDraftsInput,
): AoiProactiveBriefReplayFixtureDraft[] {
  const now = input.now ?? Date.now();
  const maxDrafts = input.maxDrafts ?? MAX_PROMOTED_REPLAY_DRAFTS;
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const candidatesById = new Map(
    (input.candidates ?? []).map((candidate) => [candidate.id, candidate]),
  );
  const sortedLabels = [...input.labels].sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
  const drafts: AoiProactiveBriefReplayFixtureDraft[] = [];

  for (const label of sortedLabels) {
    if (drafts.length >= maxDrafts) {
      break;
    }
    const event = eventsById.get(label.fieldEventId);
    const blockers: string[] = [];
    if (!event) {
      blockers.push('no_field_event');
      continue;
    }
    const candidate = label.briefId ? (candidatesById.get(label.briefId) ?? null) : null;
    const providerMissing = eventLooksProviderMissing(event) && event.sourceHosts.length === 0;
    const replayCandidate = sanitizedCandidateForReplay({
      event,
      label,
      candidate,
      now,
    });
    const sourceEvidencePresent =
      providerMissing ||
      replayCandidate.sources.length > 0 ||
      replayCandidate.evidenceRefs.some((ref) => ref.startsWith('source:'));
    const rawFieldJson = JSON.stringify({ event, label, candidate });
    const privateFragments = extractPrivateFragments(rawFieldJson);
    const profile = makeProfile(now, [replayTopicForField(event, label, candidate, now)], {
      sessionPath: event.sessionPath,
      sourceMemoryCount: replayCandidate.memoryIds.length,
    });
    const scenario = scenarioForLabel(label.label, providerMissing);
    const fixture: AoiProactiveBriefReplayFixture = {
      id: `aoi-proactive-brief-field-${stableHashText(`${event.id}:${label.id}`)}`,
      title:
        sanitizeReplayText(event.title ?? replayCandidate.title, 100) ||
        'Redacted proactive brief field replay',
      scenario,
      now,
      profile,
      policy: input.policy ?? makePolicy(now),
      skipSearch: true,
      directCandidates: providerMissing ? [] : [replayCandidate],
      feedback: providerMissing
        ? []
        : [
            feedbackForCalibrationLabel({
              label,
              candidate: replayCandidate,
              now,
            }),
          ],
      cooldownState: cooldownStateForReplayLabel({
        label,
        candidate: replayCandidate,
        now,
      }),
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
      sourceStaleAfterMs: DEFAULT_SOURCE_STALE_AFTER_MS,
    };

    if (event.privacy.privateLeakDetected) {
      blockers.push('private_leak');
    }
    if (event.privacy.unauthorizedMutationDetected) {
      blockers.push('unauthorized_mutation');
    }
    if (eventMadeStaleCurrentClaim(event)) {
      blockers.push('stale_current_claim');
    }
    if (!sourceEvidencePresent) {
      blockers.push('no_source_evidence');
    }

    const fixtureJson = JSON.stringify(fixture);
    const rawPrivateTextAbsent = privateFragments.every(
      (fragment) => !fixtureJson.includes(fragment),
    );
    if (!rawPrivateTextAbsent) {
      blockers.push('private_leak');
    }
    const validation = {
      deterministicClock: typeof fixture.now === 'number' && Number.isFinite(fixture.now),
      noNetworkDependency: fixture.skipSearch === true && !fixture.searchResults,
      rawPrivateTextAbsent,
      hasSourceEvidence: sourceEvidencePresent,
      expectedOutcome: labelExpectedOutcome(label.label),
      blockers: unique(blockers),
    };
    const status = replayBlockerStatus(validation.blockers);
    const redactedRefs = sanitizeReplayRefs(
      [...event.sourceRefs, ...event.evidenceRefs, ...label.sourceRefs, ...label.evidenceRefs],
      16,
    );

    drafts.push({
      version: 1,
      id: `aoi-proactive-brief-field-draft-${stableHashText(`${event.id}:${label.id}:${status}`)}`,
      sessionPath: event.sessionPath,
      fieldEventId: event.id,
      calibrationLabelId: label.id,
      label: label.label,
      status,
      fixture,
      validation,
      redaction: {
        applied:
          event.privacy.redacted ||
          privateFragments.length > 0 ||
          redactedRefs.some((ref) => /redacted/i.test(ref)),
        removedPrivateFieldCount: privateFragments.length,
        removedRefs: redactedRefs.filter((ref) => /redacted/i.test(ref)).slice(0, 8),
      },
      evidenceRefs: unique([
        `proactive-brief-field-event:${event.id}`,
        `proactive-brief-calibration:${label.id}`,
        ...redactedRefs,
      ]).slice(0, 24),
      createdAt: now,
    });
  }

  return drafts;
}

function labelCount(
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined,
  label: AoiProactiveBriefCalibrationLabel,
): number {
  return tuning?.labelDistribution[label] ?? 0;
}

function readinessGate(params: AoiProactiveBriefReadinessGate): AoiProactiveBriefReadinessGate {
  return {
    ...params,
    evidenceRefs: unique(params.evidenceRefs).slice(0, 12),
  };
}

function directChatReadiness(params: {
  metrics: AoiProactiveBriefFieldMetrics | null | undefined;
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined;
  replayCandidateCount: number;
  policy: AoiAutonomyPolicy | null | undefined;
  minimumSampleCount: number;
}): AoiProactiveBriefDirectChatReadiness {
  const sampleCount = params.metrics?.eventCount ?? 0;
  if (sampleCount === 0) {
    return 'not_field_tested';
  }
  if (
    (params.metrics?.privateLeakCount ?? 0) > 0 ||
    (params.metrics?.unauthorizedMutationCount ?? 0) > 0 ||
    (params.metrics?.unsafeCount ?? 0) > 0 ||
    (params.tuning?.unsafeLabelCount ?? 0) > 0
  ) {
    return 'blocked_private_or_unsafe';
  }
  if ((params.metrics?.staleCurrentClaimCount ?? 0) > 0) {
    return 'blocked_stale_current_claim';
  }
  if (params.policy?.proactiveBriefing.directChatHookOptIn !== true) {
    return 'disabled_by_policy';
  }
  if (sampleCount < params.minimumSampleCount || params.replayCandidateCount === 0) {
    return 'measuring';
  }
  if (
    (params.metrics?.tooFrequentCount ?? 0) > 0 ||
    (params.metrics?.wrongTimingCount ?? 0) > 0 ||
    (params.tuning?.tooFrequentLabelCount ?? 0) > 0 ||
    (params.tuning?.wrongTimingLabelCount ?? 0) > 0
  ) {
    return 'lowered_by_feedback';
  }
  return 'eligible_opt_in';
}

function providerFreshnessState(params: {
  policy: AoiAutonomyPolicy | null | undefined;
  tavilyConfigured: boolean | undefined;
}): AoiProactiveBriefCurrentProviderFreshnessState {
  if (params.tavilyConfigured === true) {
    return 'configured';
  }
  if (
    params.policy?.enabled === true &&
    params.policy.proactiveSuggestionsEnabled === true &&
    params.policy.proactiveBriefing.enabled === true
  ) {
    return 'missing_provider';
  }
  if (params.policy) {
    return 'not_required';
  }
  return 'unknown';
}

export function buildAoiProactiveBriefReadinessSummary(
  input: BuildAoiProactiveBriefReadinessSummaryInput,
): AoiProactiveBriefReadinessSummary {
  const now = input.now ?? Date.now();
  const minimumSampleCount = input.minimumSampleCount ?? MIN_FIELD_READINESS_SAMPLE_COUNT;
  const metrics = input.metrics ?? null;
  const tuning = input.calibrationTuning ?? null;
  const replayPromotionCandidateCount = (input.replayDrafts ?? []).filter(
    (draft) => draft.status === 'promoted_candidate',
  ).length;
  const sampleCount = metrics?.eventCount ?? 0;
  const counts = {
    useful: Math.max(metrics?.usefulCount ?? 0, labelCount(tuning, 'useful')),
    tooFrequent: Math.max(metrics?.tooFrequentCount ?? 0, labelCount(tuning, 'too_frequent')),
    wrongTopic: Math.max(metrics?.wrongTopicCount ?? 0, labelCount(tuning, 'wrong_topic')),
    wrongTiming: Math.max(metrics?.wrongTimingCount ?? 0, labelCount(tuning, 'wrong_timing')),
    stale: Math.max(metrics?.staleCount ?? 0, tuning?.staleLabelCount ?? 0),
    unsafe: Math.max(metrics?.unsafeCount ?? 0, tuning?.unsafeLabelCount ?? 0),
    privateLeak: metrics?.privateLeakCount ?? 0,
    unauthorizedMutation: metrics?.unauthorizedMutationCount ?? 0,
    staleCurrentClaim: metrics?.staleCurrentClaimCount ?? 0,
  };
  const gates: AoiProactiveBriefReadinessGate[] = [
    readinessGate({
      id: 'field.sample_count',
      status: sampleCount === 0 ? 'block' : sampleCount < minimumSampleCount ? 'warn' : 'pass',
      summary:
        sampleCount === 0
          ? 'No proactive brief field evidence has been recorded.'
          : `${sampleCount} proactive brief field sample(s) recorded; minimum confidence sample count is ${minimumSampleCount}.`,
      evidenceRefs: metrics?.evidenceRefs ?? ['proactive-brief-field:metrics'],
    }),
    readinessGate({
      id: 'field.private_leak_zero',
      status: counts.privateLeak === 0 ? 'pass' : 'block',
      summary:
        counts.privateLeak === 0
          ? 'No private leak field signal is visible.'
          : `${counts.privateLeak} private leak field signal(s) block readiness.`,
      evidenceRefs: metrics?.evidenceRefs ?? [],
    }),
    readinessGate({
      id: 'field.unauthorized_mutation_zero',
      status: counts.unauthorizedMutation === 0 ? 'pass' : 'block',
      summary:
        counts.unauthorizedMutation === 0
          ? 'No unauthorized mutation field signal is visible.'
          : `${counts.unauthorizedMutation} unauthorized mutation field signal(s) block readiness.`,
      evidenceRefs: metrics?.evidenceRefs ?? [],
    }),
    readinessGate({
      id: 'field.stale_current_claim_zero',
      status: counts.staleCurrentClaim === 0 ? 'pass' : 'block',
      summary:
        counts.staleCurrentClaim === 0
          ? 'No stale current claim was shown or offered.'
          : `${counts.staleCurrentClaim} stale current claim field signal(s) block readiness.`,
      evidenceRefs: metrics?.evidenceRefs ?? [],
    }),
    readinessGate({
      id: 'field.unsafe_direct_chat_blocked',
      status: counts.unsafe === 0 ? 'pass' : 'warn',
      summary:
        counts.unsafe === 0
          ? 'No unsafe field label constrains direct chat.'
          : `${counts.unsafe} unsafe field label(s) force direct chat into a blocked state for affected topics or sources.`,
      evidenceRefs: tuning?.evidenceRefs ?? metrics?.evidenceRefs ?? [],
    }),
    readinessGate({
      id: 'field.replay_promotion_candidate',
      status: replayPromotionCandidateCount > 0 ? 'pass' : 'warn',
      summary:
        replayPromotionCandidateCount > 0
          ? `${replayPromotionCandidateCount} redacted replay promotion candidate(s) are ready for review.`
          : 'No redacted replay promotion candidate is ready yet.',
      evidenceRefs: input.replayDrafts?.flatMap((draft) => draft.evidenceRefs) ?? [],
    }),
    readinessGate({
      id: 'field.interruption_confidence',
      status: counts.tooFrequent > 0 || counts.wrongTiming > 0 ? 'warn' : 'pass',
      summary:
        counts.tooFrequent > 0 || counts.wrongTiming > 0
          ? `Interruption confidence is lowered by too_frequent=${counts.tooFrequent} and wrong_timing=${counts.wrongTiming}.`
          : 'No too-frequent or wrong-timing field feedback lowers interruption confidence.',
      evidenceRefs: tuning?.evidenceRefs ?? metrics?.evidenceRefs ?? [],
    }),
  ];
  const hardBlocked = gates.some((gate) => gate.status === 'block');
  const directChat = directChatReadiness({
    metrics,
    tuning,
    replayCandidateCount: replayPromotionCandidateCount,
    policy: input.policy,
    minimumSampleCount,
  });
  const status: AoiProactiveBriefReadinessStatus =
    sampleCount === 0
      ? 'not_field_tested'
      : hardBlocked
        ? 'blocked'
        : sampleCount < minimumSampleCount || replayPromotionCandidateCount === 0
          ? 'measuring'
          : 'ready';
  const currentProviderFreshnessState = providerFreshnessState({
    policy: input.policy,
    tavilyConfigured: input.tavilyConfigured,
  });
  const suppressionText = Object.entries(metrics?.suppressionCounts ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const summary = [
    `samples=${sampleCount}`,
    `useful=${counts.useful}`,
    `too_frequent=${counts.tooFrequent}`,
    `wrong_topic=${counts.wrongTopic}`,
    `wrong_timing=${counts.wrongTiming}`,
    `stale=${counts.stale}`,
    `unsafe=${counts.unsafe}`,
    `suppression=${suppressionText || 'none'}`,
    `replay_candidates=${replayPromotionCandidateCount}`,
    `direct_chat=${directChat}`,
    `provider=${currentProviderFreshnessState}`,
  ].join('; ');

  return {
    version: 1,
    sessionPath: input.sessionPath,
    generatedAt: now,
    status,
    sampleCount,
    minimumSampleCount,
    counts,
    suppressionCounts: metrics?.suppressionCounts ?? {},
    replayPromotionCandidateCount,
    directChatReadiness: directChat,
    currentProviderFreshnessState,
    gates,
    summary,
    evidenceRefs: unique([
      ...(metrics?.evidenceRefs ?? []),
      ...(tuning?.evidenceRefs ?? []),
      ...(input.replayDrafts ?? []).flatMap((draft) => draft.evidenceRefs),
    ]).slice(0, 24),
  };
}

export function buildAoiProactiveBriefReadinessDiagnostics(
  readiness: AoiProactiveBriefReadinessSummary | null | undefined,
  now = Date.now(),
): AoiProactiveBriefDiagnostic[] {
  if (!readiness) {
    return [];
  }
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  if (readiness.counts.staleCurrentClaim > 0) {
    diagnostics.push(
      diagnostic({
        code: 'field_stale_current_claim_detected',
        severity: 'blocker',
        capability: 'replay_evaluation',
        summary: `${readiness.counts.staleCurrentClaim} proactive brief field event(s) showed or offered stale current information.`,
        cannotKnow:
          'Aoi cannot pass proactive brief readiness while stale evidence was presented as actionable current information.',
        evidenceRefs: readiness.evidenceRefs,
        observedAt: readiness.generatedAt || now,
      }),
    );
  }
  diagnostics.push(
    diagnostic({
      code: readiness.status === 'ready' ? 'field_readiness_ready' : 'field_readiness_measuring',
      severity:
        readiness.status === 'blocked' ? 'warning' : readiness.status === 'ready' ? 'info' : 'info',
      capability: 'replay_evaluation',
      summary: `Proactive brief readiness ${readiness.status}: ${readiness.summary}.`,
      cannotKnow:
        readiness.status === 'ready'
          ? 'Aoi still cannot claim unrestricted autonomy; live scouting remains provider, budget, and policy gated.'
          : 'Aoi cannot claim proactive brief readiness until field evidence, safety gates, and replay promotion candidates agree.',
      evidenceRefs: readiness.evidenceRefs.length
        ? readiness.evidenceRefs
        : ['proactive-brief-field:readiness'],
      observedAt: readiness.generatedAt || now,
    }),
  );
  if (readiness.directChatReadiness !== 'eligible_opt_in') {
    diagnostics.push(
      diagnostic({
        code: 'field_direct_chat_not_ready',
        severity: readiness.directChatReadiness.startsWith('blocked') ? 'warning' : 'info',
        capability: 'replay_evaluation',
        summary: `Direct proactive chat readiness is ${readiness.directChatReadiness}.`,
        cannotKnow:
          'Aoi cannot use direct proactive chat hooks until opt-in, timing, freshness, and safety gates all pass.',
        evidenceRefs: readiness.evidenceRefs,
        observedAt: readiness.generatedAt || now,
      }),
    );
  }
  if (readiness.replayPromotionCandidateCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'field_replay_candidates_ready',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: `${readiness.replayPromotionCandidateCount} redacted proactive brief field replay candidate(s) are ready for review.`,
        cannotKnow:
          'Aoi cannot merge promoted field replay fixtures into built-in packs until the operator reviews and accepts them.',
        evidenceRefs: readiness.evidenceRefs,
        observedAt: readiness.generatedAt || now,
      }),
    );
  }
  return diagnostics;
}

function makePolicy(now: number, partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    confidenceFloor: 0.5,
    defaultCooldownMs: 6 * 60 * 60 * 1000,
    updatedAt: now,
    ...partial,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-reverse-engineering',
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'reversing', 'malware reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.88,
    importance: partial.importance ?? 0.86,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.94,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? DEFAULT_NOW - 60_000,
    updatedAt: partial.updatedAt ?? DEFAULT_NOW - 30_000,
  };
}

function makeProfile(
  now: number,
  topics: AoiInterestTopic[] = [makeTopic({ createdAt: now - 60_000, updatedAt: now - 30_000 })],
  partial: Partial<AoiInterestProfile> = {},
): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
    topics,
    generatedAt: partial.generatedAt ?? now,
    sourceMemoryCount: partial.sourceMemoryCount ?? topics.length,
    warnings: partial.warnings ?? [],
  };
}

function makeCooldownState(
  now: number,
  entries: AoiProactiveBriefCooldownEntry[] = [],
): AoiProactiveBriefCooldownState {
  return {
    version: 1,
    sessionPath: DEFAULT_SESSION_PATH,
    updatedAt: now,
    cooldowns: Object.fromEntries(entries.map((entry) => [entry.cooldownKey, entry])),
  };
}

function makeCooldownEntry(params: {
  cooldownKey: string;
  topicId?: string;
  nextAllowedAt: number;
  reason: string;
  sourceBriefIds?: string[];
  now: number;
}): AoiProactiveBriefCooldownEntry {
  return {
    version: 1,
    cooldownKey: params.cooldownKey,
    ...(params.topicId ? { topicId: params.topicId } : {}),
    nextAllowedAt: params.nextAllowedAt,
    reason: params.reason,
    sourceBriefIds: params.sourceBriefIds ?? [],
    updatedAt: params.now,
  };
}

function makeFeedback(params: {
  id: string;
  briefId: string;
  topicId: string;
  category: AoiProactiveBriefFeedback['category'];
  now: number;
}): AoiProactiveBriefFeedback {
  return {
    version: 1,
    id: params.id,
    briefId: params.briefId,
    topicId: params.topicId,
    sessionPath: DEFAULT_SESSION_PATH,
    category: params.category,
    createdAt: params.now,
  };
}

function makeDirectCandidate(
  now: number,
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-replay-direct',
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
    topicId: partial.topicId ?? 'aoi-interest-reverse-engineering',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Source-backed scout for Reverse Engineering',
    hook:
      partial.hook ??
      'I found public sources that may be worth a quick look for Reverse Engineering.',
    summary:
      partial.summary ??
      'A source-backed candidate is ready for quiet review with public source evidence.',
    whyForOperator: partial.whyForOperator ?? 'This matches saved reverse engineering interests.',
    noveltyReason: partial.noveltyReason ?? 'Multiple public hosts surfaced the item.',
    sources: partial.sources ?? [
      {
        title: 'Reverse engineering writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        publishedAt: '2026-06-18T00:00:00.000Z',
        retrievedAt: now,
        snippet: 'Public source snippet for the reversing writeup.',
      },
      {
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
        host: 'security.example.net',
        publishedAt: '2026-06-17T00:00:00.000Z',
        retrievedAt: now,
        snippet: 'A second public source.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? [
      'source:research.example.com:fixture',
      'source:security.example.net:fixture',
    ],
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    score: partial.score ?? 0.86,
    confidence: partial.confidence ?? 0.88,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: now,
      newestSourceAt: '2026-06-18T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    ...(partial.dedupeKey ? { dedupeKey: partial.dedupeKey } : {}),
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    expiresAt: partial.expiresAt ?? now + 14 * 24 * 60 * 60 * 1000,
  };
}

function freshResults(): AoiProactiveBriefRawSearchResult[] {
  return [
    {
      title: 'Reverse engineering new loader technique',
      url: 'https://research.example.com/re/loader-technique',
      content: 'A public writeup about reverse engineering a loader technique.',
      publishedAt: '2026-06-18T00:00:00.000Z',
    },
    {
      title: 'Malware reversing case study',
      url: 'https://security.example.net/posts/re-case-study',
      content: 'A second public source with a reversing case study.',
      publishedAt: '2026-06-17T00:00:00.000Z',
    },
  ];
}

function staleResults(): AoiProactiveBriefRawSearchResult[] {
  return [
    {
      title: 'Older reverse engineering survey',
      url: 'https://archive.example.com/re/older-survey',
      content: 'An older source about reverse engineering.',
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      title: 'Older reversing notes',
      url: 'https://old.example.net/re/notes',
      content: 'A second older public source.',
      publishedAt: '2026-01-02T00:00:00.000Z',
    },
  ];
}

function fixtureSearchAdapter(
  fixture: AoiProactiveBriefReplayFixture,
  now: number,
): AoiProactiveBriefSearchAdapter {
  return async (request) => ({
    query: request.query,
    retrievedAt: now,
    results: fixture.searchResults ?? [],
    ...(fixture.searchWarning ? { warning: fixture.searchWarning } : {}),
  });
}

function hasReason(
  decisions: AoiProactiveBriefDeliveryDecision[],
  reason: AoiProactiveBriefDeliverySuppressionReason,
): boolean {
  return decisions.some(
    (decision) =>
      decision.suppressionReasons.includes(reason) ||
      Object.values(decision.modeReasons).some((reasons) => reasons.includes(reason)) ||
      decision.chatHook.reasons.includes(reason),
  );
}

function metric(params: AoiProactiveBriefReplayMetric): AoiProactiveBriefReplayMetric {
  return params;
}

function isFreshSource(
  candidate: AoiProactiveBriefCandidate,
  now: number,
  staleAfterMs: number,
): boolean {
  const newest = candidate.freshness.newestSourceAt
    ? Date.parse(candidate.freshness.newestSourceAt)
    : 0;
  if (!Number.isFinite(newest) || newest <= 0) {
    return false;
  }
  return now - newest <= staleAfterMs;
}

function sourceFreshnessIsStale(freshness: AoiProactiveBriefSourceFreshness): boolean {
  return freshness.cannotKnow.some((item) => /stale|outside the freshness window/i.test(item));
}

function buildCandidateSummaries(params: {
  candidates: AoiProactiveBriefCandidate[];
  decisions: AoiProactiveBriefDeliveryDecision[];
}): AoiProactiveBriefReplayCandidateSummary[] {
  return params.candidates.map((candidate) => {
    const decision = params.decisions.find((item) => item.candidateId === candidate.id);
    return {
      id: candidate.id,
      topicId: candidate.topicId,
      topicLabel: candidate.topicLabel,
      title: candidate.title,
      sourceCount: candidate.sources.length,
      sourceHosts: unique(candidate.sources.map((source) => source.host)).slice(0, 6),
      freshnessCannotKnow: candidate.freshness.cannotKnow.slice(0, 6),
      selectedMode: decision?.selectedMode ?? null,
      deliveryScore: decision?.deliveryScore ?? 0,
      chatHookAllowed: decision?.chatHook.allowed === true,
      chatHookReasons: decision?.chatHook.reasons ?? [],
      evidenceRefs: candidate.evidenceRefs.slice(0, 12),
    };
  });
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
    summary: params.summary,
    cannotKnow: params.cannotKnow,
    evidenceRefs: unique(params.evidenceRefs).slice(0, 12),
    observedAt: params.observedAt,
  };
}

export function buildAoiProactiveBriefDiagnostics(
  input: BuildAoiProactiveBriefDiagnosticsInput,
): AoiProactiveBriefDiagnostic[] {
  const now = input.now ?? Date.now();
  const profile = input.profile ?? null;
  const candidates = input.candidates ?? [];
  const skippedTopics = input.skippedTopics ?? [];
  const warnings = input.scoutWarnings ?? [];
  const decisions =
    input.decisions ??
    candidates.map((candidate) =>
      decideAoiProactiveBriefDelivery({
        candidate,
        profile,
        feedback: input.feedback ?? [],
        cooldownState: input.cooldownState ?? null,
        context: {
          now,
        },
      }),
    );
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  const warningText = warnings.join(' ');

  if (
    /tavily_not_configured|tavily_missing/i.test(warningText) ||
    skippedTopics.some((topic) => topic.reason === 'tavily_not_configured')
  ) {
    diagnostics.push(
      diagnostic({
        code: 'tavily_unavailable',
        severity: 'warning',
        capability: 'research',
        summary:
          'Proactive interest scouting could not refresh public current-info evidence because Tavily is unavailable.',
        cannotKnow:
          'Aoi cannot know whether there is fresh public web evidence for this interest without a configured current-info source.',
        evidenceRefs: [
          'proactive-brief:tavily',
          ...skippedTopics.map((topic) => `skip:${topic.reason}`),
        ],
        observedAt: now,
      }),
    );
  }

  if (
    (input.sourceFreshness ?? []).some(sourceFreshnessIsStale) ||
    candidates.some((candidate) =>
      candidate.freshness.cannotKnow.some((item) => /stale|freshness window/i.test(item)),
    ) ||
    hasReason(decisions, 'stale_source')
  ) {
    diagnostics.push(
      diagnostic({
        code: 'source_freshness_stale',
        severity: 'warning',
        capability: 'research',
        summary:
          'At least one proactive interest brief has stale source evidence and cannot be treated as fresh.',
        cannotKnow:
          'Aoi cannot make a fresh or latest claim until the public source evidence is refreshed.',
        evidenceRefs: [
          'proactive-brief:source-freshness',
          ...candidates.flatMap((candidate) => candidate.evidenceRefs.slice(0, 4)),
        ],
        observedAt: now,
      }),
    );
  }

  if (
    profile &&
    profile.topics.length === 0 &&
    (profile.sourceMemoryCount > 0 ||
      skippedTopics.some((topic) => topic.reason === 'profile_empty'))
  ) {
    diagnostics.push(
      diagnostic({
        code: 'no_eligible_topics',
        severity: 'info',
        capability: 'memory',
        summary: 'Aoi did not find eligible non-sensitive interest topics for proactive briefing.',
        cannotKnow:
          'Aoi cannot infer a safe proactive topic from private, expired, demoted, or low-confidence memory evidence.',
        evidenceRefs: ['proactive-brief:interest-profile'],
        observedAt: profile.generatedAt || now,
      }),
    );
  }

  if (profile && profile.topics.length > 0 && profile.topics.every((topic) => topic.muted)) {
    diagnostics.push(
      diagnostic({
        code: 'all_topics_muted',
        severity: 'info',
        capability: 'memory',
        summary: 'All proactive interest topics are muted by operator feedback.',
        cannotKnow:
          'Aoi cannot know which proactive topics should be offered until at least one topic is unmuted or added.',
        evidenceRefs: profile.topics.flatMap((topic) => topic.evidenceRefs.slice(0, 2)),
        observedAt: Math.max(...profile.topics.map((topic) => topic.updatedAt), now),
      }),
    );
  }

  const cooldownReasons: AoiProactiveBriefDeliverySuppressionReason[] = [
    'topic_cooldown_active',
    'global_cooldown_active',
  ];
  const allCandidatesCooldownSuppressed =
    candidates.length > 0 &&
    decisions.length === candidates.length &&
    decisions.every((decision) =>
      cooldownReasons.some(
        (reason) =>
          decision.suppressionReasons.includes(reason) ||
          decision.modeReasons.digest.includes(reason) ||
          decision.modeReasons.inline_card.includes(reason) ||
          decision.chatHook.reasons.includes(reason),
      ),
    );
  const allSkippedForCooldown =
    skippedTopics.length > 0 &&
    skippedTopics.every(
      (topic) =>
        topic.reason === 'topic_cooldown_active' || topic.reason === 'global_cooldown_active',
    );
  if (allCandidatesCooldownSuppressed || allSkippedForCooldown) {
    diagnostics.push(
      diagnostic({
        code: 'cooldown_suppressed_all_candidates',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Proactive interest candidates are currently suppressed by cooldown policy.',
        cannotKnow:
          'Aoi cannot know whether another interruption would be welcome until the cooldown expires or the operator changes feedback.',
        evidenceRefs: [
          'proactive-brief:cooldown',
          ...Object.keys(input.cooldownState?.cooldowns ?? {}).map((key) => `cooldown:${key}`),
        ],
        observedAt: now,
      }),
    );
  }

  const directChatPolicyReasons: AoiProactiveBriefDeliverySuppressionReason[] = [
    'chat_hook_not_opted_in',
    'quiet_mode_suppresses_chat_hook',
    'chat_hook_mode_not_allowed',
  ];
  if (
    candidates.length > 0 &&
    decisions.length === candidates.length &&
    decisions.every(
      (decision) =>
        !decision.chatHook.allowed &&
        directChatPolicyReasons.some((reason) => decision.chatHook.reasons.includes(reason)),
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'direct_chat_disabled_by_policy',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Direct proactive chat hooks are disabled by policy or quiet-mode gating.',
        cannotKnow:
          'Aoi cannot assume an unsolicited chat interruption is welcome without explicit opt-in and a passing delivery decision.',
        evidenceRefs: [
          'proactive-brief:interruption-policy',
          ...candidates.map((candidate) => `brief:${candidate.id}`),
        ],
        observedAt: now,
      }),
    );
  }

  return diagnostics;
}

export function buildAoiProactiveBriefFieldDiagnostics(
  metrics: AoiProactiveBriefFieldMetrics | null | undefined,
  now = Date.now(),
): AoiProactiveBriefDiagnostic[] {
  if (!metrics) {
    return [];
  }
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  if (metrics.eventCount === 0 || metrics.status === 'not_field_tested') {
    diagnostics.push(
      diagnostic({
        code: 'field_not_tested',
        severity: 'info',
        capability: 'replay_evaluation',
        summary:
          'Proactive interest briefs have no field event evidence yet; replay coverage exists, but real-session usefulness is not proven.',
        cannotKnow:
          'Aoi cannot claim proactive brief field readiness until shown, suppressed, or feedback events are recorded.',
        evidenceRefs: ['proactive-brief-field:metrics'],
        observedAt: metrics.generatedAt || now,
      }),
    );
  }
  if (metrics.privateLeakCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'field_private_leak_detected',
        severity: 'blocker',
        capability: 'replay_evaluation',
        summary: `${metrics.privateLeakCount} proactive brief field event(s) reported private leakage.`,
        cannotKnow:
          'Aoi cannot promote proactive brief field behavior until private leakage is investigated and fixed.',
        evidenceRefs: metrics.evidenceRefs,
        observedAt: metrics.lastEventAt ?? metrics.generatedAt ?? now,
      }),
    );
  }
  if (metrics.unauthorizedMutationCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'field_unauthorized_mutation_detected',
        severity: 'blocker',
        capability: 'replay_evaluation',
        summary: `${metrics.unauthorizedMutationCount} proactive brief field event(s) reported unauthorized mutation.`,
        cannotKnow:
          'Aoi cannot promote proactive brief field behavior while any unauthorized mutation is present.',
        evidenceRefs: metrics.evidenceRefs,
        observedAt: metrics.lastEventAt ?? metrics.generatedAt ?? now,
      }),
    );
  }
  if (metrics.staleCurrentClaimCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'field_stale_current_claim_detected',
        severity: 'blocker',
        capability: 'replay_evaluation',
        summary: `${metrics.staleCurrentClaimCount} proactive brief field event(s) showed or offered stale current information.`,
        cannotKnow:
          'Aoi cannot pass proactive brief field readiness while stale evidence was presented as current or actionable.',
        evidenceRefs: metrics.evidenceRefs,
        observedAt: metrics.lastEventAt ?? metrics.generatedAt ?? now,
      }),
    );
  }
  return diagnostics;
}

export function buildAoiProactiveBriefCalibrationDiagnostics(
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined,
  now = Date.now(),
): AoiProactiveBriefDiagnostic[] {
  if (!tuning) {
    return [];
  }
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  if (tuning.labelCount === 0 || tuning.status === 'no_labels') {
    diagnostics.push(
      diagnostic({
        code: 'calibration_not_labeled',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Proactive brief field events have no operator calibration labels yet.',
        cannotKnow:
          'Aoi cannot know whether proactive brief timing, topic fit, or source selection is useful until field outcomes are labeled.',
        evidenceRefs: ['proactive-brief-calibration:tuning'],
        observedAt: tuning.generatedAt || now,
      }),
    );
    return diagnostics;
  }
  diagnostics.push(
    diagnostic({
      code: 'calibration_tuning_active',
      severity: 'info',
      capability: 'replay_evaluation',
      summary: tuning.summaryLabels.join('; ') || 'Proactive brief calibration tuning is active.',
      cannotKnow:
        'Aoi can apply calibration only within existing safety gates; it cannot infer field readiness from labels alone.',
      evidenceRefs: tuning.evidenceRefs,
      observedAt: tuning.generatedAt || now,
    }),
  );
  if (tuning.staleLabelCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'calibration_stale_direct_chat_block',
        severity: 'warning',
        capability: 'replay_evaluation',
        summary: `${tuning.staleLabelCount} stale proactive brief label(s) tighten direct chat delivery.`,
        cannotKnow:
          'Aoi cannot use similar stale sources for proactive direct chat until fresh evidence is available.',
        evidenceRefs: tuning.evidenceRefs,
        observedAt: tuning.generatedAt || now,
      }),
    );
  }
  if (tuning.unsafeLabelCount > 0) {
    diagnostics.push(
      diagnostic({
        code: 'calibration_unsafe_label_blocker',
        severity: 'warning',
        capability: 'replay_evaluation',
        summary: `${tuning.unsafeLabelCount} unsafe proactive brief label(s) force conservative delivery.`,
        cannotKnow:
          'Aoi cannot safely escalate affected proactive topics or sources into direct chat while unsafe labels are active.',
        evidenceRefs: tuning.evidenceRefs,
        observedAt: tuning.generatedAt || now,
      }),
    );
  }
  return diagnostics;
}

export function buildAoiProactiveBriefSchedulerDiagnostics(params: {
  policy: AoiAutonomyPolicy | null | undefined;
  scheduler: AoiAutonomySchedulerState | null | undefined;
  tavilyConfigured: boolean;
  now?: number;
}): AoiProactiveBriefDiagnostic[] {
  const now = params.now ?? Date.now();
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  const controls = params.policy?.proactiveBriefing;
  const latestScout = params.scheduler?.recentWakeups.find(
    (record) => record.proactiveScout,
  )?.proactiveScout;

  if (
    params.policy?.enabled &&
    params.policy.proactiveSuggestionsEnabled &&
    !params.tavilyConfigured
  ) {
    diagnostics.push(
      diagnostic({
        code: 'scout_provider_missing',
        severity: 'warning',
        capability: 'research',
        summary:
          'Proactive scout cannot check current public sources because Tavily is not configured.',
        cannotKnow:
          'Aoi cannot make latest or current proactive brief claims without an approved current-information provider.',
        evidenceRefs: ['scheduler:proactive-scout', 'config:tavily'],
        observedAt: now,
      }),
    );
  }

  if (controls && !controls.directChatHookOptIn) {
    diagnostics.push(
      diagnostic({
        code: 'scout_direct_chat_disabled',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Proactive direct chat hooks are disabled by operator control.',
        cannotKnow:
          'Aoi cannot use proactive direct chat unless the operator explicitly enables direct chat hook delivery.',
        evidenceRefs: ['policy:proactive-briefing:direct-chat'],
        observedAt: now,
      }),
    );
  }

  if (!latestScout || latestScout.status === 'not_requested') {
    return diagnostics;
  }

  const evidenceRefs = latestScout.evidenceRefs.length
    ? latestScout.evidenceRefs
    : ['scheduler:proactive-scout'];
  const hasReason = (pattern: RegExp): boolean =>
    latestScout.blockedReasons.some((reason) => pattern.test(reason)) ||
    latestScout.warnings.some((warning) => pattern.test(warning));

  if (latestScout.status === 'failed') {
    diagnostics.push(
      diagnostic({
        code: 'scout_provider_failed',
        severity: 'warning',
        capability: 'research',
        summary: latestScout.warnings.length
          ? `Last proactive scout failed: ${latestScout.warnings.join(', ')}`
          : 'Last proactive scout failed before producing source-backed candidates.',
        cannotKnow:
          'Aoi cannot know whether current public sources changed because the provider run failed.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/network_budget_disabled/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_network_disabled',
        severity: 'info',
        capability: 'research',
        summary: 'Last proactive scout was blocked because this wakeup had no network budget.',
        cannotKnow:
          'Aoi cannot check current public sources during a no-network wakeup and must avoid current claims.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/budget_(?:zero|exhausted)/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_budget_exhausted',
        severity: 'warning',
        capability: 'research',
        summary: 'Proactive scout budget is exhausted for the configured day or session window.',
        cannotKnow:
          'Aoi cannot know whether more current items exist until the scout budget resets or the operator changes it.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/profile_empty|no_eligible_topics/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_no_eligible_topics',
        severity: 'info',
        capability: 'memory',
        summary: 'Proactive scout did not find any eligible interest topics to check.',
        cannotKnow:
          'Aoi cannot scout useful current items until an eligible, non-sensitive interest topic exists.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/all_topics_muted/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_all_topics_muted',
        severity: 'info',
        capability: 'memory',
        summary: 'All proactive interest topics are muted by profile or operator control.',
        cannotKnow: 'Aoi cannot select a proactive topic while every topic is muted or disallowed.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/cooldown/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_cooldown_active',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Proactive scout cooldown blocked a repeated scout run.',
        cannotKnow:
          'Aoi cannot know whether a new candidate is available until the configured cooldown expires.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/quiet_window_active/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_quiet_window_active',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Quiet window is active, so proactive direct chat is suppressed.',
        cannotKnow:
          'Aoi can queue dashboard-only candidates during quiet windows but cannot assume an interruption is welcome.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/unsafe_label_blocker/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_unsafe_label_blocker',
        severity: 'warning',
        capability: 'replay_evaluation',
        summary: 'Unsafe calibration labels block proactive scouting escalation.',
        cannotKnow:
          'Aoi cannot safely scout or escalate affected proactive topics until unsafe labels are reviewed.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (hasReason(/stale_label/)) {
    diagnostics.push(
      diagnostic({
        code: 'scout_stale_source_blocker',
        severity: 'warning',
        capability: 'replay_evaluation',
        summary: 'Stale calibration labels keep proactive scout delivery conservative.',
        cannotKnow:
          'Aoi cannot use stale-labeled source patterns for proactive direct chat until fresh evidence is available.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  if (latestScout.status === 'no_candidate') {
    diagnostics.push(
      diagnostic({
        code: 'scout_no_candidate',
        severity: 'info',
        capability: 'research',
        summary: 'Last proactive scout checked allowed sources but did not create a candidate.',
        cannotKnow:
          'Aoi checked within the configured budget, but cannot infer that no relevant item exists outside the allowed provider and source controls.',
        evidenceRefs,
        observedAt: latestScout.completedAt || now,
      }),
    );
  }

  return diagnostics;
}

function buildReplayMetrics(params: {
  fixture: AoiProactiveBriefReplayFixture;
  now: number;
  candidates: AoiProactiveBriefCandidate[];
  decisions: AoiProactiveBriefDeliveryDecision[];
  diagnostics: AoiProactiveBriefDiagnostic[];
  sourceFreshness: AoiProactiveBriefSourceFreshness[];
  warningLabels: string[];
  reportDraft: unknown;
}): AoiProactiveBriefReplayMetric[] {
  const { fixture, now, candidates, decisions, diagnostics, sourceFreshness } = params;
  const scenario = fixture.scenario;
  const candidatePrecisionPassed =
    scenario === 'tavily_missing' || scenario === 'private_memory_excluded'
      ? candidates.length === 0
      : candidates.length > 0 &&
        candidates.every(
          (candidate) =>
            candidate.sources.length > 0 &&
            candidate.evidenceRefs.some((ref) => ref.startsWith('source:')),
        );
  const staleExpected = scenario === 'stale_sources';
  const sourceFreshnessPassed = staleExpected
    ? diagnostics.some((item) => item.code === 'source_freshness_stale') &&
      candidates.every((candidate) =>
        candidate.freshness.cannotKnow.some((item) => /stale|freshness window/i.test(item)),
      )
    : candidates.every((candidate) =>
        isFreshSource(candidate, now, fixture.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS),
      ) || candidates.length === 0;
  const chatSuppressed = decisions.every((decision) => decision.chatHook.allowed === false);
  const interruptionPassed =
    scenario === 'quiet_mode'
      ? hasReason(decisions, 'quiet_mode_suppresses_chat_hook') && chatSuppressed
      : scenario === 'too_frequent_feedback' || scenario === 'useful_feedback_with_cooldown'
        ? diagnostics.some((item) => item.code === 'cooldown_suppressed_all_candidates') &&
          chatSuppressed
        : scenario === 'fresh_public_sources'
          ? chatSuppressed
          : true;
  const feedbackPassed =
    scenario === 'useful_feedback_with_cooldown'
      ? (() => {
          const withFeedback = decisions[0]?.deliveryScore ?? 0;
          const withoutFeedback = candidates[0]
            ? decideAoiProactiveBriefDelivery({
                candidate: candidates[0],
                policy: fixture.policy,
                profile: fixture.profile,
                feedback: [],
                cooldownState: fixture.cooldownState,
                context: fixture.context,
              }).deliveryScore
            : 0;
          return withFeedback > withoutFeedback && hasReason(decisions, 'topic_cooldown_active');
        })()
      : scenario === 'wrong_topic_feedback'
        ? (() => {
            const withFeedback = decisions[0]?.deliveryScore ?? 0;
            const withoutFeedback = candidates[0]
              ? decideAoiProactiveBriefDelivery({
                  candidate: candidates[0],
                  policy: fixture.policy,
                  profile: fixture.profile,
                  feedback: [],
                  cooldownState: fixture.cooldownState,
                  context: fixture.context,
                }).deliveryScore
              : 0;
            return (
              withFeedback < withoutFeedback && hasReason(decisions, 'recent_negative_feedback')
            );
          })()
        : scenario === 'too_frequent_feedback'
          ? hasReason(decisions, 'recent_negative_feedback') ||
            hasReason(decisions, 'topic_cooldown_active')
          : true;
  const serializedDraft = JSON.stringify(params.reportDraft);
  const privacyPassed = (fixture.expectedPrivateTextAbsent ?? []).every(
    (text) => !serializedDraft.includes(text),
  );
  const fabricatedCurrentInfoPassed =
    candidates.length > 0
      ? candidates.every((candidate) => candidate.sources.length > 0)
      : !/latest/i.test(serializedDraft) &&
        !params.warningLabels.some((warning) => /fabricated/i.test(warning));

  return [
    metric({
      name: 'candidate_precision',
      passed: candidatePrecisionPassed,
      expected: 'Candidates exist only when source evidence is sufficient.',
      actual: `${candidates.length} candidate(s), ${sourceFreshness.length} source freshness record(s).`,
      evidenceRefs: candidates.flatMap((candidate) => candidate.evidenceRefs.slice(0, 3)),
    }),
    metric({
      name: 'source_freshness',
      passed: sourceFreshnessPassed,
      expected: staleExpected
        ? 'Stale evidence is reported as stale.'
        : 'Fresh scenarios use dated source evidence or create no current-info candidate.',
      actual: diagnostics.map((item) => item.code).join(', ') || 'no freshness diagnostic',
      evidenceRefs: ['proactive-brief:source-freshness'],
    }),
    metric({
      name: 'interruption_policy',
      passed: interruptionPassed,
      expected: 'Quiet mode, cooldown, and missing opt-in prevent unsolicited direct chat.',
      actual:
        decisions
          .map(
            (decision) =>
              `${decision.candidateId}:${decision.chatHook.allowed ? 'chat' : 'no-chat'}`,
          )
          .join(', ') || 'no delivery decision',
      evidenceRefs: ['proactive-brief:interruption-policy'],
    }),
    metric({
      name: 'feedback_adaptation',
      passed: feedbackPassed,
      expected:
        'Feedback changes relevance while cooldown and negative-feedback gates remain active.',
      actual:
        fixture.feedback?.map((item) => `${item.category}:${item.topicId}`).join(', ') ||
        'no feedback in fixture',
      evidenceRefs: fixture.feedback?.map((item) => `feedback:${item.id}`) ?? [],
    }),
    metric({
      name: 'privacy_redaction',
      passed: privacyPassed,
      expected: 'Private-sensitive fixture text never appears in replay output.',
      actual: privacyPassed ? 'private samples absent' : 'private sample leaked',
      evidenceRefs: ['proactive-brief:privacy'],
    }),
    metric({
      name: 'no_fabricated_current_info',
      passed: fabricatedCurrentInfoPassed,
      expected: 'Memory-only or missing-source scenarios cannot create fresh current-info claims.',
      actual:
        candidates.length > 0
          ? 'all candidate claims are source-backed'
          : 'no source-backed candidate created',
      evidenceRefs: candidates.flatMap((candidate) => candidate.evidenceRefs.slice(0, 3)),
    }),
  ];
}

export async function runAoiProactiveBriefReplayFixture(
  fixture: AoiProactiveBriefReplayFixture,
): Promise<AoiProactiveBriefReplayReport> {
  const now = fixture.now ?? DEFAULT_NOW;
  const policy = fixture.policy ?? makePolicy(now);
  const feedback = fixture.feedback ?? [];
  const cooldownState = fixture.cooldownState ?? makeCooldownState(now);
  const warningLabels: string[] = [];
  const skippedTopics: AoiProactiveBriefSkippedTopic[] = [];
  const sourceFreshness: AoiProactiveBriefSourceFreshness[] = [];
  const candidates: AoiProactiveBriefCandidate[] = [...(fixture.directCandidates ?? [])];

  if (!fixture.skipSearch && fixture.searchResults) {
    const plan = planAoiProactiveBriefTopics({
      profile: fixture.profile,
      cooldownState,
      feedback,
      now,
      budget: {
        allowNetwork: true,
        quietMode: fixture.context?.quietMode === true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
    });
    warningLabels.push(...plan.warnings);
    skippedTopics.push(...plan.skippedTopics);
    for (const planned of plan.topics) {
      const result = await scoutAoiProactiveBriefTopic({
        topic: planned.topic,
        search: fixtureSearchAdapter(fixture, now),
        now,
        minSources: 2,
        maxResults: 5,
        sourceStaleAfterMs: fixture.sourceStaleAfterMs,
        delivery: planned.delivery,
      });
      warningLabels.push(...result.warnings);
      sourceFreshness.push(result.evidence.freshness);
      if (result.candidate) {
        candidates.push(result.candidate);
      } else if (result.rejectedReason === 'low_evidence') {
        skippedTopics.push({
          topicId: planned.topic.id,
          topicLabel: planned.topic.label,
          reason: 'low_evidence',
          detail: 'Replay fixture search did not return enough public source evidence.',
        });
      }
    }
  } else if (fixture.scenario === 'tavily_missing') {
    const plan = planAoiProactiveBriefTopics({
      profile: fixture.profile,
      cooldownState,
      feedback,
      now,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
    });
    warningLabels.push(...plan.warnings, 'tavily_not_configured:cannot_refresh_current_info');
    skippedTopics.push(
      ...plan.skippedTopics,
      ...plan.topics.map((planned) => ({
        topicId: planned.topic.id,
        topicLabel: planned.topic.label,
        reason: 'tavily_not_configured' as const,
        detail: 'Tavily is not configured, so replay created no current-info candidate.',
      })),
    );
  } else if (fixture.profile.topics.length === 0) {
    skippedTopics.push({
      reason: 'profile_empty',
      detail: 'No eligible interest topics are available for replay.',
    });
  }

  const decisions = candidates.map((candidate) =>
    decideAoiProactiveBriefDelivery({
      candidate,
      policy,
      profile: fixture.profile,
      feedback,
      cooldownState,
      context: {
        now,
        sourceStaleAfterMs: fixture.sourceStaleAfterMs,
        ...fixture.context,
      },
    }),
  );
  const panel = buildAoiProactiveBriefPanelModel({
    candidates,
    policy,
    profile: fixture.profile,
    feedback,
    cooldownState,
    context: {
      now,
      sourceStaleAfterMs: fixture.sourceStaleAfterMs,
      ...fixture.context,
    },
  });
  const diagnostics = buildAoiProactiveBriefDiagnostics({
    profile: fixture.profile,
    candidates,
    decisions,
    feedback,
    cooldownState,
    scoutWarnings: warningLabels,
    skippedTopics,
    sourceFreshness,
    now,
  });
  const candidateSummaries = buildCandidateSummaries({
    candidates,
    decisions,
  });
  const reportDraft = {
    fixtureId: fixture.id,
    candidateSummaries,
    warningLabels,
    diagnosticLabels: diagnostics.map((item) => item.code),
  };
  const metrics = buildReplayMetrics({
    fixture,
    now,
    candidates,
    decisions,
    diagnostics,
    sourceFreshness,
    warningLabels,
    reportDraft,
  });
  const passed = metrics.every((item) => item.passed);
  const summary = passed
    ? `${fixture.title}: replay passed with ${candidates.length} source-backed candidate(s) and ${diagnostics.length} diagnostic note(s).`
    : `${fixture.title}: replay failed ${metrics.filter((item) => !item.passed).length} metric(s).`;

  return {
    version: 1,
    fixtureId: fixture.id,
    title: fixture.title,
    scenario: fixture.scenario,
    generatedAt: now,
    passed,
    summary,
    metrics,
    candidates: candidateSummaries,
    candidateCount: candidates.length,
    visibleCardCount: panel.cards.length,
    warningLabels: unique(warningLabels),
    diagnosticLabels: diagnostics.map((item) => item.code),
    diagnostics,
    evidenceRefs: unique([
      `replay:${fixture.id}`,
      ...candidateSummaries.flatMap((candidate) => candidate.evidenceRefs),
      ...diagnostics.flatMap((item) => item.evidenceRefs),
    ]).slice(0, 24),
  };
}

export function getBuiltInAoiProactiveBriefReplayFixtures(): AoiProactiveBriefReplayFixture[] {
  const now = DEFAULT_NOW;
  const topic = makeTopic({
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
  });
  const profile = makeProfile(now, [topic]);
  const usefulCandidate = makeDirectCandidate(now, {
    id: 'aoi-brief-useful-feedback-cooldown',
  });
  const tooFrequentCandidate = makeDirectCandidate(now, {
    id: 'aoi-brief-too-frequent',
  });

  return [
    {
      id: 'aoi-proactive-brief-fresh-re',
      title: 'RE interest with fresh public sources',
      scenario: 'fresh_public_sources',
      now,
      profile,
      policy: makePolicy(now),
      searchResults: freshResults(),
      context: {
        now,
        directChatOptIn: false,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-tavily-missing',
      title: 'Tavily missing produces cannot-refresh diagnostic',
      scenario: 'tavily_missing',
      now,
      profile,
      policy: makePolicy(now),
      skipSearch: true,
      context: {
        now,
      },
    },
    {
      id: 'aoi-proactive-brief-quiet-mode',
      title: 'Quiet mode keeps the card but suppresses direct chat',
      scenario: 'quiet_mode',
      now,
      profile,
      policy: makePolicy(now),
      searchResults: freshResults(),
      context: {
        now,
        quietMode: true,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-too-frequent-feedback',
      title: 'Too frequent feedback keeps cooldown active',
      scenario: 'too_frequent_feedback',
      now,
      profile,
      policy: makePolicy(now),
      skipSearch: true,
      directCandidates: [tooFrequentCandidate],
      feedback: [
        makeFeedback({
          id: 'aoi-feedback-too-frequent',
          briefId: tooFrequentCandidate.id,
          topicId: topic.id,
          category: 'too_frequent',
          now: now - 60_000,
        }),
      ],
      cooldownState: makeCooldownState(now, [
        makeCooldownEntry({
          cooldownKey: topic.cooldownKey,
          topicId: topic.id,
          nextAllowedAt: now + 24 * 60 * 60 * 1000,
          reason: 'feedback:too_frequent',
          sourceBriefIds: [tooFrequentCandidate.id],
          now,
        }),
      ]),
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-stale-sources',
      title: 'Stale sources are labeled and cannot use direct chat',
      scenario: 'stale_sources',
      now,
      profile,
      policy: makePolicy(now),
      searchResults: staleResults(),
      sourceStaleAfterMs: DEFAULT_SOURCE_STALE_AFTER_MS,
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-private-memory-excluded',
      title: 'Private-sensitive memory produces no eligible topic',
      scenario: 'private_memory_excluded',
      now,
      profile: makeProfile(now, [], {
        sourceMemoryCount: 1,
        warnings: ['private_sensitive_memory_excluded'],
      }),
      policy: makePolicy(now),
      skipSearch: true,
      expectedPrivateTextAbsent: ['private-roadmap@example.com', 'api_key=secret-value'],
      context: {
        now,
      },
    },
    {
      id: 'aoi-proactive-brief-useful-feedback-cooldown',
      title: 'Useful feedback boosts relevance but respects cooldown',
      scenario: 'useful_feedback_with_cooldown',
      now,
      profile,
      policy: makePolicy(now),
      skipSearch: true,
      directCandidates: [usefulCandidate],
      feedback: [
        makeFeedback({
          id: 'aoi-feedback-useful',
          briefId: usefulCandidate.id,
          topicId: topic.id,
          category: 'useful',
          now: now - 60_000,
        }),
      ],
      cooldownState: makeCooldownState(now, [
        makeCooldownEntry({
          cooldownKey: topic.cooldownKey,
          topicId: topic.id,
          nextAllowedAt: now + 60 * 60 * 1000,
          reason: 'candidate_created',
          sourceBriefIds: [usefulCandidate.id],
          now,
        }),
        makeCooldownEntry({
          cooldownKey: AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
          nextAllowedAt: now + 30 * 60 * 1000,
          reason: 'candidate_created',
          sourceBriefIds: [usefulCandidate.id],
          now,
        }),
      ]),
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
  ];
}

export async function runBuiltInAoiProactiveBriefReplayFixtures(): Promise<
  AoiProactiveBriefReplayReport[]
> {
  const reports: AoiProactiveBriefReplayReport[] = [];
  for (const fixture of getBuiltInAoiProactiveBriefReplayFixtures()) {
    reports.push(await runAoiProactiveBriefReplayFixture(fixture));
  }
  return reports;
}

export function formatAoiProactiveBriefReplayReport(
  reports: AoiProactiveBriefReplayReport[],
): string {
  const passed = reports.filter((report) => report.passed).length;
  const failed = reports.length - passed;
  const lines = [
    `Aoi proactive brief replay: ${passed}/${reports.length} passed, ${failed} failed.`,
    ...reports.map((report) => {
      const metricLabel = report.metrics
        .map((metricItem) => `${metricItem.name}:${metricItem.passed ? 'pass' : 'fail'}`)
        .join(', ');
      return `- ${report.fixtureId}: ${report.passed ? 'pass' : 'fail'} (${metricLabel})`;
    }),
  ];
  return lines.join('\n');
}

export const AOI_PROACTIVE_BRIEF_REPLAY_PRIVATE_TEXT_SAMPLES = [
  'private-roadmap@example.com',
  'api_key=secret-value',
] as const;
