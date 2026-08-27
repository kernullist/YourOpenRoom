// IDA Lab standing grants: the ONLY way a session starts without a human click.
//
// The operator asked for autonomous analysis -- Aoi picking a binary and starting
// IDA while nobody is watching. That is a real process launch, so the relaxation
// is bounded on four axes at once:
//
//   - SCOPE: one registered binary root per grant, never "any path".
//   - TTL: a grant cannot outlive 24h and defaults to 2h.
//   - QUOTA: a grant covers a fixed number of session starts and is consumed
//     under the cross-process store lock, so the dev server and the daemon cannot
//     both spend the same one.
//   - CAPABILITY: nothing here is honored unless os_ida_auto_session is on, and
//     global panic forces that off.
//
// What a grant does NOT relax: the binary-root containment check, the SQL
// classifier (a write query still needs its own approval), the forbidden-statement
// refusals, and the session cap. It replaces one click for one kind of action.
//
// Aoi never mints a grant: the create route is operator-facing, and Aoi's tool
// surface does not include it (same posture as the host-bridge approvals).
//
// Machine-scoped under ~/.openroom/host-bridge/ida-standing-grants.json.
// Server-only (fs); the pure helpers are exported for tests.
import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

import { withAoiHostStoreLock } from './aoiHostStoreLock';
import { IDA_SQL_AUTO_SESSION_CAPABILITY } from './idaSqlTypes';
import type { IdaSqlStandingGrantView } from './idaSqlTypes';

export { IDA_SQL_AUTO_SESSION_CAPABILITY };

const HOST_BRIDGE_DIR = 'host-bridge';
const STANDING_GRANTS_FILE = 'ida-standing-grants.json';
const MAX_GRANTS = 8;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS_CAP = 20;
const DEFAULT_MAX_SESSIONS = 3;
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface IdaSqlStandingGrant extends IdaSqlStandingGrantView {
  version: 1;
}

export interface IdaSqlStandingGrantStore {
  version: 1;
  grants: IdaSqlStandingGrant[];
  updatedAt: number;
}

export const DEFAULT_IDA_SQL_STANDING_GRANT_STORE: IdaSqlStandingGrantStore = {
  version: 1,
  grants: [],
  updatedAt: 0,
};

export function normalizeIdaSqlStandingGrant(raw: unknown): IdaSqlStandingGrant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Partial<IdaSqlStandingGrant>;
  const rootId = typeof value.rootId === 'string' ? value.rootId.trim().toLowerCase() : '';
  if (!ROOT_ID_PATTERN.test(rootId)) {
    return null;
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    return null;
  }
  if (typeof value.createdAt !== 'number' || typeof value.expiresAt !== 'number') {
    return null;
  }
  const maxSessions =
    typeof value.maxSessions === 'number' && Number.isFinite(value.maxSessions)
      ? Math.min(MAX_SESSIONS_CAP, Math.max(1, Math.floor(value.maxSessions)))
      : DEFAULT_MAX_SESSIONS;
  const usedSessions =
    typeof value.usedSessions === 'number' && Number.isFinite(value.usedSessions)
      ? Math.max(0, Math.floor(value.usedSessions))
      : 0;
  // An expiry beyond the ceiling is clamped rather than honored: a hand-edited
  // file must not be able to mint an unbounded grant. The other half of that
  // ceiling -- a createdAt in the FUTURE, which would carry the clamp forward
  // with it -- is enforced in isIdaSqlStandingGrantLive, which is the function
  // that has a clock.
  const expiresAt = Math.min(value.expiresAt, value.createdAt + MAX_TTL_MS);
  return {
    version: 1,
    id: value.id.trim().slice(0, 80),
    rootId,
    label:
      typeof value.label === 'string' && value.label.trim()
        ? value.label.trim().slice(0, 120)
        : rootId,
    createdAt: value.createdAt,
    expiresAt,
    maxSessions,
    usedSessions,
  };
}

/**
 * A grant is live when it has not expired, has quota left, and was created in the
 * past within the TTL ceiling.
 *
 * The createdAt checks are not paranoia about clocks: expiresAt is clamped to
 * createdAt + MAX_TTL_MS, so a hand-written createdAt far in the future carries
 * that clamp forward and yields a grant honored for far longer than a day. A
 * grant that claims to have been created in the future is not a grant.
 */
export function isIdaSqlStandingGrantLive(grant: IdaSqlStandingGrant, now: number): boolean {
  if (grant.createdAt > now || now - grant.createdAt > MAX_TTL_MS) {
    return false;
  }
  return grant.expiresAt > now && grant.usedSessions < grant.maxSessions;
}

export function pruneIdaSqlStandingGrants(
  grants: readonly IdaSqlStandingGrant[],
  now: number,
): IdaSqlStandingGrant[] {
  return grants.filter((grant) => isIdaSqlStandingGrantLive(grant, now)).slice(-MAX_GRANTS);
}

