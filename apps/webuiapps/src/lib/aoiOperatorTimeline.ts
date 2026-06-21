import * as fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  createAoiAutonomyId,
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import type {
  AoiContextRouterResult,
  AoiDigestItem,
  AoiGoalProgressEvent,
  AoiMissionState,
  AoiObservation,
  AoiOperatorDigest,
  AoiOperatorReplayFixtureDraft,
  AoiOperatorTimelineEvent,
  AoiOperatorTimelineEventKind,
  AoiOperatorTimelineSummary,
  AoiOperatorTimelineVisibility,
  AoiOperatorTraceExport,
  AoiOutcomeSignalRecord,
  AoiProposal,
  AoiProposalDecision,
  AoiTraceRedactionState,
  AoiTraceRedactionSummary,
  AoiVoiceRenderDecision,
} from './aoiAutonomyTypes';
import type {
  AoiOperatorReplayFixture,
  AoiReplayInputEvent,
  AoiReplayInputEventKind,
} from './aoiOperatorReplay';

const TIMELINE_EVENT_TITLE_MAX_CHARS = 120;
const TIMELINE_EVENT_SUMMARY_MAX_CHARS = 360;
const TIMELINE_EVENT_REF_MAX_ITEMS = 24;
const TIMELINE_EVENT_METADATA_MAX_KEYS = 16;
const TIMELINE_EVENT_METADATA_VALUE_MAX_CHARS = 180;
const TIMELINE_LOAD_DEFAULT_LIMIT = 50;
const TIMELINE_LOAD_MAX_LIMIT = 500;
const TRACE_EXPORT_DEFAULT_LIMIT = 120;
const TRACE_EXPORT_MAX_LIMIT = 300;

const TIMELINE_MEANINGFUL_KINDS = new Set<AoiOperatorTimelineEventKind>([
  'observation_ingested',
  'source_selected',
  'proposal_created',
  'proposal_blocked',
  'proposal_accepted',
  'proposal_executed',
  'proposal_failed',
  'mission_state_changed',
  'goal_state_changed',
  'digest_item_surfaced',
  'approved_command_previewed',
  'approved_command_recorded',
  'feedback_recorded',
  'outcome_signal_recorded',
  'operator_voice_decision',
  'wakeup_recorded',
]);

const DEFAULT_TRACE_EXPORT_KINDS = new Set<AoiOperatorTimelineEventKind>([
  'observation_ingested',
  'source_selected',
  'source_suppressed',
  'proposal_created',
  'proposal_blocked',
  'proposal_accepted',
  'proposal_dismissed',
  'proposal_snoozed',
  'proposal_executed',
  'proposal_failed',
  'mission_state_changed',
  'goal_state_changed',
  'digest_item_surfaced',
  'digest_item_hidden',
  'approved_command_previewed',
  'approved_command_recorded',
  'feedback_recorded',
  'outcome_signal_recorded',
  'operator_voice_decision',
  'wakeup_recorded',
]);

const PRIVATE_METADATA_KEYS = new Set<string>([
  'body',
  'calendarbody',
  'command',
  'commandoutput',
  'content',
  'cwd',
  'emailbody',
  'localpath',
  'message',
  'messagebody',
  'output',
  'raw',
  'stderr',
  'stderrexcerpt',
  'stdout',
  'stdoutexcerpt',
  'url',
]);

const PERSONAL_SOURCE_KINDS = new Set<string>([
  'calendar_metadata',
  'gmail_metadata',
  'notes_metadata',
]);

const PERSONAL_SOURCE_REFS = [
  'personal-signal:calendar_metadata',
  'personal-signal:gmail_metadata',
  'personal-signal:notes_metadata',
  'environment-source:calendar-metadata',
  'environment-source:gmail-metadata',
  'environment-source:notes-metadata',
];

