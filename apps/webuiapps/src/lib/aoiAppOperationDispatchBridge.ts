// Client-side bridge logic for P2/B3-1 app-operation live dispatch.
//
// The autonomy loop runs server-side and cannot postMessage to an app iframe, so an
// approved app_operation is QUEUED as a 'pending' dispatch record (c1 + c2). This module
// is the pure, injectable core of the connected client's bridge: for each pending record
// it re-checks the content-addressed approval, publishes the action to the target app
// over the agent->app bus, captures the app's action_result, and reports the terminal
// result back. ChatPanel wires the real dependencies (fetch / fingerprint recompute /
// agent-message publish / report POST); this module owns only the decision logic so it
// is unit-testable without a live app or a server.
//
// SAFETY: the queued op already passed the L5 + content-addressed approval gate and the
// user's proposal acceptance. The re-check here is a tamper guard -- if the proposal's
// CURRENT approval fingerprint no longer matches the queued one (or the proposal is gone),
// the op is NOT dispatched; it is reported failed so the loop stops retrying it. An app
// that is not loaded in this client leaves the record pending (a different client, or a
// later refresh, can pick it up) -- live dispatch is intentionally not fully headless.
import type { AoiAppOperationDispatch, AoiProposal } from './aoiAutonomyTypes';

// What the per-record bridge decided. 'unavailable' is the only non-terminal result --
// the record stays pending for a future refresh / another connected client.
export type AoiAppOperationDispatchBridgeResultKind =
  | 'dispatched'
  | 'failed'
  | 'unavailable'
  | 'approval_mismatch'
  | 'proposal_not_found';

export interface AoiAppOperationDispatchBridgeOutcome {
  recordId: string;
  result: AoiAppOperationDispatchBridgeResultKind;
  detail?: string;
}

export interface AoiAppOperationDispatchBridgeSummary {
  outcomes: AoiAppOperationDispatchBridgeOutcome[];
  dispatched: number;
  failed: number;
  // Records left 'pending' because the target app is not loaded in this client.
  unavailable: number;
}

export interface AoiAppOperationDispatchBridgeReport {
  id: string;
  status: 'dispatched' | 'failed';
  actionResult?: string;
  failureReason?: string;
}

export interface AoiAppOperationDispatchBridgeDeps {
  // Find the source proposal (active or archived) for a dispatch, for the approval
  // re-check. Returns null when the proposal can no longer be resolved.
  lookupProposal: (proposalId: string) => AoiProposal | null;
  // Recompute the proposal's CURRENT content-addressed approval fingerprint. May throw
  // for a malformed proposal -> treated as a failed re-check (never dispatched).
  recomputeApprovalFingerprint: (proposal: AoiProposal) => string;
  // Publish the action to the target app over the agent->app bus and capture its
  // action_result. Resolve a string = the app's action_result; resolve null = the app is
  // NOT loaded in this client (leave the record pending); throw = a transport / dispatch
  // error (reported failed).
  dispatchToApp: (record: AoiAppOperationDispatch) => Promise<string | null>;
  // Report the terminal result back to the server (the c2 POST route). Best-effort: a
  // report failure is swallowed so one record cannot abort the batch.
  reportResult: (report: AoiAppOperationDispatchBridgeReport) => Promise<void>;
}

const MAX_DETAIL_CHARS = 500;

function clampDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? trimmed.slice(0, MAX_DETAIL_CHARS) : trimmed;
}

// An app handler returns 'error: {reason}' on failure (the data-interaction convention),
// so an action_result that starts with "error" is recorded as a failed dispatch.
function isAppErrorResult(actionResult: string): boolean {
  return /^\s*error\b/i.test(actionResult);
}

async function safeReport(
  deps: AoiAppOperationDispatchBridgeDeps,
  report: AoiAppOperationDispatchBridgeReport,
): Promise<void> {
  try {
    await deps.reportResult(report);
  } catch (error) {
    console.warn('[AoiAppOperationDispatchBridge] Failed to report dispatch result', error);
  }
}

