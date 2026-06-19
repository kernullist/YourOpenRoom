import { DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiOperatorHealthCapability,
  AoiOperatorHealthSeverity,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefCooldownEntry,
  AoiProactiveBriefCooldownState,
  AoiProactiveBriefFeedback,
} from './aoiAutonomyTypes';
import {
  AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
  planAoiProactiveBriefTopics,
  type AoiProactiveBriefSkippedTopic,
} from './aoiProactiveBriefPlanner';
import {
  decideAoiProactiveBriefDelivery,
  type AoiProactiveBriefDeliveryContext,
  type AoiProactiveBriefDeliveryDecision,
  type AoiProactiveBriefDeliverySuppressionReason,
} from './aoiProactiveBriefPolicy';
import {
  scoutAoiProactiveBriefTopic,
  type AoiProactiveBriefRawSearchResult,
  type AoiProactiveBriefSearchAdapter,
  type AoiProactiveBriefSourceFreshness,
} from './aoiProactiveBriefResearch';
import { buildAoiProactiveBriefPanelModel } from './aoiProactiveBriefUi';

const DEFAULT_NOW = Date.parse('2026-06-19T00:00:00.000Z');
const DEFAULT_SESSION_PATH = 'aoi/default';
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export type AoiProactiveBriefReplayScenario =
  | 'fresh_public_sources'
  | 'tavily_missing'
  | 'quiet_mode'
  | 'too_frequent_feedback'
  | 'stale_sources'
  | 'private_memory_excluded'
  | 'useful_feedback_with_cooldown';

export type AoiProactiveBriefReplayMetricName =
  | 'candidate_precision'
  | 'source_freshness'
  | 'interruption_policy'
  | 'feedback_adaptation'
  | 'privacy_redaction'
  | 'no_fabricated_current_info';

export type AoiProactiveBriefDiagnosticCode =
  | 'tavily_unavailable'
  | 'source_freshness_stale'
  | 'no_eligible_topics'
  | 'all_topics_muted'
  | 'cooldown_suppressed_all_candidates'
  | 'direct_chat_disabled_by_policy';

export interface AoiProactiveBriefReplayMetric {
  name: AoiProactiveBriefReplayMetricName;
  passed: boolean;
  expected: string;
  actual: string;
  evidenceRefs: string[];
}

export interface AoiProactiveBriefDiagnostic {
  version: 1;
  code: AoiProactiveBriefDiagnosticCode;
  severity: AoiOperatorHealthSeverity;
  capability: AoiOperatorHealthCapability;
  summary: string;
  cannotKnow: string;
  evidenceRefs: string[];
  observedAt: number;
}

export interface AoiProactiveBriefReplayCandidateSummary {
  id: string;
  topicId: string;
  topicLabel: string;
  title: string;
  sourceCount: number;
  sourceHosts: string[];
  freshnessCannotKnow: string[];
  selectedMode: AoiProactiveBriefDeliveryDecision['selectedMode'];
  deliveryScore: number;
  chatHookAllowed: boolean;
  chatHookReasons: AoiProactiveBriefDeliverySuppressionReason[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReplayReport {
  version: 1;
  fixtureId: string;
  title: string;
  scenario: AoiProactiveBriefReplayScenario;
  generatedAt: number;
  passed: boolean;
  summary: string;
  metrics: AoiProactiveBriefReplayMetric[];
  candidates: AoiProactiveBriefReplayCandidateSummary[];
  candidateCount: number;
  visibleCardCount: number;
  warningLabels: string[];
  diagnosticLabels: AoiProactiveBriefDiagnosticCode[];
  diagnostics: AoiProactiveBriefDiagnostic[];
  evidenceRefs: string[];
}

export interface AoiProactiveBriefReplayFixture {
  id: string;
  title: string;
  scenario: AoiProactiveBriefReplayScenario;
  now?: number;
  profile: AoiInterestProfile;
  policy?: AoiAutonomyPolicy;
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState;
  context?: AoiProactiveBriefDeliveryContext;
  searchResults?: AoiProactiveBriefRawSearchResult[];
  searchWarning?: string;
  skipSearch?: boolean;
  sourceStaleAfterMs?: number;
  directCandidates?: AoiProactiveBriefCandidate[];
  expectedPrivateTextAbsent?: string[];
}

export interface BuildAoiProactiveBriefDiagnosticsInput {
  profile?: AoiInterestProfile | null;
  candidates?: AoiProactiveBriefCandidate[];
  decisions?: AoiProactiveBriefDeliveryDecision[];
  feedback?: AoiProactiveBriefFeedback[];
  cooldownState?: AoiProactiveBriefCooldownState | null;
  scoutWarnings?: string[];
  skippedTopics?: AoiProactiveBriefSkippedTopic[];
  sourceFreshness?: AoiProactiveBriefSourceFreshness[];
  now?: number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function makePolicy(now: number, partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    confidenceFloor: 0.5,
    defaultCooldownMs: 6 * 60 * 60 * 1000,
    updatedAt: now,
    ...partial,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-reverse-engineering',
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'reversing', 'malware reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.88,
    importance: partial.importance ?? 0.86,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.94,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? DEFAULT_NOW - 60_000,
    updatedAt: partial.updatedAt ?? DEFAULT_NOW - 30_000,
  };
}

function makeProfile(
  now: number,
  topics: AoiInterestTopic[] = [makeTopic({ createdAt: now - 60_000, updatedAt: now - 30_000 })],
  partial: Partial<AoiInterestProfile> = {},
): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
    topics,
    generatedAt: partial.generatedAt ?? now,
    sourceMemoryCount: partial.sourceMemoryCount ?? topics.length,
    warnings: partial.warnings ?? [],
  };
}

