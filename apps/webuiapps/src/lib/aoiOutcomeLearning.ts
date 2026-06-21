import type {
  AoiFollowThroughAction,
  AoiFollowThroughDeliveryMode,
  AoiFollowThroughEvent,
  AoiFollowThroughResult,
  AoiLearningSignalKind,
  AoiOutcomeLearningAdjustment,
  AoiOutcomeLearningDirection,
  AoiOutcomeLearningSummary,
  AoiOutcomeLearningTarget,
  AoiOutcomePrivacyState,
  AoiOutcomeSignalKind,
  AoiOutcomeSignalRecord,
} from './aoiAutonomyTypes';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';
import {
  normalizeAoiFollowThroughEvent,
  normalizeAoiFollowThroughKey,
} from './aoiFollowThroughLearning';

const MAX_REFS = 24;
const DEFAULT_NOW = 1_800_000_000_000;

export interface AoiOutcomeSignalInput {
  id?: string;
  sessionPath: string;
  eventId?: string;
  sourceProposalId?: string;
  sourceDecisionId?: string;
  sourceWorkOrderId?: string;
  sourceValidationRef?: string;
  sourceCommitRef?: string;
  sourceChatRef?: string;
  outcomeKind: AoiOutcomeSignalKind;
  signalKind?: AoiLearningSignalKind;
  confidence?: number;
  explicitLabelRef?: string;
  explicitLabel?: string;
  topicKey?: string;
  sourceKey?: string;
  deliveryMode?: AoiFollowThroughDeliveryMode;
  validationPassed?: boolean;
  evidenceRefs?: readonly string[];
  privacyState?: AoiOutcomePrivacyState;
  createdAt?: number;
}

type RawOutcomeSignalInput = Partial<AoiOutcomeSignalInput> & Partial<AoiOutcomeSignalRecord>;

