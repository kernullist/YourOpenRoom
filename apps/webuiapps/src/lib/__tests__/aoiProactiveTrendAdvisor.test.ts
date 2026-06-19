import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFieldMetrics,
} from '../aoiAutonomyTypes';
import {
  buildAoiProactiveTrendAdvisorDiagnostics,
  buildAoiProactiveTrendAdvisorState,
  buildAoiProactiveTrendWatchProfile,
  loadAoiProactiveTrendDeliveryEvents,
  loadAoiProactiveTrendSnapshots,
  recordAoiProactiveTrendDeliveryEventFromSnapshot,
  resolveAoiProactiveTrendPaths,
} from '../aoiProactiveTrendAdvisor';
import {
  runAoiProactiveTrendProviderSmokeReplay,
  runBuiltInAoiProactiveTrendReplayFixtures,
} from '../aoiProactiveTrendReplay';

const SESSION_PATH = 'aoi/default';
const NOW = Date.parse('2026-06-19T00:00:00.000Z');

function tempRoot(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-trend-test-'));
}

function makePolicy(optIn = false): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    confidenceFloor: 0.55,
    proactiveBriefing: {
      ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
      enabled: true,
      allowBackgroundScout: true,
      directChatHookOptIn: optIn,
    },
    updatedAt: NOW,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-re',
    sessionPath: SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:re'],
    confidence: partial.confidence ?? 0.9,
    importance: partial.importance ?? 0.86,
    noveltyPreference: partial.noveltyPreference ?? 0.8,
    currentInfoPreference: partial.currentInfoPreference ?? 0.92,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW - 86_400_000,
    updatedAt: partial.updatedAt ?? NOW - 60_000,
  };
}

function makeProfile(topic: AoiInterestTopic = makeTopic()): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    topics: [topic],
    generatedAt: NOW,
    sourceMemoryCount: 1,
    warnings: [],
  };
}

function makeFieldMetrics(): AoiProactiveBriefFieldMetrics {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    generatedAt: NOW,
    status: 'field_events_recorded',
    eventCount: 3,
    consideredCount: 3,
    shownCount: 2,
    shownByDeliveryMode: {
      dashboard: 2,
      digest: 0,
      inline_card: 0,
      chat_hook: 0,
    },
    expandedCount: 1,
    sourceOpenedCount: 1,
    feedbackRecordedCount: 1,
    usefulCount: 1,
    tooFrequentCount: 0,
    wrongTopicCount: 0,
    wrongTimingCount: 0,
    staleCount: 0,
    staleCurrentClaimCount: 0,
    unsafeCount: 0,
    suppressionCounts: {},
    privateLeakCount: 0,
    unauthorizedMutationCount: 0,
    directChatHookCount: 0,
    lastEventAt: NOW,
    evidenceRefs: ['proactive-brief-field:ready'],
  };
}

function makeCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-trend-re',
    sessionPath: SESSION_PATH,
    topicId: partial.topicId ?? 'aoi-interest-re',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Fresh reversing writeup trend',
    hook: partial.hook ?? 'A fresh reversing writeup matches your saved interests.',
    summary:
      partial.summary ?? 'A source-backed reversing writeup appeared in public research sources.',
    whyForOperator:
      partial.whyForOperator ?? 'This matches your reverse engineering interest profile.',
    noveltyReason: partial.noveltyReason ?? 'Two public sources mention the same technical angle.',
    sources: partial.sources ?? [
      {
        title: 'Fresh reversing writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        publishedAt: '2026-06-18T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Public source snippet.',
      },
      {
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
        host: 'security.example.net',
        publishedAt: '2026-06-17T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Second public source snippet.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? [
      'source:research.example.com',
      'source:security.example.net',
    ],
    memoryIds: partial.memoryIds ?? ['memory-re'],
    score: partial.score ?? 0.86,
    confidence: partial.confidence ?? 0.86,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: NOW,
      newestSourceAt: '2026-06-18T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    expiresAt: partial.expiresAt ?? NOW + 14 * 24 * 60 * 60 * 1000,
  };
}

function makeFeedback(
  category: AoiProactiveBriefFeedback['category'],
  partial: Partial<AoiProactiveBriefFeedback> = {},
): AoiProactiveBriefFeedback {
  return {
    version: 1,
    id: partial.id ?? `aoi-trend-feedback-${category}`,
    briefId: partial.briefId ?? 'aoi-brief-trend-re',
    topicId: partial.topicId ?? 'aoi-interest-re',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    category,
    ...(partial.note ? { note: partial.note } : {}),
    createdAt: partial.createdAt ?? NOW,
  };
}

