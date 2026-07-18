// Aoi host-bridge filesystem read (HP3a): let Aoi read the real filesystem, but
// ONLY inside directories the operator registered as read roots
// (docs/aoi-host-access-design.md). Read-only: no write/delete here.
//
// Safety posture (load-bearing):
//   - CONSENT ROOTS ONLY: every read resolves the requested path and checks it
//     is inside a registered root. The roots list IS the explicit consent; an
//     unregistered path is never readable.
//   - REALPATH RE-VALIDATION (T4): the requested path AND the roots are resolved
//     through fs.realpath before the containment check, so a symlink / junction /
//     ".." that points OUT of a root is rejected -- a lexical check alone is not
//     enough on Windows.
//   - METADATA vs CONTENT are separate operations: directory listing / stat
//     return names + sizes + mtimes only; reading bytes is a distinct call with
//     a hard byte cap.
//   - The HP0 gate (auth + kill switch capability `os_file_read`) is enforced by
//     the caller; this module is the consent-root + realpath data layer.
//
// Server-only (fs). The containment check is pure; the resolver + readers accept
// an injectable realpath so the symlink-escape guard is unit-testable without
// creating real symlinks (which need privilege on Windows).
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';

export const AOI_HOST_FILE_READ_CAPABILITY = 'os_file_read';
const HOST_BRIDGE_DIR = 'host-bridge';
const READ_ROOTS_FILE = 'read-roots.json';
const MAX_ROOTS = 32;
const MAX_PATH_CHARS = 4096;
const MAX_READ_BYTES = 256 * 1024;
const MAX_DIR_ENTRIES = 1000;
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type AoiHostFileReadDenyReason =
  | 'missing_path'
  | 'path_not_absolute'
  | 'path_too_long'
  | 'no_consent_roots'
  | 'outside_consent_roots'
  | 'not_found'
  | 'not_a_directory'
  | 'not_a_file'
  | 'read_failed';

export interface AoiHostReadRoot {
  id: string;
  label: string;
  path: string;
}

export interface AoiHostReadRootsConfig {
  version: 1;
  roots: AoiHostReadRoot[];
  updatedAt: number;
}

export const DEFAULT_AOI_HOST_READ_ROOTS: AoiHostReadRootsConfig = {
  version: 1,
  roots: [],
  updatedAt: 0,
};

export interface AoiHostDirEntry {
  name: string;
  kind: 'file' | 'directory' | 'other';
  size?: number;
  mtimeMs?: number;
}

export interface AoiHostFileReadContent {
  version: 1;
  path: string;
  content: string;
  byteLength: number;
  truncated: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isSafeAbsolutePath(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    isAbsolute(value)
  );
}

// Pure lexical containment: is `target` at or below `root`? Both must already be
// resolved (absolute, symlinks followed) for this to be a real security check.
export function isAoiPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

// --- Read-roots config (pure + fs) -------------------------------------------

