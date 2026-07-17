import type { AoiFieldEvidenceClass } from './aoiFieldEvidenceManifest';
import type {
  AoiNonVoiceJarvisAxisId,
  AoiNonVoiceJarvisAxisScore,
  AoiNonVoiceJarvisHardGate,
  AoiNonVoiceJarvisScorecard,
} from './aoiNonVoiceJarvisScorecard';

export const AOI_NON_VOICE_SCORECARD_ROUTE = '/api/aoi-autonomy/operator/non-voice-scorecard';

export const AOI_NON_VOICE_EVIDENCE_CLASSES = [
  'live_field',
  'controlled_real',
  'synthetic',
] as const satisfies readonly AoiFieldEvidenceClass[];

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

const CLAIM_LEVELS = new Set([
  'baseline',
  'developing',
  'field_capable',
  'blocked_high_score',
  'claim_ready',
]);

const HARD_GATE_IDS = [
  'gate.safety_integrity',
  'gate.canonical_session',
  'gate.live_evidence_class',
  'gate.real_closed_loop',
  'gate.rollback_recovery',
  'gate.cognition_grounding',
  'gate.manifest_integrity',
  'gate.broad_validation',
  'gate.axis_minimum_evidence',
] as const;

export interface AoiNonVoiceScorecardResponse {
  ok?: boolean;
  sessionPath?: string;
  evidenceClass?: AoiFieldEvidenceClass;
  scorecard?: AoiNonVoiceJarvisScorecard;
}

export interface AoiNonVoiceScorecardPanelResult {
  requestedSessionPath: string;
  resolvedSessionPath: string;
  requestedEvidenceClass: AoiFieldEvidenceClass;
  resolvedEvidenceClass: AoiFieldEvidenceClass;
  scorecard: AoiNonVoiceJarvisScorecard;
}

function isFiniteNumber(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isEvidenceClass(value: unknown): value is AoiFieldEvidenceClass {
  return AOI_NON_VOICE_EVIDENCE_CLASSES.some((item) => item === value);
}

function isAxis(value: unknown): value is AoiNonVoiceJarvisAxisScore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const axis = value as Partial<AoiNonVoiceJarvisAxisScore>;
  const weight = axis.id ? AXIS_WEIGHTS[axis.id] : undefined;
  return (
    axis.version === 1 &&
    typeof axis.id === 'string' &&
    weight !== undefined &&
    axis.weight === weight &&
    typeof axis.label === 'string' &&
    axis.label.length > 0 &&
    isFiniteNumber(axis.rawScore, 0, weight) &&
    isFiniteNumber(axis.score, 0, weight) &&
    axis.score <= axis.rawScore &&
    typeof axis.minimumEvidenceMet === 'boolean' &&
    isFiniteNumber(axis.sampleCount) &&
    Number.isInteger(axis.sampleCount) &&
    isStringArray(axis.evidenceRefs) &&
    isStringArray(axis.blockers) &&
    typeof axis.nextEvidenceAction === 'string' &&
    axis.nextEvidenceAction.length > 0
  );
}

function isHardGate(value: unknown): value is AoiNonVoiceJarvisHardGate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const gate = value as Partial<AoiNonVoiceJarvisHardGate>;
  return (
    gate.version === 1 &&
    typeof gate.id === 'string' &&
    gate.id.length > 0 &&
    typeof gate.label === 'string' &&
    gate.label.length > 0 &&
    typeof gate.passed === 'boolean' &&
    typeof gate.reason === 'string' &&
    isStringArray(gate.evidenceRefs)
  );
}

function hasCanonicalAxes(axes: readonly AoiNonVoiceJarvisAxisScore[]): boolean {
  const expectedIds = Object.keys(AXIS_WEIGHTS);
  return (
    axes.length === expectedIds.length &&
    new Set(axes.map((axis) => axis.id)).size === expectedIds.length
  );
}

