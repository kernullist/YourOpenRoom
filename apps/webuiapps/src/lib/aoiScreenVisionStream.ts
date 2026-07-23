// Aoi screen-vision stream (SV3.1): the durable, bounded ledger of REDACTED
// summaries describing the focused window, which cognition can read at tick.
//
// Safety posture (load-bearing -- do not relax):
// - Consent-gated on BOTH write and read via the 'screen-vision' environment
//   source (default OFF + explicit_target scope + consentReason). A blocked
//   gate records NOTHING and reads NOTHING (fail-closed, including consent
//   revoked after capture).
// - NO pixel/image field exists on the event STRUCTURALLY. The only content is
//   a redacted, bounded text summary. Redaction (SV2.2) runs at the record
//   boundary here -- so even a caller that forgets to redact cannot get raw
//   text into the store (defense in depth on top of the route redaction).
// - Every record is actionAuthority:'display_only' with mutationCount:0;
//   observation only, never an instruction and never an executable action.
// - Bounded: events expire on a short TTL (screen content is sensitive -- kept
//   briefer than app activity) and the ledger compacts to a hard cap.
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
import { redactAoiScreenVisionText } from './aoiScreenVisionRedaction';
import type { AoiScreenVisionChannel } from './aoiScreenVisionBackend';
import type { AoiObservation } from './aoiAutonomyTypes';

export const AOI_SCREEN_VISION_SOURCE_ID = 'screen-vision';
// A screen summary grounds "now" on a minutes scale only (matches the
// screen_vision source freshness window in aoiSourceFreshnessContract).
export const AOI_SCREEN_VISION_FRESH_WINDOW_MS = 5 * 60 * 1000;

const SCREEN_VISION_DIR = 'screen-vision';
const SCREEN_VISION_EVENTS_FILE = 'events.jsonl';
const MAX_SCREEN_VISION_EVENTS = 200;
const MAX_SUMMARY_EVENTS = 12;
const MAX_REFS = 24;
const MAX_SUMMARY_CHARS = 320;
const MAX_DETAILS = 6;
const MAX_DETAIL_CHARS = 160;
// Screen content is more sensitive than app-activity metadata, so it is kept
// for a much shorter window (2h vs 24h) before it expires from the ledger.
const DEFAULT_SCREEN_VISION_TTL_MS = 2 * 60 * 60 * 1000;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// A model id is an identifier slug, not free text. It is redacted (secrets
// become placeholders) and then required to be a conservative slug; anything
// else is dropped to 'unknown', so an untrusted model-supplied modelId cannot
// smuggle a secret / injection into the store. Underscore is excluded so token
// shapes like `ghp_...` fail the slug test even before redaction.
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.:/-]{0,79}$/i;
// Tolerate small forward clock skew; a further-future observedAt is clamped to
// now so a bogus/attacker timestamp cannot pin a permanent "current" summary
// or dodge the TTL.
const CLOCK_SKEW_MS = 60 * 1000;
const CHANNELS: readonly AoiScreenVisionChannel[] = ['local', 'cloud'];

export type AoiScreenVisionEventKind = 'screen_summary';

export interface AoiScreenVisionEvent {
  version: 1;
  id: string;
  sessionPath: string;
  kind: AoiScreenVisionEventKind;
  appId: string | null;
  channel: AoiScreenVisionChannel;
  modelId: string;
  // The ONLY content field. Redacted + bounded. There is deliberately NO
  // pixel/image field on this type.
  summaryText: string;
  details: string[];
  confidence: number;
  evidenceRefs: string[];
  privacyState: 'redacted_summary';
  observedAt: number;
  expiresAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiScreenVisionEventInput {
  appId?: unknown;
  channel?: unknown;
  modelId?: unknown;
  // Raw (possibly unredacted) text; redacted here before it can be stored.
  summaryText?: unknown;
  details?: unknown;
  confidence?: unknown;
  observedAt?: unknown;
}

export interface AoiScreenVisionRecordResult {
  recorded: boolean;
  reasons: string[];
  event: AoiScreenVisionEvent | null;
}

export interface AoiScreenVisionStreamPaths {
  root: string;
  events: string;
}

export interface AoiScreenVisionStreamSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  consented: boolean;
  totalEventCount: number;
  activeEventCount: number;
  expiredEventCount: number;
  activeAppId: string | null;
  latestSummaryText: string | null;
  lastEventAt: number | null;
  lastEventAgeMs: number | null;
  channelCounts: Record<AoiScreenVisionChannel, number>;
  recentEvents: AoiScreenVisionEvent[];
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
    throw new Error('Resolved Aoi screen-vision path escaped the autonomy root.');
  }
  ensureDirectory(filePath, true);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeJsonLines(root: string, filePath: string, values: readonly unknown[]): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved Aoi screen-vision path escaped the autonomy root.');
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