function makeCooldownState(
  now: number,
  entries: AoiProactiveBriefCooldownEntry[] = [],
): AoiProactiveBriefCooldownState {
  return {
    version: 1,
    sessionPath: DEFAULT_SESSION_PATH,
    updatedAt: now,
    cooldowns: Object.fromEntries(entries.map((entry) => [entry.cooldownKey, entry])),
  };
}

function makeCooldownEntry(params: {
  cooldownKey: string;
  topicId?: string;
  nextAllowedAt: number;
  reason: string;
  sourceBriefIds?: string[];
  now: number;
}): AoiProactiveBriefCooldownEntry {
  return {
    version: 1,
    cooldownKey: params.cooldownKey,
    ...(params.topicId ? { topicId: params.topicId } : {}),
    nextAllowedAt: params.nextAllowedAt,
    reason: params.reason,
    sourceBriefIds: params.sourceBriefIds ?? [],
    updatedAt: params.now,
  };
}

function makeFeedback(params: {
  id: string;
  briefId: string;
  topicId: string;
  category: AoiProactiveBriefFeedback['category'];
  now: number;
}): AoiProactiveBriefFeedback {
  return {
    version: 1,
    id: params.id,
    briefId: params.briefId,
    topicId: params.topicId,
    sessionPath: DEFAULT_SESSION_PATH,
    category: params.category,
    createdAt: params.now,
  };
}

function makeDirectCandidate(
  now: number,
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-replay-direct',
    sessionPath: partial.sessionPath ?? DEFAULT_SESSION_PATH,
    topicId: partial.topicId ?? 'aoi-interest-reverse-engineering',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Source-backed scout for Reverse Engineering',
    hook:
      partial.hook ??
      'I found public sources that may be worth a quick look for Reverse Engineering.',
    summary:
      partial.summary ??
      'A source-backed candidate is ready for quiet review with public source evidence.',
    whyForOperator: partial.whyForOperator ?? 'This matches saved reverse engineering interests.',
    noveltyReason: partial.noveltyReason ?? 'Multiple public hosts surfaced the item.',
    sources: partial.sources ?? [
      {
        title: 'Reverse engineering writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        publishedAt: '2026-06-18T00:00:00.000Z',
        retrievedAt: now,
        snippet: 'Public source snippet for the reversing writeup.',
      },
      {
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
        host: 'security.example.net',
        publishedAt: '2026-06-17T00:00:00.000Z',
        retrievedAt: now,
        snippet: 'A second public source.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? [
      'source:research.example.com:fixture',
      'source:security.example.net:fixture',
    ],
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    score: partial.score ?? 0.86,
    confidence: partial.confidence ?? 0.88,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: now,
      newestSourceAt: '2026-06-18T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    ...(partial.dedupeKey ? { dedupeKey: partial.dedupeKey } : {}),
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    expiresAt: partial.expiresAt ?? now + 14 * 24 * 60 * 60 * 1000,
  };
}

