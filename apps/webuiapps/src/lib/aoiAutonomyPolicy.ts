import type {
  AoiAutonomyLevel,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiAutonomyToolPolicy,
  AoiEnvironmentSource,
  AoiEnvironmentSourceKind,
  AoiEnvironmentSourceOperation,
  AoiEnvironmentSourcePolicyCheckResult,
  AoiEnvironmentSourceQuietModeBehavior,
  AoiEnvironmentSourceRegistry,
  AoiEnvironmentSourceScope,
  AoiPersonalSignalSourceKind,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalExecutionPolicyContext,
  AoiProposalExecutionPolicyResult,
  AoiProposalFeedbackCategory,
  AoiProposalPolicyCheckInput,
  AoiProposalPolicyCheckResult,
  AoiProactiveBriefSchedulerControls,
  AoiProactiveBriefSourceHostControl,
  AoiProactiveBriefTopicControl,
  AoiInterestProfile,
} from './aoiAutonomyTypes';
import {
  collectAoiKiraHandoffScopeReasons,
  getAoiKiraSafeNarrowingSuggestion,
} from './aoiKiraHandoff';
import {
  compareAoiApprovedCommandApproval,
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
  normalizeAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import {
  compareAoiApprovedFileMutationApproval,
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
  normalizeAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import {
  compareAoiApprovedAppActionApproval,
  createAoiApprovedAppActionRequest,
  evaluateAoiApprovedAppActionPolicy,
  normalizeAoiApprovedAppActionPolicy,
} from './aoiApprovedAppActionPolicy';
import {
  compareAoiApprovedConnectorCallApproval,
  createAoiApprovedConnectorCallRequest,
  evaluateAoiApprovedConnectorCallPolicy,
  normalizeAoiApprovedConnectorCallPolicy,
} from './aoiApprovedConnectorCallPolicy';
import type { AoiMcpConnectorsConfig } from './aoiMcpConnectorRegistry';
import { applyAoiTrustCalibration } from './aoiTrustCalibration';

export const AOI_AUTONOMY_LEVEL_ORDER: Record<AoiAutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

export const AOI_ENVIRONMENT_SOURCE_KINDS: readonly AoiEnvironmentSourceKind[] = [
  'workspace_git',
  'workspace_build',
  'kira_board',
  'research_runs',
  'app_state',
  'browser_context',
  'manual_note',
  'calendar_metadata',
  'gmail_metadata',
  'notes_metadata',
];

export const AOI_ENVIRONMENT_SOURCE_OPERATIONS: readonly AoiEnvironmentSourceOperation[] = [
  'summarize',
  'status',
  'diff',
  'read_metadata',
  'summarize_counts',
];

export const AOI_ENVIRONMENT_SOURCE_SCOPES: readonly AoiEnvironmentSourceScope[] = [
  'session',
  'project',
  'workspace',
  'explicit_target',
];

export const AOI_ENVIRONMENT_SOURCE_QUIET_MODE_BEHAVIORS: readonly AoiEnvironmentSourceQuietModeBehavior[] =
  ['record_only', 'suppress'];

export const AOI_PERSONAL_SIGNAL_SOURCE_KINDS: readonly AoiPersonalSignalSourceKind[] = [
  'calendar_metadata',
  'gmail_metadata',
  'notes_metadata',
];

const DEFAULT_AOI_ENVIRONMENT_SOURCES: readonly Omit<
  AoiEnvironmentSource,
  'version' | 'updatedAt' | 'lastObservedAt' | 'lastReviewedAt' | 'consentReason'
>[] = [
  {
    id: 'workspace-git',
    kind: 'workspace_git',
    label: 'Workspace git status',
    enabled: false,
    scope: 'workspace',
    risk: 'medium',
    allowedOperations: ['summarize', 'status', 'diff', 'read_metadata'],
    privateByDefault: false,
    quietModeBehavior: 'record_only',
  },
  {
    id: 'workspace-build',
    kind: 'workspace_build',
    label: 'Workspace validation state',
    enabled: false,
    scope: 'workspace',
    risk: 'medium',
    allowedOperations: ['summarize', 'status', 'read_metadata'],
    privateByDefault: false,
    quietModeBehavior: 'record_only',
  },
  {
    id: 'kira-board',
    kind: 'kira_board',
    label: 'Kira reviewed work',
    enabled: true,
    scope: 'project',
    risk: 'medium',
    allowedOperations: ['summarize', 'status', 'read_metadata'],
    privateByDefault: false,
    quietModeBehavior: 'record_only',
  },
  {
    id: 'research-runs',
    kind: 'research_runs',
    label: 'Aoi research runs',
    enabled: true,
    scope: 'session',
    risk: 'low',
    allowedOperations: ['summarize', 'status', 'read_metadata'],
    privateByDefault: false,
    quietModeBehavior: 'record_only',
  },
  {
    id: 'app-state',
    kind: 'app_state',
    label: 'OpenRoom app state',
    enabled: true,
    scope: 'session',
    risk: 'low',
    allowedOperations: ['summarize', 'status', 'read_metadata'],
    privateByDefault: false,
    quietModeBehavior: 'record_only',
  },
  {
    id: 'browser-context',
    kind: 'browser_context',
    label: 'Explicit browser page context',
    enabled: false,
    scope: 'explicit_target',
    risk: 'high',
    allowedOperations: ['summarize', 'read_metadata'],
    privateByDefault: true,
    quietModeBehavior: 'suppress',
  },
  {
    id: 'manual-note',
    kind: 'manual_note',
    label: 'Manual user notes',
    enabled: true,
    scope: 'session',
    risk: 'low',
    allowedOperations: ['summarize', 'read_metadata'],
    privateByDefault: false,
    quietModeBehavior: 'record_only',
  },
  {
    id: 'calendar-metadata',
    kind: 'calendar_metadata',
    label: 'Calendar metadata',
    enabled: false,
    scope: 'explicit_target',
    risk: 'medium',
    allowedOperations: ['status', 'read_metadata', 'summarize_counts'],
    privateByDefault: false,
    quietModeBehavior: 'suppress',
  },
  {
    id: 'gmail-metadata',
    kind: 'gmail_metadata',
    label: 'Gmail metadata',
    enabled: false,
    scope: 'explicit_target',
    risk: 'high',
    allowedOperations: ['status', 'read_metadata', 'summarize_counts'],
    privateByDefault: true,
    quietModeBehavior: 'suppress',
  },
  {
    id: 'notes-metadata',
    kind: 'notes_metadata',
    label: 'Notes metadata',
    enabled: false,
    scope: 'explicit_target',
    risk: 'high',
    allowedOperations: ['status', 'read_metadata', 'summarize_counts'],
    privateByDefault: true,
    quietModeBehavior: 'suppress',
  },
];

export const DEFAULT_AOI_PROACTIVE_BRIEFING_CONTROLS: AoiProactiveBriefSchedulerControls = {
  version: 1,
  enabled: false,
  allowBackgroundScout: false,
  maxScoutRunsPerDay: 3,
  maxScoutRunsPerSession: 5,
  maxTopicsPerWakeup: 1,
  maxNetworkCallsPerWakeup: 1,
  minScoutCooldownMs: 30 * 60 * 1000,
  maxSessionIdleMs: 30 * 60 * 1000,
  quietWindow: {
    version: 1,
    enabled: false,
    startMinuteOfDay: 22 * 60,
    endMinuteOfDay: 8 * 60,
  },
  directChatHookOptIn: false,
  topicControls: {},
  sourceHostControls: {},
};

export const DEFAULT_AOI_AUTONOMY_POLICY: AoiAutonomyPolicy = {
  version: 1,
  enabled: false,
  previewMode: true,
  level: 'L1',
  proactiveSuggestionsEnabled: false,
  confidenceFloor: 0.55,
  maxActiveProposals: 8,
  maxProposalsPerTick: 3,
  maxProposalsPerDay: 10,
  defaultCooldownMs: 6 * 60 * 60 * 1000,
  defaultSnoozeMs: 4 * 60 * 60 * 1000,
  duplicateCheckEnabled: true,
  cooldownCheckEnabled: true,
  proactiveBriefing: DEFAULT_AOI_PROACTIVE_BRIEFING_CONTROLS,
  requireEvidenceRefs: true,
  requireApprovalForHighRisk: true,
  updatedAt: 0,
};

const DEFAULT_BLOCKED_TOOL_POLICY: AoiAutonomyToolPolicy = {
  toolName: '*',
  maxLevel: 'L5',
  requiresApproval: true,
  blocked: true,
};

const AOI_AUTONOMY_TOOL_POLICIES: Record<string, AoiAutonomyToolPolicy> = {
  open_research_artifact: {
    toolName: 'open_research_artifact',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  get_research_status: {
    toolName: 'get_research_status',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  read_research_artifact: {
    toolName: 'read_research_artifact',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  start_research: {
    toolName: 'start_research',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  cancel_research: {
    toolName: 'cancel_research',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  workspace_search: {
    toolName: 'workspace_search',
    maxLevel: 'L3',
    requiresApproval: false,
  },
  preview_changes: {
    toolName: 'preview_changes',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  workspace_checkpoint: {
    toolName: 'workspace_checkpoint',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  save_memory: {
    toolName: 'save_memory',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  create_kira_work: {
    toolName: 'create_kira_work',
    maxLevel: 'L4',
    requiresApproval: true,
  },
  file_write: {
    toolName: 'file_write',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  file_patch: {
    toolName: 'file_patch',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  file_delete: {
    toolName: 'file_delete',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  app_action: {
    toolName: 'app_action',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
  run_command: {
    toolName: 'run_command',
    maxLevel: 'L5',
    requiresApproval: true,
    blocked: true,
  },
};

const EXECUTABLE_PROPOSAL_ACTIONS = new Set([
  'open_research_artifact',
  'read_research_artifact',
  'get_research_status',
  'start_research',
  'save_memory',
  'create_kira_work',
  'run_command',
  'file_write',
  'file_patch',
  'file_delete',
  'app_action',
  'connector_call',
]);

const FILE_MUTATION_PROPOSAL_ACTIONS = new Set(['file_write', 'file_patch', 'file_delete']);

const APP_ACTION_PROPOSAL_ACTIONS = new Set(['app_action']);

const CONNECTOR_CALL_PROPOSAL_ACTIONS = new Set(['connector_call']);

function fileMutationOperationFromActionKind(
  kind: string | undefined,
): 'write' | 'patch' | 'delete' {
  if (kind === 'file_patch') {
    return 'patch';
  }
  if (kind === 'file_delete') {
    return 'delete';
  }
  return 'write';
}

const READ_ONLY_PROPOSAL_ACTIONS = new Set([
  'open_research_artifact',
  'read_research_artifact',
  'get_research_status',
]);

const FRESH_ACCEPTANCE_MS = 10 * 60 * 1000;
const FILESYSTEM_PATH_KEY_PATTERN = /(?:^|_)(?:path|file|dir|directory|cwd|command)(?:$|_)/i;
const WINDOWS_PATH_PATTERN = /(?:[a-zA-Z]:\\|\\\\)[^\s'"`<>|]*/;
const UNIX_PATH_PATTERN =
  /(?:^|\s)(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace|etc|root)\/|~\/|\.\.\/)/;
const WRONG_MEMORY_CONFIDENCE_PENALTY = 0.18;
const USEFUL_FEEDBACK_CONFIDENCE_BOOST = 0.04;
const MAX_USEFUL_FEEDBACK_BOOST = 0.08;
const TOO_FREQUENT_COOLDOWN_MULTIPLIER_LIMIT = 4;

export const AOI_PROPOSAL_FEEDBACK_CATEGORIES: readonly AoiProposalFeedbackCategory[] = [
  'useful',
  'not_useful',
  'wrong_memory',
  'wrong_evidence',
  'wrong_source',
  'stale',
  'too_frequent',
  'too_much',
  'wrong_timing',
  'unsafe',
  'already_done',
  'needs_more_detail',
];

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeControlKey(value: unknown, maxLength = 120): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function normalizeHostControlKey(value: unknown): string {
  return normalizeControlKey(value, 160).toLowerCase();
}

function normalizeMinuteOfDay(value: unknown, fallback: number): number {
  return Math.round(clampNumber(value, fallback, 0, 24 * 60 - 1));
}

function normalizeProactiveBriefQuietWindow(
  value: unknown,
  fallback: AoiProactiveBriefSchedulerControls['quietWindow'],
): AoiProactiveBriefSchedulerControls['quietWindow'] {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiProactiveBriefSchedulerControls['quietWindow']>)
      : {};
  return {
    version: 1,
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    startMinuteOfDay: normalizeMinuteOfDay(raw.startMinuteOfDay, fallback.startMinuteOfDay),
    endMinuteOfDay: normalizeMinuteOfDay(raw.endMinuteOfDay, fallback.endMinuteOfDay),
  };
}

function normalizeProactiveBriefTopicControls(
  value: unknown,
  fallback: Record<string, AoiProactiveBriefTopicControl>,
  now: number,
): Record<string, AoiProactiveBriefTopicControl> {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Partial<AoiProactiveBriefTopicControl>>)
      : fallback;
  const out: Record<string, AoiProactiveBriefTopicControl> = {};
  for (const [key, item] of Object.entries(raw).slice(0, 80)) {
    const topicId = normalizeControlKey(item?.topicId ?? key);
    if (!topicId) {
      continue;
    }
    const previous = fallback[topicId];
    out[topicId] = {
      version: 1,
      topicId,
      allowed: normalizeBoolean(item?.allowed, previous?.allowed ?? true),
      muted: normalizeBoolean(item?.muted, previous?.muted ?? false),
      pinned: normalizeBoolean(item?.pinned, previous?.pinned ?? false),
      updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : now,
    };
  }
  return out;
}

function normalizeProactiveBriefSourceHostControls(
  value: unknown,
  fallback: Record<string, AoiProactiveBriefSourceHostControl>,
  now: number,
): Record<string, AoiProactiveBriefSourceHostControl> {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, Partial<AoiProactiveBriefSourceHostControl>>)
      : fallback;
  const out: Record<string, AoiProactiveBriefSourceHostControl> = {};
  for (const [key, item] of Object.entries(raw).slice(0, 80)) {
    const host = normalizeHostControlKey(item?.host ?? key);
    if (!host) {
      continue;
    }
    const previous = fallback[host];
    out[host] = {
      version: 1,
      host,
      allowed: normalizeBoolean(item?.allowed, previous?.allowed ?? true),
      muted: normalizeBoolean(item?.muted, previous?.muted ?? false),
      updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : now,
    };
  }
  return out;
}

export function normalizeAoiProactiveBriefingControls(
  value: unknown,
  fallback: AoiProactiveBriefSchedulerControls = DEFAULT_AOI_PROACTIVE_BRIEFING_CONTROLS,
  now = Date.now(),
): AoiProactiveBriefSchedulerControls {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiProactiveBriefSchedulerControls>)
      : {};
  return {
    version: 1,
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    allowBackgroundScout: normalizeBoolean(raw.allowBackgroundScout, fallback.allowBackgroundScout),
    maxScoutRunsPerDay: Math.round(
      clampNumber(raw.maxScoutRunsPerDay, fallback.maxScoutRunsPerDay, 0, 24),
    ),
    maxScoutRunsPerSession: Math.round(
      clampNumber(raw.maxScoutRunsPerSession, fallback.maxScoutRunsPerSession, 0, 48),
    ),
    maxTopicsPerWakeup: Math.round(
      clampNumber(raw.maxTopicsPerWakeup, fallback.maxTopicsPerWakeup, 0, 5),
    ),
    maxNetworkCallsPerWakeup: Math.round(
      clampNumber(raw.maxNetworkCallsPerWakeup, fallback.maxNetworkCallsPerWakeup, 0, 5),
    ),
    minScoutCooldownMs: Math.round(
      clampNumber(raw.minScoutCooldownMs, fallback.minScoutCooldownMs, 0, 24 * 60 * 60 * 1000),
    ),
    maxSessionIdleMs: Math.round(
      clampNumber(raw.maxSessionIdleMs, fallback.maxSessionIdleMs, 60_000, 24 * 60 * 60 * 1000),
    ),
    quietWindow: normalizeProactiveBriefQuietWindow(raw.quietWindow, fallback.quietWindow),
    directChatHookOptIn: normalizeBoolean(raw.directChatHookOptIn, fallback.directChatHookOptIn),
    topicControls: normalizeProactiveBriefTopicControls(
      raw.topicControls,
      fallback.topicControls,
      now,
    ),
    sourceHostControls: normalizeProactiveBriefSourceHostControls(
      raw.sourceHostControls,
      fallback.sourceHostControls,
      now,
    ),
  };
}

export function applyAoiProactiveBriefingTopicControls(
  profile: AoiInterestProfile,
  controls: AoiProactiveBriefSchedulerControls,
): AoiInterestProfile {
  return {
    ...profile,
    topics: profile.topics.map((topic) => {
      const control = controls.topicControls[topic.id];
      if (!control) {
        return topic;
      }
      return {
        ...topic,
        muted: topic.muted || control.muted || control.allowed === false,
        pinned: control.muted || control.allowed === false ? false : topic.pinned || control.pinned,
      };
    }),
  };
}

export function isAoiProactiveBriefQuietWindowActive(
  controls: AoiProactiveBriefSchedulerControls,
  now = Date.now(),
): boolean {
  if (!controls.quietWindow.enabled) {
    return false;
  }
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  const start = controls.quietWindow.startMinuteOfDay;
  const end = controls.quietWindow.endMinuteOfDay;
  if (start === end) {
    return true;
  }
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function normalizeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return normalized || fallback;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return normalized || undefined;
}

export function isAoiProposalFeedbackCategory(
  value: unknown,
): value is AoiProposalFeedbackCategory {
  return (
    typeof value === 'string' &&
    (AOI_PROPOSAL_FEEDBACK_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isAoiAutonomyLevel(value: unknown): value is AoiAutonomyLevel {
  return (
    value === 'L0' ||
    value === 'L1' ||
    value === 'L2' ||
    value === 'L3' ||
    value === 'L4' ||
    value === 'L5'
  );
}

export function isAoiEnvironmentSourceKind(value: unknown): value is AoiEnvironmentSourceKind {
  return (
    typeof value === 'string' && (AOI_ENVIRONMENT_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isAoiEnvironmentSourceOperation(
  value: unknown,
): value is AoiEnvironmentSourceOperation {
  return (
    typeof value === 'string' &&
    (AOI_ENVIRONMENT_SOURCE_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isAoiEnvironmentSourceScope(value: unknown): value is AoiEnvironmentSourceScope {
  return (
    typeof value === 'string' &&
    (AOI_ENVIRONMENT_SOURCE_SCOPES as readonly string[]).includes(value)
  );
}

export function isAoiEnvironmentSourceQuietModeBehavior(
  value: unknown,
): value is AoiEnvironmentSourceQuietModeBehavior {
  return (
    typeof value === 'string' &&
    (AOI_ENVIRONMENT_SOURCE_QUIET_MODE_BEHAVIORS as readonly string[]).includes(value)
  );
}

export function isAoiPersonalSignalSourceKind(
  value: unknown,
): value is AoiPersonalSignalSourceKind {
  return (
    typeof value === 'string' &&
    (AOI_PERSONAL_SIGNAL_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function isAoiPersonalSignalSource(source: AoiEnvironmentSource): boolean {
  return isAoiPersonalSignalSourceKind(source.kind);
}

export function compareAoiAutonomyLevel(a: AoiAutonomyLevel, b: AoiAutonomyLevel): number {
  return AOI_AUTONOMY_LEVEL_ORDER[a] - AOI_AUTONOMY_LEVEL_ORDER[b];
}

export function normalizeAoiAutonomyPolicy(
  value: unknown,
  fallback: AoiAutonomyPolicy = DEFAULT_AOI_AUTONOMY_POLICY,
  now = Date.now(),
): AoiAutonomyPolicy {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiAutonomyPolicy>)
      : {};
  return {
    version: 1,
    enabled: normalizeBoolean(raw.enabled, fallback.enabled),
    previewMode: normalizeBoolean(raw.previewMode, fallback.previewMode),
    level: isAoiAutonomyLevel(raw.level) ? raw.level : fallback.level,
    proactiveSuggestionsEnabled: normalizeBoolean(
      raw.proactiveSuggestionsEnabled,
      fallback.proactiveSuggestionsEnabled,
    ),
    confidenceFloor: clampNumber(raw.confidenceFloor, fallback.confidenceFloor, 0, 1),
    maxActiveProposals: Math.round(
      clampNumber(raw.maxActiveProposals, fallback.maxActiveProposals, 1, 100),
    ),
    maxProposalsPerTick: Math.round(
      clampNumber(raw.maxProposalsPerTick, fallback.maxProposalsPerTick, 1, 20),
    ),
    maxProposalsPerDay: Math.round(
      clampNumber(raw.maxProposalsPerDay, fallback.maxProposalsPerDay, 1, 200),
    ),
    defaultCooldownMs: Math.round(
      clampNumber(
        raw.defaultCooldownMs,
        fallback.defaultCooldownMs,
        60_000,
        7 * 24 * 60 * 60 * 1000,
      ),
    ),
    defaultSnoozeMs: Math.round(
      clampNumber(raw.defaultSnoozeMs, fallback.defaultSnoozeMs, 60_000, 7 * 24 * 60 * 60 * 1000),
    ),
    duplicateCheckEnabled: normalizeBoolean(
      raw.duplicateCheckEnabled,
      fallback.duplicateCheckEnabled,
    ),
    cooldownCheckEnabled: normalizeBoolean(raw.cooldownCheckEnabled, fallback.cooldownCheckEnabled),
    proactiveBriefing: normalizeAoiProactiveBriefingControls(
      raw.proactiveBriefing,
      fallback.proactiveBriefing,
      now,
    ),
    requireEvidenceRefs: normalizeBoolean(raw.requireEvidenceRefs, fallback.requireEvidenceRefs),
    requireApprovalForHighRisk: normalizeBoolean(
      raw.requireApprovalForHighRisk,
      fallback.requireApprovalForHighRisk,
    ),
    updatedAt: now,
  };
}

function normalizeEnvironmentSourceOperations(
  value: unknown,
  fallback: AoiEnvironmentSourceOperation[],
): AoiEnvironmentSourceOperation[] {
  const raw = Array.isArray(value) ? value : fallback;
  const operations = raw.filter(isAoiEnvironmentSourceOperation);
  return [...new Set(operations.length > 0 ? operations : fallback)];
}

function defaultAoiEnvironmentSourceMap(now: number): Map<string, AoiEnvironmentSource> {
  return new Map(
    DEFAULT_AOI_ENVIRONMENT_SOURCES.map((source) => [
      source.id,
      {
        version: 1,
        ...source,
        updatedAt: now,
      },
    ]),
  );
}

export function normalizeAoiEnvironmentSource(
  value: unknown,
  fallback: AoiEnvironmentSource,
  now = Date.now(),
): AoiEnvironmentSource {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiEnvironmentSource>)
      : {};
  const kind = isAoiEnvironmentSourceKind(raw.kind) ? raw.kind : fallback.kind;
  const scope = isAoiEnvironmentSourceScope(raw.scope) ? raw.scope : fallback.scope;
  const risk =
    raw.risk === 'low' || raw.risk === 'medium' || raw.risk === 'high' ? raw.risk : fallback.risk;
  const quietModeBehavior = isAoiEnvironmentSourceQuietModeBehavior(raw.quietModeBehavior)
    ? raw.quietModeBehavior
    : fallback.quietModeBehavior;
  const enabled = normalizeBoolean(raw.enabled, fallback.enabled);
  const privateByDefault = normalizeBoolean(raw.privateByDefault, fallback.privateByDefault);
  const consentReason = normalizeOptionalText(raw.consentReason, 180);
  const lastReviewedAt =
    typeof raw.lastReviewedAt === 'number' && raw.lastReviewedAt > 0
      ? raw.lastReviewedAt
      : undefined;

  return {
    version: 1,
    id: fallback.id,
    kind,
    label: normalizeText(raw.label, fallback.label, 96),
    enabled,
    scope,
    risk,
    allowedOperations: normalizeEnvironmentSourceOperations(
      raw.allowedOperations,
      fallback.allowedOperations,
    ),
    privateByDefault,
    quietModeBehavior,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    ...(typeof raw.lastObservedAt === 'number' && raw.lastObservedAt > 0
      ? { lastObservedAt: raw.lastObservedAt }
      : {}),
    ...(lastReviewedAt ? { lastReviewedAt } : {}),
    ...(consentReason ? { consentReason } : {}),
  };
}

export function normalizeAoiEnvironmentSourceRegistry(
  value: unknown,
  sessionPath: string,
  now = Date.now(),
): AoiEnvironmentSourceRegistry {
  const defaults = defaultAoiEnvironmentSourceMap(now);
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiEnvironmentSourceRegistry>)
      : {};
  const parsedSources = Array.isArray(raw.sources) ? raw.sources : [];
  const parsedById = new Map<string, unknown>();
  for (const source of parsedSources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      continue;
    }
    const id = (source as Partial<AoiEnvironmentSource>).id;
    if (typeof id === 'string' && defaults.has(id)) {
      parsedById.set(id, source);
    }
  }

  return {
    version: 1,
    sessionPath,
    sources: [...defaults.values()].map((fallback) =>
      normalizeAoiEnvironmentSource(parsedById.get(fallback.id), fallback, now),
    ),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

export function getDefaultAoiEnvironmentSourceRegistry(
  sessionPath: string,
  now = Date.now(),
): AoiEnvironmentSourceRegistry {
  return normalizeAoiEnvironmentSourceRegistry(null, sessionPath, now);
}

export function getAoiEnvironmentSource(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  sourceId: string,
): AoiEnvironmentSource | null {
  return registry?.sources.find((source) => source.id === sourceId) ?? null;
}

export function classifyAoiEnvironmentSourceRisk(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  sourceId: string,
): AoiAutonomyRisk {
  return getAoiEnvironmentSource(registry, sourceId)?.risk ?? 'high';
}

export function isAoiEnvironmentSourceEnabled(
  registry: AoiEnvironmentSourceRegistry | null | undefined,
  sourceId: string,
): boolean {
  return getAoiEnvironmentSource(registry, sourceId)?.enabled === true;
}

export function isAoiEnvironmentSourcePrivateOrExplicit(source: AoiEnvironmentSource): boolean {
  return (
    source.privateByDefault ||
    source.kind === 'browser_context' ||
    isAoiPersonalSignalSource(source) ||
    source.risk === 'high'
  );
}

export function checkAoiEnvironmentSourceOperation(params: {
  registry: AoiEnvironmentSourceRegistry | null | undefined;
  sourceId: string;
  operation: AoiEnvironmentSourceOperation;
}): AoiEnvironmentSourcePolicyCheckResult {
  const source = getAoiEnvironmentSource(params.registry, params.sourceId);
  const reasons: string[] = [];

  if (!source) {
    return {
      allowed: false,
      reasons: ['unknown_source'],
    };
  }
  if (!source.enabled) {
    reasons.push('source_disabled');
  }
  if (!source.allowedOperations.includes(params.operation)) {
    reasons.push(`operation_not_allowed:${params.operation}`);
  }
  if (
    isAoiEnvironmentSourcePrivateOrExplicit(source) &&
    (source.scope !== 'explicit_target' || !source.consentReason)
  ) {
    reasons.push('explicit_target_scope_required');
  }
  if (isAoiPersonalSignalSource(source) && !source.lastReviewedAt) {
    reasons.push('source_consent_review_required');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    source,
  };
}

export function getAoiToolAutonomyPolicy(toolName: string): AoiAutonomyToolPolicy {
  return (
    AOI_AUTONOMY_TOOL_POLICIES[toolName] ?? {
      ...DEFAULT_BLOCKED_TOOL_POLICY,
      toolName,
    }
  );
}

export function isAoiToolAllowedAtLevel(toolName: string, level: AoiAutonomyLevel): boolean {
  const policy = getAoiToolAutonomyPolicy(toolName);
  if (policy.blocked) {
    return false;
  }
  return compareAoiAutonomyLevel(level, policy.maxLevel) >= 0;
}

export function requiresAoiProposalApproval(toolName: string): boolean {
  return getAoiToolAutonomyPolicy(toolName).requiresApproval;
}

function getExecutionActionKind(proposal: AoiProposal): string {
  return typeof proposal.acceptAction?.kind === 'string' ? proposal.acceptAction.kind : '';
}

function riskRank(value: AoiAutonomyRisk): number {
  if (value === 'high') {
    return 2;
  }
  if (value === 'medium') {
    return 1;
  }
  return 0;
}

function maxRisk(a: AoiAutonomyRisk, b: AoiAutonomyRisk): AoiAutonomyRisk {
  return riskRank(a) >= riskRank(b) ? a : b;
}

function nextAutonomyLevel(level: AoiAutonomyLevel): AoiAutonomyLevel {
  const nextRank = Math.min(AOI_AUTONOMY_LEVEL_ORDER.L5, AOI_AUTONOMY_LEVEL_ORDER[level] + 1);
  return (Object.entries(AOI_AUTONOMY_LEVEL_ORDER).find(([, rank]) => rank === nextRank)?.[0] ??
    'L5') as AoiAutonomyLevel;
}

function maxAutonomyLevel(a: AoiAutonomyLevel, b: AoiAutonomyLevel): AoiAutonomyLevel {
  return compareAoiAutonomyLevel(a, b) >= 0 ? a : b;
}

function actionKindToToolName(actionKind: string): string {
  return actionKind;
}

function getAoiApprovedCommandPolicyForProposal(proposal: AoiProposal, now: number) {
  const params = proposal.acceptAction?.params ?? {};
  return evaluateAoiApprovedCommandPolicy(
    createAoiApprovedCommandRequest({
      sessionPath: proposal.sessionPath,
      proposalId: proposal.id,
      command: params.command,
      cwd: params.cwd ?? params.directory,
      purpose: params.purpose ?? proposal.title,
      risk: proposal.risk,
      timeoutMs: params.timeoutMs ?? params.timeout_ms,
      requestedAt: now,
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
    }),
  );
}

function findCommandApprovalDecision(params: {
  proposal: AoiProposal;
  decisions: AoiProposalDecision[] | undefined;
  decisionId?: string;
}): AoiProposalDecision | undefined {
  return params.decisions?.find((decision) => {
    if (decision.proposalId !== params.proposal.id || decision.action !== 'accept') {
      return false;
    }
    if (params.decisionId && decision.id !== params.decisionId) {
      return false;
    }
    return Boolean(normalizeAoiApprovedCommandPolicy(decision.approvedCommand));
  });
}

function getAoiApprovedFileMutationPolicyForProposal(proposal: AoiProposal, now: number) {
  const params = proposal.acceptAction?.params ?? {};
  return evaluateAoiApprovedFileMutationPolicy(
    createAoiApprovedFileMutationRequest({
      sessionPath: proposal.sessionPath,
      proposalId: proposal.id,
      operation: fileMutationOperationFromActionKind(proposal.acceptAction?.kind),
      path: params.path,
      content: params.content,
      patchOps: params.patchOps ?? params.patch_ops,
      purpose: params.purpose ?? proposal.title,
      risk: proposal.risk,
      requestedAt: now,
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
    }),
  );
}

function findFileMutationApprovalDecision(params: {
  proposal: AoiProposal;
  decisions: AoiProposalDecision[] | undefined;
  decisionId?: string;
}): AoiProposalDecision | undefined {
  return params.decisions?.find((decision) => {
    if (decision.proposalId !== params.proposal.id || decision.action !== 'accept') {
      return false;
    }
    if (params.decisionId && decision.id !== params.decisionId) {
      return false;
    }
    return Boolean(normalizeAoiApprovedFileMutationPolicy(decision.approvedFileMutation));
  });
}

function getAoiApprovedAppActionPolicyForProposal(proposal: AoiProposal, now: number) {
  const params = proposal.acceptAction?.params ?? {};
  return evaluateAoiApprovedAppActionPolicy(
    createAoiApprovedAppActionRequest({
      sessionPath: proposal.sessionPath,
      proposalId: proposal.id,
      appReference: params.appReference ?? params.appName ?? params.app,
      capabilityId: params.capabilityId,
      intentReference: params.intentReference ?? params.intent,
      actionType: params.actionType ?? params.action,
      requestedOperation: params.requestedOperation ?? params.operation,
      operationParams: params.operationParams ?? params.actionParams,
      path: params.path,
      content: params.content,
      patchOps: params.patchOps ?? params.patch_ops,
      purpose: params.purpose ?? proposal.title,
      risk: proposal.risk,
      requestedAt: now,
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
    }),
  );
}

function findAppActionApprovalDecision(params: {
  proposal: AoiProposal;
  decisions: AoiProposalDecision[] | undefined;
  decisionId?: string;
}): AoiProposalDecision | undefined {
  return params.decisions?.find((decision) => {
    if (decision.proposalId !== params.proposal.id || decision.action !== 'accept') {
      return false;
    }
    if (params.decisionId && decision.id !== params.decisionId) {
      return false;
    }
    return Boolean(normalizeAoiApprovedAppActionPolicy(decision.approvedAppAction));
  });
}

function getAoiApprovedConnectorCallPolicyForProposal(
  proposal: AoiProposal,
  now: number,
  connectors: AoiMcpConnectorsConfig | null | undefined,
  allowSideEffecting = false,
) {
  const params = proposal.acceptAction?.params ?? {};
  return evaluateAoiApprovedConnectorCallPolicy(
    createAoiApprovedConnectorCallRequest({
      sessionPath: proposal.sessionPath,
      proposalId: proposal.id,
      connectorRef: params.connectorRef ?? params.connectorId ?? params.connector,
      toolName: params.toolName ?? params.tool,
      resourceUri: params.resourceUri ?? params.resource_uri ?? params.uri,
      args: params.args ?? params.arguments ?? params.toolArgs,
      purpose: params.purpose ?? proposal.title,
      risk: proposal.risk,
      requestedAt: now,
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      acknowledgeIrreversible: params.acknowledgeIrreversible === 'true',
    }),
    {
      connectors: connectors ?? null,
      now,
      ...(allowSideEffecting ? { allowSideEffecting: true } : {}),
    },
  );
}

function findConnectorCallApprovalDecision(params: {
  proposal: AoiProposal;
  decisions: AoiProposalDecision[] | undefined;
  decisionId?: string;
}): AoiProposalDecision | undefined {
  return params.decisions?.find((decision) => {
    if (decision.proposalId !== params.proposal.id || decision.action !== 'accept') {
      return false;
    }
    if (params.decisionId && decision.id !== params.decisionId) {
      return false;
    }
    return Boolean(normalizeAoiApprovedConnectorCallPolicy(decision.approvedConnectorCall));
  });
}

function hasExplicitAcceptDecision(params: {
  proposal: AoiProposal;
  decisions: AoiProposalDecision[] | undefined;
  decisionId?: string;
  now: number;
  freshAcceptanceMs?: number;
  requireFresh: boolean;
}): boolean {
  if (params.proposal.status === 'accepted' && !params.requireFresh) {
    return true;
  }

  const maxAge = params.freshAcceptanceMs ?? FRESH_ACCEPTANCE_MS;
  return Boolean(
    params.decisions?.some((decision) => {
      if (decision.proposalId !== params.proposal.id || decision.action !== 'accept') {
        return false;
      }
      if (params.decisionId && decision.id !== params.decisionId) {
        return false;
      }
      if (params.requireFresh && decision.createdAt + maxAge < params.now) {
        return false;
      }
      return true;
    }),
  );
}

function valueContainsFilesystemPath(value: unknown, keyHint = ''): boolean {
  if (typeof value === 'string') {
    if (FILESYSTEM_PATH_KEY_PATTERN.test(keyHint) && value.trim()) {
      return true;
    }
    return WINDOWS_PATH_PATTERN.test(value) || UNIX_PATH_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsFilesystemPath(item, keyHint));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
      valueContainsFilesystemPath(item, key),
    );
  }
  return false;
}

export function evaluateAoiProposalExecution(
  proposal: AoiProposal,
  policy: AoiAutonomyPolicy,
  context: AoiProposalExecutionPolicyContext = {},
): AoiProposalExecutionPolicyResult {
  const now = context.now ?? Date.now();
  const reasons: string[] = [];
  const actionKind = getExecutionActionKind(proposal);
  const toolName = actionKind ? actionKindToToolName(actionKind) : undefined;
  const readOnly = actionKind ? READ_ONLY_PROPOSAL_ACTIONS.has(actionKind) : false;
  const kiraHandoff = actionKind === 'create_kira_work';
  const fileMutation = FILE_MUTATION_PROPOSAL_ACTIONS.has(actionKind);
  const appAction = APP_ACTION_PROPOSAL_ACTIONS.has(actionKind);
  const connectorCall = CONNECTOR_CALL_PROPOSAL_ACTIONS.has(actionKind);
  const approvedCommandPolicy =
    actionKind === 'run_command' ? getAoiApprovedCommandPolicyForProposal(proposal, now) : null;
  const approvedFileMutationPolicy = fileMutation
    ? getAoiApprovedFileMutationPolicyForProposal(proposal, now)
    : null;
  const approvedAppActionPolicy = appAction
    ? getAoiApprovedAppActionPolicyForProposal(proposal, now)
    : null;
  const approvedConnectorCallPolicy = connectorCall
    ? getAoiApprovedConnectorCallPolicyForProposal(
        proposal,
        now,
        context.connectors,
        context.allowSideEffecting === true,
      )
    : null;
  const requiresFreshAcceptance =
    context.executionMode === 'preview'
      ? false
      : proposal.risk === 'high' || actionKind === 'start_research' || kiraHandoff || !readOnly;

  if (kiraHandoff && proposal.status !== 'accepted') {
    reasons.push('kira_handoff_requires_accepted_proposal');
  } else if (proposal.status !== 'active' && proposal.status !== 'accepted') {
    reasons.push('proposal_status_not_executable');
  }
  if (!actionKind || !EXECUTABLE_PROPOSAL_ACTIONS.has(actionKind)) {
    reasons.push(actionKind ? `unknown_action_kind:${actionKind}` : 'missing_accept_action');
  }
  if (proposal.evidenceRefs.length === 0) {
    reasons.push('missing_evidence_refs');
  }
  if (compareAoiAutonomyLevel(policy.level, proposal.requiredAutonomyLevel) < 0) {
    reasons.push('autonomy_level_too_low');
  }
  if (actionKind === 'run_command') {
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('approved_command_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('approved_command_proposal_must_require_l5');
    }
    if (approvedCommandPolicy && !approvedCommandPolicy.allowed) {
      for (const reason of approvedCommandPolicy.blockReasons) {
        reasons.push(`approved_command_blocked:${reason}`);
      }
    }
  }
  if (fileMutation) {
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('file_mutation_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('file_mutation_proposal_must_require_l5');
    }
    if (approvedFileMutationPolicy && !approvedFileMutationPolicy.allowed) {
      for (const reason of approvedFileMutationPolicy.blockReasons) {
        reasons.push(`file_mutation_blocked:${reason}`);
      }
    }
  }
  if (appAction) {
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('app_action_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('app_action_proposal_must_require_l5');
    }
    if (approvedAppActionPolicy && !approvedAppActionPolicy.allowed) {
      for (const reason of approvedAppActionPolicy.blockReasons) {
        reasons.push(`app_action_blocked:${reason}`);
      }
    }
  }
  if (connectorCall) {
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('connector_call_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('connector_call_proposal_must_require_l5');
    }
    if (approvedConnectorCallPolicy && !approvedConnectorCallPolicy.allowed) {
      for (const reason of approvedConnectorCallPolicy.blockReasons) {
        reasons.push(`connector_call_blocked:${reason}`);
      }
    }
  }
  if (kiraHandoff && compareAoiAutonomyLevel(policy.level, 'L4') < 0) {
    reasons.push('kira_handoff_requires_l4');
  }
  if (
    !hasExplicitAcceptDecision({
      proposal,
      decisions: context.decisions,
      decisionId: context.decisionId,
      now,
      freshAcceptanceMs: context.freshAcceptanceMs,
      requireFresh: requiresFreshAcceptance,
    })
  ) {
    reasons.push(
      requiresFreshAcceptance ? 'missing_fresh_acceptance' : 'missing_explicit_acceptance',
    );
  }
  if (
    actionKind === 'run_command' &&
    context.executionMode !== 'preview' &&
    approvedCommandPolicy
  ) {
    const approvalDecision = findCommandApprovalDecision({
      proposal,
      decisions: context.decisions,
      decisionId: context.decisionId,
    });
    const approvalReasons = compareAoiApprovedCommandApproval({
      approved: normalizeAoiApprovedCommandPolicy(approvalDecision?.approvedCommand),
      current: approvedCommandPolicy,
      now,
    });
    for (const reason of approvalReasons) {
      reasons.push(`approved_command_${reason}`);
    }
  }
  if (fileMutation && context.executionMode !== 'preview' && approvedFileMutationPolicy) {
    const approvalDecision = findFileMutationApprovalDecision({
      proposal,
      decisions: context.decisions,
      decisionId: context.decisionId,
    });
    const approvalReasons = compareAoiApprovedFileMutationApproval({
      approved: normalizeAoiApprovedFileMutationPolicy(approvalDecision?.approvedFileMutation),
      current: approvedFileMutationPolicy,
      now,
    });
    for (const reason of approvalReasons) {
      reasons.push(`file_mutation_${reason}`);
    }
  }
  if (appAction && context.executionMode !== 'preview' && approvedAppActionPolicy) {
    const approvalDecision = findAppActionApprovalDecision({
      proposal,
      decisions: context.decisions,
      decisionId: context.decisionId,
    });
    const approvalReasons = compareAoiApprovedAppActionApproval({
      approved: normalizeAoiApprovedAppActionPolicy(approvalDecision?.approvedAppAction),
      current: approvedAppActionPolicy,
      now,
    });
    for (const reason of approvalReasons) {
      reasons.push(`app_action_${reason}`);
    }
  }
  if (connectorCall && context.executionMode !== 'preview' && approvedConnectorCallPolicy) {
    const approvalDecision = findConnectorCallApprovalDecision({
      proposal,
      decisions: context.decisions,
      decisionId: context.decisionId,
    });
    const approvalReasons = compareAoiApprovedConnectorCallApproval({
      approved: normalizeAoiApprovedConnectorCallPolicy(approvalDecision?.approvedConnectorCall),
      current: approvedConnectorCallPolicy,
      now,
    });
    for (const reason of approvalReasons) {
      reasons.push(`connector_call_${reason}`);
    }
  }
  if (
    actionKind !== 'run_command' &&
    !fileMutation &&
    !appAction &&
    !connectorCall &&
    valueContainsFilesystemPath(proposal.acceptAction?.params ?? {})
  ) {
    reasons.push('action_params_include_filesystem_path');
  }
  if (kiraHandoff) {
    reasons.push(...collectAoiKiraHandoffScopeReasons(proposal));
  }

  const toolsToCheck = new Set<string>(proposal.suggestedTools);
  if (toolName) {
    toolsToCheck.add(toolName);
  }
  toolsToCheck.forEach((name) => {
    if (name === 'run_command' && actionKind === 'run_command') {
      if (!approvedCommandPolicy?.allowed) {
        reasons.push('tool_blocked:run_command');
      }
      return;
    }
    if (FILE_MUTATION_PROPOSAL_ACTIONS.has(name) && name === actionKind) {
      if (!approvedFileMutationPolicy?.allowed) {
        reasons.push(`tool_blocked:${name}`);
      }
      return;
    }
    if (name === 'app_action' && actionKind === 'app_action') {
      if (!approvedAppActionPolicy?.allowed) {
        reasons.push('tool_blocked:app_action');
      }
      return;
    }
    if (name === 'connector_call' && actionKind === 'connector_call') {
      if (!approvedConnectorCallPolicy?.allowed) {
        reasons.push('tool_blocked:connector_call');
      }
      return;
    }
    const toolPolicy = getAoiToolAutonomyPolicy(name);
    if (toolPolicy.blocked) {
      reasons.push(`tool_blocked:${name}`);
      return;
    }
    if (!isAoiToolAllowedAtLevel(name, policy.level)) {
      reasons.push(`tool_level_too_low:${name}`);
    }
  });

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    actionKind: actionKind || undefined,
    toolName,
    requiresFreshAcceptance,
    readOnly,
    ...(kiraHandoff && reasons.length > 0
      ? { safeAlternative: getAoiKiraSafeNarrowingSuggestion() }
      : {}),
  };
}

function hasDuplicateActiveProposal(
  proposal: AoiProposal,
  activeProposals: AoiProposal[] | undefined,
): boolean {
  return Boolean(
    activeProposals?.some(
      (active) =>
        active.id !== proposal.id &&
        (active.status === 'active' ||
          active.status === 'accepted' ||
          active.status === 'snoozed') &&
        active.cooldownKey === proposal.cooldownKey,
    ),
  );
}

function hasRecentCooldownDecision(params: {
  proposal: AoiProposal;
  recentDecisions: AoiProposalDecision[] | undefined;
  now: number;
  cooldownMs: number;
}): boolean {
  return Boolean(
    params.recentDecisions?.some(
      (decision) =>
        (decision.action === 'dismiss' || decision.action === 'snooze') &&
        decision.cooldownKey === params.proposal.cooldownKey &&
        decision.createdAt + params.cooldownMs > params.now,
    ),
  );
}

function proposalMemoryRefSet(proposal: AoiProposal): Set<string> {
  const refs = new Set<string>(proposal.memoryIds);
  for (const ref of proposal.evidenceRefs) {
    if (ref.startsWith('memory:')) {
      refs.add(ref.slice('memory:'.length));
    }
  }
  return refs;
}

function decisionMemoryRefSet(decision: AoiProposalDecision): Set<string> {
  const refs = new Set<string>(decision.memoryIds ?? []);
  for (const ref of decision.evidenceRefs ?? []) {
    if (ref.startsWith('memory:')) {
      refs.add(ref.slice('memory:'.length));
    }
  }
  return refs;
}

function sharesMemoryRef(proposal: AoiProposal, decision: AoiProposalDecision): boolean {
  const proposalRefs = proposalMemoryRefSet(proposal);
  if (proposalRefs.size === 0) {
    return false;
  }
  for (const ref of decisionMemoryRefSet(decision)) {
    if (proposalRefs.has(ref)) {
      return true;
    }
  }
  return false;
}

function actionKindMatches(proposal: AoiProposal, decision: AoiProposalDecision): boolean {
  const actionKind = getExecutionActionKind(proposal);
  if (actionKind && decision.actionKind === actionKind) {
    return true;
  }
  const tools = new Set(proposal.suggestedTools);
  return Boolean(decision.suggestedTools?.some((tool) => tools.has(tool)));
}

function sourceKindFromProposal(proposal: AoiProposal): string | undefined {
  const refs = [...proposal.evidenceRefs, ...proposal.artifactRefs];
  if (refs.some((ref) => ref.startsWith('research:'))) {
    return 'research_runs';
  }
  if (refs.some((ref) => ref.startsWith('workspace:'))) {
    return refs.some((ref) => ref.includes('validation') || ref.includes('build'))
      ? 'workspace_build'
      : 'workspace_git';
  }
  if (refs.some((ref) => ref.startsWith('memory:') || ref.startsWith('kira:'))) {
    return 'kira_board';
  }
  if (refs.some((ref) => ref.startsWith('browser:') || ref.includes('browser-context'))) {
    return 'browser_context';
  }
  if (refs.some((ref) => ref.includes('calendar'))) {
    return 'calendar_metadata';
  }
  if (refs.some((ref) => ref.includes('gmail'))) {
    return 'gmail_metadata';
  }
  if (refs.some((ref) => ref.includes('notes'))) {
    return 'notes_metadata';
  }
  return undefined;
}

function decisionAppliesToProposal(proposal: AoiProposal, decision: AoiProposalDecision): boolean {
  return (
    decision.cooldownKey === proposal.cooldownKey ||
    decision.proposalTrigger === proposal.trigger ||
    sharesMemoryRef(proposal, decision) ||
    actionKindMatches(proposal, decision)
  );
}

function feedbackDecisions(
  proposal: AoiProposal,
  decisions: AoiProposalDecision[] | undefined,
  category: AoiProposalFeedbackCategory,
): AoiProposalDecision[] {
  return (decisions ?? []).filter(
    (decision) =>
      decision.feedbackCategory === category && decisionAppliesToProposal(proposal, decision),
  );
}

function feedbackDecisionsForCategories(
  proposal: AoiProposal,
  decisions: AoiProposalDecision[] | undefined,
  categories: ReadonlySet<AoiProposalFeedbackCategory>,
): AoiProposalDecision[] {
  return (decisions ?? []).filter(
    (decision) =>
      Boolean(decision.feedbackCategory) &&
      categories.has(decision.feedbackCategory as AoiProposalFeedbackCategory) &&
      decisionAppliesToProposal(proposal, decision),
  );
}

function isRefreshProposal(proposal: AoiProposal): boolean {
  return (
    proposal.acceptAction?.kind === 'start_research' &&
    (proposal.trigger.includes('stale') ||
      proposal.cooldownKey.includes('refresh') ||
      proposal.riskSignals.includes('stale-memory'))
  );
}

export function getAoiFeedbackAdjustedCooldownMs(params: {
  proposal: AoiProposal;
  recentDecisions?: AoiProposalDecision[];
  baseCooldownMs: number;
}): number {
  const noisyTimingCategories = new Set<AoiProposalFeedbackCategory>([
    'too_frequent',
    'too_much',
    'wrong_timing',
  ]);
  const tooFrequentCount = (params.recentDecisions ?? []).filter(
    (decision) =>
      Boolean(decision.feedbackCategory) &&
      noisyTimingCategories.has(decision.feedbackCategory as AoiProposalFeedbackCategory) &&
      decision.cooldownKey === params.proposal.cooldownKey,
  ).length;
  if (tooFrequentCount <= 0) {
    return params.baseCooldownMs;
  }
  const multiplier = Math.min(TOO_FREQUENT_COOLDOWN_MULTIPLIER_LIMIT, 1 + tooFrequentCount);
  return params.baseCooldownMs * multiplier;
}

export function getAoiProposalFeedbackPriorityBoost(
  proposal: AoiProposal,
  recentDecisions?: AoiProposalDecision[],
): number {
  const usefulCount = feedbackDecisions(proposal, recentDecisions, 'useful').length;
  if (usefulCount <= 0) {
    return 0;
  }
  return Math.min(MAX_USEFUL_FEEDBACK_BOOST, usefulCount * USEFUL_FEEDBACK_CONFIDENCE_BOOST);
}

export function applyAoiFeedbackCalibrationToProposal(
  proposal: AoiProposal,
  recentDecisions?: AoiProposalDecision[],
): AoiProposal {
  const wrongEvidenceCount =
    feedbackDecisions(proposal, recentDecisions, 'wrong_memory').filter((decision) =>
      sharesMemoryRef(proposal, decision),
    ).length +
    feedbackDecisionsForCategories(
      proposal,
      recentDecisions,
      new Set<AoiProposalFeedbackCategory>(['wrong_evidence']),
    ).length;
  const unsafeCount = feedbackDecisions(proposal, recentDecisions, 'unsafe').filter((decision) =>
    actionKindMatches(proposal, decision),
  ).length;
  const confidence = Math.min(
    1,
    Math.max(0, proposal.confidence - wrongEvidenceCount * WRONG_MEMORY_CONFIDENCE_PENALTY),
  );

  if (unsafeCount <= 0) {
    return {
      ...proposal,
      confidence,
    };
  }

  return {
    ...proposal,
    confidence,
    risk: maxRisk(proposal.risk, 'medium'),
    requiredAutonomyLevel: maxAutonomyLevel(
      proposal.requiredAutonomyLevel,
      nextAutonomyLevel(proposal.requiredAutonomyLevel),
    ),
    requiresUserApproval: true,
    riskSignals: [...new Set([...proposal.riskSignals, 'unsafe-feedback'])],
  };
}

// A follow-through boost at or below this (bounded range is ~+/-0.15) marks a
// source whose recent suggestions were strongly ignored/blocked; such a proposal
// must be user-approved rather than flow autonomously.
const FOLLOW_THROUGH_SUPPRESSION_APPROVAL_THRESHOLD = -0.1;

export function checkAoiProposalPolicy(
  input: AoiProposalPolicyCheckInput,
): AoiProposalPolicyCheckResult {
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const { policy } = input;
  const proposal = applyAoiFeedbackCalibrationToProposal(input.proposal, input.recentDecisions);
  const trustCalibration = applyAoiTrustCalibration({
    profile: input.trustCalibrationProfile,
    triggerKind: proposal.trigger,
    actionKind: proposal.acceptAction?.kind ?? proposal.suggestedTools[0],
    sourceKind: sourceKindFromProposal(proposal),
    risk: proposal.risk,
    score: proposal.confidence,
  });
  const staleMemoryFeedbackApplies =
    feedbackDecisions(proposal, input.recentDecisions, 'stale').filter((decision) =>
      sharesMemoryRef(proposal, decision),
    ).length > 0;

  if (!policy.enabled && !policy.previewMode) {
    reasons.push('autonomy_disabled');
  }
  if (proposal.confidence < policy.confidenceFloor) {
    reasons.push('confidence_below_floor');
  }
  if (policy.requireEvidenceRefs && proposal.evidenceRefs.length === 0) {
    reasons.push('missing_evidence_refs');
  }
  if (trustCalibration.requiredEvidenceBoost > 0 && proposal.evidenceRefs.length < 2) {
    reasons.push('trust_calibration_requires_more_evidence');
  }
  if (trustCalibration.approvalStrictnessBoost > 0 && !proposal.requiresUserApproval) {
    reasons.push('trust_calibration_requires_user_approval');
  }
  // 5a -> policy: a strongly follow-through-suppressed source (its recent
  // suggestions were repeatedly ignored or blocked) raises the approval bar.
  // Conservative and one-directional -- it only ever requires approval, mirroring
  // the trust-calibration gate above, and is distinct from it (keys on source
  // follow-through, not decisions) so the two never double-count.
  if (
    typeof input.followThroughSuppression === 'number' &&
    input.followThroughSuppression <= FOLLOW_THROUGH_SUPPRESSION_APPROVAL_THRESHOLD &&
    !proposal.requiresUserApproval
  ) {
    reasons.push('follow_through_source_suppressed_requires_approval');
  }
  if (policy.duplicateCheckEnabled && hasDuplicateActiveProposal(proposal, input.activeProposals)) {
    reasons.push('duplicate_active_proposal');
  }
  if (
    policy.cooldownCheckEnabled &&
    hasRecentCooldownDecision({
      proposal,
      recentDecisions: input.recentDecisions,
      now,
      cooldownMs: getAoiFeedbackAdjustedCooldownMs({
        proposal,
        recentDecisions: input.recentDecisions,
        baseCooldownMs: policy.defaultCooldownMs,
      }),
    })
  ) {
    reasons.push('cooldown_active');
  }
  if (staleMemoryFeedbackApplies && !isRefreshProposal(proposal)) {
    reasons.push('stale_memory_requires_refresh');
  }
  if (policy.maxActiveProposals > 0) {
    const activeCount =
      input.activeProposals?.filter(
        (active) =>
          active.status === 'active' || active.status === 'accepted' || active.status === 'snoozed',
      ).length ?? 0;
    if (activeCount >= policy.maxActiveProposals) {
      reasons.push('too_many_active_proposals');
    }
  }
  if (compareAoiAutonomyLevel(policy.level, proposal.requiredAutonomyLevel) < 0) {
    reasons.push('autonomy_level_too_low');
  }
  if (proposal.acceptAction?.kind === 'run_command') {
    const approvedCommandPolicy = getAoiApprovedCommandPolicyForProposal(proposal, now);
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('approved_command_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('approved_command_proposal_must_require_l5');
    }
    if (!approvedCommandPolicy.allowed) {
      for (const reason of approvedCommandPolicy.blockReasons) {
        reasons.push(`approved_command_blocked:${reason}`);
      }
    }
  }
  if (proposal.acceptAction && FILE_MUTATION_PROPOSAL_ACTIONS.has(proposal.acceptAction.kind)) {
    const approvedFileMutationPolicy = getAoiApprovedFileMutationPolicyForProposal(proposal, now);
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('file_mutation_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('file_mutation_proposal_must_require_l5');
    }
    if (!approvedFileMutationPolicy.allowed) {
      for (const reason of approvedFileMutationPolicy.blockReasons) {
        reasons.push(`file_mutation_blocked:${reason}`);
      }
    }
  }
  if (proposal.acceptAction && APP_ACTION_PROPOSAL_ACTIONS.has(proposal.acceptAction.kind)) {
    const approvedAppActionPolicy = getAoiApprovedAppActionPolicyForProposal(proposal, now);
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('app_action_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('app_action_proposal_must_require_l5');
    }
    if (!approvedAppActionPolicy.allowed) {
      for (const reason of approvedAppActionPolicy.blockReasons) {
        reasons.push(`app_action_blocked:${reason}`);
      }
    }
  }
  if (proposal.acceptAction && CONNECTOR_CALL_PROPOSAL_ACTIONS.has(proposal.acceptAction.kind)) {
    const approvedConnectorCallPolicy = getAoiApprovedConnectorCallPolicyForProposal(
      proposal,
      now,
      input.connectors,
      input.allowSideEffecting === true,
    );
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      reasons.push('connector_call_requires_l5');
    }
    if (proposal.requiredAutonomyLevel !== 'L5') {
      reasons.push('connector_call_proposal_must_require_l5');
    }
    if (!approvedConnectorCallPolicy.allowed) {
      for (const reason of approvedConnectorCallPolicy.blockReasons) {
        reasons.push(`connector_call_blocked:${reason}`);
      }
    }
  }

  for (const toolName of proposal.suggestedTools) {
    if (toolName === 'run_command' && proposal.acceptAction?.kind === 'run_command') {
      const approvedCommandPolicy = getAoiApprovedCommandPolicyForProposal(proposal, now);
      if (!approvedCommandPolicy.allowed) {
        reasons.push('tool_blocked:run_command');
      }
      continue;
    }
    if (FILE_MUTATION_PROPOSAL_ACTIONS.has(toolName) && proposal.acceptAction?.kind === toolName) {
      const approvedFileMutationPolicy = getAoiApprovedFileMutationPolicyForProposal(proposal, now);
      if (!approvedFileMutationPolicy.allowed) {
        reasons.push(`tool_blocked:${toolName}`);
      }
      continue;
    }
    if (toolName === 'app_action' && proposal.acceptAction?.kind === 'app_action') {
      const approvedAppActionPolicy = getAoiApprovedAppActionPolicyForProposal(proposal, now);
      if (!approvedAppActionPolicy.allowed) {
        reasons.push('tool_blocked:app_action');
      }
      continue;
    }
    if (toolName === 'connector_call' && proposal.acceptAction?.kind === 'connector_call') {
      const approvedConnectorCallPolicy = getAoiApprovedConnectorCallPolicyForProposal(
        proposal,
        now,
        input.connectors,
        input.allowSideEffecting === true,
      );
      if (!approvedConnectorCallPolicy.allowed) {
        reasons.push('tool_blocked:connector_call');
      }
      continue;
    }
    const toolPolicy = getAoiToolAutonomyPolicy(toolName);
    if (toolPolicy.blocked) {
      reasons.push(`tool_blocked:${toolName}`);
      continue;
    }
    if (!isAoiToolAllowedAtLevel(toolName, policy.level)) {
      reasons.push(`tool_level_too_low:${toolName}`);
    }
  }

  if (
    policy.requireApprovalForHighRisk &&
    proposal.risk === 'high' &&
    !proposal.requiresUserApproval
  ) {
    reasons.push('high_risk_requires_approval');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
