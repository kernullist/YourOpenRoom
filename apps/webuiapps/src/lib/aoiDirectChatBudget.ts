// Aoi per-day direct-chat interruption budget (P3-2a self-initiation).
//
// A rolling per-session ledger that bounds how many proactive DIRECT-CHAT offers Aoi may
// make to the user in a day, so the autonomous trend advisor reaches out behind a real,
// persistent, fail-closed daily cap rather than only the per-SESSION limit (1) plus the
// 6h cooldown. It mirrors aoiScoutNetworkBudget.ts: the budgeted resource here is a COUNT
// of direct-chat offers, not network calls.
//
// CHECK / RECORD are split across two server entry points (unlike the scout-network
// budget, which both checks and records in the scheduler):
//   - CHECK happens in the scheduler on the BACKGROUND path only, around the trend-advisor
//     build: an exhausted budget downgrades the SERVER trend-advisor's direct_chat delivery
//     decision (the would-be direct chat falls through to an inline card instead). A manual
//     run is the user's own request and is exempt.
//   - RECORD happens at the trend-delivery event route when a 'direct_chat_offered' event is
//     reported, because the actual interruption is the offer the client injects, not the
//     scheduler's decision.
//
// Server-only (fs/crypto). check/record are pure so they unit-test without the
// filesystem or a clock.
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const BUDGET_FILE_NAME = 'direct-chat-budget-state.json';

// Enforced finite default: when the autonomous trend advisor can offer direct chats but no
// explicit ceiling is configured, this caps daily direct-chat offers per session. It sits
// just below the existing 6h-cooldown ceiling (~4/day) so it is a genuine cap, not only a
// runaway backstop. Env overrides it; an explicit 0 means unlimited (deliberate opt-out).
export const DEFAULT_DIRECT_CHAT_DAILY_BUDGET = 3;
export const DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AoiDirectChatBudgetState {
  version: 1;
  sessionPath: string;
  windowStartedAt: number;
  windowMs: number;
  offersSpent: number;
  recordCount: number;
}

export interface AoiDirectChatBudgetCheckResult {
  allowed: boolean;
  reason?: string;
  // The window state after rolling for elapsed time. The caller persists this (after
  // recording an offer when one is made) so usage carries across wakeups and sessions.
  rolledState: AoiDirectChatBudgetState;
}

// undefined / invalid -> the enforced finite default. A finite value >= 0 is honored
// as-is, so an explicit 0 disables the ceiling (unlimited).
export function resolveAoiDirectChatCeiling(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return DEFAULT_DIRECT_CHAT_DAILY_BUDGET;
}

function makeFreshState(
  sessionPath: string,
  now: number,
  windowMs: number,
): AoiDirectChatBudgetState {
  return {
    version: 1,
    sessionPath,
    windowStartedAt: now,
    windowMs,
    offersSpent: 0,
    recordCount: 0,
  };
}

// Roll the window if it has elapsed, then decide whether the estimated direct-chat offers
// fit under the ceiling. Pure: the caller owns persistence. Passing estimatedCalls=0 is the
// way to obtain the rolled window without an allow/deny decision (used by the recorder).
export function checkAoiDirectChatBudget(params: {
  state: AoiDirectChatBudgetState | null;
  sessionPath: string;
  now: number;
  windowMs: number;
  ceilingCalls: number;
  estimatedCalls: number;
}): AoiDirectChatBudgetCheckResult {
  const windowMs = params.windowMs > 0 ? params.windowMs : DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS;
  let rolled: AoiDirectChatBudgetState;
  if (!params.state || params.now - params.state.windowStartedAt >= windowMs) {
    rolled = makeFreshState(params.sessionPath, params.now, windowMs);
  } else {
    rolled = { ...params.state, sessionPath: params.sessionPath, windowMs };
  }
  if (params.ceilingCalls <= 0) {
    return { allowed: true, rolledState: rolled };
  }
  const estimate = Math.max(0, Math.trunc(params.estimatedCalls));
  if (rolled.offersSpent + estimate <= params.ceilingCalls) {
    return { allowed: true, rolledState: rolled };
  }
  return { allowed: false, reason: 'direct_chat_daily_budget_exhausted', rolledState: rolled };
}

// Record made direct-chat offers against the (already-rolled) window state.
export function recordAoiDirectChatOffer(
  state: AoiDirectChatBudgetState,
  _now: number,
  offers: number,
): AoiDirectChatBudgetState {
  return {
    ...state,
    offersSpent: state.offersSpent + Math.max(0, Math.trunc(offers)),
    recordCount: state.recordCount + 1,
  };
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export function normalizeAoiDirectChatBudgetState(
  raw: unknown,
  sessionPath: string,
): AoiDirectChatBudgetState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Partial<AoiDirectChatBudgetState>;
  return {
    version: 1,
    sessionPath,
    windowStartedAt: toNonNegativeInt(value.windowStartedAt),
    windowMs:
      typeof value.windowMs === 'number' && Number.isFinite(value.windowMs) && value.windowMs > 0
        ? Math.trunc(value.windowMs)
        : DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
    offersSpent: toNonNegativeInt(value.offersSpent),
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
    throw new Error('Resolved Aoi direct-chat budget path escaped the sessions directory.');
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

export function loadAoiDirectChatBudgetState(
  sessionsDir: string,
  sessionPath: string,
): AoiDirectChatBudgetState | null {
  const resolved = resolveBudgetFile(sessionsDir, sessionPath);
  return normalizeAoiDirectChatBudgetState(
    readJson<unknown>(resolved.filePath),
    resolved.sessionPath,
  );
}

export function saveAoiDirectChatBudgetState(
  sessionsDir: string,
  sessionPath: string,
  state: AoiDirectChatBudgetState,
): AoiDirectChatBudgetState {
  const resolved = resolveBudgetFile(sessionsDir, sessionPath);
  const normalized = normalizeAoiDirectChatBudgetState(state, resolved.sessionPath);
  if (!normalized) {
    throw new Error('Invalid Aoi direct-chat budget state.');
  }
  writeJsonAtomic(resolved.filePath, normalized);
  return normalized;
}
