import { DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefFieldMetrics,
  AoiProactiveBriefFeedback,
  AoiProactiveTrendAdvisorState,
} from './aoiAutonomyTypes';
import { buildAoiProactiveTrendAdvisorState } from './aoiProactiveTrendAdvisor';
import {
  scoutAoiProactiveBriefTopic,
  type AoiProactiveBriefRawSearchResult,
  type AoiProactiveBriefSearchAdapter,
} from './aoiProactiveBriefResearch';

const DEFAULT_NOW = Date.parse('2026-06-19T00:00:00.000Z');
const DEFAULT_SESSION_PATH = 'aoi/default';

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export type AoiProactiveTrendReplayScenario =
  | 'fresh_trend'
  | 'stale_source'
  | 'weak_evidence'
  | 'wrong_topic'
  | 'too_frequent'
  | 'useful_opinion'
  | 'provider_smoke';

export interface AoiProactiveTrendReplayFixture {
  id: string;
  scenario: AoiProactiveTrendReplayScenario;
  title: string;
  now?: number;
  policy?: AoiAutonomyPolicy;
  profile: AoiInterestProfile;
  candidates: AoiProactiveBriefCandidate[];
  feedback?: AoiProactiveBriefFeedback[];
  fieldMetrics?: AoiProactiveBriefFieldMetrics | null;
  expected: {
    minOpinionCards: number;
    directChatAllowed: boolean;
    blockedReason?: string;
  };
}

export interface AoiProactiveTrendReplayMetric {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  evidenceRefs: string[];
}

export interface AoiProactiveTrendReplayReport {
  version: 1;
  fixtureId: string;
  scenario: AoiProactiveTrendReplayScenario;
  title: string;
  generatedAt: number;
  passed: boolean;
  summary: string;
  metrics: AoiProactiveTrendReplayMetric[];
  state: AoiProactiveTrendAdvisorState;
  evidenceRefs: string[];
}

function makePolicy(now: number, optIn: boolean): AoiAutonomyPolicy {
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
    updatedAt: now,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-re',
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
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
    createdAt: partial.createdAt ?? DEFAULT_NOW - 86_400_000,
    updatedAt: partial.updatedAt ?? DEFAULT_NOW - 60_000,
  };
}

function makeProfile(topic: AoiInterestTopic = makeTopic()): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: DEFAULT_SESSION_PATH,
    topics: [topic],
    generatedAt: DEFAULT_NOW,
    sourceMemoryCount: 1,
    warnings: [],
  };
}

function makeFieldMetrics(
  partial: Partial<AoiProactiveBriefFieldMetrics> = {},
): AoiProactiveBriefFieldMetrics {
  return {
    version: 1,
    sessionPath: DEFAULT_SESSION_PATH,
    generatedAt: DEFAULT_NOW,
    status: partial.status ?? 'field_events_recorded',
    eventCount: partial.eventCount ?? 3,
    consideredCount: partial.consideredCount ?? 3,
    shownCount: partial.shownCount ?? 2,
    shownByDeliveryMode: partial.shownByDeliveryMode ?? {
      dashboard: 2,
      digest: 0,
      inline_card: 0,
      chat_hook: 0,
    },
    expandedCount: partial.expandedCount ?? 1,
    sourceOpenedCount: partial.sourceOpenedCount ?? 1,
    feedbackRecordedCount: partial.feedbackRecordedCount ?? 1,
    usefulCount: partial.usefulCount ?? 1,
    tooFrequentCount: partial.tooFrequentCount ?? 0,
    wrongTopicCount: partial.wrongTopicCount ?? 0,
    wrongTimingCount: partial.wrongTimingCount ?? 0,
    staleCount: partial.staleCount ?? 0,
    staleCurrentClaimCount: partial.staleCurrentClaimCount ?? 0,
    unsafeCount: partial.unsafeCount ?? 0,
    suppressionCounts: partial.suppressionCounts ?? {},
    privateLeakCount: partial.privateLeakCount ?? 0,
    unauthorizedMutationCount: partial.unauthorizedMutationCount ?? 0,
    directChatHookCount: partial.directChatHookCount ?? 0,
    lastEventAt: partial.lastEventAt ?? DEFAULT_NOW,
    evidenceRefs: partial.evidenceRefs ?? ['proactive-brief-field:fixture'],
  };
}

function makeCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-trend-re',
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
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
        retrievedAt: DEFAULT_NOW,
        snippet: 'Public source snippet.',
      },
      {
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
        host: 'security.example.net',
        publishedAt: '2026-06-17T00:00:00.000Z',
        retrievedAt: DEFAULT_NOW,
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
      searchedAt: DEFAULT_NOW,
      newestSourceAt: '2026-06-18T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    dedupeKey: partial.dedupeKey,
    createdAt: partial.createdAt ?? DEFAULT_NOW,
    updatedAt: partial.updatedAt ?? DEFAULT_NOW,
    expiresAt: partial.expiresAt ?? DEFAULT_NOW + 14 * 24 * 60 * 60 * 1000,
  };
}

function makeFeedback(
  category: AoiProactiveBriefFeedback['category'],
  briefId = 'aoi-brief-trend-re',
): AoiProactiveBriefFeedback {
  return {
    version: 1,
    id: `aoi-trend-feedback-${category}`,
    briefId,
    topicId: 'aoi-interest-re',
    sessionPath: DEFAULT_SESSION_PATH,
    category,
    createdAt: DEFAULT_NOW,
  };
}

function metric(params: AoiProactiveTrendReplayMetric): AoiProactiveTrendReplayMetric {
  return params;
}

export function builtInAoiProactiveTrendReplayFixtures(): AoiProactiveTrendReplayFixture[] {
  const profile = makeProfile();
  const staleCandidate = makeCandidate({
    id: 'aoi-brief-trend-stale',
    freshness: {
      searchedAt: DEFAULT_NOW,
      newestSourceAt: '2026-01-01T00:00:00.000Z',
      cannotKnow: ['Source evidence is stale for the configured freshness window.'],
    },
  });
  const weakCandidate = makeCandidate({
    id: 'aoi-brief-trend-weak',
    sources: [
      {
        title: 'Single reversing source',
        url: 'https://research.example.com/re/single-source',
        host: 'research.example.com',
        publishedAt: '2026-06-18T00:00:00.000Z',
        retrievedAt: DEFAULT_NOW,
        snippet: 'Only one public source.',
      },
    ],
    evidenceRefs: ['source:research.example.com'],
  });
  const wrongTopicCandidate = makeCandidate({
    id: 'aoi-brief-trend-wrong-topic',
    topicId: 'aoi-interest-cooking',
    topicLabel: 'Cooking',
    title: 'New cooking channel update',
  });

  return [
    {
      id: 'trend-fresh-default-quiet',
      scenario: 'fresh_trend',
      title: 'Fresh trend stays quiet without direct chat opt-in',
      policy: makePolicy(DEFAULT_NOW, false),
      profile,
      candidates: [makeCandidate()],
      fieldMetrics: makeFieldMetrics(),
      expected: {
        minOpinionCards: 1,
        directChatAllowed: false,
        blockedReason: 'direct_chat_not_opted_in',
      },
    },
    {
      id: 'trend-stale-source',
      scenario: 'stale_source',
      title: 'Stale source evidence blocks direct chat',
      policy: makePolicy(DEFAULT_NOW, true),
      profile,
      candidates: [staleCandidate],
      fieldMetrics: makeFieldMetrics(),
      expected: {
        minOpinionCards: 1,
        directChatAllowed: false,
        blockedReason: 'stale_source',
      },
    },
    {
      id: 'trend-weak-evidence',
      scenario: 'weak_evidence',
      title: 'Weak evidence remains dashboard-only',
      policy: makePolicy(DEFAULT_NOW, true),
      profile,
      candidates: [weakCandidate],
      fieldMetrics: makeFieldMetrics(),
      expected: {
        minOpinionCards: 1,
        directChatAllowed: false,
        blockedReason: 'weak_source_evidence',
      },
    },
    {
      id: 'trend-wrong-topic',
      scenario: 'wrong_topic',
      title: 'Wrong topic blocks direct chat',
      policy: makePolicy(DEFAULT_NOW, true),
      profile,
      candidates: [wrongTopicCandidate],
      fieldMetrics: makeFieldMetrics(),
      expected: {
        minOpinionCards: 1,
        directChatAllowed: false,
        blockedReason: 'wrong_topic_or_missing_watch',
      },
    },
    {
      id: 'trend-too-frequent',
      scenario: 'too_frequent',
      title: 'Recent timing feedback blocks direct chat',
      policy: makePolicy(DEFAULT_NOW, true),
      profile,
      candidates: [makeCandidate()],
      feedback: [makeFeedback('too_frequent')],
      fieldMetrics: makeFieldMetrics(),
      expected: {
        minOpinionCards: 1,
        directChatAllowed: false,
        blockedReason: 'too_frequent_or_wrong_timing_feedback',
      },
    },
    {
      id: 'trend-useful-opinion',
      scenario: 'useful_opinion',
      title: 'Useful opinion can pass direct chat when opt-in and field gates pass',
      policy: makePolicy(DEFAULT_NOW, true),
      profile,
      candidates: [makeCandidate()],
      feedback: [makeFeedback('useful')],
      fieldMetrics: makeFieldMetrics(),
      expected: {
        minOpinionCards: 1,
        directChatAllowed: true,
      },
    },
  ];
}

