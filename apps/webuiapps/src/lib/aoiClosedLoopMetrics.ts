// Aoi closed-loop metrics: turn the raw proposal-decision + outcome telemetry
// into per-capability precision / regret / recall numbers that (in a later step)
// feed the Jarvis readiness scorecard's promotion gate.
//
// This is the measurement layer that was missing: today the system stores every
// decision and outcome but only computes session-wide acceptance rates. Here we
// key by capability (the proposal's action kind) and compute, per capability:
//   - proposalPrecision      : of accepted proposals, the fraction that were NOT
//                              later corrected / flagged wrong (correctness).
//   - interruptionPrecision  : of surfaced proposals, the fraction NOT flagged as
//                              too-much / too-frequent / wrong-timing (noise).
//   - actionSuccessRate      : of executed actions, the fraction that succeeded.
//   - memoryRecallQuality    : of memory-citing proposals, the fraction whose
//                              memory was NOT wrong / stale.
//   - recallMiss             : count of "should have spoken" misses (injected
//                              from shadow / feedback-compression telemetry).
//
// Pure and dependency-free (types only) so it is fully unit-testable offline; a
// separate server-side runner loads the telemetry and calls buildAoiClosedLoopMetrics.

import type {
  AoiOutcomeSignalRecord,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
} from './aoiAutonomyTypes';

export const AOI_CLOSED_LOOP_METRICS_VERSION = 1 as const;

// Rolling window and the minimum denominator below which a rate is reported as
// null ("insufficient sample") so the gate never promotes/blocks on noise.
export const DEFAULT_CLOSED_LOOP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLOSED_LOOP_MIN_SAMPLE = 3;

const MAX_EVIDENCE_REFS = 12;

// The catch-all bucket for proposals with no executable action kind (proactive
// briefs, curiosity nudges, ...). Their precision/interruption still matter.
export const CLOSED_LOOP_GENERAL_CAPABILITY = 'general';

export type AoiClosedLoopCapabilityKey =
  | AoiProposalAcceptActionKind
  | typeof CLOSED_LOOP_GENERAL_CAPABILITY;

// Feedback categories that indicate the accepted action was actually wrong.
const CORRECTNESS_FAILURE: ReadonlySet<AoiProposalFeedbackCategory> = new Set([
  'wrong_memory',
  'wrong_evidence',
  'wrong_source',
  'stale',
  'unsafe',
]);

// Feedback categories that indicate surfacing was noisy / mistimed.
const INTERRUPTION_NOISE: ReadonlySet<AoiProposalFeedbackCategory> = new Set([
  'too_much',
  'too_frequent',
  'wrong_timing',
]);

// Feedback categories that indicate the cited memory was wrong.
const MEMORY_FAILURE: ReadonlySet<AoiProposalFeedbackCategory> = new Set(['wrong_memory', 'stale']);

// Outcome kinds that represent an actual execution result (for success rate).
const EXECUTION_OUTCOME_KINDS = new Set([
  'validation_run',
  'commit_created',
  'work_order_approved',
  'work_order_rejected',
  // P5.2: real executed-action outcomes count toward a capability's success rate.
  'proposal_executed',
]);

export interface AoiClosedLoopCapabilityMetric {
  capability: AoiClosedLoopCapabilityKey;
  sampleSize: number; // terminal decisions in window for this capability
  accepted: number;
  dismissed: number;
  corrections: number; // linked user_correction outcomes
  executions: number;
  // Rates are null when the denominator is below minSample (insufficient data);
  // callers/gates must treat null as "no signal", never as pass or fail.
  proposalPrecision: number | null;
  interruptionPrecision: number | null;
  actionSuccessRate: number | null;
  memoryRecallQuality: number | null;
  recallMiss: number; // should_have_spoken count (injected), else 0
  evidenceRefs: string[];
}

export interface AoiClosedLoopMetricsInput {
  sessionPath: string;
  decisions: readonly AoiProposalDecision[];
  outcomes: readonly AoiOutcomeSignalRecord[];
  // Optional should_have_spoken / recall-miss counts per capability, supplied by
  // the runner from shadow-mode + feedback-compression telemetry.
  recallMissByCapability?: Partial<Record<string, number>>;
  now?: number;
  windowMs?: number;
  minSample?: number;
}

export interface AoiClosedLoopMetricsReport {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  windowMs: number;
  minSample: number;
  overall: AoiClosedLoopCapabilityMetric;
  capabilities: AoiClosedLoopCapabilityMetric[];
  evidenceRefs: string[];
}

function rate(numerator: number, denominator: number, minSample: number): number | null {
  if (denominator < minSample || denominator <= 0) {
    return null;
  }
  return Number((numerator / denominator).toFixed(4));
}

