import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import type { AoiAutonomyPolicy, AoiInterestProfile, AoiInterestTopic } from '../aoiAutonomyTypes';
import { buildAoiFeedbackCompression } from '../aoiFeedbackCompression';
import { loadAoiFieldEvents } from '../aoiFieldEventLedger';
import { buildAoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';
import { createAoiOperatorFeedbackLabelAction } from '../aoiOperatorFeedbackInbox';
import type {
  AoiProactiveBriefRawSearchResult,
  AoiProactiveBriefSearchAdapter,
} from '../aoiProactiveBriefResearch';
import { planAoiProactiveBriefTopics } from '../aoiProactiveBriefPlanner';
import {
  buildAoiProactiveResearchRoutineProfile,
  runAoiProactiveResearchRoutine,
} from '../aoiProactiveResearchRoutine';
import { buildAoiUnifiedOperatorSnapshot } from '../aoiUnifiedOperatorModel';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-research-routine-test-'));
  tempRoots.push(root);
  return root;
}

function makePolicy(now = NOW): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    confidenceFloor: 0.5,
    defaultCooldownMs: 60 * 60 * 1000,
    proactiveBriefing: {
      ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
      enabled: true,
      allowBackgroundScout: true,
      directChatHookOptIn: false,
    },
    updatedAt: now,
  };
}

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
    confidence: partial.confidence ?? 0.86,
    importance: partial.importance ?? 0.84,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.92,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? `interest:${partial.id ?? 'reverse-engineering'}`,
    createdAt: partial.createdAt ?? NOW - 60_000,
    updatedAt: partial.updatedAt ?? NOW - 30_000,
  };
}

function makeInterestTopics(): AoiInterestTopic[] {
  return [
    makeTopic(),
    makeTopic({
      id: 'topic-windows-security',
      label: 'Windows Security',
      normalizedLabel: 'windows security',
      aliases: ['Windows internals', 'kernel telemetry'],
      memoryIds: ['memory-windows-security'],
      evidenceRefs: ['memory:windows-security'],
      cooldownKey: 'interest:windows-security',
      importance: 0.82,
      confidence: 0.85,
      currentInfoPreference: 0.9,
    }),
    makeTopic({
      id: 'topic-anti-cheat',
      label: 'Anti-Cheat',
      normalizedLabel: 'anti cheat',
      aliases: ['game security', 'kernel anti-cheat'],
      memoryIds: ['memory-anticheat'],
      evidenceRefs: ['memory:anticheat'],
      cooldownKey: 'interest:anti-cheat',
      importance: 0.81,
      confidence: 0.84,
      currentInfoPreference: 0.91,
    }),
  ];
}

function makeProfile(topics: AoiInterestTopic[] = makeInterestTopics()): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    topics,
    generatedAt: NOW,
    sourceMemoryCount: topics.length,
    warnings: [],
  };
}

function freshResults(topicId: string, now = NOW): AoiProactiveBriefRawSearchResult[] {
  const publishedAt = new Date(now - 60_000).toISOString();
  const topic = topicId.replace(/^topic-/, '');
  return [
    {
      title: `${topic} public research note`,
      url: `https://research.example.com/${topic}/note`,
      content: `Fresh public source for ${topic}.`,
      publishedAt,
    },
    {
      title: `${topic} security engineering update`,
      url: `https://security.example.net/${topic}/update`,
      content: `Second fresh public source for ${topic}.`,
      publishedAt,
    },
    {
      title: `${topic} field report`,
      url: `https://analysis.example.org/${topic}/field-report`,
      content: `Third fresh public source for ${topic}.`,
      publishedAt,
    },
  ];
}

function staleResults(topicId: string, now = NOW): AoiProactiveBriefRawSearchResult[] {
  const publishedAt = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  return freshResults(topicId, now).map((result) => ({
    ...result,
    publishedAt,
  }));
}

