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

export type AoiServerDispatchRejectReason =
  | 'not_pending'
  | 'missing_proposal_reference'
  | 'proposal_not_found'
  | 'approval_recheck_failed'
  | 'approval_fingerprint_mismatch'
  | 'approval_expired';

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
    eligible.push(record);
  }

  return { eligible, rejected };
}
