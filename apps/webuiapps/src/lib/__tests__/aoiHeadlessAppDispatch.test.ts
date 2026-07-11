import { describe, expect, it } from 'vitest';

import { buildAoiAppOperationDispatch } from '../aoiAppOperationDispatch';
import { selectAoiHeadlessAppDispatch } from '../aoiHeadlessAppDispatch';

const NOW = 1_800_000_000_000;

function record(partial: { appId?: number; createdAt?: number; fingerprint?: string } = {}) {
  const built = buildAoiAppOperationDispatch({
    sessionPath: 'aoi/default',
    appId: partial.appId ?? 7,
    appName: 'MusicApp',
    actionType: 'PLAY_TRACK',
    params: { trackId: '1' },
    approvalFingerprint: partial.fingerprint ?? 'fp-abc',
    now: partial.createdAt ?? NOW,
  });
  return built;
}

describe('selectAoiHeadlessAppDispatch (P2.2)', () => {
  it('selects a pending, fingerprinted op for an already-open, fresh app', () => {
    const selection = selectAoiHeadlessAppDispatch({
      records: [record()],
      openAppIds: new Set([7]),
      liveDispatchEnabled: true,
      now: NOW,
    });
    expect(selection.eligible.map((r) => r.appId)).toEqual([7]);
    expect(selection.skipped).toEqual([]);
  });

  it('skips everything when live dispatch is disabled (off by default)', () => {
    const selection = selectAoiHeadlessAppDispatch({
      records: [record()],
      openAppIds: new Set([7]),
      liveDispatchEnabled: false,
      now: NOW,
    });
    expect(selection.eligible).toEqual([]);
    expect(selection.skipped[0]?.reason).toBe('live_dispatch_disabled');
  });

  it('never opens an app -- an op for a closed app is skipped', () => {
    const selection = selectAoiHeadlessAppDispatch({
      records: [record({ appId: 7 })],
      openAppIds: new Set([99]), // 7 is not open
      liveDispatchEnabled: true,
      now: NOW,
    });
    expect(selection.eligible).toEqual([]);
    expect(selection.skipped[0]?.reason).toBe('target_app_not_open');
  });

  it('skips a non-pending record and one missing an approval fingerprint', () => {
    const nonPending = { ...record(), status: 'dispatched' as const };
    const noFingerprint = { ...record(), approvalFingerprint: '' };
    const selection = selectAoiHeadlessAppDispatch({
      records: [nonPending, noFingerprint],
      openAppIds: new Set([7]),
      liveDispatchEnabled: true,
      now: NOW,
    });
    expect(selection.eligible).toEqual([]);
    expect(selection.skipped.map((s) => s.reason)).toEqual([
      'not_pending',
      'approval_fingerprint_missing',
    ]);
  });

  it('skips a stale op (older than the freshness window)', () => {
    const selection = selectAoiHeadlessAppDispatch({
      records: [record({ createdAt: NOW - 20 * 60 * 1000 })],
      openAppIds: new Set([7]),
      liveDispatchEnabled: true,
      now: NOW,
    });
    expect(selection.eligible).toEqual([]);
    expect(selection.skipped[0]?.reason).toBe('stale');
  });

  it('partitions a mixed batch into eligible + skipped', () => {
    const selection = selectAoiHeadlessAppDispatch({
      records: [
        record({ appId: 7 }), // eligible
        record({ appId: 8 }), // closed app
      ],
      openAppIds: new Set([7]),
      liveDispatchEnabled: true,
      now: NOW,
    });
    expect(selection.eligible.map((r) => r.appId)).toEqual([7]);
    expect(selection.skipped.map((s) => s.reason)).toEqual(['target_app_not_open']);
  });
});
