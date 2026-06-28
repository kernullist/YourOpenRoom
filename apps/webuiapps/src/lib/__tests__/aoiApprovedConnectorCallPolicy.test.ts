import { describe, expect, it } from 'vitest';

import {
  compareAoiApprovedConnectorCallApproval,
  createAoiApprovedConnectorCallRequest,
  evaluateAoiApprovedConnectorCallPolicy,
  normalizeAoiApprovedConnectorCallPolicy,
  stableStringifyConnectorArgs,
} from '../aoiApprovedConnectorCallPolicy';
import {
  AOI_MCP_READ_RESOURCE_METHOD,
  normalizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorsConfig,
} from '../aoiMcpConnectorRegistry';

const NOW = 1_000_000;

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
      {
        id: 'slack',
        name: 'Slack',
        endpointUrl: 'https://mcp.example.com/slack',
        enabled: true,
        trusted: false,
        allowedTools: [{ name: 'list_channels', readOnly: true }],
        allowReadResource: false,
        allowPrivateHost: false,
      },
    ],
  });
}

function request(overrides: Partial<Parameters<typeof createAoiApprovedConnectorCallRequest>[0]>) {
  return createAoiApprovedConnectorCallRequest({
    sessionPath: 'aoi/session-1',
    connectorRef: 'jira',
    toolName: 'search_issues',
    args: { jql: 'assignee = me', limit: 10 },
    purpose: 'Find my open issues',
    risk: 'high',
    requestedAt: NOW,
    evidenceRefs: ['goal:demo'],
    ...overrides,
  });
}

