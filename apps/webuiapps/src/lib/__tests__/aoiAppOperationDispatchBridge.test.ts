import { describe, expect, it, vi } from 'vitest';
import {
  runAoiAppOperationDispatchBridge,
  type AoiAppOperationDispatchBridgeDeps,
  type AoiAppOperationDispatchBridgeReport,
} from '../aoiAppOperationDispatchBridge';
import type { AoiAppOperationDispatch, AoiProposal } from '../aoiAutonomyTypes';

function makeDispatch(overrides: Partial<AoiAppOperationDispatch> = {}): AoiAppOperationDispatch {
  return {
    version: 1,
    id: 'app-op-dispatch-1700-7-PLAY_TRACK',
    sessionPath: 'aoi/default',
    status: 'pending',
    appId: 7,
    appName: 'musicApp',
    actionType: 'PLAY_TRACK',
    params: { trackId: '123' },
    proposalId: 'p1',
    decisionId: 'd1',
    approvalFingerprint: 'fp-abc',
    evidenceRefs: ['proposal:p1'],
    createdAt: 1700,
    updatedAt: 1700,
    ...overrides,
  };
}

// The bridge only passes the proposal back to recomputeApprovalFingerprint (injected), so a
// minimal stub suffices for the bridge's own logic.
function makeProposal(id: string): AoiProposal {
  return { id } as unknown as AoiProposal;
}

interface Harness {
  deps: AoiAppOperationDispatchBridgeDeps;
  reports: AoiAppOperationDispatchBridgeReport[];
  dispatchToApp: ReturnType<typeof vi.fn>;
}

function makeHarness(overrides: Partial<AoiAppOperationDispatchBridgeDeps> = {}): Harness {
  const reports: AoiAppOperationDispatchBridgeReport[] = [];
  const dispatchToApp = vi.fn(async () => 'success' as string | null);
  const deps: AoiAppOperationDispatchBridgeDeps = {
    lookupProposal: (proposalId) => makeProposal(proposalId),
    recomputeApprovalFingerprint: () => 'fp-abc',
    dispatchToApp,
    reportResult: async (report) => {
      reports.push(report);
    },
    ...overrides,
  };
  return { deps, reports, dispatchToApp };
}

