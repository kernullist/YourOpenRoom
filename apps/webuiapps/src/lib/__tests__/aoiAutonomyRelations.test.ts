import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getActiveAoiRelationMemoryIds,
  loadAoiRelationIndex,
  makeAoiRelationEdge,
  makeAoiRelationNode,
  recordAoiMissionStateRelations,
  recordAoiAttentionEventRelations,
  recordAoiKiraOutcomeRelations,
  recordAoiProposalCreatedRelations,
  recordAoiRecoveryProposalRelations,
  upsertAoiRelations,
} from '../aoiAutonomyRelations';
import { buildAoiContextRouterResult } from '../aoiContextRouter';
import { updateAoiEnvironmentSource } from '../aoiAutonomyStore';
import type {
  AoiAttentionEvent,
  AoiGoal,
  AoiKiraOutcomeEvent,
  AoiMissionState,
  AoiObservation,
  AoiPlanStep,
  AoiProposal,
} from '../aoiAutonomyTypes';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-relations-test-'));
  tempRoots.push(root);
  return root;
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-relation-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Refresh stale research',
    body: 'A prior research memory is stale.',
    reason: 'The user asked for current information.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:stale',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['observation:latest-user-message', 'memory:memory-stale-research'],
    memoryIds: ['memory-stale-research'],
    artifactRefs: ['research:aoi-research-old-001/report'],
    riskSignals: [],
    ...partial,
  };
}

function makeMemory(id: string, status: AoiMemoryEntry['status']): AoiMemoryEntry {
  return {
    version: 2,
    id,
    scope: 'agent',
    type: 'fact',
    status,
    content: `Memory ${id}`,
    normalizedContent: `memory ${id}`,
    importance: 0.8,
    confidence: 0.8,
    hits: 1,
    createdAt: 100,
    updatedAt: 100,
    sourceEpisodeIds: ['episode-1'],
    tags: [],
    entities: [],
  };
}

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    status: 'waiting_on_kira',
    activeGoalId: 'aoi-goal-relation-001',
    focusSummary: 'Continue supervised Kira handoff',
    waitingOn: 'kira',
    lastMeaningfulEventRef: 'observation:kira-created',
    nextRecommendedAction: {
      kind: 'inspect_kira',
      label: 'Inspect Kira work status.',
      reason: 'A Kira work item is linked to the mission.',
      ref: 'kira-work:kira-001',
    },
    evidenceRefs: ['goal:aoi-goal-relation-001', 'proposal:proposal-relation-001'],
    sourceRefs: {
      goalRef: 'goal:aoi-goal-relation-001',
      proposalRef: 'proposal:proposal-relation-001',
      kiraWorkRef: 'kira-work:kira-001',
    },
    transitions: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...partial,
  };
}

function makeAttentionEvent(partial: Partial<AoiAttentionEvent> = {}): AoiAttentionEvent {
  return {
    version: 1,
    id: 'aoi-attn-event-relation-001',
    sessionPath: 'aoi/default',
    kind: 'research_completed',
    sourceRef: 'research:aoi-research-relation-001',
    sourceSignature: 'research_completed:aoi-research-relation-001',
    summary: 'Research completed while the user was away.',
    risk: 'low',
    evidenceRefs: ['research:aoi-research-relation-001/report'],
    suggestedAttentionLevel: 'inline',
    createdAt: 1000,
    dedupeKey: 'attention:research_completed:aoi-research-relation-001',
    ...partial,
  };
}

function makeObservation(partial: Partial<AoiObservation> = {}): AoiObservation {
  return {
    version: 1,
    id: 'aoi-obs-attention-relation-001',
    source: 'research_run',
    sessionPath: 'aoi/default',
    createdAt: 1000,
    summary: 'Research completed while the user was away.',
    payloadRef: 'event:aoi-attn-event-relation-001',
    memoryIds: [],
    artifactRefs: ['research:aoi-research-relation-001/report'],
    proposalIds: [],
    riskSignals: ['attention:research_completed'],
    dedupeKey: 'attention:research_completed:aoi-research-relation-001',
    ...partial,
  };
}

