// IDA Lab configuration: the operator-owned paths and bounds that decide what a
// session may be started from, and the argument vectors used to start one.
//
// Persisted under the `idaSql` key of the shared config file (same file and same
// shape of access as `idaPe`), so the dev server, the daemon and the app all read
// one source of truth.
//
// Two things here are load-bearing:
//
//   - BINARY ROOTS ARE THE REACH LIMIT. A session can only ever be started from a
//     file that resolves (after symlink resolution by the caller) inside a root the
//     operator registered. An empty root list means the app can analyze nothing --
//     fail-closed, like every other host store.
//   - ARGUMENT VECTORS, NEVER COMMAND STRINGS. The spawn is shell:false with a
//     validated vector, so there is no shell to inject into. The metacharacter
//     check is belt-and-braces for the audit log and for paths that would confuse
//     idasql's own parsing.
//
// Server/test only: imports node `path`. Client code must import from
// idaSqlTypes / idaSqlClient instead (a node import here would break the bundle).
import { isAbsolute, resolve, sep } from 'path';
import type { IdaSqlBinaryRoot, IdaSqlConfigView, IdaSqlSessionMode } from './idaSqlTypes';

export const IDA_SQL_CONFIG_KEY = 'idaSql';

const MAX_BINARY_ROOTS = 16;
const MAX_PATH_CHARS = 1024;
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHELL_METACHAR_REGEX = /[|&;<>`\r\n$]/;

// Default HTTP port window for headless sessions. Deliberately above the range
// the in-GUI idasql plugin auto-assigns (8100-8199) so a headless session and an
// attached GUI session never fight over a port.
export const IDA_SQL_DEFAULT_PORT_START = 8300;
export const IDA_SQL_DEFAULT_PORT_END = 8399;
// The window the in-GUI plugin picks from when the operator runs `.http start`.
export const IDA_SQL_GUI_PROBE_PORT_START = 8100;
export const IDA_SQL_GUI_PROBE_PORT_END = 8199;

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_IDLE_TIMEOUT_MS = 60 * 1000;
const MAX_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/** The raw persisted shape. Every field optional: a fresh config is legal. */
export interface IdaSqlStoredConfig {
  idaExePath?: string;
  idasqlExePath?: string;
  defaultMode?: IdaSqlSessionMode;
  binaryRoots?: IdaSqlBinaryRoot[];
  httpPortStart?: number;
  httpPortEnd?: number;
  sessionIdleTimeoutMs?: number;
  writeEnabled?: boolean;
}

export const DEFAULT_IDA_SQL_CONFIG: IdaSqlConfigView = {
  idaExePath: '',
  idasqlExePath: '',
  defaultMode: 'headless',
  binaryRoots: [],
  httpPortStart: IDA_SQL_DEFAULT_PORT_START,
  httpPortEnd: IDA_SQL_DEFAULT_PORT_END,
  sessionIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  writeEnabled: false,
};

function normalizeAbsolutePath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PATH_CHARS) {
    return '';
  }
  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    return '';
  }
  if (!isAbsolute(trimmed)) {
    return '';
  }
  return resolve(trimmed);
}

function normalizeRoot(raw: unknown): IdaSqlBinaryRoot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Partial<IdaSqlBinaryRoot>;
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
  if (!ROOT_ID_PATTERN.test(id)) {
    return null;
  }
  const path = normalizeAbsolutePath(value.path);
  if (!path) {
    return null;
  }
  const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : path;
  return { id, path, label: label.slice(0, 120) };
}

function clampPort(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < 1024 || rounded > 65535) {
    return fallback;
  }
  return rounded;
}

/** Normalize whatever is on disk into a complete, bounded view. */
export function normalizeIdaSqlConfig(raw: unknown): IdaSqlConfigView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_IDA_SQL_CONFIG, binaryRoots: [] };
  }
  const value = raw as IdaSqlStoredConfig;

  const seenIds = new Set<string>();
  const binaryRoots: IdaSqlBinaryRoot[] = [];
  for (const entry of Array.isArray(value.binaryRoots) ? value.binaryRoots : []) {
    const root = normalizeRoot(entry);
    if (!root || seenIds.has(root.id)) {
      continue;
    }
    seenIds.add(root.id);
    binaryRoots.push(root);
    if (binaryRoots.length >= MAX_BINARY_ROOTS) {
      break;
    }
  }

  let httpPortStart = clampPort(value.httpPortStart, IDA_SQL_DEFAULT_PORT_START);
  let httpPortEnd = clampPort(value.httpPortEnd, IDA_SQL_DEFAULT_PORT_END);
  if (httpPortEnd < httpPortStart) {
    // A reversed window would allocate nothing; swap rather than fail the load.
    const swap = httpPortStart;
    httpPortStart = httpPortEnd;
    httpPortEnd = swap;
  }

  const idleRaw =
    typeof value.sessionIdleTimeoutMs === 'number' && Number.isFinite(value.sessionIdleTimeoutMs)
      ? Math.floor(value.sessionIdleTimeoutMs)
      : DEFAULT_IDLE_TIMEOUT_MS;

  return {
    idaExePath: normalizeAbsolutePath(value.idaExePath),
    idasqlExePath: normalizeAbsolutePath(value.idasqlExePath),
    defaultMode: value.defaultMode === 'gui' ? 'gui' : 'headless',
    binaryRoots,
    httpPortStart,
    httpPortEnd,
    sessionIdleTimeoutMs: Math.min(
      MAX_IDLE_TIMEOUT_MS,
      Math.max(MIN_IDLE_TIMEOUT_MS, idleRaw || DEFAULT_IDLE_TIMEOUT_MS),
    ),
    writeEnabled: value.writeEnabled === true,
  };
}

/** Shape the normalized view back into the persisted (sparse) form. */
export function toStoredIdaSqlConfig(config: IdaSqlConfigView): IdaSqlStoredConfig {
  return {
    ...(config.idaExePath ? { idaExePath: config.idaExePath } : {}),
    ...(config.idasqlExePath ? { idasqlExePath: config.idasqlExePath } : {}),
    defaultMode: config.defaultMode,
    binaryRoots: config.binaryRoots,
    httpPortStart: config.httpPortStart,
    httpPortEnd: config.httpPortEnd,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    writeEnabled: config.writeEnabled,
  };
}

/**
 * Merge an operator patch onto the current config. Unknown keys are dropped by
 * normalization, so a hostile body cannot smuggle fields in.
 */
export function mergeIdaSqlConfig(current: IdaSqlConfigView, patch: unknown): IdaSqlConfigView {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return current;
  }
  const value = patch as IdaSqlStoredConfig;
  return normalizeIdaSqlConfig({
    ...toStoredIdaSqlConfig(current),
    ...(Object.prototype.hasOwnProperty.call(value, 'idaExePath')
      ? { idaExePath: value.idaExePath }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'idasqlExePath')
      ? { idasqlExePath: value.idasqlExePath }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'defaultMode')
      ? { defaultMode: value.defaultMode }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'binaryRoots')
      ? { binaryRoots: value.binaryRoots }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'httpPortStart')
      ? { httpPortStart: value.httpPortStart }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'httpPortEnd')
      ? { httpPortEnd: value.httpPortEnd }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'sessionIdleTimeoutMs')
      ? { sessionIdleTimeoutMs: value.sessionIdleTimeoutMs }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'writeEnabled')
      ? { writeEnabled: value.writeEnabled }
      : {}),
  });
}

/**
 * The IDA installation directory. idasql must live next to the IDA binary (that
 * is how it finds the engine), so either configured path yields it -- and the
 * directory is what has to be on PATH when idasql runs.
 */
export function resolveIdaDirectory(config: IdaSqlConfigView): string {
  // ida.exe FIRST. What has to be on PATH is the IDA *engine*, and the engine
  // lives next to ida.exe -- not next to idasql. Deriving the directory from
  // idasql's own location is only right in the layout the idasql README
  // assumes (the binary dropped into the IDA folder); with idasql kept
  // somewhere else, that put the wrong directory on PATH and idasql started
  // and immediately failed to find the engine.
  const source = config.idaExePath || config.idasqlExePath;
  return dirnameOf(source);
}

function dirnameOf(source: string): string {
  if (!source) {
    return '';
  }
  const lastSep = Math.max(source.lastIndexOf('\\'), source.lastIndexOf('/'));
  return lastSep > 0 ? source.slice(0, lastSep) : '';
}

function caseFold(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/** Is `candidate` the root itself or something underneath it? */
export function isPathWithinRoot(
  candidate: string,
  root: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  if (!candidate || !root) {
    return false;
  }
  const resolvedCandidate = caseFold(resolve(candidate), caseInsensitive);
  const resolvedRoot = caseFold(resolve(root), caseInsensitive);
  if (resolvedCandidate === resolvedRoot) {
    return true;
  }
  const withSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCandidate.startsWith(withSep);
}

export interface IdaSqlPathResolution {
  ok: boolean;
  path: string;
  rootId: string;
  reason: string;
}

/**
 * Resolve a requested path against the registered roots. Rejects non-absolute
 * paths, shell metacharacters, and anything outside every root.
 *
 * Symlink resolution is the CALLER's job (it needs fs): this decides containment
 * for a path already made real, and must be re-run on the realpath.
 */
export function resolveIdaSqlPathWithinRoots(
  requestedPath: unknown,
  roots: readonly IdaSqlBinaryRoot[],
  caseInsensitive: boolean = process.platform === 'win32',
): IdaSqlPathResolution {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    return { ok: false, path: '', rootId: '', reason: 'missing_path' };
  }
  const trimmed = requestedPath.trim();
  if (trimmed.length > MAX_PATH_CHARS) {
    return { ok: false, path: '', rootId: '', reason: 'path_too_long' };
  }
  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    return { ok: false, path: '', rootId: '', reason: 'shell_metacharacters' };
  }
  if (!isAbsolute(trimmed)) {
    return { ok: false, path: '', rootId: '', reason: 'path_not_absolute' };
  }
  if (roots.length === 0) {
    return { ok: false, path: '', rootId: '', reason: 'no_binary_roots' };
  }
  const resolved = resolve(trimmed);
  for (const root of roots) {
    if (isPathWithinRoot(resolved, root.path, caseInsensitive)) {
      return { ok: true, path: resolved, rootId: root.id, reason: '' };
    }
  }
  return { ok: false, path: resolved, rootId: '', reason: 'path_outside_roots' };
}

/**
 * Headless argument vector: idalib analyzes the target itself and serves SQL over
 * HTTP. `-w` is appended ONLY for a write session -- without it idasql discards
 * changes on exit, which is the structural guarantee behind read-only mode.
 */
export function buildIdaSqlHeadlessArgs(params: {
  binaryPath: string;
  port: number;
  write: boolean;
  /** Per-session bearer token. Without it the SQL server is open to any local caller. */
  token?: string;
}): string[] {
  const args = ['-s', params.binaryPath, '--http', String(params.port)];
  // Pin the bind address rather than trusting the default. This server answers
  // arbitrary SQL against the operator's database; it must never be reachable
  // off-box because a default changed.
  args.push('--bind', '127.0.0.1');
  if (params.token) {
    // idasql enforces `Authorization: Bearer <token>` and answers 401 without it
    // (verified against v0.0.18.1). Unauthenticated, ANY local process -- or a
    // web page in the operator's browser posting to 127.0.0.1 -- could read the
    // database, and in a -w session write to it.
    args.push('--token', params.token);
  }
  if (params.write) {
    args.push('-w');
  }
  return args;
}

/** GUI argument vector: hand the target to the real IDA window. */
export function buildIdaGuiArgs(params: { binaryPath: string }): string[] {
  return [params.binaryPath];
}

export interface IdaSqlConfigProblem {
  code: string;
  detail: string;
}

/** Everything wrong with the current config, for the app's setup panel. */
export function listIdaSqlConfigProblems(
  config: IdaSqlConfigView,
  mode: IdaSqlSessionMode,
): IdaSqlConfigProblem[] {
  const problems: IdaSqlConfigProblem[] = [];
  if (!config.idasqlExePath) {
    problems.push({
      code: 'idasql_path_missing',
      detail: 'Set the idasql executable path (place idasql next to the IDA binary).',
    });
  }
  if (mode === 'gui' && !config.idaExePath) {
    problems.push({
      code: 'ida_path_missing',
      detail: 'GUI mode needs the ida.exe path.',
    });
  }
  if (config.binaryRoots.length === 0) {
    problems.push({
      code: 'no_binary_roots',
      detail: 'Add at least one folder that binaries may be analyzed from.',
    });
  }
  return problems;
}
