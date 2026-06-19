import type {
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefDeliveryMode,
  AoiProactiveBriefFeedback,
} from './aoiAutonomyTypes';

export const AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY = 'proactive-brief:global';

const DEFAULT_MAX_TOPICS_PER_WAKEUP = 2;
const DEFAULT_MAX_NETWORK_CALLS_PER_WAKEUP = 2;
const DEFAULT_TOPIC_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_NEGATIVE_FEEDBACK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_TOPIC_CONFIDENCE = 0.55;
const DEFAULT_MIN_TOPIC_IMPORTANCE = 0.35;

const NEGATIVE_FEEDBACK_CATEGORIES = new Set<AoiProactiveBriefFeedback['category']>([
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

export type AoiProactiveBriefSkipReason =
  | 'profile_empty'
  | 'topic_filter_mismatch'
  | 'topic_muted'
  | 'topic_confidence_low'
  | 'topic_importance_low'
  | 'global_cooldown_active'
  | 'topic_cooldown_active'
  | 'recent_negative_feedback'
  | 'network_disabled'
  | 'network_budget_exhausted'
  | 'policy_disabled'
  | 'tavily_not_configured'
  | 'low_evidence'
  | 'scout_failed';

export interface AoiProactiveBriefPlannerBudget {
  allowNetwork?: boolean;
  quietMode?: boolean;
  maxTopicsPerWakeup?: number;
  maxNetworkCallsPerWakeup?: number;
  globalCooldownMs?: number;
  topicCooldownMs?: number;
  negativeFeedbackCooldownMs?: number;
  minTopicConfidence?: number;
  minTopicImportance?: number;
  directChatHookOptIn?: boolean;
}

export interface AoiProactiveBriefPlannedTopic {
  topic: AoiInterestTopic;
  score: number;
  reasons: string[];
  networkCallCount: number;
  delivery: {
    allowedModes: AoiProactiveBriefDeliveryMode[];
    quietModeSuppressed: boolean;
  };
}

export interface AoiProactiveBriefSkippedTopic {
  topicId?: string;
  topicLabel?: string;
  reason: AoiProactiveBriefSkipReason;
  detail: string;
  retryAfter?: number;
}

export interface AoiProactiveBriefPlan {
  sessionPath: string;
  plannedAt: number;
  topics: AoiProactiveBriefPlannedTopic[];
  skippedTopics: AoiProactiveBriefSkippedTopic[];
  warnings: string[];
  networkCallBudget: {
    allowed: boolean;
    maxCalls: number;
    plannedCalls: number;
  };
}

export interface PlanAoiProactiveBriefTopicsInput {
  profile: AoiInterestProfile;
  cooldownState: AoiProactiveBriefCooldownState;
  feedback: AoiProactiveBriefFeedback[];
  now: number;
  budget?: AoiProactiveBriefPlannerBudget;
  topicId?: string;
}

interface NormalizedPlannerBudget {
  allowNetwork: boolean;
  quietMode: boolean;
  maxTopicsPerWakeup: number;
  maxNetworkCallsPerWakeup: number;
  globalCooldownMs: number;
  topicCooldownMs: number;
  negativeFeedbackCooldownMs: number;
  minTopicConfidence: number;
  minTopicImportance: number;
  directChatHookOptIn: boolean;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizePositiveNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBudget(budget?: AoiProactiveBriefPlannerBudget): NormalizedPlannerBudget {
  const quietMode = budget?.quietMode === true;
  const topicFallback = quietMode ? 1 : DEFAULT_MAX_TOPICS_PER_WAKEUP;
  const networkFallback = quietMode ? 1 : DEFAULT_MAX_NETWORK_CALLS_PER_WAKEUP;
  return {
    allowNetwork: budget?.allowNetwork === true,
    quietMode,
    maxTopicsPerWakeup: normalizePositiveInteger(budget?.maxTopicsPerWakeup, topicFallback, 0, 5),
    maxNetworkCallsPerWakeup: normalizePositiveInteger(
      budget?.maxNetworkCallsPerWakeup,
      networkFallback,
      0,
      5,
    ),
    globalCooldownMs: normalizePositiveInteger(
      budget?.globalCooldownMs,
      DEFAULT_GLOBAL_COOLDOWN_MS,
      0,
      7 * 24 * 60 * 60 * 1000,
    ),
    topicCooldownMs: normalizePositiveInteger(
      budget?.topicCooldownMs,
      DEFAULT_TOPIC_COOLDOWN_MS,
      0,
      30 * 24 * 60 * 60 * 1000,
    ),
    negativeFeedbackCooldownMs: normalizePositiveInteger(
      budget?.negativeFeedbackCooldownMs,
      DEFAULT_NEGATIVE_FEEDBACK_COOLDOWN_MS,
      0,
      90 * 24 * 60 * 60 * 1000,
    ),
    minTopicConfidence: normalizePositiveNumber(
      budget?.minTopicConfidence,
      DEFAULT_MIN_TOPIC_CONFIDENCE,
      0,
      1,
    ),
    minTopicImportance: normalizePositiveNumber(
      budget?.minTopicImportance,
      DEFAULT_MIN_TOPIC_IMPORTANCE,
      0,
      1,
    ),
    directChatHookOptIn: budget?.directChatHookOptIn === true,
  };
}

function topicScore(topic: AoiInterestTopic): number {
  return (
    topic.importance * 0.35 +
    topic.confidence * 0.25 +
    topic.currentInfoPreference * 0.25 +
    topic.noveltyPreference * 0.15 +
    (topic.pinned ? 0.12 : 0)
  );
}

function activeCooldownRetryAfter(
  state: AoiProactiveBriefCooldownState,
  cooldownKey: string,
  now: number,
): number | undefined {
  const entry = state.cooldowns[cooldownKey];
  if (!entry || entry.nextAllowedAt <= now) {
    return undefined;
  }
  return entry.nextAllowedAt;
}

function findRecentNegativeFeedback(
  feedback: AoiProactiveBriefFeedback[],
  topicId: string,
  now: number,
  windowMs: number,
): AoiProactiveBriefFeedback | undefined {
  const threshold = now - windowMs;
  return feedback.find(
    (item) =>
      item.topicId === topicId &&
      item.createdAt >= threshold &&
      NEGATIVE_FEEDBACK_CATEGORIES.has(item.category),
  );
}

function deliveryForBudget(
  budget: NormalizedPlannerBudget,
): AoiProactiveBriefPlannedTopic['delivery'] {
  if (budget.quietMode) {
    return {
      allowedModes: ['dashboard'],
      quietModeSuppressed: true,
    };
  }
  return {
    allowedModes: budget.directChatHookOptIn
      ? ['dashboard', 'digest', 'chat_hook']
      : ['dashboard', 'digest'],
    quietModeSuppressed: false,
  };
}

function skipTopic(
  skippedTopics: AoiProactiveBriefSkippedTopic[],
  topic: AoiInterestTopic | undefined,
  reason: AoiProactiveBriefSkipReason,
  detail: string,
  retryAfter?: number,
): void {
  skippedTopics.push({
    ...(topic
      ? {
          topicId: topic.id,
          topicLabel: topic.label,
        }
      : {}),
    reason,
    detail,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

export function planAoiProactiveBriefTopics(
  input: PlanAoiProactiveBriefTopicsInput,
): AoiProactiveBriefPlan {
  const budget = normalizeBudget(input.budget);
  const skippedTopics: AoiProactiveBriefSkippedTopic[] = [];
  const warnings: string[] = [];
  const topics = Array.isArray(input.profile.topics) ? input.profile.topics : [];

  if (topics.length === 0) {
    skippedTopics.push({
      reason: 'profile_empty',
      detail: 'No interest topics are available for proactive scouting.',
    });
  }

  if (!budget.allowNetwork) {
    warnings.push('network_disabled');
  }

  const globalRetryAfter = activeCooldownRetryAfter(
    input.cooldownState,
    AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
    input.now,
  );
  const ranked: AoiProactiveBriefPlannedTopic[] = [];

  for (const topic of topics) {
    if (input.topicId && topic.id !== input.topicId) {
      skipTopic(
        skippedTopics,
        topic,
        'topic_filter_mismatch',
        'Topic did not match the requested topicId filter.',
      );
      continue;
    }

    if (topic.muted) {
      skipTopic(skippedTopics, topic, 'topic_muted', 'Topic is muted.');
      continue;
    }

    if (topic.confidence < budget.minTopicConfidence) {
      skipTopic(
        skippedTopics,
        topic,
        'topic_confidence_low',
        `Topic confidence ${topic.confidence.toFixed(2)} is below scout threshold.`,
      );
      continue;
    }

    if (topic.importance < budget.minTopicImportance) {
      skipTopic(
        skippedTopics,
        topic,
        'topic_importance_low',
        `Topic importance ${topic.importance.toFixed(2)} is below scout threshold.`,
      );
      continue;
    }

    if (globalRetryAfter !== undefined) {
      skipTopic(
        skippedTopics,
        topic,
        'global_cooldown_active',
        'Global proactive brief cooldown is still active.',
        globalRetryAfter,
      );
      continue;
    }

    const topicRetryAfter = activeCooldownRetryAfter(
      input.cooldownState,
      topic.cooldownKey,
      input.now,
    );
    if (topicRetryAfter !== undefined) {
      skipTopic(
        skippedTopics,
        topic,
        'topic_cooldown_active',
        'Topic proactive brief cooldown is still active.',
        topicRetryAfter,
      );
      continue;
    }

    const negativeFeedback = findRecentNegativeFeedback(
      input.feedback,
      topic.id,
      input.now,
      budget.negativeFeedbackCooldownMs,
    );
    if (negativeFeedback) {
      skipTopic(
        skippedTopics,
        topic,
        'recent_negative_feedback',
        `Recent ${negativeFeedback.category} feedback suppresses this topic.`,
        negativeFeedback.createdAt + budget.negativeFeedbackCooldownMs,
      );
      continue;
    }

    if (!budget.allowNetwork) {
      skipTopic(
        skippedTopics,
        topic,
        'network_disabled',
        'Public current-info scouting requires network budget.',
      );
      continue;
    }

    ranked.push({
      topic,
      score: topicScore(topic),
      reasons: [
        `importance:${topic.importance.toFixed(2)}`,
        `confidence:${topic.confidence.toFixed(2)}`,
        `current-info:${topic.currentInfoPreference.toFixed(2)}`,
      ],
      networkCallCount: 1,
      delivery: deliveryForBudget(budget),
    });
  }

  ranked.sort(
    (left, right) => right.score - left.score || left.topic.label.localeCompare(right.topic.label),
  );

  const maxPlannedCalls = Math.min(budget.maxTopicsPerWakeup, budget.maxNetworkCallsPerWakeup);
  const selected = ranked.slice(0, maxPlannedCalls);
  const selectedIds = new Set(selected.map((item) => item.topic.id));

  for (const item of ranked) {
    if (!selectedIds.has(item.topic.id)) {
      skipTopic(
        skippedTopics,
        item.topic,
        'network_budget_exhausted',
        'Topic was eligible, but this wakeup reached the scout topic or network-call budget.',
      );
    }
  }

  return {
    sessionPath: input.profile.sessionPath,
    plannedAt: input.now,
    topics: selected,
    skippedTopics,
    warnings,
    networkCallBudget: {
      allowed: budget.allowNetwork,
      maxCalls: budget.maxNetworkCallsPerWakeup,
      plannedCalls: selected.reduce((total, item) => total + item.networkCallCount, 0),
    },
  };
}
