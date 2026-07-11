// Server-readable trusted-connector allow-list for Aoi live MCP RPC.
//
// Why this exists, and why it is separate from aoiMcpPluginAdmin.ts:
//   aoiMcpPluginAdmin.ts persists in localStorage and is therefore browser-only.
//   The server-side autonomy executor (aoiAutonomyExecution.ts, Node, via the
//   Vite plugin) cannot read localStorage, so it has no way to know which MCP
//   connectors the user trusts. A live server-side MCP RPC fired at an endpoint
//   the proposal supplied -- or at a connector the server cannot verify as
//   trusted -- is an SSRF / exfiltration hazard. This module backs a config-file
//   block (PersistedConfig.aoiMcpConnectors) that the server CAN read, and is the
//   single trust authority for live RPC: the endpoint is resolved from this
//   allow-list by id, never from the proposal.
//
// This module is pure and browser-safe (no Node 'crypto' / 'fs'): the policy that
// consumes it is reachable from the client bundle, the settings UI manages it,
// and the server passes the parsed config in. URL parsing uses the global URL
// constructor, which exists in both Node and the browser.
//
// Live-RPC safety model (this cut): only read-only tools are eligible for live
// execution. Each allow-list tool carries a readOnly flag; resources/read is
// inherently read-only and gated by allowReadResource. Side-effecting tools may
// be listed (so the policy can give a precise block reason) but are not eligible
// for live execution yet -- a later commit can hard-gate them. Endpoints must be
// http(s); 'internal:' bridge endpoints are not server-callable. Private,
// loopback, link-local, and metadata hosts are blocked unless the entry opts in
// via allowPrivateHost (best-effort literal check; full DNS-rebind protection
// would require server-side resolution at call time).

export interface AoiMcpConnectorTool {
  name: string;
  // readOnly tools have no external side effect and are eligible for live RPC.
  readOnly: boolean;
  // P2.6: a short, human-declared compensating action (how the side effect is undone) for a
  // side-effecting tool. Required before a side-effecting tool is eligible for a live call --
  // an effect that cannot be bounded/rolled back stays blocked. Ignored for read-only tools.
  compensatingAction?: string;
}

export interface AoiMcpConnectorEntry {
  id: string;
  name: string;
  endpointUrl: string;
  enabled: boolean;
  trusted: boolean;
  allowedTools: AoiMcpConnectorTool[];
  // Permit the resources/read RPC (inherently read-only) on this connector.
  allowReadResource: boolean;
  // Opt in to private / loopback / link-local endpoint hosts. Default false so
  // a careless or compromised config cannot turn the server into an SSRF proxy.
  allowPrivateHost: boolean;
}

export interface AoiMcpConnectorsConfig {
  connectors: AoiMcpConnectorEntry[];
}

export type AoiMcpConnectorHostReason =
  | 'missing_endpoint'
  | 'invalid_url'
  | 'internal_endpoint_not_server_callable'
  | 'unsupported_protocol'
  | 'missing_host'
  | 'private_host_blocked';

export type AoiMcpConnectorHostCheck =
  | { ok: true; normalizedEndpoint: string; hostname: string }
  | { ok: false; reason: AoiMcpConnectorHostReason };

export interface AoiMcpConnectorToolClassification {
  allowed: boolean;
  readOnly: boolean;
  reason?: 'tool_not_allow_listed' | 'read_resource_not_allowed' | 'missing_tool_name';
  // P2.6: the tool's declared compensating action (undo path), surfaced so the call policy can
  // require it before a side-effecting tool is eligible. Absent for read-only / unknown tools.
  compensatingAction?: string;
}

export const AOI_MCP_READ_RESOURCE_METHOD = 'resources/read';

const MAX_CONNECTORS = 32;
const MAX_TOOLS_PER_CONNECTOR = 64;
const MAX_ID_CHARS = 64;
const MAX_NAME_CHARS = 90;
const MAX_TOOL_NAME_CHARS = 120;

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

// Canonical connector id derived from any reference string. Exported so the
// approved-connector-call policy can bind its content-addressed fingerprint to a
// stable key (the same canonical id whether or not the allow-list resolves at the
// time), keeping accept-time and execute-time bindings identical.
export function canonicalAoiMcpConnectorId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_ID_CHARS) || 'connector'
  );
}

