// P2.3: the bounded autonomous-execute loop -- the real-effect step, built CONSERVATIVELY.
//
// It CONSULTS the eligibility gate (aoiAutonomousExecuteEligibility, which encodes all 7 safety
// invariants) and self-invokes the executor ONLY for a gate-passing op. Every safety layer is
// stacked:
//   * OFF by default -- inert unless the operator enables it in Settings ->
//     Advanced -> Autonomy (config.json: aoiAutonomyCapabilities.selfExecuteEnabled),
//     or, for a headless deployment with no config block, AOI_AUTONOMY_SELF_EXECUTE === '1'.
//   * CONSUME, never AUTHOR -- it only ever acts on decisions a human already ACCEPTED
//     (actor 'user', action 'accept'); it never creates an acceptance.
//   * fail-closed eligibility -- the default resolver blocks everything (no checkpoint / no
//     approval), so even with the env gate on nothing runs until a real resolver is wired; the
//     eligibility gate then re-checks the reversible class / checkpoint / approval / readiness /
//     budget / user-actor before anything executes.
//   * the executor (executeAoiProposal) independently re-checks the content-addressed approval,
//     so a bug here cannot bypass that.
//   * a per-session budget caps how many ops a single run may execute.
//
// The eligibility resolver + the executor are injectable so the loop is unit-testable without
// real stores or real execution.
import { loadAoiActiveProposals, loadAoiProposalDecisions } from './aoiAutonomyStore';
import { loadAoiAutonomyCapabilitySettings } from './aoiAutonomyCapabilitySettings';
import {
  classifyAoiAutonomousExecuteEligibility,
  type AoiAutonomousExecuteBlockReason,
  type AoiAutonomousExecuteEligibilityInput,
} from './aoiAutonomousExecuteEligibility';
import type { AoiProposal, AoiProposalDecision } from './aoiAutonomyTypes';

const DEFAULT_SESSION_BUDGET = 3;

export interface AoiAutonomousExecuteLoopSkipped {
  proposalId: string;
  blockReasons: AoiAutonomousExecuteBlockReason[];
}

export interface AoiAutonomousExecuteLoopResult {
  enabled: boolean;
  executed: string[];
  skipped: AoiAutonomousExecuteLoopSkipped[];
}

export interface AoiAutonomousExecuteLoopDeps {
  // Resolve the full eligibility input for a user-accepted decision + its proposal. The DEFAULT
  // is conservative (no checkpoint, no approval on file) so the gate blocks and the loop stays
  // inert until a real resolver is wired. Injected in tests.
  resolveEligibility?: (params: {
    decision: AoiProposalDecision;
    proposal: AoiProposal;
    sessionBudgetRemaining: number;
    now: number;
  }) => AoiAutonomousExecuteEligibilityInput;
  // Execute an ELIGIBLE proposal (default wraps executeAoiProposal). Injected in tests so no
  // real execution happens.
  executeProposal?: (params: {
    proposalId: string;
    decisionId: string;
    now: number;
  }) => Promise<{ executed: boolean }>;
}

// The conservative default: fail closed on everything the loop cannot verify itself (no
// checkpoint, no approval, sub-trusted readiness), so the default loop never executes.
function conservativeResolve(params: {
  decision: AoiProposalDecision;
  proposal: AoiProposal;
  sessionBudgetRemaining: number;
  now: number;
}): AoiAutonomousExecuteEligibilityInput {
  return {
    actionKind: params.proposal.acceptAction?.kind ?? 'run_command',
    hasCheckpoint: false,
    approvalFingerprint: null,
    currentFingerprint: '',
    approvalExpiresAt: null,
    readinessLevel: 'field_shadow',
    sessionBudgetRemaining: params.sessionBudgetRemaining,
    acceptDecisionActor: params.decision.actor === 'user' ? 'user' : null,
    now: params.now,
  };
}

