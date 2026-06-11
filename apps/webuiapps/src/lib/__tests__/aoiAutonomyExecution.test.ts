import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maliciousProcedureSourceFixture } from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import { executeAoiProposal } from '../aoiAutonomyExecution';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiProposalDecisions,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import { loadServerAoiMemories } from '../aoiMemoryServerWriter';
import type { AoiProposal } from '../aoiAutonomyTypes';
import type { AoiResearchManifest } from '../aoiResearchTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-execution-test-'));
  tempRoots.push(root);
  return root;
}

function makeManifest(partial: Partial<AoiResearchManifest> = {}): AoiResearchManifest {
  return {
    version: 1,
    id: 'aoi-research-test-001',
    sessionPath: 'aoi/default',
    request: 'Investigate ETW telemetry',
    mode: 'standard',
    language: 'match-user',
    recency: 'any',
    maxSources: 12,
    createdAt: 1000,
    updatedAt: 1200,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'Completed.',
    sourceCounts: {
      planned: 12,
      candidates: 5,
      accepted: 4,
      failed: 0,
    },
    artifactPaths: {
      manifest: 'aoi-research/runs/aoi-research-test-001/manifest.json',
      report: 'aoi-research/runs/aoi-research-test-001/report.md',
      sources: 'aoi-research/runs/aoi-research-test-001/sources.json',
      evidence: 'aoi-research/runs/aoi-research-test-001/evidence.json',
    },
    artifactAvailability: {
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    },
    reportTitle: 'Investigate ETW telemetry',
    completedAt: 1200,
    ...partial,
  };
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-test-001',
    sessionPath: 'aoi/default',
    status: 'accepted',
    title: 'Open previous research',
    body: 'A previous Aoi research run may answer this.',
    reason: 'The current topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:kernel-memory',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['research:aoi-research-test-001/report'],
    memoryIds: [],
    artifactRefs: ['research:aoi-research-test-001/report'],
    riskSignals: [],
    acceptAction: {
      kind: 'read_research_artifact',
      params: {
        sessionPath: 'aoi/default',
        runId: 'aoi-research-test-001',
        artifact: 'report',
      },
    },
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('executeAoiProposal()', () => {
  it('executes accepted read-only artifact proposals at L3 with capped output', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L3' });
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
      dependencies: {
        readResearchArtifact: () => ({
          runId: 'aoi-research-test-001',
          run: makeManifest(),
          artifact: 'report',
          contentType: 'text/markdown',
          content: '# Report\n'.repeat(1000),
        }),
      },
    });

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      reasons: [],
    });
    expect(result.result?.contentPreview).toEqual(expect.stringContaining('# Report'));
    expect(String(result.result?.contentPreview).length).toBeLessThanOrEqual(4000);
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('executed');
    expect(loadAoiProposalDecisions(root, 'aoi/default')[0]).toMatchObject({
      action: 'execute',
      nextStatus: 'executed',
    });
  });

  it('blocks start_research without explicit acceptance', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW telemetry',
            mode: 'standard',
          },
        },
      }),
    ]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons.join(',')).toContain('missing_fresh_acceptance');
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('blocked');
  });

  it('executes start_research after fresh acceptance at L4', async () => {
    const root = makeTempRoot();
    const startResearch = vi.fn().mockResolvedValue({
      ok: true,
      run: makeManifest({ status: 'queued', phase: 'queued', completedAt: undefined }),
      background: true,
      maxConcurrentRuns: 2,
    });
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW telemetry',
            mode: 'standard',
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
      dependencies: {
        startResearch,
      },
    });

    expect(result.executed).toBe(true);
    expect(result.result).toMatchObject({
      kind: 'start_research',
      background: true,
    });
    expect(startResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          sessionPath: 'aoi/default',
          request: 'Investigate current ETW telemetry',
          mode: 'standard',
        }),
      }),
    );
  });

  it('blocks procedure promotion without explicit acceptance', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['save_memory'],
        acceptAction: {
          kind: 'save_memory',
          params: {
            type: 'procedure',
            content: 'Always compare source dates before promoting research findings.',
          },
        },
      }),
    ]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons.join(',')).toContain('missing_fresh_acceptance');
    expect(loadServerAoiMemories(root)).toEqual([]);
  });

  it('promotes approved procedure memory with sanitized content and relation edges', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['save_memory'],
        evidenceRefs: ['observation:latest-user-message'],
        acceptAction: {
          kind: 'save_memory',
          params: {
            type: 'procedure',
            content: maliciousProcedureSourceFixture,
            triggerTerms: ['research workflow'],
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    const memories = loadServerAoiMemories(root);
    const relationIndex = loadAoiRelationIndex(root, 'aoi/default');
    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'save_memory',
        target: 'memory',
      },
    });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      type: 'procedure',
      status: 'active',
    });
    expect(memories[0].content).not.toMatch(/ignore previous instructions/i);
    expect(memories[0].content).toContain('compare source dates');
    expect(
      relationIndex.edges.some(
        (edge) =>
          edge.kind === 'belongs_to' &&
          edge.evidenceRefs.includes(`decision:${result.decision.id}`),
      ),
    ).toBe(true);
  });

  it('returns untrusted skill drafts for approved procedure skill promotion', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['save_memory'],
        evidenceRefs: ['observation:latest-user-message'],
        acceptAction: {
          kind: 'save_memory',
          params: {
            type: 'procedure',
            target: 'skill',
            name: 'Research Date Check',
            content: 'Before answering current research questions, compare source dates.',
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.result).toMatchObject({
      kind: 'save_memory',
      target: 'skill',
      skillDraft: {
        name: 'Research Date Check',
        enabled: true,
        trusted: false,
      },
    });
    expect(loadServerAoiMemories(root)).toEqual([]);
  });

  it('blocks execution failures without losing the proposal', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L3' });
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
      dependencies: {
        readResearchArtifact: () => {
          throw new Error('artifact missing');
        },
      },
    });

    const stored = loadAoiActiveProposals(root, 'aoi/default');
    const decisions = loadAoiProposalDecisions(root, 'aoi/default');
    expect(result).toMatchObject({
      executed: false,
      outcome: 'failed',
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'proposal-test-001',
      status: 'blocked',
    });
    expect(decisions[0]).toMatchObject({
      action: 'block',
      nextStatus: 'blocked',
    });
  });
});
