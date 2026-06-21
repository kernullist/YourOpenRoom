import { applyAoiProactiveBriefingTopicControls } from './aoiAutonomyPolicy';
import { loadAoiAutonomyPolicy, normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
} from './aoiAutonomyTypes';
import {
  appendAoiFieldEvents,
  type AoiFieldEvent,
  type AoiFieldEventInput,
} from './aoiFieldEventLedger';
import type { AoiFeedbackCompressionResult } from './aoiFeedbackCompression';
import {
  buildAoiJarvisReadinessScorecard,
  type AoiJarvisReadinessScorecard,
} from './aoiJarvisReadinessScorecard';
import {
  planAoiProactiveBriefTopics,
  type AoiProactiveBriefPlannerBudget,
  type AoiProactiveBriefPlannedTopic,
  type AoiProactiveBriefSkippedTopic,
} from './aoiProactiveBriefPlanner';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFeedback,
} from './aoiProactiveBriefStore';
import type { AoiProactiveBriefSourceFreshness } from './aoiProactiveBriefResearch';
import {
  runAoiProactiveBriefScout,
  type AoiProactiveBriefScoutBudget,
  type AoiProactiveBriefScoutDependencies,
  type AoiProactiveBriefScoutSourceHonestyRecord,
} from './aoiProactiveBriefScout';

const DEFAULT_PROACTIVE_RESEARCH_NOW = 1_800_000_000_000;
const MAX_REFS = 24;

export type AoiProactiveResearchRoutineProviderGate = 'pass' | 'missing' | 'unknown';

export interface AoiProactiveResearchRoutineSelectedTopic {
  version: 1;
  topicId: string;
  topicLabel: string;
  score: number;
  reasons: string[];
  feedbackAdjusted: boolean;
  evidenceRefs: string[];
}

export interface AoiProactiveResearchRoutineSkippedTopic {
  version: 1;
  topicId?: string;
  topicLabel?: string;
  reason: AoiProactiveBriefSkippedTopic['reason'];
  detail: string;
  cannotKnow: string[];
  sourceHonestyEvidenceRefs: string[];
}

export interface AoiProactiveResearchRoutineGateSummary {
  version: 1;
  provider: AoiProactiveResearchRoutineProviderGate;
  networkBudgetAllowed: boolean;
  scoutBudgetAvailable: boolean;
  readinessAllowsDashboard: boolean;
  readinessGateStatus: string;
  directChatEligible: boolean;
  directChatBlockedReasons: string[];
  scoutExecuted: boolean;
  evidenceRefs: string[];
}

export interface AoiProactiveResearchRoutineResult {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  selectedTopics: AoiProactiveResearchRoutineSelectedTopic[];
  skippedTopics: AoiProactiveResearchRoutineSkippedTopic[];
  createdCandidates: AoiProactiveBriefCandidate[];
  currentClaimAllowed: boolean;
  currentClaimBlockedReasons: string[];
  directChatEligibility: {
    version: 1;
    eligible: boolean;
    blockedReasons: string[];
    evidenceRefs: string[];
  };
  sourceHonestyRecords: AoiProactiveBriefScoutSourceHonestyRecord[];
  fieldEvents: AoiFieldEvent[];
  freshnessRecords: AoiProactiveBriefSourceFreshness[];
  cannotKnow: string[];
  staleCurrentClaimCount: number;
  gateSummary: AoiProactiveResearchRoutineGateSummary;
  warnings: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface RunAoiProactiveResearchRoutineInput {
  sessionsDir: string;
  sessionPath: string;
  configFile?: string;
  now?: number;
  topicId?: string;
  profile?: AoiInterestProfile | null;
  feedbackCompression?: AoiFeedbackCompressionResult | null;
  readinessScorecard?: AoiJarvisReadinessScorecard | null;
  budget?: AoiProactiveBriefScoutBudget;
  dependencies?: AoiProactiveBriefScoutDependencies;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Number(value.toFixed(3))));
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function normalizeText(value: unknown, maxChars = 220): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function uniqueStrings(values: readonly unknown[], limit = MAX_REFS): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(String(value ?? ''), 220);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicMatchesAdjustment(topic: AoiInterestTopic, key: string): boolean {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) {
    return false;
  }
  const topicKeys = [
    topic.id,
    topic.cooldownKey,
    topic.label,
    topic.normalizedLabel,
    ...topic.aliases,
  ]
    .map(normalizeKey)
    .filter(Boolean);
  return topicKeys.some(
    (topicKey) => topicKey.includes(normalizedKey) || normalizedKey.includes(topicKey),
  );
}

