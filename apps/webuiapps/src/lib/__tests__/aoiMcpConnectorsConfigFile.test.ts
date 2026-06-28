import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isAoiSideEffectingLiveRpcEnabled,
  loadAoiMcpConnectorsFromConfigFile,
} from '../aoiMcpConnectorsConfigFile';

const tempRoots: string[] = [];

function makeConfigFile(contents: unknown): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-connectors-config-'));
  tempRoots.push(root);
  const file = join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify(contents), 'utf-8');
  return file;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('loadAoiMcpConnectorsFromConfigFile', () => {
  it('loads and normalizes the aoiMcpConnectors block', () => {
    const file = makeConfigFile({
      llm: { provider: 'openrouter' },
      aoiMcpConnectors: {
        connectors: [
          {
            id: 'jira',
            name: 'Jira',
            endpointUrl: 'https://mcp.example.com/jira',
            enabled: true,
            trusted: true,
            allowedTools: [{ name: 'search_issues', readOnly: true }],
            allowReadResource: true,
            allowPrivateHost: false,
          },
        ],
      },
    });
    const config = loadAoiMcpConnectorsFromConfigFile(file);
    expect(config.connectors).toHaveLength(1);
    expect(config.connectors[0].id).toBe('jira');
    expect(config.connectors[0].allowedTools[0]).toEqual({ name: 'search_issues', readOnly: true });
  });

  it('fails closed to an empty list for a missing file, blank path, or absent block', () => {
    expect(loadAoiMcpConnectorsFromConfigFile('')).toEqual({ connectors: [] });
    expect(
      loadAoiMcpConnectorsFromConfigFile(join(os.tmpdir(), 'does-not-exist-xyz.json')),
    ).toEqual({ connectors: [] });
    const noBlock = makeConfigFile({ llm: { provider: 'openrouter' } });
    expect(loadAoiMcpConnectorsFromConfigFile(noBlock)).toEqual({ connectors: [] });
  });

  it('fails closed when the file is malformed JSON', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-connectors-bad-'));
    tempRoots.push(root);
    const file = join(root, 'config.json');
    fs.writeFileSync(file, '{ not valid json', 'utf-8');
    expect(loadAoiMcpConnectorsFromConfigFile(file)).toEqual({ connectors: [] });
  });
});

describe('isAoiSideEffectingLiveRpcEnabled', () => {
  it('is off by default (unset / blank / unrelated value)', () => {
    expect(isAoiSideEffectingLiveRpcEnabled({})).toBe(false);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: '' })).toBe(false);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: '0' })).toBe(false);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: 'false' })).toBe(false);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: 'maybe' })).toBe(false);
  });

  it('is on only for an explicit truthy opt-in', () => {
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: '1' })).toBe(true);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: 'true' })).toBe(true);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: 'YES' })).toBe(true);
    expect(isAoiSideEffectingLiveRpcEnabled({ AOI_MCP_SIDE_EFFECTING_RPC: ' On ' })).toBe(true);
  });
});
