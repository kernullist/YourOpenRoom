import { describe, expect, it } from 'vitest';

import {
  AOI_MCP_READ_RESOURCE_METHOD,
  buildAoiMcpConnectorCatalog,
  classifyAoiMcpConnectorTool,
  isAoiMcpConnectorPrivateAddress,
  isAoiMcpConnectorServerCallable,
  normalizeAoiMcpConnectorEntry,
  normalizeAoiMcpConnectorsConfig,
  resolveTrustedAoiMcpConnector,
  summarizeAoiMcpConnectorsConfig,
  validateAoiMcpConnectorEndpointHost,
  type AoiMcpConnectorEntry,
} from '../aoiMcpConnectorRegistry';

function makeEntry(overrides: Partial<AoiMcpConnectorEntry> = {}): AoiMcpConnectorEntry {
  return {
    id: 'jira',
    name: 'Jira',
    endpointUrl: 'https://mcp.example.com/jira',
    enabled: true,
    trusted: true,
    allowedTools: [
      { name: 'search_issues', readOnly: true },
      { name: 'create_issue', readOnly: false },
    ],
    allowReadResource: true,
    allowPrivateHost: false,
    ...overrides,
  };
}

describe('validateAoiMcpConnectorEndpointHost', () => {
  it('accepts a public https endpoint and strips a trailing slash', () => {
    const result = validateAoiMcpConnectorEndpointHost('https://mcp.example.com/jira/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedEndpoint).toBe('https://mcp.example.com/jira');
      expect(result.hostname).toBe('mcp.example.com');
    }
  });

  it('rejects an internal: bridge endpoint as not server-callable', () => {
    const result = validateAoiMcpConnectorEndpointHost('internal:aoi-ide');
    expect(result).toEqual({ ok: false, reason: 'internal_endpoint_not_server_callable' });
  });

  it('rejects an empty, malformed, or non-http endpoint', () => {
    expect(validateAoiMcpConnectorEndpointHost('')).toEqual({
      ok: false,
      reason: 'missing_endpoint',
    });
    expect(validateAoiMcpConnectorEndpointHost('not a url')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
    expect(validateAoiMcpConnectorEndpointHost('ftp://mcp.example.com')).toEqual({
      ok: false,
      reason: 'unsupported_protocol',
    });
  });

  it('blocks loopback, private, link-local, and IPv6 local hosts by default (SSRF)', () => {
    const blocked = [
      'http://localhost:9000/mcp',
      'http://127.0.0.1/mcp',
      'http://10.1.2.3/mcp',
      'http://192.168.0.5/mcp',
      'http://172.16.0.9/mcp',
      'http://172.31.255.1/mcp',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://nas.local/mcp',
      'http://api.internal/mcp',
      'http://[::1]/mcp',
      'http://[fd00::1]/mcp',
      'http://[fe80::1]/mcp',
    ];
    for (const endpoint of blocked) {
      expect(validateAoiMcpConnectorEndpointHost(endpoint)).toEqual({
        ok: false,
        reason: 'private_host_blocked',
      });
    }
  });

  it('does not block 172.x outside the 16-31 private band', () => {
    expect(validateAoiMcpConnectorEndpointHost('http://172.15.0.1/mcp').ok).toBe(true);
    expect(validateAoiMcpConnectorEndpointHost('http://172.32.0.1/mcp').ok).toBe(true);
  });

  it('allows a private host only when the entry opts in', () => {
    expect(
      validateAoiMcpConnectorEndpointHost('http://127.0.0.1:9000/mcp', { allowPrivateHost: true })
        .ok,
    ).toBe(true);
  });
});

describe('isAoiMcpConnectorPrivateAddress', () => {
  it('flags loopback, private, link-local, CGNAT, and metadata IPv4 addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
    ]) {
      expect(isAoiMcpConnectorPrivateAddress(address)).toBe(true);
    }
  });

  it('flags loopback, unique-local, and link-local IPv6 addresses', () => {
    for (const address of ['::1', '::', 'fd00::1', 'fc00::abcd', 'fe80::1']) {
      expect(isAoiMcpConnectorPrivateAddress(address)).toBe(true);
    }
  });

  it('flags IPv4-mapped IPv6 forms of a private address (no bypass)', () => {
    expect(isAoiMcpConnectorPrivateAddress('::ffff:10.0.0.5')).toBe(true);
    expect(isAoiMcpConnectorPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    // A public IPv4 mapped into IPv6 stays public.
    expect(isAoiMcpConnectorPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('does not flag public IPv4 / IPv6 addresses', () => {
    expect(isAoiMcpConnectorPrivateAddress('8.8.8.8')).toBe(false);
    expect(isAoiMcpConnectorPrivateAddress('93.184.216.34')).toBe(false);
    expect(isAoiMcpConnectorPrivateAddress('172.32.0.1')).toBe(false);
    expect(isAoiMcpConnectorPrivateAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('normalizeAoiMcpConnectorsConfig', () => {
  it('drops entries without an endpoint and dedupes by id', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [
        makeEntry({ id: 'jira', name: 'Jira A' }),
        makeEntry({ id: 'jira', name: 'Jira B' }),
        { name: 'no endpoint' } as unknown as AoiMcpConnectorEntry,
      ],
    });
    expect(config.connectors).toHaveLength(1);
    // Last write wins on duplicate id.
    expect(config.connectors[0].name).toBe('Jira B');
  });

  it('dedupes tools and never downgrades a read-only flag', () => {
    const entry = normalizeAoiMcpConnectorEntry({
      id: 'svc',
      name: 'Svc',
      endpointUrl: 'https://mcp.example.com',
      enabled: true,
      trusted: true,
      allowedTools: [
        { name: 'fetch', readOnly: true },
        { name: 'fetch', readOnly: false },
      ],
      allowReadResource: false,
      allowPrivateHost: false,
    });
    expect(entry).not.toBeNull();
    expect(entry?.allowedTools).toHaveLength(1);
    expect(entry?.allowedTools[0]).toEqual({ name: 'fetch', readOnly: true });
  });

  it('treats missing booleans as false', () => {
    const entry = normalizeAoiMcpConnectorEntry({
      id: 'svc',
      name: 'Svc',
      endpointUrl: 'https://mcp.example.com',
    });
    expect(entry?.enabled).toBe(false);
    expect(entry?.trusted).toBe(false);
    expect(entry?.allowReadResource).toBe(false);
    expect(entry?.allowPrivateHost).toBe(false);
  });
});

describe('isAoiMcpConnectorServerCallable / resolveTrustedAoiMcpConnector', () => {
  it('requires enabled, trusted, and a valid public host', () => {
    expect(isAoiMcpConnectorServerCallable(makeEntry())).toBe(true);
    expect(isAoiMcpConnectorServerCallable(makeEntry({ enabled: false }))).toBe(false);
    expect(isAoiMcpConnectorServerCallable(makeEntry({ trusted: false }))).toBe(false);
    expect(
      isAoiMcpConnectorServerCallable(makeEntry({ endpointUrl: 'http://127.0.0.1/mcp' })),
    ).toBe(false);
    expect(
      isAoiMcpConnectorServerCallable(
        makeEntry({ endpointUrl: 'http://127.0.0.1/mcp', allowPrivateHost: true }),
      ),
    ).toBe(true);
    expect(isAoiMcpConnectorServerCallable(makeEntry({ endpointUrl: 'internal:aoi-ide' }))).toBe(
      false,
    );
  });

  it('resolves a trusted connector by id and rejects untrusted/unknown refs', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [makeEntry({ id: 'jira' }), makeEntry({ id: 'slack', trusted: false })],
    });
    expect(resolveTrustedAoiMcpConnector(config, 'jira')?.id).toBe('jira');
    expect(resolveTrustedAoiMcpConnector(config, 'slack')).toBeNull();
    expect(resolveTrustedAoiMcpConnector(config, 'unknown')).toBeNull();
    expect(resolveTrustedAoiMcpConnector(config, '')).toBeNull();
    expect(resolveTrustedAoiMcpConnector(null, 'jira')).toBeNull();
  });
});

describe('classifyAoiMcpConnectorTool', () => {
  const entry = makeEntry();

  it('classifies an allow-listed read-only tool as live-eligible', () => {
    expect(classifyAoiMcpConnectorTool(entry, 'search_issues')).toEqual({
      allowed: true,
      readOnly: true,
    });
  });

  it('classifies an allow-listed side-effecting tool as allowed but not read-only', () => {
    expect(classifyAoiMcpConnectorTool(entry, 'create_issue')).toEqual({
      allowed: true,
      readOnly: false,
    });
  });

  it('gates resources/read on allowReadResource', () => {
    expect(classifyAoiMcpConnectorTool(entry, AOI_MCP_READ_RESOURCE_METHOD)).toEqual({
      allowed: true,
      readOnly: true,
    });
    expect(
      classifyAoiMcpConnectorTool(
        makeEntry({ allowReadResource: false }),
        AOI_MCP_READ_RESOURCE_METHOD,
      ),
    ).toEqual({ allowed: false, readOnly: true, reason: 'read_resource_not_allowed' });
  });

  it('rejects an unknown tool and a missing name', () => {
    expect(classifyAoiMcpConnectorTool(entry, 'delete_everything')).toEqual({
      allowed: false,
      readOnly: false,
      reason: 'tool_not_allow_listed',
    });
    expect(classifyAoiMcpConnectorTool(entry, '   ')).toEqual({
      allowed: false,
      readOnly: false,
      reason: 'missing_tool_name',
    });
  });
});

describe('summarizeAoiMcpConnectorsConfig', () => {
  it('counts total, server-callable, and read-only tool surface', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [makeEntry({ id: 'jira' }), makeEntry({ id: 'slack', trusted: false })],
    });
    const summary = summarizeAoiMcpConnectorsConfig(config);
    expect(summary.total).toBe(2);
    expect(summary.serverCallable).toBe(1);
    // Each entry: 1 read-only tool (search_issues) + allowReadResource.
    expect(summary.readOnlyTools).toBe(4);
  });
});

