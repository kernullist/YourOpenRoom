import {
  canAoiJarvisAutonomyUseCapability,
  type AoiJarvisAutonomyGovernorDecision,
} from './aoiJarvisAutonomyGovernor';
import type {
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiInterruptionBlockedReason,
  AoiInterruptionDeliveryMode,
  AoiInterruptionGovernorDecision,
  AoiOpportunity,
  AoiProactiveBriefFeedback,
  AoiProactiveTrendAdvisorState,
  AoiProactiveTrendDeliveryEvent,
} from './aoiAutonomyTypes';

const DEFAULT_RECENT_FEEDBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_DIRECT_CHAT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_INLINE_CARDS_PER_SESSION = 2;
const DEFAULT_MAX_DIRECT_CHATS_PER_SESSION = 1;

const NEGATIVE_FEEDBACK = new Set<AoiProactiveBriefFeedback['category']>([
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

export interface AoiInterruptionGovernorInput {
  sessionPath: string;
  opportunity: AoiOpportunity;
  deliberationRun?: AoiDeliberationRun | null;
  proactiveTrendAdvisor?: AoiProactiveTrendAdvisorState | null;
  policy?: AoiAutonomyPolicy | null;
  feedback?: readonly AoiProactiveBriefFeedback[];
  quietMode?: boolean;
  notificationsEnabled?: boolean;
  directChatOptIn?: boolean;
  jarvisGovernor?: AoiJarvisAutonomyGovernorDecision | null;
  recentDeliveryKeys?: ReadonlySet<string> | readonly string[];
  recentInterruptionAt?: number | null;
  inlineShownCount?: number;
  directChatShownCount?: number;
  maxInlineCardsPerSession?: number;
  maxDirectChatsPerSession?: number;
  now?: number;
}

export interface AoiInterruptionGovernorBatchInput extends Omit<
  AoiInterruptionGovernorInput,
  'opportunity' | 'deliberationRun'
> {
  opportunities: readonly AoiOpportunity[];
  deliberationRuns?: readonly AoiDeliberationRun[];
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(3))));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value).slice(0, 220);
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

function uniqueReasons(
  values: readonly AoiInterruptionBlockedReason[],
): AoiInterruptionBlockedReason[] {
  return [...new Set(values)];
}

function deliveryKeySet(value: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  if (!value) {
    return new Set();
  }
  if (value instanceof Set) {
    return new Set(value);
  }
  return new Set(value);
}

function cooldownKeyForOpportunity(opportunity: AoiOpportunity): string {
  return `interruption:${opportunity.sessionPath}:${opportunity.dedupeKey || opportunity.id}`;
}

function scoreOpportunity(params: {
  opportunity: AoiOpportunity;
  deliberationRun?: AoiDeliberationRun | null;
  negativeFeedbackCount: number;
}): number {
  const riskPenalty =
    params.opportunity.risk === 'high' ? 0.22 : params.opportunity.risk === 'medium' ? 0.08 : 0;
  const deliberationBoost =
    params.deliberationRun?.phase === 'ready'
      ? 0.08
      : params.deliberationRun?.phase === 'blocked'
        ? -0.08
        : params.deliberationRun?.phase === 'failed'
          ? -0.18
          : 0;
  return clampScore(
    params.opportunity.confidence * 0.42 +
      params.opportunity.urgency * 0.32 +
      params.opportunity.novelty * 0.2 +
      deliberationBoost -
      riskPenalty -
      Math.min(0.32, params.negativeFeedbackCount * 0.12),
  );
}

function recentNegativeFeedback(params: {
  feedback?: readonly AoiProactiveBriefFeedback[];
  sessionPath: string;
  now: number;
}): AoiProactiveBriefFeedback[] {
  const threshold = params.now - DEFAULT_RECENT_FEEDBACK_WINDOW_MS;
  return (params.feedback ?? []).filter(
    (item) =>
      item.sessionPath === params.sessionPath &&
      item.createdAt >= threshold &&
      NEGATIVE_FEEDBACK.has(item.category),
  );
}

