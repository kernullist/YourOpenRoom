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
const FIELD_COMPACTION_FILE = 'compaction.json';
const FIELD_COMPACTION_JOURNAL_FILE = 'compaction.pending.json';
const MAX_EVENTS = 1000;
const MAX_STORED_EVENTS = 1250;
const MAX_SUMMARY_EVENTS = 12;
const MAX_REFS = 24;
const MAX_COMPACTION_BUCKETS = 120;
const DEFAULT_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AOI_FIELD_EVENT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

const FIELD_EVENT_CATEGORIES = [
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
] as const;

const FIELD_EVENT_PRIVACY_STATES = [
  'none',
  'metadata_only',
  'explicit_body_allowed',
  'redacted',
  'unknown',
] as const;

const FIELD_EVENT_SOURCE_KINDS = [
  'workspace',
  'research',
  'kira',
  'app_state',
  'personal_metadata',
  'memory',
  'manual',
  'unknown',
] as const;

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
  dedupeFingerprint: string;
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
  dedupeFingerprint?: unknown;
}

export interface AoiFieldEventLedgerPaths {
  trustedRoot: string;
  root: string;
  events: string;
  compaction: string;
  compactionJournal: string;
}

export interface AoiFieldEventCompactionBucket {
  version: 1;
  dayStart: number;
  dayEnd: number;
  compactedEventCount: number;
  expiredEventCount: number;
  overflowEventCount: number;
  categoryCounts: Record<AoiFieldEventCategory, number>;
  privacyCounts: Record<AoiFieldEventPrivacyState, number>;
  sourceKindCounts: Record<AoiFieldSignalSourceKind | 'unknown', number>;
}

export interface AoiFieldEventCompactionState {
  version: 1;
  sessionPath: string;
  updatedAt: number;
  compactedEventCount: number;
  expiredEventCount: number;
  overflowEventCount: number;
  duplicateSuppressionCount: number;
  lastTransactionId: string | null;
  buckets: AoiFieldEventCompactionBucket[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

interface AoiFieldEventCompactionJournal {
  version: 1;
  sessionPath: string;
  transactionId: string;
  createdAt: number;
  targetCompaction: AoiFieldEventCompactionState;
  removedRecordFingerprints: string[];
}

export interface AoiFieldLedgerSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  totalEventCount: number;
  retainedEventCount: number;
  compactedEventCount: number;
  duplicateSuppressionCount: number;
  activeEventCount: number;
  expiredEventCount: number;
  categoryCounts: Record<AoiFieldEventCategory, number>;
  privacyCounts: Record<AoiFieldEventPrivacyState, number>;
  sourceKindCounts: Record<AoiFieldSignalSourceKind | 'unknown', number>;
  recentEvents: AoiFieldEvent[];
  compactedCategoryCounts: Record<AoiFieldEventCategory, number>;
  evidenceRefs: string[];
  cannotKnow: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
  zeroMutation: true;
  readinessCreditEventCount: 0;
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

function throwUnsafeLedgerPath(): never {
  throw new Error('Resolved Aoi field event path escaped the trusted sessions root.');
}

function assertSafeExistingLedgerPath(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isPathInsideRoot(resolvedRoot, resolvedTarget)) {
    throwUnsafeLedgerPath();
  }
  if (!fs.existsSync(resolvedRoot)) {
    return;
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  let current = resolvedRoot;
  const segments = relative(resolvedRoot, resolvedTarget)
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    if (!fs.existsSync(current)) {
      return;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throwUnsafeLedgerPath();
    }
    const realCurrent = fs.realpathSync(current);
    if (!isPathInsideRoot(realRoot, realCurrent)) {
      throwUnsafeLedgerPath();
    }
  }
}

function ensureSafeLedgerFileParent(root: string, filePath: string): void {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(filePath);
  if (!isPathInsideRoot(resolvedRoot, resolvedFile)) {
    throwUnsafeLedgerPath();
  }
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const realRoot = fs.realpathSync(resolvedRoot);
  let current = resolvedRoot;
  const segments = relative(resolvedRoot, dirname(resolvedFile))
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current);
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throwUnsafeLedgerPath();
    }
    const realCurrent = fs.realpathSync(current);
    if (!isPathInsideRoot(realRoot, realCurrent)) {
      throwUnsafeLedgerPath();
    }
  }
  assertSafeExistingLedgerPath(resolvedRoot, resolvedFile);
}

