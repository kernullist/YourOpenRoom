import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefDeliveryMode,
  AoiProactiveBriefFeedback,
} from './aoiAutonomyTypes';

const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_FEEDBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CHAT_HOOK_MAX_CHARS = 140;

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

const POSITIVE_FEEDBACK = new Set<AoiProactiveBriefFeedback['category']>([
  'useful',
  'show_more',
  'pin_topic',
  'open_sources',
  'expand_summary',
]);

export type AoiProactiveBriefDeliverySuppressionReason =
  | 'candidate_not_active'
  | 'policy_disabled'
  | 'proactive_suggestions_disabled'
  | 'confidence_below_policy_floor'
  | 'topic_muted'
  | 'topic_cooldown_active'
  | 'global_cooldown_active'
  | 'recent_negative_feedback'
  | 'missing_sources'
  | 'stale_source'
  | 'chat_hook_not_opted_in'
  | 'quiet_mode_suppresses_chat_hook'
  | 'quiet_mode_suppresses_inline_card'
  | 'chat_hook_mode_not_allowed'
  | 'inline_mode_not_allowed'
  | 'inline_session_limit_reached';

export interface AoiProactiveBriefDeliveryContext {
  quietMode?: boolean;
  directChatOptIn?: boolean;
  now?: number;
  sourceStaleAfterMs?: number;
  maxInlineCards?: number;
  inlineCardsShown?: number;
}

export interface AoiProactiveBriefDeliveryDecision {
  candidateId: string;
  topicId: string;
  selectedMode: AoiProactiveBriefDeliveryMode | null;
  allowedModes: AoiProactiveBriefDeliveryMode[];
  suppressionReasons: AoiProactiveBriefDeliverySuppressionReason[];
  modeReasons: Record<AoiProactiveBriefDeliveryMode, AoiProactiveBriefDeliverySuppressionReason[]>;
  deliveryScore: number;
  compactCardVisible: boolean;
  digestVisible: boolean;
  inlineCardVisible: boolean;
  chatHook: {
    allowed: boolean;
    text: string;
    reasons: AoiProactiveBriefDeliverySuppressionReason[];
  };
}

export interface DecideAoiProactiveBriefDeliveryInput {
  candidate: AoiProactiveBriefCandidate;
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState | null;
  context?: AoiProactiveBriefDeliveryContext;
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(3))));
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function uniqueReasons(
  values: AoiProactiveBriefDeliverySuppressionReason[],
): AoiProactiveBriefDeliverySuppressionReason[] {
  return [...new Set(values)];
}

function findTopic(
  profile: AoiInterestProfile | null | undefined,
  candidate: AoiProactiveBriefCandidate,
): AoiInterestTopic | undefined {
  return profile?.topics.find((topic) => topic.id === candidate.topicId);
}

function isCandidateActive(candidate: AoiProactiveBriefCandidate): boolean {
  return candidate.status === 'candidate' || candidate.status === 'shown';
}

function recentFeedbackForCandidate(
  feedback: AoiProactiveBriefFeedback[] | undefined,
  candidate: AoiProactiveBriefCandidate,
  now: number,
): AoiProactiveBriefFeedback[] {
  const threshold = now - RECENT_FEEDBACK_WINDOW_MS;
  return (feedback ?? []).filter(
    (item) =>
      item.createdAt >= threshold &&
      (item.briefId === candidate.id || item.topicId === candidate.topicId),
  );
}

function feedbackAdjustment(feedback: AoiProactiveBriefFeedback[]): number {
  let score = 0;
  for (const item of feedback) {
    if (POSITIVE_FEEDBACK.has(item.category)) {
      score += 0.08;
    }
    if (NEGATIVE_FEEDBACK.has(item.category)) {
      score -= 0.22;
    }
  }
  return Math.max(-0.45, Math.min(0.25, score));
}

function newestSourceMs(candidate: AoiProactiveBriefCandidate): number | null {
  const candidates = [
    candidate.freshness.newestSourceAt,
    ...candidate.sources.map((source) => source.publishedAt),
  ].filter((value): value is string => Boolean(value));
  let newest = 0;
  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      newest = Math.max(newest, parsed);
    }
  }
  return newest > 0 ? newest : null;
}

