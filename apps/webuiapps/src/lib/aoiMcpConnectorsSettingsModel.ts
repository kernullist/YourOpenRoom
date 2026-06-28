import {
  canonicalAoiMcpConnectorId,
  normalizeAoiMcpConnectorsConfig,
  validateAoiMcpConnectorEndpointHost,
  type AoiMcpConnectorEntry,
  type AoiMcpConnectorsConfig,
  type AoiMcpConnectorHostReason,
} from './aoiMcpConnectorRegistry';
import type { AoiMcpPluginEntry } from './aoiMcpPluginAdmin';

// Pure, browser-safe editor model for the Trusted MCP Connectors settings panel.
// The React component owns local state + list keys; this module owns the data
// transforms so they can be unit-tested without a DOM: a blank editable entry,
// plugin-admin import mapping, draft -> persisted-config conversion, and inline
// host validation status.

export function createEmptyAoiMcpConnectorEntry(): AoiMcpConnectorEntry {
  return {
    id: '',
    name: '',
    endpointUrl: '',
    // A connector is added to a TRUSTED allow-list deliberately, and an untrusted
    // or disabled connector is inert (resolveTrustedAoiMcpConnector needs both),
    // so default to active; the operator can flip either toggle. Tools default to
    // none and read-resource / private-host stay OFF -- nothing runs live until
    // the operator explicitly allow-lists a read-only tool.
    enabled: true,
    trusted: true,
    allowedTools: [],
    allowReadResource: false,
    allowPrivateHost: false,
  };
}

// Map a plugin-admin entry (localStorage, aoiMcpPluginAdmin) to a connector
// allow-list entry, or null when it is not eligible. Only trusted + enabled +
// http(s) endpoints qualify; internal: bridges and untrusted/disabled entries are
// skipped. Tools start empty so nothing is callable until the operator allow-lists
// specific read-only tools -- the import is safe by default.
export function connectorEntryFromPluginAdmin(
  plugin: AoiMcpPluginEntry,
): AoiMcpConnectorEntry | null {
  if (!plugin.enabled || !plugin.trusted) {
    return null;
  }
  const endpointUrl = (plugin.endpointUrl ?? '').trim();
  if (!endpointUrl || !/^https?:\/\//i.test(endpointUrl)) {
    return null;
  }
  return {
    id: canonicalAoiMcpConnectorId(plugin.id || plugin.name),
    name: plugin.name || plugin.id,
    endpointUrl,
    enabled: true,
    trusted: true,
    allowedTools: [],
    allowReadResource: false,
    allowPrivateHost: false,
  };
}

export function eligiblePluginAdminConnectorEntries(
  plugins: AoiMcpPluginEntry[],
): AoiMcpConnectorEntry[] {
  const byId = new Map<string, AoiMcpConnectorEntry>();
  for (const plugin of plugins) {
    const entry = connectorEntryFromPluginAdmin(plugin);
    if (entry && !byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values());
}

// Merge eligible plugin-admin connectors into the current editable list, skipping
// any whose canonical id already exists so an operator's edits are never clobbered.
export function mergePluginAdminConnectors(
  existing: AoiMcpConnectorEntry[],
  plugins: AoiMcpPluginEntry[],
): { entries: AoiMcpConnectorEntry[]; importedCount: number } {
  const present = new Set(
    existing.map((entry) => canonicalAoiMcpConnectorId(entry.id || entry.name)),
  );
  const imported: AoiMcpConnectorEntry[] = [];
  for (const candidate of eligiblePluginAdminConnectorEntries(plugins)) {
    if (!present.has(candidate.id)) {
      present.add(candidate.id);
      imported.push(candidate);
    }
  }
  return { entries: [...existing, ...imported], importedCount: imported.length };
}

// Convert the editable entries to the persisted config shape. Normalization drops
// endpoint-less rows, dedupes by canonical id, and strips any non-config fields
// (e.g. a list key) the editor may have attached.
export function connectorEntriesToConfig(entries: AoiMcpConnectorEntry[]): AoiMcpConnectorsConfig {
  return normalizeAoiMcpConnectorsConfig({ connectors: entries });
}

export type AoiMcpConnectorHostStatus =
  | { state: 'empty' }
  | { state: 'ok'; hostname: string }
  | { state: 'error'; message: string };

const HOST_REASON_LABEL: Record<AoiMcpConnectorHostReason, string> = {
  missing_endpoint: 'Endpoint is required.',
  invalid_url: 'Not a valid URL.',
  internal_endpoint_not_server_callable: 'internal: endpoints are not server-callable.',
  unsupported_protocol: 'Endpoint must use http:// or https://.',
  missing_host: 'Endpoint has no host.',
  private_host_blocked: 'Private/loopback host blocked. Enable "Allow private host" to permit it.',
};

// Inline status for the endpoint field, mirroring the server-side host gate so the
// operator sees an SSRF rejection (e.g. a private host) before saving.
export function connectorHostStatus(
  endpointUrl: string,
  allowPrivateHost: boolean,
): AoiMcpConnectorHostStatus {
  if (!endpointUrl.trim()) {
    return { state: 'empty' };
  }
  const check = validateAoiMcpConnectorEndpointHost(endpointUrl, { allowPrivateHost });
  if (check.ok) {
    return { state: 'ok', hostname: check.hostname };
  }
  return { state: 'error', message: HOST_REASON_LABEL[check.reason] };
}
