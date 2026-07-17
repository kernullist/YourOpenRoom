import type {
  AoiOutcomeSignalRecord,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFieldEvent,
  AoiProposalDecision,
} from './aoiAutonomyTypes';
import type { AoiOperatorFeedbackLabelAction } from './aoiOperatorFeedbackInbox';

export const AOI_PROACTIVE_USEFULNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_EVIDENCE_REFS = 24;

interface CanonicalDecisionEvidence {
  key: string;
  labeled: boolean;
  operatorOrOutcomeBacked: boolean;
  useful: boolean;
  ignoredOrDismissed: boolean;
  sourceIssue: boolean;
  cooldownIssue: boolean;
  interruptionIssue: boolean;
  evidenceRefs: string[];
}

export interface AoiProactiveUsefulnessMetricsInput {
  sessionPath: string;
  decisions: readonly AoiProposalDecision[];
  outcomes: readonly AoiOutcomeSignalRecord[];
  feedback: readonly AoiProactiveBriefFeedback[];
  operatorLabels: readonly AoiOperatorFeedbackLabelAction[];
  fieldEvents?: readonly AoiProactiveBriefFieldEvent[];
  now?: number;
  windowMs?: number;
}

export interface AoiProactiveUsefulnessMetrics {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  windowMs: number;
  telemetryEventCount: number;
  telemetryOnlyEventCount: number;
  uniqueDecisionCount: number;
  duplicateDecisionCount: number;
  suppressedTelemetryDuplicateCount: number;
  operatorOrOutcomeBackedDecisionCount: number;
  labeledDecisionCount: number;
  usefulDecisionCount: number;
  ignoredDismissedDecisionCount: number;
  shouldHaveSpokenMissCount: number;
  precision: number;
  ignoredDismissedRate: number;
  shouldHaveSpokenMissRate: number;
  sourceHonestyRate: number;
  cooldownComplianceRate: number;
  interruptionCostRate: number;
  evidenceRefs: string[];
}