const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:(?:[\\/][^\s'"`<>|]+)+/g;
const UNC_PATH_PATTERN = /\\\\[^\s'"`<>|]+(?:\\[^\s'"`<>|]+)+/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s'"`<>]+/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export interface AoiOperatorTimelineEventInput {
  id?: string;
  sessionPath: string;
  kind: AoiOperatorTimelineEventKind;
  visibility?: AoiOperatorTimelineVisibility;
  createdAt?: number;
  title: string;
  summary: string;
  redactionState?: AoiTraceRedactionState;
  evidenceRefs?: string[];
  relatedRefs?: string[];
  sourceRef?: string;
  sourceKind?: string;
  proposalId?: string;
  decisionId?: string;
  goalId?: string;
  missionId?: string;
  digestItemId?: string;
  commandAuditId?: string;
  triggerKind?: string;
  actionKind?: string;
  status?: string;
  risk?: 'low' | 'medium' | 'high';
  metrics?: Record<string, number>;
  metadata?: Record<string, string | number | boolean | string[] | null | undefined>;
}

export interface AoiOperatorTimelineLoadOptions {
  limit?: number;
  newestFirst?: boolean;
  kinds?: AoiOperatorTimelineEventKind[];
}

export interface AoiOperatorTraceExportOptions {
  limit?: number;
  eventKinds?: AoiOperatorTimelineEventKind[];
  now?: number;
  persist?: boolean;
}

export interface AoiOperatorReplayFixtureDraftResult extends AoiOperatorReplayFixtureDraft {
  fixture: AoiOperatorReplayFixture;
}

interface Redactor {
  redactText: (value: string) => string;
  redactPersonalText: (value: string) => string;
  redactMetadata: (
    key: string,
    value: string | number | boolean | string[],
  ) => string | number | boolean | string[];
  redactPersonalMetadata: (
    key: string,
    value: string | number | boolean | string[],
  ) => string | number | boolean | string[];
  summary: () => AoiTraceRedactionSummary;
  didRedactSince: (previousCount: number) => boolean;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function ensureDirectory(fileOrDirectory: string, isFile = false): void {
  fs.mkdirSync(isFile ? dirname(fileOrDirectory) : fileOrDirectory, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDirectory(filePath, true);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeRefs(value: unknown, maxItems = TIMELINE_EVENT_REF_MAX_ITEMS): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = truncateText(item, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function normalizeOptionalText(
  value: unknown,
  maxChars = TIMELINE_EVENT_METADATA_VALUE_MAX_CHARS,
): string | undefined {
  return truncateText(value, maxChars);
}

function normalizeMetadata(
  value: Record<string, string | number | boolean | string[] | null | undefined> | undefined,
): Record<string, string | number | boolean | string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeWhitespace(rawKey)
      .replace(/[^A-Za-z0-9_.:-]/g, '_')
      .slice(0, 64);
    if (!key || rawValue === null || typeof rawValue === 'undefined') {
      continue;
    }
    if (typeof rawValue === 'string') {
      const normalized = truncateText(rawValue, TIMELINE_EVENT_METADATA_VALUE_MAX_CHARS);
      if (normalized) {
        result[key] = normalized;
      }
    } else if (typeof rawValue === 'number') {
      if (Number.isFinite(rawValue)) {
        result[key] = rawValue;
      }
    } else if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    } else if (Array.isArray(rawValue)) {
      const normalizedList = normalizeRefs(rawValue, 8);
      if (normalizedList.length > 0) {
        result[key] = normalizedList;
      }
    }
    if (Object.keys(result).length >= TIMELINE_EVENT_METADATA_MAX_KEYS) {
      break;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isTimelineEventKind(value: unknown): value is AoiOperatorTimelineEventKind {
  return (
    value === 'observation_ingested' ||
    value === 'source_selected' ||
    value === 'source_suppressed' ||
    value === 'proposal_created' ||
    value === 'proposal_blocked' ||
    value === 'proposal_accepted' ||
    value === 'proposal_dismissed' ||
    value === 'proposal_snoozed' ||
    value === 'proposal_executed' ||
    value === 'proposal_failed' ||
    value === 'mission_state_changed' ||
    value === 'goal_state_changed' ||
    value === 'digest_item_surfaced' ||
    value === 'digest_item_hidden' ||
    value === 'approved_command_previewed' ||
    value === 'approved_command_recorded' ||
    value === 'feedback_recorded' ||
    value === 'outcome_signal_recorded' ||
    value === 'operator_voice_decision' ||
    value === 'wakeup_recorded' ||
    value === 'trace_exported'
  );
}

function normalizeVisibility(value: unknown): AoiOperatorTimelineVisibility {
  if (
    value === 'operator_visible' ||
    value === 'dashboard_only' ||
    value === 'hidden' ||
    value === 'redacted'
  ) {
    return value;
  }
  return 'dashboard_only';
}

function normalizeRedactionState(value: unknown): AoiTraceRedactionState {
  if (value === 'none' || value === 'redacted' || value === 'synthetic' || value === 'removed') {
    return value;
  }
  return 'none';
}

function normalizeTimelineEvent(
  input: AoiOperatorTimelineEventInput | unknown,
  now = Date.now(),
): AoiOperatorTimelineEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as Partial<AoiOperatorTimelineEventInput>;
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  const kind = isTimelineEventKind(record.kind) ? record.kind : null;
  const title = truncateText(record.title, TIMELINE_EVENT_TITLE_MAX_CHARS);
  const summary = truncateText(record.summary, TIMELINE_EVENT_SUMMARY_MAX_CHARS);
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : now;
  if (!sessionPath || !kind || !title || !summary) {
    return null;
  }

  const event: AoiOperatorTimelineEvent = {
    version: 1,
    id: isValidAoiAutonomyId(record.id)
      ? record.id
      : createAoiAutonomyId(`aoi-timeline-${kind}`, createdAt),
    sessionPath,
    kind,
    visibility: normalizeVisibility(record.visibility),
    createdAt,
    title,
    summary,
    redactionState: normalizeRedactionState(record.redactionState),
    evidenceRefs: normalizeRefs(record.evidenceRefs),
    relatedRefs: normalizeRefs(record.relatedRefs),
  };

  const sourceRef = normalizeOptionalText(record.sourceRef, 240);
  const sourceKind = normalizeOptionalText(record.sourceKind, 80);
  const proposalId = normalizeOptionalText(record.proposalId, 128);
  const decisionId = normalizeOptionalText(record.decisionId, 128);
  const goalId = normalizeOptionalText(record.goalId, 128);
  const missionId = normalizeOptionalText(record.missionId, 128);
  const digestItemId = normalizeOptionalText(record.digestItemId, 128);
  const commandAuditId = normalizeOptionalText(record.commandAuditId, 128);
  const triggerKind = normalizeOptionalText(record.triggerKind, 80);
  const actionKind = normalizeOptionalText(record.actionKind, 80);
  const status = normalizeOptionalText(record.status, 80);
  const metadata = normalizeMetadata(record.metadata);
  const metrics =
    record.metrics && typeof record.metrics === 'object' && !Array.isArray(record.metrics)
      ? Object.fromEntries(
          Object.entries(record.metrics)
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
            .slice(0, 16),
        )
      : undefined;

  if (sourceRef) {
    event.sourceRef = sourceRef;
  }
  if (sourceKind) {
    event.sourceKind = sourceKind;
  }
  if (proposalId) {
    event.proposalId = proposalId;
  }
  if (decisionId) {
    event.decisionId = decisionId;
  }
  if (goalId) {
    event.goalId = goalId;
  }
  if (missionId) {
    event.missionId = missionId;
  }
  if (digestItemId) {
    event.digestItemId = digestItemId;
  }
  if (commandAuditId) {
    event.commandAuditId = commandAuditId;
  }
  if (triggerKind) {
    event.triggerKind = triggerKind;
  }
  if (actionKind) {
    event.actionKind = actionKind;
  }
  if (status) {
    event.status = status;
  }
  if (record.risk === 'low' || record.risk === 'medium' || record.risk === 'high') {
    event.risk = record.risk;
  }
  if (metrics && Object.keys(metrics).length > 0) {
    event.metrics = metrics;
  }
  if (metadata) {
    event.metadata = metadata;
  }

  return event;
}

function readTimelineEventsFile(filePath: string, now = Date.now()): AoiOperatorTimelineEvent[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    return fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeTimelineEvent(JSON.parse(line) as unknown, now);
        } catch {
          return null;
        }
      })
      .filter((event): event is AoiOperatorTimelineEvent => event !== null);
  } catch {
    return [];
  }
}

function sortTimelineEvents(
  events: AoiOperatorTimelineEvent[],
  newestFirst: boolean,
): AoiOperatorTimelineEvent[] {
  return [...events].sort((a, b) => {
    const byTime = newestFirst ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
    if (byTime !== 0) {
      return byTime;
    }
    return newestFirst ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
  });
}

function resolveTimelineFile(sessionsDir: string, sessionPath: string): string {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  if (!isPathInsideRoot(paths.root, paths.timelineEvents)) {
    throw new Error('Resolved Aoi timeline path escaped the autonomy directory.');
  }
  return paths.timelineEvents;
}

export function recordAoiOperatorTimelineEvent(
  sessionsDir: string,
  input: AoiOperatorTimelineEventInput,
): AoiOperatorTimelineEvent {
  const event = normalizeTimelineEvent(input);
  if (!event) {
    throw new Error('Invalid Aoi operator timeline event.');
  }
  const filePath = resolveTimelineFile(sessionsDir, event.sessionPath);
  ensureDirectory(filePath, true);
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  return event;
}

export function loadAoiOperatorTimelineEvents(
  sessionsDir: string,
  sessionPath: string,
  options: AoiOperatorTimelineLoadOptions = {},
): AoiOperatorTimelineEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const limit = clampLimit(options.limit, TIMELINE_LOAD_DEFAULT_LIMIT, TIMELINE_LOAD_MAX_LIMIT);
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const events = readTimelineEventsFile(resolveTimelineFile(sessionsDir, normalizedSessionPath))
    .filter((event) => event.sessionPath === normalizedSessionPath)
    .filter((event) => !kinds || kinds.has(event.kind));
  return sortTimelineEvents(events, options.newestFirst !== false).slice(0, limit);
}

function syntheticKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function createTraceRedactor(): Redactor {
  let localPathCount = 0;
  let urlCount = 0;
  let emailCount = 0;
  let privateFieldCount = 0;
  const localPathLabels = new Map<string, string>();
  const urlLabels = new Map<string, string>();
  const emailLabels = new Map<string, string>();
  const privateFieldLabels = new Map<string, string>();

  function labelFor(map: Map<string, string>, key: string, prefix: string): string {
    const stableKey = syntheticKey(key);
    const current = map.get(stableKey);
    if (current) {
      return current;
    }
    const label = `[${prefix}:${map.size + 1}]`;
    map.set(stableKey, label);
    return label;
  }

  function redactText(value: string): string {
    let next = value.replace(WINDOWS_PATH_PATTERN, (match) => {
      localPathCount += 1;
      return labelFor(localPathLabels, match, 'local-path');
    });
    next = next.replace(UNC_PATH_PATTERN, (match) => {
      localPathCount += 1;
      return labelFor(localPathLabels, match, 'local-path');
    });
    next = next.replace(URL_PATTERN, (match) => {
      urlCount += 1;
      return labelFor(urlLabels, match, 'url');
    });
    next = next.replace(EMAIL_PATTERN, (match) => {
      emailCount += 1;
      return labelFor(emailLabels, match, 'email');
    });
    return next;
  }

  function redactPersonalText(value: string): string {
    if (!value) {
      return value;
    }
    privateFieldCount += 1;
    return labelFor(privateFieldLabels, `personal:${value}`, 'personal-metadata');
  }

  function redactPrivateField(
    key: string,
    value: string | number | boolean | string[],
  ): string | number | boolean | string[] {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (!PRIVATE_METADATA_KEYS.has(normalizedKey)) {
      if (typeof value === 'string') {
        return redactText(value);
      }
      if (Array.isArray(value)) {
        return value.map((item) => redactText(item));
      }
      return value;
    }
    privateFieldCount += 1;
    if (Array.isArray(value)) {
      return value.map((item) => labelFor(privateFieldLabels, `${key}:${item}`, 'redacted-field'));
    }
    if (typeof value === 'string') {
      return labelFor(privateFieldLabels, `${key}:${value}`, 'redacted-field');
    }
    return labelFor(privateFieldLabels, `${key}:${String(value)}`, 'redacted-field');
  }

  function redactPersonalMetadata(
    key: string,
    value: string | number | boolean | string[],
  ): string | number | boolean | string[] {
    if (typeof value === 'boolean' || typeof value === 'number') {
      return value;
    }
    privateFieldCount += 1;
    if (Array.isArray(value)) {
      return value.map((item) =>
        labelFor(privateFieldLabels, `personal:${key}:${item}`, 'personal-metadata'),
      );
    }
    return labelFor(privateFieldLabels, `personal:${key}:${value}`, 'personal-metadata');
  }

  function buildSummary(): AoiTraceRedactionSummary {
    const syntheticLabels: Record<string, string> = {};
    for (const label of [
      ...localPathLabels.values(),
      ...urlLabels.values(),
      ...emailLabels.values(),
      ...privateFieldLabels.values(),
    ]) {
      syntheticLabels[label] = label;
    }
    return {
      totalReplacementCount: localPathCount + urlCount + emailCount + privateFieldCount,
      localPathCount,
      urlCount,
      emailCount,
      privateFieldCount,
      syntheticLabels,
    };
  }

  return {
    redactText,
    redactPersonalText,
    redactMetadata: redactPrivateField,
    redactPersonalMetadata,
    summary: buildSummary,
    didRedactSince: (previousCount: number) => buildSummary().totalReplacementCount > previousCount,
  };
}

function isPersonalTimelineEvent(event: AoiOperatorTimelineEvent): boolean {
  if (event.sourceKind && PERSONAL_SOURCE_KINDS.has(event.sourceKind)) {
    return true;
  }
  const refs = [event.sourceRef, ...event.evidenceRefs, ...event.relatedRefs].filter(
    (ref): ref is string => typeof ref === 'string',
  );
  return refs.some((ref) => PERSONAL_SOURCE_REFS.some((marker) => ref.includes(marker)));
}

function redactTimelineEvent(
  event: AoiOperatorTimelineEvent,
  redactor: Redactor,
): AoiOperatorTimelineEvent {
  const before = redactor.summary().totalReplacementCount;
  const personalEvent = isPersonalTimelineEvent(event);
  const metadata: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(event.metadata ?? {})) {
    metadata[key] = personalEvent
      ? redactor.redactPersonalMetadata(key, value)
      : redactor.redactMetadata(key, value);
  }

  const redacted: AoiOperatorTimelineEvent = {
    ...event,
    title: personalEvent
      ? redactor.redactPersonalText(event.title)
      : redactor.redactText(event.title),
    summary: personalEvent
      ? redactor.redactPersonalText(event.summary)
      : redactor.redactText(event.summary),
    evidenceRefs: event.evidenceRefs.map((ref) => redactor.redactText(ref)),
    relatedRefs: event.relatedRefs.map((ref) => redactor.redactText(ref)),
    ...(event.sourceRef ? { sourceRef: redactor.redactText(event.sourceRef) } : {}),
    ...(event.sourceKind ? { sourceKind: redactor.redactText(event.sourceKind) } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  if (redactor.didRedactSince(before)) {
    redacted.redactionState =
      redacted.redactionState === 'removed' ? redacted.redactionState : 'synthetic';
  }
  return redacted;
}

function resolveTraceExportFile(
  sessionsDir: string,
  sessionPath: string,
  exportId: string,
): string {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  if (!isPathInsideRoot(paths.root, paths.timelineExportsDir)) {
    throw new Error('Resolved Aoi trace export path escaped the autonomy directory.');
  }
  if (!isValidAoiAutonomyId(exportId)) {
    throw new Error('Invalid trace export id.');
  }
  return join(paths.timelineExportsDir, `${exportId}.json`);
}

function normalizeTraceExport(value: unknown): AoiOperatorTraceExport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiOperatorTraceExport>;
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (
    record.version !== 1 ||
    !isValidAoiAutonomyId(record.id) ||
    !sessionPath ||
    typeof record.exportedAt !== 'number' ||
    !Array.isArray(record.events) ||
    !record.redactionSummary ||
    typeof record.redactionSummary !== 'object'
  ) {
    return null;
  }
  const events = record.events
    .map((event) => normalizeTimelineEvent(event, record.exportedAt))
    .filter((event): event is AoiOperatorTimelineEvent => event !== null);
  const sourceEventIds = normalizeRefs(record.sourceEventIds, TRACE_EXPORT_MAX_LIMIT);
  const privacyNotes = normalizeRefs(record.privacyNotes, 12);
  const redactionSummary = record.redactionSummary as Partial<AoiTraceRedactionSummary>;
  return {
    version: 1,
    id: record.id,
    sessionPath,
    exportedAt: record.exportedAt,
    eventCount: events.length,
    sourceEventIds,
    events,
    redactionSummary: {
      totalReplacementCount:
        typeof redactionSummary.totalReplacementCount === 'number'
          ? redactionSummary.totalReplacementCount
          : 0,
      localPathCount:
        typeof redactionSummary.localPathCount === 'number' ? redactionSummary.localPathCount : 0,
      urlCount: typeof redactionSummary.urlCount === 'number' ? redactionSummary.urlCount : 0,
      emailCount: typeof redactionSummary.emailCount === 'number' ? redactionSummary.emailCount : 0,
      privateFieldCount:
        typeof redactionSummary.privateFieldCount === 'number'
          ? redactionSummary.privateFieldCount
          : 0,
      syntheticLabels:
        redactionSummary.syntheticLabels &&
        typeof redactionSummary.syntheticLabels === 'object' &&
        !Array.isArray(redactionSummary.syntheticLabels)
          ? Object.fromEntries(
              Object.entries(redactionSummary.syntheticLabels).filter(
                ([key, value]) => typeof key === 'string' && typeof value === 'string',
              ),
            )
          : {},
    },
    privacyNotes,
  };
}

export function buildAoiOperatorTraceExportFromEvents(params: {
  sessionPath: string;
  events: AoiOperatorTimelineEvent[];
  exportedAt?: number;
  exportId?: string;
  limit?: number;
}): AoiOperatorTraceExport {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const exportedAt = params.exportedAt ?? Date.now();
  const limit = clampLimit(params.limit, TRACE_EXPORT_DEFAULT_LIMIT, TRACE_EXPORT_MAX_LIMIT);
  const sourceEvents = sortTimelineEvents(params.events.slice(0, limit), false);
  const redactor = createTraceRedactor();
  const events = sourceEvents.map((event) => redactTimelineEvent(event, redactor));
  const exportRecord: AoiOperatorTraceExport = {
    version: 1,
    id: params.exportId ?? createAoiAutonomyId('aoi-trace-export', exportedAt),
    sessionPath: normalizedSessionPath,
    exportedAt,
    eventCount: events.length,
    sourceEventIds: sourceEvents.map((event) => event.id),
    events,
    redactionSummary: redactor.summary(),
    privacyNotes: [
      'Export is explicit only; no background trace export is performed.',
      'Local paths, URLs, email addresses, message bodies, command output, and private metadata fields are replaced with synthetic labels.',
      'Replay fixture promotion produces a draft and does not mutate built-in fixtures.',
    ],
  };

  if (!isValidAoiAutonomyId(exportRecord.id)) {
    throw new Error('Invalid trace export id.');
  }
  return exportRecord;
}

export function exportAoiOperatorTrace(
  sessionsDir: string,
  sessionPath: string,
  options: AoiOperatorTraceExportOptions = {},
): AoiOperatorTraceExport {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const exportedAt = options.now ?? Date.now();
  const limit = clampLimit(options.limit, TRACE_EXPORT_DEFAULT_LIMIT, TRACE_EXPORT_MAX_LIMIT);
  const kinds = options.eventKinds?.length
    ? new Set(options.eventKinds)
    : DEFAULT_TRACE_EXPORT_KINDS;
  const sourceEvents = sortTimelineEvents(
    loadAoiOperatorTimelineEvents(sessionsDir, normalizedSessionPath, {
      limit: TIMELINE_LOAD_MAX_LIMIT,
    })
      .filter((event) => kinds.has(event.kind))
      .slice(0, limit),
    false,
  );
  const exportRecord = buildAoiOperatorTraceExportFromEvents({
    sessionPath: normalizedSessionPath,
    events: sourceEvents,
    exportedAt,
  });

  if (options.persist !== false) {
    writeJsonAtomic(
      resolveTraceExportFile(sessionsDir, normalizedSessionPath, exportRecord.id),
      exportRecord,
    );
    recordAoiOperatorTimelineEvent(sessionsDir, {
      sessionPath: normalizedSessionPath,
      kind: 'trace_exported',
      visibility: 'dashboard_only',
      createdAt: exportedAt,
      title: 'Trace export created',
      summary: `Trace export ${exportRecord.id} contains ${exportRecord.events.length} redacted timeline events.`,
      evidenceRefs: [`trace-export:${exportRecord.id}`],
      relatedRefs: exportRecord.sourceEventIds.map((id) => `timeline:${id}`),
      redactionState:
        exportRecord.redactionSummary.totalReplacementCount > 0 ? 'synthetic' : 'none',
      metadata: {
        eventCount: exportRecord.events.length,
        redactionCount: exportRecord.redactionSummary.totalReplacementCount,
      },
    });
  }

  return exportRecord;
}

export function loadAoiOperatorTraceExports(
  sessionsDir: string,
  sessionPath: string,
  limit = 20,
): AoiOperatorTraceExport[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const resolvedExportsDir = resolve(paths.timelineExportsDir);
  if (!isPathInsideRoot(paths.root, resolvedExportsDir)) {
    throw new Error('Resolved Aoi trace export path escaped the autonomy directory.');
  }
  try {
    if (!fs.existsSync(resolvedExportsDir)) {
      return [];
    }
    return fs
      .readdirSync(resolvedExportsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        try {
          return normalizeTraceExport(
            JSON.parse(fs.readFileSync(join(resolvedExportsDir, entry.name), 'utf-8')) as unknown,
          );
        } catch {
          return null;
        }
      })
      .filter((item): item is AoiOperatorTraceExport => item !== null)
      .filter((item) => item.sessionPath === normalizedSessionPath)
      .sort((a, b) => b.exportedAt - a.exportedAt || b.id.localeCompare(a.id))
      .slice(0, clampLimit(limit, 20, 100));
  } catch {
    return [];
  }
}

export function buildAoiOperatorTimelineSummary(params: {
  sessionPath: string;
  events: AoiOperatorTimelineEvent[];
  exports?: AoiOperatorTraceExport[];
  meaningfulLimit?: number;
}): AoiOperatorTimelineSummary {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath) ?? params.sessionPath;
  const sortedEvents = sortTimelineEvents(params.events, true);
  const newestMeaningfulEvents = sortedEvents
    .filter((event) => TIMELINE_MEANINGFUL_KINDS.has(event.kind))
    .slice(0, clampLimit(params.meaningfulLimit, 8, 20));
  const newestExport = [...(params.exports ?? [])].sort(
    (a, b) => b.exportedAt - a.exportedAt || b.id.localeCompare(a.id),
  )[0];
  return {
    version: 1,
    sessionPath,
    newestMeaningfulEvents,
    newestEventAt: sortedEvents[0]?.createdAt,
    lastExportAt: newestExport?.exportedAt,
    lastExportRedactionCount: newestExport?.redactionSummary.totalReplacementCount ?? 0,
    totalEventCount: params.events.length,
    exportedTraceCount: params.exports?.length ?? 0,
  };
}

export function loadAoiOperatorTimelineSummary(
  sessionsDir: string,
  sessionPath: string,
): AoiOperatorTimelineSummary {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const events = loadAoiOperatorTimelineEvents(sessionsDir, normalizedSessionPath, {
    limit: TIMELINE_LOAD_MAX_LIMIT,
  });
  const exports = loadAoiOperatorTraceExports(sessionsDir, normalizedSessionPath, 20);
  return buildAoiOperatorTimelineSummary({
    sessionPath: normalizedSessionPath,
    events,
    exports,
  });
}

function timelineKindToReplayKind(kind: AoiOperatorTimelineEventKind): AoiReplayInputEventKind {
  if (
    kind === 'proposal_created' ||
    kind === 'proposal_blocked' ||
    kind === 'proposal_accepted' ||
    kind === 'proposal_dismissed' ||
    kind === 'proposal_snoozed' ||
    kind === 'proposal_executed' ||
    kind === 'proposal_failed'
  ) {
    return 'proposal_decision';
  }
  if (kind === 'mission_state_changed') {
    return 'mission_state';
  }
  if (kind === 'goal_state_changed') {
    return 'active_goal';
  }
  if (kind === 'feedback_recorded' || kind === 'outcome_signal_recorded') {
    return 'context_feedback';
  }
  return 'environment_source';
}

function sanitizeFixtureId(value: string): string {
  return (
    normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'trace-draft'
  );
}

export function createAoiReplayFixtureDraftFromTraceExport(
  traceExport: AoiOperatorTraceExport,
  options: { fixtureId?: string; title?: string; latestUserMessage?: string } = {},
): AoiOperatorReplayFixtureDraftResult {
  const fixtureId = sanitizeFixtureId(options.fixtureId ?? `trace-draft-${traceExport.id}`);
  const inputEvents: AoiReplayInputEvent[] = traceExport.events.map((event) => ({
    version: 1,
    id: sanitizeFixtureId(`trace-${event.id}`),
    kind: timelineKindToReplayKind(event.kind),
    createdAt: event.createdAt,
    summary: event.summary,
    sourceRef: event.sourceRef ?? `${event.kind}:${event.id}`,
    evidenceRefs: event.evidenceRefs,
  }));
  const title =
    options.title ??
    `TODO review privacy-safe trace export ${traceExport.id} before adding replay expectations`;
  const fixture: AoiOperatorReplayFixture = {
    version: 1,
    id: fixtureId,
    title,
    description:
      'Draft generated from a privacy-safe timeline trace. Replace TODO expectation before adding to built-in fixtures.',
    sessionPath: traceExport.sessionPath,
    now: traceExport.exportedAt,
    latestUserMessage:
      options.latestUserMessage ??
      'TODO: replace with a synthetic user message that exercises this trace.',
    inputEvents,
    expectedDecisions: [
      {
        id: 'todo-review-exported-trace',
        metric: 'snapshot_summary',
        label: 'TODO: replace this placeholder with concrete replay expectations.',
        snapshotIncludes: 'TODO_REPLACE_THIS_EXPECTATION',
      },
    ],
  };
  return {
    version: 1,
    traceExportId: traceExport.id,
    fixtureId,
    title,
    fixture,
    todoExpectations: [
      'Review event ordering and remove events that are not needed for deterministic replay.',
      'Replace the placeholder snapshot expectation with concrete source, proposal, digest, or boundary expectations.',
      'Keep synthetic labels; do not paste raw local paths, message bodies, command output, email, or calendar content back into the fixture.',
    ],
    warnings: [
      'This helper does not execute shell commands, call network APIs, read source files, or mutate built-in replay fixtures.',
    ],
  };
}

export function recordAoiOperatorVoiceDecisionTimelineEvent(params: {
  sessionsDir: string;
  sessionPath: string;
  decision: AoiVoiceRenderDecision;
}): AoiOperatorTimelineEvent {
  const summaryId = params.decision.summaryId ?? 'none';
  const transcriptHash = params.decision.transcriptHash ?? 'none';
  const reason = params.decision.silentReason || params.decision.status;
  return recordAoiOperatorTimelineEvent(params.sessionsDir, {
    sessionPath: params.sessionPath,
    kind: 'operator_voice_decision',
    visibility: params.decision.status === 'spoken' ? 'operator_visible' : 'dashboard_only',
    createdAt: params.decision.createdAt,
    title: `Operator voice ${params.decision.status.replace(/_/g, ' ')}`,
    summary: `Operator voice ${params.decision.status.replace(/_/g, ' ')} for ${
      params.decision.category ?? 'no_event'
    }: ${reason}.`,
    redactionState: 'redacted',
    evidenceRefs: params.decision.evidenceRefs,
    relatedRefs: [
      ...(params.decision.eventId ? [`voice-event:${params.decision.eventId}`] : []),
      ...(params.decision.summaryId ? [`voice-summary:${params.decision.summaryId}`] : []),
    ],
    sourceRef: params.decision.eventDedupeKey,
    sourceKind: params.decision.category,
    status: params.decision.status,
    metadata: {
      category: params.decision.category,
      status: params.decision.status,
      shouldSpeak: params.decision.shouldSpeak,
      summaryId,
      transcriptHash,
      silentReason: params.decision.silentReason,
      reasons: params.decision.reasons,
      replayable: params.decision.replayable,
    },
  });
}

export function recordAoiObservationTimelineEvent(params: {
  sessionsDir: string;
  observation: AoiObservation;
  created: boolean;
}): AoiOperatorTimelineEvent {
  return recordAoiOperatorTimelineEvent(params.sessionsDir, {
    sessionPath: params.observation.sessionPath,
    kind: 'observation_ingested',
    visibility: params.created ? 'dashboard_only' : 'hidden',
    createdAt: params.observation.createdAt,
    title: params.created ? 'Observation ingested' : 'Observation refreshed',
    summary: `${params.observation.source} observation: ${params.observation.summary}`,
    sourceRef: params.observation.payloadRef ?? `observation:${params.observation.id}`,
    sourceKind: params.observation.source,
    evidenceRefs: [
      ...(params.observation.payloadRef ? [params.observation.payloadRef] : []),
      ...params.observation.artifactRefs,
      ...params.observation.memoryIds.map((id) => `memory:${id}`),
    ],
    relatedRefs: [
      `observation:${params.observation.id}`,
      ...params.observation.proposalIds.map((id) => `proposal:${id}`),
    ],
    metadata: {
      observationId: params.observation.id,
      created: params.created,
      dedupeKey: params.observation.dedupeKey,
    },
  });
}

export function recordAoiProposalCreatedTimelineEvent(params: {
  sessionsDir: string;
  proposal: AoiProposal;
  now?: number;
}): AoiOperatorTimelineEvent {
  return recordAoiOperatorTimelineEvent(params.sessionsDir, {
    sessionPath: params.proposal.sessionPath,
    kind: 'proposal_created',
    visibility: 'operator_visible',
    createdAt: params.now ?? params.proposal.createdAt,
    title: 'Proposal created',
    summary: `Proposal created: ${params.proposal.title}`,
    proposalId: params.proposal.id,
    triggerKind: params.proposal.trigger,
    actionKind: params.proposal.acceptAction?.kind,
    status: params.proposal.status,
    risk: params.proposal.risk,
    evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
    relatedRefs: [`proposal:${params.proposal.id}`],
    metadata: {
      cooldownKey: params.proposal.cooldownKey,
      confidence: params.proposal.confidence,
      requiredAutonomyLevel: params.proposal.requiredAutonomyLevel,
      requiresUserApproval: params.proposal.requiresUserApproval,
      suggestedTools: params.proposal.suggestedTools,
    },
  });
}

export function recordAoiProposalBlockedTimelineEvent(params: {
  sessionsDir: string;
  proposal: AoiProposal;
  reasons: string[];
  now?: number;
}): AoiOperatorTimelineEvent {
  return recordAoiOperatorTimelineEvent(params.sessionsDir, {
    sessionPath: params.proposal.sessionPath,
    kind: 'proposal_blocked',
    visibility: 'operator_visible',
    createdAt: params.now ?? Date.now(),
    title: 'Proposal blocked',
    summary: `Proposal blocked: ${params.proposal.title}`,
    proposalId: params.proposal.id,
    triggerKind: params.proposal.trigger,
    actionKind: params.proposal.acceptAction?.kind,
    status: 'blocked',
    risk: params.proposal.risk,
    evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
    relatedRefs: [`proposal:${params.proposal.id}`],
    metadata: {
      reasons: params.reasons,
      cooldownKey: params.proposal.cooldownKey,
      requiredAutonomyLevel: params.proposal.requiredAutonomyLevel,
      requiresUserApproval: params.proposal.requiresUserApproval,
    },
  });
}

function proposalDecisionKind(decision: AoiProposalDecision): AoiOperatorTimelineEventKind {
  if (decision.action === 'accept') {
    return 'proposal_accepted';
  }
  if (decision.action === 'dismiss') {
    return 'proposal_dismissed';
  }
  if (decision.action === 'snooze') {
    return 'proposal_snoozed';
  }
  if (decision.action === 'execute') {
    return 'proposal_executed';
  }
  if (decision.action === 'block' && decision.reason?.startsWith('execution_failed:')) {
    return 'proposal_failed';
  }
  return decision.nextStatus === 'blocked' ? 'proposal_blocked' : 'proposal_failed';
}

export function recordAoiProposalDecisionTimelineEvent(params: {
  sessionsDir: string;
  proposal: AoiProposal;
  decision: AoiProposalDecision;
}): AoiOperatorTimelineEvent {
  const kind = proposalDecisionKind(params.decision);
  return recordAoiOperatorTimelineEvent(params.sessionsDir, {
    sessionPath: params.decision.sessionPath,
    kind,
    visibility: kind === 'proposal_snoozed' ? 'dashboard_only' : 'operator_visible',
    createdAt: params.decision.createdAt,
    title: `Proposal ${params.decision.action}`,
    summary: `Proposal ${params.decision.action}: ${params.proposal.title}`,
    proposalId: params.proposal.id,
    decisionId: params.decision.id,
    triggerKind: params.decision.proposalTrigger,
    actionKind: params.decision.actionKind,
    status: params.decision.nextStatus,
    risk: params.decision.proposalRisk ?? params.proposal.risk,
    evidenceRefs: [
      ...(params.decision.evidenceRefs ?? []),
      ...params.proposal.evidenceRefs,
      ...params.proposal.artifactRefs,
    ],
    relatedRefs: [`proposal:${params.proposal.id}`, `decision:${params.decision.id}`],
    metadata: {
      actor: params.decision.actor,
      previousStatus: params.decision.previousStatus,
      nextStatus: params.decision.nextStatus,
      feedbackCategory: params.decision.feedbackCategory,
      snoozedUntil: params.decision.snoozedUntil,
    },
  });
}

export function recordAoiProposalFeedbackTimelineEvent(params: {
  sessionsDir: string;
  decision: AoiProposalDecision;
}): AoiOperatorTimelineEvent {
  return recordAoiOperatorTimelineEvent(params.sessionsDir, {
    sessionPath: params.decision.sessionPath,
    kind: 'feedback_recorded',
    visibility: 'operator_visible',
    createdAt: params.decision.createdAt,
    title: 'Proposal feedback recorded',
    summary: `Feedback category ${params.decision.feedbackCategory ?? 'unknown'} recorded for proposal ${params.decision.proposalId}.`,
    proposalId: params.decision.proposalId,
    decisionId: params.decision.id,
    evidenceRefs: params.decision.evidenceRefs ?? [],
    relatedRefs: [`proposal:${params.decision.proposalId}`, `decision:${params.decision.id}`],
    metadata: {
      feedbackCategory: params.decision.feedbackCategory,
    },
  });
}

function redactionStateForOutcome(outcome: AoiOutcomeSignalRecord): AoiTraceRedactionState {
  if (outcome.privacyState === 'redacted' || outcome.privacyState === 'unknown') {
    return 'redacted';
  }
  if (outcome.privacyState === 'synthetic') {
    return 'synthetic';
  }
  return 'none';
}

export function buildAoiOutcomeSignalTimelineEventInput(
  outcome: AoiOutcomeSignalRecord,
): AoiOperatorTimelineEventInput {
  const sourceRef =
    outcome.sourceProposalId ??
    outcome.sourceDecisionId ??
    outcome.sourceWorkOrderId ??
    outcome.sourceChatRef ??
    outcome.eventId;
  const targetLabel = outcome.sourceProposalId
    ? `proposal ${outcome.sourceProposalId}`
    : outcome.sourceWorkOrderId
      ? `work order ${outcome.sourceWorkOrderId}`
      : outcome.sourceChatRef
        ? `chat ${outcome.sourceChatRef}`
        : outcome.eventId;
  return {
    id: createAoiAutonomyId('aoi-timeline-outcome', outcome.createdAt),
    sessionPath: outcome.sessionPath,
    kind: 'outcome_signal_recorded',
    visibility: 'dashboard_only',
    createdAt: outcome.createdAt,
    title: `Outcome recorded: ${outcome.outcomeKind.replace(/_/g, ' ')}`,
    summary: `Previous suggestion ${targetLabel} led to ${outcome.outcomeKind.replace(
      /_/g,
      ' ',
    )}; confidence ${outcome.confidence.toFixed(2)} is ${outcome.signalKind.replace(
      /_/g,
      ' ',
    )} calibration only.`,
    redactionState: redactionStateForOutcome(outcome),
    evidenceRefs: outcome.evidenceRefs,
    relatedRefs: [
      `outcome:${outcome.id}`,
      ...(outcome.sourceProposalId ? [`proposal:${outcome.sourceProposalId}`] : []),
      ...(outcome.sourceDecisionId ? [`decision:${outcome.sourceDecisionId}`] : []),
      ...(outcome.sourceWorkOrderId ? [`bounded-work-order:${outcome.sourceWorkOrderId}`] : []),
      ...(outcome.explicitLabelRef ? [`explicit-label:${outcome.explicitLabelRef}`] : []),
    ],
    sourceRef,
    sourceKind: 'outcome_learning',
    proposalId: outcome.sourceProposalId,
    decisionId: outcome.sourceDecisionId,
    status: outcome.outcomeKind,
    metrics: {
      confidence: outcome.confidence,
      learningMagnitude: outcome.inferredAdjustment.magnitude,
      mutationCount: outcome.mutationCount,
    },
    metadata: {
      outcomeId: outcome.id,
      outcomeKind: outcome.outcomeKind,
      signalKind: outcome.signalKind,
      explicitLabelLinked: Boolean(outcome.explicitLabelRef),
      adjustmentTarget: outcome.inferredAdjustment.target,
      adjustmentDirection: outcome.inferredAdjustment.direction,
      privacyState: outcome.privacyState,
      result: outcome.result,
    },
  };
}

export function recordAoiOutcomeSignalTimelineEvent(params: {
  sessionsDir: string;
  outcome: AoiOutcomeSignalRecord;
}): AoiOperatorTimelineEvent {
  return recordAoiOperatorTimelineEvent(
    params.sessionsDir,
    buildAoiOutcomeSignalTimelineEventInput(params.outcome),
  );
}

export function buildAoiContextRouterTimelineEvents(
  context: AoiContextRouterResult,
): AoiOperatorTimelineEventInput[] {
  const selectedIds = new Set(context.selectedSources.map((source) => source.id));
  const selectedEvents = context.selectedSources.map(
    (source): AoiOperatorTimelineEventInput => ({
      sessionPath: context.sessionPath,
      kind: 'source_selected',
      visibility: source.redactionState === 'withheld' ? 'redacted' : 'dashboard_only',
      createdAt: context.generatedAt,
      title: `Source selected: ${source.displayName ?? source.label}`,
      summary: source.summary,
      sourceRef: `context-source:${source.id}`,
      sourceKind: source.kind,
      evidenceRefs: source.evidenceRefs,
      relatedRefs: [`environment-source:${source.sourceId}`, `context-source:${source.id}`],
      metrics: {
        relevanceScore: source.relevanceScore,
        confidence: source.confidence,
      },
      metadata: {
        sourceId: source.sourceId,
        freshness: source.freshness,
        redactionState: source.redactionState,
        scoreReasons: source.scoreReasons,
      },
    }),
  );
  const suppressedEvents = context.candidateSources
    .filter((source) => !selectedIds.has(source.id))
    .map(
      (source): AoiOperatorTimelineEventInput => ({
        sessionPath: context.sessionPath,
        kind: 'source_suppressed',
        visibility: 'hidden',
        createdAt: context.generatedAt,
        title: `Source suppressed: ${source.displayName ?? source.label}`,
        summary: source.summary,
        sourceRef: `context-source:${source.id}`,
        sourceKind: source.kind,
        evidenceRefs: source.evidenceRefs,
        relatedRefs: [`environment-source:${source.sourceId}`, `context-source:${source.id}`],
        metrics: {
          relevanceScore: source.relevanceScore,
          confidence: source.confidence,
        },
        metadata: {
          sourceId: source.sourceId,
          freshness: source.freshness,
          redactionState: source.redactionState,
          scoreReasons: source.scoreReasons,
        },
      }),
    );
  return [...selectedEvents, ...suppressedEvents];
}

function digestItemToTimelineEvent(
  digest: AoiOperatorDigest,
  item: AoiDigestItem,
): AoiOperatorTimelineEventInput {
  const hidden = item.hidden || item.lane === 'hidden_by_quiet_mode';
  return {
    sessionPath: digest.sessionPath,
    kind: hidden ? 'digest_item_hidden' : 'digest_item_surfaced',
    visibility: hidden ? 'hidden' : 'operator_visible',
    createdAt: digest.generatedAt,
    title: hidden ? `Digest hidden: ${item.title}` : `Digest surfaced: ${item.title}`,
    summary: item.summary,
    digestItemId: item.id,
    sourceRef: item.sourceRefs[0],
    sourceKind: item.kind,
    risk: item.risk,
    evidenceRefs: item.evidenceRefs,
    relatedRefs: item.sourceRefs,
    metrics: {
      relevance: item.relevance,
    },
    metadata: {
      lane: item.lane,
      hidden,
      dedupeKey: item.dedupeKey,
      nextSafeAction: item.nextSafeAction,
    },
  };
}

export function buildAoiDigestTimelineEvents(
  digest: AoiOperatorDigest,
): AoiOperatorTimelineEventInput[] {
  const itemEvents = digest.items.map((item) => digestItemToTimelineEvent(digest, item));
  const approvalEvents = digest.approvalInbox.map(
    (item): AoiOperatorTimelineEventInput => ({
      sessionPath: digest.sessionPath,
      kind: 'digest_item_surfaced',
      visibility: 'operator_visible',
      createdAt: digest.generatedAt,
      title: `Approval surfaced: ${item.title}`,
      summary: item.exactNextAction,
      digestItemId: `approval:${item.proposalId}`,
      proposalId: item.proposalId,
      actionKind: item.actionKind,
      status: item.status,
      risk: item.risk,
      evidenceRefs: item.evidenceRefs,
      relatedRefs: [`proposal:${item.proposalId}`],
      metadata: {
        boundary: item.boundary,
        requiredAutonomyLevel: item.requiredAutonomyLevel,
        evidenceCount: item.evidenceCount,
      },
    }),
  );
  return [...itemEvents, ...approvalEvents];
}

export function buildAoiMissionTimelineEvent(
  mission: AoiMissionState,
): AoiOperatorTimelineEventInput {
  const transition = mission.transitions[mission.transitions.length - 1];
  return {
    sessionPath: mission.sessionPath,
    kind: 'mission_state_changed',
    visibility: 'operator_visible',
    createdAt: transition?.createdAt ?? mission.updatedAt,
    title: `Mission ${mission.status}`,
    summary: mission.focusSummary,
    missionId: mission.activeGoalId ? `mission:${mission.activeGoalId}` : 'mission:current',
    goalId: mission.activeGoalId,
    status: mission.status,
    evidenceRefs: mission.evidenceRefs,
    relatedRefs: [
      ...Object.values(mission.sourceRefs).filter(
        (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0,
      ),
    ],
    metadata: {
      waitingOn: mission.waitingOn,
      nextAction: mission.nextRecommendedAction.kind,
      transitionReason: transition?.reason,
    },
  };
}

export function buildAoiGoalProgressTimelineEvent(
  event: AoiGoalProgressEvent,
): AoiOperatorTimelineEventInput {
  return {
    sessionPath: event.sessionPath,
    kind: 'goal_state_changed',
    visibility: 'operator_visible',
    createdAt: event.createdAt,
    title: `Goal ${event.kind}`,
    summary: event.summary,
    goalId: event.goalId,
    status: event.toStatus ?? event.kind,
    evidenceRefs: event.evidenceRefs,
    relatedRefs: [
      `goal:${event.goalId}`,
      ...event.observationIds.map((id) => `observation:${id}`),
      ...event.proposalIds.map((id) => `proposal:${id}`),
      ...(event.planStepId ? [`plan-step:${event.planStepId}`] : []),
    ],
    metadata: {
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
    },
  };
}
