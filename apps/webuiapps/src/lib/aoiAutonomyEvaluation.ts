import { loadAoiGoalProgressEvents } from './aoiAutonomyGoals';
import {
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import type {
  AoiGoalProgressEvent,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
} from './aoiAutonomyTypes';

const FEEDBACK_CATEGORIES: AoiProposalFeedbackCategory[] = [
  'useful',
  'not_useful',
  'wrong_memory',
  'wrong_evidence',
  'stale',
  'too_frequent',
  'too_much',
  'wrong_timing',
  'unsafe',
  'already_done',
  'needs_more_detail',
];

export interface AoiFeedbackCategoryMetric {
  category: AoiProposalFeedbackCategory;
  count: number;
  dismissRate: number;
}

export interface AoiAutonomyEvaluationMetrics {
  totalProposals: number;
  totalDecisions: number;
  proposalAcceptanceRate: number;
  proposalDismissRate: number;
  dismissRateByCategory: AoiFeedbackCategoryMetric[];
  duplicateCooldownViolationCount: number;
  evidenceCoverage: number;
  staleMemoryReuseCount: number;
  blockedHighRiskProposalCount: number;
  acceptedExecutionSuccessRate: number;
  goalContinuationUsefulness: number | null;
}

export interface AoiCalibrationBucket {
  key: string;
  count: number;
}

export interface AoiNoisyProposalType {
  key: string;
  dismissCount: number;
  tooFrequentCount: number;
  notUsefulCount: number;
}

export interface AoiAutonomyCalibrationReport {
  noisyProposalTypes: AoiNoisyProposalType[];
  wrongMemoryRefs: AoiCalibrationBucket[];
  blockedActionKinds: AoiCalibrationBucket[];
  staleMemoryRefs: AoiCalibrationBucket[];
  highRiskProposalCount: number;
  highRiskProposalRate: number;
  highRiskBlockedCount: number;
}

export interface AoiAutonomyEvaluationResult {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  metrics: AoiAutonomyEvaluationMetrics;
  calibration: AoiAutonomyCalibrationReport;
}

export interface AoiAutonomyEvaluationRecords {
  sessionPath: string;
  proposals: AoiProposal[];
  decisions: AoiProposalDecision[];
  goalProgress?: AoiGoalProgressEvent[];
  now?: number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

function countBy(items: string[]): AoiCalibrationBucket[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.trim();
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, 12);
}

function proposalKeyFromDecision(decision: AoiProposalDecision): string {
  if (decision.proposalTrigger) {
    return decision.proposalTrigger;
  }
  const separator = decision.cooldownKey.indexOf(':');
  return separator > 0 ? decision.cooldownKey.slice(0, separator) : decision.cooldownKey;
}

function actionKindFromDecision(decision: AoiProposalDecision): string {
  if (decision.actionKind) {
    return decision.actionKind;
  }
  if (decision.suggestedTools?.[0]) {
    return decision.suggestedTools[0];
  }
  return 'unknown';
}

function isPrimaryDecision(decision: AoiProposalDecision): boolean {
  return (
    decision.action === 'accept' || decision.action === 'dismiss' || decision.action === 'snooze'
  );
}

function isNegativeDecision(decision: AoiProposalDecision): boolean {
  return decision.action === 'dismiss' || decision.action === 'snooze';
}

function isRefreshProposal(proposal: AoiProposal): boolean {
  return (
    proposal.acceptAction?.kind === 'start_research' &&
    (proposal.trigger.includes('stale') ||
      proposal.cooldownKey.includes('refresh') ||
      proposal.riskSignals.includes('stale-memory'))
  );
}

function proposalMemoryRefs(proposal: AoiProposal): Set<string> {
  const refs = new Set<string>(proposal.memoryIds);
  for (const ref of proposal.evidenceRefs) {
    if (ref.startsWith('memory:')) {
      refs.add(ref.slice('memory:'.length));
    }
  }
  return refs;
}

function decisionMemoryRefs(decision: AoiProposalDecision): string[] {
  const refs = new Set<string>(decision.memoryIds ?? []);
  for (const ref of decision.evidenceRefs ?? []) {
    if (ref.startsWith('memory:')) {
      refs.add(ref.slice('memory:'.length));
    }
  }
  return [...refs];
}

function countDuplicateCooldownViolations(proposals: AoiProposal[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const proposal of proposals) {
    if (
      proposal.status !== 'active' &&
      proposal.status !== 'accepted' &&
      proposal.status !== 'snoozed'
    ) {
      continue;
    }
    if (seen.has(proposal.cooldownKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(proposal.cooldownKey);
  }
  return duplicates;
}

function countStaleMemoryReuse(proposals: AoiProposal[], decisions: AoiProposalDecision[]): number {
  const staleRefs = new Set(
    decisions
      .filter((decision) => decision.feedbackCategory === 'stale')
      .flatMap(decisionMemoryRefs),
  );
  if (staleRefs.size === 0) {
    return 0;
  }
  return proposals.filter((proposal) => {
    if (isRefreshProposal(proposal)) {
      return false;
    }
    for (const ref of proposalMemoryRefs(proposal)) {
      if (staleRefs.has(ref)) {
        return true;
      }
    }
    return false;
  }).length;
}

function computeExecutionSuccessRate(decisions: AoiProposalDecision[]): number {
  const acceptedAt = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.action === 'accept') {
      const current = acceptedAt.get(decision.proposalId);
      if (current === undefined || decision.createdAt < current) {
        acceptedAt.set(decision.proposalId, decision.createdAt);
      }
    }
  }

  let attempts = 0;
  let successes = 0;
  for (const decision of decisions) {
    const acceptedTime = acceptedAt.get(decision.proposalId);
    if (
      acceptedTime === undefined ||
      decision.createdAt < acceptedTime ||
      (decision.action !== 'execute' && decision.action !== 'block')
    ) {
      continue;
    }
    attempts += 1;
    if (decision.action === 'execute') {
      successes += 1;
    }
  }
  return ratio(successes, attempts);
}

function computeGoalContinuationUsefulness(decisions: AoiProposalDecision[]): number | null {
  const goalDecisions = decisions.filter(
    (decision) => decision.proposalTrigger === 'goal_continuation',
  );
  if (goalDecisions.length === 0) {
    return null;
  }
  const usefulCount = goalDecisions.filter(
    (decision) => decision.action === 'accept' || decision.feedbackCategory === 'useful',
  ).length;
  return ratio(usefulCount, goalDecisions.length);
}

function buildNoisyProposalTypes(decisions: AoiProposalDecision[]): AoiNoisyProposalType[] {
  const buckets = new Map<string, AoiNoisyProposalType>();
  for (const decision of decisions) {
    if (!isNegativeDecision(decision)) {
      continue;
    }
    const key = proposalKeyFromDecision(decision);
    const bucket = buckets.get(key) ?? {
      key,
      dismissCount: 0,
      tooFrequentCount: 0,
      notUsefulCount: 0,
    };
    bucket.dismissCount += 1;
    if (
      decision.feedbackCategory === 'too_frequent' ||
      decision.feedbackCategory === 'too_much' ||
      decision.feedbackCategory === 'wrong_timing'
    ) {
      bucket.tooFrequentCount += 1;
    }
    if (decision.feedbackCategory === 'not_useful') {
      bucket.notUsefulCount += 1;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort(
      (left, right) =>
        right.dismissCount - left.dismissCount ||
        right.tooFrequentCount - left.tooFrequentCount ||
        left.key.localeCompare(right.key),
    )
    .slice(0, 12);
}

export function evaluateAoiAutonomyRecords(
  records: AoiAutonomyEvaluationRecords,
): AoiAutonomyEvaluationResult {
  const sessionPath = normalizeAoiAutonomySessionPath(records.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }

  const proposals = records.proposals;
  const decisions = records.decisions;
  const primaryDecisions = decisions.filter(isPrimaryDecision);
  const acceptedDecisions = primaryDecisions.filter((decision) => decision.action === 'accept');
  const negativeDecisions = primaryDecisions.filter(isNegativeDecision);
  const dismissByCategory = FEEDBACK_CATEGORIES.map((category) => {
    const count = negativeDecisions.filter(
      (decision) => decision.feedbackCategory === category,
    ).length;
    return {
      category,
      count,
      dismissRate: ratio(count, negativeDecisions.length),
    };
  });
  const highRiskProposalIds = new Set(
    proposals
      .filter((proposal) => proposal.risk === 'high')
      .map((proposal) => proposal.id)
      .concat(
        decisions
          .filter((decision) => decision.proposalRisk === 'high')
          .map((decision) => decision.proposalId),
      ),
  );
  const proposalUniverseCount = new Set([
    ...proposals.map((proposal) => proposal.id),
    ...decisions.map((decision) => decision.proposalId),
  ]).size;
  const highRiskBlockedIds = new Set(
    decisions
      .filter((decision) => decision.action === 'block' && decision.proposalRisk === 'high')
      .map((decision) => decision.proposalId),
  );

  const calibration: AoiAutonomyCalibrationReport = {
    noisyProposalTypes: buildNoisyProposalTypes(decisions),
    wrongMemoryRefs: countBy(
      decisions
        .filter((decision) => decision.feedbackCategory === 'wrong_memory')
        .flatMap(decisionMemoryRefs),
    ),
    blockedActionKinds: countBy(
      decisions.filter((decision) => decision.action === 'block').map(actionKindFromDecision),
    ),
    staleMemoryRefs: countBy(
      decisions
        .filter((decision) => decision.feedbackCategory === 'stale')
        .flatMap(decisionMemoryRefs),
    ),
    highRiskProposalCount: highRiskProposalIds.size,
    highRiskProposalRate: ratio(highRiskProposalIds.size, proposalUniverseCount),
    highRiskBlockedCount: highRiskBlockedIds.size,
  };

  return {
    version: 1,
    sessionPath,
    generatedAt: records.now ?? Date.now(),
    metrics: {
      totalProposals: proposals.length,
      totalDecisions: decisions.length,
      proposalAcceptanceRate: ratio(acceptedDecisions.length, primaryDecisions.length),
      proposalDismissRate: ratio(negativeDecisions.length, primaryDecisions.length),
      dismissRateByCategory: dismissByCategory,
      duplicateCooldownViolationCount: countDuplicateCooldownViolations(proposals),
      evidenceCoverage: ratio(
        proposals.filter((proposal) => proposal.evidenceRefs.length > 0).length,
        proposals.length,
      ),
      staleMemoryReuseCount: countStaleMemoryReuse(proposals, decisions),
      blockedHighRiskProposalCount: highRiskBlockedIds.size,
      acceptedExecutionSuccessRate: computeExecutionSuccessRate(decisions),
      goalContinuationUsefulness: computeGoalContinuationUsefulness(decisions),
    },
    calibration,
  };
}

export function buildAoiAutonomyEvaluation(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
}): AoiAutonomyEvaluationResult {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return evaluateAoiAutonomyRecords({
    sessionPath,
    proposals: [
      ...loadAoiActiveProposals(params.sessionsDir, sessionPath),
      ...loadAoiArchivedProposals(params.sessionsDir, sessionPath),
    ],
    decisions: loadAoiProposalDecisions(params.sessionsDir, sessionPath),
    goalProgress: loadAoiGoalProgressEvents(params.sessionsDir, sessionPath),
    now: params.now,
  });
}
