import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { buildAoiOpportunityInboxPanelSummary } from '../aoiAutonomyUi';
import {
  buildAoiInterruptionGovernorDecisions,
  decideAoiInterruptionDelivery,
} from '../aoiInterruptionGovernor';
import type { AoiJarvisAutonomyGovernorDecision } from '../aoiJarvisAutonomyGovernor';
import { buildAoiFollowThroughLearningSummary } from '../aoiFollowThroughLearning';
import type {
  AoiAutonomyPolicy,
  AoiDeliberationRun,
  AoiOpportunity,
  AoiProactiveBriefFeedback,
} from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
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
    id: 'opp-re-001',
    sessionPath: SESSION_PATH,
    sourceKind: 'interest',
    title: 'Fresh RE trend worth surfacing',
    curiosityQuestion: 'Is this RE update important enough to interrupt?',
    whyNow: 'Fresh evidence is aligned with a high-confidence interest.',
    evidenceNeed: 'Need fresh research and deliberation evidence.',
    suggestedNextAction: 'Brief the finding without executing anything.',
    risk: 'low',
    confidence: 0.91,
    urgency: 0.87,
    novelty: 0.76,
    deliveryRecommendation: 'direct_chat',
    status: 'active',
    evidenceRefs: ['research:re-trend-001', 'memory:reverse-engineering'],
    dedupeKey: 'curiosity:interest:reverse-engineering',
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - 60_000,
    expiresAt: NOW + DAY_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeJarvisGovernor(allowDirectChat = true): AoiJarvisAutonomyGovernorDecision {
  return {
    version: 1,
    id: 'jarvis-governor-test',
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    overallMode: allowDirectChat ? 'direct_chat' : 'proactive_brief',
    modeRank: allowDirectChat ? 3 : 2,
    modeLabel: allowDirectChat ? 'Direct chat' : 'Proactive brief',
    operatorSummary: 'Test governor',
    allowedAutonomyBands: [
      {
        version: 1,
        capability: 'observe',
        allowed: true,
        requiredMode: 'observe_only',
        reason: 'Observation is always allowed.',
        evidenceRefs: ['test:observe'],
      },
      {
        version: 1,
        capability: 'direct_chat',
        allowed: allowDirectChat,
        requiredMode: 'direct_chat',
        reason: allowDirectChat ? 'Direct chat gate passed.' : 'Direct chat gate blocked.',
        evidenceRefs: ['test:direct-chat'],
      },
    ],
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
            evidenceRefs: ['test:direct-chat-blocked'],
          },
        ],
    nextUpgradeAction: 'No upgrade needed for test.',
    nextUpgradeEvidenceRefs: ['test:upgrade'],
    whyNotJarvisYetLabels: [],
    evidenceRefs: ['test:governor'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeStaleRun(opportunity: AoiOpportunity): AoiDeliberationRun {
  return {
    version: 1,
    id: 'aoi-delib-run-stale',
    sessionPath: SESSION_PATH,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    opportunityTitle: opportunity.title,
    phase: 'blocked',
    selectedAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    evidencePlan: [
      {
        version: 1,
        id: 'stale-research-step',
        kind: 'research',
        status: 'stale',
        sourceRef: 'research:re-trend-001',
        label: 'Research evidence',
        summary: 'Research evidence is stale.',
        freshness: 'stale',
        evidenceRefs: ['research:re-trend-001'],
        cannotKnow: ['stale source'],
        blockers: ['research evidence is stale'],
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    ],
    finding: {
      version: 1,
      summary: 'Evidence exists but is stale.',
      sourceQuality: 'weak',
      freshness: 'stale',
      confidence: 0.32,
      evidenceRefs: ['research:re-trend-001'],
      blockers: ['research evidence is stale'],
      cannotKnow: ['current state without refresh'],
      createdAt: NOW - 1_000,
    },
    safeNextAction: 'Refresh evidence before any interruption.',
    blockers: ['research evidence is stale'],
    evidenceRefs: ['research:re-trend-001'],
    artifactRefs: ['deliberation_run:stale'],
    phaseHistory: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeFeedback(category: AoiProactiveBriefFeedback['category']): AoiProactiveBriefFeedback {
  return {
    version: 1,
    id: `feedback-${category}`,
    briefId: 'brief-001',
    topicId: 'reverse-engineering',
    sessionPath: SESSION_PATH,
    category,
    createdAt: NOW - 30_000,
  };
}

describe('Aoi Interruption Governor', () => {
  it('allows direct chat only when all direct-chat gates pass', () => {
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity: makeOpportunity(),
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).toBe('direct_chat');
    expect(decision.directChatAllowed).toBe(true);
    expect(decision.directChatBlockedReasons).toEqual([]);
    expect(decision.actionAuthority).toBe('display_only');
    expect(decision.mutationCount).toBe(0);
  });

  it('blocks direct chat when opt-in is disabled', () => {
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity: makeOpportunity(),
      policy: makePolicy(),
      directChatOptIn: false,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).not.toBe('direct_chat');
    expect(decision.directChatAllowed).toBe(false);
    expect(decision.directChatBlockedReasons).toContain('direct_chat_not_opted_in');
  });

  it('blocks direct chat when the Jarvis governor ceiling does not allow it', () => {
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity: makeOpportunity(),
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(false),
      now: NOW,
    });

    expect(decision.deliveryMode).not.toBe('direct_chat');
    expect(decision.directChatAllowed).toBe(false);
    expect(decision.directChatBlockedReasons).toContain('jarvis_governor_blocks_direct_chat');
  });

  it('blocks direct chat when the session direct-chat cap is reached', () => {
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity: makeOpportunity(),
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      directChatShownCount: 1,
      maxDirectChatsPerSession: 1,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).not.toBe('direct_chat');
    expect(decision.directChatAllowed).toBe(false);
    expect(decision.directChatBlockedReasons).toContain('direct_chat_session_limit_reached');
  });

  it('suppresses non-critical proactive interruption in quiet mode', () => {
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity: makeOpportunity({ urgency: 0.72 }),
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: true,
      notificationsEnabled: true,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).toBe('hidden');
    expect(decision.directChatBlockedReasons).toContain('quiet_mode');
  });

  it('downgrades duplicate or cooling-down delivery to dashboard only', () => {
    const opportunity = makeOpportunity();
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      notificationsEnabled: true,
      jarvisGovernor: makeJarvisGovernor(true),
      recentDeliveryKeys: [`interruption:${SESSION_PATH}:${opportunity.dedupeKey}`],
      now: NOW,
    });

    expect(decision.deliveryMode).toBe('dashboard');
    expect(decision.directChatAllowed).toBe(false);
    expect(decision.directChatBlockedReasons).toContain('duplicate_or_cooldown');
  });

  it('downgrades stale source evidence to dashboard only', () => {
    const opportunity = makeOpportunity();
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      deliberationRun: makeStaleRun(opportunity),
      policy: makePolicy(),
      directChatOptIn: true,
      quietMode: false,
      notificationsEnabled: true,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).toBe('dashboard');
    expect(decision.directChatBlockedReasons).toContain('stale_source');
  });

  it('downgrades too-frequent feedback before direct chat can be offered again', () => {
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity: makeOpportunity(),
      policy: makePolicy(),
      feedback: [makeFeedback('too_frequent')],
      directChatOptIn: true,
      quietMode: false,
      notificationsEnabled: true,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).toBe('dashboard');
    expect(decision.directChatAllowed).toBe(false);
    expect(decision.directChatBlockedReasons).toEqual(
      expect.arrayContaining(['recent_negative_feedback', 'too_frequent_feedback']),
    );
  });

  it('uses follow-through learning to reduce direct chat after too-frequent outcomes', () => {
    const opportunity = makeOpportunity();
    const followThroughLearning = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        {
          version: 1,
          id: 'follow-through-too-frequent',
          sessionPath: SESSION_PATH,
          opportunityId: opportunity.id,
          sourceKind: opportunity.sourceKind,
          topicKey: opportunity.dedupeKey,
          sourceKey: opportunity.sourceKind,
          deliveryMode: 'direct_chat',
          action: 'dismissed',
          feedbackCategory: 'too_frequent',
          result: 'negative',
          timingLabel: 'too frequent in test',
          evidenceRefs: ['test:too-frequent-follow-through'],
          createdAt: NOW - 30_000,
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
      now: NOW,
    });
    const decision = decideAoiInterruptionDelivery({
      sessionPath: SESSION_PATH,
      opportunity,
      policy: makePolicy(),
      followThroughLearning,
      directChatOptIn: true,
      quietMode: false,
      notificationsEnabled: true,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });

    expect(decision.deliveryMode).toBe('dashboard');
    expect(decision.directChatAllowed).toBe(false);
    expect(decision.directChatBlockedReasons).toEqual(
      expect.arrayContaining([
        'recent_negative_feedback',
        'too_frequent_feedback',
        'duplicate_or_cooldown',
      ]),
    );
  });

  it('surfaces governor mode and blocked reasons in the opportunity inbox summary', () => {
    const opportunity = makeOpportunity();
    const decisions = buildAoiInterruptionGovernorDecisions({
      sessionPath: SESSION_PATH,
      opportunities: [opportunity],
      policy: makePolicy(),
      directChatOptIn: false,
      quietMode: false,
      jarvisGovernor: makeJarvisGovernor(true),
      now: NOW,
    });
    const summary = buildAoiOpportunityInboxPanelSummary({
      active: [opportunity],
      status: {
        version: 1,
        sessionPath: SESSION_PATH,
        policy: makePolicy(),
        activeProposalCount: 0,
        archivedProposalCount: 0,
        acceptedProposalCount: 0,
        snoozedProposalCount: 0,
        blockedProposalCount: 0,
        observationCount: 0,
        reflectionCount: 0,
        decisionCount: 0,
        activeTick: false,
        recentObservationCount: 0,
        proposalsCreatedInLastTick: 0,
        activeGoalCount: 0,
        updatedAt: NOW,
      },
      interruptionDecisions: decisions,
      now: NOW,
    });

    expect(summary.itemLabels[0]?.interruptionModeLabel).toContain('governor:');
    expect(summary.itemLabels[0]?.interruptionBlockedLabels.join(' ')).toContain(
      'Direct chat is not opted in',
    );
  });
});
