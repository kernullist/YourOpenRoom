// Ghidra Lab server surface: /api/ghidra-lab/*.
//
// Mounted from one implementation on the Vite dev server (loopback-trust, so the
// browser never holds the token), exactly like the IDA Lab and host-bridge
// surfaces. Route resolution is a single function so the mount and the tests take
// the same path.
//
// Gate order for every effectful route (mirrors aoiHostBridgeGate):
//   0. auth        - the caller proved the local shared-secret token
//   1. kill switch - global panic off AND the capability explicitly enabled
//   2. preflight   - the configured Ghidra/JDK actually work (see below)
//   3. containment - the target resolves inside a registered binary root
//   4. approval    - starting a session and starting a sweep are each bound to a
//                    single-use, TTL-bounded, content-addressed approval
//
// Step 2 is the one this surface adds. Everywhere else a bad path produces an
// error; here a bad JDK produces a HANG, because Ghidra prompts on stdin for a
// Java home and a spawned child has no console to answer with. So the preflight
// verdict is a gate, not a display.
//
// What is deliberately NOT in Aoi's tool surface: /config, /bootstrap-python and
// /approvals/run. Aoi can propose a session or a sweep and must wait for the
// operator to click; it cannot widen its own reach or approve its own pending
// action. Same honest caveat as everywhere else in this codebase: the approve
// route shares the daemon token, so what actually keeps Aoi out is that its tools
// do not expose these routes.
import { spawn } from 'child_process';
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
  findAoiHostBridgeApproval,
  loadAoiHostBridgeApprovalStore,
  recordAoiHostBridgePendingApprovalAtomic,
} from './aoiHostBridgeApprovalStore';
import { recordAoiHostSpawnedProcess } from './aoiHostSpawnAudit';
import { aoiSyncSha256Hex } from './aoiSyncSha256';
import { callAoiMainTextModel } from './dewdropCanvasPlugin';
import {
  GHIDRA_LAB_CONFIG_KEY,
  buildGhidraChildEnv,
  deriveGhidraProjectName,
  listGhidraLabConfigProblems,
  mergeGhidraLabConfig,
  normalizeGhidraLabConfig,
  resolveGhidraPathWithinRoots,
  resolvePyghidraScriptPath,
  toStoredGhidraLabConfig,
} from './ghidraLabConfig';
import { runGhidraLabPreflight, type GhidraLabPreflightResult } from './ghidraLabPreflight';
import { GhidraLabRunManager, getSharedGhidraLabRunManager, runCapa } from './ghidraLabRunner';
import {
  GHIDRA_LAB_MAX_SESSIONS,
  GhidraLabSessionManager,
  getSharedGhidraLabSessionManager,
} from './ghidraLabSession';
import {
  GHIDRA_ANALYSIS_CAPABILITY,
  GHIDRA_AUTO_SESSION_CAPABILITY,
  GHIDRA_WRITE_CAPABILITY,
  isGhidraAnalyzableName,
  type GhidraLabBrowseEntry,
  type GhidraLabConfigView,
} from './ghidraLabTypes';
import type { LLMConfig } from './llmModels';

export const GHIDRA_LAB_API_PREFIX = '/api/ghidra-lab';
export const GHIDRA_LAB_APPROVAL_TTL_MS = 5 * 60 * 1000;

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BROWSE_ENTRIES = 400;
const MAX_FIND_DIRECTORIES = 4000;
const MAX_FIND_MATCHES = 60;
const MAX_FIND_DEPTH = 6;
const DEFAULT_FIND_DEPTH = 3;
const TERMINAL_SESSION_RETENTION_MS = 30 * 60 * 1000;
const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_CHARS = 400000;
const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;

/** A previewed action, held until its approval is spent or expires. */
type GhidraLabPendingAction =
  | {
      kind: 'session_start';
      binaryPath: string;
      rootId: string;
      projectName: string;
      expiresAt: number;
    }
  | {
      kind: 'report_run';
      sessionId: string;
      binaryPath: string;
      expiresAt: number;
    };

