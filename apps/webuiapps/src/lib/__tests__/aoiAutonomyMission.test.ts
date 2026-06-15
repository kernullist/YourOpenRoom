import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateAoiGoalFromProposal,
  buildAoiGoalProposalFromUserMessage,
} from '../aoiAutonomyGoals';
import { deriveAoiMissionState } from '../aoiAutonomyMission';
import {
  buildAoiMissionMemoryDashboardContext,
  buildAoiMissionMemoryEvaluationReport,
  buildAoiMissionMemoryReport,
  buildAoiMissionMemorySnapshot,
} from '../aoiMissionMemory';
import { loadAoiMissionMemoryReport, saveAoiMissionMemoryReport } from '../aoiMissionMemoryStore';
import { ingestAoiObservation } from '../aoiAutonomyObserver';
import type {
  AoiApprovedCommandPolicy,
  AoiMissionState,
  AoiPlaybook,
  AoiTrustCalibrationProfile,
  AoiWorkspaceSnapshot,
} from '../aoiAutonomyTypes';

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

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    status: 'active',
    activeGoalId: 'goal-mission-memory',
    focusSummary: 'Finish long-running mission memory.',
    waitingOn: 'aoi',
    lastMeaningfulEventRef: 'timeline:mission-memory',
    nextRecommendedAction: {
      kind: 'prepare_validation',
      label: 'Refresh validation evidence.',
      reason: 'Workspace validation may be stale.',
      ref: 'workspace:validation:stale',
    },
    evidenceRefs: ['mission:evidence'],
    sourceRefs: {
      goalRef: 'goal:goal-mission-memory',
      workspaceSnapshotRef: 'workspace:snapshot:mission-memory',
      validationRef: 'workspace:validation:stale',
    },
    transitions: [
      {
        from: 'none',
        to: 'active',
        createdAt: NOW,
        reason: 'Mission activated from goal evidence.',
        evidenceRefs: ['goal:goal-mission-memory'],
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function makeWorkspaceSnapshot(partial: Partial<AoiWorkspaceSnapshot> = {}): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: NOW,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace'],
    validation: {
      version: 1,
      command: 'pnpm --filter @openroom/webuiapps test',
      result: 'unknown',
      completedAt: NOW - 60_000,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'stale',
      staleReason: 'Changed files touched mission memory after validation.',
      evidenceRefs: ['workspace:validation:stale'],
    },
    freshness: 'stale',
    evidenceRefs: ['workspace:snapshot:mission-memory'],
    warnings: ['Validation stale.'],
    ...partial,
  };
}

function makeApprovalPolicy(
  partial: Partial<AoiApprovedCommandPolicy> = {},
): AoiApprovedCommandPolicy {
  return {
    version: 1,
    allowed: true,
    blockReasons: [],
    command:
      'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyMission.test.ts',
    displayCommand:
      'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyMission.test.ts',
    program: 'pnpm',
    args: ['--filter', '@openroom/webuiapps', 'test'],
    cwd: 'apps/webuiapps',
    cwdLabel: 'apps/webuiapps',
    cwdHash: 'cwd-hash',
    purpose: 'Validate mission memory.',
    purposeHash: 'purpose-hash',
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    timeoutMs: 120000,
    approvalFingerprint: 'approval-mission-memory',
    expiresAt: NOW + 60_000,
    rationale: ['User approval is required for command execution.'],
    ...partial,
  };
}

function makePlaybook(partial: Partial<AoiPlaybook> = {}): AoiPlaybook {
  return {
    version: 1,
    id: 'playbook-mission-memory',
    sessionPath: SESSION_PATH,
    title: 'Mission memory playbook',
    objective: 'Preserve long-running mission state.',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    sourceRefs: ['goal:goal-mission-memory'],
    evidenceRefs: ['playbook:evidence'],
    goalId: 'goal-mission-memory',
    missionRef: 'mission:goal-mission-memory',
    healthIssueRefs: [],
    blockedReasons: [],
    nextStepId: 'step-approval',
    nextRequiredDecision: 'Ask the user to approve validation.',
    steps: [
      {
        version: 1,
        id: 'step-approval',
        kind: 'preview_command',
        title: 'Run validation',
        summary: 'Preview validation command before execution.',
        status: 'waiting_for_approval',
        dependsOn: [],
        evidenceRefs: ['playbook-step:approval'],
        sourceRefs: ['goal:goal-mission-memory'],
        blockedReasons: [],
        executionBoundary: {
          version: 1,
          mutationCapable: false,
          commandCapable: true,
          requiresApproval: true,
          requiredAutonomyLevel: 'L5',
          freshAcceptanceRequired: true,
          approver: 'user',
          existingGate: 'approved_command',
          canAutoRun: false,
          summary: 'Command preview only until user approval is fresh.',
          approvalRef: 'command-approval:approval-mission-memory',
        },
        checkpointNotes: [],
        rollbackNotes: [],
        validationNotes: ['Validation result must be refreshed.'],
        refs: {
          goalRef: 'goal:goal-mission-memory',
          missionRef: 'mission:goal-mission-memory',
          commandAuditRef: 'command-approval:approval-mission-memory',
        },
        updatedAt: NOW,
      },
    ],
    edges: [],
    ...partial,
  };
}

