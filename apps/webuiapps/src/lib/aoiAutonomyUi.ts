import { AOI_AUTONOMY_LEVEL_ORDER, DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import type {
  AoiAutonomyLevel,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiAutonomyStatus,
  AoiProposal,
} from './aoiAutonomyTypes';

export const AOI_INLINE_SUGGESTION_COOLDOWN_MS = 30 * 60 * 1000;
export const AOI_INLINE_SUGGESTION_MAX_PER_SESSION = 3;

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
}

export interface AoiAutonomyProposalCounts {
  active: number;
  dismissed: number;
  snoozed: number;
  blocked: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function levelOrder(level: AoiAutonomyLevel): number {
  return AOI_AUTONOMY_LEVEL_ORDER[level] ?? 0;
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
