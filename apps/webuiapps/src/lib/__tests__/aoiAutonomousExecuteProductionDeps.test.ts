import { describe, expect, it, vi } from 'vitest';

import { createAoiAutonomousExecuteProductionDeps } from '../aoiAutonomousExecuteProductionDeps';
import { classifyAoiAutonomousExecuteEligibility } from '../aoiAutonomousExecuteEligibility';
import { getAoiApprovedAppActionPolicyForProposal } from '../aoiAutonomyPolicy';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';
import type { AoiProposalExecutionResult } from '../aoiAutonomyExecution';

const NOW = 1_800_000_000_000;

function makeAppActionProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'prop-1',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Play the queued track',
    body: 'x',
    reason: 'x',
    trigger: 'x',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    cooldownKey: 'k',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: [],
    evidenceRefs: [],
    memoryIds: [],
    artifactRefs: [],
    riskSignals: [],
    acceptAction: {
      kind: 'app_action',
      params: { appName: 'musicApp', actionType: 'PLAY_TRACK', trackId: '123' },
    },
    ...partial,
  };
}

function makeAcceptDecision(
  proposal: AoiProposal,
  partial: Partial<AoiProposalDecision> = {},
): AoiProposalDecision {
  // The standing approval is the policy as approved for THIS proposal at NOW.
  const standing = getAoiApprovedAppActionPolicyForProposal(proposal, NOW);
  return {
    version: 1,
    id: 'dec-1',
    proposalId: proposal.id,
    sessionPath: 'aoi/default',
    cooldownKey: 'k',
    action: 'accept',
    actor: 'user',
    createdAt: NOW - 500,
    previousStatus: 'active',
    nextStatus: 'active',
    approvedAppAction: standing,
    ...partial,
  };
}

function ctx(partial: Record<string, unknown> = {}) {
  return {
    sessionsDir: '/tmp/aoi',
    sessionPath: 'aoi/default',
    configFile: '/tmp/aoi/config.json',
    serverOrigin: 'http://127.0.0.1:3000',
    readinessLevel: 'trusted_operator' as const,
    ...partial,
  };
}

describe('createAoiAutonomousExecuteProductionDeps.resolveEligibility (P2.3)', () => {
  it('produces an ELIGIBLE input for a user-approved app_action at trusted_operator', () => {
    const proposal = makeAppActionProposal();
    const decision = makeAcceptDecision(proposal);
    const deps = createAoiAutonomousExecuteProductionDeps(ctx());
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.actionKind).toBe('app_action');
    expect(input.acceptDecisionActor).toBe('user');
    expect(input.approvalFingerprint).toBe(input.currentFingerprint);
    expect(input.approvalFingerprint).toBeTruthy();
    expect(input.hasCheckpoint).toBe(true);
    // The whole point: this really is eligible through the pure gate.
    expect(classifyAoiAutonomousExecuteEligibility(input).eligible).toBe(true);
  });

  it('fails closed for a non-reversible kind (run_command)', () => {
    const proposal = makeAppActionProposal({
      acceptAction: { kind: 'run_command', params: { command: 'ls' } },
    });
    const decision = makeAcceptDecision(proposal);
    const deps = createAoiAutonomousExecuteProductionDeps(ctx());
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.hasCheckpoint).toBe(false);
    expect(input.approvalFingerprint).toBeNull();
    const result = classifyAoiAutonomousExecuteEligibility(input);
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('not_reversible_class');
  });

  it('fails closed when the accept decision carries no standing approval', () => {
    const proposal = makeAppActionProposal();
    const decision = makeAcceptDecision(proposal, { approvedAppAction: undefined });
    const deps = createAoiAutonomousExecuteProductionDeps(ctx());
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.approvalFingerprint).toBeNull();
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'approval_missing',
    );
  });

  it('fails closed below trusted_operator readiness', () => {
    const proposal = makeAppActionProposal();
    const decision = makeAcceptDecision(proposal);
    const deps = createAoiAutonomousExecuteProductionDeps(ctx({ readinessLevel: 'field_shadow' }));
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.readinessLevel).toBe('field_shadow');
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'readiness_below_trusted_operator',
    );
  });

  it('detects approval drift (standing fingerprint no longer matches the proposal)', () => {
    const proposal = makeAppActionProposal();
    // Standing approval was for a DIFFERENT operation -> fingerprint will not match.
    const otherProposal = makeAppActionProposal({
      acceptAction: { kind: 'app_action', params: { appName: 'musicApp', actionType: 'PAUSE' } },
    });
    const decision = makeAcceptDecision(otherProposal, { proposalId: proposal.id });
    const deps = createAoiAutonomousExecuteProductionDeps(ctx());
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.approvalFingerprint).not.toBe(input.currentFingerprint);
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'approval_fingerprint_mismatch',
    );
  });

  it('maps a missing actor to null (fails the user-authored gate)', () => {
    const proposal = makeAppActionProposal();
    const decision = makeAcceptDecision(proposal, {
      actor: undefined as unknown as AoiProposalDecision['actor'],
    });
    const deps = createAoiAutonomousExecuteProductionDeps(ctx());
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.acceptDecisionActor).toBeNull();
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'accept_decision_not_user_authored',
    );
  });

  it('marks a system (daemon/loop) acceptance as aoi-authored (never self-executed)', () => {
    const proposal = makeAppActionProposal();
    const decision = makeAcceptDecision(proposal, { actor: 'system' });
    const deps = createAoiAutonomousExecuteProductionDeps(ctx());
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 3,
      now: NOW,
    });
    expect(input.acceptDecisionActor).toBe('aoi');
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'accept_decision_not_user_authored',
    );
  });
});

describe('createAoiAutonomousExecuteProductionDeps.executeProposal (P2.3)', () => {
  it('wraps executeAoiProposal and maps executed=true', async () => {
    const executeProposalFn = vi.fn(
      async () =>
        ({ executed: true, outcome: 'executed' }) as unknown as AoiProposalExecutionResult,
    );
    const deps = createAoiAutonomousExecuteProductionDeps(ctx({ executeProposalFn }));
    const result = await deps.executeProposal!({
      proposalId: 'prop-1',
      decisionId: 'dec-1',
      now: NOW,
    });
    expect(result).toEqual({ executed: true });
    expect(executeProposalFn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsDir: '/tmp/aoi',
        sessionPath: 'aoi/default',
        configFile: '/tmp/aoi/config.json',
        serverOrigin: 'http://127.0.0.1:3000',
        proposalId: 'prop-1',
        decisionId: 'dec-1',
        now: NOW,
      }),
    );
  });

  it('maps a blocked/failed execution to executed=false', async () => {
    const executeProposalFn = vi.fn(
      async () =>
        ({ executed: false, outcome: 'blocked' }) as unknown as AoiProposalExecutionResult,
    );
    const deps = createAoiAutonomousExecuteProductionDeps(ctx({ executeProposalFn }));
    const result = await deps.executeProposal!({
      proposalId: 'prop-1',
      decisionId: 'dec-1',
      now: NOW,
    });
    expect(result).toEqual({ executed: false });
  });
});
