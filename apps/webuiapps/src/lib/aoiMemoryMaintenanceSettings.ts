import * as fs from 'fs';

import {
  AOI_MEMORY_MAINTENANCE_DEFAULT_CONSOLIDATION_MAX,
  AOI_MEMORY_MAINTENANCE_DEFAULT_EMBED_MAX,
  AOI_MEMORY_MAINTENANCE_DEFAULT_INTERVAL_MINUTES,
  normalizeAoiMemoryMaintenanceConfig,
  type AoiMemoryMaintenanceConfig,
} from './configPersistence';
// The env parsing is duplicated here rather than imported from the two sweep
// modules on purpose: aoiMemoryEmbedSweep -> aoiMemoryEmbeddingServer -> this
// module would otherwise form an import cycle. The defaults are the shared
// constants from configPersistence, so the two paths cannot drift apart, and
// aoiMemoryMaintenanceSettings.test asserts they agree with the env resolvers.

// Single resolver for the memory maintenance settings (embed backfill,
// consolidation, offline local embedder).
//
// These used to be env-var only, so turning semantic memory on meant editing
// system environment variables and restarting. The settings UI now writes them
// into config.json (field: aoiMemoryMaintenance) and this resolver decides the
// effective values:
//
//   explicit config field  >  env var  >  built-in default
//
// A field ABSENT from the config block hands the decision to the env var, so an
// existing headless deployment keeps working untouched; once the operator flips
// a toggle in the UI, that field wins for good.

export interface AoiMemoryMaintenanceSettings {
  embedSweep: { enabled: boolean; intervalMs: number; max: number };
  consolidation: { enabled: boolean; max: number };
  localEmbedder: boolean;
  // Which side decided each toggle, for an honest UI ("on via environment").
  sources: {
    embedSweep: 'config' | 'env' | 'default';
    consolidation: 'config' | 'env' | 'default';
    localEmbedder: 'config' | 'env' | 'default';
  };
}

export function readAoiMemoryMaintenanceConfigFromFile(
  configFile: string | undefined,
): AoiMemoryMaintenanceConfig | null {
  if (!configFile) {
    return null;
  }
  try {
    if (!fs.existsSync(configFile)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
      aoiMemoryMaintenance?: unknown;
    } | null;
    const raw =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.aoiMemoryMaintenance
        : null;
    return normalizeAoiMemoryMaintenanceConfig(raw as Partial<AoiMemoryMaintenanceConfig> | null);
  } catch {
    return null;
  }
}

function parseBoolEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAoiMemoryMaintenanceSettings(params: {
  config?: AoiMemoryMaintenanceConfig | null;
  env?: Record<string, string | undefined>;
}): AoiMemoryMaintenanceSettings {
  const config = normalizeAoiMemoryMaintenanceConfig(params.config);
  const env = params.env ?? process.env;
  const envSweep = {
    enabled: parseBoolEnv(env.AOI_AUTONOMY_EMBED_SWEEP),
    intervalMs: parseIntEnv(
      env.AOI_AUTONOMY_EMBED_SWEEP_INTERVAL_MS,
      AOI_MEMORY_MAINTENANCE_DEFAULT_INTERVAL_MINUTES * 60_000,
    ),
    max: parseIntEnv(env.AOI_AUTONOMY_EMBED_SWEEP_MAX, AOI_MEMORY_MAINTENANCE_DEFAULT_EMBED_MAX),
  };
  const envConsolidation = {
    enabled: parseBoolEnv(env.AOI_AUTONOMY_CONSOLIDATION),
    max: Math.max(
      1,
      parseIntEnv(
        env.AOI_AUTONOMY_CONSOLIDATION_MAX,
        AOI_MEMORY_MAINTENANCE_DEFAULT_CONSOLIDATION_MAX,
      ),
    ),
  };
  const envLocalEmbedder = parseBoolEnv(env.AOI_LOCAL_EMBEDDER);

  const embedSweepEnabled = config?.embedSweepEnabled ?? envSweep.enabled;
  const consolidationEnabled = config?.consolidationEnabled ?? envConsolidation.enabled;
  const localEmbedder = config?.localEmbedderEnabled ?? envLocalEmbedder;

  const decide = (fromConfig: boolean, fromEnv: boolean): 'config' | 'env' | 'default' => {
    if (fromConfig) {
      return 'config';
    }
    return fromEnv ? 'env' : 'default';
  };

  return {
    embedSweep: {
      enabled: embedSweepEnabled,
      intervalMs:
        (config?.embedSweepIntervalMinutes ?? 0) > 0
          ? (config?.embedSweepIntervalMinutes ?? AOI_MEMORY_MAINTENANCE_DEFAULT_INTERVAL_MINUTES) *
            60_000
          : envSweep.intervalMs,
      max: config?.embedSweepMax ?? envSweep.max ?? AOI_MEMORY_MAINTENANCE_DEFAULT_EMBED_MAX,
    },
    consolidation: {
      enabled: consolidationEnabled,
      max:
        config?.consolidationMax ??
        envConsolidation.max ??
        AOI_MEMORY_MAINTENANCE_DEFAULT_CONSOLIDATION_MAX,
    },
    localEmbedder,
    sources: {
      embedSweep: decide(config?.embedSweepEnabled !== undefined, envSweep.enabled),
      consolidation: decide(config?.consolidationEnabled !== undefined, envConsolidation.enabled),
      localEmbedder: decide(config?.localEmbedderEnabled !== undefined, envLocalEmbedder),
    },
  };
}

// Read-modify-write just this block, preserving every other persisted setting
// (llm, tavily, aoiEmbedding, ...). Atomic temp+rename so a crash mid-write
// cannot truncate the operator's whole config. Passing null clears the block,
// which hands every field back to the env fallback.
export function writeAoiMemoryMaintenanceConfigToFile(
  configFile: string,
  config: AoiMemoryMaintenanceConfig | null,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // A malformed config file must not be silently replaced with just this
    // block -- that would drop the operator's keys.
    throw new Error('config.json could not be read; refusing to overwrite it.');
  }

  const next: Record<string, unknown> = { ...existing };
  if (config) {
    next.aoiMemoryMaintenance = config;
  } else {
    delete next.aoiMemoryMaintenance;
  }

  const tmp = `${configFile}.tmp-maintenance`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, configFile);
}

// Convenience for server callers that only have the config file path.
export function loadAoiMemoryMaintenanceSettings(params: {
  configFile?: string;
  env?: Record<string, string | undefined>;
}): AoiMemoryMaintenanceSettings {
  return resolveAoiMemoryMaintenanceSettings({
    config: readAoiMemoryMaintenanceConfigFromFile(params.configFile),
    ...(params.env ? { env: params.env } : {}),
  });
}
