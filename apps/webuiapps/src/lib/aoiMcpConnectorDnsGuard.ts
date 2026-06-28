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
// Residual risk (documented, DEFERRED by an explicit operator decision -- not closed
// here): a TOCTOU window remains between this lookup and the fetch the transport
// performs, because fetch re-resolves the hostname independently. Fully closing it
// needs IP pinning -- connect to the validated address while preserving Host / TLS
// SNI -- which plain fetch cannot express.
//
// The concrete remediation, for whoever picks this up:
//   1. Add `undici` as a dependency. It is NOT currently in the tree (not even
//      transitively), and Node does not expose it as a builtin (`node:undici` is
//      unknown), so there is no zero-dependency way to build a custom dispatcher.
//   2. Build an undici Agent whose `connect.lookup` resolves the hostname, re-checks
//      EVERY address with isAoiMcpConnectorPrivateAddress (as below), and pins the
//      connection to a validated address -- making validation and connect atomic.
//   3. Wire that dispatcher OPT-IN, on the connector RPC path ONLY. The McpHttpClient
//      is shared (cached per endpoint) with idaPePlugin, which talks to a LOCAL IDA
//      MCP server (a private/loopback host that MUST keep working) -- so the default
//      client/transport must stay on plain fetch; only the connector runner attaches
//      the validating dispatcher.
//
// Until then, this resolve-time re-check is the guard: it blocks the realistic
// misconfiguration (a trusted connector that resolves to a private address) and
// forces an attacker to win a sub-millisecond resolver race on every call. Side-
// effecting RPC is also OFF by default, so the exposed surface is a read-only SSRF.

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