export function runAoiProactiveTrendReplayFixture(
  fixture: AoiProactiveTrendReplayFixture,
): AoiProactiveTrendReplayReport {
  const now = fixture.now ?? DEFAULT_NOW;
  const state = buildAoiProactiveTrendAdvisorState({
    sessionPath: fixture.profile.sessionPath,
    policy: fixture.policy,
    profile: fixture.profile,
    candidates: fixture.candidates,
    feedback: fixture.feedback,
    fieldMetrics: fixture.fieldMetrics,
    now,
    persist: false,
  });
  const allowedCount = state.opinionCards.filter((card) => card.directChatAllowed).length;
  const blockedReasons = state.opinionCards.flatMap((card) => card.directChatBlockedReasons);
  const metrics = [
    metric({
      name: 'opinion_card_count',
      passed: state.opinionCards.length >= fixture.expected.minOpinionCards,
      expected: `>=${fixture.expected.minOpinionCards}`,
      actual: String(state.opinionCards.length),
      evidenceRefs: state.evidenceRefs.slice(0, 8),
    }),
    metric({
      name: 'direct_chat_gate',
      passed: fixture.expected.directChatAllowed ? allowedCount > 0 : allowedCount === 0,
      expected: fixture.expected.directChatAllowed ? 'allowed' : 'blocked',
      actual: allowedCount > 0 ? 'allowed' : 'blocked',
      evidenceRefs: state.readiness.evidenceRefs,
    }),
    metric({
      name: 'blocked_reason',
      passed: fixture.expected.blockedReason
        ? blockedReasons.includes(fixture.expected.blockedReason)
        : true,
      expected: fixture.expected.blockedReason ?? 'none',
      actual: blockedReasons.join(', ') || 'none',
      evidenceRefs: state.opinionCards.flatMap((card) => card.evidenceRefs.slice(0, 2)),
    }),
    metric({
      name: 'opinion_shape',
      passed: state.opinionCards.every(
        (card) =>
          card.whatChanged &&
          card.whyItMatters &&
          card.myTake &&
          card.suggestedNextAction &&
          card.confidenceLabel &&
          card.evidenceRefs.length > 0,
      ),
      expected: 'all opinion sections and evidence present',
      actual: `${state.opinionCards.length} card(s) checked`,
      evidenceRefs: state.opinionCards.flatMap((card) => card.evidenceRefs.slice(0, 2)),
    }),
  ];
  const passed = metrics.every((item) => item.passed);
  return {
    version: 1,
    fixtureId: fixture.id,
    scenario: fixture.scenario,
    title: fixture.title,
    generatedAt: now,
    passed,
    summary: passed
      ? `${fixture.id} passed.`
      : `${fixture.id} failed: ${metrics
          .filter((item) => !item.passed)
          .map((item) => item.name)
          .join(', ')}`,
    metrics,
    state,
    evidenceRefs: state.evidenceRefs,
  };
}

export function runBuiltInAoiProactiveTrendReplayFixtures(): AoiProactiveTrendReplayReport[] {
  return builtInAoiProactiveTrendReplayFixtures().map(runAoiProactiveTrendReplayFixture);
}

