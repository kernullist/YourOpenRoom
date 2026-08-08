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
// EVERYTHING fails closed: app_action plus exact-scope file_write/file_patch are sourced here.
// File self-execution additionally requires an approved before/after SHA-256 plan and a successful
// read-only checkpoint preflight whose captured target fingerprint still matches that plan. Every
// other kind, a missing/invalid standing approval, or a recompute/preflight error BLOCKS. The loop
// itself stays OFF unless AOI_AUTONOMY_SELF_EXECUTE is set.
import { createAoiActionCheckpoint } from './aoiActionCheckpoint';
import { loadAoiAutonomyCapabilitySettings } from './aoiAutonomyCapabilitySettings';
import { hasAoiApprovalSandboxRecoveryEvidence } from './aoiApprovalSandbox';
import { normalizeAoiApprovedAppActionPolicy } from './aoiApprovedAppActionPolicy';
import { normalizeAoiApprovedFileMutationPolicy } from './aoiApprovedFileMutationPolicy';
import {
  getAoiApprovedAppActionPolicyForProposal,
  getAoiApprovedFileMutationPolicyForProposal,
} from './aoiAutonomyPolicy';
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
      if (actionKind === 'file_write' || actionKind === 'file_patch') {
        const standing = normalizeAoiApprovedFileMutationPolicy(
          params.decision.approvedFileMutation,
        );
        if (!standing) {
          return blockedInput(base);
        }
        let current;
        try {
          current = getAoiApprovedFileMutationPolicyForProposal(params.proposal, params.now);
        } catch {
          return blockedInput(base, standing.approvalFingerprint, standing.expiresAt);
        }
        let hasCheckpoint = false;
        let targetFingerprintMatches = false;
        const exactScope =
          current.allowed &&
          current.pathLabel.length > 0 &&
          current.operation === (actionKind === 'file_patch' ? 'patch' : 'write');
        const hasValidationPlan = Boolean(current.validationPlan && standing.validationPlan);
        if (exactScope && hasValidationPlan && context.workspaceRoot) {
          try {
            const checkpoint = createAoiActionCheckpoint({
              workspaceRoot: context.workspaceRoot,
              paths: [current.pathLabel],
              now: params.now,
              evidenceRefs: [
                `proposal:${params.proposal.id}`,
                `decision:${params.decision.id}`,
                ...params.proposal.evidenceRefs,
                ...params.proposal.artifactRefs,
              ],
            });
            const entry = checkpoint.entries[0];
            const capturedFingerprint = entry?.existedBefore ? entry.sha256 : 'absent';
            hasCheckpoint = checkpoint.entries.length === 1 && Boolean(capturedFingerprint);
            targetFingerprintMatches =
              capturedFingerprint === current.validationPlan?.expectedBeforeSha256;
          } catch {
            hasCheckpoint = false;
            targetFingerprintMatches = false;
          }
        }
        return {
          ...base,
          hasCheckpoint,
          exactScope,
          hasValidationPlan,
          targetFingerprintMatches,
          approvalFingerprint: standing.approvalFingerprint,
          currentFingerprint: current.approvalFingerprint,
          approvalExpiresAt: standing.expiresAt,
        };
      }
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

// The daemon wakeup entry point. CAPABILITY GATE FIRST: when the operator has not
// enabled self-execute (Settings -> Advanced -> Autonomy, or AOI_AUTONOMY_SELF_EXECUTE
// for a headless deployment) this returns inert WITHOUT computing readiness, building
// deps, or touching the execute path -- a near-zero-cost no-op. Only when explicitly
// enabled does it resolve readiness once, build the production deps, and run the
// bounded loop. The scheduler calls this best-effort so it can never break a wakeup.
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
  const capabilities = loadAoiAutonomyCapabilitySettings({ configFile: params.configFile, env });
  if (!capabilities.selfExecute) {
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
    // Forwarded so the loop's own gate resolves from the same source; without it
    // the inner check would fall back to env and refuse what the UI enabled.
    configFile: params.configFile,
    env,
    deps,
  });
}
