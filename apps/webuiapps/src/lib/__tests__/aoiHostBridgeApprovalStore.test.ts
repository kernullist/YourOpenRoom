import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  approveAoiHostBridgeApproval,
  consumeAoiHostBridgeApproval,
  loadAoiHostBridgeApprovalStore,
  normalizeAoiHostBridgeApprovalStore,
  pruneAoiHostBridgeApprovals,
  recordAoiHostBridgePendingApproval,
  saveAoiHostBridgeApprovalStore,
} from '../aoiHostBridgeApprovalStore';

const FP = 'deadbeefcafe';
const tempRoots: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-approvals-'));
  tempRoots.push(home);
  return home;
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('approval lifecycle: record -> approve -> consume', () => {
  it('a pending approval cannot be consumed until approved', () => {
    const recorded = recordAoiHostBridgePendingApproval(null, {
      capability: 'os_process_spawn',
      approvalFingerprint: FP,
      targetSummary: 'spawn notepad',
      expiresAt: 10_000,
      now: 1000,
    });
    expect(recorded.approval.state).toBe('pending');

    // Consume before approve -> not granted.
    const early = consumeAoiHostBridgeApproval(recorded.store, {
      capability: 'os_process_spawn',
      approvalFingerprint: FP,
      now: 2000,
    });
    expect(early.ok).toBe(false);
    expect(early.reason).toBe('approval_not_granted');

    // Approve, then consume -> ok, single-use.
    const approved = approveAoiHostBridgeApproval(recorded.store, FP, 3000);
    expect(approved.approved).toBe(true);
    const consumed = consumeAoiHostBridgeApproval(approved.store, {
      capability: 'os_process_spawn',
      approvalFingerprint: FP,
      now: 4000,
    });
    expect(consumed.ok).toBe(true);

    // Second consume -> gone (single-use).
    const again = consumeAoiHostBridgeApproval(consumed.store, {
      capability: 'os_process_spawn',
      approvalFingerprint: FP,
      now: 5000,
    });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('approval_missing');
  });

  it('rejects a consume whose capability does not match the recorded one', () => {
    const recorded = recordAoiHostBridgePendingApproval(null, {
      capability: 'os_process_spawn',
      approvalFingerprint: FP,
      targetSummary: 's',
      expiresAt: 10_000,
      now: 1000,
    });
    const approved = approveAoiHostBridgeApproval(recorded.store, FP, 2000);
    const wrongCap = consumeAoiHostBridgeApproval(approved.store, {
      capability: 'os_file_write',
      approvalFingerprint: FP,
      now: 3000,
    });
    expect(wrongCap.ok).toBe(false);
  });

  it('an expired approval cannot be approved or consumed', () => {
    const recorded = recordAoiHostBridgePendingApproval(null, {
      capability: 'os_process_kill',
      approvalFingerprint: FP,
      targetSummary: 'kill 123',
      expiresAt: 2000,
      now: 1000,
    });
    // Approve after expiry -> not approved (and pruned).
    const approved = approveAoiHostBridgeApproval(recorded.store, FP, 3000);
    expect(approved.approved).toBe(false);
    const consumed = consumeAoiHostBridgeApproval(approved.store, {
      capability: 'os_process_kill',
      approvalFingerprint: FP,
      now: 3000,
    });
    expect(consumed.ok).toBe(false);
    expect(consumed.reason).toBe('approval_missing');
  });

  it('re-preview supersedes a prior pending entry for the same fingerprint', () => {
    const first = recordAoiHostBridgePendingApproval(null, {
      capability: 'os_file_write',
      approvalFingerprint: FP,
      targetSummary: 'write a',
      expiresAt: 10_000,
      now: 1000,
    });
    const second = recordAoiHostBridgePendingApproval(first.store, {
      capability: 'os_file_write',
      approvalFingerprint: FP,
      targetSummary: 'write b',
      expiresAt: 10_000,
      now: 2000,
    });
    const matching = second.store.approvals.filter((a) => a.approvalFingerprint === FP);
    expect(matching).toHaveLength(1);
    expect(matching[0].targetSummary).toBe('write b');
  });
});

describe('normalize + prune', () => {
  it('drops malformed entries and bad fingerprints', () => {
    const normalized = normalizeAoiHostBridgeApprovalStore({
      version: 1,
      approvals: [
        {
          version: 1,
          id: 'a',
          capability: 'x',
          approvalFingerprint: 'abcd',
          state: 'pending',
          createdAt: 1,
          expiresAt: 2,
        },
        {
          version: 1,
          id: 'bad',
          capability: 'x',
          approvalFingerprint: 'ZZZZ',
          state: 'pending',
          createdAt: 1,
          expiresAt: 2,
        },
        'garbage',
      ],
      updatedAt: 5,
    });
    expect(normalized.approvals.map((a) => a.id)).toEqual(['a']);
  });

  it('prune removes expired and consumed entries', () => {
    const pruned = pruneAoiHostBridgeApprovals(
      {
        version: 1,
        approvals: [
          {
            version: 1,
            id: 'live',
            capability: 'x',
            approvalFingerprint: 'aaaa',
            targetSummary: '',
            state: 'approved',
            createdAt: 1,
            expiresAt: 100,
          },
          {
            version: 1,
            id: 'dead',
            capability: 'x',
            approvalFingerprint: 'bbbb',
            targetSummary: '',
            state: 'approved',
            createdAt: 1,
            expiresAt: 5,
          },
          {
            version: 1,
            id: 'used',
            capability: 'x',
            approvalFingerprint: 'cccc',
            targetSummary: '',
            state: 'consumed',
            createdAt: 1,
            expiresAt: 100,
          },
        ],
        updatedAt: 1,
      },
      50,
    );
    expect(pruned.approvals.map((a) => a.id)).toEqual(['live']);
  });
});

describe('persistence', () => {
  it('round-trips and fails closed on a corrupt file', () => {
    const home = makeHome();
    expect(loadAoiHostBridgeApprovalStore(home).approvals).toEqual([]);
    const recorded = recordAoiHostBridgePendingApproval(null, {
      capability: 'os_process_spawn',
      approvalFingerprint: FP,
      targetSummary: 's',
      expiresAt: 10_000,
      now: 1000,
    });
    saveAoiHostBridgeApprovalStore(home, recorded.store);
    expect(
      loadAoiHostBridgeApprovalStore(home).approvals.map((a) => a.approvalFingerprint),
    ).toEqual([FP]);
  });
});
