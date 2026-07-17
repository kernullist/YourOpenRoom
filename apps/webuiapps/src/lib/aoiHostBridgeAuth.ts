// Aoi host-bridge local authentication (HP0): a file-permission shared-secret
// token that authenticates the browser (or any client) to the daemon before a
// host-bridge request is considered.
//
// Threat it addresses (docs/aoi-host-access-design.md, T2): the daemon binds
// loopback, but any process on the same machine can still reach 127.0.0.1:7333.
// The daemon writes a random token to an owner-only file under ~/.openroom/
// host-bridge/; only the same OS user can read it, so a request that echoes the
// token proves it came from a process the user controls. This keeps the
// existing HTTP transport (no named-pipe migration) while closing the port to
// unauthenticated local callers.
//
// Server-only (fs / crypto / child_process). verifyAoiHostBridgeToken is PURE
// and constant-time so it is unit-testable and leaks no length-independent
// timing. Token minting, file ACL hardening, and load are the effectful edges.
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { dirname, resolve } from 'path';
import { userInfo } from 'os';

const HOST_BRIDGE_DIR = 'host-bridge';
const AUTH_TOKEN_FILE = 'auth-token';
const TOKEN_BYTES = 32;
export const AOI_HOST_BRIDGE_AUTH_HEADER = 'x-aoi-host-bridge-token';

export function resolveAoiHostBridgeAuthTokenPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, AUTH_TOKEN_FILE);
}

// A fresh 256-bit hex token. Separated so tests can inject a deterministic one.
export function generateAoiHostBridgeToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

// Constant-time token comparison. Length mismatch returns false immediately
// (the token length is not a secret); equal-length inputs go through
// timingSafeEqual so a byte-by-byte early-exit cannot leak the token.
export function verifyAoiHostBridgeToken(
  expected: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }
  if (expected.length === 0 || expected.length !== provided.length) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'utf-8');
  const providedBuffer = Buffer.from(provided, 'utf-8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

// Best-effort owner-only lockdown of the token file on Windows: strip
// inheritance and grant the current user read+write ONLY (no other principal).
// Read+write, not read-only: the daemon itself must be able to rotate/overwrite
// the token; only OTHER users are meant to be shut out. A failure is non-fatal
// (the 0o600 mode below is the portable baseline) but is surfaced so the
// operator can harden manually if the ACL step is unavailable.
function applyOwnerOnlyAcl(filePath: string): { ok: boolean; reason?: string } {
  if (process.platform !== 'win32') {
    return { ok: true };
  }
  const user = userInfo().username;
  if (!user) {
    return { ok: false, reason: 'unknown_user' };
  }
  try {
    const result = spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(R,W)`], {
      windowsHide: true,
      encoding: 'utf-8',
    });
    if (result.status === 0) {
      return { ok: true };
    }
    return { ok: false, reason: (result.stderr || 'icacls_failed').trim().slice(0, 180) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 180) : 'icacls_error',
    };
  }
}

export interface EnsureAoiHostBridgeTokenResult {
  token: string;
  created: boolean;
  aclApplied: boolean;
  aclReason?: string;
}

// Return the daemon's host-bridge token, minting + persisting one on first use.
// The file is written 0o600 (portable) and then locked to the owner via ACL on
// Windows (best-effort). An existing token is reused as-is so restarts do not
// invalidate a client that already holds it.
export function ensureAoiHostBridgeToken(
  openroomHome: string,
  options: { generateToken?: () => string } = {},
): EnsureAoiHostBridgeTokenResult {
  const filePath = resolveAoiHostBridgeAuthTokenPath(openroomHome);
  const existing = loadAoiHostBridgeToken(openroomHome);
  if (existing) {
    return { token: existing, created: false, aclApplied: true };
  }
  const token = (options.generateToken ?? generateAoiHostBridgeToken)();
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, token, { encoding: 'utf-8', mode: 0o600 });
  const acl = applyOwnerOnlyAcl(filePath);
  return {
    token,
    created: true,
    aclApplied: acl.ok,
    ...(acl.reason ? { aclReason: acl.reason } : {}),
  };
}

// Read the persisted token, or null when absent/unreadable/empty.
export function loadAoiHostBridgeToken(openroomHome: string): string | null {
  try {
    const filePath = resolveAoiHostBridgeAuthTokenPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const token = fs.readFileSync(filePath, 'utf-8').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// Rotate the token (e.g. suspected leak): mint a new one, overwrite, re-ACL.
// Clients must re-read the token file after a rotation.
export function rotateAoiHostBridgeToken(
  openroomHome: string,
  options: { generateToken?: () => string } = {},
): EnsureAoiHostBridgeTokenResult {
  const filePath = resolveAoiHostBridgeAuthTokenPath(openroomHome);
  const token = (options.generateToken ?? generateAoiHostBridgeToken)();
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, token, { encoding: 'utf-8', mode: 0o600 });
  const acl = applyOwnerOnlyAcl(filePath);
  return {
    token,
    created: true,
    aclApplied: acl.ok,
    ...(acl.reason ? { aclReason: acl.reason } : {}),
  };
}
