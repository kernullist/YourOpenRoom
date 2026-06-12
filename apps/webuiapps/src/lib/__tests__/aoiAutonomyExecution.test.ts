import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maliciousProcedureSourceFixture } from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import { executeAoiProposal, previewAoiProposal } from '../aoiAutonomyExecution';
import { buildAoiFailureRecoveryProposal, classifyAoiFailure } from '../aoiAutonomyRecovery';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  loadAoiObservations,
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

function makeKiraProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeProposal({
    status: 'accepted',
    title: 'Create reviewed Kira handoff',
    body: 'Aoi should create a narrow Kira work item for the accepted task.',
    reason: 'The user accepted a supervised implementation proposal.',
    trigger: 'goal_continuation',
    cooldownKey: 'kira-handoff:aoi-autonomy',
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['create_kira_work'],
    evidenceRefs: ['goal:aoi-goal-001', 'observation:latest-user-message'],
    artifactRefs: ['plan-step:aoi-plan-001-step-003'],
    acceptAction: {
      kind: 'create_kira_work',
      params: {
        projectName: 'YourOpenRoom',
        title: 'Implement supervised Aoi Kira handoff',
        objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
        scope: ['Aoi autonomy execution', 'Aoi autonomy UI'],
        modules: ['aoiAutonomyExecution', 'ChatPanel'],
        validationProfile: 'aoi-autonomy',
      },
    },
    ...partial,
  });
}

