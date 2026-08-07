// Pure model for the memory maintenance settings panel: routes, response
// parsing, and the request body. Kept out of the component so the parsing rules
// are unit-testable and the panel stays a thin renderer (same split as
// aoiMemoryDecayPanelModel).

export const AOI_MEMORY_MAINTENANCE_ROUTE = '/api/aoi-autonomy/memory/maintenance';
export const AOI_MEMORY_MAINTENANCE_RUN_ROUTE = '/api/aoi-autonomy/memory/maintenance/run';

export type AoiMaintenanceToggleSource = 'config' | 'env' | 'default';

export interface AoiMemoryMaintenanceView {
  embedSweepEnabled: boolean;
  embedSweepIntervalMinutes: number;
  embedSweepMax: number;
  consolidationEnabled: boolean;
  consolidationMax: number;
  localEmbedderEnabled: boolean;
  sources: {
    embedSweep: AoiMaintenanceToggleSource;
    consolidation: AoiMaintenanceToggleSource;
    localEmbedder: AoiMaintenanceToggleSource;
  };
}

export interface AoiMemoryEmbeddingCoverage {
  providerConfigured: boolean;
  providerModel: string | null;
  activeCount: number;
  embeddedCount: number;
  pendingCount: number;
}

export interface AoiMemoryMaintenanceRunResult {
  embeddedCount: number;
  pendingCount: number;
  clusterCount: number;
  supersededCount: number;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function asSource(value: unknown): AoiMaintenanceToggleSource {
  return value === 'config' || value === 'env' ? value : 'default';
}

export function parseAoiMemoryMaintenanceResponse(raw: unknown): {
  settings: AoiMemoryMaintenanceView;
  coverage: AoiMemoryEmbeddingCoverage;
} | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const settings = body.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== 'object') {
    return null;
  }
  const embedSweep = (settings.embedSweep ?? {}) as Record<string, unknown>;
  const consolidation = (settings.consolidation ?? {}) as Record<string, unknown>;
  const sources = (settings.sources ?? {}) as Record<string, unknown>;
  const status = (body.status ?? {}) as Record<string, unknown>;
  const intervalMs = asCount(embedSweep.intervalMs);

  return {
    settings: {
      embedSweepEnabled: asBool(embedSweep.enabled),
      // Minutes is the operator-facing unit; the server stores milliseconds.
      embedSweepIntervalMinutes: Math.max(1, Math.round(intervalMs / 60_000) || 5),
      embedSweepMax: asCount(embedSweep.max) || 16,
      consolidationEnabled: asBool(consolidation.enabled),
      consolidationMax: asCount(consolidation.max) || 8,
      localEmbedderEnabled: asBool(settings.localEmbedder),
      sources: {
        embedSweep: asSource(sources.embedSweep),
        consolidation: asSource(sources.consolidation),
        localEmbedder: asSource(sources.localEmbedder),
      },
    },
    coverage: {
      providerConfigured: asBool(status.providerConfigured),
      providerModel: typeof status.providerModel === 'string' ? status.providerModel : null,
      activeCount: asCount(status.activeCount),
      embeddedCount: asCount(status.embeddedCount),
      pendingCount: asCount(status.pendingCount),
    },
  };
}

export function parseAoiMemoryMaintenanceRunResponse(
  raw: unknown,
): AoiMemoryMaintenanceRunResult | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const embed = (body.embed ?? {}) as Record<string, unknown>;
  const consolidation = (body.consolidation ?? {}) as Record<string, unknown>;
  return {
    embeddedCount: asCount(embed.embeddedCount),
    pendingCount: asCount(embed.pendingCount),
    clusterCount: asCount(consolidation.clusterCount),
    supersededCount: asCount(consolidation.supersededCount),
  };
}

// Every field is sent explicitly so a saved setting always wins over the env
// fallback -- omitting a field would hand that toggle back to the environment.
export function buildAoiMemoryMaintenanceBody(
  view: AoiMemoryMaintenanceView,
): Record<string, unknown> {
  return {
    version: 1,
    embedSweepEnabled: view.embedSweepEnabled,
    embedSweepIntervalMinutes: view.embedSweepIntervalMinutes,
    embedSweepMax: view.embedSweepMax,
    consolidationEnabled: view.consolidationEnabled,
    consolidationMax: view.consolidationMax,
    localEmbedderEnabled: view.localEmbedderEnabled,
  };
}

export function describeAoiMaintenanceSource(source: AoiMaintenanceToggleSource): string {
  if (source === 'config') {
    return 'set here';
  }
  return source === 'env' ? 'on via environment' : 'default';
}

export function formatAoiEmbeddingCoverage(coverage: AoiMemoryEmbeddingCoverage): string {
  if (coverage.activeCount === 0) {
    return 'No active memories yet.';
  }
  const percent = Math.round((coverage.embeddedCount / coverage.activeCount) * 100);
  return `${coverage.embeddedCount}/${coverage.activeCount} active memories embedded (${percent}%)`;
}
