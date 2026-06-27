import { describe, expect, it } from 'vitest';

import type {
  AoiContextRouterResult,
  AoiEnvironmentSourceRegistry,
  AoiFollowThroughEvent,
  AoiFollowThroughLearningSummary,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiMissionState,
} from '../aoiAutonomyTypes';
import { decideAoiCapabilityBrokerAuthority } from '../aoiCapabilityRegistry';
import { buildAoiFollowThroughLearningSummary } from '../aoiFollowThroughLearning';
import { buildAoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiSourceFreshnessContract } from '../aoiSourceFreshnessContract';
import {
  buildAoiInterestProfileFromUnifiedOperatorSnapshot,
  buildAoiUnifiedOperatorSnapshot,
  formatAoiUnifiedOperatorSnapshotForOperator,
} from '../aoiUnifiedOperatorModel';
import type { AppDef } from '../appRegistry';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const KIRA_APP: AppDef = {
  appId: 18,
  appName: 'kira',
  displayName: 'Kira',
  route: '/kira',
  aliases: ['Kira Model Settings'],
  actions: [
    { name: 'OPEN_APP_WINDOW', description: 'Open Kira', params: [] },
    {
      name: 'APPLY_MODEL_SETTINGS',
      description: 'Persist Kira model settings',
      params: [{ name: 'reasoningEffort', type: 'string', description: 'Reasoning effort' }],
    },
  ],
};

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'topic-reverse-engineering',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'malware reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:re'],
    confidence: partial.confidence ?? 0.82,
    importance: partial.importance ?? 0.78,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.9,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? false,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW - DAY_MS,
    updatedAt: partial.updatedAt ?? NOW - 30_000,
  };
}

function makeProfile(topics: AoiInterestTopic[] = [makeTopic()]): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    topics,
    generatedAt: NOW - 15_000,
    sourceMemoryCount: topics.length,
    warnings: [],
  };
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: partial.id ?? 'memory-re',
    scope: partial.scope ?? 'user',
    type: partial.type ?? 'preference',
    status: partial.status ?? 'active',
    content: partial.content ?? 'Operator is interested in Reverse Engineering.',
    normalizedContent: partial.normalizedContent ?? 'operator is interested in reverse engineering',
    importance: partial.importance ?? 0.8,
    confidence: partial.confidence ?? 0.8,
    hits: partial.hits ?? 1,
    createdAt: partial.createdAt ?? NOW - DAY_MS,
    updatedAt: partial.updatedAt ?? NOW - 30_000,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['episode:memory'],
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    tags: partial.tags ?? ['interest'],
    entities: partial.entities ?? ['Reverse Engineering'],
    ...partial,
  };
}

function makeFollowThrough(events: AoiFollowThroughEvent[]): AoiFollowThroughLearningSummary {
  return buildAoiFollowThroughLearningSummary({
    sessionPath: SESSION_PATH,
    followThroughEvents: events,
    now: NOW,
  });
}

