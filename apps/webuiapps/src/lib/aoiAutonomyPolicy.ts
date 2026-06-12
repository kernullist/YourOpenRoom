import type {
  AoiAutonomyLevel,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiAutonomyToolPolicy,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalExecutionPolicyContext,
  AoiProposalExecutionPolicyResult,
  AoiProposalFeedbackCategory,
  AoiProposalPolicyCheckInput,
  AoiProposalPolicyCheckResult,
} from './aoiAutonomyTypes';
import {
  collectAoiKiraHandoffScopeReasons,
  getAoiKiraSafeNarrowingSuggestion,
} from './aoiKiraHandoff';

export const AOI_AUTONOMY_LEVEL_ORDER: Record<AoiAutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

export const DEFAULT_AOI_AUTONOMY_POLICY: AoiAutonomyPolicy = {
  version: 1,
  enabled: false,
  previewMode: true,
  level: 'L1',
  proactiveSuggestionsEnabled: false,
  confidenceFloor: 0.55,
  maxActiveProposals: 8,
  maxProposalsPerTick: 3,
  maxProposalsPerDay: 10,
  defaultCooldownMs: 6 * 60 * 60 * 1000,
  defaultSnoozeMs: 4 * 60 * 60 * 1000,
  duplicateCheckEnabled: true,
  cooldownCheckEnabled: true,
  requireEvidenceRefs: true,
  requireApprovalForHighRisk: true,
  updatedAt: 0,
};

const DEFAULT_BLOCKED_TOOL_POLICY: AoiAutonomyToolPolicy = {
  toolName: '*',
  maxLevel: 'L5',
  requiresApproval: true,
  blocked: true,
};