function hasCanonicalHardGateState(scorecard: AoiNonVoiceJarvisScorecard): boolean {
  const gateIds = scorecard.hardGates.map((gate) => gate.id);
  if (
    gateIds.length !== HARD_GATE_IDS.length ||
    new Set(gateIds).size !== gateIds.length ||
    HARD_GATE_IDS.some((id) => !gateIds.includes(id)) ||
    !isStringArray(scorecard.failedHardGateIds)
  ) {
    return false;
  }
  const failedFromGates = scorecard.hardGates
    .filter((gate) => !gate.passed)
    .map((gate) => gate.id)
    .sort();
  return (
    JSON.stringify([...scorecard.failedHardGateIds].sort()) === JSON.stringify(failedFromGates)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function expectedClaimLevel(scorecard: AoiNonVoiceJarvisScorecard): string {
  if (scorecard.claimEligible) {
    return 'claim_ready';
  }
  if (scorecard.rawScore > 90) {
    return 'blocked_high_score';
  }
  if (scorecard.score >= 75) {
    return 'field_capable';
  }
  if (scorecard.score >= 50) {
    return 'developing';
  }
  return 'baseline';
}

function isCanonicalScorecard(
  value: unknown,
  sessionPath: string,
  evidenceClass: AoiFieldEvidenceClass,
): value is AoiNonVoiceJarvisScorecard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const scorecard = value as AoiNonVoiceJarvisScorecard;
  if (
    scorecard.version !== 1 ||
    typeof scorecard.id !== 'string' ||
    scorecard.id.length === 0 ||
    scorecard.sessionPath !== sessionPath ||
    scorecard.evidenceClass !== evidenceClass ||
    !isFiniteNumber(scorecard.generatedAt) ||
    !(scorecard.lastValidatedAt === null || isFiniteNumber(scorecard.lastValidatedAt as unknown)) ||
    !/^[a-f0-9]{64}$/.test(scorecard.manifestFingerprint) ||
    scorecard.voiceExcluded !== true ||
    !isFiniteNumber(scorecard.rawScore, 0, 100) ||
    !isFiniteNumber(scorecard.score, 0, 100) ||
    !isFiniteNumber(scorecard.scoreCap, 0, 100) ||
    scorecard.score > scorecard.rawScore ||
    scorecard.score > scorecard.scoreCap ||
    !CLAIM_LEVELS.has(scorecard.level) ||
    typeof scorecard.claimEligible !== 'boolean' ||
    !Array.isArray(scorecard.axes) ||
    !scorecard.axes.every(isAxis) ||
    !hasCanonicalAxes(scorecard.axes) ||
    !Array.isArray(scorecard.hardGates) ||
    !scorecard.hardGates.every(isHardGate) ||
    !isStringArray(scorecard.recommendations) ||
    !isStringArray(scorecard.evidenceRefs) ||
    scorecard.actionAuthority !== 'display_only' ||
    scorecard.mutationCount !== 0 ||
    !hasCanonicalHardGateState(scorecard)
  ) {
    return false;
  }

  const expectedScoreCap =
    evidenceClass === 'synthetic' ? 59 : scorecard.failedHardGateIds.length > 0 ? 89 : 100;
  const expectedRawScore = roundScore(
    scorecard.axes.reduce((total, axis) => total + axis.score, 0),
  );
  const expectedScore = roundScore(Math.min(expectedRawScore, expectedScoreCap));
  const expectedClaimEligible =
    evidenceClass === 'live_field' &&
    scorecard.failedHardGateIds.length === 0 &&
    expectedScore > 90;
  if (
    scorecard.scoreCap !== expectedScoreCap ||
    scorecard.rawScore !== expectedRawScore ||
    scorecard.score !== expectedScore ||
    scorecard.claimEligible !== expectedClaimEligible ||
    scorecard.level !== expectedClaimLevel(scorecard) ||
    (scorecard.claimEligible && scorecard.axes.some((axis) => !axis.minimumEvidenceMet))
  ) {
    return false;
  }
  return true;
}

export function buildAoiNonVoiceScorecardRoute(
  sessionPath: string,
  evidenceClass: AoiFieldEvidenceClass,
): string {
  return `${AOI_NON_VOICE_SCORECARD_ROUTE}?${new URLSearchParams({
    sessionPath,
    evidenceClass,
  }).toString()}`;
}

export function parseAoiNonVoiceScorecardResponse(
  payload: unknown,
  requestedSessionPath: string,
  requestedEvidenceClass: AoiFieldEvidenceClass,
): AoiNonVoiceScorecardPanelResult | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const body = payload as AoiNonVoiceScorecardResponse;
  if (
    body.ok !== true ||
    body.sessionPath !== requestedSessionPath ||
    body.evidenceClass !== requestedEvidenceClass ||
    !isEvidenceClass(body.evidenceClass) ||
    !isCanonicalScorecard(body.scorecard, body.sessionPath, body.evidenceClass)
  ) {
    return null;
  }
  return {
    requestedSessionPath,
    resolvedSessionPath: body.sessionPath,
    requestedEvidenceClass,
    resolvedEvidenceClass: body.evidenceClass,
    scorecard: body.scorecard,
  };
}

export function labelAoiNonVoiceEvidenceClass(evidenceClass: AoiFieldEvidenceClass): string {
  if (evidenceClass === 'live_field') {
    return 'LIVE FIELD';
  }
  if (evidenceClass === 'controlled_real') {
    return 'CONTROLLED REAL';
  }
  return 'SYNTHETIC';
}

export function describeAoiNonVoiceEvidenceClass(evidenceClass: AoiFieldEvidenceClass): string {
  if (evidenceClass === 'live_field') {
    return 'Only live-field evidence can qualify for the 90+ claim.';
  }
  if (evidenceClass === 'controlled_real') {
    return 'Harness-backed evidence only. It cannot substitute for a live-field claim.';
  }
  return 'Test evidence only. The canonical score is capped at 59.';
}

export function selectAoiNonVoiceNextEvidenceAction(scorecard: AoiNonVoiceJarvisScorecard): string {
  const recommendation = scorecard.recommendations.find((item) => item.trim().length > 0);
  if (recommendation) {
    return recommendation;
  }
  const blockedAxis = scorecard.axes.find((axis) => !axis.minimumEvidenceMet);
  if (blockedAxis) {
    return blockedAxis.nextEvidenceAction;
  }
  return scorecard.claimEligible
    ? 'Keep live-field validation current and preserve every hard gate.'
    : 'Refresh the canonical scorecard after collecting the required live evidence.';
}