// Process-scoped: an approval that outlives the server it was previewed on has
// nothing to execute, and re-previewing is cheap.
const pendingActions = new Map<string, GhidraLabPendingAction>();

function prunePendingActions(now: number): void {
  for (const [fingerprint, action] of [...pendingActions.entries()]) {
    if (action.expiresAt <= now) {
      pendingActions.delete(fingerprint);
    }
  }
}

function fingerprintAction(action: GhidraLabPendingAction): string {
  const canonical =
    action.kind === 'session_start'
      ? JSON.stringify(['session_start', action.binaryPath.toLowerCase(), action.projectName])
      : JSON.stringify(['report_run', action.sessionId, action.binaryPath.toLowerCase()]);
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

export function loadGhidraLabConfig(configFile: string): GhidraLabConfigView {
  return normalizeGhidraLabConfig(readPersistedConfig(configFile)[GHIDRA_LAB_CONFIG_KEY]);
}

export function saveGhidraLabConfig(
  configFile: string,
  config: GhidraLabConfigView,
): GhidraLabConfigView {
  const persisted = readPersistedConfig(configFile);
  const next = { ...persisted, [GHIDRA_LAB_CONFIG_KEY]: toStoredGhidraLabConfig(config) };
  fs.mkdirSync(dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return config;
}

function loadLlmConfig(configFile: string): LLMConfig | null {
  try {
    if (!fs.existsSync(configFile)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { llm?: LLMConfig };
    if (!raw.llm?.model?.trim()) {
      return null;
    }
    return { ...raw.llm, apiKey: raw.llm.apiKey ?? '' };
  } catch {
    return null;
  }
}

function fileExists(path: string): boolean {
  try {
    return Boolean(path) && fs.existsSync(path) && fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

// --- Browse ------------------------------------------------------------------

export function listGhidraDirectory(
  dir: string,
  maxEntries = MAX_BROWSE_ENTRIES,
): { entries: GhidraLabBrowseEntry[]; truncated: boolean } {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: false };
  }
  const entries: GhidraLabBrowseEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const fullPath = join(dir, dirent.name);
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
      analyzable: isGhidraAnalyzableName(dirent.name),
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

export function findGhidraBinariesUnder(
  startDirs: readonly string[],
  needle: string,
  maxDepth: number,
): { entries: GhidraLabBrowseEntry[]; truncated: boolean } {
  const lowered = needle.toLowerCase();
  const entries: GhidraLabBrowseEntry[] = [];
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
      if (!isGhidraAnalyzableName(dirent.name)) {
        continue;
      }
      if (entries.length >= MAX_FIND_MATCHES) {
        return { entries, truncated: true };
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
  config: GhidraLabConfigView,
): { ok: boolean; path: string; rootId: string; reason: string } {
  const first = resolveGhidraPathWithinRoots(requestedPath, config.binaryRoots);
  if (!first.ok) {
    return { ok: false, path: first.path, rootId: '', reason: first.reason };
  }
  let realPath = first.path;
  try {
    realPath = fs.realpathSync(first.path);
  } catch {
    return { ok: false, path: first.path, rootId: '', reason: 'path_not_found' };
  }
  const second = resolveGhidraPathWithinRoots(realPath, config.binaryRoots);
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

export function getGhidraLabRoute(pathname: string): string | null {
  if (pathname === GHIDRA_LAB_API_PREFIX) {
    return '/';
  }
  if (!pathname.startsWith(`${GHIDRA_LAB_API_PREFIX}/`)) {
    return null;
  }
  const route = pathname.slice(GHIDRA_LAB_API_PREFIX.length);
  return route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
}

export interface ResolveGhidraLabRouteParams {
  method: string;
  route: string;
  body: Record<string, unknown>;
  token: string | null;
  openroomHome: string;
  configFile: string;
  serverOrigin: string;
  now: number;
  /** Injected in tests; production uses the process-shared managers. */
  sessions?: GhidraLabSessionManager;
  runs?: GhidraLabRunManager;
  preflight?: (config: GhidraLabConfigView) => GhidraLabPreflightResult;
}

export interface GhidraLabRouteResult {
  status: number;
  payload: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
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

function runsDirFor(openroomHome: string): string {
  return join(openroomHome, 'ghidra-lab', 'runs');
}

interface RunResult {
  ok: boolean;
  code: number | null;
  stderr: string;
  error: string;
}

/**
 * Run one bounded child and resolve when it exits.
 *
 * Asynchronous because this runs inside the dev server's Node process. A
 * spawnSync of `pip install` froze the entire server for the several minutes the
 * install took, and every other request in the app hung behind it -- measured on
 * the first real bootstrap, where it looked exactly like a hang.
 */
function runBounded(
  program: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: RunResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], { env, windowsHide: true, shell: false });
    } catch (error) {
      finish({
        ok: false,
        code: null,
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish({ ok: false, code: null, stderr, error: `timed out after ${BOOTSTRAP_TIMEOUT_MS}ms` });
    }, BOOTSTRAP_TIMEOUT_MS);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk;
      }
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, stderr, error: error.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stderr, error: '' });
    });
  });
}

