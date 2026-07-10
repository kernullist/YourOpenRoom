import type { AoiAutonomyBackgroundCycleResult } from './aoiAutonomyBackgroundRunner';

// Health / observability tracker for the standalone autonomy daemon.
//
// It lets an operator -- or a process supervisor's readiness probe -- tell a
// healthy, actively-ticking loop from a wedged or idle one, and (critically)
// distinguishes "the loop is running" from "the loop actually processed an
// enabled session this cycle". A running loop whose every session is
// policy-disabled is a safe idle no-op, NOT active cognition, and the honest
// health signal must say so.
//
// Pure + injectable clock (every time value is passed in), so it is fully
// unit-testable and never reads Date.now itself.

export interface AoiDaemonHealthCycleSummary {
  // Wall-clock the cycle started (from the cycle result, already injected).
  startedAt: number;
  durationMs: number;
  sessionsConsidered: number;
  sessionsRun: number;
  sessionsSkipped: number;
  errorCount: number;
}

export interface AoiDaemonHealthSnapshot {
  status: 'ok';
  uptimeMs: number;
  // The env-gated background loop is running in this process.
  loopRunning: boolean;
  // loopRunning AND the most recent cycle processed >= 1 enabled session. This
  // is the honest "is Aoi actually thinking?" signal (see the module header).
  cognitionActive: boolean;
  cyclesCompleted: number;
  lastCycle: AoiDaemonHealthCycleSummary | null;
  errorsTotal: number;
  lastError: { at: number; message: string } | null;
}

export interface AoiDaemonHealthTracker {
  recordCycle: (result: AoiAutonomyBackgroundCycleResult) => void;
  recordError: (error: unknown, at: number) => void;
  snapshot: (now: number) => AoiDaemonHealthSnapshot;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// startedAt: daemon boot time. loopRunning is a thunk so the daemon can create
// the tracker before it knows whether the (post-listen) loop actually started,
// avoiding a boot-ordering dance -- the thunk is evaluated only at snapshot time.
export function createAoiDaemonHealthTracker(params: {
  startedAt: number;
  loopRunning: () => boolean;
}): AoiDaemonHealthTracker {
  const startedAt = params.startedAt;
  const isLoopRunning = params.loopRunning;
  let cyclesCompleted = 0;
  let lastCycle: AoiDaemonHealthCycleSummary | null = null;
  let errorsTotal = 0;
  let lastError: { at: number; message: string } | null = null;

  return {
    recordCycle: (result) => {
      cyclesCompleted += 1;
      lastCycle = {
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        sessionsConsidered: result.sessionsConsidered,
        sessionsRun: result.sessionsRun.length,
        sessionsSkipped: result.sessionsSkipped.length,
        errorCount: result.errors.length,
      };
      // Per-session errors reported by a cycle also count toward the total, so a
      // loop that keeps throwing on one session stays visible (not silent).
      if (result.errors.length > 0) {
        errorsTotal += result.errors.length;
        const last = result.errors[result.errors.length - 1];
        lastError = { at: result.startedAt, message: `${last.sessionPath}: ${last.error}` };
      }
    },
    recordError: (error, at) => {
      errorsTotal += 1;
      lastError = { at, message: toMessage(error) };
    },
    snapshot: (now) => {
      const loopRunning = isLoopRunning();
      return {
        status: 'ok',
        uptimeMs: Math.max(0, now - startedAt),
        loopRunning,
        cognitionActive: loopRunning && (lastCycle?.sessionsRun ?? 0) > 0,
        cyclesCompleted,
        lastCycle,
        errorsTotal,
        lastError,
      };
    },
  };
}

// One concise ASCII log line per background cycle (operational telemetry for the
// headless daemon). Pure so it is unit-testable.
export function formatAoiDaemonCycleLogLine(result: AoiAutonomyBackgroundCycleResult): string {
  return (
    `cycle: considered=${result.sessionsConsidered} run=${result.sessionsRun.length} ` +
    `skipped=${result.sessionsSkipped.length} errors=${result.errors.length} ` +
    `dur=${result.durationMs}ms`
  );
}

export interface AoiDaemonHealthHooks {
  onCycle: (result: AoiAutonomyBackgroundCycleResult) => void;
  onError: (error: unknown) => void;
}

// Compose the background runner's observability hooks around a health tracker,
// with injectable clock + loggers so the daemon's wiring is unit-testable rather
// than only reachable via a real 5-minute cycle. onCycle records the cycle and
// emits a telemetry line; onError records a whole-cycle throw.
export function createAoiDaemonHealthHooks(params: {
  tracker: AoiDaemonHealthTracker;
  now: () => number;
  logCycle?: (line: string) => void;
  logError?: (error: unknown) => void;
}): AoiDaemonHealthHooks {
  return {
    onCycle: (result) => {
      params.tracker.recordCycle(result);
      params.logCycle?.(formatAoiDaemonCycleLogLine(result));
    },
    onError: (error) => {
      params.tracker.recordError(error, params.now());
      params.logError?.(error);
    },
  };
}
