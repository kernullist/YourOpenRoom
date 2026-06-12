import {
  AOI_AUTONOMY_LEVEL_ORDER,
  DEFAULT_AOI_AUTONOMY_POLICY,
  checkAoiProposalPolicy,
} from './aoiAutonomyPolicy';
import type {
  AoiAutonomyLevel,
  AoiAutonomyBlockedProposal,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiAutonomyStatus,
  AoiMissionState,
  AoiProposal,
} from './aoiAutonomyTypes';

export const AOI_INLINE_SUGGESTION_COOLDOWN_MS = 30 * 60 * 1000;
export const AOI_INLINE_SUGGESTION_MAX_PER_SESSION = 3;
export const AOI_AUTONOMY_PANEL_SETTINGS_KEY = 'openroom-aoi-autonomy-panel-settings';

export const AOI_AUTONOMY_UI_LEVELS: AoiAutonomyLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

const RISK_SCORE: Record<AoiAutonomyRisk, number> = {
  low: 0.14,
  medium: 0,
  high: -0.22,
};

const WINDOWS_PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g;
const UNIX_PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g;

export interface AoiInlineProposalSelectionOptions {
  now?: number;
  dismissedProposalIds?: ReadonlySet<string>;
  snoozedProposalIds?: ReadonlySet<string>;
  lastShownAt?: number | null;
  shownCount?: number;
  maxPerSession?: number;
  cooldownMs?: number;
  quietMode?: boolean;
}

export interface AoiAutonomyProposalCounts {
  active: number;
  dismissed: number;
  snoozed: number;
  blocked: number;
}

export interface AoiAutonomyPanelSettings {
  panelExpanded: boolean;
  notificationsEnabled: boolean;
  quietMode: boolean;
  maxSuggestionsPerSession: number;
}

export interface AoiAutonomyNotificationBadge {
  visible: boolean;
  label: string;
  reason: 'goal_proposal' | 'background_event' | 'blocked_action';
}

export interface AoiProposalInspectorSummary {
  title: string;
  reason: string;
  confidence: number;
  risk: AoiAutonomyRisk;
  requiredAutonomyLevel: AoiAutonomyLevel;
  suggestedAction: string;
  policyAllowed: boolean;
  policyReasons: string[];
  evidenceRefs: string[];
  safeAlternative: string;
}

export interface AoiMissionPanelSummary {
  visible: boolean;
  statusLabel: string;
  waitingOnLabel: string;
  focusSummary: string;
  nextActionLabel: string;
  nextActionReason: string;
  evidenceCount: number;
  evidenceRefs: string[];
  canPause: boolean;
  canResume: boolean;
  canClear: boolean;
}

