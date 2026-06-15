import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { checkAoiEnvironmentSourceOperation } from './aoiAutonomyPolicy';
import {
  runAoiAutonomyBackgroundTick,
  type AoiAutonomyBackgroundTickParams,
} from './aoiAutonomyEngine';
import {
  buildAoiAutonomyStatus,
  createAoiAutonomyId,
  loadAoiEnvironmentSourceRegistry,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import {
  collectAndPersistAoiWorkspaceSnapshot,
  type AoiWorkspaceSignalStoreInput,
} from './aoiWorkspaceSignals';
import {
  recordAoiOperatorTimelineEvent,
  type AoiOperatorTimelineEventInput,
} from './aoiOperatorTimeline';
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
};

export interface AoiAutonomyWakeupInput {
  sessionsDir: string;
  sessionPath: string;
  reason: AoiAutonomyWakeupReason;
  workspaceRoot?: string;
  latestUserMessage?: string;
  llmConfig?: LLMConfig | null;
  sourceIds?: string[];
  budget?: Partial<AoiAutonomyWakeupBudget>;
  quietMode?: boolean;
  userIdleMs?: number;
  now?: number;
  dependencies?: AoiAutonomySchedulerDependencies;
}

export interface AoiAutonomySchedulerDependencies {
  now?: () => number;
  collectWorkspaceSnapshot?: (input: AoiWorkspaceSignalStoreInput) => AoiWorkspaceSnapshot | null;
  runBackgroundTick?: (params: AoiAutonomyBackgroundTickParams) => Promise<AoiAutonomyTickResult>;
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
    value === 'health_check'
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
  if (reason === 'source_ttl_expired' || reason === 'health_check') {
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
    ? record.skippedSources
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
  return {
    ...params.previous,
    version: 1,
    updatedAt: params.record.completedAt,
    wakeupCount: params.previous.wakeupCount + 1,
    lastWakeupAt: params.record.completedAt,
    lastWakeupReason: params.record.reason,
    lastWakeupStatus: params.record.status,
    nextAllowedWakeupAt: params.record.completedAt + params.record.budget.wakeupCooldownMs,
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
          maxRuntimeMs: budget.maxBackgroundTickRuntimeMs,
          minIntervalMs: budget.wakeupCooldownMs,
          quietMode: budget.quietMode,
          userIdleMs: input.userIdleMs,
          maxGeneratedProposals: budget.maxGeneratedProposalCount,
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

  const completedAt = input.now ?? getNow();
  const tickRan = Boolean(tickResult);
  const tickOk = tickResult?.ok ?? false;
  const tickSkipped = tickResult?.skipped ?? false;
  const runtimeBudgetFailed = warnings.some((warning) =>
    warning.includes('exceeded runtime budget'),
  );
  const tickFailed = tickResult?.ok === false;
  const recordOk = !runtimeBudgetFailed && !tickFailed;
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