function capabilityOf(decision: AoiProposalDecision): AoiClosedLoopCapabilityKey {
  return decision.actionKind ?? CLOSED_LOOP_GENERAL_CAPABILITY;
}

function isAccept(decision: AoiProposalDecision): boolean {
  return decision.action === 'accept' || decision.action === 'execute';
}

function isDismiss(decision: AoiProposalDecision): boolean {
  return decision.action === 'dismiss' || decision.action === 'block';
}

// Reduce the decision log to the latest (terminal) decision per proposal, within
// the window. A proposal snoozed then accepted counts once, as accepted.
function terminalDecisionsInWindow(
  decisions: readonly AoiProposalDecision[],
  cutoff: number,
): AoiProposalDecision[] {
  const byProposal = new Map<string, AoiProposalDecision>();
  for (const decision of decisions) {
    if (decision.createdAt < cutoff) {
      continue;
    }
    const existing = byProposal.get(decision.proposalId);
    if (!existing || decision.createdAt > existing.createdAt) {
      byProposal.set(decision.proposalId, decision);
    }
  }
  return [...byProposal.values()];
}

interface OutcomeIndex {
  correctionDecisionIds: Set<string>;
  correctionProposalIds: Set<string>;
  // capability -> { success, failure } execution tallies
  executionsByCapability: Map<AoiClosedLoopCapabilityKey, { success: number; failure: number }>;
}

function indexOutcomes(
  outcomes: readonly AoiOutcomeSignalRecord[],
  cutoff: number,
  capabilityByDecisionId: Map<string, AoiClosedLoopCapabilityKey>,
  capabilityByProposalId: Map<string, AoiClosedLoopCapabilityKey>,
): OutcomeIndex {
  const correctionDecisionIds = new Set<string>();
  const correctionProposalIds = new Set<string>();
  const executionsByCapability = new Map<
    AoiClosedLoopCapabilityKey,
    { success: number; failure: number }
  >();

  for (const outcome of outcomes) {
    if (outcome.createdAt < cutoff) {
      continue;
    }
    if (outcome.outcomeKind === 'user_correction') {
      if (outcome.sourceDecisionId) {
        correctionDecisionIds.add(outcome.sourceDecisionId);
      }
      if (outcome.sourceProposalId) {
        correctionProposalIds.add(outcome.sourceProposalId);
      }
      continue;
    }
    if (!EXECUTION_OUTCOME_KINDS.has(outcome.outcomeKind)) {
      continue;
    }
    const capability =
      (outcome.sourceDecisionId && capabilityByDecisionId.get(outcome.sourceDecisionId)) ||
      (outcome.sourceProposalId && capabilityByProposalId.get(outcome.sourceProposalId)) ||
      CLOSED_LOOP_GENERAL_CAPABILITY;
    const tally = executionsByCapability.get(capability) ?? { success: 0, failure: 0 };
    const succeeded =
      outcome.result === 'positive' ||
      ((outcome.outcomeKind === 'commit_created' ||
        outcome.outcomeKind === 'work_order_approved') &&
        outcome.result !== 'failed' &&
        outcome.result !== 'blocked' &&
        outcome.result !== 'negative');
    const failed =
      outcome.result === 'failed' ||
      outcome.result === 'blocked' ||
      outcome.result === 'negative' ||
      outcome.outcomeKind === 'work_order_rejected';
    if (succeeded) {
      tally.success += 1;
    } else if (failed) {
      tally.failure += 1;
    }
    executionsByCapability.set(capability, tally);
  }

  return { correctionDecisionIds, correctionProposalIds, executionsByCapability };
}

