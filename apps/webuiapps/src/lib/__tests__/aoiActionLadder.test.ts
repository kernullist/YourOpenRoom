import { describe, expect, it } from 'vitest';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from '../aoiApprovedCommandPolicy';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { decideAoiActionLadder } from '../aoiActionLadder';
import { buildAoiFollowThroughLearningSummary } from '../aoiFollowThroughLearning';
import type { AoiJarvisAutonomyGovernorDecision } from '../aoiJarvisAutonomyGovernor';
import type {
  AoiApprovalInboxItem,
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiOpportunity,
  AoiProposal,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
} from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    level: 'L5',
    confidenceFloor: 0.4,
    ...partial,
  };
}

function makeOpportunity(partial: Partial<AoiOpportunity> = {}): AoiOpportunity {
  return {
    version: 1,
    id: 'opp-action-ladder-001',
    sessionPath: SESSION_PATH,
    sourceKind: 'research',
    title: 'Investigate RE validation drift',
    curiosityQuestion: 'Should Aoi turn this finding into a safe next action?',
    whyNow: 'A recent Aoi deliberation found evidence that may need follow-up.',
    evidenceNeed: 'Need fresh public or local evidence before action preparation.',
    suggestedNextAction: 'Suggest research or prepare a gated follow-up only.',
    risk: 'medium',
    confidence: 0.86,
    urgency: 0.72,
    novelty: 0.7,
    deliveryRecommendation: 'dashboard',
    status: 'active',
    evidenceRefs: ['research:re-validation', 'workspace:validation-signal'],
    dedupeKey: 'action-ladder:re-validation',
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - 60_000,
    expiresAt: NOW + DAY_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeDeliberationRun(
  opportunity: AoiOpportunity,
  partial: Partial<AoiDeliberationRun> = {},
): AoiDeliberationRun {
  return {
    version: 1,
    id: 'delib-action-ladder-001',
    sessionPath: SESSION_PATH,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    opportunityTitle: opportunity.title,
    phase: 'ready',
    selectedAt: NOW - 20_000,
    updatedAt: NOW - 10_000,
    evidencePlan: [
      {
        version: 1,
        id: 'evidence-step-research',
        kind: 'research',
        status: 'observed',
        sourceRef: 'research:re-validation',
        label: 'Research evidence',
        summary: 'Fresh research evidence supports a follow-up.',
        freshness: 'fresh',
        evidenceRefs: ['research:re-validation'],
        cannotKnow: [],
        blockers: [],
        observedAt: NOW - 10_000,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    ],
    finding: {
      version: 1,
      summary: 'The finding is fresh enough for a gated follow-up.',
      sourceQuality: 'strong',
      freshness: 'fresh',
      confidence: 0.83,
      evidenceRefs: ['research:re-validation'],
      blockers: [],
      cannotKnow: [],
      createdAt: NOW - 10_000,
    },
    opinion: {
      version: 1,
      stance: 'ready_to_brief',
      summary: 'Aoi can brief this and prepare a gated next step.',
      reason: 'Fresh evidence exists.',
      evidenceRefs: ['research:re-validation'],
      createdAt: NOW - 9_000,
    },
    safeNextAction: 'Prepare a gated follow-up proposal.',
    blockers: [],
    evidenceRefs: ['research:re-validation'],
    artifactRefs: ['deliberation:action-ladder'],
    phaseHistory: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeProposal(
  opportunity: AoiOpportunity,
  kind: AoiProposalAcceptActionKind,
  partial: Partial<AoiProposal> = {},
): AoiProposal {
  return {
    version: 1,
    id: `proposal-${kind}`,
    sessionPath: SESSION_PATH,
    status: 'active',
    title: `${kind} for ${opportunity.title}`,
    body: `Prepared follow-up for ${opportunity.dedupeKey}.`,
    reason: 'A matching opportunity needs a gated next action.',
    trigger: 'action_ladder_test',
    createdAt: NOW - 5_000,
    updatedAt: NOW - 2_000,
    expiresAt: NOW + DAY_MS,
    cooldownKey: opportunity.dedupeKey,
    confidence: 0.82,
    risk: kind === 'run_command' ? 'high' : 'medium',
    requiredAutonomyLevel:
      kind === 'run_command' ? 'L5' : kind === 'create_kira_work' ? 'L4' : 'L3',
    requiresUserApproval: true,
    suggestedTools: [kind],
    evidenceRefs: [`opportunity:${opportunity.id}`, ...opportunity.evidenceRefs],
    memoryIds: [],
    artifactRefs: [`opportunity:${opportunity.id}`],
    riskSignals: [],
    acceptAction: {
      kind,
      params:
        kind === 'run_command'
          ? {
              command:
                'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiActionLadder.test.ts',
              cwd: '.',
              purpose: 'Validate the Aoi action ladder.',
            }
          : kind === 'start_research'
            ? {
                sessionPath: SESSION_PATH,
                request: 'Check fresh RE validation drift evidence.',
                mode: 'standard',
              }
            : kind === 'create_kira_work'
              ? {
                  objective: 'Implement a narrow Aoi follow-up.',
                  scope: ['apps/webuiapps/src/lib/aoiActionLadder.ts'],
                  validationProfile: 'aoi',
                }
              : {},
    },
    ...partial,
  };
}

function makeJarvisGovernor(blockedCapabilities: string[] = []): AoiJarvisAutonomyGovernorDecision {
  const capabilities = [
    'observe',
    'research',
    'memory',
    'proactive_brief',
    'direct_chat',
    'prepare_action',
    'app_action',
    'command',
  ] as const;
  return {
    version: 1,
    id: 'jarvis-governor-action-ladder-test',
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    overallMode: 'approval_execution',
    modeRank: 5,
    modeLabel: 'Approval execution',
    operatorSummary: 'Test governor',
    allowedAutonomyBands: capabilities.map((capability) => ({
      version: 1,
      capability,
      allowed: !blockedCapabilities.includes(capability),
      requiredMode: capability === 'command' ? 'approval_execution' : 'prepare_actions',
      reason: `${capability} test gate`,
      evidenceRefs: [`governor:${capability}`],
    })),
    blockers: [],
    nextUpgradeAction: 'No upgrade needed for test.',
    nextUpgradeEvidenceRefs: ['governor:upgrade'],
    whyNotJarvisYetLabels: [],
    evidenceRefs: ['governor:test'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeApprovalInboxItem(proposal: AoiProposal): AoiApprovalInboxItem {
  return {
    version: 1,
    proposalId: proposal.id,
    title: proposal.title,
    exactNextAction: 'Review and approve the exact prepared action.',
    boundary: 'Execution waits for the existing proposal approval path.',
    risk: proposal.risk,
    status: proposal.status,
    actionKind: proposal.acceptAction?.kind,
    requiredAutonomyLevel: proposal.requiredAutonomyLevel,
    evidenceCount: proposal.evidenceRefs.length,
    evidenceRefs: proposal.evidenceRefs,
    dedupeKey: proposal.cooldownKey,
    createdAt: NOW,
    availableActions: ['approve', 'dismiss', 'details'],
  };
}

function makeAcceptDecision(
  proposal: AoiProposal,
  approvedCommand?: AoiProposalDecision['approvedCommand'],
): AoiProposalDecision {
  return {
    version: 1,
    id: `decision-${proposal.id}`,
    proposalId: proposal.id,
    sessionPath: SESSION_PATH,
    cooldownKey: proposal.cooldownKey,
    action: 'accept',
    actor: 'user',
    createdAt: NOW - 1_000,
    previousStatus: 'active',
    nextStatus: 'accepted',
    reason: 'Approved in test.',
    proposalRisk: proposal.risk,
    actionKind: proposal.acceptAction?.kind,
    suggestedTools: proposal.suggestedTools,
    evidenceRefs: proposal.evidenceRefs,
    ...(approvedCommand ? { approvedCommand } : {}),
  };
}

describe('Aoi Action Ladder', () => {
  it('keeps evidence-free items at observe only', () => {
    const opportunity = makeOpportunity({
      sourceKind: 'manual',
      evidenceRefs: [],
      suggestedNextAction: 'Record this until evidence exists.',
    });
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      policy: makePolicy(),
      jarvisGovernor: makeJarvisGovernor(),
      now: NOW,
    });

    expect(decision.currentLevel).toBe('L1');
    expect(decision.allowedActions.map((action) => action.level)).toContain('L1');
    expect(decision.blockedActions.map((action) => action.level)).toEqual(
      expect.arrayContaining(['L2', 'L4', 'L5']),
    );
    expect(decision.evidenceNeeds.join(' ')).toContain('evidence ref');
    expect(decision.actionAuthority).toBe('display_only');
    expect(decision.mutationCount).toBe(0);
  });

  it('allows research suggestion without granting execution when evidence exists', () => {
    const opportunity = makeOpportunity();
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L3' }),
      jarvisGovernor: makeJarvisGovernor(),
      now: NOW,
    });

    expect(decision.currentLevel).toBe('L3');
    expect(decision.allowedActions.some((action) => action.kind === 'suggest_research')).toBe(true);
    expect(decision.blockedActions.some((action) => action.level === 'L5')).toBe(true);
    expect(decision.safeFallback).toContain('research gate');
  });

  it('opens prepare-only for a matching Kira handoff proposal', () => {
    const opportunity = makeOpportunity({ sourceKind: 'kira' });
    const proposal = makeProposal(opportunity, 'create_kira_work');
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L4' }),
      jarvisGovernor: makeJarvisGovernor(),
      activeProposals: [proposal],
      approvalInbox: [makeApprovalInboxItem(proposal)],
      now: NOW,
    });

    expect(decision.currentLevel).toBe('L4');
    expect(decision.levelLabel).toContain('prepare');
    expect(decision.allowedActions.some((action) => action.kind === 'prepare_kira_handoff')).toBe(
      true,
    );
    expect(decision.approvalNeeds.map((need) => need.requiredAutonomyLevel)).toContain('L4');
    expect(decision.blockedActions.some((action) => action.level === 'L5')).toBe(true);
    expect(decision.connectionLabels.join(' ')).toContain('aoiKiraHandoff.ts');
  });

  it('keeps L4 preparation blocked when Jarvis readiness denies prepare actions', () => {
    const opportunity = makeOpportunity({ sourceKind: 'kira' });
    const proposal = makeProposal(opportunity, 'create_kira_work');
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L4' }),
      jarvisGovernor: makeJarvisGovernor(['prepare_action']),
      activeProposals: [proposal],
      approvalInbox: [makeApprovalInboxItem(proposal)],
      now: NOW,
    });

    expect(decision.currentLevel).not.toBe('L4');
    expect(decision.allowedActions.map((action) => action.kind)).not.toContain(
      'prepare_kira_handoff',
    );
    expect(decision.blockedActions.find((action) => action.level === 'L4')?.reason).toContain(
      'jarvis_governor_blocks:prepare_action',
    );
    expect(decision.actionAuthority).toBe('display_only');
    expect(decision.mutationCount).toBe(0);
  });

  it('blocks similar action escalation when follow-through learning marked it unsafe', () => {
    const opportunity = makeOpportunity({ sourceKind: 'kira' });
    const proposal = makeProposal(opportunity, 'create_kira_work');
    const followThroughLearning = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        {
          version: 1,
          id: 'follow-through-unsafe-kira',
          sessionPath: SESSION_PATH,
          opportunityId: opportunity.id,
          sourceKind: opportunity.sourceKind,
          topicKey: opportunity.dedupeKey,
          sourceKey: opportunity.sourceKind,
          deliveryMode: 'dashboard',
          action: 'blocked',
          feedbackCategory: 'unsafe',
          result: 'blocked',
          timingLabel: 'unsafe in test',
          evidenceRefs: ['test:unsafe-follow-through'],
          createdAt: NOW - 1_000,
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
      now: NOW,
    });
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L4' }),
      jarvisGovernor: makeJarvisGovernor(),
      activeProposals: [proposal],
      approvalInbox: [makeApprovalInboxItem(proposal)],
      followThroughLearning,
      now: NOW,
    });

    expect(decision.currentLevel).not.toBe('L4');
    expect(decision.allowedActions.map((action) => action.kind)).not.toContain(
      'prepare_kira_handoff',
    );
    expect(decision.blockedActions.map((action) => action.reason).join(' ')).toContain(
      'follow_through_learning:unsafe_or_blocked',
    );
    expect(decision.actionAuthority).toBe('display_only');
    expect(decision.mutationCount).toBe(0);
  });

  it('blocks unsupported app-action preparation instead of inventing authority', () => {
    const opportunity = makeOpportunity({ sourceKind: 'app_state' });
    const proposal = makeProposal(opportunity, 'open_app', {
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['open_app'],
    });
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L5' }),
      jarvisGovernor: makeJarvisGovernor(),
      activeProposals: [proposal],
      now: NOW,
    });

    expect(decision.currentLevel).not.toBe('L4');
    expect(decision.blockedActions.some((action) => action.level === 'L4')).toBe(true);
    expect(decision.blockedActions.map((action) => action.reason).join(' ')).toContain(
      'unsupported_action_kind',
    );
    expect(decision.allowedActions.map((action) => action.kind)).not.toContain(
      'execute_via_existing_proposal_gate',
    );
  });

  it('keeps command execution blocked until an approval fingerprint is present', () => {
    const opportunity = makeOpportunity({ sourceKind: 'workspace' });
    const proposal = makeProposal(opportunity, 'run_command', { status: 'accepted' });
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L5' }),
      jarvisGovernor: makeJarvisGovernor(),
      activeProposals: [proposal],
      approvalInbox: [makeApprovalInboxItem(proposal)],
      now: NOW,
    });

    expect(decision.currentLevel).toBe('L4');
    expect(decision.approvalNeeds.some((need) => Boolean(need.approvalFingerprint))).toBe(true);
    expect(decision.blockedActions.find((action) => action.level === 'L5')?.reason).toContain(
      'approval',
    );
    expect(decision.allowedActions.map((action) => action.kind)).not.toContain(
      'execute_via_existing_proposal_gate',
    );
  });

  it('shows mixed allowed and blocked levels for a useful item without a proposal', () => {
    const opportunity = makeOpportunity({ sourceKind: 'interest' });
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L3' }),
      jarvisGovernor: makeJarvisGovernor(),
      now: NOW,
    });

    expect(decision.allowedActions.map((action) => action.level)).toEqual(
      expect.arrayContaining(['L1', 'L2', 'L3']),
    );
    expect(decision.blockedActions.map((action) => action.level)).toEqual(
      expect.arrayContaining(['L4', 'L5']),
    );
    expect(decision.safeFallback).toContain('research gate');
  });

  it('allows L5 only through the existing accepted proposal execution path', () => {
    const opportunity = makeOpportunity({ sourceKind: 'workspace' });
    const proposal = makeProposal(opportunity, 'run_command', { status: 'accepted' });
    const request = createAoiApprovedCommandRequest({
      sessionPath: SESSION_PATH,
      proposalId: proposal.id,
      command: proposal.acceptAction?.params.command,
      cwd: proposal.acceptAction?.params.cwd,
      purpose: proposal.acceptAction?.params.purpose,
      risk: proposal.risk,
      requestedAt: NOW,
      evidenceRefs: proposal.evidenceRefs,
    });
    const approvedCommand = evaluateAoiApprovedCommandPolicy(request);
    const decision = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeDeliberationRun(opportunity),
      policy: makePolicy({ level: 'L5' }),
      jarvisGovernor: makeJarvisGovernor(),
      activeProposals: [proposal],
      proposalDecisions: [makeAcceptDecision(proposal, approvedCommand)],
      now: NOW,
    });

    expect(approvedCommand.allowed).toBe(true);
    expect(decision.currentLevel).toBe('L5');
    expect(decision.allowedActions.map((action) => action.kind)).toContain(
      'execute_via_existing_proposal_gate',
    );
    expect(decision.safeFallback).toContain('does not execute');
    expect(decision.connectionLabels.join(' ')).toContain('aoiAutonomyExecution.ts');
  });
});