function providerSmokeResults(): AoiProactiveBriefRawSearchResult[] {
  return [
    {
      title: 'Reverse engineering loader analysis trend',
      url: 'https://research.example.com/re/loader-analysis-2026',
      content:
        'A current public writeup describes a loader analysis workflow with practical reversing details.',
      publishedAt: '2026-06-18T00:00:00.000Z',
    },
    {
      title: 'Malware reversing case study update',
      url: 'https://security.example.net/posts/reversing-case-study-2026',
      content:
        'A second independent source corroborates the same reverse engineering theme with case-study evidence.',
      publishedAt: '2026-06-17T00:00:00.000Z',
    },
    {
      title: 'Duplicate tracking parameter result',
      url: 'https://research.example.com/re/loader-analysis-2026?utm_source=feed',
      content: 'Duplicate source that should be normalized away by the provider path.',
      publishedAt: '2026-06-18T00:00:00.000Z',
    },
  ];
}

export async function runAoiProactiveTrendProviderSmokeReplay(): Promise<AoiProactiveTrendReplayReport> {
  const now = DEFAULT_NOW;
  const topic = makeTopic();
  const profile = makeProfile(topic);
  let searchCallCount = 0;
  let lastQuery = '';
  const search: AoiProactiveBriefSearchAdapter = async (request) => {
    searchCallCount += 1;
    lastQuery = request.query;
    return {
      query: request.query,
      retrievedAt: request.now,
      results: providerSmokeResults(),
    };
  };
  const scout = await scoutAoiProactiveBriefTopic({
    topic,
    search,
    now,
    minSources: 2,
    delivery: {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
  });
  const fixture: AoiProactiveTrendReplayFixture = {
    id: 'trend-provider-smoke',
    scenario: 'provider_smoke',
    title: 'Provider smoke creates a current-info trend candidate end-to-end',
    now,
    policy: makePolicy(now, true),
    profile,
    candidates: scout.candidate ? [scout.candidate] : [],
    fieldMetrics: makeFieldMetrics(),
    expected: {
      minOpinionCards: 1,
      directChatAllowed: true,
    },
  };
  const report = runAoiProactiveTrendReplayFixture(fixture);
  const sourceQualityStatuses = report.state.snapshots.map(
    (snapshot) => snapshot.sourceQuality.status,
  );
  const metrics = [
    ...report.metrics,
    metric({
      name: 'provider_search_called',
      passed: searchCallCount === 1 && lastQuery.includes('Reverse Engineering'),
      expected: 'one provider search for the watched topic',
      actual: `${searchCallCount} call(s): ${lastQuery || 'none'}`,
      evidenceRefs: [`trend-provider-smoke:query:${searchCallCount}`],
    }),
    metric({
      name: 'provider_candidate_created',
      passed: Boolean(scout.candidate) && scout.evidence.sources.length >= 2,
      expected: 'candidate from at least two provider-normalized public sources',
      actual: `${scout.evidence.sources.length} source(s), candidate ${scout.candidate ? 'created' : 'missing'}`,
      evidenceRefs: scout.evidence.sources.map((source) => `source:${source.host}`),
    }),
    metric({
      name: 'source_quality_gate',
      passed: sourceQualityStatuses.includes('strong'),
      expected: 'strong source quality',
      actual: sourceQualityStatuses.join(', ') || 'none',
      evidenceRefs: report.state.snapshots.flatMap((snapshot) =>
        snapshot.evidenceRefs.filter((ref) => ref.startsWith('trend-source-quality')).slice(0, 2),
      ),
    }),
    metric({
      name: 'no_fabricated_current_info',
      passed:
        Boolean(scout.candidate) &&
        (scout.candidate?.sources.length ?? 0) > 0 &&
        scout.candidate?.summary.includes('source-backed current-info candidate') === true,
      expected: 'candidate text is source-backed and not memory-only',
      actual: scout.candidate?.summary ?? scout.rejectedReason ?? 'missing candidate',
      evidenceRefs: scout.candidate?.evidenceRefs.slice(0, 6) ?? [],
    }),
  ];
  const passed = metrics.every((item) => item.passed);
  return {
    ...report,
    passed,
    summary: passed
      ? 'trend-provider-smoke passed.'
      : `trend-provider-smoke failed: ${metrics
          .filter((item) => !item.passed)
          .map((item) => item.name)
          .join(', ')}`,
    metrics,
    evidenceRefs: unique([
      ...report.evidenceRefs,
      `trend-provider-smoke:search-calls:${searchCallCount}`,
      ...scout.evidence.sources.map((source) => `source:${source.host}`),
    ]).slice(0, 32),
  };
}