export const DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS: AoiAutonomyPanelSettings = {
  panelExpanded: true,
  notificationsEnabled: false,
  quietMode: false,
  maxSuggestionsPerSession: AOI_INLINE_SUGGESTION_MAX_PER_SESSION,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function levelOrder(level: AoiAutonomyLevel): number {
  return AOI_AUTONOMY_LEVEL_ORDER[level] ?? 0;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeMaxSuggestions(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.round(clamp(value, 0, 12));
}

export function normalizeAoiAutonomyPanelSettings(
  value: unknown,
  fallback: AoiAutonomyPanelSettings = DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS,
): AoiAutonomyPanelSettings {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomyPanelSettings>)
      : {};

  return {
    panelExpanded: normalizeBoolean(raw.panelExpanded, fallback.panelExpanded),
    notificationsEnabled: normalizeBoolean(raw.notificationsEnabled, fallback.notificationsEnabled),
    quietMode: normalizeBoolean(raw.quietMode, fallback.quietMode),
    maxSuggestionsPerSession: normalizeMaxSuggestions(
      raw.maxSuggestionsPerSession,
      fallback.maxSuggestionsPerSession,
    ),
  };
}

export function loadAoiAutonomyPanelSettings(
  storage?: Pick<Storage, 'getItem'> | null,
): AoiAutonomyPanelSettings {
  const resolvedStorage =
    storage ??
    (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined);
  if (!resolvedStorage) {
    return DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  }
  try {
    return normalizeAoiAutonomyPanelSettings(
      JSON.parse(resolvedStorage.getItem(AOI_AUTONOMY_PANEL_SETTINGS_KEY) || 'null') as unknown,
    );
  } catch {
    return DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  }
}

export function saveAoiAutonomyPanelSettings(
  settings: AoiAutonomyPanelSettings,
  storage?: Pick<Storage, 'setItem'> | null,
): AoiAutonomyPanelSettings {
  const normalized = normalizeAoiAutonomyPanelSettings(settings);
  const resolvedStorage =
    storage ??
    (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined);
  if (!resolvedStorage) {
    return normalized;
  }
  try {
    resolvedStorage.setItem(AOI_AUTONOMY_PANEL_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // Persistence is best-effort.
  }
  return normalized;
}

export function sanitizeAoiProposalDisplayText(value: string, maxLength = 520): string {
  const withoutPrivatePaths = value
    .replace(WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(UNIX_PRIVATE_PATH_PATTERN, '[local path]');
  const compact = withoutPrivatePaths.replace(/\s+/g, ' ').trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function rankAoiProposal(
  proposal: AoiProposal,
  policy: AoiAutonomyPolicy = DEFAULT_AOI_AUTONOMY_POLICY,
): number {
  const confidenceScore = clamp(proposal.confidence, 0, 1);
  const evidenceScore = clamp(proposal.evidenceRefs.length, 0, 6) * 0.025;
  const toolScore = clamp(proposal.suggestedTools.length, 0, 4) * 0.01;
  const requiredLevelPenalty =
    Math.max(0, levelOrder(proposal.requiredAutonomyLevel) - levelOrder(policy.level)) * 0.08;
  const approvalPenalty = proposal.requiresUserApproval ? 0.01 : 0;

  return (
    confidenceScore +
    RISK_SCORE[proposal.risk] +
    evidenceScore +
    toolScore -
    requiredLevelPenalty -
    approvalPenalty
  );
}

export function canShowAoiProposalPrimaryAction(proposal: AoiProposal, now = Date.now()): boolean {
  if (proposal.status !== 'active') {
    return false;
  }
  if (proposal.blockedReason) {
    return false;
  }
  if (proposal.expiresAt && proposal.expiresAt <= now) {
    return false;
  }
  if (proposal.snoozedUntil && proposal.snoozedUntil > now) {
    return false;
  }
  return true;
}

export function isAoiProposalInlineEligible(
  proposal: AoiProposal,
  options: Pick<
    AoiInlineProposalSelectionOptions,
    'now' | 'dismissedProposalIds' | 'snoozedProposalIds'
  > = {},
): boolean {
  const now = options.now ?? Date.now();
  if (!canShowAoiProposalPrimaryAction(proposal, now)) {
    return false;
  }
  if (options.dismissedProposalIds?.has(proposal.id)) {
    return false;
  }
  if (options.snoozedProposalIds?.has(proposal.id)) {
    return false;
  }
  return true;
}

export function selectAoiInlineProposal(
  proposals: AoiProposal[],
  policy: AoiAutonomyPolicy | null | undefined,
  options: AoiInlineProposalSelectionOptions = {},
): AoiProposal | null {
  const resolvedPolicy = policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  if (options.quietMode) {
    return null;
  }
  if (!resolvedPolicy.enabled || !resolvedPolicy.proactiveSuggestionsEnabled) {
    return null;
  }

  const now = options.now ?? Date.now();
  const maxPerSession = options.maxPerSession ?? AOI_INLINE_SUGGESTION_MAX_PER_SESSION;
  const shownCount = options.shownCount ?? 0;
  if (shownCount >= maxPerSession) {
    return null;
  }

  const cooldownMs = options.cooldownMs ?? AOI_INLINE_SUGGESTION_COOLDOWN_MS;
  if (options.lastShownAt && now - options.lastShownAt < cooldownMs) {
    return null;
  }

  const eligible = proposals.filter((proposal) =>
    isAoiProposalInlineEligible(proposal, {
      now,
      dismissedProposalIds: options.dismissedProposalIds,
      snoozedProposalIds: options.snoozedProposalIds,
    }),
  );

  eligible.sort((left, right) => {
    const scoreDelta =
      rankAoiProposal(right, resolvedPolicy) - rankAoiProposal(left, resolvedPolicy);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return right.updatedAt - left.updatedAt;
  });

  return eligible[0] ?? null;
}

function proposalTiedToGoal(proposal: AoiProposal): boolean {
  return (
    proposal.trigger === 'goal_continuation' ||
    proposal.artifactRefs.some((ref) => ref.startsWith('goal:')) ||
    proposal.evidenceRefs.some((ref) => ref.startsWith('goal:'))
  );
}

export function buildAoiAutonomyNotificationBadge(params: {
  status?: AoiAutonomyStatus | null;
  proposals: AoiProposal[];
  blockedProposals?: AoiAutonomyBlockedProposal[];
  settings?: AoiAutonomyPanelSettings;
}): AoiAutonomyNotificationBadge | null {
  const settings = params.settings ?? DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS;
  if (settings.quietMode) {
    return null;
  }
  const goalProposalCount = params.proposals.filter(
    (proposal) =>
      proposal.status === 'active' &&
      proposal.risk !== 'high' &&
      canShowAoiProposalPrimaryAction(proposal) &&
      proposalTiedToGoal(proposal),
  ).length;
  if (goalProposalCount > 0) {
    return {
      visible: true,
      label: `${goalProposalCount} goal proposal${goalProposalCount === 1 ? '' : 's'}`,
      reason: 'goal_proposal',
    };
  }
  if ((params.blockedProposals?.length ?? 0) > 0) {
    return {
      visible: true,
      label: `${params.blockedProposals?.length ?? 0} blocked`,
      reason: 'blocked_action',
    };
  }
  if ((params.status?.proposalsCreatedInLastTick ?? 0) > 0) {
    return {
      visible: true,
      label: `${params.status?.proposalsCreatedInLastTick ?? 0} new`,
      reason: 'background_event',
    };
  }
  return null;
}

export function getAoiSafeAlternativeForReasons(
  proposal: Pick<AoiProposal, 'requiredAutonomyLevel' | 'requiresUserApproval' | 'risk'>,
  reasons: string[],
): string {
  if (reasons.some((reason) => reason.includes('kira_handoff_scope_too_broad'))) {
    return 'Narrow the Kira handoff to one accepted task with 1-3 modules and explicit non-goals.';
  }
  if (reasons.some((reason) => reason.includes('kira_handoff_requires_accepted_proposal'))) {
    return 'Accept the proposal before preparing a Kira handoff.';
  }
  if (reasons.some((reason) => reason.includes('autonomy_level_too_low'))) {
    return `Raise autonomy to ${proposal.requiredAutonomyLevel} or keep this as a proposal.`;
  }
  if (reasons.some((reason) => reason.includes('missing_fresh_acceptance'))) {
    return 'Accept the proposal again before execution.';
  }
  if (
    proposal.requiresUserApproval ||
    reasons.some((reason) => reason.includes('requires_approval'))
  ) {
    return 'Use explicit approval before continuing.';
  }
  if (proposal.risk === 'high') {
    return 'Review evidence and keep execution manual.';
  }
  if (reasons.some((reason) => reason.includes('cooldown'))) {
    return 'Wait for cooldown or run a manual check later.';
  }
  return 'Inspect the evidence and keep the action as a proposal.';
}

export function buildAoiProposalInspectorSummary(params: {
  proposal: AoiProposal;
  policy?: AoiAutonomyPolicy | null;
  activeProposals?: AoiProposal[];
  includeEvidence?: boolean;
  now?: number;
}): AoiProposalInspectorSummary {
  const policy = params.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const policyResult = checkAoiProposalPolicy({
    policy,
    proposal: params.proposal,
    activeProposals: params.activeProposals,
    now: params.now,
  });
  const suggestedAction = params.proposal.acceptAction?.kind ?? 'none';

  return {
    title: sanitizeAoiProposalDisplayText(params.proposal.title, 140),
    reason: sanitizeAoiProposalDisplayText(params.proposal.reason, 260),
    confidence: params.proposal.confidence,
    risk: params.proposal.risk,
    requiredAutonomyLevel: params.proposal.requiredAutonomyLevel,
    suggestedAction,
    policyAllowed: policyResult.allowed,
    policyReasons: policyResult.reasons,
    evidenceRefs: params.includeEvidence ? params.proposal.evidenceRefs.slice(0, 8) : [],
    safeAlternative: getAoiSafeAlternativeForReasons(params.proposal, policyResult.reasons),
  };
}

export function buildAoiMissionPanelSummary(
  mission: AoiMissionState | null | undefined,
  includeEvidence = false,
): AoiMissionPanelSummary {
  if (!mission || mission.status === 'none') {
    return {
      visible: false,
      statusLabel: 'None',
      waitingOnLabel: 'None',
      focusSummary: 'No active mission.',
      nextActionLabel: 'No immediate action.',
      nextActionReason: 'No active mission focus.',
      evidenceCount: 0,
      evidenceRefs: [],
      canPause: false,
      canResume: false,
      canClear: false,
    };
  }

  const canPause =
    mission.status === 'active' ||
    mission.status === 'waiting_on_user' ||
    mission.status === 'waiting_on_kira' ||
    mission.status === 'waiting_on_research';
  return {
    visible: true,
    statusLabel: mission.status.replace(/_/g, ' '),
    waitingOnLabel: mission.waitingOn.replace(/_/g, ' '),
    focusSummary: sanitizeAoiProposalDisplayText(mission.focusSummary, 160),
    nextActionLabel: sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.label, 160),
    nextActionReason: sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.reason, 220),
    evidenceCount: mission.evidenceRefs.length,
    evidenceRefs: includeEvidence ? mission.evidenceRefs.slice(0, 8) : [],
    canPause,
    canResume: mission.status === 'paused',
    canClear: mission.status !== 'none',
  };
}

export function buildAoiMissionResumePrompt(mission: AoiMissionState | null | undefined): string {
  if (!mission || mission.status === 'none' || mission.status === 'completed') {
    return '';
  }
  const refs = [
    mission.sourceRefs.goalRef,
    mission.sourceRefs.proposalRef,
    mission.sourceRefs.kiraWorkRef,
    mission.sourceRefs.researchRunRef,
    mission.lastMeaningfulEventRef,
  ].filter((ref): ref is string => Boolean(ref));
  const refLine = refs.length > 0 ? `- Evidence refs: ${refs.slice(0, 5).join(', ')}.` : '';
  return [
    '',
    '',
    'Aoi Mission Context:',
    `- Where we left off: ${JSON.stringify(sanitizeAoiProposalDisplayText(mission.focusSummary, 160))}.`,
    `- Status: ${mission.status}; waiting on: ${mission.waitingOn}.`,
    `- Next safe action: ${JSON.stringify(sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.label, 160))}.`,
    `- Reason: ${JSON.stringify(sanitizeAoiProposalDisplayText(mission.nextRecommendedAction.reason, 180))}.`,
    refLine,
    '- Treat this as compact context only. Do not execute tools or mutate state from this context without the current user request and normal approval gates.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function summarizeAoiAutonomyProposalCounts(
  activeProposals: AoiProposal[],
  archivedProposals: AoiProposal[],
  status?: AoiAutonomyStatus | null,
): AoiAutonomyProposalCounts {
  const allProposals = [...activeProposals, ...archivedProposals];
  return {
    active:
      status?.activeProposalCount ??
      activeProposals.filter((proposal) => proposal.status === 'active').length,
    dismissed: allProposals.filter((proposal) => proposal.status === 'dismissed').length,
    snoozed:
      status?.snoozedProposalCount ??
      allProposals.filter((proposal) => proposal.status === 'snoozed').length,
    blocked:
      status?.blockedProposalCount ??
      allProposals.filter(
        (proposal) => proposal.status === 'blocked' || Boolean(proposal.blockedReason),
      ).length,
  };
}