interface OutcomePolicy {
  confidence: number;
  action: AoiFollowThroughAction;
  result: AoiFollowThroughResult;
  target: AoiOutcomeLearningTarget;
  direction: AoiOutcomeLearningDirection;
  magnitude: number;
  reason: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, fallback = '', maxChars = 220): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = normalizeWhitespace(raw || fallback)
    .replace(/\b(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[local path]')
    .replace(/(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g, '[local path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
    .replace(
      /\b(token|secret|api[_ -]?key|access[_ -]?token)\s*[:=]?\s*[A-Za-z0-9_=-]{16,}/gi,
      '$1=[redacted-token]',
    )
    .replace(
      /\b(body|content|messageBody|rawText|transcript)\s*[:=]\s*([^.;\n]{6,})/gi,
      (_match, key: string, body: string) => {
        const residue = body
          .replace(/\[(?:private email|local path|redacted-token)\]/gi, '')
          .replace(/\b(?:token|secret|api[_ -]?key|access[_ -]?token)\s*[:=]?\s*/gi, '')
          .trim();
        if (!residue) {
          return `${key}=${body.trim()}`;
        }
        return `${key}=[private body withheld]`;
      },
    );
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`
    : normalized;
}

function uniqueStrings(values: readonly unknown[], limit = MAX_REFS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = sanitizeText(value, '', 220);
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

function stableOutcomeId(input: AoiOutcomeSignalInput, now: number): string {
  return `aoi-outcome-${hashText(
    [
      input.sessionPath,
      input.eventId,
      input.sourceProposalId,
      input.sourceDecisionId,
      input.outcomeKind,
      input.explicitLabelRef,
      now,
    ]
      .filter(Boolean)
      .join(':'),
  )}`;
}

function normalizePrivacyState(value: unknown): AoiOutcomePrivacyState {
  if (
    value === 'metadata_only' ||
    value === 'redacted' ||
    value === 'synthetic' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'metadata_only';
}

function defaultSignalKind(input: AoiOutcomeSignalInput): AoiLearningSignalKind {
  if (input.explicitLabelRef) {
    return 'explicit_label';
  }
  if (input.outcomeKind === 'user_correction') {
    return 'explicit_correction';
  }
  return 'passive_outcome';
}

function defaultPolicy(input: AoiOutcomeSignalInput): OutcomePolicy {
  switch (input.outcomeKind) {
    case 'proposal_opened':
      return {
        confidence: 0.24,
        action: 'accepted',
        result: 'positive',
        target: 'topic',
        direction: 'boost',
        magnitude: 0.12,
        reason: 'Proposal opened is a weak interest signal, not a proof of usefulness.',
      };
    case 'proposal_ignored':
      return {
        confidence: 0.16,
        action: 'ignored',
        result: 'soft_negative',
        target: 'timing',
        direction: 'suppress',
        magnitude: 0.08,
        reason: 'Ignored proposal only nudges timing down softly.',
      };
    case 'direct_chat_dismissed':
      return {
        confidence: 0.32,
        action: 'dismissed',
        result: 'negative',
        target: 'timing',
        direction: 'suppress',
        magnitude: 0.18,
        reason:
          'Dismissed direct chat lowers delivery sensitivity without proving the topic is bad.',
      };
    case 'work_order_approved':
      return {
        confidence: 0.42,
        action: 'accepted',
        result: 'positive',
        target: 'readiness',
        direction: 'boost',
        magnitude: 0.22,
        reason:
          'Approved work order suggests the proposal was actionable but still needs explicit trust evidence.',
      };
    case 'work_order_rejected':
      return {
        confidence: 0.48,
        action: 'blocked',
        result: 'negative',
        target: 'readiness',
        direction: 'suppress',
        magnitude: 0.28,
        reason: 'Rejected work order reduces readiness for similar preparation.',
      };
    case 'validation_run':
      return {
        confidence: input.validationPassed === false ? 0.5 : 0.38,
        action: input.validationPassed === false ? 'failed' : 'executed',
        result: input.validationPassed === false ? 'failed' : 'positive',
        target: 'readiness',
        direction: input.validationPassed === false ? 'suppress' : 'boost',
        magnitude: input.validationPassed === false ? 0.3 : 0.18,
        reason:
          input.validationPassed === false
            ? 'Failed validation is a stronger readiness warning.'
            : 'Validation run is useful evidence but does not bypass approval or privacy gates.',
      };
    case 'commit_created':
      return {
        confidence: 0.44,
        action: 'executed',
        result: 'positive',
        target: 'readiness',
        direction: 'boost',
        magnitude: 0.2,
        reason: 'Commit created is a success signal but not a privacy or mutation-safety waiver.',
      };
    case 'user_correction':
      return {
        confidence: 0.62,
        action: 'dismissed',
        result: 'negative',
        target: 'source',
        direction: 'risk_up',
        magnitude: 0.36,
        reason: 'User correction raises stale or wrong-source risk for similar suggestions.',
      };
  }
}

function normalizeDeliveryMode(value: unknown): AoiFollowThroughDeliveryMode {
  if (
    value === 'dashboard' ||
    value === 'inline_card' ||
    value === 'quiet_notification' ||
    value === 'direct_chat' ||
    value === 'digest' ||
    value === 'chat_hook' ||
    value === 'hidden' ||
    value === 'blocked'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeOutcomeKind(value: unknown): AoiOutcomeSignalKind | null {
  if (
    value === 'proposal_opened' ||
    value === 'proposal_ignored' ||
    value === 'direct_chat_dismissed' ||
    value === 'work_order_approved' ||
    value === 'work_order_rejected' ||
    value === 'validation_run' ||
    value === 'commit_created' ||
    value === 'user_correction'
  ) {
    return value;
  }
  return null;
}

function normalizeSignalKind(
  value: unknown,
  fallback: AoiLearningSignalKind,
): AoiLearningSignalKind {
  if (
    value === 'explicit_label' ||
    value === 'explicit_correction' ||
    value === 'passive_outcome'
  ) {
    return value;
  }
  return fallback;
}

export function normalizeAoiOutcomeSignalRecord(
  input: RawOutcomeSignalInput,
  sessionPathFallback = 'aoi/default',
  now = DEFAULT_NOW,
): AoiOutcomeSignalRecord | null {
  const explicitLabelRef = sanitizeText(input.explicitLabelRef, '', 160);
  const sessionPath = normalizeAoiAutonomySessionPath(
    sanitizeText(input.sessionPath, sessionPathFallback, 180),
  );
  const outcomeKind = normalizeOutcomeKind(input.outcomeKind);
  if (!sessionPath || !outcomeKind) {
    return null;
  }

  const policyInput: AoiOutcomeSignalInput = {
    ...input,
    sessionPath,
    outcomeKind,
  };
  const policy = defaultPolicy(policyInput);
  const fallbackSignalKind = defaultSignalKind(policyInput);
  const requestedSignalKind = normalizeSignalKind(input.signalKind, fallbackSignalKind);
  const signalKind = explicitLabelRef
    ? 'explicit_label'
    : requestedSignalKind === 'explicit_label'
      ? fallbackSignalKind === 'explicit_label'
        ? 'explicit_label'
        : 'passive_outcome'
      : requestedSignalKind;
  const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now;
  const explicitLabel = sanitizeText(input.explicitLabel, '', 120);
  const existingAdjustment = input.inferredAdjustment;
  const confidence = clamp(
    typeof input.confidence === 'number' ? input.confidence : policy.confidence,
    0.05,
    signalKind === 'passive_outcome' ? 0.5 : 0.72,
  );
  const inferredAdjustment: AoiOutcomeLearningAdjustment = {
    version: 1,
    target: existingAdjustment?.target ?? policy.target,
    direction: existingAdjustment?.direction ?? policy.direction,
    magnitude: clamp(existingAdjustment?.magnitude ?? policy.magnitude, 0, 1),
    reason: sanitizeText(existingAdjustment?.reason, policy.reason, 220),
  };
  const eventId =
    sanitizeText(input.eventId, '', 160) ||
    stableOutcomeId({ ...(input as AoiOutcomeSignalInput), sessionPath, outcomeKind }, createdAt);
  const id = sanitizeText(input.id, '', 160) || eventId;
  const evidenceRefs = uniqueStrings(
    [
      `outcome:${eventId}`,
      input.sourceProposalId ? `proposal:${input.sourceProposalId}` : undefined,
      input.sourceDecisionId ? `decision:${input.sourceDecisionId}` : undefined,
      input.sourceWorkOrderId ? `bounded-work-order:${input.sourceWorkOrderId}` : undefined,
      input.sourceValidationRef,
      input.sourceCommitRef,
      input.sourceChatRef,
      explicitLabelRef,
      ...(input.evidenceRefs ?? []),
    ],
    MAX_REFS,
  );

  return {
    version: 1,
    id,
    sessionPath,
    eventId,
    ...(sanitizeText(input.sourceProposalId, '', 160)
      ? { sourceProposalId: sanitizeText(input.sourceProposalId, '', 160) }
      : {}),
    ...(sanitizeText(input.sourceDecisionId, '', 160)
      ? { sourceDecisionId: sanitizeText(input.sourceDecisionId, '', 160) }
      : {}),
    ...(sanitizeText(input.sourceWorkOrderId, '', 160)
      ? { sourceWorkOrderId: sanitizeText(input.sourceWorkOrderId, '', 160) }
      : {}),
    ...(sanitizeText(input.sourceValidationRef, '', 180)
      ? { sourceValidationRef: sanitizeText(input.sourceValidationRef, '', 180) }
      : {}),
    ...(sanitizeText(input.sourceCommitRef, '', 180)
      ? { sourceCommitRef: sanitizeText(input.sourceCommitRef, '', 180) }
      : {}),
    ...(sanitizeText(input.sourceChatRef, '', 180)
      ? { sourceChatRef: sanitizeText(input.sourceChatRef, '', 180) }
      : {}),
    outcomeKind,
    signalKind,
    confidence,
    inferredAdjustment,
    ...(explicitLabelRef ? { explicitLabelRef } : {}),
    ...(explicitLabel ? { explicitLabel } : {}),
    ...(normalizeAoiFollowThroughKey(input.topicKey)
      ? { topicKey: normalizeAoiFollowThroughKey(input.topicKey) }
      : {}),
    ...(normalizeAoiFollowThroughKey(input.sourceKey)
      ? { sourceKey: normalizeAoiFollowThroughKey(input.sourceKey) }
      : {}),
    deliveryMode: normalizeDeliveryMode(input.deliveryMode),
    result: policy.result,
    evidenceRefs,
    privacyState: normalizePrivacyState(input.privacyState),
    createdAt,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiFollowThroughEventFromOutcomeSignal(
  outcome: AoiOutcomeSignalRecord,
  now = DEFAULT_NOW,
): AoiFollowThroughEvent {
  const policy = defaultPolicy({
    sessionPath: outcome.sessionPath,
    outcomeKind: outcome.outcomeKind,
    validationPassed: outcome.result !== 'failed',
  });
  return normalizeAoiFollowThroughEvent(
    {
      id: `aoi-follow-through-outcome-${hashText(outcome.id)}`,
      sessionPath: outcome.sessionPath,
      opportunityId: outcome.sourceProposalId
        ? `proposal:${outcome.sourceProposalId}`
        : outcome.sourceChatRef || outcome.eventId,
      proposalId: outcome.sourceProposalId,
      sourceKind: outcome.sourceProposalId ? 'proposal' : 'app_state',
      topicKey: outcome.topicKey ?? outcome.sourceProposalId ?? outcome.eventId,
      sourceKey: outcome.sourceKey ?? outcome.outcomeKind,
      deliveryMode: outcome.deliveryMode,
      action: policy.action,
      feedbackCategory: `outcome:${outcome.outcomeKind}`,
      learningSignalKind: outcome.signalKind,
      outcomeSignalId: outcome.id,
      outcomeKind: outcome.outcomeKind,
      confidence: outcome.confidence,
      learningEffect: outcome.inferredAdjustment,
      trustIncreaseEligible: Boolean(outcome.explicitLabelRef),
      result: outcome.result,
      timingLabel: `outcome ${outcome.outcomeKind}`,
      evidenceRefs: outcome.evidenceRefs,
      createdAt: outcome.createdAt,
    },
    outcome.sessionPath,
    now,
  )!;
}

export function buildAoiOutcomeLearningSummary(params: {
  sessionPath: string;
  outcomes: readonly Partial<AoiOutcomeSignalRecord | AoiOutcomeSignalInput>[];
  fieldReadinessEvidence?: boolean;
  now?: number;
}): AoiOutcomeLearningSummary {
  const now = params.now ?? DEFAULT_NOW;
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath) ?? params.sessionPath;
  const outcomes = params.outcomes
    .map((item) => normalizeAoiOutcomeSignalRecord(item, sessionPath, now))
    .filter((item): item is AoiOutcomeSignalRecord => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  const explicitLabelLinkedCount = outcomes.filter((item) => item.explicitLabelRef).length;
  const explicitCorrectionCount = outcomes.filter(
    (item) => item.signalKind === 'explicit_correction',
  ).length;
  const passiveOutcomeCount = outcomes.filter(
    (item) => item.signalKind === 'passive_outcome',
  ).length;
  const outcomeOnly =
    outcomes.length > 0 && explicitLabelLinkedCount <= 0 && params.fieldReadinessEvidence !== true;
  const trustIncreaseAllowed = !outcomeOnly;
  const trustIncreaseBlockedReasons = uniqueStrings(
    [
      outcomeOnly
        ? 'outcome-only signals cannot increase trust without explicit labels or field readiness'
        : undefined,
      passiveOutcomeCount > 0
        ? `${passiveOutcomeCount} passive outcome signal(s) are low-confidence calibration only`
        : undefined,
    ],
    6,
  );

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    outcomeCount: outcomes.length,
    explicitLabelLinkedCount,
    explicitCorrectionCount,
    passiveOutcomeCount,
    outcomeOnly,
    trustIncreaseAllowed,
    trustIncreaseBlockedReasons,
    kindConfidenceLabels: uniqueStrings(
      outcomes.map(
        (item) =>
          `${item.outcomeKind}: confidence ${item.confidence.toFixed(2)} (${item.signalKind})`,
      ),
      12,
    ),
    learningEffectLabels: uniqueStrings(
      outcomes.map(
        (item) =>
          `${item.outcomeKind}: ${item.inferredAdjustment.target} ${item.inferredAdjustment.direction} x${item.inferredAdjustment.magnitude.toFixed(
            2,
          )}`,
      ),
      12,
    ),
    previousSuggestionOutcomeLabels: uniqueStrings(
      outcomes.map((item) => {
        const target = item.sourceProposalId
          ? `proposal ${item.sourceProposalId}`
          : item.sourceChatRef
            ? `chat ${item.sourceChatRef}`
            : item.eventId;
        return `${target} -> ${item.outcomeKind} (${item.result}, confidence ${item.confidence.toFixed(
          2,
        )})`;
      }),
      12,
    ),
    evidenceRefs: uniqueStrings(
      [
        'outcome-learning:v1',
        ...outcomes.flatMap((item) => [`outcome:${item.id}`, ...item.evidenceRefs.slice(0, 2)]),
      ],
      MAX_REFS,
    ),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}
