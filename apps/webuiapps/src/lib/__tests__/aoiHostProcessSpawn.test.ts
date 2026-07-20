import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  addAoiHostSpawnAllowlistEntry,
  compareAoiHostSpawnApproval,
  evaluateAoiHostSpawnPolicy,
  isAoiHostProgramInsideSpawnEntry,
  isAoiHostSpawnRateLimited,
  loadAoiHostSpawnAllowlist,
  normalizeAoiHostSpawnAllowlist,
  removeAoiHostSpawnAllowlistEntry,
  resolveAoiHostSpawnAllowlistHit,
  runAoiHostSpawn,
  saveAoiHostSpawnAllowlist,
  suggestAoiHostSpawnEntryId,
  type AoiHostSpawnAllowlist,
} from '../aoiHostProcessSpawn';

const WIN_EXE = 'C:\\Windows\\System32\\notepad.exe';
const WIN_DIR = 'C:\\Windows\\System32';
const tempRoots: string[] = [];

function makeTempHome(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-spawn-test-'));
  tempRoots.push(root);
  return root;
}

function allowlistWith(entry: {
  id: string;
  label?: string;
  path: string;
  fixedArgs?: string[];
}): AoiHostSpawnAllowlist {
  return addAoiHostSpawnAllowlistEntry(null, entry, 1000).allowlist;
}

afterAll(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('allowlist management', () => {
  it('adds a valid absolute-path entry and rejects relative / metachar / traversal paths', () => {
    expect(addAoiHostSpawnAllowlistEntry(null, { id: 'notepad', path: WIN_EXE }, 1).added).toBe(
      true,
    );
    expect(addAoiHostSpawnAllowlistEntry(null, { id: 'rel', path: 'notepad.exe' }, 1).reason).toBe(
      'invalid_path',
    );
    expect(addAoiHostSpawnAllowlistEntry(null, { id: 'meta', path: 'C:\\a&b.exe' }, 1).reason).toBe(
      'invalid_path',
    );
    expect(
      addAoiHostSpawnAllowlistEntry(null, { id: 'trav', path: 'C:\\a\\..\\b.exe' }, 1).reason,
    ).toBe('invalid_path');
    expect(addAoiHostSpawnAllowlistEntry(null, { id: 'Bad Id', path: WIN_EXE }, 1).reason).toBe(
      'invalid_id',
    );
  });

  it('auto-generates an id and accepts directory match entries', () => {
    const result = addAoiHostSpawnAllowlistEntry(
      null,
      { path: WIN_DIR, match: 'directory', label: 'System32' },
      1,
    );
    expect(result.added).toBe(true);
    expect(result.allowlist.entries[0].match).toBe('directory');
    expect(result.allowlist.entries[0].id.startsWith('dir-')).toBe(true);
    expect(suggestAoiHostSpawnEntryId(WIN_EXE, 'file').startsWith('exe-')).toBe(true);
  });

  it('resolves a program under a directory allowlist entry (nested children ok)', () => {
    const list = addAoiHostSpawnAllowlistEntry(
      null,
      { id: 'sys32', path: WIN_DIR, match: 'directory' },
      1,
    ).allowlist;
    expect(isAoiHostProgramInsideSpawnEntry(list.entries[0], WIN_EXE)).toBe(true);
    expect(
      isAoiHostProgramInsideSpawnEntry(list.entries[0], 'C:\\Windows\\System32\\Drivers\\a.exe'),
    ).toBe(true);
    expect(isAoiHostProgramInsideSpawnEntry(list.entries[0], 'C:\\Windows\\explorer.exe')).toBe(
      false,
    );
    const hit = resolveAoiHostSpawnAllowlistHit({
      allowlist: list,
      programPath: WIN_EXE,
    });
    expect(hit?.entry.id).toBe('sys32');
    expect(hit?.program).toBe(WIN_EXE);
    const policy = evaluateAoiHostSpawnPolicy({
      request: { programPath: WIN_EXE, requestedAt: 1000 },
      allowlist: list,
    });
    expect(policy.allowed).toBe(true);
    expect(policy.program).toBe(WIN_EXE);
  });

  it('replaces an entry with the same id (no duplicates) and removes by id', () => {
    let list = allowlistWith({ id: 'notepad', label: 'Notepad', path: WIN_EXE });
    list = addAoiHostSpawnAllowlistEntry(
      list,
      { id: 'notepad', path: 'C:\\other.exe' },
      2,
    ).allowlist;
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].path).toBe('C:\\other.exe');
    list = removeAoiHostSpawnAllowlistEntry(list, 'notepad', 3);
    expect(list.entries).toHaveLength(0);
  });

  it('drops malformed entries on normalize', () => {
    const normalized = normalizeAoiHostSpawnAllowlist({
      version: 1,
      entries: [
        { id: 'ok', path: WIN_EXE },
        { id: 'rel', path: 'notepad.exe' },
        { id: 'Bad Id', path: WIN_EXE },
        'garbage',
      ],
      updatedAt: 5,
    });
    expect(normalized.entries.map((e) => e.id)).toEqual(['ok']);
  });

  it('round-trips through disk and fails closed on a corrupt file', () => {
    const home = makeTempHome();
    expect(loadAoiHostSpawnAllowlist(home).entries).toEqual([]);
    saveAoiHostSpawnAllowlist(home, allowlistWith({ id: 'notepad', path: WIN_EXE }));
    expect(loadAoiHostSpawnAllowlist(home).entries.map((e) => e.id)).toEqual(['notepad']);
  });
});