function makeGoal(partial: Partial<AoiGoal> = {}): AoiGoal {
  return {
    version: 1,
    id: 'aoi-goal-relation-001',
    sessionPath: 'aoi/default',
    title: 'Complete reviewed Kira handoff',
    userIntentSummary: 'Use Kira to complete a reviewed implementation step.',
    sourceRefs: ['proposal:proposal-relation-001'],
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    lastCheckedAt: 1000,
    confidence: 0.82,
    risk: 'medium',
    owner: 'shared',
    plan: {
      version: 1,
      id: 'aoi-plan-relation-001',
      goalId: 'aoi-goal-relation-001',
      sessionPath: 'aoi/default',
      createdAt: 1000,
      updatedAt: 1000,
      sourceRefs: ['proposal:proposal-relation-001'],
      steps: [makePlanStep()],
    },
    ...partial,
  };
}

function makePlanStep(partial: Partial<AoiPlanStep> = {}): AoiPlanStep {
  return {
    version: 1,
    id: 'step-relation-001',
    kind: 'handoff_kira',
    title: 'Delegate reviewed implementation to Kira',
    status: 'done',
    expectedEvidence: ['kira-work:kira-001'],
    allowedActionKind: 'create_kira_work',
    requiredAutonomyLevel: 'L4',
    doneCriteria: ['Kira reviewer approved the validated outcome.'],
    evidenceRefs: ['kira-work:kira-001'],
    risk: 'medium',
    ...partial,
  };
}

