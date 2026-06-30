// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAoiAppOperationDispatch,
  isAoiAppOpLiveDispatchEnabled,
} from '../aoiAppOperationDispatch';
import { appendAoiAppOperationDispatch, loadAoiAppOperationDispatches } from '../aoiAutonomyStore';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function tempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-appop-dispatch-'));
  roots.push(root);
  return root;
}

describe('isAoiAppOpLiveDispatchEnabled()', () => {
  it('is OFF unless the opt-in flag is exactly "1"', () => {
    expect(isAoiAppOpLiveDispatchEnabled({})).toBe(false);
    expect(isAoiAppOpLiveDispatchEnabled({ AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: '0' })).toBe(false);
    expect(isAoiAppOpLiveDispatchEnabled({ AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: 'true' })).toBe(
      false,
    );
    expect(isAoiAppOpLiveDispatchEnabled({ AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: '1' })).toBe(true);
    // Default arg reads process.env; assert the type without depending on its value.
    expect(typeof isAoiAppOpLiveDispatchEnabled()).toBe('boolean');
  });
});

describe('buildAoiAppOperationDispatch()', () => {
  it('builds a pending record with a filename-safe, deterministic id', () => {
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
    });
    expect(dispatch.status).toBe('pending');
    expect(dispatch.id).toBe('app-op-dispatch-1700-7-PLAY_TRACK');
    expect(dispatch.appId).toBe(7);
    expect(dispatch.actionType).toBe('PLAY_TRACK');
    expect(dispatch.params).toEqual({ trackId: '123' });
    expect(dispatch.approvalFingerprint).toBe('fp-abc');
    expect(dispatch.proposalId).toBe('p1');
    expect(dispatch.createdAt).toBe(1700);
    expect(dispatch.updatedAt).toBe(1700);
  });

  it('sanitizes unsafe characters in the action type for the id', () => {
    const dispatch = buildAoiAppOperationDispatch({
      sessionPath: 'aoi/default',
      appId: 1,
      appName: 'a',
      actionType: 'do/../evil thing',
      params: {},
      approvalFingerprint: 'fp',
      now: 5,
    });
    expect(dispatch.id.startsWith('app-op-dispatch-5-1-')).toBe(true);
    // No path-traversal / unsafe characters survive into the store filename.
    expect(dispatch.id).not.toContain('/');
    expect(dispatch.id).not.toContain('.');
    expect(dispatch.id).not.toContain(' ');
    // The original action type is preserved on the record for the client bridge.
    expect(dispatch.actionType).toBe('do/../evil thing');
  });

  it('omits proposalId / decisionId when not provided', () => {
    const dispatch = buildAoiAppOperationDispatch({
      sessionPath: 'aoi/default',
      appId: 1,
      appName: 'a',
      actionType: 'X',
      params: {},
      approvalFingerprint: 'fp',
      now: 1,
    });
    expect(dispatch.proposalId).toBeUndefined();
    expect(dispatch.decisionId).toBeUndefined();
    expect(dispatch.evidenceRefs).toEqual([]);
  });
});

describe('app-operation dispatch store round-trip', () => {
  it('appends, loads, and updates a dispatch in place by id', () => {
    const root = tempRoot();
    const dispatch = buildAoiAppOperationDispatch({
      sessionPath: 'aoi/default',
      appId: 7,
      appName: 'musicApp',
      actionType: 'PLAY_TRACK',
      params: { trackId: '123' },
      approvalFingerprint: 'fp-abc',
      now: 1700,
    });
    appendAoiAppOperationDispatch(root, 'aoi/default', dispatch);
    let loaded = loadAoiAppOperationDispatches(root, 'aoi/default');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('pending');

    // A status update with the same id overwrites in place (still one record).
    appendAoiAppOperationDispatch(root, 'aoi/default', {
      ...dispatch,
      status: 'dispatched',
      actionResult: 'done',
      updatedAt: 1800,
    });
    loaded = loadAoiAppOperationDispatches(root, 'aoi/default');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('dispatched');
    expect(loaded[0].actionResult).toBe('done');
  });

  it('returns an empty list when no dispatches exist', () => {
    const root = tempRoot();
    expect(loadAoiAppOperationDispatches(root, 'aoi/default')).toEqual([]);
  });

  it('rejects an invalid dispatch record', () => {
    const root = tempRoot();
    expect(() =>
      appendAoiAppOperationDispatch(root, 'aoi/default', {
        version: 1,
        id: 'x',
      } as unknown as Parameters<typeof appendAoiAppOperationDispatch>[2]),
    ).toThrow(/Invalid/);
  });
});
