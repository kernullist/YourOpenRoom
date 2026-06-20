import type {
  AoiDeliberationRun,
  AoiFollowThroughAction,
  AoiFollowThroughCooldownAdjustment,
  AoiFollowThroughDeliveryMode,
  AoiFollowThroughDeliverySensitivity,
  AoiFollowThroughEvent,
  AoiFollowThroughLearningAdjustment,
  AoiFollowThroughLearningSummary,
  AoiFollowThroughResult,
  AoiFollowThroughSummaryIndex,
  AoiFollowThroughSummaryIndexEntry,
  AoiOpportunity,
  AoiProactiveBriefFeedback,
  AoiProactiveTrendAdvisorState,
  AoiProactiveTrendDeliveryEvent,
  AoiProposalDecision,
  AoiProposalFeedbackCategory,
} from './aoiAutonomyTypes';

const DEFAULT_RECENT_EVENT_LIMIT = 80;
const DEFAULT_SUMMARY_ADJUSTMENT_LIMIT = 8;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const TOO_FREQUENT_COOLDOWN_MS = 36 * 60 * 60 * 1000;
const UNSAFE_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const IGNORED_AFTER_MS = 30 * 60 * 1000;

const POSITIVE_PROPOSAL_FEEDBACK = new Set<AoiProposalFeedbackCategory>(['useful', 'already_done']);

const NEGATIVE_PROPOSAL_FEEDBACK = new Set<AoiProposalFeedbackCategory>([
  'not_useful',
  'wrong_memory',
  'wrong_evidence',
  'wrong_source',
  'stale',
  'too_frequent',
  'too_much',
  'wrong_timing',
  'unsafe',
  'needs_more_detail',
]);

const POSITIVE_BRIEF_FEEDBACK = new Set<AoiProactiveBriefFeedback['category']>([
  'useful',
  'show_more',
  'pin_topic',
  'open_sources',
  'expand_summary',
]);

const NEGATIVE_BRIEF_FEEDBACK = new Set<AoiProactiveBriefFeedback['category']>([
  'not_useful',
  'show_less',
  'wrong_topic',
  'wrong_timing',
  'too_frequent',
  'stale',
  'unsafe',
  'mute_topic',
  'archive_brief',
]);

export interface AoiFollowThroughLearningInput {
  sessionPath: string;
  opportunities?: readonly AoiOpportunity[];
  archivedOpportunities?: readonly AoiOpportunity[];
  deliberationRuns?: readonly AoiDeliberationRun[];
  proposalDecisions?: readonly AoiProposalDecision[];
  proactiveBriefFeedback?: readonly AoiProactiveBriefFeedback[];
  proactiveTrendAdvisor?: AoiProactiveTrendAdvisorState | null;
  trendDeliveryEvents?: readonly AoiProactiveTrendDeliveryEvent[];
  followThroughEvents?: readonly AoiFollowThroughEvent[];
  now?: number;
}