function isSourceStale(
  candidate: AoiProactiveBriefCandidate,
  now: number,
  staleAfterMs: number,
): boolean {
  if (candidate.freshness.cannotKnow.some((item) => item.toLowerCase().includes('stale'))) {
    return true;
  }
  const newest = newestSourceMs(candidate);
  return newest !== null && now - newest > staleAfterMs;
}

function activeCooldownReason(
  candidate: AoiProactiveBriefCandidate,
  cooldownState: AoiProactiveBriefCooldownState | null | undefined,
  now: number,
): AoiProactiveBriefDeliverySuppressionReason | null {
  if (!cooldownState) {
    return null;
  }
  const topicCooldown = cooldownState.cooldowns[candidate.cooldownKey];
  if (topicCooldown && topicCooldown.nextAllowedAt > now) {
    return 'topic_cooldown_active';
  }
  const globalCooldown = cooldownState.cooldowns['proactive-brief:global'];
  if (globalCooldown && globalCooldown.nextAllowedAt > now) {
    return 'global_cooldown_active';
  }
  return null;
}

function addReason(
  reasons: AoiProactiveBriefDeliverySuppressionReason[],
  value: AoiProactiveBriefDeliverySuppressionReason | null | undefined,
): void {
  if (value) {
    reasons.push(value);
  }
}

function modeAllowed(
  candidate: AoiProactiveBriefCandidate,
  mode: AoiProactiveBriefDeliveryMode,
): boolean {
  return candidate.delivery.allowedModes.includes(mode);
}

function chatHookText(candidate: AoiProactiveBriefCandidate): string {
  return truncateText(
    `${candidate.hook} Open the brief if you want the sources.`,
    CHAT_HOOK_MAX_CHARS,
  );
}