function makeKiraOutcome(partial: Partial<AoiKiraOutcomeEvent> = {}): AoiKiraOutcomeEvent {
  return {
    version: 1,
    id: 'aoi-kira-outcome-relation-001',
    sessionPath: 'aoi/default',
    kind: 'kira_integrated',
    workId: 'kira-001',
    workRef: 'kira-work:kira-001',
    workTitle: 'Implement reviewed Aoi handoff',
    projectName: 'YourOpenRoom',
    attemptId: 'kira-001-1',
    attemptNo: 1,
    reviewId: 'review-kira-001-1',
    sourceProposalId: 'proposal-relation-001',
    sourceGoalId: 'aoi-goal-relation-001',
    sourcePlanStepId: 'step-relation-001',
    validationSummary: 'passed=2 failed=0',
    changedFilesSummary: 'src/lib/aoiAutonomyEngine.ts',
    evidenceRefs: [
      'kira-work:kira-001',
      'kira-attempt:kira-001-1',
      'kira-review:review-kira-001-1',
      'proposal:proposal-relation-001',
      'goal:aoi-goal-relation-001',
      'goal:aoi-goal-relation-001/step:step-relation-001',
    ],
    reviewApproved: true,
    validationPassed: true,
    integrated: true,
    reviewerNotes: ['Follow up with one small UI note.'],
    createdAt: 2000,
    dedupeKey: 'kira-outcome:kira-001:1',
    ...partial,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi autonomy relation index', () => {
  it('preserves app registry display names when routing app context', () => {
    const root = makeTempRoot();
    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      latestUserMessage: "Aoi's IDE에서 지금 구현하던 작업 이어가자",
      now: 2000,
    });

    const appSource = result.selectedSources.find((source) => source.sourceId === 'app-state');
    expect(appSource).toMatchObject({
      displayName: "Aoi's IDE",
      label: "Aoi's IDE app context",
    });
    expect(appSource?.summary).toContain('appName=openvscode');
    expect(appSource?.summary).not.toContain('appId');
  });

  it('excludes disabled context sources from route candidates', () => {
    const root = makeTempRoot();
    updateAoiEnvironmentSource(root, 'aoi/default', {
      sourceId: 'app-state',
      patch: {
        enabled: false,
      },
      now: 2000,
    });

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      latestUserMessage: 'Kira 앱 열어서 reviewed work를 확인하자',
      now: 2000,
    });

    expect(result.candidateSources.some((source) => source.sourceId === 'app-state')).toBe(false);
  });

  it('records proposal evidence edges and deduplicates repeated writes', () => {
    const root = makeTempRoot();
    const proposal = makeProposal();

    const first = recordAoiProposalCreatedRelations(root, proposal, 2000);
    const second = recordAoiProposalCreatedRelations(root, proposal, 3000);

    expect(second.nodes.length).toBe(first.nodes.length);
    expect(second.edges.length).toBe(first.edges.length);
    expect(second.nodes.every((node) => /^[A-Za-z0-9._-]+$/.test(node.id))).toBe(true);
    expect(
      second.edges.some(
        (edge) =>
          edge.kind === 'supports' && edge.evidenceRefs.includes('memory:memory-stale-research'),
      ),
    ).toBe(true);

    const reloaded = loadAoiRelationIndex(root, 'aoi/default');
    expect(reloaded.edges).toHaveLength(second.edges.length);
  });

  it('records recovery proposal links from failure source to goal step', () => {
    const root = makeTempRoot();
    const proposal = makeProposal({
      id: 'proposal-recovery-001',
      trigger: 'failure_recovery',
      evidenceRefs: [
        'research:aoi-research-failed-001',
        'goal:aoi-goal-relation-001',
        'goal:aoi-goal-relation-001/step:step-research',
      ],
      artifactRefs: [
        'research:aoi-research-failed-001',
        'goal:aoi-goal-relation-001',
        'goal:aoi-goal-relation-001/step:step-research',
      ],
      recoveryPreview: {
        version: 1,
        failureKind: 'research_failed',
        rootCauseSummary: 'Observed research failed signal.',
        evidenceRefs: ['research:aoi-research-failed-001', 'goal:aoi-goal-relation-001'],
        proposedAction: {
          kind: 'refresh_research',
          label: 'Refresh research narrowly',
          reason: 'Retry with smaller source budget.',
        },
        whyNarrowerOrSafer: 'Bounded to the failed research run.',
        retryCount: 0,
        maxRetryCount: 1,
        cooldownActive: false,
        sourceRef: 'research:aoi-research-failed-001',
        failureSignature: 'failure:research_failed:test',
        nonGoals: ['Do not execute file writes, patches, deletes, or shell commands.'],
      },
    });

    const index = recordAoiRecoveryProposalRelations(root, proposal, 4000);
    const proposalNode = index.nodes.find((node) => node.ref === 'proposal:proposal-recovery-001');
    const sourceNode = index.nodes.find((node) => node.ref === 'research:aoi-research-failed-001');
    const goalNode = index.nodes.find((node) => node.ref === 'goal:aoi-goal-relation-001');

    expect(proposalNode).toBeTruthy();
    expect(sourceNode).toBeTruthy();
    expect(goalNode).toBeTruthy();
    expect(
      index.edges.some(
        (edge) =>
          edge.from === sourceNode?.id && edge.to === proposalNode?.id && edge.kind === 'supports',
      ),
    ).toBe(true);
    expect(
      index.edges.some(
        (edge) =>
          edge.from === proposalNode?.id && edge.to === goalNode?.id && edge.kind === 'followed_by',
      ),
    ).toBe(true);
  });

  it('deduplicates raw edge upserts by from kind and to', () => {
    const root = makeTempRoot();
    const memory = makeAoiRelationNode({ ref: 'memory:memory-1', now: 1000 });
    const proposal = makeAoiRelationNode({ ref: 'proposal:proposal-1', now: 1000 });
    const edge = makeAoiRelationEdge({
      from: memory.id,
      to: proposal.id,
      kind: 'supports',
      evidenceRefs: ['memory:memory-1'],
      now: 1000,
    });

    upsertAoiRelations(root, 'aoi/default', {
      nodes: [memory, proposal],
      edges: [edge],
      now: 1000,
    });
    const index = upsertAoiRelations(root, 'aoi/default', {
      nodes: [memory, proposal],
      edges: [edge],
      now: 2000,
    });

    expect(index.edges).toHaveLength(1);
    expect(index.edges[0]).toMatchObject({
      from: memory.id,
      to: proposal.id,
      kind: 'supports',
    });
  });

  it('does not treat archived or deleted memories as active through relation traversal', () => {
    const root = makeTempRoot();
    const index = recordAoiProposalCreatedRelations(root, makeProposal(), 2000);
    const activeIds = getActiveAoiRelationMemoryIds(index, [
      makeMemory('memory-stale-research', 'archived'),
      makeMemory('memory-active-other', 'active'),
    ]);

    expect(activeIds).toEqual([]);
  });

  it('records mission links to goal, proposal, and worker refs', () => {
    const root = makeTempRoot();
    const index = recordAoiMissionStateRelations({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      mission: makeMission(),
      now: 3000,
    });

    const missionNode = index.nodes.find((node) => node.kind === 'mission');
    expect(missionNode).toBeTruthy();
    expect(index.nodes.some((node) => node.ref === 'goal:aoi-goal-relation-001')).toBe(true);
    expect(index.nodes.some((node) => node.ref === 'proposal:proposal-relation-001')).toBe(true);
    expect(index.nodes.some((node) => node.ref === 'kira-work:kira-001')).toBe(true);
    expect(
      index.edges.some(
        (edge) => edge.to === missionNode?.id && edge.evidenceRefs.includes('kira-work:kira-001'),
      ),
    ).toBe(true);
  });

  it('records attention event links to observation and proposal refs', () => {
    const root = makeTempRoot();
    const proposal = makeProposal({
      id: 'proposal-attention-relation-001',
      trigger: 'attention_broker',
      evidenceRefs: ['observation:aoi-obs-attention-relation-001'],
    });
    const index = recordAoiAttentionEventRelations({
      sessionsDir: root,
      event: makeAttentionEvent(),
      observation: makeObservation(),
      proposal,
      mission: makeMission(),
      now: 3000,
    });

    const eventNode = index.nodes.find((node) => node.kind === 'event');
    const observationNode = index.nodes.find(
      (node) => node.ref === 'observation:aoi-obs-attention-relation-001',
    );
    const proposalNode = index.nodes.find(
      (node) => node.ref === 'proposal:proposal-attention-relation-001',
    );

    expect(eventNode).toBeTruthy();
    expect(observationNode).toBeTruthy();
    expect(proposalNode).toBeTruthy();
    expect(
      index.edges.some(
        (edge) =>
          edge.from === eventNode?.id &&
          edge.to === observationNode?.id &&
          edge.kind === 'caused_by',
      ),
    ).toBe(true);
    expect(
      index.edges.some(
        (edge) =>
          edge.from === observationNode?.id &&
          edge.to === proposalNode?.id &&
          edge.kind === 'suggested_by',
      ),
    ).toBe(true);
  });

  it('records Kira outcome links across proposal, goal, work, attempt, review, and evidence', () => {
    const root = makeTempRoot();
    const proposal = makeProposal({ id: 'proposal-relation-001' });
    const goal = makeGoal();
    const planStep = goal.plan.steps[0];
    const observation = makeObservation({
      id: 'aoi-obs-kira-outcome-relation-001',
      source: 'kira',
      payloadRef: 'event:aoi-kira-outcome-relation-001',
      artifactRefs: ['kira-work:kira-001'],
      proposalIds: ['proposal-relation-001'],
      riskSignals: ['kira-outcome:kira_integrated'],
      dedupeKey: 'kira-outcome:kira-001:1',
    });

    const index = recordAoiKiraOutcomeRelations({
      sessionsDir: root,
      outcome: makeKiraOutcome(),
      observation,
      proposal,
      goal,
      planStep,
      memoryIds: ['memory-kira-outcome-001'],
      now: 4000,
    });

    expect(index.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'kira_work', ref: 'kira-work:kira-001' }),
        expect.objectContaining({ kind: 'kira_attempt', ref: 'kira-attempt:kira-001-1' }),
        expect.objectContaining({ kind: 'kira_review', ref: 'kira-review:review-kira-001-1' }),
        expect.objectContaining({ kind: 'proposal', ref: 'proposal:proposal-relation-001' }),
        expect.objectContaining({ kind: 'goal', ref: 'goal:aoi-goal-relation-001' }),
        expect.objectContaining({
          kind: 'plan_step',
          ref: 'goal:aoi-goal-relation-001/step:step-relation-001',
        }),
        expect.objectContaining({ kind: 'memory', ref: 'memory:memory-kira-outcome-001' }),
      ]),
    );
    const workNode = index.nodes.find((node) => node.ref === 'kira-work:kira-001');
    const attemptNode = index.nodes.find((node) => node.ref === 'kira-attempt:kira-001-1');
    const reviewNode = index.nodes.find((node) => node.ref === 'kira-review:review-kira-001-1');
    expect(
      index.edges.some(
        (edge) =>
          edge.from === attemptNode?.id && edge.to === workNode?.id && edge.kind === 'belongs_to',
      ),
    ).toBe(true);
    expect(
      index.edges.some(
        (edge) =>
          edge.from === reviewNode?.id && edge.to === workNode?.id && edge.kind === 'belongs_to',
      ),
    ).toBe(true);
  });
});
