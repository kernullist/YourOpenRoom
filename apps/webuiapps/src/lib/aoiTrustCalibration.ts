import type {
  AoiActionCalibration,
  AoiAutonomyRisk,
  AoiCalibrationDimension,
  AoiCalibrationDirection,
  AoiCalibrationEvidence,
  AoiContextSourceFeedback,
  AoiInterruptionPolicy,
  AoiNotificationLane,
  AoiOperatorTimelineEvent,
  AoiOperatorVoiceEventCategory,
  AoiOutcomeSignalRecord,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
  AoiSourceCalibration,
  AoiTriggerCalibration,
  AoiTrustCalibrationProfile,
  AoiTrustCalibrationReset,
} from './aoiAutonomyTypes';

const MAX_EVIDENCE_REFS = 12;
const MAX_RECENT_CHANGES = 24;
const POSITIVE_DELTA = 0.04;
const DISMISS_DELTA = -0.06;
const TOO_MUCH_DELTA = -0.28;
const WRONG_SOURCE_DELTA = -0.3;
const WRONG_EVIDENCE_DELTA = -0.18;
const UNSAFE_STRICTNESS_DELTA = 0.22;
// Outcome-derived calibration deltas: weaker than decision evidence (outcomes are
// mostly passive, confidence <= 0.5) and further scaled by confidence * magnitude.
// The boost delta only applies when the outcome-learning trust gate is open;
// suppress and risk deltas always apply (conservative -- lower usefulness / raise
// strictness). All accumulation stays inside the existing calibration clamps.
const OUTCOME_BOOST_DELTA = 0.03;
const OUTCOME_SUPPRESS_DELTA = -0.05;
const OUTCOME_RISK_DELTA = 0.1;

// Adaptive learning caps. The trust-adjustment clamps start conservative and
// widen with FIELD EVIDENCE, but never past a hard bound:
//  - the positive cap (how much trust may rise) widens ONLY when positive
//    evidence DOMINATES (net positive), up to POSITIVE_CAP_CEILING. This is the
//    autonomy-sensitive direction, so it stays consistency-gated and hard-capped;
//  - the negative floor (how much a kind/source may be de-prioritized) deepens
//    with the VOLUME of negative evidence (more suppression is always safe), down
//    to NEGATIVE_CAP_FLOOR.
// Sparse evidence -> the conservative base (byte-identical to the prior static
// caps). The caps feed ranking / interruption / per-key scoring ONLY; they never
// touch the promotion trigger (canIncreaseTrust does not read this profile), so a
// wider cap cannot enable self-promotion.
const POSITIVE_CAP_BASE = 0.12;
const POSITIVE_CAP_CEILING = 0.2;
const NEGATIVE_CAP_BASE = -0.42;
const NEGATIVE_CAP_FLOOR = -0.5;
const CAP_ADAPT_MIN_EVIDENCE = 8;
const CAP_ADAPT_FULL_EVIDENCE = 24;

export interface AoiTrustCalibrationBuildInput {
  sessionPath: string;
  proposals?: AoiProposal[];
  decisions?: AoiProposalDecision[];
  contextFeedback?: AoiContextSourceFeedback[];
  timelineEvents?: AoiOperatorTimelineEvent[];
  replayFailures?: Array<{ key: string; evidenceRefs?: string[] }>;
  resets?: AoiTrustCalibrationReset[];
  // Outcome signals feed bounded secondary evidence on their linked proposal's
  // trigger / action calibration. outcomeTrustIncreaseAllowed gates the BOOST
  // direction (outcome-only signals cannot raise trust); suppress / risk always
  // apply. Absent or false keeps boosts off (fail-closed).
  outcomes?: AoiOutcomeSignalRecord[];
  outcomeTrustIncreaseAllowed?: boolean;
  now?: number;
}

