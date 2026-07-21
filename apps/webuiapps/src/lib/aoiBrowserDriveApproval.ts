// Aoi browser-drive per-ACT approval wiring (P2.3a): the bridge between the P2.2b
// executor's abstract approval gate and the REAL host-bridge approval store, plus
// the preview payload an operator approval card is built from.
//
// The whole point of Phase 2 is that an irreversible browser ACT (click/type/
// select/press/submit) runs ONLY after an explicit, per-action human approval. The
// executor asks an injected gate "is THIS exact action (by content-addressed
// fingerprint) approved?"; this module supplies:
//
//   1. buildAoiBrowserDriveActApprovalPreview -- a PURE function that turns
//      (plan, stepIndex) into the fingerprint + human-facing summary the preview
//      route records as a PENDING approval and the card renders (with the before-
//      screenshot). Read/forbidden/out-of-range steps are rejected: read needs no
//      approval, forbidden can never run, and only an ACT is approvable.
//
//   2. makeAoiBrowserDriveStoreApprovalGate -- a gate the execute route hands the
//      executor. It CONSUMES a matching operator-approved, unexpired, single-use
//      store entry; a missing/pending/expired entry is fail-closed (approved:false).
//      Consumption happens exactly once, at the gate, so echoing a preview never
//      runs anything.
//
// The fingerprint MUST be computed the same way the executor computes it
// (computeAoiBrowserDriveActionFingerprint) so the pending entry the preview
// records is the one the executor's gate consumes. SERVER-ONLY (the store is fs),
// but the store accessors are injected so the pure logic is unit-testable. Inert
// until P2.3b wires the routes.

import { AOI_BROWSER_DRIVE_CAPABILITY } from './aoiBrowserDrive';
import {
  classifyAoiBrowserDriveAction,
  type AoiBrowserDriveActionRequest,
} from './aoiBrowserDriveAction';
import {
  computeAoiBrowserDriveActionFingerprint,
  type AoiBrowserDriveApprovalGate,
} from './aoiBrowserDriveExecutor';
import { classifyAoiBrowserDrivePlan, type AoiBrowserDrivePlan } from './aoiBrowserDrivePlan';
import {
  consumeAoiHostBridgeApproval,
  recordAoiHostBridgePendingApproval,
  type AoiHostBridgeApprovalStoreData,
} from './aoiHostBridgeApprovalStore';
import {
  consumeAoiBrowserDriveStandingGrant,
  findLiveAoiBrowserDriveStandingGrant,
  type AoiBrowserDriveStandingGrantStore,
} from './aoiBrowserDriveStandingGrant';

export const AOI_BROWSER_DRIVE_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_SUMMARY = 200;

export type AoiBrowserDriveApprovalDenyReason =
  | 'step_out_of_range'
  | 'plan_inadmissible'
  | 'forbidden_step'
  | 'not_an_act';

export interface AoiBrowserDriveActApprovalPreview {
  ok: true;
  capability: string;
  fingerprint: string;
  stepIndex: number;
  action: AoiBrowserDriveActionRequest;
  description: string;
  // Short human-facing line for the store entry + approval card.
  targetSummary: string;
  hostname: string;
  beforeScreenshotBase64?: string;
  expiresAt: number;
}

export interface AoiBrowserDriveActApprovalRejection {
  ok: false;
  reason: AoiBrowserDriveApprovalDenyReason;
  detail?: string;
}