function appendJsonLine(root: string, filePath: string, value: unknown): void {
  ensureSafeLedgerFileParent(root, filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeJsonLines(root: string, filePath: string, values: readonly unknown[]): void {
  ensureSafeLedgerFileParent(root, filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  const payload = values.map((value) => JSON.stringify(value)).join('\n');
  fs.writeFileSync(tmpPath, payload ? `${payload}\n` : '', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomic(root: string, filePath: string, value: unknown): void {
  ensureSafeLedgerFileParent(root, filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function removeFileSafely(root: string, filePath: string): void {
  assertSafeExistingLedgerPath(root, filePath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function readJson(root: string, filePath: string): unknown {
  assertSafeExistingLedgerPath(root, filePath);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function readJsonLines(root: string, filePath: string): unknown[] {
  assertSafeExistingLedgerPath(root, filePath);
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
  createdAt: number;
  dedupeFingerprint: string;
}): string {
  const explicit = normalizeStablePart(params.id, '');
  if (explicit) {
    return explicit.startsWith('aoi-field-event-') ? explicit : `aoi-field-event-${explicit}`;
  }
  const key = [
    params.sessionPath,
    params.category,
    params.dedupeFingerprint,
    String(Math.floor(params.createdAt / AOI_FIELD_EVENT_DEDUPE_WINDOW_MS)),
  ].join('|');
  return `aoi-field-event-${hashText(key)}`;
}

function makeDedupeFingerprint(params: {
  id?: unknown;
  sessionPath: string;
  category: AoiFieldEventCategory;
  summary: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  signalIds: string[];
  dedupeKey?: unknown;
}): string {
  const explicitDedupe = sanitizeAoiFieldSignalText(params.dedupeKey, 180);
  const key = JSON.stringify([
    params.sessionPath,
    params.category,
    explicitDedupe || params.summary,
    [...params.sourceRefs].sort(),
    [...params.evidenceRefs].sort(),
    [...params.signalIds].sort(),
  ]);
  return createHash('sha256').update(key).digest('hex');
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
    trustedRoot: resolve(sessionsDir),
    root,
    events: join(root, FIELD_EVENTS_FILE),
    compaction: join(root, FIELD_COMPACTION_FILE),
    compactionJournal: join(root, FIELD_COMPACTION_JOURNAL_FILE),
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
  const storedFingerprint =
    typeof input.dedupeFingerprint === 'string' && /^[a-f0-9]{64}$/.test(input.dedupeFingerprint)
      ? input.dedupeFingerprint
      : '';
  const dedupeFingerprint =
    storedFingerprint ||
    makeDedupeFingerprint({
      id: input.id,
      sessionPath,
      category,
      summary,
      sourceRefs,
      evidenceRefs,
      signalIds,
      dedupeKey: input.dedupeKey,
    });

  return {
    version: 1,
    id: makeEventId({
      id: input.id,
      sessionPath,
      category,
      createdAt,
      dedupeFingerprint,
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
    dedupeFingerprint,
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

type AoiFieldEventCompactionReason = 'expired' | 'overflow';

interface AoiFieldEventCompactionEntry {
  event: AoiFieldEvent;
  reason: AoiFieldEventCompactionReason;
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeCountRecord<T extends string>(
  value: unknown,
  keys: readonly T[],
): Record<T, number> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = normalizeCounts(keys);
  for (const key of keys) {
    out[key] = normalizeCount((raw as Record<string, unknown>)[key]);
  }
  return out;
}

function emptyCompactionState(sessionPath: string, now: number): AoiFieldEventCompactionState {
  return {
    version: 1,
    sessionPath,
    updatedAt: now,
    compactedEventCount: 0,
    expiredEventCount: 0,
    overflowEventCount: 0,
    duplicateSuppressionCount: 0,
    lastTransactionId: null,
    buckets: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function normalizeCompactionBucket(value: unknown): AoiFieldEventCompactionBucket | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiFieldEventCompactionBucket>;
  if (
    raw.version !== 1 ||
    typeof raw.dayStart !== 'number' ||
    !Number.isFinite(raw.dayStart) ||
    raw.dayStart < 0
  ) {
    return null;
  }
  const dayStart = Math.trunc(raw.dayStart);
  return {
    version: 1,
    dayStart,
    dayEnd: dayStart + 24 * 60 * 60 * 1000,
    compactedEventCount: normalizeCount(raw.compactedEventCount),
    expiredEventCount: normalizeCount(raw.expiredEventCount),
    overflowEventCount: normalizeCount(raw.overflowEventCount),
    categoryCounts: normalizeCountRecord(raw.categoryCounts, FIELD_EVENT_CATEGORIES),
    privacyCounts: normalizeCountRecord(raw.privacyCounts, FIELD_EVENT_PRIVACY_STATES),
    sourceKindCounts: normalizeCountRecord(raw.sourceKindCounts, FIELD_EVENT_SOURCE_KINDS),
  };
}

function normalizeCompactionState(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiFieldEventCompactionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyCompactionState(sessionPath, now);
  }
  const raw = value as Partial<AoiFieldEventCompactionState>;
  if (raw.version !== 1 || raw.sessionPath !== sessionPath) {
    return emptyCompactionState(sessionPath, now);
  }
  const buckets = Array.isArray(raw.buckets)
    ? raw.buckets
        .map(normalizeCompactionBucket)
        .filter((bucket): bucket is AoiFieldEventCompactionBucket => bucket !== null)
        .sort((left, right) => right.dayStart - left.dayStart)
        .slice(0, MAX_COMPACTION_BUCKETS)
    : [];
  return {
    version: 1,
    sessionPath,
    updatedAt: normalizeTimestamp(raw.updatedAt, now),
    compactedEventCount: normalizeCount(raw.compactedEventCount),
    expiredEventCount: normalizeCount(raw.expiredEventCount),
    overflowEventCount: normalizeCount(raw.overflowEventCount),
    duplicateSuppressionCount: normalizeCount(raw.duplicateSuppressionCount),
    lastTransactionId:
      typeof raw.lastTransactionId === 'string' && /^[a-f0-9-]{16,64}$/.test(raw.lastTransactionId)
        ? raw.lastTransactionId
        : null,
    buckets,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function fieldEventRecordFingerprint(event: AoiFieldEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function normalizeCompactionJournal(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiFieldEventCompactionJournal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiFieldEventCompactionJournal>;
  if (
    raw.version !== 1 ||
    raw.sessionPath !== sessionPath ||
    typeof raw.transactionId !== 'string' ||
    !/^[a-f0-9-]{16,64}$/.test(raw.transactionId) ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt) ||
    !Array.isArray(raw.removedRecordFingerprints)
  ) {
    return null;
  }
  const removedRecordFingerprints = raw.removedRecordFingerprints.filter(
    (item): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item),
  );
  if (removedRecordFingerprints.length !== raw.removedRecordFingerprints.length) {
    return null;
  }
  const targetCompaction = normalizeCompactionState(raw.targetCompaction, sessionPath, now);
  if (targetCompaction.lastTransactionId !== raw.transactionId) {
    return null;
  }
  return {
    version: 1,
    sessionPath,
    transactionId: raw.transactionId,
    createdAt: Math.trunc(raw.createdAt),
    targetCompaction,
    removedRecordFingerprints,
  };
}

function recoverPendingCompactionTransaction(
  paths: AoiFieldEventLedgerPaths,
  sessionPath: string,
  now: number,
): void {
  assertSafeExistingLedgerPath(paths.trustedRoot, paths.compactionJournal);
  if (!fs.existsSync(paths.compactionJournal)) {
    return;
  }
  const journal = normalizeCompactionJournal(
    readJson(paths.trustedRoot, paths.compactionJournal),
    sessionPath,
    now,
  );
  if (!journal) {
    throw new Error('Invalid pending Aoi field event compaction transaction.');
  }
  const currentCompaction = normalizeCompactionState(
    readJson(paths.trustedRoot, paths.compaction),
    sessionPath,
    now,
  );
  if (currentCompaction.lastTransactionId !== journal.transactionId) {
    writeJsonAtomic(paths.trustedRoot, paths.compaction, journal.targetCompaction);
  }

  const removalCounts = new Map<string, number>();
  for (const fingerprint of journal.removedRecordFingerprints) {
    removalCounts.set(fingerprint, (removalCounts.get(fingerprint) ?? 0) + 1);
  }
  const retained: AoiFieldEvent[] = [];
  for (const item of readJsonLines(paths.trustedRoot, paths.events)) {
    const event = normalizeLoadedAoiFieldEvent(item, sessionPath, now);
    if (!event) {
      continue;
    }
    const fingerprint = fieldEventRecordFingerprint(event);
    const remaining = removalCounts.get(fingerprint) ?? 0;
    if (remaining > 0) {
      removalCounts.set(fingerprint, remaining - 1);
      continue;
    }
    retained.push(event);
  }
  writeJsonLines(paths.trustedRoot, paths.events, retained);
  removeFileSafely(paths.trustedRoot, paths.compactionJournal);
}

function commitCompactionTransaction(params: {
  paths: AoiFieldEventLedgerPaths;
  sessionPath: string;
  compaction: AoiFieldEventCompactionState;
  retainedEvents: readonly AoiFieldEvent[];
  removedEvents: readonly AoiFieldEvent[];
  now: number;
}): AoiFieldEventCompactionState {
  const transactionId = randomUUID();
  const targetCompaction: AoiFieldEventCompactionState = {
    ...params.compaction,
    lastTransactionId: transactionId,
  };
  const journal: AoiFieldEventCompactionJournal = {
    version: 1,
    sessionPath: params.sessionPath,
    transactionId,
    createdAt: params.now,
    targetCompaction,
    removedRecordFingerprints: params.removedEvents.map(fieldEventRecordFingerprint),
  };
  writeJsonAtomic(params.paths.trustedRoot, params.paths.compactionJournal, journal);
  writeJsonAtomic(params.paths.trustedRoot, params.paths.compaction, targetCompaction);
  writeJsonLines(params.paths.trustedRoot, params.paths.events, params.retainedEvents);
  removeFileSafely(params.paths.trustedRoot, params.paths.compactionJournal);
  return targetCompaction;
}

export function loadAoiFieldEventCompactionState(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldEventCompactionState {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiFieldEventLedgerPaths(sessionsDir, normalizedSessionPath);
  recoverPendingCompactionTransaction(paths, normalizedSessionPath, now);
  return normalizeCompactionState(
    readJson(paths.trustedRoot, paths.compaction),
    normalizedSessionPath,
    now,
  );
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function compactEntries(
  state: AoiFieldEventCompactionState,
  entries: readonly AoiFieldEventCompactionEntry[],
  now: number,
): AoiFieldEventCompactionState {
  if (entries.length === 0) {
    return state;
  }
  const buckets = new Map<number, AoiFieldEventCompactionBucket>(
    state.buckets.map((bucket) => [
      bucket.dayStart,
      {
        ...bucket,
        categoryCounts: { ...bucket.categoryCounts },
        privacyCounts: { ...bucket.privacyCounts },
        sourceKindCounts: { ...bucket.sourceKindCounts },
      },
    ]),
  );
  let expiredEventCount = state.expiredEventCount;
  let overflowEventCount = state.overflowEventCount;

  for (const entry of entries) {
    const dayStart = utcDayStart(entry.event.createdAt);
    const bucket = buckets.get(dayStart) ?? {
      version: 1 as const,
      dayStart,
      dayEnd: dayStart + 24 * 60 * 60 * 1000,
      compactedEventCount: 0,
      expiredEventCount: 0,
      overflowEventCount: 0,
      categoryCounts: normalizeCounts(FIELD_EVENT_CATEGORIES),
      privacyCounts: normalizeCounts(FIELD_EVENT_PRIVACY_STATES),
      sourceKindCounts: normalizeCounts(FIELD_EVENT_SOURCE_KINDS),
    };
    bucket.compactedEventCount += 1;
    bucket.categoryCounts[entry.event.category] += 1;
    bucket.privacyCounts[entry.event.privacyState] += 1;
    const sourceKinds = new Set(entry.event.sourceRefs.map(sourceKindFromRef));
    for (const sourceKind of sourceKinds) {
      bucket.sourceKindCounts[sourceKind] += 1;
    }
    if (entry.reason === 'expired') {
      bucket.expiredEventCount += 1;
      expiredEventCount += 1;
    } else {
      bucket.overflowEventCount += 1;
      overflowEventCount += 1;
    }
    buckets.set(dayStart, bucket);
  }

  return {
    ...state,
    updatedAt: now,
    compactedEventCount: state.compactedEventCount + entries.length,
    expiredEventCount,
    overflowEventCount,
    buckets: [...buckets.values()]
      .sort((left, right) => right.dayStart - left.dayStart)
      .slice(0, MAX_COMPACTION_BUCKETS),
  };
}

function loadAllAoiFieldEvents(
  paths: AoiFieldEventLedgerPaths,
  sessionPath: string,
  now: number,
): AoiFieldEvent[] {
  return readJsonLines(paths.trustedRoot, paths.events)
    .map((item) => normalizeLoadedAoiFieldEvent(item, sessionPath, now))
    .filter((item): item is AoiFieldEvent => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

function partitionFieldEvents(params: {
  events: readonly AoiFieldEvent[];
  now: number;
  enforceLimit: boolean;
  compactExpired: boolean;
}): {
  retained: AoiFieldEvent[];
  compacted: AoiFieldEventCompactionEntry[];
  discardedDuplicates: AoiFieldEvent[];
  duplicateCount: number;
} {
  const retained: AoiFieldEvent[] = [];
  const compacted: AoiFieldEventCompactionEntry[] = [];
  const discardedDuplicates: AoiFieldEvent[] = [];
  let duplicateCount = 0;
  const seenIds = new Set<string>();
  const latestByFingerprint = new Map<string, number>();
  const sorted = [...params.events].sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
  for (const event of sorted) {
    const latest = latestByFingerprint.get(event.dedupeFingerprint);
    const duplicate =
      seenIds.has(event.id) ||
      (latest !== undefined && latest - event.createdAt <= AOI_FIELD_EVENT_DEDUPE_WINDOW_MS);
    if (duplicate) {
      duplicateCount += 1;
      discardedDuplicates.push(event);
      continue;
    }
    seenIds.add(event.id);
    latestByFingerprint.set(event.dedupeFingerprint, event.createdAt);
    if (params.compactExpired && event.expiresAt <= params.now) {
      compacted.push({ event, reason: 'expired' });
      continue;
    }
    if (params.enforceLimit && retained.length >= MAX_EVENTS) {
      compacted.push({ event, reason: 'overflow' });
      continue;
    }
    retained.push(event);
  }
  return { retained, compacted, discardedDuplicates, duplicateCount };
}

export function compactAoiFieldEventLedger(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): { retainedEvents: AoiFieldEvent[]; compaction: AoiFieldEventCompactionState } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiFieldEventLedgerPaths(sessionsDir, normalizedSessionPath);
  recoverPendingCompactionTransaction(paths, normalizedSessionPath, now);
  const events = loadAllAoiFieldEvents(paths, normalizedSessionPath, now);
  const partitioned = partitionFieldEvents({
    events,
    now,
    enforceLimit: true,
    compactExpired: true,
  });
  const prior = loadAoiFieldEventCompactionState(sessionsDir, normalizedSessionPath, now);
  const compactedState = compactEntries(prior, partitioned.compacted, now);
  let compaction = {
    ...compactedState,
    duplicateSuppressionCount:
      compactedState.duplicateSuppressionCount + partitioned.duplicateCount,
    updatedAt:
      partitioned.compacted.length > 0 || partitioned.duplicateCount > 0
        ? now
        : compactedState.updatedAt,
  };
  const retainedEvents = [...partitioned.retained].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const removedEvents = [
    ...partitioned.compacted.map((entry) => entry.event),
    ...partitioned.discardedDuplicates,
  ];
  if (removedEvents.length > 0) {
    compaction = commitCompactionTransaction({
      paths,
      sessionPath: normalizedSessionPath,
      compaction,
      retainedEvents,
      removedEvents,
      now,
    });
  } else {
    writeJsonLines(paths.trustedRoot, paths.events, retainedEvents);
    writeJsonAtomic(paths.trustedRoot, paths.compaction, compaction);
  }
  return { retainedEvents: partitioned.retained, compaction };
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
  recoverPendingCompactionTransaction(paths, normalizedSessionPath, now);
  return loadAllAoiFieldEvents(paths, normalizedSessionPath, now).slice(
    0,
    Math.max(1, Math.min(MAX_EVENTS, Math.trunc(limit))),
  );
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
  return appendAoiFieldEvents(sessionsDir, [input], now)[0];
}

export function appendAoiFieldEvents(
  sessionsDir: string,
  inputs: readonly AoiFieldEventInput[],
  now = Date.now(),
): AoiFieldEvent[] {
  const normalizedInputs = inputs.map((input) => {
    const normalized = normalizeAoiFieldEvent(input, undefined, now);
    if (!normalized) {
      throw new Error('Invalid Aoi field event.');
    }
    return normalized;
  });
  const output = new Array<AoiFieldEvent>(normalizedInputs.length);
  const grouped = new Map<string, Array<{ index: number; event: AoiFieldEvent }>>();
  normalizedInputs.forEach((event, index) => {
    const items = grouped.get(event.sessionPath) ?? [];
    items.push({ index, event });
    grouped.set(event.sessionPath, items);
  });

  for (const [sessionPath, items] of grouped) {
    const paths = resolveAoiFieldEventLedgerPaths(sessionsDir, sessionPath);
    recoverPendingCompactionTransaction(paths, sessionPath, now);
    const loaded = loadAllAoiFieldEvents(paths, sessionPath, now);
    const initialPartition = partitionFieldEvents({
      events: loaded,
      now,
      enforceLimit: loaded.length > MAX_STORED_EVENTS,
      compactExpired: true,
    });
    const working = [...initialPartition.retained];
    const appended: AoiFieldEvent[] = [];
    let duplicateSuppressionCount = initialPartition.duplicateCount;

    for (const item of items) {
      const existing = working.find(
        (event) =>
          event.id === item.event.id ||
          (event.category === item.event.category &&
            event.dedupeFingerprint === item.event.dedupeFingerprint &&
            Math.abs(event.createdAt - item.event.createdAt) <= AOI_FIELD_EVENT_DEDUPE_WINDOW_MS),
      );
      if (existing) {
        output[item.index] = existing;
        duplicateSuppressionCount += 1;
        continue;
      }
      working.push(item.event);
      appended.push(item.event);
      output[item.index] = item.event;
    }

    const finalPartition = partitionFieldEvents({
      events: working,
      now,
      enforceLimit: working.length > MAX_STORED_EVENTS,
      compactExpired: working.length > MAX_STORED_EVENTS,
    });
    duplicateSuppressionCount += finalPartition.duplicateCount;
    const compacted = [...initialPartition.compacted, ...finalPartition.compacted];
    const prior = loadAoiFieldEventCompactionState(sessionsDir, sessionPath, now);
    const compaction = {
      ...compactEntries(prior, compacted, now),
      duplicateSuppressionCount: prior.duplicateSuppressionCount + duplicateSuppressionCount,
      updatedAt: compacted.length > 0 || duplicateSuppressionCount > 0 ? now : prior.updatedAt,
    };
    const requiresRewrite =
      compacted.length > 0 ||
      initialPartition.duplicateCount > 0 ||
      finalPartition.duplicateCount > 0;
    if (requiresRewrite) {
      const retainedEvents = [...finalPartition.retained].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
      const removedEvents = [
        ...initialPartition.compacted.map((entry) => entry.event),
        ...initialPartition.discardedDuplicates,
        ...finalPartition.compacted.map((entry) => entry.event),
        ...finalPartition.discardedDuplicates,
      ];
      commitCompactionTransaction({
        paths,
        sessionPath,
        compaction,
        retainedEvents,
        removedEvents,
        now,
      });
    } else {
      for (const event of appended) {
        appendJsonLine(paths.trustedRoot, paths.events, event);
      }
    }
    if (
      !requiresRewrite &&
      (compacted.length > 0 || duplicateSuppressionCount > 0 || fs.existsSync(paths.compaction))
    ) {
      writeJsonAtomic(paths.trustedRoot, paths.compaction, compaction);
    }
  }

  return output;
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
  return compactAoiFieldEventLedger(sessionsDir, normalizedSessionPath, now).retainedEvents.sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

export function buildAoiFieldLedgerSummary(params: {
  sessionPath: string;
  events: readonly AoiFieldEvent[];
  compaction?: AoiFieldEventCompactionState | null;
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
  const compaction = normalizeCompactionState(params.compaction, sessionPath, now);
  const categoryCounts = normalizeCounts(FIELD_EVENT_CATEGORIES);
  const privacyCounts = normalizeCounts(FIELD_EVENT_PRIVACY_STATES);
  const sourceKindCounts = normalizeCounts(FIELD_EVENT_SOURCE_KINDS);
  const compactedCategoryCounts = normalizeCounts(FIELD_EVENT_CATEGORIES);
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
  for (const bucket of compaction.buckets) {
    for (const category of FIELD_EVENT_CATEGORIES) {
      compactedCategoryCounts[category] += bucket.categoryCounts[category];
    }
  }

  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    totalEventCount: normalizedEvents.length + compaction.compactedEventCount,
    retainedEventCount: normalizedEvents.length,
    compactedEventCount: compaction.compactedEventCount,
    duplicateSuppressionCount: compaction.duplicateSuppressionCount,
    activeEventCount: activeEvents.length,
    expiredEventCount: expiredEvents.length + compaction.expiredEventCount,
    categoryCounts,
    privacyCounts,
    sourceKindCounts,
    recentEvents: activeEvents.slice(0, MAX_SUMMARY_EVENTS),
    compactedCategoryCounts,
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REFS),
    cannotKnow: [...cannotKnow].slice(0, MAX_REFS),
    actionAuthority: 'display_only',
    mutationCount: 0,
    zeroMutation: true,
    readinessCreditEventCount: 0,
  };
}

export function loadAoiFieldLedgerSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldLedgerSummary {
  const events = loadAoiFieldEvents(sessionsDir, sessionPath, now, MAX_EVENTS);
  const compaction = loadAoiFieldEventCompactionState(sessionsDir, sessionPath, now);
  return buildAoiFieldLedgerSummary({
    sessionPath,
    events,
    compaction,
    now,
  });
}