export function decideAoiProactiveBriefDelivery(
  input: DecideAoiProactiveBriefDeliveryInput,
): AoiProactiveBriefDeliveryDecision {
  const candidate = input.candidate;
  const policy = input.policy ?? null;
  const context = input.context ?? {};
  const now = context.now ?? Date.now();
  const topic = findTopic(input.profile, candidate);
  const sourceStale = isSourceStale(
    candidate,
    now,
    context.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS,
  );
  const recentFeedback = recentFeedbackForCandidate(input.feedback, candidate, now);
  const hasNegativeFeedback = recentFeedback.some((item) => NEGATIVE_FEEDBACK.has(item.category));
  const baseReasons: AoiProactiveBriefDeliverySuppressionReason[] = [];

  if (!isCandidateActive(candidate)) {
    baseReasons.push('candidate_not_active');
  }
  if (policy && !policy.enabled) {
    baseReasons.push('policy_disabled');
  }
  if (policy && !policy.proactiveSuggestionsEnabled) {
    baseReasons.push('proactive_suggestions_disabled');
  }
  if (policy && candidate.confidence < policy.confidenceFloor) {
    baseReasons.push('confidence_below_policy_floor');
  }
  if (topic?.muted) {
    baseReasons.push('topic_muted');
  }
  if (candidate.sources.length === 0) {
    baseReasons.push('missing_sources');
  }
  if (sourceStale) {
    baseReasons.push('stale_source');
  }
  if (hasNegativeFeedback) {
    baseReasons.push('recent_negative_feedback');
  }
  addReason(baseReasons, activeCooldownReason(candidate, input.cooldownState, now));

  const deliveryScore = clampScore(
    candidate.score * 0.48 +
      candidate.confidence * 0.28 +
      (topic?.importance ?? 0.5) * 0.12 +
      (topic?.pinned ? 0.08 : 0) +
      feedbackAdjustment(recentFeedback),
  );
  const dashboardBlocking = baseReasons.filter(
    (reason) =>
      reason === 'candidate_not_active' ||
      reason === 'policy_disabled' ||
      reason === 'proactive_suggestions_disabled' ||
      reason === 'confidence_below_policy_floor' ||
      reason === 'missing_sources' ||
      reason === 'topic_muted',
  );
  const attentionBlocking = baseReasons.filter(
    (reason) =>
      dashboardBlocking.includes(reason) ||
      reason === 'topic_cooldown_active' ||
      reason === 'global_cooldown_active' ||
      reason === 'recent_negative_feedback' ||
      reason === 'stale_source',
  );
  const compactCardVisible = dashboardBlocking.length === 0;
  const digestVisible =
    compactCardVisible &&
    attentionBlocking.length === 0 &&
    deliveryScore >= 0.5 &&
    candidate.delivery.allowedModes.some((mode) => mode === 'digest' || mode === 'dashboard');

  const modeReasons: Record<
    AoiProactiveBriefDeliveryMode,
    AoiProactiveBriefDeliverySuppressionReason[]
  > = {
    dashboard: uniqueReasons(dashboardBlocking),
    digest: uniqueReasons(
      compactCardVisible && digestVisible ? [] : [...dashboardBlocking, ...attentionBlocking],
    ),
    inline_card: [],
    chat_hook: [],
  };

  const inlineReasons: AoiProactiveBriefDeliverySuppressionReason[] = [];
  if (!modeAllowed(candidate, 'inline_card') && !modeAllowed(candidate, 'dashboard')) {
    inlineReasons.push('inline_mode_not_allowed');
  }
  if ((context.inlineCardsShown ?? 0) >= (context.maxInlineCards ?? 1)) {
    inlineReasons.push('inline_session_limit_reached');
  }
  if (context.quietMode) {
    inlineReasons.push('quiet_mode_suppresses_inline_card');
  }
  modeReasons.inline_card = uniqueReasons([
    ...dashboardBlocking,
    ...attentionBlocking,
    ...inlineReasons,
  ]);

  const chatHookReasons: AoiProactiveBriefDeliverySuppressionReason[] = [];
  if (!context.directChatOptIn) {
    chatHookReasons.push('chat_hook_not_opted_in');
  }
  if (context.quietMode) {
    chatHookReasons.push('quiet_mode_suppresses_chat_hook');
  }
  if (!modeAllowed(candidate, 'chat_hook')) {
    chatHookReasons.push('chat_hook_mode_not_allowed');
  }
  if (sourceStale) {
    chatHookReasons.push('stale_source');
  }
  modeReasons.chat_hook = uniqueReasons([
    ...dashboardBlocking,
    ...attentionBlocking,
    ...chatHookReasons,
  ]);

  const inlineCardVisible =
    compactCardVisible &&
    modeReasons.inline_card.length === 0 &&
    deliveryScore >= 0.58 &&
    !hasNegativeFeedback;
  const chatHookAllowed =
    compactCardVisible &&
    modeReasons.chat_hook.length === 0 &&
    deliveryScore >= 0.72 &&
    !hasNegativeFeedback;

  const allowedModes: AoiProactiveBriefDeliveryMode[] = [];
  if (compactCardVisible) {
    allowedModes.push('dashboard');
  }
  if (digestVisible) {
    allowedModes.push('digest');
  }
  if (inlineCardVisible) {
    allowedModes.push('inline_card');
  }
  if (chatHookAllowed) {
    allowedModes.push('chat_hook');
  }

  const selectedMode =
    inlineCardVisible && deliveryScore >= 0.68
      ? 'inline_card'
      : digestVisible
        ? 'digest'
        : compactCardVisible
          ? 'dashboard'
          : null;

  return {
    candidateId: candidate.id,
    topicId: candidate.topicId,
    selectedMode,
    allowedModes,
    suppressionReasons: uniqueReasons(baseReasons),
    modeReasons,
    deliveryScore,
    compactCardVisible,
    digestVisible,
    inlineCardVisible,
    chatHook: {
      allowed: chatHookAllowed,
      text: chatHookAllowed ? chatHookText(candidate) : '',
      reasons: modeReasons.chat_hook,
    },
  };
}