export type AoiBrowserDriveActApprovalOutcome =
  | AoiBrowserDriveActApprovalPreview
  | AoiBrowserDriveActApprovalRejection;

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_SUMMARY) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SUMMARY - 3).trimEnd()}...`;
}

function summarizeAction(action: AoiBrowserDriveActionRequest, hostname: string): string {
  const target = action.selector || action.url || action.targetText || '';
  const where = hostname ? ` on ${hostname}` : '';
  const detail = target ? ` ${target}` : '';
  return truncate(`${action.kind}${detail}${where}`);
}

/**
 * Build the approval preview for exactly one plan step. Only an admissible plan's
 * ACT step is approvable; a read step needs no approval, a forbidden step can never
 * run, and an out-of-range/inadmissible request is rejected. Pure.
 */
export function buildAoiBrowserDriveActApprovalPreview(params: {
  plan: AoiBrowserDrivePlan;
  stepIndex: number;
  hostname?: string;
  beforeScreenshotBase64?: string;
  now: number;
  ttlMs?: number;
  maxPlanSteps?: number;
}): AoiBrowserDriveActApprovalOutcome {
  const { plan, stepIndex } = params;

  const step = plan?.steps?.[stepIndex];
  if (!step || stepIndex < 0 || stepIndex >= (plan?.steps?.length ?? 0)) {
    return { ok: false, reason: 'step_out_of_range', detail: `no step at index ${stepIndex}` };
  }

  const decision = classifyAoiBrowserDriveAction(step.action);
  // Forbidden is checked before admissibility so it is always reported as such.
  if (decision.category === 'forbidden') {
    return { ok: false, reason: 'forbidden_step', detail: decision.reason };
  }

  const planClass = classifyAoiBrowserDrivePlan(plan, {
    ...(params.maxPlanSteps ? { maxSteps: params.maxPlanSteps } : {}),
  });
  if (!planClass.admissible) {
    return {
      ok: false,
      reason: 'plan_inadmissible',
      detail: planClass.rejectReasons.join(',') || 'inadmissible',
    };
  }

  if (decision.category !== 'act') {
    return { ok: false, reason: 'not_an_act', detail: 'read steps run without approval' };
  }

  const hostname = typeof params.hostname === 'string' ? params.hostname.trim().toLowerCase() : '';
  const ttlMs = Math.max(1_000, params.ttlMs ?? AOI_BROWSER_DRIVE_APPROVAL_TTL_MS);
  // Bind the acting host into the fingerprint so this approval can only be consumed
  // to act on the host the operator previewed (matches the executor, which computes
  // it from the live page host at act time). Empty host on both sides stays
  // consistent for the pre-browser reject pass.
  const fingerprint = computeAoiBrowserDriveActionFingerprint(
    plan.goal,
    stepIndex,
    step.action,
    hostname,
  );

  return {
    ok: true,
    capability: AOI_BROWSER_DRIVE_CAPABILITY,
    fingerprint,
    stepIndex,
    action: step.action,
    description: step.description,
    targetSummary: summarizeAction(step.action, hostname),
    hostname,
    ...(typeof params.beforeScreenshotBase64 === 'string'
      ? { beforeScreenshotBase64: params.beforeScreenshotBase64 }
      : {}),
    expiresAt: params.now + ttlMs,
  };
}

/**
 * Record a PENDING approval for a built preview so the execute gate cannot self-
 * approve by echoing the preview: the operator must explicitly approve the
 * fingerprint (reusing the existing /approvals/approve step).
 */
export function recordAoiBrowserDriveActPendingApproval(
  store: AoiHostBridgeApprovalStoreData | null | undefined,
  preview: AoiBrowserDriveActApprovalPreview,
  now: number,
): { store: AoiHostBridgeApprovalStoreData } {
  const recorded = recordAoiHostBridgePendingApproval(store, {
    capability: preview.capability,
    approvalFingerprint: preview.fingerprint,
    targetSummary: preview.targetSummary,
    expiresAt: preview.expiresAt,
    now,
  });
  return { store: recorded.store };
}

// Optional standing-grant fallback (P3.1): when the os_browser_drive_standing toggle
// is ON, a per-action inbox approval that is missing can be satisfied instead by a
// LIVE operator-created domain-wide grant covering the acting page's host. This is
// the ONLY relaxation of the per-ACT click, and it is domain-allowlist-bound + TTL +
// quota + panic-off (the caller sets `enabled` = capability toggle && !panic).
export interface AoiBrowserDriveStandingFallback {
  enabled: boolean;
  loadGrants: () => AoiBrowserDriveStandingGrantStore;
  saveGrants: (store: AoiBrowserDriveStandingGrantStore) => void;
}

export interface AoiBrowserDriveApprovalGateDeps {
  loadStore: () => AoiHostBridgeApprovalStoreData;
  saveStore: (store: AoiHostBridgeApprovalStoreData) => void;
  now: number;
  capability?: string;
  standing?: AoiBrowserDriveStandingFallback;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A store-backed approval gate for the executor. FIRST tries to consume a matching
 * operator-approved, unexpired, single-use per-action approval (Phase 2). If none
 * exists AND the standing fallback is enabled, it consumes one action from a LIVE
 * domain-wide grant covering the acting host (P3.1) and reports viaStanding. Anything
 * else is fail-closed.
 */
export function makeAoiBrowserDriveStoreApprovalGate(
  deps: AoiBrowserDriveApprovalGateDeps,
): AoiBrowserDriveApprovalGate {
  const capability = deps.capability ?? AOI_BROWSER_DRIVE_CAPABILITY;
  return async ({ fingerprint, url }) => {
    const consumed = consumeAoiHostBridgeApproval(deps.loadStore(), {
      capability,
      approvalFingerprint: fingerprint,
      now: deps.now,
    });
    if (consumed.ok) {
      deps.saveStore(consumed.store);
      return { approved: true };
    }
    // Standing-grant fallback: only when explicitly enabled by the caller.
    if (deps.standing?.enabled) {
      const hostname = hostnameOf(typeof url === 'string' ? url : '');
      if (hostname) {
        const grant = findLiveAoiBrowserDriveStandingGrant(
          deps.standing.loadGrants(),
          hostname,
          deps.now,
        );
        if (grant) {
          const result = consumeAoiBrowserDriveStandingGrant(
            deps.standing.loadGrants(),
            grant.id,
            deps.now,
          );
          if (result.consumed) {
            deps.standing.saveGrants(result.store);
            return { approved: true, viaStanding: true };
          }
        }
      }
    }
    return { approved: false, reason: consumed.reason ?? 'approval_missing' };
  };
}
