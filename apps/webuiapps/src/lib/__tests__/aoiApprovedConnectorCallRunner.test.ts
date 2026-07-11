import { describe, expect, it } from 'vitest';

import {
  createAoiApprovedConnectorCallRequest,
  evaluateAoiApprovedConnectorCallPolicy,
} from '../aoiApprovedConnectorCallPolicy';
import { applyAoiApprovedConnectorCall } from '../aoiApprovedConnectorCallRunner';
import type { AoiMcpConnectorHostLookup } from '../aoiMcpConnectorDnsGuard';
import {
  AOI_MCP_READ_RESOURCE_METHOD,
  normalizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorsConfig,
} from '../aoiMcpConnectorRegistry';

const NOW = 2_000_000;

// Default offline resolver: every allow-listed hostname maps to a public address,
// so the execute-time DNS-rebind guard passes without touching real DNS.
const publicLookup: AoiMcpConnectorHostLookup = async () => ['93.184.216.34'];

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
          { name: 'create_issue', readOnly: false, compensatingAction: 'delete the created issue' },
        ],
        allowReadResource: true,
        allowPrivateHost: false,
      },
    ],
  });
}

// A trusted connector that explicitly opted into a private endpoint host (e.g. a
// local dev MCP server); the execute-time DNS re-check is intentionally skipped.
function privateConnectors(): AoiMcpConnectorsConfig {
  return normalizeAoiMcpConnectorsConfig({
    connectors: [
      {
        id: 'localmcp',
        name: 'Local MCP',
        endpointUrl: 'http://10.0.0.9/mcp',
        enabled: true,
        trusted: true,
        allowedTools: [{ name: 'search_issues', readOnly: true }],
        allowReadResource: true,
        allowPrivateHost: true,
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
      resolveHost: publicLookup,
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
      resolveHost: publicLookup,
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

  it('fires a side-effecting tool only with the env gate AND the irreversibility ack', async () => {
    const request = createAoiApprovedConnectorCallRequest({
      sessionPath: 'aoi/session-run',
      connectorRef: 'jira',
      toolName: 'create_issue',
      args: { project: 'OPS', summary: 'x' },
      purpose: 'Create an issue',
      risk: 'high',
      requestedAt: NOW,
      evidenceRefs: ['goal:demo'],
      acknowledgeIrreversible: true,
    });
    // Accept-time binding receipt (no allow-list -> routing unknown, but the
    // fingerprint is resolution-independent and matches the execute-time policy).
    const approvedPolicy = evaluateAoiApprovedConnectorCallPolicy(request, { now: NOW });
    const { transport, calls } = recordingTransport({ callTool: () => ({ created: 'OPS-1' }) });

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      allowSideEffecting: true,
      transport,
      resolveHost: publicLookup,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.routing).toBe('side_effecting');
    expect(calls.callTool).toHaveLength(1);
    expect(calls.callTool[0].toolName).toBe('create_issue');
    expect(calls.callTool[0].endpointUrl).toBe('https://mcp.example.com/jira');
  });

  it('blocks a gated side-effecting tool that lacks the irreversibility ack (no RPC)', async () => {
    const request = createAoiApprovedConnectorCallRequest({
      sessionPath: 'aoi/session-run',
      connectorRef: 'jira',
      toolName: 'create_issue',
      args: { project: 'OPS', summary: 'x' },
      purpose: 'Create an issue',
      risk: 'high',
      requestedAt: NOW,
      evidenceRefs: ['goal:demo'],
    });
    const approvedPolicy = evaluateAoiApprovedConnectorCallPolicy(request, { now: NOW });
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      allowSideEffecting: true,
      transport,
      resolveHost: publicLookup,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('irreversible_approval_not_acknowledged');
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
      resolveHost: publicLookup,
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

  it('fires when the endpoint hostname resolves to a public address', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport({ callTool: () => ({ issues: [] }) });

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      resolveHost: async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(calls.callTool).toHaveLength(1);
  });

  it('blocks when the hostname resolves to a private address (DNS rebind) before any RPC', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      // Public-looking hostname that resolves to an internal address.
      resolveHost: async () => ['93.184.216.34', '10.0.0.5'],
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.blockReasons).toContain('dns_rebind_blocked');
    expect(result.resultDigest).toContain('error:dns:resolved_private_host_blocked');
    expect(result.resultDigest).toContain('10.0.0.5');
    expect(calls.callTool).toHaveLength(0);
  });

  it('blocks when the hostname resolves to the cloud metadata address', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      resolveHost: async () => ['169.254.169.254'],
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('dns_rebind_blocked');
    expect(calls.callTool).toHaveLength(0);
  });

  it('blocks an IPv4-mapped IPv6 private resolution (no bypass)', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      resolveHost: async () => ['::ffff:10.0.0.5'],
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('dns_rebind_blocked');
    expect(calls.callTool).toHaveLength(0);
  });

  it('captures a DNS resolution failure as execution_failed without an RPC', async () => {
    const { request, approvedPolicy } = approvedRequest();
    const { transport, calls } = recordingTransport();

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: connectors(),
      approvedPolicy,
      transport,
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.blockReasons).toContain('execution_failed');
    expect(result.resultDigest).toContain('error:dns:dns_resolution_failed');
    expect(calls.callTool).toHaveLength(0);
  });

  it('skips the DNS re-check for a connector that opted into private hosts', async () => {
    const config = privateConnectors();
    const request = createAoiApprovedConnectorCallRequest({
      sessionPath: 'aoi/session-run',
      connectorRef: 'localmcp',
      toolName: 'search_issues',
      args: { jql: 'assignee = me' },
      purpose: 'List my issues',
      risk: 'high',
      requestedAt: NOW,
    });
    const approvedPolicy = evaluateAoiApprovedConnectorCallPolicy(request, {
      connectors: config,
      now: NOW,
    });
    const { transport, calls } = recordingTransport({ callTool: () => ({ issues: [] }) });
    let lookups = 0;

    const result = await applyAoiApprovedConnectorCall(request, {
      connectors: config,
      approvedPolicy,
      transport,
      resolveHost: async () => {
        lookups += 1;
        return ['10.0.0.9'];
      },
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    // allowPrivateHost short-circuits the guard, so the resolver is never consulted.
    expect(lookups).toBe(0);
    expect(calls.callTool).toHaveLength(1);
    expect(calls.callTool[0].endpointUrl).toBe('http://10.0.0.9/mcp');
  });
});