// Best-effort literal classification of private / loopback / link-local / unique
// local / metadata hosts. No DNS resolution (pure module); the runner can add a
// resolve-time check later for DNS-rebind hardening.
function isLikelyPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) {
    return true;
  }

  // IPv4-mapped IPv6 (e.g. '::ffff:10.0.0.5'): classify by the embedded IPv4 so a
  // resolver returning a mapped address cannot slip a private range past the check.
  const mappedV4 = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedV4) {
    return isLikelyPrivateOrLoopbackHost(mappedV4[1]);
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host === '::1' || host === '::') {
    return true;
  }
  if (host.includes(':')) {
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
      return true;
    }
    return false;
  }

  // IPv4 literal ranges.
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
    const nums = octets.map((part) => Number.parseInt(part, 10));
    if (nums.some((value) => value > 255)) {
      return true;
    }
    const [a, b] = nums;
    if (a === 0 || a === 127 || a === 10) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    // Carrier-grade NAT 100.64.0.0/10.
    if (a === 100 && b >= 64 && b <= 127) {
      return true;
    }
  }

  return false;
}

// Public classifier for a resolved IP address (or any host literal): true when the
// address falls in a private / loopback / link-local / unique-local / carrier-grade
// NAT / metadata range. The server-only DNS guard (aoiMcpConnectorDnsGuard) re-checks
// every address an endpoint hostname resolves to, closing the gap this module's
// literal check leaves open against a hostname that resolves to a private address
// (DNS rebinding). Stays pure / browser-safe; the guard owns the Node 'dns' import.
export function isAoiMcpConnectorPrivateAddress(address: string): boolean {
  return isLikelyPrivateOrLoopbackHost(address);
}

// Validate that an endpoint is server-callable and not an SSRF hazard. Used at
// config-normalization time and again by the runner before any live RPC.
export function validateAoiMcpConnectorEndpointHost(
  endpointUrl: string,
  options: { allowPrivateHost?: boolean } = {},
): AoiMcpConnectorHostCheck {
  const trimmed = (endpointUrl ?? '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'missing_endpoint' };
  }
  if (trimmed.toLowerCase().startsWith('internal:')) {
    return { ok: false, reason: 'internal_endpoint_not_server_callable' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'missing_host' };
  }
  if (!options.allowPrivateHost && isLikelyPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: 'private_host_blocked' };
  }

  return {
    ok: true,
    normalizedEndpoint: trimmed.replace(/\/+$/, '') || trimmed,
    hostname: parsed.hostname.toLowerCase(),
  };
}

function normalizeConnectorTool(value: unknown): AoiMcpConnectorTool | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiMcpConnectorTool>;
  const name =
    typeof record.name === 'string' ? record.name.trim().slice(0, MAX_TOOL_NAME_CHARS) : '';
  if (!name) {
    return null;
  }
  const compensatingAction =
    typeof record.compensatingAction === 'string'
      ? record.compensatingAction.replace(/\s+/g, ' ').trim().slice(0, 240)
      : '';
  return {
    name,
    readOnly: record.readOnly === true,
    ...(compensatingAction ? { compensatingAction } : {}),
  };
}

function normalizeConnectorTools(value: unknown): AoiMcpConnectorTool[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byName = new Map<string, AoiMcpConnectorTool>();
  for (const raw of value) {
    const tool = normalizeConnectorTool(raw);
    if (!tool) {
      continue;
    }
    // Last write wins, but a read-only flag is never silently downgraded by a
    // later duplicate that forgot to set it.
    const existing = byName.get(tool.name);
    const compensatingAction = tool.compensatingAction ?? existing?.compensatingAction;
    byName.set(tool.name, {
      name: tool.name,
      readOnly: tool.readOnly || Boolean(existing?.readOnly),
      ...(compensatingAction ? { compensatingAction } : {}),
    });
    if (byName.size >= MAX_TOOLS_PER_CONNECTOR) {
      break;
    }
  }
  return Array.from(byName.values());
}

export function normalizeAoiMcpConnectorEntry(value: unknown): AoiMcpConnectorEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiMcpConnectorEntry>;
  const name = truncateSingleLine(
    typeof record.name === 'string' ? record.name : '',
    MAX_NAME_CHARS,
  );
  const endpointUrl = typeof record.endpointUrl === 'string' ? record.endpointUrl.trim() : '';
  if (!endpointUrl) {
    return null;
  }
  const rawId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : name;
  const id = canonicalAoiMcpConnectorId(rawId);
  return {
    id,
    name: name || id,
    endpointUrl,
    enabled: record.enabled === true,
    trusted: record.trusted === true,
    allowedTools: normalizeConnectorTools(record.allowedTools),
    allowReadResource: record.allowReadResource === true,
    allowPrivateHost: record.allowPrivateHost === true,
  };
}

export function normalizeAoiMcpConnectorsConfig(
  raw: Partial<AoiMcpConnectorsConfig> | null | undefined,
): AoiMcpConnectorsConfig {
  const entries = Array.isArray(raw?.connectors) ? raw.connectors : [];
  const byId = new Map<string, AoiMcpConnectorEntry>();
  for (const candidate of entries) {
    const normalized = normalizeAoiMcpConnectorEntry(candidate);
    if (!normalized) {
      continue;
    }
    byId.set(normalized.id, normalized);
    if (byId.size >= MAX_CONNECTORS) {
      break;
    }
  }
  return { connectors: Array.from(byId.values()) };
}

