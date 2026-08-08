// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  acquireAoiAutonomyLoopLock,
  createAoiAutonomyLoopLockKeeper,
} from '../aoiAutonomyLoopLock';

const LOCK_FILE = '.aoi-autonomy-loop.lock';
const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-loop-lock-'));
  tempRoots.push(dir);
  return dir;
}

function lockPath(dir: string): string {
  return join(dir, LOCK_FILE);
}

function readPid(dir: string): number {
  const record = JSON.parse(fs.readFileSync(lockPath(dir), 'utf-8')) as { pid: number };
  return record.pid;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('acquireAoiAutonomyLoopLock', () => {
  it('creates the lock file on a fresh acquire and removes it on release', () => {
    const dir = makeTempDir();
    const handle = acquireAoiAutonomyLoopLock(dir, { pid: 1234, host: 'h1' });
    expect(handle).not.toBeNull();
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    const record = JSON.parse(fs.readFileSync(lockPath(dir), 'utf-8')) as {
      pid: number;
      host: string;
      kind: string;
    };
    expect(record.pid).toBe(1234);
    expect(record.host).toBe('h1');
    expect(record.kind).toBe('aoi-autonomy-loop');
    handle?.release();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });

  it('creates a missing sessions dir before locking', () => {
    const dir = join(makeTempDir(), 'nested', 'sessions');
    const handle = acquireAoiAutonomyLoopLock(dir, { pid: 1, host: 'h1' });
    expect(handle).not.toBeNull();
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    handle?.release();
  });

  it('refuses a second acquire while a live holder owns the lock', () => {
    const dir = makeTempDir();
    const first = acquireAoiAutonomyLoopLock(dir, { pid: 100, host: 'h1', isPidAlive: () => true });
    expect(first).not.toBeNull();
    const second = acquireAoiAutonomyLoopLock(dir, {
      pid: 200,
      host: 'h1',
      isPidAlive: () => true,
    });
    expect(second).toBeNull();
    // The original holder's lock is left untouched.
    expect(readPid(dir)).toBe(100);
    first?.release();
  });

  it('reclaims a stale lock whose holder is dead', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ kind: 'aoi-autonomy-loop', pid: 999, host: 'h1', startedAt: 1 }),
    );
    const handle = acquireAoiAutonomyLoopLock(dir, {
      pid: 555,
      host: 'h1',
      isPidAlive: () => false,
    });
    expect(handle).not.toBeNull();
    expect(readPid(dir)).toBe(555);
    handle?.release();
  });

  it('reclaims a malformed lock file once it is past the mid-write grace', () => {
    const dir = makeTempDir();
    fs.writeFileSync(lockPath(dir), 'not-json{');
    // Age it past the grace: this is abandoned garbage, not a holder mid-write.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(dir), old, old);
    const handle = acquireAoiAutonomyLoopLock(dir, {
      pid: 7,
      host: 'h1',
      // Even a "live" probe cannot rescue a record that proves no ownership.
      isPidAlive: () => true,
    });
    expect(handle).not.toBeNull();
    expect(readPid(dir)).toBe(7);
    handle?.release();
  });

  it('refuses a freshly-created unreadable lock (a holder between create and write)', () => {
    const dir = makeTempDir();
    // Exactly what another process leaves visible between its exclusive create
    // and its record write. Stealing it would bypass the role rules entirely --
    // an unreadable record has no role to check -- and yield two owners.
    fs.writeFileSync(lockPath(dir), '');
    const handle = acquireAoiAutonomyLoopLock(dir, {
      pid: 7,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: () => true,
    });
    expect(handle).toBeNull();
    expect(fs.readFileSync(lockPath(dir), 'utf-8')).toBe('');
  });

  it('refuses when the lock is held by another host (liveness unverifiable)', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ kind: 'aoi-autonomy-loop', pid: 1, host: 'other-host', startedAt: 1 }),
    );
    const handle = acquireAoiAutonomyLoopLock(dir, {
      pid: 2,
      host: 'this-host',
      isPidAlive: () => false,
    });
    expect(handle).toBeNull();
    // Untouched.
    expect(readPid(dir)).toBe(1);
  });

  it('release only removes a lock this process still owns', () => {
    const dir = makeTempDir();
    const handle = acquireAoiAutonomyLoopLock(dir, { pid: 10, host: 'h1' });
    expect(handle).not.toBeNull();
    // Another process takes over the lock file (simulated).
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ kind: 'aoi-autonomy-loop', pid: 20, host: 'h1', startedAt: 2 }),
    );
    handle?.release();
    // The other owner's lock is left intact.
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    expect(readPid(dir)).toBe(20);
  });

  it('is idempotent on release', () => {
    const dir = makeTempDir();
    const handle = acquireAoiAutonomyLoopLock(dir, { pid: 1, host: 'h1' });
    handle?.release();
    expect(() => handle?.release()).not.toThrow();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });
});

