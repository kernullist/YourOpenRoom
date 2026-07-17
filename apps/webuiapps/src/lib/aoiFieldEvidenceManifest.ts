import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { resolveAoiActivityStreamPaths } from './aoiActivityStream';
import { resolveAoiGoalPaths } from './aoiAutonomyGoals';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import { resolveAoiCurrentSituationPaths } from './aoiCurrentSituationModel';
import { resolveAoiFieldEventLedgerPaths } from './aoiFieldEventLedger';
import { resolveAoiOperatorFlightRecorderPaths } from './aoiOperatorFlightRecorder';
import { getAoiOutcomeSignalSemanticKey } from './aoiOutcomeLearning';
import type { AoiOutcomeSignalRecord } from './aoiAutonomyTypes';

export type AoiFieldEvidenceClass = 'synthetic' | 'controlled_real' | 'live_field';
export type AoiFieldEvidenceSourceKind = 'json' | 'jsonl' | 'json_directory';

export interface AoiFieldEvidenceParseError {
  code:
    | 'json_parse_error'
    | 'jsonl_parse_error'
    | 'read_error'
    | 'file_too_large'
    | 'file_limit_exceeded'
    | 'symlink_skipped';
  line?: number;
  fileFingerprint: string;
}

export interface AoiFieldEvidenceSourceManifest {
  version: 1;
  id: string;
  kind: AoiFieldEvidenceSourceKind;
  relativePath: string;
  required: boolean;
  exists: boolean;
  fileCount: number;
  byteSize: number;
  recordCount: number;
  validRecordCount: number;
  invalidRecordCount: number;
  sessionMismatchCount: number;
  privateValueCount: number;
  syntheticMarkerCount: number;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  recordTypeCounts: Record<string, number>;
  evidenceClassCounts: Record<AoiFieldEvidenceClass, number>;
  contentFingerprint: string;
  parseErrors: AoiFieldEvidenceParseError[];
}

export interface AoiFieldEvidenceClassCounts {
  sourceCount: number;
  recordCount: number;
  byteSize: number;
}

export interface AoiFieldEvidenceOperationalCounts {
  fieldEventCount: number;
  situationSampleCount: number;
  groundedSituationCount: number;
  runCount: number;
  executionRecordCount: number;
  executionOutcomeCount: number;
  outcomeSignalCount: number;
  feedbackRecordCount: number;
  shadowDecisionCount: number;
  shadowLabelCount: number;
  rollbackEvidenceCount: number;
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  approvalBypassCount: number;
  staleCurrentClaimCount: number;
}

export interface AoiFieldEvidenceManifest {
  version: 1;
  id: string;
  sessionPath: string;
  evidenceClass: AoiFieldEvidenceClass;
  generatedAt: number;
  sessionExists: boolean;
  sessionRootFingerprintBefore: string;
  sessionRootFingerprintAfter: string;
  readOnlyVerified: boolean;
  manifestFingerprint: string;
  sourceCount: number;
  existingSourceCount: number;
  recordCount: number;
  validRecordCount: number;
  invalidRecordCount: number;
  byteSize: number;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  parseErrorCount: number;
  sessionMismatchCount: number;
  privateValueCount: number;
  syntheticMarkerCount: number;
  mixedEvidenceClass: boolean;
  evidenceClassCounts: Record<AoiFieldEvidenceClass, AoiFieldEvidenceClassCounts>;
  operationalCounts: AoiFieldEvidenceOperationalCounts;
  requiredEvidenceFailures: string[];
  hardFailures: string[];
  claimEligible: boolean;
  passed: boolean;
  sources: AoiFieldEvidenceSourceManifest[];
}

export interface AoiFieldEvidenceManifestOptions {
  sessionsDir: string;
  sessionPath: string;
  evidenceClass: AoiFieldEvidenceClass;
  now?: number;
  maxEvidenceAgeMs?: number;
}

interface SourceSpec {
  id: string;
  kind: AoiFieldEvidenceSourceKind;
  filePath: string;
  requiredFor?: readonly AoiFieldEvidenceClass[];
  recordKeys?: readonly string[];
}

interface ScanAccumulator {
  source: AoiFieldEvidenceSourceManifest;
  hasher: ReturnType<typeof createHash>;
  targetSessionPath: string;
  requestedClass: AoiFieldEvidenceClass;
  operationalCounts: AoiFieldEvidenceOperationalCounts;
  seenExplicitOutcomeSignals: Set<string>;
}

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_DIRECTORY_FILES = 20_000;
const MAX_PARSE_ERRORS = 64;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const TIMESTAMP_KEYS = [
  'createdAt',
  'updatedAt',
  'generatedAt',
  'observedAt',
  'recordedAt',
  'capturedAt',
  'startedAt',
  'completedAt',
  'savedAt',
] as const;
const EXECUTION_EVENT_TYPES = new Set([
  'proposal_executed',
  'command_executed',
  'file_write_executed',
  'file_patch_executed',
  'app_action_executed',
  'connector_call_executed',
  'autonomous_execute',
]);

