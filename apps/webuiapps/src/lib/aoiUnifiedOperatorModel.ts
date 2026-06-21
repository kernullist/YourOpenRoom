import type {
  AoiContextRouterResult,
  AoiContextSourceSummary,
  AoiEnvironmentSourceRegistry,
  AoiFollowThroughEvent,
  AoiFollowThroughLearningAdjustment,
  AoiFollowThroughLearningSummary,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiMissionState,
} from './aoiAutonomyTypes';
import type {
  AoiCapabilityBrokerDecision,
  AoiConnectorAuthorityDecision,
} from './aoiCapabilityRegistry';
import type { AoiJarvisReadinessScorecard } from './aoiJarvisReadinessScorecard';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import { redactAoiSensitiveContent } from './aoiMemoryShared';
import type { AoiSourceFreshnessContract } from './aoiSourceFreshnessContract';

const DEFAULT_OPERATOR_SNAPSHOT_NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTEREST_DECAY_AFTER_MS = 45 * DAY_MS;
const DEFAULT_SOURCE_DECAY_AFTER_MS = 14 * DAY_MS;
const MAX_EVIDENCE_REFS = 32;
const MAX_CANNOT_KNOW = 24;
const OPERATOR_PRIVATE_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const OPERATOR_WINDOWS_PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const OPERATOR_UNIX_PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g;
const OPERATOR_STANDALONE_SECRET_PATTERN = /\bsecret[A-Za-z0-9_-]{8,}\b/gi;

export type AoiUnifiedOperatorFreshness =
  | 'fresh'
  | 'recent'
  | 'stale'
  | 'expired'
  | 'blocked'
  | 'unknown';

export type AoiUnifiedOperatorConflictWinner =
  | 'current_user_message'
  | 'explicit_operator_feedback'
  | 'fresh_source'
  | 'durable_memory'
  | 'inferred_outcome'
  | 'none';

export interface AoiUnifiedOperatorEvidenceSection {
  version: 1;
  id: string;
  label: string;
  summary: string;
  confidence: number;
  freshness: AoiUnifiedOperatorFreshness;
  evidenceRefs: string[];
  cannotKnow: string[];
}

export interface AoiUnifiedOperatorInterestSnapshot extends AoiUnifiedOperatorEvidenceSection {
  topicId: string;
  normalizedLabel: string;
  aliases: string[];
  memoryIds: string[];
  source: AoiInterestTopic['source'];
  importance: number;
  relevance: number;
  muted: boolean;
  pinned: boolean;
  winner: AoiUnifiedOperatorConflictWinner;
  decayReasons: string[];
}

export interface AoiUnifiedOperatorSourceTrustSnapshot extends AoiUnifiedOperatorEvidenceSection {
  sourceId: string;
  sourceKind: string;
  trustState:
    | 'trusted'
    | 'weak'
    | 'decayed'
    | 'stale'
    | 'blind_spot'
    | 'revoked'
    | 'disabled'
    | 'unknown';
  trustScore: number;
  signalFreshness: string;
  consentState?: string;
  bodyAccessState?: string;
  negativeEvidence: boolean;
}