describe('acquireAoiAutonomyLoopLock roles', () => {
  const alive = () => true;

  it('records the role of the holder', () => {
    const dir = makeTempDir();
    const handle = acquireAoiAutonomyLoopLock(dir, {
      pid: 1,
      host: 'h1',
      role: 'maintenance',
    });
    expect(handle).not.toBeNull();
    const record = JSON.parse(fs.readFileSync(lockPath(dir), 'utf-8')) as { role: string };
    expect(record.role).toBe('maintenance');
    handle?.release();
  });

  it('defaults to the authoritative loop role when the caller does not say', () => {
    const dir = makeTempDir();
    const handle = acquireAoiAutonomyLoopLock(dir, { pid: 1, host: 'h1' });
    const record = JSON.parse(fs.readFileSync(lockPath(dir), 'utf-8')) as { role: string };
    expect(record.role).toBe('loop');
    handle?.release();
  });

  it('lets the loop take over a LIVE maintenance lock', () => {
    const dir = makeTempDir();
    const maintenance = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });
    expect(maintenance).not.toBeNull();

    const loop = acquireAoiAutonomyLoopLock(dir, {
      pid: 200,
      host: 'h1',
      role: 'loop',
      isPidAlive: alive,
    });
    expect(loop).not.toBeNull();
    expect(readPid(dir)).toBe(200);
    // The displaced holder must be able to SEE that it lost the lock.
    expect(maintenance?.isOwner()).toBe(false);
    expect(loop?.isOwner()).toBe(true);

    // ...and releasing it must not remove the new owner's lock.
    maintenance?.release();
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    expect(readPid(dir)).toBe(200);
    loop?.release();
  });

  it('never lets maintenance displace a LIVE loop lock', () => {
    const dir = makeTempDir();
    const loop = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'loop',
      isPidAlive: alive,
    });
    expect(loop).not.toBeNull();

    const maintenance = acquireAoiAutonomyLoopLock(dir, {
      pid: 200,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });
    expect(maintenance).toBeNull();
    expect(readPid(dir)).toBe(100);
    expect(loop?.isOwner()).toBe(true);
    loop?.release();
  });

  it('refuses a second LIVE maintenance holder', () => {
    const dir = makeTempDir();
    const first = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });
    expect(first).not.toBeNull();
    expect(
      acquireAoiAutonomyLoopLock(dir, {
        pid: 200,
        host: 'h1',
        role: 'maintenance',
        isPidAlive: alive,
      }),
    ).toBeNull();
    first?.release();
  });

  it('treats a live record with NO role as a loop (an older build is never displaced)', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ kind: 'aoi-autonomy-loop', pid: 100, host: 'h1', startedAt: 1 }),
    );
    expect(
      acquireAoiAutonomyLoopLock(dir, { pid: 200, host: 'h1', role: 'loop', isPidAlive: alive }),
    ).toBeNull();
    expect(
      acquireAoiAutonomyLoopLock(dir, {
        pid: 200,
        host: 'h1',
        role: 'maintenance',
        isPidAlive: alive,
      }),
    ).toBeNull();
    expect(readPid(dir)).toBe(100);
  });

  it('still reclaims a stale maintenance lock for maintenance', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({
        kind: 'aoi-autonomy-loop',
        pid: 999,
        host: 'h1',
        startedAt: 1,
        role: 'maintenance',
      }),
    );
    const handle = acquireAoiAutonomyLoopLock(dir, {
      pid: 555,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: () => false,
    });
    expect(handle).not.toBeNull();
    expect(readPid(dir)).toBe(555);
    handle?.release();
  });

  it('refuses a cross-host takeover even for the loop (liveness unverifiable)', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({
        kind: 'aoi-autonomy-loop',
        pid: 1,
        host: 'other-host',
        startedAt: 1,
        role: 'maintenance',
      }),
    );
    expect(
      acquireAoiAutonomyLoopLock(dir, {
        pid: 2,
        host: 'this-host',
        role: 'loop',
        isPidAlive: alive,
      }),
    ).toBeNull();
    expect(readPid(dir)).toBe(1);
  });

  it('distinguishes two holders that share a pid', () => {
    const dir = makeTempDir();
    const maintenance = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });
    // Same pid AND host as the holder it displaces -- only the per-acquire id
    // tells them apart.
    const loop = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'loop',
      isPidAlive: alive,
    });
    expect(loop).not.toBeNull();
    expect(maintenance?.isOwner()).toBe(false);

    maintenance?.release();
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    expect(loop?.isOwner()).toBe(true);
    loop?.release();
  });
});

describe('createAoiAutonomyLoopLockKeeper', () => {
  const alive = () => true;

  it('yields while a live loop owns the dir and resumes once it is released', () => {
    const dir = makeTempDir();
    const loop = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'loop',
      isPidAlive: alive,
    });
    const keeper = createAoiAutonomyLoopLockKeeper(dir, {
      pid: 200,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });

    expect(keeper.ownsLock()).toBe(false);
    expect(readPid(dir)).toBe(100);

    loop?.release();
    // The next cycle picks the dir back up without a restart.
    expect(keeper.ownsLock()).toBe(true);
    expect(readPid(dir)).toBe(200);

    keeper.release();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });

  it('reports the loss as soon as a loop takes the lock over', () => {
    const dir = makeTempDir();
    const keeper = createAoiAutonomyLoopLockKeeper(dir, {
      pid: 200,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });
    expect(keeper.ownsLock()).toBe(true);

    const loop = acquireAoiAutonomyLoopLock(dir, {
      pid: 100,
      host: 'h1',
      role: 'loop',
      isPidAlive: alive,
    });
    expect(loop).not.toBeNull();
    // Ownership is re-read from disk, not assumed for the process lifetime.
    expect(keeper.ownsLock()).toBe(false);

    keeper.release();
    // Releasing the yielded keeper leaves the loop's lock intact.
    expect(readPid(dir)).toBe(100);
    loop?.release();
  });

  it('stays released after release()', () => {
    const dir = makeTempDir();
    const keeper = createAoiAutonomyLoopLockKeeper(dir, {
      pid: 200,
      host: 'h1',
      role: 'maintenance',
      isPidAlive: alive,
    });
    expect(keeper.ownsLock()).toBe(true);
    keeper.release();
    expect(keeper.ownsLock()).toBe(false);
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });
});