function emptyEvidenceClassRecord<T>(factory: () => T): Record<AoiFieldEvidenceClass, T> {
  return {
    synthetic: factory(),
    controlled_real: factory(),
    live_field: factory(),
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableRelative(root: string, target: string): string {
  const value = relative(root, target).replace(/\\/g, '/');
  return value || '.';
}

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(resolve(root), resolve(target));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function addCount(target: Record<string, number>, key: string, amount = 1): void {
  const normalized = key.trim().slice(0, 100);
  if (!normalized) {
    return;
  }
  target[normalized] = (target[normalized] ?? 0) + amount;
}

function numericTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function collectRecordTimestamps(record: Record<string, unknown>): number[] {
  const values: number[] = [];
  for (const key of TIMESTAMP_KEYS) {
    const value = numericTimestamp(record[key]);
    if (value !== null) {
      values.push(value);
    }
  }
  return values;
}

function countPattern(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function countPrivateValues(value: string): number {
  return (
    countPattern(value, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) +
    countPattern(value, /\b[A-Z]:\\(?:Users|Documents and Settings)\\[^"\r\n]+/giu) +
    countPattern(
      value,
      /"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"\s*:\s*"(?!\[redacted)[^"\r\n]{8,}"/giu,
    )
  );
}

function hasSyntheticMarker(record: Record<string, unknown>, serialized: string): boolean {
  if (record.evidenceClass === 'synthetic' || record.privacyState === 'synthetic') {
    return true;
  }
  return /(?:aoi-real-field-operations|field-grounded-acceptance|jarvis-acceptance|(?:^|[-_:])(?:synthetic|fixture)(?:$|[-_:]))/iu.test(
    serialized,
  );
}

function classifyRecord(
  record: Record<string, unknown>,
  serialized: string,
  requestedClass: AoiFieldEvidenceClass,
): AoiFieldEvidenceClass {
  if (hasSyntheticMarker(record, serialized)) {
    return 'synthetic';
  }
  const explicit = record.evidenceClass;
  if (explicit === 'controlled_real' || explicit === 'live_field') {
    return explicit;
  }
  return requestedClass;
}

function recordType(record: Record<string, unknown>): string {
  for (const key of ['outcomeKind', 'category', 'type', 'kind', 'executionKind', 'status']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return `${key}:${value.trim()}`;
    }
  }
  return 'record';
}

function deepContainsExecution(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + deepContainsExecution(item), 0);
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key of ['type', 'kind', 'outcomeKind']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && EXECUTION_EVENT_TYPES.has(candidate)) {
      count += 1;
    }
  }
  for (const nested of Object.values(record)) {
    count += deepContainsExecution(nested);
  }
  return count;
}

function deepContainsRollback(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + deepContainsRollback(item), 0);
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  const record = value as Record<string, unknown>;
  let count = 0;
  if (
    record.rolledBack === true ||
    record.rollbackAttempted === true ||
    record.rollbackVerified === true ||
    record.checkpointRestored === true
  ) {
    count += 1;
  }
  for (const nested of Object.values(record)) {
    count += deepContainsRollback(nested);
  }
  return count;
}

function extractRecords(value: unknown, recordKeys: readonly string[] | undefined): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  const selected = (recordKeys ?? []).flatMap((key) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]) : [],
  );
  return selected.length > 0 ? selected : [record];
}

function pushParseError(
  source: AoiFieldEvidenceSourceManifest,
  error: AoiFieldEvidenceParseError,
): void {
  source.invalidRecordCount += 1;
  if (source.parseErrors.length < MAX_PARSE_ERRORS) {
    source.parseErrors.push(error);
  }
}

