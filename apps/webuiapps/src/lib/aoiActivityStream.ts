// Aoi activity stream (SA1.2): the durable, bounded, METADATA-ONLY ledger of
// live app activity ("which app, which action type, when") that cognition can
// read at tick time.
//
// Safety posture (load-bearing -- do not relax):
// - Consent-gated on BOTH write and read via the 'app-activity' environment
//   source (default OFF + explicit_target scope + consentReason). A blocked
//   gate records NOTHING and reads NOTHING (fail-closed, including consent
//   revoked after capture).
// - STRUCTURALLY metadata-only: the event type has no params/content/body
//   field, and the summary text is DERIVED from the validated appId/actionType
//   slugs -- free text from the caller can never enter the store.
// - Every record is actionAuthority:'display_only' with mutationCount:0;
//   observation only, never an instruction and never an executable action.
// - Bounded: events expire on a 24h TTL and the ledger compacts to a hard cap.
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  loadAoiEnvironmentSourceRegistry,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import { checkAoiEnvironmentSourceOperation } from './aoiAutonomyPolicy';

export const AOI_ACTIVITY_SOURCE_ID = 'app-activity';

const ACTIVITY_DIR = 'activity';
const ACTIVITY_EVENTS_FILE = 'events.jsonl';
const MAX_ACTIVITY_EVENTS = 500;
const MAX_SUMMARY_EVENTS = 12;
const MAX_SUMMARY_APPS = 8;
const MAX_REFS = 24;
const DEFAULT_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTION_TYPE_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,63}$/;

export type AoiActivityEventKind =
  | 'app_opened'
  | 'app_closed'
  | 'app_focused'
  | 'app_action'
  | 'chat_turn';

const ACTIVITY_EVENT_KINDS: readonly AoiActivityEventKind[] = [
  'app_opened',
  'app_closed',
  'app_focused',
  'app_action',
  'chat_turn',
];

export interface AoiActivityEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiActivityEventKind;
  appId: string | null;
  actionType: string | null;
  summary: string;
  evidenceRefs: string[];
  privacyState: 'metadata_only';
  observedAt: number;
  expiresAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiActivityEventInput {
  kind?: unknown;
  appId?: unknown;
  actionType?: unknown;
  observedAt?: unknown;
}

export interface AoiActivityRecordResult {
  recorded: boolean;
  reasons: string[];
  event: AoiActivityEvent | null;
}

export interface AoiActivityStreamPaths {
  root: string;
  events: string;
}

export interface AoiActivityAppCount {
  appId: string;
  eventCount: number;
  lastEventAt: number;
}

export interface AoiActivityStreamSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  consented: boolean;
  totalEventCount: number;
  activeEventCount: number;
  expiredEventCount: number;
  activeAppId: string | null;
  lastEventAt: number | null;
  lastEventAgeMs: number | null;
  kindCounts: Record<AoiActivityEventKind, number>;
  appCounts: AoiActivityAppCount[];
  recentEvents: AoiActivityEvent[];
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
    throw new Error('Resolved Aoi activity path escaped the autonomy root.');
  }
  ensureDirectory(filePath, true);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeJsonLines(root: string, filePath: string, values: readonly unknown[]): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved Aoi activity path escaped the autonomy root.');
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

function normalizeKind(value: unknown): AoiActivityEventKind | null {
  return ACTIVITY_EVENT_KINDS.includes(value as AoiActivityEventKind)
    ? (value as AoiActivityEventKind)
    : null;
}

function normalizeAppId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return APP_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeActionType(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return ACTION_TYPE_PATTERN.test(normalized) ? normalized : null;
}

// The summary is DERIVED from validated slug parts only. Caller-supplied free
// text never reaches the store -- this is the structural metadata-only boundary.
function describeActivity(
  kind: AoiActivityEventKind,
  appId: string | null,
  actionType: string | null,
): string {
  if (kind === 'chat_turn') {
    return 'chat turn observed.';
  }
  if (kind === 'app_action') {
    return `app action: ${appId ?? 'unknown-app'} ${actionType ?? 'UNSPECIFIED_ACTION'}.`;
  }
  return `${kind.replace(/_/g, ' ')}: ${appId ?? 'unknown-app'}.`;
}

function makeActivityEventId(params: {
  sessionPath: string;
  kind: AoiActivityEventKind;
  appId: string | null;
  actionType: string | null;
  observedAt: number;
}): string {
  const key = [
    params.sessionPath,
    params.kind,
    params.appId ?? '',
    params.actionType ?? '',
    String(params.observedAt),
  ].join('|');
  return `aoi-activity-${hashText(key)}`;
}

export function resolveAoiActivityStreamPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiActivityStreamPaths {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const autonomyPaths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const root = join(autonomyPaths.root, ACTIVITY_DIR);
  return {
    root,
    events: join(root, ACTIVITY_EVENTS_FILE),
  };
}

