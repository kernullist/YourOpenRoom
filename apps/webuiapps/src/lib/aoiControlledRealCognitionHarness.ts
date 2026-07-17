import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { join } from 'path';

import { recordAoiActivityEvent, loadAoiActivityStreamSummary } from './aoiActivityStream';
import {
  activateAoiGoalFromProposal,
  buildAoiGoalProposalFromUserMessage,
  loadAoiActiveGoals,
  loadAoiArchivedGoals,
  loadAoiGoalProgressEvents,
  saveAoiActiveGoals,
  updateAoiGoalProgressFromObservations,
  updateAoiGoalProgressFromOutcomeSignals,
} from './aoiAutonomyGoals';
import { deriveAoiMissionState } from './aoiAutonomyMission';
import {
  appendAoiOutcomeSignalRecord,
  loadAoiEnvironmentSourceRegistry,
  saveAoiArchivedProposals,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import type { AoiGoal, AoiObservation, AoiProposal } from './aoiAutonomyTypes';
import { buildAoiServerCognitionReadinessScorecard } from './aoiCognitionReadinessServer';
import { buildAoiCurrentSituation, saveAoiCurrentSituation } from './aoiCurrentSituationModel';
import { buildAoiIntentState, saveAoiIntentState } from './aoiIntentInference';
import { createAoiLocalEmbeddingProvider } from './aoiLocalEmbedding';
import { loadAoiMemoryEmbeddingStatus } from './aoiMemoryEmbeddingStatus';
import { buildAoiMemoryDiagnostics, loadAoiMemoryRecallTrials } from './aoiMemoryRecallDiagnostics';
import { runAoiMeasuredMemoryRecall } from './aoiMeasuredMemoryRecall';
import {
  loadServerAoiMemories,
  saveServerAoiMemoryCandidatesWithEmbedding,
} from './aoiMemoryServerWriter';

export type AoiControlledRealCognitionScenarioId =
  | 'consented_grounded_situation'
  | 'dark_source_fail_closed'
  | 'measured_memory_recall'
  | 'validated_goal_continuity';

export interface AoiControlledRealGroundedScenario {
  version: 1;
  id: 'consented_grounded_situation';
  passed: boolean;
  cognitionScore: number;
  cognitionLevel: string;
  canSupportPromotion: boolean;
  situationSampleCount: number;
  activitySourceStatus: string;
  activityMetadataOnly: boolean;
  evidenceRefs: string[];
}

export interface AoiControlledRealDarkScenario {
  version: 1;
  id: 'dark_source_fail_closed';
  passed: boolean;
  activityEventBlocked: boolean;
  cognitionLevel: string;
  canSupportPromotion: boolean;
  activitySourceStatus: string;
  privateBaitAbsent: boolean;
  evidenceRefs: string[];
}

export interface AoiControlledRealMemoryScenario {
  version: 1;
  id: 'measured_memory_recall';
  passed: boolean;
  recallSampleCount: number;
  successfulRecallCount: number;
  recallMissCount: number;
  localFallbackVerified: boolean;
  embeddingCoverage: number;
  conflictResolutionCount: number;
  supersessionCount: number;
  decayCandidateCount: number;
  evidenceRefs: string[];
}

export interface AoiControlledRealGoalScenario {
  version: 1;
  id: 'validated_goal_continuity';
  passed: boolean;
  wakeupCount: number;
  goalPersistedAcrossWakeups: boolean;
  completedFromOutcome: boolean;
  outcomeBackedCompletion: boolean;
  completionEventCount: number;
  evidenceRefs: string[];
}

export type AoiControlledRealCognitionScenario =
  | AoiControlledRealGroundedScenario
  | AoiControlledRealDarkScenario
  | AoiControlledRealMemoryScenario
  | AoiControlledRealGoalScenario;

export interface AoiControlledRealCognitionReport {
  version: 1;
  id: string;
  evidenceClass: 'controlled_real';
  generatedAt: number;
  passed: boolean;
  scenarioCount: number;
  passedScenarioCount: number;
  behaviorFingerprint: string;
  cleanupVerified: boolean;
  scenarios: AoiControlledRealCognitionScenario[];
  evidenceRefs: string[];
  actionAuthority: 'disposable_workspace_only';
}

const CONTROLLED_SESSION = 'aoi/controlled-cognition';
const DARK_SESSION = 'aoi/controlled-dark';
const PRIVATE_BAIT = 'private-bait-user@example.invalid';

function fingerprintValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function fingerprintAoiControlledRealCognitionBehavior(
  scenarios: readonly AoiControlledRealCognitionScenario[],
): string {
  return fingerprintValue(
    scenarios.map((scenario) => {
      const behavior: Partial<AoiControlledRealCognitionScenario> = { ...scenario };
      delete behavior.evidenceRefs;
      return behavior;
    }),
  );
}

function treeContainsText(root: string, needle: string): boolean {
  const visit = (candidate: string): boolean => {
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      const target = join(candidate, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (visit(target)) {
          return true;
        }
        continue;
      }
      if (entry.isFile() && fs.statSync(target).size <= 2 * 1024 * 1024) {
        if (fs.readFileSync(target, 'utf8').includes(needle)) {
          return true;
        }
      }
    }
    return false;
  };
  return visit(root);
}

