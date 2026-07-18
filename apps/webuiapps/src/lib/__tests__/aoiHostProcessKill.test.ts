import { describe, expect, it } from 'vitest';

import {
  compareAoiHostKillApproval,
  evaluateAoiHostKillPolicy,
  isAoiHostProtectedImage,
  runAoiHostKill,
  verifyAoiHostKillTarget,
  type AoiHostKillRequest,
  type AoiHostLiveProcess,
} from '../aoiHostProcessKill';

function req(partial: Partial<AoiHostKillRequest> = {}): AoiHostKillRequest {
  return {
    pid: 4321,
    expectedImageName: 'notepad.exe',
    expectedStartTime: '2026-07-18T10:00:00',
    requestedAt: 1000,
    ...partial,
  };
}

describe('isAoiHostProtectedImage', () => {
  it('protects OS-critical and Tavern anti-cheat images (case-insensitive)', () => {
    for (const image of ['lsass.exe', 'CSRSS.EXE', 'services.exe', 'System', 'svchost.exe']) {
      expect(isAoiHostProtectedImage(image)).toBe(true);
    }
    expect(isAoiHostProtectedImage('Tavern.exe')).toBe(true);
    expect(isAoiHostProtectedImage('TavernWorker.exe')).toBe(true);
    expect(isAoiHostProtectedImage('notepad.exe')).toBe(false);
  });
});

describe('evaluateAoiHostKillPolicy', () => {
  it('never allows a protected image, even if it is on the kill allowlist', () => {
    const policy = evaluateAoiHostKillPolicy({
      request: req({ expectedImageName: 'lsass.exe' }),
      context: { killAllowlistImages: ['lsass.exe'], aoiSpawnedPids: [4321] },
    });
    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('protected_process');
  });

  it('never allows a protected pid (daemon self)', () => {
    const policy = evaluateAoiHostKillPolicy({
      request: req({ pid: 999 }),
      context: { protectedPids: [999], killAllowlistImages: ['notepad.exe'] },
    });
    expect(policy.blockReasons).toContain('protected_pid');
  });

  it('blocks a target that is neither Aoi-spawned nor allowlisted', () => {
    const policy = evaluateAoiHostKillPolicy({ request: req(), context: {} });
    expect(policy.blockReasons).toContain('not_killable');
  });

  it('allows an Aoi-spawned pid with a valid approval fingerprint', () => {
    const policy = evaluateAoiHostKillPolicy({
      request: req(),
      context: { aoiSpawnedPids: [4321] },
    });
    expect(policy.allowed).toBe(true);
    expect(policy.approvalSandbox.expectedMutationCount).toBe(1);
    expect(policy.approvalSandbox.recoveryPlan.available).toBe(false);
  });

  it('allows an allowlisted image (case-insensitive)', () => {
    const policy = evaluateAoiHostKillPolicy({
      request: req({ expectedImageName: 'Notepad.exe' }),
      context: { killAllowlistImages: ['notepad.exe'] },
    });
    expect(policy.allowed).toBe(true);
  });
});

describe('verifyAoiHostKillTarget (TOCTOU)', () => {
  it('accepts a live process matching image + start time', () => {
    const live: AoiHostLiveProcess = {
      imageName: 'notepad.exe',
      startTime: '2026-07-18T10:00:00',
    };
    expect(verifyAoiHostKillTarget(req(), live).ok).toBe(true);
  });

  it('rejects a reused pid whose image changed', () => {
    const result = verifyAoiHostKillTarget(req(), { imageName: 'chrome.exe' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('toctou_mismatch');
  });

  it('rejects a reused pid whose start time changed', () => {
    const result = verifyAoiHostKillTarget(req(), {
      imageName: 'notepad.exe',
      startTime: '2026-07-18T11:11:11',
    });
    expect(result.reason).toBe('toctou_mismatch');
  });

  it('reports process_not_found when the pid is gone', () => {
    expect(verifyAoiHostKillTarget(req(), null).reason).toBe('process_not_found');
  });
});

describe('runAoiHostKill', () => {
  const approvedPolicy = evaluateAoiHostKillPolicy({
    request: req(),
    context: { aoiSpawnedPids: [4321] },
  });

  it('kills only after policy + approval + TOCTOU all pass, and audits it', () => {
    let killedPid: number | null = null;
    const result = runAoiHostKill({
      request: req(),
      context: { aoiSpawnedPids: [4321] },
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      readProcessImpl: () => ({ imageName: 'notepad.exe', startTime: '2026-07-18T10:00:00' }),
      killImpl: (pid) => {
        killedPid = pid;
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.killed).toBe(true);
    expect(killedPid).toBe(4321);
    expect(result.auditRecord.allowed).toBe(true);
  });

  it('never kills when the TOCTOU re-read mismatches (pid reused)', () => {
    let killCalled = false;
    const result = runAoiHostKill({
      request: req(),
      context: { aoiSpawnedPids: [4321] },
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      // The pid now hosts a DIFFERENT image.
      readProcessImpl: () => ({ imageName: 'lsass.exe', startTime: 'x' }),
      killImpl: () => {
        killCalled = true;
        return true;
      },
    });
    expect(killCalled).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('toctou_mismatch');
  });

  it('never kills a protected process even if the live re-read reveals one', () => {
    let killCalled = false;
    const result = runAoiHostKill({
      // Request pins lsass (protected) -> policy already blocks; belt-and-suspenders.
      request: req({ expectedImageName: 'lsass.exe' }),
      context: { killAllowlistImages: ['lsass.exe'], aoiSpawnedPids: [4321] },
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      readProcessImpl: () => ({ imageName: 'lsass.exe' }),
      killImpl: () => {
        killCalled = true;
        return true;
      },
    });
    expect(killCalled).toBe(false);
    expect(result.blockReasons).toContain('protected_process');
  });

  it('never kills without an approval', () => {
    let killCalled = false;
    const result = runAoiHostKill({
      request: req(),
      context: { aoiSpawnedPids: [4321] },
      approvedSandbox: null,
      now: 1000,
      readProcessImpl: () => ({ imageName: 'notepad.exe' }),
      killImpl: () => {
        killCalled = true;
        return true;
      },
    });
    expect(killCalled).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
  });
});

describe('compareAoiHostKillApproval', () => {
  const policy = evaluateAoiHostKillPolicy({ request: req(), context: { aoiSpawnedPids: [4321] } });

  it('passes on match, flags missing/expired', () => {
    expect(
      compareAoiHostKillApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual([]);
    expect(
      compareAoiHostKillApproval({
        approved: null,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual(['approval_missing']);
    expect(
      compareAoiHostKillApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 500,
        now: 1500,
      }),
    ).toEqual(['approval_expired']);
  });
});
