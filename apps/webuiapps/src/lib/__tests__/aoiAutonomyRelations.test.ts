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
  recordAoiProposalCreatedRelations,
  upsertAoiRelations,
} from '../aoiAutonomyRelations';
import type { AoiMissionState, AoiProposal } from '../aoiAutonomyTypes';
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi autonomy relation index', () => {
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
});
