// Aoi browser-drive standing grants (P3.1a): the ONLY relaxation of Phase 2's per-
// ACT human approval, and the highest-risk surface of the whole feature. A standing
// grant is an operator-created, TTL-bounded, quota-limited pre-authorization for Aoi
// to act on ONE domain WITHOUT a per-action Approvals-inbox click.
//
// What a grant does NOT relax (all still enforced per-act, elsewhere): the domain
// allowlist, the forbidden hard-blocks (passwords/payment/OTP/CAPTCHA/financial
// commit), the redirect-drift block, the step audit, and panic. A grant only
// replaces the per-fingerprint inbox click for NON-forbidden actions on its domain,
// and only while the os_browser_drive_standing capability toggle is ON (checked by
// the caller). The grant is created by the human (actor='user', consume-not-author);
// Aoi never mints one.
//
// Scope = domain-wide (any non-forbidden action on the grant's registrable domain +
// its subdomains), bounded by an expiry and a max-action quota. Machine-scoped under
// ~/.openroom/host-bridge/browser-drive-standing-grants.json, mirroring the domain
// allowlist store. Server-only (fs); pure normalize/match/consume are exported for
// testing. Inert until P3.1b wires the approval gate.

import * as fs from 'fs';

import { withAoiHostStoreLock } from './aoiHostStoreLock';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

// The kill-switch capability toggle that must be ON for any grant to be honored
// (the single settings toggle; default OFF, and panic forces it off).
export const AOI_BROWSER_DRIVE_STANDING_CAPABILITY = 'os_browser_drive_standing';

const HOST_BRIDGE_DIR = 'host-bridge';
const STANDING_GRANTS_FILE = 'browser-drive-standing-grants.json';
const MAX_GRANTS = 32;
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // a grant can never outlive 24h
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_ACTIONS_CAP = 200;
const DEFAULT_MAX_ACTIONS = 20;
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Registrable hostname: >=2 dot-separated labels (mirrors the allowlist store).
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AoiBrowserDriveStandingGrant {
  version: 1;
  id: string;
  // Registrable hostname, lowercased. Covers the exact host and any subdomain.
  domain: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  maxActions: number;
  usedActions: number;
}

export interface AoiBrowserDriveStandingGrantStore {
  version: 1;
  grants: AoiBrowserDriveStandingGrant[];
  updatedAt: number;
}

export const DEFAULT_AOI_BROWSER_DRIVE_STANDING_GRANT_STORE: AoiBrowserDriveStandingGrantStore = {
  version: 1,
  grants: [],
  updatedAt: 0,
};

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  let host = value.trim().toLowerCase();
  // Tolerate a pasted URL: take its hostname.
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  host = host.replace(/\.$/, '');
  return DOMAIN_PATTERN.test(host) ? host : '';
}

export function normalizeAoiBrowserDriveStandingGrant(
  raw: unknown,
): AoiBrowserDriveStandingGrant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Partial<AoiBrowserDriveStandingGrant>;
  const domain = normalizeDomain(value.domain);
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !ENTRY_ID_PATTERN.test(value.id) ||
    !domain ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    typeof value.maxActions !== 'number' ||
    !Number.isFinite(value.maxActions)
  ) {
    return null;
  }
  const maxActions = Math.min(MAX_ACTIONS_CAP, Math.max(1, Math.trunc(value.maxActions)));
  const usedActions =
    typeof value.usedActions === 'number' && Number.isFinite(value.usedActions)
      ? Math.max(0, Math.trunc(value.usedActions))
      : 0;
  return {
    version: 1,
    id: value.id,
    domain,
    label: typeof value.label === 'string' ? value.label.slice(0, 120) : domain,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    maxActions,
    usedActions,
  };
}

// A grant is LIVE when it has not expired and has quota remaining. Pure.
export function isAoiBrowserDriveStandingGrantLive(
  grant: AoiBrowserDriveStandingGrant,
  now: number,
): boolean {
  return grant.expiresAt > now && grant.usedActions < grant.maxActions;
}

