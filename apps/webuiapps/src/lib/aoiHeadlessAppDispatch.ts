// P2.2: make live app-operation dispatch headless -- the SAFE selection GATE (no effect here).
//
// Today a fingerprinted, approved app operation only actually dispatches while the ChatPanel is
// mounted; a 24/7 daemon dispatches nothing. The per-record approval-fingerprint re-check
// already lives in aoiAppOperationDispatchBridge (a mismatch fails closed). What is missing is
// the headless orchestration: deciding WHICH pending, approved operations a daemon worker may
// hand to that bridge WITHOUT a mounted panel. That decision is isolated here as a pure,
// fail-closed selection -- it publishes nothing; a worker consults it, then drives the existing
// (fingerprint-re-checking) bridge for each eligible record.
//
// Invariants:
//   * OFF by default -- only when the live-dispatch env gate is on is anything selectable.
//   * pending records only (a completed / failed record is never re-fired).
//   * an approval fingerprint must be present (the bridge still re-checks it before publishing).
//   * NO AUTO-OPEN OF APPS -- the target app must ALREADY be open; an operation for a closed app
//     is skipped, never opened.
//   * not stale -- an operation older than the freshness window is dropped rather than fired
//     long after it was approved.
import type { AoiAppOperationDispatch } from './aoiAutonomyTypes';

export type AoiHeadlessDispatchSkipReason =
  | 'live_dispatch_disabled'
  | 'not_pending'
  | 'approval_fingerprint_missing'
  | 'target_app_not_open'
  | 'stale';

export interface AoiHeadlessDispatchSkipped {
  id: string;
  reason: AoiHeadlessDispatchSkipReason;
}

export interface AoiHeadlessDispatchSelection {
  // The records a daemon worker may hand to the (fingerprint-re-checking) dispatch bridge.
  eligible: AoiAppOperationDispatch[];
  // The rest, with why each was skipped -- for operator observability.
  skipped: AoiHeadlessDispatchSkipped[];
}

// Default: an operation older than this is not fired headlessly (it should be re-approved).
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

// Pure, fail-closed. When live dispatch is disabled EVERYTHING is skipped; otherwise each
// record must be pending + fingerprinted + for an already-open app + fresh.
export function selectAoiHeadlessAppDispatch(params: {
  records: readonly AoiAppOperationDispatch[];
  // Ids of apps that are ALREADY open -- headless dispatch never opens an app.
  openAppIds: ReadonlySet<number>;
  liveDispatchEnabled: boolean;
  now: number;
  maxAgeMs?: number;
}): AoiHeadlessDispatchSelection {
  const eligible: AoiAppOperationDispatch[] = [];
  const skipped: AoiHeadlessDispatchSkipped[] = [];
  const maxAgeMs =
    typeof params.maxAgeMs === 'number' && params.maxAgeMs > 0
      ? params.maxAgeMs
      : DEFAULT_MAX_AGE_MS;

  for (const record of params.records) {
    if (!params.liveDispatchEnabled) {
      skipped.push({ id: record.id, reason: 'live_dispatch_disabled' });
      continue;
    }
    if (record.status !== 'pending') {
      skipped.push({ id: record.id, reason: 'not_pending' });
      continue;
    }
    if (typeof record.approvalFingerprint !== 'string' || record.approvalFingerprint.length === 0) {
      skipped.push({ id: record.id, reason: 'approval_fingerprint_missing' });
      continue;
    }
    if (!params.openAppIds.has(record.appId)) {
      skipped.push({ id: record.id, reason: 'target_app_not_open' });
      continue;
    }
    if (params.now - record.createdAt > maxAgeMs) {
      skipped.push({ id: record.id, reason: 'stale' });
      continue;
    }
    eligible.push(record);
  }

  return { eligible, skipped };
}