function makeEvent(partial: Partial<AoiFollowThroughEvent> = {}): AoiFollowThroughEvent {
  return {
    version: 1,
    id: partial.id ?? 'event-useful',
    sessionPath: SESSION_PATH,
    opportunityId: partial.opportunityId ?? 'opportunity-re',
    sourceKind: partial.sourceKind ?? 'proactive_brief',
    topicKey: partial.topicKey ?? 'topic:reverse-engineering',
    sourceKey: partial.sourceKey ?? 'workspace',
    deliveryMode: partial.deliveryMode ?? 'dashboard',
    action: partial.action ?? 'accepted',
    feedbackCategory: partial.feedbackCategory ?? 'useful',
    learningSignalKind: partial.learningSignalKind ?? 'explicit_label',
    result: partial.result ?? 'positive',
    timingLabel: partial.timingLabel ?? 'test event',
    evidenceRefs: partial.evidenceRefs ?? ['operator-feedback:test'],
    createdAt: partial.createdAt ?? NOW,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeRegistry(): AoiEnvironmentSourceRegistry {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    updatedAt: NOW,
    sources: [
      {
        version: 1,
        id: 'workspace-git',
        kind: 'workspace_git',
        label: 'Workspace git',
        enabled: true,
        scope: 'workspace',
        risk: 'low',
        allowedOperations: ['status', 'diff'],
        privateByDefault: false,
        quietModeBehavior: 'record_only',
        updatedAt: NOW - 1_000,
        lastObservedAt: NOW - 1_000,
      },
      {
        version: 1,
        id: 'bad_source',
        kind: 'browser_context',
        label: 'Bad source',
        enabled: true,
        scope: 'session',
        risk: 'medium',
        allowedOperations: ['summarize'],
        privateByDefault: false,
        quietModeBehavior: 'record_only',
        updatedAt: NOW - 1_000,
        lastObservedAt: NOW - 1_000,
      },
      {
        version: 1,
        id: 'gmail-metadata',
        kind: 'gmail_metadata',
        label: 'Gmail metadata for honey@example.com',
        enabled: true,
        scope: 'session',
        risk: 'medium',
        allowedOperations: ['read_metadata'],
        privateByDefault: true,
        quietModeBehavior: 'record_only',
        updatedAt: NOW - 1_000,
      },
    ],
  };
}

function makeContextRouter(partial: Partial<AoiContextRouterResult> = {}): AoiContextRouterResult {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    selectedSources: [
      {
        version: 1,
        id: 'context-workspace-git',
        sourceId: 'workspace-git',
        kind: 'workspace_git',
        label: 'Workspace git',
        relevanceScore: 0.9,
        confidence: 0.86,
        freshness: 'fresh',
        redactionState: 'none',
        summary: 'Fresh workspace validation evidence is available.',
        evidenceRefs: ['workspace:git-status'],
        scoreReasons: ['fresh_validation'],
        updatedAt: NOW - 1_000,
      },
    ],
    candidateSources: [],
    promptBlock: 'test context',
    ...partial,
  };
}

function makeMission(): AoiMissionState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    status: 'active',
    activeGoalId: 'goal-unified-operator',
    focusSummary: 'Build unified operator state.',
    waitingOn: 'none',
    nextRecommendedAction: {
      kind: 'prepare_validation',
      label: 'Run unified operator tests.',
      reason: 'Snapshot contract changed.',
      ref: 'goal:unified-operator',
    },
    evidenceRefs: ['goal:unified-operator'],
    sourceRefs: {
      goalRef: 'goal:unified-operator',
      workspaceSnapshotRef: 'workspace:git-status',
    },
    transitions: [],
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - 1_000,
  };
}

function makeSourceContract(
  partial: Partial<AoiSourceFreshnessContract> = {},
): AoiSourceFreshnessContract {
  return {
    version: 1,
    id: `source-contract:${partial.sourceId ?? 'workspace-git'}`,
    sourceId: partial.sourceId ?? 'workspace-git',
    sourceKind: partial.sourceKind ?? 'workspace_git',
    sourceLabel: partial.sourceLabel ?? 'Workspace git',
    consentState: partial.consentState ?? 'granted',
    dataScope: partial.dataScope ?? 'status and diff',
    scopeState: partial.scopeState ?? 'workspace',
    bodyAccessState: partial.bodyAccessState ?? 'not_applicable',
    freshnessState: partial.freshnessState ?? 'fresh',
    signalFreshness: partial.signalFreshness ?? 'fresh',
    staleAfterMs: partial.staleAfterMs ?? 60_000,
    lastObservedAt: partial.lastObservedAt ?? NOW - 1_000,
    cannotKnow: partial.cannotKnow ?? [],
    evidenceRefs: partial.evidenceRefs ?? [`source:${partial.sourceId ?? 'workspace-git'}`],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeSnapshot(
  partial: Partial<Parameters<typeof buildAoiUnifiedOperatorSnapshot>[0]> = {},
) {
  return buildAoiUnifiedOperatorSnapshot({
    sessionPath: SESSION_PATH,
    now: NOW,
    interestProfile: makeProfile(),
    mission: makeMission(),
    sourceRegistry: makeRegistry(),
    contextRouter: makeContextRouter(),
    sourceFreshnessContracts: [makeSourceContract()],
    readinessScorecard: buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
    }),
    ...partial,
  });
}

