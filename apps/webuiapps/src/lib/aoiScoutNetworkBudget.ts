// Aoi autonomous-scout network-call budget (P3-1 self-initiation).
//
// A rolling per-session ledger that bounds how many NETWORK (search) calls the
// AUTONOMOUS scout path may make, so the auto scout runs behind a real, persistent,
// fail-closed budget rather than only the run-count heuristics (maxScoutRunsPerDay /
// maxNetworkCallsPerWakeup). It mirrors aoiAutonomyLlmBudget.ts (the LLM token ledger):
// the budgeted resource here is a COUNT of network calls, not tokens. Only the auto
// (background) scout draws from it; a manual run is the user's own request and is exempt.
//
// Server-only (fs/crypto). check/record are pure so they unit-test without the
// filesystem or a clock.
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const BUDGET_FILE_NAME = 'scout-network-budget-state.json';

// Enforced finite default: when the auto scout uses the network but no explicit ceiling
// is configured, this caps daily network calls per session. It sits above normal use
// (maxScoutRunsPerDay 3 x maxNetworkCallsPerWakeup 1 ~= 3/day) as a runaway backstop. Env
// overrides it; an explicit 0 means unlimited (deliberate opt-out).
export const DEFAULT_SCOUT_NETWORK_DAILY_BUDGET = 8;
export const DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AoiScoutNetworkBudgetState {
  version: 1;
  sessionPath: string;
  windowStartedAt: number;
  windowMs: number;
  callsSpent: number;
  recordCount: number;
}

export interface AoiScoutNetworkBudgetCheckResult {
  allowed: boolean;
  reason?: string;
  // The window state after rolling for elapsed time. The caller persists this (after
  // recording spend when calls are made) so usage carries across scout runs.
  rolledState: AoiScoutNetworkBudgetState;
}

// undefined / invalid -> the enforced finite default. A finite value >= 0 is honored
// as-is, so an explicit 0 disables the ceiling (unlimited).
export function resolveAoiScoutNetworkCeiling(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return DEFAULT_SCOUT_NETWORK_DAILY_BUDGET;
}

function makeFreshState(
  sessionPath: string,
  now: number,
  windowMs: number,
): AoiScoutNetworkBudgetState {
  return {
    version: 1,
    sessionPath,
    windowStartedAt: now,
    windowMs,
    callsSpent: 0,
    recordCount: 0,
  };
}

// Roll the window if it has elapsed, then decide whether the estimated network calls fit
// under the ceiling. Pure: the caller owns persistence.
export function checkAoiScoutNetworkBudget(params: {
  state: AoiScoutNetworkBudgetState | null;
  sessionPath: string;
  now: number;
  windowMs: number;
  ceilingCalls: number;
  estimatedCalls: number;
}): AoiScoutNetworkBudgetCheckResult {
  const windowMs = params.windowMs > 0 ? params.windowMs : DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS;
  let rolled: AoiScoutNetworkBudgetState;
  if (!params.state || params.now - params.state.windowStartedAt >= windowMs) {
    rolled = makeFreshState(params.sessionPath, params.now, windowMs);
  } else {
    rolled = { ...params.state, sessionPath: params.sessionPath, windowMs };
  }
  if (params.ceilingCalls <= 0) {
    return { allowed: true, rolledState: rolled };
  }
  const estimate = Math.max(0, Math.trunc(params.estimatedCalls));
  if (rolled.callsSpent + estimate <= params.ceilingCalls) {
    return { allowed: true, rolledState: rolled };
  }
  return { allowed: false, reason: 'scout_network_budget_exhausted', rolledState: rolled };
}

// Record made network calls against the (already-rolled) window state.
export function recordAoiScoutNetworkSpend(
  state: AoiScoutNetworkBudgetState,
  _now: number,
  calls: number,
): AoiScoutNetworkBudgetState {
  return {
    ...state,
    callsSpent: state.callsSpent + Math.max(0, Math.trunc(calls)),
    recordCount: state.recordCount + 1,
  };
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export function normalizeAoiScoutNetworkBudgetState(
  raw: unknown,
  sessionPath: string,
): AoiScoutNetworkBudgetState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Partial<AoiScoutNetworkBudgetState>;
  return {
    version: 1,
    sessionPath,
    windowStartedAt: toNonNegativeInt(value.windowStartedAt),
    windowMs:
      typeof value.windowMs === 'number' && Number.isFinite(value.windowMs) && value.windowMs > 0
        ? Math.trunc(value.windowMs)
        : DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
    callsSpent: toNonNegativeInt(value.callsSpent),
    recordCount: toNonNegativeInt(value.recordCount),
  };
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveBudgetFile(
  sessionsDir: string,
  sessionPath: string,
): { sessionPath: string; filePath: string } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(
    sessionsRoot,
    normalizedSessionPath,
    AUTONOMY_ROOT_DIR,
    BUDGET_FILE_NAME,
  );
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi scout network budget path escaped the sessions directory.');
  }
  return { sessionPath: normalizedSessionPath, filePath };
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function loadAoiScoutNetworkBudgetState(
  sessionsDir: string,
  sessionPath: string,
): AoiScoutNetworkBudgetState | null {
  const resolved = resolveBudgetFile(sessionsDir, sessionPath);
  return normalizeAoiScoutNetworkBudgetState(
    readJson<unknown>(resolved.filePath),
    resolved.sessionPath,
  );
}

export function saveAoiScoutNetworkBudgetState(
  sessionsDir: string,
  sessionPath: string,
  state: AoiScoutNetworkBudgetState,
): AoiScoutNetworkBudgetState {
  const resolved = resolveBudgetFile(sessionsDir, sessionPath);
  const normalized = normalizeAoiScoutNetworkBudgetState(state, resolved.sessionPath);
  if (!normalized) {
    throw new Error('Invalid Aoi scout network budget state.');
  }
  writeJsonAtomic(resolved.filePath, normalized);
  return normalized;
}