function freshResults(): AoiProactiveBriefRawSearchResult[] {
  return [
    {
      title: 'Reverse engineering new loader technique',
      url: 'https://research.example.com/re/loader-technique',
      content: 'A public writeup about reverse engineering a loader technique.',
      publishedAt: '2026-06-18T00:00:00.000Z',
    },
    {
      title: 'Malware reversing case study',
      url: 'https://security.example.net/posts/re-case-study',
      content: 'A second public source with a reversing case study.',
      publishedAt: '2026-06-17T00:00:00.000Z',
    },
  ];
}

function staleResults(): AoiProactiveBriefRawSearchResult[] {
  return [
    {
      title: 'Older reverse engineering survey',
      url: 'https://archive.example.com/re/older-survey',
      content: 'An older source about reverse engineering.',
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      title: 'Older reversing notes',
      url: 'https://old.example.net/re/notes',
      content: 'A second older public source.',
      publishedAt: '2026-01-02T00:00:00.000Z',
    },
  ];
}

function fixtureSearchAdapter(
  fixture: AoiProactiveBriefReplayFixture,
  now: number,
): AoiProactiveBriefSearchAdapter {
  return async (request) => ({
    query: request.query,
    retrievedAt: now,
    results: fixture.searchResults ?? [],
    ...(fixture.searchWarning ? { warning: fixture.searchWarning } : {}),
  });
}

function hasReason(
  decisions: AoiProactiveBriefDeliveryDecision[],
  reason: AoiProactiveBriefDeliverySuppressionReason,
): boolean {
  return decisions.some(
    (decision) =>
      decision.suppressionReasons.includes(reason) ||
      Object.values(decision.modeReasons).some((reasons) => reasons.includes(reason)) ||
      decision.chatHook.reasons.includes(reason),
  );
}

function metric(params: AoiProactiveBriefReplayMetric): AoiProactiveBriefReplayMetric {
  return params;
}

function isFreshSource(
  candidate: AoiProactiveBriefCandidate,
  now: number,
  staleAfterMs: number,
): boolean {
  const newest = candidate.freshness.newestSourceAt
    ? Date.parse(candidate.freshness.newestSourceAt)
    : 0;
  if (!Number.isFinite(newest) || newest <= 0) {
    return false;
  }
  return now - newest <= staleAfterMs;
}

function sourceFreshnessIsStale(freshness: AoiProactiveBriefSourceFreshness): boolean {
  return freshness.cannotKnow.some((item) => /stale|outside the freshness window/i.test(item));
}

function buildCandidateSummaries(params: {
  candidates: AoiProactiveBriefCandidate[];
  decisions: AoiProactiveBriefDeliveryDecision[];
}): AoiProactiveBriefReplayCandidateSummary[] {
  return params.candidates.map((candidate) => {
    const decision = params.decisions.find((item) => item.candidateId === candidate.id);
    return {
      id: candidate.id,
      topicId: candidate.topicId,
      topicLabel: candidate.topicLabel,
      title: candidate.title,
      sourceCount: candidate.sources.length,
      sourceHosts: unique(candidate.sources.map((source) => source.host)).slice(0, 6),
      freshnessCannotKnow: candidate.freshness.cannotKnow.slice(0, 6),
      selectedMode: decision?.selectedMode ?? null,
      deliveryScore: decision?.deliveryScore ?? 0,
      chatHookAllowed: decision?.chatHook.allowed === true,
      chatHookReasons: decision?.chatHook.reasons ?? [],
      evidenceRefs: candidate.evidenceRefs.slice(0, 12),
    };
  });
}

function diagnostic(params: {
  code: AoiProactiveBriefDiagnosticCode;
  severity: AoiOperatorHealthSeverity;
  capability: AoiOperatorHealthCapability;
  summary: string;
  cannotKnow: string;
  evidenceRefs: string[];
  observedAt: number;
}): AoiProactiveBriefDiagnostic {
  return {
    version: 1,
    code: params.code,
    severity: params.severity,
    capability: params.capability,
    summary: params.summary,
    cannotKnow: params.cannotKnow,
    evidenceRefs: unique(params.evidenceRefs).slice(0, 12),
    observedAt: params.observedAt,
  };
}

