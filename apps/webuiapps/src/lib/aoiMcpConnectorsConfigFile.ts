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

// Hard env gate for side-effecting (irreversible) live MCP RPC. OFF by default:
// only an explicit AOI_MCP_SIDE_EFFECTING_RPC=1 (or true/yes/on) unlocks eligibility,
// and even then a side-effecting call still needs the per-call irreversibility
// acknowledgment in the approved action (enforced by the connector-call policy). This
// is deliberately an env gate, not a config-file flag, so it cannot be flipped by the
// in-app settings UI or a persisted file an attacker might influence -- it requires
// operator access to the server environment. Default (unset) keeps every
// side-effecting tool hard-blocked with `side_effecting_live_rpc_not_enabled`.
export function isAoiSideEffectingLiveRpcEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.AOI_MCP_SIDE_EFFECTING_RPC ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