describe('Aoi proactive trend advisor', () => {
  it('builds per-interest trend watch profiles from interest topics', () => {
    const profile = makeProfile();
    const trendProfile = buildAoiProactiveTrendWatchProfile({
      sessionPath: SESSION_PATH,
      profile,
      now: NOW,
    });

    expect(trendProfile.topicWatches).toHaveLength(1);
    expect(trendProfile.topicWatches[0].topicLabel).toBe('Reverse Engineering');
    expect(trendProfile.topicWatches[0].watchQueries.join(' ')).toContain('Reverse Engineering');
    expect(trendProfile.topicWatches[0].cadence).toBe('daily');
  });

  it('calibrates trend watch cadence and direct-chat sensitivity from feedback', () => {
    const profile = makeProfile(
      makeTopic({
        pinned: false,
        currentInfoPreference: 0.52,
      }),
    );
    const positiveFeedback: AoiProactiveBriefFeedback = {
      version: 1,
      id: 'aoi-feedback-useful-trend',
      briefId: 'aoi-brief-trend-re',
      topicId: 'aoi-interest-re',
      sessionPath: SESSION_PATH,
      category: 'useful',
      createdAt: NOW,
    };
    const trendProfile = buildAoiProactiveTrendWatchProfile({
      sessionPath: SESSION_PATH,
      profile,
      feedback: [positiveFeedback],
      now: NOW,
    });

    expect(trendProfile.topicWatches[0].cadence).toBe('daily');
    expect(trendProfile.topicWatches[0].directChatSensitivity).toBeGreaterThan(0.5);
    expect(trendProfile.topicWatches[0].evidenceRefs).toContain(
      'feedback:aoi-feedback-useful-trend',
    );
  });

  it('stores redacted source-backed trend snapshots under the session autonomy directory', () => {
    const root = tempRoot();
    const state = buildAoiProactiveTrendAdvisorState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      policy: makePolicy(false),
      profile: makeProfile(),
      candidates: [
        makeCandidate({
          summary:
            'Read C:\\Users\\kernulist\\private\\notes.md and token sk-test_secret_should_not_leak for details.',
        }),
      ],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
    });
    const paths = resolveAoiProactiveTrendPaths(root, SESSION_PATH);
    const stored = loadAoiProactiveTrendSnapshots(root, SESSION_PATH, NOW);
    const rawSnapshotText = fs.readFileSync(
      join(paths.snapshotsDir, `${state.snapshots[0].id}.json`),
      'utf-8',
    );

    expect(fs.existsSync(paths.watchProfile)).toBe(true);
    expect(fs.existsSync(paths.snapshotIndex)).toBe(true);
    expect(stored).toHaveLength(1);
    expect(rawSnapshotText).not.toContain('C:\\Users\\kernulist');
    expect(rawSnapshotText).not.toContain('sk-test_secret_should_not_leak');
    expect(stored[0].sources).toHaveLength(2);
    expect(state.opinionCards[0].whatChanged).toBeTruthy();
    expect(state.opinionCards[0].whyItMatters).toBeTruthy();
    expect(state.opinionCards[0].myTake).toBeTruthy();
    expect(state.opinionCards[0].suggestedNextAction).toBeTruthy();
  });

  it('keeps direct chat blocked by default while still preparing dashboard opinion cards', () => {
    const state = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(false),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });

    expect(state.opinionCards).toHaveLength(1);
    expect(state.opinionCards[0].directChatAllowed).toBe(false);
    expect(state.opinionCards[0].directChatBlockedReasons).toContain('direct_chat_not_opted_in');
    expect(state.inlineCard?.deliveryMode).toBe('inline_card');
    expect(state.quietNotificationCount).toBe(1);
  });

  it('marks direct chat ready only when opt-in, field evidence, and source gates pass', () => {
    const state = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });

    expect(state.readiness.status).toBe('ready');
    expect(state.opinionCards[0].directChatAllowed).toBe(true);
    expect(state.opinionCards[0].deliveryMode).toBe('direct_chat');
    expect(state.chatHook).toContain('Aoi trend signal');
    expect(state.directChatHookCount).toBe(1);
  });

  it('suppresses repeated snapshots from direct chat with novelty evidence', () => {
    const first = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });
    const repeated = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      existingSnapshots: first.snapshots,
      fieldMetrics: makeFieldMetrics(),
      now: NOW + 60_000,
      persist: false,
    });

    expect(repeated.opinionCards[0].directChatAllowed).toBe(false);
    expect(repeated.opinionCards[0].directChatBlockedReasons).toContain('repeat_trend_snapshot');
    expect(repeated.snapshots[0].novelty.status).toBe('repeat');
    expect(repeated.snapshots[0].novelty.matchedSnapshotIds).toContain(first.snapshots[0].id);
  });

  it('uses normalized public sources before allowing direct chat', () => {
    const state = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [
        makeCandidate({
          sources: [
            {
              title: 'Fresh reversing writeup',
              url: 'https://research.example.com/re/writeup',
              host: 'notion.so',
              publishedAt: '2026-06-18T00:00:00.000Z',
              retrievedAt: NOW,
              snippet: 'Public source snippet.',
            },
            {
              title: 'Local note should not count',
              url: 'file:///C:/Users/kernulist/private/notes.md',
              host: 'local',
              publishedAt: '2026-06-18T00:00:00.000Z',
              retrievedAt: NOW,
              snippet: 'Private local note.',
            },
          ],
        }),
      ],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });

    expect(state.opinionCards).toHaveLength(1);
    expect(state.opinionCards[0].sourceHosts).toEqual(['research.example.com']);
    expect(state.opinionCards[0].directChatAllowed).toBe(false);
    expect(state.opinionCards[0].directChatBlockedReasons).toContain('weak_source_evidence');
    expect(state.snapshots[0].sourceQuality.status).toBe('weak');
    expect(state.sourceQualityCounts.weak).toBe(1);
  });

  it('suppresses duplicate direct chat and notification delivery with a stable control key', () => {
    const first = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate({ dedupeKey: 'trend:reverse-engineering:loader' })],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });
    const repeated = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate({ dedupeKey: 'trend:reverse-engineering:loader' })],
      existingSnapshots: first.snapshots,
      fieldMetrics: makeFieldMetrics(),
      now: NOW + 60_000,
      persist: false,
    });

    expect(repeated.snapshots[0].delivery.controls.duplicateBlocked).toBe(true);
    expect(repeated.snapshots[0].delivery.controls.reasons).toContain('duplicate_trend_delivery');
    expect(repeated.opinionCards[0].directChatBlockedReasons).toContain('duplicate_trend_delivery');
    expect(repeated.opinionCards[0].deliveryMode).toBe('dashboard');
    expect(repeated.deliveryControlBlockedReasons).toContain('duplicate_trend_delivery');
  });

  it('records delivery audit events and uses them to suppress repeated trend delivery', () => {
    const root = tempRoot();
    const first = buildAoiProactiveTrendAdvisorState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate({ dedupeKey: 'trend:reverse-engineering:audit' })],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: true,
    });

    expect(first.directChatCard?.snapshotId).toBe(first.snapshots[0].id);

    const event = recordAoiProactiveTrendDeliveryEventFromSnapshot({
      sessionsDir: root,
      snapshot: first.snapshots[0],
      kind: 'direct_chat_offered',
      now: NOW + 1_000,
    });
    const repeatedEvent = recordAoiProactiveTrendDeliveryEventFromSnapshot({
      sessionsDir: root,
      snapshot: first.snapshots[0],
      kind: 'direct_chat_offered',
      now: NOW + 2_000,
    });
    const storedEvents = loadAoiProactiveTrendDeliveryEvents(root, SESSION_PATH, NOW + 3_000);

    expect(repeatedEvent.id).toBe(event.id);
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0].kind).toBe('direct_chat_offered');

    const repeated = buildAoiProactiveTrendAdvisorState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate({ dedupeKey: 'trend:reverse-engineering:audit' })],
      fieldMetrics: makeFieldMetrics(),
      now: NOW + 60_000,
      persist: true,
    });
    const diagnostics = buildAoiProactiveTrendAdvisorDiagnostics({
      state: repeated,
      tavilyConfigured: true,
      now: NOW + 60_000,
    });

    expect(repeated.recentDeliveryEvents[0].id).toBe(event.id);
    expect(repeated.deliveryAuditSummary.directChatOfferedCount).toBe(1);
    expect(repeated.snapshots[0].delivery.controls.duplicateBlocked).toBe(true);
    expect(repeated.snapshots[0].delivery.controls.reasons).toContain(
      'delivery_event_recently_recorded',
    );
    expect(repeated.snapshots[0].delivery.controls.evidenceRefs).toContain(
      `trend-delivery-event:${event.id}`,
    );
    expect(repeated.directChatCard).toBeUndefined();
    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'trend_delivery_audit_ready',
        'trend_delivery_audit_duplicate_suppressed',
      ]),
    );
  });

  it('honors quiet and snooze feedback controls before interrupting chat', () => {
    const quiet = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      feedback: [makeFeedback('wrong_timing')],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });
    const snoozed = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      feedback: [makeFeedback('archive_brief')],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });

    expect(quiet.opinionCards[0].directChatBlockedReasons).toContain('trend_quiet_control_active');
    expect(quiet.opinionCards[0].quietUntil).toBeGreaterThan(NOW);
    expect(snoozed.opinionCards[0].directChatBlockedReasons).toContain('trend_snoozed');
    expect(snoozed.opinionCards[0].snoozedUntil).toBeGreaterThan(NOW);
    expect(snoozed.opinionCards[0].deliveryMode).toBe('blocked');
  });

  it('calibrates interest drift from wrong-topic feedback and blocks direct chat', () => {
    const state = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      feedback: [makeFeedback('wrong_topic')],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });

    expect(state.snapshots[0].interestDrift.status).toBe('drifting');
    expect(state.interestDriftCounts.drifting).toBe(1);
    expect(state.opinionCards[0].directChatBlockedReasons).toContain('interest_drift_detected');
  });

  it('runs deterministic replay fixtures for trend advisor edge cases', () => {
    const reports = runBuiltInAoiProactiveTrendReplayFixtures();
    const scenarios = reports.map((report) => report.scenario);

    expect(scenarios).toEqual([
      'fresh_trend',
      'stale_source',
      'weak_evidence',
      'wrong_topic',
      'too_frequent',
      'useful_opinion',
    ]);
    expect(reports.every((report) => report.passed)).toBe(true);
  });

  it('runs provider smoke from current-info search adapter through trend advisor', async () => {
    const report = await runAoiProactiveTrendProviderSmokeReplay();

    expect(report.scenario).toBe('provider_smoke');
    expect(report.passed).toBe(true);
    expect(report.metrics.find((item) => item.name === 'provider_search_called')?.passed).toBe(
      true,
    );
    expect(report.metrics.find((item) => item.name === 'source_quality_gate')?.actual).toContain(
      'strong',
    );
    expect(report.state.directChatHookCount).toBe(1);
  });

  it('emits operator-health diagnostics without claiming unrestricted background research', () => {
    const state = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(false),
      profile: makeProfile(),
      candidates: [makeCandidate()],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });
    const diagnostics = buildAoiProactiveTrendAdvisorDiagnostics({
      state,
      tavilyConfigured: false,
      now: NOW,
    });

    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'trend_provider_missing',
        'trend_opinion_cards_ready',
        'trend_direct_chat_not_ready',
      ]),
    );
    expect(diagnostics.map((item) => item.cannotKnow).join(' ')).toContain(
      'cannot know current public trends',
    );
  });

  it('emits operator-health evidence for source quality, controls, and interest drift', () => {
    const first = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [makeCandidate({ dedupeKey: 'trend:reverse-engineering:loader' })],
      fieldMetrics: makeFieldMetrics(),
      now: NOW,
      persist: false,
    });
    const state = buildAoiProactiveTrendAdvisorState({
      sessionPath: SESSION_PATH,
      policy: makePolicy(true),
      profile: makeProfile(),
      candidates: [
        makeCandidate({ dedupeKey: 'trend:reverse-engineering:loader' }),
        makeCandidate({
          id: 'aoi-brief-trend-weak-health',
          sources: [
            {
              title: 'Single reversing source',
              url: 'https://research.example.com/re/single-source',
              host: 'research.example.com',
              publishedAt: '2026-06-18T00:00:00.000Z',
              retrievedAt: NOW,
              snippet: 'Only one source.',
            },
          ],
          evidenceRefs: ['source:research.example.com'],
        }),
      ],
      existingSnapshots: first.snapshots,
      feedback: [makeFeedback('wrong_timing'), makeFeedback('wrong_topic')],
      fieldMetrics: makeFieldMetrics(),
      now: NOW + 60_000,
      persist: false,
    });
    const diagnostics = buildAoiProactiveTrendAdvisorDiagnostics({
      state,
      tavilyConfigured: true,
      now: NOW + 60_000,
    });
    const codes = diagnostics.map((item) => item.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        'trend_source_quality_weak',
        'trend_duplicate_suppressed',
        'trend_quiet_control_active',
        'trend_interest_drift_detected',
        'trend_provider_smoke_ready',
      ]),
    );
  });
});