// A connector is server-callable for live RPC only when it is enabled, trusted,
// and its endpoint passes host validation. This is the gate the runner repeats.
export function isAoiMcpConnectorServerCallable(entry: AoiMcpConnectorEntry): boolean {
  if (!entry.enabled || !entry.trusted) {
    return false;
  }
  return validateAoiMcpConnectorEndpointHost(entry.endpointUrl, {
    allowPrivateHost: entry.allowPrivateHost,
  }).ok;
}

// Resolve a connector reference (its id) against the trusted allow-list. Returns
// the entry only when it is server-callable; the endpoint is therefore never
// proposal-controlled. Returns null for an unknown / disabled / untrusted /
// non-server-callable reference.
export function resolveTrustedAoiMcpConnector(
  config: AoiMcpConnectorsConfig | null | undefined,
  connectorRef: string,
): AoiMcpConnectorEntry | null {
  const ref = (connectorRef ?? '').trim();
  if (!ref || !config) {
    return null;
  }
  const target = canonicalAoiMcpConnectorId(ref);
  const entry = config.connectors.find((candidate) => candidate.id === target);
  if (!entry || !isAoiMcpConnectorServerCallable(entry)) {
    return null;
  }
  return entry;
}

// Classify a requested tool against a connector's allow-list. resources/read is
// treated as an inherently read-only operation gated by allowReadResource.
export function classifyAoiMcpConnectorTool(
  entry: AoiMcpConnectorEntry,
  toolName: string,
): AoiMcpConnectorToolClassification {
  const name = (toolName ?? '').trim();
  if (!name) {
    return { allowed: false, readOnly: false, reason: 'missing_tool_name' };
  }
  if (name === AOI_MCP_READ_RESOURCE_METHOD) {
    return entry.allowReadResource
      ? { allowed: true, readOnly: true }
      : { allowed: false, readOnly: true, reason: 'read_resource_not_allowed' };
  }
  const tool = entry.allowedTools.find((candidate) => candidate.name === name);
  if (!tool) {
    return { allowed: false, readOnly: false, reason: 'tool_not_allow_listed' };
  }
  return {
    allowed: true,
    readOnly: tool.readOnly,
    ...(tool.compensatingAction ? { compensatingAction: tool.compensatingAction } : {}),
  };
}

export function summarizeAoiMcpConnectorsConfig(
  config: AoiMcpConnectorsConfig | null | undefined,
): {
  total: number;
  serverCallable: number;
  readOnlyTools: number;
} {
  const connectors = config?.connectors ?? [];
  let serverCallable = 0;
  let readOnlyTools = 0;
  for (const entry of connectors) {
    if (isAoiMcpConnectorServerCallable(entry)) {
      serverCallable += 1;
    }
    readOnlyTools += entry.allowedTools.filter((tool) => tool.readOnly).length;
    if (entry.allowReadResource) {
      readOnlyTools += 1;
    }
  }
  return { total: connectors.length, serverCallable, readOnlyTools };
}

export interface AoiMcpConnectorCatalogEntry {
  connectorRef: string;
  name: string;
  // Live-eligible (read-only) tool names; side-effecting tools are omitted.
  readOnlyTools: string[];
  // True when resources/read (inherently read-only) is permitted on this connector.
  allowReadResource: boolean;
}

// Catalog of server-callable connectors and their live-eligible (read-only) tools,
// for offering to the LLM reflection driver so it can propose a connector_call.
// Only read-only tools (and the gated resources/read) are listed -- side-effecting
// tools are omitted so the model is never shown a tool it cannot run live, and a
// connector with nothing live (no read-only tool and no resources/read) is excluded
// entirely. This is the same trust gate the policy/runner enforce, so anything in
// the catalog is guaranteed to pass the live_read_only routing.
export function buildAoiMcpConnectorCatalog(
  config: AoiMcpConnectorsConfig | null | undefined,
): AoiMcpConnectorCatalogEntry[] {
  const catalog: AoiMcpConnectorCatalogEntry[] = [];
  for (const entry of config?.connectors ?? []) {
    if (!isAoiMcpConnectorServerCallable(entry)) {
      continue;
    }
    const readOnlyTools = entry.allowedTools
      .filter((tool) => tool.readOnly)
      .map((tool) => tool.name);
    if (readOnlyTools.length === 0 && !entry.allowReadResource) {
      continue;
    }
    catalog.push({
      connectorRef: entry.id,
      name: entry.name,
      readOnlyTools,
      allowReadResource: entry.allowReadResource,
    });
  }
  return catalog;
}
