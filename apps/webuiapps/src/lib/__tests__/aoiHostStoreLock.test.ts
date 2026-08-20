import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  AoiHostStoreLockTimeout,
  resolveAoiHostStoreLockPath,
  withAoiHostStoreLock,
} from '../aoiHostStoreLock';

function makeHome(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'aoi-store-lock-'));
}

describe('withAoiHostStoreLock', () => {
  it('returns the body result and leaves no lock behind', () => {
    const home = makeHome();
    expect(withAoiHostStoreLock(home, 'approvals', () => 'done')).toBe('done');
    expect(fs.existsSync(resolveAoiHostStoreLockPath(home, 'approvals'))).toBe(false);
  });

  it('releases the lock when the body throws', () => {
    // A body that throws must not wedge every later caller out of the store.
    const home = makeHome();
    expect(() =>
      withAoiHostStoreLock(home, 'approvals', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(resolveAoiHostStoreLockPath(home, 'approvals'))).toBe(false);
    expect(withAoiHostStoreLock(home, 'approvals', () => 'after')).toBe('after');
  });

  it('refuses rather than proceeding when the lock is held', () => {
    // Fail CLOSED. Proceeding unprotected is what the lock exists to prevent,
    // so a caller that cannot take it is told, not waved through.
    const home = makeHome();
    const lockPath = resolveAoiHostStoreLockPath(home, 'approvals');
    fs.mkdirSync(join(lockPath, '..'), { recursive: true });
    fs.writeFileSync(lockPath, '99999\n');

    let ran = false;
    expect(() =>
      withAoiHostStoreLock(
        home,
        'approvals',
        () => {
          ran = true;
        },
        { timeoutMs: 30 },
      ),
    ).toThrow(AoiHostStoreLockTimeout);
    expect(ran).toBe(false);
  });

  it('reclaims a lock left behind by a process that died', () => {
    // Otherwise one hard kill locks the operator out of their own store until
    // they find and delete the file.
    const home = makeHome();
    const lockPath = resolveAoiHostStoreLockPath(home, 'approvals');
    fs.mkdirSync(join(lockPath, '..'), { recursive: true });
    fs.writeFileSync(lockPath, '99999\n');
    const old = Date.now() - 60_000;
    fs.utimesSync(lockPath, new Date(old), new Date(old));

    expect(withAoiHostStoreLock(home, 'approvals', () => 'reclaimed', { staleMs: 30_000 })).toBe(
      'reclaimed',
    );
  });

  it('separates locks by name', () => {
    // Two different stores must not block each other.
    const home = makeHome();
    const held = resolveAoiHostStoreLockPath(home, 'approvals');
    fs.mkdirSync(join(held, '..'), { recursive: true });
    fs.writeFileSync(held, '99999\n');

    expect(
      withAoiHostStoreLock(home, 'standing-grants', () => 'independent', { timeoutMs: 30 }),
    ).toBe('independent');
  });
});
