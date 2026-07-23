import { describe, expect, it } from 'vitest';

import { selectAoiServerValidatedAppDispatches } from '../aoiServerAppDispatchValidation';
import type { AoiAppOperationDispatch, AoiProposal } from '../aoiAutonomyTypes';

const NOW = 1_800_000_000_000;

function makeDispatch(partial: Partial<AoiAppOperationDispatch> = {}): AoiAppOperationDispatch {
  return {
    version: 1,
    id: 'dispatch-1',
    sessionPath: 'aoi/default',
    status: 'pending',
    appId: 7,
    appName: 'notes',
    actionType: 'CREATE_NOTE',
    params: {},
    proposalId: 'proposal-1',
    approvalFingerprint: 'fp-good',
    evidenceRefs: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...partial,
  };
}

const proposal = { id: 'proposal-1' } as AoiProposal;
const lookupProposal = (id: string): AoiProposal | null => (id === 'proposal-1' ? proposal : null);
const matchingFingerprint = () => 'fp-good';

describe('selectAoiServerValidatedAppDispatches (P2.2 server-side re-check)', () => {
  it('keeps a pending record whose approval fingerprint still matches', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch()],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.eligible.map((r) => r.id)).toEqual(['dispatch-1']);
    expect(result.rejected).toEqual([]);
  });

  it('drops a non-pending record', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ status: 'dispatched' })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'not_pending' }]);
  });

  it('drops a record with no proposal reference', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ proposalId: undefined })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'missing_proposal_reference' }]);
  });

  it('drops a record whose proposal is no longer present', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ proposalId: 'gone' })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'proposal_not_found' }]);
  });

  it('drops a record when the fingerprint recompute throws (fail closed)', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch()],
      lookupProposal,
      recomputeApprovalFingerprint: () => {
        throw new Error('policy blew up');
      },
    });
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'approval_recheck_failed' }]);
  });

  it('drops a record whose stored fingerprint no longer matches the current approval', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ approvalFingerprint: 'fp-stale' })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.rejected).toEqual([
      { id: 'dispatch-1', reason: 'approval_fingerprint_mismatch' },
    ]);
  });

  it('drops a record with an empty stored fingerprint', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ approvalFingerprint: '' })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.rejected).toEqual([
      { id: 'dispatch-1', reason: 'approval_fingerprint_mismatch' },
    ]);
  });

  it('partitions a mixed batch, preserving eligible order', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [
        makeDispatch({ id: 'ok-1' }),
        makeDispatch({ id: 'stale', approvalFingerprint: 'fp-stale' }),
        makeDispatch({ id: 'ok-2' }),
        makeDispatch({ id: 'done', status: 'dispatched' }),
      ],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
    });
    expect(result.eligible.map((r) => r.id)).toEqual(['ok-1', 'ok-2']);
    expect(result.rejected).toEqual([
      { id: 'stale', reason: 'approval_fingerprint_mismatch' },
      { id: 'done', reason: 'not_pending' },
    ]);
  });

  it('drops a record whose queue-time standing approval has expired', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ approvalExpiresAt: NOW - 1 })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
      now: NOW,
    });
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'approval_expired' }]);
  });

  it('keeps a record with a future queue-time expiresAt', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ approvalExpiresAt: NOW + 60_000 })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
      now: NOW,
    });
    expect(result.eligible.map((r) => r.id)).toEqual(['dispatch-1']);
  });

  it('keeps a record whose stored action matches the re-derived approved action (A4)', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ actionType: 'CREATE_NOTE', params: { title: 'x' } })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
      deriveApprovedAction: () => ({ actionType: 'CREATE_NOTE', params: { title: 'x' } }),
    });
    expect(result.eligible.map((r) => r.id)).toEqual(['dispatch-1']);
    expect(result.rejected).toEqual([]);
  });

  it('drops a record whose stored action was tampered to differ from the approval (A4)', () => {
    // The fingerprint still matches (the proposal is unchanged), but the record's
    // stored action fields were swapped for a DIFFERENT action than the approval.
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch({ actionType: 'DELETE_ALL', params: { scope: 'everything' } })],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
      deriveApprovedAction: () => ({ actionType: 'CREATE_NOTE', params: {} }),
    });
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'action_mismatch' }]);
  });

  it('drops a record when the approved action cannot be re-derived (fail closed, A4)', () => {
    const result = selectAoiServerValidatedAppDispatches({
      records: [makeDispatch()],
      lookupProposal,
      recomputeApprovalFingerprint: matchingFingerprint,
      deriveApprovedAction: () => null,
    });
    expect(result.rejected).toEqual([{ id: 'dispatch-1', reason: 'action_mismatch' }]);
  });
});