export function normalizeAoiActivityEvent(
  input: AoiActivityEventInput,
  sessionPath: string,
  now = Date.now(),
): { event: AoiActivityEvent | null; reasons: string[] } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return { event: null, reasons: ['invalid_session_path'] };
  }
  const kind = normalizeKind(input.kind);
  if (!kind) {
    return { event: null, reasons: ['invalid_activity_kind'] };
  }
  const appId = normalizeAppId(input.appId);
  if (kind !== 'chat_turn' && !appId) {
    return { event: null, reasons: ['invalid_app_id'] };
  }
  const actionType = kind === 'app_action' ? normalizeActionType(input.actionType) : null;
  const observedAt = normalizeTimestamp(input.observedAt, now);
  const event: AoiActivityEvent = {
    version: 1,
    id: makeActivityEventId({
      sessionPath: normalizedSessionPath,
      kind,
      appId,
      actionType,
      observedAt,
    }),
    sessionPath: normalizedSessionPath,
    kind,
    appId,
    actionType,
    summary: describeActivity(kind, appId, actionType),
    evidenceRefs: [
      `environment-source:${AOI_ACTIVITY_SOURCE_ID}`,
      ...(appId ? [`app:${appId}`] : []),
    ],
    privacyState: 'metadata_only',
    observedAt,
    expiresAt: observedAt + DEFAULT_ACTIVITY_TTL_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  return { event, reasons: [] };
}

function normalizeLoadedActivityEvent(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiActivityEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiActivityEvent>;
  if (raw.version !== 1 || typeof raw.observedAt !== 'number') {
    return null;
  }
  const normalized = normalizeAoiActivityEvent(
    {
      kind: raw.kind,
      appId: raw.appId ?? undefined,
      actionType: raw.actionType ?? undefined,
      observedAt: raw.observedAt,
    },
    sessionPath,
    now,
  );
  return normalized.event;
}

export function checkAoiActivityStreamConsent(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): { allowed: boolean; reasons: string[] } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return { allowed: false, reasons: ['invalid_session_path'] };
  }
  try {
    const registry = loadAoiEnvironmentSourceRegistry(sessionsDir, normalizedSessionPath, now);
    const check = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: AOI_ACTIVITY_SOURCE_ID,
      operation: 'read_metadata',
    });
    return { allowed: check.allowed, reasons: check.reasons };
  } catch {
    // Fail closed: an unreadable registry means no consent evidence.
    return { allowed: false, reasons: ['registry_unreadable'] };
  }
}

export function recordAoiActivityEvent(
  sessionsDir: string,
  sessionPath: string,
  input: AoiActivityEventInput,
  now = Date.now(),
): AoiActivityRecordResult {
  const consent = checkAoiActivityStreamConsent(sessionsDir, sessionPath, now);
  if (!consent.allowed) {
    return { recorded: false, reasons: consent.reasons, event: null };
  }
  const { event, reasons } = normalizeAoiActivityEvent(input, sessionPath, now);
  if (!event) {
    return { recorded: false, reasons, event: null };
  }
  const paths = resolveAoiActivityStreamPaths(sessionsDir, event.sessionPath);
  appendJsonLine(paths.root, paths.events, event);
  compactActivityEventsIfNeeded(paths, event.sessionPath, now);
  try {
    // Keep the source freshness contract honest: a recorded event IS a fresh
    // observation of this source. Best-effort -- recording must not fail on a
    // registry write problem.
    updateAoiEnvironmentSource(sessionsDir, event.sessionPath, {
      sourceId: AOI_ACTIVITY_SOURCE_ID,
      patch: { lastObservedAt: now },
      now,
    });
  } catch {
    // Ignore: the event itself is durably recorded.
  }
  return { recorded: true, reasons: [], event };
}

function compactActivityEventsIfNeeded(
  paths: AoiActivityStreamPaths,
  sessionPath: string,
  now: number,
): void {
  const raw = readJsonLines(paths.events);
  if (raw.length <= MAX_ACTIVITY_EVENTS) {
    return;
  }
  const retained = raw
    .map((item) => normalizeLoadedActivityEvent(item, sessionPath, now))
    .filter((item): item is AoiActivityEvent => item !== null)
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id))
    .slice(-MAX_ACTIVITY_EVENTS);
  writeJsonLines(paths.root, paths.events, retained);
}

export function loadAoiActivityEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_ACTIVITY_EVENTS,
): AoiActivityEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  // Fail-closed read: consent revoked/disabled AFTER capture hides the data.
  const consent = checkAoiActivityStreamConsent(sessionsDir, normalizedSessionPath, now);
  if (!consent.allowed) {
    return [];
  }
  const paths = resolveAoiActivityStreamPaths(sessionsDir, normalizedSessionPath);
  return readJsonLines(paths.events)
    .map((item) => normalizeLoadedActivityEvent(item, normalizedSessionPath, now))
    .filter((item): item is AoiActivityEvent => item !== null)
    .sort((left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(MAX_ACTIVITY_EVENTS, Math.trunc(limit))));
}