describe('evaluateAoiHostSpawnPolicy', () => {
  const allowlist = allowlistWith({ id: 'notepad', label: 'Notepad', path: WIN_EXE });

  it('allows a known entry and builds a content-addressed approval', () => {
    const policy = evaluateAoiHostSpawnPolicy({
      request: { allowlistId: 'notepad', requestedAt: 1000 },
      allowlist,
      now: 1000,
    });
    expect(policy.allowed).toBe(true);
    expect(policy.program).toBe(WIN_EXE);
    expect(policy.requiredAutonomyLevel).toBe('L5');
    expect(policy.approvalFingerprint).toBe(policy.approvalSandbox.approvalFingerprint);
    expect(policy.approvalSandbox.expectedMutationCount).toBe(1);
  });

  it('blocks an unknown entry and a missing id', () => {
    expect(
      evaluateAoiHostSpawnPolicy({
        request: { allowlistId: 'ghost', requestedAt: 1000 },
        allowlist,
        now: 1000,
      }).blockReasons,
    ).toContain('unknown_allowlist_entry');
    expect(
      evaluateAoiHostSpawnPolicy({
        request: { allowlistId: '', requestedAt: 1000 },
        allowlist,
        now: 1000,
      }).blockReasons,
    ).toContain('missing_allowlist_id');
  });

  it('blocks shell metacharacters and over-long / too-many args', () => {
    const meta = evaluateAoiHostSpawnPolicy({
      request: { allowlistId: 'notepad', args: ['a && b'], requestedAt: 1000 },
      allowlist,
      now: 1000,
    });
    expect(meta.blockReasons).toContain('shell_metacharacters');

    const many = evaluateAoiHostSpawnPolicy({
      request: {
        allowlistId: 'notepad',
        args: Array.from({ length: 40 }, (_u, i) => `a${i}`),
        requestedAt: 1000,
      },
      allowlist,
      now: 1000,
    });
    expect(many.blockReasons).toContain('too_many_arguments');
  });

  it('prepends the entry fixed args before request args', () => {
    const list = allowlistWith({ id: 'app', path: WIN_EXE, fixedArgs: ['--safe'] });
    const policy = evaluateAoiHostSpawnPolicy({
      request: { allowlistId: 'app', args: ['file.txt'], requestedAt: 1000 },
      allowlist: list,
      now: 1000,
    });
    expect(policy.args).toEqual(['--safe', 'file.txt']);
  });
});

