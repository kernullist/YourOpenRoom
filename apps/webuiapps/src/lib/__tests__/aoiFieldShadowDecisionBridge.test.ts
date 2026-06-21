import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { decideAoiActionLadder } from '../aoiActionLadder';
import type { AoiJarvisAutonomyGovernorDecision } from '../aoiJarvisAutonomyGovernor';
import { buildAoiFollowThroughLearningSummary } from '../aoiFollowThroughLearning';
import { decideAoiInterruptionDelivery } from '../aoiInterruptionGovernor';
import {
  buildAoiFieldShadowDecisionBridge,
  buildAoiFieldShadowDecisionBridgeSummary,
  recordAoiFieldShadowDecisionIntegration,
} from '../aoiFieldShadowDecisionBridge';
import { loadAoiFieldEvents } from '../aoiFieldEventLedger';
import { loadAoiFieldShadowRecordReport } from '../aoiAutonomyStore';
import type {
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiOpportunity,
  AoiProposal,
} from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-field-shadow-decision-bridge-test-'));
  tempRoots.push(root);
  return root;
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

function makeOpportunity(partial: Partial<AoiOpportunity> = {}): AoiOpportunity {
  return {
    version: 1,
    id: partial.id ?? 'opp-shadow-001',
    sessionPath: SESSION_PATH,
    sourceKind: partial.sourceKind ?? 'research',
    title: partial.title ?? 'Fresh RE trend worth surfacing',
    curiosityQuestion: 'Is this evidence important enough to mention?',
    whyNow: 'Fresh evidence is aligned with a high-confidence interest.',
    evidenceNeed: 'Need fresh research and deliberation evidence.',
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

function makeJarvisGovernor(allowDirectChat = true): AoiJarvisAutonomyGovernorDecision {
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
    id: 'jarvis-governor-shadow-test',
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    overallMode: allowDirectChat ? 'direct_chat' : 'proactive_brief',
    modeRank: allowDirectChat ? 3 : 2,
    modeLabel: allowDirectChat ? 'Direct chat' : 'Proactive brief',
    operatorSummary: 'Test governor',
    allowedAutonomyBands: capabilities.map((capability) => ({
      version: 1,
      capability,
      allowed: capability === 'direct_chat' ? allowDirectChat : true,
      requiredMode: capability === 'command' ? 'approval_execution' : 'prepare_actions',
      reason: `${capability} test gate`,
      evidenceRefs: [`governor:${capability}`],
    })),
    blockers: allowDirectChat
      ? []
      : [
          {
            version: 1,
            id: 'jarvis-block-direct-chat',
            severity: 'blocker',
            label: 'Direct chat blocked',
            reason: 'Test governor ceiling blocks direct chat.',
            affectedModes: ['direct_chat'],
            evidenceRefs: ['governor:direct-chat-blocked'],
          },
        ],
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
    id: 'proposal-run-command-shadow',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: `Run command for ${opportunity.title}`,
    body: `Prepared follow-up for ${opportunity.dedupeKey}.`,
    reason: 'A matching opportunity needs a gated command.',
    trigger: 'field_shadow_bridge_test',
    createdAt: NOW - 5_000,
    updatedAt: NOW - 2_000,
    expiresAt: NOW + DAY_MS,
    cooldownKey: opportunity.dedupeKey,
    confidence: 0.82,
    risk: 'high',
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
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiFieldShadowDecisionBridge.test.ts',
        cwd: '.',
        purpose: 'Validate field shadow bridge.',
      },
    },
  };
}

