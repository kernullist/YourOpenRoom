import {
  AOI_AUTONOMY_LEVEL_ORDER,
  DEFAULT_AOI_AUTONOMY_POLICY,
  checkAoiProposalPolicy,
} from './aoiAutonomyPolicy';
import type {
  AoiAutonomyVisibleState,
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
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_TOKEN_PATTERN = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_=-]{12,}/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|secret|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*['"]?[^'"\s,;]+/gi;

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
  why: string;
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

export interface AoiProactiveExplanation {
  whyNow: string;
  whatChanged: string;
  evidenceRefs: string[];
  evidenceSummary: string;
  evidenceCount: number;
  confidence: number;
  confidenceLabel: string;
  risk: AoiAutonomyRisk;
  safeNextAction: string;
  willNotDoWithoutApproval: string;
  oneLineRationale: string;
  messageSummary: string;
  approvalBoundary: string;
  details: string[];
  lowEvidence: boolean;
}

export interface AoiRecoveryPreviewSummary {
  visible: boolean;
  failureKind: string;
  rootCauseSummary: string;
  proposedActionLabel: string;
  whyNarrowerOrSafer: string;
  retryLabel: string;
  cooldownLabel: string;
  evidenceRefs: string[];
  nonGoals: string[];
}

export interface AoiMissionPanelSummary {
  visible: boolean;
  visibleState: AoiAutonomyVisibleState | null;
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
  pauseLabel: string;
  pauseTitle: string;
  resumeLabel: string;
  resumeTitle: string;
  showEvidenceLabel: string;
  showEvidenceTitle: string;
}

export interface AoiProposalActionPresentation {
  visibleState: AoiAutonomyVisibleState;
  primaryLabel: string;
  primaryTitle: string;
  primaryRole: 'approve' | 'preview' | 'execute' | 'none';
  mutationBoundary: string;
  requiresPreviewBeforeFinal: boolean;
  finalActionAvailable: boolean;
}

export interface AoiBlockedStateSummary {
  policyReasons: string[];
  missingEvidence: string[];
  safeAlternative: string;
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
    .replace(PRIVATE_KEY_BLOCK_PATTERN, '[private secret]')
    .replace(SECRET_TOKEN_PATTERN, '[private secret]')
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[private secret]`)
    .replace(WINDOWS_PRIVATE_PATH_PATTERN, '[local path]')
    .replace(UNIX_PRIVATE_PATH_PATTERN, '[local path]');
  const compact = withoutPrivatePaths.replace(/\s+/g, ' ').trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function formatAoiEvidenceSummary(evidenceCount: number): string {
  if (evidenceCount <= 0) {
    return 'Limited evidence: no evidence refs are attached yet.';
  }
  return `${evidenceCount} evidence ref${evidenceCount === 1 ? '' : 's'} attached; details stay in the panel.`;
}

function getAoiConfidenceLabel(confidence: number, evidenceCount: number): string {
  if (evidenceCount <= 0 || confidence < 0.55) {
    return 'low evidence';
  }
  if (confidence < 0.7) {
    return 'moderate confidence';
  }
  return 'good confidence';
}

function triggerLabel(trigger: string): string {
  const normalized = sanitizeAoiProposalDisplayText(trigger.replace(/[_-]+/g, ' '), 80);
  return normalized || 'background check';
}

function describeAoiProposalChange(proposal: AoiProposal, policyReasons: string[]): string {
  if (proposal.blockedReason || policyReasons.length > 0 || proposal.status === 'blocked') {
    return 'A policy or evidence gate is blocking the next step.';
  }
  if (proposal.recoveryPreview) {
    return `A narrower recovery proposal is available after ${proposal.recoveryPreview.failureKind.replace(/_/g, ' ')}.`;
  }
  if (proposal.trigger === 'attention_broker') {
    return 'A background event surfaced a proposal worth reviewing.';
  }
  if (proposal.trigger === 'kira_outcome_followup') {
    return 'Reviewed Kira work produced one follow-up note.';
  }
  if (proposal.trigger === 'goal_continuation') {
    return 'The active goal has a proposed next step.';
  }
  if (proposal.evidenceRefs.length <= 0) {
    return 'A proposal exists, but supporting evidence is incomplete.';
  }
  return `A ${triggerLabel(proposal.trigger)} proposal is ready for review.`;
}

function getAoiApprovalBoundary(
  proposal: AoiProposal,
  action: AoiProposalActionPresentation,
): string {
  if (proposal.acceptAction?.kind === 'create_kira_work') {
    return 'I will not edit files directly; approval only creates one reviewed Kira work item.';
  }
  if (proposal.acceptAction?.kind === 'start_research') {
    return 'I will not start a research run without explicit approval.';
  }
  if (proposal.acceptAction?.kind === 'save_memory') {
    return 'I will not promote memory or create a skill draft without explicit approval.';
  }
  if (proposal.risk === 'high') {
    return 'High-risk work needs fresh explicit approval before any action.';
  }
  if (proposal.requiresUserApproval || proposal.acceptAction) {
    return 'I will not run tools or change state without explicit approval.';
  }
  if (action.primaryRole === 'none') {
    return 'This explanation does not run tools or change state.';
  }
  return action.mutationBoundary;
}

export function buildAoiProactiveExplanation(params: {
  proposal: AoiProposal;
  policy?: AoiAutonomyPolicy | null;
  activeProposals?: AoiProposal[];
  includeEvidence?: boolean;
  hasKiraPreview?: boolean;
  now?: number;
}): AoiProactiveExplanation {
  const policy = params.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const policyResult = checkAoiProposalPolicy({
    policy,
    proposal: params.proposal,
    activeProposals: params.activeProposals,
    now: params.now,
  });
  const action = buildAoiProposalActionPresentation(params.proposal, {
    hasKiraPreview: params.hasKiraPreview,
  });
  const evidenceCount = params.proposal.evidenceRefs.length;
  const lowEvidence = evidenceCount <= 0 || params.proposal.confidence < 0.55;
  const reason = sanitizeAoiProposalDisplayText(params.proposal.reason, 180);
  const whyNow = lowEvidence
    ? `Limited evidence: ${reason || 'this should stay as a suggestion.'}`
    : reason;
  const whatChanged = sanitizeAoiProposalDisplayText(
    describeAoiProposalChange(params.proposal, policyResult.reasons),
    180,
  );
  const safeNextAction = sanitizeAoiProposalDisplayText(action.primaryLabel, 120);
  const approvalBoundary = sanitizeAoiProposalDisplayText(
    getAoiApprovalBoundary(params.proposal, action),
    180,
  );
  const evidenceSummary = formatAoiEvidenceSummary(evidenceCount);
  const confidenceLabel = getAoiConfidenceLabel(params.proposal.confidence, evidenceCount);
  const oneLineRationale = sanitizeAoiProposalDisplayText(
    lowEvidence ? `Low evidence, review first: ${reason || whatChanged}` : reason || whatChanged,
    180,
  );
  const details = [
    `Body: ${params.proposal.body}`,
    `Reason: ${params.proposal.reason}`,
    `Policy: ${policyResult.allowed ? 'allowed' : 'blocked'}`,
    policyResult.reasons.length > 0 ? `Policy reasons: ${policyResult.reasons.join(' / ')}` : '',
    `Trigger: ${params.proposal.trigger}`,
    `Cooldown: ${params.proposal.cooldownKey}`,
  ]
    .filter(Boolean)
    .map((item) => sanitizeAoiProposalDisplayText(item, 260));
  const messageSummary = sanitizeAoiProposalDisplayText(
    [
      `Why now: ${whyNow}`,
      `Changed: ${whatChanged}`,
      `Evidence: ${evidenceSummary}`,
      `Next: ${safeNextAction}`,
      `Boundary: ${approvalBoundary}`,
    ].join(' '),
    520,
  );

  return {
    whyNow,
    whatChanged,
    evidenceRefs: params.includeEvidence
      ? params.proposal.evidenceRefs
          .slice(0, 8)
          .map((ref) => sanitizeAoiProposalDisplayText(ref, 220))
      : [],
    evidenceSummary,
    evidenceCount,
    confidence: params.proposal.confidence,
    confidenceLabel,
    risk: params.proposal.risk,
    safeNextAction,
    willNotDoWithoutApproval: approvalBoundary,
    oneLineRationale,
    messageSummary,
    approvalBoundary,
    details,
    lowEvidence,
  };
}

export function buildAoiBlockedProactiveExplanation(params: {
  blockedProposal: AoiAutonomyBlockedProposal;
  includeEvidence?: boolean;
}): AoiProactiveExplanation {
  const blockedSummary = buildAoiBlockedStateSummary({
    blockedProposal: params.blockedProposal,
  });
  const evidenceCount = params.blockedProposal.evidenceRefs.length;
  const whyNow = blockedSummary.policyReasons[0] ?? 'A background proposal was blocked by policy.';
  const whatChanged = 'A policy or evidence gate stopped the proposal before execution.';
  const safeNextAction = blockedSummary.safeAlternative;
  const approvalBoundary = 'No tools run from a blocked proposal; resolve the policy gate first.';
  const evidenceSummary = formatAoiEvidenceSummary(evidenceCount);
  const details = [
    ...blockedSummary.policyReasons.map((reason) => `Policy reason: ${reason}`),
    ...blockedSummary.missingEvidence.map((item) => `Missing evidence: ${item}`),
    `Safe alternative: ${blockedSummary.safeAlternative}`,
  ].map((item) => sanitizeAoiProposalDisplayText(item, 260));
  const messageSummary = sanitizeAoiProposalDisplayText(
    [
      `Why now: ${whyNow}`,
      `Changed: ${whatChanged}`,
      `Evidence: ${evidenceSummary}`,
      `Next: ${safeNextAction}`,
      `Boundary: ${approvalBoundary}`,
    ].join(' '),
    520,
  );

  return {
    whyNow: sanitizeAoiProposalDisplayText(whyNow, 180),
    whatChanged,
    evidenceRefs: params.includeEvidence
      ? params.blockedProposal.evidenceRefs
          .slice(0, 8)
          .map((ref) => sanitizeAoiProposalDisplayText(ref, 220))
      : [],
    evidenceSummary,
    evidenceCount,
    confidence: 0,
    confidenceLabel: evidenceCount > 0 ? 'blocked by policy' : 'blocked with limited evidence',
    risk: params.blockedProposal.risk ?? 'medium',
    safeNextAction,
    willNotDoWithoutApproval: approvalBoundary,
    oneLineRationale: sanitizeAoiProposalDisplayText(whyNow, 180),
    messageSummary,
    approvalBoundary,
    details,
    lowEvidence: evidenceCount <= 0,
  };
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
    const topGoalProposal = params.proposals.find(
      (proposal) =>
        proposal.status === 'active' &&
        proposal.risk !== 'high' &&
        canShowAoiProposalPrimaryAction(proposal) &&
        proposalTiedToGoal(proposal),
    );
    return {
      visible: true,
      label: `${goalProposalCount} goal proposal${goalProposalCount === 1 ? '' : 's'}`,
      why: topGoalProposal
        ? sanitizeAoiProposalDisplayText(topGoalProposal.reason, 180)
        : 'A goal-linked proposal has a safe next step.',
      reason: 'goal_proposal',
    };
  }
  if ((params.blockedProposals?.length ?? 0) > 0) {
    return {
      visible: true,
      label: `${params.blockedProposals?.length ?? 0} blocked`,
      why: sanitizeAoiProposalDisplayText(
        params.blockedProposals?.[0]?.safeAlternative ||
          params.blockedProposals?.[0]?.reasons.join(' / ') ||
          'A background action was blocked by policy.',
        180,
      ),
      reason: 'blocked_action',
    };
  }
  if ((params.status?.proposalsCreatedInLastTick ?? 0) > 0) {
    const attentionProposal = params.proposals.find(
      (proposal) => proposal.trigger === 'attention_broker',
    );
    return {
      visible: true,
      label: attentionProposal
        ? `${params.status?.proposalsCreatedInLastTick ?? 0} attention update`
        : `${params.status?.proposalsCreatedInLastTick ?? 0} new`,
      why: attentionProposal
        ? sanitizeAoiProposalDisplayText(attentionProposal.reason, 180)
        : 'A background check created a new proposal.',
      reason: 'background_event',
    };
  }
  if ((params.status?.recentObservationCount ?? 0) > 0) {
    return {
      visible: true,
      label: `${params.status?.recentObservationCount ?? 0} event${
        params.status?.recentObservationCount === 1 ? '' : 's'
      }`,
      why: 'Background events were recorded silently; open details for evidence.',
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

function getAoiMissingEvidenceLabels(reasons: string[], evidenceCount?: number): string[] {
  const labels: string[] = [];
  const add = (label: string) => {
    if (!labels.includes(label)) {
      labels.push(label);
    }
  };

  if (reasons.some((reason) => reason.includes('missing_evidence_refs'))) {
    add('Evidence refs are missing.');
  }
  if (reasons.some((reason) => reason.includes('missing_fresh_acceptance'))) {
    add('Fresh explicit acceptance is missing.');
  }
  if (reasons.some((reason) => reason.includes('kira_handoff_requires_accepted_proposal'))) {
    add('An accepted proposal is required before Kira handoff.');
  }
  if (typeof evidenceCount === 'number' && evidenceCount === 0 && reasons.length > 0) {
    add('No evidence refs are attached to this blocked action.');
  }

  return labels;
}

export function buildAoiBlockedStateSummary(params: {
  proposal?: Pick<
    AoiProposal,
    'requiredAutonomyLevel' | 'requiresUserApproval' | 'risk' | 'evidenceRefs' | 'blockedReason'
  > | null;
  blockedProposal?: Pick<
    AoiAutonomyBlockedProposal,
    | 'reasons'
    | 'evidenceRefs'
    | 'safeAlternative'
    | 'requiredAutonomyLevel'
    | 'requiresUserApproval'
    | 'risk'
  > | null;
  reasons?: string[];
}): AoiBlockedStateSummary {
  const rawReasons =
    params.reasons ??
    params.blockedProposal?.reasons ??
    (params.proposal?.blockedReason ? [params.proposal.blockedReason] : []);
  const policyReasons = rawReasons.map((reason) => sanitizeAoiProposalDisplayText(reason, 180));
  const proposalForAlternative = params.proposal ?? {
    requiredAutonomyLevel: params.blockedProposal?.requiredAutonomyLevel ?? 'L1',
    requiresUserApproval: params.blockedProposal?.requiresUserApproval ?? true,
    risk: params.blockedProposal?.risk ?? 'medium',
  };
  const evidenceCount =
    params.proposal?.evidenceRefs.length ?? params.blockedProposal?.evidenceRefs.length;

  return {
    policyReasons,
    missingEvidence: getAoiMissingEvidenceLabels(rawReasons, evidenceCount),
    safeAlternative: sanitizeAoiProposalDisplayText(
      params.blockedProposal?.safeAlternative ??
        getAoiSafeAlternativeForReasons(proposalForAlternative, rawReasons),
      220,
    ),
  };
}

function getAoiMissionVisibleState(
  mission: AoiMissionState | null | undefined,
): AoiAutonomyVisibleState | null {
  if (!mission || mission.status === 'none') {
    return null;
  }
  if (mission.status === 'paused') {
    return 'paused';
  }
  if (mission.status === 'blocked') {
    return 'blocked';
  }
  if (mission.status === 'completed') {
    return 'completed';
  }
  if (mission.status === 'waiting_on_kira' || mission.sourceRefs.kiraWorkRef) {
    return 'delegated_to_kira';
  }
  if (mission.status === 'waiting_on_research') {
    return 'waiting_on_research';
  }
  if (mission.status === 'waiting_on_user') {
    return 'waiting_on_user';
  }
  return 'waiting_for_approval';
}

export function buildAoiProposalActionPresentation(
  proposal: AoiProposal,
  options: { hasKiraPreview?: boolean } = {},
): AoiProposalActionPresentation {
  const kind = proposal.acceptAction?.kind;
  if (proposal.status === 'blocked' || proposal.blockedReason) {
    return {
      visibleState: 'blocked',
      primaryLabel: 'Show evidence',
      primaryTitle: 'Show policy reasons, missing evidence, and a safe alternative.',
      primaryRole: 'none',
      mutationBoundary: 'No mutation is available while this proposal is blocked.',
      requiresPreviewBeforeFinal: kind === 'create_kira_work',
      finalActionAvailable: false,
    };
  }

  if (proposal.status === 'executed') {
    return {
      visibleState: kind === 'create_kira_work' ? 'delegated_to_kira' : 'completed',
      primaryLabel: 'Show evidence',
      primaryTitle: 'Show evidence for the completed action.',
      primaryRole: 'none',
      mutationBoundary: 'No additional mutation is available from this completed proposal.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: false,
    };
  }

  if (proposal.status === 'active') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve exact action',
      primaryTitle:
        'Record approval for this exact proposal. No tools run and no files are edited.',
      primaryRole: 'approve',
      mutationBoundary: 'Records approval only. It does not run tools or edit files.',
      requiresPreviewBeforeFinal: kind === 'create_kira_work',
      finalActionAvailable: false,
    };
  }

  if (proposal.status !== 'accepted') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Show evidence',
      primaryTitle: `No primary action is available while status is ${proposal.status}.`,
      primaryRole: 'none',
      mutationBoundary: 'No mutation is available for this proposal state.',
      requiresPreviewBeforeFinal: kind === 'create_kira_work',
      finalActionAvailable: false,
    };
  }

  if (kind === 'create_kira_work') {
    if (!options.hasKiraPreview) {
      return {
        visibleState: 'preview_ready',
        primaryLabel: 'Preview plan',
        primaryTitle:
          'Preview the Kira work item plan. This does not create work items or edit files.',
        primaryRole: 'preview',
        mutationBoundary: 'No mutation. It only previews the Kira work item plan.',
        requiresPreviewBeforeFinal: true,
        finalActionAvailable: false,
      };
    }

    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and create Kira work item',
      primaryTitle: 'Approve and create a reviewed Kira work item. This does not edit files.',
      primaryRole: 'execute',
      mutationBoundary: 'Creates one reviewed Kira work item only. It does not edit files.',
      requiresPreviewBeforeFinal: true,
      finalActionAvailable: true,
    };
  }

  if (kind === 'start_research') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and start research run',
      primaryTitle: 'Approve and start a new Aoi research run.',
      primaryRole: 'execute',
      mutationBoundary: 'Starts one Aoi research run.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'save_memory') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Approve and promote memory',
      primaryTitle:
        'Approve memory promotion. This may promote memory or create an untrusted skill draft.',
      primaryRole: 'execute',
      mutationBoundary: 'Promotes memory or creates an untrusted skill draft.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'get_research_status') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Check research status',
      primaryTitle: 'Check linked research status without editing files.',
      primaryRole: 'execute',
      mutationBoundary: 'Reads research status only.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'open_research_artifact') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Open research artifact',
      primaryTitle: 'Open the approved research artifact without editing files.',
      primaryRole: 'execute',
      mutationBoundary: 'Opens an existing research artifact only.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'read_research_artifact') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Read research artifact',
      primaryTitle: 'Read the approved research artifact without editing files.',
      primaryRole: 'execute',
      mutationBoundary: 'Reads an existing research artifact only.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: true,
    };
  }

  if (kind === 'open_app') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Review app handoff',
      primaryTitle: 'Review the approved app handoff. No direct app launch is available here.',
      primaryRole: 'none',
      mutationBoundary: 'No app is opened from this proposal card.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: false,
    };
  }

  if (kind === 'activate_goal') {
    return {
      visibleState: 'waiting_for_approval',
      primaryLabel: 'Review goal activation',
      primaryTitle: 'Review the approved goal activation. Use goal controls to mutate goal state.',
      primaryRole: 'none',
      mutationBoundary: 'No goal state changes from this proposal card.',
      requiresPreviewBeforeFinal: false,
      finalActionAvailable: false,
    };
  }

  return {
    visibleState: 'waiting_for_approval',
    primaryLabel: 'Review action',
    primaryTitle: 'Review the proposal details before any further action.',
    primaryRole: 'none',
    mutationBoundary: 'No direct mutation is available for this proposal action.',
    requiresPreviewBeforeFinal: false,
    finalActionAvailable: false,
  };
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

export function buildAoiRecoveryPreviewSummary(
  proposal: AoiProposal,
  includeEvidence = false,
): AoiRecoveryPreviewSummary {
  const preview = proposal.recoveryPreview;
  if (!preview) {
    return {
      visible: false,
      failureKind: '',
      rootCauseSummary: '',
      proposedActionLabel: '',
      whyNarrowerOrSafer: '',
      retryLabel: '',
      cooldownLabel: '',
      evidenceRefs: [],
      nonGoals: [],
    };
  }

  const cooldownLabel = preview.cooldownActive
    ? `cooldown active${preview.cooldownUntil ? ` until ${new Date(preview.cooldownUntil).toISOString()}` : ''}`
    : 'cooldown clear';
  return {
    visible: true,
    failureKind: sanitizeAoiProposalDisplayText(preview.failureKind.replace(/_/g, ' '), 80),
    rootCauseSummary: sanitizeAoiProposalDisplayText(preview.rootCauseSummary, 260),
    proposedActionLabel: sanitizeAoiProposalDisplayText(preview.proposedAction.label, 140),
    whyNarrowerOrSafer: sanitizeAoiProposalDisplayText(preview.whyNarrowerOrSafer, 220),
    retryLabel: `${preview.retryCount}/${preview.maxRetryCount} retries used`,
    cooldownLabel: sanitizeAoiProposalDisplayText(cooldownLabel, 120),
    evidenceRefs: includeEvidence ? preview.evidenceRefs.slice(0, 8) : [],
    nonGoals: preview.nonGoals.slice(0, 4).map((item) => sanitizeAoiProposalDisplayText(item, 180)),
  };
}

export function buildAoiMissionPanelSummary(
  mission: AoiMissionState | null | undefined,
  includeEvidence = false,
): AoiMissionPanelSummary {
  if (!mission || mission.status === 'none') {
    return {
      visible: false,
      visibleState: null,
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
      pauseLabel: 'Pause this goal',
      pauseTitle: 'Pause this goal without deleting evidence.',
      resumeLabel: 'Resume',
      resumeTitle: 'Resume this goal from its saved mission state.',
      showEvidenceLabel: 'Show evidence',
      showEvidenceTitle: 'Show mission evidence and source references.',
    };
  }

  const canPause =
    mission.status === 'active' ||
    mission.status === 'waiting_on_user' ||
    mission.status === 'waiting_on_kira' ||
    mission.status === 'waiting_on_research';
  return {
    visible: true,
    visibleState: getAoiMissionVisibleState(mission),
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
    pauseLabel: 'Pause this goal',
    pauseTitle: 'Pause this goal while keeping evidence and source references.',
    resumeLabel: 'Resume',
    resumeTitle: 'Resume this goal from its saved mission state.',
    showEvidenceLabel: 'Show evidence',
    showEvidenceTitle: 'Show mission evidence and source references.',
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