function makeTrustCalibrationProfile(
  partial: Partial<AoiTrustCalibrationProfile> = {},
): AoiTrustCalibrationProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    interruptionPolicy: {
      version: 1,
      defaultThreshold: 0.55,
      askFirstThreshold: 0.74,
      suppressThreshold: 0.25,
      minInterruptionGapMs: 900000,
      positiveLearningCap: 0.2,
      negativeLearningCap: -0.2,
    },
    triggerCalibrations: [],
    sourceCalibrations: [],
    actionCalibrations: [],
    riskCalibration: {
      low: 0,
      medium: 0,
      high: 0,
    },
    laneCalibration: {},
    voiceCalibration: {},
    feedbackCalibration: {},
    topSuppressedCategories: [],
    negativeSources: [],
    recentChanges: [
      {
        version: 1,
        id: 'calibration-safety-001',
        dimension: 'feedback_category',
        key: 'unsafe',
        direction: 'safety',
        delta: -0.2,
        reason: 'User marked a prior suggestion unsafe.',
        createdAt: NOW,
        evidenceRefs: ['feedback:unsafe-001'],
        feedbackCategory: 'unsafe',
        replayBlocked: true,
      },
    ],
    resetCategories: [],
    ...partial,
  };
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

  it('builds evidence-backed long-running mission memory without leaking private content', () => {
    const root = makeTempRoot();
    const goal = activateGoal(root);
    const mission = makeMission({
      activeGoalId: goal.id,
      focusSummary:
        'Finish mission memory for private-roadmap@example.com in F:\\private\\aoi\\notes.',
      sourceRefs: {
        goalRef: `goal:${goal.id}`,
        workspaceSnapshotRef: 'workspace:snapshot:mission-memory',
        validationRef: 'workspace:validation:stale',
      },
      evidenceRefs: ['mission:evidence', `goal:${goal.id}`],
    });

    const snapshot = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission,
      goals: [goal],
      workspaceSnapshot: makeWorkspaceSnapshot(),
      now: NOW + 1000,
    });
    const secondSnapshot = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission,
      goals: [goal],
      workspaceSnapshot: makeWorkspaceSnapshot(),
      now: NOW + 2000,
    });
    const report = buildAoiMissionMemoryReport({
      sessionPath: SESSION_PATH,
      snapshots: [snapshot],
      now: NOW + 3000,
    });
    const persisted = saveAoiMissionMemoryReport({
      sessionsDir: root,
      report,
    });
    const loaded = loadAoiMissionMemoryReport({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
    });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.id).toBe(secondSnapshot.id);
    expect(snapshot.missionId).toBe(`goal:${goal.id}`);
    expect(snapshot.lastKnownState).toContain('active');
    expect(snapshot.staleValidationRefs).toContain('workspace:validation:stale');
    expect(snapshot.evidenceRefs).toContain(`goal:${goal.id}`);
    expect(snapshot.signals.some((signal) => signal.kind === 'last_known_state')).toBe(true);
    expect(persisted.id).toBe(report.id);
    expect(loaded?.snapshots[0]?.evidenceRefs).toContain(`goal:${goal.id}`);
    expect(report.activeSnapshot?.id).toBe(snapshot.id);
    expect(report.staleSnapshotCount).toBe(1);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('F:\\private\\aoi\\notes');
  });

  it('degrades expired mission memory to refresh-required while preserving stale validation refs', () => {
    const previous = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission: makeMission(),
      workspaceSnapshot: makeWorkspaceSnapshot(),
      now: NOW,
      ttlMs: 1000,
    });

    const expired = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      previousSnapshot: previous,
      now: NOW + 2000,
      ttlMs: 1000,
    });

    expect(expired.freshness).toBe('expired');
    expect(expired.needsRefresh).toBe(true);
    expect(expired.lastKnownState).toBe(previous.lastKnownState);
    expect(expired.staleValidationRefs).toEqual(previous.staleValidationRefs);
    expect(expired.signals.some((signal) => signal.kind === 'needs_refresh')).toBe(true);
    expect(expired.evidenceRefs).toContain(`expired-at:${previous.expiresAt}`);
  });

  it('clears stale validation refs when fresh validation evidence arrives', () => {
    const previous = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission: makeMission(),
      workspaceSnapshot: makeWorkspaceSnapshot(),
      now: NOW,
    });
    const refreshed = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission: makeMission(),
      workspaceSnapshot: makeWorkspaceSnapshot({
        validation: {
          version: 1,
          command: 'pnpm --filter @openroom/webuiapps test',
          result: 'passed',
          completedAt: NOW + 500,
          touchedFileScopes: ['apps/webuiapps/src/lib'],
          freshness: 'fresh',
          evidenceRefs: ['workspace:validation:fresh'],
        },
        freshness: 'fresh',
        evidenceRefs: ['workspace:snapshot:fresh', 'workspace:validation:fresh'],
        warnings: [],
      }),
      previousSnapshot: previous,
      now: NOW + 1000,
    });

    expect(previous.staleValidationRefs).toContain('workspace:validation:stale');
    expect(refreshed.freshness).toBe('fresh');
    expect(refreshed.needsRefresh).toBe(false);
    expect(refreshed.staleValidationRefs).toEqual([]);
  });

  it('blocks overconfident next actions while external mission evidence is pending', () => {
    const mission = makeMission({
      status: 'waiting_on_kira',
      waitingOn: 'kira',
      nextRecommendedAction: {
        kind: 'inspect_kira',
        label: 'Wait for Kira review.',
        reason: 'Kira work is still pending.',
        ref: 'kira:work:mission-memory',
      },
      sourceRefs: {
        goalRef: 'goal:goal-mission-memory',
        kiraWorkRef: 'kira:work:mission-memory',
      },
      evidenceRefs: ['kira:work:mission-memory'],
    });
    const playbook = makePlaybook({
      nextStepId: 'step-external',
      steps: [
        {
          ...makePlaybook().steps[0],
          id: 'step-external',
          kind: 'wait_for_external_event',
          title: 'Wait for Kira result',
          summary: 'Kira review has not returned yet.',
          status: 'waiting_for_external_event',
          refs: {
            goalRef: 'goal:goal-mission-memory',
            missionRef: 'mission:goal-mission-memory',
            kiraWorkRef: 'kira:work:mission-memory',
          },
          evidenceRefs: ['kira:work:mission-memory'],
        },
      ],
    });

    const snapshot = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission,
      playbooks: [playbook],
      now: NOW + 1000,
    });
    const context = buildAoiMissionMemoryDashboardContext(snapshot);
    const evaluation = buildAoiMissionMemoryEvaluationReport({
      sessionPath: SESSION_PATH,
      afterSnapshot: snapshot,
      now: NOW + 2000,
    });

    expect(snapshot.pendingExternalRefs).toContain('kira:work:mission-memory');
    expect(context?.nextSafeActionLabel).toContain('Wait for external evidence');
    expect(context?.blockedReasonLabels).toContain('pending external evidence');
    expect(
      evaluation.metrics.find((metric) => metric.id === 'pending_external_preserved')?.passed,
    ).toBe(true);
  });

  it('preserves next approval refs across a session gap without new evidence', () => {
    const previous = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission: makeMission(),
      playbooks: [makePlaybook()],
      approvedCommandPolicies: [makeApprovalPolicy()],
      now: NOW,
    });

    const resumed = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      previousSnapshot: previous,
      now: NOW + 5000,
    });

    expect(previous.nextApprovalRefs).toContain('command-approval:approval-mission-memory');
    expect(resumed.freshness).toBe('stale');
    expect(resumed.nextApprovalRefs).toEqual(previous.nextApprovalRefs);
    expect(resumed.signals.some((signal) => signal.kind === 'next_approval')).toBe(true);
  });

  it('tracks preference drift without overriding safety or project instructions', () => {
    const snapshot = buildAoiMissionMemorySnapshot({
      sessionPath: SESSION_PATH,
      mission: makeMission(),
      playbooks: [makePlaybook()],
      trustCalibration: makeTrustCalibrationProfile(),
      now: NOW + 1000,
    });
    const driftSignal = snapshot.signals.find((signal) => signal.kind === 'preference_drift');
    const context = buildAoiMissionMemoryDashboardContext(snapshot);

    expect(snapshot.preferenceDriftRefs).toContain('trust-calibration:calibration-safety-001');
    expect(driftSignal?.summary).toContain('safety rules');
    expect(snapshot.nextApprovalRefs).toContain('command-approval:approval-mission-memory');
    expect(context?.boundaryLabel).toContain('display-only');
  });
});
