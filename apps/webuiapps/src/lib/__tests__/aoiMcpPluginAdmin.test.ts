import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_MCP_PLUGIN_ENTRIES,
  buildAoiMcpPluginPrompt,
  createUserAoiMcpPluginEntry,
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
});
