// IDA Lab server surface: /api/ida-sql/*.
//
// Mounted twice from one implementation -- on the Vite dev server (loopback-trust,
// so the browser never holds the token) and on the autonomy daemon (token
// required), exactly like the host-bridge surface. Route resolution is a single
// pure-ish function so both mounts, and the tests, take the same path.
//
// Gate order for every effectful route (mirrors aoiHostBridgeGate):
//   0. auth        - the caller proved the local shared-secret token
//   1. kill switch - global panic off AND the capability explicitly enabled
//   2. containment - the target resolves inside a registered binary root
//   3. approval    - starting a session and running a write query are each bound
//                    to a single-use, TTL-bounded, content-addressed approval
//
// What is deliberately NOT in Aoi's tool surface: /config, /grants and
// /approvals/run. Aoi can propose a session or a write and must wait for the
// operator to click; it cannot widen its own reach, mint its own standing grant,
// or approve its own pending action. Same honest caveat as the host-bridge store:
// the approve route shares the daemon token, so what actually keeps Aoi out is
// that its tools do not expose these routes (plus the token in production).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, join, resolve } from 'path';
import type { Plugin } from 'vite';

import {
  AOI_HOST_BRIDGE_AUTH_HEADER,
  loadAoiHostBridgeToken,
  verifyAoiHostBridgeToken,
} from './aoiHostBridgeAuth';
import { evaluateAoiHostBridgeGate } from './aoiHostBridgeGate';
import {
  loadAoiHostBridgeKillSwitchState,
  type AoiHostBridgeKillSwitchState,
} from './aoiHostBridgeKillSwitch';
import {
  approveAoiHostBridgeApprovalAtomic,
  consumeAoiHostBridgeApprovalAtomic,
  findAoiHostBridgeApproval,
  loadAoiHostBridgeApprovalStore,
  recordAoiHostBridgePendingApprovalAtomic,
} from './aoiHostBridgeApprovalStore';
import { recordAoiHostSpawnedProcess } from './aoiHostSpawnAudit';
import { aoiSyncSha256Hex } from './aoiSyncSha256';
import {
  IDA_SQL_CONFIG_KEY,
  listIdaSqlConfigProblems,
  mergeIdaSqlConfig,
  normalizeIdaSqlConfig,
  resolveIdaDirectory,
  resolveIdaSqlPathWithinRoots,
  toStoredIdaSqlConfig,
} from './idaSqlConfig';
import { classifyIdaSqlBatch, summarizeIdaSqlBatch } from './idaSqlPolicy';
import {
  describeIdaWindow,
  describeIdaWindowForOperator,
  recallIdaWindow,
} from './idaSqlWindowHint';
import {
  IDA_SQL_MAX_SESSIONS,
  IdaSqlSessionManager,
  getSharedIdaSqlSessionManager,
  type IdaSqlQueryOutcome,
} from './idaSqlSession';
import {
  addIdaSqlStandingGrant,
  consumeIdaSqlStandingGrantAtomic,
  findLiveIdaSqlStandingGrant,
  loadIdaSqlStandingGrantStore,
  removeIdaSqlStandingGrant,
  updateIdaSqlStandingGrantStore,
} from './idaSqlStandingGrant';
import {
  IDA_SQL_ANALYSIS_CAPABILITY,
  IDA_SQL_AUTO_SESSION_CAPABILITY,
  IDA_SQL_WRITE_CAPABILITY,
  isIdaSqlAnalyzableName,
  type IdaSqlBrowseEntry,
  type IdaSqlConfigView,
  type IdaSqlSessionMode,
  type IdaSqlStatementClass,
  type IdaSqlStatementInfo,
} from './idaSqlTypes';

export const IDA_SQL_API_PREFIX = '/api/ida-sql';
export const IDA_SQL_APPROVAL_TTL_MS = 5 * 60 * 1000;

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BROWSE_ENTRIES = 400;
const MAX_FIND_DIRECTORIES = 4000;
const MAX_FIND_MATCHES = 60;
const MAX_FIND_DEPTH = 6;
const DEFAULT_FIND_DEPTH = 3;
const VERSION_PROBE_TIMEOUT_MS = 8000;
const TERMINAL_SESSION_RETENTION_MS = 30 * 60 * 1000;

/** A previewed action, held until its approval is spent or expires. */
type IdaSqlPendingAction =
  | {
      kind: 'session_start';
      binaryPath: string;
      rootId: string;
      mode: IdaSqlSessionMode;
      write: boolean;
      expiresAt: number;
    }
  | {
      kind: 'write_query';
      sessionId: string;
      sql: string;
      expiresAt: number;
    };

// Process-scoped: an approval that outlives the server it was previewed on has
// nothing to execute, and re-previewing is cheap.
const pendingActions = new Map<string, IdaSqlPendingAction>();

function prunePendingActions(now: number): void {
  for (const [fingerprint, action] of [...pendingActions.entries()]) {
    if (action.expiresAt <= now) {
      pendingActions.delete(fingerprint);
    }
  }
}

function fingerprintAction(action: IdaSqlPendingAction): string {
  const canonical =
    action.kind === 'session_start'
      ? JSON.stringify([
          'session_start',
          action.binaryPath.toLowerCase(),
          action.mode,
          action.write,
        ])
      : // The SQL is fingerprinted EXACTLY, whitespace included. Collapsing runs
        // of whitespace made two different statements share a fingerprint
        // whenever they differed only inside a string literal
        // (name='a  b' vs name='a b'), and then the second preview silently
        // became what an already-open popup for the first would run.
        JSON.stringify(['write_query', action.sessionId, action.sql]);
  return aoiSyncSha256Hex(canonical);
}

// --- Config persistence ------------------------------------------------------