function updateOperationalCounts(
  sourceId: string,
  record: Record<string, unknown>,
  accumulator: ScanAccumulator,
): void {
  const counts = accumulator.operationalCounts;
  if (sourceId === 'field_event_ledger') {
    counts.fieldEventCount += 1;
  }
  if (sourceId === 'proactive_field_event_compaction') {
    const compacted = Number(record.compactedEventCount ?? 0);
    if (Number.isFinite(compacted) && compacted > 0) {
      counts.fieldEventCount += compacted;
    }
  }
  if (sourceId === 'outcome_signals') {
    const isSemanticExplicitSignal =
      typeof record.sourceOutcomeId === 'string' &&
      record.sourceOutcomeId.trim().length > 0 &&
      ((record.signalKind === 'explicit_label' &&
        typeof record.explicitLabel === 'string' &&
        record.explicitLabel.trim().length > 0) ||
        (record.signalKind === 'explicit_correction' &&
          typeof record.explicitCorrection === 'string' &&
          record.explicitCorrection.trim().length > 0));
    const semanticKey = isSemanticExplicitSignal
      ? getAoiOutcomeSignalSemanticKey(record as unknown as AoiOutcomeSignalRecord)
      : null;
    const duplicateExplicitSignal =
      semanticKey !== null && accumulator.seenExplicitOutcomeSignals.has(semanticKey);

    if (!duplicateExplicitSignal) {
      if (semanticKey !== null) {
        accumulator.seenExplicitOutcomeSignals.add(semanticKey);
      }
      counts.outcomeSignalCount += 1;
      if (record.outcomeKind === 'proposal_executed') {
        counts.executionOutcomeCount += 1;
      }
      if (
        record.outcomeKind === 'user_correction' ||
        (record.outcomeKind === 'user_feedback' &&
          record.signalKind === 'explicit_label' &&
          typeof record.explicitLabelRef === 'string' &&
          record.explicitLabelRef.trim().length > 0)
      ) {
        counts.feedbackRecordCount += 1;
      }
    }
  }
  if (sourceId === 'situation_current' || sourceId === 'situation_history') {
    counts.situationSampleCount += 1;
    const segments = Array.isArray(record.segments) ? record.segments : [];
    const grounded =
      segments.length > 0 &&
      segments.every(
        (segment) =>
          Boolean(segment) &&
          typeof segment === 'object' &&
          Array.isArray((segment as Record<string, unknown>).evidenceRefs) &&
          ((segment as Record<string, unknown>).evidenceRefs as unknown[]).length > 0,
      );
    if (grounded) {
      counts.groundedSituationCount += 1;
    }
  }
  if (sourceId === 'run_ledger') {
    counts.runCount += 1;
  }
  if (
    sourceId === 'command_audit' ||
    sourceId === 'file_mutation_audit' ||
    sourceId === 'app_action_audit' ||
    sourceId === 'connector_call_audit'
  ) {
    counts.executionRecordCount += Math.max(1, deepContainsExecution(record));
  } else {
    counts.executionRecordCount += deepContainsExecution(record);
  }
  counts.rollbackEvidenceCount += deepContainsRollback(record);
  if (
    sourceId === 'proactive_feedback' ||
    sourceId === 'proactive_calibration_labels' ||
    sourceId === 'field_shadow_labels'
  ) {
    counts.feedbackRecordCount += 1;
  }
  if (sourceId === 'field_shadow_records') {
    counts.shadowDecisionCount += 1;
  }
  if (sourceId === 'field_shadow_labels') {
    counts.shadowLabelCount += 1;
  }
  const mutationCount = Number(record.mutationCount ?? 0);
  if (Number.isFinite(mutationCount) && mutationCount > 0) {
    counts.unauthorizedMutationCount += mutationCount;
  }
  const unauthorized = Number(record.unauthorizedMutationCount ?? 0);
  if (Number.isFinite(unauthorized) && unauthorized > 0) {
    counts.unauthorizedMutationCount += unauthorized;
  }
  const privateLeak = Number(record.privateLeakCount ?? 0);
  if (Number.isFinite(privateLeak) && privateLeak > 0) {
    counts.privateLeakCount += privateLeak;
  }
  const privacy =
    record.privacy && typeof record.privacy === 'object' && !Array.isArray(record.privacy)
      ? (record.privacy as Record<string, unknown>)
      : null;
  if (privacy?.privateLeakDetected === true) {
    counts.privateLeakCount += 1;
  }
  const approvalBypass = Number(record.approvalBypassCount ?? 0);
  if (Number.isFinite(approvalBypass) && approvalBypass > 0) {
    counts.approvalBypassCount += approvalBypass;
  }
  const stale = Number(record.staleCurrentClaimCount ?? 0);
  if (Number.isFinite(stale) && stale > 0) {
    counts.staleCurrentClaimCount += stale;
  }
}

