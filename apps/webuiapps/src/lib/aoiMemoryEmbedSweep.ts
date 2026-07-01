import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import { embedAndPersistServerAoiMemories } from './aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';

// Loop-independent server memory embed sweep.
//
// The bulk embed backfill (embedAndPersistServerAoiMemories) only runs inside the
// autonomy wakeup, so a server memory written while the background loop is OFF (the
// default) -- notably a kira_automation memory, whose write path is a deep chain of
// synchronous callers with no embedding seam -- never gets a vector and stays
// lexical-only for recall. This sweep runs the SAME bounded, idempotent backfill on
// its own timer, independent of the autonomy tick, so those memories eventually gain
// vectors even when the loop never runs.
//
// Safety: it only ADDS vectors to active memories that lack them -- it never deletes,
// hides, supersedes, or rewrites content -- so the embedding key stays the true
// opt-in and lexical recall is unaffected when no key is set. OFF by default; a
// separate env flag (independent of AOI_AUTONOMY_BACKGROUND) turns it on.

// Guard rails mirroring the background runner so a misconfig cannot hammer the store.
const MIN_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SWEEP_MAX = 16;

export interface AoiMemoryEmbedSweepEnvConfig {
  enabled: boolean;
  intervalMs: number;
  max: number;
}

function parseBoolEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// OFF by default (like the background loop). The flag is separate from
// AOI_AUTONOMY_BACKGROUND so embedding can be kept warm even when the autonomy tick
// is not running.
export function resolveAoiMemoryEmbedSweepConfigFromEnv(
  env: Record<string, string | undefined>,
): AoiMemoryEmbedSweepEnvConfig {
  return {
    enabled: parseBoolEnv(env.AOI_AUTONOMY_EMBED_SWEEP),
    intervalMs: parseIntEnv(env.AOI_AUTONOMY_EMBED_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS),
    max: parseIntEnv(env.AOI_AUTONOMY_EMBED_SWEEP_MAX, DEFAULT_SWEEP_MAX),
  };
}

export interface AoiMemoryEmbedSweepCycleResult {
  ran: boolean;
  embeddedCount: number;
  pendingCount: number;
}

// Run one bounded embed sweep across the whole server memory store
// (embedAndPersistServerAoiMemories is session-agnostic -- it scans the shared
// memories dir). The provider is resolved from the config file / env each cycle
// unless one is injected (tests), so a key added later is picked up without a
// restart. No provider (no key) -> a no-op, so lexical recall is unaffected.
// Best-effort: any failure yields ran:false and never throws.
export async function runAoiMemoryEmbedSweepCycle(options: {
  sessionsDir: string;
  configFile?: string;
  max?: number;
  provider?: AoiEmbeddingProvider | null;
  env?: Record<string, string | undefined>;
}): Promise<AoiMemoryEmbedSweepCycleResult> {
  const provider =
    options.provider !== undefined
      ? options.provider
      : createServerAoiEmbeddingProvider({
          ...(options.configFile ? { configFile: options.configFile } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
  if (!provider) {
    return { ran: false, embeddedCount: 0, pendingCount: 0 };
  }
  try {
    const result = await embedAndPersistServerAoiMemories(options.sessionsDir, provider, {
      max: options.max ?? DEFAULT_SWEEP_MAX,
    });
    return { ran: true, embeddedCount: result.embeddedCount, pendingCount: result.pendingCount };
  } catch {
    // Best-effort: embedding never blocks or crashes the sweep.
    return { ran: false, embeddedCount: 0, pendingCount: 0 };
  }
}

export interface AoiMemoryEmbedSweepHandle {
  stop: () => void;
}

export interface AoiMemoryEmbedSweepOptions {
  sessionsDir: string;
  configFile?: string;
  intervalMs: number;
  max?: number;
  runImmediately?: boolean;
  onCycle?: (result: AoiMemoryEmbedSweepCycleResult) => void;
  onError?: (error: unknown) => void;
  // Injectable seam for tests.
  runCycle?: typeof runAoiMemoryEmbedSweepCycle;
}

// Start the loop-independent embed sweep interval. Overlapping cycles are blocked
// by an in-flight guard; the timer is unref'd so it never keeps the host process
// alive on its own. Mirrors startAoiAutonomyBackgroundRunner. Returns a stop()
// handle for clean shutdown.
export function startAoiMemoryEmbedSweep(
  options: AoiMemoryEmbedSweepOptions,
): AoiMemoryEmbedSweepHandle {
  const intervalMs = Math.max(MIN_SWEEP_INTERVAL_MS, options.intervalMs);
  const runCycle = options.runCycle ?? runAoiMemoryEmbedSweepCycle;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const result = await runCycle({
        sessionsDir: options.sessionsDir,
        ...(options.configFile ? { configFile: options.configFile } : {}),
        ...(typeof options.max === 'number' ? { max: options.max } : {}),
      });
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