describe('buildAoiMcpConnectorCatalog', () => {
  it('lists server-callable connectors with only their read-only tools', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [
        makeEntry({
          id: 'jira',
          name: 'Jira',
          allowedTools: [
            { name: 'search_issues', readOnly: true },
            { name: 'create_issue', readOnly: false },
          ],
          allowReadResource: true,
        }),
      ],
    });
    expect(buildAoiMcpConnectorCatalog(config)).toEqual([
      {
        connectorRef: 'jira',
        name: 'Jira',
        readOnlyTools: ['search_issues'],
        allowReadResource: true,
      },
    ]);
  });

  it('excludes untrusted, disabled, and non-server-callable connectors', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [
        makeEntry({ id: 'untrusted', trusted: false }),
        makeEntry({ id: 'disabled', enabled: false }),
        makeEntry({ id: 'private', endpointUrl: 'http://10.0.0.5/mcp', allowPrivateHost: false }),
      ],
    });
    expect(buildAoiMcpConnectorCatalog(config)).toEqual([]);
  });

  it('excludes a connector with only side-effecting tools and no resources/read', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [
        makeEntry({
          id: 'writeonly',
          allowedTools: [{ name: 'create_issue', readOnly: false }],
          allowReadResource: false,
        }),
      ],
    });
    expect(buildAoiMcpConnectorCatalog(config)).toEqual([]);
  });

  it('includes a connector with no read-only tools but resources/read enabled', () => {
    const config = normalizeAoiMcpConnectorsConfig({
      connectors: [
        makeEntry({
          id: 'resourceonly',
          name: 'Resource Only',
          allowedTools: [{ name: 'create_issue', readOnly: false }],
          allowReadResource: true,
        }),
      ],
    });
    expect(buildAoiMcpConnectorCatalog(config)).toEqual([
      {
        connectorRef: 'resourceonly',
        name: 'Resource Only',
        readOnlyTools: [],
        allowReadResource: true,
      },
    ]);
  });
});