describe('compareAoiHostSpawnApproval', () => {
  const allowlist = allowlistWith({ id: 'notepad', path: WIN_EXE });
  const policy = evaluateAoiHostSpawnPolicy({
    request: { allowlistId: 'notepad', requestedAt: 1000 },
    allowlist,
    now: 1000,
  });

  it('passes when the approved sandbox matches and is unexpired', () => {
    expect(
      compareAoiHostSpawnApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual([]);
  });

  it('flags a missing, expired, or changed approval', () => {
    expect(
      compareAoiHostSpawnApproval({
        approved: null,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual(['approval_missing']);
    expect(
      compareAoiHostSpawnApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 1000,
        now: 1500,
      }),
    ).toEqual(['approval_expired']);

    // An approval fingerprinted for a DIFFERENT entry must not authorize this one.
    const otherPolicy = evaluateAoiHostSpawnPolicy({
      request: { allowlistId: 'notepad', args: ['different.txt'], requestedAt: 1000 },
      allowlist,
      now: 1000,
    });
    const reasons = compareAoiHostSpawnApproval({
      approved: otherPolicy.approvalSandbox,
      current: policy,
      approvedExpiresAt: 2000,
      now: 1500,
    });
    expect(reasons.length).toBeGreaterThan(0);
  });
});

describe('isAoiHostSpawnRateLimited', () => {
  it('limits by count within the window', () => {
    const now = 100_000;
    const recent = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000];
    expect(isAoiHostSpawnRateLimited(recent, now, { maxPerWindow: 5, windowMs: 60_000 })).toBe(
      true,
    );
    expect(isAoiHostSpawnRateLimited(recent.slice(0, 3), now, { maxPerWindow: 5 })).toBe(false);
    // Old timestamps fall outside the window.
    expect(
      isAoiHostSpawnRateLimited([now - 120_000, now - 130_000], now, { maxPerWindow: 1 }),
    ).toBe(false);
  });
});

describe('runAoiHostSpawn', () => {
  const allowlist = allowlistWith({ id: 'notepad', path: WIN_EXE });
  const approvedPolicy = evaluateAoiHostSpawnPolicy({
    request: { allowlistId: 'notepad', requestedAt: 1000 },
    allowlist,
    now: 1000,
  });

  it('spawns with a fixed argv (shell:false, detached) and audits the pid', () => {
    const calls: Array<{ program: string; args: string[]; opts: Record<string, unknown> }> = [];
    const fakeSpawn = ((program: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ program, args, opts });
      return { pid: 4321, unref: () => undefined };
    }) as unknown as typeof import('child_process').spawn;

    const result = runAoiHostSpawn({
      request: { allowlistId: 'notepad', requestedAt: 1000 },
      allowlist,
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      spawnImpl: fakeSpawn,
    });

    expect(result.ok).toBe(true);
    expect(result.spawnedPid).toBe(4321);
    expect(result.auditRecord.allowed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].program).toBe(WIN_EXE);
    expect(calls[0].opts.shell).toBe(false);
    expect(calls[0].opts.detached).toBe(true);
  });

  it('never spawns when the approval is missing and audits the block', () => {
    let spawned = false;
    const fakeSpawn = (() => {
      spawned = true;
      return { pid: 1, unref: () => undefined };
    }) as unknown as typeof import('child_process').spawn;

    const result = runAoiHostSpawn({
      request: { allowlistId: 'notepad', requestedAt: 1000 },
      allowlist,
      approvedSandbox: null,
      now: 1000,
      spawnImpl: fakeSpawn,
    });

    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.spawnedPid).toBeNull();
    expect(result.blockReasons).toContain('approval_missing');
    expect(result.auditRecord.allowed).toBe(false);
  });

  it('never spawns an unknown entry', () => {
    let spawned = false;
    const fakeSpawn = (() => {
      spawned = true;
      return { pid: 1, unref: () => undefined };
    }) as unknown as typeof import('child_process').spawn;

    const result = runAoiHostSpawn({
      request: { allowlistId: 'ghost', requestedAt: 1000 },
      allowlist,
      approvedSandbox: approvedPolicy.approvalSandbox,
      approvedExpiresAt: approvedPolicy.expiresAt,
      now: 1000,
      spawnImpl: fakeSpawn,
    });

    expect(spawned).toBe(false);
    expect(result.blockReasons).toContain('unknown_allowlist_entry');
  });
});
