import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  applyAoiProactiveBriefingTopicControls,
  checkAoiEnvironmentSourceOperation,
  isAoiProactiveBriefQuietWindowActive,
} from './aoiAutonomyPolicy';
import {
  runAoiAutonomyBackgroundTick,
  type AoiAutonomyBackgroundTickParams,
} from './aoiAutonomyEngine';
import { loadAoiMcpConnectorsFromConfigFile } from './aoiMcpConnectorsConfigFile';
import { maybeRunAoiAutonomyLevelPromotion } from './aoiAutonomyLevelPromotionRunner';
import { DEFAULT_LLM_DAILY_TOKEN_BUDGET, resolveAoiLlmTokenCeiling } from './aoiAutonomyLlmBudget';
import {
  checkAoiScoutNetworkBudget,
  DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
  DEFAULT_SCOUT_NETWORK_DAILY_BUDGET,
  loadAoiScoutNetworkBudgetState,
  recordAoiScoutNetworkSpend,
  resolveAoiScoutNetworkCeiling,
  saveAoiScoutNetworkBudgetState,
  type AoiScoutNetworkBudgetState,
} from './aoiScoutNetworkBudget';
import {
  checkAoiDirectChatBudget,
  DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
  DEFAULT_DIRECT_CHAT_DAILY_BUDGET,
  loadAoiDirectChatBudgetState,
  resolveAoiDirectChatCeiling,
} from './aoiDirectChatBudget';
import { createAoiAutonomyReflectionChat } from './aoiAutonomyReflectionChat';
import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import { embedAndPersistServerAoiMemories } from './aoiMemoryServerWriter';
import {
  buildAoiAutonomyStatus,
  createAoiAutonomyId,
  loadAoiAutonomyPolicy,
  loadAoiEnvironmentSourceRegistry,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import {
  collectAndPersistAoiWorkspaceSnapshot,
  type AoiWorkspaceSignalStoreInput,
} from './aoiWorkspaceSignals';
import { loadAoiResearchTavilyConfig } from './aoiResearchEngine';
import {
  recordAoiOperatorTimelineEvent,
  type AoiOperatorTimelineEventInput,
} from './aoiOperatorTimeline';
import {
  runAoiProactiveBriefScout,
  type AoiProactiveBriefScoutResult,
} from './aoiProactiveBriefScout';
import { buildAoiProactiveTrendAdvisorState } from './aoiProactiveTrendAdvisor';
import { planAoiProactiveBriefTopics } from './aoiProactiveBriefPlanner';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCalibrationTuning,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFeedback,
  loadAoiProactiveBriefFieldMetrics,
  recordAoiProactiveBriefFieldEvent,
} from './aoiProactiveBriefStore';
import type { LLMConfig } from './llmModels';
import type {
  AoiAutonomySchedulerState,
  AoiAutonomySourceSchedule,
  AoiAutonomyTickReason,
  AoiAutonomyTickResult,
  AoiAutonomyWakeupBudget,
  AoiAutonomyWakeupReason,
  AoiAutonomyWakeupRecord,
  AoiAutonomyWakeupResult,
  AoiEnvironmentSource,
  AoiEnvironmentSourceOperation,
  AoiEnvironmentSourceRegistry,
  AoiProactiveBriefSchedulerRunRecord,
  AoiProactiveBriefScoutBudgetState,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

const MAX_RECENT_WAKEUPS = 20;
const DEFAULT_SOURCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SOURCE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_WAKEUP_COOLDOWN_MS = 30 * 1000;
const DEFAULT_SCHEDULER_RUNTIME_MS = 15_000;
const DEFAULT_BACKGROUND_TICK_RUNTIME_MS = 12_000;
const DEFAULT_MAX_SOURCE_COUNT = 3;
const DEFAULT_MAX_GENERATED_PROPOSALS = 2;

const SOURCE_TTL_MS_BY_ID: Record<string, number> = {
  'workspace-git': 60 * 1000,
  'workspace-build': 5 * 60 * 1000,
  'kira-board': 2 * 60 * 1000,
  'research-runs': 2 * 60 * 1000,
  'app-state': 60 * 1000,
  'browser-context': 5 * 60 * 1000,
  'manual-note': 5 * 60 * 1000,
  'calendar-metadata': 10 * 60 * 1000,
  'gmail-metadata': 15 * 60 * 1000,
  'notes-metadata': 10 * 60 * 1000,
};

export const DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET: AoiAutonomyWakeupBudget = {
  version: 1,
  maxSchedulerRuntimeMs: DEFAULT_SCHEDULER_RUNTIME_MS,
  maxBackgroundTickRuntimeMs: DEFAULT_BACKGROUND_TICK_RUNTIME_MS,
  maxSourceCount: DEFAULT_MAX_SOURCE_COUNT,
  maxGeneratedProposalCount: DEFAULT_MAX_GENERATED_PROPOSALS,
  perSourceCooldownMs: DEFAULT_SOURCE_COOLDOWN_MS,
  wakeupCooldownMs: DEFAULT_WAKEUP_COOLDOWN_MS,
  quietMode: false,
  allowNetwork: false,
  llmDailyTokenBudget: DEFAULT_LLM_DAILY_TOKEN_BUDGET,
  goalSynthesisEnabled: false,
  scoutNetworkDailyBudget: DEFAULT_SCOUT_NETWORK_DAILY_BUDGET,
  directChatDailyBudget: DEFAULT_DIRECT_CHAT_DAILY_BUDGET,
};

export interface AoiAutonomyWakeupInput {
  sessionsDir: string;
  sessionPath: string;
  reason: AoiAutonomyWakeupReason;
  workspaceRoot?: string;
  configFile?: string;
  // Origin for the server-side reflection chat adapter (used only by CLI /
  // managed-auth providers; baseUrl providers call their absolute endpoint
  // directly). Defaults to the dev loopback when absent.
  serverOrigin?: string;
  latestUserMessage?: string;
  llmConfig?: LLMConfig | null;
  sourceIds?: string[];
  budget?: Partial<AoiAutonomyWakeupBudget>;
  quietMode?: boolean;
  userIdleMs?: number;
  proactiveScout?: {
    runNow?: boolean;
    topicId?: string;
  };
  now?: number;
  dependencies?: AoiAutonomySchedulerDependencies;
}

export interface AoiAutonomySchedulerDependencies {
  now?: () => number;
  collectWorkspaceSnapshot?: (input: AoiWorkspaceSignalStoreInput) => AoiWorkspaceSnapshot | null;
  runBackgroundTick?: (params: AoiAutonomyBackgroundTickParams) => Promise<AoiAutonomyTickResult>;
  runProactiveBriefScout?: (
    input: Parameters<typeof runAoiProactiveBriefScout>[0],
  ) => Promise<AoiProactiveBriefScoutResult>;
  currentInfoProviderConfigured?: (configFile: string) => boolean;
}

interface SourceDecision {
  sourceId: string;
  source?: AoiEnvironmentSource;
  operation: AoiEnvironmentSourceOperation;
  schedule: AoiAutonomySourceSchedule;
  selected: boolean;
  reasons: string[];
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function schedulerStatePath(sessionsDir: string, sessionPath: string): string {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  if (!isPathInsideRoot(paths.root, paths.schedulerState)) {
    throw new Error('Resolved Aoi scheduler state path escaped the autonomy directory.');
  }
  return paths.schedulerState;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function normalizeStringList(value: unknown, maxItems = 24): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function normalizeWakeupReason(value: unknown): AoiAutonomyWakeupReason | null {
  if (
    value === 'session_open' ||
    value === 'user_return_idle' ||
    value === 'manual_refresh' ||
    value === 'source_ttl_expired' ||
    value === 'mission_waiting_too_long' ||
    value === 'kira_event' ||
    value === 'research_event' ||
    value === 'health_check' ||
    value === 'scheduled_background'
  ) {
    return value;
  }
  return null;
}

export function isAoiAutonomyWakeupReason(value: unknown): value is AoiAutonomyWakeupReason {
  return normalizeWakeupReason(value) !== null;
}

function mapWakeupReasonToTickReason(reason: AoiAutonomyWakeupReason): AoiAutonomyTickReason {
  if (reason === 'manual_refresh') {
    return 'manual';
  }
  if (
    reason === 'source_ttl_expired' ||
    reason === 'health_check' ||
    reason === 'scheduled_background'
  ) {
    return 'periodic';
  }
  if (reason === 'kira_event') {
    return 'kira';
  }
  if (reason === 'research_event') {
    return 'research_run';
  }
  return 'app';
}

function defaultOperationForSource(source: AoiEnvironmentSource): AoiEnvironmentSourceOperation {
  if (source.kind === 'workspace_git') {
    return 'status';
  }
  if (source.kind === 'workspace_build') {
    return 'read_metadata';
  }
  if (source.allowedOperations.includes('status')) {
    return 'status';
  }
  if (source.allowedOperations.includes('read_metadata')) {
    return 'read_metadata';
  }
  return source.allowedOperations[0] ?? 'read_metadata';
}

function normalizeBudget(
  budget: Partial<AoiAutonomyWakeupBudget> | undefined,
  quietMode?: boolean,
): AoiAutonomyWakeupBudget {
  return {
    version: 1,
    maxSchedulerRuntimeMs: clampNumber(
      budget?.maxSchedulerRuntimeMs,
      DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.maxSchedulerRuntimeMs,
      1,
      120_000,
    ),
    maxBackgroundTickRuntimeMs: clampNumber(
      budget?.maxBackgroundTickRuntimeMs,
      DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.maxBackgroundTickRuntimeMs,
      0,
      120_000,
    ),
    maxSourceCount: clampNumber(
      budget?.maxSourceCount,
      DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.maxSourceCount,
      0,
      24,
    ),
    maxGeneratedProposalCount: clampNumber(
      budget?.maxGeneratedProposalCount,
      DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.maxGeneratedProposalCount,
      0,
      12,
    ),
    perSourceCooldownMs: clampNumber(
      budget?.perSourceCooldownMs,
      DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.perSourceCooldownMs,
      0,
      24 * 60 * 60 * 1000,
    ),
    wakeupCooldownMs: clampNumber(
      budget?.wakeupCooldownMs,
      DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.wakeupCooldownMs,
      0,
      24 * 60 * 60 * 1000,
    ),
    quietMode: quietMode ?? budget?.quietMode ?? DEFAULT_AOI_AUTONOMY_WAKEUP_BUDGET.quietMode,
    allowNetwork: budget?.allowNetwork === true,
    llmDailyTokenBudget: resolveAoiLlmTokenCeiling(budget?.llmDailyTokenBudget),
    goalSynthesisEnabled: budget?.goalSynthesisEnabled === true,
    scoutNetworkDailyBudget: resolveAoiScoutNetworkCeiling(budget?.scoutNetworkDailyBudget),
    directChatDailyBudget: resolveAoiDirectChatCeiling(budget?.directChatDailyBudget),
  };
}

function normalizeSourceSchedule(
  value: unknown,
  fallback: {
    sourceId: string;
    operation: AoiEnvironmentSourceOperation;
    now: number;
    cooldownMs: number;
  },
): AoiAutonomySourceSchedule {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomySourceSchedule>)
      : {};
  const lastReasons = normalizeStringList(record.lastReasons, 12);
  return {
    version: 1,
    sourceId:
      typeof record.sourceId === 'string' && record.sourceId.trim()
        ? record.sourceId.trim().slice(0, 120)
        : fallback.sourceId,
    operation:
      record.operation === 'summarize' ||
      record.operation === 'status' ||
      record.operation === 'diff' ||
      record.operation === 'read_metadata'
        ? record.operation
        : fallback.operation,
    ttlMs: clampNumber(
      record.ttlMs,
      SOURCE_TTL_MS_BY_ID[fallback.sourceId] ?? DEFAULT_SOURCE_TTL_MS,
      0,
      24 * 60 * 60 * 1000,
    ),
    cooldownMs: clampNumber(record.cooldownMs, fallback.cooldownMs, 0, 24 * 60 * 60 * 1000),
    ...(typeof record.nextAllowedAt === 'number' ? { nextAllowedAt: record.nextAllowedAt } : {}),
    ...(typeof record.lastRefreshedAt === 'number'
      ? { lastRefreshedAt: record.lastRefreshedAt }
      : {}),
    ...(typeof record.lastSkippedAt === 'number' ? { lastSkippedAt: record.lastSkippedAt } : {}),
    ...(record.lastResult === 'refreshed' ||
    record.lastResult === 'skipped' ||
    record.lastResult === 'failed'
      ? { lastResult: record.lastResult }
      : {}),
    lastReasons,
    refreshCount: clampNumber(record.refreshCount, 0, 0, 100_000),
    skipCount: clampNumber(record.skipCount, 0, 0, 100_000),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : fallback.now,
  };
}

function normalizeWakeupBudget(value: unknown): AoiAutonomyWakeupBudget {
  const budget =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomyWakeupBudget>)
      : {};
  return normalizeBudget(budget);
}

function dayKeyForTimestamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function normalizeProactiveScoutBudgetState(
  value: unknown,
  now: number,
): AoiProactiveBriefScoutBudgetState {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiProactiveBriefScoutBudgetState>)
      : {};
  const dayKey =
    typeof raw.dayKey === 'string' && raw.dayKey ? raw.dayKey : dayKeyForTimestamp(now);
  const sameDay = dayKey === dayKeyForTimestamp(now);
  return {
    version: 1,
    dayKey: sameDay ? dayKey : dayKeyForTimestamp(now),
    runsToday: sameDay ? clampNumber(raw.runsToday, 0, 0, 100_000) : 0,
    runsThisSession: clampNumber(raw.runsThisSession, 0, 0, 100_000),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

function normalizeProactiveScoutRunRecord(
  value: unknown,
): AoiProactiveBriefSchedulerRunRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiProactiveBriefSchedulerRunRecord>;
  const status =
    raw.status === 'not_requested' ||
    raw.status === 'blocked' ||
    raw.status === 'scouted' ||
    raw.status === 'no_candidate' ||
    raw.status === 'failed'
      ? raw.status
      : 'blocked';
  const budget = (
    raw.budget && typeof raw.budget === 'object' && !Array.isArray(raw.budget) ? raw.budget : {}
  ) as Partial<NonNullable<AoiProactiveBriefSchedulerRunRecord['budget']>>;
  const controlSnapshot =
    raw.controlSnapshot &&
    typeof raw.controlSnapshot === 'object' &&
    !Array.isArray(raw.controlSnapshot)
      ? raw.controlSnapshot
      : undefined;
  return {
    version: 1,
    requested: raw.requested === true,
    runNow: raw.runNow === true,
    background: raw.background !== false,
    status,
    provider: raw.provider === 'tavily' || raw.provider === 'test' ? raw.provider : 'none',
    providerConfigured: raw.providerConfigured === true,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : 0,
    createdCandidateCount: clampNumber(raw.createdCandidateCount, 0, 0, 100_000),
    skippedTopicCount: clampNumber(raw.skippedTopicCount, 0, 0, 100_000),
    sourceFreshnessCount: clampNumber(raw.sourceFreshnessCount, 0, 0, 100_000),
    topicIds: normalizeStringList(raw.topicIds, 24),
    blockedReasons: normalizeStringList(raw.blockedReasons, 24),
    warnings: normalizeStringList(raw.warnings, 24),
    budget: {
      dayKey: typeof budget.dayKey === 'string' ? budget.dayKey.slice(0, 20) : '',
      runsToday: clampNumber(budget.runsToday, 0, 0, 100_000),
      maxRunsPerDay: clampNumber(budget.maxRunsPerDay, 0, 0, 100_000),
      runsThisSession: clampNumber(budget.runsThisSession, 0, 0, 100_000),
      maxRunsPerSession: clampNumber(budget.maxRunsPerSession, 0, 0, 100_000),
    },
    ...(controlSnapshot
      ? {
          controlSnapshot: {
            version: 1,
            enabled: controlSnapshot.enabled === true,
            allowBackgroundScout: controlSnapshot.allowBackgroundScout === true,
            directChatHookOptIn: controlSnapshot.directChatHookOptIn === true,
            quietWindowEnabled: controlSnapshot.quietWindowEnabled === true,
            quietWindowActive: controlSnapshot.quietWindowActive === true,
            maxScoutRunsPerDay: clampNumber(controlSnapshot.maxScoutRunsPerDay, 0, 0, 100_000),
            maxScoutRunsPerSession: clampNumber(
              controlSnapshot.maxScoutRunsPerSession,
              0,
              0,
              100_000,
            ),
            maxTopicsPerWakeup: clampNumber(controlSnapshot.maxTopicsPerWakeup, 0, 0, 100_000),
            maxNetworkCallsPerWakeup: clampNumber(
              controlSnapshot.maxNetworkCallsPerWakeup,
              0,
              0,
              100_000,
            ),
            minScoutCooldownMs: clampNumber(
              controlSnapshot.minScoutCooldownMs,
              0,
              0,
              24 * 60 * 60 * 1000,
            ),
            maxSessionIdleMs: clampNumber(
              controlSnapshot.maxSessionIdleMs,
              0,
              0,
              24 * 60 * 60 * 1000,
            ),
            topicControlCount: clampNumber(controlSnapshot.topicControlCount, 0, 0, 100_000),
            allowedTopicCount: clampNumber(controlSnapshot.allowedTopicCount, 0, 0, 100_000),
            mutedTopicCount: clampNumber(controlSnapshot.mutedTopicCount, 0, 0, 100_000),
            sourceHostControlCount: clampNumber(
              controlSnapshot.sourceHostControlCount,
              0,
              0,
              100_000,
            ),
            allowedSourceHostCount: clampNumber(
              controlSnapshot.allowedSourceHostCount,
              0,
              0,
              100_000,
            ),
            mutedSourceHostCount: clampNumber(controlSnapshot.mutedSourceHostCount, 0, 0, 100_000),
            actionAuthority: 'display_only',
            mutationCount: 0,
          },
        }
      : {}),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24),
  };
}