function computeCapabilityMetric(
  capability: AoiClosedLoopCapabilityKey,
  terminalDecisions: AoiProposalDecision[],
  outcomeIndex: OutcomeIndex,
  recallMiss: number,
  minSample: number,
): AoiClosedLoopCapabilityMetric {
  let accepted = 0;
  let dismissed = 0;
  let goodAccepts = 0;
  let corrections = 0;
  let noisy = 0;
  let memoryCited = 0;
  let memoryBad = 0;
  const evidenceRefs: string[] = [];

  for (const decision of terminalDecisions) {
    if (evidenceRefs.length < MAX_EVIDENCE_REFS) {
      evidenceRefs.push(`decision:${decision.id}`);
    }
    const corrected =
      outcomeIndex.correctionDecisionIds.has(decision.id) ||
      outcomeIndex.correctionProposalIds.has(decision.proposalId);
    if (corrected) {
      corrections += 1;
    }
    const feedback = decision.feedbackCategory;
    if (feedback && INTERRUPTION_NOISE.has(feedback)) {
      noisy += 1;
    }
    if (decision.memoryIds && decision.memoryIds.length > 0) {
      memoryCited += 1;
      if (feedback && MEMORY_FAILURE.has(feedback)) {
        memoryBad += 1;
      }
    }
    if (isAccept(decision)) {
      accepted += 1;
      const correctnessFail = corrected || (feedback ? CORRECTNESS_FAILURE.has(feedback) : false);
      if (!correctnessFail) {
        goodAccepts += 1;
      }
    } else if (isDismiss(decision)) {
      dismissed += 1;
    }
  }

  const execution = outcomeIndex.executionsByCapability.get(capability) ?? {
    success: 0,
    failure: 0,
  };
  const executions = execution.success + execution.failure;

  return {
    capability,
    sampleSize: terminalDecisions.length,
    accepted,
    dismissed,
    corrections,
    executions,
    proposalPrecision: rate(goodAccepts, accepted, minSample),
    interruptionPrecision: rate(
      terminalDecisions.length - noisy,
      terminalDecisions.length,
      minSample,
    ),
    actionSuccessRate: rate(execution.success, executions, minSample),
    memoryRecallQuality: rate(memoryCited - memoryBad, memoryCited, minSample),
    recallMiss,
    evidenceRefs,
  };
}

export function buildAoiClosedLoopMetrics(
  input: AoiClosedLoopMetricsInput,
): AoiClosedLoopMetricsReport {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_CLOSED_LOOP_WINDOW_MS;
  const minSample = Math.max(1, input.minSample ?? DEFAULT_CLOSED_LOOP_MIN_SAMPLE);
  const cutoff = now - windowMs;
  const recallMissByCapability = input.recallMissByCapability ?? {};

  const terminalDecisions = terminalDecisionsInWindow(input.decisions, cutoff);

  const capabilityByDecisionId = new Map<string, AoiClosedLoopCapabilityKey>();
  const capabilityByProposalId = new Map<string, AoiClosedLoopCapabilityKey>();
  const decisionsByCapability = new Map<AoiClosedLoopCapabilityKey, AoiProposalDecision[]>();
  for (const decision of terminalDecisions) {
    const capability = capabilityOf(decision);
    capabilityByDecisionId.set(decision.id, capability);
    capabilityByProposalId.set(decision.proposalId, capability);
    const bucket = decisionsByCapability.get(capability) ?? [];
    bucket.push(decision);
    decisionsByCapability.set(capability, bucket);
  }

  const outcomeIndex = indexOutcomes(
    input.outcomes,
    cutoff,
    capabilityByDecisionId,
    capabilityByProposalId,
  );

  // Any capability that shows up only via execution outcomes (no decision in
  // window) still deserves a metric row.
  const capabilityKeys = new Set<AoiClosedLoopCapabilityKey>([
    ...decisionsByCapability.keys(),
    ...outcomeIndex.executionsByCapability.keys(),
  ]);

  const capabilities = [...capabilityKeys]
    .map((capability) =>
      computeCapabilityMetric(
        capability,
        decisionsByCapability.get(capability) ?? [],
        outcomeIndex,
        Math.max(0, Math.trunc(recallMissByCapability[capability] ?? 0)),
        minSample,
      ),
    )
    .sort(
      (left, right) =>
        right.sampleSize - left.sampleSize ||
        right.executions - left.executions ||
        left.capability.localeCompare(right.capability),
    );

  // Overall rolls up every terminal decision + execution into one bucket, so the
  // gate has a session-wide signal in addition to per-capability breakdowns.
  const overallExecution = { success: 0, failure: 0 };
  for (const tally of outcomeIndex.executionsByCapability.values()) {
    overallExecution.success += tally.success;
    overallExecution.failure += tally.failure;
  }
  const overallIndex: OutcomeIndex = {
    correctionDecisionIds: outcomeIndex.correctionDecisionIds,
    correctionProposalIds: outcomeIndex.correctionProposalIds,
    executionsByCapability: new Map([['overall' as AoiClosedLoopCapabilityKey, overallExecution]]),
  };
  let overallRecallMiss = 0;
  for (const value of Object.values(recallMissByCapability)) {
    overallRecallMiss += Math.max(0, Math.trunc(value ?? 0));
  }
  const overall = computeCapabilityMetric(
    'overall' as AoiClosedLoopCapabilityKey,
    terminalDecisions,
    overallIndex,
    overallRecallMiss,
    minSample,
  );

  return {
    version: AOI_CLOSED_LOOP_METRICS_VERSION,
    sessionPath: input.sessionPath,
    generatedAt: now,
    windowMs,
    minSample,
    overall,
    capabilities,
    evidenceRefs: overall.evidenceRefs.slice(0, MAX_EVIDENCE_REFS),
  };
}
