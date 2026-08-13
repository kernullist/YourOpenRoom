import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAoiAutonomySessionSummaries } from '../aoiAutonomyStore';

// CP-01: the bootstrap session list behind GET /api/aoi-autonomy/sessions.
//
// The behaviors under test are the ones an operator console depends on and
// nothing else in the codebase guarantees: a cold install must read as "no
// sessions yet" rather than as a failure, newest-first must actually hold so a
// caller can default to [0], and a stat failure must degrade the timestamp
// WITHOUT dropping the row (a session with a policy.json exists whether or not
// we can read its mtime).

// fs.statSync cannot be vi.spyOn'd here (the ESM namespace object is frozen), and
// a genuine unreadable policy.json is not portable to make on Windows. Mock the
// module instead, delegating everything to the real fs except paths explicitly
// marked to fail -- which reproduces the actual race this guards: the file is
// discovered by existsSync and then vanishes (or is locked) before the stat.
const { statFailures } = vi.hoisted(() => ({ statFailures: new Set<string>() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const statSync = (target: unknown, ...rest: unknown[]): unknown => {
    const normalized = String(target).replace(/\\/g, '/');
    for (const marker of statFailures) {
      if (normalized.includes(marker)) {
        throw new Error('EACCES: permission denied');
      }
    }
    return (actual.statSync as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...actual, default: { ...actual, statSync }, statSync };
});

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-sessions-test-'));
  tempRoots.push(root);
  return root;
}

function seedSession(root: string, sessionPath: string, mtimeMs: number): string {
  const autonomyDir = join(root, ...sessionPath.split('/'), 'aoi-autonomy');
  fs.mkdirSync(autonomyDir, { recursive: true });
  const policyFile = join(autonomyDir, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, enabled: false }), 'utf8');
  const stamp = new Date(mtimeMs);
  fs.utimesSync(policyFile, stamp, stamp);
  return policyFile;
}

afterEach(() => {
  statFailures.clear();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('listAoiAutonomySessionSummaries', () => {
  it('returns an empty list for a sessions dir with no autonomy stores', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'aoi', 'space_adventure'), { recursive: true });

    expect(listAoiAutonomySessionSummaries(root)).toEqual([]);
  });

  it('returns an empty list when the sessions dir does not exist at all', () => {
    const root = makeTempRoot();

    expect(listAoiAutonomySessionSummaries(join(root, 'never-created'))).toEqual([]);
  });

  it('ignores a session directory that has no policy.json', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'aoi', 'half_built', 'aoi-autonomy'), { recursive: true });
    seedSession(root, 'aoi/real', 5_000_000);

    expect(listAoiAutonomySessionSummaries(root).map((entry) => entry.sessionPath)).toEqual([
      'aoi/real',
    ]);
  });

  it('sorts sessions newest-first so callers can default to the first entry', () => {
    const root = makeTempRoot();
    seedSession(root, 'aoi/oldest', 1_000_000);
    seedSession(root, 'aoi/newest', 9_000_000);
    seedSession(root, 'aoi/middle', 5_000_000);

    const summaries = listAoiAutonomySessionSummaries(root);

    expect(summaries.map((entry) => entry.sessionPath)).toEqual([
      'aoi/newest',
      'aoi/middle',
      'aoi/oldest',
    ]);
    expect(summaries[0].updatedAt).toBeGreaterThan(summaries[1].updatedAt);
  });

  it('breaks timestamp ties by session path so the order is stable', () => {
    const root = makeTempRoot();
    seedSession(root, 'aoi/beta', 4_000_000);
    seedSession(root, 'aoi/alpha', 4_000_000);

    expect(listAoiAutonomySessionSummaries(root).map((entry) => entry.sessionPath)).toEqual([
      'aoi/alpha',
      'aoi/beta',
    ]);
  });

  it('keeps a session whose policy.json cannot be stat-ed, degrading only the timestamp', () => {
    const root = makeTempRoot();
    seedSession(root, 'aoi/readable', 7_000_000);
    seedSession(root, 'aoi/unreadable', 8_000_000);

    statFailures.add('aoi/unreadable/aoi-autonomy/policy.json');

    const summaries = listAoiAutonomySessionSummaries(root);

    // The row survives -- the session genuinely exists.
    expect(summaries.map((entry) => entry.sessionPath).sort()).toEqual([
      'aoi/readable',
      'aoi/unreadable',
    ]);
    const unreadable = summaries.find((entry) => entry.sessionPath === 'aoi/unreadable');
    expect(unreadable?.updatedAt).toBe(0);
    // ...and it sorts last, so a stat failure never wins the default selection.
    expect(summaries[summaries.length - 1].sessionPath).toBe('aoi/unreadable');
  });

  it('reports integer millisecond timestamps', () => {
    const root = makeTempRoot();
    seedSession(root, 'aoi/one', 3_333_333);

    const [summary] = listAoiAutonomySessionSummaries(root);

    expect(Number.isInteger(summary.updatedAt)).toBe(true);
    expect(summary.updatedAt).toBeGreaterThan(0);
  });

  it('finds nested sessions and normalizes separators to forward slashes', () => {
    const root = makeTempRoot();
    seedSession(root, 'aoi/deep/nested_mod', 2_000_000);

    expect(listAoiAutonomySessionSummaries(root).map((entry) => entry.sessionPath)).toEqual([
      'aoi/deep/nested_mod',
    ]);
  });
});
