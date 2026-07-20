import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendAoiProposalDecision, saveAoiActiveProposals } from '../aoiAutonomyStore';
import { runAoiAutonomousExecuteLoop } from '../aoiAutonomousExecuteLoop';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';
import type { AoiAutonomousExecuteEligibilityInput } from '../aoiAutonomousExecuteEligibility';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/default';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-self-exec-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-x',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: 'Reversible file edit',
    body: 'x',
    reason: 'x',
    trigger: 'x',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
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
    acceptAction: { kind: 'file_write', params: {} },
    ...partial,
  };
}

function makeDecision(partial: Partial<AoiProposalDecision> = {}): AoiProposalDecision {
  return {
    version: 1,
    id: 'decision-x',
    proposalId: 'proposal-x',
    sessionPath: SESSION_PATH,
    cooldownKey: 'k',
    action: 'accept',
    actor: 'user',
    createdAt: NOW - 500,
    previousStatus: 'active',
    nextStatus: 'active',
    ...partial,
  };
}

function seed(root: string, proposal: AoiProposal, decision: AoiProposalDecision): void {
  saveAoiActiveProposals(root, SESSION_PATH, [proposal]);
  appendAoiProposalDecision(root, decision);
}

const eligibleInput: AoiAutonomousExecuteEligibilityInput = {
  actionKind: 'file_write',
  hasCheckpoint: true,
  exactScope: true,
  hasValidationPlan: true,
  targetFingerprintMatches: true,
  approvalFingerprint: 'fp',
  currentFingerprint: 'fp',
  approvalExpiresAt: NOW + 60_000,
  readinessLevel: 'trusted_operator',
  sessionBudgetRemaining: 3,
  acceptDecisionActor: 'user',
  now: NOW,
};

