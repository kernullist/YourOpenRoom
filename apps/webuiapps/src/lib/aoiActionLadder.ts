import { DEFAULT_AOI_AUTONOMY_POLICY, evaluateAoiProposalExecution } from './aoiAutonomyPolicy';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import type { AoiBoundedWorkOrder } from './aoiBoundedWorkOrder';
import {
  canAoiJarvisAutonomyUseCapability,
  type AoiJarvisAutonomyCapability,
  type AoiJarvisAutonomyGovernorDecision,
} from './aoiJarvisAutonomyGovernor';
import { buildAoiPreparedActionPlan } from './aoiSafeActionPlan';
import type {
  AoiActionLadderAction,
  AoiActionLadderApprovalNeed,
  AoiActionLadderBlockedAction,
  AoiActionLadderDecision,
  AoiActionLadderExistingGate,
  AoiActionLadderLevel,
  AoiApprovalInboxItem,
  AoiApprovedCommandPolicy,
  AoiAutonomyBlockedProposal,
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiFollowThroughLearningSummary,
  AoiOpportunity,
  AoiPreparedActionPlan,
  AoiProposal,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
} from './aoiAutonomyTypes';
import { hasAoiFollowThroughUnsafeSignal } from './aoiFollowThroughLearning';

const LEVEL_ORDER: Record<AoiActionLadderLevel, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

const LEVEL_LABELS: Record<AoiActionLadderLevel, string> = {
  L1: 'L1 observe',
  L2: 'L2 brief',
  L3: 'L3 research gate',
  L4: 'L4 prepare only',
  L5: 'L5 execute after approval',
};

export interface AoiActionLadderInput {
  sessionPath: string;
  opportunity: AoiOpportunity;
  deliberationRun?: AoiDeliberationRun | null;
  jarvisGovernor?: AoiJarvisAutonomyGovernorDecision | null;
  policy?: AoiAutonomyPolicy | null;
  activeProposals?: readonly AoiProposal[];
  blockedProposals?: readonly AoiAutonomyBlockedProposal[];
  approvalInbox?: readonly AoiApprovalInboxItem[];
  proposalDecisions?: readonly AoiProposalDecision[];
  boundedWorkOrders?: readonly AoiBoundedWorkOrder[];
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
  now?: number;
}

export interface AoiActionLadderBatchInput extends Omit<
  AoiActionLadderInput,
  'opportunity' | 'deliberationRun'
> {
  opportunities: readonly AoiOpportunity[];
  deliberationRuns?: readonly AoiDeliberationRun[];
}

function sanitizeText(value: unknown, fallback = '', maxChars = 220): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const safe = normalized || fallback;
  return safe.length > maxChars ? `${safe.slice(0, maxChars - 3).trimEnd()}...` : safe;
}