export function normalizeAoiHostReadRoots(raw: unknown): AoiHostReadRootsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_HOST_READ_ROOTS, roots: [] };
  }
  const value = raw as Partial<AoiHostReadRootsConfig>;
  if (value.version !== 1 || !Array.isArray(value.roots)) {
    return { ...DEFAULT_AOI_HOST_READ_ROOTS, roots: [] };
  }
  const roots: AoiHostReadRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of value.roots) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const root = candidate as Partial<AoiHostReadRoot>;
    const id = typeof root.id === 'string' ? root.id : '';
    const path = typeof root.path === 'string' ? root.path : '';
    if (!ROOT_ID_PATTERN.test(id) || seen.has(id) || !isSafeAbsolutePath(path)) {
      continue;
    }
    roots.push({
      id,
      label:
        normalizeWhitespace(typeof root.label === 'string' ? root.label : id).slice(0, 120) || id,
      path,
    });
    seen.add(id);
    if (roots.length >= MAX_ROOTS) {
      break;
    }
  }
  return {
    version: 1,
    roots,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function addAoiHostReadRoot(
  config: AoiHostReadRootsConfig | null | undefined,
  root: { id: string; label?: string; path: string },
  now: number,
): { config: AoiHostReadRootsConfig; added: boolean; reason?: string } {
  const base = normalizeAoiHostReadRoots(config);
  if (!ROOT_ID_PATTERN.test(root.id)) {
    return { config: base, added: false, reason: 'invalid_id' };
  }
  if (!isSafeAbsolutePath(root.path)) {
    return { config: base, added: false, reason: 'invalid_path' };
  }
  if (base.roots.every((existing) => existing.id !== root.id) && base.roots.length >= MAX_ROOTS) {
    return { config: base, added: false, reason: 'roots_full' };
  }
  const nextRoot: AoiHostReadRoot = {
    id: root.id,
    label: normalizeWhitespace(root.label ?? root.id).slice(0, 120) || root.id,
    path: root.path,
  };
  const roots = [...base.roots.filter((existing) => existing.id !== root.id), nextRoot];
  return { config: { version: 1, roots, updatedAt: now }, added: true };
}

export function removeAoiHostReadRoot(
  config: AoiHostReadRootsConfig | null | undefined,
  id: string,
  now: number,
): AoiHostReadRootsConfig {
  const base = normalizeAoiHostReadRoots(config);
  const roots = base.roots.filter((root) => root.id !== id);
  return {
    version: 1,
    roots,
    updatedAt: roots.length === base.roots.length ? base.updatedAt : now,
  };
}

export function resolveAoiHostReadRootsPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, READ_ROOTS_FILE);
}

export function loadAoiHostReadRoots(openroomHome: string): AoiHostReadRootsConfig {
  try {
    const filePath = resolveAoiHostReadRootsPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_HOST_READ_ROOTS, roots: [] };
    }
    return normalizeAoiHostReadRoots(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_HOST_READ_ROOTS, roots: [] };
  }
}

export function saveAoiHostReadRoots(
  openroomHome: string,
  config: AoiHostReadRootsConfig,
): AoiHostReadRootsConfig {
  const normalized = normalizeAoiHostReadRoots(config);
  const filePath = resolveAoiHostReadRootsPath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}

// --- Realpath-validated resolution (the security core) -----------------------

export type AoiHostRealpathImpl = (target: string) => string;

export interface AoiHostReadTargetResolution {
  ok: boolean;
  resolvedPath?: string;
  rootId?: string;
  reason?: AoiHostFileReadDenyReason;
}

// Resolve a requested path against the consent roots with realpath re-validation.
// The requested path AND each root are realpathed; the resolved target must sit
// inside a resolved root. This is what defeats a symlink/junction/".." escape.
export function resolveAoiHostReadTarget(params: {
  roots: readonly AoiHostReadRoot[];
  requestedPath: string;
  realpathImpl?: AoiHostRealpathImpl;
}): AoiHostReadTargetResolution {
  const requested = params.requestedPath;
  if (typeof requested !== 'string' || requested.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }
  if (requested.length > MAX_PATH_CHARS) {
    return { ok: false, reason: 'path_too_long' };
  }
  if (!isAbsolute(requested)) {
    return { ok: false, reason: 'path_not_absolute' };
  }
  if (params.roots.length === 0) {
    return { ok: false, reason: 'no_consent_roots' };
  }
  const realpathImpl = params.realpathImpl ?? ((target: string) => fs.realpathSync.native(target));
  let resolvedTarget: string;
  try {
    resolvedTarget = realpathImpl(resolve(requested));
  } catch {
    // realpath throws when the path does not exist.
    return { ok: false, reason: 'not_found' };
  }
  for (const root of params.roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathImpl(resolve(root.path));
    } catch {
      // A configured root that no longer resolves is skipped, not fatal.
      continue;
    }
    if (isAoiPathInsideRoot(resolvedRoot, resolvedTarget)) {
      return { ok: true, resolvedPath: resolvedTarget, rootId: root.id };
    }
  }
  return { ok: false, reason: 'outside_consent_roots' };
}

// --- Read operations (effectful) ---------------------------------------------

export interface AoiHostDirListing {
  ok: boolean;
  path?: string;
  rootId?: string;
  entries: AoiHostDirEntry[];
  truncated: boolean;
  reason?: AoiHostFileReadDenyReason;
}

