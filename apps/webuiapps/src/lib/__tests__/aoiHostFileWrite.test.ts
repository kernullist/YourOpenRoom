import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  addAoiHostWriteRoot,
  compareAoiHostWriteApproval,
  evaluateAoiHostFileWritePolicy,
  resolveAoiHostWriteTarget,
  runAoiHostFileWrite,
  type AoiHostWriteRoot,
} from '../aoiHostFileWrite';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
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

describe('write-roots management', () => {
  it('adds absolute roots and rejects relative / bad id', () => {
    const abs = makeTempDir('aoi-wroot-');
    expect(addAoiHostWriteRoot(null, { id: 'work', path: abs }, 1).added).toBe(true);
    expect(addAoiHostWriteRoot(null, { id: 'x', path: 'rel/dir' }, 1).reason).toBe('invalid_path');
    expect(addAoiHostWriteRoot(null, { id: 'Bad', path: abs }, 1).reason).toBe('invalid_id');
  });
});

describe('resolveAoiHostWriteTarget (parent realpath + symlink overwrite guard)', () => {
  const roots: AoiHostWriteRoot[] = [{ id: 'work', label: 'Work', path: 'C:\\work' }];

  it('accepts a new file whose parent resolves inside a root', () => {
    const result = resolveAoiHostWriteTarget({
      roots,
      requestedPath: 'C:\\work\\new.txt',
      realpathImpl: (t) => t,
      existsImpl: () => false,
    });
    expect(result.ok).toBe(true);
    expect(result.exists).toBe(false);
    expect(result.rootId).toBe('work');
  });

  it('rejects a ".." traversal escape (resolve collapses it out of the root)', () => {
    // resolve() normalizes 'C:\\work\\..\\evil.txt' to 'C:\\evil.txt', which is
    // outside the root -> the escape is still rejected, categorized as outside-root.
    expect(
      resolveAoiHostWriteTarget({
        roots,
        requestedPath: 'C:\\work\\..\\evil.txt',
        realpathImpl: (t) => t,
      }).reason,
    ).toBe('outside_consent_roots');
  });

  it('rejects an empty basename (drive root has nothing to write)', () => {
    expect(
      resolveAoiHostWriteTarget({ roots, requestedPath: 'C:\\', realpathImpl: (t) => t }).reason,
    ).toBe('unsafe_basename');
  });

  it('rejects when the PARENT resolves outside the root (symlinked dir)', () => {
    const result = resolveAoiHostWriteTarget({
      roots,
      requestedPath: 'C:\\work\\sub\\file.txt',
      // The parent dir is a symlink pointing out of the root.
      realpathImpl: (t) => (t === 'C:\\work\\sub' ? 'C:\\secret' : t),
      existsImpl: () => false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('outside_consent_roots');
  });

  it('rejects overwrite-through-symlink (existing target resolves out of root)', () => {
    const result = resolveAoiHostWriteTarget({
      roots,
      requestedPath: 'C:\\work\\link.txt',
      realpathImpl: (t) =>
        t === 'C:\\work\\link.txt' ? 'C:\\secret\\real.txt' : t === 'C:\\work' ? 'C:\\work' : t,
      existsImpl: () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('outside_consent_roots');
  });

  it('reports parent_not_found when the parent does not resolve', () => {
    const result = resolveAoiHostWriteTarget({
      roots,
      requestedPath: 'C:\\work\\ghostdir\\a.txt',
      realpathImpl: (t) => {
        if (t === 'C:\\work\\ghostdir') {
          throw new Error('ENOENT');
        }
        return t;
      },
      existsImpl: () => false,
    });
    expect(result.reason).toBe('parent_not_found');
  });
});

describe('evaluateAoiHostFileWritePolicy', () => {
  const roots: AoiHostWriteRoot[] = [{ id: 'work', label: 'Work', path: 'C:\\work' }];

  it('allows an in-root write and content-addresses the approval', () => {
    const policy = evaluateAoiHostFileWritePolicy({
      request: { requestedPath: 'C:\\work\\a.txt', content: 'hello', requestedAt: 1000 },
      roots,
      realpathImpl: (t) => t,
      existsImpl: () => false,
    });
    expect(policy.allowed).toBe(true);
    expect(policy.willOverwrite).toBe(false);
    expect(policy.byteLength).toBe(5);
    expect(policy.approvalFingerprint).toBe(policy.approvalSandbox.approvalFingerprint);
  });

  it('a different content produces a different approval fingerprint', () => {
    const a = evaluateAoiHostFileWritePolicy({
      request: { requestedPath: 'C:\\work\\a.txt', content: 'AAA', requestedAt: 1000 },
      roots,
      realpathImpl: (t) => t,
      existsImpl: () => false,
    });
    const b = evaluateAoiHostFileWritePolicy({
      request: { requestedPath: 'C:\\work\\a.txt', content: 'BBB', requestedAt: 1000 },
      roots,
      realpathImpl: (t) => t,
      existsImpl: () => false,
    });
    expect(a.approvalFingerprint).not.toBe(b.approvalFingerprint);
  });

  it('blocks a path outside every root', () => {
    const policy = evaluateAoiHostFileWritePolicy({
      request: { requestedPath: 'C:\\other\\a.txt', content: 'x', requestedAt: 1000 },
      roots,
      realpathImpl: (t) => t,
      existsImpl: () => false,
    });
    expect(policy.blockReasons).toContain('outside_consent_roots');
  });
});

describe('runAoiHostFileWrite over a real temp root', () => {
  it('creates a file atomically after approval and audits it', () => {
    const dir = makeTempDir('aoi-wroot-');
    const roots = [addAoiHostWriteRoot(null, { id: 'work', path: dir }, 1).config.roots[0]];
    const target = join(dir, 'out.txt');
    const policy = evaluateAoiHostFileWritePolicy({
      request: { requestedPath: target, content: 'written by aoi', requestedAt: 1000 },
      roots,
    });
    expect(policy.allowed).toBe(true);

    const result = runAoiHostFileWrite({
      request: { requestedPath: target, content: 'written by aoi', requestedAt: 1000 },
      roots,
      approvedSandbox: policy.approvalSandbox,
      approvedExpiresAt: policy.expiresAt,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('written by aoi');
    expect(result.auditRecord.contentHash).toBe(policy.contentHash);
  });

  it('never writes when the approval is missing', () => {
    const dir = makeTempDir('aoi-wroot-');
    const roots = [addAoiHostWriteRoot(null, { id: 'work', path: dir }, 1).config.roots[0]];
    const target = join(dir, 'blocked.txt');
    const result = runAoiHostFileWrite({
      request: { requestedPath: target, content: 'nope', requestedAt: 1000 },
      roots,
      approvedSandbox: null,
      now: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never applies an approval fingerprinted for different content', () => {
    const dir = makeTempDir('aoi-wroot-');
    const roots = [addAoiHostWriteRoot(null, { id: 'work', path: dir }, 1).config.roots[0]];
    const target = join(dir, 'swap.txt');
    const approvedForA = evaluateAoiHostFileWritePolicy({
      request: { requestedPath: target, content: 'content-A', requestedAt: 1000 },
      roots,
    });
    // Try to run with the SAME approval but DIFFERENT content.
    const result = runAoiHostFileWrite({
      request: { requestedPath: target, content: 'content-B-different', requestedAt: 1000 },
      roots,
      approvedSandbox: approvedForA.approvalSandbox,
      approvedExpiresAt: approvedForA.expiresAt,
      now: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockReasons.some((r) => r.startsWith('approval_'))).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('compareAoiHostWriteApproval', () => {
  const roots: AoiHostWriteRoot[] = [{ id: 'work', label: 'Work', path: 'C:\\work' }];
  const policy = evaluateAoiHostFileWritePolicy({
    request: { requestedPath: 'C:\\work\\a.txt', content: 'x', requestedAt: 1000 },
    roots,
    realpathImpl: (t) => t,
    existsImpl: () => false,
  });

  it('passes on match and flags missing/expired', () => {
    expect(
      compareAoiHostWriteApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual([]);
    expect(
      compareAoiHostWriteApproval({
        approved: null,
        current: policy,
        approvedExpiresAt: 2000,
        now: 1500,
      }),
    ).toEqual(['approval_missing']);
    expect(
      compareAoiHostWriteApproval({
        approved: policy.approvalSandbox,
        current: policy,
        approvedExpiresAt: 1000,
        now: 1500,
      }),
    ).toEqual(['approval_expired']);
  });
});