function makeSearch(
  resultsForTopic: (topicId: string) => AoiProactiveBriefRawSearchResult[] = freshResults,
): AoiProactiveBriefSearchAdapter {
  return vi.fn(async (request) => ({
    query: request.query,
    retrievedAt: request.now,
    results: resultsForTopic(request.topicId),
  }));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi proactive research routine', () => {
  it('selects RE, Windows security, and anti-cheat interests and scouts only through gated fresh public fixtures', async () => {
    const root = makeTempRoot();
    const profile = makeProfile();
    const search = makeSearch();
    const usefulReLabel = createAoiOperatorFeedbackLabelAction({
      sessionPath: SESSION_PATH,
      decisionRecordId: 'record-re-useful',
      decisionId: 'decision-re-useful',
      topicKey: 'topic:reverse-engineering',
      label: 'useful',
      sourceKinds: ['research_run'],
      sourceKey: 'research',
      evidenceRefs: ['operator-feedback:re-useful'],
      now: NOW,
    });
    const feedbackCompression = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      labelActions: [usefulReLabel],
      now: NOW,
    });

    const result = await runAoiProactiveResearchRoutine({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      profile,
      feedbackCompression,
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 3,
        maxNetworkCallsPerWakeup: 3,
      },
      dependencies: {
        search,
        loadPolicy: () => makePolicy(),
      },
    });

    expect(search).toHaveBeenCalledTimes(3);
    expect(result.selectedTopics.map((topic) => topic.topicLabel).sort()).toEqual([
      'Anti-Cheat',
      'Reverse Engineering',
      'Windows Security',
    ]);
    expect(
      result.selectedTopics.find((topic) => topic.topicLabel === 'Reverse Engineering')
        ?.feedbackAdjusted,
    ).toBe(true);
    expect(result.createdCandidates).toHaveLength(3);
    expect(
      result.createdCandidates.every(
        (candidate) => candidate.delivery.allowedModes[0] === 'dashboard',
      ),
    ).toBe(true);
    expect(result.currentClaimAllowed).toBe(true);
    expect(result.gateSummary.provider).toBe('pass');
    expect(result.gateSummary.networkBudgetAllowed).toBe(true);
    expect(result.gateSummary.scoutBudgetAvailable).toBe(true);
    expect(result.gateSummary.readinessAllowsDashboard).toBe(true);
    expect(result.gateSummary.scoutExecuted).toBe(true);
    expect(result.directChatEligibility.eligible).toBe(false);
    expect(result.staleCurrentClaimCount).toBe(0);
    expect(result.mutationCount).toBe(0);
    expect(loadAoiFieldEvents(root, SESSION_PATH, NOW)).toHaveLength(3);
  });

  it('records provider-missing source honesty and cannotKnow without making a current claim', async () => {
    const root = makeTempRoot();
    const result = await runAoiProactiveResearchRoutine({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      profile: makeProfile([makeTopic()]),
      configFile: join(root, 'missing-tavily.json'),
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
      dependencies: {
        loadPolicy: () => makePolicy(),
      },
    });

    expect(result.createdCandidates).toHaveLength(0);
    expect(result.currentClaimAllowed).toBe(false);
    expect(result.currentClaimBlockedReasons).toContain('tavily_not_configured');
    expect(result.gateSummary.provider).toBe('missing');
    expect(result.gateSummary.scoutExecuted).toBe(false);
    expect(result.cannotKnow.join(' ')).toContain('no approved current-info provider');
    expect(result.sourceHonestyRecords[0]).toMatchObject({
      reason: 'tavily_not_configured',
      currentClaimAllowed: false,
      directChatCandidate: false,
      mutationCount: 0,
    });
    expect(result.fieldEvents[0]?.category).toBe('deliberation_blocked');
    expect(result.staleCurrentClaimCount).toBe(0);
  });

  it('reads planned interests and evidence from a unified operator snapshot when profile is omitted', async () => {
    const root = makeTempRoot();
    const topic = makeTopic({ updatedAt: NOW - 123_456 });
    const search = makeSearch();
    const operatorSnapshot = buildAoiUnifiedOperatorSnapshot({
      sessionPath: SESSION_PATH,
      now: NOW,
      interestProfile: makeProfile([topic]),
    });

    const result = await runAoiProactiveResearchRoutine({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      operatorSnapshot,
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
      dependencies: {
        search,
        loadPolicy: () => makePolicy(),
      },
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.selectedTopics[0]).toMatchObject({
      topicId: 'topic-reverse-engineering',
      topicLabel: 'Reverse Engineering',
    });
    expect(result.operatorSnapshotSummary?.id).toBe(operatorSnapshot.id);
    expect(result.evidenceRefs).toContain(`operator-snapshot:${operatorSnapshot.id}`);
    expect(result.gateSummary.evidenceRefs).toContain(`operator-snapshot:${operatorSnapshot.id}`);
  });

  it('does not call search when explicit network scout budget is exhausted', async () => {
    const root = makeTempRoot();
    const search = makeSearch();
    const result = await runAoiProactiveResearchRoutine({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      profile: makeProfile([makeTopic()]),
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 0,
      },
      dependencies: {
        search,
        loadPolicy: () => makePolicy(),
      },
    });

    expect(search).not.toHaveBeenCalled();
    expect(result.createdCandidates).toHaveLength(0);
    expect(result.currentClaimAllowed).toBe(false);
    expect(result.currentClaimBlockedReasons).toContain('network_budget_exhausted');
    expect(result.skippedTopics[0]).toMatchObject({
      reason: 'network_budget_exhausted',
    });
    expect(result.cannotKnow.join(' ')).toContain('scout budget was exhausted');
    expect(result.staleCurrentClaimCount).toBe(0);
  });

  it('allows a stale-source scout candidate only as a non-current claim with source honesty', async () => {
    const root = makeTempRoot();
    const result = await runAoiProactiveResearchRoutine({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      profile: makeProfile([makeTopic()]),
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
        minSourcesPerCandidate: 2,
        sourceStaleAfterMs: 7 * 24 * 60 * 60 * 1000,
      },
      dependencies: {
        search: makeSearch(staleResults),
        loadPolicy: () => makePolicy(),
      },
    });

    expect(result.createdCandidates).toHaveLength(1);
    expect(result.createdCandidates[0]?.summary).toContain('source-backed scout candidate');
    expect(result.createdCandidates[0]?.summary).not.toContain('current-info candidate');
    expect(result.currentClaimAllowed).toBe(false);
    expect(result.currentClaimBlockedReasons).toContain('source_stale');
    expect(result.freshnessRecords[0]?.cannotKnow.join(' ')).toContain('fresh current information');
    expect(result.sourceHonestyRecords[0]).toMatchObject({
      reason: 'source_freshness_uncertain',
      currentClaimAllowed: false,
    });
    expect(JSON.stringify(result.fieldEvents)).not.toContain('current-info candidate');
    expect(result.staleCurrentClaimCount).toBe(0);
  });

  it('blocks scouting before provider/search when readiness does not allow dashboard visibility', async () => {
    const root = makeTempRoot();
    const search = makeSearch();
    const baseReadiness = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    const readiness = {
      ...baseReadiness,
      gateStatus: 'blocked' as const,
      visibility: {
        ...baseReadiness.visibility,
        dashboard: 'blocked' as const,
        directChat: 'blocked' as const,
        directChatBlockedReasons: ['routine test dashboard readiness block'],
      },
      gates: [
        ...baseReadiness.gates,
        {
          version: 1 as const,
          id: 'gate.routine_dashboard_visibility',
          label: 'Routine dashboard visibility',
          status: 'block' as const,
          reason: 'Dashboard visibility is blocked for the proactive routine test.',
          evidenceRefs: ['readiness:routine-dashboard-blocked'],
          blockerRefs: ['readiness:routine-dashboard-blocked'],
        },
      ],
      blockerRefs: ['readiness:routine-dashboard-blocked'],
      evidenceRefs: ['readiness:routine-dashboard-blocked'],
    };

    const result = await runAoiProactiveResearchRoutine({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      profile: makeProfile([makeTopic()]),
      readinessScorecard: readiness,
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
      dependencies: {
        search,
        loadPolicy: () => makePolicy(),
      },
    });

    expect(search).not.toHaveBeenCalled();
    expect(result.createdCandidates).toHaveLength(0);
    expect(result.currentClaimAllowed).toBe(false);
    expect(result.currentClaimBlockedReasons).toContain('readiness_gate_blocked');
    expect(result.gateSummary.readinessAllowsDashboard).toBe(false);
    expect(result.skippedTopics[0]).toMatchObject({
      reason: 'readiness_gate_blocked',
    });
    expect(result.cannotKnow.join(' ')).toContain('readiness does not allow dashboard visibility');
    expect(result.fieldEvents[0]?.category).toBe('readiness_gate_changed');
    expect(result.staleCurrentClaimCount).toBe(0);
  });
});