function processRecord(sourceId: string, value: unknown, accumulator: ScanAccumulator): void {
  accumulator.source.recordCount += 1;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    pushParseError(accumulator.source, {
      code: 'json_parse_error',
      fileFingerprint: hashText(`${sourceId}:non-object`).slice(0, 16),
    });
    return;
  }
  const record = value as Record<string, unknown>;
  const serialized = JSON.stringify(record);
  accumulator.source.validRecordCount += 1;
  addCount(accumulator.source.recordTypeCounts, recordType(record));
  const evidenceClass = classifyRecord(record, serialized, accumulator.requestedClass);
  accumulator.source.evidenceClassCounts[evidenceClass] += 1;
  if (evidenceClass === 'synthetic') {
    accumulator.source.syntheticMarkerCount += 1;
  }
  const recordSession = record.sessionPath;
  if (
    typeof recordSession === 'string' &&
    normalizeAoiAutonomySessionPath(recordSession) !== accumulator.targetSessionPath
  ) {
    accumulator.source.sessionMismatchCount += 1;
  }
  const timestamps = collectRecordTimestamps(record);
  for (const timestamp of timestamps) {
    accumulator.source.firstObservedAt =
      accumulator.source.firstObservedAt === null
        ? timestamp
        : Math.min(accumulator.source.firstObservedAt, timestamp);
    accumulator.source.lastObservedAt =
      accumulator.source.lastObservedAt === null
        ? timestamp
        : Math.max(accumulator.source.lastObservedAt, timestamp);
  }
  updateOperationalCounts(sourceId, record, accumulator);
}

function makeSourceManifest(
  spec: SourceSpec,
  sessionRoot: string,
  evidenceClass: AoiFieldEvidenceClass,
): AoiFieldEvidenceSourceManifest {
  return {
    version: 1,
    id: spec.id,
    kind: spec.kind,
    relativePath: stableRelative(sessionRoot, spec.filePath),
    required: spec.requiredFor?.includes(evidenceClass) ?? false,
    exists: false,
    fileCount: 0,
    byteSize: 0,
    recordCount: 0,
    validRecordCount: 0,
    invalidRecordCount: 0,
    sessionMismatchCount: 0,
    privateValueCount: 0,
    syntheticMarkerCount: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    recordTypeCounts: {},
    evidenceClassCounts: emptyEvidenceClassRecord(() => 0),
    contentFingerprint: hashText('missing'),
    parseErrors: [],
  };
}

function readFileForScan(filePath: string, source: AoiFieldEvidenceSourceManifest): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    pushParseError(source, {
      code: 'read_error',
      fileFingerprint: hashText(stableRelative(resolve(filePath, '..'), filePath)).slice(0, 16),
    });
    return null;
  }
  if (stat.isSymbolicLink()) {
    pushParseError(source, {
      code: 'symlink_skipped',
      fileFingerprint: hashText(filePath).slice(0, 16),
    });
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  source.fileCount += 1;
  source.byteSize += stat.size;
  if (stat.size > MAX_FILE_BYTES) {
    pushParseError(source, {
      code: 'file_too_large',
      fileFingerprint: hashText(filePath).slice(0, 16),
    });
    return null;
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    pushParseError(source, {
      code: 'read_error',
      fileFingerprint: hashText(filePath).slice(0, 16),
    });
    return null;
  }
}

function scanJsonText(
  spec: SourceSpec,
  filePath: string,
  text: string,
  accumulator: ScanAccumulator,
): void {
  accumulator.hasher.update(stableRelative(resolve(spec.filePath, '..'), filePath));
  accumulator.hasher.update(text);
  accumulator.source.privateValueCount += countPrivateValues(text);
  try {
    const parsed = JSON.parse(text) as unknown;
    const records = extractRecords(parsed, spec.recordKeys);
    if (records.length === 0) {
      const isEmptyArray = Array.isArray(parsed);
      const isEmptyRecordContainer =
        Boolean(parsed) &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Boolean(
          spec.recordKeys?.some((key) => Array.isArray((parsed as Record<string, unknown>)[key])),
        );
      if (isEmptyArray || isEmptyRecordContainer) {
        return;
      }
      accumulator.source.recordCount += 1;
      pushParseError(accumulator.source, {
        code: 'json_parse_error',
        fileFingerprint: hashText(text).slice(0, 16),
      });
      return;
    }
    for (const record of records) {
      processRecord(spec.id, record, accumulator);
    }
  } catch {
    accumulator.source.recordCount += 1;
    pushParseError(accumulator.source, {
      code: 'json_parse_error',
      fileFingerprint: hashText(text).slice(0, 16),
    });
  }
}

function scanJsonLinesText(
  spec: SourceSpec,
  filePath: string,
  text: string,
  accumulator: ScanAccumulator,
): void {
  accumulator.hasher.update(stableRelative(resolve(spec.filePath, '..'), filePath));
  accumulator.hasher.update(text);
  accumulator.source.privateValueCount += countPrivateValues(text);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      processRecord(spec.id, JSON.parse(line) as unknown, accumulator);
    } catch {
      accumulator.source.recordCount += 1;
      pushParseError(accumulator.source, {
        code: 'jsonl_parse_error',
        line: index + 1,
        fileFingerprint: hashText(line).slice(0, 16),
      });
    }
  }
}

