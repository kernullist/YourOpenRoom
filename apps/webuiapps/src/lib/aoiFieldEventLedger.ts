import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import {
  sanitizeAoiFieldSignalText,
  type AoiFieldSignalBodyAccess,
  type AoiFieldSignalPacket,
  type AoiFieldSignalSourceKind,
} from './aoiFieldSignalBridge';

const FIELD_LEDGER_DIR = 'field-event-ledger';
const FIELD_EVENTS_FILE = 'events.jsonl';
const MAX_EVENTS = 1000;
const MAX_SUMMARY_EVENTS = 12;
const MAX_REFS = 24;
const DEFAULT_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AoiFieldEventCategory =
  | 'signal_observed'
  | 'opportunity_created'
  | 'opportunity_deduped'
  | 'deliberation_ready'
  | 'deliberation_blocked'
  | 'delivery_hidden'
  | 'delivery_dashboard'
  | 'delivery_inline'
  | 'delivery_direct_chat_candidate'
  | 'action_ladder_blocked'
  | 'work_order_prepared'
  | 'feedback_recorded'
  | 'trace_promotion_candidate_created'
  | 'readiness_gate_changed';

export type AoiFieldEventPrivacyState =
  | 'none'
  | 'metadata_only'
  | 'explicit_body_allowed'
  | 'redacted'
  | 'unknown';

export interface AoiFieldEvent {
  version: 1;
  id: string;
  sessionPath: string;
  category: AoiFieldEventCategory;
  summary: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  privacyState: AoiFieldEventPrivacyState;
  mutationCount: 0;
  cannotKnow: string[];
  createdAt: number;
  expiresAt: number;
  actionAuthority: 'display_only';
  signalIds: string[];
}

export interface AoiFieldEventInput {
  id?: unknown;
  sessionPath?: unknown;
  category?: unknown;
  summary?: unknown;
  sourceRefs?: unknown;
  evidenceRefs?: unknown;
  privacyState?: unknown;
  mutationCount?: unknown;
  cannotKnow?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  signalIds?: unknown;
  dedupeKey?: unknown;
}

export interface AoiFieldEventLedgerPaths {
  root: string;
  events: string;
}

export interface AoiFieldLedgerSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  totalEventCount: number;
  activeEventCount: number;
  expiredEventCount: number;
  categoryCounts: Record<AoiFieldEventCategory, number>;
  privacyCounts: Record<AoiFieldEventPrivacyState, number>;
  sourceKindCounts: Record<AoiFieldSignalSourceKind | 'unknown', number>;
  recentEvents: AoiFieldEvent[];
  evidenceRefs: string[];
  cannotKnow: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  zeroMutation: true;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
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