/**
 * How the bootstrap's two children are launched.
 *
 * Injectable only so the decision tree below -- venv creation failing, a venv
 * that produces no interpreter, pip failing, the success path -- can be tested
 * without running a real pip install over the network. Production passes
 * nothing and gets the bounded spawner above.
 */
export type RunBounded = typeof runBounded;

/**
 * Create the venv and install pyghidra-mcp into it.
 *
 * Operator-initiated and never in Aoi's tool list: it installs software. Two
 * bounded children, both shell:false -- one to create the venv, one to pip
 * install into it. The resulting interpreter path is written back into the config
 * so the preflight and the session manager agree on which Python is meant.
 */
export async function bootstrapPyghidraVenv(
  params: {
    config: GhidraLabConfigView;
    openroomHome: string;
  },
  run: RunBounded = runBounded,
): Promise<{ ok: boolean; pythonExePath: string; detail: string }> {
  const seed = params.config.pythonExePath;
  if (!seed || !fileExists(seed)) {
    return { ok: false, pythonExePath: '', detail: 'Set a working Python interpreter first.' };
  }
  const venvDir = join(params.openroomHome, 'ghidra-lab', 'venv');
  const env = buildGhidraChildEnv(params.config);

  const created = await run(seed, ['-m', 'venv', venvDir], env);
  if (!created.ok) {
    return {
      ok: false,
      pythonExePath: '',
      detail: created.error || created.stderr.slice(0, 500) || 'venv creation failed',
    };
  }
  const venvPython =
    process.platform === 'win32'
      ? join(venvDir, 'Scripts', 'python.exe')
      : join(venvDir, 'bin', 'python');
  if (!fileExists(venvPython)) {
    return {
      ok: false,
      pythonExePath: '',
      detail: `venv produced no interpreter at ${venvPython}`,
    };
  }

  const installed = await run(
    venvPython,
    ['-m', 'pip', 'install', '--upgrade', 'pyghidra-mcp'],
    env,
  );
  if (!installed.ok) {
    return {
      ok: false,
      pythonExePath: venvPython,
      detail: installed.error || installed.stderr.slice(-800) || 'pip install failed',
    };
  }
  return { ok: true, pythonExePath: venvPython, detail: 'pyghidra-mcp installed.' };
}

