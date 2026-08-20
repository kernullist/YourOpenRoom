import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addAoiBrowserDriveStandingGrant,
  consumeAoiBrowserDriveStandingGrant,
  consumeAoiBrowserDriveStandingGrantAtomic,
  findLiveAoiBrowserDriveStandingGrant,
  hostnameMatchesStandingDomain,
  isAoiBrowserDriveStandingGrantLive,
  loadAoiBrowserDriveStandingGrantStore,
  normalizeAoiBrowserDriveStandingGrant,
  removeAoiBrowserDriveStandingGrant,
  resolveAoiBrowserDriveStandingGrantStorePath,
  saveAoiBrowserDriveStandingGrantStore,
} from '../aoiBrowserDriveStandingGrant';

const tempRoots: string[] = [];
function makeHome(): string {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-bd-grant-'));
  tempRoots.push(home);
  return home;
}
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('add + normalize', () => {
  it('adds a grant with clamped ttl + quota and a valid domain', () => {
    const { store, grant } = addAoiBrowserDriveStandingGrant(
      null,
      { domain: 'https://Example.com/x', ttlMs: 999 * 24 * 60 * 60 * 1000, maxActions: 10_000 },
      1_000,
    );
    expect(grant).toBeDefined();
    expect(grant?.domain).toBe('example.com');
    // ttl clamped to <= 24h
    expect(grant!.expiresAt - grant!.createdAt).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    // quota clamped to <= 200
    expect(grant!.maxActions).toBeLessThanOrEqual(200);
    expect(store.grants).toHaveLength(1);
  });

  it('rejects an invalid domain', () => {
    const { grant, reason } = addAoiBrowserDriveStandingGrant(null, { domain: 'not a domain' }, 1);
    expect(grant).toBeUndefined();
    expect(reason).toBe('invalid_domain');
  });

  it('drops a malformed grant on normalize', () => {
    expect(normalizeAoiBrowserDriveStandingGrant({ version: 1, id: 'x' })).toBeNull();
    expect(normalizeAoiBrowserDriveStandingGrant(null)).toBeNull();
  });
});

describe('matching + liveness', () => {
  it('matches exact host and subdomains, not lookalikes', () => {
    expect(hostnameMatchesStandingDomain('example.com', 'example.com')).toBe(true);
    expect(hostnameMatchesStandingDomain('app.example.com', 'example.com')).toBe(true);
    expect(hostnameMatchesStandingDomain('notexample.com', 'example.com')).toBe(false);
    expect(hostnameMatchesStandingDomain('example.com.evil.com', 'example.com')).toBe(false);
  });

  it('finds a live grant for a covered host and ignores expired/exhausted', () => {
    const now = 10_000;
    const seeded = addAoiBrowserDriveStandingGrant(
      null,
      { domain: 'example.com', maxActions: 1 },
      now,
    ).store;
    expect(findLiveAoiBrowserDriveStandingGrant(seeded, 'app.example.com', now)?.domain).toBe(
      'example.com',
    );
    // exhaust it
    const grantId = seeded.grants[0].id;
    const after = consumeAoiBrowserDriveStandingGrant(seeded, grantId, now);
    expect(after.consumed).toBe(true);
    expect(findLiveAoiBrowserDriveStandingGrant(after.store, 'example.com', now)).toBeNull();
  });

  it('isLive is false past expiry or quota', () => {
    const grant = {
      version: 1 as const,
      id: 'g',
      domain: 'example.com',
      label: 'x',
      createdAt: 0,
      expiresAt: 100,
      maxActions: 2,
      usedActions: 2,
    };
    expect(isAoiBrowserDriveStandingGrantLive(grant, 50)).toBe(false); // quota
    expect(isAoiBrowserDriveStandingGrantLive({ ...grant, usedActions: 0 }, 200)).toBe(false); // expiry
    expect(isAoiBrowserDriveStandingGrantLive({ ...grant, usedActions: 0 }, 50)).toBe(true);
  });
});

describe('consume', () => {
  it('increments usedActions and refuses a missing/dead grant', () => {
    const now = 1;
    const seeded = addAoiBrowserDriveStandingGrant(
      null,
      { domain: 'example.com', maxActions: 3 },
      now,
    ).store;
    const id = seeded.grants[0].id;
    const first = consumeAoiBrowserDriveStandingGrant(seeded, id, now);
    expect(first.consumed).toBe(true);
    expect(first.store.grants[0].usedActions).toBe(1);
    const miss = consumeAoiBrowserDriveStandingGrant(seeded, 'nope', now);
    expect(miss.consumed).toBe(false);
  });
});

describe('persistence + remove', () => {
  it('round-trips and removes', () => {
    const home = makeHome();
    const added = addAoiBrowserDriveStandingGrant(null, { domain: 'example.com' }, 1000);
    saveAoiBrowserDriveStandingGrantStore(home, added.store);
    expect(fs.existsSync(resolveAoiBrowserDriveStandingGrantStorePath(home))).toBe(true);

    const loaded = loadAoiBrowserDriveStandingGrantStore(home);
    expect(loaded.grants).toHaveLength(1);

    const removed = removeAoiBrowserDriveStandingGrant(loaded, added.grant!.id, 1100);
    expect(removed.grants).toHaveLength(0);
  });

  it('returns an empty store when the file is missing', () => {
    const home = makeHome();
    expect(loadAoiBrowserDriveStandingGrantStore(home).grants).toEqual([]);
  });
});

// The quota is the point of a standing grant. Two processes over one store both
// read the same usedActions and both write it plus one, so the budget pays for
// one action while two happen.
describe('standing-grant quota under a concurrent consumer', () => {
  it('spends one action per consume, not one per process', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-grant-race-'));
    const now = Date.now();
    const created = addAoiBrowserDriveStandingGrant(
      null,
      { domain: 'example.com', maxActions: 1 },
      now,
    );
    expect(created.grant).not.toBeNull();
    saveAoiBrowserDriveStandingGrantStore(home, created.store);

    const first = consumeAoiBrowserDriveStandingGrantAtomic(home, created.grant?.id ?? '', now + 1);
    const second = consumeAoiBrowserDriveStandingGrantAtomic(
      home,
      created.grant?.id ?? '',
      now + 2,
    );

    // A quota of one buys exactly one action.
    expect([first.consumed, second.consumed].filter(Boolean)).toHaveLength(1);
  });
});