function listJsonFiles(root: string, source: AoiFieldEvidenceSourceManifest): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_DIRECTORY_FILES) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_DIRECTORY_FILES) {
        break;
      }
      const filePath = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        pushParseError(source, {
          code: 'symlink_skipped',
          fileFingerprint: hashText(filePath).slice(0, 16),
        });
      } else if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        files.push(filePath);
      }
    }
  };
  walk(root);
  if (files.length >= MAX_DIRECTORY_FILES) {
    pushParseError(source, {
      code: 'file_limit_exceeded',
      fileFingerprint: hashText(root).slice(0, 16),
    });
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function scanSource(
  spec: SourceSpec,
  sessionRoot: string,
  sessionPath: string,
  evidenceClass: AoiFieldEvidenceClass,
  operationalCounts: AoiFieldEvidenceOperationalCounts,
): AoiFieldEvidenceSourceManifest {
  const source = makeSourceManifest(spec, sessionRoot, evidenceClass);
  if (!fs.existsSync(spec.filePath)) {
    return source;
  }
  source.exists = true;
  const accumulator: ScanAccumulator = {
    source,
    hasher: createHash('sha256'),
    targetSessionPath: sessionPath,
    requestedClass: evidenceClass,
    operationalCounts,
    seenExplicitOutcomeSignals: new Set<string>(),
  };
  if (spec.kind === 'json_directory') {
    for (const filePath of listJsonFiles(spec.filePath, source)) {
      const text = readFileForScan(filePath, source);
      if (text !== null) {
        scanJsonText(spec, filePath, text, accumulator);
      }
    }
  } else {
    const text = readFileForScan(spec.filePath, source);
    if (text !== null) {
      if (spec.kind === 'jsonl') {
        scanJsonLinesText(spec, spec.filePath, text, accumulator);
      } else {
        scanJsonText(spec, spec.filePath, text, accumulator);
      }
    }
  }
  source.contentFingerprint = accumulator.hasher.digest('hex');
  return source;
}

function fingerprintDirectory(root: string): string {
  if (!fs.existsSync(root)) {
    return hashText('missing-session-root');
  }
  const hasher = createHash('sha256');
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = join(dir, entry.name);
      const relativePath = stableRelative(root, target);
      if (entry.isSymbolicLink()) {
        hasher.update(`symlink:${relativePath}`);
      } else if (entry.isDirectory()) {
        hasher.update(`dir:${relativePath}`);
        walk(target);
      } else if (entry.isFile()) {
        const stat = fs.statSync(target);
        hasher.update(`file:${relativePath}:${stat.size}:${Math.round(stat.mtimeMs)}`);
      }
    }
  };
  walk(root);
  return hasher.digest('hex');
}

