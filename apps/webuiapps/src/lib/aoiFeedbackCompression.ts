import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';
import {
  buildAoiFollowThroughLearningSummary,
  normalizeAoiFollowThroughEvent,
  normalizeAoiFollowThroughKey,
} from './aoiFollowThroughLearning';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type { AoiFollowThroughEvent, AoiFollowThroughLearningSummary } from './aoiAutonomyTypes';
import type { AoiOperatorFeedbackLabelAction } from './aoiOperatorFeedbackInbox';

const DEFAULT_FEEDBACK_COMPRESSION_NOW = 1_800_000_000_000;
const MAX_REFS = 24;
const MAX_ADJUSTMENTS = 12;

export type AoiFeedbackCompressionAdjustmentKind =
  | 'topic'
  | 'source'
  | 'timing'
  | 'direct_chat'
  | 'verbosity'
  | 'trust'
  | 'unsafe'
  | 'should_have_spoken';

export type AoiFeedbackCompressionDirection =
  | 'increase'
  | 'decrease'
  | 'block'
  | 'tighten'
  | 'hint'
  | 'neutral';

export type AoiFeedbackCompressionSignalOrigin = 'explicit_label' | 'passive_outcome';

export interface AoiFeedbackCompressionAdjustment {
  version: 1;
  id: string;
  kind: AoiFeedbackCompressionAdjustmentKind;
  key: string;
  label: string;
  direction: AoiFeedbackCompressionDirection;
  score: number;
  confidence: number;
  explicitLabelCount: number;
  passiveOutcomeCount: number;
  labels: string[];
  reason: string;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFeedbackCompressionDirectChatSensitivity {
  version: 1;
  factor: number;
  confidence: number;
  reasonLabels: string[];
  evidenceRefs: string[];
}

export interface AoiFeedbackCompressionVerbosityPreference {
  version: 1;
  level: 'shorter' | 'balanced' | 'more_context';
  factor: number;
  confidence: number;
  reasonLabels: string[];
  evidenceRefs: string[];
}

export interface AoiFeedbackCompressionUnsafeBlocker {
  version: 1;
  key: string;
  label: string;
  blocksActionEscalation: true;
  reason: string;
  confidence: number;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFeedbackCompressionShouldHaveSpokenHint {
  version: 1;
  key: string;
  label: string;
  directChatCandidate: true;
  reason: string;
  confidence: number;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFeedbackCompressionResult {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  topicAdjustments: AoiFeedbackCompressionAdjustment[];
  sourceAdjustments: AoiFeedbackCompressionAdjustment[];
  timingAdjustments: AoiFeedbackCompressionAdjustment[];
  directChatSensitivity: AoiFeedbackCompressionDirectChatSensitivity;
  verbosityPreference: AoiFeedbackCompressionVerbosityPreference;
  unsafeBlockers: AoiFeedbackCompressionUnsafeBlocker[];
  shouldHaveSpokenHints: AoiFeedbackCompressionShouldHaveSpokenHint[];
  trustAdjustments: AoiFeedbackCompressionAdjustment[];
  trustIncreaseAllowed: boolean;
  trustIncreaseBlockedReasons: string[];
  explicitLabelCount: number;
  passiveOutcomeCount: number;
  confidence: number;
  explanationLabels: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFeedbackCompressionInput {
  sessionPath: string;
  labelActions?: readonly AoiOperatorFeedbackLabelAction[];
  followThroughEvents?: readonly AoiFollowThroughEvent[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
  now?: number;
}

interface CompressionSignal {
  origin: AoiFeedbackCompressionSignalOrigin;
  label: string;
  topicKey: string;
  sourceKey: string;
  deliveryMode: string;
  result: string;
  createdAt: number;
  confidenceWeight: number;
  evidenceRefs: string[];
}

interface Aggregate {
  key: string;
  explicitLabelCount: number;
  passiveOutcomeCount: number;
  score: number;
  confidence: number;
  labels: string[];
  evidenceRefs: string[];
  latestAt: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, maxChars = 220): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(body|content|snippet|transcript|messageBody|rawText)\s*[:=]\s*[^.;\n]{6,}/gi,
        '$1=[private body withheld]',
      )
      .replace(/\b(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[local path]')
      .replace(/(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g, '[local path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(
        /\b(token|secret|api[_ -]?key|access[_ -]?token)\s*[:=]?\s*[A-Za-z0-9_=-]{16,}/gi,
        '$1=[redacted-token]',
      ),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function uniqueStrings(values: readonly unknown[], limit = MAX_REFS): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeText(String(value ?? ''), 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

function keyFrom(value: unknown, fallback: string): string {
  return normalizeAoiFollowThroughKey(value) || normalizeAoiFollowThroughKey(fallback) || 'unknown';
}

function explicitPositiveTrustLabel(label: string): boolean {
  return label === 'useful' || label === 'should_have_spoken' || label === 'show_more';
}

function scoreForLabel(label: string): number {
  if (label === 'useful' || label === 'should_have_spoken' || label === 'show_more') {
    return 1;
  }
  if (label === 'too_frequent' || label === 'too_much' || label === 'wrong_timing') {
    return -0.75;
  }
  if (label === 'wrong_source') {
    return -1;
  }
  if (label === 'unsafe') {
    return -1.25;
  }
  return 0;
}

function scoreForPassiveOutcome(event: AoiFollowThroughEvent): number {
  if (event.result === 'positive') {
    return 0.22;
  }
  if (event.result === 'soft_negative') {
    return -0.12;
  }
  if (event.result === 'negative') {
    return -0.2;
  }
  if (event.result === 'blocked' || event.result === 'failed') {
    return -0.35;
  }
  return 0;
}

function signalFromLabel(label: AoiOperatorFeedbackLabelAction): CompressionSignal {
  return {
    origin: 'explicit_label',
    label: label.label,
    topicKey: keyFrom(label.topicKey ?? label.opportunityId, label.decisionRecordId),
    sourceKey: keyFrom(label.sourceKey ?? label.sourceKinds[0], 'field_feedback'),
    deliveryMode: sanitizeText(label.deliveryMode ?? 'unknown', 80) || 'unknown',
    result:
      label.label === 'unsafe'
        ? 'blocked'
        : scoreForLabel(label.label) >= 0
          ? 'positive'
          : 'negative',
    createdAt: label.createdAt,
    confidenceWeight: 1,
    evidenceRefs: uniqueStrings([
      `operator-feedback:${label.id}`,
      `field-shadow-record:${label.decisionRecordId}`,
      `field-shadow-decision:${label.decisionId}`,
      ...(label.fieldEventId ? [`field-event:${label.fieldEventId}`] : []),
      ...label.evidenceRefs,
    ]),
  };
}

function signalFromPassiveEvent(event: AoiFollowThroughEvent): CompressionSignal {
  return {
    origin: 'passive_outcome',
    label: event.feedbackCategory ?? event.action,
    topicKey: keyFrom(event.topicKey ?? event.opportunityId, event.opportunityId),
    sourceKey: keyFrom(event.sourceKey ?? event.sourceKind, 'field_feedback'),
    deliveryMode: sanitizeText(event.deliveryMode ?? 'unknown', 80) || 'unknown',
    result: event.result,
    createdAt: event.createdAt,
    confidenceWeight: 0.25,
    evidenceRefs: uniqueStrings([`follow-through:${event.id}`, ...event.evidenceRefs]),
  };
}

function passiveEventsWithoutExplicitLabels(params: {
  events: readonly AoiFollowThroughEvent[];
  explicitLabelRefs: ReadonlySet<string>;
  sessionPath: string;
  now: number;
}): AoiFollowThroughEvent[] {
  return params.events
    .map((event) => normalizeAoiFollowThroughEvent(event, params.sessionPath, params.now))
    .filter((event): event is AoiFollowThroughEvent => event !== null)
    .filter(
      (event) =>
        !event.evidenceRefs.some(
          (ref) => ref.startsWith('operator-feedback:') && params.explicitLabelRefs.has(ref),
        ),
    );
}

function updateAggregate(
  aggregates: Map<string, Aggregate>,
  key: string,
  signal: CompressionSignal,
  score: number,
): void {
  const current =
    aggregates.get(key) ??
    ({
      key,
      explicitLabelCount: 0,
      passiveOutcomeCount: 0,
      score: 0,
      confidence: 0,
      labels: [],
      evidenceRefs: [],
      latestAt: 0,
    } satisfies Aggregate);
  if (signal.origin === 'explicit_label') {
    current.explicitLabelCount += 1;
  } else {
    current.passiveOutcomeCount += 1;
  }
  current.score += score;
  current.confidence += signal.origin === 'explicit_label' ? 0.28 : 0.06;
  current.labels = uniqueStrings([...current.labels, signal.label], 10);
  current.evidenceRefs = uniqueStrings([...current.evidenceRefs, ...signal.evidenceRefs], 12);
  current.latestAt = Math.max(current.latestAt, signal.createdAt);
  aggregates.set(key, current);
}

function aggregateSignals(
  signals: readonly CompressionSignal[],
  keyOf: (signal: CompressionSignal) => string,
  scoreOf: (signal: CompressionSignal) => number,
): Aggregate[] {
  const aggregates = new Map<string, Aggregate>();
  for (const signal of signals) {
    const key = keyOf(signal);
    if (!key || key === 'unknown') {
      continue;
    }
    const score = scoreOf(signal) * signal.confidenceWeight;
    if (Math.abs(score) < 0.001) {
      continue;
    }
    updateAggregate(aggregates, key, signal, score);
  }
  return [...aggregates.values()].sort(
    (left, right) => Math.abs(right.score) - Math.abs(left.score) || right.latestAt - left.latestAt,
  );
}

function adjustmentFromAggregate(params: {
  aggregate: Aggregate;
  kind: AoiFeedbackCompressionAdjustmentKind;
  direction?: AoiFeedbackCompressionDirection;
  labelPrefix: string;
  reason: string;
}): AoiFeedbackCompressionAdjustment {
  const direction =
    params.direction ??
    (params.aggregate.score > 0 ? 'increase' : params.aggregate.score < 0 ? 'decrease' : 'neutral');
  return {
    version: 1,
    id: `aoi-feedback-compression-${params.kind}-${hashText(params.aggregate.key)}`,
    kind: params.kind,
    key: params.aggregate.key,
    label: `${params.labelPrefix}: ${params.aggregate.key.replace(/[_:-]+/g, ' ')}`,
    direction,
    score: clamp(params.aggregate.score, -1, 1),
    confidence: clamp(params.aggregate.confidence, 0, 0.95),
    explicitLabelCount: params.aggregate.explicitLabelCount,
    passiveOutcomeCount: params.aggregate.passiveOutcomeCount,
    labels: params.aggregate.labels,
    reason: sanitizeText(params.reason, 220),
    evidenceRefs: uniqueStrings(params.aggregate.evidenceRefs, 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function buildTopicAdjustments(signals: readonly CompressionSignal[]) {
  return aggregateSignals(
    signals.filter((signal) => signal.label !== 'wrong_source' && signal.label !== 'unsafe'),
    (signal) => signal.topicKey,
    (signal) =>
      signal.origin === 'explicit_label'
        ? scoreForLabel(signal.label)
        : scoreForPassiveOutcome(signal),
  )
    .map((aggregate) =>
      adjustmentFromAggregate({
        aggregate,
        kind: 'topic',
        labelPrefix: aggregate.score >= 0 ? 'Topic interest increase' : 'Topic interest decrease',
        reason:
          aggregate.explicitLabelCount > 0
            ? 'Explicit operator feedback adjusted topic interest.'
            : 'Passive outcome adjusted topic interest with low confidence.',
      }),
    )
    .slice(0, MAX_ADJUSTMENTS);
}

function buildSourceAdjustments(signals: readonly CompressionSignal[]) {
  return aggregateSignals(
    signals.filter((signal) => signal.label !== 'too_frequent' && signal.label !== 'too_much'),
    (signal) => signal.sourceKey,
    (signal) => {
      if (signal.label === 'wrong_source') {
        return -1.1;
      }
      if (signal.label === 'unsafe') {
        return -0.8;
      }
      return signal.origin === 'explicit_label'
        ? scoreForLabel(signal.label) * 0.75
        : scoreForPassiveOutcome(signal) * 0.6;
    },
  )
    .map((aggregate) =>
      adjustmentFromAggregate({
        aggregate,
        kind: 'source',
        labelPrefix: aggregate.score >= 0 ? 'Source trust increase' : 'Source trust decrease',
        reason: aggregate.labels.includes('wrong_source')
          ? 'Wrong-source feedback blocks source trust growth for this source.'
          : aggregate.explicitLabelCount > 0
            ? 'Explicit operator feedback adjusted source trust.'
            : 'Passive outcome adjusted source trust with low confidence.',
      }),
    )
    .slice(0, MAX_ADJUSTMENTS);
}

function buildTimingAdjustments(signals: readonly CompressionSignal[]) {
  return aggregateSignals(
    signals.filter(
      (signal) =>
        signal.label === 'too_frequent' ||
        signal.label === 'too_much' ||
        signal.label === 'wrong_timing' ||
        signal.label === 'should_have_spoken' ||
        signal.result === 'soft_negative',
    ),
    (signal) => `${signal.deliveryMode}:${signal.topicKey}`,
    (signal) => {
      if (signal.label === 'should_have_spoken') {
        return 0.7;
      }
      if (signal.result === 'soft_negative') {
        return -0.15;
      }
      return -0.85;
    },
  )
    .map((aggregate) =>
      adjustmentFromAggregate({
        aggregate,
        kind: 'timing',
        labelPrefix:
          aggregate.score >= 0 ? 'Timing tolerance increase' : 'Timing tolerance decrease',
        reason: aggregate.labels.includes('should_have_spoken')
          ? 'Should-have-spoken feedback raises visibility timing for similar evidence.'
          : aggregate.explicitLabelCount > 0
            ? 'Frequency or timing feedback lowers interruption tolerance.'
            : 'Ignored passive outcome softly lowers timing tolerance.',
      }),
    )
    .slice(0, MAX_ADJUSTMENTS);
}

function buildDirectChatSensitivity(
  signals: readonly CompressionSignal[],
  learning: AoiFollowThroughLearningSummary,
): AoiFeedbackCompressionDirectChatSensitivity {
  const explicitDirectSignals = signals.filter(
    (signal) => signal.origin === 'explicit_label' && signal.deliveryMode === 'direct_chat',
  );
  let score = 0;
  const reasonLabels: string[] = [];
  const evidenceRefs: string[] = [];
  for (const signal of explicitDirectSignals) {
    evidenceRefs.push(...signal.evidenceRefs);
    if (signal.label === 'should_have_spoken' || signal.label === 'useful') {
      score += 0.16;
      reasonLabels.push(`${signal.label.replace(/_/g, ' ')} raises direct-chat sensitivity.`);
    } else if (signal.label === 'too_frequent' || signal.label === 'too_much') {
      score -= 0.42;
      reasonLabels.push('Too-frequent feedback lowers direct-chat sensitivity.');
    } else if (signal.label === 'wrong_source') {
      score -= 0.35;
      reasonLabels.push('Wrong-source feedback lowers direct-chat sensitivity.');
    } else if (signal.label === 'unsafe') {
      score -= 0.65;
      reasonLabels.push('Unsafe feedback blocks direct-chat escalation.');
    }
  }
  const learnedDirectChat = learning.deliveryModeSensitivity.find(
    (item) => item.mode === 'direct_chat',
  );
  if (learnedDirectChat) {
    score += (learnedDirectChat.factor - 1) * 0.35;
    evidenceRefs.push(...learnedDirectChat.evidenceRefs);
    reasonLabels.push(learnedDirectChat.reason);
  }
  return {
    version: 1,
    factor: clamp(1 + score, 0.1, 1.25),
    confidence: clamp(
      explicitDirectSignals.length * 0.25 + (learnedDirectChat ? 0.08 : 0),
      0,
      0.95,
    ),
    reasonLabels: uniqueStrings(
      reasonLabels.length > 0
        ? reasonLabels
        : ['No explicit direct-chat feedback; keep current sensitivity.'],
      6,
    ),
    evidenceRefs: uniqueStrings(evidenceRefs, 12),
  };
}

function buildVerbosityPreference(
  signals: readonly CompressionSignal[],
): AoiFeedbackCompressionVerbosityPreference {
  const explicitLabels = signals.filter((signal) => signal.origin === 'explicit_label');
  let score = 0;
  const evidenceRefs: string[] = [];
  const reasonLabels: string[] = [];
  for (const signal of explicitLabels) {
    evidenceRefs.push(...signal.evidenceRefs);
    if (signal.label === 'too_frequent' || signal.label === 'too_much') {
      score -= 0.35;
      reasonLabels.push('Frequency feedback prefers shorter proactive wording.');
    }
    if (signal.label === 'wrong_source' || signal.label === 'unsafe') {
      score -= 0.2;
      reasonLabels.push(`${signal.label.replace(/_/g, ' ')} feedback prefers stricter summaries.`);
    }
    if (signal.label === 'should_have_spoken') {
      score += 0.2;
      reasonLabels.push('Should-have-spoken feedback permits a little more context.');
    }
  }
  const factor = clamp(1 + score, 0.45, 1.25);
  return {
    version: 1,
    level: factor < 0.85 ? 'shorter' : factor > 1.08 ? 'more_context' : 'balanced',
    factor,
    confidence: clamp(explicitLabels.length * 0.2, 0, 0.9),
    reasonLabels: uniqueStrings(
      reasonLabels.length > 0 ? reasonLabels : ['No explicit verbosity feedback yet.'],
      5,
    ),
    evidenceRefs: uniqueStrings(evidenceRefs, 12),
  };
}

function buildUnsafeBlockers(
  signals: readonly CompressionSignal[],
): AoiFeedbackCompressionUnsafeBlocker[] {
  return aggregateSignals(
    signals.filter((signal) => signal.label === 'unsafe'),
    (signal) => signal.topicKey || signal.sourceKey,
    () => -1,
  )
    .map((aggregate) => ({
      version: 1 as const,
      key: aggregate.key,
      label: `Unsafe blocker: ${aggregate.key.replace(/[_:-]+/g, ' ')}`,
      blocksActionEscalation: true as const,
      reason: 'Unsafe feedback immediately blocks action escalation for similar evidence.',
      confidence: clamp(0.55 + aggregate.explicitLabelCount * 0.2, 0, 0.98),
      evidenceRefs: uniqueStrings(aggregate.evidenceRefs, 12),
      actionAuthority: 'display_only' as const,
      mutationCount: 0 as const,
    }))
    .slice(0, MAX_ADJUSTMENTS);
}

function buildShouldHaveSpokenHints(
  signals: readonly CompressionSignal[],
): AoiFeedbackCompressionShouldHaveSpokenHint[] {
  return aggregateSignals(
    signals.filter((signal) => signal.label === 'should_have_spoken'),
    (signal) => signal.topicKey,
    () => 1,
  )
    .map((aggregate) => ({
      version: 1 as const,
      key: aggregate.key,
      label: `Should have spoken: ${aggregate.key.replace(/[_:-]+/g, ' ')}`,
      directChatCandidate: true as const,
      reason:
        'Should-have-spoken feedback raises future visibility, but opt-in, freshness, quiet-mode, and approval gates still apply.',
      confidence: clamp(0.45 + aggregate.explicitLabelCount * 0.18, 0, 0.95),
      evidenceRefs: uniqueStrings(aggregate.evidenceRefs, 12),
      actionAuthority: 'display_only' as const,
      mutationCount: 0 as const,
    }))
    .slice(0, MAX_ADJUSTMENTS);
}

function buildTrustAdjustments(params: {
  signals: readonly CompressionSignal[];
  trustIncreaseAllowed: boolean;
  trustIncreaseBlockedReasons: readonly string[];
}): AoiFeedbackCompressionAdjustment[] {
  const explicitSignals = params.signals.filter((signal) => signal.origin === 'explicit_label');
  const aggregate: Aggregate = {
    key: 'operator-trust',
    explicitLabelCount: explicitSignals.length,
    passiveOutcomeCount: params.signals.length - explicitSignals.length,
    score: params.trustIncreaseAllowed ? 0.35 : -0.25,
    confidence: clamp(explicitSignals.length * 0.2, 0, 0.95),
    labels: uniqueStrings(
      explicitSignals.map((signal) => signal.label),
      10,
    ),
    evidenceRefs: uniqueStrings(
      params.signals.flatMap((signal) => signal.evidenceRefs),
      12,
    ),
    latestAt: Math.max(0, ...params.signals.map((signal) => signal.createdAt)),
  };
  return [
    adjustmentFromAggregate({
      aggregate,
      kind: 'trust',
      direction: params.trustIncreaseAllowed ? 'increase' : 'block',
      labelPrefix: params.trustIncreaseAllowed
        ? 'Trust increase candidate'
        : 'Trust increase blocked',
      reason: params.trustIncreaseAllowed
        ? 'Explicit positive operator labels are present and no wrong-source or unsafe feedback blocks trust growth.'
        : params.trustIncreaseBlockedReasons.join('; '),
    }),
  ];
}

function buildLearningSummary(params: {
  sessionPath: string;
  followThroughEvents: readonly AoiFollowThroughEvent[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
  now: number;
}): AoiFollowThroughLearningSummary {
  if (params.followThroughLearning) {
    return params.followThroughLearning;
  }
  return buildAoiFollowThroughLearningSummary({
    sessionPath: params.sessionPath,
    followThroughEvents: params.followThroughEvents,
    now: params.now,
  });
}

export function buildAoiFeedbackCompression(
  input: AoiFeedbackCompressionInput,
): AoiFeedbackCompressionResult {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? DEFAULT_FEEDBACK_COMPRESSION_NOW;
  const labels = (input.labelActions ?? []).filter((label) => label.sessionPath === sessionPath);
  const explicitLabelRefs = new Set(labels.map((label) => `operator-feedback:${label.id}`));
  const passiveEvents = passiveEventsWithoutExplicitLabels({
    events: input.followThroughEvents ?? [],
    explicitLabelRefs,
    sessionPath,
    now,
  });
  const signals = [
    ...labels.map(signalFromLabel),
    ...passiveEvents.map(signalFromPassiveEvent),
  ].sort((left, right) => right.createdAt - left.createdAt);
  const learning = buildLearningSummary({
    sessionPath,
    followThroughEvents: input.followThroughEvents ?? [],
    followThroughLearning: input.followThroughLearning,
    now,
  });
  const explicitPositiveTrustLabels = labels.filter((label) =>
    explicitPositiveTrustLabel(label.label),
  ).length;
  const wrongSourceCount = labels.filter((label) => label.label === 'wrong_source').length;
  const unsafeCount = labels.filter((label) => label.label === 'unsafe').length;
  const trustIncreaseBlockedReasons = uniqueStrings([
    explicitPositiveTrustLabels <= 0
      ? 'explicit positive operator label required before trust increase'
      : undefined,
    wrongSourceCount > 0 ? 'wrong-source feedback blocks trust increase' : undefined,
    unsafeCount > 0 ? 'unsafe feedback blocks trust increase' : undefined,
  ]);
  const trustIncreaseAllowed = trustIncreaseBlockedReasons.length <= 0;
  const topicAdjustments = buildTopicAdjustments(signals);
  const sourceAdjustments = buildSourceAdjustments(signals);
  const timingAdjustments = buildTimingAdjustments(signals);
  const directChatSensitivity = buildDirectChatSensitivity(signals, learning);
  const verbosityPreference = buildVerbosityPreference(signals);
  const unsafeBlockers = buildUnsafeBlockers(signals);
  const shouldHaveSpokenHints = buildShouldHaveSpokenHints(signals);
  const trustAdjustments = buildTrustAdjustments({
    signals,
    trustIncreaseAllowed,
    trustIncreaseBlockedReasons,
  });
  const evidenceRefs = uniqueStrings([
    ...signals.flatMap((signal) => signal.evidenceRefs),
    ...learning.evidenceRefs,
    ...topicAdjustments.flatMap((item) => item.evidenceRefs),
    ...sourceAdjustments.flatMap((item) => item.evidenceRefs),
    ...timingAdjustments.flatMap((item) => item.evidenceRefs),
  ]);
  const confidence = clamp(
    labels.length * 0.16 + passiveEvents.length * 0.025 + learning.eventCount * 0.01,
    0,
    0.95,
  );
  const explanationLabels = uniqueStrings([
    ...topicAdjustments.slice(0, 3).map((item) => item.reason),
    ...sourceAdjustments.slice(0, 3).map((item) => item.reason),
    ...timingAdjustments.slice(0, 3).map((item) => item.reason),
    ...directChatSensitivity.reasonLabels,
    ...verbosityPreference.reasonLabels,
    ...trustIncreaseBlockedReasons,
    trustIncreaseAllowed
      ? 'Trust increase is only a candidate; readiness, opt-in, freshness, and approval gates still apply.'
      : undefined,
  ]);

  return {
    version: 1,
    id: `aoi-feedback-compression-${hashText(
      `${sessionPath}:${now}:${labels.map((label) => label.id).join('|')}:${passiveEvents
        .map((event) => event.id)
        .join('|')}`,
    )}`,
    sessionPath,
    generatedAt: now,
    topicAdjustments,
    sourceAdjustments,
    timingAdjustments,
    directChatSensitivity,
    verbosityPreference,
    unsafeBlockers,
    shouldHaveSpokenHints,
    trustAdjustments,
    trustIncreaseAllowed,
    trustIncreaseBlockedReasons,
    explicitLabelCount: labels.length,
    passiveOutcomeCount: passiveEvents.length,
    confidence,
    explanationLabels,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}