function runGroundedScenario(sessionsDir: string, now: number): AoiControlledRealGroundedScenario {
  updateAoiEnvironmentSource(sessionsDir, CONTROLLED_SESSION, {
    sourceId: 'research-runs',
    patch: { enabled: false },
    now,
  });
  updateAoiEnvironmentSource(sessionsDir, CONTROLLED_SESSION, {
    sourceId: 'app-activity',
    patch: {
      enabled: true,
      consentReason: 'Operator approved metadata-only activity for this controlled-real trial.',
      lastReviewedAt: now,
    },
    now,
  });
  const opened = recordAoiActivityEvent(
    sessionsDir,
    CONTROLLED_SESSION,
    { kind: 'app_opened', appId: 'notesapp', observedAt: now - 2000 },
    now,
  );
  const action = recordAoiActivityEvent(
    sessionsDir,
    CONTROLLED_SESSION,
    {
      kind: 'app_action',
      appId: 'notesapp',
      actionType: 'EDIT_NOTE',
      observedAt: now - 1000,
    },
    now,
  );
  const activitySummary = loadAoiActivityStreamSummary(sessionsDir, CONTROLLED_SESSION, now);
  const registry = loadAoiEnvironmentSourceRegistry(sessionsDir, CONTROLLED_SESSION, now);
  const intent = buildAoiIntentState({
    sessionPath: CONTROLLED_SESSION,
    now,
    registry,
    activitySummary,
  });
  saveAoiIntentState(sessionsDir, intent);
  for (let index = 0; index < 3; index += 1) {
    saveAoiCurrentSituation(
      sessionsDir,
      buildAoiCurrentSituation({
        sessionPath: CONTROLLED_SESSION,
        now: now + index,
        intentState: intent,
        activitySummary,
        lastUserMessageAt: now - 60_000,
      }),
    );
  }
  const scorecard = buildAoiServerCognitionReadinessScorecard({
    sessionsDir,
    sessionPath: CONTROLLED_SESSION,
    now: now + 3,
  });
  const activityDiagnostic = scorecard.sourceDiagnostics.find(
    (source) => source.sourceId === 'app-activity',
  );
  const activityMetadataOnly = Boolean(
    opened.event?.privacyState === 'metadata_only' &&
    action.event?.privacyState === 'metadata_only' &&
    opened.event?.actionAuthority === 'display_only' &&
    action.event?.actionAuthority === 'display_only',
  );
  const passed = Boolean(
    opened.recorded &&
    action.recorded &&
    scorecard.score >= 85 &&
    scorecard.level === 'live_grounded' &&
    scorecard.canSupportPromotion &&
    activityDiagnostic?.status === 'fresh' &&
    activityMetadataOnly,
  );
  return {
    version: 1,
    id: 'consented_grounded_situation',
    passed,
    cognitionScore: scorecard.score,
    cognitionLevel: scorecard.level,
    canSupportPromotion: scorecard.canSupportPromotion,
    situationSampleCount:
      scorecard.metrics.find((metric) => metric.key === 'situation_sample_count')?.value ?? 0,
    activitySourceStatus: activityDiagnostic?.status ?? 'missing',
    activityMetadataOnly,
    evidenceRefs: [
      'controlled-real-cognition:consented-grounded-situation',
      ...scorecard.evidenceRefs.slice(0, 6),
    ],
  };
}