function feedbackAdjustmentForTopic(
  topic: AoiInterestTopic,
  feedbackCompression: AoiFeedbackCompressionResult | null | undefined,
): { delta: number; evidenceRefs: string[] } {
  if (!feedbackCompression) {
    return { delta: 0, evidenceRefs: [] };
  }
  let delta = 0;
  const evidenceRefs: string[] = [];
  for (const adjustment of feedbackCompression.topicAdjustments) {
    if (!topicMatchesAdjustment(topic, adjustment.key)) {
      continue;
    }
    const direction =
      adjustment.direction === 'increase' ? 1 : adjustment.direction === 'decrease' ? -1 : 0;
    delta += direction * Math.min(0.16, Math.abs(adjustment.score) * adjustment.confidence * 0.18);
    evidenceRefs.push(...adjustment.evidenceRefs);
  }
  for (const hint of feedbackCompression.shouldHaveSpokenHints) {
    if (!topicMatchesAdjustment(topic, hint.key)) {
      continue;
    }
    delta += Math.min(0.12, hint.confidence * 0.12);
    evidenceRefs.push(...hint.evidenceRefs);
  }
  return {
    delta: clamp(delta, -0.18, 0.2),
    evidenceRefs: uniqueStrings(evidenceRefs, 8),
  };
}

export function buildAoiProactiveResearchRoutineProfile(params: {
  profile: AoiInterestProfile;
  feedbackCompression?: AoiFeedbackCompressionResult | null;
  now?: number;
}): AoiInterestProfile {
  const now = params.now ?? params.profile.generatedAt;
  const topics = params.profile.topics.map((topic) => {
    const adjustment = feedbackAdjustmentForTopic(topic, params.feedbackCompression);
    if (Math.abs(adjustment.delta) < 0.001) {
      return topic;
    }
    return {
      ...topic,
      confidence: clamp(topic.confidence + adjustment.delta * 0.35, 0, 1),
      importance: clamp(topic.importance + adjustment.delta, 0, 1),
      currentInfoPreference: clamp(topic.currentInfoPreference + adjustment.delta * 0.75, 0, 1),
      evidenceRefs: uniqueStrings(
        [
          ...topic.evidenceRefs,
          `feedback-compression:${params.feedbackCompression?.id}`,
          ...adjustment.evidenceRefs,
        ],
        16,
      ),
      updatedAt: Math.max(topic.updatedAt, now),
    };
  });
  return {
    ...params.profile,
    topics,
    generatedAt: now,
    warnings: uniqueStrings([
      ...params.profile.warnings,
      params.feedbackCompression
        ? 'feedback compression applied to proactive research routine ranking'
        : undefined,
    ]),
  };
}

function selectedTopicFromPlan(
  planned: AoiProactiveBriefPlannedTopic,
  originalProfile: AoiInterestProfile,
): AoiProactiveResearchRoutineSelectedTopic {
  const original = originalProfile.topics.find((topic) => topic.id === planned.topic.id);
  return {
    version: 1,
    topicId: planned.topic.id,
    topicLabel: planned.topic.label,
    score: clamp(planned.score, 0, 1),
    reasons: uniqueStrings(planned.reasons, 8),
    feedbackAdjusted:
      Boolean(original) &&
      (original?.importance !== planned.topic.importance ||
        original?.confidence !== planned.topic.confidence ||
        original?.currentInfoPreference !== planned.topic.currentInfoPreference),
    evidenceRefs: uniqueStrings(planned.topic.evidenceRefs, 12),
  };
}

function skippedTopicFromHonesty(
  skip: AoiProactiveBriefSkippedTopic,
  records: readonly AoiProactiveBriefScoutSourceHonestyRecord[],
): AoiProactiveResearchRoutineSkippedTopic {
  const matchedRecords = records.filter(
    (record) =>
      (skip.topicId && record.topicId === skip.topicId && record.reason === skip.reason) ||
      (!skip.topicId && record.reason === skip.reason),
  );
  return {
    version: 1,
    ...(skip.topicId ? { topicId: skip.topicId } : {}),
    ...(skip.topicLabel ? { topicLabel: skip.topicLabel } : {}),
    reason: skip.reason,
    detail: skip.detail,
    cannotKnow: uniqueStrings(matchedRecords.flatMap((record) => record.cannotKnow)),
    sourceHonestyEvidenceRefs: uniqueStrings(
      matchedRecords.flatMap((record) => record.evidenceRefs),
      12,
    ),
  };
}

