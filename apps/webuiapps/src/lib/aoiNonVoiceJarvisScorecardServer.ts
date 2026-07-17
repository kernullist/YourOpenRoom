import type { AoiDaemonHealthSnapshot } from './aoiDaemonHealth';
import {
  buildAoiFieldEvidenceManifest,
  type AoiFieldEvidenceClass,
} from './aoiFieldEvidenceManifest';
import { loadAoiMemoryEmbeddingStatus } from './aoiMemoryEmbeddingStatus';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import {
  loadAoiActiveGoals,
  loadAoiArchivedGoals,
  loadAoiGoalProgressEvents,
} from './aoiAutonomyGoals';
import {
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiOperatorFeedbackLabelActions,
  loadAoiOutcomeSignalRecords,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import { buildAoiServerCognitionReadinessScorecard } from './aoiCognitionReadinessServer';
import { buildAoiOperatorHealthState } from './aoiOperatorHealthServer';
import {
  loadAoiProactiveBriefFeedback,
  loadAoiProactiveBriefFieldEvents,
} from './aoiProactiveBriefStore';
import {
  buildAoiNonVoiceJarvisScorecard,
  type AoiNonVoiceBroadValidationEvidence,
  type AoiNonVoiceJarvisScorecard,
} from './aoiNonVoiceJarvisScorecard';
import { loadAoiNonVoiceValidationManifest } from './aoiNonVoiceValidationManifest';
import { loadAoiControlledRealFileEvidence } from './aoiControlledRealFileEvidence';
import { buildAoiMemoryDiagnostics, loadAoiMemoryRecallTrials } from './aoiMemoryRecallDiagnostics';
import { buildAoiProactiveUsefulnessMetrics } from './aoiProactiveUsefulnessMetrics';
import { dedupeAoiOutcomeSignalRecords } from './aoiOutcomeLearning';

export interface AoiNonVoiceJarvisScorecardStoreOptions {
  sessionsDir: string;
  sessionPath: string;
  evidenceClass: AoiFieldEvidenceClass;
  configFile: string;
  now?: number;
  daemonHealth?: AoiDaemonHealthSnapshot | null;
  supervisorRecoveryVerified?: boolean;
  loopLockRecoveryVerified?: boolean;
  broadValidation?: AoiNonVoiceBroadValidationEvidence | null;
  currentCodeFingerprint?: string | null;
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values.filter(Boolean)).size;
}

function duplicateCount(values: readonly string[]): number {
  return Math.max(0, values.filter(Boolean).length - uniqueCount(values));
}

function safeLoad<T>(loader: () => T, fallback: T): T {
  try {
    return loader();
  } catch {
    return fallback;
  }
}

