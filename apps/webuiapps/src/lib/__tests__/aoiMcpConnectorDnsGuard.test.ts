import { describe, expect, it } from 'vitest';

import {
  assertAoiMcpConnectorEndpointResolvesPublic,
  buildAoiMcpConnectorPinnedDispatcher,
  createAoiPinnedConnectLookup,
  pinAoiMcpConnectorAddress,
  type AoiMcpConnectorAddressRecord,
} from '../aoiMcpConnectorDnsGuard';

const PUBLIC: AoiMcpConnectorAddressRecord = { address: '93.184.216.34', family: 4 };
const PRIVATE: AoiMcpConnectorAddressRecord = { address: '10.0.0.5', family: 4 };
const LOOPBACK: AoiMcpConnectorAddressRecord = { address: '127.0.0.1', family: 4 };
const METADATA: AoiMcpConnectorAddressRecord = { address: '169.254.169.254', family: 4 };

// Drive the node-style lookup and resolve the (err, address, family) it hands back.
function runLookup(
  lookup: ReturnType<typeof createAoiPinnedConnectLookup>,
  hostname: string,
): Promise<{ error: Error | null; address: string; family: number }> {
  return new Promise((resolve) => {
    lookup(hostname, {}, (error, address, family) => resolve({ error, address, family }));
  });
}

describe('pinAoiMcpConnectorAddress (P2.5)', () => {
  it('pins the first address when every resolved address is public', () => {
    expect(pinAoiMcpConnectorAddress([PUBLIC, { address: '1.1.1.1', family: 4 }], false)).toEqual({
      ok: true,
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('fails closed when ANY resolved address is private/loopback/metadata', () => {
    expect(pinAoiMcpConnectorAddress([PUBLIC, PRIVATE], false)).toEqual({
      ok: false,
      reason: 'resolved_private_host_blocked',
    });
    expect(pinAoiMcpConnectorAddress([LOOPBACK], false).ok).toBe(false);
    expect(pinAoiMcpConnectorAddress([METADATA], false).ok).toBe(false);
  });

  it('fails closed on an empty answer', () => {
    expect(pinAoiMcpConnectorAddress([], false)).toEqual({ ok: false, reason: 'dns_no_addresses' });
  });

  it('allowPrivateHost skips the range check (operator-opted local host)', () => {
    expect(pinAoiMcpConnectorAddress([PRIVATE], true)).toEqual({
      ok: true,
      address: '10.0.0.5',
      family: 4,
    });
  });
});

describe('createAoiPinnedConnectLookup (P2.5, closes the TOCTOU)', () => {
  it('hands the socket a validated pinned address for a public host', async () => {
    const lookup = createAoiPinnedConnectLookup({ resolveAddresses: async () => [PUBLIC] });
    const result = await runLookup(lookup, 'example.com');
    expect(result.error).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('fails the connect when the host resolves to a private address (rebind blocked)', async () => {
    const lookup = createAoiPinnedConnectLookup({
      resolveAddresses: async () => [PUBLIC, PRIVATE],
    });
    const result = await runLookup(lookup, 'rebind.example.com');
    expect(result.error?.message).toContain('resolved_private_host_blocked');
    expect(result.address).toBe('');
  });

  it('fails the connect when resolution throws', async () => {
    const lookup = createAoiPinnedConnectLookup({
      resolveAddresses: async () => {
        throw new Error('boom');
      },
    });
    const result = await runLookup(lookup, 'broken.example.com');
    expect(result.error).toBeInstanceOf(Error);
  });

  it('fails the connect on an empty answer', async () => {
    const lookup = createAoiPinnedConnectLookup({ resolveAddresses: async () => [] });
    const result = await runLookup(lookup, 'empty.example.com');
    expect(result.error?.message).toContain('dns_no_addresses');
  });

  it('allowPrivateHost pins the private address (local dev opt-in)', async () => {
    const lookup = createAoiPinnedConnectLookup({
      allowPrivateHost: true,
      resolveAddresses: async () => [LOOPBACK],
    });
    const result = await runLookup(lookup, 'localhost');
    expect(result.error).toBeNull();
    expect(result.address).toBe('127.0.0.1');
  });
});

describe('buildAoiMcpConnectorPinnedDispatcher (P2.5)', () => {
  it('returns an undici Agent (a dispatcher with a dispatch method)', () => {
    const dispatcher = buildAoiMcpConnectorPinnedDispatcher({
      resolveAddresses: async () => [PUBLIC],
    });
    expect(typeof (dispatcher as { dispatch?: unknown }).dispatch).toBe('function');
  });
});

describe('assertAoiMcpConnectorEndpointResolvesPublic (existing resolve-time backstop)', () => {
  it('blocks an endpoint that resolves to a private address', async () => {
    const check = await assertAoiMcpConnectorEndpointResolvesPublic(
      'https://rebind.example.com/mcp',
      {
        lookup: async () => ['10.0.0.5'],
      },
    );
    expect(check).toMatchObject({ ok: false, reason: 'resolved_private_host_blocked' });
  });

  it('allows a public endpoint', async () => {
    const check = await assertAoiMcpConnectorEndpointResolvesPublic('https://example.com/mcp', {
      lookup: async () => ['93.184.216.34'],
    });
    expect(check.ok).toBe(true);
  });
});