function runDarkScenario(sessionsDir: string, now: number): AoiControlledRealDarkScenario {
  updateAoiEnvironmentSource(sessionsDir, DARK_SESSION, {
    sourceId: 'app-activity',
    patch: { enabled: true },
    now,
  });
  const attempted = recordAoiActivityEvent(
    sessionsDir,
    DARK_SESSION,
    { kind: 'app_opened', appId: PRIVATE_BAIT, observedAt: now },
    now,
  );
  const scorecard = buildAoiServerCognitionReadinessScorecard({
    sessionsDir,
    sessionPath: DARK_SESSION,
    now,
  });
  const activityDiagnostic = scorecard.sourceDiagnostics.find(
    (source) => source.sourceId === 'app-activity',
  );
  const privateBaitAbsent = !treeContainsText(sessionsDir, PRIVATE_BAIT);
  const passed = Boolean(
    !attempted.recorded &&
    scorecard.level === 'ungrounded' &&
    !scorecard.canSupportPromotion &&
    activityDiagnostic?.status === 'consent_missing' &&
    privateBaitAbsent,
  );
  return {
    version: 1,
    id: 'dark_source_fail_closed',
    passed,
    activityEventBlocked: !attempted.recorded,
    cognitionLevel: scorecard.level,
    canSupportPromotion: scorecard.canSupportPromotion,
    activitySourceStatus: activityDiagnostic?.status ?? 'missing',
    privateBaitAbsent,
    evidenceRefs: ['controlled-real-cognition:dark-source-fail-closed'],
  };
}

async function runMemoryScenario(
  sessionsDir: string,
  now: number,
): Promise<AoiControlledRealMemoryScenario> {
  const provider = createAoiLocalEmbeddingProvider();
  await saveServerAoiMemoryCandidatesWithEmbedding(
    sessionsDir,
    CONTROLLED_SESSION,
    [
      {
        type: 'preference',
        content: 'The user prefers Korean security engineering answers.',
        importance: 0.95,
        confidence: 0.95,
        tags: ['language', 'security'],
      },
      {
        type: 'fact',
        content: 'Project codename cobalt uses deterministic validation receipts.',
        importance: 0.92,
        confidence: 0.94,
        tags: ['cobalt', 'validation'],
      },
      {
        type: 'procedure',
        content: 'Before release, run the narrow regression suite and verify the artifact hash.',
        importance: 0.9,
        confidence: 0.93,
        tags: ['release', 'regression'],
      },
      {
        type: 'event',
        content: 'Temporary expired recall evidence sample.',
        importance: 0.5,
        confidence: 0.4,
        expiresAt: now - 1,
      },
    ],
    'controlled-memory-initial',
    provider,
  );
  await saveServerAoiMemoryCandidatesWithEmbedding(
    sessionsDir,
    CONTROLLED_SESSION,
    [
      {
        type: 'fact',
        content: "The user's name is Alice.",
        importance: 0.8,
        confidence: 0.9,
      },
    ],
    'controlled-memory-name-alice',
    provider,
  );
  await saveServerAoiMemoryCandidatesWithEmbedding(
    sessionsDir,
    CONTROLLED_SESSION,
    [
      {
        type: 'fact',
        content: "The user's name is Bob.",
        importance: 0.9,
        confidence: 0.95,
      },
    ],
    'controlled-memory-name-bob',
    provider,
  );
  const memories = loadServerAoiMemories(sessionsDir).filter(
    (memory) => memory.sessionPath === CONTROLLED_SESSION,
  );
  const probes = [
    ['Korean security answers', 'The user prefers'],
    ['cobalt validation receipts', 'Project codename cobalt'],
    ['release regression artifact hash', 'Before release'],
  ] as const;
  for (let index = 0; index < probes.length; index += 1) {
    const [query, prefix] = probes[index];
    const expected = memories.find((memory) => memory.content.startsWith(prefix));
    if (!expected) {
      throw new Error(`Controlled-real memory fixture missing: ${prefix}`);
    }
    await runAoiMeasuredMemoryRecall({
      sessionsDir,
      sessionPath: CONTROLLED_SESSION,
      query,
      expectedMemoryIds: [expected.id],
      provider,
      limit: 1,
      now: now - 100 + index,
    });
  }
  const diagnostics = buildAoiMemoryDiagnostics({
    sessionPath: CONTROLLED_SESSION,
    memories: loadServerAoiMemories(sessionsDir),
    embeddingStatus: loadAoiMemoryEmbeddingStatus(sessionsDir, { provider }),
    recallTrials: loadAoiMemoryRecallTrials(sessionsDir, CONTROLLED_SESSION),
    now,
  });
  const passed = Boolean(
    diagnostics.recallSampleCount >= 3 &&
    diagnostics.successfulRecallCount === diagnostics.recallSampleCount &&
    diagnostics.localFallbackVerified &&
    diagnostics.embeddingCoverage === 1 &&
    diagnostics.conflictResolutionCount >= 1 &&
    diagnostics.supersessionCount >= 1 &&
    diagnostics.decayCandidateCount >= 1,
  );
  return {
    version: 1,
    id: 'measured_memory_recall',
    passed,
    recallSampleCount: diagnostics.recallSampleCount,
    successfulRecallCount: diagnostics.successfulRecallCount,
    recallMissCount: diagnostics.recallMissCount,
    localFallbackVerified: diagnostics.localFallbackVerified,
    embeddingCoverage: diagnostics.embeddingCoverage,
    conflictResolutionCount: diagnostics.conflictResolutionCount,
    supersessionCount: diagnostics.supersessionCount,
    decayCandidateCount: diagnostics.decayCandidateCount,
    evidenceRefs: [
      'controlled-real-cognition:measured-memory-recall',
      ...diagnostics.evidenceRefs.slice(0, 6),
    ],
  };
}

