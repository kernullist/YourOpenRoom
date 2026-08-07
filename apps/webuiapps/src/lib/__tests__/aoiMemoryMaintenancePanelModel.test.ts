import { describe, expect, it } from 'vitest';
import {
  buildAoiMemoryMaintenanceBody,
  describeAoiMaintenanceSource,
  formatAoiEmbeddingCoverage,
  parseAoiMemoryMaintenanceResponse,
  parseAoiMemoryMaintenanceRunResponse,
  type AoiMemoryMaintenanceView,
} from '../aoiMemoryMaintenancePanelModel';

const SERVER_RESPONSE = {
  ok: true,
  settings: {
    embedSweep: { enabled: true, intervalMs: 600_000, max: 4 },
    consolidation: { enabled: false, max: 8 },
    localEmbedder: true,
    sources: { embedSweep: 'config', consolidation: 'env', localEmbedder: 'default' },
  },
  status: {
    providerConfigured: false,
    providerModel: 'aoi-local-hash-v1',
    activeCount: 21,
    embeddedCount: 21,
    pendingCount: 0,
  },
};

describe('parseAoiMemoryMaintenanceResponse', () => {
  it('maps the server shape into the panel view', () => {
    const parsed = parseAoiMemoryMaintenanceResponse(SERVER_RESPONSE);

    expect(parsed?.settings).toEqual({
      embedSweepEnabled: true,
      embedSweepIntervalMinutes: 10,
      embedSweepMax: 4,
      consolidationEnabled: false,
      consolidationMax: 8,
      localEmbedderEnabled: true,
      sources: { embedSweep: 'config', consolidation: 'env', localEmbedder: 'default' },
    });
    expect(parsed?.coverage.embeddedCount).toBe(21);
    expect(parsed?.coverage.providerModel).toBe('aoi-local-hash-v1');
  });

  it('rejects a malformed payload instead of rendering junk toggles', () => {
    expect(parseAoiMemoryMaintenanceResponse(null)).toBeNull();
    expect(parseAoiMemoryMaintenanceResponse({ ok: true })).toBeNull();
    expect(parseAoiMemoryMaintenanceResponse('nope')).toBeNull();
  });

  it('defaults unknown source labels rather than trusting the payload', () => {
    const parsed = parseAoiMemoryMaintenanceResponse({
      settings: { embedSweep: {}, consolidation: {}, sources: { embedSweep: 'hacked' } },
    });
    expect(parsed?.settings.sources.embedSweep).toBe('default');
    expect(parsed?.settings.embedSweepEnabled).toBe(false);
  });
});

describe('buildAoiMemoryMaintenanceBody', () => {
  it('sends each toggle explicitly so a saved setting beats the env fallback', () => {
    const view: AoiMemoryMaintenanceView = {
      embedSweepEnabled: false,
      embedSweepIntervalMinutes: 5,
      embedSweepMax: 16,
      consolidationEnabled: true,
      consolidationMax: 8,
      localEmbedderEnabled: false,
      sources: { embedSweep: 'env', consolidation: 'default', localEmbedder: 'env' },
    };

    expect(buildAoiMemoryMaintenanceBody(view)).toEqual({
      version: 1,
      embedSweepEnabled: false,
      consolidationEnabled: true,
      localEmbedderEnabled: false,
    });
  });

  it('omits interval and max, which the panel does not control', () => {
    // Echoing the resolved values back would freeze an env-supplied interval
    // into config.json -- and the ms->minutes rounding changed it on the way
    // (a 20s sweep came back as 5 minutes, then clamped max 200 down to 64).
    const view: AoiMemoryMaintenanceView = {
      embedSweepEnabled: true,
      embedSweepIntervalMinutes: 5,
      embedSweepMax: 200,
      consolidationEnabled: false,
      consolidationMax: 8,
      localEmbedderEnabled: true,
      sources: { embedSweep: 'config', consolidation: 'env', localEmbedder: 'config' },
    };
    const body = buildAoiMemoryMaintenanceBody(view);

    expect(body).not.toHaveProperty('embedSweepIntervalMinutes');
    expect(body).not.toHaveProperty('embedSweepMax');
    expect(body).not.toHaveProperty('consolidationMax');
  });
});

describe('parseAoiMemoryMaintenanceRunResponse', () => {
  it('summarizes an immediate maintenance pass', () => {
    expect(
      parseAoiMemoryMaintenanceRunResponse({
        embed: { ran: true, embeddedCount: 15, pendingCount: 0 },
        consolidation: { ran: true, clusterCount: 2, supersededCount: 3 },
      }),
    ).toEqual({ embeddedCount: 15, pendingCount: 0, clusterCount: 2, supersededCount: 3 });
  });

  it('reports zeros when a half was disabled', () => {
    expect(parseAoiMemoryMaintenanceRunResponse({ embed: { ran: false } })).toEqual({
      embeddedCount: 0,
      pendingCount: 0,
      clusterCount: 0,
      supersededCount: 0,
    });
  });
});

describe('display helpers', () => {
  it('labels where a toggle was decided', () => {
    expect(describeAoiMaintenanceSource('config')).toBe('set here');
    expect(describeAoiMaintenanceSource('env')).toBe('on via environment');
    expect(describeAoiMaintenanceSource('default')).toBe('default');
  });

  it('formats embedding coverage as a percentage', () => {
    expect(
      formatAoiEmbeddingCoverage({
        providerConfigured: false,
        providerModel: null,
        activeCount: 20,
        embeddedCount: 15,
        pendingCount: 5,
      }),
    ).toBe('15/20 active memories embedded (75%)');
  });

  it('does not divide by zero on an empty store', () => {
    expect(
      formatAoiEmbeddingCoverage({
        providerConfigured: false,
        providerModel: null,
        activeCount: 0,
        embeddedCount: 0,
        pendingCount: 0,
      }),
    ).toBe('No active memories yet.');
  });
});
