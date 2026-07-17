import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ensureAoiHostBridgeToken,
  generateAoiHostBridgeToken,
  loadAoiHostBridgeToken,
  resolveAoiHostBridgeAuthTokenPath,
  rotateAoiHostBridgeToken,
  verifyAoiHostBridgeToken,
} from '../aoiHostBridgeAuth';

const tempRoots: string[] = [];

function makeTempHome(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-hostauth-test-'));
  tempRoots.push(root);
  return root;
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

describe('verifyAoiHostBridgeToken', () => {
  it('accepts an exact match and rejects everything else', () => {
    const token = 'a'.repeat(64);
    expect(verifyAoiHostBridgeToken(token, token)).toBe(true);
    expect(verifyAoiHostBridgeToken(token, `${token}x`)).toBe(false);
    expect(verifyAoiHostBridgeToken(token, 'a'.repeat(63))).toBe(false);
    expect(verifyAoiHostBridgeToken(token, 'b'.repeat(64))).toBe(false);
  });

  it('rejects empty, null, and non-string inputs', () => {
    expect(verifyAoiHostBridgeToken('', '')).toBe(false);
    expect(verifyAoiHostBridgeToken('tok', null)).toBe(false);
    expect(verifyAoiHostBridgeToken(null, 'tok')).toBe(false);
    expect(verifyAoiHostBridgeToken(undefined, undefined)).toBe(false);
    expect(verifyAoiHostBridgeToken(123 as unknown as string, 'tok')).toBe(false);
  });
});

describe('generateAoiHostBridgeToken', () => {
  it('mints a 64-hex-char (256-bit) token that differs each call', () => {
    const a = generateAoiHostBridgeToken();
    const b = generateAoiHostBridgeToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('ensure / load / rotate token', () => {
  it('mints on first use, reuses on subsequent calls, and verifies round-trip', () => {
    const home = makeTempHome();
    expect(loadAoiHostBridgeToken(home)).toBeNull();

    const first = ensureAoiHostBridgeToken(home, { generateToken: () => 'f'.repeat(64) });
    expect(first.created).toBe(true);
    expect(first.token).toBe('f'.repeat(64));
    expect(loadAoiHostBridgeToken(home)).toBe('f'.repeat(64));

    // Reuse: a second ensure returns the SAME token (a restart must not
    // invalidate a client that already holds it).
    const second = ensureAoiHostBridgeToken(home, { generateToken: () => 'g'.repeat(64) });
    expect(second.created).toBe(false);
    expect(second.token).toBe('f'.repeat(64));

    expect(verifyAoiHostBridgeToken(loadAoiHostBridgeToken(home), first.token)).toBe(true);
  });

  it('writes the token file with a restrictive mode', () => {
    const home = makeTempHome();
    ensureAoiHostBridgeToken(home, { generateToken: () => 'e'.repeat(64) });
    const mode = fs.statSync(resolveAoiHostBridgeAuthTokenPath(home)).mode & 0o777;
    // POSIX honors 0o600; Windows ignores the group/other bits but must still
    // grant the owner read/write.
    expect(mode & 0o600).toBe(0o600);
  });

  it('rotate replaces the token so the old one no longer verifies', () => {
    const home = makeTempHome();
    ensureAoiHostBridgeToken(home, { generateToken: () => '1'.repeat(64) });
    const rotated = rotateAoiHostBridgeToken(home, { generateToken: () => '2'.repeat(64) });
    expect(rotated.token).toBe('2'.repeat(64));
    expect(loadAoiHostBridgeToken(home)).toBe('2'.repeat(64));
    expect(verifyAoiHostBridgeToken(loadAoiHostBridgeToken(home), '1'.repeat(64))).toBe(false);
  });
});