function runGoalScenario(sessionsDir: string, now: number): AoiControlledRealGoalScenario {
  const candidate = buildAoiGoalProposalFromUserMessage({
    sessionPath: CONTROLLED_SESSION,
    latestUserMessage:
      '이 검증 작업을 목표로 관리하자. 실제 outcome 증거로 완료될 때까지 이어가자.',
    now,
  });
  if (!candidate) {
    throw new Error('Controlled-real goal proposal was not created.');
  }
  const activated = activateAoiGoalFromProposal({
    sessionsDir,
    sessionPath: CONTROLLED_SESSION,
    proposal: candidate,
    now,
  });
  if (!activated || activated.plan.steps.length < 2) {
    throw new Error('Controlled-real goal did not contain two plan steps.');
  }
  const controlledGoal: AoiGoal = {
    ...activated,
    plan: {
      ...activated.plan,
      steps: activated.plan.steps.slice(0, 2),
    },
  };
  saveAoiActiveGoals(sessionsDir, CONTROLLED_SESSION, [controlledGoal]);
  const firstMission = deriveAoiMissionState({
    sessionsDir,
    sessionPath: CONTROLLED_SESSION,
    now: now + 10,
  });
  const secondMission = deriveAoiMissionState({
    sessionsDir,
    sessionPath: CONTROLLED_SESSION,
    now: now + 20,
  });
  const goalPersistedAcrossWakeups = Boolean(
    firstMission.activeGoalId === controlledGoal.id &&
    secondMission.activeGoalId === controlledGoal.id,
  );
  const progressObservation: AoiObservation = {
    version: 1,
    id: 'controlled-goal-progress-observation',
    source: 'system',
    sessionPath: CONTROLLED_SESSION,
    createdAt: now + 30,
    summary: 'Controlled goal context was reviewed.',
    payloadRef: 'controlled-real:goal-progress',
    memoryIds: [],
    artifactRefs: [`goal:${controlledGoal.id}`],
    proposalIds: [],
    riskSignals: [],
    dedupeKey: 'controlled-real:goal-progress',
  };
  updateAoiGoalProgressFromObservations({
    sessionsDir,
    sessionPath: CONTROLLED_SESSION,
    observations: [progressObservation],
    now: now + 30,
  });
  const progressedGoal = loadAoiActiveGoals(sessionsDir, CONTROLLED_SESSION)[0];
  const targetStep = progressedGoal?.plan.steps.find((step) => step.status !== 'done');
  if (!progressedGoal || !targetStep) {
    throw new Error('Controlled-real goal did not retain an outcome target step.');
  }
  const executionProposal: AoiProposal = {
    ...candidate,
    id: 'controlled-goal-execution-proposal',
    status: 'executed',
    updatedAt: now + 40,
    evidenceRefs: [`goal:${progressedGoal.id}`],
    artifactRefs: [`goal:${progressedGoal.id}`, `goal:${progressedGoal.id}/step:${targetStep.id}`],
  };
  saveAoiArchivedProposals(sessionsDir, CONTROLLED_SESSION, [executionProposal]);
  const outcome = appendAoiOutcomeSignalRecord(
    sessionsDir,
    {
      sessionPath: CONTROLLED_SESSION,
      eventId: 'controlled-goal-validated-outcome',
      sourceProposalId: executionProposal.id,
      sourceDecisionId: 'controlled-goal-decision',
      sourceValidationRef: 'validation:controlled-goal-outcome',
      outcomeKind: 'proposal_executed',
      validationPassed: true,
      privacyState: 'metadata_only',
      evidenceRefs: executionProposal.artifactRefs,
      createdAt: now + 50,
    },
    now + 50,
  );
  updateAoiGoalProgressFromOutcomeSignals({
    sessionsDir,
    sessionPath: CONTROLLED_SESSION,
    outcomes: [outcome],
    proposals: [executionProposal],
    now: now + 60,
  });
  const completedGoal = loadAoiArchivedGoals(sessionsDir, CONTROLLED_SESSION).find(
    (goal) => goal.id === controlledGoal.id && goal.status === 'completed',
  );
  const completionEvents = loadAoiGoalProgressEvents(sessionsDir, CONTROLLED_SESSION).filter(
    (event) => event.goalId === controlledGoal.id && event.kind === 'completed',
  );
  const outcomeBackedCompletion = completionEvents.some((event) =>
    event.evidenceRefs.includes(`outcome:${outcome.eventId}`),
  );
  const passed = Boolean(goalPersistedAcrossWakeups && completedGoal && outcomeBackedCompletion);
  return {
    version: 1,
    id: 'validated_goal_continuity',
    passed,
    wakeupCount: 2,
    goalPersistedAcrossWakeups,
    completedFromOutcome: Boolean(completedGoal),
    outcomeBackedCompletion,
    completionEventCount: completionEvents.length,
    evidenceRefs: [
      'controlled-real-cognition:validated-goal-continuity',
      `outcome:${outcome.eventId}`,
    ],
  };
}