describe('evaluateAoiApprovedConnectorCallPolicy', () => {
  it('allows an allow-listed read-only tool and keeps mutationCount 0', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(request({}), {
      connectors: connectors(),
      now: NOW,
    });
    expect(policy.allowed).toBe(true);
    expect(policy.blockReasons).toEqual([]);
    expect(policy.routing).toBe('live_read_only');
    expect(policy.readOnly).toBe(true);
    expect(policy.connectorId).toBe('jira');
    expect(policy.endpointHost).toBe('mcp.example.com');
    expect(policy.requiredAutonomyLevel).toBe('L5');
    expect(policy.approvalSandbox?.expectedMutationCount).toBe(0);
    expect(policy.approvalSandbox?.mutationCount).toBe(0);
    expect(policy.approvalFingerprint).toBeTruthy();
  });

  it('blocks a side-effecting tool from live RPC when the env gate is off (default)', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(
      request({ toolName: 'create_issue', args: { project: 'OPS', summary: 'x' } }),
      { connectors: connectors(), now: NOW },
    );
    expect(policy.allowed).toBe(false);
    expect(policy.routing).toBe('side_effecting');
    expect(policy.requiresIrreversibleApproval).toBe(false);
    expect(policy.blockReasons).toContain('side_effecting_live_rpc_not_enabled');
  });

  it('with the env gate on, a side-effecting call still needs the irreversibility ack', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(
      request({ toolName: 'create_issue', args: { project: 'OPS', summary: 'x' } }),
      { connectors: connectors(), now: NOW, allowSideEffecting: true },
    );
    expect(policy.allowed).toBe(false);
    expect(policy.routing).toBe('side_effecting');
    expect(policy.requiresIrreversibleApproval).toBe(true);
    // The legacy hard block is lifted by the gate, replaced by the stronger consent.
    expect(policy.blockReasons).not.toContain('side_effecting_live_rpc_not_enabled');
    expect(policy.blockReasons).toContain('irreversible_approval_not_acknowledged');
  });

  it('allows a side-effecting call only with the env gate AND an explicit irreversibility ack', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(
      request({
        toolName: 'create_issue',
        args: { project: 'OPS', summary: 'x' },
        acknowledgeIrreversible: true,
      }),
      { connectors: connectors(), now: NOW, allowSideEffecting: true },
    );
    expect(policy.allowed).toBe(true);
    expect(policy.blockReasons).toEqual([]);
    expect(policy.routing).toBe('side_effecting');
    expect(policy.requiresIrreversibleApproval).toBe(true);
    expect(policy.rationale.join(' ')).toMatch(/irreversible/i);
  });

  it('leaves a read-only call unaffected when the env gate is on', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(request({}), {
      connectors: connectors(),
      now: NOW,
      allowSideEffecting: true,
    });
    expect(policy.allowed).toBe(true);
    expect(policy.routing).toBe('live_read_only');
    expect(policy.requiresIrreversibleApproval).toBe(false);
  });

  it('keeps the accept->execute binding stable for a gated side-effecting call', () => {
    // Accept time: no allow-list, no ack -> routing unknown, the binding receipt.
    const acceptPolicy = evaluateAoiApprovedConnectorCallPolicy(
      request({ toolName: 'create_issue', args: { project: 'OPS', summary: 'x' } }),
      { now: NOW },
    );
    // Execute time: allow-list + gate + ack -> routing side_effecting.
    const executePolicy = evaluateAoiApprovedConnectorCallPolicy(
      request({
        toolName: 'create_issue',
        args: { project: 'OPS', summary: 'x' },
        acknowledgeIrreversible: true,
      }),
      { connectors: connectors(), now: NOW, allowSideEffecting: true },
    );
    // The fingerprint is resolution-independent, so the binding holds even though
    // routing / requiresIrreversibleApproval / the ack differ between the two.
    expect(executePolicy.approvalFingerprint).toBe(acceptPolicy.approvalFingerprint);
    expect(executePolicy.operationHash).toBe(acceptPolicy.operationHash);
    expect(
      compareAoiApprovedConnectorCallApproval({
        approved: acceptPolicy,
        current: executePolicy,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('blocks an unknown or untrusted connector', () => {
    expect(
      evaluateAoiApprovedConnectorCallPolicy(request({ connectorRef: 'unknown' }), {
        connectors: connectors(),
        now: NOW,
      }).blockReasons,
    ).toContain('unknown_or_untrusted_connector');
    expect(
      evaluateAoiApprovedConnectorCallPolicy(
        request({ connectorRef: 'slack', toolName: 'list_channels' }),
        { connectors: connectors(), now: NOW },
      ).blockReasons,
    ).toContain('unknown_or_untrusted_connector');
  });

  it('blocks a tool that is not allow-listed', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(request({ toolName: 'delete_project' }), {
      connectors: connectors(),
      now: NOW,
    });
    expect(policy.blockReasons).toContain('tool_not_allow_listed');
    expect(policy.routing).toBe('unknown');
  });

  it('gates resources/read on the connector allowReadResource flag', () => {
    const allowed = evaluateAoiApprovedConnectorCallPolicy(
      request({ toolName: AOI_MCP_READ_RESOURCE_METHOD, resourceUri: 'jira://issue/1', args: {} }),
      { connectors: connectors(), now: NOW },
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.routing).toBe('live_read_only');

    const denyConfig = normalizeAoiMcpConnectorsConfig({
      connectors: [
        {
          id: 'jira',
          name: 'Jira',
          endpointUrl: 'https://mcp.example.com/jira',
          enabled: true,
          trusted: true,
          allowedTools: [{ name: 'search_issues', readOnly: true }],
          allowReadResource: false,
          allowPrivateHost: false,
        },
      ],
    });
    const denied = evaluateAoiApprovedConnectorCallPolicy(
      request({ toolName: AOI_MCP_READ_RESOURCE_METHOD, resourceUri: 'jira://issue/1', args: {} }),
      { connectors: denyConfig, now: NOW },
    );
    expect(denied.blockReasons).toContain('read_resource_not_allowed');
  });

  it('reports missing connector reference and tool name', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(
      request({ connectorRef: '', toolName: '' }),
      { connectors: connectors(), now: NOW },
    );
    expect(policy.blockReasons).toContain('missing_connector_reference');
    expect(policy.blockReasons).toContain('missing_tool_name');
  });

  it('blocks when no allow-list is provided at all', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(request({}), { now: NOW });
    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('unknown_or_untrusted_connector');
  });
});

