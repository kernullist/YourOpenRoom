import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import { embedAndPersistServerAoiMemories } from './aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';
import {
  runAoiMemoryConsolidationSweepCycle,
  type AoiMemoryConsolidationSweepCycleResult,
} from './aoiMemoryConsolidationSweep';

// Loop-independent server memory maintenance sweep (embed + consolidation).
//
// This owns the single loop-independent maintenance timer. Its primary job is the
// embed backfill; when consolidation is opted in (see aoiMemoryConsolidationSweep),
// the SAME timer runs a bounded consolidation pass right after the embed cycle,
// under the SAME reused single-instance loop lock, so the two never both mutate the
// memory files and a just-vectorised memory is immediately eligible to collapse.
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
  // Consolidation half of the maintenance sweep: when enabled, the SAME timer runs
  // one bounded consolidation pass right AFTER the embed cycle (so any vectors the
  // backfill just added are immediately eligible to collapse). OFF by default; it
  // shares this timer and the reused single-instance loop lock, so embedding and
  // consolidation never both mutate the memory files. See aoiMemoryConsolidationSweep.
  consolidation?: { enabled: boolean; max?: number };
  // Startup value for the embed half, and the fail-safe the tick falls back to
  // when resolveCycleSettings throws. Defaults true so existing callers (which
  // only start the sweep when embedding is wanted) are unchanged.
  embedEnabled?: boolean;
  onConsolidation?: (result: AoiMemoryConsolidationSweepCycleResult) => void;
  // Injectable seam for tests.
  runConsolidationCycle?: typeof runAoiMemoryConsolidationSweepCycle;
  // Re-read the operator's maintenance settings at the START of every cycle, so
  // a toggle flipped in the settings UI takes effect on the next tick instead of
  // requiring a server restart. Returning enabled:false makes the cycle a no-op
  // (nothing is read or written). Absent -> the static options above are used,
  // which is what the existing env-only callers and tests rely on.
  resolveCycleSettings?: () => {
    embedSweep: { enabled: boolean; max: number };
    consolidation: { enabled: boolean; max: number };
  };
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
  const runConsolidationCycle =
    options.runConsolidationCycle ?? runAoiMemoryConsolidationSweepCycle;
  let running = false;
  let stopped = false;
  // Seeded from the values start() was called with; refreshed by
  // resolveCycleSettings on every successful resolve. Callers with no resolver
  // keep these forever, which is the historical behavior.
  let lastKnownSettings: {
    embedSweep: { enabled: boolean; max: number };
    consolidation: { enabled: boolean; max: number };
  } = {
    embedSweep: {
      enabled: options.embedEnabled ?? true,
      max: options.max ?? DEFAULT_SWEEP_MAX,
    },
    consolidation: {
      enabled: options.consolidation?.enabled ?? false,
      max: options.consolidation?.max ?? 8,
    },
  };

  const tick = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      // Live settings win over the values captured at start(), so the UI toggle
      // applies on the next tick. A resolver failure keeps the LAST KNOWN GOOD
      // settings (initially the ones start() was called with) -- it must never
      // fall open to "embed enabled", because embedding is outbound egress the
      // operator may have deliberately switched off.
      if (options.resolveCycleSettings) {
        try {
          lastKnownSettings = options.resolveCycleSettings();
        } catch {
          // Keep lastKnownSettings as-is.
        }
      }
      const embedEnabled = lastKnownSettings.embedSweep.enabled;
      const embedMax = lastKnownSettings.embedSweep.max;
      const consolidation = lastKnownSettings.consolidation;

      if (embedEnabled) {
        const result = await runCycle({
          sessionsDir: options.sessionsDir,
          ...(options.configFile ? { configFile: options.configFile } : {}),
          ...(typeof embedMax === 'number' ? { max: embedMax } : {}),
        });
        options.onCycle?.(result);
      }
      // Consolidation runs AFTER embedding in the same cycle so any vectors the
      // backfill just added are eligible; it is best-effort (never throws).
      if (consolidation?.enabled) {
        const consolidationResult = runConsolidationCycle({
          sessionsDir: options.sessionsDir,
          ...(typeof consolidation.max === 'number' ? { max: consolidation.max } : {}),
        });
        options.onConsolidation?.(consolidationResult);
      }
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
