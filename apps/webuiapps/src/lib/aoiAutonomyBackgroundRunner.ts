import type { LLMConfig } from './llmModels';
import type { AoiAutonomyPolicy, AoiAutonomyWakeupResult } from './aoiAutonomyTypes';
import { listAoiAutonomySessionPaths, loadAoiAutonomyPolicy } from './aoiAutonomyStore';
import { runAoiAutonomyWakeup, type AoiAutonomyWakeupInput } from './aoiAutonomyScheduler';

// Guard rails so a misconfiguration cannot hammer the loop or fan out forever.
const MIN_BACKGROUND_INTERVAL_MS = 30_000;
const DEFAULT_BACKGROUND_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_SESSIONS_PER_CYCLE = 16;

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
  llmConfig?: LLMConfig | null;
  // Lazily resolve the main LLM config (e.g. from the config file) each cycle.
  // Without this the background loop runs deterministic-only (no LLM reasoning).
  loadLlmConfig?: () => LLMConfig | null;
  now?: number;
  maxSessionsPerCycle?: number;
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
  const listSessions = options.listSessions ?? listAoiAutonomySessionPaths;
  const loadPolicy = options.loadPolicy ?? loadAoiAutonomyPolicy;
  const runWakeup = options.runWakeup ?? runAoiAutonomyWakeup;
  const maxSessions = Math.max(1, options.maxSessionsPerCycle ?? DEFAULT_MAX_SESSIONS_PER_CYCLE);
  // The env ceiling only CAPS network access; the per-session policy.allowNetwork is
  // the actual switch. undefined/true ceiling -> policy decides; false -> hard off.
  const ceilingPermitsNetwork = options.allowNetworkCeiling !== false;
  // Resolve the main LLM config once per cycle (shared across sessions). This is
  // what actually puts the model in the loop for self-initiated reasoning when a
  // session enables network; skip the resolve entirely if the ceiling forbids it.
  const llmConfig = ceilingPermitsNetwork
    ? (options.llmConfig ?? options.loadLlmConfig?.() ?? null)
    : null;
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
    result.durationMs = Math.max(0, (options.now ?? Date.now()) - startedAt);
    return result;
  }
  result.sessionsConsidered = sessionPaths.length;

  let ran = 0;
  for (const sessionPath of sessionPaths) {
    if (ran >= maxSessions) {
      result.sessionsSkipped.push({ sessionPath, reason: 'max_sessions_per_cycle' });
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
    try {
      await runWakeup({
        sessionsDir: options.sessionsDir,
        sessionPath,
        reason: 'scheduled_background',
        configFile: options.configFile,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        // The LLM only participates when network is allowed (see llmConfig
        // resolution above); otherwise the wakeup runs the deterministic loop.
        llmConfig,
        budget: {
          // Effective network = the deployment ceiling AND the per-session policy
          // switch (operator-controlled via the settings UI).
          allowNetwork: ceilingPermitsNetwork && policy.allowNetwork === true,
          ...(typeof options.llmDailyTokenBudget === 'number'
            ? { llmDailyTokenBudget: options.llmDailyTokenBudget }
            : {}),
          ...(typeof options.goalSynthesisEnabled === 'boolean'
            ? { goalSynthesisEnabled: options.goalSynthesisEnabled }
            : {}),
          ...(typeof options.scoutNetworkDailyBudget === 'number'
            ? { scoutNetworkDailyBudget: options.scoutNetworkDailyBudget }
            : {}),
          ...(typeof options.directChatDailyBudget === 'number'
            ? { directChatDailyBudget: options.directChatDailyBudget }
            : {}),
          ...(typeof options.idleConfidenceSurgeEnabled === 'boolean'
            ? { idleConfidenceSurgeEnabled: options.idleConfidenceSurgeEnabled }
            : {}),
        },
        now: startedAt,
      });
      result.sessionsRun.push(sessionPath);
      ran += 1;
    } catch (error) {
      result.errors.push({ sessionPath, error: errorMessage(error) });
    }
  }

  result.durationMs = Math.max(0, (options.now ?? Date.now()) - startedAt);
  return result;
}

export interface AoiAutonomyBackgroundRunnerHandle {
  stop: () => void;
}

export interface AoiAutonomyBackgroundRunnerOptions extends AoiAutonomyBackgroundCycleOptions {
  intervalMs: number;
  runImmediately?: boolean;
  onCycle?: (result: AoiAutonomyBackgroundCycleResult) => void;
  onError?: (error: unknown) => void;
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

  const tick = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const result = await runAoiAutonomyBackgroundCycle(options);
      options.onCycle?.(result);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  (handle as unknown as { unref?: () => void }).unref?.();

  if (options.runImmediately) {
    void tick();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

export interface AoiAutonomyBackgroundEnvConfig {
  enabled: boolean;
  intervalMs: number;
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
export function resolveAoiAutonomyBackgroundConfigFromEnv(
  env: Record<string, string | undefined>,
): AoiAutonomyBackgroundEnvConfig {
  return {
    enabled: parseBoolEnv(env.AOI_AUTONOMY_BACKGROUND),
    intervalMs: parseIntEnv(
      env.AOI_AUTONOMY_BACKGROUND_INTERVAL_MS,
      DEFAULT_BACKGROUND_INTERVAL_MS,
    ),
    allowNetworkCeiling: parseBoolEnvTristate(env.AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK),
    maxSessionsPerCycle: parseIntEnv(
      env.AOI_AUTONOMY_BACKGROUND_MAX_SESSIONS,
      DEFAULT_MAX_SESSIONS_PER_CYCLE,
    ),
    llmDailyTokenBudget: parseTokenBudgetEnv(env.AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET),
    goalSynthesisEnabled: parseBoolEnv(env.AOI_AUTONOMY_GOAL_SYNTHESIS),
    scoutNetworkDailyBudget: parseTokenBudgetEnv(env.AOI_AUTONOMY_SCOUT_NETWORK_DAILY_BUDGET),
    directChatDailyBudget: parseTokenBudgetEnv(env.AOI_AUTONOMY_DIRECT_CHAT_DAILY_BUDGET),
    idleConfidenceSurgeEnabled: parseBoolEnv(env.AOI_AUTONOMY_IDLE_CONFIDENCE_SURGE),
  };
}