export interface AoiFollowThroughLearningScore {
  rankingFactor: number;
  suppressed: boolean;
  directChatFactor: number;
  nextEligibleAt?: number;
  reasonLabels: string[];
  evidenceRefs: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, fallback = '', maxChars = 220): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = normalizeWhitespace(raw || fallback);
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 3).trimEnd()}...`
    : normalized;
}

export function normalizeAoiFollowThroughKey(value: unknown): string {
  return sanitizeText(value, '', 180)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueStrings(values: readonly unknown[], limit: number): string[] {
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

function clampScore(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const key = normalizeAoiFollowThroughKey(parts.map((part) => String(part ?? '')).join(':'));
  return `${prefix}-${key || 'event'}`.slice(0, 128);
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

function actionFromOpportunityStatus(
  status: AoiOpportunity['status'],
): AoiFollowThroughAction | null {
  if (status === 'accepted' || status === 'converted') {
    return 'accepted';
  }
  if (status === 'dismissed') {
    return 'dismissed';
  }
  if (status === 'snoozed') {
    return 'snoozed';
  }
  if (status === 'expired' || status === 'archived') {
    return 'ignored';
  }
  return null;
}

function resultForAction(action: AoiFollowThroughAction): AoiFollowThroughResult {
  if (action === 'accepted' || action === 'executed') {
    return 'positive';
  }
  if (action === 'dismissed') {
    return 'negative';
  }
  if (action === 'blocked') {
    return 'blocked';
  }
  if (action === 'failed') {
    return 'failed';
  }
  if (action === 'ignored') {
    return 'soft_negative';
  }
  return 'neutral';
}

function resultWeight(result: AoiFollowThroughResult, action: AoiFollowThroughAction): number {
  if (result === 'positive') {
    return action === 'executed' ? 1.2 : 1;
  }
  if (result === 'negative') {
    return -1;
  }
  if (result === 'blocked' || result === 'failed') {
    return -1.25;
  }
  if (result === 'soft_negative') {
    return -0.35;
  }
  return -0.05;
}

function resultStrength(result: AoiFollowThroughResult): number {
  if (result === 'blocked' || result === 'failed') {
    return 4;
  }
  if (result === 'negative' || result === 'positive') {
    return 3;
  }
  if (result === 'soft_negative') {
    return 2;
  }
  return 1;
}

function resultFromProposalDecision(decision: AoiProposalDecision): AoiFollowThroughResult {
  if (decision.feedbackCategory === 'unsafe') {
    return 'blocked';
  }
  if (decision.action === 'block') {
    return 'blocked';
  }
  if (decision.action === 'execute' || decision.action === 'accept') {
    if (decision.feedbackCategory && NEGATIVE_PROPOSAL_FEEDBACK.has(decision.feedbackCategory)) {
      return decision.feedbackCategory === 'unsafe' ? 'blocked' : 'negative';
    }
    return 'positive';
  }
  if (decision.action === 'dismiss') {
    return 'negative';
  }
  if (decision.action === 'snooze') {
    return 'neutral';
  }
  if (decision.feedbackCategory && POSITIVE_PROPOSAL_FEEDBACK.has(decision.feedbackCategory)) {
    return 'positive';
  }
  if (decision.feedbackCategory && NEGATIVE_PROPOSAL_FEEDBACK.has(decision.feedbackCategory)) {
    return 'negative';
  }
  return 'neutral';
}

function actionFromProposalDecision(decision: AoiProposalDecision): AoiFollowThroughAction {
  if (decision.feedbackCategory === 'unsafe') {
    return 'blocked';
  }
  if (decision.action === 'accept') {
    return 'accepted';
  }
  if (decision.action === 'dismiss') {
    return 'dismissed';
  }
  if (decision.action === 'snooze') {
    return 'snoozed';
  }
  if (decision.action === 'execute') {
    return 'executed';
  }
  return 'blocked';
}

function resultFromBriefFeedback(
  category: AoiProactiveBriefFeedback['category'],
): AoiFollowThroughResult {
  if (category === 'unsafe') {
    return 'blocked';
  }
  if (POSITIVE_BRIEF_FEEDBACK.has(category)) {
    return 'positive';
  }
  if (NEGATIVE_BRIEF_FEEDBACK.has(category)) {
    return 'negative';
  }
  return 'neutral';
}

function actionFromBriefFeedback(
  category: AoiProactiveBriefFeedback['category'],
): AoiFollowThroughAction {
  if (category === 'unsafe') {
    return 'blocked';
  }
  if (category === 'archive_brief' || category === 'mute_topic') {
    return 'dismissed';
  }
  if (POSITIVE_BRIEF_FEEDBACK.has(category)) {
    return 'accepted';
  }
  if (NEGATIVE_BRIEF_FEEDBACK.has(category)) {
    return 'dismissed';
  }
  return 'ignored';
}

function topicKeyFromOpportunity(opportunity: AoiOpportunity): string {
  return normalizeAoiFollowThroughKey(opportunity.dedupeKey || opportunity.title || opportunity.id);
}

function sourceKeyFromOpportunity(opportunity: AoiOpportunity): string {
  return normalizeAoiFollowThroughKey(opportunity.sourceKind);
}

function relatedKeysForOpportunity(opportunity: AoiOpportunity): string[] {
  return uniqueStrings(
    [
      opportunity.id,
      `opportunity:${opportunity.id}`,
      opportunity.dedupeKey,
      topicKeyFromOpportunity(opportunity),
      opportunity.title,
      ...opportunity.evidenceRefs,
    ],
    24,
  ).map(normalizeAoiFollowThroughKey);
}

function scoreOpportunityMatch(opportunity: AoiOpportunity, decision: AoiProposalDecision): number {
  const opportunityKeys = new Set(relatedKeysForOpportunity(opportunity));
  const decisionKeys = [
    decision.proposalId,
    `proposal:${decision.proposalId}`,
    decision.cooldownKey,
    decision.proposalTrigger,
    ...(decision.evidenceRefs ?? []),
    ...(decision.memoryIds ?? []).map((id) => `memory:${id}`),
  ].map(normalizeAoiFollowThroughKey);
  return decisionKeys.reduce((score, key) => score + (key && opportunityKeys.has(key) ? 1 : 0), 0);
}

function opportunityForDecision(
  decision: AoiProposalDecision,
  opportunities: readonly AoiOpportunity[],
): AoiOpportunity | null {
  return (
    opportunities
      .map((opportunity) => ({
        opportunity,
        score: scoreOpportunityMatch(opportunity, decision),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.opportunity.updatedAt - left.opportunity.updatedAt,
      )[0]?.opportunity ?? null
  );
}

export function normalizeAoiFollowThroughEvent(
  event: Partial<AoiFollowThroughEvent>,
  sessionPath: string,
  now = Date.now(),
): AoiFollowThroughEvent | null {
  const opportunityId = sanitizeText(event.opportunityId, '', 160);
  const action = event.action;
  const result = event.result ?? (action ? resultForAction(action) : undefined);
  if (
    !opportunityId ||
    !action ||
    !result ||
    !['accepted', 'dismissed', 'snoozed', 'executed', 'blocked', 'failed', 'ignored'].includes(
      action,
    ) ||
    !['positive', 'negative', 'neutral', 'soft_negative', 'blocked', 'failed'].includes(result)
  ) {
    return null;
  }
  const createdAt = Number.isFinite(event.createdAt) ? Number(event.createdAt) : now;
  const id =
    sanitizeText(event.id, '', 128) ||
    stableId('aoi-follow-through', [
      sessionPath,
      opportunityId,
      event.proposalId,
      event.deliberationRunId,
      action,
      event.feedbackCategory,
      createdAt,
    ]);
  return {
    version: 1,
    id,
    sessionPath,
    opportunityId,
    ...(sanitizeText(event.proposalId, '', 128)
      ? { proposalId: sanitizeText(event.proposalId, '', 128) }
      : {}),
    ...(sanitizeText(event.deliberationRunId, '', 128)
      ? { deliberationRunId: sanitizeText(event.deliberationRunId, '', 128) }
      : {}),
    ...(event.sourceKind ? { sourceKind: event.sourceKind } : {}),
    ...(normalizeAoiFollowThroughKey(event.topicKey)
      ? { topicKey: normalizeAoiFollowThroughKey(event.topicKey) }
      : {}),
    ...(normalizeAoiFollowThroughKey(event.sourceKey)
      ? { sourceKey: normalizeAoiFollowThroughKey(event.sourceKey) }
      : {}),
    deliveryMode: normalizeDeliveryMode(event.deliveryMode),
    action,
    ...(sanitizeText(event.feedbackCategory, '', 120)
      ? { feedbackCategory: sanitizeText(event.feedbackCategory, '', 120) }
      : {}),
    result,
    timingLabel: sanitizeText(event.timingLabel, `${action} recorded`, 160),
    evidenceRefs: uniqueStrings(event.evidenceRefs ?? [], 24),
    createdAt,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiFollowThroughEventFromOpportunity(
  opportunity: AoiOpportunity,
  now = Date.now(),
): AoiFollowThroughEvent | null {
  const action = actionFromOpportunityStatus(opportunity.status);
  if (!action) {
    return null;
  }
  return normalizeAoiFollowThroughEvent(
    {
      id: stableId('aoi-follow-through-opportunity', [
        opportunity.sessionPath,
        opportunity.id,
        opportunity.status,
        opportunity.updatedAt,
      ]),
      opportunityId: opportunity.id,
      sourceKind: opportunity.sourceKind,
      topicKey: topicKeyFromOpportunity(opportunity),
      sourceKey: sourceKeyFromOpportunity(opportunity),
      deliveryMode: opportunity.deliveryRecommendation,
      action,
      feedbackCategory: opportunity.status,
      result: resultForAction(action),
      timingLabel: `opportunity status ${opportunity.status}`,
      evidenceRefs: [`opportunity:${opportunity.id}`, ...opportunity.evidenceRefs],
      createdAt: opportunity.updatedAt || now,
    },
    opportunity.sessionPath,
    now,
  );
}

export function buildAoiFollowThroughEventFromProposalDecision(
  decision: AoiProposalDecision,
  opportunity?: AoiOpportunity | null,
  now = Date.now(),
): AoiFollowThroughEvent {
  const action = actionFromProposalDecision(decision);
  const result = resultFromProposalDecision(decision);
  return normalizeAoiFollowThroughEvent(
    {
      id: stableId('aoi-follow-through-proposal', [
        decision.sessionPath,
        decision.id,
        decision.proposalId,
        decision.action,
      ]),
      opportunityId: opportunity?.id ?? `proposal:${decision.proposalId}`,
      proposalId: decision.proposalId,
      sourceKind: opportunity?.sourceKind ?? 'proposal',
      topicKey: opportunity ? topicKeyFromOpportunity(opportunity) : decision.cooldownKey,
      sourceKey: opportunity
        ? sourceKeyFromOpportunity(opportunity)
        : (decision.actionKind ?? 'proposal'),
      deliveryMode: opportunity?.deliveryRecommendation ?? 'unknown',
      action,
      feedbackCategory: decision.feedbackCategory ?? decision.action,
      result,
      timingLabel: `proposal decision ${decision.action}`,
      evidenceRefs: uniqueStrings(
        [
          `proposal:${decision.proposalId}`,
          `decision:${decision.id}`,
          ...(opportunity ? [`opportunity:${opportunity.id}`, ...opportunity.evidenceRefs] : []),
          ...(decision.evidenceRefs ?? []),
        ],
        24,
      ),
      createdAt: decision.createdAt || now,
    },
    decision.sessionPath,
    now,
  )!;
}

export function buildAoiFollowThroughEventFromProactiveBriefFeedback(
  feedback: AoiProactiveBriefFeedback,
  now = Date.now(),
): AoiFollowThroughEvent {
  const action = actionFromBriefFeedback(feedback.category);
  const result = resultFromBriefFeedback(feedback.category);
  return normalizeAoiFollowThroughEvent(
    {
      id: stableId('aoi-follow-through-brief', [
        feedback.sessionPath,
        feedback.id,
        feedback.briefId,
        feedback.category,
      ]),
      opportunityId: `brief:${feedback.briefId}`,
      sourceKind: 'proactive_brief',
      topicKey: feedback.topicId,
      sourceKey: 'proactive_brief',
      deliveryMode: 'unknown',
      action,
      feedbackCategory: feedback.category,
      result,
      timingLabel: `brief feedback ${feedback.category}`,
      evidenceRefs: uniqueStrings(
        [
          `feedback:${feedback.id}`,
          `proactive-brief:${feedback.briefId}`,
          `topic:${feedback.topicId}`,
        ],
        12,
      ),
      createdAt: feedback.createdAt || now,
    },
    feedback.sessionPath,
    now,
  )!;
}

export function buildAoiFollowThroughEventFromTrendDelivery(
  event: AoiProactiveTrendDeliveryEvent,
  now = Date.now(),
): AoiFollowThroughEvent {
  const suppressed = event.kind === 'delivery_suppressed' || event.deliveryMode === 'blocked';
  const oldEnoughToTreatAsIgnored = now - event.createdAt >= IGNORED_AFTER_MS;
  return normalizeAoiFollowThroughEvent(
    {
      id: stableId('aoi-follow-through-trend', [
        event.sessionPath,
        event.id,
        event.kind,
        event.snapshotId,
      ]),
      opportunityId: event.candidateId ? `brief:${event.candidateId}` : `trend:${event.snapshotId}`,
      sourceKind: 'proactive_trend',
      topicKey: event.topicId,
      sourceKey: event.sourceHosts[0] ?? 'proactive_trend',
      deliveryMode: event.deliveryMode,
      action: suppressed ? 'blocked' : 'ignored',
      feedbackCategory: event.kind,
      result: suppressed ? 'blocked' : oldEnoughToTreatAsIgnored ? 'soft_negative' : 'neutral',
      timingLabel: suppressed
        ? 'trend delivery suppressed'
        : oldEnoughToTreatAsIgnored
          ? 'trend delivered without explicit feedback'
          : 'trend delivery awaiting feedback window',
      evidenceRefs: uniqueStrings(
        [
          `trend-delivery-event:${event.id}`,
          `trend-snapshot:${event.snapshotId}`,
          ...(event.candidateId ? [`proactive-brief:${event.candidateId}`] : []),
          ...event.evidenceRefs,
        ],
        24,
      ),
      createdAt: event.createdAt || now,
    },
    event.sessionPath,
    now,
  )!;
}

function isUnsafeDeliberationBlock(run: AoiDeliberationRun): boolean {
  return [
    ...run.blockers,
    ...(run.finding?.blockers ?? []),
    ...run.evidencePlan.flatMap((step) => step.blockers),
  ].some((item) => /credential|private|secret|sensitive|token|unsafe/i.test(item));
}

export function buildAoiFollowThroughEventFromDeliberationRun(
  run: AoiDeliberationRun,
  now = Date.now(),
): AoiFollowThroughEvent | null {
  if (run.phase !== 'ready' && run.phase !== 'blocked' && run.phase !== 'failed') {
    return null;
  }
  const unsafeBlock = run.phase === 'blocked' && isUnsafeDeliberationBlock(run);
  const action: AoiFollowThroughAction =
    run.phase === 'ready' ? 'accepted' : run.phase === 'failed' ? 'failed' : 'blocked';
  const result: AoiFollowThroughResult =
    run.phase === 'ready'
      ? 'positive'
      : run.phase === 'failed'
        ? 'failed'
        : unsafeBlock
          ? 'blocked'
          : 'negative';
  const feedbackCategory =
    run.phase === 'ready'
      ? 'deliberation_ready'
      : run.phase === 'failed'
        ? 'deliberation_failed'
        : unsafeBlock
          ? 'unsafe'
          : 'deliberation_blocked';

  return normalizeAoiFollowThroughEvent(
    {
      id: stableId('aoi-follow-through-deliberation', [
        run.sessionPath,
        run.id,
        run.phase,
        run.updatedAt,
      ]),
      opportunityId: run.opportunityId,
      deliberationRunId: run.id,
      sourceKind: 'deliberation',
      topicKey: run.opportunityDedupeKey,
      sourceKey: `deliberation:${run.phase}`,
      deliveryMode: 'dashboard',
      action,
      feedbackCategory,
      result,
      timingLabel: `deliberation ${run.phase}`,
      evidenceRefs: uniqueStrings(
        [
          `deliberation-run:${run.id}`,
          `opportunity:${run.opportunityId}`,
          ...run.evidenceRefs,
          ...(run.finding?.evidenceRefs ?? []),
          ...(run.opinion?.evidenceRefs ?? []),
        ],
        24,
      ),
      createdAt: run.updatedAt || now,
    },
    run.sessionPath,
    now,
  );
}

function allLearningEvents(input: AoiFollowThroughLearningInput): AoiFollowThroughEvent[] {
  const now = input.now ?? Date.now();
  const sessionPath = input.sessionPath;
  const opportunities = [...(input.opportunities ?? []), ...(input.archivedOpportunities ?? [])];
  const normalizedEvents = (input.followThroughEvents ?? [])
    .map((event) => normalizeAoiFollowThroughEvent(event, sessionPath, now))
    .filter((event): event is AoiFollowThroughEvent => event !== null);
  const opportunityEvents = opportunities
    .map((opportunity) => buildAoiFollowThroughEventFromOpportunity(opportunity, now))
    .filter((event): event is AoiFollowThroughEvent => event !== null);
  const deliberationEvents = (input.deliberationRuns ?? [])
    .map((run) => buildAoiFollowThroughEventFromDeliberationRun(run, now))
    .filter((event): event is AoiFollowThroughEvent => event !== null);
  const decisionEvents = (input.proposalDecisions ?? []).map((decision) =>
    buildAoiFollowThroughEventFromProposalDecision(
      decision,
      opportunityForDecision(decision, opportunities),
      now,
    ),
  );
  const feedbackEvents = (input.proactiveBriefFeedback ?? []).map((feedback) =>
    buildAoiFollowThroughEventFromProactiveBriefFeedback(feedback, now),
  );
  const trendEvents = [
    ...(input.trendDeliveryEvents ?? []),
    ...(input.proactiveTrendAdvisor?.recentDeliveryEvents ?? []),
  ].map((event) => buildAoiFollowThroughEventFromTrendDelivery(event, now));

  const byId = new Map<string, AoiFollowThroughEvent>();
  for (const event of [
    ...normalizedEvents,
    ...opportunityEvents,
    ...deliberationEvents,
    ...decisionEvents,
    ...feedbackEvents,
    ...trendEvents,
  ]) {
    if (event.sessionPath !== sessionPath) {
      continue;
    }
    const existing = byId.get(event.id);
    if (
      !existing ||
      event.createdAt > existing.createdAt ||
      (event.createdAt === existing.createdAt &&
        resultStrength(event.result) > resultStrength(existing.result))
    ) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function adjustmentLabel(key: string, positive: number, negative: number, kind: string): string {
  const cleanKey = key.replace(/[_:-]+/g, ' ').trim() || kind;
  if (positive > Math.abs(negative)) {
    return `${kind} boost: ${cleanKey}`;
  }
  return `${kind} suppress: ${cleanKey}`;
}

function buildAdjustment(params: {
  key: string;
  kind: string;
  score: number;
  positive: number;
  negative: number;
  evidenceRefs: string[];
}): AoiFollowThroughLearningAdjustment {
  const direction = params.score >= 0 ? 'more' : 'less';
  return {
    key: params.key,
    label: adjustmentLabel(params.key, params.positive, params.negative, params.kind),
    score: clampScore(params.score, -1, 1),
    reason: `${direction} likely after ${params.positive.toFixed(1)} positive and ${Math.abs(
      params.negative,
    ).toFixed(1)} negative follow-through signal(s).`,
    evidenceRefs: uniqueStrings(params.evidenceRefs, 8),
  };
}

function summarizeByKey(
  events: readonly AoiFollowThroughEvent[],
  keyOf: (event: AoiFollowThroughEvent) => string | undefined,
  kind: string,
): {
  boosts: AoiFollowThroughLearningAdjustment[];
  suppressions: AoiFollowThroughLearningAdjustment[];
} {
  const aggregates = new Map<
    string,
    { positive: number; negative: number; latestAt: number; evidenceRefs: string[] }
  >();
  for (const event of events) {
    const key = normalizeAoiFollowThroughKey(keyOf(event));
    if (!key) {
      continue;
    }
    const weight = resultWeight(event.result, event.action);
    const aggregate = aggregates.get(key) ?? {
      positive: 0,
      negative: 0,
      latestAt: 0,
      evidenceRefs: [],
    };
    if (weight >= 0) {
      aggregate.positive += weight;
    } else {
      aggregate.negative += weight;
    }
    aggregate.latestAt = Math.max(aggregate.latestAt, event.createdAt);
    aggregate.evidenceRefs = uniqueStrings([...aggregate.evidenceRefs, ...event.evidenceRefs], 12);
    aggregates.set(key, aggregate);
  }
  const adjustments = [...aggregates.entries()]
    .map(([key, aggregate]) =>
      buildAdjustment({
        key,
        kind,
        score: clampScore((aggregate.positive + aggregate.negative) / 3, -1, 1),
        positive: aggregate.positive,
        negative: aggregate.negative,
        evidenceRefs: aggregate.evidenceRefs,
      }),
    )
    .filter((adjustment) => Math.abs(adjustment.score) >= 0.08)
    .sort((left, right) => Math.abs(right.score) - Math.abs(left.score));
  return {
    boosts: adjustments
      .filter((adjustment) => adjustment.score > 0)
      .slice(0, DEFAULT_SUMMARY_ADJUSTMENT_LIMIT),
    suppressions: adjustments
      .filter((adjustment) => adjustment.score < 0)
      .slice(0, DEFAULT_SUMMARY_ADJUSTMENT_LIMIT),
  };
}

function buildDeliverySensitivity(
  events: readonly AoiFollowThroughEvent[],
): AoiFollowThroughDeliverySensitivity[] {
  const byMode = new Map<
    AoiFollowThroughDeliveryMode,
    { score: number; unsafe: boolean; tooFrequent: boolean; evidenceRefs: string[] }
  >();
  for (const event of events) {
    const mode = event.deliveryMode ?? 'unknown';
    const aggregate = byMode.get(mode) ?? {
      score: 0,
      unsafe: false,
      tooFrequent: false,
      evidenceRefs: [],
    };
    aggregate.score += resultWeight(event.result, event.action);
    aggregate.unsafe ||= event.result === 'blocked' || event.feedbackCategory === 'unsafe';
    aggregate.tooFrequent ||=
      event.feedbackCategory === 'too_frequent' || event.feedbackCategory === 'too_much';
    aggregate.evidenceRefs = uniqueStrings([...aggregate.evidenceRefs, ...event.evidenceRefs], 12);
    byMode.set(mode, aggregate);
  }
  return [...byMode.entries()]
    .map(([mode, aggregate]) => {
      const factor =
        aggregate.score > 0
          ? clampScore(1 + aggregate.score * 0.08, 0.7, 1.25)
          : clampScore(1 + aggregate.score * 0.18, 0.25, 1.1);
      const cooldownMs = aggregate.unsafe
        ? UNSAFE_COOLDOWN_MS
        : aggregate.tooFrequent
          ? TOO_FREQUENT_COOLDOWN_MS
          : aggregate.score < 0
            ? NEGATIVE_COOLDOWN_MS
            : DEFAULT_COOLDOWN_MS;
      return {
        mode,
        factor,
        cooldownMs,
        reason:
          factor < 1
            ? `${mode.replace(/_/g, ' ')} delivery is less sensitive after negative follow-through.`
            : `${mode.replace(/_/g, ' ')} delivery can be considered slightly more often after useful follow-through.`,
        evidenceRefs: uniqueStrings(aggregate.evidenceRefs, 8),
      };
    })
    .filter((item) => item.mode !== 'unknown' && Math.abs(item.factor - 1) >= 0.02)
    .sort((left, right) => Math.abs(1 - right.factor) - Math.abs(1 - left.factor))
    .slice(0, DEFAULT_SUMMARY_ADJUSTMENT_LIMIT);
}

function buildCooldownAdjustments(
  events: readonly AoiFollowThroughEvent[],
  now: number,
): AoiFollowThroughCooldownAdjustment[] {
  return events
    .filter(
      (event) =>
        event.result === 'negative' ||
        event.result === 'blocked' ||
        event.result === 'failed' ||
        event.result === 'soft_negative',
    )
    .map((event) => {
      const key = event.topicKey || event.opportunityId;
      const unsafe = event.result === 'blocked' || event.feedbackCategory === 'unsafe';
      const tooFrequent =
        event.feedbackCategory === 'too_frequent' || event.feedbackCategory === 'too_much';
      const cooldownMs = unsafe
        ? UNSAFE_COOLDOWN_MS
        : tooFrequent
          ? TOO_FREQUENT_COOLDOWN_MS
          : event.result === 'soft_negative'
            ? DEFAULT_COOLDOWN_MS
            : NEGATIVE_COOLDOWN_MS;
      return {
        key,
        factor: event.result === 'soft_negative' ? 0.85 : unsafe ? 0.25 : tooFrequent ? 0.4 : 0.62,
        nextEligibleAt: Math.max(now, event.createdAt + cooldownMs),
        reason:
          event.result === 'soft_negative'
            ? 'Ignored delivery is a soft cooldown signal, not a hard dislike.'
            : 'Negative follow-through suppresses similar proactive delivery before confidence can rise again.',
        evidenceRefs: uniqueStrings(event.evidenceRefs, 8),
      };
    })
    .sort((left, right) => (right.nextEligibleAt ?? 0) - (left.nextEligibleAt ?? 0))
    .slice(0, DEFAULT_SUMMARY_ADJUSTMENT_LIMIT);
}

function buildTrustHints(events: readonly AoiFollowThroughEvent[]): string[] {
  const unsafeCount = events.filter((event) => event.result === 'blocked').length;
  const failedCount = events.filter((event) => event.result === 'failed').length;
  const ignoredCount = events.filter((event) => event.result === 'soft_negative').length;
  const positiveCount = events.filter((event) => event.result === 'positive').length;
  return uniqueStrings(
    [
      unsafeCount > 0
        ? `${unsafeCount} unsafe/blocked signal(s): keep action ladder conservative and never grant execution authority from learning.`
        : '',
      failedCount > 0
        ? `${failedCount} failed execution signal(s): require fresh evidence before escalating similar suggestions.`
        : '',
      ignoredCount > 0
        ? `${ignoredCount} ignored delivery signal(s): reduce interruption softly without treating it as a dislike.`
        : '',
      positiveCount > 0
        ? `${positiveCount} accepted/executed signal(s): rank similar evidence-backed opportunities slightly higher.`
        : '',
      'Learning may tune ranking, cooldown, and delivery sensitivity only; approval and execution gates remain unchanged.',
    ],
    6,
  );
}

export function buildAoiFollowThroughLearningSummary(
  input: AoiFollowThroughLearningInput,
): AoiFollowThroughLearningSummary {
  const now = input.now ?? Date.now();
  const events = allLearningEvents(input).slice(0, DEFAULT_RECENT_EVENT_LIMIT);
  const latestByOpportunityId: Record<string, AoiFollowThroughEvent> = {};
  for (const event of events) {
    if (!latestByOpportunityId[event.opportunityId]) {
      latestByOpportunityId[event.opportunityId] = event;
    }
  }
  const byTopic = summarizeByKey(events, (event) => event.topicKey || event.opportunityId, 'topic');
  const bySource = summarizeByKey(events, (event) => event.sourceKey || event.sourceKind, 'source');
  const evidenceRefs = uniqueStrings(
    [
      'follow_through_learning:v1',
      ...events.flatMap((event) => [
        `follow-through:${event.id}`,
        ...event.evidenceRefs.slice(0, 2),
      ]),
    ],
    24,
  );
  return {
    version: 1,
    sessionPath: input.sessionPath,
    generatedAt: now,
    eventCount: events.length,
    ...(events[0]?.createdAt ? { latestEventAt: events[0].createdAt } : {}),
    recentEvents: events,
    latestByOpportunityId,
    topicBoosts: byTopic.boosts,
    topicSuppressions: byTopic.suppressions,
    sourceBoosts: bySource.boosts,
    sourceSuppressions: bySource.suppressions,
    deliveryModeSensitivity: buildDeliverySensitivity(events),
    duplicateCooldownAdjustments: buildCooldownAdjustments(events, now),
    trustCalibrationHints: buildTrustHints(events),
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function keyMatches(left: string | undefined, right: string | undefined): boolean {
  const leftKey = normalizeAoiFollowThroughKey(left);
  const rightKey = normalizeAoiFollowThroughKey(right);
  if (!leftKey || !rightKey) {
    return false;
  }
  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function relatedEventsForOpportunity(
  opportunity: AoiOpportunity,
  summary: AoiFollowThroughLearningSummary | null | undefined,
): AoiFollowThroughEvent[] {
  if (!summary) {
    return [];
  }
  const keys = relatedKeysForOpportunity(opportunity);
  return summary.recentEvents.filter((event) => {
    if (event.opportunityId === opportunity.id) {
      return true;
    }
    return keys.some(
      (key) =>
        keyMatches(key, event.topicKey) ||
        keyMatches(key, event.sourceKey) ||
        keyMatches(key, event.opportunityId) ||
        event.evidenceRefs.some((ref) => keyMatches(key, ref)),
    );
  });
}

export function latestAoiFollowThroughEventForOpportunity(
  opportunity: AoiOpportunity,
  summary: AoiFollowThroughLearningSummary | null | undefined,
): AoiFollowThroughEvent | null {
  if (!summary) {
    return null;
  }
  return (
    summary.latestByOpportunityId[opportunity.id] ??
    relatedEventsForOpportunity(opportunity, summary).sort(
      (left, right) => right.createdAt - left.createdAt,
    )[0] ??
    null
  );
}

export function scoreAoiFollowThroughLearningForOpportunity(
  opportunity: AoiOpportunity,
  summary: AoiFollowThroughLearningSummary | null | undefined,
  now = Date.now(),
): AoiFollowThroughLearningScore {
  const relatedEvents = relatedEventsForOpportunity(opportunity, summary);
  let rankingFactor = 1;
  let directChatFactor = 1;
  let suppressed = false;
  let nextEligibleAt: number | undefined;
  const reasonLabels: string[] = [];
  const evidenceRefs: string[] = [];
  for (const event of relatedEvents.slice(0, 12)) {
    evidenceRefs.push(...event.evidenceRefs, `follow-through:${event.id}`);
    if (event.result === 'positive') {
      rankingFactor = Math.max(rankingFactor, event.action === 'executed' ? 1.18 : 1.12);
      reasonLabels.push(`show more after ${event.action}`);
      continue;
    }
    if (event.result === 'soft_negative') {
      rankingFactor = Math.min(rankingFactor, 0.88);
      directChatFactor = Math.min(directChatFactor, 0.8);
      reasonLabels.push('show slightly less after ignored delivery');
      continue;
    }
    suppressed = true;
    const unsafe = event.result === 'blocked' || event.feedbackCategory === 'unsafe';
    const tooFrequent =
      event.feedbackCategory === 'too_frequent' || event.feedbackCategory === 'too_much';
    rankingFactor = Math.min(rankingFactor, unsafe ? 0.25 : tooFrequent ? 0.42 : 0.62);
    directChatFactor = Math.min(directChatFactor, unsafe ? 0.15 : tooFrequent ? 0.25 : 0.55);
    const cooldownMs = unsafe
      ? UNSAFE_COOLDOWN_MS
      : tooFrequent
        ? TOO_FREQUENT_COOLDOWN_MS
        : NEGATIVE_COOLDOWN_MS;
    nextEligibleAt = Math.max(nextEligibleAt ?? now, event.createdAt + cooldownMs);
    reasonLabels.push(
      unsafe
        ? 'show less because similar follow-through was unsafe or blocked'
        : tooFrequent
          ? 'show less because similar direct delivery felt too frequent'
          : 'show less after negative follow-through',
    );
  }
  for (const sensitivity of summary?.deliveryModeSensitivity ?? []) {
    if (sensitivity.mode === 'direct_chat') {
      directChatFactor = Math.min(directChatFactor, sensitivity.factor);
      evidenceRefs.push(...sensitivity.evidenceRefs);
    }
  }
  return {
    rankingFactor: clampScore(rankingFactor, 0.1, 1.25),
    suppressed,
    directChatFactor: clampScore(directChatFactor, 0.1, 1.25),
    ...(nextEligibleAt && nextEligibleAt > now ? { nextEligibleAt } : {}),
    reasonLabels: uniqueStrings(reasonLabels, 5),
    evidenceRefs: uniqueStrings(evidenceRefs, 12),
  };
}

export function scoreAoiFollowThroughLearningForKey(
  key: string,
  summary: AoiFollowThroughLearningSummary | null | undefined,
  now = Date.now(),
): AoiFollowThroughLearningScore {
  const fakeOpportunity: AoiOpportunity = {
    version: 1,
    id: `learning-key-${normalizeAoiFollowThroughKey(key) || 'unknown'}`,
    sessionPath: summary?.sessionPath ?? 'aoi/default',
    sourceKind: 'manual',
    title: key,
    curiosityQuestion: key,
    whyNow: key,
    evidenceNeed: key,
    suggestedNextAction: key,
    risk: 'low',
    confidence: 0.5,
    urgency: 0.5,
    novelty: 0.5,
    deliveryRecommendation: 'dashboard',
    status: 'active',
    evidenceRefs: [key],
    dedupeKey: key,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + DEFAULT_COOLDOWN_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  return scoreAoiFollowThroughLearningForOpportunity(fakeOpportunity, summary, now);
}

export function hasAoiFollowThroughUnsafeSignal(
  opportunity: AoiOpportunity,
  summary: AoiFollowThroughLearningSummary | null | undefined,
): boolean {
  return relatedEventsForOpportunity(opportunity, summary).some(
    (event) => event.result === 'blocked' || event.feedbackCategory === 'unsafe',
  );
}

export function buildAoiFollowThroughSummaryIndex(
  summary: AoiFollowThroughLearningSummary,
): AoiFollowThroughSummaryIndex {
  const entries: AoiFollowThroughSummaryIndexEntry[] = [
    ...summary.topicBoosts.map((item) =>
      adjustmentIndexEntry(item, 'topic', 'boost', summary.generatedAt),
    ),
    ...summary.topicSuppressions.map((item) =>
      adjustmentIndexEntry(item, 'topic', 'suppress', summary.generatedAt),
    ),
    ...summary.sourceBoosts.map((item) =>
      adjustmentIndexEntry(item, 'source', 'boost', summary.generatedAt),
    ),
    ...summary.sourceSuppressions.map((item) =>
      adjustmentIndexEntry(item, 'source', 'suppress', summary.generatedAt),
    ),
    ...summary.deliveryModeSensitivity.map((item) => ({
      key: item.mode,
      kind: 'delivery' as const,
      direction: item.factor >= 1 ? ('boost' as const) : ('suppress' as const),
      score: clampScore(item.factor - 1, -1, 1),
      reason: item.reason,
      evidenceRefs: item.evidenceRefs,
      updatedAt: summary.generatedAt,
    })),
    ...summary.duplicateCooldownAdjustments.map((item) => ({
      key: item.key,
      kind: 'cooldown' as const,
      direction: item.factor >= 1 ? ('boost' as const) : ('suppress' as const),
      score: clampScore(item.factor - 1, -1, 1),
      reason: item.reason,
      evidenceRefs: item.evidenceRefs,
      updatedAt: summary.generatedAt,
    })),
  ].slice(0, 80);
  return {
    version: 1,
    sessionPath: summary.sessionPath,
    updatedAt: summary.generatedAt,
    entries,
    evidenceRefs: summary.evidenceRefs.slice(0, 24),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function adjustmentIndexEntry(
  item: AoiFollowThroughLearningAdjustment,
  kind: AoiFollowThroughSummaryIndexEntry['kind'],
  direction: AoiFollowThroughSummaryIndexEntry['direction'],
  updatedAt: number,
): AoiFollowThroughSummaryIndexEntry {
  return {
    key: item.key,
    kind,
    direction,
    score: item.score,
    reason: item.reason,
    evidenceRefs: item.evidenceRefs,
    updatedAt,
  };
}
