import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAoiObservation,
  appendAoiReflection,
  applyAoiProposalDecision,
  buildAoiAutonomyStatus,
  createAoiAutonomyId,
  isValidAoiAutonomyId,
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiAutonomyPolicy,
  loadAoiObservationIndex,
  loadAoiObservations,
  loadAoiProposalDecisions,
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import type { AoiObservation, AoiProposal, AoiReflection } from '../aoiAutonomyTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-test-'));
  tempRoots.push(root);
  return root;
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-test-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Open previous research',
    body: 'A previous Aoi research run may answer this.',
    reason: 'The current topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:kernel-memory',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-001'],
    memoryIds: ['aoi-memory-001'],
    artifactRefs: ['research:aoi-research-001/report'],
    riskSignals: [],
    ...partial,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi autonomy path guards', () => {
  it('normalizes session paths and rejects traversal or absolute paths', () => {
    expect(normalizeAoiAutonomySessionPath(' /aoi/default-mod/ ')).toBe('aoi/default-mod');
    expect(normalizeAoiAutonomySessionPath('aoi\\default')).toBe('aoi/default');
    expect(normalizeAoiAutonomySessionPath('../aoi')).toBeNull();
    expect(normalizeAoiAutonomySessionPath('aoi/../other')).toBeNull();
    expect(normalizeAoiAutonomySessionPath('C:\\Users\\secret')).toBeNull();
    expect(normalizeAoiAutonomySessionPath('aoi//default')).toBeNull();
  });

  it('resolves all storage paths under the session autonomy directory', () => {
    const root = makeTempRoot();
    const paths = resolveAoiAutonomyPaths(root, 'aoi/default');

    expect(paths.root).toBe(resolve(root, 'aoi/default/aoi-autonomy'));
    expect(paths.policy).toBe(join(paths.root, 'policy.json'));
    expect(paths.activeProposals).toBe(join(paths.root, 'proposals', 'active.json'));
    expect(() => resolveAoiAutonomyPaths(root, '../escape')).toThrow(/sessionPath/);
  });

  it('creates stable path-safe ids', () => {
    const id = createAoiAutonomyId('bad prefix!', 1000);

    expect(id).toMatch(/^bad-prefix-/);
    expect(isValidAoiAutonomyId(id)).toBe(true);
    expect(isValidAoiAutonomyId('../bad')).toBe(false);
  });
});

describe('Aoi autonomy policy storage', () => {
  it('loads conservative defaults and saves normalized policy', () => {
    const root = makeTempRoot();

    expect(loadAoiAutonomyPolicy(root, 'aoi/default')).toMatchObject({
      enabled: false,
      previewMode: true,
      level: 'L1',
    });

    const saved = saveAoiAutonomyPolicy(
      root,
      'aoi/default',
      { enabled: true, level: 'L4', maxActiveProposals: 2 },
      1234,
    );

    expect(saved).toMatchObject({
      enabled: true,
      level: 'L4',
      maxActiveProposals: 2,
      updatedAt: 1234,
    });
    expect(loadAoiAutonomyPolicy(root, 'aoi/default')).toMatchObject(saved);
  });
});

describe('Aoi autonomy observations and reflections', () => {
  it('appends and loads observations and reflections latest-first', () => {
    const root = makeTempRoot();
    const observation: AoiObservation = {
      version: 1,
      id: 'observation-test-001',
      source: 'research_run',
      sessionPath: 'aoi/default',
      createdAt: 1000,
      summary: 'Research completed.',
      memoryIds: ['memory-1'],
      artifactRefs: ['research:run-1/report'],
      proposalIds: [],
      riskSignals: [],
      dedupeKey: 'research_run:run-1',
    };
    const reflection: AoiReflection = {
      version: 1,
      id: 'reflection-test-001',
      observationIds: ['observation-test-001'],
      sessionPath: 'aoi/default',
      createdAt: 1500,
      kind: 'opportunity',
      claim: 'Open the completed report when the user asks about the same topic.',
      evidenceRefs: ['observation:observation-test-001'],
      confidence: 0.82,
      risk: 'low',
      proposedMemoryCandidates: [],
      proposedActions: ['read_research_artifact'],
    };

    appendAoiObservation(root, observation);
    appendAoiReflection(root, reflection);

    expect(loadAoiObservations(root, 'aoi/default')).toEqual([observation]);
    expect(loadAoiObservationIndex(root, 'aoi/default').entries).toHaveLength(1);
    expect(loadAoiReflections(root, 'aoi/default')).toEqual([reflection]);
  });
});

describe('Aoi autonomy proposal storage and decisions', () => {
  it('keeps accepted proposals active and archives dismissed proposals', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({ id: 'proposal-test-001' }),
      makeProposal({ id: 'proposal-test-002', cooldownKey: 'research:other' }),
    ]);

    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2000,
    });
    expect(accepted.proposal.status).toBe('accepted');
    expect(
      loadAoiActiveProposals(root, 'aoi/default').find((item) => item.id === 'proposal-test-001')
        ?.status,
    ).toBe('accepted');

    const dismissed = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-002',
      action: 'dismiss',
      reason: 'not useful',
      now: 2500,
    });
    expect(dismissed.proposal.status).toBe('dismissed');
    expect(loadAoiActiveProposals(root, 'aoi/default').map((item) => item.id)).toEqual([
      'proposal-test-001',
    ]);
    expect(loadAoiArchivedProposals(root, 'aoi/default').map((item) => item.id)).toEqual([
      'proposal-test-002',
    ]);
    expect(loadAoiProposalDecisions(root, 'aoi/default')).toHaveLength(2);
  });

  it('snoozes proposals without executing actions', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'snooze',
      snoozeMs: 5000,
      now: 3000,
    });

    expect(result.proposal.status).toBe('snoozed');
    expect(result.proposal.snoozedUntil).toBe(8000);
    expect(result.decision).toMatchObject({
      action: 'snooze',
      cooldownKey: 'research:kernel-memory',
      nextStatus: 'snoozed',
      snoozedUntil: 8000,
    });
  });

  it('rejects invalid proposal transitions', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal({ status: 'accepted' })]);

    expect(() =>
      applyAoiProposalDecision(root, 'aoi/default', {
        proposalId: 'proposal-test-001',
        action: 'dismiss',
      }),
    ).toThrow(/Cannot dismiss proposal/);
  });

  it('builds a compact status summary', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({ id: 'proposal-test-001', status: 'active' }),
      makeProposal({ id: 'proposal-test-002', status: 'snoozed', cooldownKey: 'research:other' }),
    ]);
    appendAoiObservation(root, {
      version: 1,
      id: 'observation-test-001',
      source: 'system',
      sessionPath: 'aoi/default',
      createdAt: 1000,
      summary: 'Observed.',
      memoryIds: [],
      artifactRefs: [],
      proposalIds: [],
      riskSignals: [],
      dedupeKey: 'system:observed',
    });

    const status = buildAoiAutonomyStatus(root, 'aoi/default', 4000);

    expect(status).toMatchObject({
      sessionPath: 'aoi/default',
      activeProposalCount: 1,
      snoozedProposalCount: 1,
      observationCount: 1,
      updatedAt: 4000,
    });
  });
});