describe('Aoi proactive brief planner feedback compression handoff', () => {
  it('keeps the feedback-adjusted profile compatible with the existing planner budget contract', () => {
    const profile = makeProfile([makeTopic({ importance: 0.7, currentInfoPreference: 0.7 })]);
    const label = createAoiOperatorFeedbackLabelAction({
      sessionPath: SESSION_PATH,
      decisionRecordId: 'record-should-have-spoken',
      decisionId: 'decision-should-have-spoken',
      topicKey: 'topic:reverse-engineering',
      label: 'should_have_spoken',
      sourceKinds: ['research_run'],
      sourceKey: 'research',
      evidenceRefs: ['operator-feedback:should-have-spoken'],
      now: NOW,
    });
    const feedbackCompression = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      labelActions: [label],
      now: NOW,
    });
    const adjustedProfile = buildAoiProactiveResearchRoutineProfile({
      profile,
      feedbackCompression,
      now: NOW,
    });
    const plan = planAoiProactiveBriefTopics({
      profile: adjustedProfile,
      cooldownState: {
        version: 1,
        sessionPath: SESSION_PATH,
        updatedAt: NOW,
        cooldowns: {},
      },
      feedback: [],
      now: NOW,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
    });

    expect(adjustedProfile.topics[0]?.importance).toBeGreaterThan(
      profile.topics[0]?.importance ?? 0,
    );
    expect(plan.topics).toHaveLength(1);
    expect(plan.topics[0]?.topic.id).toBe('topic-reverse-engineering');
    expect(plan.networkCallBudget.plannedCalls).toBe(1);
  });
});