function makeReadProposal(opportunity: AoiOpportunity): AoiProposal {
  return {
    version: 1,
    id: 'proposal-read-research-shadow',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: `Read research artifact for ${opportunity.title}`,
    body: `Prepared read-only follow-up for ${opportunity.dedupeKey}.`,
    reason: 'A matching opportunity needs a bounded read-only work order.',
    trigger: 'field_shadow_bridge_test',
    createdAt: NOW - 5_000,
    updatedAt: NOW - 2_000,
    expiresAt: NOW + DAY_MS,
    cooldownKey: opportunity.dedupeKey,
    confidence: 0.88,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: [`opportunity:${opportunity.id}`, ...opportunity.evidenceRefs],
    memoryIds: [],
    artifactRefs: [`opportunity:${opportunity.id}`],
    riskSignals: [],
    acceptAction: {
      kind: 'read_research_artifact',
      params: {
        runId: 'research-run-shadow',
        artifact: 'summary.md',
      },
    },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi Field Shadow Decision Bridge', () => {
  it('records a high-confidence fresh item as speak-capable shadow evidence', () => {
    const opportunity = makeOpportunity();
    const run = makeRun(opportunity);
    const interruption = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });
    const result = buildAoiFieldShadowDecisionBridge({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      interruptionDecisions: [interruption],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(result.decisions[0]).toMatchObject({
      kind: 'would_speak',
      opportunityId: opportunity.id,
      interruptionDecisionId: interruption.id,
      sourceFreshness: 'fresh',
      policyResult: 'allowed',
      mutationCount: 0,
    });
    expect(result.decisions[0].whySpeak).toContain('Direct chat is allowed');
    expect(result.fieldEvents[0]).toMatchObject({
      category: 'delivery_direct_chat_candidate',
      mutationCount: 0,
    });
    expect(result.fieldShadowReport.decisionKindCounts.would_speak).toBe(1);
  });

  it('records quiet mode as why-quiet shadow evidence with a quiet blocker', () => {
    const opportunity = makeOpportunity({ id: 'opp-shadow-quiet', urgency: 0.72 });
    const run = makeRun(opportunity);
    const interruption = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: true,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });
    const result = buildAoiFieldShadowDecisionBridge({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      interruptionDecisions: [interruption],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(result.decisions[0].kind).toBe('would_stay_quiet');
    expect(result.decisions[0].directChatBlockers).toContain('quiet_mode');
    expect(result.decisions[0].whyQuiet).toContain('quiet mode');
    expect(result.summary.whyQuietLabels.join(' ')).toContain('quiet mode');
    expect(result.mutationCount).toBe(0);
  });

  it('records stale source as a blind spot with cannotKnow', () => {
    const opportunity = makeOpportunity({ id: 'opp-shadow-stale' });
    const run = makeRun(opportunity, {
      phase: 'blocked',
      finding: {
        version: 1,
        summary: 'Evidence is stale.',
        sourceQuality: 'weak',
        freshness: 'stale',
        confidence: 0.3,
        evidenceRefs: ['research:stale'],
        blockers: ['research evidence is stale'],
        cannotKnow: ['current state without refresh'],
        createdAt: NOW - 10_000,
      },
      evidenceRefs: ['research:stale'],
      blockers: ['research evidence is stale'],
    });
    const interruption = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });
    const result = buildAoiFieldShadowDecisionBridge({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      interruptionDecisions: [interruption],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(result.decisions[0]).toMatchObject({
      kind: 'would_mark_blind_spot',
      sourceFreshness: 'stale',
      policyResult: 'record_only',
    });
    expect(result.decisions[0].cannotKnow?.join(' ')).toContain('Current state cannot be claimed');
    expect(result.fieldEvents[0].category).toBe('deliberation_blocked');
    expect(result.summary.staleUnsafeDuplicateLabels.join(' ')).toContain('stale');
  });

  it('records prepared bounded work orders as prepare-only field evidence', () => {
    const opportunity = makeOpportunity({
      id: 'opp-shadow-work-order',
      deliveryRecommendation: 'dashboard',
      risk: 'low',
    });
    const run = makeRun(opportunity);
    const proposal = makeReadProposal(opportunity);
    const ladder = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy({ level: 'L4' }),
      jarvisGovernor: makeJarvisGovernor(true),
      activeProposals: [proposal],
      now: NOW,
    });
    const result = buildAoiFieldShadowDecisionBridge({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      actionLadderDecisions: [ladder],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(ladder.preparedWorkOrder).toMatchObject({
      status: 'draft',
      actionAuthority: 'display_only',
      mutationCount: 0,
      policyResult: {
        executionAllowed: false,
        canAutoRun: false,
      },
    });
    expect(result.decisions[0]).toMatchObject({
      kind: 'would_prepare_work_order',
      policyResult: 'record_only',
      actionLadderDecisionId: ladder.id,
      mutationCount: 0,
    });
    expect(result.fieldEvents[0]).toMatchObject({
      category: 'work_order_prepared',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(result.summary.workOrderPrepareCount).toBe(1);
    expect(result.summary.zeroMutation).toBe(true);
  });

  it('keeps unsafe command opportunities blocked instead of preparing a work order', () => {
    const opportunity = makeOpportunity({
      id: 'opp-shadow-command',
      sourceKind: 'workspace',
      title: 'Validate unsafe command follow-up',
      risk: 'high',
      deliveryRecommendation: 'dashboard',
      dedupeKey: 'shadow:unsafe-command',
    });
    const run = makeRun(opportunity);
    const proposal = makeCommandProposal(opportunity);
    const followThroughLearning = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        {
          version: 1,
          id: 'follow-through-unsafe-command',
          sessionPath: SESSION_PATH,
          opportunityId: opportunity.id,
          sourceKind: opportunity.sourceKind,
          topicKey: opportunity.dedupeKey,
          sourceKey: opportunity.sourceKind,
          deliveryMode: 'dashboard',
          action: 'blocked',
          feedbackCategory: 'unsafe',
          result: 'blocked',
          timingLabel: 'unsafe command in test',
          evidenceRefs: ['test:unsafe-follow-through'],
          createdAt: NOW - 1_000,
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
      now: NOW,
    });
    const ladder = decideAoiActionLadder({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy({ level: 'L5' }),
      jarvisGovernor: makeJarvisGovernor(true),
      activeProposals: [proposal],
      followThroughLearning,
      now: NOW,
    });
    const result = buildAoiFieldShadowDecisionBridge({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      actionLadderDecisions: [ladder],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(result.decisions.map((decision) => decision.kind)).not.toContain(
      'would_prepare_work_order',
    );
    expect(result.decisions[0]).toMatchObject({
      kind: 'would_mark_blind_spot',
      policyResult: 'blocked',
      actionLadderDecisionId: ladder.id,
      mutationCount: 0,
    });
    expect(result.decisions[0].cannotKnow?.join(' ')).toContain('Unsafe');
    expect(result.fieldEvents[0].category).toBe('action_ladder_blocked');
    expect(result.fieldEvents[0].mutationCount).toBe(0);
  });

  it('does not promote duplicate or cooldown items into direct-chat shadow speak', () => {
    const opportunity = makeOpportunity({ id: 'opp-shadow-duplicate' });
    const run = makeRun(opportunity);
    const interruption = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      recentDeliveryKeys: [opportunity.dedupeKey],
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });
    const result = buildAoiFieldShadowDecisionBridge({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      interruptionDecisions: [interruption],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(result.decisions[0].kind).not.toBe('would_speak');
    expect(result.decisions[0].kind).toBe('would_stay_quiet');
    expect(result.decisions[0].directChatBlockers).toContain('duplicate_or_cooldown');
    expect(result.summary.staleUnsafeDuplicateLabels.join(' ')).toContain('duplicate');
  });

  it('persists field shadow decisions and field ledger events without mutation authority', () => {
    const root = makeTempRoot();
    const opportunity = makeOpportunity({ id: 'opp-shadow-persist' });
    const run = makeRun(opportunity);
    const interruption = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: run,
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });
    const result = recordAoiFieldShadowDecisionIntegration(root, {
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      interruptionDecisions: [interruption],
      deliberationRuns: [run],
      now: NOW,
    });
    const loadedReport = loadAoiFieldShadowRecordReport(root, SESSION_PATH, NOW);
    const events = loadAoiFieldEvents(root, SESSION_PATH, NOW);
    const summary = buildAoiFieldShadowDecisionBridgeSummary({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      interruptionDecisions: [interruption],
      deliberationRuns: [run],
      now: NOW,
    });

    expect(result.persistedFieldShadowReport.mutationCount).toBe(0);
    expect(result.appendedFieldEvents[0].mutationCount).toBe(0);
    expect(loadedReport.records[0]).toMatchObject({
      opportunityId: opportunity.id,
      privacyState: 'metadata_only',
      mutationCount: 0,
    });
    expect(events[0]).toMatchObject({
      signalIds: [result.decisions[0].id],
      mutationCount: 0,
    });
    expect(summary.zeroMutation).toBe(true);
  });
});
