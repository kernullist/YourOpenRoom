// Server-only report-back recorder for P2/B3-1 app-operation live dispatch.
//
// The autonomy loop queues an approved app_operation as a 'pending' dispatch record
// (see aoiAppOperationDispatch.ts + the execution wiring). A connected client bridge
// (slice 3) re-checks the content-addressed approval, dispatches the operation over
// the agent->app bus, captures the app's action_result, and POSTs it back here. This
// module applies that report: it updates the dispatch record in place
// (pending -> dispatched|failed), records a run-ledger event, and ingests an
// observation so the outcome is auditable on the operator timeline.
//
// SCOPE / SAFETY: this records the OUTCOME of an operation that already passed the
// L5 + content-addressed approval gate and the user's proposal acceptance. It does
// NOT feed trust calibration or readiness -- a client-reported result is not a field
// learning signal, and auto-feeding it would open a self-reinforcing vector. Trust
// learning stays on the existing operator / outcome-signal paths. Idempotent: a record
// that already reached a terminal state is never re-flipped by a late duplicate report.
//
// Server-only (fs + ledger + observation writes); never import from client-reachable code.
import { appendAoiAppOperationDispatch, loadAoiAppOperationDispatches } from './aoiAutonomyStore';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import { ingestAoiObservation } from './aoiAutonomyObserver';
import type { AoiAppOperationDispatch } from './aoiAutonomyTypes';

// Only the two terminal states a client bridge can report; 'pending' is never a report.
export type AoiAppOperationDispatchReportStatus = 'dispatched' | 'failed';

export interface AoiAppOperationDispatchResultInput {
  sessionsDir: string;
  sessionPath: string;
  id: string;
  status: AoiAppOperationDispatchReportStatus;
  actionResult?: string;
  failureReason?: string;
  now: number;
}

export interface AoiAppOperationDispatchResultOutcome {
  // False when no record matches the id (the route maps this to a 404).
  found: boolean;
  // The record after the update, or the existing terminal record on an idempotent
  // no-op; null only when nothing matched.
  dispatch: AoiAppOperationDispatch | null;
  // True when the record was already terminal and this report changed nothing.
  alreadyResolved: boolean;
}

const MAX_RESULT_CHARS = 2000;

// Bound a client-reported string and drop empties; the bridge result is untrusted
// input, so it is clamped before it lands in a durable record / observation.
function clampReportText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export function recordAoiAppOperationDispatchResult(
  input: AoiAppOperationDispatchResultInput,
): AoiAppOperationDispatchResultOutcome {
  const existing = loadAoiAppOperationDispatches(input.sessionsDir, input.sessionPath).find(
    (record) => record.id === input.id,
  );
  if (!existing) {
    return { found: false, dispatch: null, alreadyResolved: false };
  }
  // Idempotent: a record that already reached a terminal state is not re-reported, so
  // a late duplicate cannot flip dispatched <-> failed. Return it unchanged.
  if (existing.status !== 'pending') {
    return { found: true, dispatch: existing, alreadyResolved: true };
  }

  const actionResult = clampReportText(input.actionResult, MAX_RESULT_CHARS);
  const failureReason = clampReportText(input.failureReason, MAX_RESULT_CHARS);
  const updated: AoiAppOperationDispatch = {
    ...existing,
    status: input.status,
    updatedAt: input.now,
    ...(actionResult !== undefined ? { actionResult } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
  const saved = appendAoiAppOperationDispatch(input.sessionsDir, input.sessionPath, updated);

  const dispatched = saved.status === 'dispatched';
  const statusLabel = dispatched ? 'dispatched live' : 'failed';
  try {
    recordServerAoiRunLedgerEvent({
      sessionsDir: input.sessionsDir,
      sessionPath: input.sessionPath,
      type: dispatched ? 'app_operation_dispatch_executed' : 'app_operation_dispatch_failed',
      message: `App operation ${saved.actionType} on ${saved.appName} (#${saved.appId}) ${statusLabel}.`,
      goalSummary: `Aoi app operation dispatch: ${saved.actionType}`,
      toolNames: ['app_action'],
      status: dispatched ? 'completed' : 'failed',
      now: input.now,
    });
  } catch (error) {
    console.warn('[AoiAppOperationDispatch] Failed to record dispatch ledger event', error);
  }
  try {
    ingestAoiObservation(
      input.sessionsDir,
      {
        source: 'tool',
        sessionPath: input.sessionPath,
        stableKey: `app-op-dispatch:${saved.id}`,
        createdAt: input.now,
        summary: `App operation ${saved.actionType} on ${saved.appName} ${statusLabel}.`,
        payloadRef: `aoi-app-op-dispatch:${saved.id}`,
        memoryIds: [],
        artifactRefs: [
          ...new Set([
            `aoi-app-op-dispatch:${saved.id}`,
            ...(saved.proposalId ? [`proposal:${saved.proposalId}`] : []),
            ...(saved.decisionId ? [`decision:${saved.decisionId}`] : []),
            ...saved.evidenceRefs,
          ]),
        ].slice(0, 24),
        proposalIds: saved.proposalId ? [saved.proposalId] : [],
        riskSignals: [
          'app-operation-dispatch',
          dispatched ? 'app-operation-dispatch:dispatched' : 'app-operation-dispatch:failed',
        ],
      },
      { now: input.now },
    );
  } catch (error) {
    console.warn('[AoiAppOperationDispatch] Failed to ingest dispatch observation', error);
  }
  return { found: true, dispatch: saved, alreadyResolved: false };
}