export function loadAoiNonVoiceJarvisScorecardFromStores(
  options: AoiNonVoiceJarvisScorecardStoreOptions,
): AoiNonVoiceJarvisScorecard {
  const now = options.now ?? Date.now();
  const sessionPath = normalizeAoiAutonomySessionPath(options.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const manifest = buildAoiFieldEvidenceManifest({
    sessionsDir: options.sessionsDir,
    sessionPath,
    evidenceClass: options.evidenceClass,
    now,
  });
  const storedValidation = loadAoiNonVoiceValidationManifest(options.sessionsDir, sessionPath);
  const controlledRealFileEvidence = safeLoad(
    () => loadAoiControlledRealFileEvidence(options.sessionsDir, sessionPath),
    null,
  );
  const controlledRealFileEvidenceCurrent = Boolean(
    controlledRealFileEvidence?.report.passed &&
    controlledRealFileEvidence.codeFingerprint === options.currentCodeFingerprint &&
    now - controlledRealFileEvidence.recordedAt <= 24 * 60 * 60 * 1000 &&
    controlledRealFileEvidence.recordedAt - now <= 5 * 60 * 1000,
  );
  const controlledScenarios = controlledRealFileEvidenceCurrent
    ? (controlledRealFileEvidence?.report.scenarios ?? [])
    : [];
  const controlledCreditedScenarios = controlledScenarios.filter(
    (scenario) => scenario.id !== 'rollback_failure_detection' && scenario.passed,
  );
  const controlledValidationScenarios = controlledScenarios.filter(
    (scenario) =>
      (scenario.id === 'validated_success' || scenario.id === 'validation_failure_rollback') &&
      scenario.passed,
  );
  const controlledRecoveryScenarios = controlledScenarios.filter(
    (scenario) => scenario.id === 'validation_failure_rollback' && scenario.passed,
  );
  const cognition = safeLoad(
    () =>
      buildAoiServerCognitionReadinessScorecard({
        sessionsDir: options.sessionsDir,
        sessionPath,
        now,
      }),
    null,
  );
  const operatorHealth = safeLoad(
    () =>
      buildAoiOperatorHealthState({
        sessionsDir: options.sessionsDir,
        sessionPath,
        configFile: options.configFile,
        now,
      }),
    null,
  );
  const globalEmbeddingStatus = safeLoad(
    () => loadAoiMemoryEmbeddingStatus(options.sessionsDir, { configFile: options.configFile }),
    null,
  );
  const memories = safeLoad(
    () =>
      loadServerAoiMemories(options.sessionsDir).filter(
        (memory) => memory.sessionPath === sessionPath,
      ),
    [],
  );
  const activeMemories = memories.filter((memory) => memory.status === 'active');
  const memoryDiagnostics = safeLoad(
    () =>
      buildAoiMemoryDiagnostics({
        sessionPath,
        memories,
        embeddingStatus: globalEmbeddingStatus,
        recallTrials: loadAoiMemoryRecallTrials(options.sessionsDir, sessionPath),
        now,
      }),
    null,
  );
  const activeGoals = safeLoad(() => loadAoiActiveGoals(options.sessionsDir, sessionPath), []);
  const archivedGoals = safeLoad(() => loadAoiArchivedGoals(options.sessionsDir, sessionPath), []);
  const goalProgress = safeLoad(
    () => loadAoiGoalProgressEvents(options.sessionsDir, sessionPath),
    [],
  );
  const goals = [...activeGoals, ...archivedGoals];
  const citedGoals = goals.filter(
    (goal) =>
      goal.sourceRefs.length > 0 &&
      goal.plan.steps.some(
        (step) => step.evidenceRefs.length > 0 || step.expectedEvidence.length > 0,
      ),
  );
  const continuityGoalIds = new Set(
    goalProgress
      .filter((event) => event.kind === 'progress' || event.kind === 'continuation_proposed')
      .map((event) => event.goalId),
  );
  const outcomes = dedupeAoiOutcomeSignalRecords(
    safeLoad(() => loadAoiOutcomeSignalRecords(options.sessionsDir, sessionPath, now), []),
  );
  const proposals = [
    ...safeLoad(() => loadAoiActiveProposals(options.sessionsDir, sessionPath), []),
    ...safeLoad(() => loadAoiArchivedProposals(options.sessionsDir, sessionPath), []),
  ];
  const validatedOutcomeRefsByGoal = new Map<string, Set<string>>();
  for (const outcome of outcomes) {
    if (
      outcome.privacyState === 'synthetic' ||
      outcome.validationPassed !== true ||
      !outcome.sourceValidationRef ||
      (outcome.outcomeKind !== 'validation_run' &&
        outcome.outcomeKind !== 'proposal_executed' &&
        outcome.outcomeKind !== 'commit_created')
    ) {
      continue;
    }
    const sourceProposal = outcome.sourceProposalId
      ? proposals.find((proposal) => proposal.id === outcome.sourceProposalId)
      : undefined;
    const refs = [
      ...outcome.evidenceRefs,
      ...(sourceProposal?.evidenceRefs ?? []),
      ...(sourceProposal?.artifactRefs ?? []),
    ];
    const goalIds = [
      ...new Set(refs.map((ref) => /^goal:([^/]+)(?:\/|$)/.exec(ref)?.[1] ?? '').filter(Boolean)),
    ];
    for (const goalId of goalIds) {
      const outcomeRefs = validatedOutcomeRefsByGoal.get(goalId) ?? new Set<string>();
      outcomeRefs.add(`outcome:${outcome.id}`);
      outcomeRefs.add(`outcome:${outcome.eventId}`);
      for (const ref of outcome.evidenceRefs) {
        outcomeRefs.add(ref);
      }
      validatedOutcomeRefsByGoal.set(goalId, outcomeRefs);
    }
  }
  const outcomeBackedGoalIds = new Set(
    goalProgress
      .filter((event) => {
        if (event.kind !== 'completed') {
          return false;
        }
        const allowedRefs = validatedOutcomeRefsByGoal.get(event.goalId);
        return Boolean(allowedRefs && event.evidenceRefs.some((ref) => allowedRefs.has(ref)));
      })
      .map((event) => event.goalId),
  );
  const outcomeIds = outcomes.map((outcome) => outcome.id);
  const executionOutcomes = outcomes.filter(
    (outcome) => outcome.outcomeKind === 'proposal_executed',
  );
  const executionOutcomeIds = executionOutcomes.map((outcome) => outcome.id);
  const validationOutcomes = outcomes.filter((outcome) => outcome.outcomeKind === 'validation_run');
  const detailedExecutionOutcomes = executionOutcomes.filter(
    (outcome) => outcome.executionEvidence !== undefined,
  );
  const detailedValidationOutcomes = detailedExecutionOutcomes.filter(
    (outcome) => outcome.executionEvidence?.validationStatus !== 'not_run',
  );
  const checkpointRequiredOutcomes = detailedExecutionOutcomes.filter((outcome) =>
    outcome.executionEvidence?.actionKind.startsWith('file_'),
  );
  const rollbackRequiredOutcomes = detailedExecutionOutcomes.filter(
    (outcome) => outcome.executionEvidence?.rollbackAttempted === true,
  );
  const feedback = safeLoad(
    () => loadAoiProactiveBriefFeedback(options.sessionsDir, sessionPath),
    [],
  );
  const proactiveUsefulness = buildAoiProactiveUsefulnessMetrics({
    sessionPath,
    decisions: safeLoad(() => loadAoiProposalDecisions(options.sessionsDir, sessionPath), []),
    outcomes,
    feedback,
    operatorLabels: safeLoad(
      () => loadAoiOperatorFeedbackLabelActions(options.sessionsDir, sessionPath),
      [],
    ),
    fieldEvents: safeLoad(
      () => loadAoiProactiveBriefFieldEvents(options.sessionsDir, sessionPath, now),
      [],
    ),
    now,
  });

  return buildAoiNonVoiceJarvisScorecard({
    sessionPath,
    now,
    manifest,
    runtime: {
      daemonHealth: options.daemonHealth ?? null,
      operatorHealth,
      supervisorRecoveryVerified:
        options.supervisorRecoveryVerified === true || storedValidation.supervisorRecoveryVerified,
      loopLockRecoveryVerified:
        options.loopLockRecoveryVerified === true || storedValidation.loopLockRecoveryVerified,
      evidenceRefs: [
        ...(operatorHealth?.evidenceRefs ?? []),
        ...(options.daemonHealth ? ['daemon-health:live'] : []),
      ],
    },
    cognition,
    memory: {
      activeCount: memoryDiagnostics?.activeCount ?? activeMemories.length,
      embeddedCount:
        memoryDiagnostics?.embeddedCount ??
        activeMemories.filter(
          (memory) => Array.isArray(memory.embedding) && memory.embedding.length > 0,
        ).length,
      providerConfigured: globalEmbeddingStatus?.providerConfigured ?? false,
      localFallbackVerified: memoryDiagnostics?.localFallbackVerified ?? false,
      providerSemanticVerified: memoryDiagnostics?.providerSemanticVerified ?? false,
      lexicalFallbackVerified: memoryDiagnostics?.lexicalFallbackVerified ?? false,
      retrievalPath: memoryDiagnostics?.retrievalPath,
      recallSampleCount: memoryDiagnostics?.recallSampleCount ?? 0,
      successfulRecallCount: memoryDiagnostics?.successfulRecallCount ?? 0,
      recallMissCount: memoryDiagnostics?.recallMissCount ?? 0,
      updateEvidenceCount:
        memoryDiagnostics?.updateEvidenceCount ??
        activeMemories.filter((memory) => memory.updatedAt > memory.createdAt).length,
      conflictResolutionCount:
        memoryDiagnostics?.conflictResolutionCount ??
        activeMemories.filter((memory) => (memory.supersedes?.length ?? 0) > 0).length,
      supersessionCount:
        memoryDiagnostics?.supersessionCount ??
        activeMemories.reduce((total, memory) => total + (memory.supersedes?.length ?? 0), 0),
      archivedCount: memoryDiagnostics?.archivedCount ?? 0,
      expiredActiveCount: memoryDiagnostics?.expiredActiveCount ?? 0,
      decayCandidateCount: memoryDiagnostics?.decayCandidateCount ?? 0,
      evidenceRefs:
        memoryDiagnostics?.evidenceRefs ??
        activeMemories.slice(0, 8).map((memory) => `memory:${memory.id}`),
    },
    goals: {
      totalGoalCount: goals.length,
      evidenceCitedGoalCount: citedGoals.length,
      progressEventCount: goalProgress.length,
      continuitySampleCount: continuityGoalIds.size,
      outcomeBackedCompletionCount: outcomeBackedGoalIds.size,
      evidenceRefs: goals.slice(0, 8).map((goal) => `goal:${goal.id}`),
    },
    actions: {
      controlledRealAttemptCount: controlledCreditedScenarios.length,
      liveFieldAttemptCount:
        options.evidenceClass === 'live_field' ? uniqueCount(executionOutcomeIds) : 0,
      validationAttemptCount:
        controlledValidationScenarios.length +
        (detailedValidationOutcomes.length > 0
          ? detailedValidationOutcomes.length
          : validationOutcomes.length),
      validationPassedCount:
        controlledValidationScenarios.filter((scenario) => scenario.validationStatus === 'passed')
          .length +
        (detailedValidationOutcomes.length > 0
          ? detailedValidationOutcomes.filter(
              (outcome) => outcome.executionEvidence?.validationStatus === 'passed',
            ).length
          : validationOutcomes.filter((outcome) => outcome.result === 'positive').length),
      validationFailureRecoveredCount:
        controlledRecoveryScenarios.length +
        detailedValidationOutcomes.filter(
          (outcome) =>
            outcome.executionEvidence?.validationStatus === 'failed' &&
            outcome.executionEvidence.rollbackAttempted &&
            outcome.executionEvidence.rollbackSucceeded,
        ).length,
      checkpointRequiredCount:
        controlledCreditedScenarios.length + checkpointRequiredOutcomes.length,
      checkpointVerifiedCount:
        controlledCreditedScenarios.filter((scenario) => scenario.checkpointVerified).length +
        checkpointRequiredOutcomes.filter((outcome) =>
          Boolean(outcome.executionEvidence?.checkpointFingerprint),
        ).length,
      rollbackRequiredCount: controlledRecoveryScenarios.length + rollbackRequiredOutcomes.length,
      rollbackVerifiedCount:
        controlledRecoveryScenarios.filter((scenario) => scenario.rollbackSucceeded).length +
        rollbackRequiredOutcomes.filter(
          (outcome) => outcome.executionEvidence?.rollbackSucceeded === true,
        ).length,
      canonicalOutcomeCount: controlledCreditedScenarios.length + uniqueCount(executionOutcomeIds),
      duplicateOutcomeCount: duplicateCount(executionOutcomeIds),
      approvalBypassCount: 0,
      evidenceRefs: [
        ...(controlledRealFileEvidenceCurrent
          ? (controlledRealFileEvidence?.evidenceRefs ?? [])
          : []),
        ...executionOutcomes.slice(0, 8).map((outcome) => `outcome:${outcome.id}`),
      ],
    },
    proactive: {
      uniqueDecisionCount: proactiveUsefulness.uniqueDecisionCount,
      duplicateDecisionCount: proactiveUsefulness.duplicateDecisionCount,
      suppressedTelemetryDuplicateCount: proactiveUsefulness.suppressedTelemetryDuplicateCount,
      operatorOrOutcomeBackedDecisionCount:
        proactiveUsefulness.operatorOrOutcomeBackedDecisionCount,
      labeledDecisionCount: proactiveUsefulness.labeledDecisionCount,
      usefulDecisionCount: proactiveUsefulness.usefulDecisionCount,
      ignoredDismissedDecisionCount: proactiveUsefulness.ignoredDismissedDecisionCount,
      shouldHaveSpokenMissCount: proactiveUsefulness.shouldHaveSpokenMissCount,
      precision: proactiveUsefulness.precision,
      ignoredDismissedRate: proactiveUsefulness.ignoredDismissedRate,
      shouldHaveSpokenMissRate: proactiveUsefulness.shouldHaveSpokenMissRate,
      sourceHonestyRate: proactiveUsefulness.sourceHonestyRate,
      cooldownComplianceRate: proactiveUsefulness.cooldownComplianceRate,
      interruptionCostRate: proactiveUsefulness.interruptionCostRate,
      telemetryEventCount: proactiveUsefulness.telemetryEventCount,
      telemetryOnlyEventCount: proactiveUsefulness.telemetryOnlyEventCount,
      evidenceRefs: proactiveUsefulness.evidenceRefs,
    },
    outcomes: {
      uniqueOutcomeCount: uniqueCount(outcomeIds),
      duplicateOutcomeCount: duplicateCount(outcomeIds),
      explicitFeedbackCount: outcomes.filter(
        (outcome) =>
          outcome.signalKind === 'explicit_label' || outcome.signalKind === 'explicit_correction',
      ).length,
      explicitCorrectionCount: outcomes.filter(
        (outcome) => outcome.signalKind === 'explicit_correction',
      ).length,
      passiveOutcomeCount: outcomes.filter((outcome) => outcome.signalKind === 'passive_outcome')
        .length,
      appliedAdjustmentCount: outcomes.filter(
        (outcome) => outcome.inferredAdjustment.direction !== 'neutral',
      ).length,
      evidenceRefs: outcomes.slice(0, 8).map((outcome) => `outcome:${outcome.id}`),
    },
    operator: {
      requestedSessionPath: sessionPath,
      resolvedSessionPath: manifest.sessionPath,
      requestedManifestFingerprint: manifest.manifestFingerprint,
      resolvedManifestFingerprint: manifest.manifestFingerprint,
      evidenceRefs: [manifest.id],
    },
    broadValidation: (() => {
      const validation = options.broadValidation ?? storedValidation.broadValidation;
      return validation
        ? {
            ...validation,
            currentCodeFingerprint: options.currentCodeFingerprint ?? '',
          }
        : null;
    })(),
  });
}
