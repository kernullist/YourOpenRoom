// Aoi browser-drive domain allowlist (P1.1): the ONLY containment for the
// CDP-attach model. Because Aoi attaches to the operator's MAIN browser (every
// logged-in site is reachable), a navigation/extraction is permitted ONLY when its
// hostname is on this operator-authored allowlist. Any drift off the allowlist
// (a redirect, a link, a new tab to another host) is refused fail-closed.
//
// Mirrors the host-bridge spawn-allowlist store: machine-global config under
// <openroomHome>/host-bridge, auth-only to edit (configuring one's own scope), pure
// normalize/add/remove + atomic persistence. SERVER-ONLY persistence; the pure
// matcher (isAoiBrowserDriveUrlAllowed) is client-safe.

import * as fs from 'fs';
import { dirname, resolve } from 'path';

const HOST_BRIDGE_DIR = 'host-bridge';
const BROWSER_DRIVE_ALLOWLIST_FILE = 'browser-drive-allowlist.json';
const MAX_ALLOWLIST_ENTRIES = 64;
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// A registrable hostname: >=2 dot-separated labels, each 1-63 chars, total <=253.
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface AoiBrowserDriveAllowlistEntry {
  id: string;
  // Registrable hostname, lowercased. Covers the exact host and any subdomain.
  domain: string;
  label: string;
  addedAt: number;
}

export interface AoiBrowserDriveAllowlist {
  version: 1;
  entries: AoiBrowserDriveAllowlistEntry[];
  updatedAt: number;
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
  | 'host_not_allowlisted';

export interface AoiBrowserDriveUrlDecision {
  allowed: boolean;
  hostname: string;
  reason?: AoiBrowserDriveUrlDenyReason;
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
    if (entries.length >= MAX_ALLOWLIST_ENTRIES) {
      break;
    }
  }
  return {
    version: 1,
    entries,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
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
  if (base.entries.length >= MAX_ALLOWLIST_ENTRIES) {
    return { allowlist: base, added: false, reason: 'allowlist_full' };
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

/**
 * The drift-block core. A URL is allowed ONLY when its scheme is http(s) and its
 * hostname exactly matches, or is a subdomain of, an allowlisted registrable
 * domain. `evil-github.com` never matches `github.com` (the subdomain test
 * requires a leading dot). Fail-closed on anything unparseable.
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
  const list = normalizeAoiBrowserDriveAllowlist(allowlist);
  const entry = list.entries.find(
    (candidate) => hostname === candidate.domain || hostname.endsWith(`.${candidate.domain}`),
  );
  if (!entry) {
    return { allowed: false, hostname, reason: 'host_not_allowlisted' };
  }
  return { allowed: true, hostname, entry };
}

export function resolveAoiBrowserDriveAllowlistPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, BROWSER_DRIVE_ALLOWLIST_FILE);
}

export function loadAoiBrowserDriveAllowlist(openroomHome: string): AoiBrowserDriveAllowlist {
  try {
    const filePath = resolveAoiBrowserDriveAllowlistPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [] };
    }
    return normalizeAoiBrowserDriveAllowlist(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_BROWSER_DRIVE_ALLOWLIST, entries: [] };
  }
}

export function saveAoiBrowserDriveAllowlist(
  openroomHome: string,
  allowlist: AoiBrowserDriveAllowlist,
): AoiBrowserDriveAllowlist {
  const normalized = normalizeAoiBrowserDriveAllowlist(allowlist);
  const filePath = resolveAoiBrowserDriveAllowlistPath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}
