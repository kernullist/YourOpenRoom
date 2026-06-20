import { loadAoiResearchTavilyConfig, type AoiResearchTavilyConfig } from './aoiResearchEngine';
import {
  applyAoiProactiveBriefingTopicControls,
  isAoiProactiveBriefQuietWindowActive,
} from './aoiAutonomyPolicy';
import { loadAoiAutonomyPolicy, normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFeedback,
  upsertAoiProactiveBriefCandidate,
  upsertAoiProactiveBriefCooldown,
} from './aoiProactiveBriefStore';
import {
  AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
  planAoiProactiveBriefTopics,
  type AoiProactiveBriefPlannerBudget,
  type AoiProactiveBriefSkippedTopic,
} from './aoiProactiveBriefPlanner';
import {
  createAoiProactiveBriefTavilySearchAdapter,
  scoutAoiProactiveBriefTopic,
  type AoiProactiveBriefSearchAdapter,
  type AoiProactiveBriefSourceFreshness,
} from './aoiProactiveBriefResearch';
import type { AoiAutonomyPolicy, AoiProactiveBriefCandidate } from './aoiAutonomyTypes';
import {
  appendAoiFieldEvents,
  type AoiFieldEvent,
  type AoiFieldEventCategory,
  type AoiFieldEventInput,
} from './aoiFieldEventLedger';

const DEFAULT_MAX_RESULTS_PER_TOPIC = 5;
const DEFAULT_MIN_SOURCES_PER_CANDIDATE = 2;
const DEFAULT_GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface AoiProactiveBriefScoutBudget extends AoiProactiveBriefPlannerBudget {
  maxResultsPerTopic?: number;
  minSourcesPerCandidate?: number;
  sourceStaleAfterMs?: number;
  allowedSourceHosts?: string[];
  mutedSourceHosts?: string[];
}

export interface AoiProactiveBriefScoutDependencies {
  search?: AoiProactiveBriefSearchAdapter;
  fetchImpl?: typeof fetch;
  loadTavilyConfig?: (configFile: string) => AoiResearchTavilyConfig | null;
  loadPolicy?: (sessionsDir: string, sessionPath: string) => AoiAutonomyPolicy;
}

export interface RunAoiProactiveBriefScoutInput {
  sessionsDir: string;
  sessionPath: string;
  configFile?: string;
  now?: number;
  topicId?: string;
  mode?: 'quick';
  budget?: AoiProactiveBriefScoutBudget;
  dependencies?: AoiProactiveBriefScoutDependencies;
}

