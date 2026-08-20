// Aoi browser-drive domain denylist (was P1.1 allowlist): containment for the
// CDP-attach model. Aoi attaches to the operator's MAIN browser (every logged-in
// site is reachable), so navigation defaults to ALLOWED for any http(s) host and
// is refused only when the hostname matches an operator-authored denylist entry
// (exact host or subdomain). Redirects onto a denylisted host are refused
// fail-closed (tab blanked by the caller).
//
// Mirrors the host-bridge spawn-allowlist store shape: machine-global config under
// <openroomHome>/host-bridge, auth-only to edit, pure normalize/add/remove + atomic
// persistence. SERVER-ONLY persistence; the pure matcher (isAoiBrowserDriveUrlAllowed)
// is client-safe.
//
// Naming note: types keep the historical "Allowlist" suffix so call sites and
// persisted version-1 entry shapes stay stable. Semantics are denylist: empty list
// means allow-all. Persistence file is browser-drive-denylist.json (the old
// browser-drive-allowlist.json is intentionally NOT migrated -- its entries meant
// "permit these", which would wrongly become blocks).

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { isAoiPrivateOrLocalHostname } from './aoiHostUrlSafety';

const HOST_BRIDGE_DIR = 'host-bridge';
const BROWSER_DRIVE_DENYLIST_FILE = 'browser-drive-denylist.json';
// Legacy filename kept only so operators can find orphan files; never loaded as a denylist.
const LEGACY_BROWSER_DRIVE_ALLOWLIST_FILE = 'browser-drive-allowlist.json';
const MAX_DENYLIST_ENTRIES = 64;
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// A registrable hostname: >=2 dot-separated labels, each 1-63 chars, total <=253.
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AoiBrowserDriveAllowlistEntry {
  id: string;
  // Registrable hostname, lowercased. Blocks the exact host and any subdomain.
  domain: string;
  label: string;
  addedAt: number;
}

export interface AoiBrowserDriveAllowlist {
  version: 1;
  entries: AoiBrowserDriveAllowlistEntry[];
  updatedAt: number;
  // The stored list EXISTS but could not be read.
  //
  // Empty means "allow everything" here, which is right when the operator never
  // configured containment and catastrophic when they did and the file was then
  // truncated or hand-edited into invalid JSON: the two states were
  // indistinguishable, so a corrupted denylist silently became no denylist.
  unreadable?: true;
}

export const DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST: AoiBrowserDriveAllowlist = {
  version: 1,
  entries: [],
  updatedAt: 0,
};

export type AoiBrowserDriveUrlDenyReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'empty_host'
  | 'host_private'
  | 'host_denylisted'
  // The stored denylist exists but could not be read, so containment cannot be
  // applied. Distinct from every other reason: nothing about the URL is wrong.
  | 'denylist_unreadable'
  // Legacy alias kept for older error strings / log greps.
  | 'host_not_allowlisted';

export interface AoiBrowserDriveUrlDecision {
  allowed: boolean;
  hostname: string;
  reason?: AoiBrowserDriveUrlDenyReason;
  /** Present when the host matched a denylist entry. */
  entry?: AoiBrowserDriveAllowlistEntry;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize an operator-entered domain: strip scheme/path/port/userinfo/leading
 * `*.`/trailing dot, lowercase, and validate as a registrable hostname. Returns
 * null when it is not a plausible domain (single label, IP, empty, junk).
 */
export function normalizeAoiBrowserDriveDomain(raw: string): string | null {
  let value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) {
    return null;
  }
  // Accept a full URL and reduce to its hostname.
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  value = value
    .replace(/^\*\./, '') // wildcard prefix -> the base domain already covers subdomains
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/:\d+$/, '') // stray port
    .replace(/\/.*$/, ''); // stray path
  if (!DOMAIN_PATTERN.test(value)) {
    return null;
  }
  // Reject IPv4 / numeric junk: a real TLD is never all-digits.
  const labels = value.split('.');
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return null;
  }
  return value;
}

