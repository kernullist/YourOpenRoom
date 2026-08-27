import { describe, expect, it } from 'vitest';
import {
  addIdaSqlStandingGrant,
  consumeIdaSqlStandingGrant,
  findLiveIdaSqlStandingGrant,
  isIdaSqlStandingGrantLive,
  normalizeIdaSqlStandingGrant,
  normalizeIdaSqlStandingGrantStore,
  pruneIdaSqlStandingGrants,
  removeIdaSqlStandingGrant,
  DEFAULT_IDA_SQL_STANDING_GRANT_STORE,
} from '../idaSqlStandingGrant';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function storeWithGrant(overrides: Record<string, unknown> = {}) {
  const added = addIdaSqlStandingGrant(DEFAULT_IDA_SQL_STANDING_GRANT_STORE, {
    rootId: 'bins',
    now: NOW,
    ...overrides,
  });
  return { store: added.store, grant: added.grant };
}

describe('normalizeIdaSqlStandingGrant', () => {
  it('rejects junk and an invalid root id', () => {
    expect(normalizeIdaSqlStandingGrant(null)).toBeNull();
    expect(
      normalizeIdaSqlStandingGrant({ id: 'g', rootId: 'BAD ID', createdAt: NOW, expiresAt: NOW }),
    ).toBeNull();
    expect(normalizeIdaSqlStandingGrant({ id: '', rootId: 'bins' })).toBeNull();
  });

  it('clamps a hand-edited expiry to the 24h ceiling', () => {
    const grant = normalizeIdaSqlStandingGrant({
      id: 'g',
      rootId: 'bins',
      createdAt: NOW,
      expiresAt: NOW + 30 * DAY_MS,
    });
    expect(grant?.expiresAt).toBe(NOW + DAY_MS);
  });

  it('clamps the session quota', () => {
    const grant = normalizeIdaSqlStandingGrant({
      id: 'g',
      rootId: 'bins',
      createdAt: NOW,
      expiresAt: NOW + 1000,
      maxSessions: 9999,
    });
    expect(grant?.maxSessions).toBe(20);
  });

  it('lowercases the root id so lookups cannot miss by case', () => {
    const grant = normalizeIdaSqlStandingGrant({
      id: 'g',
      rootId: 'BINS',
      createdAt: NOW,
      expiresAt: NOW + 1000,
    });
    expect(grant?.rootId).toBe('bins');
  });
});

describe('addIdaSqlStandingGrant', () => {
  it('defaults to a 2h TTL and a 3-session quota', () => {
    const { grant } = storeWithGrant();
    expect(grant?.expiresAt).toBe(NOW + 2 * 60 * 60 * 1000);
    expect(grant?.maxSessions).toBe(3);
  });

  it('caps an oversized TTL request at 24h', () => {
    const { grant } = storeWithGrant({ ttlMs: 30 * DAY_MS });
    expect(grant?.expiresAt).toBe(NOW + DAY_MS);
  });

  it('replaces rather than stacks a grant for the same root', () => {
    const first = storeWithGrant({ maxSessions: 1 });
    const second = addIdaSqlStandingGrant(first.store, {
      rootId: 'bins',
      maxSessions: 5,
      now: NOW + 1000,
    });
    expect(second.store.grants).toHaveLength(1);
    expect(second.store.grants[0].maxSessions).toBe(5);
  });

  it('refuses an invalid root id', () => {
    const result = addIdaSqlStandingGrant(DEFAULT_IDA_SQL_STANDING_GRANT_STORE, {
      rootId: 'not a root',
      now: NOW,
    });
    expect(result.grant).toBeNull();
    expect(result.reason).toBe('invalid_root_id');
  });
});

