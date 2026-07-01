import { consolidateServerAoiMemories } from './aoiMemoryServerWriter';

// Loop-independent memory consolidation cycle (P4-a c2).
//
// This is the consolidation half of the loop-independent memory-maintenance sweep.
// It carries NO timer and NO lock of its own: the embed sweep's single timer runs
// this right AFTER the embed backfill in the same cycle, under the same reused
// single-instance loop lock (see aoiMemoryEmbedSweep + the plugin bootstrap), so
// embedding and consolidation never both mutate the memory files concurrently and
// a memory the backfill just vectorised is immediately eligible to collapse.
//
// Safety: consolidateServerAoiMemories is non-destructive (near-duplicate ACTIVE
// memories collapse into their strongest member; superseded originals are only
// status-flipped, their files kept on disk) and requires embeddings (no vectors ->
// nothing eligible -> a no-op), so the embedding key stays the opt-in. OFF by
// default behind its own env flag, independent of AOI_AUTONOMY_EMBED_SWEEP and
// AOI_AUTONOMY_BACKGROUND.

const MIN_CONSOLIDATION_MAX = 1;
const DEFAULT_CONSOLIDATION_MAX = 8;

export interface AoiMemoryConsolidationSweepConfig {
  enabled: boolean;
  // Max clusters collapsed per cycle (bounds one pass; leftovers converge later).
  max: number;
}

function parseBoolEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// OFF by default. The flag is separate from AOI_AUTONOMY_EMBED_SWEEP so
// consolidation can be opted into independently, though in practice it needs the
// embedding key (no vectors -> no-op) and benefits from the embed step running in
// the same cycle first.
export function resolveAoiMemoryConsolidationConfigFromEnv(
  env: Record<string, string | undefined>,
): AoiMemoryConsolidationSweepConfig {
  return {
    enabled: parseBoolEnv(env.AOI_AUTONOMY_CONSOLIDATION),
    max: Math.max(
      MIN_CONSOLIDATION_MAX,
      parseIntEnv(env.AOI_AUTONOMY_CONSOLIDATION_MAX, DEFAULT_CONSOLIDATION_MAX),
    ),
  };
}

export interface AoiMemoryConsolidationSweepCycleResult {
  ran: boolean;
  clusterCount: number;
  supersededCount: number;
}

// Run one bounded consolidation pass across the whole server memory store
// (consolidateServerAoiMemories is session-agnostic -- it scans the shared memories
// dir). Synchronous and self-contained: it reads only embeddings already on disk,
// never calls a provider. Best-effort: any failure yields ran:false and never
// throws into the sweep timer or the autonomy tick.
export function runAoiMemoryConsolidationSweepCycle(options: {
  sessionsDir: string;
  now?: number;
  max?: number;
}): AoiMemoryConsolidationSweepCycleResult {
  try {
    const result = consolidateServerAoiMemories(options.sessionsDir, {
      ...(typeof options.now === 'number' ? { now: options.now } : {}),
      ...(typeof options.max === 'number' ? { maxClusters: options.max } : {}),
    });
    return {
      ran: true,
      clusterCount: result.clusterCount,
      supersededCount: result.supersededCount,
    };
  } catch {
    // Best-effort: consolidation never blocks or crashes the sweep.
    return { ran: false, clusterCount: 0, supersededCount: 0 };
  }
}
