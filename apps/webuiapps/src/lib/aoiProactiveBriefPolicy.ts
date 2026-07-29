import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCalibrationTuning,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefDeliveryMode,
  AoiProactiveBriefFeedback,
} from './aoiAutonomyTypes';
import { buildAoiCompanionBriefChatHook, type AoiCompanionVoice } from './aoiCompanionVoice';

const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_FEEDBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const CHAT_HOOK_MAX_CHARS = 140;

const NEGATIVE_FEEDBACK = new Set<AoiProactiveBriefFeedback['category']>([
  'not_useful',
  'show_less',
  'wrong_topic',
  'wrong_source',
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
  | 'inline_session_limit_reached'
  | 'calibration_stale_direct_chat_block'
  | 'calibration_unsafe_direct_chat_block'
  | 'calibration_timing_prefers_digest';

export type AoiProactiveBriefDeliveryLadderLane =
  | 'hidden'
  | 'dashboard'
  | 'digest'
  | 'direct_chat'
  | 'approval_request'
  | 'execute_after_approval';

export interface AoiProactiveBriefDeliveryLadderStep {
  lane: AoiProactiveBriefDeliveryLadderLane;
  allowed: boolean;
  reasons: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiProactiveBriefDeliveryLadderDecision {
  version: 1;
  selectedLane: AoiProactiveBriefDeliveryLadderLane;
  steps: Record<AoiProactiveBriefDeliveryLadderLane, AoiProactiveBriefDeliveryLadderStep>;
  approvalRequired: boolean;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

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
  ladder: AoiProactiveBriefDeliveryLadderDecision;
}

export interface DecideAoiProactiveBriefDeliveryInput {
  candidate: AoiProactiveBriefCandidate;
  policy?: AoiAutonomyPolicy | null;
  profile?: AoiInterestProfile | null;
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState | null;
  calibrationTuning?: AoiProactiveBriefCalibrationTuning | null;
  context?: AoiProactiveBriefDeliveryContext;
  // Renders the chat hook in the companion register. Omitted -> the stored
  // English hook is used, so existing callers are unaffected.
  voice?: AoiCompanionVoice | null;
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

function uniqueReasonText(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, 24);
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

function sourceHostKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sourceCalibrationTuning(
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined,
  candidate: AoiProactiveBriefCandidate,
): Array<AoiProactiveBriefCalibrationTuning['sourceTuning'][string]> {
  if (!tuning) {
    return [];
  }
  return candidate.sources
    .map((source) => tuning.sourceTuning[sourceHostKey(source.host)])
    .filter((item): item is AoiProactiveBriefCalibrationTuning['sourceTuning'][string] =>
      Boolean(item),
    );
}

function calibrationScoreAdjustment(params: {
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined;
  candidate: AoiProactiveBriefCandidate;
}): number {
  const topicTuning = params.tuning?.topicTuning[params.candidate.topicId];
  const sourceTunings = sourceCalibrationTuning(params.tuning, params.candidate);
  const sourceDelta =
    sourceTunings.length > 0
      ? sourceTunings.reduce((sum, item) => sum + item.preferenceDelta, 0) / sourceTunings.length
      : 0;
  return Math.max(
    -0.5,
    Math.min(
      0.35,
      (topicTuning?.scoreDelta ?? 0) +
        (topicTuning?.sourcePreferenceDelta ?? 0) * 0.4 +
        sourceDelta * 0.25,
    ),
  );
}

function activeCalibrationCooldownReason(
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined,
  candidate: AoiProactiveBriefCandidate,
  now: number,
): AoiProactiveBriefDeliverySuppressionReason | null {
  const topicTuning = tuning?.topicTuning[candidate.topicId];
  if (!topicTuning || topicTuning.cooldownMs <= 0) {
    return null;
  }
  return topicTuning.updatedAt + topicTuning.cooldownMs > now ? 'topic_cooldown_active' : null;
}

function calibrationChatHookReasons(params: {
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined;
  candidate: AoiProactiveBriefCandidate;
}): AoiProactiveBriefDeliverySuppressionReason[] {
  const topicTuning = params.tuning?.topicTuning[params.candidate.topicId];
  const sourceTunings = sourceCalibrationTuning(params.tuning, params.candidate);
  const reasons: AoiProactiveBriefDeliverySuppressionReason[] = [];
  if (topicTuning?.directChatBlocked || topicTuning?.preferDigestOrDashboard) {
    if (topicTuning.conservativeReasons.includes('unsafe')) {
      reasons.push('calibration_unsafe_direct_chat_block');
    } else if (topicTuning.conservativeReasons.includes('stale')) {
      reasons.push('calibration_stale_direct_chat_block');
    } else {
      reasons.push('calibration_timing_prefers_digest');
    }
  }
  if (sourceTunings.some((item) => item.unsafeBlocked)) {
    reasons.push('calibration_unsafe_direct_chat_block');
  } else if (sourceTunings.some((item) => item.staleBlocked || item.directChatBlocked)) {
    reasons.push('calibration_stale_direct_chat_block');
  }
  return uniqueReasons(reasons);
}

function calibrationChatHookThresholdDelta(
  tuning: AoiProactiveBriefCalibrationTuning | null | undefined,
  candidate: AoiProactiveBriefCandidate,
): number {
  return tuning?.topicTuning[candidate.topicId]?.chatHookThresholdDelta ?? 0;
}

function addReason(
  reasons: AoiProactiveBriefDeliverySuppressionReason[],
  value: AoiProactiveBriefDeliverySuppressionReason | null | undefined,
): void {
  if (value) {
    reasons.push(value);
  }
}

function ladderStep(
  lane: AoiProactiveBriefDeliveryLadderLane,
  allowed: boolean,
  reasons: Array<string | undefined | null>,
): AoiProactiveBriefDeliveryLadderStep {
  return {
    lane,
    allowed,
    reasons: uniqueReasonText(reasons),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function buildDeliveryLadder(params: {
  compactCardVisible: boolean;
  digestVisible: boolean;
  chatHookAllowed: boolean;
  selectedMode: AoiProactiveBriefDeliveryMode | null;
  baseReasons: AoiProactiveBriefDeliverySuppressionReason[];
  modeReasons: Record<AoiProactiveBriefDeliveryMode, AoiProactiveBriefDeliverySuppressionReason[]>;
  chatHookReasons: AoiProactiveBriefDeliverySuppressionReason[];
  sourceStale: boolean;
  unsafeFeedback: boolean;
  unsafeCalibration: boolean;
}): AoiProactiveBriefDeliveryLadderDecision {
  const selectedLane: AoiProactiveBriefDeliveryLadderLane = params.chatHookAllowed
    ? 'direct_chat'
    : params.selectedMode === 'digest'
      ? 'digest'
      : params.compactCardVisible
        ? 'dashboard'
        : 'hidden';
  const approvalReasons = uniqueReasonText([
    'no_prepared_action',
    params.unsafeFeedback || params.unsafeCalibration
      ? 'unsafe_feedback_blocks_approval_request'
      : undefined,
    params.sourceStale ? 'stale_source_blocks_approval_request' : undefined,
  ]);
  const executeReasons = uniqueReasonText([
    'approval_sandbox_required',
    'authority_registry_proof_required',
    'approval_request_not_allowed',
  ]);

  return {
    version: 1,
    selectedLane,
    steps: {
      hidden: ladderStep('hidden', !params.compactCardVisible, [
        params.compactCardVisible ? undefined : 'record_only_hidden',
        ...params.baseReasons,
        ...params.modeReasons.dashboard,
      ]),
      dashboard: ladderStep('dashboard', params.compactCardVisible, params.modeReasons.dashboard),
      digest: ladderStep('digest', params.digestVisible, params.modeReasons.digest),
      direct_chat: ladderStep('direct_chat', params.chatHookAllowed, params.chatHookReasons),
      approval_request: ladderStep('approval_request', false, approvalReasons),
      execute_after_approval: ladderStep('execute_after_approval', false, executeReasons),
    },
    approvalRequired: false,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function modeAllowed(
  candidate: AoiProactiveBriefCandidate,
  mode: AoiProactiveBriefDeliveryMode,
): boolean {
  return candidate.delivery.allowedModes.includes(mode);
}

// The line Aoi actually says when a brief is escalated to chat. With a voice
// supplied it is composed in the companion register from the candidate's own
// structured fields; without one it falls back to the stored hook, so legacy
// records and callers that pass no voice behave exactly as before.
function chatHookText(
  candidate: AoiProactiveBriefCandidate,
  voice: AoiCompanionVoice | null,
): string {
  if (voice) {
    return truncateText(
      buildAoiCompanionBriefChatHook(voice, {
        topicLabel: candidate.topicLabel,
        sourceCount: candidate.sources.length,
        mediaBucket: candidate.mediaBucket ?? null,
      }),
      CHAT_HOOK_MAX_CHARS,
    );
  }
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
  const calibrationTuning = input.calibrationTuning ?? null;
  const topicCalibration = calibrationTuning?.topicTuning[candidate.topicId];
  const chatCalibrationReasons = calibrationChatHookReasons({
    tuning: calibrationTuning,
    candidate,
  });
  const sourceStale = isSourceStale(
    candidate,
    now,
    context.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS,
  );
  const recentFeedback = recentFeedbackForCandidate(input.feedback, candidate, now);
  const hasNegativeFeedback = recentFeedback.some((item) => NEGATIVE_FEEDBACK.has(item.category));
  const hasUnsafeFeedback = recentFeedback.some((item) => item.category === 'unsafe');
  const hasUnsafeCalibration = chatCalibrationReasons.includes(
    'calibration_unsafe_direct_chat_block',
  );
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
  if (topicCalibration?.muted) {
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
  addReason(baseReasons, activeCalibrationCooldownReason(calibrationTuning, candidate, now));

  const deliveryScore = clampScore(
    candidate.score * 0.48 +
      candidate.confidence * 0.28 +
      (topic?.importance ?? 0.5) * 0.12 +
      (topic?.pinned ? 0.08 : 0) +
      (topicCalibration?.pinned ? 0.04 : 0) +
      feedbackAdjustment(recentFeedback) +
      calibrationScoreAdjustment({ tuning: calibrationTuning, candidate }),
  );
  const dashboardBlocking: AoiProactiveBriefDeliverySuppressionReason[] = baseReasons.filter(
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
  if (chatCalibrationReasons.includes('calibration_unsafe_direct_chat_block')) {
    inlineReasons.push('calibration_unsafe_direct_chat_block');
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
  chatHookReasons.push(...chatCalibrationReasons);
  modeReasons.chat_hook = uniqueReasons([
    ...dashboardBlocking,
    ...attentionBlocking,
    ...chatHookReasons,
  ]);

  const inlineCardVisible =
    compactCardVisible &&
    modeReasons.inline_card.length === 0 &&
    deliveryScore >= 0.58 + (topicCalibration?.preferDigestOrDashboard ? 0.08 : 0) &&
    !hasNegativeFeedback;
  const chatHookAllowed =
    compactCardVisible &&
    modeReasons.chat_hook.length === 0 &&
    deliveryScore >= 0.72 + calibrationChatHookThresholdDelta(calibrationTuning, candidate) &&
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
  const chatHookReasonList = modeReasons.chat_hook;
  const ladder = buildDeliveryLadder({
    compactCardVisible,
    digestVisible,
    chatHookAllowed,
    selectedMode,
    baseReasons: uniqueReasons(baseReasons),
    modeReasons,
    chatHookReasons: chatHookReasonList,
    sourceStale,
    unsafeFeedback: hasUnsafeFeedback,
    unsafeCalibration: hasUnsafeCalibration,
  });

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
      text: chatHookAllowed ? chatHookText(candidate, input.voice ?? null) : '',
      reasons: chatHookReasonList,
    },
    ladder,
  };
}
