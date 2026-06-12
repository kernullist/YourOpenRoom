import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAoiAutonomyTick } from '../aoiAutonomyEngine';
import {
  activateAoiGoalFromProposal,
  aoiPlanStepRequiredLevel,
  applyAoiGoalDecision,
  buildAoiGoalContinuationProposals,
  buildAoiGoalProposalFromUserMessage,
  loadAoiActiveGoals,
  loadAoiArchivedGoals,
  loadAoiGoalProgressEvents,
  saveAoiActiveGoals,
  updateAoiGoalProgressFromObservations,
} from '../aoiAutonomyGoals';
import {
  applyAoiMissionDecision,
  deriveAoiMissionState,
  loadAoiMissionState,
} from '../aoiAutonomyMission';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import {
  applyAoiProposalDecision,
  loadAoiActiveProposals,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';
import type { AoiGoal, AoiObservation, AoiProposal } from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-goals-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeGoal(root: string, message?: string): AoiGoal {
  const proposal = buildAoiGoalProposalFromUserMessage({
    sessionPath: SESSION_PATH,
    latestUserMessage:
      message ?? '이 작업을 목표로 관리하자. 최신 Windows 커널 보안 리서치를 끝까지 정리하자.',
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

function makeObservation(partial: Partial<AoiObservation> = {}): AoiObservation {
  return {
    version: 1,
    id: 'observation-goal-001',
    source: 'system',
    sessionPath: SESSION_PATH,
    createdAt: NOW + 1000,
    summary: 'Progress observed for the tracked Windows kernel security research goal.',
    payloadRef: 'goal-progress:test',
    memoryIds: [],
    artifactRefs: [],
    proposalIds: [],
    riskSignals: [],
    dedupeKey: 'goal-progress:test',
    ...partial,
  };
}

function markFirstStepDone(root: string, goal: AoiGoal): AoiGoal {
  const updated: AoiGoal = {
    ...goal,
    updatedAt: NOW + 500,
    plan: {
      ...goal.plan,
      updatedAt: NOW + 500,
      steps: goal.plan.steps.map((step, index) =>
        index === 0 ? { ...step, status: 'done', evidenceRefs: ['observation:read-done'] } : step,
      ),
    },
  };
  saveAoiActiveGoals(root, SESSION_PATH, [updated]);
  return updated;
}

function makeWaitingProposal(goal: AoiGoal): AoiProposal {
  return {
    version: 1,
    id: 'proposal-user-wait-001',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: 'Confirm goal continuation',
    body: 'Aoi needs user approval before continuing this goal.',
    reason: 'The next action requires explicit approval.',
    trigger: 'goal_continuation',
    createdAt: NOW + 100,
    updatedAt: NOW + 100,
    cooldownKey: `goal-continuation:${goal.id}:user`,
    confidence: 0.8,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['start_research'],
    evidenceRefs: [`goal:${goal.id}`],
    memoryIds: [],
    artifactRefs: [`goal:${goal.id}`],
    riskSignals: ['goal-continuation'],
    acceptAction: {
      kind: 'start_research',
      params: {
        sessionPath: SESSION_PATH,
        request: goal.userIntentSummary,
        mode: 'standard',
      },
    },
  };
}

describe('Aoi autonomy goals', () => {
  it('creates an explicit goal candidate proposal but not from ambiguous text', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, SESSION_PATH, {
      enabled: true,
      previewMode: true,
      level: 'L4',
      maxProposalsPerTick: 4,
    });

    const explicit = buildAoiGoalProposalFromUserMessage({
      sessionPath: SESSION_PATH,
      latestUserMessage: '이걸 목표로 관리하자. 다음 단계까지 계속 추적해줘.',
      now: NOW,
    });
    expect(explicit).toMatchObject({
      trigger: 'goal_candidate',
      requiresUserApproval: true,
      acceptAction: {
        kind: 'activate_goal',
      },
    });

    const ambiguous = buildAoiGoalProposalFromUserMessage({
      sessionPath: SESSION_PATH,
      latestUserMessage: '좋아. 진행해.',
      now: NOW,
    });
    expect(ambiguous).toBeNull();

    const tick = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: '좋아. 진행해.',
      now: NOW,
    });
    expect(tick.newActiveProposalCount).toBe(0);
    expect(loadAoiActiveGoals(root, SESSION_PATH)).toEqual([]);
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toEqual([]);
  });

  it('activates a goal only after the goal proposal is accepted', () => {
    const root = makeTempRoot();
    const proposal = buildAoiGoalProposalFromUserMessage({
      sessionPath: SESSION_PATH,
      latestUserMessage: 'Aoi가 이 목표를 끝까지 추적하고 다음 단계를 제안해줘.',
      now: NOW,
    });
    expect(proposal).not.toBeNull();
    saveAoiActiveProposals(root, SESSION_PATH, [proposal as AoiProposal]);

    expect(loadAoiActiveGoals(root, SESSION_PATH)).toEqual([]);
    const accepted = applyAoiProposalDecision(root, SESSION_PATH, {
      proposalId: (proposal as AoiProposal).id,
      action: 'accept',
      now: NOW + 1000,
    });
    const goal = activateAoiGoalFromProposal({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      proposal: accepted.proposal,
      now: NOW + 1000,
    });

    expect(goal).toMatchObject({
      status: 'active',
      owner: 'shared',
    });
    expect(loadAoiActiveGoals(root, SESSION_PATH)).toHaveLength(1);
    expect(loadAoiGoalProgressEvents(root, SESSION_PATH)[0]).toMatchObject({
      kind: 'activated',
      goalId: goal?.id,
    });
  });

  it('maps high-risk plan steps to approval-gated autonomy levels', () => {
    expect(aoiPlanStepRequiredLevel('read', 'low')).toBe('L2');
    expect(aoiPlanStepRequiredLevel('research', 'medium')).toBe('L4');
    expect(aoiPlanStepRequiredLevel('execute_proposal', 'high')).toBe('L4');
  });

  it('updates progress from matching observations', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);

    const result = updateAoiGoalProgressFromObservations({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      observations: [
        makeObservation({
          artifactRefs: [`goal:${goal.id}`],
        }),
      ],
      now: NOW + 2000,
    });

    expect(result.events.some((event) => event.kind === 'progress')).toBe(true);
    expect(loadAoiActiveGoals(root, SESSION_PATH)[0].plan.steps[0].status).toBe('done');
  });

  it('blocks goals only with clear blocking evidence', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);

    updateAoiGoalProgressFromObservations({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      observations: [],
      now: NOW + 2000,
    });
    expect(loadAoiActiveGoals(root, SESSION_PATH)[0].status).toBe('active');

    updateAoiGoalProgressFromObservations({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      observations: [
        makeObservation({
          id: 'observation-goal-fail-001',
          summary: 'Goal related research failed with a retriable error.',
          artifactRefs: [`goal:${goal.id}`],
          riskSignals: ['research-failed'],
          dedupeKey: 'goal-progress:fail-1',
        }),
        makeObservation({
          id: 'observation-goal-fail-002',
          summary: 'Goal related Kira handoff failed again.',
          artifactRefs: [`goal:${goal.id}`],
          riskSignals: ['kira-failed'],
          dedupeKey: 'goal-progress:fail-2',
        }),
      ],
      now: NOW + 3000,
    });

    expect(loadAoiActiveGoals(root, SESSION_PATH)[0].status).toBe('blocked');
    expect(loadAoiGoalProgressEvents(root, SESSION_PATH)[0].kind).toBe('blocked');
  });

  it('requires evidence or explicit user confirmation for completion', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);

    expect(() =>
      applyAoiGoalDecision(root, SESSION_PATH, {
        goalId: goal.id,
        action: 'complete',
        now: NOW + 1000,
      }),
    ).toThrow(/requires evidence/);

    const completed = applyAoiGoalDecision(root, SESSION_PATH, {
      goalId: goal.id,
      action: 'complete',
      userConfirmed: true,
      reason: 'User confirmed this goal is complete.',
      now: NOW + 2000,
    });
    expect(completed.status).toBe('completed');
    expect(loadAoiActiveGoals(root, SESSION_PATH)).toEqual([]);
    expect(loadAoiArchivedGoals(root, SESSION_PATH)[0]).toMatchObject({
      id: goal.id,
      status: 'completed',
    });
  });

  it('does not repeat duplicate continuation proposals while cooldown is active', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);
    const first = buildAoiGoalContinuationProposals({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      observations: [],
      activeProposals: [],
      now: NOW + 1000,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      trigger: 'goal_continuation',
      artifactRefs: [`goal:${goal.id}`, `goal:${goal.id}/step:${goal.plan.steps[0].id}`],
    });

    saveAoiActiveProposals(root, SESSION_PATH, first);
    const second = buildAoiGoalContinuationProposals({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      observations: [],
      activeProposals: first,
      now: NOW + 2000,
    });

    expect(second).toEqual([]);
  });

  it('persists one compact mission snapshot and records audit refs', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);

    const mission = deriveAoiMissionState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
    });
    const reloaded = loadAoiMissionState(root, SESSION_PATH);
    const second = deriveAoiMissionState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW + 2000,
    });
    const relations = loadAoiRelationIndex(root, SESSION_PATH);
    const ledger = loadServerAoiRunLedger(root, SESSION_PATH);

    expect(mission).toMatchObject({
      status: 'active',
      activeGoalId: goal.id,
      sourceRefs: {
        goalRef: `goal:${goal.id}`,
      },
    });
    expect(reloaded?.activeGoalId).toBe(goal.id);
    expect(second.activeGoalId).toBe(goal.id);
    expect(second.transitions.length).toBe(mission.transitions.length);
    expect(relations.nodes.some((node) => node.kind === 'mission')).toBe(true);
    expect(
      ledger.some((entry) => entry.events.some((event) => event.type === 'mission_activated')),
    ).toBe(true);
  });

  it('does not keep completed goals as active mission focus', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);
    applyAoiGoalDecision(root, SESSION_PATH, {
      goalId: goal.id,
      action: 'complete',
      userConfirmed: true,
      reason: 'User confirmed completion.',
      now: NOW + 1000,
    });

    const mission = deriveAoiMissionState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW + 2000,
    });

    expect(mission.status).toBe('none');
    expect(mission.activeGoalId).toBeUndefined();
    expect(mission.nextRecommendedAction.kind).toBe('none');
  });

  it('derives user, Kira, and research waiting states from current sources', () => {
    const userRoot = makeTempRoot();
    const userGoal = makeGoal(userRoot);
    saveAoiActiveProposals(userRoot, SESSION_PATH, [makeWaitingProposal(userGoal)]);
    expect(
      deriveAoiMissionState({
        sessionsDir: userRoot,
        sessionPath: SESSION_PATH,
        now: NOW + 1000,
      }),
    ).toMatchObject({
      status: 'waiting_on_user',
      waitingOn: 'user',
    });

    const kiraRoot = makeTempRoot();
    const kiraGoal = markFirstStepDone(
      kiraRoot,
      makeGoal(kiraRoot, 'Kira에게 넘길 자동화 작업을 목표로 관리하자.'),
    );
    expect(kiraGoal.plan.steps.some((step) => step.kind === 'handoff_kira')).toBe(true);
    expect(
      deriveAoiMissionState({
        sessionsDir: kiraRoot,
        sessionPath: SESSION_PATH,
        now: NOW + 1000,
      }),
    ).toMatchObject({
      status: 'waiting_on_kira',
      waitingOn: 'kira',
    });

    const researchRoot = makeTempRoot();
    const researchGoal = markFirstStepDone(
      researchRoot,
      makeGoal(researchRoot, '최신 Windows 커널 보안 리서치를 목표로 관리하자.'),
    );
    expect(researchGoal.plan.steps.some((step) => step.kind === 'research')).toBe(true);
    expect(
      deriveAoiMissionState({
        sessionsDir: researchRoot,
        sessionPath: SESSION_PATH,
        now: NOW + 1000,
      }),
    ).toMatchObject({
      status: 'waiting_on_research',
      waitingOn: 'research',
    });
  });

  it('pauses and resumes mission focus without deleting evidence or creating proposals', () => {
    const root = makeTempRoot();
    const goal = makeGoal(root);
    const proposal = makeWaitingProposal(goal);
    saveAoiActiveProposals(root, SESSION_PATH, [proposal]);
    const initial = deriveAoiMissionState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
    });

    const paused = applyAoiMissionDecision(root, SESSION_PATH, {
      action: 'pause',
      now: NOW + 2000,
      reason: 'Pause from test.',
    });
    const resumed = applyAoiMissionDecision(root, SESSION_PATH, {
      action: 'resume',
      now: NOW + 3000,
      reason: 'Resume from test.',
    });

    expect(paused.status).toBe('paused');
    expect(paused.evidenceRefs).toEqual(expect.arrayContaining(initial.evidenceRefs));
    expect(resumed.status).toBe('waiting_on_user');
    expect(loadAoiActiveProposals(root, SESSION_PATH).map((item) => item.id)).toEqual([
      proposal.id,
    ]);
  });
});