function uniqueStrings(values: readonly unknown[], limit = MAX_EVIDENCE_REFS): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function safeRate(numerator: number, denominator: number, missing: number): number {
  if (denominator <= 0) {
    return missing;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function emptyDecision(key: string): CanonicalDecisionEvidence {
  return {
    key,
    labeled: false,
    operatorOrOutcomeBacked: false,
    useful: false,
    ignoredOrDismissed: false,
    sourceIssue: false,
    cooldownIssue: false,
    interruptionIssue: false,
    evidenceRefs: [],
  };
}

function mergeDecision(
  decisions: Map<string, CanonicalDecisionEvidence>,
  key: string,
  update: Partial<Omit<CanonicalDecisionEvidence, 'key'>>,
): void {
  const current = decisions.get(key) ?? emptyDecision(key);
  decisions.set(key, {
    key,
    labeled: current.labeled || update.labeled === true,
    operatorOrOutcomeBacked:
      current.operatorOrOutcomeBacked || update.operatorOrOutcomeBacked === true,
    useful: current.useful || update.useful === true,
    ignoredOrDismissed: current.ignoredOrDismissed || update.ignoredOrDismissed === true,
    sourceIssue: current.sourceIssue || update.sourceIssue === true,
    cooldownIssue: current.cooldownIssue || update.cooldownIssue === true,
    interruptionIssue: current.interruptionIssue || update.interruptionIssue === true,
    evidenceRefs: uniqueStrings(
      [...(current.evidenceRefs ?? []), ...(update.evidenceRefs ?? [])],
      8,
    ),
  });
}

function isInWindow(sessionPath: string, createdAt: number, cutoff: number, now: number): boolean {
  return (
    Number.isFinite(createdAt) &&
    createdAt >= cutoff &&
    createdAt <= now + 5 * 60 * 1000 &&
    sessionPath.length > 0
  );
}

function latestUserDecisions(
  decisions: readonly AoiProposalDecision[],
  sessionPath: string,
  cutoff: number,
  now: number,
): AoiProposalDecision[] {
  const latest = new Map<string, AoiProposalDecision>();
  for (const decision of decisions) {
    if (
      decision.sessionPath !== sessionPath ||
      decision.actor !== 'user' ||
      !isInWindow(decision.sessionPath, decision.createdAt, cutoff, now)
    ) {
      continue;
    }
    const current = latest.get(decision.proposalId);
    if (!current || decision.createdAt > current.createdAt) {
      latest.set(decision.proposalId, decision);
    }
  }
  return [...latest.values()];
}

function proposalFeedbackFlags(category: AoiProposalDecision['feedbackCategory']): {
  useful: boolean;
  sourceIssue: boolean;
  cooldownIssue: boolean;
  interruptionIssue: boolean;
} {
  return {
    useful: category === 'useful' || category === 'already_done',
    sourceIssue:
      category === 'wrong_memory' ||
      category === 'wrong_evidence' ||
      category === 'wrong_source' ||
      category === 'stale' ||
      category === 'unsafe',
    cooldownIssue: category === 'too_frequent',
    interruptionIssue:
      category === 'too_frequent' || category === 'too_much' || category === 'wrong_timing',
  };
}

function proactiveFeedbackFlags(category: AoiProactiveBriefFeedback['category']): {
  useful: boolean;
  ignoredOrDismissed: boolean;
  sourceIssue: boolean;
  cooldownIssue: boolean;
  interruptionIssue: boolean;
} {
  return {
    useful:
      category === 'useful' ||
      category === 'show_more' ||
      category === 'open_sources' ||
      category === 'expand_summary' ||
      category === 'pin_topic',
    ignoredOrDismissed:
      category === 'not_useful' ||
      category === 'show_less' ||
      category === 'archive_brief' ||
      category === 'mute_topic',
    sourceIssue: category === 'wrong_source' || category === 'stale' || category === 'unsafe',
    cooldownIssue: category === 'too_frequent',
    interruptionIssue: category === 'too_frequent' || category === 'wrong_timing',
  };
}

function outcomeDecisionKey(
  outcome: AoiOutcomeSignalRecord,
  proposalByDecisionId: ReadonlyMap<string, string>,
): string {
  if (outcome.sourceProposalId) {
    return `proposal:${outcome.sourceProposalId}`;
  }
  if (outcome.sourceDecisionId) {
    const proposalId = proposalByDecisionId.get(outcome.sourceDecisionId);
    return proposalId ? `proposal:${proposalId}` : `decision:${outcome.sourceDecisionId}`;
  }
  if (outcome.sourceWorkOrderId) {
    return `work-order:${outcome.sourceWorkOrderId}`;
  }
  if (outcome.sourceChatRef) {
    return `chat:${outcome.sourceChatRef}`;
  }
  return '';
}

function operatorLabelDecisionKey(label: AoiOperatorFeedbackLabelAction): string {
  if (label.opportunityId) {
    return `opportunity:${label.opportunityId}`;
  }
  if (label.decisionId) {
    return `shadow-decision:${label.decisionId}`;
  }
  return `shadow-record:${label.decisionRecordId}`;
}

function telemetryDuplicateCount(events: readonly AoiProactiveBriefFieldEvent[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const event of [...events].sort((left, right) => left.createdAt - right.createdAt)) {
    const key = `${event.kind}:${event.dedupeKey || event.briefId || event.id}:${Math.floor(
      event.createdAt / (15 * 60 * 1000),
    )}`;
    if (seen.has(key)) {
      duplicates += 1;
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

export function buildAoiProactiveUsefulnessMetrics(
  input: AoiProactiveUsefulnessMetricsInput,
): AoiProactiveUsefulnessMetrics {
  const now = input.now ?? Date.now();
  const windowMs = Math.max(60_000, input.windowMs ?? AOI_PROACTIVE_USEFULNESS_WINDOW_MS);
  const cutoff = now - windowMs;
  const canonical = new Map<string, CanonicalDecisionEvidence>();
  const seenSignalIds = new Set<string>();
  let duplicateDecisionCount = 0;
  const recordSignal = (signalId: string): boolean => {
    if (seenSignalIds.has(signalId)) {
      duplicateDecisionCount += 1;
      return false;
    }
    seenSignalIds.add(signalId);
    return true;
  };
  const proposalByDecisionId = new Map(
    input.decisions.map((decision) => [decision.id, decision.proposalId]),
  );

  for (const decision of latestUserDecisions(input.decisions, input.sessionPath, cutoff, now)) {
    if (!recordSignal(`decision:${decision.id}`)) {
      continue;
    }
    const feedback = proposalFeedbackFlags(decision.feedbackCategory);
    mergeDecision(canonical, `proposal:${decision.proposalId}`, {
      labeled: true,
      operatorOrOutcomeBacked: true,
      useful: decision.action === 'accept' || feedback.useful,
      ignoredOrDismissed: decision.action === 'dismiss' || decision.action === 'snooze',
      sourceIssue: feedback.sourceIssue,
      cooldownIssue: feedback.cooldownIssue,
      interruptionIssue: feedback.interruptionIssue,
      evidenceRefs: [`decision:${decision.id}`, ...(decision.evidenceRefs ?? [])],
    });
  }

  for (const outcome of input.outcomes) {
    if (
      outcome.sessionPath !== input.sessionPath ||
      !isInWindow(outcome.sessionPath, outcome.createdAt, cutoff, now)
    ) {
      continue;
    }
    const key = outcomeDecisionKey(outcome, proposalByDecisionId);
    if (!key || !recordSignal(`outcome:${outcome.eventId}`)) {
      continue;
    }
    const positiveExecution =
      (outcome.outcomeKind === 'work_order_approved' ||
        outcome.outcomeKind === 'validation_run' ||
        outcome.outcomeKind === 'commit_created' ||
        outcome.outcomeKind === 'proposal_executed') &&
      outcome.result === 'positive' &&
      outcome.validationPassed !== false;
    mergeDecision(canonical, key, {
      labeled: true,
      operatorOrOutcomeBacked: true,
      useful: positiveExecution,
      ignoredOrDismissed:
        outcome.outcomeKind === 'proposal_ignored' ||
        outcome.outcomeKind === 'direct_chat_dismissed' ||
        outcome.outcomeKind === 'work_order_rejected',
      sourceIssue: outcome.outcomeKind === 'user_correction',
      interruptionIssue: outcome.outcomeKind === 'direct_chat_dismissed',
      evidenceRefs: [`outcome:${outcome.eventId}`, ...outcome.evidenceRefs],
    });
  }

  for (const feedback of input.feedback) {
    if (
      feedback.sessionPath !== input.sessionPath ||
      !isInWindow(feedback.sessionPath, feedback.createdAt, cutoff, now) ||
      !recordSignal(`proactive-feedback:${feedback.id}`)
    ) {
      continue;
    }
    const flags = proactiveFeedbackFlags(feedback.category);
    mergeDecision(canonical, `brief:${feedback.briefId}`, {
      labeled: true,
      operatorOrOutcomeBacked: true,
      ...flags,
      evidenceRefs: [`proactive-feedback:${feedback.id}`],
    });
  }

  const missKeys = new Set<string>();
  const missEvidenceRefs: string[] = [];
  for (const label of input.operatorLabels) {
    if (
      label.sessionPath !== input.sessionPath ||
      label.actor !== 'user' ||
      !isInWindow(label.sessionPath, label.createdAt, cutoff, now) ||
      !recordSignal(`operator-label:${label.id}`)
    ) {
      continue;
    }
    const key = operatorLabelDecisionKey(label);
    if (label.label === 'should_have_spoken') {
      missKeys.add(key);
      missEvidenceRefs.push(`operator-feedback:${label.id}`, ...label.evidenceRefs);
      continue;
    }
    mergeDecision(canonical, key, {
      labeled: true,
      operatorOrOutcomeBacked: true,
      useful:
        label.label === 'useful' || label.label === 'show_more' || label.label === 'pin_topic',
      ignoredOrDismissed:
        label.label === 'show_less' || label.label === 'mute_topic' || label.label === 'too_much',
      sourceIssue: label.label === 'wrong_source' || label.label === 'unsafe',
      cooldownIssue: label.label === 'too_frequent',
      interruptionIssue:
        label.label === 'too_frequent' ||
        label.label === 'too_much' ||
        label.label === 'wrong_timing',
      evidenceRefs: [`operator-feedback:${label.id}`, ...label.evidenceRefs],
    });
  }

  const credited = [...canonical.values()].filter((decision) => decision.operatorOrOutcomeBacked);
  const labeled = credited.filter((decision) => decision.labeled);
  const useful = labeled.filter((decision) => decision.useful);
  const ignored = labeled.filter((decision) => decision.ignoredOrDismissed);
  const sourceIssues = labeled.filter((decision) => decision.sourceIssue);
  const cooldownIssues = labeled.filter((decision) => decision.cooldownIssue);
  const interruptionIssues = labeled.filter((decision) => decision.interruptionIssue);
  const shouldHaveSpokenMissCount = missKeys.size;
  const fieldEvents = (input.fieldEvents ?? []).filter(
    (event) =>
      event.sessionPath === input.sessionPath &&
      isInWindow(event.sessionPath, event.createdAt, cutoff, now),
  );
  const feedbackIds = new Set(input.feedback.map((item) => item.id));
  const feedbackBriefIds = new Set(input.feedback.map((item) => item.briefId));
  const labeledFieldEventIds = new Set(
    input.operatorLabels
      .map((label) => label.fieldEventId)
      .filter((id): id is string => Boolean(id)),
  );
  const telemetryOnlyEventCount = fieldEvents.filter(
    (event) =>
      !labeledFieldEventIds.has(event.id) &&
      !(event.feedbackId && feedbackIds.has(event.feedbackId)) &&
      !(event.briefId && feedbackBriefIds.has(event.briefId)),
  ).length;
  const evidenceRefs = uniqueStrings([
    ...credited.flatMap((decision) => decision.evidenceRefs),
    ...missEvidenceRefs,
  ]);

  return {
    version: 1,
    sessionPath: input.sessionPath,
    generatedAt: now,
    windowMs,
    telemetryEventCount: fieldEvents.length,
    telemetryOnlyEventCount,
    uniqueDecisionCount: credited.length,
    duplicateDecisionCount,
    suppressedTelemetryDuplicateCount: telemetryDuplicateCount(fieldEvents),
    operatorOrOutcomeBackedDecisionCount: credited.length,
    labeledDecisionCount: labeled.length,
    usefulDecisionCount: useful.length,
    ignoredDismissedDecisionCount: ignored.length,
    shouldHaveSpokenMissCount,
    precision: safeRate(useful.length, labeled.length, 0),
    ignoredDismissedRate: safeRate(ignored.length, labeled.length, 1),
    shouldHaveSpokenMissRate: safeRate(
      shouldHaveSpokenMissCount,
      labeled.length + shouldHaveSpokenMissCount,
      1,
    ),
    sourceHonestyRate: safeRate(labeled.length - sourceIssues.length, labeled.length, 0),
    cooldownComplianceRate: safeRate(labeled.length - cooldownIssues.length, labeled.length, 0),
    interruptionCostRate: safeRate(interruptionIssues.length, labeled.length, 1),
    evidenceRefs,
  };
}