function providerGateFromWarnings(
  warnings: readonly string[],
  dependencies: AoiProactiveBriefScoutDependencies | undefined,
): AoiProactiveResearchRoutineProviderGate {
  if (warnings.some((warning) => warning.startsWith('tavily_not_configured'))) {
    return 'missing';
  }
  if (dependencies?.search) {
    return 'pass';
  }
  return 'unknown';
}

function readinessAllowsDashboard(scorecard: AoiJarvisReadinessScorecard): boolean {
  return scorecard.visibility.dashboard !== 'blocked';
}

function readinessBlockedCannotKnow(scorecard: AoiJarvisReadinessScorecard): string[] {
  return uniqueStrings([
    'Aoi cannot scout or claim current public information because readiness does not allow dashboard visibility.',
    ...scorecard.gates
      .filter((gate) => gate.status === 'block')
      .slice(0, 5)
      .map((gate) => gate.reason),
  ]);
}

function createReadinessBlockedHonestyRecord(params: {
  sessionPath: string;
  topic: AoiProactiveBriefPlannedTopic | AoiInterestTopic | null;
  scorecard: AoiJarvisReadinessScorecard;
  now: number;
}): AoiProactiveBriefScoutSourceHonestyRecord {
  const topic =
    'topic' in (params.topic ?? {})
      ? (params.topic as AoiProactiveBriefPlannedTopic).topic
      : params.topic;
  const cannotKnow = readinessBlockedCannotKnow(params.scorecard);
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(topic?.id ? { topicId: topic.id } : {}),
    ...(topic?.label ? { topicLabel: topic.label } : {}),
    status: 'blocked',
    reason: 'readiness_gate_blocked',
    currentClaimAllowed: false,
    currentClaimBlockedReasons: ['readiness_gate_blocked'],
    directChatCandidate: false,
    directChatRequiresReadinessGate: true,
    cannotKnow,
    evidenceRefs: uniqueStrings([
      `jarvis-readiness:${params.scorecard.id}`,
      ...params.scorecard.blockerRefs,
    ]),
    actionAuthority: 'display_only',
    mutationCount: 0,
    createdAt: params.now,
  };
}

function fieldEventFromRoutineHonesty(
  record: AoiProactiveBriefScoutSourceHonestyRecord,
): AoiFieldEventInput {
  const topic = record.topicLabel ?? record.topicId ?? 'proactive research topic';
  return {
    sessionPath: record.sessionPath,
    category: 'readiness_gate_changed',
    summary: `Aoi did not run a current-info scout for ${topic}: ${record.reason}.`,
    sourceRefs: record.topicId
      ? [`research:proactive-routine:${record.topicId}`]
      : ['research:proactive-routine'],
    evidenceRefs: record.evidenceRefs,
    privacyState: 'metadata_only',
    cannotKnow: record.cannotKnow,
    createdAt: record.createdAt,
    dedupeKey: `proactive-research-routine:${record.topicId ?? topic}:${record.reason}:${record.createdAt}`,
  };
}

function staleCurrentClaimCount(
  records: readonly AoiProactiveBriefScoutSourceHonestyRecord[],
  fieldEvents: readonly AoiFieldEvent[],
): number {
  const blockedCurrentByTopic = new Set(
    records
      .filter(
        (record) =>
          !record.currentClaimAllowed &&
          record.currentClaimBlockedReasons.some((reason) => reason === 'source_stale'),
      )
      .map((record) => record.topicId ?? record.topicLabel ?? record.reason),
  );
  if (blockedCurrentByTopic.size <= 0) {
    return 0;
  }
  return fieldEvents.filter((event) => {
    const text = `${event.summary} ${event.sourceRefs.join(' ')} ${event.evidenceRefs.join(' ')}`;
    const claimsCurrentInfo =
      /current-info candidate|fresh current information|latest|current claim allowed/i.test(text);
    if (!claimsCurrentInfo) {
      return false;
    }
    return [...blockedCurrentByTopic].some((topic) => text.includes(topic));
  }).length;
}