export async function resolveGhidraLabRoute(
  params: ResolveGhidraLabRouteParams,
): Promise<GhidraLabRouteResult> {
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
  const sessions = params.sessions ?? getSharedGhidraLabSessionManager();
  const config = loadGhidraLabConfig(params.configFile);
  const runPreflight =
    params.preflight ?? ((value: GhidraLabConfigView) => runGhidraLabPreflight(value));

  const runs =
    params.runs ??
    getSharedGhidraLabRunManager(
      {
        query: (sessionId, kind, args) => sessions.query(sessionId, kind, args),
        now: () => Date.now(),
        runCapa: (capaParams) => runCapa(capaParams),
        logError: (message, error) => console.error(`[ghidra-lab] ${message}`, error),
        // Always present, and it re-reads the config on every call.
        //
        // This manager is a process singleton, so a conditional `callModel` set
        // at construction froze the answer to "is a model configured?" for the
        // life of the server: configure one afterwards and reports stayed
        // deterministic forever. Throwing when there is no model is equivalent
        // for the caller -- writeGhidraReport already falls back on any failure.
        callModel: async (prompt: string, maxTokens: number, responseJson: boolean) => {
          const llm = loadLlmConfig(params.configFile);
          if (!llm) {
            throw new Error('no_llm_configured');
          }
          return callAoiMainTextModel(llm, params.serverOrigin, prompt, maxTokens, responseJson);
        },
      },
      runsDirFor(openroomHome),
    );

  prunePendingActions(now);
  sessions.pruneTerminal(TERMINAL_SESSION_RETENTION_MS);
  runs.prune(RUN_RETENTION_MS, now);
  // A request that names a session is activity on it, and has to count as such
  // BEFORE the reaper runs -- otherwise the first query after a long pause reaps
  // the session it was for and then fails on it.
  const namedSession = asString(body.sessionId);
  if (namedSession) {
    sessions.touch(namedSession);
  }
  await sessions.reapIdle(config);

  const capabilityEnabled = (key: string): boolean =>
    gateOrDeny({
      authenticated: true,
      killSwitchState,
      capabilityKey: key,
      irreversible: false,
    }) === null;

  // --- Health / config (operator surface; auth only) -------------------------

  if (method === 'GET' && (route === '/' || route === '/health')) {
    const verdict = runPreflight(config);
    const problems = listGhidraLabConfigProblems(config, 'headless').map(
      (problem) => `${problem.code}: ${problem.detail}`,
    );
    return {
      status: 200,
      payload: {
        ok: true,
        health: {
          configured: verdict.availableModes.length > 0,
          config,
          checks: verdict.checks,
          availableModes: verdict.availableModes,
          ghidraVersion: verdict.ghidraVersion,
          jdkVersion: verdict.jdkVersion,
          jdkMajor: verdict.jdkMajor,
          pyghidraMcpVersion: verdict.pyghidraMcpVersion,
          capaVersion: verdict.capaVersion,
          analysisCapabilityEnabled: capabilityEnabled(GHIDRA_ANALYSIS_CAPABILITY),
          writeCapabilityEnabled: capabilityEnabled(GHIDRA_WRITE_CAPABILITY),
          autoSessionCapabilityEnabled: capabilityEnabled(GHIDRA_AUTO_SESSION_CAPABILITY),
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
      const next = saveGhidraLabConfig(
        params.configFile,
        mergeGhidraLabConfig(config, body.config),
      );
      return { status: 200, payload: { ok: true, config: next } };
    }
    return { status: 405, payload: { ok: false, error: 'method_not_allowed' } };
  }

  if (method === 'POST' && route === '/bootstrap-python') {
    const result = await bootstrapPyghidraVenv({ config, openroomHome });
    if (!result.ok) {
      return {
        status: 200,
        payload: { ok: false, error: 'bootstrap_failed', detail: result.detail },
      };
    }
    const next = saveGhidraLabConfig(
      params.configFile,
      mergeGhidraLabConfig(config, { pythonExePath: result.pythonExePath }),
    );
    return { status: 200, payload: { ok: true, config: next, detail: result.detail } };
  }

  // --- Browse ---------------------------------------------------------------

  if (method === 'GET' && route === '/browse') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: GHIDRA_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    if (config.binaryRoots.length === 0) {
      return { status: 200, payload: { ok: false, error: 'no_binary_roots' } };
    }

    const find = asString(body.find).trim();
    if (find) {
      const depth = Math.min(
        MAX_FIND_DEPTH,
        Math.max(1, asNumber(body.depth) || DEFAULT_FIND_DEPTH),
      );
      const requested = asString(body.path).trim();
      let startDirs = config.binaryRoots.map((root) => root.path);
      if (requested) {
        const target = resolveRealTargetWithinRoots(requested, config);
        if (!target.ok) {
          return { status: 200, payload: { ok: false, error: target.reason } };
        }
        startDirs = [target.path];
      }
      const found = findGhidraBinariesUnder(startDirs, find, depth);
      return {
        status: 200,
        payload: {
          ok: true,
          browse: {
            path: requested,
            rootId: '',
            parentPath: '',
            entries: found.entries,
            truncated: found.truncated,
          },
        },
      };
    }

    const requested = asString(body.path).trim();
    if (!requested) {
      // No path: list the roots themselves, so an operator always has a way in.
      return {
        status: 200,
        payload: {
          ok: true,
          browse: {
            path: '',
            rootId: '',
            parentPath: '',
            entries: config.binaryRoots.map((root) => ({
              name: root.label || root.id,
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
      return { status: 200, payload: { ok: false, error: target.reason } };
    }
    const listing = listGhidraDirectory(target.path);
    const parent = parentOf(target.path);
    const parentInside = parent
      ? resolveGhidraPathWithinRoots(parent, config.binaryRoots).ok
        ? parent
        : ''
      : '';
    return {
      status: 200,
      payload: {
        ok: true,
        browse: {
          path: target.path,
          rootId: target.rootId,
          parentPath: parentInside,
          entries: listing.entries,
          truncated: listing.truncated,
        },
      },
    };
  }

  // --- Sessions -------------------------------------------------------------

  if (method === 'GET' && route === '/sessions') {
    return { status: 200, payload: { ok: true, sessions: sessions.list() } };
  }

  if (method === 'GET' && route === '/session-output') {
    const sessionId = asString(body.sessionId);
    return {
      status: 200,
      payload: {
        ok: true,
        output: sessions.outputTail(sessionId),
        engineTools: sessions.engineToolNames(sessionId),
      },
    };
  }

  if (method === 'POST' && route === '/sessions/preview') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: GHIDRA_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }

    const blockReasons: string[] = [];
    const verdict = runPreflight(config);
    // The preflight IS the gate here. A wrong JDK does not fail the spawn -- it
    // makes Ghidra prompt on a stdin nobody is holding, and the session then
    // sits in 'starting' until the analysis deadline for a reason that was
    // knowable before we started.
    for (const check of verdict.checks) {
      if (!check.ok && check.id !== 'capa' && check.id !== 'python') {
        blockReasons.push(`preflight_${check.id}`);
      }
    }
    if (!verdict.availableModes.includes('headless')) {
      blockReasons.push('headless_mode_unavailable');
    }
    if (sessions.activeCount() >= GHIDRA_LAB_MAX_SESSIONS) {
      blockReasons.push('too_many_sessions');
    }

    const target = resolveRealTargetWithinRoots(asString(body.binaryPath), config);
    let holderSessionId = '';
    if (!target.ok) {
      blockReasons.push(target.reason);
    } else if (!fileExists(target.path)) {
      blockReasons.push('binary_not_found');
    } else {
      const holder = sessions.findByBinary(target.path);
      if (holder) {
        holderSessionId = holder.id;
        blockReasons.push('session_already_open');
      }
    }

    const binaryName = target.path.split(/[\\/]/).pop() ?? '';
    const projectName = deriveGhidraProjectName(binaryName, aoiSyncSha256Hex(target.path));
    const action: GhidraLabPendingAction = {
      kind: 'session_start',
      binaryPath: target.path,
      rootId: target.rootId,
      projectName,
      expiresAt: now + GHIDRA_LAB_APPROVAL_TTL_MS,
    };
    const approvalFingerprint = fingerprintAction(action);
    const targetSummary = `Ghidra headless (pyghidra-mcp): ${target.path || asString(body.binaryPath)}`;

    if (blockReasons.length > 0) {
      return {
        status: 200,
        payload: {
          ok: true,
          preview: {
            allowed: false,
            blockReasons,
            approvalFingerprint: '',
            capability: GHIDRA_ANALYSIS_CAPABILITY,
            targetSummary,
            expiresAt: 0,
            autoApproved: false,
            binaryPath: target.path,
            mode: 'headless',
            write: false,
            program: config.pythonExePath,
            args: [],
            ...(holderSessionId ? { existingSessionId: holderSessionId } : {}),
          },
        },
      };
    }

    pendingActions.set(approvalFingerprint, action);
    recordAoiHostBridgePendingApprovalAtomic(openroomHome, {
      capability: GHIDRA_ANALYSIS_CAPABILITY,
      approvalFingerprint,
      targetSummary,
      now,
      expiresAt: now + GHIDRA_LAB_APPROVAL_TTL_MS,
    });

    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: true,
          blockReasons: [],
          approvalFingerprint,
          capability: GHIDRA_ANALYSIS_CAPABILITY,
          targetSummary,
          expiresAt: action.expiresAt,
          autoApproved: false,
          binaryPath: target.path,
          mode: 'headless',
          write: false,
          program: config.pythonExePath,
          args: [],
        },
      },
    };
  }

  if (method === 'DELETE' && route === '/sessions') {
    const stopped = await sessions.stop(asString(body.sessionId));
    return {
      status: stopped.ok ? 200 : 404,
      payload: stopped.ok ? { ok: true } : { ok: false, error: stopped.reason },
    };
  }

  // --- Query ----------------------------------------------------------------

  if (method === 'POST' && route === '/query') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: GHIDRA_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    const sessionId = asString(body.sessionId);
    const kind = body.kind;
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const outcome = await sessions.query(sessionId, kind, args);
    return {
      status: 200,
      payload: outcome.ok
        ? {
            ok: true,
            query: {
              sessionId,
              kind: outcome.kind,
              mcpTool: outcome.mcpTool,
              rows: outcome.rows,
              rowCount: outcome.rowCount,
              truncated: outcome.truncated,
              elapsedMs: outcome.elapsedMs,
              engineError: '',
            },
          }
        : {
            ok: false,
            error: outcome.reason || 'query_failed',
            detail: outcome.engineError,
          },
    };
  }

  // --- Reports --------------------------------------------------------------

  if (method === 'GET' && route === '/reports') {
    return { status: 200, payload: { ok: true, runs: runs.list() } };
  }

  if (method === 'GET' && route === '/reports/artifact') {
    const runId = asString(body.runId);
    const which = asString(body.artifact) || 'report';
    if (which === 'ledger') {
      const ledger = runs.readLedger(runId);
      return ledger
        ? { status: 200, payload: { ok: true, ledger } }
        : { status: 404, payload: { ok: false, error: 'ledger_not_found' } };
    }
    const report = runs.readReport(runId);
    if (!report) {
      return { status: 404, payload: { ok: false, error: 'report_not_found' } };
    }
    return {
      status: 200,
      payload: {
        ok: true,
        report: report.slice(0, MAX_ARTIFACT_CHARS),
        truncated: report.length > MAX_ARTIFACT_CHARS,
      },
    };
  }

  if (method === 'DELETE' && route === '/reports') {
    const cancelled = runs.cancel(asString(body.runId));
    return {
      status: cancelled ? 200 : 404,
      payload: cancelled ? { ok: true } : { ok: false, error: 'run_not_cancellable' },
    };
  }

  if (method === 'POST' && route === '/reports/preview') {
    const denied = gateOrDeny({
      authenticated,
      killSwitchState,
      capabilityKey: GHIDRA_ANALYSIS_CAPABILITY,
      irreversible: false,
    });
    if (denied) {
      return denied;
    }
    const sessionId = asString(body.sessionId);
    const session = sessions.get(sessionId);
    const blockReasons: string[] = [];
    if (!session) {
      blockReasons.push('session_not_found');
    } else if (session.state !== 'ready') {
      blockReasons.push(`session_not_ready:${session.state}`);
    }
    if (session && runs.findByBinary(session.binaryPath)) {
      blockReasons.push('run_already_active');
    }

    const binaryPath = session?.binaryPath ?? '';
    const action: GhidraLabPendingAction = {
      kind: 'report_run',
      sessionId,
      binaryPath,
      expiresAt: now + GHIDRA_LAB_APPROVAL_TTL_MS,
    };
    const approvalFingerprint = fingerprintAction(action);
    const targetSummary = `Full sweep + report: ${session?.binaryName || binaryPath || sessionId}`;

    if (blockReasons.length > 0) {
      return {
        status: 200,
        payload: {
          ok: true,
          preview: {
            allowed: false,
            blockReasons,
            approvalFingerprint: '',
            capability: GHIDRA_ANALYSIS_CAPABILITY,
            targetSummary,
            expiresAt: 0,
            autoApproved: false,
          },
        },
      };
    }

    pendingActions.set(approvalFingerprint, action);
    recordAoiHostBridgePendingApprovalAtomic(openroomHome, {
      capability: GHIDRA_ANALYSIS_CAPABILITY,
      approvalFingerprint,
      targetSummary,
      now,
      expiresAt: now + GHIDRA_LAB_APPROVAL_TTL_MS,
    });

    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: true,
          blockReasons: [],
          approvalFingerprint,
          capability: GHIDRA_ANALYSIS_CAPABILITY,
          targetSummary,
          expiresAt: action.expiresAt,
          autoApproved: false,
        },
      },
    };
  }

  // --- Approvals ------------------------------------------------------------

  if (method === 'GET' && route === '/approvals') {
    const store = loadAoiHostBridgeApprovalStore(openroomHome);
    const approvals = store.approvals.filter(
      (approval) =>
        approval.capability === GHIDRA_ANALYSIS_CAPABILITY ||
        approval.capability === GHIDRA_WRITE_CAPABILITY,
    );
    return { status: 200, payload: { ok: true, approvals } };
  }

  if (method === 'POST' && route === '/approvals/run') {
    const approvalFingerprint = asString(body.approvalFingerprint);
    if (!approvalFingerprint) {
      return { status: 400, payload: { ok: false, error: 'missing_fingerprint' } };
    }
    // Establish that this fingerprint is OURS before approving anything.
    //
    // The approval store is shared with the host bridge (spawn, kill, file
    // delete) and with IDA Lab. Approving by fingerprint alone would let a
    // caller here flip a PENDING host-bridge approval to 'approved' -- and the
    // host-bridge execute routes honor an approved entry, so this route could
    // hand itself a process spawn or a file delete no operator ever clicked.
    // The pending-action map is the proof of ownership: it only ever holds
    // previews this module recorded.
    const pending = pendingActions.get(approvalFingerprint);
    if (!pending) {
      return { status: 404, payload: { ok: false, error: 'unknown_or_expired_preview' } };
    }
    const storedEntry = findAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(openroomHome),
      approvalFingerprint,
      now,
    );
    if (storedEntry && storedEntry.capability !== GHIDRA_ANALYSIS_CAPABILITY) {
      return { status: 403, payload: { ok: false, error: 'capability_mismatch' } };
    }
    approveAoiHostBridgeApprovalAtomic(openroomHome, approvalFingerprint, now);
    pendingActions.delete(approvalFingerprint);

    if (pending.kind === 'session_start') {
      // The cap is re-checked at execute time: the preview-to-click window is
      // exactly where a third session could have appeared.
      if (sessions.activeCount() >= GHIDRA_LAB_MAX_SESSIONS) {
        return { status: 200, payload: { ok: false, error: 'too_many_sessions' } };
      }
      const verdict = runPreflight(config);
      if (!verdict.availableModes.includes('headless') || !verdict.pyghidraLaunch) {
        return { status: 200, payload: { ok: false, error: 'headless_mode_unavailable' } };
      }
      const started = await sessions.startHeadless({
        config,
        binaryPath: pending.binaryPath,
        projectName: pending.projectName,
        launch: verdict.pyghidraLaunch,
      });
      if (!started.ok || !started.session) {
        return {
          status: 200,
          payload: {
            ok: false,
            error: started.reason,
            ...(started.existingSessionId ? { existingSessionId: started.existingSessionId } : {}),
          },
        };
      }
      if (started.session.pid) {
        recordAoiHostSpawnedProcess(
          openroomHome,
          { pid: started.session.pid, imageName: 'pyghidra-mcp' },
          now,
        );
      }
      return { status: 200, payload: { ok: true, session: started.session } };
    }

    const session = sessions.get(pending.sessionId);
    if (!session || session.state !== 'ready') {
      return { status: 200, payload: { ok: false, error: 'session_not_ready' } };
    }
    const started = runs.start({
      sessionId: pending.sessionId,
      binaryPath: session.binaryPath,
      binaryName: session.binaryName,
      config,
    });
    return {
      status: 200,
      payload: started.ok
        ? { ok: true, runId: started.runId }
        : { ok: false, error: started.reason, runId: started.runId },
    };
  }

  return { status: 404, payload: { ok: false, error: 'unknown_route' } };
}

