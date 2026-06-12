import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateAoiGoalFromProposal,
  buildAoiGoalProposalFromUserMessage,
} from '../aoiAutonomyGoals';
import { deriveAoiMissionState } from '../aoiAutonomyMission';
import { ingestAoiObservation } from '../aoiAutonomyObserver';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-mission-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function activateGoal(root: string) {
  const proposal = buildAoiGoalProposalFromUserMessage({
    sessionPath: SESSION_PATH,
    latestUserMessage:
      '이 작업을 목표로 관리하자. Aoi workspace signal connector 구현을 끝까지 완료하자.',
    now: NOW,
  });
  if (!proposal) {
    throw new Error('Expected goal proposal.');
  }
  const goal = activateAoiGoalFromProposal({
    sessionsDir: root,
    sessionPath: SESSION_PATH,
    proposal,
    now: NOW,
  });
  if (!goal) {
    throw new Error('Expected active goal.');
  }
  return goal;
}

describe('Aoi autonomy mission workspace signals', () => {
  it('updates the active mission recommendation when workspace validation is stale', () => {
    const root = makeTempRoot();
    const goal = activateGoal(root);
    const goalRef = `goal:${goal.id}`;

    const observation = ingestAoiObservation(root, {
      source: 'workspace',
      sessionPath: SESSION_PATH,
      stableKey: 'workspace-validation-stale',
      createdAt: NOW + 1000,
      summary: 'Workspace validation stale: relevant files changed after the last passed result.',
      payloadRef: 'workspace:snapshot:mission-test',
      artifactRefs: [goalRef, 'workspace:snapshot:mission-test', 'workspace:validation:stale'],
      riskSignals: ['workspace-signal', 'workspace-validation:stale', 'workspace-dirty-tree'],
    }).observation;

    const mission = deriveAoiMissionState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW + 2000,
    });

    expect(mission).toMatchObject({
      status: 'active',
      waitingOn: 'aoi',
      activeGoalId: goal.id,
      nextRecommendedAction: {
        kind: 'prepare_validation',
        ref: `observation:${observation.id}`,
      },
      sourceRefs: {
        goalRef,
        workspaceSnapshotRef: 'workspace:snapshot:mission-test',
        validationRef: 'workspace:validation:stale',
      },
    });
    expect(mission.nextRecommendedAction.label).toContain('validation check');
    expect(mission.nextRecommendedAction.reason).toContain('stale');
    expect(mission.evidenceRefs).toContain(`observation:${observation.id}`);
    expect(mission.evidenceRefs).toContain('workspace:snapshot:mission-test');
  });
});