function normalizeWakeupRecord(value: unknown): AoiAutonomyWakeupRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiAutonomyWakeupRecord>;
  const reason = normalizeWakeupReason(record.reason);
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!sessionPath || !reason || typeof record.id !== 'string') {
    return null;
  }
  const selectedSourceIds = normalizeStringList(record.selectedSourceIds);
  const refreshedSourceIds = normalizeStringList(record.refreshedSourceIds);
  const skippedSources = Array.isArray(record.skippedSources)
    ? (record.skippedSources as unknown[])
        .filter(
          (item): item is { sourceId?: unknown; reasons?: unknown } =>
            Boolean(item) && typeof item === 'object',
        )
        .map((item) => ({
          sourceId: typeof item.sourceId === 'string' ? item.sourceId.slice(0, 120) : 'unknown',
          reasons: normalizeStringList(item.reasons, 12),
        }))
        .slice(0, 24)
    : [];
  const status =
    record.status === 'completed' || record.status === 'skipped' || record.status === 'failed'
      ? record.status
      : record.ok === false
        ? 'failed'
        : 'completed';
  return {
    version: 1,
    id: record.id.slice(0, 128),
    sessionPath,
    reason,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
    completedAt: typeof record.completedAt === 'number' ? record.completedAt : 0,
    durationMs: clampNumber(record.durationMs, 0, 0, 24 * 60 * 60 * 1000),
    ok: record.ok !== false,
    status,
    budget: normalizeWakeupBudget(record.budget),
    selectedSourceIds,
    refreshedSourceIds,
    skippedSources,
    tickRan: record.tickRan === true,
    tickSkipped: record.tickSkipped === true,
    tickOk: record.tickOk !== false,
    tickReason:
      record.tickReason === 'manual' ||
      record.tickReason === 'turn' ||
      record.tickReason === 'periodic' ||
      record.tickReason === 'research_run' ||
      record.tickReason === 'kira' ||
      record.tickReason === 'proposal' ||
      record.tickReason === 'memory' ||
      record.tickReason === 'app'
        ? record.tickReason
        : mapWakeupReasonToTickReason(reason),
    proposalsCreated: clampNumber(record.proposalsCreated, 0, 0, 100_000),
    observationsSeen: clampNumber(record.observationsSeen, 0, 0, 100_000),
    warnings: normalizeStringList(record.warnings, 24),
    ...(normalizeProactiveScoutRunRecord(record.proactiveScout)
      ? { proactiveScout: normalizeProactiveScoutRunRecord(record.proactiveScout) }
      : {}),
  };
}

