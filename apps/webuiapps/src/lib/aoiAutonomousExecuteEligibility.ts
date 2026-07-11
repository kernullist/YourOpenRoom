// P2.3: bounded autonomous execute -- the SAFE eligibility GATE (this module NEVER executes).
//
// The loop is propose-only; it never self-invokes the executor. Enabling that for even a narrow
// class is the single most dangerous roadmap step, so the decision of WHAT is eligible is
// isolated here as a pure, fail-closed classifier that captures ALL of the safety invariants.
// A future caller may consult it before self-invoking executeAoiProposal, but this module
// itself performs no side effect, no I/O, and authors nothing.
//
// The invariants (every one must hold; any miss => blocked):
//   1. Reversible class ONLY -- checkpoint-backed file_write / file_patch / app_action. Every
//      irreversible / irreversible-adjacent kind (run_command, connector_call, file_delete,
//      create_kira_work, ...) is OUT of the class.
//   2. A rollback checkpoint exists -- an effect that cannot be bounded/rolled back stays out.
//   3. A standing content-addressed approval is present AND its fingerprint still matches the
//      proposal's current fingerprint (no drift between approve and execute).
//   4. The approval-TTL window is still open.
//   5. Readiness is at trusted_operator (the top band).
//   6. The per-session autonomous-execute budget has room.
//   7. CONSUME, never AUTHOR: the accept decision must be human-authored (actor 'user') -- the
//      no-self-promotion barrier. A loop-authored acceptance is never self-executed.
//
// L5 stays human by construction: connector_call (the only L5 kind here) is not in the class.
import type { AoiProposalAcceptActionKind } from './aoiAutonomyTypes';
import type { AoiJarvisReadinessLevel } from './aoiJarvisReadinessScorecard';

// The ONLY action kinds eligible for bounded autonomous execution: reversible + checkpoint-able.
export const AOI_AUTONOMOUS_EXECUTE_REVERSIBLE_CLASS: ReadonlySet<AoiProposalAcceptActionKind> =
  new Set<AoiProposalAcceptActionKind>(['file_write', 'file_patch', 'app_action']);

export type AoiAutonomousExecuteBlockReason =
  | 'not_reversible_class'
  | 'checkpoint_missing'
  | 'approval_missing'
  | 'approval_fingerprint_mismatch'
  | 'approval_expired'
  | 'readiness_below_trusted_operator'
  | 'session_budget_exhausted'
  | 'accept_decision_not_user_authored';

export interface AoiAutonomousExecuteEligibilityInput {
  actionKind: AoiProposalAcceptActionKind;
  // Whether a rollback checkpoint (touched-scope snapshot / backup) exists for this effect.
  hasCheckpoint: boolean;
  // The standing content-addressed approval fingerprint (null when none is on file).
  approvalFingerprint: string | null;
  // The proposal's current content-addressed fingerprint (recomputed at execute time).
  currentFingerprint: string;
  // The approval-TTL window end (null when none).
  approvalExpiresAt: number | null;
  readinessLevel: AoiJarvisReadinessLevel;
  // Remaining room in the per-session autonomous-execute budget.
  sessionBudgetRemaining: number;
  // Who authored the accept decision being consumed. Only a human 'user' acceptance qualifies.
  acceptDecisionActor: 'user' | 'aoi' | null;
  now: number;
}

export interface AoiAutonomousExecuteEligibility {
  eligible: boolean;
  blockReasons: AoiAutonomousExecuteBlockReason[];
}

// Pure, fail-closed. Collects ALL failing gates (not just the first) for observability. Returns
// eligible only when every invariant holds.
export function classifyAoiAutonomousExecuteEligibility(
  input: AoiAutonomousExecuteEligibilityInput,
): AoiAutonomousExecuteEligibility {
  const blockReasons: AoiAutonomousExecuteBlockReason[] = [];

  if (!AOI_AUTONOMOUS_EXECUTE_REVERSIBLE_CLASS.has(input.actionKind)) {
    blockReasons.push('not_reversible_class');
  }
  if (!input.hasCheckpoint) {
    blockReasons.push('checkpoint_missing');
  }
  if (typeof input.approvalFingerprint !== 'string' || input.approvalFingerprint.length === 0) {
    blockReasons.push('approval_missing');
  } else if (input.approvalFingerprint !== input.currentFingerprint) {
    blockReasons.push('approval_fingerprint_mismatch');
  }
  if (typeof input.approvalExpiresAt !== 'number' || input.approvalExpiresAt <= input.now) {
    blockReasons.push('approval_expired');
  }
  if (input.readinessLevel !== 'trusted_operator') {
    blockReasons.push('readiness_below_trusted_operator');
  }
  if (!(input.sessionBudgetRemaining > 0)) {
    blockReasons.push('session_budget_exhausted');
  }
  if (input.acceptDecisionActor !== 'user') {
    blockReasons.push('accept_decision_not_user_authored');
  }

  return { eligible: blockReasons.length === 0, blockReasons };
}