const AOI_AUTONOMY_TOOL_POLICIES: Record<string, AoiAutonomyToolPolicy> = {
  open_research_artifact: {
    toolName: 'open_research_artifact',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  get_research_status: {
    toolName: 'get_research_status',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  read_research_artifact: {
    toolName: 'read_research_artifact',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  start_research: {
    toolName: 'start_research',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  cancel_research: {
    toolName: 'cancel_research',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  workspace_search: {
    toolName: 'workspace_search',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  preview_changes: {
    toolName: 'preview_changes',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  workspace_checkpoint: {
    toolName: 'workspace_checkpoint',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  save_memory: {
    toolName: 'save_memory',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  create_kira_work: {
    toolName: 'create_kira_work',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  file_write: {
    toolName: 'file_write',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  file_patch: {
    toolName: 'file_patch',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  file_delete: {
    toolName: 'file_delete',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  run_command: {
    toolName: 'run_command',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
};

const EXECUTABLE_PROPOSAL_ACTIONS = new Set([
  'open_research_artifact',
  'read_research_artifact',
  'get_research_status',
  'start_research',
  'save_memory',
  'create_kira_work',
]);

const READ_ONLY_PROPOSAL_ACTIONS = new Set([
  'open_research_artifact',
  'read_research_artifact',
  'get_research_status',
]);

const FRESH_ACCEPTANCE_MS = 10 * 60 * 1000;
const FILESYSTEM_PATH_KEY_PATTERN = /(?:^|_)(?:path|file|dir|directory|cwd|command)(?:$|_)/i;
const WINDOWS_PATH_PATTERN = /(?:[a-zA-Z]:\\|\\\\)[^\s'"`<>|]*/;
const UNIX_PATH_PATTERN =
  /(?:^|\s)(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace|etc|root)\/|~\/|\.\.\/)/;
const WRONG_MEMORY_CONFIDENCE_PENALTY = 0.18;
const USEFUL_FEEDBACK_CONFIDENCE_BOOST = 0.04;
const MAX_USEFUL_FEEDBACK_BOOST = 0.08;
const TOO_FREQUENT_COOLDOWN_MULTIPLIER_LIMIT = 4;

export const AOI_PROPOSAL_FEEDBACK_CATEGORIES: readonly AoiProposalFeedbackCategory[] = [
  'useful',
  'not_useful',
  'wrong_memory',
  'stale',
  'too_frequent',
  'unsafe',
  'already_done',
  'needs_more_detail',
];

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function isAoiProposalFeedbackCategory(
  value: unknown,
): value is AoiProposalFeedbackCategory {
  return (
    typeof value === 'string' &&
    (AOI_PROPOSAL_FEEDBACK_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isAoiAutonomyLevel(value: unknown): value is AoiAutonomyLevel {
  return (
    value === 'L0' ||
    value === 'L1' ||
    value === 'L2' ||
    value === 'L3' ||
    value === 'L4' ||
    value === 'L5'
  );
}

export function compareAoiAutonomyLevel(a: AoiAutonomyLevel, b: AoiAutonomyLevel): number {
  return AOI_AUTONOMY_LEVEL_ORDER[a] - AOI_AUTONOMY_LEVEL_ORDER[b];
}

export function normalizeAoiAutonomyPolicy(
  value: unknown,
  fallback: AoiAutonomyPolicy = DEFAULT_AOI_AUTONOMY_POLICY,
  now = Date.now(),
): AoiAutonomyPolicy {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomyPolicy>)
      : {};
  return {
    version: 1,
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    previewMode: normalizeBoolean(raw.previewMode, fallback.previewMode),
    level: isAoiAutonomyLevel(raw.level) ? raw.level : fallback.level,
    proactiveSuggestionsEnabled: normalizeBoolean(
      raw.proactiveSuggestionsEnabled,
      fallback.proactiveSuggestionsEnabled,
    ),
    confidenceFloor: clampNumber(raw.confidenceFloor, fallback.confidenceFloor, 0, 1),
    maxActiveProposals: Math.round(
      clampNumber(raw.maxActiveProposals, fallback.maxActiveProposals, 1, 100),
    ),
    maxProposalsPerTick: Math.round(
      clampNumber(raw.maxProposalsPerTick, fallback.maxProposalsPerTick, 1, 20),
    ),
    maxProposalsPerDay: Math.round(
      clampNumber(raw.maxProposalsPerDay, fallback.maxProposalsPerDay, 1, 200),
    ),
    defaultCooldownMs: Math.round(
      clampNumber(
        raw.defaultCooldownMs,
        fallback.defaultCooldownMs,
        60_000,
        7 * 24 * 60 * 60 * 1000,
      ),
    ),
    defaultSnoozeMs: Math.round(
      clampNumber(raw.defaultSnoozeMs, fallback.defaultSnoozeMs, 60_000, 7 * 24 * 60 * 60 * 1000),
    ),
    duplicateCheckEnabled: normalizeBoolean(
      raw.duplicateCheckEnabled,
      fallback.duplicateCheckEnabled,
    ),
    cooldownCheckEnabled: normalizeBoolean(raw.cooldownCheckEnabled, fallback.cooldownCheckEnabled),
    requireEvidenceRefs: normalizeBoolean(raw.requireEvidenceRefs, fallback.requireEvidenceRefs),
    requireApprovalForHighRisk: normalizeBoolean(
      raw.requireApprovalForHighRisk,
      fallback.requireApprovalForHighRisk,
    ),
    updatedAt: now,
  };
}

export function getAoiToolAutonomyPolicy(toolName: string): AoiAutonomyToolPolicy {
  return (
    AOI_AUTONOMY_TOOL_POLICIES[toolName] ?? {
      ...DEFAULT_BLOCKED_TOOL_POLICY,
      toolName,
    }
  );
}

export function isAoiToolAllowedAtLevel(toolName: string, level: AoiAutonomyLevel): boolean {
  const policy = getAoiToolAutonomyPolicy(toolName);
  if (policy.blocked) {
    return false;
  }
  return compareAoiAutonomyLevel(level, policy.maxLevel) >= 0;
}

export function requiresAoiProposalApproval(toolName: string): boolean {
  return getAoiToolAutonomyPolicy(toolName).requiresApproval;
}

function getExecutionActionKind(proposal: AoiProposal): string {
  return typeof proposal.acceptAction?.kind === 'string' ? proposal.acceptAction.kind : '';
}

function riskRank(value: AoiAutonomyRisk): number {
  if (value === 'high') {
    return 2;
  }
  if (value === 'medium') {
    return 1;
  }
  return 0;
}

function maxRisk(a: AoiAutonomyRisk, b: AoiAutonomyRisk): AoiAutonomyRisk {
  return riskRank(a) >= riskRank(b) ? a : b;
}

function nextAutonomyLevel(level: AoiAutonomyLevel): AoiAutonomyLevel {
  const nextRank = Math.min(AOI_AUTONOMY_LEVEL_ORDER.L5, AOI_AUTONOMY_LEVEL_ORDER[level] + 1);
  return (Object.entries(AOI_AUTONOMY_LEVEL_ORDER).find(([, rank]) => rank === nextRank)?.[0] ??
    'L5') as AoiAutonomyLevel;
}

function maxAutonomyLevel(a: AoiAutonomyLevel, b: AoiAutonomyLevel): AoiAutonomyLevel {
  return compareAoiAutonomyLevel(a, b) >= 0 ? a : b;
}

function actionKindToToolName(actionKind: string): string {
  return actionKind;
}

function hasExplicitAcceptDecision(params: {
  proposal: AoiProposal;
  decisions: AoiProposalDecision[] | undefined;
  decisionId?: string;
  now: number;
  freshAcceptanceMs?: number;
  requireFresh: boolean;
}): boolean {
  if (params.proposal.status === 'accepted' && !params.requireFresh) {
    return true;
  }

  const maxAge = params.freshAcceptanceMs ?? FRESH_ACCEPTANCE_MS;
  return Boolean(
    params.decisions?.some((decision) => {
      if (decision.proposalId !== params.proposal.id || decision.action !== 'accept') {
        return false;
      }
      if (params.decisionId && decision.id !== params.decisionId) {
        return false;
      }
      if (params.requireFresh && decision.createdAt + maxAge < params.now) {
        return false;
      }
      return true;
    }),
  );
}

function valueContainsFilesystemPath(value: unknown, keyHint = ''): boolean {
  if (typeof value === 'string') {
    if (FILESYSTEM_PATH_KEY_PATTERN.test(keyHint) && value.trim()) {
      return true;
    }
    return WINDOWS_PATH_PATTERN.test(value) || UNIX_PATH_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsFilesystemPath(item, keyHint));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
      valueContainsFilesystemPath(item, key),
    );
  }
  return false;
}

export function evaluateAoiProposalExecution(
  proposal: AoiProposal,
  policy: AoiAutonomyPolicy,
  context: AoiProposalExecutionPolicyContext = {},
): AoiProposalExecutionPolicyResult {
  const now = context.now ?? Date.now();
  const reasons: string[] = [];
  const actionKind = getExecutionActionKind(proposal);
  const toolName = actionKind ? actionKindToToolName(actionKind) : undefined;
  const readOnly = actionKind ? READ_ONLY_PROPOSAL_ACTIONS.has(actionKind) : false;
  const kiraHandoff = actionKind === 'create_kira_work';
  const requiresFreshAcceptance =
    context.executionMode === 'preview'
      ? false
      : proposal.risk === 'high' || actionKind === 'start_research' || kiraHandoff || !readOnly;

  if (kiraHandoff && proposal.status !== 'accepted') {
    reasons.push('kira_handoff_requires_accepted_proposal');
  } else if (proposal.status !== 'active' && proposal.status !== 'accepted') {
    reasons.push('proposal_status_not_executable');
  }
  if (!actionKind || !EXECUTABLE_PROPOSAL_ACTIONS.has(actionKind)) {
    reasons.push(actionKind ? `unknown_action_kind:${actionKind}` : 'missing_accept_action');
  }
  if (proposal.evidenceRefs.length === 0) {
    reasons.push('missing_evidence_refs');
  }
  if (compareAoiAutonomyLevel(policy.level, proposal.requiredAutonomyLevel) < 0) {
    reasons.push('autonomy_level_too_low');
  }
  if (kiraHandoff && compareAoiAutonomyLevel(policy.level, 'L4') < 0) {
    reasons.push('kira_handoff_requires_l4');
  }
  if (
    !hasExplicitAcceptDecision({
      proposal,
      decisions: context.decisions,
      decisionId: context.decisionId,
      now,
      freshAcceptanceMs: context.freshAcceptanceMs,
      requireFresh: requiresFreshAcceptance,
    })
  ) {
    reasons.push(
      requiresFreshAcceptance ? 'missing_fresh_acceptance' : 'missing_explicit_acceptance',
    );
  }
  if (valueContainsFilesystemPath(proposal.acceptAction?.params ?? {})) {
    reasons.push('action_params_include_filesystem_path');
  }
  if (kiraHandoff) {
    reasons.push(...collectAoiKiraHandoffScopeReasons(proposal));
  }

  const toolsToCheck = new Set<string>(proposal.suggestedTools);
  if (toolName) {
    toolsToCheck.add(toolName);
  }
  toolsToCheck.forEach((name) => {
    const toolPolicy = getAoiToolAutonomyPolicy(name);
    if (toolPolicy.blocked) {
      reasons.push(`tool_blocked:${name}`);
      return;
    }
    if (!isAoiToolAllowedAtLevel(name, policy.level)) {
      reasons.push(`tool_level_too_low:${name}`);
    }
  });

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    actionKind: actionKind || undefined,
    toolName,
    requiresFreshAcceptance,
    readOnly,
    ...(kiraHandoff && reasons.length > 0
      ? { safeAlternative: getAoiKiraSafeNarrowingSuggestion() }
      : {}),
  };
}

function hasDuplicateActiveProposal(
  proposal: AoiProposal,
  activeProposals: AoiProposal[] | undefined,
): boolean {
  return Boolean(
    activeProposals?.some(
      (active) =>
        active.id !== proposal.id &&
        (active.status === 'active' ||
          active.status === 'accepted' ||
          active.status === 'snoozed') &&
        active.cooldownKey === proposal.cooldownKey,
    ),
  );
}

function hasRecentCooldownDecision(params: {
  proposal: AoiProposal;
  recentDecisions: AoiProposalDecision[] | undefined;
  now: number;
  cooldownMs: number;
}): boolean {
  return Boolean(
    params.recentDecisions?.some(
      (decision) =>
        (decision.action === 'dismiss' || decision.action === 'snooze') &&
        decision.cooldownKey === params.proposal.cooldownKey &&
        decision.createdAt + params.cooldownMs > params.now,
    ),
  );
}

function proposalMemoryRefSet(proposal: AoiProposal): Set<string> {
  const refs = new Set<string>(proposal.memoryIds);
  for (const ref of proposal.evidenceRefs) {
    if (ref.startsWith('memory:')) {
      refs.add(ref.slice('memory:'.length));
    }
  }
  return refs;
}

function decisionMemoryRefSet(decision: AoiProposalDecision): Set<string> {
  const refs = new Set<string>(decision.memoryIds ?? []);
  for (const ref of decision.evidenceRefs ?? []) {
    if (ref.startsWith('memory:')) {
      refs.add(ref.slice('memory:'.length));
    }
  }
  return refs;
}

function sharesMemoryRef(proposal: AoiProposal, decision: AoiProposalDecision): boolean {
  const proposalRefs = proposalMemoryRefSet(proposal);
  if (proposalRefs.size === 0) {
    return false;
  }
  for (const ref of decisionMemoryRefSet(decision)) {
    if (proposalRefs.has(ref)) {
      return true;
    }
  }
  return false;
}

function actionKindMatches(proposal: AoiProposal, decision: AoiProposalDecision): boolean {
  const actionKind = getExecutionActionKind(proposal);
  if (actionKind && decision.actionKind === actionKind) {
    return true;
  }
  const tools = new Set(proposal.suggestedTools);
  return Boolean(decision.suggestedTools?.some((tool) => tools.has(tool)));
}

function decisionAppliesToProposal(proposal: AoiProposal, decision: AoiProposalDecision): boolean {
  return (
    decision.cooldownKey === proposal.cooldownKey ||
    decision.proposalTrigger === proposal.trigger ||
    sharesMemoryRef(proposal, decision) ||
    actionKindMatches(proposal, decision)
  );
}

function feedbackDecisions(
  proposal: AoiProposal,
  decisions: AoiProposalDecision[] | undefined,
  category: AoiProposalFeedbackCategory,
): AoiProposalDecision[] {
  return (decisions ?? []).filter(
    (decision) =>
      decision.feedbackCategory === category && decisionAppliesToProposal(proposal, decision),
  );
}

function isRefreshProposal(proposal: AoiProposal): boolean {
  return (
    proposal.acceptAction?.kind === 'start_research' &&
    (proposal.trigger.includes('stale') ||
      proposal.cooldownKey.includes('refresh') ||
      proposal.riskSignals.includes('stale-memory'))
  );
}

export function getAoiFeedbackAdjustedCooldownMs(params: {
  proposal: AoiProposal;
  recentDecisions?: AoiProposalDecision[];
  baseCooldownMs: number;
}): number {
  const tooFrequentCount = (params.recentDecisions ?? []).filter(
    (decision) =>
      decision.feedbackCategory === 'too_frequent' &&
      decision.cooldownKey === params.proposal.cooldownKey,
  ).length;
  if (tooFrequentCount <= 0) {
    return params.baseCooldownMs;
  }
  const multiplier = Math.min(TOO_FREQUENT_COOLDOWN_MULTIPLIER_LIMIT, 1 + tooFrequentCount);
  return params.baseCooldownMs * multiplier;
}

export function getAoiProposalFeedbackPriorityBoost(
  proposal: AoiProposal,
  recentDecisions?: AoiProposalDecision[],
): number {
  const usefulCount = feedbackDecisions(proposal, recentDecisions, 'useful').length;
  if (usefulCount <= 0) {
    return 0;
  }
  return Math.min(MAX_USEFUL_FEEDBACK_BOOST, usefulCount * USEFUL_FEEDBACK_CONFIDENCE_BOOST);
}

export function applyAoiFeedbackCalibrationToProposal(
  proposal: AoiProposal,
  recentDecisions?: AoiProposalDecision[],
): AoiProposal {
  const wrongMemoryCount = feedbackDecisions(proposal, recentDecisions, 'wrong_memory').filter(
    (decision) => sharesMemoryRef(proposal, decision),
  ).length;
  const unsafeCount = feedbackDecisions(proposal, recentDecisions, 'unsafe').filter((decision) =>
    actionKindMatches(proposal, decision),
  ).length;
  const confidence = Math.min(
    1,
    Math.max(0, proposal.confidence - wrongMemoryCount * WRONG_MEMORY_CONFIDENCE_PENALTY),
  );

  if (unsafeCount <= 0) {
    return {
      ...proposal,
      confidence,
    };
  }

  return {
    ...proposal,
    confidence,
    risk: maxRisk(proposal.risk, 'medium'),
    requiredAutonomyLevel: maxAutonomyLevel(
      proposal.requiredAutonomyLevel,
      nextAutonomyLevel(proposal.requiredAutonomyLevel),
    ),
    requiresUserApproval: true,
    riskSignals: [...new Set([...proposal.riskSignals, 'unsafe-feedback'])],
  };
}

export function checkAoiProposalPolicy(
  input: AoiProposalPolicyCheckInput,
): AoiProposalPolicyCheckResult {
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const { policy } = input;
  const proposal = applyAoiFeedbackCalibrationToProposal(input.proposal, input.recentDecisions);
  const staleMemoryFeedbackApplies =
    feedbackDecisions(proposal, input.recentDecisions, 'stale').filter((decision) =>
      sharesMemoryRef(proposal, decision),
    ).length > 0;

  if (!policy.enabled && !policy.previewMode) {
    reasons.push('autonomy_disabled');
  }
  if (proposal.confidence < policy.confidenceFloor) {
    reasons.push('confidence_below_floor');
  }
  if (policy.requireEvidenceRefs && proposal.evidenceRefs.length === 0) {
    reasons.push('missing_evidence_refs');
  }
  if (policy.duplicateCheckEnabled && hasDuplicateActiveProposal(proposal, input.activeProposals)) {
    reasons.push('duplicate_active_proposal');
  }
  if (
    policy.cooldownCheckEnabled &&
    hasRecentCooldownDecision({
      proposal,
      recentDecisions: input.recentDecisions,
      now,
      cooldownMs: getAoiFeedbackAdjustedCooldownMs({
        proposal,
        recentDecisions: input.recentDecisions,
        baseCooldownMs: policy.defaultCooldownMs,
      }),
    })
  ) {
    reasons.push('cooldown_active');
  }
  if (staleMemoryFeedbackApplies && !isRefreshProposal(proposal)) {
    reasons.push('stale_memory_requires_refresh');
  }
  if (policy.maxActiveProposals > 0) {
    const activeCount =
      input.activeProposals?.filter(
        (active) =>
          active.status === 'active' || active.status === 'accepted' || active.status === 'snoozed',
      ).length ?? 0;
    if (activeCount >= policy.maxActiveProposals) {
      reasons.push('too_many_active_proposals');
    }
  }
  if (compareAoiAutonomyLevel(policy.level, proposal.requiredAutonomyLevel) < 0) {
    reasons.push('autonomy_level_too_low');
  }

  for (const toolName of proposal.suggestedTools) {
    const toolPolicy = getAoiToolAutonomyPolicy(toolName);
    if (toolPolicy.blocked) {
      reasons.push(`tool_blocked:${toolName}`);
      continue;
    }
    if (!isAoiToolAllowedAtLevel(toolName, policy.level)) {
      reasons.push(`tool_level_too_low:${toolName}`);
    }
  }

  if (
    policy.requireApprovalForHighRisk &&
    proposal.risk === 'high' &&
    !proposal.requiresUserApproval
  ) {
    reasons.push('high_risk_requires_approval');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