// --- Mount -------------------------------------------------------------------

export interface GhidraLabPluginOptions {
  sessionsDir: string;
  openroomHome: string;
  configFile: string;
  /**
   * Accept a loopback caller without a header token, filling it in server-side.
   * The dev mount sets this so the browser never holds the secret.
   */
  trustLoopbackToken?: boolean;
}

export type GhidraLabMiddleware = (
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

function getRequestOrigin(req: IncomingMessage): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').trim();
  const host = String(req.headers.host ?? '').trim() || '127.0.0.1:3000';
  return `${forwardedProto || 'http'}://${host}`;
}

export function createGhidraLabMiddleware(options: GhidraLabPluginOptions): GhidraLabMiddleware {
  const sessionsDir = resolve(options.sessionsDir);
  const openroomHome = resolve(options.openroomHome || resolve(sessionsDir, '..'));
  const configFile = resolve(options.configFile);
  return (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = getGhidraLabRoute(url.pathname);
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
      const result = await resolveGhidraLabRoute({
        method,
        route,
        body,
        token,
        openroomHome,
        configFile,
        serverOrigin: getRequestOrigin(req),
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

export function ghidraLabPlugin(options: GhidraLabPluginOptions): Plugin {
  const middleware = createGhidraLabMiddleware({ ...options, trustLoopbackToken: true });
  return {
    name: 'ghidra-lab',
    configureServer(server) {
      server.middlewares.use(middleware);
      // Reclaim the JVMs when the dev server goes away.
      //
      // A pyghidra-mcp child is a Ghidra JVM holding a multi-gigabyte heap and a
      // port, and it never exits on its own. Without this, every dev-server
      // restart -- which HMR does on its own -- leaves one running with nothing
      // able to reach it, and the next start finds its port taken. Observed on a
      // real run before this hook existed.
      const reclaim = (): void => {
        try {
          getSharedGhidraLabSessionManager().killAllChildren();
        } catch {
          // Shutdown is not a place to throw.
        }
      };
      server.httpServer?.once('close', reclaim);
      // 'exit' only allows synchronous work, which kill() is.
      process.once('exit', reclaim);
    },
  };
}

export { resolvePyghidraScriptPath };
