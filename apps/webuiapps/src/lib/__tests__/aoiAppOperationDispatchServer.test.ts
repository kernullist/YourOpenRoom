// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAoiAppOperationDispatch } from '../aoiAppOperationDispatch';
import { recordAoiAppOperationDispatchResult } from '../aoiAppOperationDispatchServer';
import { appendAoiAppOperationDispatch, loadAoiAppOperationDispatches } from '../aoiAutonomyStore';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function tempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-appop-dispatch-server-'));
  roots.push(root);
  return root;
}

function seedPending(
  root: string,
  overrides: Partial<Parameters<typeof buildAoiAppOperationDispatch>[0]> = {},
) {
  const dispatch = buildAoiAppOperationDispatch({
    sessionPath: 'aoi/default',
    appId: 7,
    appName: 'musicApp',
    actionType: 'PLAY_TRACK',
    params: { trackId: '123' },
    approvalFingerprint: 'fp-abc',
    proposalId: 'p1',
    decisionId: 'd1',
    evidenceRefs: ['proposal:p1'],
    now: 1700,
    ...overrides,
  });
  return appendAoiAppOperationDispatch(root, 'aoi/default', dispatch);
}

function ledgerEventTypes(root: string): string[] {
  return loadServerAoiRunLedger(root, 'aoi/default').flatMap((entry) =>
    entry.events.map((event) => event.type),
  );
}

describe('recordAoiAppOperationDispatchResult()', () => {
  it('marks a pending dispatch dispatched, records the action result, and writes a ledger event', () => {
    const root = tempRoot();
    const seeded = seedPending(root);

    const outcome = recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: seeded.id,
      status: 'dispatched',
      actionResult: 'success',
      now: 2000,
    });

    expect(outcome.found).toBe(true);
    expect(outcome.alreadyResolved).toBe(false);
    expect(outcome.dispatch?.status).toBe('dispatched');
    expect(outcome.dispatch?.actionResult).toBe('success');
    expect(outcome.dispatch?.updatedAt).toBe(2000);

    // Persisted in place (still one record, now terminal).
    const loaded = loadAoiAppOperationDispatches(root, 'aoi/default');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('dispatched');
    expect(loaded[0].actionResult).toBe('success');

    expect(ledgerEventTypes(root)).toContain('app_operation_dispatch_executed');
  });

  it('marks a pending dispatch failed and records the failure reason + failed ledger event', () => {
    const root = tempRoot();
    const seeded = seedPending(root);

    const outcome = recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: seeded.id,
      status: 'failed',
      failureReason: 'error: track not found',
      now: 2100,
    });

    expect(outcome.dispatch?.status).toBe('failed');
    expect(outcome.dispatch?.failureReason).toBe('error: track not found');
    expect(ledgerEventTypes(root)).toContain('app_operation_dispatch_failed');
    expect(ledgerEventTypes(root)).not.toContain('app_operation_dispatch_executed');
  });

  it('returns found:false for an unknown id and writes nothing', () => {
    const root = tempRoot();
    seedPending(root);

    const outcome = recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: 'app-op-dispatch-does-not-exist',
      status: 'dispatched',
      now: 2000,
    });

    expect(outcome.found).toBe(false);
    expect(outcome.dispatch).toBeNull();
    // The seeded record is untouched and no ledger event was written.
    expect(loadAoiAppOperationDispatches(root, 'aoi/default')[0].status).toBe('pending');
    expect(ledgerEventTypes(root)).not.toContain('app_operation_dispatch_executed');
  });

  it('is idempotent: a report on an already-terminal record does not re-flip it', () => {
    const root = tempRoot();
    const seeded = seedPending(root);
    recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: seeded.id,
      status: 'dispatched',
      actionResult: 'success',
      now: 2000,
    });

    // A late duplicate reporting 'failed' must NOT flip the dispatched record.
    const second = recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: seeded.id,
      status: 'failed',
      failureReason: 'late duplicate',
      now: 2200,
    });

    expect(second.found).toBe(true);
    expect(second.alreadyResolved).toBe(true);
    expect(second.dispatch?.status).toBe('dispatched');
    expect(second.dispatch?.actionResult).toBe('success');
    expect(second.dispatch?.failureReason).toBeUndefined();
    expect(loadAoiAppOperationDispatches(root, 'aoi/default')[0].status).toBe('dispatched');
  });

  it('clamps an oversized action result and drops empty result strings', () => {
    const root = tempRoot();
    const seeded = seedPending(root, { now: 1701 });
    const huge = 'x'.repeat(5000);

    const outcome = recordAoiAppOperationDispatchResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      id: seeded.id,
      status: 'dispatched',
      actionResult: huge,
      failureReason: '   ',
      now: 2000,
    });

    expect(outcome.dispatch?.actionResult?.length).toBe(2000);
    // A whitespace-only failure reason is treated as absent.
    expect(outcome.dispatch?.failureReason).toBeUndefined();
  });
});