export function buildAoiProactiveBriefDiagnostics(
  input: BuildAoiProactiveBriefDiagnosticsInput,
): AoiProactiveBriefDiagnostic[] {
  const now = input.now ?? Date.now();
  const profile = input.profile ?? null;
  const candidates = input.candidates ?? [];
  const skippedTopics = input.skippedTopics ?? [];
  const warnings = input.scoutWarnings ?? [];
  const decisions =
    input.decisions ??
    candidates.map((candidate) =>
      decideAoiProactiveBriefDelivery({
        candidate,
        profile,
        feedback: input.feedback ?? [],
        cooldownState: input.cooldownState ?? null,
        context: {
          now,
        },
      }),
    );
  const diagnostics: AoiProactiveBriefDiagnostic[] = [];
  const warningText = warnings.join(' ');

  if (
    /tavily_not_configured|tavily_missing/i.test(warningText) ||
    skippedTopics.some((topic) => topic.reason === 'tavily_not_configured')
  ) {
    diagnostics.push(
      diagnostic({
        code: 'tavily_unavailable',
        severity: 'warning',
        capability: 'research',
        summary:
          'Proactive interest scouting could not refresh public current-info evidence because Tavily is unavailable.',
        cannotKnow:
          'Aoi cannot know whether there is fresh public web evidence for this interest without a configured current-info source.',
        evidenceRefs: [
          'proactive-brief:tavily',
          ...skippedTopics.map((topic) => `skip:${topic.reason}`),
        ],
        observedAt: now,
      }),
    );
  }

  if (
    (input.sourceFreshness ?? []).some(sourceFreshnessIsStale) ||
    candidates.some((candidate) =>
      candidate.freshness.cannotKnow.some((item) => /stale|freshness window/i.test(item)),
    ) ||
    hasReason(decisions, 'stale_source')
  ) {
    diagnostics.push(
      diagnostic({
        code: 'source_freshness_stale',
        severity: 'warning',
        capability: 'research',
        summary:
          'At least one proactive interest brief has stale source evidence and cannot be treated as fresh.',
        cannotKnow:
          'Aoi cannot make a fresh or latest claim until the public source evidence is refreshed.',
        evidenceRefs: [
          'proactive-brief:source-freshness',
          ...candidates.flatMap((candidate) => candidate.evidenceRefs.slice(0, 4)),
        ],
        observedAt: now,
      }),
    );
  }

  if (
    profile &&
    profile.topics.length === 0 &&
    (profile.sourceMemoryCount > 0 ||
      skippedTopics.some((topic) => topic.reason === 'profile_empty'))
  ) {
    diagnostics.push(
      diagnostic({
        code: 'no_eligible_topics',
        severity: 'info',
        capability: 'memory',
        summary: 'Aoi did not find eligible non-sensitive interest topics for proactive briefing.',
        cannotKnow:
          'Aoi cannot infer a safe proactive topic from private, expired, demoted, or low-confidence memory evidence.',
        evidenceRefs: ['proactive-brief:interest-profile'],
        observedAt: profile.generatedAt || now,
      }),
    );
  }

  if (profile && profile.topics.length > 0 && profile.topics.every((topic) => topic.muted)) {
    diagnostics.push(
      diagnostic({
        code: 'all_topics_muted',
        severity: 'info',
        capability: 'memory',
        summary: 'All proactive interest topics are muted by operator feedback.',
        cannotKnow:
          'Aoi cannot know which proactive topics should be offered until at least one topic is unmuted or added.',
        evidenceRefs: profile.topics.flatMap((topic) => topic.evidenceRefs.slice(0, 2)),
        observedAt: Math.max(...profile.topics.map((topic) => topic.updatedAt), now),
      }),
    );
  }

  const cooldownReasons: AoiProactiveBriefDeliverySuppressionReason[] = [
    'topic_cooldown_active',
    'global_cooldown_active',
  ];
  const allCandidatesCooldownSuppressed =
    candidates.length > 0 &&
    decisions.length === candidates.length &&
    decisions.every((decision) =>
      cooldownReasons.some(
        (reason) =>
          decision.suppressionReasons.includes(reason) ||
          decision.modeReasons.digest.includes(reason) ||
          decision.modeReasons.inline_card.includes(reason) ||
          decision.chatHook.reasons.includes(reason),
      ),
    );
  const allSkippedForCooldown =
    skippedTopics.length > 0 &&
    skippedTopics.every(
      (topic) =>
        topic.reason === 'topic_cooldown_active' || topic.reason === 'global_cooldown_active',
    );
  if (allCandidatesCooldownSuppressed || allSkippedForCooldown) {
    diagnostics.push(
      diagnostic({
        code: 'cooldown_suppressed_all_candidates',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Proactive interest candidates are currently suppressed by cooldown policy.',
        cannotKnow:
          'Aoi cannot know whether another interruption would be welcome until the cooldown expires or the operator changes feedback.',
        evidenceRefs: [
          'proactive-brief:cooldown',
          ...Object.keys(input.cooldownState?.cooldowns ?? {}).map((key) => `cooldown:${key}`),
        ],
        observedAt: now,
      }),
    );
  }

  const directChatPolicyReasons: AoiProactiveBriefDeliverySuppressionReason[] = [
    'chat_hook_not_opted_in',
    'quiet_mode_suppresses_chat_hook',
    'chat_hook_mode_not_allowed',
  ];
  if (
    candidates.length > 0 &&
    decisions.length === candidates.length &&
    decisions.every(
      (decision) =>
        !decision.chatHook.allowed &&
        directChatPolicyReasons.some((reason) => decision.chatHook.reasons.includes(reason)),
    )
  ) {
    diagnostics.push(
      diagnostic({
        code: 'direct_chat_disabled_by_policy',
        severity: 'info',
        capability: 'replay_evaluation',
        summary: 'Direct proactive chat hooks are disabled by policy or quiet-mode gating.',
        cannotKnow:
          'Aoi cannot assume an unsolicited chat interruption is welcome without explicit opt-in and a passing delivery decision.',
        evidenceRefs: [
          'proactive-brief:interruption-policy',
          ...candidates.map((candidate) => `brief:${candidate.id}`),
        ],
        observedAt: now,
      }),
    );
  }

  return diagnostics;
}

