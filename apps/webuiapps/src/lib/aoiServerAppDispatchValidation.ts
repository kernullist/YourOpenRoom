// P2.2 (server-side re-check): before the daemon advertises a pending app-operation
// dispatch to the connected client bridge, re-derive the content-addressed approval
// fingerprint SERVER-SIDE and drop any record whose approval no longer matches.
//
// The client bridge (aoiAppOperationDispatchBridge) ALREADY re-checks the fingerprint
// before it publishes over the agent->app bus. This adds the same check on the server
// so the daemon never even advertises a dispatch whose approval changed/vanished since
// queueing -- defense in depth, and the roadmap's "re-check ... server-side before
// publishing". It is READ-ONLY: it filters what the GET route returns; it does not
// mutate any record (marking a record failed stays the client bridge's job, since only
// a real dispatch attempt is an authoritative outcome).
//
// Pure + fail-closed: lookupProposal and recomputeApprovalFingerprint are injected so a
// missing proposal, a recompute error, or a fingerprint mismatch each drops the record.
import type { AoiAppOperationDispatch, AoiProposal } from './aoiAutonomyTypes';

// Whether a re-derived approved action equals what the stored record would dispatch.
// The fingerprint proves the PROPOSAL is unchanged; this proves the RECORD's own
// actionType/params were not swapped for a different action under the same approval.
function actionTargetMatches(
  expected: { actionType: string; params: Record<string, string> },
  record: AoiAppOperationDispatch,
): boolean {
  if (expected.actionType !== record.actionType) {
    return false;
  }
  const recordParams = record.params ?? {};
  const expectedKeys = Object.keys(expected.params);
  if (expectedKeys.length !== Object.keys(recordParams).length) {
    return false;
  }
  for (const key of expectedKeys) {
    if (expected.params[key] !== recordParams[key]) {
      return false;
    }
  }
  return true;
}

export type AoiServerDispatchRejectReason =
  | 'not_pending'
  | 'missing_proposal_reference'
  | 'proposal_not_found'
  | 'approval_recheck_failed'
  | 'approval_fingerprint_mismatch'
  | 'approval_expired'
  // The record's stored actionType/params no longer match the action the source
  // proposal (and thus the fingerprint) covers -- a tampered dispatch record.
  | 'action_mismatch';

export interface AoiServerDispatchRejected {
  id: string;
  reason: AoiServerDispatchRejectReason;
}

export interface AoiServerValidatedAppDispatchSelection {
  // Pending records whose approval fingerprint still matches the current server-derived
  // approval AND whose standing approval has not expired. Only these are advertised.
  eligible: AoiAppOperationDispatch[];
  // The rest, with why each was dropped -- for operator observability.
  rejected: AoiServerDispatchRejected[];
}

export interface AoiServerDispatchApprovalSnapshot {
  fingerprint: string;
  // Epoch-ms expiry of the standing content-addressed app-action approval.
  expiresAt: number;
}

export function selectAoiServerValidatedAppDispatches(params: {
  records: readonly AoiAppOperationDispatch[];
  lookupProposal: (proposalId: string) => AoiProposal | null;
  // Prefer the snapshot form (fingerprint + expiresAt). The legacy string form is
  // still accepted for older callers/tests and is treated as non-expiring only when
  // no expiresAt can be derived -- prefer always returning expiresAt.
  recomputeApprovalFingerprint:
    | ((proposal: AoiProposal) => string)
    | ((proposal: AoiProposal) => AoiServerDispatchApprovalSnapshot);
  // Re-derive the action the proposal (and thus the fingerprint) approves. When
  // provided, a record whose stored actionType/params diverge from it is dropped
  // as tampered. Optional so older callers/tests keep the fingerprint-only check.
  deriveApprovedAction?: (
    proposal: AoiProposal,
  ) => { actionType: string; params: Record<string, string> } | null;
  now?: number;
}): AoiServerValidatedAppDispatchSelection {
  const eligible: AoiAppOperationDispatch[] = [];
  const rejected: AoiServerDispatchRejected[] = [];
  const now =
    typeof params.now === 'number' && Number.isFinite(params.now) ? params.now : Date.now();

  for (const record of params.records) {
    if (record.status !== 'pending') {
      rejected.push({ id: record.id, reason: 'not_pending' });
      continue;
    }
    if (!record.proposalId) {
      rejected.push({ id: record.id, reason: 'missing_proposal_reference' });
      continue;
    }
    const proposal = params.lookupProposal(record.proposalId);
    if (!proposal) {
      rejected.push({ id: record.id, reason: 'proposal_not_found' });
      continue;
    }
    let currentFingerprint: string;
    let expiresAt = Number.POSITIVE_INFINITY;
    try {
      const recomputed = params.recomputeApprovalFingerprint(proposal) as
        | string
        | AoiServerDispatchApprovalSnapshot;
      if (typeof recomputed === 'string') {
        currentFingerprint = recomputed;
      } else {
        currentFingerprint = recomputed.fingerprint;
        expiresAt =
          typeof recomputed.expiresAt === 'number' && Number.isFinite(recomputed.expiresAt)
            ? recomputed.expiresAt
            : Number.POSITIVE_INFINITY;
      }
    } catch {
      rejected.push({ id: record.id, reason: 'approval_recheck_failed' });
      continue;
    }
    if (
      typeof record.approvalFingerprint !== 'string' ||
      record.approvalFingerprint.length === 0 ||
      currentFingerprint !== record.approvalFingerprint
    ) {
      rejected.push({ id: record.id, reason: 'approval_fingerprint_mismatch' });
      continue;
    }
    // Prefer the standing expiry snapshotted on the dispatch at queue time
    // (accept-time + TTL). Fall back to the recompute snapshot when present.
    const standingExpiresAt =
      typeof record.approvalExpiresAt === 'number' && Number.isFinite(record.approvalExpiresAt)
        ? record.approvalExpiresAt
        : expiresAt;
    if (standingExpiresAt < now) {
      rejected.push({ id: record.id, reason: 'approval_expired' });
      continue;
    }
    // Bind the DISPATCHED action to the approval: the fingerprint match above only
    // proves the proposal is unchanged, not that this record's stored actionType/
    // params still equal what the proposal (and fingerprint) approve. A record
    // whose action fields were edited to a different action is dropped.
    if (params.deriveApprovedAction) {
      const expected = params.deriveApprovedAction(proposal);
      if (!expected || !actionTargetMatches(expected, record)) {
        rejected.push({ id: record.id, reason: 'action_mismatch' });
        continue;
      }
    }
    eligible.push(record);
  }

  return { eligible, rejected };
}
