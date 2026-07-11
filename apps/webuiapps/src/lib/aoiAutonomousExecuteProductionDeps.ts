// P2.3: the PRODUCTION wiring for the bounded autonomous-execute loop.
//
// aoiAutonomousExecuteLoop is the mechanism (default-OFF, consume-not-author, per-session
// budget) and aoiAutonomousExecuteEligibility is the pure gate (7 invariants). This module
// supplies the loop's two injected dependencies with REAL sourcing:
//   * resolveEligibility -- reads the standing approval off the human accept decision, recomputes
//     the current fingerprint from the proposal (drift check), derives the checkpoint signal from
//     the approval's recovery evidence, and stamps the once-per-run readiness level.
//   * executeProposal -- wraps executeAoiProposal (which independently re-checks the approval).
//
// EVERYTHING fails closed: only `app_action` is sourced here (it is the one reversible-class kind
// with a proposal->fingerprint recompute path today); every other kind, a missing/invalid standing
// approval, or a recompute error yields inputs that make the gate BLOCK. So imperfect sourcing can
// only ever over-block, never over-permit. The loop itself stays OFF unless AOI_AUTONOMY_SELF_EXECUTE
// is set, so wiring this changes nothing in production until it is explicitly enabled.
import { hasAoiApprovalSandboxRecoveryEvidence } from './aoiApprovalSandbox';
import { normalizeAoiApprovedAppActionPolicy } from './aoiApprovedAppActionPolicy';
import { getAoiApprovedAppActionPolicyForProposal } from './aoiAutonomyPolicy';
import { executeAoiProposal } from './aoiAutonomyExecution';
import {
  runAoiAutonomousExecuteLoop,
  type AoiAutonomousExecuteLoopDeps,
  type AoiAutonomousExecuteLoopResult,
} from './aoiAutonomousExecuteLoop';
import type { AoiAutonomousExecuteEligibilityInput } from './aoiAutonomousExecuteEligibility';
import { buildAoiServerJarvisReadinessScorecard } from './aoiServerJarvisGovernor';
import type { AoiJarvisReadinessLevel } from './aoiJarvisReadinessScorecard';
import type { AoiProposal, AoiProposalDecision } from './aoiAutonomyTypes';

export interface AoiAutonomousExecuteProductionContext {
  sessionsDir: string;
  sessionPath: string;
  configFile: string;
  serverOrigin: string;
  workspaceRoot?: string;
  // Readiness computed ONCE per loop run by the caller (buildAoiServerJarvisAutonomyGovernor /
  // the readiness scorecard). The gate requires 'trusted_operator'; anything lower blocks.
  readinessLevel: AoiJarvisReadinessLevel;
  // Injected in tests so no real execution happens. Defaults to executeAoiProposal.
  executeProposalFn?: typeof executeAoiProposal;
}

function actorOf(decision: AoiProposalDecision): 'user' | 'aoi' | null {
  if (decision.actor === 'user') {
    return 'user';
  }
  // The daemon / loop authors decisions as 'system'. Any non-human author is an aoi-authored
  // acceptance and must NEVER be self-executed (the no-self-promotion barrier).
  if (decision.actor === 'system') {
    return 'aoi';
  }
  return null;
}

// A fully-blocking eligibility input: no checkpoint, no approval, unverifiable fingerprint. The
// gate rejects it; the actionKind / readiness / actor / budget are still real for observability.
function blockedInput(
  base: Pick<
    AoiAutonomousExecuteEligibilityInput,
    'actionKind' | 'readinessLevel' | 'sessionBudgetRemaining' | 'acceptDecisionActor' | 'now'
  >,
  approvalFingerprint: string | null = null,
  approvalExpiresAt: number | null = null,
): AoiAutonomousExecuteEligibilityInput {
  return {
    ...base,
    hasCheckpoint: false,
    approvalFingerprint,
    currentFingerprint: '',
    approvalExpiresAt,
  };
}

