import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  addAoiBrowserDriveAllowlistEntry,
  isAoiBrowserDriveUrlAllowed,
  loadAoiBrowserDriveAllowlist,
  normalizeAoiBrowserDriveAllowlist,
  normalizeAoiBrowserDriveDomain,
  removeAoiBrowserDriveAllowlistEntry,
  resolveAoiBrowserDriveAllowlistPath,
  saveAoiBrowserDriveAllowlist,
  type AoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';

describe('normalizeAoiBrowserDriveDomain', () => {
  it('accepts registrable domains and reduces URLs/wildcards/ports', () => {
    expect(normalizeAoiBrowserDriveDomain('GitHub.com')).toBe('github.com');
    expect(normalizeAoiBrowserDriveDomain('https://mail.google.com/inbox')).toBe('mail.google.com');
    expect(normalizeAoiBrowserDriveDomain('*.example.com')).toBe('example.com');
    expect(normalizeAoiBrowserDriveDomain('example.com:8443')).toBe('example.com');
    expect(normalizeAoiBrowserDriveDomain('example.com.')).toBe('example.com');
    expect(normalizeAoiBrowserDriveDomain('sub.deep.example.co.uk')).toBe('sub.deep.example.co.uk');
  });

  it('rejects single labels, IPs, and junk', () => {
    expect(normalizeAoiBrowserDriveDomain('localhost')).toBeNull();
    expect(normalizeAoiBrowserDriveDomain('127.0.0.1')).toBeNull();
    expect(normalizeAoiBrowserDriveDomain('has space.com')).toBeNull();
    expect(normalizeAoiBrowserDriveDomain('')).toBeNull();
    expect(normalizeAoiBrowserDriveDomain('http://')).toBeNull();
  });
});

describe('normalizeAoiBrowserDriveAllowlist', () => {
  it('drops non-v1 shapes and dedups ids + domains', () => {
    expect(normalizeAoiBrowserDriveAllowlist(null).entries).toEqual([]);
    expect(normalizeAoiBrowserDriveAllowlist({ version: 2, entries: [] }).entries).toEqual([]);
    const raw = {
      version: 1,
      updatedAt: 5,
      entries: [
        { id: 'a', domain: 'example.com', label: 'Ex', addedAt: 1 },
        { id: 'a', domain: 'other.com', label: 'dup id', addedAt: 2 },
        { id: 'b', domain: 'example.com', label: 'dup domain', addedAt: 3 },
        { id: 'BAD ID', domain: 'x.com', addedAt: 4 },
        { id: 'c', domain: 'not-a-domain', addedAt: 5 },
      ],
    };
    const list = normalizeAoiBrowserDriveAllowlist(raw);
    expect(list.entries.map((e) => e.id)).toEqual(['a']);
    expect(list.updatedAt).toBe(5);
  });
});

describe('add/remove denylist entries', () => {
  it('adds, rejects invalid/duplicate, and removes', () => {
    let list: AoiBrowserDriveAllowlist = { version: 1, entries: [], updatedAt: 0 };

    const added = addAoiBrowserDriveAllowlistEntry(list, { domain: 'GitHub.com' }, 1000);
    expect(added.added).toBe(true);
    expect(added.allowlist.entries[0]).toMatchObject({ id: 'github-com', domain: 'github.com' });
    list = added.allowlist;

    expect(addAoiBrowserDriveAllowlistEntry(list, { domain: 'bad domain' }, 1001).reason).toBe(
      'invalid_domain',
    );
    expect(addAoiBrowserDriveAllowlistEntry(list, { domain: 'github.com' }, 1002).reason).toBe(
      'duplicate_domain',
    );

    const removed = removeAoiBrowserDriveAllowlistEntry(list, 'github-com', 2000);
    expect(removed.entries).toEqual([]);
    expect(removed.updatedAt).toBe(2000);
    // Removing a missing id keeps updatedAt unchanged.
    expect(removeAoiBrowserDriveAllowlistEntry(list, 'nope', 3000).updatedAt).toBe(1000);
  });
});

