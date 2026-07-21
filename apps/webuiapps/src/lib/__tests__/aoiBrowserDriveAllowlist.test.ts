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

describe('add/remove allowlist entries', () => {
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

describe('isAoiBrowserDriveUrlAllowed (drift block)', () => {
  const list = addAoiBrowserDriveAllowlistEntry(
    { version: 1, entries: [], updatedAt: 0 },
    { domain: 'github.com' },
    1,
  ).allowlist;

  it('allows the exact host and subdomains', () => {
    expect(isAoiBrowserDriveUrlAllowed(list, 'https://github.com/kernullist').allowed).toBe(true);
    expect(isAoiBrowserDriveUrlAllowed(list, 'https://gist.github.com/x').allowed).toBe(true);
  });

  it('rejects lookalikes, other hosts, and bad schemes', () => {
    expect(isAoiBrowserDriveUrlAllowed(list, 'https://evil-github.com/x')).toMatchObject({
      allowed: false,
      reason: 'host_not_allowlisted',
    });
    expect(isAoiBrowserDriveUrlAllowed(list, 'https://githubXcom.example/x').allowed).toBe(false);
    expect(isAoiBrowserDriveUrlAllowed(list, 'https://google.com').allowed).toBe(false);
    expect(isAoiBrowserDriveUrlAllowed(list, 'file:///etc/passwd')).toMatchObject({
      reason: 'scheme_not_allowed',
    });
    expect(isAoiBrowserDriveUrlAllowed(list, 'not a url')).toMatchObject({ reason: 'invalid_url' });
  });
});

describe('load/save persistence', () => {
  it('round-trips through disk and returns default when absent', () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-bd-allowlist-'));
    try {
      expect(loadAoiBrowserDriveAllowlist(home).entries).toEqual([]);
      const { allowlist } = addAoiBrowserDriveAllowlistEntry(
        loadAoiBrowserDriveAllowlist(home),
        { domain: 'example.com', label: 'Example' },
        1234,
      );
      const saved = saveAoiBrowserDriveAllowlist(home, allowlist);
      expect(saved.entries).toHaveLength(1);
      expect(fs.existsSync(resolveAoiBrowserDriveAllowlistPath(home))).toBe(true);
      const reloaded = loadAoiBrowserDriveAllowlist(home);
      expect(reloaded.entries[0]).toMatchObject({ domain: 'example.com', label: 'Example' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