function normalizeSchedulerState(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiAutonomySchedulerState {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomySchedulerState>)
      : {};
  const stateSessionPath = normalizeAoiAutonomySessionPath(record.sessionPath) ?? sessionPath;
  const sourceSchedules = Array.isArray(record.sourceSchedules)
    ? record.sourceSchedules
        .map((item) =>
          normalizeSourceSchedule(item, {
            sourceId:
              item &&
              typeof item === 'object' &&
              typeof (item as { sourceId?: unknown }).sourceId === 'string'
                ? String((item as { sourceId: string }).sourceId)
                : 'unknown',
            operation: 'read_metadata',
            now,
            cooldownMs: DEFAULT_SOURCE_COOLDOWN_MS,
          }),
        )
        .filter((item) => item.sourceId !== 'unknown')
        .slice(0, 100)
    : [];
  const recentWakeups = Array.isArray(record.recentWakeups)
    ? record.recentWakeups
        .map(normalizeWakeupRecord)
        .filter((item): item is AoiAutonomyWakeupRecord => item !== null)
        .slice(0, MAX_RECENT_WAKEUPS)
    : [];
  return {
    version: 1,
    sessionPath: stateSessionPath,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
    wakeupCount: clampNumber(record.wakeupCount, recentWakeups.length, 0, 1_000_000),
    ...(typeof record.lastWakeupAt === 'number' ? { lastWakeupAt: record.lastWakeupAt } : {}),
    ...(normalizeWakeupReason(record.lastWakeupReason)
      ? { lastWakeupReason: normalizeWakeupReason(record.lastWakeupReason) ?? undefined }
      : {}),
    ...(record.lastWakeupStatus === 'completed' ||
    record.lastWakeupStatus === 'skipped' ||
    record.lastWakeupStatus === 'failed'
      ? { lastWakeupStatus: record.lastWakeupStatus }
      : {}),
    ...(typeof record.nextAllowedWakeupAt === 'number'
      ? { nextAllowedWakeupAt: record.nextAllowedWakeupAt }
      : {}),
    proactiveScoutBudget: normalizeProactiveScoutBudgetState(record.proactiveScoutBudget, now),
    sourceSchedules,
    recentWakeups,
  };
}