function buildSourceSpecs(
  sessionsDir: string,
  sessionPath: string,
): { sessionRoot: string; sources: SourceSpec[] } {
  const sessionsRoot = resolve(sessionsDir);
  const sessionRoot = resolve(sessionsRoot, sessionPath);
  if (!isPathInsideRoot(sessionsRoot, sessionRoot)) {
    throw new Error('Resolved field-evidence session path escaped the sessions directory.');
  }
  if (fs.existsSync(sessionsRoot) && fs.existsSync(sessionRoot)) {
    const realSessionsRoot = fs.realpathSync(sessionsRoot);
    const realSessionRoot = fs.realpathSync(sessionRoot);
    if (!isPathInsideRoot(realSessionsRoot, realSessionRoot)) {
      throw new Error('Resolved field-evidence session path escaped through a symbolic link.');
    }
  }
  const autonomy = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const fieldLedger = resolveAoiFieldEventLedgerPaths(sessionsDir, sessionPath);
  const situation = resolveAoiCurrentSituationPaths(sessionsDir, sessionPath);
  const activity = resolveAoiActivityStreamPaths(sessionsDir, sessionPath);
  const goals = resolveAoiGoalPaths(sessionsDir, sessionPath);
  const flight = resolveAoiOperatorFlightRecorderPaths(sessionsDir, sessionPath);
  const realClasses: AoiFieldEvidenceClass[] = ['controlled_real', 'live_field'];
  return {
    sessionRoot,
    sources: [
      { id: 'policy', kind: 'json', filePath: autonomy.policy },
      { id: 'environment_sources', kind: 'json', filePath: autonomy.environmentSources },
      { id: 'observations', kind: 'json_directory', filePath: autonomy.observationsDir },
      { id: 'reflections', kind: 'json_directory', filePath: autonomy.reflectionsDir },
      { id: 'proposals_active', kind: 'json', filePath: autonomy.activeProposals },
      { id: 'proposals_archived', kind: 'json', filePath: autonomy.archivedProposals },
      { id: 'decisions', kind: 'json_directory', filePath: autonomy.decisionsDir },
      { id: 'command_audit', kind: 'json_directory', filePath: autonomy.commandAuditDir },
      {
        id: 'file_mutation_audit',
        kind: 'json_directory',
        filePath: autonomy.fileMutationAuditDir,
      },
      { id: 'app_action_audit', kind: 'json_directory', filePath: autonomy.appActionAuditDir },
      {
        id: 'connector_call_audit',
        kind: 'json_directory',
        filePath: autonomy.connectorCallAuditDir,
      },
      { id: 'timeline', kind: 'jsonl', filePath: autonomy.timelineEvents },
      {
        id: 'field_shadow_records',
        kind: 'json',
        filePath: autonomy.fieldShadowRecords,
        recordKeys: ['records'],
      },
      {
        id: 'field_shadow_labels',
        kind: 'json',
        filePath: autonomy.fieldShadowFeedbackLabels,
        recordKeys: ['labels'],
      },
      {
        id: 'proactive_feedback',
        kind: 'json_directory',
        filePath: autonomy.proactiveBriefFeedbackDir,
      },
      {
        id: 'proactive_field_events',
        kind: 'json_directory',
        filePath: autonomy.proactiveBriefFieldEventRecordsDir,
      },
      {
        id: 'proactive_field_event_compaction',
        kind: 'json',
        filePath: join(autonomy.proactiveBriefFieldEventsDir, 'compaction.json'),
      },
      {
        id: 'proactive_calibration_labels',
        kind: 'json_directory',
        filePath: autonomy.proactiveBriefCalibrationLabelRecordsDir,
      },
      { id: 'follow_through', kind: 'jsonl', filePath: autonomy.followThroughEvents },
      {
        id: 'outcome_signals',
        kind: 'jsonl',
        filePath: autonomy.outcomeSignals,
        requiredFor: realClasses,
      },
      {
        id: 'field_event_ledger',
        kind: 'jsonl',
        filePath: fieldLedger.events,
        requiredFor: ['live_field'],
      },
      { id: 'situation_current', kind: 'json', filePath: situation.current },
      {
        id: 'situation_history',
        kind: 'jsonl',
        filePath: situation.history,
        requiredFor: realClasses,
      },
      {
        id: 'run_ledger',
        kind: 'json',
        filePath: join(sessionRoot, 'aoi-run-ledger', 'runs.json'),
        requiredFor: realClasses,
        recordKeys: ['runs'],
      },
      { id: 'activity_stream', kind: 'jsonl', filePath: activity.events },
      { id: 'goals_active', kind: 'json', filePath: goals.activeGoals },
      { id: 'goals_archived', kind: 'json', filePath: goals.archivedGoals },
      { id: 'goal_progress', kind: 'json', filePath: goals.progressEvents },
      {
        id: 'operator_flight_recorder',
        kind: 'jsonl',
        filePath: flight.records,
      },
    ],
  };
}

function emptyOperationalCounts(): AoiFieldEvidenceOperationalCounts {
  return {
    fieldEventCount: 0,
    situationSampleCount: 0,
    groundedSituationCount: 0,
    runCount: 0,
    executionRecordCount: 0,
    executionOutcomeCount: 0,
    outcomeSignalCount: 0,
    feedbackRecordCount: 0,
    shadowDecisionCount: 0,
    shadowLabelCount: 0,
    rollbackEvidenceCount: 0,
    privateLeakCount: 0,
    unauthorizedMutationCount: 0,
    approvalBypassCount: 0,
    staleCurrentClaimCount: 0,
  };
}

function buildRequiredEvidenceFailures(
  evidenceClass: AoiFieldEvidenceClass,
  sources: readonly AoiFieldEvidenceSourceManifest[],
  counts: AoiFieldEvidenceOperationalCounts,
): string[] {
  if (evidenceClass === 'synthetic') {
    return ['synthetic_evidence_not_field_claim_eligible'];
  }
  const failures: string[] = [];
  for (const source of sources.filter((item) => item.required)) {
    if (!source.exists || source.validRecordCount === 0) {
      failures.push(`required_source_empty:${source.id}`);
    }
  }
  if (counts.situationSampleCount === 0) {
    failures.push('real_situation_sample_missing');
  }
  if (counts.groundedSituationCount === 0) {
    failures.push('grounded_situation_sample_missing');
  }
  if (counts.runCount === 0) {
    failures.push('real_run_ledger_entry_missing');
  }
  if (counts.outcomeSignalCount === 0) {
    failures.push('real_outcome_signal_missing');
  }
  if (counts.executionOutcomeCount === 0) {
    failures.push('real_execution_outcome_missing');
  }
  if (counts.feedbackRecordCount === 0) {
    failures.push('real_feedback_signal_missing');
  }
  if (evidenceClass === 'live_field' && counts.fieldEventCount === 0) {
    failures.push('live_field_event_missing');
  }
  return [...new Set(failures)];
}

