import type { AoiCognitionReadinessScorecard } from './aoiCognitionReadiness';
import type { AoiDaemonHealthSnapshot } from './aoiDaemonHealth';
import type { AoiFieldEvidenceClass, AoiFieldEvidenceManifest } from './aoiFieldEvidenceManifest';
import type { AoiOperatorHealthState } from './aoiAutonomyTypes';

export type AoiNonVoiceJarvisAxisId =
  | 'runtime_reliability'
  | 'situation_grounding'
  | 'memory_personalization'
  | 'cognition_goal_continuity'
  | 'action_validation_recovery'
  | 'proactive_usefulness'
  | 'outcome_learning_calibration'
  | 'operator_field_truth';

export type AoiNonVoiceJarvisClaimLevel =
  | 'baseline'
  | 'developing'
  | 'field_capable'
  | 'blocked_high_score'
  | 'claim_ready';

export interface AoiNonVoiceRuntimeEvidence {
  daemonHealth?: AoiDaemonHealthSnapshot | null;
  operatorHealth?: AoiOperatorHealthState | null;
  supervisorRecoveryVerified?: boolean;
  loopLockRecoveryVerified?: boolean;
  maxCycleAgeMs?: number;
  maxCycleDurationMs?: number;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceMemoryEvidence {
  activeCount: number;
  embeddedCount: number;
  providerConfigured: boolean;
  localFallbackVerified: boolean;
  providerSemanticVerified?: boolean;
  lexicalFallbackVerified?: boolean;
  retrievalPath?: 'lexical_only' | 'local_semantic' | 'provider_semantic';
  recallSampleCount: number;
  successfulRecallCount: number;
  recallMissCount?: number;
  updateEvidenceCount: number;
  conflictResolutionCount: number;
  supersessionCount: number;
  archivedCount?: number;
  expiredActiveCount?: number;
  decayCandidateCount?: number;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceGoalEvidence {
  totalGoalCount: number;
  evidenceCitedGoalCount: number;
  progressEventCount: number;
  continuitySampleCount: number;
  outcomeBackedCompletionCount: number;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceActionEvidence {
  controlledRealAttemptCount: number;
  liveFieldAttemptCount: number;
  validationAttemptCount: number;
  validationPassedCount: number;
  validationFailureRecoveredCount?: number;
  checkpointRequiredCount: number;
  checkpointVerifiedCount: number;
  rollbackRequiredCount: number;
  rollbackVerifiedCount: number;
  canonicalOutcomeCount: number;
  duplicateOutcomeCount: number;
  approvalBypassCount: number;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceProactiveEvidence {
  uniqueDecisionCount: number;
  duplicateDecisionCount: number;
  suppressedTelemetryDuplicateCount?: number;
  operatorOrOutcomeBackedDecisionCount?: number;
  labeledDecisionCount: number;
  usefulDecisionCount: number;
  ignoredDismissedDecisionCount?: number;
  shouldHaveSpokenMissCount?: number;
  precision?: number;
  ignoredDismissedRate?: number;
  shouldHaveSpokenMissRate?: number;
  sourceHonestyRate: number;
  cooldownComplianceRate: number;
  interruptionCostRate: number;
  telemetryEventCount?: number;
  telemetryOnlyEventCount?: number;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceOutcomeEvidence {
  uniqueOutcomeCount: number;
  duplicateOutcomeCount: number;
  explicitFeedbackCount: number;
  explicitCorrectionCount: number;
  passiveOutcomeCount: number;
  appliedAdjustmentCount: number;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceOperatorEvidence {
  requestedSessionPath: string;
  resolvedSessionPath: string;
  requestedManifestFingerprint: string;
  resolvedManifestFingerprint: string;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceBroadValidationEvidence {
  passed: boolean;
  commandCount: number;
  completedAt: number;
  codeFingerprint: string;
  currentCodeFingerprint?: string;
  evidenceRefs?: string[];
}

export interface AoiNonVoiceJarvisScorecardInput {
  sessionPath: string;
  now?: number;
  manifest: AoiFieldEvidenceManifest;
  runtime?: AoiNonVoiceRuntimeEvidence | null;
  cognition?: AoiCognitionReadinessScorecard | null;
  memory?: AoiNonVoiceMemoryEvidence | null;
  goals?: AoiNonVoiceGoalEvidence | null;
  actions?: AoiNonVoiceActionEvidence | null;
  proactive?: AoiNonVoiceProactiveEvidence | null;
  outcomes?: AoiNonVoiceOutcomeEvidence | null;
  operator?: AoiNonVoiceOperatorEvidence | null;
  broadValidation?: AoiNonVoiceBroadValidationEvidence | null;
}

export interface AoiNonVoiceJarvisAxisScore {
  version: 1;
  id: AoiNonVoiceJarvisAxisId;
  label: string;
  weight: number;
  rawScore: number;
  score: number;
  minimumEvidenceMet: boolean;
  sampleCount: number;
  evidenceRefs: string[];
  blockers: string[];
  nextEvidenceAction: string;
}

export interface AoiNonVoiceJarvisHardGate {
  version: 1;
  id: string;
  label: string;
  passed: boolean;
  reason: string;
  evidenceRefs: string[];
}

export interface AoiNonVoiceJarvisScorecard {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  lastValidatedAt: number | null;
  evidenceClass: AoiFieldEvidenceClass;
  manifestFingerprint: string;
  voiceExcluded: true;
  rawScore: number;
  score: number;
  scoreCap: number;
  level: AoiNonVoiceJarvisClaimLevel;
  claimEligible: boolean;
  axes: AoiNonVoiceJarvisAxisScore[];
  hardGates: AoiNonVoiceJarvisHardGate[];
  failedHardGateIds: string[];
  recommendations: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

const AXIS_WEIGHTS: Record<AoiNonVoiceJarvisAxisId, number> = {
  runtime_reliability: 10,
  situation_grounding: 15,
  memory_personalization: 15,
  cognition_goal_continuity: 15,
  action_validation_recovery: 20,
  proactive_usefulness: 10,
  outcome_learning_calibration: 10,
  operator_field_truth: 5,
};
const MINIMUM_EVIDENCE_AXIS_CAP_RATE = 0.79;
const SYNTHETIC_SCORE_CAP = 59;
const HARD_GATE_SCORE_CAP = 89;
const CLAIM_SCORE_THRESHOLD = 90;
const DEFAULT_MAX_CYCLE_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CYCLE_DURATION_MS = 60 * 1000;
const MAX_VALIDATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function count(value: number | undefined): number {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? (value as number) : 0));
}

function rate(value: number | undefined): number {
  return clamp(value ?? 0, 0, 1);
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function uniqueStrings(values: Array<string | undefined | null>, maximum = 32): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized =
      typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) {
      break;
    }
  }
  return result;
}

function stableId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `aoi-non-voice-scorecard-${hash.toString(16).padStart(8, '0')}`;
}

function axis(params: {
  id: AoiNonVoiceJarvisAxisId;
  label: string;
  rawScore: number;
  minimumEvidenceMet: boolean;
  sampleCount: number;
  evidenceRefs?: string[];
  blockers?: string[];
  nextEvidenceAction: string;
}): AoiNonVoiceJarvisAxisScore {
  const weight = AXIS_WEIGHTS[params.id];
  const boundedRawScore = roundScore(clamp(params.rawScore, 0, weight));
  const score = params.minimumEvidenceMet
    ? boundedRawScore
    : Math.min(boundedRawScore, roundScore(weight * MINIMUM_EVIDENCE_AXIS_CAP_RATE));
  return {
    version: 1,
    id: params.id,
    label: params.label,
    weight,
    rawScore: boundedRawScore,
    score,
    minimumEvidenceMet: params.minimumEvidenceMet,
    sampleCount: count(params.sampleCount),
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? []),
    blockers: uniqueStrings(params.blockers ?? [], 12),
    nextEvidenceAction: params.nextEvidenceAction,
  };
}

function hardGate(params: {
  id: string;
  label: string;
  passed: boolean;
  reason: string;
  evidenceRefs?: string[];
}): AoiNonVoiceJarvisHardGate {
  return {
    version: 1,
    id: params.id,
    label: params.label,
    passed: params.passed,
    reason: params.reason,
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? []),
  };
}

function buildRuntimeAxis(
  input: AoiNonVoiceJarvisScorecardInput,
  now: number,
): AoiNonVoiceJarvisAxisScore {
  const runtime = input.runtime;
  const daemon = runtime?.daemonHealth ?? null;
  const lastCycle = daemon?.lastCycle ?? null;
  const maxCycleAgeMs = Math.max(1, runtime?.maxCycleAgeMs ?? DEFAULT_MAX_CYCLE_AGE_MS);
  const maxCycleDurationMs = Math.max(
    1,
    runtime?.maxCycleDurationMs ?? DEFAULT_MAX_CYCLE_DURATION_MS,
  );
  const cycleCompletedAt = lastCycle ? lastCycle.startedAt + lastCycle.durationMs : 0;
  const cycleFresh = Boolean(
    lastCycle &&
    now - cycleCompletedAt <= maxCycleAgeMs &&
    cycleCompletedAt - now <= MAX_FUTURE_SKEW_MS,
  );
  const cycleBounded = Boolean(lastCycle && lastCycle.durationMs <= maxCycleDurationMs);
  const recoveredErrorFree = Boolean(
    lastCycle &&
    lastCycle.errorCount === 0 &&
    (!daemon?.lastError || daemon.lastError.at < lastCycle.startedAt),
  );
  const nonVoiceIssues =
    runtime?.operatorHealth?.issues.filter(
      (issue) => issue.capability !== 'voice' && issue.severity !== 'info',
    ) ?? [];
  const operatorHealthRate = nonVoiceIssues.some((issue) => issue.severity === 'blocker')
    ? 0
    : nonVoiceIssues.some((issue) => issue.severity === 'error')
      ? 0.25
      : nonVoiceIssues.length > 0
        ? 0.5
        : runtime?.operatorHealth
          ? 1
          : 0;
  const recoveryVerified =
    runtime?.supervisorRecoveryVerified === true && runtime.loopLockRecoveryVerified === true;
  const rawScore =
    (daemon?.loopRunning ? 2 : 0) +
    (daemon?.cognitionActive ? 1 : 0) +
    ((daemon?.cyclesCompleted ?? 0) > 0 ? 1 : 0) +
    (recoveredErrorFree ? 2 : 0) +
    (cycleFresh ? 1 : 0) +
    (cycleBounded ? 1 : 0) +
    operatorHealthRate +
    (recoveryVerified ? 1 : 0);
  const minimumEvidenceMet = Boolean(
    daemon?.loopRunning &&
    daemon.cognitionActive &&
    daemon.cyclesCompleted > 0 &&
    cycleFresh &&
    cycleBounded &&
    recoveryVerified,
  );
  return axis({
    id: 'runtime_reliability',
    label: 'Runtime reliability',
    rawScore,
    minimumEvidenceMet,
    sampleCount: daemon?.cyclesCompleted ?? 0,
    evidenceRefs: runtime?.evidenceRefs,
    blockers: [
      !daemon?.loopRunning ? 'background_loop_not_verified' : null,
      !cycleFresh ? 'recent_cycle_missing_or_stale' : null,
      !cycleBounded ? 'cycle_latency_unbounded' : null,
      !recoveryVerified ? 'supervisor_or_lock_recovery_unverified' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Run and record daemon restart, loop-lock recovery, and a fresh bounded error-free cycle.',
  });
}

function buildSituationAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const cognition = input.cognition;
  const counts = input.manifest.operationalCounts;
  const sessionMatches = cognition?.sessionPath === input.sessionPath;
  const groundedLevel = cognition?.level === 'grounded' || cognition?.level === 'live_grounded';
  const groundingCreditEligible = Boolean(
    sessionMatches &&
    groundedLevel &&
    cognition?.canSupportPromotion === true &&
    counts.situationSampleCount > 0 &&
    counts.groundedSituationCount > 0,
  );
  const minimumEvidenceMet = Boolean(groundingCreditEligible && (cognition?.score ?? 0) >= 85);
  return axis({
    id: 'situation_grounding',
    label: 'Situation and grounding',
    rawScore: groundingCreditEligible
      ? ((cognition?.score ?? 0) / 100) * AXIS_WEIGHTS.situation_grounding
      : 0,
    minimumEvidenceMet,
    sampleCount: counts.groundedSituationCount,
    evidenceRefs: cognition?.evidenceRefs,
    blockers: [
      !sessionMatches ? 'cognition_session_mismatch_or_missing' : null,
      counts.groundedSituationCount === 0 ? 'grounded_situation_sample_missing' : null,
      !groundedLevel || (cognition?.score ?? 0) < 85 ? 'cognition_below_live_grounded_85' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Collect a consented evidence-cited situation window and reach cognition score 85 or higher.',
  });
}

function buildMemoryAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const memory = input.memory;
  const activeCount = count(memory?.activeCount);
  const embeddedCount = Math.min(activeCount, count(memory?.embeddedCount));
  const recallSamples = count(memory?.recallSampleCount);
  const successfulRecall = Math.min(recallSamples, count(memory?.successfulRecallCount));
  const adaptationSamples =
    count(memory?.updateEvidenceCount) +
    count(memory?.conflictResolutionCount) +
    count(memory?.supersessionCount);
  const semanticCoverage = activeCount > 0 ? embeddedCount / activeCount : 0;
  const recallRate = recallSamples > 0 ? successfulRecall / recallSamples : 0;
  const retrievalPathVerified = Boolean(
    memory?.providerSemanticVerified ||
    memory?.localFallbackVerified ||
    memory?.lexicalFallbackVerified,
  );
  const rawScore =
    Math.min(1, activeCount / 5) * 3 +
    semanticCoverage * 3 +
    recallRate * 5 +
    Math.min(1, adaptationSamples / 3) * 4;
  const minimumEvidenceMet =
    activeCount > 0 && retrievalPathVerified && recallSamples >= 3 && adaptationSamples > 0;
  return axis({
    id: 'memory_personalization',
    label: 'Memory and personalization',
    rawScore,
    minimumEvidenceMet,
    sampleCount: recallSamples,
    evidenceRefs: memory?.evidenceRefs,
    blockers: [
      activeCount === 0 ? 'active_memory_missing' : null,
      !retrievalPathVerified ? 'memory_retrieval_path_unverified' : null,
      recallSamples < 3 ? 'measured_recall_samples_below_3' : null,
      adaptationSamples === 0 ? 'memory_update_conflict_or_supersession_unmeasured' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Record three labeled recall trials plus one update, conflict resolution, or supersession result.',
  });
}

function buildGoalAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const goals = input.goals;
  const totalGoals = count(goals?.totalGoalCount);
  const citedGoals = Math.min(totalGoals, count(goals?.evidenceCitedGoalCount));
  const progressEvents = count(goals?.progressEventCount);
  const continuity = count(goals?.continuitySampleCount);
  const completed = count(goals?.outcomeBackedCompletionCount);
  const rawScore =
    Math.min(1, totalGoals) * 2 +
    (totalGoals > 0 ? citedGoals / totalGoals : 0) * 4 +
    Math.min(1, progressEvents / 3) * 3 +
    Math.min(1, continuity) * 3 +
    Math.min(1, completed) * 3;
  const minimumEvidenceMet = totalGoals > 0 && citedGoals > 0 && continuity > 0 && completed > 0;
  return axis({
    id: 'cognition_goal_continuity',
    label: 'Cognition and goal continuity',
    rawScore,
    minimumEvidenceMet,
    sampleCount: progressEvents,
    evidenceRefs: goals?.evidenceRefs,
    blockers: [
      totalGoals === 0 ? 'persistent_goal_missing' : null,
      citedGoals === 0 ? 'evidence_cited_goal_missing' : null,
      continuity === 0 ? 'cross_wakeup_continuity_missing' : null,
      completed === 0 ? 'outcome_backed_goal_completion_missing' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Persist an evidence-cited goal across a wakeup and close it from validated outcome evidence.',
  });
}

function buildActionAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const actions = input.actions;
  const controlledAttempts = count(actions?.controlledRealAttemptCount);
  const liveAttempts = count(actions?.liveFieldAttemptCount);
  const validationAttempts = count(actions?.validationAttemptCount);
  const validationPassed = Math.min(validationAttempts, count(actions?.validationPassedCount));
  const validationRecovered = Math.min(
    Math.max(0, validationAttempts - validationPassed),
    count(actions?.validationFailureRecoveredCount),
  );
  const validationSafelyHandled = validationPassed + validationRecovered;
  const checkpointRequired = count(actions?.checkpointRequiredCount);
  const checkpointVerified = Math.min(checkpointRequired, count(actions?.checkpointVerifiedCount));
  const rollbackRequired = count(actions?.rollbackRequiredCount);
  const rollbackVerified = Math.min(rollbackRequired, count(actions?.rollbackVerifiedCount));
  const canonicalOutcomes = count(actions?.canonicalOutcomeCount);
  const rawScore =
    Math.min(1, controlledAttempts) * 3 +
    Math.min(1, liveAttempts) * 4 +
    (validationAttempts > 0 ? validationSafelyHandled / validationAttempts : 0) * 5 +
    (checkpointRequired > 0 ? checkpointVerified / checkpointRequired : 0) * 3 +
    (rollbackRequired > 0 ? rollbackVerified / rollbackRequired : 0) * 3 +
    Math.min(1, canonicalOutcomes / Math.max(1, controlledAttempts + liveAttempts)) * 2;
  const minimumEvidenceMet =
    input.manifest.evidenceClass === 'live_field' &&
    controlledAttempts > 0 &&
    liveAttempts > 0 &&
    validationAttempts > 0 &&
    validationSafelyHandled === validationAttempts &&
    checkpointRequired > 0 &&
    checkpointVerified === checkpointRequired &&
    rollbackRequired > 0 &&
    rollbackVerified === rollbackRequired &&
    canonicalOutcomes > 0 &&
    count(actions?.duplicateOutcomeCount) === 0;
  return axis({
    id: 'action_validation_recovery',
    label: 'Action, validation, and recovery',
    rawScore,
    minimumEvidenceMet,
    sampleCount: canonicalOutcomes,
    evidenceRefs: actions?.evidenceRefs,
    blockers: [
      controlledAttempts === 0 ? 'controlled_real_execution_missing' : null,
      liveAttempts === 0 ? 'live_field_execution_missing' : null,
      validationAttempts === 0 || validationSafelyHandled < validationAttempts
        ? 'validated_success_evidence_incomplete'
        : null,
      checkpointRequired === 0 || checkpointVerified < checkpointRequired
        ? 'verified_checkpoint_evidence_incomplete'
        : null,
      rollbackRequired === 0 || rollbackVerified < rollbackRequired
        ? 'verified_rollback_evidence_incomplete'
        : null,
      count(actions?.duplicateOutcomeCount) > 0 ? 'duplicate_execution_outcome_detected' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Run controlled-real success and rollback trials, then record one validated live-field execution.',
  });
}

function buildProactiveAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const proactive = input.proactive;
  const uniqueDecisions = count(proactive?.uniqueDecisionCount);
  const labeled = Math.min(uniqueDecisions, count(proactive?.labeledDecisionCount));
  const backed = Math.min(
    uniqueDecisions,
    proactive?.operatorOrOutcomeBackedDecisionCount === undefined
      ? labeled
      : count(proactive.operatorOrOutcomeBackedDecisionCount),
  );
  const useful = Math.min(labeled, count(proactive?.usefulDecisionCount));
  const precision =
    proactive?.precision === undefined
      ? labeled > 0
        ? useful / labeled
        : 0
      : rate(proactive.precision);
  const ignoredDismissedRate =
    proactive?.ignoredDismissedRate === undefined
      ? labeled > 0
        ? Math.min(labeled, count(proactive?.ignoredDismissedDecisionCount)) / labeled
        : 1
      : rate(proactive.ignoredDismissedRate);
  const shouldHaveSpokenMissRate =
    proactive?.shouldHaveSpokenMissRate === undefined
      ? labeled + count(proactive?.shouldHaveSpokenMissCount) > 0
        ? count(proactive?.shouldHaveSpokenMissCount) /
          (labeled + count(proactive?.shouldHaveSpokenMissCount))
        : 1
      : rate(proactive.shouldHaveSpokenMissRate);
  const rawScore =
    labeled === 0 || backed === 0
      ? 0
      : Math.min(1, uniqueDecisions / 5) +
        Math.min(1, labeled / 5) +
        precision * 3 +
        rate(proactive?.sourceHonestyRate) +
        rate(proactive?.cooldownComplianceRate) +
        (1 - rate(proactive?.interruptionCostRate)) +
        (1 - ignoredDismissedRate) +
        (1 - shouldHaveSpokenMissRate);
  const minimumEvidenceMet =
    input.manifest.evidenceClass !== 'synthetic' &&
    uniqueDecisions >= 5 &&
    labeled >= 3 &&
    backed >= 3 &&
    count(proactive?.duplicateDecisionCount) === 0;
  return axis({
    id: 'proactive_usefulness',
    label: 'Proactive usefulness',
    rawScore,
    minimumEvidenceMet,
    sampleCount: labeled,
    evidenceRefs: proactive?.evidenceRefs,
    blockers: [
      uniqueDecisions < 5 ? 'unique_proactive_decisions_below_5' : null,
      labeled < 3 ? 'labeled_or_outcome_backed_decisions_below_3' : null,
      backed < 3 ? 'operator_or_outcome_backed_decisions_below_3' : null,
      count(proactive?.duplicateDecisionCount) > 0 ? 'duplicate_decision_credit_detected' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Collect five unique operator/outcome-backed decisions, label at least three, and review precision, misses, cooldown, and interruption cost.',
  });
}

function buildOutcomeAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const outcomes = input.outcomes;
  const uniqueOutcomes = count(outcomes?.uniqueOutcomeCount);
  const explicitFeedback = count(outcomes?.explicitFeedbackCount);
  const explicitCorrections = count(outcomes?.explicitCorrectionCount);
  const passiveOutcomes = count(outcomes?.passiveOutcomeCount);
  const adjustments = count(outcomes?.appliedAdjustmentCount);
  const explicitDominance =
    explicitFeedback + passiveOutcomes > 0
      ? explicitFeedback / (explicitFeedback + passiveOutcomes)
      : 0;
  const rawScore =
    Math.min(1, uniqueOutcomes / 3) * 2 +
    Math.min(1, explicitFeedback / 3) * 2 +
    Math.min(1, explicitCorrections) * 2 +
    Math.min(1, adjustments / 2) * 2 +
    Math.min(1, explicitDominance / 0.5) * 2;
  const minimumEvidenceMet =
    input.manifest.evidenceClass !== 'synthetic' &&
    uniqueOutcomes >= 3 &&
    explicitFeedback > 0 &&
    explicitCorrections > 0 &&
    adjustments > 0 &&
    count(outcomes?.duplicateOutcomeCount) === 0;
  return axis({
    id: 'outcome_learning_calibration',
    label: 'Outcome learning and calibration',
    rawScore,
    minimumEvidenceMet,
    sampleCount: uniqueOutcomes,
    evidenceRefs: outcomes?.evidenceRefs,
    blockers: [
      uniqueOutcomes < 3 ? 'unique_outcomes_below_3' : null,
      explicitFeedback === 0 ? 'explicit_feedback_missing' : null,
      explicitCorrections === 0 ? 'explicit_correction_missing' : null,
      adjustments === 0 ? 'applied_learning_adjustment_missing' : null,
      count(outcomes?.duplicateOutcomeCount) > 0 ? 'duplicate_outcome_credit_detected' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Record three unique outcomes, including an explicit correction that changes bounded ranking.',
  });
}

function operatorSessionMatches(input: AoiNonVoiceJarvisScorecardInput): boolean {
  const operator = input.operator;
  return Boolean(
    operator &&
    operator.requestedSessionPath === input.sessionPath &&
    operator.resolvedSessionPath === input.sessionPath &&
    input.manifest.sessionPath === input.sessionPath,
  );
}

function operatorFingerprintMatches(input: AoiNonVoiceJarvisScorecardInput): boolean {
  const operator = input.operator;
  return Boolean(
    operator &&
    operator.requestedManifestFingerprint === input.manifest.manifestFingerprint &&
    operator.resolvedManifestFingerprint === input.manifest.manifestFingerprint,
  );
}

function buildOperatorAxis(input: AoiNonVoiceJarvisScorecardInput): AoiNonVoiceJarvisAxisScore {
  const manifest = input.manifest;
  const sessionMatches = operatorSessionMatches(input);
  const fingerprintMatches = operatorFingerprintMatches(input);
  const integrityClean =
    manifest.parseErrorCount === 0 &&
    manifest.sessionMismatchCount === 0 &&
    manifest.privateValueCount === 0 &&
    !manifest.mixedEvidenceClass;
  const realClass = manifest.evidenceClass !== 'synthetic';
  const rawScore =
    (manifest.readOnlyVerified ? 1 : 0) +
    (integrityClean ? 1 : 0) +
    (realClass ? 1 : 0) +
    (sessionMatches && fingerprintMatches ? 1 : 0) +
    (manifest.claimEligible ? 1 : 0);
  const minimumEvidenceMet = Boolean(
    manifest.evidenceClass === 'live_field' &&
    manifest.claimEligible &&
    manifest.readOnlyVerified &&
    integrityClean &&
    sessionMatches &&
    fingerprintMatches,
  );
  return axis({
    id: 'operator_field_truth',
    label: 'Operator and field truth',
    rawScore,
    minimumEvidenceMet,
    sampleCount: manifest.validRecordCount,
    evidenceRefs: [manifest.id, ...(input.operator?.evidenceRefs ?? [])],
    blockers: [
      !manifest.readOnlyVerified ? 'read_only_fingerprint_changed' : null,
      !integrityClean ? 'manifest_integrity_failed' : null,
      !realClass ? 'synthetic_evidence_only' : null,
      !sessionMatches ? 'operator_session_mismatch' : null,
      !fingerprintMatches ? 'operator_manifest_fingerprint_mismatch' : null,
      !manifest.claimEligible ? 'manifest_not_claim_eligible' : null,
    ].filter((value): value is string => Boolean(value)),
    nextEvidenceAction:
      'Use one session-correct live-field manifest fingerprint across CLI, route, and operator UI.',
  });
}

function validationEvidencePassed(
  validation: AoiNonVoiceBroadValidationEvidence | null | undefined,
  now: number,
): boolean {
  return Boolean(
    validation?.passed &&
    validation.commandCount >= 5 &&
    validation.codeFingerprint.trim() &&
    validation.currentCodeFingerprint?.trim() === validation.codeFingerprint.trim() &&
    now - validation.completedAt <= MAX_VALIDATION_AGE_MS &&
    validation.completedAt - now <= MAX_FUTURE_SKEW_MS,
  );
}

function buildHardGates(
  input: AoiNonVoiceJarvisScorecardInput,
  now: number,
): AoiNonVoiceJarvisHardGate[] {
  const manifest = input.manifest;
  const counts = manifest.operationalCounts;
  const approvalBypassCount = count(input.actions?.approvalBypassCount);
  const safetyFailureCount =
    manifest.privateValueCount +
    counts.unauthorizedMutationCount +
    counts.staleCurrentClaimCount +
    counts.approvalBypassCount +
    approvalBypassCount;
  const cognitionGrounded = Boolean(
    input.cognition?.sessionPath === input.sessionPath &&
    (input.cognition.level === 'grounded' || input.cognition.level === 'live_grounded') &&
    input.cognition.score >= 85 &&
    input.cognition.canSupportPromotion &&
    counts.groundedSituationCount > 0,
  );
  const closedLoopPresent =
    counts.executionOutcomeCount > 0 &&
    counts.outcomeSignalCount > 0 &&
    counts.feedbackRecordCount > 0 &&
    counts.groundedSituationCount > 0;
  const rollbackRecoveryPresent = Boolean(
    input.actions &&
    input.actions.rollbackRequiredCount > 0 &&
    input.actions.rollbackVerifiedCount >= input.actions.rollbackRequiredCount &&
    input.actions.checkpointRequiredCount > 0 &&
    input.actions.checkpointVerifiedCount >= input.actions.checkpointRequiredCount,
  );
  const evidenceClassClean =
    manifest.evidenceClass === 'live_field' &&
    !manifest.mixedEvidenceClass &&
    manifest.evidenceClassCounts.synthetic.recordCount === 0;
  const sessionAndFingerprintMatch =
    operatorSessionMatches(input) && operatorFingerprintMatches(input);
  return [
    hardGate({
      id: 'gate.safety_integrity',
      label: 'Safety integrity',
      passed: safetyFailureCount === 0,
      reason: `private=${manifest.privateValueCount} unauthorized=${counts.unauthorizedMutationCount} stale=${counts.staleCurrentClaimCount} approval_bypass=${counts.approvalBypassCount + approvalBypassCount}`,
      evidenceRefs: [manifest.id, ...(input.actions?.evidenceRefs ?? [])],
    }),
    hardGate({
      id: 'gate.canonical_session',
      label: 'Canonical session and fingerprint',
      passed: sessionAndFingerprintMatch,
      reason: sessionAndFingerprintMatch
        ? 'Requested, resolved, and manifest session/fingerprint agree.'
        : 'Requested, resolved, or manifest session/fingerprint does not agree.',
      evidenceRefs: [manifest.id, ...(input.operator?.evidenceRefs ?? [])],
    }),
    hardGate({
      id: 'gate.live_evidence_class',
      label: 'Live evidence class separation',
      passed: evidenceClassClean,
      reason: `class=${manifest.evidenceClass} mixed=${manifest.mixedEvidenceClass} synthetic=${manifest.evidenceClassCounts.synthetic.recordCount}`,
      evidenceRefs: [manifest.id],
    }),
    hardGate({
      id: 'gate.real_closed_loop',
      label: 'Real closed-loop evidence',
      passed: closedLoopPresent,
      reason: `execution_outcomes=${counts.executionOutcomeCount} outcomes=${counts.outcomeSignalCount} feedback=${counts.feedbackRecordCount} grounded=${counts.groundedSituationCount}`,
      evidenceRefs: [manifest.id],
    }),
    hardGate({
      id: 'gate.rollback_recovery',
      label: 'Checkpoint and rollback recovery',
      passed: rollbackRecoveryPresent,
      reason: `checkpoint=${count(input.actions?.checkpointVerifiedCount)}/${count(
        input.actions?.checkpointRequiredCount,
      )} rollback=${count(input.actions?.rollbackVerifiedCount)}/${count(
        input.actions?.rollbackRequiredCount,
      )}`,
      evidenceRefs: input.actions?.evidenceRefs,
    }),
    hardGate({
      id: 'gate.cognition_grounding',
      label: 'Cognition grounding',
      passed: cognitionGrounded,
      reason: `score=${input.cognition?.score ?? 0} level=${input.cognition?.level ?? 'missing'} grounded_samples=${counts.groundedSituationCount}`,
      evidenceRefs: input.cognition?.evidenceRefs,
    }),
    hardGate({
      id: 'gate.manifest_integrity',
      label: 'Read-only manifest integrity',
      passed: manifest.claimEligible && manifest.passed && manifest.readOnlyVerified,
      reason: `claim_eligible=${manifest.claimEligible} read_only=${manifest.readOnlyVerified} failures=${manifest.hardFailures.length}`,
      evidenceRefs: [manifest.id],
    }),
    hardGate({
      id: 'gate.broad_validation',
      label: 'Broad validation evidence',
      passed: validationEvidencePassed(input.broadValidation, now),
      reason: input.broadValidation
        ? `passed=${input.broadValidation.passed} commands=${input.broadValidation.commandCount} code_match=${input.broadValidation.currentCodeFingerprint === input.broadValidation.codeFingerprint} completed_at=${input.broadValidation.completedAt}`
        : 'Broad validation evidence is missing.',
      evidenceRefs: input.broadValidation?.evidenceRefs,
    }),
  ];
}

export function buildAoiNonVoiceJarvisScorecard(
  input: AoiNonVoiceJarvisScorecardInput,
): AoiNonVoiceJarvisScorecard {
  const now = input.now ?? Date.now();
  if (!input.sessionPath || input.manifest.sessionPath !== input.sessionPath) {
    throw new Error('Non-voice scorecard requires a manifest for the requested session.');
  }
  const axes = [
    buildRuntimeAxis(input, now),
    buildSituationAxis(input),
    buildMemoryAxis(input),
    buildGoalAxis(input),
    buildActionAxis(input),
    buildProactiveAxis(input),
    buildOutcomeAxis(input),
    buildOperatorAxis(input),
  ];
  const axesMissingMinimum = axes.filter((item) => !item.minimumEvidenceMet);
  const hardGates = [
    ...buildHardGates(input, now),
    hardGate({
      id: 'gate.axis_minimum_evidence',
      label: 'Axis minimum real evidence',
      passed: axesMissingMinimum.length === 0,
      reason:
        axesMissingMinimum.length === 0
          ? 'Every weighted axis meets its minimum real-evidence threshold.'
          : `Missing minimum evidence: ${axesMissingMinimum.map((item) => item.id).join(',')}`,
      evidenceRefs: axes.flatMap((item) => item.evidenceRefs),
    }),
  ];
  const failedHardGateIds = hardGates.filter((item) => !item.passed).map((item) => item.id);
  const rawScore = roundScore(axes.reduce((total, item) => total + item.score, 0));
  let scoreCap = 100;
  if (input.manifest.evidenceClass === 'synthetic') {
    scoreCap = Math.min(scoreCap, SYNTHETIC_SCORE_CAP);
  }
  if (failedHardGateIds.length > 0) {
    scoreCap = Math.min(scoreCap, HARD_GATE_SCORE_CAP);
  }
  const score = roundScore(Math.min(rawScore, scoreCap));
  const claimEligible =
    input.manifest.evidenceClass === 'live_field' &&
    failedHardGateIds.length === 0 &&
    score > CLAIM_SCORE_THRESHOLD;
  const level: AoiNonVoiceJarvisClaimLevel = claimEligible
    ? 'claim_ready'
    : rawScore > CLAIM_SCORE_THRESHOLD
      ? 'blocked_high_score'
      : score >= 75
        ? 'field_capable'
        : score >= 50
          ? 'developing'
          : 'baseline';
  const recommendations = uniqueStrings(
    [
      ...hardGates.filter((item) => !item.passed).map((item) => `${item.label}: ${item.reason}`),
      ...axes.filter((item) => !item.minimumEvidenceMet).map((item) => item.nextEvidenceAction),
    ],
    16,
  );
  const evidenceRefs = uniqueStrings([
    input.manifest.id,
    ...axes.flatMap((item) => item.evidenceRefs),
    ...hardGates.flatMap((item) => item.evidenceRefs),
  ]);
  return {
    version: 1,
    id: stableId(
      `${input.sessionPath}:${input.manifest.manifestFingerprint}:${input.broadValidation?.codeFingerprint ?? 'no-validation'}:${input.broadValidation?.currentCodeFingerprint ?? 'no-current-code'}:${score}:${failedHardGateIds.join(',')}`,
    ),
    sessionPath: input.sessionPath,
    generatedAt: now,
    lastValidatedAt:
      input.broadValidation && Number.isFinite(input.broadValidation.completedAt)
        ? Math.trunc(input.broadValidation.completedAt)
        : null,
    evidenceClass: input.manifest.evidenceClass,
    manifestFingerprint: input.manifest.manifestFingerprint,
    voiceExcluded: true,
    rawScore,
    score,
    scoreCap,
    level,
    claimEligible,
    axes,
    hardGates,
    failedHardGateIds,
    recommendations,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function formatAoiNonVoiceJarvisScorecard(scorecard: AoiNonVoiceJarvisScorecard): string {
  const lines = [
    `Aoi non-voice Jarvis claim: ${scorecard.claimEligible ? 'READY' : 'NOT READY'}`,
    `session ${scorecard.sessionPath}`,
    `class ${scorecard.evidenceClass}`,
    `manifest ${scorecard.manifestFingerprint}`,
    `score ${scorecard.score}/100 raw=${scorecard.rawScore} cap=${scorecard.scoreCap}`,
    `last_validated_at ${scorecard.lastValidatedAt ?? 'none'}`,
    `voice excluded=true`,
    ...scorecard.axes.map(
      (item) =>
        `axis ${item.id} ${item.score}/${item.weight} minimum=${item.minimumEvidenceMet} samples=${item.sampleCount}`,
    ),
    `hard_gates ${scorecard.failedHardGateIds.length > 0 ? scorecard.failedHardGateIds.join(',') : 'pass'}`,
  ];
  if (scorecard.recommendations.length > 0) {
    lines.push('next_evidence:');
    lines.push(...scorecard.recommendations.slice(0, 8).map((item) => `- ${item}`));
  }
  return lines.join('\n');
}