export function normalizeIdaSqlStandingGrantStore(raw: unknown): IdaSqlStandingGrantStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_IDA_SQL_STANDING_GRANT_STORE, grants: [] };
  }
  const value = raw as Partial<IdaSqlStandingGrantStore>;
  const grants: IdaSqlStandingGrant[] = [];
  for (const entry of Array.isArray(value.grants) ? value.grants : []) {
    const grant = normalizeIdaSqlStandingGrant(entry);
    if (grant) {
      grants.push(grant);
    }
    if (grants.length >= MAX_GRANTS) {
      break;
    }
  }
  return {
    version: 1,
    grants,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

/** The live grant covering this root, if any. */
export function findLiveIdaSqlStandingGrant(
  store: IdaSqlStandingGrantStore,
  rootId: string,
  now: number,
): IdaSqlStandingGrant | null {
  const wanted = rootId.trim().toLowerCase();
  if (!wanted) {
    return null;
  }
  return (
    store.grants.find(
      (grant) => grant.rootId === wanted && isIdaSqlStandingGrantLive(grant, now),
    ) ?? null
  );
}

export function consumeIdaSqlStandingGrant(
  store: IdaSqlStandingGrantStore,
  grantId: string,
  now: number,
): { store: IdaSqlStandingGrantStore; consumed: boolean } {
  const base = normalizeIdaSqlStandingGrantStore(store);
  const index = base.grants.findIndex((grant) => grant.id === grantId);
  if (index < 0) {
    return { store: base, consumed: false };
  }
  const grant = base.grants[index];
  if (!isIdaSqlStandingGrantLive(grant, now)) {
    return { store: base, consumed: false };
  }
  const grants = [...base.grants];
  grants[index] = { ...grant, usedSessions: grant.usedSessions + 1 };
  return {
    store: { version: 1, grants: pruneIdaSqlStandingGrants(grants, now), updatedAt: now },
    consumed: true,
  };
}

export function addIdaSqlStandingGrant(
  store: IdaSqlStandingGrantStore,
  params: {
    rootId: string;
    label?: string;
    ttlMs?: number;
    maxSessions?: number;
    now: number;
  },
): { store: IdaSqlStandingGrantStore; grant: IdaSqlStandingGrant | null; reason: string } {
  const rootId = params.rootId.trim().toLowerCase();
  if (!ROOT_ID_PATTERN.test(rootId)) {
    return { store, grant: null, reason: 'invalid_root_id' };
  }
  const base = normalizeIdaSqlStandingGrantStore(store);
  const pruned = pruneIdaSqlStandingGrants(base.grants, params.now);
  if (pruned.length >= MAX_GRANTS) {
    return { store: base, grant: null, reason: 'too_many_grants' };
  }
  const ttlMs =
    typeof params.ttlMs === 'number' && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? Math.min(MAX_TTL_MS, Math.floor(params.ttlMs))
      : DEFAULT_TTL_MS;
  const maxSessions =
    typeof params.maxSessions === 'number' && Number.isFinite(params.maxSessions)
      ? Math.min(MAX_SESSIONS_CAP, Math.max(1, Math.floor(params.maxSessions)))
      : DEFAULT_MAX_SESSIONS;
  const grant: IdaSqlStandingGrant = {
    version: 1,
    id: `ida-grant-${params.now.toString(36)}-${randomUUID().slice(0, 8)}`,
    rootId,
    label: params.label?.trim() ? params.label.trim().slice(0, 120) : rootId,
    createdAt: params.now,
    expiresAt: params.now + ttlMs,
    maxSessions,
    usedSessions: 0,
  };
  return {
    store: {
      version: 1,
      // One grant per root: re-granting replaces rather than stacks, so quotas
      // cannot be multiplied by asking twice.
      grants: [...pruned.filter((entry) => entry.rootId !== rootId), grant],
      updatedAt: params.now,
    },
    grant,
    reason: '',
  };
}

export function removeIdaSqlStandingGrant(
  store: IdaSqlStandingGrantStore,
  grantId: string,
  now: number,
): { store: IdaSqlStandingGrantStore; removed: boolean } {
  const base = normalizeIdaSqlStandingGrantStore(store);
  const grants = base.grants.filter((grant) => grant.id !== grantId);
  return {
    store: { version: 1, grants, updatedAt: now },
    removed: grants.length !== base.grants.length,
  };
}

// --- Persistence -------------------------------------------------------------

export function resolveIdaSqlStandingGrantStorePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, STANDING_GRANTS_FILE);
}

export function loadIdaSqlStandingGrantStore(openroomHome: string): IdaSqlStandingGrantStore {
  try {
    const filePath = resolveIdaSqlStandingGrantStorePath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_IDA_SQL_STANDING_GRANT_STORE, grants: [] };
    }
    return normalizeIdaSqlStandingGrantStore(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_IDA_SQL_STANDING_GRANT_STORE, grants: [] };
  }
}

export function saveIdaSqlStandingGrantStore(
  openroomHome: string,
  store: IdaSqlStandingGrantStore,
): IdaSqlStandingGrantStore {
  const normalized = normalizeIdaSqlStandingGrantStore(store);
  const filePath = resolveIdaSqlStandingGrantStorePath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}

/**
 * Consume one session from a grant under the cross-process lock. The quota is the
 * whole point: without the lock the daemon and the dev server read the same
 * usedSessions, both write it plus one, and one budgeted start becomes two.
 */
export function consumeIdaSqlStandingGrantAtomic(
  openroomHome: string,
  grantId: string,
  now: number,
): { store: IdaSqlStandingGrantStore; consumed: boolean } {
  return withAoiHostStoreLock(openroomHome, 'ida-standing-grants', () => {
    const result = consumeIdaSqlStandingGrant(
      loadIdaSqlStandingGrantStore(openroomHome),
      grantId,
      now,
    );
    if (result.consumed) {
      saveIdaSqlStandingGrantStore(openroomHome, result.store);
    }
    return result;
  });
}

/** Load, mutate and save under the store lock. The mutator must be synchronous. */
export function updateIdaSqlStandingGrantStore<R>(
  openroomHome: string,
  mutate: (current: IdaSqlStandingGrantStore) => {
    next: IdaSqlStandingGrantStore | null;
    result: R;
  },
): { result: R; saved: IdaSqlStandingGrantStore | null } {
  return withAoiHostStoreLock(openroomHome, 'ida-standing-grants', () => {
    const { next, result } = mutate(loadIdaSqlStandingGrantStore(openroomHome));
    return {
      result,
      saved: next ? saveIdaSqlStandingGrantStore(openroomHome, next) : null,
    };
  });
}