function normalizeAppId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return APP_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeChannel(value: unknown): AoiScreenVisionChannel {
  return CHANNELS.includes(value as AoiScreenVisionChannel)
    ? (value as AoiScreenVisionChannel)
    : 'local';
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  // Redact first (a secret that rode in becomes a placeholder), then require a
  // conservative slug -- a redacted or free-text value fails and becomes unknown.
  const redacted = redactAoiScreenVisionText(value, 80);
  return MODEL_ID_PATTERN.test(redacted) ? redacted : 'unknown';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeDetails(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= MAX_DETAILS) {
      break;
    }
    const redacted = redactAoiScreenVisionText(item, MAX_DETAIL_CHARS);
    if (redacted.length > 0) {
      out.push(redacted);
    }
  }
  return out;
}

function makeScreenVisionEventId(params: {
  sessionPath: string;
  appId: string | null;
  summaryText: string;
  observedAt: number;
}): string {
  const key = [
    params.sessionPath,
    params.appId ?? '',
    params.summaryText,
    String(params.observedAt),
  ].join('|');
  return `aoi-screen-${hashText(key)}`;
}

export function resolveAoiScreenVisionStreamPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiScreenVisionStreamPaths {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const autonomyPaths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const root = join(autonomyPaths.root, SCREEN_VISION_DIR);
  return {
    root,
    events: join(root, SCREEN_VISION_EVENTS_FILE),
  };
}

// Normalize + REDACT an input into a storable event. The summary/details are
// redacted here (SV2.2) so raw text cannot reach the store; an empty summary
// after redaction is rejected (fail-closed -- an empty signal is never stored).
export function normalizeAoiScreenVisionEvent(
  input: AoiScreenVisionEventInput,
  sessionPath: string,
  now = Date.now(),
): { event: AoiScreenVisionEvent | null; reasons: string[] } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return { event: null, reasons: ['invalid_session_path'] };
  }
  const summaryText = redactAoiScreenVisionText(input.summaryText, MAX_SUMMARY_CHARS);
  if (summaryText.length === 0) {
    return { event: null, reasons: ['empty_summary'] };
  }
  const appId = normalizeAppId(input.appId);
  const channel = normalizeChannel(input.channel);
  const modelId = normalizeModelId(input.modelId);
  const details = normalizeDetails(input.details);
  const confidence = normalizeConfidence(input.confidence);
  // Clamp a future timestamp to now (+ small skew) so it cannot become a
  // permanent "latest" summary or outlive the TTL.
  const observedAt = Math.min(normalizeTimestamp(input.observedAt, now), now + CLOCK_SKEW_MS);
  const event: AoiScreenVisionEvent = {
    version: 1,
    id: makeScreenVisionEventId({
      sessionPath: normalizedSessionPath,
      appId,
      summaryText,
      observedAt,
    }),
    sessionPath: normalizedSessionPath,
    kind: 'screen_summary',
    appId,
    channel,
    modelId,
    summaryText,
    details,
    confidence,
    evidenceRefs: [
      `environment-source:${AOI_SCREEN_VISION_SOURCE_ID}`,
      ...(appId ? [`app:${appId}`] : []),
    ],
    privacyState: 'redacted_summary',
    observedAt,
    expiresAt: observedAt + DEFAULT_SCREEN_VISION_TTL_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  return { event, reasons: [] };
}

function normalizeLoadedScreenVisionEvent(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiScreenVisionEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiScreenVisionEvent>;
  if (raw.version !== 1 || typeof raw.observedAt !== 'number') {
    return null;
  }
  const normalized = normalizeAoiScreenVisionEvent(
    {
      appId: raw.appId ?? undefined,
      channel: raw.channel,
      modelId: raw.modelId,
      summaryText: raw.summaryText,
      details: raw.details,
      confidence: raw.confidence,
      observedAt: raw.observedAt,
    },
    sessionPath,
    now,
  );
  return normalized.event;
}

export function checkAoiScreenVisionStreamConsent(
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
      sourceId: AOI_SCREEN_VISION_SOURCE_ID,
      operation: 'read_metadata',
    });
    return { allowed: check.allowed, reasons: check.reasons };
  } catch {
    // Fail closed: an unreadable registry means no consent evidence.
    return { allowed: false, reasons: ['registry_unreadable'] };
  }
}