function newestMatchingTrendDelivery(params: {
  trendAdvisor?: AoiProactiveTrendAdvisorState | null;
  opportunity: AoiOpportunity;
}): AoiProactiveTrendDeliveryEvent | null {
  const events = params.trendAdvisor?.recentDeliveryEvents ?? [];
  const refs = new Set([
    params.opportunity.id,
    params.opportunity.dedupeKey,
    ...params.opportunity.evidenceRefs,
  ]);
  return (
    events
      .filter(
        (event) =>
          event.dedupeKey === params.opportunity.dedupeKey ||
          refs.has(event.candidateId ?? '') ||
          refs.has(`trend:${event.snapshotId}`) ||
          refs.has(`proactive-brief:${event.candidateId ?? ''}`),
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
}

function evidenceBlockers(params: {
  opportunity: AoiOpportunity;
  deliberationRun?: AoiDeliberationRun | null;
}): AoiInterruptionBlockedReason[] {
  const reasons: AoiInterruptionBlockedReason[] = [];
  if (params.opportunity.evidenceRefs.length === 0) {
    reasons.push('missing_evidence');
  }
  const run = params.deliberationRun;
  if (!run) {
    return reasons;
  }
  if (run.phase === 'failed' || run.finding?.freshness === 'failed') {
    reasons.push('failed_evidence');
  }
  if (
    run.finding?.freshness === 'stale' ||
    run.evidencePlan.some((step) => step.status === 'stale')
  ) {
    reasons.push('stale_source');
  }
  if (
    run.finding?.sourceQuality === 'missing' ||
    run.evidencePlan.some((step) => step.status === 'missing' || step.status === 'blocked')
  ) {
    reasons.push('missing_evidence');
  }
  return uniqueReasons(reasons);
}

function labelForReason(reason: AoiInterruptionBlockedReason): string {
  switch (reason) {
    case 'policy_disabled':
      return 'Aoi autonomy policy is disabled.';
    case 'proactive_suggestions_disabled':
      return 'Proactive suggestions are disabled by policy.';
    case 'opportunity_not_active':
      return 'Opportunity is not active.';
    case 'opportunity_expired':
      return 'Opportunity expired before delivery.';
    case 'opportunity_snoozed':
      return 'Opportunity is snoozed.';
    case 'low_confidence':
      return 'Confidence is below the direct-interruption threshold.';
    case 'low_urgency':
      return 'Urgency is not high enough for direct chat.';
    case 'low_novelty':
      return 'Novelty is not high enough for direct chat.';
    case 'high_risk':
      return 'High-risk items stay dashboard-only until a later approval path handles them.';
    case 'missing_evidence':
      return 'Evidence is missing or blocked, so Aoi should abstain from interruption.';
    case 'stale_source':
      return 'Source evidence is stale; dashboard review only.';
    case 'failed_evidence':
      return 'Evidence validation failed, so delivery is blocked from interruption.';
    case 'direct_chat_not_opted_in':
      return 'Direct chat is not opted in.';
    case 'quiet_mode':
      return 'Quiet mode suppresses proactive interruption.';
    case 'notifications_disabled':
      return 'Panel notifications are disabled.';
    case 'inline_session_limit_reached':
      return 'Inline card session budget is exhausted.';
    case 'direct_chat_session_limit_reached':
      return 'Direct chat session budget is exhausted.';
    case 'recent_interruption_budget':
      return 'A recent interruption is still cooling down.';
    case 'duplicate_or_cooldown':
      return 'Duplicate delivery or cooldown is active.';
    case 'recent_negative_feedback':
      return 'Recent negative feedback lowers delivery intensity.';
    case 'too_frequent_feedback':
      return 'Recent too-frequent feedback blocks direct chat.';
    case 'jarvis_governor_blocks_direct_chat':
      return 'Jarvis autonomy governor does not currently allow direct chat.';
    case 'trend_direct_chat_not_ready':
      return 'Trend advisor direct-chat readiness is not yet proven.';
    case 'trend_duplicate_suppressed':
      return 'Trend delivery audit suppressed a repeated item.';
  }
}

function modeLabel(mode: AoiInterruptionDeliveryMode): string {
  switch (mode) {
    case 'hidden':
      return 'hidden';
    case 'dashboard':
      return 'dashboard';
    case 'inline_card':
      return 'inline card';
    case 'quiet_notification':
      return 'quiet notification';
    case 'direct_chat':
      return 'direct chat';
  }
}

function summaryForMode(mode: AoiInterruptionDeliveryMode, reasons: readonly string[]): string {
  if (mode === 'direct_chat') {
    return 'Direct chat is allowed because opt-in, freshness, budget, confidence, novelty, urgency, and Jarvis governor gates all passed.';
  }
  if (mode === 'inline_card') {
    return 'Aoi can surface this as an inline card, but direct chat remains blocked.';
  }
  if (mode === 'quiet_notification') {
    return 'Aoi can surface this as a quiet notification without direct chat.';
  }
  if (mode === 'dashboard') {
    return reasons.length > 0
      ? 'Dashboard-only because one or more interruption gates blocked stronger delivery.'
      : 'Dashboard-only because the item does not need interruption.';
  }
  return 'Hidden from proactive interruption because policy, quiet mode, snooze, or duplicate gates blocked delivery.';
}

function isCriticalOpportunity(opportunity: AoiOpportunity): boolean {
  return (
    opportunity.urgency >= 0.92 && opportunity.confidence >= 0.82 && opportunity.risk !== 'high'
  );
}

function latestRunForOpportunity(
  runs: readonly AoiDeliberationRun[] | undefined,
  opportunityId: string,
): AoiDeliberationRun | null {
  return (
    (runs ?? [])
      .filter((run) => run.opportunityId === opportunityId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  );
}

export function decideAoiInterruptionDelivery(
  input: AoiInterruptionGovernorInput,
): AoiInterruptionGovernorDecision {
  const now = input.now ?? Date.now();
  const policy = input.policy ?? null;
  const opportunity = input.opportunity;
  const cooldownMs = Math.max(
    DEFAULT_DIRECT_CHAT_COOLDOWN_MS,
    policy?.defaultCooldownMs ?? DEFAULT_DIRECT_CHAT_COOLDOWN_MS,
  );
  const cooldownKey = cooldownKeyForOpportunity(opportunity);
  const recentKeys = deliveryKeySet(input.recentDeliveryKeys);
  const negativeFeedback = recentNegativeFeedback({
    feedback: input.feedback,
    sessionPath: input.sessionPath,
    now,
  });
  const tooFrequentFeedback = negativeFeedback.some((item) => item.category === 'too_frequent');
  const newestTrendDelivery = newestMatchingTrendDelivery({
    trendAdvisor: input.proactiveTrendAdvisor,
    opportunity,
  });
  const nextEligibleCandidates: number[] = [];
  const hardBlockers: AoiInterruptionBlockedReason[] = [];
  const baseBlockers: AoiInterruptionBlockedReason[] = [];
  const directBlockers: AoiInterruptionBlockedReason[] = [];

  if (policy && !policy.enabled) {
    hardBlockers.push('policy_disabled');
  }
  if (policy && !policy.proactiveSuggestionsEnabled) {
    hardBlockers.push('proactive_suggestions_disabled');
  }
  if (opportunity.status !== 'active') {
    if (opportunity.status === 'snoozed') {
      hardBlockers.push('opportunity_snoozed');
      if (opportunity.snoozedUntil && opportunity.snoozedUntil > now) {
        nextEligibleCandidates.push(opportunity.snoozedUntil);
      }
    } else {
      hardBlockers.push('opportunity_not_active');
    }
  }
  if (opportunity.expiresAt <= now) {
    hardBlockers.push('opportunity_expired');
  }
  if (opportunity.confidence < Math.max(policy?.confidenceFloor ?? 0.45, 0.45)) {
    baseBlockers.push('low_confidence');
  }
  if (opportunity.risk === 'high') {
    baseBlockers.push('high_risk');
  }

  const directChatOptIn =
    input.directChatOptIn ?? policy?.proactiveBriefing.directChatHookOptIn === true;
  const directChatSessionLimit =
    input.maxDirectChatsPerSession ?? DEFAULT_MAX_DIRECT_CHATS_PER_SESSION;
  const inlineSessionLimit = input.maxInlineCardsPerSession ?? DEFAULT_MAX_INLINE_CARDS_PER_SESSION;
  const evidenceReasons = evidenceBlockers({
    opportunity,
    deliberationRun: input.deliberationRun,
  });
  const allEvidenceRefs = uniqueStrings(
    [
      `opportunity:${opportunity.id}`,
      ...opportunity.evidenceRefs,
      ...(input.deliberationRun?.evidenceRefs ?? []),
      ...(input.deliberationRun?.finding?.evidenceRefs ?? []),
      ...(input.proactiveTrendAdvisor?.evidenceRefs ?? []),
    ],
    24,
  );
  const score = scoreOpportunity({
    opportunity,
    deliberationRun: input.deliberationRun,
    negativeFeedbackCount: negativeFeedback.length,
  });

  if (opportunity.urgency < 0.72) {
    directBlockers.push('low_urgency');
  }
  if (opportunity.novelty < 0.48) {
    directBlockers.push('low_novelty');
  }
  if (!directChatOptIn) {
    directBlockers.push('direct_chat_not_opted_in');
  }
  if (input.quietMode === true) {
    directBlockers.push('quiet_mode');
  }
  if ((input.directChatShownCount ?? 0) >= directChatSessionLimit) {
    directBlockers.push('direct_chat_session_limit_reached');
  }
  if ((input.inlineShownCount ?? 0) >= inlineSessionLimit) {
    baseBlockers.push('inline_session_limit_reached');
  }
  if (input.recentInterruptionAt && input.recentInterruptionAt + cooldownMs > now) {
    directBlockers.push('recent_interruption_budget');
    nextEligibleCandidates.push(input.recentInterruptionAt + cooldownMs);
  }
  if (
    recentKeys.has(cooldownKey) ||
    recentKeys.has(opportunity.dedupeKey) ||
    (newestTrendDelivery && newestTrendDelivery.createdAt + cooldownMs > now)
  ) {
    directBlockers.push('duplicate_or_cooldown');
    if (newestTrendDelivery) {
      nextEligibleCandidates.push(newestTrendDelivery.createdAt + cooldownMs);
    }
  }
  if (negativeFeedback.length > 0) {
    directBlockers.push('recent_negative_feedback');
  }
  if (tooFrequentFeedback) {
    directBlockers.push('too_frequent_feedback');
  }
  if (
    input.proactiveTrendAdvisor &&
    input.proactiveTrendAdvisor.readiness.directChatReady !== true
  ) {
    directBlockers.push('trend_direct_chat_not_ready');
  }
  if (
    input.proactiveTrendAdvisor?.deliveryControlBlockedReasons.some((reason) =>
      /duplicate|delivery_event_recently_recorded/.test(reason),
    )
  ) {
    directBlockers.push('trend_duplicate_suppressed');
  }
  if (!canAoiJarvisAutonomyUseCapability(input.jarvisGovernor, 'direct_chat')) {
    directBlockers.push('jarvis_governor_blocks_direct_chat');
  }
  directBlockers.push(...evidenceReasons);
  if (score < 0.72) {
    directBlockers.push('low_confidence');
  }

  const baseReasons = uniqueReasons([...hardBlockers, ...baseBlockers, ...evidenceReasons]);
  const directChatBlockedReasons = uniqueReasons([...baseReasons, ...directBlockers]);
  const hardBlocked = hardBlockers.length > 0;
  const staleOrMissing = evidenceReasons.some(
    (reason) =>
      reason === 'stale_source' || reason === 'failed_evidence' || reason === 'missing_evidence',
  );
  const deliveryBudgetBlocked = directBlockers.some(
    (reason) =>
      reason === 'duplicate_or_cooldown' ||
      reason === 'recent_interruption_budget' ||
      reason === 'too_frequent_feedback',
  );
  const critical = isCriticalOpportunity(opportunity);
  const directChatAllowed = !hardBlocked && directChatBlockedReasons.length === 0;
  const inlineAllowed =
    !hardBlocked &&
    !staleOrMissing &&
    !deliveryBudgetBlocked &&
    input.quietMode !== true &&
    (input.inlineShownCount ?? 0) < inlineSessionLimit &&
    score >= 0.58 &&
    negativeFeedback.length === 0;
  const quietNotificationAllowed =
    !hardBlocked &&
    input.notificationsEnabled === true &&
    !staleOrMissing &&
    !deliveryBudgetBlocked &&
    (input.quietMode !== true || critical) &&
    score >= 0.5;

  let deliveryMode: AoiInterruptionDeliveryMode = 'dashboard';
  if (hardBlocked) {
    deliveryMode = 'hidden';
  } else if (directChatAllowed) {
    deliveryMode = 'direct_chat';
  } else if (inlineAllowed) {
    deliveryMode = 'inline_card';
  } else if (quietNotificationAllowed) {
    deliveryMode = 'quiet_notification';
  } else if (input.quietMode === true && !critical) {
    deliveryMode = 'hidden';
  }

  const blockedReasons = uniqueReasons(
    deliveryMode === 'direct_chat'
      ? baseReasons
      : deliveryMode === 'hidden'
        ? [...baseReasons, ...directChatBlockedReasons]
        : directChatBlockedReasons,
  );
  const nextEligibleAt =
    nextEligibleCandidates.length > 0 ? Math.max(...nextEligibleCandidates) : undefined;
  const blockedReasonLabels = blockedReasons.map(labelForReason).slice(0, 8);

  return {
    version: 1,
    id: `aoi-interrupt-${opportunity.id}`,
    sessionPath: input.sessionPath,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    requestedMode: opportunity.deliveryRecommendation,
    deliveryMode,
    directChatAllowed,
    score,
    blockedReasons,
    directChatBlockedReasons,
    evidenceRefs: allEvidenceRefs,
    cooldownKey,
    ...(nextEligibleAt ? { nextEligibleAt } : {}),
    modeLabel: modeLabel(deliveryMode),
    summaryLabel: summaryForMode(deliveryMode, blockedReasonLabels),
    blockedReasonLabels,
    safetyBoundaryLabel:
      'Interruption governor is display-only: it can downgrade or explain delivery, but it cannot execute tools, mutate apps, start research, or create Kira work.',
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiInterruptionGovernorDecisions(
  input: AoiInterruptionGovernorBatchInput,
): AoiInterruptionGovernorDecision[] {
  return input.opportunities.map((opportunity) =>
    decideAoiInterruptionDelivery({
      ...input,
      opportunity,
      deliberationRun: latestRunForOpportunity(input.deliberationRuns, opportunity.id),
    }),
  );
}
