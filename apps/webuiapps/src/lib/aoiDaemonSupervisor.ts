// Supervisor / watchdog for the standalone Aoi autonomy daemon (P0.1).
//
// The daemon is a plain child process today: a crash (or an uncaughtException
// exit(1)) leaves Aoi simply OFF until someone re-runs the launcher, so "24/7"
// is not actually backed by anything. This supervisor keeps it alive: it spawns
// the daemon, restarts it on unexpected exit with exponential backoff, and --
// crucially -- GIVES UP if it crash-loops (too many exits in a short window) so
// a broken build cannot spin forever. Boot-persistence (start-at-logon) is a
// thin OS registration on top (see Install-AoiDaemonService.ps1); this module is
// the restart brain, made fully unit-testable via injected spawn / timer / clock.

export interface SupervisedChild {
  // Register the one-shot exit listener (exit code, or null on signal).
  onExit: (listener: (code: number | null) => void) => void;
  // Terminate the child (best-effort).
  kill: () => void;
}

export type AoiDaemonSupervisorEvent =
  | { type: 'started'; attempt: number }
  | { type: 'crashed'; code: number | null; recentCrashes: number; restartInMs: number }
  | { type: 'gave_up'; recentCrashes: number }
  | { type: 'stopped' };

export interface AoiDaemonSupervisorOptions {
  // Spawn a fresh daemon child. Injectable so tests never spawn a real process.
  spawnChild: () => SupervisedChild;
  // Schedule a delayed restart; returns a cancel fn. Default: unref'd setTimeout.
  schedule?: (fn: () => void, delayMs: number) => () => void;
  now?: () => number;
  baseRestartDelayMs?: number; // default 1000
  maxRestartDelayMs?: number; // default 30_000
  crashWindowMs?: number; // default 60_000
  // Give up after MORE than this many crashes inside crashWindowMs (crash loop).
  maxCrashesInWindow?: number; // default 5
  onEvent?: (event: AoiDaemonSupervisorEvent) => void;
}

export interface AoiDaemonSupervisorHandle {
  stop: () => void;
}

const DEFAULT_BASE_RESTART_MS = 1000;
const DEFAULT_MAX_RESTART_MS = 30_000;
const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASHES = 5;

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(timer);
  };
}

// Start supervising: spawns the daemon immediately and keeps it running. Returns
// a stop() handle that cancels any pending restart and kills the live child.
export function superviseAoiDaemon(options: AoiDaemonSupervisorOptions): AoiDaemonSupervisorHandle {
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? Date.now;
  const baseDelay = options.baseRestartDelayMs ?? DEFAULT_BASE_RESTART_MS;
  const maxDelay = options.maxRestartDelayMs ?? DEFAULT_MAX_RESTART_MS;
  const crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
  const maxCrashes = options.maxCrashesInWindow ?? DEFAULT_MAX_CRASHES;

  let stopped = false;
  let child: SupervisedChild | null = null;
  let cancelPending: (() => void) | null = null;
  let crashTimes: number[] = [];
  let attempt = 0;

  const start = (): void => {
    if (stopped) {
      return;
    }
    cancelPending = null;
    attempt += 1;
    child = options.spawnChild();
    options.onEvent?.({ type: 'started', attempt });
    child.onExit((code) => {
      child = null;
      if (stopped) {
        return;
      }
      const at = now();
      // Keep only crashes inside the rolling window; a lone crash after a long
      // healthy run resets the streak (and the backoff).
      crashTimes = crashTimes.filter((time) => at - time < crashWindowMs);
      crashTimes.push(at);
      if (crashTimes.length > maxCrashes) {
        // Crash loop: stop trying so a broken build cannot spin forever.
        options.onEvent?.({ type: 'gave_up', recentCrashes: crashTimes.length });
        stopped = true;
        return;
      }
      const restartInMs = Math.min(maxDelay, baseDelay * 2 ** (crashTimes.length - 1));
      options.onEvent?.({ type: 'crashed', code, recentCrashes: crashTimes.length, restartInMs });
      cancelPending = schedule(start, restartInMs);
    });
  };

  start();

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      cancelPending?.();
      cancelPending = null;
      child?.kill();
      child = null;
      options.onEvent?.({ type: 'stopped' });
    },
  };
}