export function recordAoiScreenVisionEvent(
  sessionsDir: string,
  sessionPath: string,
  input: AoiScreenVisionEventInput,
  now = Date.now(),
): AoiScreenVisionRecordResult {
  const consent = checkAoiScreenVisionStreamConsent(sessionsDir, sessionPath, now);
  if (!consent.allowed) {
    return { recorded: false, reasons: consent.reasons, event: null };
  }
  const { event, reasons } = normalizeAoiScreenVisionEvent(input, sessionPath, now);
  if (!event) {
    return { recorded: false, reasons, event: null };
  }
  const paths = resolveAoiScreenVisionStreamPaths(sessionsDir, event.sessionPath);
  appendJsonLine(paths.root, paths.events, event);
  compactScreenVisionEventsIfNeeded(paths, event.sessionPath, now);
  try {
    // Keep the source freshness contract honest: a recorded summary IS a fresh
    // observation of this source. Best-effort -- recording must not fail on a
    // registry write problem.
    updateAoiEnvironmentSource(sessionsDir, event.sessionPath, {
      sourceId: AOI_SCREEN_VISION_SOURCE_ID,
      patch: { lastObservedAt: now },
      now,
    });
  } catch {
    // Ignore: the event itself is durably recorded.
  }
  return { recorded: true, reasons: [], event };
}

function compactScreenVisionEventsIfNeeded(
  paths: AoiScreenVisionStreamPaths,
  sessionPath: string,
  now: number,
): void {
  const raw = readJsonLines(paths.events);
  if (raw.length <= MAX_SCREEN_VISION_EVENTS) {
    return;
  }
  const retained = raw
    .map((item) => normalizeLoadedScreenVisionEvent(item, sessionPath, now))
    .filter((item): item is AoiScreenVisionEvent => item !== null)
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id))
    .slice(-MAX_SCREEN_VISION_EVENTS);
  writeJsonLines(paths.root, paths.events, retained);
}

// Internal: read + normalize all persisted events newest-first, WITHOUT the
// TTL filter. The summary builder needs the expired ones to report
// expiredEventCount; the public loader below filters them out.
function readNormalizedScreenVisionEvents(
  sessionsDir: string,
  normalizedSessionPath: string,
  now: number,
): AoiScreenVisionEvent[] {
  const paths = resolveAoiScreenVisionStreamPaths(sessionsDir, normalizedSessionPath);
  return readJsonLines(paths.events)
    .map((item) => normalizeLoadedScreenVisionEvent(item, normalizedSessionPath, now))
    .filter((item): item is AoiScreenVisionEvent => item !== null)
    .sort((left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id));
}

export function loadAoiScreenVisionEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_SCREEN_VISION_EVENTS,
): AoiScreenVisionEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  // Fail-closed read: consent revoked/disabled AFTER capture hides the data.
  const consent = checkAoiScreenVisionStreamConsent(sessionsDir, normalizedSessionPath, now);
  if (!consent.allowed) {
    return [];
  }
  return (
    readNormalizedScreenVisionEvents(sessionsDir, normalizedSessionPath, now)
      // Enforce the retention boundary on the public read path too: a past-TTL
      // summary must never be handed to a reader for grounding "now".
      .filter((item) => item.expiresAt > now)
      .slice(0, Math.max(0, Math.min(MAX_SCREEN_VISION_EVENTS, Math.trunc(limit))))
  );
}

export function pruneAoiScreenVisionEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiScreenVisionEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiScreenVisionStreamPaths(sessionsDir, normalizedSessionPath);
  const retained = readJsonLines(paths.events)
    .map((item) => normalizeLoadedScreenVisionEvent(item, normalizedSessionPath, now))
    .filter((item): item is AoiScreenVisionEvent => item !== null)
    .filter((item) => item.expiresAt > now)
    .sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id));
  writeJsonLines(paths.root, paths.events, retained);
  return retained;
}

function emptyChannelCounts(): Record<AoiScreenVisionChannel, number> {
  return CHANNELS.reduce(
    (out, channel) => {
      out[channel] = 0;
      return out;
    },
    {} as Record<AoiScreenVisionChannel, number>,
  );
}

// Newest-first: the first event's app is the inferred active app.
function inferActiveAppId(eventsNewestFirst: readonly AoiScreenVisionEvent[]): string | null {
  for (const event of eventsNewestFirst) {
    if (event.appId) {
      return event.appId;
    }
  }
  return null;
}