export function pruneAoiActivityEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiActivityEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiActivityStreamPaths(sessionsDir, normalizedSessionPath);
  const retained = readJsonLines(paths.events)
    .map((item) => normalizeLoadedActivityEvent(item, normalizedSessionPath, now))
    .filter((item): item is AoiActivityEvent => item !== null)
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id));
  writeJsonLines(paths.root, paths.events, retained);
  return retained;
}

function emptyKindCounts(): Record<AoiActivityEventKind, number> {
  return ACTIVITY_EVENT_KINDS.reduce(
    (out, kind) => {
      out[kind] = 0;
      return out;
    },
    {} as Record<AoiActivityEventKind, number>,
  );
}

// Newest-first walk: the first app whose MOST RECENT event is not app_closed
// is the inferred active app. An app whose newest event is app_closed is
// closed regardless of older opens.
function inferActiveAppId(eventsNewestFirst: readonly AoiActivityEvent[]): string | null {
  const seenApps = new Set<string>();
  for (const event of eventsNewestFirst) {
    if (!event.appId) {
      continue;
    }
    if (seenApps.has(event.appId)) {
      continue;
    }
    seenApps.add(event.appId);
    if (event.kind === 'app_closed') {
      continue;
    }
    return event.appId;
  }
  return null;
}

export function buildAoiActivityStreamSummary(params: {
  sessionPath: string;
  events: readonly AoiActivityEvent[];
  consented?: boolean;
  consentReasons?: readonly string[];
  now?: number;
}): AoiActivityStreamSummary {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const consented = params.consented !== false;
  const normalizedEvents = consented
    ? params.events
        .map((event) => normalizeLoadedActivityEvent(event, sessionPath, now))
        .filter((event): event is AoiActivityEvent => event !== null)
        .sort(
          (left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id),
        )
    : [];
  const activeEvents = normalizedEvents.filter((event) => event.expiresAt > now);
  const expiredEvents = normalizedEvents.filter((event) => event.expiresAt <= now);
  const kindCounts = emptyKindCounts();
  const appAccumulator = new Map<string, { eventCount: number; lastEventAt: number }>();
  const evidenceRefs = new Set<string>([`environment-source:${AOI_ACTIVITY_SOURCE_ID}`]);
  const cannotKnow: string[] = [];

  for (const event of activeEvents) {
    kindCounts[event.kind] += 1;
    evidenceRefs.add(`activity:${event.id}`);
    if (event.appId) {
      const entry = appAccumulator.get(event.appId) ?? { eventCount: 0, lastEventAt: 0 };
      entry.eventCount += 1;
      entry.lastEventAt = Math.max(entry.lastEventAt, event.observedAt);
      appAccumulator.set(event.appId, entry);
    }
  }

  if (!consented) {
    const reasonSuffix = params.consentReasons?.length
      ? ` (${[...params.consentReasons].join(', ')})`
      : '';
    cannotKnow.push(
      `Aoi cannot know live app activity because the app-activity source is not consented${reasonSuffix}.`,
    );
  } else if (activeEvents.length === 0) {
    cannotKnow.push(
      'Aoi cannot know current app activity because no live activity has been observed within the retention window.',
    );
  }

  const lastEventAt = activeEvents.length > 0 ? activeEvents[0].observedAt : null;
  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    consented,
    totalEventCount: normalizedEvents.length,
    activeEventCount: activeEvents.length,
    expiredEventCount: expiredEvents.length,
    activeAppId: inferActiveAppId(activeEvents),
    lastEventAt,
    lastEventAgeMs: lastEventAt === null ? null : Math.max(0, now - lastEventAt),
    kindCounts,
    appCounts: [...appAccumulator.entries()]
      .map(([appId, entry]) => ({
        appId,
        eventCount: entry.eventCount,
        lastEventAt: entry.lastEventAt,
      }))
      .sort(
        (left, right) =>
          right.eventCount - left.eventCount ||
          right.lastEventAt - left.lastEventAt ||
          left.appId.localeCompare(right.appId),
      )
      .slice(0, MAX_SUMMARY_APPS),
    recentEvents: activeEvents.slice(0, MAX_SUMMARY_EVENTS),
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REFS),
    cannotKnow,
    actionAuthority: 'display_only',
    mutationCount: 0,
    zeroMutation: true,
  };
}

export function loadAoiActivityStreamSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiActivityStreamSummary {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const consent = checkAoiActivityStreamConsent(sessionsDir, normalizedSessionPath, now);
  if (!consent.allowed) {
    return buildAoiActivityStreamSummary({
      sessionPath: normalizedSessionPath,
      events: [],
      consented: false,
      consentReasons: consent.reasons,
      now,
    });
  }
  return buildAoiActivityStreamSummary({
    sessionPath: normalizedSessionPath,
    events: loadAoiActivityEvents(sessionsDir, normalizedSessionPath, now),
    consented: true,
    now,
  });
}