// Drop expired + exhausted grants and cap. Pure.
export function pruneAoiBrowserDriveStandingGrants(
  grants: readonly unknown[],
  now: number,
): AoiBrowserDriveStandingGrant[] {
  const live: AoiBrowserDriveStandingGrant[] = [];
  for (const candidate of grants) {
    const grant = normalizeAoiBrowserDriveStandingGrant(candidate);
    if (grant && isAoiBrowserDriveStandingGrantLive(grant, now)) {
      live.push(grant);
    }
  }
  return live.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_GRANTS);
}

export function normalizeAoiBrowserDriveStandingGrantStore(
  raw: unknown,
): AoiBrowserDriveStandingGrantStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_STANDING_GRANT_STORE, grants: [] };
  }
  const value = raw as Partial<AoiBrowserDriveStandingGrantStore>;
  const grants = Array.isArray(value.grants) ? value.grants : [];
  return {
    version: 1,
    grants: grants
      .map((grant) => normalizeAoiBrowserDriveStandingGrant(grant))
      .filter((grant): grant is AoiBrowserDriveStandingGrant => grant !== null)
      .slice(-MAX_GRANTS),
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

// A hostname is covered by a grant domain when it equals it or is a subdomain.
// Mirrors the allowlist matcher so a grant never covers more than an allowlist entry.
export function hostnameMatchesStandingDomain(hostname: string, domain: string): boolean {
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!host || !domain) {
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

// Find a LIVE grant covering the given hostname (newest-first so the freshest wins).
// Pure -- does not consume.
export function findLiveAoiBrowserDriveStandingGrant(
  store: AoiBrowserDriveStandingGrantStore | null | undefined,
  hostname: string,
  now: number,
): AoiBrowserDriveStandingGrant | null {
  const grants = pruneAoiBrowserDriveStandingGrants(
    normalizeAoiBrowserDriveStandingGrantStore(store).grants,
    now,
  );
  const matches = grants
    .filter((grant) => hostnameMatchesStandingDomain(hostname, grant.domain))
    .sort((a, b) => b.createdAt - a.createdAt);
  return matches[0] ?? null;
}

// Consume one action from a grant (usedActions += 1). Returns the updated store and
// whether a consume happened (false if the grant is missing / no longer live). Pure.
export function consumeAoiBrowserDriveStandingGrant(
  store: AoiBrowserDriveStandingGrantStore | null | undefined,
  grantId: string,
  now: number,
): { store: AoiBrowserDriveStandingGrantStore; consumed: boolean } {
  const base = normalizeAoiBrowserDriveStandingGrantStore(store);
  let consumed = false;
  const grants = base.grants.map((grant) => {
    if (grant.id === grantId && isAoiBrowserDriveStandingGrantLive(grant, now)) {
      consumed = true;
      return { ...grant, usedActions: grant.usedActions + 1 };
    }
    return grant;
  });
  // Prune AFTER incrementing so a just-exhausted grant drops out.
  const pruned = pruneAoiBrowserDriveStandingGrants(grants, now);
  return { store: { version: 1, grants: pruned, updatedAt: now }, consumed };
}

// Add a grant (operator action). Clamps TTL <= 24h and quota <= 200. Rejects a bad
// domain. Pure.
export function addAoiBrowserDriveStandingGrant(
  store: AoiBrowserDriveStandingGrantStore | null | undefined,
  input: { domain: string; label?: string; ttlMs?: number; maxActions?: number; id?: string },
  now: number,
): {
  store: AoiBrowserDriveStandingGrantStore;
  grant?: AoiBrowserDriveStandingGrant;
  reason?: string;
} {
  const base = pruneAoiBrowserDriveStandingGrants(
    normalizeAoiBrowserDriveStandingGrantStore(store).grants,
    now,
  );
  const domain = normalizeDomain(input.domain);
  if (!domain) {
    return { store: { version: 1, grants: base, updatedAt: now }, reason: 'invalid_domain' };
  }
  const ttlMs = Math.min(
    MAX_TTL_MS,
    Math.max(
      60_000,
      typeof input.ttlMs === 'number' && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS,
    ),
  );
  const maxActions = Math.min(
    MAX_ACTIONS_CAP,
    Math.max(
      1,
      typeof input.maxActions === 'number' && input.maxActions > 0
        ? Math.trunc(input.maxActions)
        : DEFAULT_MAX_ACTIONS,
    ),
  );
  const id =
    typeof input.id === 'string' && ENTRY_ID_PATTERN.test(input.id)
      ? input.id
      : `bdsg-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
  const grant: AoiBrowserDriveStandingGrant = {
    version: 1,
    id,
    domain,
    label:
      typeof input.label === 'string' && input.label.trim()
        ? input.label.trim().slice(0, 120)
        : domain,
    createdAt: now,
    expiresAt: now + ttlMs,
    maxActions,
    usedActions: 0,
  };
  const grants = [...base.filter((existing) => existing.id !== id), grant].slice(-MAX_GRANTS);
  return { store: { version: 1, grants, updatedAt: now }, grant };
}

export function removeAoiBrowserDriveStandingGrant(
  store: AoiBrowserDriveStandingGrantStore | null | undefined,
  grantId: string,
  now: number,
): AoiBrowserDriveStandingGrantStore {
  const base = normalizeAoiBrowserDriveStandingGrantStore(store);
  return {
    version: 1,
    grants: pruneAoiBrowserDriveStandingGrants(
      base.grants.filter((grant) => grant.id !== grantId),
      now,
    ),
    updatedAt: now,
  };
}

// --- Persistence -------------------------------------------------------------

export function resolveAoiBrowserDriveStandingGrantStorePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, STANDING_GRANTS_FILE);
}

export function loadAoiBrowserDriveStandingGrantStore(
  openroomHome: string,
): AoiBrowserDriveStandingGrantStore {
  try {
    const filePath = resolveAoiBrowserDriveStandingGrantStorePath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_BROWSER_DRIVE_STANDING_GRANT_STORE, grants: [] };
    }
    return normalizeAoiBrowserDriveStandingGrantStore(
      JSON.parse(fs.readFileSync(filePath, 'utf-8')),
    );
  } catch {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_STANDING_GRANT_STORE, grants: [] };
  }
}

/**
 * Consume one action from a grant under the same cross-process lock.
 *
 * The quota is the whole point of a standing grant: without the lock two
 * processes read the same usedActions, both write it plus one, and the budget
 * pays for one action while two happen.
 */
export function consumeAoiBrowserDriveStandingGrantAtomic(
  openroomHome: string,
  grantId: string,
  now: number,
): { store: AoiBrowserDriveStandingGrantStore; consumed: boolean } {
  return withAoiHostStoreLock(openroomHome, 'standing-grants', () => {
    const result = consumeAoiBrowserDriveStandingGrant(
      loadAoiBrowserDriveStandingGrantStore(openroomHome),
      grantId,
      now,
    );
    if (result.consumed) {
      saveAoiBrowserDriveStandingGrantStore(openroomHome, result.store);
    }
    return result;
  });
}

/**
 * Load, mutate and save under the cross-process store lock.
 *
 * The daemon and the dev server are separate processes over one openroomHome,
 * so a load-modify-save assembled from the pieces can be interleaved and the
 * loser's write silently lost. The mutator receives state read INSIDE the lock;
 * returning null means "do not save".
 *
 * The mutator must be synchronous -- an async one would release the lock at its
 * first await while the rest of the work continued.
 */
export function updateAoiBrowserDriveStandingGrantStore<R>(
  openroomHome: string,
  mutate: (current: AoiBrowserDriveStandingGrantStore) => {
    next: AoiBrowserDriveStandingGrantStore | null;
    result: R;
  },
): { result: R; saved: AoiBrowserDriveStandingGrantStore | null } {
  return withAoiHostStoreLock(openroomHome, 'standing-grants', () => {
    const { next, result } = mutate(loadAoiBrowserDriveStandingGrantStore(openroomHome));
    return {
      result,
      saved: next ? saveAoiBrowserDriveStandingGrantStore(openroomHome, next) : null,
    };
  });
}

export function saveAoiBrowserDriveStandingGrantStore(
  openroomHome: string,
  store: AoiBrowserDriveStandingGrantStore,
): AoiBrowserDriveStandingGrantStore {
  const normalized = normalizeAoiBrowserDriveStandingGrantStore(store);
  const filePath = resolveAoiBrowserDriveStandingGrantStorePath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}
