import { DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import type {
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
import type {
  AoiProactiveBriefDiagnostic,
  AoiProactiveBriefDiagnosticCode,
  AoiProactiveBriefDirectChatReadiness,
  AoiProactiveBriefCurrentProviderFreshnessState,
  AoiProactiveBriefReadinessGate,
  AoiProactiveBriefReadinessStatus,
  AoiProactiveBriefReadinessSummary,
  AoiProactiveBriefReplayDraftStatus,
  AoiProactiveBriefReplayFixture,
  AoiProactiveBriefReplayFixtureDraft,
  AoiProactiveBriefReplayScenario,
  BuildAoiProactiveBriefReadinessSummaryInput,
  BuildAoiProactiveBriefReplayPromotionDraftsInput,
} from './aoiProactiveBriefReplayTypes';

const DEFAULT_NOW = Date.parse('2026-06-19T00:00:00.000Z');
const DEFAULT_SESSION_PATH = 'aoi/default';
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

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
