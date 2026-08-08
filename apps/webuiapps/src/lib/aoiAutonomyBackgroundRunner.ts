import type { LLMConfig } from './llmModels';
import type { AoiAutonomyPolicy, AoiAutonomyWakeupResult } from './aoiAutonomyTypes';
import { listAoiAutonomySessionPaths, loadAoiAutonomyPolicy } from './aoiAutonomyStore';
import { runAoiAutonomyWakeup, type AoiAutonomyWakeupInput } from './aoiAutonomyScheduler';
import { loadAoiAutonomyCapabilitySettings } from './aoiAutonomyCapabilitySettings';

// Guard rails so a misconfiguration cannot hammer the loop or fan out forever.
const MIN_BACKGROUND_INTERVAL_MS = 30_000;
const DEFAULT_BACKGROUND_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_SESSIONS_PER_CYCLE = 16;
// The canonical non-voice runtime scorecard requires the complete daemon cycle
// to finish within 60 seconds. Keep the background wakeup below that boundary
// and reserve explicit headroom for source persistence, scout bookkeeping, and
// cycle accounting after the model-facing tick returns.
const DEFAULT_MAX_CYCLE_RUNTIME_MS = 55_000;
const DEFAULT_MAX_BACKGROUND_TICK_RUNTIME_MS = 45_000;
const MIN_SCHEDULER_HEADROOM_MS = 10_000;

export interface AoiAutonomyBackgroundCycleOptions {
  sessionsDir: string;
  configFile: string;
  workspaceRoot?: string;
  // Deployment ceiling for network "thinking" (tri-state): undefined = no ceiling
  // (the per-session policy.allowNetwork decides), false = hard-disabled regardless
  // of policy, true = permitted (policy decides). The actual per-session switch is
  // policy.allowNetwork; this only caps it.
  allowNetworkCeiling?: boolean;
  // Rolling daily LLM token ceiling threaded to each wakeup (P1a c2). Undefined
  // -> the scheduler applies the enforced finite default; 0 -> unlimited.
  llmDailyTokenBudget?: number;
  // P1a c4: explicit opt-in for LLM goal synthesis, threaded to each wakeup.
  goalSynthesisEnabled?: boolean;
  // P3-1: rolling daily network-call ceiling for the auto scout, threaded to each
  // wakeup. Undefined -> the scheduler applies the enforced finite default; 0 -> unlimited.
  scoutNetworkDailyBudget?: number;
  // P3-2a: rolling daily direct-chat offer ceiling for the auto trend advisor, threaded to
  // each wakeup. Undefined -> the scheduler applies the enforced finite default; 0 -> unlimited.
  directChatDailyBudget?: number;
  // P3-2b: explicit opt-in for the user-return lull confidence-floor relief, threaded to each
  // wakeup. Default/false -> no relief (byte-identical). Only ever applies on the background path.
  idleConfidenceSurgeEnabled?: boolean;
  // Re-read the operator's capability settings at the START of every cycle, so a
  // toggle flipped in the settings UI takes effect on the next tick instead of
  // requiring a restart. Without it the two flags above are frozen at process
  // start, and the safety-relevant direction -- switching something OFF -- fails
  // silently on an always-on daemon. Absent -> the static values above are used,
  // which is what the env-only callers and tests rely on.
  resolveCapabilities?: () => { goalSynthesis: boolean; idleConfidenceSurge: boolean };
  llmConfig?: LLMConfig | null;
  // Lazily resolve the main LLM config (e.g. from the config file) each cycle.
  // Without this the background loop runs deterministic-only (no LLM reasoning).
  loadLlmConfig?: () => LLMConfig | null;
  now?: number;
  maxSessionsPerCycle?: number;
  maxCycleRuntimeMs?: number;
  maxBackgroundTickRuntimeMs?: number;
  // Injectable seams for tests.
  listSessions?: (sessionsDir: string) => string[];
  loadPolicy?: (sessionsDir: string, sessionPath: string) => AoiAutonomyPolicy;
  runWakeup?: (input: AoiAutonomyWakeupInput) => Promise<AoiAutonomyWakeupResult>;
}

