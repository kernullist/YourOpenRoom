import * as fs from 'fs';

import {
  normalizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorsConfig,
} from './aoiMcpConnectorRegistry';

// Server-only loader for the trusted MCP connector allow-list from the persisted
// config file (PersistedConfig.aoiMcpConnectors). Shared by the autonomy execution
// layer (the SINGLE trust source for a live connector RPC -- the endpoint is
// resolved by id from here, never from a proposal) and the scheduler (so the LLM
// reflection prompt can offer the operator's read-only connector tools). Leaf
// module: imports only 'fs' + the pure registry, so it cannot create an import
// cycle. Fail-closed to an empty list when the file is missing or unreadable.
export function loadAoiMcpConnectorsFromConfigFile(configFile: string): AoiMcpConnectorsConfig {
  try {
    if (!configFile || !fs.existsSync(configFile)) {
      return { connectors: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
      aoiMcpConnectors?: unknown;
    } | null;
    const raw =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed.aoiMcpConnectors as Partial<AoiMcpConnectorsConfig> | undefined)
        : undefined;
    return normalizeAoiMcpConnectorsConfig(raw ?? null);
  } catch {
    return { connectors: [] };
  }
}