function manifestContentFingerprint(params: {
  sessionPath: string;
  evidenceClass: AoiFieldEvidenceClass;
  sources: readonly AoiFieldEvidenceSourceManifest[];
}): string {
  const payload = {
    version: 1,
    sessionPath: params.sessionPath,
    evidenceClass: params.evidenceClass,
    sources: params.sources.map((source) => ({
      id: source.id,
      exists: source.exists,
      fileCount: source.fileCount,
      byteSize: source.byteSize,
      recordCount: source.recordCount,
      validRecordCount: source.validRecordCount,
      invalidRecordCount: source.invalidRecordCount,
      sessionMismatchCount: source.sessionMismatchCount,
      syntheticMarkerCount: source.syntheticMarkerCount,
      evidenceClassCounts: source.evidenceClassCounts,
      contentFingerprint: source.contentFingerprint,
    })),
  };
  return hashText(JSON.stringify(payload));
}

export function buildAoiFieldEvidenceManifest(
  options: AoiFieldEvidenceManifestOptions,
): AoiFieldEvidenceManifest {
  const sessionsDir = String(options.sessionsDir ?? '').trim();
  if (!sessionsDir) {
    throw new Error('Field evidence requires an explicit sessionsDir.');
  }
  const sessionPath = normalizeAoiAutonomySessionPath(options.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (
    options.evidenceClass !== 'synthetic' &&
    options.evidenceClass !== 'controlled_real' &&
    options.evidenceClass !== 'live_field'
  ) {
    throw new Error('Invalid or missing evidenceClass.');
  }
  const now = options.now ?? Date.now();
  const maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('Field evidence requires a valid now timestamp.');
  }
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0) {
    throw new Error('Field evidence requires a positive maxEvidenceAgeMs.');
  }
  const { sessionRoot, sources: specs } = buildSourceSpecs(sessionsDir, sessionPath);
  const sessionExists = fs.existsSync(sessionRoot) && fs.statSync(sessionRoot).isDirectory();
  const before = fingerprintDirectory(sessionRoot);
  const operationalCounts = emptyOperationalCounts();
  const sources = specs.map((spec) =>
    scanSource(spec, sessionRoot, sessionPath, options.evidenceClass, operationalCounts),
  );
  const after = fingerprintDirectory(sessionRoot);
  operationalCounts.privateLeakCount += sources.reduce(
    (total, source) => total + source.privateValueCount,
    0,
  );
  const evidenceClassCounts = emptyEvidenceClassRecord<AoiFieldEvidenceClassCounts>(() => ({
    sourceCount: 0,
    recordCount: 0,
    byteSize: 0,
  }));
  for (const source of sources) {
    for (const evidenceClass of ['synthetic', 'controlled_real', 'live_field'] as const) {
      const count = source.evidenceClassCounts[evidenceClass];
      if (count > 0) {
        evidenceClassCounts[evidenceClass].sourceCount += 1;
        evidenceClassCounts[evidenceClass].recordCount += count;
        evidenceClassCounts[evidenceClass].byteSize += Math.round(
          source.byteSize * (count / Math.max(1, source.validRecordCount)),
        );
      }
    }
  }
  const recordCount = sources.reduce((total, source) => total + source.recordCount, 0);
  const validRecordCount = sources.reduce((total, source) => total + source.validRecordCount, 0);
  const invalidRecordCount = sources.reduce(
    (total, source) => total + source.invalidRecordCount,
    0,
  );
  const byteSize = sources.reduce((total, source) => total + source.byteSize, 0);
  const parseErrorCount = invalidRecordCount;
  const sessionMismatchCount = sources.reduce(
    (total, source) => total + source.sessionMismatchCount,
    0,
  );
  const privateValueCount = sources.reduce((total, source) => total + source.privateValueCount, 0);
  const syntheticMarkerCount = sources.reduce(
    (total, source) => total + source.syntheticMarkerCount,
    0,
  );
  const timestamps = sources.flatMap((source) =>
    [source.firstObservedAt, source.lastObservedAt].filter(
      (value): value is number => value !== null,
    ),
  );
  const firstObservedAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const lastObservedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;
  const representedClasses = (['synthetic', 'controlled_real', 'live_field'] as const).filter(
    (evidenceClass) => evidenceClassCounts[evidenceClass].recordCount > 0,
  );
  const mixedEvidenceClass =
    representedClasses.some((evidenceClass) => evidenceClass !== options.evidenceClass) ||
    representedClasses.length > 1;
  const requiredEvidenceFailures = buildRequiredEvidenceFailures(
    options.evidenceClass,
    sources,
    operationalCounts,
  );
  const hardFailures = [...requiredEvidenceFailures];
  if (!sessionExists) {
    hardFailures.push('session_root_missing');
  }
  if (parseErrorCount > 0) {
    hardFailures.push('evidence_parse_error');
  }
  if (sessionMismatchCount > 0) {
    hardFailures.push('cross_session_record_detected');
  }
  if (mixedEvidenceClass) {
    hardFailures.push('mixed_evidence_class');
  }
  if (privateValueCount > 0) {
    hardFailures.push('private_value_detected');
  }
  if (operationalCounts.privateLeakCount > 0) {
    hardFailures.push('private_leak_detected');
  }
  if (operationalCounts.unauthorizedMutationCount > 0) {
    hardFailures.push('unauthorized_mutation_detected');
  }
  if (operationalCounts.staleCurrentClaimCount > 0) {
    hardFailures.push('stale_current_claim_detected');
  }
  if (before !== after) {
    hardFailures.push('session_changed_during_read_only_scan');
  }
  if (
    options.evidenceClass !== 'synthetic' &&
    lastObservedAt !== null &&
    now - lastObservedAt > maxEvidenceAgeMs
  ) {
    hardFailures.push('evidence_window_stale');
  }
  if (
    options.evidenceClass !== 'synthetic' &&
    lastObservedAt !== null &&
    lastObservedAt - now > MAX_FUTURE_TIMESTAMP_SKEW_MS
  ) {
    hardFailures.push('evidence_timestamp_in_future');
  }
  const uniqueHardFailures = [...new Set(hardFailures)];
  const manifestFingerprint = manifestContentFingerprint({
    sessionPath,
    evidenceClass: options.evidenceClass,
    sources,
  });
  const claimEligible = options.evidenceClass !== 'synthetic' && uniqueHardFailures.length === 0;
  return {
    version: 1,
    id: `aoi-field-evidence-${manifestFingerprint.slice(0, 24)}`,
    sessionPath,
    evidenceClass: options.evidenceClass,
    generatedAt: now,
    sessionExists,
    sessionRootFingerprintBefore: before,
    sessionRootFingerprintAfter: after,
    readOnlyVerified: before === after,
    manifestFingerprint,
    sourceCount: sources.length,
    existingSourceCount: sources.filter((source) => source.exists).length,
    recordCount,
    validRecordCount,
    invalidRecordCount,
    byteSize,
    firstObservedAt,
    lastObservedAt,
    parseErrorCount,
    sessionMismatchCount,
    privateValueCount,
    syntheticMarkerCount,
    mixedEvidenceClass,
    evidenceClassCounts,
    operationalCounts,
    requiredEvidenceFailures,
    hardFailures: uniqueHardFailures,
    claimEligible,
    passed: claimEligible,
    sources,
  };
}