function appendJsonLine(root: string, filePath: string, value: unknown): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved Aoi field event path escaped the autonomy root.');
  }
  ensureDirectory(filePath, true);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeJsonLines(root: string, filePath: string, values: readonly unknown[]): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved Aoi field event path escaped the autonomy root.');
  }
  ensureDirectory(filePath, true);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  const payload = values.map((value) => JSON.stringify(value)).join('\n');
  fs.writeFileSync(tmpPath, payload ? `${payload}\n` : '', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonLines(filePath: string): unknown[] {
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
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((item): item is unknown => item !== null);
  } catch {
    return [];
  }
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

function normalizeStringList(value: unknown, maxItems = MAX_REFS): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = sanitizeAoiFieldSignalText(item, 180);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function normalizeCategory(value: unknown): AoiFieldEventCategory {
  if (
    value === 'signal_observed' ||
    value === 'opportunity_created' ||
    value === 'opportunity_deduped' ||
    value === 'deliberation_ready' ||
    value === 'deliberation_blocked' ||
    value === 'delivery_hidden' ||
    value === 'delivery_dashboard' ||
    value === 'delivery_inline' ||
    value === 'delivery_direct_chat_candidate' ||
    value === 'action_ladder_blocked' ||
    value === 'work_order_prepared' ||
    value === 'feedback_recorded' ||
    value === 'trace_promotion_candidate_created' ||
    value === 'readiness_gate_changed'
  ) {
    return value;
  }
  return 'signal_observed';
}

function normalizePrivacyState(value: unknown): AoiFieldEventPrivacyState {
  if (
    value === 'none' ||
    value === 'metadata_only' ||
    value === 'explicit_body_allowed' ||
    value === 'redacted' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function privacyStateFromBodyAccess(
  bodyAccess: AoiFieldSignalBodyAccess,
): AoiFieldEventPrivacyState {
  if (bodyAccess === 'none') {
    return 'none';
  }
  return bodyAccess;
}

function hasRedactionMarker(values: readonly string[]): boolean {
  return values.some((value) =>
    /\[redacted-|redacted_secret|\[path]|\[email]|\[secret]/i.test(value),
  );
}

function normalizeStablePart(value: unknown, fallback: string): string {
  const sanitized = sanitizeAoiFieldSignalText(value, 120)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return sanitized || fallback;
}

function makeEventId(params: {
  id?: unknown;
  sessionPath: string;
  category: AoiFieldEventCategory;
  summary: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  createdAt: number;
  dedupeKey?: unknown;
}): string {
  const explicit = normalizeStablePart(params.id, '');
  if (explicit) {
    return explicit.startsWith('aoi-field-event-') ? explicit : `aoi-field-event-${explicit}`;
  }
  const dedupe = sanitizeAoiFieldSignalText(params.dedupeKey, 180);
  const key = [
    params.sessionPath,
    params.category,
    dedupe || params.summary,
    params.sourceRefs.join(','),
    params.evidenceRefs.join(','),
    String(params.createdAt),
  ].join('|');
  return `aoi-field-event-${hashText(key)}`;
}

function sourceKindFromRef(ref: string): AoiFieldSignalSourceKind | 'unknown' {
  if (/^workspace:/i.test(ref)) {
    return 'workspace';
  }
  if (/^research:/i.test(ref)) {
    return 'research';
  }
  if (/^kira:/i.test(ref)) {
    return 'kira';
  }
  if (/^app(?:-|_)?state:/i.test(ref)) {
    return 'app_state';
  }
  if (/^(?:personal|gmail|calendar|notes)(?:-|_)?metadata:/i.test(ref)) {
    return 'personal_metadata';
  }
  if (/^memory:/i.test(ref)) {
    return 'memory';
  }
  if (/^manual:/i.test(ref)) {
    return 'manual';
  }
  return 'unknown';
}

function normalizeCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return keys.reduce(
    (out, key) => {
      out[key] = 0;
      return out;
    },
    {} as Record<T, number>,
  );
}

export function resolveAoiFieldEventLedgerPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiFieldEventLedgerPaths {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const autonomyPaths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const root = join(autonomyPaths.root, FIELD_LEDGER_DIR);
  return {
    root,
    events: join(root, FIELD_EVENTS_FILE),
  };
}

export function normalizeAoiFieldEvent(
  input: AoiFieldEventInput,
  defaultSessionPath?: string,
  now = Date.now(),
): AoiFieldEvent | null {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath ?? defaultSessionPath);
  if (!sessionPath) {
    return null;
  }
  const category = normalizeCategory(input.category);
  const createdAt = normalizeTimestamp(input.createdAt, now);
  const summary = sanitizeAoiFieldSignalText(input.summary) || `${category.replace(/_/g, ' ')}.`;
  const sourceRefs = normalizeStringList(input.sourceRefs);
  const evidenceRefs = normalizeStringList(input.evidenceRefs);
  const cannotKnow = normalizeStringList(input.cannotKnow);
  const signalIds = normalizeStringList(input.signalIds);
  const expiresAt = Math.max(
    normalizeTimestamp(input.expiresAt, createdAt + DEFAULT_EVENT_TTL_MS),
    createdAt,
  );
  const redacted = hasRedactionMarker([summary, ...sourceRefs, ...evidenceRefs, ...cannotKnow]);
  const privacyState = redacted ? 'redacted' : normalizePrivacyState(input.privacyState);

  return {
    version: 1,
    id: makeEventId({
      id: input.id,
      sessionPath,
      category,
      summary,
      sourceRefs,
      evidenceRefs,
      createdAt,
      dedupeKey: input.dedupeKey,
    }),
    sessionPath,
    category,
    summary,
    sourceRefs,
    evidenceRefs,
    privacyState,
    mutationCount: 0,
    cannotKnow,
    createdAt,
    expiresAt,
    actionAuthority: 'display_only',
    signalIds,
  };
}

function normalizeLoadedAoiFieldEvent(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiFieldEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiFieldEvent>;
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.summary !== 'string' ||
    typeof raw.createdAt !== 'number' ||
    typeof raw.expiresAt !== 'number' ||
    !Array.isArray(raw.sourceRefs) ||
    !Array.isArray(raw.evidenceRefs) ||
    !Array.isArray(raw.cannotKnow) ||
    !Array.isArray(raw.signalIds)
  ) {
    return null;
  }
  return normalizeAoiFieldEvent(raw, sessionPath, now);
}

export function buildAoiFieldEventFromSignal(
  signal: AoiFieldSignalPacket,
  category: AoiFieldEventCategory = 'signal_observed',
): AoiFieldEvent {
  const sourceRef = `${signal.sourceKind}:${signal.id}`;
  const normalized = normalizeAoiFieldEvent(
    {
      id: `${category}-${signal.id}`,
      sessionPath: signal.sessionPath,
      category,
      summary: signal.summary,
      sourceRefs: [sourceRef],
      evidenceRefs: signal.evidenceRefs,
      privacyState: privacyStateFromBodyAccess(signal.bodyAccess),
      cannotKnow: signal.cannotKnow,
      createdAt: signal.observedAt,
      expiresAt: signal.expiresAt,
      signalIds: [signal.id],
      dedupeKey: `${category}:${signal.id}`,
    },
    signal.sessionPath,
    signal.observedAt,
  );
  if (!normalized) {
    throw new Error('Invalid Aoi field signal event.');
  }
  return normalized;
}

export function buildAoiFieldEventsFromSignals(
  signals: readonly AoiFieldSignalPacket[],
  category: AoiFieldEventCategory = 'signal_observed',
): AoiFieldEvent[] {
  return signals.map((signal) => buildAoiFieldEventFromSignal(signal, category));
}

export function loadAoiFieldEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_EVENTS,
): AoiFieldEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiFieldEventLedgerPaths(sessionsDir, normalizedSessionPath);
  return readJsonLines(paths.events)
    .map((item) => normalizeLoadedAoiFieldEvent(item, normalizedSessionPath, now))
    .filter((item): item is AoiFieldEvent => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(MAX_EVENTS, Math.trunc(limit))));
}

