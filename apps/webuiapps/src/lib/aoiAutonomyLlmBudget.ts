// Aoi autonomy LLM token budget (P1a continuous reasoning, commit 2).
//
// A rolling per-session token ledger that bounds how much the auto path may
// spend on LLM brief synthesis, so the model runs behind a real token budget
// rather than just the binary allowNetwork flag. The ledger uses an ESTIMATE
// (chars / 4) because the reflection chat response exposes no usage; widening
// the shared llmClient response to carry real usage is a deferred follow-up.
//
// Server-only (fs/crypto). The check/estimate/record helpers are pure so they
// are unit-testable without the filesystem or a clock.
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const BUDGET_FILE_NAME = 'llm-budget-state.json';

// Enforced finite default: when the LLM runs (allowNetwork on) but no explicit
// ceiling is configured, this bounds daily spend per session. Env overrides it;
// an explicit 0 means unlimited (deliberate opt-out).
export const DEFAULT_LLM_DAILY_TOKEN_BUDGET = 200_000;
export const DEFAULT_LLM_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

// P3.4 tiered budgets: two sub-tiers UNDER the rolling daily ceiling, so no single call
// and no runaway call VOLUME can consume the day at once (the daily token ceiling alone
// misses many-tiny-calls). Both are generous -- a normal auto-path call is ~a few thousand
// tokens and a tick makes at most a handful of calls (the P3.1 loop is step-capped at 4) --
// so realistic operation never trips them; they bound only the pathological tail. An
// explicit unlimited daily opt-out (ceilingTokens<=0) disables these too.
export const AOI_LLM_PER_CALL_TOKEN_CEILING = 48_000;
export const AOI_LLM_MAX_CALLS_PER_WINDOW = 480;

export interface AoiLlmBudgetState {
  version: 1;
  sessionPath: string;
  windowStartedAt: number;
  windowMs: number;
  tokensSpent: number;
  callCount: number;
}

export interface AoiLlmBudgetCheckResult {
  allowed: boolean;
  reason?: string;
  // The window state after rolling for elapsed time. The caller persists this
  // (after recording spend when a call is made) so usage carries across ticks.
  rolledState: AoiLlmBudgetState;
}

// Rough token estimate. The model/tokenizer is unknown here and varies by
// provider, so a conservative chars/4 heuristic is used uniformly.
export function estimateAoiLlmTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

// undefined / invalid -> the enforced finite default. A finite value >= 0 is
// honored as-is, so an explicit 0 disables the ceiling (unlimited).
export function resolveAoiLlmTokenCeiling(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return DEFAULT_LLM_DAILY_TOKEN_BUDGET;
}

function makeFreshState(sessionPath: string, now: number, windowMs: number): AoiLlmBudgetState {
  return {
    version: 1,
    sessionPath,
    windowStartedAt: now,
    windowMs,
    tokensSpent: 0,
    callCount: 0,
  };
}

// Roll the window if it has elapsed, then decide whether the estimated spend
// fits under the ceiling. Pure: the caller owns persistence.
export function checkAoiLlmBudget(params: {
  state: AoiLlmBudgetState | null;
  sessionPath: string;
  now: number;
  windowMs: number;
  ceilingTokens: number;
  estimatedTokens: number;
  // P3.4: optional per-CALL token tier -- a single call whose estimate exceeds this is
  // rejected regardless of remaining daily budget. Absent/<=0 -> not enforced.
  perCallCeilingTokens?: number;
  // P3.4: optional per-WINDOW call-count tier -- once the rolling window has made this many
  // calls, further calls are rejected even if tokens remain. Absent/<=0 -> not enforced.
  maxCallsPerWindow?: number;
}): AoiLlmBudgetCheckResult {
  const windowMs = params.windowMs > 0 ? params.windowMs : DEFAULT_LLM_BUDGET_WINDOW_MS;
  let rolled: AoiLlmBudgetState;
  if (!params.state || params.now - params.state.windowStartedAt >= windowMs) {
    rolled = makeFreshState(params.sessionPath, params.now, windowMs);
  } else {
    rolled = { ...params.state, sessionPath: params.sessionPath, windowMs };
  }
  if (params.ceilingTokens <= 0) {
    // Explicit unlimited opt-out disables ALL tiers (deliberate).
    return { allowed: true, rolledState: rolled };
  }
  const estimate = Math.max(0, params.estimatedTokens);
  // P3.4 per-call tier: fail-closed on a single oversized call.
  if (
    typeof params.perCallCeilingTokens === 'number' &&
    params.perCallCeilingTokens > 0 &&
    estimate > params.perCallCeilingTokens
  ) {
    return {
      allowed: false,
      reason: 'llm_token_budget_per_call_exceeded',
      rolledState: rolled,
    };
  }
  // P3.4 per-window call-count tier: fail-closed on runaway call volume.
  if (
    typeof params.maxCallsPerWindow === 'number' &&
    params.maxCallsPerWindow > 0 &&
    rolled.callCount >= params.maxCallsPerWindow
  ) {
    return {
      allowed: false,
      reason: 'llm_token_budget_call_count_exceeded',
      rolledState: rolled,
    };
  }
  if (rolled.tokensSpent + estimate <= params.ceilingTokens) {
    return { allowed: true, rolledState: rolled };
  }
  return { allowed: false, reason: 'llm_token_budget_exhausted', rolledState: rolled };
}

// Record a made call against the (already-rolled) window state.
export function recordAoiLlmSpend(
  state: AoiLlmBudgetState,
  _now: number,
  tokens: number,
): AoiLlmBudgetState {
  return {
    ...state,
    tokensSpent: state.tokensSpent + Math.max(0, Math.trunc(tokens)),
    callCount: state.callCount + 1,
  };
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export function normalizeAoiLlmBudgetState(
  raw: unknown,
  sessionPath: string,
): AoiLlmBudgetState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Partial<AoiLlmBudgetState>;
  return {
    version: 1,
    sessionPath,
    windowStartedAt: toNonNegativeInt(value.windowStartedAt),
    windowMs:
      typeof value.windowMs === 'number' && Number.isFinite(value.windowMs) && value.windowMs > 0
        ? Math.trunc(value.windowMs)
        : DEFAULT_LLM_BUDGET_WINDOW_MS,
    tokensSpent: toNonNegativeInt(value.tokensSpent),
    callCount: toNonNegativeInt(value.callCount),
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
    throw new Error('Resolved Aoi LLM budget path escaped the sessions directory.');
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

export function loadAoiLlmBudgetState(
  sessionsDir: string,
  sessionPath: string,
): AoiLlmBudgetState | null {
  const resolved = resolveBudgetFile(sessionsDir, sessionPath);
  return normalizeAoiLlmBudgetState(readJson<unknown>(resolved.filePath), resolved.sessionPath);
}

export function saveAoiLlmBudgetState(
  sessionsDir: string,
  sessionPath: string,
  state: AoiLlmBudgetState,
): AoiLlmBudgetState {
  const resolved = resolveBudgetFile(sessionsDir, sessionPath);
  const normalized = normalizeAoiLlmBudgetState(state, resolved.sessionPath);
  if (!normalized) {
    throw new Error('Invalid Aoi LLM budget state.');
  }
  writeJsonAtomic(resolved.filePath, normalized);
  return normalized;
}