export function formatAoiFieldEvidenceManifest(manifest: AoiFieldEvidenceManifest): string {
  const classCounts = manifest.evidenceClassCounts;
  const invalidSources = manifest.sources
    .filter((source) => source.invalidRecordCount > 0)
    .map((source) => `${source.id}:${source.invalidRecordCount}`);
  return [
    `Aoi field evidence: ${manifest.passed ? 'ready' : 'not-ready'}`,
    `session ${manifest.sessionPath}`,
    `class ${manifest.evidenceClass}`,
    `fingerprint ${manifest.manifestFingerprint}`,
    `read_only ${manifest.readOnlyVerified ? 'verified' : 'changed-during-scan'}`,
    `sources ${manifest.existingSourceCount}/${manifest.sourceCount} records=${manifest.validRecordCount}/${manifest.recordCount} bytes=${manifest.byteSize}`,
    `classes synthetic=${classCounts.synthetic.recordCount} controlled_real=${classCounts.controlled_real.recordCount} live_field=${classCounts.live_field.recordCount}`,
    `operational field=${manifest.operationalCounts.fieldEventCount} situation=${manifest.operationalCounts.situationSampleCount} grounded=${manifest.operationalCounts.groundedSituationCount} runs=${manifest.operationalCounts.runCount} outcomes=${manifest.operationalCounts.outcomeSignalCount} executions=${manifest.operationalCounts.executionOutcomeCount} feedback=${manifest.operationalCounts.feedbackRecordCount} rollback=${manifest.operationalCounts.rollbackEvidenceCount}`,
    `integrity parse=${manifest.parseErrorCount} session_mismatch=${manifest.sessionMismatchCount} private=${manifest.privateValueCount} synthetic_markers=${manifest.syntheticMarkerCount}`,
    `invalid_sources ${invalidSources.length > 0 ? invalidSources.join(',') : 'none'}`,
    `hard_failures ${manifest.hardFailures.length > 0 ? manifest.hardFailures.join(',') : 'none'}`,
  ].join('\n');
}