export function listAoiFieldEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_EVENTS,
): AoiFieldEvent[] {
  return loadAoiFieldEvents(sessionsDir, sessionPath, now, limit);
}

export function appendAoiFieldEvent(
  sessionsDir: string,
  input: AoiFieldEventInput,
  now = Date.now(),
): AoiFieldEvent {
  const normalized = normalizeAoiFieldEvent(input, undefined, now);
  if (!normalized) {
    throw new Error('Invalid Aoi field event.');
  }
  const paths = resolveAoiFieldEventLedgerPaths(sessionsDir, normalized.sessionPath);
  appendJsonLine(paths.root, paths.events, normalized);
  return normalized;
}

export function appendAoiFieldEvents(
  sessionsDir: string,
  inputs: readonly AoiFieldEventInput[],
  now = Date.now(),
): AoiFieldEvent[] {
  return inputs.map((input) => appendAoiFieldEvent(sessionsDir, input, now));
}

export function saveAoiFieldEvents(
  sessionsDir: string,
  inputs: readonly AoiFieldEventInput[],
  now = Date.now(),
): AoiFieldEvent[] {
  return appendAoiFieldEvents(sessionsDir, inputs, now);
}

export function pruneAoiFieldEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiFieldEventLedgerPaths(sessionsDir, normalizedSessionPath);
  const retained = readJsonLines(paths.events)
    .map((item) => normalizeLoadedAoiFieldEvent(item, normalizedSessionPath, now))
    .filter((item): item is AoiFieldEvent => item !== null)
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  writeJsonLines(paths.root, paths.events, retained);
  return retained;
}

export function buildAoiFieldLedgerSummary(params: {
  sessionPath: string;
  events: readonly AoiFieldEvent[];
  now?: number;
}): AoiFieldLedgerSummary {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const normalizedEvents = params.events
    .map((event) => normalizeAoiFieldEvent(event, sessionPath, now))
    .filter((event): event is AoiFieldEvent => event !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  const activeEvents = normalizedEvents.filter((event) => event.expiresAt > now);
  const expiredEvents = normalizedEvents.filter((event) => event.expiresAt <= now);
  const categoryCounts = normalizeCounts<AoiFieldEventCategory>([
    'signal_observed',
    'opportunity_created',
    'opportunity_deduped',
    'deliberation_ready',
    'deliberation_blocked',
    'delivery_hidden',
    'delivery_dashboard',
    'delivery_inline',
    'delivery_direct_chat_candidate',
    'action_ladder_blocked',
    'work_order_prepared',
    'feedback_recorded',
    'trace_promotion_candidate_created',
    'readiness_gate_changed',
  ]);
  const privacyCounts = normalizeCounts<AoiFieldEventPrivacyState>([
    'none',
    'metadata_only',
    'explicit_body_allowed',
    'redacted',
    'unknown',
  ]);
  const sourceKindCounts = normalizeCounts<AoiFieldSignalSourceKind | 'unknown'>([
    'workspace',
    'research',
    'kira',
    'app_state',
    'personal_metadata',
    'memory',
    'manual',
    'unknown',
  ]);
  const evidenceRefs = new Set<string>();
  const cannotKnow = new Set<string>();

  for (const event of activeEvents) {
    categoryCounts[event.category] += 1;
    privacyCounts[event.privacyState] += 1;
    const sourceKinds = new Set(event.sourceRefs.map(sourceKindFromRef));
    for (const sourceKind of sourceKinds) {
      sourceKindCounts[sourceKind] += 1;
    }
    for (const ref of event.evidenceRefs) {
      evidenceRefs.add(ref);
    }
    for (const statement of event.cannotKnow) {
      cannotKnow.add(statement);
    }
  }

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    totalEventCount: normalizedEvents.length,
    activeEventCount: activeEvents.length,
    expiredEventCount: expiredEvents.length,
    categoryCounts,
    privacyCounts,
    sourceKindCounts,
    recentEvents: activeEvents.slice(0, MAX_SUMMARY_EVENTS),
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REFS),
    cannotKnow: [...cannotKnow].slice(0, MAX_REFS),
    actionAuthority: 'display_only',
    mutationCount: 0,
    zeroMutation: true,
  };
}

export function loadAoiFieldLedgerSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldLedgerSummary {
  const events = loadAoiFieldEvents(sessionsDir, sessionPath, now, MAX_EVENTS);
  return buildAoiFieldLedgerSummary({
    sessionPath,
    events,
    now,
  });
}