export interface AoiAutonomyBackgroundCycleResult {
  startedAt: number;
  durationMs: number;
  sessionsConsidered: number;
  sessionsRun: string[];
  sessionsSkipped: Array<{ sessionPath: string; reason: string }>;
  errors: Array<{ sessionPath: string; error: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wakeupFailureMessage(result: AoiAutonomyWakeupResult): string {
  const warning = result.record?.warnings.find((value) => value.trim().length > 0);
  return warning
    ? `wakeup_failed:${warning}`
    : `wakeup_failed:${result.record?.status ?? 'failed'}`;
}

// Run one full background sweep: discover sessions with an initialized autonomy
// store and, for each enabled session, fire a self-initiated
// 'scheduled_background' wakeup. Per-session failures are isolated so one bad
// session cannot stall the sweep. The scheduler enforces wakeup cooldowns
// internally, so frequent cycles are naturally throttled (no extra work runs
// before a session's cooldown elapses).
export async function runAoiAutonomyBackgroundCycle(
  options: AoiAutonomyBackgroundCycleOptions,
): Promise<AoiAutonomyBackgroundCycleResult> {
  const startedAt = options.now ?? Date.now();
  const currentTime = (): number => options.now ?? Date.now();
  const listSessions = options.listSessions ?? listAoiAutonomySessionPaths;
  const loadPolicy = options.loadPolicy ?? loadAoiAutonomyPolicy;
  const runWakeup = options.runWakeup ?? runAoiAutonomyWakeup;
  const maxSessions = Math.max(1, options.maxSessionsPerCycle ?? DEFAULT_MAX_SESSIONS_PER_CYCLE);
  const maxCycleRuntimeMs = Math.max(1, options.maxCycleRuntimeMs ?? DEFAULT_MAX_CYCLE_RUNTIME_MS);
  const maxBackgroundTickRuntimeMs = Math.max(
    0,
    options.maxBackgroundTickRuntimeMs ?? DEFAULT_MAX_BACKGROUND_TICK_RUNTIME_MS,
  );
  // The env ceiling only CAPS network access; the per-session policy.allowNetwork is
  // the actual switch. undefined/true ceiling -> policy decides; false -> hard off.
  const ceilingPermitsNetwork = options.allowNetworkCeiling !== false;
  // Resolve the main LLM config once per cycle (shared across sessions). This is
  // what actually puts the model in the loop for self-initiated reasoning when a
  // session enables network; skip the resolve entirely if the ceiling forbids it.
  const llmConfig = ceilingPermitsNetwork
    ? (options.llmConfig ?? options.loadLlmConfig?.() ?? null)
    : null;
  // Live capability settings win over the values captured at start(), so a toggle
  // in the settings UI applies on the next tick rather than at the next restart.
  // A resolver failure keeps the startup values -- it must never fall OPEN, since
  // these enable LLM egress and louder interruption.
  let goalSynthesisEnabled = options.goalSynthesisEnabled;
  let idleConfidenceSurgeEnabled = options.idleConfidenceSurgeEnabled;
  if (options.resolveCapabilities) {
    try {
      const live = options.resolveCapabilities();
      goalSynthesisEnabled = live.goalSynthesis;
      idleConfidenceSurgeEnabled = live.idleConfidenceSurge;
    } catch {
      // Keep the startup values.
    }
  }
  const result: AoiAutonomyBackgroundCycleResult = {
    startedAt,
    durationMs: 0,
    sessionsConsidered: 0,
    sessionsRun: [],
    sessionsSkipped: [],
    errors: [],
  };

  let sessionPaths: string[];
  try {
    sessionPaths = listSessions(options.sessionsDir);
  } catch (error) {
    result.errors.push({ sessionPath: '*', error: errorMessage(error) });
    result.durationMs = Math.max(0, currentTime() - startedAt);
    return result;
  }
  result.sessionsConsidered = sessionPaths.length;

  let attempted = 0;
  for (const sessionPath of sessionPaths) {
    if (attempted >= maxSessions) {
      result.sessionsSkipped.push({ sessionPath, reason: 'max_sessions_per_cycle' });
      continue;
    }
    const remainingCycleMs = maxCycleRuntimeMs - Math.max(0, currentTime() - startedAt);
    if (remainingCycleMs <= MIN_SCHEDULER_HEADROOM_MS) {
      result.sessionsSkipped.push({ sessionPath, reason: 'cycle_runtime_budget_exhausted' });
      continue;
    }
    let policy: AoiAutonomyPolicy;
    try {
      policy = loadPolicy(options.sessionsDir, sessionPath);
    } catch (error) {
      result.errors.push({ sessionPath, error: errorMessage(error) });
      continue;
    }
    if (!policy.enabled) {
      result.sessionsSkipped.push({ sessionPath, reason: 'policy_disabled' });
      continue;
    }
    attempted += 1;
    const schedulerRuntimeMs = Math.max(1, Math.min(maxCycleRuntimeMs, remainingCycleMs));
    const tickRuntimeMs = Math.max(
      0,
      Math.min(maxBackgroundTickRuntimeMs, schedulerRuntimeMs - MIN_SCHEDULER_HEADROOM_MS),
    );
    try {
      const wakeupResult = await runWakeup({
        sessionsDir: options.sessionsDir,
        sessionPath,
        reason: 'scheduled_background',
        configFile: options.configFile,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        // The LLM only participates when network is allowed (see llmConfig
        // resolution above); otherwise the wakeup runs the deterministic loop.
        llmConfig,
        budget: {
          maxSchedulerRuntimeMs: schedulerRuntimeMs,
          maxBackgroundTickRuntimeMs: tickRuntimeMs,
          // Effective network = the deployment ceiling AND the per-session policy
          // switch (operator-controlled via the settings UI).
          allowNetwork: ceilingPermitsNetwork && policy.allowNetwork === true,
          ...(typeof options.llmDailyTokenBudget === 'number'
            ? { llmDailyTokenBudget: options.llmDailyTokenBudget }
            : {}),
          ...(typeof goalSynthesisEnabled === 'boolean' ? { goalSynthesisEnabled } : {}),
          ...(typeof options.scoutNetworkDailyBudget === 'number'
            ? { scoutNetworkDailyBudget: options.scoutNetworkDailyBudget }
            : {}),
          ...(typeof options.directChatDailyBudget === 'number'
            ? { directChatDailyBudget: options.directChatDailyBudget }
            : {}),
          ...(typeof idleConfidenceSurgeEnabled === 'boolean'
            ? { idleConfidenceSurgeEnabled }
            : {}),
        },
        // A fixed clock is only a test seam. Passing the real cycle start as a
        // fixed `now` made production wakeups report durationMs=0 regardless of
        // actual latency and hid slow scheduler work from the operator ledger.
        ...(typeof options.now === 'number' ? { now: options.now } : {}),
      });
      if (!wakeupResult.ok) {
        result.errors.push({ sessionPath, error: wakeupFailureMessage(wakeupResult) });
        continue;
      }
      result.sessionsRun.push(sessionPath);
    } catch (error) {
      result.errors.push({ sessionPath, error: errorMessage(error) });
    }
  }

  result.durationMs = Math.max(0, currentTime() - startedAt);
  return result;
}

export interface AoiAutonomyBackgroundRunnerHandle {
  // Stops the timer and resolves once the in-flight cycle has drained. Awaiting
  // it matters to whoever holds the single-instance lock: a cycle mid-await is
  // still mutating the session store, so releasing the lock before this settles
  // hands the dir to the next process while this one is still writing.
  stop: () => Promise<void>;
}

export interface AoiAutonomyBackgroundRunnerOptions extends AoiAutonomyBackgroundCycleOptions {
  intervalMs: number;
  runImmediately?: boolean;
  onCycle?: (result: AoiAutonomyBackgroundCycleResult) => void;
  onError?: (error: unknown) => void;
  // Ran after every cycle, INSIDE the in-flight guard, so whatever it does is
  // serialized against the cycle it follows. This is how the loop host performs
  // store-wide memory maintenance: it holds the single-instance lock, so no
  // other process may touch the memory files, and a plain timer here could
  // interleave with a cycle mid-await.
  afterCycle?: () => Promise<void> | void;
}

// Start the self-initiating background loop. Overlapping cycles are prevented
// by an in-flight guard. The timer is unref'd so it never keeps the host
// process alive on its own. Returns a stop() handle for clean shutdown.
export function startAoiAutonomyBackgroundRunner(
  options: AoiAutonomyBackgroundRunnerOptions,
): AoiAutonomyBackgroundRunnerHandle {
  const intervalMs = Math.max(MIN_BACKGROUND_INTERVAL_MS, options.intervalMs);
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      try {
        const result = await runAoiAutonomyBackgroundCycle(options);
        options.onCycle?.(result);
      } finally {
        // afterCycle carries the store-wide memory maintenance this process is
        // responsible for while it holds the single-instance lock. It must not
        // depend on the cycle (or an onCycle observer) having succeeded -- a
        // throwing cycle would otherwise stop maintenance for as long as it
        // keeps throwing, with nothing else allowed to pick it up.
        await options.afterCycle?.();
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const startTick = (): void => {
    inFlight = tick();
  };

  const handle = setInterval(startTick, intervalMs);
  (handle as unknown as { unref?: () => void }).unref?.();

  if (options.runImmediately) {
    startTick();
  }

  return {
    stop: async () => {
      stopped = true;
      clearInterval(handle);
      await inFlight;
    },
  };
}

export interface AoiAutonomyBackgroundEnvConfig {
  enabled: boolean;
  intervalMs: number;
  maxCycleRuntimeMs: number;
  maxBackgroundTickRuntimeMs: number;
  // Tri-state deployment ceiling for network "thinking": undefined when the env var
  // is unset (no ceiling -> the settings UI / policy.allowNetwork decides), false =
  // hard-disabled, true = permitted. The actual switch is per-session policy.allowNetwork.
  allowNetworkCeiling: boolean | undefined;
  maxSessionsPerCycle: number;
  // Rolling daily LLM token ceiling for brief synthesis. Undefined when unset ->
  // the scheduler applies the enforced finite default; 0 -> unlimited.
  llmDailyTokenBudget?: number;
  // P1a c4: explicit opt-in for LLM goal synthesis (on top of allowNetwork).
  goalSynthesisEnabled: boolean;
  // P3-1: rolling daily network-call ceiling for the auto scout. Undefined when unset ->
  // the scheduler applies the enforced finite default; 0 -> unlimited.
  scoutNetworkDailyBudget?: number;
  // P3-2a: rolling daily direct-chat offer ceiling for the auto trend advisor. Undefined when
  // unset -> the scheduler applies the enforced finite default; 0 -> unlimited.
  directChatDailyBudget?: number;
  // P3-2b: explicit opt-in for the user-return lull confidence-floor relief on the auto trend
  // advisor (on top of allowNetwork + the background path). Default false.
  idleConfidenceSurgeEnabled: boolean;
}

function parseBoolEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

// Tri-state parse for a ceiling flag: undefined when unset/empty (no ceiling -> the
// settings UI decides), else the boolean. Distinguishes "unset" (permit, UI decides)
// from an explicit "0" (hard-disable), which parseBoolEnv cannot.
function parseBoolEnvTristate(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value === '1' || value === 'true' || value === 'yes';
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Like parseIntEnv but accepts an explicit 0 (= unlimited) and returns undefined
// when unset/invalid so the scheduler can apply the enforced finite default.
function parseTokenBudgetEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// Background autonomy is OFF by default. Operators opt in via env so the loop
// never self-activates without explicit intent (safety-first posture). Network
// access (LLM reflection + proactive scout) is a separate, also-opt-in flag.
// goalSynthesis and idleConfidenceSurge are capability enablement, so the
// settings UI owns them (config.json: aoiAutonomyCapabilities) with the env vars
// as the headless fallback. configFile is optional so every existing caller and
// test keeps resolving from env alone. Everything else here -- the intervals,
// budgets, and the tri-state network ceiling -- stays env: they are deployment
// bounds, not capabilities.
export function resolveAoiAutonomyBackgroundConfigFromEnv(
  env: Record<string, string | undefined>,
  configFile?: string,
): AoiAutonomyBackgroundEnvConfig {
  const capabilities = loadAoiAutonomyCapabilitySettings({
    ...(configFile ? { configFile } : {}),
    env,
  });
  return {
    enabled: parseBoolEnv(env.AOI_AUTONOMY_BACKGROUND),
    intervalMs: parseIntEnv(
      env.AOI_AUTONOMY_BACKGROUND_INTERVAL_MS,
      DEFAULT_BACKGROUND_INTERVAL_MS,
    ),
    maxCycleRuntimeMs: parseIntEnv(
      env.AOI_AUTONOMY_BACKGROUND_MAX_CYCLE_RUNTIME_MS,
      DEFAULT_MAX_CYCLE_RUNTIME_MS,
    ),
    maxBackgroundTickRuntimeMs: parseIntEnv(
      env.AOI_AUTONOMY_BACKGROUND_MAX_TICK_RUNTIME_MS,
      DEFAULT_MAX_BACKGROUND_TICK_RUNTIME_MS,
    ),
    allowNetworkCeiling: parseBoolEnvTristate(env.AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK),
    maxSessionsPerCycle: parseIntEnv(
      env.AOI_AUTONOMY_BACKGROUND_MAX_SESSIONS,
      DEFAULT_MAX_SESSIONS_PER_CYCLE,
    ),
    llmDailyTokenBudget: parseTokenBudgetEnv(env.AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET),
    goalSynthesisEnabled: capabilities.goalSynthesis,
    scoutNetworkDailyBudget: parseTokenBudgetEnv(env.AOI_AUTONOMY_SCOUT_NETWORK_DAILY_BUDGET),
    directChatDailyBudget: parseTokenBudgetEnv(env.AOI_AUTONOMY_DIRECT_CHAT_DAILY_BUDGET),
    idleConfidenceSurgeEnabled: capabilities.idleConfidenceSurge,
  };
}