export async function runAoiControlledRealCognitionHarness(
  now = Date.now(),
): Promise<AoiControlledRealCognitionReport> {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-controlled-cognition-'));
  const scenarios: AoiControlledRealCognitionScenario[] = [];
  let cleanupVerified = false;
  try {
    scenarios.push(runGroundedScenario(root, now));
    scenarios.push(runDarkScenario(root, now));
    scenarios.push(await runMemoryScenario(root, now));
    scenarios.push(runGoalScenario(root, now));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    cleanupVerified = !fs.existsSync(root);
  }
  const passedScenarioCount = scenarios.filter((scenario) => scenario.passed).length;
  const behaviorFingerprint = fingerprintAoiControlledRealCognitionBehavior(scenarios);
  return {
    version: 1,
    id: `aoi-controlled-cognition-${behaviorFingerprint.slice(0, 20)}`,
    evidenceClass: 'controlled_real',
    generatedAt: now,
    passed: passedScenarioCount === scenarios.length && cleanupVerified,
    scenarioCount: scenarios.length,
    passedScenarioCount,
    behaviorFingerprint,
    cleanupVerified,
    scenarios,
    evidenceRefs: scenarios.flatMap((scenario) => scenario.evidenceRefs).slice(0, 24),
    actionAuthority: 'disposable_workspace_only',
  };
}