describe('content-addressed fingerprint stability', () => {
  it('is stable across re-evaluation with the same input (accept -> execute)', () => {
    const req = request({});
    const a = evaluateAoiApprovedConnectorCallPolicy(req, { connectors: connectors(), now: NOW });
    const b = evaluateAoiApprovedConnectorCallPolicy(req, {
      connectors: connectors(),
      now: NOW + 1000,
    });
    expect(a.operationHash).toBe(b.operationHash);
    expect(a.approvalFingerprint).toBe(b.approvalFingerprint);
  });

  it('is independent of arg key order but changes when arg values change', () => {
    const ordered = evaluateAoiApprovedConnectorCallPolicy(
      request({ args: { jql: 'x', limit: 10 } }),
      { connectors: connectors(), now: NOW },
    );
    const reordered = evaluateAoiApprovedConnectorCallPolicy(
      request({ args: { limit: 10, jql: 'x' } }),
      { connectors: connectors(), now: NOW },
    );
    const changed = evaluateAoiApprovedConnectorCallPolicy(
      request({ args: { jql: 'x', limit: 11 } }),
      { connectors: connectors(), now: NOW },
    );
    expect(ordered.argsHash).toBe(reordered.argsHash);
    expect(ordered.operationHash).toBe(reordered.operationHash);
    expect(ordered.operationHash).not.toBe(changed.operationHash);
  });

  it('changes when the tool or connector changes', () => {
    const base = evaluateAoiApprovedConnectorCallPolicy(request({}), {
      connectors: connectors(),
      now: NOW,
    });
    const otherTool = evaluateAoiApprovedConnectorCallPolicy(
      request({ toolName: AOI_MCP_READ_RESOURCE_METHOD, resourceUri: 'jira://x' }),
      { connectors: connectors(), now: NOW },
    );
    expect(base.operationHash).not.toBe(otherTool.operationHash);
  });
});

describe('stableStringifyConnectorArgs', () => {
  it('sorts keys recursively and preserves array order', () => {
    expect(stableStringifyConnectorArgs({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(stableStringifyConnectorArgs({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
    expect(stableStringifyConnectorArgs(null)).toBe('null');
  });
});

describe('normalize + compare', () => {
  it('round-trips a valid policy and rejects malformed input', () => {
    const policy = evaluateAoiApprovedConnectorCallPolicy(request({}), {
      connectors: connectors(),
      now: NOW,
    });
    const normalized = normalizeAoiApprovedConnectorCallPolicy(policy);
    expect(normalized).toEqual(policy);
    expect(normalizeAoiApprovedConnectorCallPolicy(null)).toBeUndefined();
    expect(normalizeAoiApprovedConnectorCallPolicy({ version: 2 })).toBeUndefined();
  });

  it('flags a missing approval, expiry, and tool/operation drift', () => {
    const current = evaluateAoiApprovedConnectorCallPolicy(request({}), {
      connectors: connectors(),
      now: NOW,
    });
    expect(
      compareAoiApprovedConnectorCallApproval({ approved: undefined, current, now: NOW }),
    ).toContain('approval_missing');

    expect(
      compareAoiApprovedConnectorCallApproval({
        approved: current,
        current,
        now: current.expiresAt + 1,
      }),
    ).toContain('approval_expired');

    const matching = compareAoiApprovedConnectorCallApproval({
      approved: current,
      current,
      now: NOW,
    });
    expect(matching).toEqual([]);

    const driftedArgs = evaluateAoiApprovedConnectorCallPolicy(
      request({ args: { jql: 'different', limit: 10 } }),
      { connectors: connectors(), now: NOW },
    );
    expect(
      compareAoiApprovedConnectorCallApproval({
        approved: current,
        current: driftedArgs,
        now: NOW,
      }),
    ).toContain('approval_operation_changed');
  });
});
