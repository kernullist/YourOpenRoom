// Server-only logic for P2/B3-1 app-operation live dispatch (client-mediated).
//
// The autonomy loop runs server-side and cannot postMessage to an app iframe, so an
// approved app_operation is normally handed off to a Kira review. When this path is
// opted in, the loop instead QUEUES the approved operation as a dispatch record; a
// connected client bridge (slice 3) dispatches it over the agent->app bus and reports
// the result back. This module only GATES + SHAPES the queued record -- nothing here
// executes anything, and it queues an operation that already passed the L5 +
// content-addressed approval gate and the user's proposal acceptance.
//
// OFF by default. Server-only (reads process.env by default); never import from
// client-reachable code.
import { loadAoiAutonomyCapabilitySettings } from './aoiAutonomyCapabilitySettings';
import type { AoiAppOperationDispatch } from './aoiAutonomyTypes';

// OFF by default. When enabled, an approved app_operation is queued for
// client-mediated live dispatch instead of the Kira review handoff. Separate from
// every other gate; the existing L5 + content-addressed approval gate still
// governs the operation.
//
// The operator owns this in Settings -> Advanced -> Autonomy
// (config.json: aoiAutonomyCapabilities.appOpLiveDispatchEnabled). The env var
// stays the fallback for headless deployments, and still takes a strict '1'.
export function isAoiAppOpLiveDispatchEnabled(
  env: Record<string, string | undefined> = process.env,
  configFile?: string,
): boolean {
  return loadAoiAutonomyCapabilitySettings({
    ...(configFile ? { configFile } : {}),
    env,
  }).appOpLiveDispatch;
}

export interface AoiAppOperationDispatchDraft {
  sessionPath: string;
  appId: number;
  appName: string;
  actionType: string;
  params: Record<string, string>;
  approvalFingerprint: string;
  // Standing approval expiry at accept/queue time (required for late-dispatch expiry).
  approvalExpiresAt?: number;
  proposalId?: string;
  decisionId?: string;
  evidenceRefs?: string[];
  now: number;
}

// Build a 'pending' dispatch record from an approved app_operation. Pure (the caller
// passes `now`), so it is deterministic + offline-testable. The id is filename-safe
// (it becomes the store filename) and stable for a given (now, app, action) so a
// re-queue overwrites in place rather than duplicating.
export function buildAoiAppOperationDispatch(
  draft: AoiAppOperationDispatchDraft,
): AoiAppOperationDispatch {
  const safeActionType = draft.actionType.replace(/[^a-zA-Z0-9_-]/g, '_');
  const id = `app-op-dispatch-${draft.now}-${draft.appId}-${safeActionType}`;
  return {
    version: 1,
    id,
    sessionPath: draft.sessionPath,
    status: 'pending',
    appId: draft.appId,
    appName: draft.appName,
    actionType: draft.actionType,
    params: { ...draft.params },
    ...(draft.proposalId ? { proposalId: draft.proposalId } : {}),
    ...(draft.decisionId ? { decisionId: draft.decisionId } : {}),
    approvalFingerprint: draft.approvalFingerprint,
    ...(typeof draft.approvalExpiresAt === 'number' && Number.isFinite(draft.approvalExpiresAt)
      ? { approvalExpiresAt: draft.approvalExpiresAt }
      : {}),
    evidenceRefs: draft.evidenceRefs ?? [],
    createdAt: draft.now,
    updatedAt: draft.now,
  };
}
