import { resolve } from 'path';

import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import { embedAndPersistServerAoiMemories } from './aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from './aoiMemoryEmbedding';
import {
  runAoiMemoryConsolidationSweepCycle,
  type AoiMemoryConsolidationSweepCycleResult,
} from './aoiMemoryConsolidationSweep';

// Loop-independent server memory maintenance sweep (embed + consolidation).
//
// This owns the single loop-independent maintenance timer, for hosts that run NO
// autonomy loop of their own (typically a dev server alongside the daemon). Its
// primary job is the embed backfill; when consolidation is opted in (see
// aoiMemoryConsolidationSweep) the SAME timer runs a bounded consolidation pass
// right after the embed cycle, so a just-vectorised memory is immediately eligible
// to collapse.
//
// It takes the single-instance loop lock as the subordinate 'maintenance' role and
// re-checks ownership every cycle: an autonomy loop starting anywhere takes the
// lock over, and from then on this sweep yields (that loop runs the same pass
// itself) until the lock comes back. Note the run-now route serves the same
// maintenance on demand WITHOUT the lock, so the lock is not the only writer.
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
  // Stops the timer and resolves once the in-flight cycle has drained. A cycle
  // already awaiting its embedding provider keeps writing memory files until it
  // finishes, so the lock must not be released until this settles -- otherwise a
  // shutdown deterministically hands the dir to the next process while the old
  // one is still mutating it.
  stop: () => Promise<void>;
}

export interface AoiMemoryMaintenanceCycleOptions {
  sessionsDir: string;
  configFile?: string;
  embedSweep: { enabled: boolean; max: number };
  consolidation: { enabled: boolean; max: number };
  // Pre-resolved embedding provider. Passing null skips the embed half without
  // touching the consolidation half; omitting it resolves per cycle as before.
  provider?: AoiEmbeddingProvider | null;
  onCycle?: (result: AoiMemoryEmbedSweepCycleResult) => void;
  onConsolidation?: (result: AoiMemoryConsolidationSweepCycleResult) => void;
  // Re-asked BETWEEN the two halves. Embedding awaits a provider, which can take
  // long enough for the authoritative loop to take the lock over mid-cycle;
  // continuing into consolidation then would have two processes rewriting the
  // same memory files. Absent -> both halves run.
  ownsLock?: () => boolean;
  // Injectable seams for tests.
  runCycle?: typeof runAoiMemoryEmbedSweepCycle;
  runConsolidationCycle?: typeof runAoiMemoryConsolidationSweepCycle;
}

// In-process serialization, keyed by session store. The single-instance lock is
// a CROSS-process guard; within one process there are three paths that mutate the
// same memory files -- the standalone sweep's timer, the loop's post-cycle pass,
// and the operator's "Run now" route -- and each has its own in-flight guard that
// says nothing about the others. Two of them overlapping at an await is a lost
// update: a consolidation status flip overwritten by a concurrent embed write.
//
// A promise chain per store is enough: passes are bounded and infrequent, so
// queueing behind the one in flight costs nothing and removes the interleaving.
const maintenanceChains = new Map<string, Promise<void>>();

function runSerializedPerStore<T>(sessionsDir: string, fn: () => Promise<T>): Promise<T> {
  // Normalized, so two spellings of the same directory cannot end up on two
  // chains and silently stop serializing against each other.
  const key = resolve(sessionsDir);
  const previous = maintenanceChains.get(key) ?? Promise.resolve();
  const result = previous.then(fn);
  // The stored chain swallows failures so one bad pass cannot poison the queue.
  maintenanceChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

// One maintenance pass: embed backfill, then consolidation. Consolidation runs
// AFTER embedding so any vectors the backfill just added are already eligible to
// collapse.
//
// Extracted so every driver shares one body and they cannot drift: the standalone
// timer below, the autonomy loop's own cycle, and the run-now route. Which one
// drives it depends on who holds the single-instance lock -- the loop host must
// run this itself, because a loop with no enabled session performs no maintenance
// of its own and would otherwise leave the store unmaintained while holding the
// lock that stops anyone else from doing it.
export async function runAoiMemoryMaintenanceCycle(
  options: AoiMemoryMaintenanceCycleOptions,
): Promise<void> {
  return runSerializedPerStore(options.sessionsDir, () => runAoiMemoryMaintenancePass(options));
}

// Queue an arbitrary mutation of a memory store behind whatever pass is already
// running for it. For callers that do their own embed/consolidation rather than
// a full cycle -- the autonomy wakeup does exactly that, and used to be able to
// interleave with the sweep and the run-now route.
//
// Do NOT call runAoiMemoryMaintenanceCycle from inside `run`: it takes the same
// chain and would wait for the pass it is part of. Use
// runAoiMemoryMaintenancePass, which is the unserialized body.
export function runSerializedAoiMemoryMaintenance<T>(
  sessionsDir: string,
  run: () => Promise<T>,
): Promise<T> {
  return runSerializedPerStore(sessionsDir, run);
}

// The pass itself, with no serialization. Exported for callers that are already
// inside runSerializedAoiMemoryMaintenance.
export async function runAoiMemoryMaintenancePass(
  options: AoiMemoryMaintenanceCycleOptions,
): Promise<void> {
  const runCycle = options.runCycle ?? runAoiMemoryEmbedSweepCycle;
  const runConsolidationCycle =
    options.runConsolidationCycle ?? runAoiMemoryConsolidationSweepCycle;
  if (options.embedSweep.enabled) {
    const result = await runCycle({
      sessionsDir: options.sessionsDir,
      ...(options.configFile ? { configFile: options.configFile } : {}),
      max: options.embedSweep.max,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
    });
    options.onCycle?.(result);
  }
  // Ownership can change while the embed half awaits its provider.
  if (options.ownsLock && !options.ownsLock()) {
    return;
  }
  if (options.consolidation.enabled) {
    const consolidationResult = runConsolidationCycle({
      sessionsDir: options.sessionsDir,
      max: options.consolidation.max,
    });
    options.onConsolidation?.(consolidationResult);
  }
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
  // Asked at the top of EVERY cycle, before anything is read or written. The
  // single-instance lock this sweep holds can be taken over by the authoritative
  // autonomy loop at any time, so ownership must be re-checked rather than
  // assumed for the process lifetime -- otherwise a displaced sweep would keep
  // mutating the same memory files the loop is mutating. Absent -> the sweep
  // owns its cycles unconditionally (the historical behavior, used by tests).
  ownsLock?: () => boolean;
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
  // The cycle currently in flight, so a caller can wait for it before releasing
  // the lock this sweep holds.
  let inFlight: Promise<void> = Promise.resolve();
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
      // Yield the whole cycle when this process no longer owns the store. Asked
      // FIRST so a displaced sweep neither reads nor writes: the loop that took
      // the lock over already performs this maintenance in its own tick.
      if (options.ownsLock && !options.ownsLock()) {
        return;
      }
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
      await runAoiMemoryMaintenanceCycle({
        sessionsDir: options.sessionsDir,
        ...(options.configFile ? { configFile: options.configFile } : {}),
        embedSweep: lastKnownSettings.embedSweep,
        consolidation: lastKnownSettings.consolidation,
        runCycle,
        runConsolidationCycle,
        ...(options.ownsLock ? { ownsLock: options.ownsLock } : {}),
        ...(options.onCycle ? { onCycle: options.onCycle } : {}),
        ...(options.onConsolidation ? { onConsolidation: options.onConsolidation } : {}),
      });
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