function slugifyDomainId(domain: string): string {
  const slug = domain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ENTRY_ID_PATTERN.test(slug) ? slug : `d-${slug}`.slice(0, 64);
}

export function normalizeAoiBrowserDriveAllowlist(raw: unknown): AoiBrowserDriveAllowlist {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [] };
  }
  const value = raw as Partial<AoiBrowserDriveAllowlist>;
  if (value.version !== 1 || !Array.isArray(value.entries)) {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [] };
  }
  // Carried through, because this is what every consumer funnels into -- the
  // matcher normalizes its argument before deciding. Dropping the flag here
  // would quietly restore the fail-open the loader just closed.
  const unreadable = value.unreadable === true ? ({ unreadable: true } as const) : null;
  const entries: AoiBrowserDriveAllowlistEntry[] = [];
  const seenIds = new Set<string>();
  const seenDomains = new Set<string>();
  for (const candidate of value.entries) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const entry = candidate as Partial<AoiBrowserDriveAllowlistEntry>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const domain = normalizeAoiBrowserDriveDomain(
      typeof entry.domain === 'string' ? entry.domain : '',
    );
    if (!ENTRY_ID_PATTERN.test(id) || !domain || seenIds.has(id) || seenDomains.has(domain)) {
      continue;
    }
    entries.push({
      id,
      domain,
      label:
        normalizeWhitespace(typeof entry.label === 'string' ? entry.label : domain).slice(0, 80) ||
        domain,
      addedAt:
        typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
    });
    seenIds.add(id);
    seenDomains.add(domain);
    if (entries.length >= MAX_DENYLIST_ENTRIES) {
      break;
    }
  }
  return {
    version: 1,
    entries,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    ...(unreadable ?? {}),
  };
}

export function addAoiBrowserDriveAllowlistEntry(
  allowlist: AoiBrowserDriveAllowlist | null | undefined,
  entry: { id?: string; domain: string; label?: string },
  now: number,
): { allowlist: AoiBrowserDriveAllowlist; added: boolean; reason?: string } {
  const base = normalizeAoiBrowserDriveAllowlist(allowlist);
  const domain = normalizeAoiBrowserDriveDomain(entry.domain);
  if (!domain) {
    return { allowlist: base, added: false, reason: 'invalid_domain' };
  }
  if (base.entries.some((existing) => existing.domain === domain)) {
    return { allowlist: base, added: false, reason: 'duplicate_domain' };
  }
  if (base.entries.length >= MAX_DENYLIST_ENTRIES) {
    return { allowlist: base, added: false, reason: 'denylist_full' };
  }
  const id =
    typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : slugifyDomainId(domain);
  if (!ENTRY_ID_PATTERN.test(id) || base.entries.some((existing) => existing.id === id)) {
    return { allowlist: base, added: false, reason: 'invalid_id' };
  }
  const nextEntry: AoiBrowserDriveAllowlistEntry = {
    id,
    domain,
    label: normalizeWhitespace(entry.label ?? domain).slice(0, 80) || domain,
    addedAt: now,
  };
  return {
    allowlist: { version: 1, entries: [...base.entries, nextEntry], updatedAt: now },
    added: true,
  };
}

export function removeAoiBrowserDriveAllowlistEntry(
  allowlist: AoiBrowserDriveAllowlist | null | undefined,
  id: string,
  now: number,
): AoiBrowserDriveAllowlist {
  const base = normalizeAoiBrowserDriveAllowlist(allowlist);
  const entries = base.entries.filter((entry) => entry.id !== id);
  return {
    version: 1,
    entries,
    updatedAt: entries.length === base.entries.length ? base.updatedAt : now,
  };
}

function findDenylistMatch(
  list: AoiBrowserDriveAllowlist,
  hostname: string,
): AoiBrowserDriveAllowlistEntry | undefined {
  return list.entries.find(
    (candidate) => hostname === candidate.domain || hostname.endsWith(`.${candidate.domain}`),
  );
}