describe('Aoi unified operator model', () => {
  it('lets the current user message override durable interest memory', () => {
    const topic = makeTopic();
    const snapshot = makeSnapshot({
      currentUserMessage: 'I am not interested in RE anymore.',
      memories: [makeMemory({ id: 'memory-re' })],
      interestProfile: makeProfile([topic]),
    });
    const interest = snapshot.interests[0];

    expect(interest).toMatchObject({
      topicId: 'topic-reverse-engineering',
      winner: 'current_user_message',
      muted: true,
      relevance: 0,
    });
    expect(
      snapshot.conflicts.some((conflict) => conflict.kind === 'current_message_over_memory'),
    ).toBe(true);
    expect(buildAoiInterestProfileFromUnifiedOperatorSnapshot(snapshot)?.topics[0]?.updatedAt).toBe(
      topic.updatedAt,
    );
  });

  it('lowers source trust from explicit wrong-source feedback', () => {
    const snapshot = makeSnapshot({
      followThroughLearning: makeFollowThrough([
        makeEvent({
          id: 'event-wrong-source',
          sourceKey: 'bad_source',
          feedbackCategory: 'wrong_source',
          result: 'negative',
          evidenceRefs: ['operator-feedback:wrong-source'],
        }),
      ]),
      sourceFreshnessContracts: [
        makeSourceContract({
          sourceId: 'bad_source',
          sourceKind: 'browser_context',
          sourceLabel: 'Bad source',
          evidenceRefs: ['source:bad-source'],
        }),
      ],
    });
    const sourceTrust = snapshot.sourceTrust.find((source) => source.sourceId === 'bad_source');

    expect(sourceTrust?.negativeEvidence).toBe(true);
    expect(sourceTrust?.trustScore).toBeLessThanOrEqual(0.32);
    expect(sourceTrust?.evidenceRefs).toContain('operator-feedback:wrong-source');
  });

  it('raises useful topic relevance without granting execute authority', () => {
    const baseTopic = makeTopic({ importance: 0.6, confidence: 0.62 });
    const feedback = makeFollowThrough([
      makeEvent({
        id: 'event-useful-topic',
        feedbackCategory: 'useful',
        evidenceRefs: ['operator-feedback:useful-topic'],
      }),
    ]);
    const brokerDecision = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'APPLY_MODEL_SETTINGS',
      requestedBand: 'execute',
      apps: [KIRA_APP],
    });
    const snapshot = makeSnapshot({
      interestProfile: makeProfile([baseTopic]),
      followThroughLearning: feedback,
      capabilityDecisions: [brokerDecision],
    });
    const interest = snapshot.interests[0];

    expect(interest?.relevance).toBeGreaterThan(baseTopic.importance);
    expect(interest?.winner).toBe('explicit_operator_feedback');
    expect(snapshot.actionAuthority.executeAllowed).toBe(false);
    expect(snapshot.actionAuthority.mutationCount).toBe(0);
    expect(snapshot.actionAuthority.capabilityDecisionRefs).toContain(
      brokerDecision.authorityDecisionId,
    );
  });

  it('keeps passive outcomes low confidence until explicit feedback exists', () => {
    const snapshot = makeSnapshot({
      interestProfile: makeProfile([makeTopic({ confidence: 0.4, importance: 0.5 })]),
      followThroughLearning: makeFollowThrough([
        makeEvent({
          id: 'event-passive-opened',
          feedbackCategory: 'outcome:proposal_opened',
          learningSignalKind: 'passive_outcome',
          outcomeKind: 'proposal_opened',
          evidenceRefs: ['outcome:proposal-opened'],
        }),
      ]),
    });
    const interest = snapshot.interests[0];

    expect(interest?.winner).toBe('inferred_outcome');
    expect(interest?.confidence).toBeLessThanOrEqual(0.54);
    expect(snapshot.feedback.cannotKnow.join(' ')).toContain('Passive outcomes');
  });

  it('lets fresh source state win over stale project memory', () => {
    const snapshot = makeSnapshot({
      memories: [
        makeMemory({
          id: 'memory-stale-project',
          scope: 'project',
          type: 'fact',
          content: 'Project state from old memory.',
          normalizedContent: 'project state from old memory',
          tags: ['project'],
          updatedAt: NOW - 90 * DAY_MS,
        }),
      ],
      contextRouter: makeContextRouter(),
      sourceFreshnessContracts: [makeSourceContract()],
    });

    expect(snapshot.projectState.freshness).toBe('fresh');
    expect(
      snapshot.conflicts.some((conflict) => conflict.kind === 'fresh_source_over_stale_memory'),
    ).toBe(true);
  });

  it('treats disconnected personal sources as blind spots, not negative evidence', () => {
    const snapshot = makeSnapshot({
      sourceFreshnessContracts: [
        makeSourceContract({
          sourceId: 'gmail-metadata',
          sourceKind: 'gmail_metadata',
          sourceLabel: 'Gmail metadata',
          consentState: 'disconnected',
          freshnessState: 'disconnected',
          signalFreshness: 'unknown',
          bodyAccessState: 'body_disabled',
          cannotKnow: [
            {
              version: 1,
              code: 'gmail_disconnected',
              statement: 'Aoi cannot know current Gmail metadata because Gmail is disconnected.',
              evidenceRefs: ['gmail:disconnected'],
            },
          ],
        }),
      ],
    });
    const sourceTrust = snapshot.sourceTrust.find((source) => source.sourceId === 'gmail-metadata');

    expect(sourceTrust?.trustState).toBe('blind_spot');
    expect(sourceTrust?.negativeEvidence).toBe(false);
    expect(snapshot.blindSpots[0]?.negativeEvidence).toBe(false);
    expect(
      snapshot.conflicts.some((conflict) => conflict.kind === 'disconnected_source_blind_spot'),
    ).toBe(true);
  });

  it('redacts private source bodies, emails, local paths, and standalone secrets', () => {
    const snapshot = makeSnapshot({
      contextRouter: makeContextRouter({
        selectedSources: [
          {
            version: 1,
            id: 'context-gmail-metadata',
            sourceId: 'gmail-metadata',
            kind: 'gmail_metadata',
            label: 'Gmail metadata for honey@example.com',
            relevanceScore: 0.7,
            confidence: 0.4,
            freshness: 'stale',
            redactionState: 'redacted',
            summary:
              'Private body for honey@example.com from C:\\Users\\secret\\Inbox\\raw.eml token=secret123456789012.',
            evidenceRefs: ['C:\\Users\\secret\\Inbox\\raw.eml'],
            scoreReasons: ['private_source_disconnected'],
            updatedAt: NOW - 5_000,
            cannotKnowStatements: [
              'Cannot read C:\\Users\\secret\\Inbox\\raw.eml while Gmail is disconnected.',
            ],
          },
        ],
      }),
      sourceFreshnessContracts: [
        makeSourceContract({
          sourceId: 'gmail-metadata',
          sourceKind: 'gmail_metadata',
          sourceLabel: 'Gmail metadata for honey@example.com',
          consentState: 'disconnected',
          freshnessState: 'disconnected',
          signalFreshness: 'unknown',
          bodyAccessState: 'body_disabled',
          evidenceRefs: ['C:\\Users\\secret\\Inbox\\raw.eml'],
        }),
      ],
    });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.projectState.summary).toContain('body withheld');
    expect(serialized).not.toContain('honey@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('secret123456789012');
    expect(formatAoiUnifiedOperatorSnapshotForOperator(snapshot)).toContain('What I saw');
    expect(formatAoiUnifiedOperatorSnapshotForOperator(snapshot)).toContain('What I cannot know');
  });
});
