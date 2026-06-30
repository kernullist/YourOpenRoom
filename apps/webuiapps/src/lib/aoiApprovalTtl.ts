// Server-only gate for P2/B3-2 trust-bounded approval TTL. OFF by default.
//
// Per-execution the autonomy gate normally requires a FRESH acceptance (the user's
// accept decision within FRESH_ACCEPTANCE_MS = 10min); after that the loop needs a new
// human click. When this path is opted in AND the field-evidence readiness is at the
// trusted_operator rung, an approved app_operation may instead execute within a longer
// approval-valid-until WINDOW measured from the user's accept decision -- so the loop can
// act without a click every time, within bounds + audit. This only widens the RE-CLICK
// window; the content-addressed approval fingerprint compare + L5 + cwd checks are
// untouched, and only a pure app_operation is eligible (run_command / connector_call /
// file mutation stay strict). The trust signal is the SAME non-self-authorable readiness
// scorecard B2 used (it never reads the autonomy level -> no self-amplifying loop).
//
// Server-only (reads process.env by default); never import from client-reachable code.
import type { AoiJarvisReadinessScorecard } from './aoiJarvisReadinessScorecard';
import type { AoiProposalDecision } from './aoiAutonomyTypes';

// Default approval-valid-until window when the feature is on and no override is set.
export const AOI_APPROVAL_TTL_DEFAULT_MS = 60 * 60 * 1000; // 1h

// OFF by default. Independent of every other gate; when off the fresh-acceptance behavior
// is byte-identical (the default 10min window).
export function isAoiApprovalTtlEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AOI_AUTONOMY_APPROVAL_TTL === '1';
}

// The approval-valid-until window in ms. Positive-finite override only; anything else
// (unset / 0 / negative / non-numeric) falls back to the 1h default so the window is
// never accidentally infinite or zero.
export function resolveAoiApprovalTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AOI_AUTONOMY_APPROVAL_TTL_MS;
  if (raw === undefined) {
    return AOI_APPROVAL_TTL_DEFAULT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return AOI_APPROVAL_TTL_DEFAULT_MS;
  }
  return Math.floor(parsed);
}

// The only trust signal that may relax fresh-acceptance: a clean pass at the STRICT
// trusted_operator readiness rung (field evidence, reachable only via deliberate operator
// promotion -- not self-authorable). trusted_operator is the highest rung, so this is an
// exact-match check.
export function isAoiApprovalTtlTrustSatisfied(scorecard: AoiJarvisReadinessScorecard): boolean {
  return scorecard.gateStatus === 'pass' && scorecard.level === 'trusted_operator';
}

// Resolve the fresh-acceptance window for one execution. Returns the widened window (ms)
// ONLY when the flag is on AND the action is an eligible pure app_operation AND the
// readiness trust gate is satisfied; otherwise null (the caller keeps the default 10min).
export function resolveAoiApprovalTtlWindowMs(params: {
  enabled: boolean;
  eligibleAppOperation: boolean;
  scorecard: AoiJarvisReadinessScorecard | null;
  env?: Record<string, string | undefined>;
}): number | null {
  if (!params.enabled || !params.eligibleAppOperation || !params.scorecard) {
    return null;
  }
  if (!isAoiApprovalTtlTrustSatisfied(params.scorecard)) {
    return null;
  }
  return resolveAoiApprovalTtlMs(params.env);
}

// Whether the widened window was actually NEEDED for this execution -- i.e. the youngest
// matching accept decision is OLDER than the strict fresh-acceptance window (so it would
// have failed `missing_fresh_acceptance` without the TTL). Mirrors the gate's accept-
// decision matching (proposalId + action 'accept' + optional decisionId). Used only to
// stamp the audit marker when the loop acted on a stale approval, not on a fresh click.
export function wasAoiApprovalTtlWindowUsed(params: {
  decisions: AoiProposalDecision[] | undefined;
  proposalId: string;
  decisionId?: string;
  now: number;
  freshAcceptanceMs: number;
}): boolean {
  const matches = (params.decisions ?? []).filter((decision) => {
    if (decision.proposalId !== params.proposalId || decision.action !== 'accept') {
      return false;
    }
    if (params.decisionId && decision.id !== params.decisionId) {
      return false;
    }
    return true;
  });
  if (matches.length === 0) {
    return false;
  }
  const youngest = matches.reduce(
    (max, decision) => Math.max(max, decision.createdAt),
    Number.NEGATIVE_INFINITY,
  );
  return youngest + params.freshAcceptanceMs < params.now;
}
