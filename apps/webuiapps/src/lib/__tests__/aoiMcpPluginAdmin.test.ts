import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_MCP_PLUGIN_ENTRIES,
  applyAoiMcpPluginHealthCheckResult,
  buildAoiMcpPluginPrompt,
  createUserAoiMcpPluginEntry,
  isAoiMcpPluginTrustLocked,
  probeAoiMcpPluginEndpoint,
  removeAoiMcpPluginEntry,
  summarizeAoiMcpPluginAdmin,
  updateAoiMcpPluginEntry,
  upsertAoiMcpPluginEntry,
  type AoiMcpPluginEntry,
} from '../aoiMcpPluginAdmin';

describe('aoiMcpPluginAdmin', () => {
  it('summarizes built-in admin entries', () => {
    const summary = summarizeAoiMcpPluginAdmin(DEFAULT_AOI_MCP_PLUGIN_ENTRIES);

    expect(summary.total).toBeGreaterThanOrEqual(2);
    expect(summary.builtIn).toBe(summary.total);
    expect(summary.enabled).toBeGreaterThan(0);
    expect(summary.trusted).toBeGreaterThan(0);
  });

  it('injects only enabled and trusted entries into the prompt', () => {
    const userEntry = createUserAoiMcpPluginEntry({
      name: 'Local MCP',
      endpointUrl: 'http://127.0.0.1:9999/mcp',
      kind: 'mcp-server',
      now: 100,
    });
    const entries = updateAoiMcpPluginEntry(
      upsertAoiMcpPluginEntry(DEFAULT_AOI_MCP_PLUGIN_ENTRIES, userEntry),
      userEntry.id,
      { trusted: true },
      110,
    );
    const prompt = buildAoiMcpPluginPrompt(entries);

    expect(prompt).toContain('Aoi MCP/Plugin Admin');
    expect(prompt).toContain('Local MCP');
  });

  it('keeps built-in entries and removes user entries only', () => {
    const userEntry = createUserAoiMcpPluginEntry({
      name: 'Temporary Connector',
      endpointUrl: 'http://localhost:7777',
      kind: 'connector',
      now: 200,
    });
    let entries = upsertAoiMcpPluginEntry(DEFAULT_AOI_MCP_PLUGIN_ENTRIES, userEntry);
    entries = removeAoiMcpPluginEntry(entries, userEntry.id);
    entries = removeAoiMcpPluginEntry(entries, 'aoi-ide-local-bridge');

    expect(entries.some((entry) => entry.id === userEntry.id)).toBe(false);
    expect(entries.some((entry) => entry.id === 'aoi-ide-local-bridge')).toBe(true);
  });

  it('probes internal and invalid endpoints without network calls', async () => {
    const internal = await probeAoiMcpPluginEndpoint(DEFAULT_AOI_MCP_PLUGIN_ENTRIES[0], 300);
    const invalid = await probeAoiMcpPluginEndpoint(
      createUserAoiMcpPluginEntry({
        name: 'Invalid',
        endpointUrl: 'not-a-url',
        kind: 'mcp-server',
        now: 300,
      }),
      310,
    );

    expect(internal.healthStatus).toBe('healthy');
    expect(invalid.healthStatus).toBe('error');
    expect(invalid.healthMessage).toContain('Endpoint URL');
  });

  it('normalizes invalid persisted enum values', () => {
    const damaged = {
      ...DEFAULT_AOI_MCP_PLUGIN_ENTRIES[0],
      id: 'damaged-user-entry',
      source: 'user',
      authMode: 'surprise',
      healthStatus: 'maybe',
    } as unknown as AoiMcpPluginEntry;

    const summary = summarizeAoiMcpPluginAdmin([damaged]);
    const prompt = buildAoiMcpPluginPrompt([damaged]);

    expect(summary.errors).toBe(0);
    expect(prompt).toContain('[plugin, unknown]');
  });

  it('locks trust only for built-ins that are trusted by default', () => {
    let entries = updateAoiMcpPluginEntry(
      DEFAULT_AOI_MCP_PLUGIN_ENTRIES,
      'ida-pe-mcp-backend',
      { trusted: true },
      400,
    );
    expect(entries.find((entry) => entry.id === 'ida-pe-mcp-backend')?.trusted).toBe(true);
    expect(
      isAoiMcpPluginTrustLocked(entries.find((entry) => entry.id === 'ida-pe-mcp-backend')!),
    ).toBe(false);

    entries = updateAoiMcpPluginEntry(entries, 'ida-pe-mcp-backend', { trusted: false }, 410);

    expect(entries.find((entry) => entry.id === 'ida-pe-mcp-backend')?.trusted).toBe(false);
    expect(isAoiMcpPluginTrustLocked(DEFAULT_AOI_MCP_PLUGIN_ENTRIES[0])).toBe(true);
  });

  it('applies health check results without restoring stale control state', () => {
    const userEntry = createUserAoiMcpPluginEntry({
      name: 'Racey MCP',
      endpointUrl: 'http://127.0.0.1:9999/mcp',
      kind: 'mcp-server',
      now: 500,
    });
    const checkedEntry: AoiMcpPluginEntry = {
      ...userEntry,
      trusted: false,
      enabled: true,
      healthStatus: 'healthy',
      healthMessage: 'HTTP 200',
      lastCheckedAt: 520,
      updatedAt: 520,
    };
    const toggledEntries = updateAoiMcpPluginEntry(
      upsertAoiMcpPluginEntry(DEFAULT_AOI_MCP_PLUGIN_ENTRIES, userEntry),
      userEntry.id,
      { trusted: true, enabled: false },
      510,
    );
    const mergedEntries = applyAoiMcpPluginHealthCheckResult(toggledEntries, checkedEntry);
    const merged = mergedEntries.find((entry) => entry.id === userEntry.id);

    expect(merged?.trusted).toBe(true);
    expect(merged?.enabled).toBe(false);
    expect(merged?.healthStatus).toBe('healthy');
    expect(merged?.healthMessage).toBe('HTTP 200');

    const deletedEntries = removeAoiMcpPluginEntry(toggledEntries, userEntry.id);
    const afterDeletedCheck = applyAoiMcpPluginHealthCheckResult(deletedEntries, checkedEntry);

    expect(afterDeletedCheck.some((entry) => entry.id === userEntry.id)).toBe(false);
  });
});