export interface AoiUnifiedOperatorFeedbackSignal {
  version: 1;
  id: string;
  key: string;
  kind: 'topic' | 'source' | 'delivery' | 'trust' | 'unknown';
  direction: 'raise' | 'lower' | 'neutral';
  confidence: number;
  explicit: boolean;
  passive: boolean;
  syntheticOnly: boolean;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiUnifiedOperatorReadinessSnapshot extends AoiUnifiedOperatorEvidenceSection {
  gateStatus: string;
  level?: string;
  score?: number;
  canIncreaseTrust: boolean;
  dashboard: string;
  directChat: string;
  workOrderPrepare: string;
  blockerRefs: string[];
}

export interface AoiUnifiedOperatorInterruptionTolerance extends AoiUnifiedOperatorEvidenceSection {
  directChatAllowed: boolean;
  dashboardAllowed: boolean;
  deliveryMode: 'hidden' | 'dashboard' | 'direct_chat' | 'blocked';
  blockedReasons: string[];
}

export interface AoiUnifiedOperatorActionAuthority extends AoiUnifiedOperatorEvidenceSection {
  actionAuthority: 'display_only';
  executeAllowed: false;
  mutationCount: 0;
  unauthorizedMutationCount: number;
  capabilityDecisionRefs: string[];
}

export interface AoiUnifiedOperatorBlindSpot {
  version: 1;
  id: string;
  sourceId: string;
  label: string;
  reason: string;
  cannotKnow: string[];
  evidenceRefs: string[];
  negativeEvidence: false;
}

export interface AoiUnifiedOperatorConflict {
  version: 1;
  id: string;
  kind:
    | 'current_message_over_memory'
    | 'feedback_over_inferred_outcome'
    | 'fresh_source_over_stale_memory'
    | 'disconnected_source_blind_spot';
  winner: AoiUnifiedOperatorConflictWinner;
  loser: AoiUnifiedOperatorConflictWinner;
  summary: string;
  evidenceRefs: string[];
}

export interface AoiUnifiedOperatorSnapshotSummary {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  topInterestLabels: string[];
  readiness: string;
  interruption: string;
  blindSpotCount: number;
  actionAuthority: 'display_only';
  executeAllowed: false;
  summary: string;
  evidenceRefs: string[];
  cannotKnow: string[];
  mutationCount: 0;
}

export interface AoiUnifiedOperatorSnapshot {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  interestProfile?: AoiInterestProfile;
  interests: AoiUnifiedOperatorInterestSnapshot[];
  projectState: AoiUnifiedOperatorEvidenceSection;
  missionState: AoiUnifiedOperatorEvidenceSection;
  sourceTrust: AoiUnifiedOperatorSourceTrustSnapshot[];
  feedback: AoiUnifiedOperatorEvidenceSection & {
    signals: AoiUnifiedOperatorFeedbackSignal[];
    explicitFeedbackCount: number;
    passiveOutcomeCount: number;
  };
  readiness: AoiUnifiedOperatorReadinessSnapshot;
  interruptionTolerance: AoiUnifiedOperatorInterruptionTolerance;
  actionAuthority: AoiUnifiedOperatorActionAuthority;
  blindSpots: AoiUnifiedOperatorBlindSpot[];
  conflicts: AoiUnifiedOperatorConflict[];
  evidenceRefs: string[];
  cannotKnow: string[];
  operatorLanguageSummary: string;
  actionAuthorityMode: 'display_only';
  mutationCount: 0;
}

export interface AoiUnifiedOperatorSnapshotInput {
  sessionPath: string;
  now?: number;
  currentUserMessage?: string;
  memories?: readonly AoiMemoryEntry[];
  interestProfile?: AoiInterestProfile | null;
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
  mission?: AoiMissionState | null;
  contextRouter?: AoiContextRouterResult | null;
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  sourceFreshnessContracts?: readonly AoiSourceFreshnessContract[];
  readinessScorecard?: AoiJarvisReadinessScorecard | null;
  capabilityDecisions?: readonly (AoiCapabilityBrokerDecision | AoiConnectorAuthorityDecision)[];
  interestDecayAfterMs?: number;
  sourceDecayAfterMs?: number;
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}

function normalizeWhitespace(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function redactOperatorSnapshotText(value: string): string {
  return redactAoiSensitiveContent(value)
    .replace(OPERATOR_WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(OPERATOR_UNIX_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(OPERATOR_PRIVATE_EMAIL_PATTERN, '[private email]')
    .replace(OPERATOR_STANDALONE_SECRET_PATTERN, '[redacted-secret]');
}

function sanitizeText(value: unknown, fallback = '', maxChars = 260): string {
  const redacted = redactOperatorSnapshotText(normalizeWhitespace(value) || fallback);
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 3).trimEnd()}...` : redacted;
}

function normalizeKey(value: unknown): string {
  return sanitizeText(value, '', 180)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueStrings(values: readonly unknown[], limit = MAX_EVIDENCE_REFS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = sanitizeText(value, '', 240);
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

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function freshnessFromAge(
  updatedAt: number | undefined,
  now: number,
  staleAfterMs: number,
): AoiUnifiedOperatorFreshness {
  if (!updatedAt || !Number.isFinite(updatedAt)) {
    return 'unknown';
  }
  const age = Math.max(0, now - updatedAt);
  if (age <= Math.min(staleAfterMs / 4, 7 * DAY_MS)) {
    return 'fresh';
  }
  if (age <= staleAfterMs) {
    return 'recent';
  }
  if (age <= staleAfterMs * 3) {
    return 'stale';
  }
  return 'expired';
}

function confidenceAfterDecay(
  confidence: number,
  updatedAt: number | undefined,
  now: number,
  decayAfterMs: number,
): { confidence: number; reasons: string[]; freshness: AoiUnifiedOperatorFreshness } {
  const freshness = freshnessFromAge(updatedAt, now, decayAfterMs);
  if (freshness === 'stale') {
    return {
      confidence: clamp(confidence * 0.68),
      reasons: ['stale_without_recent_evidence'],
      freshness,
    };
  }
  if (freshness === 'expired') {
    return {
      confidence: clamp(confidence * 0.42),
      reasons: ['expired_without_recent_evidence'],
      freshness,
    };
  }
  return { confidence: clamp(confidence), reasons: [], freshness };
}

function memoryById(memories: readonly AoiMemoryEntry[] | undefined): Map<string, AoiMemoryEntry> {
  const result = new Map<string, AoiMemoryEntry>();
  for (const memory of memories ?? []) {
    result.set(memory.id, memory);
  }
  return result;
}

function topicKeys(topic: AoiInterestTopic): string[] {
  return uniqueStrings([
    topic.id,
    topic.cooldownKey,
    topic.normalizedLabel,
    `topic:${topic.normalizedLabel}`,
    normalizeKey(topic.label),
    ...topic.aliases.map(normalizeKey),
  ]);
}

function messageMentionsTopic(message: string, topic: AoiInterestTopic): boolean {
  const normalized = message.toLowerCase();
  return [topic.label, topic.normalizedLabel, ...topic.aliases]
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .some((value) => normalized.includes(value));
}

function currentMessageInterestOverride(
  message: string | undefined,
  topic: AoiInterestTopic,
): 'negative' | 'positive' | null {
  if (!message?.trim() || !messageMentionsTopic(message, topic)) {
    return null;
  }
  if (
    /\b(?:not interested|no longer interested|stop tracking|ignore|do not care|don't care|less interested)\b/iu.test(
      message,
    ) ||
    /(?:관심\s*없|관심없|더\s*이상.*관심|추적.*그만|그만.*추적|중요하지\s*않)/u.test(message)
  ) {
    return 'negative';
  }
  if (
    /\b(?:focus on|prioritize|show more|more interested|track)\b/iu.test(message) ||
    /(?:관심|우선|집중|더\s*보|추적)/u.test(message)
  ) {
    return 'positive';
  }
  return null;
}

function eventIsExplicitFeedback(event: AoiFollowThroughEvent): boolean {
  if (event.learningSignalKind === 'explicit_label') {
    return true;
  }
  const category = normalizeKey(event.feedbackCategory).replace(/_/g, '-');
  return [
    'useful',
    'show-more',
    'pin-topic',
    'wrong-source',
    'wrong-topic',
    'too-frequent',
    'not-useful',
    'unsafe',
    'should-have-spoken',
  ].includes(category);
}

function eventIsPassiveOutcome(event: AoiFollowThroughEvent): boolean {
  return (
    event.learningSignalKind === 'passive_outcome' ||
    normalizeKey(event.feedbackCategory).startsWith('outcome:')
  );
}

function hasSyntheticOnlyEvidence(evidenceRefs: readonly string[]): boolean {
  return (
    evidenceRefs.length > 0 &&
    evidenceRefs.every((ref) => /(?:synthetic|replay|fixture|acceptance)/iu.test(ref))
  );
}

function buildFeedbackSignals(
  summary: AoiFollowThroughLearningSummary | null | undefined,
): AoiUnifiedOperatorFeedbackSignal[] {
  if (!summary) {
    return [];
  }
  const signals: AoiUnifiedOperatorFeedbackSignal[] = [];
  const addAdjustment = (
    adjustment: AoiFollowThroughLearningAdjustment,
    kind: AoiUnifiedOperatorFeedbackSignal['kind'],
    direction: AoiUnifiedOperatorFeedbackSignal['direction'],
  ): void => {
    const relatedEvents = summary.recentEvents.filter((event) => {
      const adjustmentKey = normalizeKey(adjustment.key);
      return [event.topicKey, event.sourceKey, event.opportunityId, ...event.evidenceRefs]
        .map(normalizeKey)
        .filter(Boolean)
        .some((eventKey) => adjustmentKey.includes(eventKey) || eventKey.includes(adjustmentKey));
    });
    const explicit = relatedEvents.some(eventIsExplicitFeedback);
    const passive = relatedEvents.some(eventIsPassiveOutcome);
    const syntheticOnly = hasSyntheticOnlyEvidence(adjustment.evidenceRefs);
    const confidence = explicit ? 0.86 : passive ? 0.28 : syntheticOnly ? 0.18 : 0.52;
    signals.push({
      version: 1,
      id: `operator-feedback:${kind}:${direction}:${stableHash(
        `${adjustment.key}:${adjustment.reason}`,
      )}`,
      key: adjustment.key,
      kind,
      direction,
      confidence: clamp(confidence),
      explicit,
      passive,
      syntheticOnly,
      reason: syntheticOnly
        ? `${adjustment.reason}; replay or synthetic evidence cannot increase real-world preference confidence by itself.`
        : adjustment.reason,
      evidenceRefs: adjustment.evidenceRefs,
    });
  };

  for (const adjustment of summary.topicBoosts) {
    addAdjustment(adjustment, 'topic', 'raise');
  }
  for (const adjustment of summary.topicSuppressions) {
    addAdjustment(adjustment, 'topic', 'lower');
  }
  for (const adjustment of summary.sourceBoosts) {
    addAdjustment(adjustment, 'source', 'raise');
  }
  for (const adjustment of summary.sourceSuppressions) {
    addAdjustment(adjustment, 'source', 'lower');
  }
  for (const adjustment of summary.deliveryModeSensitivity) {
    signals.push({
      version: 1,
      id: `operator-feedback:delivery:${stableHash(`${adjustment.mode}:${adjustment.reason}`)}`,
      key: adjustment.mode,
      kind: 'delivery',
      direction: adjustment.factor >= 1 ? 'raise' : 'lower',
      confidence: clamp(adjustment.factor >= 1 ? 0.6 : 0.7),
      explicit: false,
      passive: true,
      syntheticOnly: hasSyntheticOnlyEvidence(adjustment.evidenceRefs),
      reason: adjustment.reason,
      evidenceRefs: adjustment.evidenceRefs,
    });
  }
  return signals;
}

function feedbackSignalsForTopic(
  signals: readonly AoiUnifiedOperatorFeedbackSignal[],
  topic: AoiInterestTopic,
): AoiUnifiedOperatorFeedbackSignal[] {
  return signals.filter((signal) => {
    if (signal.kind !== 'topic') {
      return false;
    }
    const key = normalizeKey(signal.key);
    return topicKeys(topic).some((candidate) => key.includes(normalizeKey(candidate)));
  });
}

function buildInterestSnapshots(params: {
  profile: AoiInterestProfile | null | undefined;
  memories?: readonly AoiMemoryEntry[];
  currentUserMessage?: string;
  feedbackSignals: readonly AoiUnifiedOperatorFeedbackSignal[];
  now: number;
  decayAfterMs: number;
}): { interests: AoiUnifiedOperatorInterestSnapshot[]; conflicts: AoiUnifiedOperatorConflict[] } {
  const byMemoryId = memoryById(params.memories);
  const conflicts: AoiUnifiedOperatorConflict[] = [];
  const interests = (params.profile?.topics ?? []).map((topic) => {
    const topicMemories = topic.memoryIds
      .map((id) => byMemoryId.get(id))
      .filter((memory): memory is AoiMemoryEntry => Boolean(memory));
    const latestMemoryUpdate = Math.max(
      topic.updatedAt,
      ...topicMemories.map((memory) => memory.updatedAt),
    );
    const decay = confidenceAfterDecay(
      topic.confidence,
      latestMemoryUpdate,
      params.now,
      params.decayAfterMs,
    );
    const signals = feedbackSignalsForTopic(params.feedbackSignals, topic);
    const explicitRaise = signals.find(
      (signal) => signal.direction === 'raise' && signal.explicit && !signal.syntheticOnly,
    );
    const explicitLower = signals.find((signal) => signal.direction === 'lower' && signal.explicit);
    const passiveRaise = signals.find((signal) => signal.direction === 'raise' && signal.passive);
    let confidence = decay.confidence;
    let relevance = topic.importance;
    let winner: AoiUnifiedOperatorConflictWinner = 'durable_memory';
    const cannotKnow: string[] = [];
    const decayReasons = [...decay.reasons];

    if (explicitRaise) {
      confidence = clamp(Math.max(confidence, explicitRaise.confidence));
      relevance = clamp(relevance + 0.12);
      winner = 'explicit_operator_feedback';
    } else if (passiveRaise) {
      confidence = clamp(Math.max(confidence, Math.min(0.54, confidence + 0.03)));
      relevance = clamp(relevance + 0.03);
      winner = 'inferred_outcome';
      cannotKnow.push(
        'Aoi cannot raise durable preference confidence from passive outcomes without explicit operator feedback.',
      );
    }

    if (explicitLower) {
      confidence = clamp(Math.min(confidence, 0.42));
      relevance = clamp(relevance - 0.25);
      winner = 'explicit_operator_feedback';
    }

    const messageOverride = currentMessageInterestOverride(params.currentUserMessage, topic);
    if (messageOverride) {
      conflicts.push({
        version: 1,
        id: `operator-conflict:current-message:${topic.id}`,
        kind: 'current_message_over_memory',
        winner: 'current_user_message',
        loser: winner,
        summary:
          messageOverride === 'negative'
            ? `Current user message overrides durable memory for ${topic.label}; treat it as not wanted now.`
            : `Current user message refreshes ${topic.label}; treat it as the active preference now.`,
        evidenceRefs: uniqueStrings([
          'current-user-message',
          ...topic.evidenceRefs,
          ...signals.flatMap((signal) => signal.evidenceRefs),
        ]),
      });
      winner = 'current_user_message';
      if (messageOverride === 'negative') {
        confidence = 0.95;
        relevance = 0;
      } else {
        confidence = 0.95;
        relevance = clamp(Math.max(relevance, 0.86));
      }
    }

    if (decayReasons.length > 0) {
      cannotKnow.push(
        `Aoi cannot assume ${topic.label} is still equally strong without refreshed evidence.`,
      );
    }

    return {
      version: 1,
      id: `operator-interest:${topic.id}`,
      topicId: topic.id,
      label: topic.label,
      normalizedLabel: topic.normalizedLabel,
      aliases: topic.aliases,
      memoryIds: topic.memoryIds,
      source: topic.source,
      summary: `${topic.label}: relevance ${relevance.toFixed(2)}, confidence ${confidence.toFixed(
        2,
      )}`,
      confidence,
      freshness: decay.freshness,
      importance: clamp(topic.importance),
      relevance,
      muted: topic.muted || relevance <= 0,
      pinned: topic.pinned,
      winner,
      decayReasons,
      evidenceRefs: uniqueStrings([
        ...topic.evidenceRefs,
        ...topic.memoryIds.map((id) => `memory:${id}`),
        ...signals.flatMap((signal) => signal.evidenceRefs),
      ]),
      cannotKnow: uniqueStrings(cannotKnow, 6),
    };
  });
  return { interests, conflicts };
}

function sourceTrustState(
  contract: AoiSourceFreshnessContract | undefined,
): AoiUnifiedOperatorSourceTrustSnapshot['trustState'] {
  if (!contract) {
    return 'unknown';
  }
  if (contract.consentState === 'disconnected' || contract.freshnessState === 'disconnected') {
    return 'blind_spot';
  }
  if (contract.consentState === 'revoked' || contract.freshnessState === 'revoked') {
    return 'revoked';
  }
  if (contract.consentState === 'disabled' || contract.freshnessState === 'disabled') {
    return 'disabled';
  }
  if (contract.freshnessState === 'stale' || contract.freshnessState === 'failed') {
    return 'stale';
  }
  if (contract.freshnessState === 'unknown') {
    return 'unknown';
  }
  return 'trusted';
}

function sourceFreshness(
  contract: AoiSourceFreshnessContract | undefined,
  now: number,
  decayAfterMs: number,
): AoiUnifiedOperatorFreshness {
  if (!contract) {
    return 'unknown';
  }
  if (
    contract.consentState === 'disconnected' ||
    contract.consentState === 'revoked' ||
    contract.consentState === 'disabled'
  ) {
    return 'blocked';
  }
  if (contract.signalFreshness === 'fresh') {
    return 'fresh';
  }
  if (contract.signalFreshness === 'stale' || contract.freshnessState === 'stale') {
    return 'stale';
  }
  return freshnessFromAge(contract.lastObservedAt, now, decayAfterMs);
}

function signalMatchesSource(
  signal: AoiUnifiedOperatorFeedbackSignal,
  contract: AoiSourceFreshnessContract,
): boolean {
  if (signal.kind !== 'source') {
    return false;
  }
  const key = normalizeKey(signal.key);
  return [contract.sourceId, contract.sourceKind, contract.sourceLabel]
    .map(normalizeKey)
    .some((candidate) => candidate && key.includes(candidate));
}

function buildSourceTrust(params: {
  sourceRegistry?: AoiEnvironmentSourceRegistry | null;
  contracts?: readonly AoiSourceFreshnessContract[];
  feedbackSignals: readonly AoiUnifiedOperatorFeedbackSignal[];
  now: number;
  decayAfterMs: number;
}): {
  sourceTrust: AoiUnifiedOperatorSourceTrustSnapshot[];
  blindSpots: AoiUnifiedOperatorBlindSpot[];
  conflicts: AoiUnifiedOperatorConflict[];
} {
  const registrySources = params.sourceRegistry?.sources ?? [];
  const contracts = params.contracts ?? [];
  const sourceIds = uniqueStrings([
    ...registrySources.map((source) => source.id),
    ...contracts.map((contract) => contract.sourceId),
  ]);
  const sourceTrust: AoiUnifiedOperatorSourceTrustSnapshot[] = [];
  const blindSpots: AoiUnifiedOperatorBlindSpot[] = [];
  const conflicts: AoiUnifiedOperatorConflict[] = [];

  for (const sourceId of sourceIds) {
    const source = registrySources.find((item) => item.id === sourceId);
    const contract = contracts.find((item) => item.sourceId === sourceId);
    const label = sanitizeText(source?.label ?? contract?.sourceLabel ?? sourceId, sourceId, 120);
    const trustState = sourceTrustState(contract);
    const freshness = sourceFreshness(contract, params.now, params.decayAfterMs);
    const matchingSignals = contract
      ? params.feedbackSignals.filter((signal) => signalMatchesSource(signal, contract))
      : [];
    const explicitLower = matchingSignals.find(
      (signal) => signal.direction === 'lower' && signal.explicit,
    );
    const passiveLower = matchingSignals.find(
      (signal) => signal.direction === 'lower' && signal.passive,
    );
    let trustScore =
      trustState === 'trusted'
        ? 0.82
        : trustState === 'stale'
          ? 0.48
          : trustState === 'blind_spot'
            ? 0.35
            : 0.25;
    if (freshness === 'stale') {
      trustScore = Math.min(trustScore, 0.46);
    }
    if (explicitLower && trustState !== 'blind_spot') {
      trustScore = Math.min(trustScore, 0.32);
    } else if (passiveLower && trustState !== 'blind_spot') {
      trustScore = Math.min(trustScore, 0.58);
    }
    const cannotKnow = uniqueStrings(
      contract?.cannotKnow.map((item) => item.statement) ?? [],
      MAX_CANNOT_KNOW,
    );
    const evidenceRefs = uniqueStrings([
      ...(contract?.evidenceRefs ?? []),
      ...(source ? [`source-registry:${source.id}`] : []),
      ...matchingSignals.flatMap((signal) => signal.evidenceRefs),
    ]);
    if (trustState === 'blind_spot') {
      blindSpots.push({
        version: 1,
        id: `operator-blind-spot:${sourceId}`,
        sourceId,
        label,
        reason: contract?.consentState === 'disconnected' ? 'source_disconnected' : 'blind_spot',
        cannotKnow: uniqueStrings([
          ...cannotKnow,
          `Aoi cannot treat ${label} as empty or negative evidence while it is disconnected.`,
        ]),
        evidenceRefs,
        negativeEvidence: false,
      });
      conflicts.push({
        version: 1,
        id: `operator-conflict:disconnected:${sourceId}`,
        kind: 'disconnected_source_blind_spot',
        winner: 'none',
        loser: 'none',
        summary: `${label} is a blind spot, not evidence that nothing happened there.`,
        evidenceRefs,
      });
    }
    sourceTrust.push({
      version: 1,
      id: `operator-source:${sourceId}`,
      sourceId,
      sourceKind: source?.kind ?? contract?.sourceKind ?? 'unknown',
      label,
      summary: `${label}: ${trustState}, freshness ${freshness}`,
      confidence: clamp(trustScore),
      freshness,
      trustState,
      trustScore: clamp(trustScore),
      signalFreshness: contract?.signalFreshness ?? 'unknown',
      ...(contract?.consentState ? { consentState: contract.consentState } : {}),
      ...(contract?.bodyAccessState ? { bodyAccessState: contract.bodyAccessState } : {}),
      negativeEvidence: trustState !== 'blind_spot' && Boolean(explicitLower || passiveLower),
      evidenceRefs,
      cannotKnow,
    });
  }

  return { sourceTrust, blindSpots, conflicts };
}

function buildProjectState(params: {
  contextRouter?: AoiContextRouterResult | null;
  sourceTrust: readonly AoiUnifiedOperatorSourceTrustSnapshot[];
  memories?: readonly AoiMemoryEntry[];
  now: number;
  decayAfterMs: number;
}): { section: AoiUnifiedOperatorEvidenceSection; conflicts: AoiUnifiedOperatorConflict[] } {
  const selectedSources = params.contextRouter?.selectedSources ?? [];
  const freshness = selectedSources.some((source) => source.freshness === 'fresh')
    ? 'fresh'
    : selectedSources.some((source) => source.freshness === 'recent')
      ? 'recent'
      : selectedSources.some((source) => source.freshness === 'stale')
        ? 'stale'
        : 'unknown';
  const projectMemories = (params.memories ?? []).filter(
    (memory) => memory.scope === 'project' || memory.tags.some((tag) => tag.includes('project')),
  );
  const staleProjectMemories = projectMemories.filter(
    (memory) =>
      freshnessFromAge(memory.updatedAt, params.now, params.decayAfterMs) === 'stale' ||
      freshnessFromAge(memory.updatedAt, params.now, params.decayAfterMs) === 'expired',
  );
  const freshSourceTrust = params.sourceTrust.filter((source) => source.freshness === 'fresh');
  const conflicts =
    staleProjectMemories.length > 0 && freshSourceTrust.length > 0
      ? [
          {
            version: 1 as const,
            id: `operator-conflict:fresh-source:${stableHash(
              staleProjectMemories.map((memory) => memory.id).join(','),
            )}`,
            kind: 'fresh_source_over_stale_memory' as const,
            winner: 'fresh_source' as const,
            loser: 'durable_memory' as const,
            summary: 'Fresh source evidence wins over stale project memory.',
            evidenceRefs: uniqueStrings([
              ...staleProjectMemories.map((memory) => `memory:${memory.id}`),
              ...freshSourceTrust.flatMap((source) => source.evidenceRefs),
            ]),
          },
        ]
      : [];
  const summaries = selectedSources.map((source) => sanitizeContextSummary(source));
  return {
    section: {
      version: 1,
      id: 'operator-project-state',
      label: 'Project state',
      summary:
        summaries.length > 0
          ? summaries.slice(0, 3).join(' ')
          : 'No fresh project source was selected for this snapshot.',
      confidence: clamp(
        summaries.length > 0
          ? selectedSources.reduce((total, source) => total + source.confidence, 0) /
              selectedSources.length
          : 0.25,
      ),
      freshness,
      evidenceRefs: uniqueStrings([
        ...(params.contextRouter?.selectedSources.flatMap((source) => source.evidenceRefs) ?? []),
        ...conflicts.flatMap((conflict) => conflict.evidenceRefs),
      ]),
      cannotKnow: uniqueStrings(
        selectedSources.flatMap((source) => [
          ...(source.cannotKnowStatements ?? []),
          ...privateContextCannotKnow(source),
        ]),
        MAX_CANNOT_KNOW,
      ),
    },
    conflicts,
  };
}

function sanitizeContextSummary(source: AoiContextSourceSummary): string {
  if (isPrivateContextSource(source)) {
    return `${sanitizeText(source.label, 'Private source', 100)}: metadata selected; body withheld from operator snapshot.`;
  }
  return `${sanitizeText(source.label, 'Source', 100)}: ${sanitizeText(
    source.summary,
    'source selected',
    180,
  )}`;
}

function isPrivateContextSource(source: AoiContextSourceSummary): boolean {
  return (
    source.redactionState !== 'none' ||
    source.kind === 'gmail_metadata' ||
    source.kind === 'calendar_metadata' ||
    source.kind === 'notes_metadata'
  );
}

function privateContextCannotKnow(source: AoiContextSourceSummary): string[] {
  if (!isPrivateContextSource(source)) {
    return [];
  }
  return [
    `Aoi cannot use ${sanitizeText(
      source.label,
      'private source',
      100,
    )} body content in the operator snapshot without explicit body access consent.`,
  ];
}

function buildMissionState(
  mission: AoiMissionState | null | undefined,
): AoiUnifiedOperatorEvidenceSection {
  if (!mission) {
    return {
      version: 1,
      id: 'operator-mission-state',
      label: 'Mission state',
      summary: 'No active mission state was provided.',
      confidence: 0.2,
      freshness: 'unknown',
      evidenceRefs: [],
      cannotKnow: ['Aoi cannot infer long-horizon mission state without mission evidence.'],
    };
  }
  return {
    version: 1,
    id: 'operator-mission-state',
    label: 'Mission state',
    summary: sanitizeText(
      `${mission.status}: ${mission.focusSummary}; next ${mission.nextRecommendedAction.label}`,
      'mission state',
      260,
    ),
    confidence: 0.78,
    freshness: 'recent',
    evidenceRefs: uniqueStrings(mission.evidenceRefs),
    cannotKnow: mission.blockedReason ? [mission.blockedReason] : [],
  };
}

function buildReadinessState(
  scorecard: AoiJarvisReadinessScorecard | null | undefined,
): AoiUnifiedOperatorReadinessSnapshot {
  if (!scorecard) {
    return {
      version: 1,
      id: 'operator-readiness',
      label: 'Readiness',
      summary: 'No readiness scorecard was provided.',
      confidence: 0.2,
      freshness: 'unknown',
      gateStatus: 'unknown',
      canIncreaseTrust: false,
      dashboard: 'unknown',
      directChat: 'unknown',
      workOrderPrepare: 'unknown',
      blockerRefs: [],
      evidenceRefs: [],
      cannotKnow: ['Aoi cannot know delivery readiness without a readiness scorecard.'],
    };
  }
  return {
    version: 1,
    id: 'operator-readiness',
    label: 'Readiness',
    summary: `${scorecard.gateStatus}; ${scorecard.modeRecommendation}; score ${scorecard.score.toFixed(
      2,
    )}`,
    confidence: clamp(scorecard.score),
    freshness: 'fresh',
    gateStatus: scorecard.gateStatus,
    level: scorecard.level,
    score: scorecard.score,
    canIncreaseTrust: scorecard.canIncreaseTrust,
    dashboard: scorecard.visibility.dashboard,
    directChat: scorecard.visibility.directChat,
    workOrderPrepare: scorecard.visibility.workOrderPrepare,
    blockerRefs: scorecard.blockerRefs,
    evidenceRefs: uniqueStrings([`jarvis-readiness:${scorecard.id}`, ...scorecard.evidenceRefs]),
    cannotKnow: uniqueStrings([
      ...scorecard.visibility.directChatBlockedReasons.map(
        (reason) => `Aoi cannot initiate direct chat because ${reason}.`,
      ),
      ...scorecard.recommendations
        .filter((recommendation) => recommendation.severity === 'blocker')
        .map((recommendation) => recommendation.summary),
    ]),
  };
}

function buildInterruptionTolerance(params: {
  readiness: AoiUnifiedOperatorReadinessSnapshot;
  feedbackSignals: readonly AoiUnifiedOperatorFeedbackSignal[];
}): AoiUnifiedOperatorInterruptionTolerance {
  const deliverySuppressions = params.feedbackSignals.filter(
    (signal) => signal.kind === 'delivery' && signal.direction === 'lower',
  );
  const directChatAllowed =
    params.readiness.directChat === 'allowed' && deliverySuppressions.length <= 0;
  const dashboardAllowed = params.readiness.dashboard === 'allowed';
  const blockedReasons = uniqueStrings([
    ...params.readiness.cannotKnow,
    ...deliverySuppressions.map((signal) => signal.reason),
  ]);
  return {
    version: 1,
    id: 'operator-interruption-tolerance',
    label: 'Interruption tolerance',
    summary: directChatAllowed
      ? 'Direct chat is allowed for high-confidence operator briefs.'
      : dashboardAllowed
        ? 'Dashboard-first delivery is allowed; direct chat remains blocked.'
        : 'Operator-visible delivery is blocked.',
    confidence: directChatAllowed ? 0.82 : dashboardAllowed ? 0.72 : 0.46,
    freshness: params.readiness.freshness,
    directChatAllowed,
    dashboardAllowed,
    deliveryMode: directChatAllowed ? 'direct_chat' : dashboardAllowed ? 'dashboard' : 'blocked',
    blockedReasons,
    evidenceRefs: uniqueStrings([
      ...params.readiness.evidenceRefs,
      ...deliverySuppressions.flatMap((signal) => signal.evidenceRefs),
    ]),
    cannotKnow: blockedReasons,
  };
}

function buildActionAuthority(params: {
  capabilityDecisions?: readonly (AoiCapabilityBrokerDecision | AoiConnectorAuthorityDecision)[];
}): AoiUnifiedOperatorActionAuthority {
  const decisions = params.capabilityDecisions ?? [];
  const unauthorizedMutationCount = decisions.reduce(
    (total, decision) => total + decision.unauthorizedMutationCount,
    0,
  );
  const mutationRequested = decisions.some((decision) => decision.mutationCapable);
  return {
    version: 1,
    id: 'operator-action-authority',
    label: 'Action authority',
    summary: mutationRequested
      ? 'Aoi can prepare and explain actions, but this snapshot grants no execute authority.'
      : 'Aoi authority remains display-only in this snapshot.',
    confidence: 0.95,
    freshness: 'fresh',
    actionAuthority: 'display_only',
    executeAllowed: false,
    mutationCount: 0,
    unauthorizedMutationCount,
    capabilityDecisionRefs: decisions.map((decision) => decision.authorityDecisionId),
    evidenceRefs: uniqueStrings(
      decisions.flatMap((decision) => [
        `authority-decision:${decision.authorityDecisionId}`,
        ...decision.evidenceRefs,
      ]),
    ),
    cannotKnow: uniqueStrings(
      decisions.flatMap((decision) => decision.cannotKnow),
      MAX_CANNOT_KNOW,
    ),
  };
}

function buildFeedbackSection(
  signals: AoiUnifiedOperatorFeedbackSignal[],
  summary: AoiFollowThroughLearningSummary | null | undefined,
): AoiUnifiedOperatorSnapshot['feedback'] {
  const explicitFeedbackCount = signals.filter((signal) => signal.explicit).length;
  const passiveOutcomeCount = signals.filter((signal) => signal.passive).length;
  return {
    version: 1,
    id: 'operator-feedback',
    label: 'Feedback',
    summary: `${explicitFeedbackCount} explicit feedback signal(s), ${passiveOutcomeCount} passive outcome signal(s).`,
    confidence:
      explicitFeedbackCount > 0 ? 0.82 : passiveOutcomeCount > 0 ? 0.38 : summary ? 0.45 : 0.2,
    freshness: summary?.latestEventAt ? 'recent' : 'unknown',
    signals,
    explicitFeedbackCount,
    passiveOutcomeCount,
    evidenceRefs: uniqueStrings([
      ...(summary?.evidenceRefs ?? []),
      ...signals.flatMap((signal) => signal.evidenceRefs),
    ]),
    cannotKnow: uniqueStrings(
      signals
        .filter((signal) => signal.passive || signal.syntheticOnly)
        .map((signal) =>
          signal.syntheticOnly
            ? 'Replay or synthetic evidence can verify safety but cannot raise real-world preference confidence by itself.'
            : 'Passive outcomes are lower-confidence than explicit operator labels.',
        ),
    ),
  };
}

function buildFeedbackConflicts(
  signals: readonly AoiUnifiedOperatorFeedbackSignal[],
): AoiUnifiedOperatorConflict[] {
  const result: AoiUnifiedOperatorConflict[] = [];
  const explicitKeys = new Set(
    signals
      .filter((signal) => signal.explicit)
      .map((signal) => `${normalizeKey(signal.kind)}:${normalizeKey(signal.key)}`),
  );
  for (const signal of signals) {
    const key = `${normalizeKey(signal.kind)}:${normalizeKey(signal.key)}`;
    if (signal.passive && explicitKeys.has(key)) {
      result.push({
        version: 1,
        id: `operator-conflict:feedback:${stableHash(key)}`,
        kind: 'feedback_over_inferred_outcome',
        winner: 'explicit_operator_feedback',
        loser: 'inferred_outcome',
        summary: `Explicit operator feedback wins over passive outcome inference for ${signal.key}.`,
        evidenceRefs: signal.evidenceRefs,
      });
    }
  }
  return result;
}

function copyProfileWithInterests(
  profile: AoiInterestProfile | null | undefined,
  interests: readonly AoiUnifiedOperatorInterestSnapshot[],
): AoiInterestProfile | undefined {
  if (!profile) {
    return undefined;
  }
  const byTopicId = new Map(interests.map((interest) => [interest.topicId, interest]));
  return {
    ...profile,
    generatedAt: profile.generatedAt,
    topics: profile.topics.map((topic) => {
      const interest = byTopicId.get(topic.id);
      if (!interest) {
        return topic;
      }
      return {
        ...topic,
        confidence: interest.confidence,
        importance: interest.relevance,
        muted: interest.muted,
        updatedAt: topic.updatedAt,
        evidenceRefs: uniqueStrings([...topic.evidenceRefs, ...interest.evidenceRefs]),
      };
    }),
  };
}

function buildOperatorLanguage(
  snapshot: Omit<AoiUnifiedOperatorSnapshot, 'operatorLanguageSummary'>,
): string {
  const topInterests = snapshot.interests
    .filter((interest) => !interest.muted)
    .slice(0, 3)
    .map((interest) => `${interest.label} (${interest.relevance.toFixed(2)})`);
  const blindSpots = snapshot.blindSpots
    .slice(0, 3)
    .map((blindSpot) => `${blindSpot.label}: ${blindSpot.reason}`);
  const cannotKnow = snapshot.cannotKnow.slice(0, 3);
  return [
    'Aoi operator snapshot',
    `What I saw: ${topInterests.length > 0 ? topInterests.join(', ') : 'no active interest topic'}; ${snapshot.projectState.summary}`,
    `What I cannot know: ${cannotKnow.length > 0 ? cannotKnow.join(' ') : 'No current blind spot was recorded.'}`,
    `My opinion: ${snapshot.interruptionTolerance.summary}`,
    `Prepared authority: ${snapshot.actionAuthority.summary}`,
    `Blind spots: ${blindSpots.length > 0 ? blindSpots.join('; ') : 'none'}`,
  ].join('\n');
}

export function buildAoiUnifiedOperatorSnapshot(
  input: AoiUnifiedOperatorSnapshotInput,
): AoiUnifiedOperatorSnapshot {
  const sessionPath = sanitizeText(input.sessionPath, 'aoi/default', 160) || 'aoi/default';
  const now = input.now ?? DEFAULT_OPERATOR_SNAPSHOT_NOW;
  const feedbackSignals = buildFeedbackSignals(input.followThroughLearning);
  const interestResult = buildInterestSnapshots({
    profile: input.interestProfile,
    memories: input.memories,
    currentUserMessage: input.currentUserMessage,
    feedbackSignals,
    now,
    decayAfterMs: input.interestDecayAfterMs ?? DEFAULT_INTEREST_DECAY_AFTER_MS,
  });
  const sourceResult = buildSourceTrust({
    sourceRegistry: input.sourceRegistry,
    contracts: input.sourceFreshnessContracts,
    feedbackSignals,
    now,
    decayAfterMs: input.sourceDecayAfterMs ?? DEFAULT_SOURCE_DECAY_AFTER_MS,
  });
  const projectResult = buildProjectState({
    contextRouter: input.contextRouter,
    sourceTrust: sourceResult.sourceTrust,
    memories: input.memories,
    now,
    decayAfterMs: input.sourceDecayAfterMs ?? DEFAULT_SOURCE_DECAY_AFTER_MS,
  });
  const missionState = buildMissionState(input.mission);
  const readiness = buildReadinessState(input.readinessScorecard);
  const feedback = buildFeedbackSection(feedbackSignals, input.followThroughLearning);
  const interruptionTolerance = buildInterruptionTolerance({ readiness, feedbackSignals });
  const actionAuthority = buildActionAuthority({
    capabilityDecisions: input.capabilityDecisions,
  });
  const conflicts = uniqueConflicts([
    ...interestResult.conflicts,
    ...sourceResult.conflicts,
    ...projectResult.conflicts,
    ...buildFeedbackConflicts(feedbackSignals),
  ]);
  const evidenceRefs = uniqueStrings([
    ...interestResult.interests.flatMap((interest) => interest.evidenceRefs),
    ...projectResult.section.evidenceRefs,
    ...missionState.evidenceRefs,
    ...sourceResult.sourceTrust.flatMap((source) => source.evidenceRefs),
    ...feedback.evidenceRefs,
    ...readiness.evidenceRefs,
    ...interruptionTolerance.evidenceRefs,
    ...actionAuthority.evidenceRefs,
    ...sourceResult.blindSpots.flatMap((blindSpot) => blindSpot.evidenceRefs),
    ...conflicts.flatMap((conflict) => conflict.evidenceRefs),
  ]);
  const cannotKnow = uniqueStrings(
    [
      ...interestResult.interests.flatMap((interest) => interest.cannotKnow),
      ...projectResult.section.cannotKnow,
      ...missionState.cannotKnow,
      ...sourceResult.sourceTrust.flatMap((source) => source.cannotKnow),
      ...feedback.cannotKnow,
      ...readiness.cannotKnow,
      ...interruptionTolerance.cannotKnow,
      ...actionAuthority.cannotKnow,
      ...sourceResult.blindSpots.flatMap((blindSpot) => blindSpot.cannotKnow),
    ],
    MAX_CANNOT_KNOW,
  );
  const snapshotBase = {
    version: 1 as const,
    id: `aoi-unified-operator:${stableHash(
      `${sessionPath}:${now}:${evidenceRefs.join(',')}:${cannotKnow.join(',')}`,
    )}`,
    sessionPath,
    generatedAt: now,
    interestProfile: copyProfileWithInterests(input.interestProfile, interestResult.interests),
    interests: interestResult.interests,
    projectState: projectResult.section,
    missionState,
    sourceTrust: sourceResult.sourceTrust,
    feedback,
    readiness,
    interruptionTolerance,
    actionAuthority,
    blindSpots: sourceResult.blindSpots,
    conflicts,
    evidenceRefs,
    cannotKnow,
    actionAuthorityMode: 'display_only' as const,
    mutationCount: 0 as const,
  };
  return {
    ...snapshotBase,
    operatorLanguageSummary: buildOperatorLanguage(snapshotBase),
  };
}

function uniqueConflicts(
  conflicts: readonly AoiUnifiedOperatorConflict[],
): AoiUnifiedOperatorConflict[] {
  const seen = new Set<string>();
  const result: AoiUnifiedOperatorConflict[] = [];
  for (const conflict of conflicts) {
    if (seen.has(conflict.id)) {
      continue;
    }
    seen.add(conflict.id);
    result.push(conflict);
  }
  return result;
}

export function summarizeAoiUnifiedOperatorSnapshot(
  snapshot: AoiUnifiedOperatorSnapshot,
): AoiUnifiedOperatorSnapshotSummary {
  const topInterestLabels = snapshot.interests
    .filter((interest) => !interest.muted)
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, 5)
    .map((interest) => interest.label);
  return {
    version: 1,
    id: snapshot.id,
    sessionPath: snapshot.sessionPath,
    generatedAt: snapshot.generatedAt,
    topInterestLabels,
    readiness: snapshot.readiness.gateStatus,
    interruption: snapshot.interruptionTolerance.deliveryMode,
    blindSpotCount: snapshot.blindSpots.length,
    actionAuthority: 'display_only',
    executeAllowed: false,
    summary: snapshot.operatorLanguageSummary,
    evidenceRefs: uniqueStrings(snapshot.evidenceRefs, 12),
    cannotKnow: uniqueStrings(snapshot.cannotKnow, 8),
    mutationCount: 0,
  };
}

export function buildAoiInterestProfileFromUnifiedOperatorSnapshot(
  snapshot: AoiUnifiedOperatorSnapshot | null | undefined,
): AoiInterestProfile | null {
  return snapshot.interestProfile ?? null;
}

export function formatAoiUnifiedOperatorSnapshotForOperator(
  snapshot: AoiUnifiedOperatorSnapshot,
): string {
  return snapshot.operatorLanguageSummary;
}