/**
 * Domain containment for browser-drive. Default ALLOW for public http(s) hosts.
 * Hard-blocked always: bad scheme, unparseable URL, empty host, private/loopback/
 * link-local/metadata hosts (same SSRF set as headless host-browser-read — under
 * denylist default-allow those would otherwise pass, and they cannot be represented
 * as denylist entries because entry normalize rejects single-label/IP hosts).
 * Operator denylist: exact host or subdomain match (`evil-github.com` never matches
 * denylist entry `github.com`; subdomain test requires a leading dot).
 */
export function isAoiBrowserDriveUrlAllowed(
  allowlist: AoiBrowserDriveAllowlist | null | undefined,
  url: string,
): AoiBrowserDriveUrlDecision {
  let parsed: URL;
  try {
    parsed = new URL(typeof url === 'string' ? url : '');
  } catch {
    return { allowed: false, hostname: '', reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, hostname: '', reason: 'scheme_not_allowed' };
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!hostname) {
    return { allowed: false, hostname: '', reason: 'empty_host' };
  }
  // Preserve the pre-denylist invariant that private hosts were unreachable
  // (allowlist only accepted registrable public domains as entries).
  if (isAoiPrivateOrLocalHostname(hostname)) {
    return { allowed: false, hostname, reason: 'host_private' };
  }
  const list = normalizeAoiBrowserDriveAllowlist(allowlist);
  // A denylist that exists but cannot be read is not an empty denylist. Empty
  // means allow-all here, so treating the two the same turned a corrupted file
  // into no containment at all -- silently, and exactly for the operator who
  // bothered to configure some.
  if (list.unreadable === true) {
    return { allowed: false, hostname, reason: 'denylist_unreadable' };
  }
  const entry = findDenylistMatch(list, hostname);
  if (entry) {
    return { allowed: false, hostname, reason: 'host_denylisted', entry };
  }
  return { allowed: true, hostname };
}

export function resolveAoiBrowserDriveAllowlistPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, BROWSER_DRIVE_DENYLIST_FILE);
}

/** @deprecated Path of the pre-denylist permit-list file. Never auto-loaded. */
export function resolveAoiBrowserDriveLegacyAllowlistPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, LEGACY_BROWSER_DRIVE_ALLOWLIST_FILE);
}

export function loadAoiBrowserDriveAllowlist(openroomHome: string): AoiBrowserDriveAllowlist {
  try {
    const filePath = resolveAoiBrowserDriveAllowlistPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      // Never configured. This is the one honest empty.
      return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [] };
    }
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Present, parsed, and shaped like a list -- even an empty one -- is a real
    // answer. Present and shaped like anything else is a file we cannot read,
    // which is not the same as a file that permits everything.
    const shaped =
      !!raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Partial<AoiBrowserDriveAllowlist>).version === 1 &&
      Array.isArray((raw as Partial<AoiBrowserDriveAllowlist>).entries);
    if (!shaped) {
      return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [], unreadable: true };
    }
    return normalizeAoiBrowserDriveAllowlist(raw);
  } catch {
    // The file is there and unreadable: bad JSON, a truncated write, a bad
    // permission. Fail closed and say so rather than reporting no restrictions.
    return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [], unreadable: true };
  }
}

export function saveAoiBrowserDriveAllowlist(
  openroomHome: string,
  allowlist: AoiBrowserDriveAllowlist,
): AoiBrowserDriveAllowlist {
  const normalized = normalizeAoiBrowserDriveAllowlist(allowlist);
  const filePath = resolveAoiBrowserDriveAllowlistPath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  // pid + random, like every other store here. A fixed name is raced by the
  // daemon and the dev server -- separate processes over one store -- and the
  // loser renames a half-written file into place, which is precisely the
  // corruption the loader above now has to survive.
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}