function uniqueStrings(values: Array<string | undefined | null>, limit = 24): string[] {
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

function highestLevel(levels: readonly AoiActionLadderLevel[]): AoiActionLadderLevel {
  return levels.reduce(
    (best, level) => (LEVEL_ORDER[level] > LEVEL_ORDER[best] ? level : best),
    'L1',
  );
}

function nextLevelAfter(level: AoiActionLadderLevel): AoiActionLadderLevel | undefined {
  if (level === 'L1') {
    return 'L2';
  }
  if (level === 'L2') {
    return 'L3';
  }
  if (level === 'L3') {
    return 'L4';
  }
  if (level === 'L4') {
    return 'L5';
  }
  return undefined;
}

function makeAction(params: {
  level: AoiActionLadderLevel;
  kind: string;
  label: string;
  existingGate: AoiActionLadderExistingGate;
  evidenceRefs?: string[];
}): AoiActionLadderAction {
  return {
    version: 1,
    level: params.level,
    kind: params.kind,
    label: sanitizeText(params.label, 'Allowed action is unspecified.'),
    existingGate: params.existingGate,
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? [], 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeBlockedAction(params: {
  level: AoiActionLadderLevel;
  kind: string;
  label: string;
  reason: string;
  existingGate: AoiActionLadderExistingGate;
  evidenceRefs?: string[];
}): AoiActionLadderBlockedAction {
  return {
    version: 1,
    level: params.level,
    kind: params.kind,
    label: sanitizeText(params.label, 'Blocked action is unspecified.'),
    reason: sanitizeText(params.reason, 'Existing gate blocks this level.'),
    existingGate: params.existingGate,
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? [], 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeApprovalNeed(params: {
  level: AoiActionLadderLevel;
  label: string;
  requiredAutonomyLevel?: AoiActionLadderApprovalNeed['requiredAutonomyLevel'];
  approvalRef?: string;
  approvalFingerprint?: string;
  reason: string;
  satisfied?: boolean;
  evidenceRefs?: string[];
}): AoiActionLadderApprovalNeed {
  return {
    version: 1,
    level: params.level,
    label: sanitizeText(params.label, 'Approval need is unspecified.'),
    ...(params.requiredAutonomyLevel
      ? { requiredAutonomyLevel: params.requiredAutonomyLevel }
      : {}),
    ...(params.approvalRef ? { approvalRef: params.approvalRef } : {}),
    ...(params.approvalFingerprint ? { approvalFingerprint: params.approvalFingerprint } : {}),
    reason: sanitizeText(params.reason, 'Existing approval gate must be satisfied.'),
    satisfied: params.satisfied === true,
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? [], 12),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function opportunityRefs(opportunity: AoiOpportunity): Set<string> {
  return new Set([
    opportunity.id,
    `opportunity:${opportunity.id}`,
    opportunity.dedupeKey,
    ...opportunity.evidenceRefs,
  ]);
}

function overlapCount(left: ReadonlySet<string>, right: readonly string[]): number {
  return right.reduce((count, item) => count + (left.has(item) ? 1 : 0), 0);
}

function scoreProposalForOpportunity(opportunity: AoiOpportunity, proposal: AoiProposal): number {
  const refs = opportunityRefs(opportunity);
  let score = 0;
  score += overlapCount(refs, proposal.evidenceRefs) * 4;
  score += overlapCount(refs, proposal.artifactRefs) * 4;
  if (proposal.cooldownKey === opportunity.dedupeKey) {
    score += 6;
  }
  if (proposal.title.toLowerCase().includes(opportunity.title.toLowerCase().slice(0, 24))) {
    score += 2;
  }
  if (proposal.body.toLowerCase().includes(opportunity.dedupeKey.toLowerCase())) {
    score += 2;
  }
  return score;
}

function findMatchingProposal(
  opportunity: AoiOpportunity,
  proposals: readonly AoiProposal[] | undefined,
): AoiProposal | null {
  return (
    (proposals ?? [])
      .map((proposal) => ({
        proposal,
        score: scoreProposalForOpportunity(opportunity, proposal),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.proposal.updatedAt - left.proposal.updatedAt,
      )[0]?.proposal ?? null
  );
}

function findMatchingBlockedProposal(
  opportunity: AoiOpportunity,
  blockedProposals: readonly AoiAutonomyBlockedProposal[] | undefined,
): AoiAutonomyBlockedProposal | null {
  const refs = opportunityRefs(opportunity);
  return (
    (blockedProposals ?? [])
      .map((proposal) => ({
        proposal,
        score:
          overlapCount(refs, proposal.evidenceRefs) * 4 +
          (proposal.dedupeKey === opportunity.dedupeKey ? 6 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.proposal ?? null
  );
}

function findApprovalInboxItem(
  proposal: AoiProposal | null,
  approvalInbox: readonly AoiApprovalInboxItem[] | undefined,
): AoiApprovalInboxItem | null {
  if (!proposal) {
    return null;
  }
  return approvalInbox?.find((item) => item.proposalId === proposal.id) ?? null;
}

function findMatchingWorkOrder(
  opportunity: AoiOpportunity,
  proposal: AoiProposal | null,
  workOrders: readonly AoiBoundedWorkOrder[] | undefined,
): AoiBoundedWorkOrder | null {
  const refs = opportunityRefs(opportunity);
  if (proposal) {
    refs.add(proposal.id);
    refs.add(`proposal:${proposal.id}`);
  }
  return (
    (workOrders ?? [])
      .map((order) => ({
        order,
        score: overlapCount(refs, order.evidenceRefs) * 4 + (refs.has(order.origin.ref) ? 6 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) => right.score - left.score || right.order.updatedAt - left.order.updatedAt,
      )[0]?.order ?? null
  );
}

function getStringParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildApprovedCommandPolicyForProposal(
  proposal: AoiProposal | null,
  now: number,
): AoiApprovedCommandPolicy | null {
  if (proposal?.acceptAction?.kind !== 'run_command') {
    return null;
  }
  const params = proposal.acceptAction.params;
  const request = createAoiApprovedCommandRequest({
    sessionPath: proposal.sessionPath,
    proposalId: proposal.id,
    command: getStringParam(params, 'command'),
    cwd: getStringParam(params, 'cwd') || getStringParam(params, 'directory') || '.',
    purpose: getStringParam(params, 'purpose') || proposal.title,
    risk: proposal.risk,
    timeoutMs: params.timeoutMs ?? params.timeout_ms,
    requestedAt: now,
    evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
  });
  return evaluateAoiApprovedCommandPolicy(request);
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

function hasBriefEvidence(
  opportunity: AoiOpportunity,
  run: AoiDeliberationRun | null | undefined,
): boolean {
  return opportunity.evidenceRefs.length > 0 || Boolean(run?.finding?.evidenceRefs.length);
}

function hasFreshDeliberation(run: AoiDeliberationRun | null | undefined): boolean {
  return Boolean(
    run &&
    run.phase === 'ready' &&
    run.finding &&
    run.finding.sourceQuality !== 'missing' &&
    run.finding.freshness !== 'stale' &&
    run.finding.freshness !== 'failed' &&
    run.finding.evidenceRefs.length > 0,
  );
}

function opportunityWantsResearch(
  opportunity: AoiOpportunity,
  run: AoiDeliberationRun | null | undefined,
): boolean {
  const haystack = [
    opportunity.sourceKind,
    opportunity.curiosityQuestion,
    opportunity.evidenceNeed,
    opportunity.suggestedNextAction,
    run?.safeNextAction,
  ]
    .join(' ')
    .toLowerCase();
  return /\b(?:research|source|verify|fresh|investigate|check|scan|trend)\b/.test(haystack);
}

function actionKindUsesResearch(kind: AoiProposalAcceptActionKind | string | undefined): boolean {
  return (
    kind === 'start_research' ||
    kind === 'get_research_status' ||
    kind === 'open_research_artifact' ||
    kind === 'read_research_artifact'
  );
}

function capabilityForActionKind(
  kind: AoiProposalAcceptActionKind | string | undefined,
): AoiJarvisAutonomyCapability {
  if (kind === 'run_command') {
    return 'command';
  }
  if (kind === 'create_kira_work' || kind === 'open_app' || kind === 'activate_goal') {
    return 'app_action';
  }
  if (
    kind === 'start_research' ||
    kind === 'open_research_artifact' ||
    kind === 'read_research_artifact' ||
    kind === 'get_research_status'
  ) {
    return 'research';
  }
  if (kind === 'save_memory') {
    return 'memory';
  }
  return 'prepare_action';
}

function summarizeReasons(reasons: readonly string[], fallback: string): string {
  if (reasons.length <= 0) {
    return fallback;
  }
  return reasons.slice(0, 5).join(', ');
}

function buildConnectionLabels(kind: string | undefined): string[] {
  return uniqueStrings(
    [
      'L1/L2: apps/webuiapps/src/lib/aoiAutonomyStore.ts and apps/webuiapps/src/lib/aoiAutonomyUi.ts keep opportunity handling display-only.',
      'L3: apps/webuiapps/src/lib/aoiAutonomyExecution.ts can start/read research only from an accepted proposal path.',
      'L4: apps/webuiapps/src/lib/aoiSafeActionPlan.ts and apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts prepare reviewable plans without execution.',
      kind === 'create_kira_work'
        ? 'L4 Kira: apps/webuiapps/src/lib/aoiKiraHandoff.ts builds a preview before any Kira work item can be created.'
        : undefined,
      kind === 'run_command'
        ? 'L4/L5 command: apps/webuiapps/src/lib/aoiApprovedCommandPolicy.ts supplies the exact approval fingerprint.'
        : undefined,
      'L5: apps/webuiapps/src/lib/aoiAutonomyPolicy.ts and apps/webuiapps/src/lib/aoiAutonomyExecution.ts remain the only execution gates.',
    ],
    8,
  );
}

export function decideAoiActionLadder(input: AoiActionLadderInput): AoiActionLadderDecision {
  const now = input.now ?? Date.now();
  const opportunity = input.opportunity;
  const policy = input.policy ?? DEFAULT_AOI_AUTONOMY_POLICY;
  const matchingProposal = findMatchingProposal(opportunity, input.activeProposals);
  const blockedProposal = findMatchingBlockedProposal(opportunity, input.blockedProposals);
  const approvalInboxItem = findApprovalInboxItem(matchingProposal, input.approvalInbox);
  const preparedPlan: AoiPreparedActionPlan | null = matchingProposal
    ? buildAoiPreparedActionPlan(matchingProposal, { now, existingGitStateAvailable: true })
    : null;
  const boundedWorkOrder = findMatchingWorkOrder(
    opportunity,
    matchingProposal,
    input.boundedWorkOrders,
  );
  const approvedCommandPolicy = buildApprovedCommandPolicyForProposal(matchingProposal, now);
  const previewEvaluation = matchingProposal
    ? evaluateAoiProposalExecution(matchingProposal, policy, {
        now,
        decisions: input.proposalDecisions ? [...input.proposalDecisions] : undefined,
        executionMode: 'preview',
      })
    : null;
  const executeEvaluation = matchingProposal
    ? evaluateAoiProposalExecution(matchingProposal, policy, {
        now,
        decisions: input.proposalDecisions ? [...input.proposalDecisions] : undefined,
        executionMode: 'execute',
      })
    : null;
  const actionKind = matchingProposal?.acceptAction?.kind;
  const evidenceRefs = uniqueStrings(
    [
      `opportunity:${opportunity.id}`,
      ...opportunity.evidenceRefs,
      ...(input.deliberationRun?.evidenceRefs ?? []),
      ...(input.deliberationRun?.finding?.evidenceRefs ?? []),
      ...(input.followThroughLearning?.evidenceRefs ?? []),
      ...(matchingProposal ? [`proposal:${matchingProposal.id}`] : []),
      ...(matchingProposal?.evidenceRefs ?? []),
      ...(matchingProposal?.artifactRefs ?? []),
      ...(blockedProposal?.evidenceRefs ?? []),
      ...(approvalInboxItem?.evidenceRefs ?? []),
      ...(boundedWorkOrder ? [`bounded-work-order:${boundedWorkOrder.id}`] : []),
      ...(boundedWorkOrder?.evidenceRefs ?? []),
      ...(approvedCommandPolicy
        ? [`approved-command-policy:${approvedCommandPolicy.approvalFingerprint}`]
        : []),
    ],
    32,
  );
  const unsafeLearningSignal = hasAoiFollowThroughUnsafeSignal(
    opportunity,
    input.followThroughLearning,
  );
  const allowedActions: AoiActionLadderAction[] = [
    makeAction({
      level: 'L1',
      kind: 'observe',
      label: 'Record and summarize the opportunity in the display-only inbox.',
      existingGate: 'opportunity_inbox',
      evidenceRefs,
    }),
  ];
  const blockedActions: AoiActionLadderBlockedAction[] = [];
  const approvalNeeds: AoiActionLadderApprovalNeed[] = [];
  const evidenceNeeds: string[] = [];
  const reachedLevels: AoiActionLadderLevel[] = ['L1'];

  if (hasBriefEvidence(opportunity, input.deliberationRun)) {
    reachedLevels.push('L2');
    allowedActions.push(
      makeAction({
        level: 'L2',
        kind: 'brief',
        label: 'Show a dashboard or inline explanation using the interruption governor result.',
        existingGate: 'interruption_governor',
        evidenceRefs,
      }),
    );
  } else {
    evidenceNeeds.push(
      'Attach at least one opportunity or deliberation evidence ref before briefing.',
    );
    blockedActions.push(
      makeBlockedAction({
        level: 'L2',
        kind: 'brief',
        label: 'Brief the opportunity.',
        reason: 'Briefing is blocked until evidence refs exist.',
        existingGate: 'deliberation_run',
        evidenceRefs,
      }),
    );
  }

  const researchCandidate =
    opportunityWantsResearch(opportunity, input.deliberationRun) ||
    actionKindUsesResearch(actionKind);
  if (researchCandidate && hasBriefEvidence(opportunity, input.deliberationRun)) {
    reachedLevels.push('L3');
    allowedActions.push(
      makeAction({
        level: 'L3',
        kind: actionKind === 'start_research' ? 'start_research_via_gate' : 'suggest_research',
        label:
          actionKind === 'start_research'
            ? 'Research may proceed only through the existing accepted proposal research gate.'
            : 'Suggest a research follow-up while keeping execution behind the research gate.',
        existingGate: 'research_gate',
        evidenceRefs,
      }),
    );
  } else if (researchCandidate) {
    blockedActions.push(
      makeBlockedAction({
        level: 'L3',
        kind: 'research',
        label: 'Suggest or start research through the existing gate.',
        reason:
          'Research is blocked until the opportunity has enough cited evidence to justify it.',
        existingGate: 'research_gate',
        evidenceRefs,
      }),
    );
  }

  if (input.deliberationRun && !hasFreshDeliberation(input.deliberationRun)) {
    evidenceNeeds.push(
      'Refresh or complete the deliberation run before escalating beyond brief/research suggestion.',
    );
  }
  if (!input.deliberationRun) {
    evidenceNeeds.push(
      'Create or attach a deliberation run before claiming Aoi is ready for action preparation.',
    );
  }

  if (matchingProposal && preparedPlan) {
    const prepareReady =
      !unsafeLearningSignal &&
      preparedPlan.status === 'ready' &&
      boundedWorkOrder?.policyResult.status !== 'blocked';
    if (prepareReady) {
      reachedLevels.push('L4');
      allowedActions.push(
        makeAction({
          level: 'L4',
          kind:
            actionKind === 'create_kira_work'
              ? 'prepare_kira_handoff'
              : actionKind === 'run_command'
                ? 'prepare_command_plan'
                : 'prepare_bounded_work_order',
          label:
            actionKind === 'create_kira_work'
              ? 'Prepare a Kira handoff preview; creating the work item still needs approval.'
              : actionKind === 'run_command'
                ? 'Prepare an approved-command plan and show its exact policy fingerprint.'
                : 'Prepare a bounded work order or action checklist without executing it.',
          existingGate: actionKind === 'create_kira_work' ? 'kira_handoff' : 'bounded_work_order',
          evidenceRefs,
        }),
      );
    } else {
      blockedActions.push(
        makeBlockedAction({
          level: 'L4',
          kind: 'prepare',
          label: 'Prepare a reviewable action plan.',
          reason: summarizeReasons(
            [
              ...preparedPlan.blockers.map((blocker) => `prepared_plan:${blocker}`),
              ...(boundedWorkOrder?.policyResult.blockedReasons.map(
                (reason) => `work_order:${reason}`,
              ) ?? []),
              ...(previewEvaluation?.reasons.map((reason) => `proposal_policy:${reason}`) ?? []),
              ...(unsafeLearningSignal ? ['follow_through_learning:unsafe_or_blocked'] : []),
            ],
            'Prepared action plan or bounded work order is not ready.',
          ),
          existingGate: 'safe_action_plan',
          evidenceRefs,
        }),
      );
    }

    if (preparedPlan.approval.required) {
      approvalNeeds.push(
        makeApprovalNeed({
          level: preparedPlan.approval.requiredLevel === 'L5' ? 'L5' : 'L4',
          label: `Prepared plan approval: ${preparedPlan.approval.reason}`,
          requiredAutonomyLevel: preparedPlan.approval.requiredLevel,
          approvalRef: `proposal:${matchingProposal.id}`,
          reason: preparedPlan.approval.freshAcceptanceRequired
            ? 'Fresh explicit acceptance is required for this exact proposal.'
            : 'Explicit proposal approval is required.',
          satisfied: matchingProposal.status === 'accepted',
          evidenceRefs,
        }),
      );
    }
    if (approvalInboxItem) {
      approvalNeeds.push(
        makeApprovalNeed({
          level: 'L5',
          label: approvalInboxItem.exactNextAction,
          requiredAutonomyLevel: approvalInboxItem.requiredAutonomyLevel,
          approvalRef: `approval-inbox:${approvalInboxItem.proposalId}`,
          reason: approvalInboxItem.boundary,
          satisfied: false,
          evidenceRefs: approvalInboxItem.evidenceRefs,
        }),
      );
    }
    const firstCommand = boundedWorkOrder?.commands[0];
    if (actionKind === 'run_command' && (firstCommand || approvedCommandPolicy)) {
      const commandAllowed = firstCommand?.allowed ?? approvedCommandPolicy?.allowed ?? false;
      const commandBlockReasons =
        firstCommand?.blockReasons ?? approvedCommandPolicy?.blockReasons ?? [];
      const approvalFingerprint =
        firstCommand?.approvalFingerprint ?? approvedCommandPolicy?.approvalFingerprint ?? '';
      approvalNeeds.push(
        makeApprovalNeed({
          level: 'L5',
          label: `Approved command fingerprint: ${approvalFingerprint}`,
          requiredAutonomyLevel: 'L5',
          approvalRef: `proposal:${matchingProposal.id}`,
          approvalFingerprint,
          reason: commandAllowed
            ? 'The exact command can be approved, but execution still waits for a matching approval decision.'
            : `Command policy blocks approval: ${commandBlockReasons.join(', ')}`,
          satisfied: false,
          evidenceRefs,
        }),
      );
    }

    const capability = capabilityForActionKind(actionKind);
    const governorAllowsExecution = canAoiJarvisAutonomyUseCapability(
      input.jarvisGovernor,
      capability,
    );
    const executeAllowed =
      executeEvaluation?.allowed === true &&
      governorAllowsExecution &&
      boundedWorkOrder?.policyResult.status !== 'blocked' &&
      !unsafeLearningSignal;
    if (executeAllowed) {
      reachedLevels.push('L5');
      allowedActions.push(
        makeAction({
          level: 'L5',
          kind: 'execute_via_existing_proposal_gate',
          label:
            'Execution is available only by invoking the existing accepted proposal execution path.',
          existingGate: 'autonomy_execution',
          evidenceRefs,
        }),
      );
    } else {
      const reasons = [
        ...(executeEvaluation?.reasons ?? ['missing_matching_proposal']),
        ...(governorAllowsExecution ? [] : [`jarvis_governor_blocks:${capability}`]),
        ...(boundedWorkOrder?.policyResult.status === 'blocked'
          ? boundedWorkOrder.policyResult.blockedReasons
          : []),
        ...(unsafeLearningSignal ? ['follow_through_learning:unsafe_or_blocked'] : []),
      ];
      blockedActions.push(
        makeBlockedAction({
          level: 'L5',
          kind: 'execute',
          label: 'Execute through the existing proposal path.',
          reason: summarizeReasons(reasons, 'Existing execution gates are not satisfied.'),
          existingGate: 'autonomy_execution',
          evidenceRefs,
        }),
      );
    }
  } else {
    evidenceNeeds.push(
      'Create or link an Aoi proposal before L4 prepare/L5 execute can be evaluated.',
    );
    if (blockedProposal) {
      blockedActions.push(
        makeBlockedAction({
          level: 'L4',
          kind: 'prepare',
          label: 'Prepare action from blocked proposal.',
          reason: summarizeReasons(blockedProposal.reasons, 'Matching proposal is blocked.'),
          existingGate: 'proposal_acceptance',
          evidenceRefs,
        }),
      );
    } else {
      blockedActions.push(
        makeBlockedAction({
          level: 'L4',
          kind: 'prepare',
          label: 'Prepare Kira handoff, app checklist, command plan, or bounded work order.',
          reason:
            'No matching proposal exists, so Aoi can only describe the next safe proposal path.',
          existingGate: 'proposal_acceptance',
          evidenceRefs,
        }),
      );
    }
    blockedActions.push(
      makeBlockedAction({
        level: 'L5',
        kind: 'execute',
        label: 'Execute work.',
        reason:
          'Execution is unavailable without an accepted proposal and existing approval gate evidence.',
        existingGate: 'autonomy_execution',
        evidenceRefs,
      }),
    );
  }

  const currentLevel = highestLevel(reachedLevels);
  const firstBlockedAboveCurrent = blockedActions
    .map((action) => action.level)
    .filter((level) => LEVEL_ORDER[level] > LEVEL_ORDER[currentLevel])
    .sort((left, right) => LEVEL_ORDER[left] - LEVEL_ORDER[right])[0];
  const nextLevel = firstBlockedAboveCurrent ?? nextLevelAfter(currentLevel);
  const safeFallback =
    currentLevel === 'L5'
      ? 'Use only the existing proposal execution controls; this ladder does not execute anything.'
      : currentLevel === 'L4'
        ? 'Prepare-only: keep execution behind explicit approval, policy, and runner gates.'
        : currentLevel === 'L3'
          ? 'Suggest or queue research through the existing research gate; do not mutate app or files.'
          : currentLevel === 'L2'
            ? 'Keep the item as a dashboard or inline brief until action evidence exists.'
            : 'Record the opportunity and collect evidence before interrupting or preparing actions.';

  return {
    version: 1,
    id: `aoi-action-ladder-${opportunity.id}`,
    sessionPath: input.sessionPath,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    currentLevel,
    ...(nextLevel ? { nextLevel } : {}),
    levelLabel: LEVEL_LABELS[currentLevel],
    ...(nextLevel ? { nextLevelLabel: LEVEL_LABELS[nextLevel] } : {}),
    summaryLabel:
      currentLevel === 'L5'
        ? 'Existing gates show this can proceed only through the approved proposal execution path.'
        : `${LEVEL_LABELS[currentLevel]} is the current safe ceiling; stronger actions remain gated.`,
    allowedActions,
    blockedActions: blockedActions.slice(0, 8),
    approvalNeeds: approvalNeeds.slice(0, 6),
    evidenceNeeds: uniqueStrings(evidenceNeeds, 6),
    safeFallback,
    connectionLabels: buildConnectionLabels(actionKind),
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiActionLadderDecisions(
  input: AoiActionLadderBatchInput,
): AoiActionLadderDecision[] {
  return input.opportunities.map((opportunity) =>
    decideAoiActionLadder({
      ...input,
      opportunity,
      deliberationRun: latestRunForOpportunity(input.deliberationRuns, opportunity.id),
    }),
  );
}