function buildId(params: {
  sessionPath: string;
  now: number;
  selectedTopics: readonly AoiProactiveResearchRoutineSelectedTopic[];
  skippedTopics: readonly AoiProactiveResearchRoutineSkippedTopic[];
  candidates: readonly AoiProactiveBriefCandidate[];
}): string {
  return `aoi-proactive-research-routine-${stableHash(
    JSON.stringify({
      sessionPath: params.sessionPath,
      now: params.now,
      selected: params.selectedTopics.map((topic) => topic.topicId),
      skipped: params.skippedTopics.map((topic) => [topic.topicId, topic.reason]),
      candidates: params.candidates.map((candidate) => candidate.id),
    }),
  )}`;
}

function uniqueSkippedTopics(
  skippedTopics: readonly AoiProactiveBriefSkippedTopic[],
): AoiProactiveBriefSkippedTopic[] {
  const result: AoiProactiveBriefSkippedTopic[] = [];
  const seen = new Set<string>();
  for (const topic of skippedTopics) {
    const key = `${topic.topicId ?? ''}:${topic.reason}:${topic.detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(topic);
  }
  return result;
}

export async function runAoiProactiveResearchRoutine(
  input: RunAoiProactiveResearchRoutineInput,
): Promise<AoiProactiveResearchRoutineResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? DEFAULT_PROACTIVE_RESEARCH_NOW;
  const loadPolicy = input.dependencies?.loadPolicy ?? loadAoiAutonomyPolicy;
  const policy: AoiAutonomyPolicy = loadPolicy(input.sessionsDir, sessionPath);
  const baseProfile =
    input.profile ??
    (input.dependencies?.loadInterestProfile ?? loadAoiInterestProfile)(
      input.sessionsDir,
      sessionPath,
      now,
    );
  const adjustedProfile = applyAoiProactiveBriefingTopicControls(
    buildAoiProactiveResearchRoutineProfile({
      profile: baseProfile,
      feedbackCompression: input.feedbackCompression,
      now,
    }),
    policy.proactiveBriefing,
  );
  const cooldownState = loadAoiProactiveBriefCooldownState(input.sessionsDir, sessionPath, now);
  const feedback = loadAoiProactiveBriefFeedback(input.sessionsDir, sessionPath);
  const budget: AoiProactiveBriefPlannerBudget = input.budget ?? {};
  const plan = planAoiProactiveBriefTopics({
    profile: adjustedProfile,
    cooldownState,
    feedback,
    now,
    budget,
    topicId: input.topicId,
  });
  const readiness =
    input.readinessScorecard ??
    buildAoiJarvisReadinessScorecard({
      sessionPath,
      now,
      feedbackCompression: input.feedbackCompression,
      directChatOptInEnabled: policy.proactiveBriefing.directChatHookOptIn,
    });
  const selectedTopics = plan.topics.map((topic) => selectedTopicFromPlan(topic, baseProfile));
  const scoutBudgetAvailable =
    plan.networkCallBudget.allowed &&
    plan.networkCallBudget.maxCalls > 0 &&
    plan.networkCallBudget.plannedCalls > 0;
  const dashboardReady = readinessAllowsDashboard(readiness);

  let warnings = [...plan.warnings];
  let createdCandidates: AoiProactiveBriefCandidate[] = [];
  let freshnessRecords: AoiProactiveBriefSourceFreshness[] = [];
  let sourceHonestyRecords: AoiProactiveBriefScoutSourceHonestyRecord[] = [];
  let fieldEvents: AoiFieldEvent[] = [];
  let rawSkippedTopics = [...plan.skippedTopics];
  let scoutExecuted = false;

  if (!dashboardReady) {
    warnings.push('readiness_gate_blocked:dashboard_visibility');
    const topicsForRecord =
      plan.topics.length > 0
        ? plan.topics
        : adjustedProfile.topics.length > 0
          ? [adjustedProfile.topics[0]]
          : [null];
    sourceHonestyRecords = topicsForRecord.map((topic) =>
      createReadinessBlockedHonestyRecord({
        sessionPath,
        topic,
        scorecard: readiness,
        now,
      }),
    );
    rawSkippedTopics = [
      ...rawSkippedTopics,
      ...sourceHonestyRecords.map(
        (record): AoiProactiveBriefSkippedTopic => ({
          ...(record.topicId ? { topicId: record.topicId } : {}),
          ...(record.topicLabel ? { topicLabel: record.topicLabel } : {}),
          reason: 'readiness_gate_blocked',
          detail: 'Readiness does not allow dashboard visibility for current-info scouting.',
        }),
      ),
    ];
    fieldEvents = appendAoiFieldEvents(
      input.sessionsDir,
      sourceHonestyRecords.map(fieldEventFromRoutineHonesty),
      now,
    );
  } else {
    const scoutResult = await runAoiProactiveBriefScout({
      sessionsDir: input.sessionsDir,
      sessionPath,
      configFile: input.configFile,
      now,
      topicId: input.topicId,
      mode: 'quick',
      budget: input.budget,
      dependencies: {
        ...input.dependencies,
        loadPolicy,
        loadInterestProfile: () => adjustedProfile,
      },
    });
    scoutExecuted =
      !scoutResult.warnings.some((warning) => warning.startsWith('tavily_not_configured')) &&
      (scoutResult.createdCandidates.length > 0 ||
        scoutResult.sourceFreshness.some((freshness) => freshness.sourceCount > 0));
    warnings = uniqueStrings([...warnings, ...scoutResult.warnings]);
    createdCandidates = scoutResult.createdCandidates;
    freshnessRecords = scoutResult.sourceFreshness;
    sourceHonestyRecords = scoutResult.sourceHonestyRecords;
    fieldEvents = scoutResult.fieldEvents;
    rawSkippedTopics = uniqueSkippedTopics([...rawSkippedTopics, ...scoutResult.skippedTopics]);
  }

  const skippedTopics = rawSkippedTopics.map((skip) =>
    skippedTopicFromHonesty(skip, sourceHonestyRecords),
  );
  const cannotKnow = uniqueStrings(sourceHonestyRecords.flatMap((record) => record.cannotKnow));
  const currentClaimAllowed = sourceHonestyRecords.some((record) => record.currentClaimAllowed);
  const currentClaimBlockedReasons = uniqueStrings(
    sourceHonestyRecords.flatMap((record) => record.currentClaimBlockedReasons),
  );
  const sourceAllowsDirectChat = sourceHonestyRecords.some((record) => record.directChatCandidate);
  const directChatEligible =
    sourceAllowsDirectChat && readiness.visibility.directChat === 'allowed';
  const directChatBlockedReasons = directChatEligible
    ? []
    : uniqueStrings([
        ...readiness.visibility.directChatBlockedReasons,
        sourceAllowsDirectChat ? undefined : 'source honesty did not allow direct-chat candidate',
      ]);
  const staleClaims = staleCurrentClaimCount(sourceHonestyRecords, fieldEvents);
  const provider = providerGateFromWarnings(warnings, input.dependencies);
  const evidenceRefs = uniqueStrings([
    `jarvis-readiness:${readiness.id}`,
    ...selectedTopics.flatMap((topic) => topic.evidenceRefs),
    ...sourceHonestyRecords.flatMap((record) => record.evidenceRefs),
    ...fieldEvents.flatMap((event) => [`field-event:${event.id}`, ...event.evidenceRefs]),
    ...createdCandidates.flatMap((candidate) => candidate.evidenceRefs),
  ]);
  const gateSummary: AoiProactiveResearchRoutineGateSummary = {
    version: 1,
    provider,
    networkBudgetAllowed: plan.networkCallBudget.allowed,
    scoutBudgetAvailable,
    readinessAllowsDashboard: dashboardReady,
    readinessGateStatus: readiness.gateStatus,
    directChatEligible,
    directChatBlockedReasons,
    scoutExecuted,
    evidenceRefs: uniqueStrings([`jarvis-readiness:${readiness.id}`, ...readiness.evidenceRefs]),
  };
  return {
    version: 1,
    id: buildId({
      sessionPath,
      now,
      selectedTopics,
      skippedTopics,
      candidates: createdCandidates,
    }),
    sessionPath,
    generatedAt: now,
    selectedTopics,
    skippedTopics,
    createdCandidates,
    currentClaimAllowed,
    currentClaimBlockedReasons,
    directChatEligibility: {
      version: 1,
      eligible: directChatEligible,
      blockedReasons: directChatBlockedReasons,
      evidenceRefs: gateSummary.evidenceRefs,
    },
    sourceHonestyRecords,
    fieldEvents,
    freshnessRecords,
    cannotKnow,
    staleCurrentClaimCount: staleClaims,
    gateSummary,
    warnings,
    evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}