function buildReplayMetrics(params: {
  fixture: AoiProactiveBriefReplayFixture;
  now: number;
  candidates: AoiProactiveBriefCandidate[];
  decisions: AoiProactiveBriefDeliveryDecision[];
  diagnostics: AoiProactiveBriefDiagnostic[];
  sourceFreshness: AoiProactiveBriefSourceFreshness[];
  warningLabels: string[];
  reportDraft: unknown;
}): AoiProactiveBriefReplayMetric[] {
  const { fixture, now, candidates, decisions, diagnostics, sourceFreshness } = params;
  const scenario = fixture.scenario;
  const candidatePrecisionPassed =
    scenario === 'tavily_missing' || scenario === 'private_memory_excluded'
      ? candidates.length === 0
      : candidates.length > 0 &&
        candidates.every(
          (candidate) =>
            candidate.sources.length > 0 &&
            candidate.evidenceRefs.some((ref) => ref.startsWith('source:')),
        );
  const staleExpected = scenario === 'stale_sources';
  const sourceFreshnessPassed = staleExpected
    ? diagnostics.some((item) => item.code === 'source_freshness_stale') &&
      candidates.every((candidate) =>
        candidate.freshness.cannotKnow.some((item) => /stale|freshness window/i.test(item)),
      )
    : candidates.every((candidate) =>
        isFreshSource(candidate, now, fixture.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS),
      ) || candidates.length === 0;
  const chatSuppressed = decisions.every((decision) => decision.chatHook.allowed === false);
  const interruptionPassed =
    scenario === 'quiet_mode'
      ? hasReason(decisions, 'quiet_mode_suppresses_chat_hook') && chatSuppressed
      : scenario === 'too_frequent_feedback' || scenario === 'useful_feedback_with_cooldown'
        ? diagnostics.some((item) => item.code === 'cooldown_suppressed_all_candidates') &&
          chatSuppressed
        : scenario === 'fresh_public_sources'
          ? chatSuppressed
          : true;
  const feedbackPassed =
    scenario === 'useful_feedback_with_cooldown'
      ? (() => {
          const withFeedback = decisions[0]?.deliveryScore ?? 0;
          const withoutFeedback = candidates[0]
            ? decideAoiProactiveBriefDelivery({
                candidate: candidates[0],
                policy: fixture.policy,
                profile: fixture.profile,
                feedback: [],
                cooldownState: fixture.cooldownState,
                context: fixture.context,
              }).deliveryScore
            : 0;
          return withFeedback > withoutFeedback && hasReason(decisions, 'topic_cooldown_active');
        })()
      : scenario === 'too_frequent_feedback'
        ? hasReason(decisions, 'recent_negative_feedback') ||
          hasReason(decisions, 'topic_cooldown_active')
        : true;
  const serializedDraft = JSON.stringify(params.reportDraft);
  const privacyPassed = (fixture.expectedPrivateTextAbsent ?? []).every(
    (text) => !serializedDraft.includes(text),
  );
  const fabricatedCurrentInfoPassed =
    candidates.length > 0
      ? candidates.every((candidate) => candidate.sources.length > 0)
      : !/latest/i.test(serializedDraft) &&
        !params.warningLabels.some((warning) => /fabricated/i.test(warning));

  return [
    metric({
      name: 'candidate_precision',
      passed: candidatePrecisionPassed,
      expected: 'Candidates exist only when source evidence is sufficient.',
      actual: `${candidates.length} candidate(s), ${sourceFreshness.length} source freshness record(s).`,
      evidenceRefs: candidates.flatMap((candidate) => candidate.evidenceRefs.slice(0, 3)),
    }),
    metric({
      name: 'source_freshness',
      passed: sourceFreshnessPassed,
      expected: staleExpected
        ? 'Stale evidence is reported as stale.'
        : 'Fresh scenarios use dated source evidence or create no current-info candidate.',
      actual: diagnostics.map((item) => item.code).join(', ') || 'no freshness diagnostic',
      evidenceRefs: ['proactive-brief:source-freshness'],
    }),
    metric({
      name: 'interruption_policy',
      passed: interruptionPassed,
      expected: 'Quiet mode, cooldown, and missing opt-in prevent unsolicited direct chat.',
      actual:
        decisions
          .map(
            (decision) =>
              `${decision.candidateId}:${decision.chatHook.allowed ? 'chat' : 'no-chat'}`,
          )
          .join(', ') || 'no delivery decision',
      evidenceRefs: ['proactive-brief:interruption-policy'],
    }),
    metric({
      name: 'feedback_adaptation',
      passed: feedbackPassed,
      expected:
        'Feedback changes relevance while cooldown and negative-feedback gates remain active.',
      actual:
        fixture.feedback?.map((item) => `${item.category}:${item.topicId}`).join(', ') ||
        'no feedback in fixture',
      evidenceRefs: fixture.feedback?.map((item) => `feedback:${item.id}`) ?? [],
    }),
    metric({
      name: 'privacy_redaction',
      passed: privacyPassed,
      expected: 'Private-sensitive fixture text never appears in replay output.',
      actual: privacyPassed ? 'private samples absent' : 'private sample leaked',
      evidenceRefs: ['proactive-brief:privacy'],
    }),
    metric({
      name: 'no_fabricated_current_info',
      passed: fabricatedCurrentInfoPassed,
      expected: 'Memory-only or missing-source scenarios cannot create fresh current-info claims.',
      actual:
        candidates.length > 0
          ? 'all candidate claims are source-backed'
          : 'no source-backed candidate created',
      evidenceRefs: candidates.flatMap((candidate) => candidate.evidenceRefs.slice(0, 3)),
    }),
  ];
}