// Metadata-only directory listing (names + kind + size + mtime; never content).
export function listAoiHostDirectory(params: {
  roots: readonly AoiHostReadRoot[];
  requestedPath: string;
  realpathImpl?: AoiHostRealpathImpl;
}): AoiHostDirListing {
  const resolution = resolveAoiHostReadTarget(params);
  if (!resolution.ok || !resolution.resolvedPath) {
    return {
      ok: false,
      entries: [],
      truncated: false,
      ...(resolution.reason ? { reason: resolution.reason } : {}),
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolution.resolvedPath);
  } catch {
    return { ok: false, entries: [], truncated: false, reason: 'not_found' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, entries: [], truncated: false, reason: 'not_a_directory' };
  }
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(resolution.resolvedPath, { withFileTypes: true });
  } catch {
    return { ok: false, entries: [], truncated: false, reason: 'read_failed' };
  }
  const truncated = dirents.length > MAX_DIR_ENTRIES;
  const entries: AoiHostDirEntry[] = dirents.slice(0, MAX_DIR_ENTRIES).map((dirent) => {
    const kind: AoiHostDirEntry['kind'] = dirent.isDirectory()
      ? 'directory'
      : dirent.isFile()
        ? 'file'
        : 'other';
    const entry: AoiHostDirEntry = { name: dirent.name, kind };
    try {
      const childStat = fs.statSync(resolve(resolution.resolvedPath as string, dirent.name));
      if (childStat.isFile()) {
        entry.size = childStat.size;
      }
      entry.mtimeMs = Math.round(childStat.mtimeMs);
    } catch {
      // A child that cannot be stat'd still lists by name + kind.
    }
    return entry;
  });
  return {
    ok: true,
    path: resolution.resolvedPath,
    ...(resolution.rootId ? { rootId: resolution.rootId } : {}),
    entries,
    truncated,
  };
}

export interface AoiHostStatResult {
  ok: boolean;
  path?: string;
  rootId?: string;
  kind?: AoiHostDirEntry['kind'];
  size?: number;
  mtimeMs?: number;
  reason?: AoiHostFileReadDenyReason;
}

export function statAoiHostPath(params: {
  roots: readonly AoiHostReadRoot[];
  requestedPath: string;
  realpathImpl?: AoiHostRealpathImpl;
}): AoiHostStatResult {
  const resolution = resolveAoiHostReadTarget(params);
  if (!resolution.ok || !resolution.resolvedPath) {
    return { ok: false, ...(resolution.reason ? { reason: resolution.reason } : {}) };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolution.resolvedPath);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  const kind: AoiHostDirEntry['kind'] = stat.isDirectory()
    ? 'directory'
    : stat.isFile()
      ? 'file'
      : 'other';
  return {
    ok: true,
    path: resolution.resolvedPath,
    ...(resolution.rootId ? { rootId: resolution.rootId } : {}),
    kind,
    ...(stat.isFile() ? { size: stat.size } : {}),
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

export interface AoiHostFileReadResult {
  ok: boolean;
  content?: AoiHostFileReadContent;
  reason?: AoiHostFileReadDenyReason;
}

// Read file bytes as text, capped at MAX_READ_BYTES. A distinct operation from
// listing/stat so the metadata vs content boundary is explicit.
export function readAoiHostFileContent(params: {
  roots: readonly AoiHostReadRoot[];
  requestedPath: string;
  maxBytes?: number;
  realpathImpl?: AoiHostRealpathImpl;
}): AoiHostFileReadResult {
  const resolution = resolveAoiHostReadTarget(params);
  if (!resolution.ok || !resolution.resolvedPath) {
    return { ok: false, ...(resolution.reason ? { reason: resolution.reason } : {}) };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolution.resolvedPath);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'not_a_file' };
  }
  const cap = Math.max(1, Math.min(MAX_READ_BYTES, params.maxBytes ?? MAX_READ_BYTES));
  try {
    const buffer = fs.readFileSync(resolution.resolvedPath);
    const truncated = buffer.byteLength > cap;
    const slice = truncated ? buffer.subarray(0, cap) : buffer;
    return {
      ok: true,
      content: {
        version: 1,
        path: resolution.resolvedPath,
        content: slice.toString('utf-8'),
        byteLength: buffer.byteLength,
        truncated,
      },
    };
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
}
