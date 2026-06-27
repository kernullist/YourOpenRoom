import { describe, expect, it } from 'vitest';

import {
  createAoiApprovedConnectorCallRequest,
  evaluateAoiApprovedConnectorCallPolicy,
} from '../aoiApprovedConnectorCallPolicy';
import { applyAoiApprovedConnectorCall } from '../aoiApprovedConnectorCallRunner';
import {
  AOI_MCP_READ_RESOURCE_METHOD,
  normalizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorsConfig,
} from '../aoiMcpConnectorRegistry';

const NOW = 2_000_000;

function connectors(): AoiMcpConnectorsConfig {
  return normalizeAoiMcpConnectorsConfig({
    connectors: [
      {
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
      },
    ],
  });
}

function recordingTransport(
  impl: {
    callTool?: (p: {
      endpointUrl: string;
      toolName: string;
      args: Record<string, unknown>;
    }) => unknown;
    readResource?: (p: { endpointUrl: string; resourceUri: string }) => unknown;
  } = {},
) {
  const calls = {
    callTool: [] as Array<{ endpointUrl: string; toolName: string; args: Record<string, unknown> }>,
    readResource: [] as Array<{ endpointUrl: string; resourceUri: string }>,
  };
  return {
    calls,
    transport: {
      async callTool(p: { endpointUrl: string; toolName: string; args: Record<string, unknown> }) {
        calls.callTool.push(p);
        return impl.callTool ? impl.callTool(p) : { issues: [] };
      },
      async readResource(p: { endpointUrl: string; resourceUri: string }) {
        calls.readResource.push(p);
        return impl.readResource ? impl.readResource(p) : { contents: [] };
      },
    },
  };
}

function approvedRequest(
  overrides: Partial<Parameters<typeof createAoiApprovedConnectorCallRequest>[0]> = {},
) {
  const request = createAoiApprovedConnectorCallRequest({
    sessionPath: 'aoi/session-run',
    connectorRef: 'jira',
    toolName: 'search_issues',
    args: { jql: 'assignee = me' },
    purpose: 'List my issues',
    risk: 'high',
    requestedAt: NOW,
    evidenceRefs: ['goal:demo'],
    ...overrides,
  });
  const approvedPolicy = evaluateAoiApprovedConnectorCallPolicy(request, {
    connectors: connectors(),
    now: NOW,
  });
  return { request, approvedPolicy };
}

describe('applyAoiApprovedConnectorCall', () => {
  it('fires a read-only tool call against the allow-list endpoint and records a digest', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport({
      callTool: () => ({ issues: [{ id: 'A-1' }] }),
    });

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.routing).toBe('live_read_only');
    expect(result.result).toEqual({ issues: [{ id: 'A-1' }] });
    expect(result.resultDigest).toMatch(/^sha256:[0-9a-f]{16}:len=\d+$/);
    expect(result.auditRecord.connectorId).toBe('jira');
    expect(result.auditRecord.endpointHost).toBe('mcp.example.com');
    expect(result.auditRecord.approvalFingerprint).toBe(approvedPolicy.approvalFingerprint);
    // SSRF gate: the endpoint comes from the allow-list, never the proposal.
    expect(calls.callTool).toHaveLength(1);
    expect(calls.callTool[0].endpointUrl).toBe('https://mcp.example.com/jira');
    expect(calls.callTool[0].toolName).toBe('search_issues');
  });

  it('routes resources/read to readResource', async () => {
    const { request, approvedPolicy } = approvedRequest({
      toolName: AOI_MCP_READ_RESOURCE_METHOD,
      resourceUri: 'jira://issue/A-1',
      args: {},
    });
    const { transport, calls } = recordingTransport({ readResource: () => ({ contents: ['x'] }) });

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(calls.readResource).toHaveLength(1);
    expect(calls.readResource[0]).toEqual({
      endpointUrl: 'https://mcp.example.com/jira',
      resourceUri: 'jira://issue/A-1',
    });
    expect(calls.callTool).toHaveLength(0);
  });

  it('blocks resources/read with no resourceUri without calling the transport', async () => {
    const { request, approvedPolicy } = approvedRequest({
      toolName: AOI_MCP_READ_RESOURCE_METHOD,
      args: {},
    });
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('execution_failed');
    expect(calls.readResource).toHaveLength(0);
  });

  it('blocks a side-effecting tool and never reaches the transport', async () => {
    const { request, approvedPolicy } = approvedRequest({
      toolName: 'create_issue',
      args: { project: 'OPS' },
    });
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('side_effecting_live_rpc_not_enabled');
    expect(calls.callTool).toHaveLength(0);
  });

  it('blocks when the connector is no longer trusted at execute time (no RPC)', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport();

    // Config changed since accept: connector revoked.
    const revoked = normalizeAoiMcpConnectorsConfig({
      connectors: [
        {
          id: 'jira',
          name: 'Jira',
          endpointUrl: 'https://mcp.example.com/jira',
          enabled: true,
          trusted: false,
          allowedTools: [{ name: 'search_issues', readOnly: true }],
          allowReadResource: true,
          allowPrivateHost: false,
        },
      ],
    });

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: revoked,
      approvedPolicy,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('unknown_or_untrusted_connector');
    expect(calls.callTool).toHaveLength(0);
  });

  it('blocks a stale approval (operation drift) without calling the transport', async () => {
    const { request } = approvedRequest();
    // Approval captured for a different operation (different args).
    const staleApproval = evaluateAoiApprovedConnectorCallPolicy(
      createAoiApprovedConnectorCallRequest({
        sessionPath: 'aoi/session-run',
        connectorRef: 'jira',
        toolName: 'search_issues',
        args: { jql: 'something else' },
        risk: 'high',
        requestedAt: NOW,
      }),
      { connectors: connectors(), now: NOW },
    );
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy: staleApproval,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('approval_operation_changed');
    expect(calls.callTool).toHaveLength(0);
  });

  it('captures a transport failure as execution_failed with an error digest', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport } = recordingTransport({
      callTool: () => {
        throw new Error('backend 502');
      },
    });

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.blockReasons).toContain('execution_failed');
    expect(result.resultDigest).toContain('error:backend 502');
  });

  it('blocks a missing approval (never accepted) before any RPC', async () => {
    const { request } = approvedRequest();
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      transport,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
    expect(calls.callTool).toHaveLength(0);
  });
});