export async function runAoiProactiveBriefReplayFixture(
  fixture: AoiProactiveBriefReplayFixture,
): Promise<AoiProactiveBriefReplayReport> {
  const now = fixture.now ?? DEFAULT_NOW;
  const policy = fixture.policy ?? makePolicy(now);
  const feedback = fixture.feedback ?? [];
  const cooldownState = fixture.cooldownState ?? makeCooldownState(now);
  const warningLabels: string[] = [];
  const skippedTopics: AoiProactiveBriefSkippedTopic[] = [];
  const sourceFreshness: AoiProactiveBriefSourceFreshness[] = [];
  const candidates: AoiProactiveBriefCandidate[] = [...(fixture.directCandidates ?? [])];

  if (!fixture.skipSearch && fixture.searchResults) {
    const plan = planAoiProactiveBriefTopics({
      profile: fixture.profile,
      cooldownState,
      feedback,
      now,
      budget: {
        allowNetwork: true,
        quietMode: fixture.context?.quietMode === true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
    });
    warningLabels.push(...plan.warnings);
    skippedTopics.push(...plan.skippedTopics);
    for (const planned of plan.topics) {
      const result = await scoutAoiProactiveBriefTopic({
        topic: planned.topic,
        search: fixtureSearchAdapter(fixture, now),
        now,
        minSources: 2,
        maxResults: 5,
        sourceStaleAfterMs: fixture.sourceStaleAfterMs,
        delivery: planned.delivery,
      });
      warningLabels.push(...result.warnings);
      sourceFreshness.push(result.evidence.freshness);
      if (result.candidate) {
        candidates.push(result.candidate);
      } else if (result.rejectedReason === 'low_evidence') {
        skippedTopics.push({
          topicId: planned.topic.id,
          topicLabel: planned.topic.label,
          reason: 'low_evidence',
          detail: 'Replay fixture search did not return enough public source evidence.',
        });
      }
    }
  } else if (fixture.scenario === 'tavily_missing') {
    const plan = planAoiProactiveBriefTopics({
      profile: fixture.profile,
      cooldownState,
      feedback,
      now,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
    });
    warningLabels.push(...plan.warnings, 'tavily_not_configured:cannot_refresh_current_info');
    skippedTopics.push(
      ...plan.skippedTopics,
      ...plan.topics.map((planned) => ({
        topicId: planned.topic.id,
        topicLabel: planned.topic.label,
        reason: 'tavily_not_configured' as const,
        detail: 'Tavily is not configured, so replay created no current-info candidate.',
      })),
    );
  } else if (fixture.profile.topics.length === 0) {
    skippedTopics.push({
      reason: 'profile_empty',
      detail: 'No eligible interest topics are available for replay.',
    });
  }

  const decisions = candidates.map((candidate) =>
    decideAoiProactiveBriefDelivery({
      candidate,
      policy,
      profile: fixture.profile,
      feedback,
      cooldownState,
      context: {
        now,
        sourceStaleAfterMs: fixture.sourceStaleAfterMs,
        ...fixture.context,
      },
    }),
  );
  const panel = buildAoiProactiveBriefPanelModel({
    candidates,
    policy,
    profile: fixture.profile,
    feedback,
    cooldownState,
    context: {
      now,
      sourceStaleAfterMs: fixture.sourceStaleAfterMs,
      ...fixture.context,
    },
  });
  const diagnostics = buildAoiProactiveBriefDiagnostics({
    profile: fixture.profile,
    candidates,
    decisions,
    feedback,
    cooldownState,
    scoutWarnings: warningLabels,
    skippedTopics,
    sourceFreshness,
    now,
  });
  const candidateSummaries = buildCandidateSummaries({
    candidates,
    decisions,
  });
  const reportDraft = {
    fixtureId: fixture.id,
    candidateSummaries,
    warningLabels,
    diagnosticLabels: diagnostics.map((item) => item.code),
  };
  const metrics = buildReplayMetrics({
    fixture,
    now,
    candidates,
    decisions,
    diagnostics,
    sourceFreshness,
    warningLabels,
    reportDraft,
  });
  const passed = metrics.every((item) => item.passed);
  const summary = passed
    ? `${fixture.title}: replay passed with ${candidates.length} source-backed candidate(s) and ${diagnostics.length} diagnostic note(s).`
    : `${fixture.title}: replay failed ${metrics.filter((item) => !item.passed).length} metric(s).`;

  return {
    version: 1,
    fixtureId: fixture.id,
    title: fixture.title,
    scenario: fixture.scenario,
    generatedAt: now,
    passed,
    summary,
    metrics,
    candidates: candidateSummaries,
    candidateCount: candidates.length,
    visibleCardCount: panel.cards.length,
    warningLabels: unique(warningLabels),
    diagnosticLabels: diagnostics.map((item) => item.code),
    diagnostics,
    evidenceRefs: unique([
      `replay:${fixture.id}`,
      ...candidateSummaries.flatMap((candidate) => candidate.evidenceRefs),
      ...diagnostics.flatMap((item) => item.evidenceRefs),
    ]).slice(0, 24),
  };
}

export function getBuiltInAoiProactiveBriefReplayFixtures(): AoiProactiveBriefReplayFixture[] {
  const now = DEFAULT_NOW;
  const topic = makeTopic({
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
  });
  const profile = makeProfile(now, [topic]);
  const usefulCandidate = makeDirectCandidate(now, {
    id: 'aoi-brief-useful-feedback-cooldown',
  });
  const tooFrequentCandidate = makeDirectCandidate(now, {
    id: 'aoi-brief-too-frequent',
  });

  return [
    {
      id: 'aoi-proactive-brief-fresh-re',
      title: 'RE interest with fresh public sources',
      scenario: 'fresh_public_sources',
      now,
      profile,
      policy: makePolicy(now),
      searchResults: freshResults(),
      context: {
        now,
        directChatOptIn: false,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-tavily-missing',
      title: 'Tavily missing produces cannot-refresh diagnostic',
      scenario: 'tavily_missing',
      now,
      profile,
      policy: makePolicy(now),
      skipSearch: true,
      context: {
        now,
      },
    },
    {
      id: 'aoi-proactive-brief-quiet-mode',
      title: 'Quiet mode keeps the card but suppresses direct chat',
      scenario: 'quiet_mode',
      now,
      profile,
      policy: makePolicy(now),
      searchResults: freshResults(),
      context: {
        now,
        quietMode: true,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-too-frequent-feedback',
      title: 'Too frequent feedback keeps cooldown active',
      scenario: 'too_frequent_feedback',
      now,
      profile,
      policy: makePolicy(now),
      skipSearch: true,
      directCandidates: [tooFrequentCandidate],
      feedback: [
        makeFeedback({
          id: 'aoi-feedback-too-frequent',
          briefId: tooFrequentCandidate.id,
          topicId: topic.id,
          category: 'too_frequent',
          now: now - 60_000,
        }),
      ],
      cooldownState: makeCooldownState(now, [
        makeCooldownEntry({
          cooldownKey: topic.cooldownKey,
          topicId: topic.id,
          nextAllowedAt: now + 24 * 60 * 60 * 1000,
          reason: 'feedback:too_frequent',
          sourceBriefIds: [tooFrequentCandidate.id],
          now,
        }),
      ]),
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-stale-sources',
      title: 'Stale sources are labeled and cannot use direct chat',
      scenario: 'stale_sources',
      now,
      profile,
      policy: makePolicy(now),
      searchResults: staleResults(),
      sourceStaleAfterMs: DEFAULT_SOURCE_STALE_AFTER_MS,
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
    {
      id: 'aoi-proactive-brief-private-memory-excluded',
      title: 'Private-sensitive memory produces no eligible topic',
      scenario: 'private_memory_excluded',
      now,
      profile: makeProfile(now, [], {
        sourceMemoryCount: 1,
        warnings: ['private_sensitive_memory_excluded'],
      }),
      policy: makePolicy(now),
      skipSearch: true,
      expectedPrivateTextAbsent: ['private-roadmap@example.com', 'api_key=secret-value'],
      context: {
        now,
      },
    },
    {
      id: 'aoi-proactive-brief-useful-feedback-cooldown',
      title: 'Useful feedback boosts relevance but respects cooldown',
      scenario: 'useful_feedback_with_cooldown',
      now,
      profile,
      policy: makePolicy(now),
      skipSearch: true,
      directCandidates: [usefulCandidate],
      feedback: [
        makeFeedback({
          id: 'aoi-feedback-useful',
          briefId: usefulCandidate.id,
          topicId: topic.id,
          category: 'useful',
          now: now - 60_000,
        }),
      ],
      cooldownState: makeCooldownState(now, [
        makeCooldownEntry({
          cooldownKey: topic.cooldownKey,
          topicId: topic.id,
          nextAllowedAt: now + 60 * 60 * 1000,
          reason: 'candidate_created',
          sourceBriefIds: [usefulCandidate.id],
          now,
        }),
        makeCooldownEntry({
          cooldownKey: AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
          nextAllowedAt: now + 30 * 60 * 1000,
          reason: 'candidate_created',
          sourceBriefIds: [usefulCandidate.id],
          now,
        }),
      ]),
      context: {
        now,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    },
  ];
}

export async function runBuiltInAoiProactiveBriefReplayFixtures(): Promise<
  AoiProactiveBriefReplayReport[]
> {
  const reports: AoiProactiveBriefReplayReport[] = [];
  for (const fixture of getBuiltInAoiProactiveBriefReplayFixtures()) {
    reports.push(await runAoiProactiveBriefReplayFixture(fixture));
  }
  return reports;
}

export function formatAoiProactiveBriefReplayReport(
  reports: AoiProactiveBriefReplayReport[],
): string {
  const passed = reports.filter((report) => report.passed).length;
  const failed = reports.length - passed;
  const lines = [
    `Aoi proactive brief replay: ${passed}/${reports.length} passed, ${failed} failed.`,
    ...reports.map((report) => {
      const metricLabel = report.metrics
        .map((metricItem) => `${metricItem.name}:${metricItem.passed ? 'pass' : 'fail'}`)
        .join(', ');
      return `- ${report.fixtureId}: ${report.passed ? 'pass' : 'fail'} (${metricLabel})`;
    }),
  ];
  return lines.join('\n');
}

export const AOI_PROACTIVE_BRIEF_REPLAY_PRIVATE_TEXT_SAMPLES = [
  'private-roadmap@example.com',
  'api_key=secret-value',
] as const;
