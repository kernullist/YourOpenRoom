import { promises as dns } from 'dns';

import { isAoiMcpConnectorPrivateAddress } from './aoiMcpConnectorRegistry';

// Server-only DNS-rebind / SSRF guard for a live MCP connector RPC.
//
// Why this is separate from aoiMcpConnectorRegistry.ts: the registry is pure and
// browser-safe (the policy that consumes it is reachable from the client bundle),
// so it can only do a LITERAL host check -- it never resolves DNS. That leaves a
// gap: a trusted connector whose endpoint hostname looks public but RESOLVES to a
// private / loopback / link-local / metadata address (a misconfiguration, or an
// active DNS-rebinding attack) passes the literal check, and the server then makes
// an SSRF request whose full body is handed back to the caller.
//
// This module closes that gap by resolving the endpoint hostname at execute time
// (only from the runner, which is server-only and already imports Node builtins)
// and re-checking EVERY resolved address with the registry's range classifier. The
// lookup is injectable so tests never touch real DNS.
//
// Residual risk (documented, not closed here): a TOCTOU window remains between this
// lookup and the fetch the transport performs, because fetch re-resolves the
// hostname. Fully closing it needs IP pinning (connect to the validated address
// while preserving Host / SNI), which the shared McpHttpClient does not support
// yet. The resolve-time re-check still raises the bar substantially: an attacker
// must win a sub-millisecond resolver race on every call.

export type AoiMcpConnectorDnsBlockReason =
  | 'invalid_url'
  | 'missing_host'
  | 'dns_resolution_failed'
  | 'dns_no_addresses'
  | 'resolved_private_host_blocked';

export type AoiMcpConnectorDnsCheck =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: AoiMcpConnectorDnsBlockReason; addresses: string[] };

// Resolve a hostname to its addresses. The default mirrors what the OS resolver
// (and thus fetch / undici) returns -- including /etc/hosts -- via getaddrinfo.
export type AoiMcpConnectorHostLookup = (hostname: string) => Promise<string[]>;

const defaultHostLookup: AoiMcpConnectorHostLookup = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

// Re-validate, at execute time, that an allow-listed endpoint still resolves only
// to public addresses. Returns a structured check so the runner can map a real
// private-address hit to a distinct block reason and fold transient failures into
// the generic execution failure.
export async function assertAoiMcpConnectorEndpointResolvesPublic(
  endpointUrl: string,
  options: { allowPrivateHost?: boolean; lookup?: AoiMcpConnectorHostLookup } = {},
): Promise<AoiMcpConnectorDnsCheck> {
  let hostname: string;
  try {
    hostname = new URL(endpointUrl).hostname;
  } catch {
    return { ok: false, reason: 'invalid_url', addresses: [] };
  }
  const bareHost = hostname.trim().replace(/^\[|\]$/g, '');
  if (!bareHost) {
    return { ok: false, reason: 'missing_host', addresses: [] };
  }

  // The operator explicitly opted this connector into private / loopback hosts, so
  // the resolve-time check is intentionally skipped (e.g. a local dev MCP server).
  if (options.allowPrivateHost) {
    return { ok: true, addresses: [] };
  }

  const lookup = options.lookup ?? defaultHostLookup;
  let resolved: string[];
  try {
    resolved = await lookup(bareHost);
  } catch {
    return { ok: false, reason: 'dns_resolution_failed', addresses: [] };
  }

  const addresses = [...new Set(resolved.map((address) => address.trim()).filter(Boolean))];
  if (addresses.length === 0) {
    return { ok: false, reason: 'dns_no_addresses', addresses: [] };
  }

  const offending = addresses.filter((address) => isAoiMcpConnectorPrivateAddress(address));
  if (offending.length > 0) {
    return { ok: false, reason: 'resolved_private_host_blocked', addresses: offending };
  }

  return { ok: true, addresses };
}
