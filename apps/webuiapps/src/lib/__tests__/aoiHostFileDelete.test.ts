import { describe, expect, it } from 'vitest';

import {
  compareAoiHostDeleteApproval,
  evaluateAoiHostFileDeletePolicy,
  resolveAoiHostDeleteTarget,
  runAoiHostFileDelete,
} from '../aoiHostFileDelete';
import { type AoiHostWriteRoot } from '../aoiHostFileWrite';

const roots: AoiHostWriteRoot[] = [{ id: 'work', label: 'Work', path: 'C:\\work' }];
const idRealpath = (t: string) => t;
const fileStat = () => ({ isDirectory: false });

describe('resolveAoiHostDeleteTarget', () => {
  it('accepts an existing file inside a write root', () => {
    const result = resolveAoiHostDeleteTarget({
      roots,
      requestedPath: 'C:\\work\\old.txt',
      realpathImpl: idRealpath,
      statImpl: fileStat,
    });
    expect(result.ok).toBe(true);
    expect(result.rootId).toBe('work');
  });

  it('refuses a path outside every root and a nonexistent target', () => {
    expect(
      resolveAoiHostDeleteTarget({
        roots,
        requestedPath: 'C:\\other\\x.txt',
        realpathImpl: idRealpath,
        statImpl: fileStat,
      }).reason,
    ).toBe('outside_consent_roots');
    expect(
      resolveAoiHostDeleteTarget({
        roots,
        requestedPath: 'C:\\work\\ghost.txt',
        realpathImpl: () => {
          throw new Error('ENOENT');
        },
      }).reason,
    ).toBe('not_found');
  });

  it('refuses a directory (files only)', () => {
    const result = resolveAoiHostDeleteTarget({
      roots,
      requestedPath: 'C:\\work\\sub',
      realpathImpl: idRealpath,
      statImpl: () => ({ isDirectory: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('target_is_directory');
  });

  it('rejects an existing symlink that resolves out of the root', () => {
    const result = resolveAoiHostDeleteTarget({
      roots,
      requestedPath: 'C:\\work\\link.txt',
      realpathImpl: (t) => (t === 'C:\\work\\link.txt' ? 'C:\\secret\\real.txt' : t),
      statImpl: fileStat,
    });
    expect(result.reason).toBe('outside_consent_roots');
  });
});

describe('evaluateAoiHostFileDeletePolicy', () => {
  it('allows an in-root file and marks the Recycle Bin as the recovery', () => {
    const policy = evaluateAoiHostFileDeletePolicy({
      request: { requestedPath: 'C:\\work\\old.txt', requestedAt: 1000 },
      roots,
      realpathImpl: idRealpath,
      statImpl: fileStat,
    });
    expect(policy.allowed).toBe(true);
    // The Recycle Bin is the recovery: recoverable, not "not_applicable".
    expect(policy.approvalSandbox.recoveryPlan.available).toBe(true);
    expect(policy.approvalFingerprint).toBe(policy.approvalSandbox.approvalFingerprint);
  });
});

describe('runAoiHostFileDelete', () => {
  const approvedPolicy = evaluateAoiHostFileDeletePolicy({
    request: { requestedPath: 'C:\\work\\old.txt', requestedAt: 1000 },
    roots,
    realpathImpl: idRealpath,
    statImpl: fileStat,
  });

  it('recycles the file after policy + approval pass, and audits it', () => {
    let recycledPath: string | null = null;
    const result = runAoiHostFileDelete({
      request: { requestedPath: 'C:\\work\\old.txt', requestedAt: 1000 },
      roots,
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      realpathImpl: idRealpath,
      statImpl: fileStat,
      recycleImpl: (path) => {
        recycledPath = path;
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.recycled).toBe(true);
    expect(recycledPath).toBe('C:\\work\\old.txt');
    expect(result.auditRecord.allowed).toBe(true);
  });

  it('never recycles when the approval is missing', () => {
    let recycleCalled = false;
    const result = runAoiHostFileDelete({
      request: { requestedPath: 'C:\\work\\old.txt', requestedAt: 1000 },
      roots,
      approvedSandbox: null,
      now: 1000,
      realpathImpl: idRealpath,
      statImpl: fileStat,
      recycleImpl: () => {
        recycleCalled = true;
        return true;
      },
    });
    expect(recycleCalled).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
  });

  it('never recycles a target outside a consent root', () => {
    let recycleCalled = false;
    const result = runAoiHostFileDelete({
      request: { requestedPath: 'C:\\other\\x.txt', requestedAt: 1000 },
      roots,
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      realpathImpl: idRealpath,
      statImpl: fileStat,
      recycleImpl: () => {
        recycleCalled = true;
        return true;
      },
    });
    expect(recycleCalled).toBe(false);
    expect(result.blockReasons).toContain('outside_consent_roots');
  });
});

describe('compareAoiHostDeleteApproval', () => {
  const policy = evaluateAoiHostFileDeletePolicy({
    request: { requestedPath: 'C:\\work\\old.txt', requestedAt: 1000 },
    roots,
    realpathImpl: idRealpath,
    statImpl: fileStat,
  });

  it('passes on match, flags missing/expired', () => {
    expect(
      compareAoiHostDeleteApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual([]);
    expect(
      compareAoiHostDeleteApproval({
        approved: null,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual(['approval_missing']);
    expect(
      compareAoiHostDeleteApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 500,
        now: 1500,
      }),
    ).toEqual(['approval_expired']);
  });
});