export async function runAoiAutonomousExecuteLoop(params: {
  sessionsDir: string;
  sessionPath: string;
  now: number;
  sessionBudget?: number;
  // Where the operator's setting lives. Omitted -> env-only, which is what a
  // headless caller (and every existing test) gets.
  configFile?: string;
  env?: Record<string, string | undefined>;
  deps?: AoiAutonomousExecuteLoopDeps;
}): Promise<AoiAutonomousExecuteLoopResult> {
  const env = params.env ?? process.env;
  // OFF by default. The settings UI owns this now; the env var stays the
  // fallback, and the safety gate below is untouched either way -- this only
  // decides whether the gate is consulted at all.
  const capabilities = loadAoiAutonomyCapabilitySettings({
    ...(params.configFile ? { configFile: params.configFile } : {}),
    env,
  });
  if (!capabilities.selfExecute) {
    return { enabled: false, executed: [], skipped: [] };
  }

  const resolveEligibility = params.deps?.resolveEligibility ?? conservativeResolve;
  const executeProposal = params.deps?.executeProposal;
  const allDecisions = loadAoiProposalDecisions(params.sessionsDir, params.sessionPath);
  // Terminal execute/block decisions mark a proposal as already attempted so a
  // failed self-execute does not burn budget every wakeup forever.
  const terminalAttemptProposalIds = new Set(
    allDecisions
      .filter(
        (decision) =>
          decision.action === 'execute' ||
          decision.action === 'block' ||
          decision.nextStatus === 'executed' ||
          decision.nextStatus === 'blocked',
      )
      .map((decision) => decision.proposalId),
  );
  const proposalsById = new Map(
    loadAoiActiveProposals(params.sessionsDir, params.sessionPath)
      .filter((proposal) => proposal.status === 'active' || proposal.status === 'accepted')
      .map((proposal) => [proposal.id, proposal]),
  );
  // CONSUME, never AUTHOR: only human-accepted decisions.
  const decisions = allDecisions.filter(
    (decision) => decision.actor === 'user' && decision.action === 'accept',
  );

  let budgetRemaining = params.sessionBudget ?? DEFAULT_SESSION_BUDGET;
  const executed: string[] = [];
  const skipped: AoiAutonomousExecuteLoopSkipped[] = [];
  const processedProposalIds = new Set<string>();

  for (const decision of decisions) {
    if (processedProposalIds.has(decision.proposalId)) {
      skipped.push({ proposalId: decision.proposalId, blockReasons: ['duplicate_attempt'] });
      continue;
    }
    processedProposalIds.add(decision.proposalId);
    if (terminalAttemptProposalIds.has(decision.proposalId)) {
      skipped.push({ proposalId: decision.proposalId, blockReasons: ['duplicate_attempt'] });
      continue;
    }
    const proposal = proposalsById.get(decision.proposalId);
    if (!proposal) {
      skipped.push({ proposalId: decision.proposalId, blockReasons: ['proposal_not_executable'] });
      continue;
    }
    if (proposal.status === 'executed' || proposal.status === 'blocked') {
      skipped.push({ proposalId: decision.proposalId, blockReasons: ['duplicate_attempt'] });
      continue;
    }
    const input = resolveEligibility({
      decision,
      proposal,
      sessionBudgetRemaining: budgetRemaining,
      now: params.now,
    });
    const eligibility = classifyAoiAutonomousExecuteEligibility(input);
    if (!eligibility.eligible) {
      skipped.push({ proposalId: decision.proposalId, blockReasons: eligibility.blockReasons });
      continue;
    }
    // Eligible: self-invoke the executor (which independently re-checks the approval).
    if (!executeProposal) {
      continue;
    }
    let result: { executed: boolean };
    try {
      result = await executeProposal({
        proposalId: decision.proposalId,
        decisionId: decision.id,
        now: params.now,
      });
    } catch {
      budgetRemaining -= 1;
      skipped.push({ proposalId: decision.proposalId, blockReasons: ['execution_failed'] });
      continue;
    }
    // Eligibility was consumed and an executor attempt occurred. Failed attempts
    // spend budget too, preventing a retry storm from bypassing the session cap.
    budgetRemaining -= 1;
    if (result.executed) {
      executed.push(decision.proposalId);
    } else {
      skipped.push({ proposalId: decision.proposalId, blockReasons: ['execution_failed'] });
    }
  }

  return { enabled: true, executed, skipped };
}