export function loadAoiAutonomySchedulerState(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiAutonomySchedulerState {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return normalizeSchedulerState(
    readJson<unknown>(schedulerStatePath(sessionsDir, normalizedSessionPath)),
    normalizedSessionPath,
    now,
  );
}

function saveAoiAutonomySchedulerState(
  sessionsDir: string,
  state: AoiAutonomySchedulerState,
): AoiAutonomySchedulerState {
  writeJsonAtomic(schedulerStatePath(sessionsDir, state.sessionPath), state);
  return state;
}

function updateScheduleForDecision(
  decision: SourceDecision,
  params: {
    now: number;
    refreshed: boolean;
    failed?: boolean;
    reasons?: string[];
  },
): AoiAutonomySourceSchedule {
  const reasons = params.reasons ?? decision.reasons;
  if (params.refreshed) {
    return {
      ...decision.schedule,
      operation: decision.operation,
      lastRefreshedAt: params.now,
      nextAllowedAt: params.now + decision.schedule.cooldownMs,
      lastResult: 'refreshed',
      lastReasons: [],
      refreshCount: decision.schedule.refreshCount + 1,
      updatedAt: params.now,
    };
  }
  return {
    ...decision.schedule,
    operation: decision.operation,
    lastSkippedAt: params.now,
    lastResult: params.failed ? 'failed' : 'skipped',
    lastReasons: reasons.slice(0, 12),
    skipCount: decision.schedule.skipCount + 1,
    updatedAt: params.now,
  };
}

function mergeSchedules(
  previous: AoiAutonomySourceSchedule[],
  updates: AoiAutonomySourceSchedule[],
): AoiAutonomySourceSchedule[] {
  const byId = new Map(previous.map((item) => [item.sourceId, item]));
  for (const update of updates) {
    byId.set(update.sourceId, update);
  }
  return [...byId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).slice(0, 100);
}

function buildSourceDecision(params: {
  sourceId: string;
  registry: AoiEnvironmentSourceRegistry;
  scheduleMap: Map<string, AoiAutonomySourceSchedule>;
  budget: AoiAutonomyWakeupBudget;
  reason: AoiAutonomyWakeupReason;
  now: number;
}): SourceDecision {
  const source = params.registry.sources.find((item) => item.id === params.sourceId);
  const operation = source ? defaultOperationForSource(source) : 'read_metadata';
  const previousSchedule = params.scheduleMap.get(params.sourceId);
  const schedule = normalizeSourceSchedule(previousSchedule, {
    sourceId: params.sourceId,
    operation,
    now: params.now,
    cooldownMs: params.budget.perSourceCooldownMs,
  });
  const reasons: string[] = [];
  if (!source) {
    reasons.push('unknown_source');
  } else {
    const policy = checkAoiEnvironmentSourceOperation({
      registry: params.registry,
      sourceId: source.id,
      operation,
    });
    reasons.push(...policy.reasons);
    if (params.budget.quietMode && source.quietModeBehavior === 'suppress') {
      reasons.push('quiet_mode_suppressed');
    }
    if (
      params.reason === 'source_ttl_expired' &&
      typeof schedule.lastRefreshedAt === 'number' &&
      schedule.lastRefreshedAt + schedule.ttlMs > params.now
    ) {
      reasons.push('source_ttl_fresh');
    }
  }
  if (schedule.nextAllowedAt && schedule.nextAllowedAt > params.now) {
    reasons.push('source_cooldown_active');
  }
  return {
    sourceId: params.sourceId,
    source,
    operation,
    schedule,
    selected: false,
    reasons: [...new Set(reasons)],
  };
}

function chooseSources(params: {
  registry: AoiEnvironmentSourceRegistry;
  state: AoiAutonomySchedulerState;
  budget: AoiAutonomyWakeupBudget;
  reason: AoiAutonomyWakeupReason;
  sourceIds?: string[];
  now: number;
}): SourceDecision[] {
  const scheduleMap = new Map(params.state.sourceSchedules.map((item) => [item.sourceId, item]));
  const requestedSourceIds =
    params.sourceIds && params.sourceIds.length > 0
      ? normalizeStringList(params.sourceIds, 48)
      : params.registry.sources.map((source) => source.id);
  const decisions = requestedSourceIds.map((sourceId) =>
    buildSourceDecision({
      sourceId,
      registry: params.registry,
      scheduleMap,
      budget: params.budget,
      reason: params.reason,
      now: params.now,
    }),
  );
  let selectedCount = 0;
  return decisions.map((decision) => {
    if (decision.reasons.length > 0) {
      return decision;
    }
    if (selectedCount >= params.budget.maxSourceCount) {
      return {
        ...decision,
        reasons: ['max_source_count_reached'],
      };
    }
    selectedCount += 1;
    return {
      ...decision,
      selected: true,
    };
  });
}

function registryForSelectedSources(
  registry: AoiEnvironmentSourceRegistry,
  selectedSourceIds: Set<string>,
): AoiEnvironmentSourceRegistry {
  return {
    ...registry,
    sources: registry.sources.map((source) =>
      selectedSourceIds.has(source.id)
        ? source
        : {
            ...source,
            enabled: false,
          },
    ),
  };
}

function isWorkspaceSource(sourceId: string): boolean {
  return sourceId === 'workspace-git' || sourceId === 'workspace-build';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(message));
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function recordTimelineBestEffort(sessionsDir: string, event: AoiOperatorTimelineEventInput): void {
  try {
    recordAoiOperatorTimelineEvent(sessionsDir, event);
  } catch {
    // Timeline is diagnostic only; wakeup state remains authoritative.
  }
}

function buildStateWithRecord(params: {
  previous: AoiAutonomySchedulerState;
  record: AoiAutonomyWakeupRecord;
  scheduleUpdates: AoiAutonomySourceSchedule[];
}): AoiAutonomySchedulerState {
  const scoutBudget = normalizeProactiveScoutBudgetState(
    params.previous.proactiveScoutBudget,
    params.record.completedAt,
  );
  const scoutRan =
    params.record.proactiveScout?.status === 'scouted' ||
    params.record.proactiveScout?.status === 'no_candidate' ||
    params.record.proactiveScout?.status === 'failed';
  const nextScoutBudget: AoiProactiveBriefScoutBudgetState = scoutRan
    ? {
        ...scoutBudget,
        runsToday: scoutBudget.runsToday + 1,
        runsThisSession: scoutBudget.runsThisSession + 1,
        updatedAt: params.record.completedAt,
      }
    : {
        ...scoutBudget,
        updatedAt: params.record.completedAt,
      };
  return {
    ...params.previous,
    version: 1,
    updatedAt: params.record.completedAt,
    wakeupCount: params.previous.wakeupCount + 1,
    lastWakeupAt: params.record.completedAt,
    lastWakeupReason: params.record.reason,
    lastWakeupStatus: params.record.status,
    nextAllowedWakeupAt: params.record.completedAt + params.record.budget.wakeupCooldownMs,
    proactiveScoutBudget: nextScoutBudget,
    sourceSchedules: mergeSchedules(params.previous.sourceSchedules, params.scheduleUpdates),
    recentWakeups: [params.record, ...params.previous.recentWakeups].slice(0, MAX_RECENT_WAKEUPS),
  };
}

function recordWakeupTimeline(params: {
  sessionsDir: string;
  record: AoiAutonomyWakeupRecord;
}): void {
  recordTimelineBestEffort(params.sessionsDir, {
    sessionPath: params.record.sessionPath,
    kind: 'wakeup_recorded',
    visibility: params.record.ok ? 'dashboard_only' : 'operator_visible',
    createdAt: params.record.completedAt,
    title: `Wakeup ${params.record.status}`,
    summary: `Wakeup ${params.record.reason} ${params.record.status}: ${params.record.refreshedSourceIds.length} source(s), ${params.record.proposalsCreated} proposal(s).`,
    evidenceRefs: [`wakeup:${params.record.id}`],
    relatedRefs: [
      ...params.record.selectedSourceIds.map((sourceId) => `environment-source:${sourceId}`),
      ...params.record.refreshedSourceIds.map((sourceId) => `environment-source:${sourceId}`),
    ],
    status: params.record.status,
    metrics: {
      durationMs: params.record.durationMs,
      refreshedSourceCount: params.record.refreshedSourceIds.length,
      skippedSourceCount: params.record.skippedSources.length,
      proposalsCreated: params.record.proposalsCreated,
    },
    metadata: {
      reason: params.record.reason,
      tickReason: params.record.tickReason,
      tickRan: params.record.tickRan,
      tickSkipped: params.record.tickSkipped,
      quietMode: params.record.budget.quietMode,
      warnings: params.record.warnings,
      proactiveScoutStatus: params.record.proactiveScout?.status,
      proactiveScoutReasons: params.record.proactiveScout?.blockedReasons,
      proactiveScoutCandidates: params.record.proactiveScout?.createdCandidateCount,
    },
  });
}

function recordSourceTimeline(params: {
  sessionsDir: string;
  sessionPath: string;
  decision: SourceDecision;
  refreshed: boolean;
  now: number;
  reasons?: string[];
}): void {
  const reasons = params.reasons ?? params.decision.reasons;
  recordTimelineBestEffort(params.sessionsDir, {
    sessionPath: params.sessionPath,
    kind: params.refreshed ? 'source_selected' : 'source_suppressed',
    visibility: params.refreshed ? 'dashboard_only' : 'hidden',
    createdAt: params.now,
    title: params.refreshed
      ? `Wakeup refreshed ${params.decision.sourceId}`
      : `Wakeup skipped ${params.decision.sourceId}`,
    summary: params.refreshed
      ? `Scheduler refreshed source ${params.decision.sourceId}.`
      : `Scheduler skipped source ${params.decision.sourceId}: ${reasons.join(', ') || 'not selected'}.`,
    sourceRef: `environment-source:${params.decision.sourceId}`,
    sourceKind: params.decision.source?.kind ?? 'unknown',
    evidenceRefs: [`environment-source:${params.decision.sourceId}`],
    relatedRefs: [`environment-source:${params.decision.sourceId}`],
    metadata: {
      operation: params.decision.operation,
      reasons,
    },
  });
}

function isCurrentInfoProviderConfigured(params: {
  configFile?: string;
  dependencies: AoiAutonomySchedulerDependencies;
}): boolean {
  if (params.dependencies.currentInfoProviderConfigured) {
    return params.dependencies.currentInfoProviderConfigured(params.configFile ?? '');
  }
  return Boolean(loadAoiResearchTavilyConfig(params.configFile ?? ''));
}

function activeProactiveScoutCooldownReason(params: {
  state: AoiAutonomySchedulerState;
  controls: NonNullable<ReturnType<typeof loadAoiAutonomyPolicy>['proactiveBriefing']>;
  now: number;
}): string | null {
  const previousRun = params.state.recentWakeups.find(
    (record) =>
      record.proactiveScout?.status === 'scouted' ||
      record.proactiveScout?.status === 'no_candidate' ||
      record.proactiveScout?.status === 'failed',
  );
  if (!previousRun?.proactiveScout || params.controls.minScoutCooldownMs <= 0) {
    return null;
  }
  return previousRun.proactiveScout.completedAt + params.controls.minScoutCooldownMs > params.now
    ? 'scout_cooldown_active'
    : null;
}

function scoutBudgetReasons(params: {
  budgetState: AoiProactiveBriefScoutBudgetState;
  controls: NonNullable<ReturnType<typeof loadAoiAutonomyPolicy>['proactiveBriefing']>;
}): string[] {
  const reasons: string[] = [];
  if (params.controls.maxScoutRunsPerDay <= 0) {
    reasons.push('scout_daily_budget_zero');
  } else if (params.budgetState.runsToday >= params.controls.maxScoutRunsPerDay) {
    reasons.push('scout_daily_budget_exhausted');
  }
  if (params.controls.maxScoutRunsPerSession <= 0) {
    reasons.push('scout_session_budget_zero');
  } else if (params.budgetState.runsThisSession >= params.controls.maxScoutRunsPerSession) {
    reasons.push('scout_session_budget_exhausted');
  }
  return reasons;
}

function sourceHostControlLists(
  controls: NonNullable<ReturnType<typeof loadAoiAutonomyPolicy>['proactiveBriefing']>,
): { allowedSourceHosts: string[]; mutedSourceHosts: string[] } {
  const controlsList = Object.values(controls.sourceHostControls);
  return {
    allowedSourceHosts: controlsList
      .filter((control) => control.allowed === true && control.muted !== true)
      .map((control) => control.host),
    mutedSourceHosts: controlsList
      .filter((control) => control.muted === true || control.allowed === false)
      .map((control) => control.host),
  };
}

function proactiveScoutControlSnapshot(params: {
  controls: NonNullable<ReturnType<typeof loadAoiAutonomyPolicy>['proactiveBriefing']>;
  quietWindowActive: boolean;
}): NonNullable<AoiProactiveBriefSchedulerRunRecord['controlSnapshot']> {
  const topicControls = Object.values(params.controls.topicControls);
  const sourceHostControls = Object.values(params.controls.sourceHostControls);
  return {
    version: 1,
    enabled: params.controls.enabled,
    allowBackgroundScout: params.controls.allowBackgroundScout,
    directChatHookOptIn: params.controls.directChatHookOptIn,
    quietWindowEnabled: params.controls.quietWindow.enabled,
    quietWindowActive: params.quietWindowActive,
    maxScoutRunsPerDay: params.controls.maxScoutRunsPerDay,
    maxScoutRunsPerSession: params.controls.maxScoutRunsPerSession,
    maxTopicsPerWakeup: params.controls.maxTopicsPerWakeup,
    maxNetworkCallsPerWakeup: params.controls.maxNetworkCallsPerWakeup,
    minScoutCooldownMs: params.controls.minScoutCooldownMs,
    maxSessionIdleMs: params.controls.maxSessionIdleMs,
    topicControlCount: topicControls.length,
    allowedTopicCount: topicControls.filter(
      (control) => control.allowed === true && control.muted !== true,
    ).length,
    mutedTopicCount: topicControls.filter(
      (control) => control.muted === true || control.allowed === false,
    ).length,
    sourceHostControlCount: sourceHostControls.length,
    allowedSourceHostCount: sourceHostControls.filter(
      (control) => control.allowed === true && control.muted !== true,
    ).length,
    mutedSourceHostCount: sourceHostControls.filter(
      (control) => control.muted === true || control.allowed === false,
    ).length,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function proactiveScoutFieldEventKind(
  status: AoiProactiveBriefSchedulerRunRecord['status'],
  reasons: string[],
): Parameters<typeof recordAoiProactiveBriefFieldEvent>[1]['kind'] {
  if (status === 'no_candidate') {
    return 'suppressed_no_topics';
  }
  if (reasons.some((reason) => reason.includes('quiet'))) {
    return 'suppressed_quiet_mode';
  }
  if (reasons.some((reason) => reason.includes('cooldown'))) {
    return 'suppressed_cooldown';
  }
  if (reasons.some((reason) => reason.includes('topic') || reason.includes('profile_empty'))) {
    return 'suppressed_no_topics';
  }
  return 'suppressed_budget';
}

function recordProactiveScoutFieldEvent(params: {
  sessionsDir: string;
  sessionPath: string;
  record: AoiProactiveBriefSchedulerRunRecord;
  now: number;
}): void {
  if (!params.record.requested) {
    return;
  }
  const reasons =
    params.record.blockedReasons.length > 0
      ? params.record.blockedReasons
      : params.record.warnings.length > 0
        ? params.record.warnings
        : [`scheduler_${params.record.status}`];
  try {
    recordAoiProactiveBriefFieldEvent(params.sessionsDir, {
      sessionPath: params.sessionPath,
      kind: proactiveScoutFieldEventKind(params.record.status, reasons),
      policyReason: `scheduler:${params.record.status}`,
      suppressionReasons: reasons,
      title: 'Scheduler proactive scout decision',
      summary:
        params.record.status === 'no_candidate'
          ? 'Scheduler checked allowed current-info sources but did not create a candidate.'
          : `Scheduler did not run proactive scout: ${reasons.join(', ')}.`,
      evidenceRefs: params.record.evidenceRefs,
      freshness: {
        searchedAt:
          params.record.status === 'scouted' || params.record.status === 'no_candidate'
            ? params.record.completedAt
            : undefined,
        cannotKnow: params.record.providerConfigured
          ? []
          : [
              'Aoi could not check current information because no approved provider was configured.',
            ],
        stale: false,
      },
      dedupeKey: `scheduler:proactive-scout:${params.record.completedAt}:${params.record.status}:${reasons.join('|')}`,
      createdAt: params.now,
    });
  } catch {
    // Field events are diagnostic; scheduler state remains authoritative.
  }
}

async function runProactiveScoutForWakeup(params: {
  input: AoiAutonomyWakeupInput;
  dependencies: AoiAutonomySchedulerDependencies;
  previousState: AoiAutonomySchedulerState;
  startedAt: number;
  now: number;
  budget: AoiAutonomyWakeupBudget;
}): Promise<AoiProactiveBriefSchedulerRunRecord> {
  const sessionPath =
    normalizeAoiAutonomySessionPath(params.input.sessionPath) ?? params.input.sessionPath;
  const policy = loadAoiAutonomyPolicy(params.input.sessionsDir, sessionPath);
  const controls = policy.proactiveBriefing;
  const runNow = params.input.proactiveScout?.runNow === true;
  const background = !runNow;
  const profile = applyAoiProactiveBriefingTopicControls(
    loadAoiInterestProfile(params.input.sessionsDir, sessionPath, params.now),
    controls,
  );
  const providerConfigured = isCurrentInfoProviderConfigured({
    configFile: params.input.configFile,
    dependencies: params.dependencies,
  });
  const scoutBudget = normalizeProactiveScoutBudgetState(
    params.previousState.proactiveScoutBudget,
    params.now,
  );
  // P3-1: the auto (background) scout's network calls draw from a persistent, fail-closed
  // daily budget (separate from the run-count caps). Rolled here when the budget is
  // checked; recorded + saved after a successful scout. A manual run is exempt.
  let scoutNetworkBudgetState: AoiScoutNetworkBudgetState | null = null;
  const requested =
    runNow ||
    controls.allowBackgroundScout ||
    controls.enabled ||
    policy.proactiveSuggestionsEnabled ||
    profile.topics.length > 0;
  const budgetSnapshot = {
    dayKey: scoutBudget.dayKey,
    runsToday: scoutBudget.runsToday,
    maxRunsPerDay: controls.maxScoutRunsPerDay,
    runsThisSession: scoutBudget.runsThisSession,
    maxRunsPerSession: controls.maxScoutRunsPerSession,
  };
  const quietWindowActive = isAoiProactiveBriefQuietWindowActive(controls, params.now);
  const controlSnapshot = proactiveScoutControlSnapshot({
    controls,
    quietWindowActive,
  });

  const makeRecord = (
    status: AoiProactiveBriefSchedulerRunRecord['status'],
    blockedReasons: string[],
    extra?: Partial<AoiProactiveBriefSchedulerRunRecord>,
  ): AoiProactiveBriefSchedulerRunRecord => ({
    version: 1,
    requested,
    runNow,
    background,
    status,
    provider: providerConfigured
      ? params.dependencies.runProactiveBriefScout
        ? 'test'
        : 'tavily'
      : 'none',
    providerConfigured,
    startedAt: params.startedAt,
    completedAt: params.now,
    createdCandidateCount: 0,
    skippedTopicCount: 0,
    sourceFreshnessCount: 0,
    topicIds: [],
    blockedReasons: [...new Set(blockedReasons)].slice(0, 24),
    warnings: [],
    budget: budgetSnapshot,
    controlSnapshot,
    evidenceRefs: ['scheduler:proactive-scout'],
    ...extra,
  });

  if (!requested) {
    return makeRecord('not_requested', []);
  }

  const blockedReasons: string[] = [];
  if (!policy.enabled) {
    blockedReasons.push('autonomy_policy_disabled');
  }
  if (!policy.proactiveSuggestionsEnabled) {
    blockedReasons.push('proactive_suggestions_disabled');
  }
  if (!controls.enabled) {
    blockedReasons.push('proactive_scouting_disabled');
  }
  if (background && !controls.allowBackgroundScout) {
    blockedReasons.push('background_scout_disabled');
  }
  if (
    background &&
    typeof params.input.userIdleMs === 'number' &&
    params.input.userIdleMs > controls.maxSessionIdleMs
  ) {
    blockedReasons.push('session_not_active_enough');
  }
  if (!params.budget.allowNetwork) {
    blockedReasons.push('network_budget_disabled');
  }
  // P3-1: the AUTONOMOUS scout path is bounded by a daily network-call budget; a manual
  // run is the user's own request and is exempt. Fail-closed: an exhausted budget blocks.
  if (background) {
    const networkBudgetCheck = checkAoiScoutNetworkBudget({
      state: loadAoiScoutNetworkBudgetState(params.input.sessionsDir, sessionPath),
      sessionPath,
      now: params.now,
      windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
      ceilingCalls: resolveAoiScoutNetworkCeiling(params.budget.scoutNetworkDailyBudget),
      estimatedCalls: Math.max(1, controls.maxNetworkCallsPerWakeup),
    });
    scoutNetworkBudgetState = networkBudgetCheck.rolledState;
    if (!networkBudgetCheck.allowed) {
      blockedReasons.push('scout_network_budget_exhausted');
    }
  }
  if (!providerConfigured) {
    blockedReasons.push('current_provider_missing');
  }
  blockedReasons.push(...scoutBudgetReasons({ budgetState: scoutBudget, controls }));
  const scoutCooldownReason = activeProactiveScoutCooldownReason({
    state: params.previousState,
    controls,
    now: params.now,
  });
  if (scoutCooldownReason) {
    blockedReasons.push(scoutCooldownReason);
  }
  const tuning = loadAoiProactiveBriefCalibrationTuning(
    params.input.sessionsDir,
    sessionPath,
    params.now,
  );
  if (tuning.unsafeLabelCount > 0) {
    blockedReasons.push('unsafe_label_blocker');
  }
  if (tuning.staleLabelCount > 0) {
    blockedReasons.push('stale_label_direct_chat_blocker');
  }

  if (profile.topics.length === 0) {
    blockedReasons.push('profile_empty');
  } else if (profile.topics.every((topic) => topic.muted)) {
    blockedReasons.push('all_topics_muted');
  }

  const cooldownState = loadAoiProactiveBriefCooldownState(
    params.input.sessionsDir,
    sessionPath,
    params.now,
  );
  const feedback = loadAoiProactiveBriefFeedback(params.input.sessionsDir, sessionPath);
  const plan = planAoiProactiveBriefTopics({
    profile,
    cooldownState,
    feedback,
    now: params.now,
    topicId: params.input.proactiveScout?.topicId,
    budget: {
      allowNetwork: true,
      quietMode: params.budget.quietMode || quietWindowActive,
      maxTopicsPerWakeup: controls.maxTopicsPerWakeup,
      maxNetworkCallsPerWakeup: controls.maxNetworkCallsPerWakeup,
      directChatHookOptIn: controls.directChatHookOptIn,
      globalCooldownMs: Math.max(controls.minScoutCooldownMs, 0),
      topicCooldownMs: Math.max(controls.minScoutCooldownMs, 0),
    },
  });
  if (
    plan.topics.length === 0 &&
    !blockedReasons.includes('profile_empty') &&
    !blockedReasons.includes('all_topics_muted')
  ) {
    blockedReasons.push(
      plan.skippedTopics[0]?.reason === 'global_cooldown_active' ||
        plan.skippedTopics[0]?.reason === 'topic_cooldown_active'
        ? 'proactive_brief_cooldown_active'
        : 'no_eligible_topics',
    );
  }

  if (blockedReasons.length > 0) {
    const record = makeRecord('blocked', blockedReasons, {
      topicIds: plan.topics.map((topic) => topic.topic.id),
      skippedTopicCount: plan.skippedTopics.length,
      warnings: [
        ...plan.warnings,
        ...(quietWindowActive ? ['quiet_window_active:direct_chat_suppressed'] : []),
      ].slice(0, 24),
      evidenceRefs: [
        'scheduler:proactive-scout',
        ...plan.skippedTopics.flatMap((topic) =>
          topic.topicId
            ? [`topic:${topic.topicId}:skipped:${topic.reason}`]
            : [`topic:skipped:${topic.reason}`],
        ),
      ].slice(0, 24),
    });
    recordProactiveScoutFieldEvent({
      sessionsDir: params.input.sessionsDir,
      sessionPath,
      record,
      now: params.now,
    });
    return record;
  }

  const runScout = params.dependencies.runProactiveBriefScout ?? runAoiProactiveBriefScout;
  const sourceControls = sourceHostControlLists(controls);
  let result: AoiProactiveBriefScoutResult;
  try {
    result = await runScout({
      sessionsDir: params.input.sessionsDir,
      sessionPath,
      configFile: params.input.configFile,
      now: params.now,
      topicId: params.input.proactiveScout?.topicId,
      mode: 'quick',
      budget: {
        allowNetwork: params.budget.allowNetwork,
        quietMode: params.budget.quietMode || quietWindowActive,
        maxTopicsPerWakeup: controls.maxTopicsPerWakeup,
        maxNetworkCallsPerWakeup: controls.maxNetworkCallsPerWakeup,
        globalCooldownMs: Math.max(controls.minScoutCooldownMs, 0),
        topicCooldownMs: Math.max(controls.minScoutCooldownMs, 0),
        directChatHookOptIn: controls.directChatHookOptIn,
        ...sourceControls,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'proactive scout failed';
    const record = makeRecord('failed', ['scout_failed'], {
      warnings: [message.slice(0, 180)],
    });
    recordProactiveScoutFieldEvent({
      sessionsDir: params.input.sessionsDir,
      sessionPath,
      record,
      now: params.now,
    });
    return record;
  }

  const createdCandidates = result.createdCandidates;
  for (const candidate of createdCandidates) {
    try {
      recordAoiProactiveBriefFieldEvent(params.input.sessionsDir, {
        sessionPath,
        kind: 'candidate_created',
        briefId: candidate.id,
        topicId: candidate.topicId,
        title: candidate.title,
        summary: candidate.hook,
        sourceRefs: candidate.sources.map((source) => source.url),
        sourceHosts: candidate.sources.map((source) => source.host),
        evidenceRefs: ['scheduler:proactive-scout', ...candidate.evidenceRefs],
        freshness: {
          searchedAt: candidate.freshness.searchedAt,
          newestSourceAt: candidate.freshness.newestSourceAt,
          cannotKnow: candidate.freshness.cannotKnow,
          stale: candidate.freshness.cannotKnow.some((item) =>
            /outside the freshness window|stale/i.test(item),
          ),
        },
        createdAt: params.now,
      });
    } catch {
      // Field events are diagnostic; stored candidates remain authoritative.
    }
  }

  const trendWarnings: string[] = [];
  let trendSnapshotCount = 0;
  let trendOpinionCardCount = 0;
  let trendDirectChatReadyCount = 0;
  const trendDeliveryModes: AoiProactiveBriefSchedulerRunRecord['trendDeliveryModes'] = {};
  let trendBlockedReasons: string[] = [];
  try {
    const fieldMetrics = loadAoiProactiveBriefFieldMetrics(
      params.input.sessionsDir,
      sessionPath,
      params.now,
    );
    // P3-2a: on the BACKGROUND path, an exhausted per-day direct-chat budget downgrades the
    // trend advisor's direct_chat decision to an inline card. A manual run is the user's own
    // request and is exempt. Read-only here; an offer is charged at the trend-delivery route.
    let directChatBudgetExhausted = false;
    if (background) {
      const directChatCheck = checkAoiDirectChatBudget({
        state: loadAoiDirectChatBudgetState(params.input.sessionsDir, sessionPath),
        sessionPath,
        now: params.now,
        windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
        ceilingCalls: resolveAoiDirectChatCeiling(params.budget.directChatDailyBudget),
        estimatedCalls: 1,
      });
      directChatBudgetExhausted = !directChatCheck.allowed;
    }
    const trendAdvisor = buildAoiProactiveTrendAdvisorState({
      sessionsDir: params.input.sessionsDir,
      sessionPath,
      policy,
      profile,
      candidates: createdCandidates,
      feedback,
      fieldMetrics,
      calibrationTuning: tuning,
      now: params.now,
      directChatBudgetExhausted,
    });
    trendSnapshotCount = trendAdvisor.snapshots.length;
    trendOpinionCardCount = trendAdvisor.opinionCards.length;
    trendDirectChatReadyCount = trendAdvisor.directChatHookCount;
    for (const card of trendAdvisor.opinionCards) {
      trendDeliveryModes[card.deliveryMode] = (trendDeliveryModes[card.deliveryMode] ?? 0) + 1;
    }
    trendBlockedReasons = [
      ...new Set(trendAdvisor.opinionCards.flatMap((card) => card.directChatBlockedReasons)),
    ].slice(0, 16);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'trend advisor update failed';
    trendWarnings.push(`trend_advisor_update_failed:${message.slice(0, 160)}`);
  }

  // P3-1: charge the auto scout's actual network searches (one source-freshness record per
  // search) against the daily budget. Best-effort: a write failure must not fail the scout.
  if (background && scoutNetworkBudgetState && result.sourceFreshness.length > 0) {
    try {
      saveAoiScoutNetworkBudgetState(
        params.input.sessionsDir,
        sessionPath,
        recordAoiScoutNetworkSpend(
          scoutNetworkBudgetState,
          params.now,
          result.sourceFreshness.length,
        ),
      );
    } catch {
      // Budget accounting is diagnostic; stored candidates remain authoritative.
    }
  }

  const status: AoiProactiveBriefSchedulerRunRecord['status'] =
    createdCandidates.length > 0 ? 'scouted' : 'no_candidate';
  const record = makeRecord(status, [], {
    createdCandidateCount: createdCandidates.length,
    skippedTopicCount: result.skippedTopics.length,
    sourceFreshnessCount: result.sourceFreshness.length,
    trendSnapshotCount,
    trendOpinionCardCount,
    trendDirectChatReadyCount,
    trendDeliveryModes,
    trendBlockedReasons,
    topicIds: [
      ...new Set([
        ...createdCandidates.map((candidate) => candidate.topicId),
        ...result.skippedTopics
          .map((topic) => topic.topicId)
          .filter((item): item is string => Boolean(item)),
      ]),
    ].slice(0, 24),
    warnings: [
      ...result.warnings,
      ...trendWarnings,
      ...(quietWindowActive ? ['quiet_window_active:direct_chat_suppressed'] : []),
      ...(controls.directChatHookOptIn ? [] : ['direct_chat_hook_opt_in_disabled']),
    ].slice(0, 24),
    evidenceRefs: [
      'scheduler:proactive-scout',
      ...createdCandidates.map((candidate) => `brief:${candidate.id}`),
      ...result.skippedTopics.flatMap((topic) =>
        topic.topicId
          ? [`topic:${topic.topicId}:skipped:${topic.reason}`]
          : [`topic:skipped:${topic.reason}`],
      ),
    ].slice(0, 24),
  });
  if (status === 'no_candidate') {
    recordProactiveScoutFieldEvent({
      sessionsDir: params.input.sessionsDir,
      sessionPath,
      record,
      now: params.now,
    });
  }
  return record;
}

async function runWakeupInternal(
  input: AoiAutonomyWakeupInput,
  startedAt: number,
  guard?: { cancelled: boolean },
): Promise<AoiAutonomyWakeupResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const dependencies = input.dependencies ?? {};
  const getNow = dependencies.now ?? (() => Date.now());
  const now = input.now ?? startedAt;
  const budget = normalizeBudget(input.budget, input.quietMode);
  const registry = loadAoiEnvironmentSourceRegistry(input.sessionsDir, sessionPath, now);
  const previousState = loadAoiAutonomySchedulerState(input.sessionsDir, sessionPath, now);
  const decisions = chooseSources({
    registry,
    state: previousState,
    budget,
    reason: input.reason,
    sourceIds: input.sourceIds,
    now,
  });
  const selectedDecisions = decisions.filter((decision) => decision.selected);
  const selectedSourceIds = selectedDecisions.map((decision) => decision.sourceId);
  const refreshedSourceIds = new Set<string>();
  const skippedSources: AoiAutonomyWakeupRecord['skippedSources'] = [];
  const scheduleUpdates: AoiAutonomySourceSchedule[] = [];
  const warnings: string[] = [];

  for (const decision of decisions.filter((item) => !item.selected)) {
    skippedSources.push({
      sourceId: decision.sourceId,
      reasons: decision.reasons.length > 0 ? decision.reasons : ['source_not_selected'],
    });
    scheduleUpdates.push(
      updateScheduleForDecision(decision, {
        now,
        refreshed: false,
      }),
    );
    recordSourceTimeline({
      sessionsDir: input.sessionsDir,
      sessionPath,
      decision,
      refreshed: false,
      now,
    });
  }

  const selectedSourceSet = new Set(selectedSourceIds);
  const workspaceDecisions = selectedDecisions.filter((decision) =>
    isWorkspaceSource(decision.sourceId),
  );
  if (workspaceDecisions.length > 0) {
    if (!input.workspaceRoot) {
      for (const decision of workspaceDecisions) {
        const reasons = ['workspace_root_missing'];
        skippedSources.push({ sourceId: decision.sourceId, reasons });
        scheduleUpdates.push(
          updateScheduleForDecision(decision, {
            now,
            refreshed: false,
            reasons,
          }),
        );
        recordSourceTimeline({
          sessionsDir: input.sessionsDir,
          sessionPath,
          decision,
          refreshed: false,
          now,
          reasons,
        });
      }
    } else {
      try {
        const collectWorkspaceSnapshot =
          dependencies.collectWorkspaceSnapshot ?? collectAndPersistAoiWorkspaceSnapshot;
        const snapshot = collectWorkspaceSnapshot({
          sessionsDir: input.sessionsDir,
          sessionPath,
          workspaceRoot: input.workspaceRoot,
          registry: registryForSelectedSources(registry, selectedSourceSet),
          now,
        });
        for (const decision of workspaceDecisions) {
          if (snapshot?.sourceIds.includes(decision.sourceId)) {
            refreshedSourceIds.add(decision.sourceId);
            scheduleUpdates.push(
              updateScheduleForDecision(decision, {
                now,
                refreshed: true,
              }),
            );
            recordSourceTimeline({
              sessionsDir: input.sessionsDir,
              sessionPath,
              decision,
              refreshed: true,
              now,
            });
          } else {
            const reasons = ['workspace_snapshot_unavailable'];
            skippedSources.push({ sourceId: decision.sourceId, reasons });
            scheduleUpdates.push(
              updateScheduleForDecision(decision, {
                now,
                refreshed: false,
                failed: true,
                reasons,
              }),
            );
            recordSourceTimeline({
              sessionsDir: input.sessionsDir,
              sessionPath,
              decision,
              refreshed: false,
              now,
              reasons,
            });
          }
        }
      } catch (error) {
        const reason =
          error instanceof Error
            ? `workspace_refresh_failed:${error.message}`
            : 'workspace_refresh_failed';
        for (const decision of workspaceDecisions) {
          const reasons = [reason];
          skippedSources.push({ sourceId: decision.sourceId, reasons });
          scheduleUpdates.push(
            updateScheduleForDecision(decision, {
              now,
              refreshed: false,
              failed: true,
              reasons,
            }),
          );
          recordSourceTimeline({
            sessionsDir: input.sessionsDir,
            sessionPath,
            decision,
            refreshed: false,
            now,
            reasons,
          });
        }
      }
    }
  }

  for (const decision of selectedDecisions.filter((item) => !isWorkspaceSource(item.sourceId))) {
    try {
      updateAoiEnvironmentSource(input.sessionsDir, sessionPath, {
        sourceId: decision.sourceId,
        patch: {
          lastObservedAt: now,
        },
        now,
      });
      refreshedSourceIds.add(decision.sourceId);
      scheduleUpdates.push(
        updateScheduleForDecision(decision, {
          now,
          refreshed: true,
        }),
      );
      recordSourceTimeline({
        sessionsDir: input.sessionsDir,
        sessionPath,
        decision,
        refreshed: true,
        now,
      });
    } catch (error) {
      const reasons = [
        error instanceof Error ? `source_refresh_failed:${error.message}` : 'source_refresh_failed',
      ];
      skippedSources.push({ sourceId: decision.sourceId, reasons });
      scheduleUpdates.push(
        updateScheduleForDecision(decision, {
          now,
          refreshed: false,
          failed: true,
          reasons,
        }),
      );
      recordSourceTimeline({
        sessionsDir: input.sessionsDir,
        sessionPath,
        decision,
        refreshed: false,
        now,
        reasons,
      });
    }
  }

  const runBackgroundTick = dependencies.runBackgroundTick ?? runAoiAutonomyBackgroundTick;
  const tickReason = mapWakeupReasonToTickReason(input.reason);
  // Resolve the embedding provider once (config aoiEmbedding block / env). Reused
  // for the tick's semantic query recall (network-gated below) and the best-effort
  // memory embed-persist after the tick. Null when no key is configured.
  const embeddingProvider = createServerAoiEmbeddingProvider({ configFile: input.configFile });
  let tickResult: AoiAutonomyTickResult | undefined;
  if (budget.maxBackgroundTickRuntimeMs <= 0) {
    warnings.push('background_tick_budget_zero');
  } else {
    try {
      tickResult = await withTimeout(
        runBackgroundTick({
          sessionsDir: input.sessionsDir,
          sessionPath,
          reason: tickReason,
          latestUserMessage: input.latestUserMessage,
          llmConfig: budget.allowNetwork ? (input.llmConfig ?? undefined) : undefined,
          // Server-capable reflection chat: the engine's default chat is the
          // browser client (relative /api/llm-proxy) which throws in the Node
          // loop. When network is allowed and a model is configured, route the
          // LLM reflection / brief / goal synthesis through the server-side
          // caller so it actually reaches the model (otherwise it silently falls
          // back to deterministic).
          reflectionChat:
            budget.allowNetwork && input.llmConfig
              ? createAoiAutonomyReflectionChat(input.serverOrigin, input.workspaceRoot)
              : undefined,
          // The trusted connector allow-list only matters when the LLM driver is
          // active (network allowed); it lets the driver propose a connector_call
          // for an allow-listed read-only tool. Loaded from the same config file
          // that is the live-RPC trust source.
          connectors: budget.allowNetwork
            ? loadAoiMcpConnectorsFromConfigFile(input.configFile ?? '')
            : undefined,
          // Semantic query recall also requires a network call to the embedding
          // provider, so it is gated on allowNetwork like the LLM driver.
          embeddingProvider: budget.allowNetwork ? embeddingProvider : undefined,
          maxRuntimeMs: budget.maxBackgroundTickRuntimeMs,
          minIntervalMs: budget.wakeupCooldownMs,
          quietMode: budget.quietMode,
          userIdleMs: input.userIdleMs,
          maxGeneratedProposals: budget.maxGeneratedProposalCount,
          // P1a c2: rolling daily token ceiling for LLM brief synthesis. Only
          // consumed when allowNetwork put an llmConfig in the tick above.
          llmDailyTokenBudget: budget.llmDailyTokenBudget,
          // P1a c4: explicit opt-in for LLM goal synthesis (on top of network).
          goalSynthesisEnabled: budget.goalSynthesisEnabled,
        }),
        budget.maxBackgroundTickRuntimeMs,
        'Aoi scheduler background tick exceeded runtime budget.',
      );
      warnings.push(...tickResult.warnings);
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : 'Aoi scheduler background tick failed.',
      );
    }
  }

  // Gated autonomy-level auto-promotion (roadmap 5b). OFF unless the operator opts
  // in via AOI_AUTONOMY_AUTO_PROMOTE=1; runs after the tick so it reflects the
  // latest readiness. Best-effort (maybeRun swallows its own errors and returns
  // null when disabled), so it never blocks or fails the wakeup.
  const levelPromotion = maybeRunAoiAutonomyLevelPromotion({
    sessionsDir: input.sessionsDir,
    sessionPath,
    now,
  });
  if (levelPromotion?.changed) {
    warnings.push(
      `autonomy_level_${levelPromotion.action}:${levelPromotion.previousLevel}->${levelPromotion.nextLevel}`,
    );
  }

  // Server-side memory embedding (best-effort): when an embedding key is configured
  // (config aoiEmbedding block or env), opportunistically embed a bounded batch of
  // un-embedded server memories so semantic recall has vectors to fuse. The key is
  // the opt-in -- no key means lexical-only, unchanged. Never blocks the wakeup.
  // (embeddingProvider was resolved once above and is reused here.)
  if (embeddingProvider) {
    try {
      await embedAndPersistServerAoiMemories(input.sessionsDir, embeddingProvider, { max: 16 });
    } catch {
      // best-effort; embeddings never block the wakeup
    }
  }

  const tickRan = Boolean(tickResult);
  const tickOk = tickResult?.ok ?? false;
  const tickSkipped = tickResult?.skipped ?? false;
  const runtimeBudgetFailed = warnings.some((warning) =>
    warning.includes('exceeded runtime budget'),
  );
  const tickFailed = tickResult?.ok === false;
  const recordOk = !runtimeBudgetFailed && !tickFailed;
  const proactiveScout = await runProactiveScoutForWakeup({
    input,
    dependencies,
    previousState,
    startedAt,
    now,
    budget,
  });
  const completedAt = input.now ?? getNow();
  const record: AoiAutonomyWakeupRecord = {
    version: 1,
    id: createAoiAutonomyId('aoi-wakeup', startedAt),
    sessionPath,
    reason: input.reason,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    ok: recordOk,
    status: !recordOk
      ? 'failed'
      : selectedSourceIds.length === 0 && !tickRan
        ? 'skipped'
        : 'completed',
    budget,
    selectedSourceIds,
    refreshedSourceIds: [...refreshedSourceIds],
    skippedSources,
    tickRan,
    tickSkipped,
    tickOk,
    tickReason,
    proposalsCreated: tickResult?.newActiveProposalCount ?? 0,
    observationsSeen: tickResult?.tickState.recentObservationCount ?? 0,
    warnings: [...new Set(warnings)].slice(0, 24),
    proactiveScout,
  };
  if (guard?.cancelled) {
    return {
      ok: false,
      sessionPath,
      record,
      state: previousState,
      status: buildAoiAutonomyStatus(input.sessionsDir, sessionPath, completedAt),
      ...(tickResult ? { tickResult } : {}),
    };
  }
  const state = saveAoiAutonomySchedulerState(
    input.sessionsDir,
    buildStateWithRecord({
      previous: previousState,
      record,
      scheduleUpdates,
    }),
  );
  recordWakeupTimeline({
    sessionsDir: input.sessionsDir,
    record,
  });
  return {
    ok: record.ok,
    sessionPath,
    record,
    state,
    status: buildAoiAutonomyStatus(input.sessionsDir, sessionPath, completedAt),
    ...(tickResult ? { tickResult } : {}),
  };
}

export async function runAoiAutonomyWakeup(
  input: AoiAutonomyWakeupInput,
): Promise<AoiAutonomyWakeupResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const dependencies = input.dependencies ?? {};
  const startedAt = input.now ?? dependencies.now?.() ?? Date.now();
  const guard = { cancelled: false };
  try {
    return await withTimeout(
      runWakeupInternal(
        {
          ...input,
          sessionPath,
        },
        startedAt,
        guard,
      ),
      normalizeBudget(input.budget, input.quietMode).maxSchedulerRuntimeMs,
      'Aoi scheduler exceeded runtime budget.',
    );
  } catch (error) {
    guard.cancelled = true;
    const completedAt = input.now ?? dependencies.now?.() ?? Date.now();
    const previousState = loadAoiAutonomySchedulerState(
      input.sessionsDir,
      sessionPath,
      completedAt,
    );
    const budget = normalizeBudget(input.budget, input.quietMode);
    const tickReason = mapWakeupReasonToTickReason(input.reason);
    const record: AoiAutonomyWakeupRecord = {
      version: 1,
      id: createAoiAutonomyId('aoi-wakeup', startedAt),
      sessionPath,
      reason: input.reason,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      ok: false,
      status: 'failed',
      budget,
      selectedSourceIds: [],
      refreshedSourceIds: [],
      skippedSources: [],
      tickRan: false,
      tickSkipped: false,
      tickOk: false,
      tickReason,
      proposalsCreated: 0,
      observationsSeen: 0,
      warnings: [error instanceof Error ? error.message : 'Aoi scheduler failed.'],
    };
    const state = saveAoiAutonomySchedulerState(
      input.sessionsDir,
      buildStateWithRecord({
        previous: previousState,
        record,
        scheduleUpdates: [],
      }),
    );
    recordWakeupTimeline({
      sessionsDir: input.sessionsDir,
      record,
    });
    return {
      ok: false,
      sessionPath,
      record,
      state,
      status: buildAoiAutonomyStatus(input.sessionsDir, sessionPath, completedAt),
    };
  }
}