describe('isAoiBrowserDriveUrlAllowed (denylist, default-allow)', () => {
  const empty: AoiBrowserDriveAllowlist = { version: 1, entries: [], updatedAt: 0 };
  const denylist = addAoiBrowserDriveAllowlistEntry(empty, { domain: 'evil.com' }, 1).allowlist;

  it('allows any http(s) host when the denylist is empty', () => {
    expect(isAoiBrowserDriveUrlAllowed(empty, 'https://github.com/x').allowed).toBe(true);
    expect(isAoiBrowserDriveUrlAllowed(empty, 'https://google.com').allowed).toBe(true);
    expect(isAoiBrowserDriveUrlAllowed(null, 'http://example.com/a').allowed).toBe(true);
  });

  it('blocks the exact host and subdomains on the denylist', () => {
    expect(isAoiBrowserDriveUrlAllowed(denylist, 'https://evil.com/x')).toMatchObject({
      allowed: false,
      reason: 'host_denylisted',
    });
    expect(isAoiBrowserDriveUrlAllowed(denylist, 'https://tracker.evil.com/x')).toMatchObject({
      allowed: false,
      reason: 'host_denylisted',
    });
  });

  it('does not block lookalikes or unrelated hosts', () => {
    expect(isAoiBrowserDriveUrlAllowed(denylist, 'https://evil-github.com/x').allowed).toBe(true);
    expect(isAoiBrowserDriveUrlAllowed(denylist, 'https://notevil.com/x').allowed).toBe(true);
    expect(isAoiBrowserDriveUrlAllowed(denylist, 'https://github.com').allowed).toBe(true);
  });

  it('still rejects bad schemes and junk', () => {
    expect(isAoiBrowserDriveUrlAllowed(empty, 'file:///etc/passwd')).toMatchObject({
      reason: 'scheme_not_allowed',
    });
    expect(isAoiBrowserDriveUrlAllowed(empty, 'not a url')).toMatchObject({
      reason: 'invalid_url',
    });
  });

  it('hard-blocks private/loopback hosts even when the denylist is empty', () => {
    // Regression: default-allow denylist would otherwise open localhost/RFC1918
    // targets that the old registrable-domain allowlist could never permit.
    expect(isAoiBrowserDriveUrlAllowed(empty, 'http://localhost/admin')).toMatchObject({
      allowed: false,
      reason: 'host_private',
    });
    expect(isAoiBrowserDriveUrlAllowed(empty, 'http://127.0.0.1:8787/')).toMatchObject({
      allowed: false,
      reason: 'host_private',
    });
    expect(isAoiBrowserDriveUrlAllowed(empty, 'http://192.168.1.1/')).toMatchObject({
      allowed: false,
      reason: 'host_private',
    });
    expect(isAoiBrowserDriveUrlAllowed(empty, 'http://[::1]/')).toMatchObject({
      allowed: false,
      reason: 'host_private',
    });
  });
});

describe('load/save persistence', () => {
  it('round-trips through the denylist file and returns empty default when absent', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-bd-denylist-'));
    try {
      expect(loadAoiBrowserDriveAllowlist(home).entries).toEqual([]);
      const { allowlist } = addAoiBrowserDriveAllowlistEntry(
        loadAoiBrowserDriveAllowlist(home),
        { domain: 'blocked.com', label: 'Blocked' },
        1234,
      );
      const saved = saveAoiBrowserDriveAllowlist(home, allowlist);
      expect(saved.entries).toHaveLength(1);
      const path = resolveAoiBrowserDriveAllowlistPath(home);
      expect(path.endsWith('browser-drive-denylist.json')).toBe(true);
      expect(fs.existsSync(path)).toBe(true);
      const reloaded = loadAoiBrowserDriveAllowlist(home);
      expect(reloaded.entries[0]).toMatchObject({ domain: 'blocked.com', label: 'Blocked' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
