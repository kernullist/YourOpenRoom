import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAoiAutonomousExecuteProductionDeps,
  runAoiAutonomousExecuteForWakeup,
} from '../aoiAutonomousExecuteProductionDeps';
import { classifyAoiAutonomousExecuteEligibility } from '../aoiAutonomousExecuteEligibility';
import {
  getAoiApprovedAppActionPolicyForProposal,
  getAoiApprovedFileMutationPolicyForProposal,
} from '../aoiAutonomyPolicy';
import { appendAoiProposalDecision, saveAoiActiveProposals } from '../aoiAutonomyStore';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';
import type { AoiProposalExecutionResult } from '../aoiAutonomyExecution';

const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

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

function makeFileWriteProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeAppActionProposal({
    id: 'prop-file-1',
    title: 'Write the reviewed file',
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['file_write'],
    evidenceRefs: ['workspace:reviewed-file'],
    acceptAction: {
      kind: 'file_write',
      params: {
        path: 'controlled/result.txt',
        content: 'approved',
        validationPlan: {
          version: 1,
          expectedBeforeSha256: 'absent',
          expectedAfterSha256: sha256('approved'),
        },
      },
    },
    ...partial,
  });
}

function makeFileAcceptDecision(
  proposal: AoiProposal,
  partial: Partial<AoiProposalDecision> = {},
): AoiProposalDecision {
  return {
    version: 1,
    id: 'dec-file-1',
    proposalId: proposal.id,
    sessionPath: proposal.sessionPath,
    cooldownKey: proposal.cooldownKey,
    action: 'accept',
    actor: 'user',
    createdAt: NOW,
    previousStatus: 'active',
    nextStatus: 'active',
    approvedFileMutation: getAoiApprovedFileMutationPolicyForProposal(proposal, NOW),
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
  it('allows an exact user-approved file_write after checkpoint and target preflight', () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-prod-file-')));
    tempRoots.push(root);
    const proposal = makeFileWriteProposal();
    const decision = makeFileAcceptDecision(proposal);
    const deps = createAoiAutonomousExecuteProductionDeps(ctx({ workspaceRoot: root }));
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 1,
      now: NOW + 1,
    });
    expect(input).toMatchObject({
      actionKind: 'file_write',
      hasCheckpoint: true,
      exactScope: true,
      hasValidationPlan: true,
      targetFingerprintMatches: true,
    });
    expect(classifyAoiAutonomousExecuteEligibility(input)).toEqual({
      eligible: true,
      blockReasons: [],
    });
  });

  it('blocks file self-execution when the approved validation plan is missing', () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-prod-file-no-plan-')));
    tempRoots.push(root);
    const proposal = makeFileWriteProposal({
      acceptAction: {
        kind: 'file_write',
        params: { path: 'controlled/result.txt', content: 'approved' },
      },
    });
    const decision = makeFileAcceptDecision(proposal);
    const deps = createAoiAutonomousExecuteProductionDeps(ctx({ workspaceRoot: root }));
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 1,
      now: NOW + 1,
    });
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'validation_plan_missing',
    );
  });

  it('blocks file self-execution when the target changed after approval', () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-prod-file-drift-')));
    tempRoots.push(root);
    fs.mkdirSync(join(root, 'controlled'), { recursive: true });
    fs.writeFileSync(join(root, 'controlled/result.txt'), 'reviewed');
    const proposal = makeFileWriteProposal({
      acceptAction: {
        kind: 'file_write',
        params: {
          path: 'controlled/result.txt',
          content: 'approved',
          validationPlan: {
            version: 1,
            expectedBeforeSha256: sha256('reviewed'),
            expectedAfterSha256: sha256('approved'),
          },
        },
      },
    });
    const decision = makeFileAcceptDecision(proposal);
    fs.writeFileSync(join(root, 'controlled/result.txt'), 'drifted');
    const deps = createAoiAutonomousExecuteProductionDeps(ctx({ workspaceRoot: root }));
    const input = deps.resolveEligibility!({
      decision,
      proposal,
      sessionBudgetRemaining: 1,
      now: NOW + 1,
    });
    expect(input.hasCheckpoint).toBe(true);
    expect(classifyAoiAutonomousExecuteEligibility(input).blockReasons).toContain(
      'target_fingerprint_mismatch',
    );
  });

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

describe('runAoiAutonomousExecuteForWakeup (P2.3 daemon entry)', () => {
  function makeRoot(): string {
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-wakeup-exec-')));
    tempRoots.push(root);
    return root;
  }

  it('is inert without the env gate, WITHOUT computing readiness or touching stores', async () => {
    // A non-existent sessionsDir would throw if readiness were computed -> proves the short-circuit.
    const result = await runAoiAutonomousExecuteForWakeup({
      sessionsDir: join(os.tmpdir(), 'aoi-wakeup-does-not-exist-xyz'),
      sessionPath: 'aoi/default',
      configFile: '/tmp/config.json',
      serverOrigin: 'http://127.0.0.1:3000',
      now: NOW,
      env: {}, // gate off
    });
    expect(result).toEqual({ enabled: false, executed: [], skipped: [] });
  });

  it('runs the bounded loop when enabled, using injected readiness + deps (no real execution)', async () => {
    const root = makeRoot();
    const proposal = makeAppActionProposal();
    saveAoiActiveProposals(root, 'aoi/default', [proposal]);
    appendAoiProposalDecision(root, makeAcceptDecision(proposal));
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteForWakeup({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      configFile: '/tmp/config.json',
      serverOrigin: 'http://127.0.0.1:3000',
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      readinessLevel: 'trusted_operator',
      deps: {
        resolveEligibility: ({ decision, proposal: p, sessionBudgetRemaining, now }) => {
          const standing = getAoiApprovedAppActionPolicyForProposal(p, now);
          return {
            actionKind: 'app_action',
            hasCheckpoint: true,
            approvalFingerprint: standing.approvalFingerprint,
            currentFingerprint: standing.approvalFingerprint,
            approvalExpiresAt: standing.expiresAt,
            readinessLevel: 'trusted_operator',
            sessionBudgetRemaining,
            acceptDecisionActor: decision.actor === 'user' ? 'user' : null,
            now,
          };
        },
        executeProposal,
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.executed).toEqual([proposal.id]);
    expect(executeProposal).toHaveBeenCalledTimes(1);
  });
});
