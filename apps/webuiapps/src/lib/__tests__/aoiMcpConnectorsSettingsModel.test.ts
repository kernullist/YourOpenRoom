import { describe, expect, it } from 'vitest';

import {
  connectorEntriesToConfig,
  connectorEntryFromPluginAdmin,
  connectorHostStatus,
  createEmptyAoiMcpConnectorEntry,
  eligiblePluginAdminConnectorEntries,
  mergePluginAdminConnectors,
} from '../aoiMcpConnectorsSettingsModel';
import type { AoiMcpConnectorEntry } from '../aoiMcpConnectorRegistry';
import type { AoiMcpPluginEntry } from '../aoiMcpPluginAdmin';

function plugin(overrides: Partial<AoiMcpPluginEntry> = {}): AoiMcpPluginEntry {
  return {
    id: 'jira',
    name: 'Jira',
    description: 'Issue tracker',
    kind: 'connector',
    endpointUrl: 'https://mcp.example.com/jira',
    enabled: true,
    trusted: true,
    authMode: 'none',
    healthStatus: 'healthy',
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('createEmptyAoiMcpConnectorEntry', () => {
  it('defaults to an active, trusted connector with nothing callable yet', () => {
    expect(createEmptyAoiMcpConnectorEntry()).toEqual({
      id: '',
      name: '',
      endpointUrl: '',
      enabled: true,
      trusted: true,
      allowedTools: [],
      allowReadResource: false,
      allowPrivateHost: false,
    });
  });
});

describe('connectorEntryFromPluginAdmin', () => {
  it('maps a trusted, enabled http(s) plugin entry with empty tools', () => {
    expect(connectorEntryFromPluginAdmin(plugin())).toEqual({
      id: 'jira',
      name: 'Jira',
      endpointUrl: 'https://mcp.example.com/jira',
      enabled: true,
      trusted: true,
      allowedTools: [],
      allowReadResource: false,
      allowPrivateHost: false,
    });
  });

  it('canonicalizes a non-slug id', () => {
    expect(connectorEntryFromPluginAdmin(plugin({ id: 'My Cool MCP!' }))?.id).toBe('my-cool-mcp');
  });

  it('rejects untrusted, disabled, internal, and non-http entries', () => {
    expect(connectorEntryFromPluginAdmin(plugin({ trusted: false }))).toBeNull();
    expect(connectorEntryFromPluginAdmin(plugin({ enabled: false }))).toBeNull();
    expect(connectorEntryFromPluginAdmin(plugin({ endpointUrl: 'internal:aoi-ide' }))).toBeNull();
    expect(connectorEntryFromPluginAdmin(plugin({ endpointUrl: 'ftp://x/y' }))).toBeNull();
    expect(connectorEntryFromPluginAdmin(plugin({ endpointUrl: '' }))).toBeNull();
  });
});

describe('eligiblePluginAdminConnectorEntries', () => {
  it('filters ineligible entries and dedupes by canonical id', () => {
    const entries = eligiblePluginAdminConnectorEntries([
      plugin({ id: 'jira' }),
      plugin({ id: 'Jira', name: 'Jira dup' }), // canonical id collides with 'jira'
      plugin({ id: 'confluence', name: 'Confluence' }),
      plugin({ id: 'internal', endpointUrl: 'internal:aoi-ide' }),
      plugin({ id: 'untrusted', trusted: false }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['jira', 'confluence']);
  });
});

describe('mergePluginAdminConnectors', () => {
  it('appends new connectors and skips ids already present', () => {
    const existing: AoiMcpConnectorEntry[] = [
      {
        ...createEmptyAoiMcpConnectorEntry(),
        id: 'jira',
        name: 'Jira (edited)',
        endpointUrl: 'https://x/y',
      },
    ];
    const { entries, importedCount } = mergePluginAdminConnectors(existing, [
      plugin({ id: 'jira' }), // already present -> skipped (operator edit preserved)
      plugin({ id: 'confluence', name: 'Confluence' }),
    ]);
    expect(importedCount).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('Jira (edited)');
    expect(entries[1].id).toBe('confluence');
  });

  it('reports zero imports when nothing is eligible', () => {
    const { entries, importedCount } = mergePluginAdminConnectors(
      [],
      [plugin({ trusted: false }), plugin({ endpointUrl: 'internal:aoi-ide' })],
    );
    expect(importedCount).toBe(0);
    expect(entries).toHaveLength(0);
  });
});

describe('connectorEntriesToConfig', () => {
  it('drops endpoint-less rows, dedupes by id, and strips editor-only fields', () => {
    const drafts = [
      { ...createEmptyAoiMcpConnectorEntry(), id: 'jira', endpointUrl: 'https://x/y', __key: 'k1' },
      { ...createEmptyAoiMcpConnectorEntry(), id: 'no-endpoint', endpointUrl: '', __key: 'k2' },
      { ...createEmptyAoiMcpConnectorEntry(), id: 'jira', endpointUrl: 'https://x/z', __key: 'k3' },
    ] as unknown as AoiMcpConnectorEntry[];
    const config = connectorEntriesToConfig(drafts);
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors[0].id).toBe('jira');
    expect(config.connectors[0]).not.toHaveProperty('__key');
  });
});

describe('connectorHostStatus', () => {
  it('reports empty for a blank endpoint', () => {
    expect(connectorHostStatus('', false)).toEqual({ state: 'empty' });
  });

  it('reports ok with the resolved hostname for a public https endpoint', () => {
    expect(connectorHostStatus('https://mcp.example.com/jira', false)).toEqual({
      state: 'ok',
      hostname: 'mcp.example.com',
    });
  });

  it('blocks a private host unless allowPrivateHost is set', () => {
    const blocked = connectorHostStatus('http://10.0.0.5/mcp', false);
    expect(blocked.state).toBe('error');
    if (blocked.state === 'error') {
      expect(blocked.message).toMatch(/private/i);
    }
    expect(connectorHostStatus('http://10.0.0.5/mcp', true)).toEqual({
      state: 'ok',
      hostname: '10.0.0.5',
    });
  });

  it('reports an error for internal: and malformed endpoints', () => {
    expect(connectorHostStatus('internal:aoi-ide', false).state).toBe('error');
    expect(connectorHostStatus('not a url', false).state).toBe('error');
  });
});