describe('runAoiAppOperationDispatchBridge()', () => {
  it('dispatches a matching pending record and reports it dispatched with the action result', async () => {
    // The harness default dispatchToApp resolves 'success'.
    const { deps, reports, dispatchToApp } = makeHarness();
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(dispatchToApp).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([
      { id: 'app-op-dispatch-1700-7-PLAY_TRACK', status: 'dispatched', actionResult: 'success' },
    ]);
    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.unavailable).toBe(0);
    expect(summary.outcomes[0].result).toBe('dispatched');
  });

  it("maps an 'error:' app result to a failed report (the app handler failure convention)", async () => {
    const { deps, reports } = makeHarness({
      dispatchToApp: vi.fn(async () => 'error: track not found'),
    });
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(reports[0]).toEqual({
      id: 'app-op-dispatch-1700-7-PLAY_TRACK',
      status: 'failed',
      failureReason: 'error: track not found',
    });
    expect(summary.failed).toBe(1);
    expect(summary.dispatched).toBe(0);
  });

  it('reports failed when the app dispatch throws (transport / timeout failure)', async () => {
    const { deps, reports } = makeHarness({
      dispatchToApp: vi.fn(async () => {
        throw new Error('timeout: no response from app');
      }),
    });
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(reports[0].status).toBe('failed');
    expect(reports[0].failureReason).toBe('timeout: no response from app');
    expect(summary.failed).toBe(1);
  });

  it('leaves a record pending (unavailable) and reports nothing when the app is not loaded', async () => {
    const { deps, reports } = makeHarness({
      dispatchToApp: vi.fn(async () => null),
    });
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(reports).toEqual([]);
    expect(summary.unavailable).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.outcomes[0].result).toBe('unavailable');
  });

  it('does NOT dispatch and reports failed when the approval fingerprint no longer matches', async () => {
    const { deps, reports, dispatchToApp } = makeHarness({
      recomputeApprovalFingerprint: () => 'fp-DIFFERENT',
    });
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(dispatchToApp).not.toHaveBeenCalled();
    expect(reports[0]).toEqual({
      id: 'app-op-dispatch-1700-7-PLAY_TRACK',
      status: 'failed',
      failureReason: 'approval_fingerprint_mismatch',
    });
    expect(summary.outcomes[0].result).toBe('approval_mismatch');
    expect(summary.failed).toBe(1);
  });

  it('reports failed when the source proposal cannot be resolved', async () => {
    const { deps, reports, dispatchToApp } = makeHarness({
      lookupProposal: () => null,
    });
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(dispatchToApp).not.toHaveBeenCalled();
    expect(reports[0]).toEqual({
      id: 'app-op-dispatch-1700-7-PLAY_TRACK',
      status: 'failed',
      failureReason: 'proposal_not_found',
    });
    expect(summary.outcomes[0].result).toBe('proposal_not_found');
    expect(summary.failed).toBe(1);
  });

  it('reports failed when the record carries no proposal reference', async () => {
    const { deps, reports, dispatchToApp } = makeHarness();
    const record = makeDispatch();
    delete (record as { proposalId?: string }).proposalId;
    const summary = await runAoiAppOperationDispatchBridge([record], deps);

    expect(dispatchToApp).not.toHaveBeenCalled();
    expect(reports[0].failureReason).toBe('missing_proposal_reference');
    expect(summary.failed).toBe(1);
  });

  it('treats a fingerprint-recompute throw as a failed re-check (never dispatches)', async () => {
    const { deps, reports, dispatchToApp } = makeHarness({
      recomputeApprovalFingerprint: () => {
        throw new Error('malformed proposal');
      },
    });
    const summary = await runAoiAppOperationDispatchBridge([makeDispatch()], deps);

    expect(dispatchToApp).not.toHaveBeenCalled();
    expect(reports[0].status).toBe('failed');
    expect(reports[0].failureReason).toBe('approval_recheck_failed');
    expect(summary.outcomes[0].result).toBe('approval_mismatch');
  });

  it('skips a non-pending record defensively without dispatching or reporting', async () => {
    const { deps, reports, dispatchToApp } = makeHarness();
    const summary = await runAoiAppOperationDispatchBridge(
      [makeDispatch({ status: 'dispatched' })],
      deps,
    );

    expect(dispatchToApp).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
    expect(summary.outcomes[0].result).toBe('unavailable');
  });

  it('isolates a report failure (best-effort) so the batch still completes', async () => {
    const dispatchToApp = vi.fn(async () => 'success');
    const summary = await runAoiAppOperationDispatchBridge(
      [makeDispatch(), makeDispatch({ id: 'app-op-dispatch-1700-7-OTHER' })],
      {
        lookupProposal: (proposalId) => makeProposal(proposalId),
        recomputeApprovalFingerprint: () => 'fp-abc',
        dispatchToApp,
        reportResult: async () => {
          throw new Error('network down');
        },
      },
    );

    // Both records were dispatched even though every report POST threw.
    expect(dispatchToApp).toHaveBeenCalledTimes(2);
    expect(summary.dispatched).toBe(2);
    expect(summary.outcomes).toHaveLength(2);
  });

  it('processes a mixed batch and tallies the summary counts', async () => {
    const records = [
      makeDispatch({ id: 'd-ok', proposalId: 'p-ok' }),
      makeDispatch({ id: 'd-unavailable', proposalId: 'p-unavailable' }),
      makeDispatch({ id: 'd-mismatch', proposalId: 'p-mismatch' }),
    ];
    const summary = await runAoiAppOperationDispatchBridge(records, {
      lookupProposal: (proposalId) => makeProposal(proposalId),
      recomputeApprovalFingerprint: (proposal) =>
        proposal.id === 'p-mismatch' ? 'fp-other' : 'fp-abc',
      dispatchToApp: vi.fn(async (record) => (record.id === 'd-unavailable' ? null : 'success')),
      reportResult: async () => {},
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.unavailable).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes.map((outcome) => outcome.result)).toEqual([
      'dispatched',
      'unavailable',
      'approval_mismatch',
    ]);
  });
});
