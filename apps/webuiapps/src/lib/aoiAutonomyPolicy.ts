import type {
  AoiAutonomyLevel,
  AoiAutonomyPolicy,
  AoiAutonomyToolPolicy,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalPolicyCheckInput,
  AoiProposalPolicyCheckResult,
} from './aoiAutonomyTypes';

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
  file_write: {
    toolName: 'file_write',
    maxLevel: 'L5',
    requiresApproval: true,
  },
  file_patch: {
    toolName: 'file_patch',
    maxLevel: 'L5',
    requiresApproval: true,
  },
  file_delete: {
    toolName: 'file_delete',
    maxLevel: 'L5',
    requiresApproval: true,
  },
  run_command: {
    toolName: 'run_command',
    maxLevel: 'L5',
    requiresApproval: true,
  },
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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

export function checkAoiProposalPolicy(
  input: AoiProposalPolicyCheckInput,
): AoiProposalPolicyCheckResult {
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const { policy, proposal } = input;

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
      cooldownMs: policy.defaultCooldownMs,
    })
  ) {
    reasons.push('cooldown_active');
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
