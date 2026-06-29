// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { acquireAoiAutonomyLoopLock } from '../aoiAutonomyLoopLock';

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

  it('reclaims a malformed lock file', () => {
    const dir = makeTempDir();
    fs.writeFileSync(lockPath(dir), 'not-json{');
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