describe('grant liveness and consumption', () => {
  it('is not live once expired', () => {
    const { grant } = storeWithGrant({ ttlMs: 1000 });
    expect(isIdaSqlStandingGrantLive(grant!, NOW + 500)).toBe(true);
    expect(isIdaSqlStandingGrantLive(grant!, NOW + 2000)).toBe(false);
  });

  it('is not live when it claims to have been created in the future', () => {
    // expiresAt is clamped to createdAt + 24h, so a createdAt in the future
    // carries the ceiling with it and yields a grant honored for far longer than
    // a day. A grant created in the future is not a grant.
    const forged = normalizeIdaSqlStandingGrant({
      id: 'forged',
      rootId: 'bins',
      createdAt: NOW + 30 * DAY_MS,
      expiresAt: NOW + 31 * DAY_MS,
      maxSessions: 5,
    });
    expect(forged).not.toBeNull();
    expect(isIdaSqlStandingGrantLive(forged!, NOW)).toBe(false);
    expect(
      findLiveIdaSqlStandingGrant({ version: 1, grants: [forged!], updatedAt: NOW }, 'bins', NOW),
    ).toBeNull();
  });

  it('is not live once it is older than the TTL ceiling, whatever expiresAt says', () => {
    const stale = normalizeIdaSqlStandingGrant({
      id: 'stale',
      rootId: 'bins',
      createdAt: NOW,
      expiresAt: NOW + DAY_MS,
      maxSessions: 5,
    });
    expect(isIdaSqlStandingGrantLive(stale!, NOW + DAY_MS - 1)).toBe(true);
    expect(isIdaSqlStandingGrantLive(stale!, NOW + DAY_MS + 1)).toBe(false);
  });

  it('is not live once the quota is spent', () => {
    const { store, grant } = storeWithGrant({ maxSessions: 1 });
    const consumed = consumeIdaSqlStandingGrant(store, grant!.id, NOW);
    expect(consumed.consumed).toBe(true);
    expect(findLiveIdaSqlStandingGrant(consumed.store, 'bins', NOW)).toBeNull();
  });

  it('counts each consumption once and drops the grant when the quota runs out', () => {
    const { store, grant } = storeWithGrant({ maxSessions: 2 });
    const first = consumeIdaSqlStandingGrant(store, grant!.id, NOW);
    expect(first.consumed).toBe(true);
    expect(first.store.grants[0].usedSessions).toBe(1);

    const second = consumeIdaSqlStandingGrant(first.store, grant!.id, NOW);
    expect(second.consumed).toBe(true);
    // Exhausted grants are pruned on the way out, so the quota cannot be
    // re-read as available by a later caller.
    expect(second.store.grants).toHaveLength(0);

    const third = consumeIdaSqlStandingGrant(second.store, grant!.id, NOW);
    expect(third.consumed).toBe(false);
  });

  it('will not consume an unknown grant', () => {
    const { store } = storeWithGrant();
    expect(consumeIdaSqlStandingGrant(store, 'nope', NOW).consumed).toBe(false);
  });

  it('matches only the requested root', () => {
    const { store } = storeWithGrant();
    expect(findLiveIdaSqlStandingGrant(store, 'bins', NOW)).not.toBeNull();
    expect(findLiveIdaSqlStandingGrant(store, 'other', NOW)).toBeNull();
    expect(findLiveIdaSqlStandingGrant(store, '', NOW)).toBeNull();
  });
});

describe('store maintenance', () => {
  it('prunes expired and exhausted grants', () => {
    const { store, grant } = storeWithGrant({ ttlMs: 1000 });
    expect(pruneIdaSqlStandingGrants(store.grants, NOW + 2000)).toHaveLength(0);
    expect(pruneIdaSqlStandingGrants(store.grants, NOW)).toHaveLength(1);
    expect(grant).not.toBeNull();
  });

  it('removes a grant by id', () => {
    const { store, grant } = storeWithGrant();
    const removed = removeIdaSqlStandingGrant(store, grant!.id, NOW);
    expect(removed.removed).toBe(true);
    expect(removed.store.grants).toHaveLength(0);
  });

  it('normalizes a corrupt store to empty rather than throwing', () => {
    expect(normalizeIdaSqlStandingGrantStore('nonsense').grants).toEqual([]);
    expect(normalizeIdaSqlStandingGrantStore({ grants: [{ bogus: true }] }).grants).toEqual([]);
  });
});