describe('runAoiAutonomousExecuteLoop (P2.3)', () => {
  it('is inert (does nothing) unless the env gate is on', async () => {
    const root = makeRoot();
    seed(root, makeProposal(), makeDecision());
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: {}, // AOI_AUTONOMY_SELF_EXECUTE not set
      deps: { resolveEligibility: () => eligibleInput, executeProposal },
    });
    expect(result).toEqual({ enabled: false, executed: [], skipped: [] });
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('self-invokes the executor for an eligible user-accepted decision', async () => {
    const root = makeRoot();
    seed(root, makeProposal(), makeDecision());
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { resolveEligibility: () => eligibleInput, executeProposal },
    });
    expect(result.enabled).toBe(true);
    expect(result.executed).toEqual(['proposal-x']);
    expect(executeProposal).toHaveBeenCalledWith({
      proposalId: 'proposal-x',
      decisionId: 'decision-x',
      now: NOW,
    });
  });

  it('the DEFAULT resolver fails closed -> inert even when enabled (no real execution)', async () => {
    const root = makeRoot();
    seed(root, makeProposal(), makeDecision());
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { executeProposal }, // no resolver -> conservative default blocks
    });
    expect(result.executed).toEqual([]);
    expect(result.skipped[0]?.proposalId).toBe('proposal-x');
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('never acts on a non-user (system) or non-accept decision', async () => {
    const root = makeRoot();
    seed(root, makeProposal(), makeDecision({ actor: 'system' }));
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { resolveEligibility: () => eligibleInput, executeProposal },
    });
    // The system decision is never loaded as a candidate.
    expect(result.executed).toEqual([]);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('skips an ineligible decision with the gate reasons', async () => {
    const root = makeRoot();
    seed(root, makeProposal(), makeDecision());
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: {
        resolveEligibility: () => ({ ...eligibleInput, readinessLevel: 'field_shadow' }),
      },
    });
    expect(result.executed).toEqual([]);
    expect(result.skipped[0]?.blockReasons).toContain('readiness_below_trusted_operator');
  });

  it('does not execute when eligible but no executor is wired (executor absent -> inert)', async () => {
    const root = makeRoot();
    seed(root, makeProposal(), makeDecision());
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { resolveEligibility: () => eligibleInput }, // eligible, but no executeProposal
    });
    expect(result.enabled).toBe(true);
    expect(result.executed).toEqual([]);
  });

  it('skips proposals that already have a terminal execute/block decision', async () => {
    const root = makeRoot();
    seed(root, makeProposal({ status: 'accepted' }), makeDecision({ nextStatus: 'accepted' }));
    appendAoiProposalDecision(
      root,
      makeDecision({
        id: 'decision-exec',
        action: 'execute',
        actor: 'system',
        previousStatus: 'accepted',
        nextStatus: 'executed',
        createdAt: NOW - 100,
      }),
    );
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { resolveEligibility: () => eligibleInput, executeProposal },
    });
    expect(executeProposal).not.toHaveBeenCalled();
    expect(result.skipped.some((item) => item.blockReasons.includes('duplicate_attempt'))).toBe(
      true,
    );
  });

  it('the conservative default resolver treats a proposal with no acceptAction as run_command', async () => {
    const root = makeRoot();
    seed(root, makeProposal({ acceptAction: undefined }), makeDecision());
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' }, // no deps -> conservative default resolver
    });
    // run_command is NOT in the reversible class -> blocked, and also fails closed on checkpoint.
    expect(result.executed).toEqual([]);
    expect(result.skipped[0]?.blockReasons).toContain('not_reversible_class');
  });

  it('skips a decision whose proposal is no longer active', async () => {
    const root = makeRoot();
    // Seed the decision but NOT a matching active proposal.
    saveAoiActiveProposals(root, SESSION_PATH, []);
    appendAoiProposalDecision(root, makeDecision());
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { resolveEligibility: () => eligibleInput, executeProposal },
    });
    expect(result.executed).toEqual([]);
    expect(result.skipped).toEqual([
      { proposalId: 'proposal-x', blockReasons: ['proposal_not_executable'] },
    ]);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('caps executions at the per-session budget', async () => {
    const root = makeRoot();
    saveAoiActiveProposals(root, SESSION_PATH, [
      makeProposal({ id: 'proposal-1' }),
      makeProposal({ id: 'proposal-2' }),
    ]);
    appendAoiProposalDecision(root, makeDecision({ id: 'decision-1', proposalId: 'proposal-1' }));
    appendAoiProposalDecision(root, makeDecision({ id: 'decision-2', proposalId: 'proposal-2' }));
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      sessionBudget: 1,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: {
        resolveEligibility: ({ sessionBudgetRemaining }) => ({
          ...eligibleInput,
          sessionBudgetRemaining,
        }),
        executeProposal,
      },
    });
    // Budget 1 -> the second op sees sessionBudgetRemaining 0 and the gate blocks it.
    expect(result.executed).toHaveLength(1);
    expect(executeProposal).toHaveBeenCalledTimes(1);
  });

  it('consumes budget for a failed executor attempt and prevents a retry storm', async () => {
    const root = makeRoot();
    saveAoiActiveProposals(root, SESSION_PATH, [
      makeProposal({ id: 'proposal-1' }),
      makeProposal({ id: 'proposal-2' }),
    ]);
    appendAoiProposalDecision(
      root,
      makeDecision({ id: 'decision-1', proposalId: 'proposal-1', createdAt: NOW }),
    );
    appendAoiProposalDecision(
      root,
      makeDecision({ id: 'decision-2', proposalId: 'proposal-2', createdAt: NOW - 1 }),
    );
    const executeProposal = vi.fn(async () => ({ executed: false }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      sessionBudget: 1,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: {
        resolveEligibility: ({ sessionBudgetRemaining }) => ({
          ...eligibleInput,
          sessionBudgetRemaining,
        }),
        executeProposal,
      },
    });
    expect(executeProposal).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { proposalId: 'proposal-1', blockReasons: ['execution_failed'] },
        { proposalId: 'proposal-2', blockReasons: ['session_budget_exhausted'] },
      ]),
    );
  });

  it('consumes only the newest acceptance for a proposal and rejects duplicates', async () => {
    const root = makeRoot();
    saveAoiActiveProposals(root, SESSION_PATH, [makeProposal()]);
    appendAoiProposalDecision(root, makeDecision({ id: 'decision-old', createdAt: NOW - 2 }));
    appendAoiProposalDecision(root, makeDecision({ id: 'decision-new', createdAt: NOW - 1 }));
    const executeProposal = vi.fn(async () => ({ executed: true }));
    const result = await runAoiAutonomousExecuteLoop({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
      deps: { resolveEligibility: () => eligibleInput, executeProposal },
    });
    expect(executeProposal).toHaveBeenCalledTimes(1);
    expect(executeProposal).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: 'decision-new' }),
    );
    expect(result.skipped).toContainEqual({
      proposalId: 'proposal-x',
      blockReasons: ['duplicate_attempt'],
    });
  });
});