// Process one pending record. Returns the bridge decision for it; reportResult is invoked
// for every terminal outcome (dispatched | failed), never for 'unavailable'.
async function processOne(
  deps: AoiAppOperationDispatchBridgeDeps,
  record: AoiAppOperationDispatch,
): Promise<AoiAppOperationDispatchBridgeOutcome> {
  if (record.status !== 'pending') {
    // Defensive: the GET route returns only pending records, but never re-dispatch a
    // terminal one if a caller passes it in.
    return { recordId: record.id, result: 'unavailable', detail: 'not_pending' };
  }
  if (!record.proposalId) {
    await safeReport(deps, {
      id: record.id,
      status: 'failed',
      failureReason: 'missing_proposal_reference',
    });
    return { recordId: record.id, result: 'failed', detail: 'missing_proposal_reference' };
  }
  const proposal = deps.lookupProposal(record.proposalId);
  if (!proposal) {
    await safeReport(deps, {
      id: record.id,
      status: 'failed',
      failureReason: 'proposal_not_found',
    });
    return { recordId: record.id, result: 'proposal_not_found', detail: 'proposal_not_found' };
  }
  let currentFingerprint: string;
  try {
    currentFingerprint = deps.recomputeApprovalFingerprint(proposal);
  } catch (error) {
    await safeReport(deps, {
      id: record.id,
      status: 'failed',
      failureReason: 'approval_recheck_failed',
    });
    return {
      recordId: record.id,
      result: 'approval_mismatch',
      detail: error instanceof Error ? clampDetail(error.message) : 'approval_recheck_failed',
    };
  }
  if (currentFingerprint !== record.approvalFingerprint) {
    // The proposal's approval no longer matches what was queued (tamper / change since
    // queueing). Do NOT dispatch; report failed so the loop stops retrying it.
    await safeReport(deps, {
      id: record.id,
      status: 'failed',
      failureReason: 'approval_fingerprint_mismatch',
    });
    return {
      recordId: record.id,
      result: 'approval_mismatch',
      detail: 'approval_fingerprint_mismatch',
    };
  }

  let actionResult: string | null;
  try {
    actionResult = await deps.dispatchToApp(record);
  } catch (error) {
    const failureReason = error instanceof Error ? clampDetail(error.message) : 'dispatch_error';
    await safeReport(deps, { id: record.id, status: 'failed', failureReason });
    return { recordId: record.id, result: 'failed', detail: failureReason };
  }
  if (actionResult === null) {
    // The target app is not loaded in this client -> leave the record pending.
    return { recordId: record.id, result: 'unavailable', detail: 'app_not_loaded' };
  }
  if (isAppErrorResult(actionResult)) {
    await safeReport(deps, {
      id: record.id,
      status: 'failed',
      failureReason: clampDetail(actionResult),
    });
    return { recordId: record.id, result: 'failed', detail: clampDetail(actionResult) };
  }
  await safeReport(deps, {
    id: record.id,
    status: 'dispatched',
    actionResult: clampDetail(actionResult),
  });
  return { recordId: record.id, result: 'dispatched' };
}

// Process the pending dispatches sequentially (small queue; sequential avoids racing the
// agent->app bus and keeps ordering deterministic). Per-record isolation: one record's
// failure never aborts the batch.
export async function runAoiAppOperationDispatchBridge(
  pending: readonly AoiAppOperationDispatch[],
  deps: AoiAppOperationDispatchBridgeDeps,
): Promise<AoiAppOperationDispatchBridgeSummary> {
  const outcomes: AoiAppOperationDispatchBridgeOutcome[] = [];
  for (const record of pending) {
    try {
      outcomes.push(await processOne(deps, record));
    } catch (error) {
      // Defensive: processOne already isolates its steps, but never let an unexpected
      // throw abort the remaining records.
      console.warn('[AoiAppOperationDispatchBridge] Unexpected error processing dispatch', error);
      outcomes.push({
        recordId: record.id,
        result: 'failed',
        detail: error instanceof Error ? clampDetail(error.message) : 'unexpected_error',
      });
    }
  }
  return {
    outcomes,
    dispatched: outcomes.filter((outcome) => outcome.result === 'dispatched').length,
    failed: outcomes.filter(
      (outcome) =>
        outcome.result === 'failed' ||
        outcome.result === 'proposal_not_found' ||
        outcome.result === 'approval_mismatch',
    ).length,
    unavailable: outcomes.filter((outcome) => outcome.result === 'unavailable').length,
  };
}