export function createAoiAutonomousExecuteProductionDeps(
  context: AoiAutonomousExecuteProductionContext,
): AoiAutonomousExecuteLoopDeps {
  return {
    resolveEligibility: (params: {
      decision: AoiProposalDecision;
      proposal: AoiProposal;
      sessionBudgetRemaining: number;
      now: number;
    }): AoiAutonomousExecuteEligibilityInput => {
      const actionKind = params.proposal.acceptAction?.kind ?? 'run_command';
      const base = {
        actionKind,
        readinessLevel: context.readinessLevel,
        sessionBudgetRemaining: params.sessionBudgetRemaining,
        acceptDecisionActor: actorOf(params.decision),
        now: params.now,
      };
      // Only app_action is sourced today; every other kind fails closed (the gate also blocks
      // non-reversible kinds outright via not_reversible_class).
      if (actionKind !== 'app_action') {
        return blockedInput(base);
      }
      // The STANDING approval must come from the human accept decision, not a recompute -- that is
      // what a drift check compares against.
      const standing = normalizeAoiApprovedAppActionPolicy(params.decision.approvedAppAction);
      if (!standing) {
        return blockedInput(base);
      }
      let current;
      try {
        current = getAoiApprovedAppActionPolicyForProposal(params.proposal, params.now);
      } catch {
        // Cannot recompute -> currentFingerprint stays '' -> the gate blocks on mismatch.
        return blockedInput(base, standing.approvalFingerprint, standing.expiresAt);
      }
      return {
        ...base,
        hasCheckpoint: hasAoiApprovalSandboxRecoveryEvidence(current.approvalSandbox),
        approvalFingerprint: standing.approvalFingerprint,
        currentFingerprint: current.approvalFingerprint,
        approvalExpiresAt: standing.expiresAt,
      };
    },
    executeProposal: async (params: {
      proposalId: string;
      decisionId: string;
      now: number;
    }): Promise<{ executed: boolean }> => {
      const execute = context.executeProposalFn ?? executeAoiProposal;
      const result = await execute({
        sessionsDir: context.sessionsDir,
        configFile: context.configFile,
        serverOrigin: context.serverOrigin,
        workspaceRoot: context.workspaceRoot,
        sessionPath: context.sessionPath,
        proposalId: params.proposalId,
        decisionId: params.decisionId,
        now: params.now,
      });
      return { executed: result.executed === true };
    },
  };
}

// The daemon wakeup entry point. ENV-GATE FIRST: in production (AOI_AUTONOMY_SELF_EXECUTE unset)
// this returns inert WITHOUT computing readiness, building deps, or touching the execute path --
// a near-zero-cost no-op. Only when explicitly enabled does it resolve readiness once, build the
// production deps, and run the bounded loop. The scheduler calls this best-effort so it can never
// break a wakeup.
export async function runAoiAutonomousExecuteForWakeup(params: {
  sessionsDir: string;
  sessionPath: string;
  configFile: string;
  serverOrigin: string;
  workspaceRoot?: string;
  now: number;
  sessionBudget?: number;
  env?: Record<string, string | undefined>;
  // Test injection: skip the real readiness computation / real deps.
  readinessLevel?: AoiJarvisReadinessLevel;
  deps?: AoiAutonomousExecuteLoopDeps;
}): Promise<AoiAutonomousExecuteLoopResult> {
  const env = params.env ?? process.env;
  if (env.AOI_AUTONOMY_SELF_EXECUTE !== '1') {
    return { enabled: false, executed: [], skipped: [] };
  }
  const readinessLevel =
    params.readinessLevel ??
    buildAoiServerJarvisReadinessScorecard({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      now: params.now,
    }).level;
  const deps =
    params.deps ??
    createAoiAutonomousExecuteProductionDeps({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      configFile: params.configFile,
      serverOrigin: params.serverOrigin,
      workspaceRoot: params.workspaceRoot,
      readinessLevel,
    });
  return runAoiAutonomousExecuteLoop({
    sessionsDir: params.sessionsDir,
    sessionPath: params.sessionPath,
    now: params.now,
    sessionBudget: params.sessionBudget,
    env,
    deps,
  });
}