export interface AoiProactiveBriefScoutResult {
  ok: boolean;
  sessionPath: string;
  mode: 'quick';
  createdCandidates: AoiProactiveBriefCandidate[];
  skippedTopics: AoiProactiveBriefSkippedTopic[];
  warnings: string[];
  sourceFreshness: AoiProactiveBriefSourceFreshness[];
  sourceHonestyRecords: AoiProactiveBriefScoutSourceHonestyRecord[];
  fieldEvents: AoiFieldEvent[];
  cannotKnow: string[];
  currentClaimAllowed: boolean;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export type AoiProactiveBriefScoutSourceHonestyStatus =
  | 'candidate_created'
  | 'blocked'
  | 'suppressed'
  | 'no_news';

export interface AoiProactiveBriefScoutSourceHonestyRecord {
  version: 1;
  sessionPath: string;
  topicId?: string;
  topicLabel?: string;
  status: AoiProactiveBriefScoutSourceHonestyStatus;
  reason: string;
  currentClaimAllowed: boolean;
  currentClaimBlockedReasons: string[];
  directChatCandidate: boolean;
  directChatRequiresReadinessGate: boolean;
  cannotKnow: string[];
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  createdAt: number;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizePositiveNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeScoutBudget(
  input: AoiProactiveBriefScoutBudget | undefined,
  policy: AoiAutonomyPolicy,
): AoiProactiveBriefScoutBudget {
  const controls = policy.proactiveBriefing;
  const quietMode = input?.quietMode === true || isAoiProactiveBriefQuietWindowActive(controls);
  return {
    ...input,
    allowNetwork:
      input?.allowNetwork === true &&
      policy.enabled === true &&
      policy.proactiveSuggestionsEnabled === true &&
      controls.enabled === true,
    quietMode,
    directChatHookOptIn: controls.directChatHookOptIn === true,
    allowedSourceHosts:
      input?.allowedSourceHosts ??
      Object.values(controls.sourceHostControls)
        .filter((control) => control.allowed === true && control.muted !== true)
        .map((control) => control.host),
    mutedSourceHosts:
      input?.mutedSourceHosts ??
      Object.values(controls.sourceHostControls)
        .filter((control) => control.muted === true || control.allowed === false)
        .map((control) => control.host),
    topicCooldownMs: normalizePositiveInteger(
      input?.topicCooldownMs,
      policy.defaultCooldownMs,
      0,
      30 * 24 * 60 * 60 * 1000,
    ),
    globalCooldownMs: normalizePositiveInteger(
      input?.globalCooldownMs,
      DEFAULT_GLOBAL_COOLDOWN_MS,
      0,
      7 * 24 * 60 * 60 * 1000,
    ),
    maxResultsPerTopic: normalizePositiveInteger(
      input?.maxResultsPerTopic,
      DEFAULT_MAX_RESULTS_PER_TOPIC,
      1,
      10,
    ),
    minSourcesPerCandidate: normalizePositiveInteger(
      input?.minSourcesPerCandidate,
      DEFAULT_MIN_SOURCES_PER_CANDIDATE,
      1,
      5,
    ),
    sourceStaleAfterMs: normalizePositiveNumber(
      input?.sourceStaleAfterMs,
      DEFAULT_SOURCE_STALE_AFTER_MS,
      0,
      365 * 24 * 60 * 60 * 1000,
    ),
    minTopicConfidence: normalizePositiveNumber(
      input?.minTopicConfidence,
      policy.confidenceFloor,
      0,
      1,
    ),
  };
}

function normalizeHost(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function wrapSearchWithSourceControls(
  search: AoiProactiveBriefSearchAdapter,
  budget: AoiProactiveBriefScoutBudget,
): AoiProactiveBriefSearchAdapter {
  const allowedHosts = new Set(
    (budget.allowedSourceHosts ?? []).map(normalizeHost).filter(Boolean),
  );
  const mutedHosts = new Set((budget.mutedSourceHosts ?? []).map(normalizeHost).filter(Boolean));
  if (allowedHosts.size === 0 && mutedHosts.size === 0) {
    return search;
  }
  return async (request) => {
    const response = await search(request);
    return {
      ...response,
      results: response.results.filter((result) => {
        const host = hostFromUrl(result.url);
        if (!host) {
          return false;
        }
        if (mutedHosts.has(host)) {
          return false;
        }
        return allowedHosts.size === 0 || allowedHosts.has(host);
      }),
    };
  };
}

function makeSkip(params: {
  topicId?: string;
  topicLabel?: string;
  reason: AoiProactiveBriefSkippedTopic['reason'];
  detail: string;
  retryAfter?: number;
}): AoiProactiveBriefSkippedTopic {
  return {
    ...(params.topicId ? { topicId: params.topicId } : {}),
    ...(params.topicLabel ? { topicLabel: params.topicLabel } : {}),
    reason: params.reason,
    detail: params.detail,
    ...(params.retryAfter !== undefined ? { retryAfter: params.retryAfter } : {}),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function currentClaimBlockReasonsForFreshness(
  freshness: AoiProactiveBriefSourceFreshness,
): string[] {
  const reasons: string[] = [];
  if (freshness.sourceCount <= 0) {
    reasons.push('no_public_sources');
  }
  for (const cannotKnow of freshness.cannotKnow) {
    const lower = cannotKnow.toLowerCase();
    if (lower.includes('fresh current information') || lower.includes('freshness window')) {
      reasons.push('source_stale');
    } else if (lower.includes('publication dates') || lower.includes('newest item')) {
      reasons.push('source_date_unknown');
    } else if (lower.includes('coverage may be incomplete')) {
      reasons.push('source_coverage_incomplete');
    } else {
      reasons.push('source_freshness_uncertain');
    }
  }
  return uniqueStrings(reasons);
}

function cannotKnowForSkip(skip: AoiProactiveBriefSkippedTopic): string[] {
  switch (skip.reason) {
    case 'policy_disabled':
      return [
        'Aoi cannot claim current public information because proactive scouting is disabled by policy.',
      ];
    case 'tavily_not_configured':
      return [
        'Aoi cannot claim current public information because no approved current-info provider is configured.',
      ];
    case 'network_disabled':
      return [
        'Aoi cannot claim current public information because this wakeup has no network budget.',
      ];
    case 'network_budget_exhausted':
      return [
        'Aoi cannot claim current public information because the scout budget was exhausted.',
      ];
    case 'topic_muted':
      return ['Aoi cannot claim current public information for a muted topic.'];
    case 'global_cooldown_active':
    case 'topic_cooldown_active':
      return [
        'Aoi cannot refresh current public information while proactive brief cooldown is active.',
      ];
    case 'low_evidence':
      return [
        'Aoi cannot claim current public information because public source evidence was too thin.',
      ];
    case 'scout_failed':
      return [
        'Aoi cannot claim current public information because the public scout failed before evidence was collected.',
      ];
    case 'profile_empty':
      return [
        'Aoi cannot scout current public information because no interest topics are available.',
      ];
    case 'topic_filter_mismatch':
      return ['Aoi did not scout this topic because it did not match the requested topic filter.'];
    case 'topic_confidence_low':
    case 'topic_importance_low':
      return [
        'Aoi did not scout this topic because it did not meet proactive brief priority thresholds.',
      ];
    case 'recent_negative_feedback':
      return ['Aoi did not scout this topic because recent operator feedback suppresses it.'];
    default:
      return ['Aoi cannot claim current public information for this skipped topic.'];
  }
}

function statusForSkip(
  reason: AoiProactiveBriefSkippedTopic['reason'],
): AoiProactiveBriefScoutSourceHonestyStatus {
  if (reason === 'low_evidence') {
    return 'no_news';
  }
  if (
    reason === 'topic_muted' ||
    reason === 'global_cooldown_active' ||
    reason === 'topic_cooldown_active' ||
    reason === 'recent_negative_feedback'
  ) {
    return 'suppressed';
  }
  return 'blocked';
}

function fieldCategoryForSkip(
  reason: AoiProactiveBriefSkippedTopic['reason'],
): AoiFieldEventCategory {
  if (
    reason === 'topic_muted' ||
    reason === 'global_cooldown_active' ||
    reason === 'topic_cooldown_active' ||
    reason === 'recent_negative_feedback'
  ) {
    return 'delivery_hidden';
  }
  return 'deliberation_blocked';
}

function createSkipHonestyRecord(params: {
  sessionPath: string;
  skip: AoiProactiveBriefSkippedTopic;
  now: number;
}): AoiProactiveBriefScoutSourceHonestyRecord {
  const cannotKnow = cannotKnowForSkip(params.skip);
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(params.skip.topicId ? { topicId: params.skip.topicId } : {}),
    ...(params.skip.topicLabel ? { topicLabel: params.skip.topicLabel } : {}),
    status: statusForSkip(params.skip.reason),
    reason: params.skip.reason,
    currentClaimAllowed: false,
    currentClaimBlockedReasons: [params.skip.reason],
    directChatCandidate: false,
    directChatRequiresReadinessGate: true,
    cannotKnow,
    evidenceRefs: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
    createdAt: params.now,
  };
}

function createCandidateHonestyRecord(params: {
  sessionPath: string;
  candidate: AoiProactiveBriefCandidate;
  now: number;
}): AoiProactiveBriefScoutSourceHonestyRecord {
  const blockedReasons = currentClaimBlockReasonsForFreshness({
    topicId: params.candidate.topicId,
    query: '',
    searchedAt: params.candidate.freshness.searchedAt,
    sourceCount: params.candidate.sources.length,
    ...(params.candidate.freshness.newestSourceAt
      ? { newestSourceAt: params.candidate.freshness.newestSourceAt }
      : {}),
    cannotKnow: params.candidate.freshness.cannotKnow,
  });
  const currentClaimAllowed = blockedReasons.length === 0;
  return {
    version: 1,
    sessionPath: params.sessionPath,
    topicId: params.candidate.topicId,
    topicLabel: params.candidate.topicLabel,
    status: 'candidate_created',
    reason: currentClaimAllowed ? 'source_fresh' : 'source_freshness_uncertain',
    currentClaimAllowed,
    currentClaimBlockedReasons: blockedReasons,
    directChatCandidate:
      currentClaimAllowed && params.candidate.delivery.allowedModes.includes('chat_hook'),
    directChatRequiresReadinessGate: true,
    cannotKnow: params.candidate.freshness.cannotKnow,
    evidenceRefs: params.candidate.evidenceRefs,
    actionAuthority: 'display_only',
    mutationCount: 0,
    createdAt: params.now,
  };
}

function createFieldEventFromHonestyRecord(
  record: AoiProactiveBriefScoutSourceHonestyRecord,
  category: AoiFieldEventCategory,
): AoiFieldEventInput {
  const topic = record.topicLabel ?? record.topicId ?? 'proactive brief topic';
  const sourceRefs = record.topicId
    ? [`research:proactive-brief-scout:${record.topicId}`]
    : ['research:proactive-brief-scout'];
  const summary =
    record.status === 'candidate_created'
      ? `Aoi created a source-backed scout opportunity for ${topic}.`
      : `Aoi did not create a current-info scout claim for ${topic}: ${record.reason}.`;
  return {
    sessionPath: record.sessionPath,
    category,
    summary,
    sourceRefs,
    evidenceRefs: record.evidenceRefs,
    privacyState: 'metadata_only',
    cannotKnow: record.cannotKnow,
    createdAt: record.createdAt,
    dedupeKey: `proactive-brief-scout:${record.topicId ?? topic}:${record.reason}:${record.createdAt}`,
  };
}

export async function runAoiProactiveBriefScout(
  input: RunAoiProactiveBriefScoutInput,
): Promise<AoiProactiveBriefScoutResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (input.mode && input.mode !== 'quick') {
    throw new Error('Only quick proactive brief scouting is supported.');
  }

  const now = input.now ?? Date.now();
  const loadPolicy = input.dependencies?.loadPolicy ?? loadAoiAutonomyPolicy;
  const policy = loadPolicy(input.sessionsDir, sessionPath);
  const budget = normalizeScoutBudget(input.budget, policy);
  const warnings: string[] = [];
  const createdCandidates: AoiProactiveBriefCandidate[] = [];
  const sourceFreshness: AoiProactiveBriefSourceFreshness[] = [];
  const sourceHonestyRecords: AoiProactiveBriefScoutSourceHonestyRecord[] = [];
  const fieldEventInputs: AoiFieldEventInput[] = [];
  const recordedSkipKeys = new Set<string>();

  function recordSkip(skip: AoiProactiveBriefSkippedTopic): void {
    const key = `${skip.topicId ?? ''}:${skip.reason}:${skip.detail}`;
    if (recordedSkipKeys.has(key)) {
      return;
    }
    recordedSkipKeys.add(key);
    const record = createSkipHonestyRecord({
      sessionPath,
      skip,
      now,
    });
    sourceHonestyRecords.push(record);
    fieldEventInputs.push(
      createFieldEventFromHonestyRecord(record, fieldCategoryForSkip(skip.reason)),
    );
  }

  function recordSkippedTopics(skips: readonly AoiProactiveBriefSkippedTopic[]): void {
    for (const skip of skips) {
      recordSkip(skip);
    }
  }

  function recordCandidate(candidate: AoiProactiveBriefCandidate): void {
    const record = createCandidateHonestyRecord({
      sessionPath,
      candidate,
      now,
    });
    sourceHonestyRecords.push(record);
    fieldEventInputs.push(
      createFieldEventFromHonestyRecord(
        record,
        record.currentClaimAllowed ? 'opportunity_created' : 'delivery_dashboard',
      ),
    );
  }

  function finishResult(): AoiProactiveBriefScoutResult {
    const fieldEvents =
      fieldEventInputs.length > 0
        ? appendAoiFieldEvents(input.sessionsDir, fieldEventInputs, now)
        : [];
    const cannotKnow = uniqueStrings(sourceHonestyRecords.flatMap((record) => record.cannotKnow));
    return {
      ok: true,
      sessionPath,
      mode: 'quick',
      createdCandidates,
      skippedTopics,
      warnings,
      sourceFreshness,
      sourceHonestyRecords,
      fieldEvents,
      cannotKnow,
      currentClaimAllowed: sourceHonestyRecords.some((record) => record.currentClaimAllowed),
      actionAuthority: 'display_only',
      mutationCount: 0,
    };
  }

  if (!policy.enabled || !policy.proactiveSuggestionsEnabled) {
    warnings.push('proactive_suggestions_disabled');
  }
  if (!policy.proactiveBriefing.enabled) {
    warnings.push('proactive_brief_scouting_disabled');
  }

  const profile = applyAoiProactiveBriefingTopicControls(
    loadAoiInterestProfile(input.sessionsDir, sessionPath, now),
    policy.proactiveBriefing,
  );
  const cooldownState = loadAoiProactiveBriefCooldownState(input.sessionsDir, sessionPath, now);
  const feedback = loadAoiProactiveBriefFeedback(input.sessionsDir, sessionPath);
  const plan = planAoiProactiveBriefTopics({
    profile,
    cooldownState,
    feedback,
    now,
    budget,
    topicId: input.topicId,
  });
  const skippedTopics = [...plan.skippedTopics];
  warnings.push(...plan.warnings);

  if (!policy.enabled || !policy.proactiveSuggestionsEnabled || !policy.proactiveBriefing.enabled) {
    for (const planned of plan.topics) {
      skippedTopics.push(
        makeSkip({
          topicId: planned.topic.id,
          topicLabel: planned.topic.label,
          reason: 'policy_disabled',
          detail: 'Aoi proactive suggestions or proactive scouting are disabled by policy.',
        }),
      );
    }
    recordSkippedTopics(skippedTopics);
    return finishResult();
  }

  if (!budget.allowNetwork || plan.topics.length === 0) {
    recordSkippedTopics(skippedTopics);
    return finishResult();
  }

  let search = input.dependencies?.search;
  if (!search) {
    const config = (input.dependencies?.loadTavilyConfig ?? loadAoiResearchTavilyConfig)(
      input.configFile ?? '',
    );
    if (!config) {
      warnings.push('tavily_not_configured:cannot_refresh_current_info');
      for (const planned of plan.topics) {
        skippedTopics.push(
          makeSkip({
            topicId: planned.topic.id,
            topicLabel: planned.topic.label,
            reason: 'tavily_not_configured',
            detail: 'Tavily is not configured, so Aoi did not create a current-info brief.',
          }),
        );
        sourceFreshness.push({
          topicId: planned.topic.id,
          query: '',
          searchedAt: now,
          sourceCount: 0,
          cannotKnow: [
            'Aoi cannot know current public developments because no approved current-info provider is configured.',
          ],
        });
      }
      recordSkippedTopics(skippedTopics);
      return finishResult();
    }
    search = createAoiProactiveBriefTavilySearchAdapter({
      config,
      fetchImpl: input.dependencies?.fetchImpl,
    });
  }
  search = wrapSearchWithSourceControls(search, budget);

  for (const planned of plan.topics) {
    try {
      const result = await scoutAoiProactiveBriefTopic({
        topic: planned.topic,
        search,
        now,
        maxResults: budget.maxResultsPerTopic,
        minSources: budget.minSourcesPerCandidate,
        sourceStaleAfterMs: budget.sourceStaleAfterMs,
        delivery: planned.delivery,
      });
      sourceFreshness.push(result.evidence.freshness);
      warnings.push(...result.warnings);

      if (!result.candidate) {
        skippedTopics.push(
          makeSkip({
            topicId: planned.topic.id,
            topicLabel: planned.topic.label,
            reason: 'low_evidence',
            detail: 'Public search did not return enough independent source URLs.',
          }),
        );
        recordSkip(skippedTopics[skippedTopics.length - 1]);
        continue;
      }

      const upserted = upsertAoiProactiveBriefCandidate(input.sessionsDir, result.candidate, now);
      createdCandidates.push(upserted.candidate);
      recordCandidate(upserted.candidate);

      upsertAoiProactiveBriefCooldown(input.sessionsDir, sessionPath, {
        cooldownKey: planned.topic.cooldownKey,
        topicId: planned.topic.id,
        nextAllowedAt: now + (budget.topicCooldownMs ?? policy.defaultCooldownMs),
        reason: 'candidate_created',
        sourceBriefIds: [upserted.candidate.id],
        now,
      });
      upsertAoiProactiveBriefCooldown(input.sessionsDir, sessionPath, {
        cooldownKey: AOI_PROACTIVE_BRIEF_GLOBAL_COOLDOWN_KEY,
        nextAllowedAt: now + (budget.globalCooldownMs ?? DEFAULT_GLOBAL_COOLDOWN_MS),
        reason: 'candidate_created',
        sourceBriefIds: [upserted.candidate.id],
        now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`scout_failed:${planned.topic.id}:${message.slice(0, 160)}`);
      skippedTopics.push(
        makeSkip({
          topicId: planned.topic.id,
          topicLabel: planned.topic.label,
          reason: 'scout_failed',
          detail: 'Public scout failed before a source-backed candidate could be created.',
        }),
      );
      recordSkip(skippedTopics[skippedTopics.length - 1]);
    }
  }

  recordSkippedTopics(skippedTopics);
  return finishResult();
}
