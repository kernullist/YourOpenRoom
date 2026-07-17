// Aoi host-bridge gate (HP0): the single decision function every real-PC
// request passes through. It composes the four safety layers from
// docs/aoi-host-access-design.md in a fixed order into one allow/deny verdict:
//
//   0. authentication  -- the caller proved the local shared-secret token
//   1. kill switch     -- global panic off AND this capability explicitly enabled
//   2. consent         -- the backing environment-source is consented (read paths)
//   3. approval        -- irreversible capabilities carry a satisfied approval
//
// PURE + dependency-light: the effectful checks (token verify, kill-switch load,
// consent check, approval-sandbox validation) run in the caller/middleware and
// are passed in as already-resolved inputs. This keeps the composed policy fully
// unit-testable and makes the deny order and reasons auditable. The gate itself
// runs no I/O and never executes anything -- it only decides.
import {
  isAoiHostBridgeCapabilityEnabled,
  type AoiHostBridgeKillSwitchState,
} from './aoiHostBridgeKillSwitch';

export type AoiHostBridgeDenyReason =
  | 'not_authenticated'
  | 'host_bridge_panic'
  | 'capability_disabled'
  | 'source_not_consented'
  | 'approval_required';

export interface AoiHostBridgeGateInput {
  // Did the caller present a valid host-bridge auth token (verifyAoiHostBridgeToken)?
  authenticated: boolean;
  // The machine-level kill-switch state and the capability/source key to check.
  killSwitchState: AoiHostBridgeKillSwitchState | null | undefined;
  capabilityKey: string;
  // Whether this capability is irreversible (spawn/kill/delete) and therefore
  // requires a satisfied approval. Reversible reads leave this false.
  irreversible: boolean;
  // Result of checkAoiEnvironmentSourceOperation for the backing source. Omit
  // (undefined) for capabilities that are not gated by an environment source
  // (e.g. a mutate capability whose consent is expressed only via the kill
  // switch); when omitted, the consent layer is a pass.
  consent?: { allowed: boolean; reasons: string[] };
  // Approval-sandbox outcome for an irreversible capability. Required (and must
  // be satisfied) only when `irreversible` is true.
  approvalSatisfied?: boolean;
}

export interface AoiHostBridgeGateDecision {
  allowed: boolean;
  denyReasons: AoiHostBridgeDenyReason[];
  // Detail lines for audit/telemetry (e.g. the underlying consent reasons),
  // parallel to denyReasons but human/log oriented. Never gates on its own.
  detail: string[];
}

export function evaluateAoiHostBridgeGate(
  input: AoiHostBridgeGateInput,
): AoiHostBridgeGateDecision {
  const denyReasons: AoiHostBridgeDenyReason[] = [];
  const detail: string[] = [];

  // 0. Authentication is the outermost gate: an unauthenticated caller is
  //    rejected before any capability/consent state is even consulted.
  if (!input.authenticated) {
    denyReasons.push('not_authenticated');
  }

  // 1. Kill switch. Distinguish global panic from a per-capability disable so
  //    the operator sees WHY it was blocked. Panic dominates.
  if (input.killSwitchState?.globalPanic === true) {
    denyReasons.push('host_bridge_panic');
  } else if (!isAoiHostBridgeCapabilityEnabled(input.killSwitchState, input.capabilityKey)) {
    denyReasons.push('capability_disabled');
    detail.push(`capability_disabled:${input.capabilityKey}`);
  }

  // 2. Consent (environment-source), when this capability is source-gated.
  if (input.consent && !input.consent.allowed) {
    denyReasons.push('source_not_consented');
    for (const reason of input.consent.reasons) {
      detail.push(`consent:${reason}`);
    }
  }

  // 3. Approval for irreversible effects (spawn/kill/delete). A reversible read
  //    never reaches this branch.
  if (input.irreversible && input.approvalSatisfied !== true) {
    denyReasons.push('approval_required');
  }

  return {
    allowed: denyReasons.length === 0,
    denyReasons,
    detail,
  };
}