export function buildAoiScreenVisionStreamSummary(params: {
  sessionPath: string;
  events: readonly AoiScreenVisionEvent[];
  consented?: boolean;
  consentReasons?: readonly string[];
  now?: number;
}): AoiScreenVisionStreamSummary {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  // Fail-closed: only an explicit true is treated as consented. A missing flag
  // must never surface events as consented (defense in depth behind the route
  // and loader consent gates, which always pass this explicitly).
  const consented = params.consented === true;
  const normalizedEvents = consented
    ? params.events
        .map((event) => normalizeLoadedScreenVisionEvent(event, sessionPath, now))
        .filter((event): event is AoiScreenVisionEvent => event !== null)
        .sort(
          (left, right) => right.observedAt - left.observedAt || left.id.localeCompare(right.id),
        )
    : [];
  const activeEvents = normalizedEvents.filter((event) => event.expiresAt > now);
  const expiredEvents = normalizedEvents.filter((event) => event.expiresAt <= now);
  const channelCounts = emptyChannelCounts();
  const evidenceRefs = new Set<string>([`environment-source:${AOI_SCREEN_VISION_SOURCE_ID}`]);
  const cannotKnow: string[] = [];

  for (const event of activeEvents) {
    channelCounts[event.channel] += 1;
    evidenceRefs.add(`screen:${event.id}`);
  }

  if (!consented) {
    const reasonSuffix = params.consentReasons?.length
      ? ` (${[...params.consentReasons].join(', ')})`
      : '';
    cannotKnow.push(
      `Aoi cannot know screen content because the screen-vision source is not consented${reasonSuffix}.`,
    );
  } else if (activeEvents.length === 0) {
    cannotKnow.push(
      'Aoi cannot know the current screen because no screen summary has been observed within the retention window.',
    );
  }
  // Always honest about what is structurally impossible to know.
  cannotKnow.push(
    'Aoi cannot know raw screen pixels, off-screen or other-window content, or anything redaction removed; only a bounded redacted summary of the focused window.',
  );

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
    latestSummaryText: activeEvents.length > 0 ? activeEvents[0].summaryText : null,
    lastEventAt,
    lastEventAgeMs: lastEventAt === null ? null : Math.max(0, now - lastEventAt),
    channelCounts,
    recentEvents: activeEvents.slice(0, MAX_SUMMARY_EVENTS),
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REFS),
    cannotKnow,
    actionAuthority: 'display_only',
    mutationCount: 0,
    zeroMutation: true,
  };
}

// Compact one-line description of the live screen stream. The latest summary is
// already redacted + bounded, so this is safe to surface.
export function describeAoiScreenVisionStreamSummary(
  summary: AoiScreenVisionStreamSummary,
): string {
  const lastAge =
    summary.lastEventAgeMs === null
      ? 'never'
      : `${Math.max(0, Math.round(summary.lastEventAgeMs / 60_000))}m ago`;
  const latest = summary.latestSummaryText ? `; latest="${summary.latestSummaryText}"` : '';
  return (
    `Screen vision: active app=${summary.activeAppId ?? 'none'}; ` +
    `summaries=${summary.activeEventCount}; last=${lastAge}${latest}.`
  );
}

// Derive tick observations from the (already consent-gated) screen-vision
// summary. Observation-only: feeds cognition context, never authority. Buckets
// by the fresh window so an unchanged screen does not re-observe each tick.
export function createAoiScreenVisionObservations(params: {
  summary: AoiScreenVisionStreamSummary;
  now?: number;
}): AoiObservation[] {
  const summary = params.summary;
  if (!summary.consented || summary.activeEventCount === 0 || summary.lastEventAt === null) {
    return [];
  }
  const bucket = Math.floor(summary.lastEventAt / AOI_SCREEN_VISION_FRESH_WINDOW_MS);
  const dedupeKey = `screen:${summary.activeAppId ?? 'none'}:${bucket}`;
  return [
    {
      version: 1,
      id: `aoi-obs-screen-${hashText(`${summary.sessionPath}:${dedupeKey}`)}`,
      source: 'app',
      sessionPath: summary.sessionPath,
      createdAt: summary.lastEventAt,
      summary: describeAoiScreenVisionStreamSummary(summary),
      payloadRef: `environment-source:${AOI_SCREEN_VISION_SOURCE_ID}`,
      memoryIds: [],
      artifactRefs: summary.evidenceRefs.slice(0, 8),
      proposalIds: [],
      riskSignals: ['screen-vision-signal'],
      dedupeKey,
    },
  ];
}

export function loadAoiScreenVisionStreamSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiScreenVisionStreamSummary {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const consent = checkAoiScreenVisionStreamConsent(sessionsDir, normalizedSessionPath, now);
  if (!consent.allowed) {
    return buildAoiScreenVisionStreamSummary({
      sessionPath: normalizedSessionPath,
      events: [],
      consented: false,
      consentReasons: consent.reasons,
      now,
    });
  }
  return buildAoiScreenVisionStreamSummary({
    sessionPath: normalizedSessionPath,
    // Unfiltered read so the summary can still partition + report expired
    // (past-TTL) events; the summary itself only surfaces the active ones.
    events: readNormalizedScreenVisionEvents(sessionsDir, normalizedSessionPath, now),
    consented: true,
    now,
  });
}