function readPersistedConfig(configFile: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(configFile)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function loadIdaSqlConfig(configFile: string): IdaSqlConfigView {
  return normalizeIdaSqlConfig(readPersistedConfig(configFile)[IDA_SQL_CONFIG_KEY]);
}

export function saveIdaSqlConfig(configFile: string, config: IdaSqlConfigView): IdaSqlConfigView {
  const persisted = readPersistedConfig(configFile);
  const next = { ...persisted, [IDA_SQL_CONFIG_KEY]: toStoredIdaSqlConfig(config) };
  fs.mkdirSync(dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return config;
}

// --- Health probes -----------------------------------------------------------

function fileExists(path: string): boolean {
  try {
    return Boolean(path) && fs.existsSync(path) && fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return Boolean(path) && fs.existsSync(path) && fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Cached `idasql --version` output, keyed by the binary's identity on disk.
 *
 * This probe is a SYNCHRONOUS process spawn, and /health is polled every couple
 * of seconds while a session is analyzing. Uncached, that re-spawned idasql on
 * every poll and blocked the server's event loop for as long as it took each
 * time. The key includes size + mtime so replacing the binary re-probes.
 */
const versionProbeCache = new Map<string, string>();

function probeIdasqlVersion(config: IdaSqlConfigView): string {
  const path = config.idasqlExePath;
  if (!path) {
    return '';
  }
  let stamp: string;
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) {
      return '';
    }
    stamp = `${path}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return '';
  }
  const cached = versionProbeCache.get(stamp);
  if (cached !== undefined) {
    return cached;
  }
  let version = '';
  try {
    const idaDir = resolveIdaDirectory(config);
    const result = spawnSync(path, ['--version'], {
      cwd: idaDir || undefined,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf-8',
      shell: false,
    });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    version = text.split(/\r?\n/)[0]?.slice(0, 200) ?? '';
  } catch {
    version = '';
  }
  // Bound the map: one entry per binary identity, and a replaced binary would
  // otherwise leave its old entry behind forever.
  if (versionProbeCache.size > 8) {
    versionProbeCache.clear();
  }
  versionProbeCache.set(stamp, version);
  return version;
}

/** Test seam: drop the memoized version probe. */
export function resetIdaSqlVersionProbeCache(): void {
  versionProbeCache.clear();
}

/** idalib next to the IDA binary is what makes headless mode possible at all. */
function probeIdalibPresent(config: IdaSqlConfigView): boolean {
  const idaDir = resolveIdaDirectory(config);
  if (!idaDir) {
    return false;
  }
  return (
    directoryExists(join(idaDir, 'idalib')) ||
    fileExists(join(idaDir, 'idalib.dll')) ||
    fileExists(join(idaDir, 'libidalib.so')) ||
    fileExists(join(idaDir, 'libidalib.dylib'))
  );
}

/**
 * Does this directory actually contain the IDA engine?
 *
 * The directory we put on PATH is only useful if the engine is in it. Checking
 * turns "idasql started and died" into a setup message that names the problem.
 */
/**
 * Is the idasql IDA PLUGIN installed, as opposed to the CLI?
 *
 * These are two different artifacts and only one of them was ever checked. The
 * CLI (idasql.exe) serves a headless session; the plugin (idasql.dll, shipped in
 * the same archive under plugin/) is what adds `.http start` INSIDE the IDA
 * window. Without it GUI mode cannot work at all, and the app was telling the
 * operator to run a command their IDA does not have.
 *
 * Looked up per IDA's own plugin search: the user plugins directory first, then
 * the install tree.
 */
export function findIdaSqlPluginInstall(idaDirectory: string): string {
  const candidates: string[] = [];
  // IDAUSR relocates IDA's user directory, and on Windows it may hold several
  // paths separated by ';'. Checking it FIRST matters: a machine that sets it
  // does not use the default location at all, so ignoring it meant reporting a
  // correctly installed plugin as missing -- and that report blocks GUI mode.
  const idaUsr = process.env.IDAUSR;
  if (idaUsr) {
    for (const entry of idaUsr.split(process.platform === 'win32' ? ';' : ':')) {
      const trimmed = entry.trim();
      if (trimmed) {
        candidates.push(join(trimmed, 'plugins'));
      }
    }
  }
  const appData = process.env.APPDATA;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (appData) {
    candidates.push(join(appData, 'Hex-Rays', 'IDA Pro', 'plugins'));
  }
  if (home) {
    candidates.push(join(home, '.idapro', 'plugins'));
  }
  if (idaDirectory) {
    candidates.push(join(idaDirectory, 'plugins'));
  }
  const names = ['idasql.dll', 'idasql.so', 'idasql.dylib'];
  for (const directory of candidates) {
    for (const name of names) {
      // Both layouts IDA accepts: loose in plugins/, or in its own subfolder
      // beside an ida-plugin.json manifest (what 9.x prefers).
      for (const candidate of [join(directory, name), join(directory, 'idasql', name)]) {
        if (fileExists(candidate)) {
          return candidate;
        }
      }
    }
  }
  return '';
}

/**
 * The directories findIdaSqlPluginInstall looked in.
 *
 * Reported with the "not installed" problem on purpose. That verdict HARD-BLOCKS
 * GUI mode, and it comes from a heuristic over a handful of candidate paths -- so
 * if it is ever wrong, the operator has to be able to see that their actual
 * install location was never checked, instead of arguing with a flat denial.
 */
export function listIdaSqlPluginSearchPaths(idaDirectory: string): string[] {
  const searched: string[] = [];
  const idaUsr = process.env.IDAUSR;
  if (idaUsr) {
    for (const entry of idaUsr.split(process.platform === 'win32' ? ';' : ':')) {
      const trimmed = entry.trim();
      if (trimmed) {
        searched.push(join(trimmed, 'plugins'));
      }
    }
  }
  const appData = process.env.APPDATA;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (appData) {
    searched.push(join(appData, 'Hex-Rays', 'IDA Pro', 'plugins'));
  }
  if (home) {
    searched.push(join(home, '.idapro', 'plugins'));
  }
  if (idaDirectory) {
    searched.push(join(idaDirectory, 'plugins'));
  }
  return searched;
}

function probeIdaEnginePresent(directory: string): boolean {
  if (!directory) {
    return false;
  }
  return (
    fileExists(join(directory, 'ida.dll')) ||
    fileExists(join(directory, 'libida.so')) ||
    fileExists(join(directory, 'libida.dylib')) ||
    fileExists(join(directory, 'ida.exe'))
  );
}

// --- Browse ------------------------------------------------------------------

function listBrowseEntries(targetDir: string): {
  entries: IdaSqlBrowseEntry[];
  truncated: boolean;
} {
  const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
  const entries: IdaSqlBrowseEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= MAX_BROWSE_ENTRIES) {
      truncated = true;
      break;
    }
    const fullPath = join(targetDir, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({
        name: dirent.name,
        path: fullPath,
        kind: 'directory',
        sizeBytes: 0,
        analyzable: false,
      });
      continue;
    }
    if (!dirent.isFile()) {
      // Sockets, devices and dangling links are not analysis targets.
      continue;
    }
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(fullPath).size;
    } catch {
      sizeBytes = 0;
    }
    entries.push({
      name: dirent.name,
      path: fullPath,
      kind: 'file',
      sizeBytes,
      analyzable: isIdaSqlAnalyzableName(dirent.name),
    });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  return { entries, truncated };
}

/**
 * Bounded breadth-first search for a filename substring. Bounded on three axes
 * (depth, directories visited, matches) because this runs on an operator request
 * and a naive walk of a game install or C:\ would never come back.
 */
/**
 * Walk the roots for analyzable files whose name contains `needle`.
 *
 * Descends on `dirent.isDirectory()` and nothing else. That is load-bearing on
 * Windows: a directory junction inside a root is reported by readdir
 * withFileTypes as isDirectory=false, isSymbolicLink=true (measured), so this
 * walk stops at it and never enumerates the directory it points to. Switching
 * this test to statSync -- which FOLLOWS links -- would silently start
 * reporting file names from outside the operator's roots. Exported for the test
 * that pins exactly that.
 */
export function findBinariesUnder(
  startDirs: readonly string[],
  needle: string,
  maxDepth: number,
): { entries: IdaSqlBrowseEntry[]; truncated: boolean } {
  const lowered = needle.toLowerCase();
  const entries: IdaSqlBrowseEntry[] = [];
  const queue: { dir: string; depth: number }[] = startDirs.map((dir) => ({ dir, depth: 0 }));
  let visited = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (visited >= MAX_FIND_DIRECTORIES) {
      truncated = true;
      break;
    }
    visited += 1;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const fullPath = join(current.dir, dirent.name);
      if (dirent.isDirectory()) {
        if (current.depth < maxDepth) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!dirent.isFile() || !dirent.name.toLowerCase().includes(lowered)) {
        continue;
      }
      if (!isIdaSqlAnalyzableName(dirent.name)) {
        continue;
      }
      if (entries.length >= MAX_FIND_MATCHES) {
        truncated = true;
        return { entries, truncated };
      }
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(fullPath).size;
      } catch {
        sizeBytes = 0;
      }
      entries.push({
        name: dirent.name,
        path: fullPath,
        kind: 'file',
        sizeBytes,
        analyzable: true,
      });
    }
  }
  return { entries, truncated };
}

/**
 * Resolve a browse/analysis target to a real path that is still inside a root.
 * Containment is checked AFTER realpath, so a symlink pointing out of a root
 * cannot be used to walk out of it.
 */
function resolveRealTargetWithinRoots(
  requestedPath: string,
  config: IdaSqlConfigView,
): { ok: boolean; path: string; rootId: string; reason: string } {
  const first = resolveIdaSqlPathWithinRoots(requestedPath, config.binaryRoots);
  if (!first.ok) {
    return { ok: false, path: first.path, rootId: '', reason: first.reason };
  }
  let realPath = first.path;
  try {
    realPath = fs.realpathSync(first.path);
  } catch {
    return { ok: false, path: first.path, rootId: '', reason: 'path_not_found' };
  }
  const second = resolveIdaSqlPathWithinRoots(realPath, config.binaryRoots);
  if (!second.ok) {
    return { ok: false, path: realPath, rootId: '', reason: 'path_outside_roots' };
  }
  return { ok: true, path: realPath, rootId: second.rootId, reason: '' };
}

// --- Gate --------------------------------------------------------------------

interface GateParams {
  authenticated: boolean;
  killSwitchState: AoiHostBridgeKillSwitchState | null;
  capabilityKey: string;
  irreversible: boolean;
  approvalSatisfied?: boolean;
}

function gateOrDeny(params: GateParams): { status: number; payload: unknown } | null {
  const decision = evaluateAoiHostBridgeGate({
    authenticated: params.authenticated,
    killSwitchState: params.killSwitchState,
    capabilityKey: params.capabilityKey,
    irreversible: params.irreversible,
    ...(params.approvalSatisfied === undefined
      ? {}
      : { approvalSatisfied: params.approvalSatisfied }),
  });
  if (decision.allowed) {
    return null;
  }
  const status = decision.denyReasons.includes('not_authenticated') ? 401 : 403;
  return {
    status,
    payload: {
      ok: false,
      error: decision.denyReasons[0] ?? 'blocked',
      denyReasons: decision.denyReasons,
      detail: decision.detail,
    },
  };
}

// --- Routing -----------------------------------------------------------------

export function getIdaSqlRoute(pathname: string): string | null {
  if (pathname === IDA_SQL_API_PREFIX) {
    return '/';
  }
  if (!pathname.startsWith(`${IDA_SQL_API_PREFIX}/`)) {
    return null;
  }
  const route = pathname.slice(IDA_SQL_API_PREFIX.length);
  return route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
}

export interface ResolveIdaSqlRouteParams {
  method: string;
  route: string;
  body: Record<string, unknown>;
  token: string | null;
  openroomHome: string;
  configFile: string;
  now: number;
  /** Injected in tests; production uses the process-shared manager. */
  manager?: IdaSqlSessionManager;
}

export interface IdaSqlRouteResult {
  status: number;
  payload: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function parentOf(path: string): string {
  const parent = dirname(path);
  return parent === path ? '' : parent;
}

export async function resolveIdaSqlRoute(
  params: ResolveIdaSqlRouteParams,
): Promise<IdaSqlRouteResult> {
  const { method, route, body, now } = params;
  const openroomHome = resolve(params.openroomHome);
  const expectedToken = loadAoiHostBridgeToken(openroomHome);
  const authenticated = Boolean(
    expectedToken && verifyAoiHostBridgeToken(expectedToken, params.token),
  );
  if (!authenticated) {
    return {
      status: 401,
      payload: { ok: false, error: 'not_authenticated', denyReasons: ['not_authenticated'] },
    };
  }

  const killSwitchState = loadAoiHostBridgeKillSwitchState(openroomHome);
  const manager = params.manager ?? getSharedIdaSqlSessionManager();
  const config = loadIdaSqlConfig(params.configFile);
  prunePendingActions(now);
  manager.pruneTerminal(TERMINAL_SESSION_RETENTION_MS);
  // A request that names a session is activity on it, and has to count as such
  // BEFORE the reaper runs -- otherwise the first query after a long pause reaps
  // the session it was for and then fails on it.
  const namedSession = asString(body.sessionId);
  if (namedSession) {
    manager.touch(namedSession);
  }
  // Lazy reaper: a headless session holds a real idasql process and a port, so an
  // abandoned one has to be reclaimed by something. There is no timer here on
  // purpose -- a background interval in the Vite plugin would outlive the work it
  // was serving; the next request is a good enough clock for an idle timeout.
  await manager.reapIdle(config);

  const capabilityEnabled = (key: string): boolean =>
    gateOrDeny({
      authenticated: true,
      killSwitchState,
      capabilityKey: key,
      irreversible: false,
    }) === null;

  // --- Health / config (operator surface; auth only) -------------------------

  if (method === 'GET' && (route === '/' || route === '/health')) {
    const problems = listIdaSqlConfigProblems(config, config.defaultMode).map(
      (problem) => `${problem.code}: ${problem.detail}`,
    );
    const idasqlPresent = fileExists(config.idasqlExePath);
    if (config.idasqlExePath && !idasqlPresent) {
      problems.push('idasql_not_found: the configured idasql path does not exist.');
    }
    // The directory we will put on PATH has to be the one holding the engine.
    // Saying so here is the difference between a setup message and idasql dying
    // on first launch for a reason nobody can see.
    const idaDirectory = resolveIdaDirectory(config);
    const idaEnginePresent = probeIdaEnginePresent(idaDirectory);
    if (config.idasqlExePath && !config.idaExePath && !idaEnginePresent) {
      problems.push(
        'ida_path_required: idasql is not inside an IDA install, so the IDA engine cannot be found from it. Set the ida.exe path.',
      );
    } else if (idaDirectory && !idaEnginePresent) {
      problems.push(
        `ida_engine_not_found: no IDA engine in ${idaDirectory}. idasql needs that directory on PATH to start.`,
      );
    }
    // GUI mode needs the PLUGIN, which is a different artifact from the CLI and
    // was never checked. Report it rather than letting the operator discover it
    // as a command their IDA does not have.
    const idaSqlPluginPath = findIdaSqlPluginInstall(idaDirectory);
    if (config.idaExePath && !idaSqlPluginPath) {
      const searched = listIdaSqlPluginSearchPaths(idaDirectory);
      problems.push(
        'idasql_plugin_not_installed: GUI mode needs the idasql IDA plugin (plugin/idasql.dll from the same archive as the CLI) in your IDA plugins folder. ' +
          `Headless mode works without it. Looked in: ${searched.join(' | ') || '(no candidate directories)'}.`,
      );
    }
    return {
      status: 200,
      payload: {
        ok: true,
        health: {
          configured:
            Boolean(config.idasqlExePath) && config.binaryRoots.length > 0 && idaEnginePresent,
          config,
          idasqlPresent,
          idasqlVersion: probeIdasqlVersion(config),
          idaExePresent: fileExists(config.idaExePath),
          idaDirectory,
          idaEnginePresent,
          idaSqlPluginPath,
          idalibPresent: probeIdalibPresent(config),
          analysisCapabilityEnabled: capabilityEnabled(IDA_SQL_ANALYSIS_CAPABILITY),
          writeCapabilityEnabled: capabilityEnabled(IDA_SQL_WRITE_CAPABILITY),
          autoSessionCapabilityEnabled: capabilityEnabled(IDA_SQL_AUTO_SESSION_CAPABILITY),
          globalPanic: killSwitchState?.globalPanic === true,
          problems,
        },
      },
    };
  }

  if (route === '/config') {
    if (method === 'GET') {
      return { status: 200, payload: { ok: true, config } };
    }
    if (method === 'POST') {
      const next = mergeIdaSqlConfig(config, body);
      saveIdaSqlConfig(params.configFile, next);
      return { status: 200, payload: { ok: true, config: next } };
    }
    return { status: 405, payload: { ok: false, error: 'method_not_allowed' } };
  }

  // --- Standing grants (operator surface; auth only) ------------------------

  if (route === '/grants') {
    if (method === 'GET') {
      const store = loadIdaSqlStandingGrantStore(openroomHome);
      return { status: 200, payload: { ok: true, grants: store.grants } };
    }
    if (method === 'POST') {
      const rootId = asString(body.rootId);
      if (!config.binaryRoots.some((root) => root.id === rootId)) {
        return { status: 400, payload: { ok: false, error: 'unknown_root_id' } };
      }
      const outcome = updateIdaSqlStandingGrantStore(openroomHome, (current) => {
        const result = addIdaSqlStandingGrant(current, {
          rootId,
          ...(asString(body.label) ? { label: asString(body.label) } : {}),
          ...(asNumber(body.ttlMs) > 0 ? { ttlMs: asNumber(body.ttlMs) } : {}),
          ...(asNumber(body.maxSessions) > 0 ? { maxSessions: asNumber(body.maxSessions) } : {}),
          now,
        });
        return { next: result.grant ? result.store : null, result };
      });
      if (!outcome.result.grant) {
        return {
          status: 400,
          payload: { ok: false, error: outcome.result.reason || 'grant_rejected' },
        };
      }
      return { status: 200, payload: { ok: true, grant: outcome.result.grant } };
    }
    if (method === 'DELETE') {
      const grantId = asString(body.grantId);
      const outcome = updateIdaSqlStandingGrantStore(openroomHome, (current) => {
        const result = removeIdaSqlStandingGrant(current, grantId, now);
        return { next: result.removed ? result.store : null, result };
      });
      return { status: 200, payload: { ok: true, removed: outcome.result.removed } };
    }
    return { status: 405, payload: { ok: false, error: 'method_not_allowed' } };
  }

  // --- Browse ---------------------------------------------------------------

  if (method === 'GET' && route === '/browse') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    const requested = asString(body.path);
    const find = asString(body.find).trim();

    if (find) {
      if (find.length < 2) {
        return { status: 400, payload: { ok: false, error: 'find_too_short' } };
      }
      // Search inside the requested subtree when given one, otherwise across
      // every registered root. Either way the walk starts inside a root, so a
      // match can never be outside one.
      let startDirs: string[];
      let searchRootId = '';
      if (requested) {
        const target = resolveRealTargetWithinRoots(requested, config);
        if (!target.ok) {
          return { status: 403, payload: { ok: false, error: target.reason } };
        }
        if (!directoryExists(target.path)) {
          return { status: 400, payload: { ok: false, error: 'not_a_directory' } };
        }
        startDirs = [target.path];
        searchRootId = target.rootId;
      } else {
        startDirs = config.binaryRoots.map((root) => root.path).filter(directoryExists);
      }
      const depthRaw = asNumber(body.depth);
      const depth =
        depthRaw > 0 ? Math.min(MAX_FIND_DEPTH, Math.floor(depthRaw)) : DEFAULT_FIND_DEPTH;
      const found = findBinariesUnder(startDirs, find, depth);
      return {
        status: 200,
        payload: {
          ok: true,
          browse: {
            path: requested ? startDirs[0] : '',
            rootId: searchRootId,
            parentPath: '',
            entries: found.entries,
            truncated: found.truncated,
          },
        },
      };
    }

    if (!requested) {
      // No path: the roots themselves are the entry points.
      return {
        status: 200,
        payload: {
          ok: true,
          browse: {
            path: '',
            rootId: '',
            parentPath: '',
            entries: config.binaryRoots.map((root) => ({
              name: root.label,
              path: root.path,
              kind: 'directory' as const,
              sizeBytes: 0,
              analyzable: false,
            })),
            truncated: false,
          },
        },
      };
    }
    const target = resolveRealTargetWithinRoots(requested, config);
    if (!target.ok) {
      return { status: 403, payload: { ok: false, error: target.reason } };
    }
    if (!directoryExists(target.path)) {
      return { status: 400, payload: { ok: false, error: 'not_a_directory' } };
    }
    let listing: { entries: IdaSqlBrowseEntry[]; truncated: boolean };
    try {
      listing = listBrowseEntries(target.path);
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: 'browse_failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const parentCandidate = parentOf(target.path);
    const parentAllowed =
      parentCandidate && resolveIdaSqlPathWithinRoots(parentCandidate, config.binaryRoots).ok;
    return {
      status: 200,
      payload: {
        ok: true,
        browse: {
          path: target.path,
          rootId: target.rootId,
          parentPath: parentAllowed ? parentCandidate : '',
          entries: listing.entries,
          truncated: listing.truncated,
        },
      },
    };
  }

  // --- Sessions -------------------------------------------------------------

  if (method === 'GET' && route === '/sessions') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    return { status: 200, payload: { ok: true, sessions: manager.list() } };
  }

  if (method === 'POST' && route === '/sessions/preview') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }

    const mode: IdaSqlSessionMode = asString(body.mode) === 'gui' ? 'gui' : config.defaultMode;
    const write = asBoolean(body.write);
    const blockReasons: string[] = [];

    if (write) {
      if (!config.writeEnabled) {
        blockReasons.push('write_not_enabled_in_settings');
      }
      if (!capabilityEnabled(IDA_SQL_WRITE_CAPABILITY)) {
        blockReasons.push('write_capability_disabled');
      }
    }
    if (mode === 'headless' && !config.idasqlExePath) {
      blockReasons.push('idasql_path_missing');
    }
    if (
      mode === 'gui' &&
      config.idaExePath &&
      !findIdaSqlPluginInstall(resolveIdaDirectory(config))
    ) {
      // The launch itself would succeed and be useless: without the plugin there
      // is no `.http start` inside IDA, so the session can never be attached.
      // Checked here so the operator learns it before a window opens.
      blockReasons.push('idasql_plugin_not_installed');
    }
    if (mode === 'gui' && !config.idaExePath) {
      blockReasons.push('ida_path_missing');
    }

    // Checked at preview so a start that cannot happen never records an approval
    // -- and, for an auto-approved start, never SPENDS a standing-grant session
    // on it. startHeadless enforces the cap again at execute time, which is what
    // actually closes the preview-to-click window.
    if (manager.activeCount() >= IDA_SQL_MAX_SESSIONS) {
      blockReasons.push('too_many_sessions');
    }

    const target = resolveRealTargetWithinRoots(asString(body.binaryPath), config);
    let holderSessionId = '';
    if (!target.ok) {
      blockReasons.push(target.reason);
    } else if (!fileExists(target.path)) {
      blockReasons.push('binary_not_found');
    } else if (mode === 'headless') {
      // Two idasql instances on one database fight over the .i64 lock, and the
      // loser exits with "Failed to open database" (measured, not guessed).
      // Point the caller at the session that already exists instead.
      const holder = manager.findByBinary(target.path);
      if (holder) {
        holderSessionId = holder.id;
        blockReasons.push('session_already_open');
      }
    }

    const action: IdaSqlPendingAction = {
      kind: 'session_start',
      binaryPath: target.path,
      rootId: target.rootId,
      mode,
      write,
      expiresAt: now + IDA_SQL_APPROVAL_TTL_MS,
    };
    const approvalFingerprint = fingerprintAction(action);
    const targetSummary = `${mode === 'gui' ? 'IDA GUI' : 'idasql headless'}${
      write ? ' (write)' : ''
    }: ${target.path || asString(body.binaryPath)}`;

    if (blockReasons.length > 0) {
      return {
        status: 200,
        payload: {
          ok: true,
          preview: {
            allowed: false,
            blockReasons,
            approvalFingerprint: '',
            capability: IDA_SQL_ANALYSIS_CAPABILITY,
            targetSummary,
            expiresAt: 0,
            autoApproved: false,
            binaryPath: target.path,
            mode,
            write,
            program: mode === 'gui' ? config.idaExePath : config.idasqlExePath,
            args: [],
            ...(holderSessionId ? { existingSessionId: holderSessionId } : {}),
          },
        },
      };
    }

    // A live standing grant for this root replaces the click -- and only the
    // click. Containment, capability and the session cap were already checked.
    const autoRequested = asBoolean(body.auto);
    let autoApproved = false;
    if (autoRequested && capabilityEnabled(IDA_SQL_AUTO_SESSION_CAPABILITY)) {
      const grant = findLiveIdaSqlStandingGrant(
        loadIdaSqlStandingGrantStore(openroomHome),
        target.rootId,
        now,
      );
      if (grant && consumeIdaSqlStandingGrantAtomic(openroomHome, grant.id, now).consumed) {
        autoApproved = true;
      }
    }

    pendingActions.set(approvalFingerprint, action);
    recordAoiHostBridgePendingApprovalAtomic(openroomHome, {
      capability: IDA_SQL_ANALYSIS_CAPABILITY,
      approvalFingerprint,
      targetSummary,
      now,
      expiresAt: now + IDA_SQL_APPROVAL_TTL_MS,
    });

    if (autoApproved) {
      approveAoiHostBridgeApprovalAtomic(openroomHome, approvalFingerprint, now);
      const executed = await executePendingAction({
        openroomHome,
        approvalFingerprint,
        config,
        killSwitchState,
        manager,
        now,
      });
      return { status: executed.status, payload: executed.payload };
    }

    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: true,
          blockReasons: [],
          approvalFingerprint,
          capability: IDA_SQL_ANALYSIS_CAPABILITY,
          targetSummary,
          expiresAt: action.expiresAt,
          autoApproved: false,
          binaryPath: target.path,
          mode,
          write,
          program: mode === 'gui' ? config.idaExePath : config.idasqlExePath,
          args: [],
        },
      },
    };
  }

  if (method === 'POST' && route === '/sessions/attach') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    const hint = asString(body.binaryPath);
    const port = asNumber(body.port);
    // An in-IDA server the operator protected with a token is reachable only if
    // they hand us the token; otherwise the probe just gets 401.
    const guiToken = asString(body.token).trim().slice(0, 256);
    // A HUMAN saying "that port is my IDA". Deliberately not part of the Aoi tool
    // surface: a model repeating a port back is not a person who can see what is
    // listening on it. This exists because the identity check is an inference
    // about the plugin's /status body -- strong (the plugin binary carries the
    // same tool/idasql/status strings as the CLI, whose body IS measured) but not
    // measured -- and if that inference is ever wrong the operator must not be
    // locked out of their own IDA.
    const portDeclared = asBoolean(body.portDeclared);
    const attached = await manager.attachGui({
      ...(hint ? { binaryPathHint: hint } : {}),
      ...(port > 0 ? { portHint: port } : {}),
      ...(portDeclared && port > 0 ? { portDeclared: true } : {}),
      ...(guiToken ? { token: guiToken } : {}),
    });
    if (!attached.ok) {
      return { status: 409, payload: { ok: false, error: attached.reason } };
    }
    return { status: 200, payload: { ok: true, session: attached.session } };
  }

  if (method === 'DELETE' && route === '/sessions') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    const stopped = await manager.stop(asString(body.sessionId));
    if (!stopped.ok) {
      return { status: 404, payload: { ok: false, error: stopped.reason } };
    }
    return { status: 200, payload: { ok: true } };
  }

  // --- Query ----------------------------------------------------------------

  if (method === 'POST' && route === '/query') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }

    const sessionId = asString(body.sessionId);
    const sql = asString(body.sql);
    const session = manager.get(sessionId);
    if (!session) {
      return { status: 404, payload: { ok: false, error: 'unknown_session' } };
    }

    // Classify against THIS session's engine: a function the policy has never
    // reviewed makes the statement a write, so an idasql upgrade that adds one
    // cannot arrive silently classified as a read.
    const classification = classifyIdaSqlBatch(sql, {
      unreviewedFunctions: manager.unreviewedFunctions(sessionId),
    });
    if (classification.rejectReason) {
      return { status: 400, payload: { ok: false, error: classification.rejectReason } };
    }
    if (classification.statementClass === 'forbidden') {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'forbidden_statement',
          detail: summarizeIdaSqlBatch(classification),
          statements: classification.statements,
        },
      };
    }

    if (classification.statementClass === 'write') {
      if (!capabilityEnabled(IDA_SQL_WRITE_CAPABILITY)) {
        return {
          status: 403,
          payload: {
            ok: false,
            error: 'write_capability_disabled',
            statements: classification.statements,
          },
        };
      }
      if (!session.write) {
        return {
          status: 409,
          payload: {
            ok: false,
            error: 'session_is_read_only',
            detail:
              'This session was started without -w, so a write cannot persist. Start a write session for this binary first.',
            statements: classification.statements,
          },
        };
      }
      const action: IdaSqlPendingAction = {
        kind: 'write_query',
        sessionId,
        sql,
        expiresAt: now + IDA_SQL_APPROVAL_TTL_MS,
      };
      const approvalFingerprint = fingerprintAction(action);
      const targetSummary = `IDASQL write on ${session.binaryName}: ${summarizeIdaSqlBatch(
        classification,
      )}`;
      pendingActions.set(approvalFingerprint, action);
      recordAoiHostBridgePendingApprovalAtomic(openroomHome, {
        capability: IDA_SQL_WRITE_CAPABILITY,
        approvalFingerprint,
        targetSummary,
        now,
        expiresAt: action.expiresAt,
      });
      return {
        status: 200,
        payload: {
          ok: true,
          needsApproval: true,
          preview: {
            allowed: true,
            blockReasons: [],
            approvalFingerprint,
            capability: IDA_SQL_WRITE_CAPABILITY,
            targetSummary,
            expiresAt: action.expiresAt,
            autoApproved: false,
            sessionId,
            sql,
            statements: classification.statements,
          },
        },
      };
    }

    const outcome = await manager.query(sessionId, sql);
    return buildQueryResponse({
      sessionId,
      statementClass: classification.statementClass,
      statements: classification.statements,
      outcome,
    });
  }

  // --- Approve and run (operator click; NOT in Aoi's tool surface) ----------

  if (method === 'POST' && route === '/approvals/run') {
    const approvalFingerprint = asString(body.approvalFingerprint);
    if (!approvalFingerprint) {
      return { status: 400, payload: { ok: false, error: 'missing_fingerprint' } };
    }
    // Establish that this fingerprint is OURS before approving anything.
    //
    // The approval store is shared with the host bridge (spawn, kill, file
    // delete). Approving by fingerprint first meant this route would flip a
    // PENDING host-bridge approval to 'approved' whenever the fingerprint did
    // not belong to IDA Lab -- and the host-bridge execute routes honor an
    // approved entry, so a caller here could hand itself a process spawn or a
    // file delete that no operator ever clicked. The pending-action map is the
    // proof of ownership: it only ever holds previews this module recorded.
    const pending = pendingActions.get(approvalFingerprint);
    if (!pending) {
      return { status: 404, payload: { ok: false, error: 'unknown_or_expired_preview' } };
    }
    const pendingCapability =
      pending.kind === 'write_query' ? IDA_SQL_WRITE_CAPABILITY : IDA_SQL_ANALYSIS_CAPABILITY;
    const storedEntry = findAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(openroomHome),
      approvalFingerprint,
      now,
    );
    // A live entry under a different capability is not ours to approve either,
    // even though we hold a preview for the same fingerprint.
    if (storedEntry && storedEntry.capability !== pendingCapability) {
      return { status: 403, payload: { ok: false, error: 'capability_mismatch' } };
    }
    approveAoiHostBridgeApprovalAtomic(openroomHome, approvalFingerprint, now);
    const executed = await executePendingAction({
      openroomHome,
      approvalFingerprint,
      config,
      killSwitchState,
      manager,
      now,
    });
    return { status: executed.status, payload: executed.payload };
  }

  if (method === 'GET' && route === '/approvals') {
    const store = loadAoiHostBridgeApprovalStore(openroomHome);
    const approvals = store.approvals.filter(
      (approval) =>
        approval.capability === IDA_SQL_ANALYSIS_CAPABILITY ||
        approval.capability === IDA_SQL_WRITE_CAPABILITY,
    );
    return { status: 200, payload: { ok: true, approvals } };
  }

  if (method === 'GET' && route === '/gui-window') {
    // Reads what the launch's own hint run already found. No PowerShell here:
    // the launch fires one and this returns its result, so polling this route
    // costs nothing. Gated like the other reads -- it exposes a window title,
    // which carries the binary path.
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    const pid = Number.parseInt(asString(body.pid), 10);
    const hint = Number.isInteger(pid) && pid > 0 ? recallIdaWindow(pid) : null;
    return {
      status: 200,
      payload: {
        ok: true,
        // Null until the hint run settles: it waits for IDA to draw a window,
        // which takes about three seconds.
        window: hint,
        detail: hint ? describeIdaWindowForOperator(hint) : '',
      },
    };
  }

  if (method === 'GET' && route === '/session-output') {
    // Gated like every other read: this is idasql's own stdout/stderr, which
    // carries host paths and licence detail.
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: IDA_SQL_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    return {
      status: 200,
      payload: { ok: true, output: manager.outputTail(asString(body.sessionId)) },
    };
  }

  return { status: 404, payload: { ok: false, error: 'unknown_route' } };
}

/**
 * Spend the approval and perform what it was previewed for. Consuming FIRST is
 * deliberate: a single-use approval must be gone before the effect happens, so a
 * crash mid-effect can never leave a reusable approval behind.
 */
/**
 * Shape a query answer.
 *
 * A statement the ENGINE rejected ("no such column: start_ea") is a successful
 * request carrying a failed statement, not a failed request. Returning it as
 * ok:false threw away the message on the way out -- the client raises the top
 * level `error` code and drops the body, so the operator was told
 * "engine_error" and the UI kept the PREVIOUS query's table on screen. Only a
 * transport or session failure is ok:false.
 */
function buildQueryResponse(params: {
  sessionId: string;
  statementClass: IdaSqlStatementClass;
  statements: IdaSqlStatementInfo[];
  outcome: IdaSqlQueryOutcome;
}): IdaSqlRouteResult {
  const { sessionId, statementClass, statements, outcome } = params;
  const engineRejected = !outcome.ok && outcome.reason === 'engine_error';
  const delivered = outcome.ok || engineRejected;
  return {
    status: delivered ? 200 : 409,
    payload: {
      ok: delivered,
      ...(delivered ? {} : { error: outcome.reason || 'query_failed' }),
      // The message travels in `detail` too, so a caller that only surfaces the
      // envelope still says something useful.
      ...(!delivered && outcome.engineError ? { detail: outcome.engineError } : {}),
      query: {
        sessionId,
        statementClass,
        statements,
        resultSets: outcome.resultSets,
        elapsedMs: outcome.elapsedMs,
        engineError: outcome.engineError,
      },
    },
  };
}

async function executePendingAction(params: {
  openroomHome: string;
  approvalFingerprint: string;
  config: IdaSqlConfigView;
  killSwitchState: AoiHostBridgeKillSwitchState | null;
  manager: IdaSqlSessionManager;
  now: number;
}): Promise<IdaSqlRouteResult> {
  const { openroomHome, approvalFingerprint, config, killSwitchState, manager, now } = params;
  const action = pendingActions.get(approvalFingerprint);
  if (!action) {
    return { status: 404, payload: { ok: false, error: 'unknown_or_expired_preview' } };
  }
  if (action.expiresAt <= now) {
    pendingActions.delete(approvalFingerprint);
    return { status: 410, payload: { ok: false, error: 'preview_expired' } };
  }

  const capability =
    action.kind === 'write_query' ? IDA_SQL_WRITE_CAPABILITY : IDA_SQL_ANALYSIS_CAPABILITY;

  // Re-evaluate the gate HERE, not only at preview.
  //
  // Everything between preview and click is the operator's chance to change
  // their mind: pressing panic, switching the capability off, dropping the root
  // the binary lives under. Checking only at preview meant an approval recorded
  // minutes ago still spawned IDA after panic was engaged -- exactly the state
  // panic exists to prevent. Same discipline as the host-bridge spawn runner,
  // which re-evaluates its policy at execute time.
  const denied = gateOrDeny({
    authenticated: true,
    killSwitchState,
    capabilityKey: capability,
    irreversible: false,
  });
  if (denied) {
    return denied;
  }

  if (action.kind === 'session_start') {
    const target = resolveRealTargetWithinRoots(action.binaryPath, config);
    if (!target.ok || !fileExists(target.path)) {
      return {
        status: 403,
        payload: { ok: false, error: target.ok ? 'binary_not_found' : target.reason },
      };
    }
    if (action.write && !config.writeEnabled) {
      return { status: 403, payload: { ok: false, error: 'write_not_enabled_in_settings' } };
    }
    // The program, not only the target. Preview checked the binary existed but
    // never re-checked the engine, so a moved or renamed ida.exe surfaced as a
    // bare spawn failure. Name the thing the operator has to fix.
    const program = action.mode === 'gui' ? config.idaExePath : config.idasqlExePath;
    if (!program || !fileExists(program)) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: action.mode === 'gui' ? 'ida_path_missing' : 'idasql_path_missing',
          detail: program
            ? `${program} is configured but not on disk any more.`
            : 'No path is configured for it in IDA Lab settings.',
        },
      };
    }
  }

  const stored = findAoiHostBridgeApproval(
    loadAoiHostBridgeApprovalStore(openroomHome),
    approvalFingerprint,
    now,
  );
  if (!stored || stored.state !== 'approved') {
    return {
      status: 403,
      payload: { ok: false, error: 'approval_required', denyReasons: ['approval_required'] },
    };
  }

  const consumed = consumeAoiHostBridgeApprovalAtomic(openroomHome, {
    capability,
    approvalFingerprint,
    now,
  });
  if (!consumed.ok) {
    return {
      status: 403,
      payload: {
        ok: false,
        error: 'approval_required',
        denyReasons: ['approval_required'],
        ...(consumed.reason ? { detail: consumed.reason } : {}),
      },
    };
  }
  pendingActions.delete(approvalFingerprint);

  if (action.kind === 'write_query') {
    const outcome = await manager.query(action.sessionId, action.sql);
    return buildQueryResponse({
      sessionId: action.sessionId,
      statementClass: 'write',
      statements: [],
      outcome,
    });
  }

  if (action.mode === 'gui') {
    const launched = await manager.launchGui({ config, binaryPath: action.binaryPath });
    if (!launched.ok) {
      return { status: 409, payload: { ok: false, error: launched.reason } };
    }
    if (launched.pid) {
      recordAoiHostSpawnedProcess(openroomHome, { pid: launched.pid, imageName: 'ida' }, now);
    }
    // Fired, not awaited.
    //
    // The hint has to WAIT for IDA to draw (measured: ~3s to a window handle, and
    // its first window is usually the existing-database prompt), so awaiting it
    // would hold the approval response for several seconds -- while the thing the
    // operator actually needs from that response is the command to type. The
    // flash is the part that answers "I cannot see it", and a flash needs no
    // reply. .catch is belt and braces: describeIdaWindow is documented not to
    // throw, and an unhandled rejection here would be the dev server's problem.
    if (launched.pid) {
      void describeIdaWindow(launched.pid).catch(() => undefined);
    }
    return {
      status: 200,
      payload: {
        ok: true,
        launchedPid: launched.pid,
        session: null,
        guiStartCommand: launched.startCommand,
        guiSuggestedPort: launched.suggestedPort,
        guiSuggestedToken: launched.suggestedToken,
        // Both halves are load-bearing. The window opens BEHIND whatever had
        // focus, because a detached process cannot take the foreground -- so
        // "IDA is starting" alone left the operator looking for a window they
        // could not see. And a bare `.http start` binds a random port with no
        // auth, so attaching needs the port and token named up front.
        // No coordinates here on purpose: at the moment this replies, IDA has
        // not drawn a window yet, so any position would be invented. What can be
        // promised is the flash, and why it will not come to the front.
        detail:
          `IDA is opening as PID ${launched.pid}. Its window opens BEHIND this one -- Windows does not let a background launcher take the foreground -- and it may land on another monitor, so watch for its taskbar button flashing in a few seconds. ` +
          `If a database already exists it asks what to do with it first. ` +
          `Once the database is loaded, run this in IDA's idasql CLI window, then attach here:
${launched.startCommand}`,
      },
    };
  }

  const started = await manager.startHeadless({
    config,
    binaryPath: action.binaryPath,
    write: action.write,
  });
  if (!started.ok) {
    return {
      status: 409,
      payload: {
        ok: false,
        error: started.reason,
        ...(started.existingSessionId ? { existingSessionId: started.existingSessionId } : {}),
      },
    };
  }
  if (started.session?.pid) {
    recordAoiHostSpawnedProcess(
      openroomHome,
      { pid: started.session.pid, imageName: 'idasql' },
      now,
    );
  }
  return { status: 200, payload: { ok: true, session: started.session } };
}

// --- Middleware / plugin -----------------------------------------------------

export interface IdaSqlPluginOptions {
  configFile: string;
  sessionsDir: string;
  openroomHome?: string;
  /**
   * Dev-server convenience: a loopback request without the auth header borrows
   * the daemon's token, so the browser never holds the secret. Off by default --
   * the standalone daemon still requires the header.
   */
  trustLoopbackToken?: boolean;
}

export type IdaSqlMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString() || '{}';
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Request body must be a JSON object.'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function createIdaSqlMiddleware(options: IdaSqlPluginOptions): IdaSqlMiddleware {
  const sessionsDir = resolve(options.sessionsDir);
  const openroomHome = resolve(options.openroomHome || resolve(sessionsDir, '..'));
  const configFile = resolve(options.configFile);
  return (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = getIdaSqlRoute(url.pathname);
    if (route === null) {
      next();
      return;
    }
    const method = req.method ?? 'GET';
    const tokenHeader = req.headers[AOI_HOST_BRIDGE_AUTH_HEADER];
    let token = Array.isArray(tokenHeader) ? (tokenHeader[0] ?? null) : (tokenHeader ?? null);
    if (!token && options.trustLoopbackToken && isLoopbackRequest(req)) {
      token = loadAoiHostBridgeToken(openroomHome);
    }

    void (async () => {
      const body: Record<string, unknown> =
        method === 'GET' || method === 'DELETE'
          ? Object.fromEntries(url.searchParams.entries())
          : await readJsonBody(req).catch(() => ({}));
      const result = await resolveIdaSqlRoute({
        method,
        route,
        body,
        token,
        openroomHome,
        configFile,
        now: Date.now(),
      });
      writeJson(res, result.status, result.payload);
    })().catch((error) => {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

export function idaSqlPlugin(options: IdaSqlPluginOptions): Plugin {
  const middleware = createIdaSqlMiddleware({ ...options, trustLoopbackToken: true });
  return {
    name: 'ida-sql',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