function loadKiraWorkFiles(
  root: string,
  sessionPath = 'aoi/default',
): Array<Record<string, unknown>> {
  const worksDir = join(root, sessionPath, 'apps', 'kira', 'data', 'works');
  if (!fs.existsSync(worksDir)) {
    return [];
  }
  return fs
    .readdirSync(worksDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => JSON.parse(fs.readFileSync(join(worksDir, fileName), 'utf-8')));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi failure recovery classification', () => {
  it('classifies policy, research, Kira, and execution failures deterministically', () => {
    expect(
      classifyAoiFailure({
        source: 'policy',
        sessionPath: 'aoi/default',
        sourceRef: 'proposal:policy-001',
        reasons: ['tool_blocked:run_command'],
        suggestedTools: ['run_command'],
      }).kind,
    ).toBe('policy_blocked');

    expect(
      classifyAoiFailure({
        source: 'research',
        sessionPath: 'aoi/default',
        sourceRef: 'research:failed-001',
        reasons: ['accepted_sources:0'],
        researchRun: makeManifest({
          id: 'failed-001',
          status: 'failed',
          sourceCounts: {
            planned: 12,
            candidates: 5,
            accepted: 0,
            failed: 5,
          },
        }),
      }).kind,
    ).toBe('research_insufficient_sources');

    expect(
      classifyAoiFailure({
        source: 'kira',
        sessionPath: 'aoi/default',
        sourceRef: 'memory:kira-001',
        riskSignals: ['validation-failed'],
        summary: 'Kira validation failed for the scoped work.',
      }).kind,
    ).toBe('kira_validation_failed');

    expect(
      classifyAoiFailure({
        source: 'execution',
        sessionPath: 'aoi/default',
        sourceRef: 'proposal:exec-001',
        reasons: ['unexpected runtime exception'],
      }).kind,
    ).toBe('execution_exception');
  });

  it('does not create direct mutation recovery actions', () => {
    const failure = classifyAoiFailure({
      source: 'policy',
      sessionPath: 'aoi/default',
      sourceRef: 'proposal:mutation-001',
      reasons: ['tool_blocked:file_patch'],
      suggestedTools: ['file_patch'],
      acceptActionKind: 'file_patch',
    });

    const result = buildAoiFailureRecoveryProposal({
      failure,
      context: {
        activeProposals: [],
        recentDecisions: [],
        now: 3000,
      },
    });

    expect(result.proposal).toBeNull();
    expect(result.suppression?.reason).toBe('mutation_action_not_retriable');
    expect(result.suppression?.preview.nonGoals).toEqual(
      expect.arrayContaining(['Do not execute file writes, patches, deletes, or shell commands.']),
    );
  });
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
    const observations = loadAoiObservations(root, 'aoi/default');
    const relationIndex = loadAoiRelationIndex(root, 'aoi/default');
    const promotionObservation = observations.find((observation) =>
      observation.dedupeKey.startsWith('proposal:procedure-promotion:'),
    );
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
    expect(promotionObservation).toMatchObject({
      source: 'proposal',
      proposalIds: ['proposal-test-001'],
      memoryIds: [memories[0].id],
    });
    expect(promotionObservation?.summary).not.toMatch(/ignore previous instructions/i);
    expect(promotionObservation?.artifactRefs).toContain('procedure:proposal-test-001');
    expect(
      relationIndex.edges.some(
        (edge) =>
          edge.kind === 'belongs_to' &&
          edge.evidenceRefs.includes(`decision:${result.decision.id}`),
      ),
    ).toBe(true);
    expect(
      relationIndex.nodes.some((node) => node.ref === `observation:${promotionObservation?.id}`),
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

  it('previews Kira handoff without creating work or transitioning the proposal', () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeKiraProposal()]);

    const result = previewAoiProposal({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result).toMatchObject({
      previewed: true,
      outcome: 'previewed',
      reasons: [],
    });
    expect(result.result?.preview).toMatchObject({
      kind: 'create_kira_work',
      objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
      requiresReview: true,
      noSideEffects: true,
    });
    expect(loadKiraWorkFiles(root)).toEqual([]);
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('accepted');
    expect(
      loadServerAoiRunLedger(root, 'aoi/default').some((entry) =>
        entry.events.some((event) => event.type === 'kira_handoff_preview_created'),
      ),
    ).toBe(true);
  });

  it('blocks Kira handoff without acceptance, evidence, safe params, or narrow scope', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });

    saveAoiActiveProposals(root, 'aoi/default', [makeKiraProposal({ status: 'active' })]);
    const withoutAcceptance = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });
    expect(withoutAcceptance.executed).toBe(false);
    expect(withoutAcceptance.reasons.join(',')).toContain(
      'kira_handoff_requires_accepted_proposal',
    );

    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'accepted',
        evidenceRefs: [],
      }),
    ]);
    const missingEvidence = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 4000,
    });
    expect(missingEvidence.reasons.join(',')).toContain('missing_evidence_refs');

    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'F:\\secret\\repo',
            objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
            scope: ['Aoi autonomy execution'],
          },
        },
      }),
    ]);
    const pathParam = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 5000,
    });
    expect(pathParam.reasons.join(',')).toContain('action_params_include_filesystem_path');

    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'YourOpenRoom',
            objective: 'Rewrite the entire repository.',
            scope: ['entire repo'],
          },
        },
      }),
    ]);
    const broadScope = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 6000,
    });
    expect(broadScope.reasons.join(',')).toContain('kira_handoff_scope_too_broad');
    expect(broadScope.result?.safeAlternative).toEqual(expect.stringContaining('Narrow'));
    expect(loadKiraWorkFiles(root)).toEqual([]);
    expect(
      loadServerAoiRunLedger(root, 'aoi/default').some((entry) =>
        entry.events.some((event) => event.type === 'kira_handoff_policy_blocked'),
      ),
    ).toBe(true);
  });

  it('creates reviewed Kira work after fresh approval and records relations plus ledger events', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeKiraProposal({ status: 'active' })]);
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

    const workFiles = loadKiraWorkFiles(root);
    const relationIndex = loadAoiRelationIndex(root, 'aoi/default');
    const ledger = loadServerAoiRunLedger(root, 'aoi/default');
    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'create_kira_work',
        reviewRequired: true,
      },
    });
    expect(workFiles).toHaveLength(1);
    expect(workFiles[0]).toMatchObject({
      type: 'work',
      projectName: 'YourOpenRoom',
      status: 'todo',
    });
    expect(String(workFiles[0].description)).toContain('Requires Kira reviewer approval');
    expect(relationIndex.nodes.some((node) => node.kind === 'kira_work')).toBe(true);
    expect(
      relationIndex.edges.some(
        (edge) => edge.kind === 'supports' && edge.evidenceRefs.includes('goal:aoi-goal-001'),
      ),
    ).toBe(true);
    expect(
      ledger.some((entry) =>
        entry.events.some((event) => event.type === 'kira_handoff_execution_approved'),
      ),
    ).toBe(true);
    expect(
      ledger.some((entry) => entry.events.some((event) => event.type === 'kira_work_item_created')),
    ).toBe(true);
  });

  it('does not route Kira handoff through direct file or command tools', async () => {
    const root = makeTempRoot();
    const createKiraWork = vi.fn();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'active',
        suggestedTools: ['create_kira_work', 'file_write', 'run_command'],
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
        createKiraWork,
      },
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('tool_blocked:file_write');
    expect(result.reasons.join(',')).toContain('tool_blocked:run_command');
    expect(createKiraWork).not.toHaveBeenCalled();
    expect(loadKiraWorkFiles(root)).toEqual([]);
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
