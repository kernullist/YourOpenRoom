import { describe, expect, it } from 'vitest';
import {
  buildAoiAutonomyReflectionMessages,
  parseAoiAutonomyReflectionResponse,
} from '../aoiAutonomyEngine';
import {
  normalizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorsConfig,
} from '../aoiMcpConnectorRegistry';

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

function connectorProposalRaw(
  acceptActionParams: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    proposals: [
      {
        title: 'Read my open Jira issues',
        body: 'A read-only connector query.',
        reason: 'The user asked about open issues.',
        confidence: 0.8,
        // Deliberately under-gated; the parser must force connector_call governance.
        risk: 'low',
        requiredAutonomyLevel: 'L2',
        requiresUserApproval: false,
        evidenceRefs: ['observation:obs-1'],
        acceptAction: { kind: 'connector_call', params: acceptActionParams },
        ...overrides,
      },
    ],
  });
}

// Driver's-seat evidence handling: the LLM may originate proposals/reflections,
// and unverifiable evidence refs are filtered (not used to reject the whole
// item). Actionable proposals still need at least one known ref; reflections
// (thoughts) may stand alone. The execution policy gate is the final safety net.
describe('parseAoiAutonomyReflectionResponse driver-seat evidence handling', () => {
  const base = { sessionPath: 'demo', now: 1_000 };

  it('keeps an LLM proposal but drops unknown evidence refs', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          title: 'Refresh stale research',
          body: 'Body',
          reason: 'Reason',
          confidence: 0.8,
          evidenceRefs: ['observation:obs-1', 'memory:ghost'],
        },
      ],
    });
    const result = parseAoiAutonomyReflectionResponse(raw, {
      ...base,
      knownEvidenceRefs: new Set(['observation:obs-1', 'memory:m-1']),
    });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.evidenceRefs).toEqual(['observation:obs-1']);
    expect(result.warnings).toContain('proposal_evidence_filtered');
  });

  it('skips an LLM proposal whose evidence is entirely unknown', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          title: 'Ungrounded',
          body: 'Body',
          reason: 'Reason',
          confidence: 0.8,
          evidenceRefs: ['memory:ghost'],
        },
      ],
    });
    const result = parseAoiAutonomyReflectionResponse(raw, {
      ...base,
      knownEvidenceRefs: new Set<string>(),
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings).toContain('proposal_rejected_no_known_evidence');
  });

  it('keeps a reflection even when it cites no known refs (a thought may stand alone)', () => {
    const raw = JSON.stringify({
      reflections: [
        {
          claim: 'The current research looks stale.',
          confidence: 0.7,
          evidenceRefs: ['memory:ghost'],
        },
      ],
    });
    const result = parseAoiAutonomyReflectionResponse(raw, {
      ...base,
      knownEvidenceRefs: new Set<string>(),
    });
    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0]?.evidenceRefs).toEqual([]);
  });
});

// The LLM driver-seat may propose a connector_call, but only for an allow-listed
// read-only tool; the parser validates against the trusted catalog and forces L5 +
// approval + high risk so the execution gate is the final backstop.
describe('parseAoiAutonomyReflectionResponse connector_call handling', () => {
  const base = {
    sessionPath: 'demo',
    now: 1_000,
    knownEvidenceRefs: new Set(['observation:obs-1']),
  };

  it('accepts a read-only connector_call and forces L5 + approval + high risk', () => {
    const raw = connectorProposalRaw({
      connectorRef: 'jira',
      toolName: 'search_issues',
      args: { jql: 'assignee = currentUser() AND status = Open' },
      purpose: 'List my open issues',
    });
    const result = parseAoiAutonomyReflectionResponse(raw, { ...base, connectors: connectors() });
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal?.acceptAction?.kind).toBe('connector_call');
    expect(proposal?.risk).toBe('high');
    expect(proposal?.requiresUserApproval).toBe(true);
    expect(proposal?.requiredAutonomyLevel).toBe('L5');
  });

  it('accepts a gated resources/read connector_call', () => {
    const raw = connectorProposalRaw({
      connectorRef: 'jira',
      toolName: 'resources/read',
      resourceUri: 'jira://issue/A-1',
      purpose: 'Read an issue resource',
    });
    const result = parseAoiAutonomyReflectionResponse(raw, { ...base, connectors: connectors() });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.acceptAction?.kind).toBe('connector_call');
  });

  it('drops a connector_call to an unknown/untrusted connector', () => {
    const raw = connectorProposalRaw({ connectorRef: 'ghost', toolName: 'search_issues' });
    const result = parseAoiAutonomyReflectionResponse(raw, { ...base, connectors: connectors() });
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings).toContain('proposal_connector_call_untrusted');
  });

  it('drops a connector_call to a side-effecting (non-read-only) tool', () => {
    const raw = connectorProposalRaw({ connectorRef: 'jira', toolName: 'create_issue' });
    const result = parseAoiAutonomyReflectionResponse(raw, { ...base, connectors: connectors() });
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings).toContain('proposal_connector_call_not_read_only');
  });

  it('drops a connector_call when no allow-list is supplied (fail-closed)', () => {
    const raw = connectorProposalRaw({ connectorRef: 'jira', toolName: 'search_issues' });
    const result = parseAoiAutonomyReflectionResponse(raw, base);
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings).toContain('proposal_connector_call_untrusted');
  });

  it('drops a connector_call missing connectorRef or toolName', () => {
    const raw = connectorProposalRaw({ toolName: 'search_issues' });
    const result = parseAoiAutonomyReflectionResponse(raw, { ...base, connectors: connectors() });
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings).toContain('proposal_connector_call_incomplete');
  });
});

describe('buildAoiAutonomyReflectionMessages connector catalog', () => {
  const baseParams = { observations: [], memories: [], activeProposals: [] };

  it('omits connector guidance when no connectors are available (default prompt)', () => {
    const [system, user] = buildAoiAutonomyReflectionMessages(baseParams);
    expect(system.content).not.toContain('connector_call');
    expect(user.content).not.toContain('availableConnectors');
  });

  it('offers only read-only tools when connectors are available', () => {
    const [system, user] = buildAoiAutonomyReflectionMessages({
      ...baseParams,
      availableConnectors: [
        {
          connectorRef: 'jira',
          name: 'Jira',
          readOnlyTools: ['search_issues'],
          allowReadResource: true,
        },
      ],
    });
    expect(system.content).toContain('connector_call');
    expect(user.content).toContain('availableConnectors');
    expect(user.content).toContain('search_issues');
    // Side-effecting tools are never put in the catalog the model sees.
    expect(user.content).not.toContain('create_issue');
  });
});
