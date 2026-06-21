import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  createAoiAutonomyId,
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type { AoiOperatorReplayFixture, AoiReplayInputEvent } from './aoiOperatorReplay';

const FLIGHT_RECORDER_DIR = 'operator-flight-recorder';
const FLIGHT_RECORDS_FILE = 'records.jsonl';
const REPLAY_DRAFTS_DIR = 'replay-drafts';
const MAX_RECORDS = 500;
const MAX_RECENT_RECORDS = 12;
const MAX_TEXT = 260;
const MAX_REFS = 24;
const MAX_SOURCE_STATES = 16;

const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:(?:[\\/][^\s'"`<>|]+)+/g;
const UNC_PATH_PATTERN = /\\\\[^\s'"`<>|]+(?:\\[^\s'"`<>|]+)+/g;
const UNIX_PATH_PATTERN = /\b\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s'"`<>]+/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PRIVATE_BODY_PATTERN =
  /\b(?:message|email|mail|calendar|event|note|source|raw)\s+body\s*[:=-]\s*[^.!?\n\r]{1,240}/gi;

export type AoiOperatorFlightSignalClass =
  | 'user_message'
  | 'app_state'
  | 'workspace'
  | 'research'
  | 'kira'
  | 'proactive_scheduler'
  | 'capability'
  | 'manual'
  | 'unknown';

export type AoiOperatorFlightDecisionLane =
  | 'hidden'
  | 'dashboard'
  | 'digest'
  | 'direct_chat'
  | 'approval_request'
  | 'blocked';

export type AoiOperatorFlightSourceStateStatus =
  | 'available'
  | 'disconnected'
  | 'revoked'
  | 'disabled'
  | 'stale'
  | 'unknown';

export type AoiOperatorFlightSourceFreshness = 'fresh' | 'stale' | 'unknown' | 'failed';

export type AoiOperatorFlightApprovalStatus =
  | 'not_required'
  | 'required'
  | 'pending'
  | 'approved'
  | 'blocked'
  | 'expired'
  | 'unknown';

export interface AoiOperatorFlightSourceState {
  sourceId: string;
  label: string;
  kind: string;
  state: AoiOperatorFlightSourceStateStatus;
  freshness: AoiOperatorFlightSourceFreshness;
  cannotKnow: string[];
  evidenceRefs: string[];
}

export interface AoiOperatorFlightApprovalState {
  status: AoiOperatorFlightApprovalStatus;
  required: boolean;
  approvalRef?: string;
  reason?: string;
}

export interface AoiOperatorFlightHardFailCounters {
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  staleCurrentClaimCount: number;
  approvalBypassCount: number;
}

export interface AoiOperatorFlightRedactionSummary {
  replacementCount: number;
  localPathCount: number;
  urlCount: number;
  emailCount: number;
  privateBodyCount: number;
  secretCount: number;
}

export interface AoiOperatorFlightRecord {
  version: 1;
  id: string;
  sessionPath: string;
  createdAt: number;
  signalClass: AoiOperatorFlightSignalClass;
  decisionLane: AoiOperatorFlightDecisionLane;
  sourceStates: AoiOperatorFlightSourceState[];
  evidenceRefs: string[];
  whySpeak: string[];
  whyQuiet: string[];
  preparedActionRefs: string[];
  approvalState: AoiOperatorFlightApprovalState;
  outcomeRefs: string[];
  hardFailCounters: AoiOperatorFlightHardFailCounters;
  redaction: AoiOperatorFlightRedactionSummary;
  mutationCount: number;
  actionAuthority: 'display_only';
}

export interface AoiOperatorFlightRecordInput {
  id?: unknown;
  sessionPath?: unknown;
  createdAt?: unknown;
  signalClass?: unknown;
  decisionLane?: unknown;
  sourceStates?: unknown;
  evidenceRefs?: unknown;
  whySpeak?: unknown;
  whyQuiet?: unknown;
  preparedActionRefs?: unknown;
  approvalState?: unknown;
  outcomeRefs?: unknown;
  hardFailCounters?: unknown;
  mutationCount?: unknown;
}

export interface AoiOperatorFlightRecorderPaths {
  root: string;
  records: string;
  replayDraftsDir: string;
}

export interface AoiOperatorFlightRecorderSummary {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  totalRecordCount: number;
  laneCounts: Record<AoiOperatorFlightDecisionLane, number>;
  hardFailCounters: AoiOperatorFlightHardFailCounters;
  latestBlindSpotLabels: string[];
  latestSourceFreshnessGapLabels: string[];
  recentRecords: AoiOperatorFlightRecord[];
  evidenceRefs: string[];
  replayDraftCount: number;
  mutationCount: number;
  actionAuthority: 'display_only';
}

export interface AoiOperatorFlightReplayDraft {
  version: 1;
  id: string;
  sourceRecordId: string;
  fixtureId: string;
  status: 'draft_needs_review';
  createdAt: number;
  sessionPath: string;
  title: string;
  fixture: AoiOperatorReplayFixture;
  redaction: AoiOperatorFlightRedactionSummary;
  todoExpectations: string[];
  warnings: string[];
  evidenceRefs: string[];
  mutationCount: 0;
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
    throw new Error('Resolved Aoi flight recorder path escaped the autonomy directory.');
  }
  ensureDirectory(filePath, true);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeJsonAtomic(root: string, filePath: string, value: unknown): void {
  if (!isPathInsideRoot(root, filePath)) {
    throw new Error('Resolved Aoi flight recorder path escaped the autonomy directory.');
  }
  ensureDirectory(filePath, true);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1000, Math.round(value)));
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

function emptyRedactionSummary(): AoiOperatorFlightRedactionSummary {
  return {
    replacementCount: 0,
    localPathCount: 0,
    urlCount: 0,
    emailCount: 0,
    privateBodyCount: 0,
    secretCount: 0,
  };
}

function redactFlightText(
  value: unknown,
  summary: AoiOperatorFlightRedactionSummary,
  maxChars = MAX_TEXT,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const beforeSecret = value;
  let next = stripAoiSourceInstructions(redactAoiSensitiveContent(value));
  if (next !== beforeSecret) {
    summary.secretCount += 1;
  }
  next = next.replace(PRIVATE_BODY_PATTERN, () => {
    summary.privateBodyCount += 1;
    return '[private-body]';
  });
  next = next.replace(WINDOWS_PATH_PATTERN, () => {
    summary.localPathCount += 1;
    return '[local-path]';
  });
  next = next.replace(UNC_PATH_PATTERN, () => {
    summary.localPathCount += 1;
    return '[local-path]';
  });
  next = next.replace(UNIX_PATH_PATTERN, () => {
    summary.localPathCount += 1;
    return '[local-path]';
  });
  next = next.replace(URL_PATTERN, () => {
    summary.urlCount += 1;
    return '[url]';
  });
  next = next.replace(EMAIL_PATTERN, () => {
    summary.emailCount += 1;
    return '[email]';
  });
  summary.replacementCount =
    summary.localPathCount +
    summary.urlCount +
    summary.emailCount +
    summary.privateBodyCount +
    summary.secretCount;
  const normalized = normalizeWhitespace(next);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeTextOrFallback(
  value: unknown,
  fallback: string,
  summary: AoiOperatorFlightRedactionSummary,
  maxChars = MAX_TEXT,
): string {
  return redactFlightText(value, summary, maxChars) ?? fallback;
}

function normalizeStringList(
  value: unknown,
  summary: AoiOperatorFlightRedactionSummary,
  maxItems = MAX_REFS,
  maxChars = 180,
): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawItems) {
    const normalized = redactFlightText(item, summary, maxChars);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function normalizeSignalClass(value: unknown): AoiOperatorFlightSignalClass {
  if (
    value === 'user_message' ||
    value === 'app_state' ||
    value === 'workspace' ||
    value === 'research' ||
    value === 'kira' ||
    value === 'proactive_scheduler' ||
    value === 'capability' ||
    value === 'manual' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeDecisionLane(value: unknown): AoiOperatorFlightDecisionLane {
  if (
    value === 'hidden' ||
    value === 'dashboard' ||
    value === 'digest' ||
    value === 'direct_chat' ||
    value === 'approval_request' ||
    value === 'blocked'
  ) {
    return value;
  }
  return 'hidden';
}

function normalizeSourceStateStatus(value: unknown): AoiOperatorFlightSourceStateStatus {
  if (
    value === 'available' ||
    value === 'disconnected' ||
    value === 'revoked' ||
    value === 'disabled' ||
    value === 'stale' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeSourceFreshness(value: unknown): AoiOperatorFlightSourceFreshness {
  if (value === 'fresh' || value === 'stale' || value === 'unknown' || value === 'failed') {
    return value;
  }
  return 'unknown';
}

function normalizeApprovalStatus(value: unknown): AoiOperatorFlightApprovalStatus {
  if (
    value === 'not_required' ||
    value === 'required' ||
    value === 'pending' ||
    value === 'approved' ||
    value === 'blocked' ||
    value === 'expired' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeSourceStates(
  value: unknown,
  summary: AoiOperatorFlightRedactionSummary,
): AoiOperatorFlightSourceState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: AoiOperatorFlightSourceState[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const raw = item as Partial<AoiOperatorFlightSourceState>;
    const sourceId = normalizeTextOrFallback(raw.sourceId, 'unknown-source', summary, 120);
    const key = sourceId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      sourceId,
      label: normalizeTextOrFallback(raw.label, sourceId, summary, 160),
      kind: normalizeTextOrFallback(raw.kind, 'unknown', summary, 80),
      state: normalizeSourceStateStatus(raw.state),
      freshness: normalizeSourceFreshness(raw.freshness),
      cannotKnow: normalizeStringList(raw.cannotKnow, summary, 8, 180),
      evidenceRefs: normalizeStringList(raw.evidenceRefs, summary, 8, 180),
    });
    if (out.length >= MAX_SOURCE_STATES) {
      break;
    }
  }
  return out;
}

function normalizeApprovalState(
  value: unknown,
  summary: AoiOperatorFlightRedactionSummary,
): AoiOperatorFlightApprovalState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      status: 'not_required',
      required: false,
    };
  }
  const raw = value as Partial<AoiOperatorFlightApprovalState>;
  const status = normalizeApprovalStatus(raw.status);
  const required = typeof raw.required === 'boolean' ? raw.required : status !== 'not_required';
  const approvalRef = redactFlightText(raw.approvalRef, summary, 160);
  const reason = redactFlightText(raw.reason, summary, 180);
  return {
    status,
    required,
    ...(approvalRef ? { approvalRef } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizeHardFailCounters(value: unknown): AoiOperatorFlightHardFailCounters {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiOperatorFlightHardFailCounters>)
      : {};
  return {
    privateLeakCount: clampCount(raw.privateLeakCount),
    unauthorizedMutationCount: clampCount(raw.unauthorizedMutationCount),
    staleCurrentClaimCount: clampCount(raw.staleCurrentClaimCount),
    approvalBypassCount: clampCount(raw.approvalBypassCount),
  };
}

function normalizeRedactionSummary(value: unknown): AoiOperatorFlightRedactionSummary {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<AoiOperatorFlightRedactionSummary>)
      : {};
  return {
    replacementCount: clampCount(raw.replacementCount),
    localPathCount: clampCount(raw.localPathCount),
    urlCount: clampCount(raw.urlCount),
    emailCount: clampCount(raw.emailCount),
    privateBodyCount: clampCount(raw.privateBodyCount),
    secretCount: clampCount(raw.secretCount),
  };
}

function makeRecordId(params: {
  id?: unknown;
  sessionPath: string;
  createdAt: number;
  signalClass: AoiOperatorFlightSignalClass;
  decisionLane: AoiOperatorFlightDecisionLane;
  evidenceRefs: string[];
}): string {
  if (isValidAoiAutonomyId(params.id)) {
    return params.id;
  }
  const stablePart = hashText(
    [
      params.sessionPath,
      String(params.createdAt),
      params.signalClass,
      params.decisionLane,
      params.evidenceRefs.join(','),
    ].join('|'),
  );
  return `aoi-flight-${stablePart}`;
}

export function resolveAoiOperatorFlightRecorderPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiOperatorFlightRecorderPaths {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const autonomyPaths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const root = join(autonomyPaths.root, FLIGHT_RECORDER_DIR);
  return {
    root,
    records: join(root, FLIGHT_RECORDS_FILE),
    replayDraftsDir: join(root, REPLAY_DRAFTS_DIR),
  };
}

export function normalizeAoiOperatorFlightRecord(
  input: AoiOperatorFlightRecordInput,
  now = Date.now(),
): AoiOperatorFlightRecord | null {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    return null;
  }
  const createdAt = normalizeTimestamp(input.createdAt, now);
  const redaction = emptyRedactionSummary();
  const signalClass = normalizeSignalClass(input.signalClass);
  const decisionLane = normalizeDecisionLane(input.decisionLane);
  const sourceStates = normalizeSourceStates(input.sourceStates, redaction);
  const evidenceRefs = normalizeStringList(input.evidenceRefs, redaction);
  const whySpeak = normalizeStringList(input.whySpeak, redaction, 12, 220);
  const whyQuiet = normalizeStringList(input.whyQuiet, redaction, 12, 220);
  const preparedActionRefs = normalizeStringList(input.preparedActionRefs, redaction);
  const approvalState = normalizeApprovalState(input.approvalState, redaction);
  const outcomeRefs = normalizeStringList(input.outcomeRefs, redaction);
  const hardFailCounters = normalizeHardFailCounters(input.hardFailCounters);
  const mutationCount = clampCount(input.mutationCount);
  const id = makeRecordId({
    id: input.id,
    sessionPath,
    createdAt,
    signalClass,
    decisionLane,
    evidenceRefs,
  });

  return {
    version: 1,
    id,
    sessionPath,
    createdAt,
    signalClass,
    decisionLane,
    sourceStates,
    evidenceRefs,
    whySpeak,
    whyQuiet,
    preparedActionRefs,
    approvalState,
    outcomeRefs,
    hardFailCounters,
    redaction,
    mutationCount,
    actionAuthority: 'display_only',
  };
}

function normalizeLoadedFlightRecord(
  value: unknown,
  sessionPath: string,
  now: number,
): AoiOperatorFlightRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiOperatorFlightRecord>;
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.createdAt !== 'number' ||
    !Array.isArray(raw.sourceStates) ||
    !Array.isArray(raw.evidenceRefs) ||
    !Array.isArray(raw.whySpeak) ||
    !Array.isArray(raw.whyQuiet) ||
    !Array.isArray(raw.preparedActionRefs) ||
    !Array.isArray(raw.outcomeRefs)
  ) {
    return null;
  }
  const normalized = normalizeAoiOperatorFlightRecord(
    {
      ...raw,
      sessionPath: raw.sessionPath ?? sessionPath,
    },
    now,
  );
  return normalized
    ? {
        ...normalized,
        id: raw.id,
        hardFailCounters: normalizeHardFailCounters(raw.hardFailCounters),
        redaction: normalizeRedactionSummary(raw.redaction),
        mutationCount: clampCount(raw.mutationCount),
      }
    : null;
}

export function recordAoiOperatorFlightRecord(
  sessionsDir: string,
  input: AoiOperatorFlightRecordInput,
  now = Date.now(),
): AoiOperatorFlightRecord {
  const record = normalizeAoiOperatorFlightRecord(input, now);
  if (!record) {
    throw new Error('Invalid Aoi operator flight record.');
  }
  const paths = resolveAoiOperatorFlightRecorderPaths(sessionsDir, record.sessionPath);
  appendJsonLine(paths.root, paths.records, record);
  return record;
}

export function loadAoiOperatorFlightRecords(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_RECORDS,
): AoiOperatorFlightRecord[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiOperatorFlightRecorderPaths(sessionsDir, normalizedSessionPath);
  const max = Math.max(1, Math.min(MAX_RECORDS, Math.trunc(limit)));
  return readJsonLines(paths.records)
    .map((item) => normalizeLoadedFlightRecord(item, normalizedSessionPath, now))
    .filter((item): item is AoiOperatorFlightRecord => item !== null)
    .filter((item) => item.sessionPath === normalizedSessionPath)
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
    .slice(0, max);
}

function emptyLaneCounts(): Record<AoiOperatorFlightDecisionLane, number> {
  return {
    hidden: 0,
    dashboard: 0,
    digest: 0,
    direct_chat: 0,
    approval_request: 0,
    blocked: 0,
  };
}

function addHardFailCounters(
  left: AoiOperatorFlightHardFailCounters,
  right: AoiOperatorFlightHardFailCounters,
): AoiOperatorFlightHardFailCounters {
  return {
    privateLeakCount: left.privateLeakCount + right.privateLeakCount,
    unauthorizedMutationCount: left.unauthorizedMutationCount + right.unauthorizedMutationCount,
    staleCurrentClaimCount: left.staleCurrentClaimCount + right.staleCurrentClaimCount,
    approvalBypassCount: left.approvalBypassCount + right.approvalBypassCount,
  };
}

function countReplayDrafts(paths: AoiOperatorFlightRecorderPaths): number {
  try {
    if (!fs.existsSync(paths.replayDraftsDir)) {
      return 0;
    }
    return fs
      .readdirSync(paths.replayDraftsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function pushUnique(out: string[], value: string | undefined, maxItems: number): void {
  const normalized = normalizeWhitespace(value ?? '');
  if (!normalized || out.includes(normalized) || out.length >= maxItems) {
    return;
  }
  out.push(normalized);
}

export function buildAoiOperatorFlightRecorderSummary(params: {
  sessionPath: string;
  records: readonly AoiOperatorFlightRecord[];
  replayDraftCount?: number;
  now?: number;
}): AoiOperatorFlightRecorderSummary {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const laneCounts = emptyLaneCounts();
  let hardFailCounters: AoiOperatorFlightHardFailCounters = {
    privateLeakCount: 0,
    unauthorizedMutationCount: 0,
    staleCurrentClaimCount: 0,
    approvalBypassCount: 0,
  };
  let mutationCount = 0;
  const latestBlindSpotLabels: string[] = [];
  const latestSourceFreshnessGapLabels: string[] = [];
  const evidenceRefs: string[] = [];

  const records = [...params.records].sort(
    (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );
  for (const record of records) {
    laneCounts[record.decisionLane] += 1;
    hardFailCounters = addHardFailCounters(hardFailCounters, record.hardFailCounters);
    mutationCount += record.mutationCount;
    for (const ref of record.evidenceRefs) {
      pushUnique(evidenceRefs, ref, MAX_REFS);
    }
    for (const source of record.sourceStates) {
      if (
        source.state === 'disconnected' ||
        source.state === 'revoked' ||
        source.state === 'disabled' ||
        source.state === 'unknown'
      ) {
        pushUnique(
          latestBlindSpotLabels,
          `${source.label}: ${source.state}; ${
            source.cannotKnow[0] ?? 'Aoi cannot rely on this source.'
          }`,
          8,
        );
      }
      if (
        source.freshness === 'stale' ||
        source.freshness === 'unknown' ||
        source.freshness === 'failed' ||
        source.state === 'stale'
      ) {
        pushUnique(
          latestSourceFreshnessGapLabels,
          `${source.label}: ${source.freshness} freshness / ${source.state} state`,
          8,
        );
      }
    }
  }

  return {
    version: 1,
    sessionPath,
    generatedAt: params.now ?? Date.now(),
    totalRecordCount: records.length,
    laneCounts,
    hardFailCounters,
    latestBlindSpotLabels,
    latestSourceFreshnessGapLabels,
    recentRecords: records.slice(0, MAX_RECENT_RECORDS),
    evidenceRefs,
    replayDraftCount: params.replayDraftCount ?? 0,
    mutationCount,
    actionAuthority: 'display_only',
  };
}

export function loadAoiOperatorFlightRecorderSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiOperatorFlightRecorderSummary {
  const records = loadAoiOperatorFlightRecords(sessionsDir, sessionPath, now, MAX_RECORDS);
  const paths = resolveAoiOperatorFlightRecorderPaths(sessionsDir, sessionPath);
  return buildAoiOperatorFlightRecorderSummary({
    sessionPath,
    records,
    replayDraftCount: countReplayDrafts(paths),
    now,
  });
}

function replayKindForRecord(record: AoiOperatorFlightRecord): AoiReplayInputEvent['kind'] {
  if (record.decisionLane === 'approval_request' || record.decisionLane === 'blocked') {
    return 'proposal_decision';
  }
  if (record.signalClass === 'workspace') {
    return 'workspace_snapshot';
  }
  if (record.signalClass === 'research') {
    return 'research_run';
  }
  if (record.signalClass === 'kira') {
    return 'kira_memory';
  }
  return 'environment_source';
}

function sanitizeFixturePart(value: string): string {
  return (
    normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'flight-record'
  );
}

export function buildAoiOperatorFlightReplayDraft(params: {
  record: AoiOperatorFlightRecord;
  now?: number;
  title?: string;
}): AoiOperatorFlightReplayDraft {
  const record = params.record;
  const now = params.now ?? record.createdAt;
  const fixtureId = sanitizeFixturePart(`flight-${record.id}`);
  const draftId = createAoiAutonomyId('aoi-flight-replay-draft', now);
  const sourceRefs = record.sourceStates.map((source) => `${source.kind}:${source.sourceId}`);
  const summaryParts = [
    `lane=${record.decisionLane}`,
    `signal=${record.signalClass}`,
    record.whySpeak[0] ? `speak=${record.whySpeak[0]}` : undefined,
    record.whyQuiet[0] ? `quiet=${record.whyQuiet[0]}` : undefined,
    ...record.sourceStates
      .flatMap((source) => source.cannotKnow.slice(0, 1))
      .map((statement) => `cannotKnow=${statement}`),
  ].filter((item): item is string => Boolean(item));
  const inputEvent: AoiReplayInputEvent = {
    version: 1,
    id: sanitizeFixturePart(`flight-event-${record.id}`),
    kind: replayKindForRecord(record),
    createdAt: record.createdAt,
    summary: summaryParts.join('; '),
    sourceRef: sourceRefs[0] ?? `${record.signalClass}:${record.id}`,
    evidenceRefs: record.evidenceRefs,
  };
  const fixture: AoiOperatorReplayFixture = {
    version: 1,
    id: fixtureId,
    title: params.title ?? `TODO review operator flight record ${record.id}`,
    description:
      'Draft generated from a redacted operator flight record. Replace TODO expectation before adding to built-in replay fixtures.',
    sessionPath: record.sessionPath,
    now,
    latestUserMessage:
      record.signalClass === 'user_message'
        ? 'TODO: replace with synthetic user message that matches the redacted flight record.'
        : 'TODO: replace with synthetic operator context for this flight record.',
    inputEvents: [inputEvent],
    expectedDecisions: [
      {
        id: 'todo-review-flight-record',
        metric: 'snapshot_summary',
        label: 'TODO: replace this placeholder with concrete runtime observability expectation.',
        snapshotIncludes: 'TODO_REPLACE_THIS_EXPECTATION',
      },
    ],
  };
  return {
    version: 1,
    id: draftId,
    sourceRecordId: record.id,
    fixtureId,
    status: 'draft_needs_review',
    createdAt: now,
    sessionPath: record.sessionPath,
    title: fixture.title,
    fixture,
    redaction: record.redaction,
    todoExpectations: [
      'Review whether the decision lane should be hidden, dashboard, digest, direct_chat, approval_request, or blocked.',
      'Replace the placeholder expectation with a concrete replay assertion before promotion.',
      'Keep synthetic labels; do not paste raw message bodies, private notes, local paths, URLs, emails, or command output back into the fixture.',
    ],
    warnings: [
      'This draft builder does not execute shell commands, call network APIs, read connector bodies, or mutate built-in replay fixtures.',
      'Flight recorder evidence is audit evidence, not permission to execute app actions.',
    ],
    evidenceRefs: [`flight-record:${record.id}`, ...record.evidenceRefs],
    mutationCount: 0,
  };
}

export function saveAoiOperatorFlightReplayDraft(
  sessionsDir: string,
  draft: AoiOperatorFlightReplayDraft,
): AoiOperatorFlightReplayDraft {
  const paths = resolveAoiOperatorFlightRecorderPaths(sessionsDir, draft.sessionPath);
  writeJsonAtomic(paths.root, join(paths.replayDraftsDir, `${draft.id}.json`), draft);
  return draft;
}

export function createAoiOperatorFlightReplayDraft(params: {
  sessionsDir: string;
  sessionPath: string;
  recordId?: string;
  now?: number;
  persist?: boolean;
}): AoiOperatorFlightReplayDraft {
  const records = loadAoiOperatorFlightRecords(
    params.sessionsDir,
    params.sessionPath,
    params.now,
    MAX_RECORDS,
  );
  const record = params.recordId ? records.find((item) => item.id === params.recordId) : records[0];
  if (!record) {
    throw new Error('No Aoi operator flight record is available for replay extraction.');
  }
  const draft = buildAoiOperatorFlightReplayDraft({
    record,
    now: params.now,
  });
  return params.persist === false
    ? draft
    : saveAoiOperatorFlightReplayDraft(params.sessionsDir, draft);
}

export function loadAoiOperatorFlightReplayDrafts(
  sessionsDir: string,
  sessionPath: string,
  limit = 50,
): AoiOperatorFlightReplayDraft[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiOperatorFlightRecorderPaths(sessionsDir, normalizedSessionPath);
  const max = Math.max(1, Math.min(100, Math.trunc(limit)));
  try {
    if (!fs.existsSync(paths.replayDraftsDir)) {
      return [];
    }
    return fs
      .readdirSync(paths.replayDraftsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) =>
        readJsonFile<AoiOperatorFlightReplayDraft>(join(paths.replayDraftsDir, entry.name)),
      )
      .filter((item): item is AoiOperatorFlightReplayDraft => Boolean(item))
      .filter((item) => item.version === 1 && item.sessionPath === normalizedSessionPath)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .slice(0, max);
  } catch {
    return [];
  }
}
