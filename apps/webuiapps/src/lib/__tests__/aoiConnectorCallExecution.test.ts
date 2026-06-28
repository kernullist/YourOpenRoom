import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAoiProposal } from '../aoiAutonomyExecution';
import { applyAoiApprovedConnectorCall } from '../aoiApprovedConnectorCallRunner';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiConnectorCallAuditRecords,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import type { AoiMcpConnectorsConfig } from '../aoiMcpConnectorRegistry';
import type {
  AoiApprovedConnectorCallPolicy,
  AoiApprovedConnectorCallRequest,
  AoiProposal,
} from '../aoiAutonomyTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-connector-exec-test-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

const TRUSTED_CONNECTORS: AoiMcpConnectorsConfig = {
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
};

function writeConfig(root: string, connectors: AoiMcpConnectorsConfig): string {
  const configFile = join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ aoiMcpConnectors: connectors }), 'utf-8');
  return configFile;
}

function makeConnectorProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-cc-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Search my open Jira issues',
    body: 'Aoi can read open issues through the trusted Jira connector.',
    reason: 'A read-only connector query is approved for this exact operation.',
    trigger: 'connector_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'connector-call:jira-search',
    confidence: 0.9,
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['connector_call'],
    evidenceRefs: ['memory:jira-approved', 'goal:aoi-goal-cc-001'],
    memoryIds: [],
    artifactRefs: ['workspace:snapshot:cc-test'],
    riskSignals: ['connector-call:approved'],
    acceptAction: {
      kind: 'connector_call',
      params: {
        connectorRef: 'jira',
        toolName: 'search_issues',
        args: { jql: 'assignee = currentUser() AND status = Open' },
        purpose: 'Search my open Jira issues',
      },
    },
    ...partial,
  };
}

// A recording transport delegated to by the injected runApprovedConnectorCall
// dependency, so the execution path runs the real runner/policy/audit but never
// touches the network.
function recordingTransport() {
  const calls = {
    callTool: [] as Array<{ endpointUrl: string; toolName: string; args: Record<string, unknown> }>,
    readResource: [] as Array<{ endpointUrl: string; resourceUri: string }>,
  };
  return {
    calls,
    transport: {
      async callTool(p: { endpointUrl: string; toolName: string; args: Record<string, unknown> }) {
        calls.callTool.push(p);
        return { issues: [{ id: 'JIRA-1', summary: 'open bug' }] };
      },
      async readResource(p: { endpointUrl: string; resourceUri: string }) {
        calls.readResource.push(p);
        return { contents: [] };
      },
    },
  };
}

function dependenciesWith(transportHolder: ReturnType<typeof recordingTransport>) {
  return {
    runApprovedConnectorCall: (p: {
      request: AoiApprovedConnectorCallRequest;
      approvedPolicy?: AoiApprovedConnectorCallPolicy;
      connectors: AoiMcpConnectorsConfig | null;
      now: number;
    }) =>
      applyAoiApprovedConnectorCall(p.request, {
        connectors: p.connectors,
        ...(p.approvedPolicy ? { approvedPolicy: p.approvedPolicy } : {}),
        transport: transportHolder.transport,
        // Offline resolver so the execute-time DNS-rebind guard passes without
        // touching real DNS; the allow-list host maps to a public address.
        resolveHost: async () => ['93.184.216.34'],
        now: p.now,
      }),
  };
}

describe('executeAoiProposal() connector calls', () => {
  it('executes an approved read-only connector call under L5 and records the audit', async () => {
    const root = makeTempRoot();
    const configFile = writeConfig(root, TRUSTED_CONNECTORS);
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeConnectorProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-cc-001',
      action: 'accept',
      now: 2500,
    });
    const holder = recordingTransport();

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile,
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-cc-001',
      decisionId: accepted.decision.id,
      dependencies: dependenciesWith(holder),
      now: 3000,
    });

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'connector_call',
        connectorCallResult: { ok: true, applied: true, routing: 'live_read_only' },
      },
    });
    // SSRF gate: the endpoint came from the allow-list, not the proposal.
    expect(holder.calls.callTool).toHaveLength(1);
    expect(holder.calls.callTool[0].endpointUrl).toBe('https://mcp.example.com/jira');
    const audits = loadAoiConnectorCallAuditRecords(root, 'aoi/default');
    expect(audits).toHaveLength(1);
    expect(audits[0].applied).toBe(true);
    expect(audits[0].connectorId).toBe('jira');
    expect(audits[0].toolName).toBe('search_issues');
    expect(audits[0].resultDigest).toMatch(/^sha256:/);
    expect(audits[0].evidenceRefs.some((ref) => ref.startsWith('decision:'))).toBe(true);
  });

  it('blocks a connector call below L5 and never reaches the connector', async () => {
    const root = makeTempRoot();
    const configFile = writeConfig(root, TRUSTED_CONNECTORS);
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeConnectorProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-cc-001',
      action: 'accept',
      now: 2500,
    });
    const holder = recordingTransport();

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile,
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-cc-001',
      decisionId: accepted.decision.id,
      dependencies: dependenciesWith(holder),
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('connector_call_requires_l5');
    expect(holder.calls.callTool).toHaveLength(0);
    expect(loadAoiConnectorCallAuditRecords(root, 'aoi/default')).toHaveLength(0);
  });

  it('blocks a side-effecting tool from live RPC', async () => {
    const root = makeTempRoot();
    const configFile = writeConfig(root, TRUSTED_CONNECTORS);
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeConnectorProposal({
        acceptAction: {
          kind: 'connector_call',
          params: {
            connectorRef: 'jira',
            toolName: 'create_issue',
            args: { project: 'OPS', summary: 'new' },
            purpose: 'Create an issue',
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-cc-001',
      action: 'accept',
      now: 2500,
    });
    const holder = recordingTransport();

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile,
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-cc-001',
      decisionId: accepted.decision.id,
      dependencies: dependenciesWith(holder),
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('side_effecting_live_rpc_not_enabled');
    expect(holder.calls.callTool).toHaveLength(0);
  });

  it('blocks when the connector is untrusted in the server config', async () => {
    const root = makeTempRoot();
    const configFile = writeConfig(root, {
      connectors: [{ ...TRUSTED_CONNECTORS.connectors[0], trusted: false }],
    });
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeConnectorProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-cc-001',
      action: 'accept',
      now: 2500,
    });
    const holder = recordingTransport();

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile,
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-cc-001',
      decisionId: accepted.decision.id,
      dependencies: dependenciesWith(holder),
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('unknown_or_untrusted_connector');
    expect(holder.calls.callTool).toHaveLength(0);
  });

  it('blocks when the args change after approval (content-addressed)', async () => {
    const root = makeTempRoot();
    const configFile = writeConfig(root, TRUSTED_CONNECTORS);
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeConnectorProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-cc-001',
      action: 'accept',
      now: 2500,
    });

    const tampered = loadAoiActiveProposals(root, 'aoi/default').map((proposal) =>
      proposal.id === 'proposal-cc-001'
        ? {
            ...proposal,
            acceptAction: {
              kind: 'connector_call' as const,
              params: {
                connectorRef: 'jira',
                toolName: 'search_issues',
                args: { jql: 'project = SECRET' },
                purpose: 'Search my open Jira issues',
              },
            },
          }
        : proposal,
    );
    saveAoiActiveProposals(root, 'aoi/default', tampered);
    const holder = recordingTransport();

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile,
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-cc-001',
      decisionId: accepted.decision.id,
      dependencies: dependenciesWith(holder),
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('connector_call_approval_operation_changed');
    expect(holder.calls.callTool).toHaveLength(0);
  });
});