export interface AoiTrustCalibrationApplication {
  rankingAdjustment: number;
  interruptionAdjustment: number;
  sourceSelectionPenalty: number;
  requiresAskFirst: boolean;
  suppress: boolean;
  requiredEvidenceBoost: number;
  approvalStrictnessBoost: number;
  reasons: string[];
  evidenceRefs: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSessionPath(value: string): string | null {
  const normalized = normalizeWhitespace(value)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.includes('..') ||
    normalized.startsWith('.') ||
    normalized.length > 220
  ) {
    return null;
  }
  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fixed(value: number): number {
  return Number(value.toFixed(3));
}

function dedupeRefs(refs: Array<string | undefined>, maxItems = MAX_EVIDENCE_REFS): string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = normalizeWhitespace(ref ?? '').slice(0, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function calibrationEvidenceId(params: {
  dimension: AoiCalibrationDimension;
  key: string;
  reason: string;
  createdAt: number;
}): string {
  const raw = `${params.dimension}:${params.key}:${params.reason}:${params.createdAt}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `aoi-calibration-${hash.toString(16).padStart(8, '0')}`.slice(0, 127);
}

function getDefaultAoiInterruptionPolicy(): AoiInterruptionPolicy {
  return {
    version: 1,
    defaultThreshold: 0.62,
    askFirstThreshold: 0.52,
    suppressThreshold: 0.24,
    minInterruptionGapMs: 10 * 60 * 1000,
    positiveLearningCap: POSITIVE_CAP_BASE,
    negativeLearningCap: NEGATIVE_CAP_BASE,
  };
}

// Linear 0..1 adaptation fraction: 0 below the minimum evidence threshold, 1 at
// or above the full-adaptation threshold.
function capAdaptFraction(strength: number): number {
  if (strength <= CAP_ADAPT_MIN_EVIDENCE) {
    return 0;
  }
  if (strength >= CAP_ADAPT_FULL_EVIDENCE) {
    return 1;
  }
  return (strength - CAP_ADAPT_MIN_EVIDENCE) / (CAP_ADAPT_FULL_EVIDENCE - CAP_ADAPT_MIN_EVIDENCE);
}

// Derive the learning caps from the assembled evidence. Positive cap widens only
// with NET positive evidence (consistency-gated); negative floor deepens with the
// volume of negative evidence. Both stay inside their hard bounds.
function computeAdaptiveLearningCaps(evidence: AoiCalibrationEvidence[]): {
  positiveLearningCap: number;
  negativeLearningCap: number;
} {
  let positiveCount = 0;
  let negativeCount = 0;
  for (const item of evidence) {
    if (item.direction === 'positive' && item.delta > 0) {
      positiveCount += 1;
    } else if (item.direction === 'negative' && item.delta < 0) {
      negativeCount += 1;
    }
  }
  const netPositive = Math.max(0, positiveCount - negativeCount);
  const positiveLearningCap = fixed(
    POSITIVE_CAP_BASE + (POSITIVE_CAP_CEILING - POSITIVE_CAP_BASE) * capAdaptFraction(netPositive),
  );
  const negativeLearningCap = fixed(
    NEGATIVE_CAP_BASE + (NEGATIVE_CAP_FLOOR - NEGATIVE_CAP_BASE) * capAdaptFraction(negativeCount),
  );
  return { positiveLearningCap, negativeLearningCap };
}

function actionKindFromDecision(decision: AoiProposalDecision): string {
  return decision.actionKind || decision.suggestedTools?.[0] || 'unknown';
}

function triggerKindFromDecision(decision: AoiProposalDecision): string {
  if (decision.proposalTrigger) {
    return decision.proposalTrigger;
  }
  const separator = decision.cooldownKey.indexOf(':');
  return separator > 0 ? decision.cooldownKey.slice(0, separator) : decision.cooldownKey;
}

function sourceKindFromRef(ref: string): string | null {
  if (ref.startsWith('research:')) {
    return 'research_runs';
  }
  if (ref.startsWith('workspace:')) {
    return ref.includes('validation') || ref.includes('build')
      ? 'workspace_build'
      : 'workspace_git';
  }
  if (ref.startsWith('browser:') || ref.includes('browser-context')) {
    return 'browser_context';
  }
  if (ref.startsWith('memory:') || ref.startsWith('kira:')) {
    return 'kira_board';
  }
  if (ref.includes('calendar')) {
    return 'calendar_metadata';
  }
  if (ref.includes('gmail')) {
    return 'gmail_metadata';
  }
  if (ref.includes('notes')) {
    return 'notes_metadata';
  }
  return null;
}

// The source_kind an UNLINKED outcome is about, derived from what its evidence
// points at (first recognized ref). Null when nothing is attributable -> the
// outcome is then skipped (fail-closed), so a chat correction with no concrete
// source never perturbs calibration.
function unlinkedOutcomeSourceKind(outcome: AoiOutcomeSignalRecord): string | null {
  for (const ref of outcome.evidenceRefs ?? []) {
    const kind = sourceKindFromRef(ref);
    if (kind) {
      return kind;
    }
  }
  return null;
}

function sourceKindFromSourceId(sourceId: string): string {
  return sourceId.replace(/-/g, '_') || 'unknown';
}

function sourceKindsFromDecision(decision: AoiProposalDecision): string[] {
  const kinds = new Set<string>();
  for (const ref of decision.evidenceRefs ?? []) {
    const kind = sourceKindFromRef(ref);
    if (kind) {
      kinds.add(kind);
    }
  }
  return [...kinds];
}

function riskFromDecision(
  decision: AoiProposalDecision,
  proposalsById: Map<string, AoiProposal>,
): AoiAutonomyRisk {
  return decision.proposalRisk ?? proposalsById.get(decision.proposalId)?.risk ?? 'low';
}

function addEvidence(
  evidence: AoiCalibrationEvidence[],
  params: {
    dimension: AoiCalibrationDimension;
    key: string;
    direction: AoiCalibrationDirection;
    delta: number;
    reason: string;
    createdAt: number;
    evidenceRefs: string[];
    feedbackCategory?: AoiProposalFeedbackCategory;
    replayBlocked?: boolean;
  },
): void {
  const key = normalizeWhitespace(params.key).slice(0, 120);
  if (!key) {
    return;
  }
  evidence.push({
    version: 1,
    id: calibrationEvidenceId({
      dimension: params.dimension,
      key,
      reason: params.reason,
      createdAt: params.createdAt,
    }),
    dimension: params.dimension,
    key,
    direction: params.direction,
    delta: fixed(params.delta),
    reason: normalizeWhitespace(params.reason).slice(0, 180),
    createdAt: params.createdAt,
    evidenceRefs: dedupeRefs(params.evidenceRefs),
    ...(params.feedbackCategory ? { feedbackCategory: params.feedbackCategory } : {}),
    ...(params.replayBlocked ? { replayBlocked: true } : {}),
  });
}

function resetApplies(reset: AoiTrustCalibrationReset, evidence: AoiCalibrationEvidence): boolean {
  return reset.dimension === evidence.dimension && reset.key === evidence.key;
}

function applyResets(
  evidence: AoiCalibrationEvidence[],
  resets: AoiTrustCalibrationReset[] | undefined,
): AoiCalibrationEvidence[] {
  if (!resets || resets.length === 0) {
    return evidence;
  }
  return evidence.filter(
    (item) => !resets.some((reset) => resetApplies(reset, item) && item.createdAt <= reset.resetAt),
  );
}

function replayFailureBlocks(
  key: string,
  replayFailures: AoiTrustCalibrationBuildInput['replayFailures'],
): boolean {
  return (replayFailures ?? []).some((failure) => failure.key === key);
}

function evidenceFromDecisions(
  params: Required<Pick<AoiTrustCalibrationBuildInput, 'decisions' | 'now'>> & {
    proposalsById: Map<string, AoiProposal>;
    replayFailures?: AoiTrustCalibrationBuildInput['replayFailures'];
  },
): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  for (const decision of params.decisions) {
    const triggerKind = triggerKindFromDecision(decision);
    const actionKind = actionKindFromDecision(decision);
    const risk = riskFromDecision(decision, params.proposalsById);
    const evidenceRefs = dedupeRefs([
      `decision:${decision.id}`,
      `proposal:${decision.proposalId}`,
      decision.cooldownKey,
      ...(decision.evidenceRefs ?? []),
    ]);
    const sourceKinds = sourceKindsFromDecision(decision);
    const accepted = decision.action === 'accept' || decision.feedbackCategory === 'useful';
    const negative = decision.action === 'dismiss' || decision.action === 'snooze';
    const replayBlocked =
      accepted &&
      (replayFailureBlocks(`trigger:${triggerKind}`, params.replayFailures) ||
        replayFailureBlocks(`action:${actionKind}`, params.replayFailures));

    if (accepted) {
      addEvidence(evidence, {
        dimension: 'trigger_kind',
        key: triggerKind,
        direction: replayBlocked ? 'negative' : 'positive',
        delta: replayBlocked ? 0 : POSITIVE_DELTA,
        reason: replayBlocked
          ? 'Replay failure blocked positive trigger promotion.'
          : 'Accepted proposal raised usefulness slowly.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
        replayBlocked,
      });
      addEvidence(evidence, {
        dimension: 'action_kind',
        key: actionKind,
        direction: replayBlocked ? 'negative' : 'positive',
        delta: replayBlocked ? 0 : POSITIVE_DELTA,
        reason: replayBlocked
          ? 'Replay failure blocked positive action promotion.'
          : 'Accepted action raised future visibility slowly.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
        replayBlocked,
      });
    }

    if (negative) {
      const strongTiming =
        decision.feedbackCategory === 'too_much' ||
        decision.feedbackCategory === 'too_frequent' ||
        decision.feedbackCategory === 'wrong_timing';
      addEvidence(evidence, {
        dimension: 'trigger_kind',
        key: triggerKind,
        direction: 'negative',
        delta: strongTiming ? TOO_MUCH_DELTA : DISMISS_DELTA,
        reason: strongTiming
          ? 'Timing feedback lowered interruption threshold for similar triggers.'
          : 'Dismissed proposal lowered usefulness mildly.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
    }

    if (decision.feedbackCategory) {
      addEvidence(evidence, {
        dimension: 'feedback_category',
        key: decision.feedbackCategory,
        direction: decision.feedbackCategory === 'useful' ? 'positive' : 'negative',
        delta:
          decision.feedbackCategory === 'useful'
            ? POSITIVE_DELTA
            : decision.feedbackCategory === 'too_much'
              ? TOO_MUCH_DELTA
              : DISMISS_DELTA,
        reason: `Feedback category ${decision.feedbackCategory} changed calibration.`,
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
    }

    if (decision.feedbackCategory === 'unsafe') {
      addEvidence(evidence, {
        dimension: 'trigger_kind',
        key: triggerKind,
        direction: 'safety',
        delta: UNSAFE_STRICTNESS_DELTA,
        reason: 'Unsafe feedback increased evidence and approval strictness.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
      addEvidence(evidence, {
        dimension: 'action_kind',
        key: actionKind,
        direction: 'safety',
        delta: UNSAFE_STRICTNESS_DELTA,
        reason: 'Unsafe feedback kept matching action approval-gated.',
        createdAt: decision.createdAt,
        evidenceRefs,
        feedbackCategory: decision.feedbackCategory,
      });
    }

    if (
      decision.feedbackCategory === 'wrong_source' ||
      decision.feedbackCategory === 'wrong_evidence'
    ) {
      for (const sourceKind of sourceKinds) {
        addEvidence(evidence, {
          dimension: 'source_kind',
          key: sourceKind,
          direction: 'negative',
          delta:
            decision.feedbackCategory === 'wrong_source'
              ? WRONG_SOURCE_DELTA
              : WRONG_EVIDENCE_DELTA,
          reason:
            decision.feedbackCategory === 'wrong_source'
              ? 'Wrong-source feedback penalized source selection.'
              : 'Wrong-evidence feedback penalized matching source evidence.',
          createdAt: decision.createdAt,
          evidenceRefs,
          feedbackCategory: decision.feedbackCategory,
        });
      }
    }

    addEvidence(evidence, {
      dimension: 'risk_level',
      key: risk,
      direction: accepted ? 'positive' : negative ? 'negative' : 'safety',
      delta: accepted ? POSITIVE_DELTA : negative ? DISMISS_DELTA : 0,
      reason: `Risk level ${risk} observed in proposal decision.`,
      createdAt: decision.createdAt,
      evidenceRefs,
      feedbackCategory: decision.feedbackCategory,
    });
  }
  return evidence;
}

// Outcome signals become bounded secondary calibration evidence.
//
// LINKED outcomes (sourceProposalId resolvable in proposalsById) land on the SAME
// trigger_kind / action_kind vocabulary the ranking path looks up (a proposal's
// trigger / acceptAction). Direction maps conservatively: suppress -> negative,
// risk_up -> safety (strictness), boost -> positive but ONLY when the trust gate
// is open.
//
// UNLINKED outcomes (chat corrections / standalone signals) feed the source_kind
// dimension, keyed on what the outcome is ABOUT (derived from its evidence refs).
// They are held to a STRICTER rule than linked outcomes: they may only LOWER trust
// / raise strictness (suppress -> negative, risk_up -> safety) and NEVER boost,
// regardless of the gate, because their attribution is weaker. Unlinked outcomes
// with no attributable source are skipped.
//
// neutral carries no signal. Deltas are scaled by confidence * magnitude and stay
// inside the existing per-dimension and final calibration clamps.
function evidenceFromOutcomes(params: {
  outcomes: AoiOutcomeSignalRecord[];
  proposalsById: Map<string, AoiProposal>;
  trustIncreaseAllowed: boolean;
}): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  for (const outcome of params.outcomes) {
    const direction = outcome.inferredAdjustment.direction;
    if (direction === 'neutral') {
      continue;
    }
    const weight =
      clamp(outcome.confidence, 0, 1) * clamp(outcome.inferredAdjustment.magnitude, 0, 1);
    if (weight <= 0) {
      continue;
    }
    const proposalId = outcome.sourceProposalId;
    const proposal = proposalId ? params.proposalsById.get(proposalId) : undefined;

    if (!proposal) {
      // Unlinked outcome: an outcome with only a SOURCE (no proposal). Both
      // suppress and risk_up DE-PRIORITIZE that source (source_kind negative);
      // approval-strictness is a proposal-kind concept that does not apply without
      // a proposal. NEVER boosts trust (weaker attribution), regardless of the
      // gate. No attributable source -> skip (fail-closed).
      if (direction === 'boost') {
        continue;
      }
      const sourceKind = unlinkedOutcomeSourceKind(outcome);
      if (!sourceKind) {
        continue;
      }
      // Both suppress and risk_up de-prioritize the source, so both use the
      // (negative) suppress delta; OUTCOME_RISK_DELTA is positive and is meant
      // for the safety/strictness direction, which does not apply without a
      // proposal kind.
      const delta = fixed(OUTCOME_SUPPRESS_DELTA * weight);
      if (delta === 0) {
        continue;
      }
      addEvidence(evidence, {
        dimension: 'source_kind',
        key: sourceKind,
        direction: 'negative',
        delta,
        reason: `Unlinked outcome ${outcome.outcomeKind} (${outcome.signalKind}) ${direction} on source ${sourceKind}.`,
        createdAt: outcome.createdAt,
        evidenceRefs: dedupeRefs([`outcome:${outcome.id}`, ...(outcome.evidenceRefs ?? [])]),
      });
      continue;
    }

    // Linked outcome: trigger_kind + action_kind calibration. Fail-closed gate --
    // a boost may only raise trust when the outcome-learning summary permits it.
    if (direction === 'boost' && !params.trustIncreaseAllowed) {
      continue;
    }
    const calibrationDirection: AoiCalibrationDirection =
      direction === 'boost' ? 'positive' : direction === 'risk_up' ? 'safety' : 'negative';
    const baseDelta =
      direction === 'boost'
        ? OUTCOME_BOOST_DELTA
        : direction === 'risk_up'
          ? OUTCOME_RISK_DELTA
          : OUTCOME_SUPPRESS_DELTA;
    const delta = fixed(baseDelta * weight);
    if (delta === 0) {
      continue;
    }
    const triggerKind = proposal.trigger;
    const actionKind = proposal.acceptAction?.kind ?? proposal.suggestedTools[0] ?? 'unknown';
    const evidenceRefs = dedupeRefs([
      `outcome:${outcome.id}`,
      `proposal:${proposalId}`,
      ...(outcome.evidenceRefs ?? []),
    ]);
    const reason = `Outcome ${outcome.outcomeKind} (${outcome.signalKind}) ${direction} on linked proposal.`;
    addEvidence(evidence, {
      dimension: 'trigger_kind',
      key: triggerKind,
      direction: calibrationDirection,
      delta,
      reason,
      createdAt: outcome.createdAt,
      evidenceRefs,
    });
    addEvidence(evidence, {
      dimension: 'action_kind',
      key: actionKind,
      direction: calibrationDirection,
      delta,
      reason,
      createdAt: outcome.createdAt,
      evidenceRefs,
    });
  }
  return evidence;
}

function evidenceFromContextFeedback(
  feedback: AoiContextSourceFeedback[] | undefined,
): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  for (const item of feedback ?? []) {
    const sourceKind = sourceKindFromSourceId(item.sourceId);
    const wrongSource =
      item.feedbackCategory === 'wrong_source' || item.feedbackCategory === 'wrong_evidence';
    addEvidence(evidence, {
      dimension: 'source_kind',
      key: sourceKind,
      direction: wrongSource ? 'negative' : 'negative',
      delta: wrongSource ? WRONG_SOURCE_DELTA : DISMISS_DELTA,
      reason: wrongSource
        ? 'Context feedback penalized source selection.'
        : `Context feedback ${item.feedbackCategory} reduced source priority.`,
      createdAt: item.createdAt,
      evidenceRefs: dedupeRefs([
        `context-feedback:${item.id}`,
        `environment-source:${item.sourceId}`,
        ...(item.evidenceRefs ?? []),
      ]),
      feedbackCategory: item.feedbackCategory,
    });
  }
  return evidence;
}

function metadataString(event: AoiOperatorTimelineEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function evidenceFromTimeline(
  timelineEvents: AoiOperatorTimelineEvent[] | undefined,
): AoiCalibrationEvidence[] {
  const evidence: AoiCalibrationEvidence[] = [];
  const visibleInterruptions = (timelineEvents ?? [])
    .filter((event) => event.visibility === 'operator_visible')
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const event of timelineEvents ?? []) {
    if (event.kind === 'digest_item_hidden' || event.kind === 'digest_item_surfaced') {
      const lane = metadataString(event, 'lane') as AoiNotificationLane | undefined;
      if (lane) {
        addEvidence(evidence, {
          dimension: 'notification_lane',
          key: lane,
          direction: event.kind === 'digest_item_hidden' ? 'negative' : 'positive',
          delta: event.kind === 'digest_item_hidden' ? DISMISS_DELTA : POSITIVE_DELTA / 2,
          reason:
            event.kind === 'digest_item_hidden'
              ? 'Digest lane was hidden by policy or quiet feedback.'
              : 'Digest lane surfaced to the operator.',
          createdAt: event.createdAt,
          evidenceRefs: event.evidenceRefs,
        });
      }
    }
    if (event.kind === 'operator_voice_decision') {
      const category = event.sourceKind as AoiOperatorVoiceEventCategory | undefined;
      if (category) {
        const spoken = event.status === 'spoken';
        addEvidence(evidence, {
          dimension: 'voice_category',
          key: category,
          direction: spoken ? 'positive' : 'negative',
          delta: spoken ? POSITIVE_DELTA / 2 : DISMISS_DELTA,
          reason: spoken
            ? 'Voice category passed interruption policy.'
            : `Voice category stayed silent: ${event.status ?? 'unknown'}.`,
          createdAt: event.createdAt,
          evidenceRefs: event.evidenceRefs,
        });
      }
    }
  }
  for (let index = 1; index < visibleInterruptions.length; index += 1) {
    const gapMs = visibleInterruptions[index].createdAt - visibleInterruptions[index - 1].createdAt;
    if (gapMs >= 0 && gapMs < getDefaultAoiInterruptionPolicy().minInterruptionGapMs) {
      addEvidence(evidence, {
        dimension: 'interruption_gap',
        key: 'too_close',
        direction: 'negative',
        delta: -0.12,
        reason: 'Operator-visible interruptions happened close together.',
        createdAt: visibleInterruptions[index].createdAt,
        evidenceRefs: visibleInterruptions[index].evidenceRefs,
      });
    }
  }
  return evidence;
}

function summarizeByDimension(
  evidence: AoiCalibrationEvidence[],
  dimension: AoiCalibrationDimension,
): Map<string, AoiCalibrationEvidence[]> {
  const buckets = new Map<string, AoiCalibrationEvidence[]>();
  for (const item of evidence) {
    if (item.dimension !== dimension) {
      continue;
    }
    buckets.set(item.key, [...(buckets.get(item.key) ?? []), item]);
  }
  return buckets;
}

function sumDelta(items: AoiCalibrationEvidence[], min: number, max: number): number {
  return fixed(
    clamp(
      items.reduce((total, item) => total + item.delta, 0),
      min,
      max,
    ),
  );
}

function newestAt(items: AoiCalibrationEvidence[]): number | undefined {
  const newest = Math.max(...items.map((item) => item.createdAt));
  return Number.isFinite(newest) ? newest : undefined;
}

function evidenceRefsFromItems(items: AoiCalibrationEvidence[]): string[] {
  return dedupeRefs(items.flatMap((item) => item.evidenceRefs));
}

function buildTriggerCalibrations(
  evidence: AoiCalibrationEvidence[],
  policy: AoiInterruptionPolicy,
): AoiTriggerCalibration[] {
  return [...summarizeByDimension(evidence, 'trigger_kind').entries()]
    .map(([triggerKind, items]) => {
      const safetyItems = items.filter((item) => item.direction === 'safety');
      const usefulnessScore = sumDelta(
        items.filter((item) => item.direction !== 'safety'),
        policy.negativeLearningCap,
        policy.positiveLearningCap,
      );
      const safetyScore = sumDelta(safetyItems, 0, 0.5);
      return {
        version: 1 as const,
        triggerKind,
        usefulnessScore,
        interruptionScore: fixed(clamp(usefulnessScore - safetyScore, -0.55, 0.16)),
        requiredEvidenceBoost: safetyScore,
        approvalStrictnessBoost: safetyScore,
        evidenceCount: items.length,
        lastUpdatedAt: newestAt(items),
        evidenceRefs: evidenceRefsFromItems(items),
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.interruptionScore) - Math.abs(left.interruptionScore) ||
        right.evidenceCount - left.evidenceCount ||
        left.triggerKind.localeCompare(right.triggerKind),
    )
    .slice(0, 24);
}

function buildSourceCalibrations(evidence: AoiCalibrationEvidence[]): AoiSourceCalibration[] {
  return [...summarizeByDimension(evidence, 'source_kind').entries()]
    .map(([sourceKind, items]) => {
      const usefulnessScore = sumDelta(items, -0.5, 0.12);
      const negativeFeedbackCount = items.filter((item) => item.direction === 'negative').length;
      return {
        version: 1 as const,
        sourceKind,
        usefulnessScore,
        selectionPenalty: fixed(clamp(-Math.min(0, usefulnessScore), 0, 0.5)),
        evidenceCount: items.length,
        negativeFeedbackCount,
        lastUpdatedAt: newestAt(items),
        evidenceRefs: evidenceRefsFromItems(items),
      };
    })
    .sort(
      (left, right) =>
        right.selectionPenalty - left.selectionPenalty ||
        right.negativeFeedbackCount - left.negativeFeedbackCount ||
        left.sourceKind.localeCompare(right.sourceKind),
    )
    .slice(0, 24);
}

function buildActionCalibrations(
  evidence: AoiCalibrationEvidence[],
  policy: AoiInterruptionPolicy,
): AoiActionCalibration[] {
  return [...summarizeByDimension(evidence, 'action_kind').entries()]
    .map(([actionKind, items]) => {
      const safetyItems = items.filter((item) => item.direction === 'safety');
      return {
        version: 1 as const,
        actionKind,
        usefulnessScore: sumDelta(
          items.filter((item) => item.direction !== 'safety'),
          policy.negativeLearningCap,
          policy.positiveLearningCap,
        ),
        approvalStrictnessBoost: sumDelta(safetyItems, 0, 0.5),
        evidenceCount: items.length,
        unsafeFeedbackCount: safetyItems.length,
        lastUpdatedAt: newestAt(items),
        evidenceRefs: evidenceRefsFromItems(items),
      };
    })
    .sort(
      (left, right) =>
        right.approvalStrictnessBoost - left.approvalStrictnessBoost ||
        Math.abs(right.usefulnessScore) - Math.abs(left.usefulnessScore) ||
        left.actionKind.localeCompare(right.actionKind),
    )
    .slice(0, 24);
}

function buildRecordCalibration<T extends string>(
  evidence: AoiCalibrationEvidence[],
  dimension: AoiCalibrationDimension,
  min: number,
  max: number,
): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const [key, items] of summarizeByDimension(evidence, dimension).entries()) {
    result[key as T] = sumDelta(items, min, max);
  }
  return result;
}

export function buildAoiTrustCalibrationProfile(
  input: AoiTrustCalibrationBuildInput,
): AoiTrustCalibrationProfile {
  const sessionPath = normalizeSessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const policy = getDefaultAoiInterruptionPolicy();
  const now = input.now ?? Date.now();
  const proposalsById = new Map((input.proposals ?? []).map((proposal) => [proposal.id, proposal]));
  const evidence = applyResets(
    [
      ...evidenceFromDecisions({
        decisions: input.decisions ?? [],
        proposalsById,
        replayFailures: input.replayFailures,
        now,
      }),
      ...evidenceFromOutcomes({
        outcomes: input.outcomes ?? [],
        proposalsById,
        // Fail-closed: only an explicit true opens the boost gate.
        trustIncreaseAllowed: input.outcomeTrustIncreaseAllowed === true,
      }),
      ...evidenceFromContextFeedback(input.contextFeedback),
      ...evidenceFromTimeline(input.timelineEvents),
    ].sort((left, right) => right.createdAt - left.createdAt),
    input.resets,
  );
  // P1b: learning caps adapt to the assembled field evidence (consistency-gated
  // positive widening, volume-driven negative deepening, hard-bounded). Sparse
  // evidence keeps the conservative base, so this is byte-identical until enough
  // evidence accumulates. The same adaptive caps flow into the per-key clamps.
  const adaptivePolicy: AoiInterruptionPolicy = {
    ...policy,
    ...computeAdaptiveLearningCaps(evidence),
  };
  const triggerCalibrations = buildTriggerCalibrations(evidence, adaptivePolicy);
  const sourceCalibrations = buildSourceCalibrations(evidence);
  const actionCalibrations = buildActionCalibrations(evidence, adaptivePolicy);
  const negativeEvidence = evidence
    .filter((item) => item.direction === 'negative' && item.delta < 0)
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) || right.createdAt - left.createdAt,
    );

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    interruptionPolicy: adaptivePolicy,
    triggerCalibrations,
    sourceCalibrations,
    actionCalibrations,
    riskCalibration: {
      low: buildRecordCalibration<AoiAutonomyRisk>(evidence, 'risk_level', -0.24, 0.08).low ?? 0,
      medium:
        buildRecordCalibration<AoiAutonomyRisk>(evidence, 'risk_level', -0.24, 0.08).medium ?? 0,
      high: buildRecordCalibration<AoiAutonomyRisk>(evidence, 'risk_level', -0.24, 0.08).high ?? 0,
    },
    laneCalibration: buildRecordCalibration<AoiNotificationLane>(
      evidence,
      'notification_lane',
      -0.32,
      0.08,
    ),
    voiceCalibration: buildRecordCalibration<AoiOperatorVoiceEventCategory>(
      evidence,
      'voice_category',
      -0.32,
      0.08,
    ),
    feedbackCalibration: buildRecordCalibration<AoiProposalFeedbackCategory>(
      evidence,
      'feedback_category',
      -0.42,
      0.12,
    ),
    topSuppressedCategories: negativeEvidence.slice(0, 8),
    negativeSources: sourceCalibrations.filter((source) => source.selectionPenalty > 0).slice(0, 8),
    recentChanges: evidence.slice(0, MAX_RECENT_CHANGES),
    resetCategories: input.resets ?? [],
  };
}

export function applyAoiTrustCalibration(params: {
  profile?: AoiTrustCalibrationProfile | null;
  triggerKind?: string;
  sourceKind?: string;
  actionKind?: string;
  risk?: AoiAutonomyRisk;
  notificationLane?: AoiNotificationLane;
  voiceCategory?: AoiOperatorVoiceEventCategory;
  score?: number;
}): AoiTrustCalibrationApplication {
  const profile = params.profile;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let rankingAdjustment = 0;
  let interruptionAdjustment = 0;
  let sourceSelectionPenalty = 0;
  let requiredEvidenceBoost = 0;
  let approvalStrictnessBoost = 0;

  const trigger = profile?.triggerCalibrations.find(
    (item) => item.triggerKind === params.triggerKind,
  );
  if (trigger) {
    rankingAdjustment += trigger.usefulnessScore;
    interruptionAdjustment += trigger.interruptionScore;
    requiredEvidenceBoost += trigger.requiredEvidenceBoost;
    approvalStrictnessBoost += trigger.approvalStrictnessBoost;
    evidenceRefs.push(...trigger.evidenceRefs);
    reasons.push(`trigger:${trigger.triggerKind}:${trigger.interruptionScore}`);
  }

  const source = profile?.sourceCalibrations.find((item) => item.sourceKind === params.sourceKind);
  if (source) {
    rankingAdjustment += source.usefulnessScore;
    sourceSelectionPenalty += source.selectionPenalty;
    evidenceRefs.push(...source.evidenceRefs);
    reasons.push(`source:${source.sourceKind}:-${source.selectionPenalty}`);
  }

  const action = profile?.actionCalibrations.find((item) => item.actionKind === params.actionKind);
  if (action) {
    rankingAdjustment += action.usefulnessScore;
    approvalStrictnessBoost += action.approvalStrictnessBoost;
    evidenceRefs.push(...action.evidenceRefs);
    reasons.push(`action:${action.actionKind}:${action.usefulnessScore}`);
  }

  if (profile && params.risk) {
    rankingAdjustment += profile.riskCalibration[params.risk] ?? 0;
  }
  if (profile && params.notificationLane) {
    interruptionAdjustment += profile.laneCalibration[params.notificationLane] ?? 0;
  }
  if (profile && params.voiceCategory) {
    interruptionAdjustment += profile.voiceCalibration[params.voiceCategory] ?? 0;
  }

  // Adaptive learning caps from the profile (conservative base when evidence is
  // sparse; widened/deepened within hard bounds otherwise). Fall back to the
  // static base when there is no profile.
  const positiveCap = profile?.interruptionPolicy.positiveLearningCap ?? POSITIVE_CAP_BASE;
  const negativeCap = profile?.interruptionPolicy.negativeLearningCap ?? NEGATIVE_CAP_BASE;
  rankingAdjustment = fixed(clamp(rankingAdjustment, negativeCap, positiveCap));
  interruptionAdjustment = fixed(clamp(interruptionAdjustment, negativeCap, positiveCap));
  sourceSelectionPenalty = fixed(clamp(sourceSelectionPenalty, 0, 0.5));
  const adjustedScore = fixed(
    (params.score ?? profile?.interruptionPolicy.defaultThreshold ?? 0) + interruptionAdjustment,
  );
  const strongNegativeInterruption =
    interruptionAdjustment <= -0.28 || sourceSelectionPenalty >= 0.3;
  const suppress =
    Boolean(profile) &&
    (adjustedScore < (profile?.interruptionPolicy.suppressThreshold ?? 0.24) ||
      (strongNegativeInterruption &&
        adjustedScore < (profile?.interruptionPolicy.askFirstThreshold ?? 0.52)));
  const requiresAskFirst =
    Boolean(profile) &&
    adjustedScore < (profile?.interruptionPolicy.askFirstThreshold ?? 0.52) &&
    !suppress;

  return {
    rankingAdjustment,
    interruptionAdjustment,
    sourceSelectionPenalty,
    requiresAskFirst,
    suppress,
    requiredEvidenceBoost: fixed(clamp(requiredEvidenceBoost, 0, 0.5)),
    approvalStrictnessBoost: fixed(clamp(approvalStrictnessBoost, 0, 0.5)),
    reasons,
    evidenceRefs: dedupeRefs(evidenceRefs),
  };
}
