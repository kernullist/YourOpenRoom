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
    return {
      ok: true,
      sessionPath,
      mode: 'quick',
      createdCandidates,
      skippedTopics,
      warnings,
      sourceFreshness,
    };
  }

  if (!budget.allowNetwork || plan.topics.length === 0) {
    return {
      ok: true,
      sessionPath,
      mode: 'quick',
      createdCandidates,
      skippedTopics,
      warnings,
      sourceFreshness,
    };
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
      }
      return {
        ok: true,
        sessionPath,
        mode: 'quick',
        createdCandidates,
        skippedTopics,
        warnings,
        sourceFreshness,
      };
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
        continue;
      }

      const upserted = upsertAoiProactiveBriefCandidate(input.sessionsDir, result.candidate, now);
      createdCandidates.push(upserted.candidate);

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
    }
  }

  return {
    ok: true,
    sessionPath,
    mode: 'quick',
    createdCandidates,
    skippedTopics,
    warnings,
    sourceFreshness,
  };
}
