import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { decideAoiActionLadder } from '../aoiActionLadder';
import type { AoiJarvisAutonomyGovernorDecision } from '../aoiJarvisAutonomyGovernor';
import type {
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiOpportunity,
  AoiProposal,
} from '../aoiAutonomyTypes';
import type { AoiFieldShadowDecisionRecord } from '../aoiFieldShadowDogfooding';
import {
  buildAoiFieldFeedbackLearning,
  buildAoiFieldFeedbackEvents,
  recordAoiFieldFeedbackLearningAction,
} from '../aoiFieldFeedbackLearning';
import {
  loadAoiFollowThroughEvents,
  loadAoiFollowThroughLearningSummary,
} from '../aoiAutonomyStore';
import {
  hasAoiFollowThroughUnsafeSignal,
  scoreAoiFollowThroughLearningForOpportunity,
} from '../aoiFollowThroughLearning';
import { decideAoiInterruptionDelivery } from '../aoiInterruptionGovernor';
import { createAoiOperatorFeedbackLabelAction } from '../aoiOperatorFeedbackInbox';
import type { AoiShadowDecisionLabel } from '../aoiShadowModeEvaluation';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-field-feedback-test-'));
  tempRoots.push(root);
  return root;
}

function makeOpportunity(partial: Partial<AoiOpportunity> = {}): AoiOpportunity {
  return {
    version: 1,
    id: partial.id ?? 'opp-field-feedback-re',
    sessionPath: SESSION_PATH,
    sourceKind: partial.sourceKind ?? 'research',
    title: partial.title ?? 'Reverse engineering trend worth surfacing',
    curiosityQuestion: 'Is this RE signal worth mentioning now?',
    whyNow: 'Fresh evidence matches a high-confidence operator interest.',
    evidenceNeed: 'Need fresh source and deliberation evidence.',
    suggestedNextAction: 'Brief the finding without executing anything.',
    risk: partial.risk ?? 'low',
    confidence: partial.confidence ?? 0.92,
    urgency: partial.urgency ?? 0.9,
    novelty: partial.novelty ?? 0.78,
    deliveryRecommendation: partial.deliveryRecommendation ?? 'direct_chat',
    status: partial.status ?? 'active',
    evidenceRefs: partial.evidenceRefs ?? ['research:re-trend-001', 'memory:reverse-engineering'],
    dedupeKey: partial.dedupeKey ?? 'curiosity:interest:reverse-engineering',
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - 60_000,
    expiresAt: NOW + DAY_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeRecord(
  partial: Partial<AoiFieldShadowDecisionRecord> = {},
): AoiFieldShadowDecisionRecord {
  const opportunity = makeOpportunity();
  return {
    version: 1,
    id: partial.id ?? 'aoi-field-shadow-record-feedback-re',
    sessionId: 'aoi-field-shadow-session-feedback',
    sessionPath: SESSION_PATH,
    decisionId: partial.decisionId ?? 'aoi-shadow-decision-feedback-re',
    decisionKind: partial.decisionKind ?? 'would_speak',
    subsystemOrigin: partial.subsystemOrigin ?? 'interruption_governor',
    createdAt: partial.createdAt ?? NOW - 10_000,
    recordedAt: partial.recordedAt ?? NOW - 9_000,
    expiresAt: partial.expiresAt ?? NOW + DAY_MS,
    retentionMs: DAY_MS,
    sourceRefs: partial.sourceRefs ?? ['browser-context:re-feed'],
    evidenceRefs: partial.evidenceRefs ?? [
      'opportunity:opp-field-feedback-re',
      'research:re-trend-001',
    ],
    consentState: partial.consentState ?? 'allowed',
    privacyState: partial.privacyState ?? 'metadata_only',
    policyResult: partial.policyResult ?? 'allowed',
    risk: partial.risk ?? 'low',
    sourceSummary:
      partial.sourceSummary ?? 'A fresh RE metadata signal matched the operator interest.',
    mutationCount: 0,
    dedupeKey: partial.dedupeKey ?? opportunity.dedupeKey,
    opportunityId: partial.opportunityId ?? opportunity.id,
    fieldEventId: partial.fieldEventId ?? 'aoi-field-event-source-re',
    whySpeak: partial.whySpeak ?? 'High urgency and fresh evidence made direct chat plausible.',
    whyQuiet: partial.whyQuiet ?? 'No quiet blocker was active.',
    sourceFreshness: partial.sourceFreshness ?? 'fresh',
    interruptionDeliveryMode: partial.interruptionDeliveryMode ?? 'direct_chat',
    directChatBlockers: partial.directChatBlockers ?? [],
    cannotKnow: partial.cannotKnow ?? [],
    operatorMessagePreview: partial.operatorMessagePreview ?? 'Fresh RE item is ready to brief.',
    ...partial,
  };
}

function makeLabel(
  record: AoiFieldShadowDecisionRecord,
  label: AoiShadowDecisionLabel,
  partial: Partial<Parameters<typeof createAoiOperatorFeedbackLabelAction>[0]> = {},
) {
  return createAoiOperatorFeedbackLabelAction({
    sessionPath: SESSION_PATH,
    decisionRecordId: record.id,
    decisionId: record.decisionId,
    fieldEventId: record.fieldEventId,
    opportunityId: record.opportunityId,
    topicKey: record.dedupeKey,
    sourceKey: partial.sourceKey ?? 'browser_context',
    deliveryMode: partial.deliveryMode ?? record.interruptionDeliveryMode,
    label,
    sourceKinds: partial.sourceKinds ?? ['browser_context'],
    evidenceRefs: record.evidenceRefs,
    now: NOW,
    ...partial,
  });
}

function makeRun(
  opportunity: AoiOpportunity,
  partial: Partial<AoiDeliberationRun> = {},
): AoiDeliberationRun {
  const stale = partial.finding?.freshness === 'stale' || partial.phase === 'blocked';
  return {
    version: 1,
    id: partial.id ?? `delib-${opportunity.id}`,
    sessionPath: SESSION_PATH,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    opportunityTitle: opportunity.title,
    phase: partial.phase ?? 'ready',
    selectedAt: NOW - 20_000,
    updatedAt: NOW - 10_000,
    evidencePlan: partial.evidencePlan ?? [
      {
        version: 1,
        id: `evidence-${opportunity.id}`,
        kind: 'research',
        status: stale ? 'stale' : 'observed',
        sourceRef: 'research:re-trend-001',
        label: 'Research evidence',
        summary: stale ? 'Research evidence is stale.' : 'Fresh research evidence exists.',
        freshness: stale ? 'stale' : 'fresh',
        evidenceRefs: ['research:re-trend-001'],
        cannotKnow: stale ? ['current state without refresh'] : [],
        blockers: stale ? ['research evidence is stale'] : [],
        observedAt: NOW - 10_000,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    ],
    finding: partial.finding ?? {
      version: 1,
      summary: stale ? 'Evidence exists but is stale.' : 'The finding is fresh enough to brief.',
      sourceQuality: stale ? 'weak' : 'strong',
      freshness: stale ? 'stale' : 'fresh',
      confidence: stale ? 0.31 : 0.84,
      evidenceRefs: ['research:re-trend-001'],
      blockers: stale ? ['research evidence is stale'] : [],
      cannotKnow: stale ? ['current state without refresh'] : [],
      createdAt: NOW - 10_000,
    },
    safeNextAction: stale
      ? 'Refresh evidence before any interruption.'
      : 'Brief this as a display-only finding.',
    blockers: stale ? ['research evidence is stale'] : [],
    evidenceRefs: ['research:re-trend-001'],
    artifactRefs: [`deliberation:${opportunity.id}`],
    phaseHistory: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    level: 'L5',
    confidenceFloor: 0.4,
    proactiveBriefing: {
      ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
      directChatHookOptIn: true,
    },
    ...partial,
  };
}

function makeJarvisGovernor(): AoiJarvisAutonomyGovernorDecision {
  const capabilities = [
    'observe',
    'research',
    'memory',
    'proactive_brief',
    'direct_chat',
    'prepare_action',
    'app_action',
    'command',
  ] as const;
  return {
    version: 1,
    id: 'jarvis-governor-field-feedback-test',
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    overallMode: 'approval_execution',
    modeRank: 5,
    modeLabel: 'Approval execution',
    operatorSummary: 'Test governor allows all capabilities through existing gates.',
    allowedAutonomyBands: capabilities.map((capability) => ({
      version: 1,
      capability,
      allowed: true,
      requiredMode: capability === 'command' ? 'approval_execution' : 'prepare_actions',
      reason: `${capability} test gate`,
      evidenceRefs: [`governor:${capability}`],
    })),
    blockers: [],
    nextUpgradeAction: 'No upgrade needed for test.',
    nextUpgradeEvidenceRefs: ['governor:upgrade'],
    whyNotJarvisYetLabels: [],
    evidenceRefs: ['governor:test'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeCommandProposal(opportunity: AoiOpportunity): AoiProposal {
  return {
    version: 1,
    id: 'proposal-field-feedback-command',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: `Run validation for ${opportunity.title}`,
    body: `Prepared validation follow-up for ${opportunity.dedupeKey}.`,
    reason: 'A matching opportunity needs a gated validation command.',
    trigger: 'field_feedback_learning_test',
    createdAt: NOW - 5_000,
    updatedAt: NOW - 2_000,
    expiresAt: NOW + DAY_MS,
    cooldownKey: opportunity.dedupeKey,
    confidence: 0.84,
    risk: 'medium',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['run_command'],
    evidenceRefs: [`opportunity:${opportunity.id}`, ...opportunity.evidenceRefs],
    memoryIds: [],
    artifactRefs: [`opportunity:${opportunity.id}`],
    riskSignals: [],
    acceptAction: {
      kind: 'run_command',
      params: {
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiFieldFeedbackLearning.test.ts',
        cwd: '.',
        purpose: 'Validate field feedback learning.',
      },
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi field feedback learning', () => {
  it('raises related topic ranking for useful labels without raising execution authority', () => {
    const record = makeRecord();
    const label = makeLabel(record, 'useful');
    const result = buildAoiFieldFeedbackLearning({
      sessionPath: SESSION_PATH,
      records: [record],
      labelActions: [label],
      now: NOW,
    });
    const score = scoreAoiFollowThroughLearningForOpportunity(
      makeOpportunity(),
      result.followThroughLearning,
      NOW,
    );

    expect(score.rankingFactor).toBeGreaterThan(1);
    expect(result.summary.topicAdjustmentLabels.join(' ')).toContain('reverse engineering');
    expect(result.summary.executionPermissionRaised).toBe(false);
    expect(result.summary.actionAuthority).toBe('display_only');
    expect(label.actionAuthority).toBe('display_only');
    expect(label.mutationCount).toBe(0);
  });

  it('lowers direct chat sensitivity and creates cooldown for too frequent labels', () => {
    const record = makeRecord({ interruptionDeliveryMode: 'direct_chat' });
    const label = makeLabel(record, 'too_frequent', { deliveryMode: 'direct_chat' });
    const result = buildAoiFieldFeedbackLearning({
      sessionPath: SESSION_PATH,
      records: [record],
      labelActions: [label],
      now: NOW,
    });
    const score = scoreAoiFollowThroughLearningForOpportunity(
      makeOpportunity(),
      result.followThroughLearning,
      NOW,
    );

    expect(score.directChatFactor).toBeLessThan(1);
    expect(score.nextEligibleAt).toBeGreaterThan(NOW);
    expect(result.summary.cooldownAdjustmentLabels.length).toBeGreaterThan(0);
    expect(result.followThroughLearning.deliveryModeSensitivity[0]?.factor).toBeLessThan(1);
    expect(result.feedbackCompression.directChatSensitivity.factor).toBeLessThan(1);
    expect(result.feedbackCompression.verbosityPreference.level).toBe('shorter');
  });

  it('lowers source confidence and emits readiness warnings for wrong source labels', () => {
    const record = makeRecord({
      sourceRefs: ['browser-context:wrong-feed'],
      evidenceRefs: ['environment-source:browser-context'],
    });
    const label = makeLabel(record, 'wrong_source', {
      sourceKey: 'browser_context',
      sourceKinds: ['browser_context'],
    });
    const result = buildAoiFieldFeedbackLearning({
      sessionPath: SESSION_PATH,
      records: [record],
      labelActions: [label],
      now: NOW,
    });

    expect(
      result.followThroughLearning.sourceSuppressions.some((item) =>
        item.key.includes('browser_context'),
      ),
    ).toBe(true);
    expect(result.summary.sourceAdjustmentLabels.join(' ')).toContain('browser context');
    expect(result.summary.readinessWarningLabels.join(' ')).toContain('wrong source');
    expect(result.feedbackCompression.trustIncreaseAllowed).toBe(false);
    expect(result.feedbackCompression.trustIncreaseBlockedReasons.join(' ')).toContain(
      'wrong-source',
    );
  });

  it('blocks action ladder escalation when unsafe feedback exists', () => {
    const opportunity = makeOpportunity();
    const record = makeRecord({ opportunityId: opportunity.id });
    const label = makeLabel(record, 'unsafe');
    const result = buildAoiFieldFeedbackLearning({
      sessionPath: SESSION_PATH,
      records: [record],
      labelActions: [label],
      now: NOW,
    });
    const ladder = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeRun(opportunity),
      activeProposals: [makeCommandProposal(opportunity)],
      policy: makePolicy(),
      jarvisGovernor: makeJarvisGovernor(),
      followThroughLearning: result.followThroughLearning,
      now: NOW,
    });

    expect(hasAoiFollowThroughUnsafeSignal(opportunity, result.followThroughLearning)).toBe(true);
    expect(result.feedbackCompression.unsafeBlockers[0]?.blocksActionEscalation).toBe(true);
    expect(result.feedbackCompression.trustIncreaseBlockedReasons.join(' ')).toContain('unsafe');
    expect(ladder.allowedActions.some((action) => action.level === 'L4')).toBe(false);
    expect(ladder.allowedActions.some((action) => action.level === 'L5')).toBe(false);
    expect(ladder.blockedActions.map((action) => action.reason).join(' ')).toContain(
      'follow_through_learning:unsafe_or_blocked',
    );
  });

  it('raises should-have-spoken visibility without bypassing opt-in quiet or freshness gates', () => {
    const opportunity = makeOpportunity();
    const record = makeRecord({ opportunityId: opportunity.id, decisionKind: 'would_stay_quiet' });
    const label = makeLabel(record, 'should_have_spoken', { deliveryMode: 'direct_chat' });
    const result = buildAoiFieldFeedbackLearning({
      sessionPath: SESSION_PATH,
      records: [record],
      labelActions: [label],
      now: NOW,
    });
    const score = scoreAoiFollowThroughLearningForOpportunity(
      opportunity,
      result.followThroughLearning,
      NOW,
    );
    const optInBlocked = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeRun(opportunity),
      policy: makePolicy({
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          directChatHookOptIn: false,
        },
      }),
      directChatOptIn: false,
      followThroughLearning: result.followThroughLearning,
      jarvisGovernor: makeJarvisGovernor(),
      now: NOW,
    });
    const quietBlocked = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeRun(opportunity),
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: true,
      followThroughLearning: result.followThroughLearning,
      jarvisGovernor: makeJarvisGovernor(),
      now: NOW,
    });
    const staleBlocked = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeRun(opportunity, {
        phase: 'blocked',
        finding: {
          version: 1,
          summary: 'Evidence is stale.',
          sourceQuality: 'weak',
          freshness: 'stale',
          confidence: 0.31,
          evidenceRefs: ['research:stale-re-trend'],
          blockers: ['research evidence is stale'],
          cannotKnow: ['current state without refresh'],
          createdAt: NOW - 10_000,
        },
      }),
      policy: makePolicy(),
      directChatOptIn: true,
      followThroughLearning: result.followThroughLearning,
      jarvisGovernor: makeJarvisGovernor(),
      now: NOW,
    });

    expect(score.directChatFactor).toBeGreaterThan(1);
    expect(result.feedbackCompression.shouldHaveSpokenHints[0]?.directChatCandidate).toBe(true);
    expect(optInBlocked.directChatAllowed).toBe(false);
    expect(optInBlocked.directChatBlockedReasons).toContain('direct_chat_not_opted_in');
    expect(quietBlocked.directChatAllowed).toBe(false);
    expect(quietBlocked.directChatBlockedReasons).toContain('quiet_mode');
    expect(staleBlocked.directChatAllowed).toBe(false);
    expect(staleBlocked.directChatBlockedReasons).toContain('stale_source');
  });

  it('records feedback field events with zero mutation count', () => {
    const record = makeRecord();
    const label = makeLabel(record, 'show_less');
    const events = buildAoiFieldFeedbackEvents({
      sessionPath: SESSION_PATH,
      records: [record],
      labelActions: [label],
      now: NOW,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe('feedback_recorded');
    expect(events[0]?.actionAuthority).toBe('display_only');
    expect(events[0]?.mutationCount).toBe(0);
  });

  it('persists field feedback as follow-through learning for future decisions', () => {
    const root = makeTempRoot();
    const result = recordAoiFieldFeedbackLearningAction(root, {
      sessionPath: SESSION_PATH,
      decisionRecordId: 'field-shadow-record-persisted-feedback',
      decisionId: 'field-shadow-decision-persisted-feedback',
      opportunityId: 'opp-field-feedback-re',
      topicKey: 'curiosity:interest:reverse-engineering',
      sourceKey: 'browser_context',
      deliveryMode: 'direct_chat',
      label: 'too_frequent',
      sourceKinds: ['browser_context'],
      evidenceRefs: ['field-shadow-record:field-shadow-record-persisted-feedback'],
      now: NOW,
    });

    const events = loadAoiFollowThroughEvents(root, SESSION_PATH, NOW + 1_000);
    const summary = loadAoiFollowThroughLearningSummary(root, SESSION_PATH, NOW + 1_000);

    expect(result.appendedFollowThroughEvents).toHaveLength(1);
    expect(events.map((event) => event.feedbackCategory)).toContain('too_frequent');
    expect(events[0]?.actionAuthority).toBe('display_only');
    expect(events[0]?.mutationCount).toBe(0);
    expect(
      summary.deliveryModeSensitivity.some(
        (item) => item.mode === 'direct_chat' && item.factor < 1,
      ),
    ).toBe(true);
  });
});
