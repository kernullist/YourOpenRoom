import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type { AoiAutonomyRisk } from './aoiAutonomyTypes';
import type {
  AoiShadowConsentState,
  AoiShadowDecision,
  AoiShadowDecisionKind,
  AoiShadowPolicyResult,
} from './aoiShadowModeEvaluation';

const MAX_TEXT = 220;
const MAX_REFS = 24;
const DEFAULT_FIELD_SHADOW_NOW = 1_800_000_000_000;

export const AOI_FIELD_SHADOW_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type AoiFieldShadowSubsystemOrigin =
  | 'digest'
  | 'health'
  | 'source_consent'
  | 'personal_source_reality'
  | 'playbook'
  | 'approved_command_policy'
  | 'mission_memory'
  | 'voice_policy'
  | 'unknown';

export type AoiFieldShadowPrivacyState = 'redacted' | 'metadata_only' | 'synthetic' | 'unknown';

export interface AoiFieldShadowSession {
  version: 1;
  id: string;
  sessionPath: string;
  startedAt: number;
  updatedAt: number;
  decisionCount: number;
  activeDecisionCount: number;
  expiredDecisionCount: number;
  evidenceRefs: string[];
  mutationCount: 0;
  expiresAt: number;
}

export interface AoiFieldShadowDecisionRecord {
  version: 1;
  id: string;
  sessionId: string;
  sessionPath: string;
  decisionId: string;
  decisionKind: AoiShadowDecisionKind;
  subsystemOrigin: AoiFieldShadowSubsystemOrigin;
  createdAt: number;
  recordedAt: number;
  expiresAt: number;
  retentionMs: number;
  sourceRefs: string[];
  evidenceRefs: string[];
  consentState: AoiShadowConsentState;
  privacyState: AoiFieldShadowPrivacyState;
  policyResult: AoiShadowPolicyResult;
  risk: AoiAutonomyRisk;
  sourceSummary: string;
  mutationCount: 0;
  dedupeKey: string;
  missionId?: string;
  operatorMessagePreview?: string;
  silenceReason?: string;
  suggestedAction?: string;
  approvalBoundary?: string;
}

export interface AoiFieldShadowRecorderInput {
  sessionPath: string;
  decisions: AoiShadowDecision[];
  sessionId?: string;
  missionId?: string;
  now?: number;
  retentionMs?: number;
  subsystemOriginByDecisionId?: Record<string, AoiFieldShadowSubsystemOrigin>;
  evidenceRefs?: string[];
}

export interface AoiFieldShadowRecordReport {
  version: 1;
  id: string;
  sessionPath: string;
  generatedAt: number;
  session: AoiFieldShadowSession;
  records: AoiFieldShadowDecisionRecord[];
  activeRecords: AoiFieldShadowDecisionRecord[];
  expiredRecords: AoiFieldShadowDecisionRecord[];
  totalRecordCount: number;
  activeRecordCount: number;
  expiredRecordCount: number;
  dedupedRecordCount: number;
  mutationCount: 0;
  zeroMutation: true;
  privacyCounts: Record<AoiFieldShadowPrivacyState, number>;
  decisionKindCounts: Record<AoiShadowDecisionKind, number>;
  subsystemOriginCounts: Record<AoiFieldShadowSubsystemOrigin, number>;
  sourceKindCounts: Record<string, number>;
  evidenceRefs: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

export function normalizeAoiFieldShadowSessionPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) {
    return null;
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function sanitizeFieldShadowText(value: unknown, maxChars = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(?:do not leak|private|raw|full|secret)[^.!?\n]{0,120}\b(?:mail|email|calendar|event|note|message)?\s*body[^.!?\n]*(?:[.!?]|$)/gi,
        '[redacted-private-body]',
      )
      .replace(
        /\b(body|content|snippet|transcript|messageBody|rawText)\s*[:=]\s*[^.;\n]{6,}/gi,
        '$1=[redacted-private-body]',
      )
      .replace(/\b[A-Z]:\\[^\s'"`<>|]+/gi, '[path]')
      .replace(/\\\\[^\s'"`<>|]+/g, '[path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[url]')
      .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[secret]'),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeRefs(refs: unknown, maxItems = MAX_REFS): string[] {
  if (!Array.isArray(refs)) {
    return [];
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    const normalized = sanitizeFieldShadowText(ref, 160);
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

function sanitizeStablePart(value: unknown, fallback: string): string {
  const sanitized = sanitizeFieldShadowText(value, 96)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return sanitized || fallback;
}

function normalizeRetentionMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return AOI_FIELD_SHADOW_DEFAULT_RETENTION_MS;
  }
  return Math.min(Math.max(Math.round(value), 1), 180 * 24 * 60 * 60 * 1000);
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

function isDecisionKind(value: unknown): value is AoiShadowDecisionKind {
  return (
    value === 'would_speak' ||
    value === 'would_stay_quiet' ||
    value === 'would_propose' ||
    value === 'would_prepare_approval' ||
    value === 'would_mark_blind_spot'
  );
}

function isConsentState(value: unknown): value is AoiShadowConsentState {
  return (
    value === 'allowed' ||
    value === 'disabled' ||
    value === 'revoked' ||
    value === 'disconnected' ||
    value === 'unknown'
  );
}

function isPolicyResult(value: unknown): value is AoiShadowPolicyResult {
  return (
    value === 'record_only' ||
    value === 'allowed' ||
    value === 'approval_required' ||
    value === 'blocked' ||
    value === 'not_applicable'
  );
}

function isRisk(value: unknown): value is AoiAutonomyRisk {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isSubsystemOrigin(value: unknown): value is AoiFieldShadowSubsystemOrigin {
  return (
    value === 'digest' ||
    value === 'health' ||
    value === 'source_consent' ||
    value === 'personal_source_reality' ||
    value === 'playbook' ||
    value === 'approved_command_policy' ||
    value === 'mission_memory' ||
    value === 'voice_policy' ||
    value === 'unknown'
  );
}

function isPrivacyState(value: unknown): value is AoiFieldShadowPrivacyState {
  return (
    value === 'redacted' ||
    value === 'metadata_only' ||
    value === 'synthetic' ||
    value === 'unknown'
  );
}

function inferSubsystemOrigin(
  decision: AoiShadowDecision,
  override: AoiFieldShadowSubsystemOrigin | undefined,
): AoiFieldShadowSubsystemOrigin {
  if (override) {
    return override;
  }
  const haystack = [decision.dedupeKey, ...decision.sourceRefs, ...decision.evidenceRefs].join(' ');
  if (/\bpersonal-(?:source-reality|reality|signal)/i.test(haystack)) {
    return 'personal_source_reality';
  }
  if (/\bsource-consent:|environment-source:/i.test(decision.dedupeKey)) {
    return 'source_consent';
  }
  if (/\bhealth:/i.test(decision.dedupeKey)) {
    return 'health';
  }
  if (/\bplaybook:/i.test(haystack)) {
    return 'playbook';
  }
  if (/\bapproved-command:/i.test(haystack)) {
    return 'approved_command_policy';
  }
  if (/\bmission-memory:/i.test(haystack)) {
    return 'mission_memory';
  }
  if (/\bvoice(?:-|_)?policy:|\boperator-voice:/i.test(haystack)) {
    return 'voice_policy';
  }
  if (/\bdigest:|\bapproval-inbox:/i.test(decision.dedupeKey)) {
    return 'digest';
  }
  if (/\bsource-consent:/i.test(haystack)) {
    return 'source_consent';
  }
  if (/\bhealth:/i.test(haystack)) {
    return 'health';
  }
  return 'unknown';
}

function inferPrivacyState(params: {
  sourceRefs: string[];
  evidenceRefs: string[];
  textFields: string[];
}): AoiFieldShadowPrivacyState {
  const refs = [...params.sourceRefs, ...params.evidenceRefs].join(' ');
  const text = params.textFields.join(' ');
  if (/\[(?:redacted|email|path|url|secret)|redacted_secret|redacted-private-body/i.test(text)) {
    return 'redacted';
  }
  if (/\bsynthetic|\[personal-metadata:/i.test(`${refs} ${text}`)) {
    return 'synthetic';
  }
  if (/\b(?:gmail|calendar|notes|personal-signal|personal-source|browser-context)\b/i.test(refs)) {
    return 'metadata_only';
  }
  return 'unknown';
}

function sourceKindForRef(ref: string): string {
  if (/\bpersonal-source-reality\b/i.test(ref)) {
    return 'personal_source_reality';
  }
  if (/\bpersonal-signal:calendar|\bcalendar/i.test(ref)) {
    return 'calendar_metadata';
  }
  if (/\bpersonal-signal:gmail|\bgmail/i.test(ref)) {
    return 'gmail_metadata';
  }
  if (/\bpersonal-signal:notes|\bnotes/i.test(ref)) {
    return 'notes_metadata';
  }
  if (/\bbrowser-context|\bbrowser/i.test(ref)) {
    return 'browser_context';
  }
  if (/\bworkspace/i.test(ref)) {
    return 'workspace';
  }
  if (/\bhealth:/i.test(ref)) {
    return 'health';
  }
  if (/\benvironment-source:/i.test(ref)) {
    return 'environment_source';
  }
  if (/\bplaybook:/i.test(ref)) {
    return 'playbook';
  }
  if (/\bapproved-command:/i.test(ref)) {
    return 'approved_command_policy';
  }
  if (/\bproposal:/i.test(ref)) {
    return 'proposal';
  }
  if (/\bdigest:|\bapproval-inbox:/i.test(ref)) {
    return 'digest';
  }
  if (/\bmemory:/i.test(ref)) {
    return 'memory';
  }
  return 'unknown';
}

function incrementCount<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function makeSessionId(
  sessionPath: string,
  inputSessionId: string | undefined,
  existingSessionId?: string,
): string {
  if (inputSessionId) {
    const stablePart = sanitizeStablePart(inputSessionId, hashText(sessionPath));
    return stablePart.startsWith('aoi-field-shadow-session-')
      ? stablePart
      : `aoi-field-shadow-session-${stablePart}`;
  }
  if (existingSessionId) {
    const stablePart = sanitizeStablePart(existingSessionId, hashText(sessionPath));
    return stablePart.startsWith('aoi-field-shadow-session-')
      ? stablePart
      : `aoi-field-shadow-session-${stablePart}`;
  }
  return `aoi-field-shadow-session-${hashText(sessionPath)}`;
}

function makeRecordId(sessionId: string, dedupeKey: string): string {
  return `aoi-field-shadow-${hashText(`${sessionId}:${dedupeKey}`)}`;
}

function makeRecord(params: {
  decision: AoiShadowDecision;
  sessionPath: string;
  sessionId: string;
  missionId?: string;
  now: number;
  retentionMs: number;
  subsystemOrigin?: AoiFieldShadowSubsystemOrigin;
  evidenceRefs: string[];
}): AoiFieldShadowDecisionRecord {
  const decision = params.decision;
  const createdAt = normalizeTimestamp(decision.createdAt, params.now);
  const recordedAt = params.now;
  const sourceRefs = normalizeRefs(decision.sourceRefs, MAX_REFS);
  const evidenceRefs = normalizeRefs([...decision.evidenceRefs, ...params.evidenceRefs], MAX_REFS);
  const sourceSummary = sanitizeFieldShadowText(decision.sourceSummary);
  const operatorMessagePreview = sanitizeFieldShadowText(decision.operatorMessagePreview);
  const silenceReason = sanitizeFieldShadowText(decision.silenceReason);
  const suggestedAction = sanitizeFieldShadowText(decision.suggestedAction);
  const approvalBoundary = sanitizeFieldShadowText(decision.approvalBoundary);
  const missionId = sanitizeFieldShadowText(decision.missionId ?? params.missionId, 120);
  const dedupeKey = sanitizeFieldShadowText(decision.dedupeKey || decision.id, 180);
  const textFields = [
    sourceSummary,
    operatorMessagePreview,
    silenceReason,
    suggestedAction,
    approvalBoundary,
  ].filter((value) => value.length > 0);

  return {
    version: 1,
    id: makeRecordId(params.sessionId, dedupeKey),
    sessionId: params.sessionId,
    sessionPath: params.sessionPath,
    decisionId: sanitizeFieldShadowText(decision.id, 127),
    decisionKind: decision.kind,
    subsystemOrigin: inferSubsystemOrigin(decision, params.subsystemOrigin),
    createdAt,
    recordedAt,
    expiresAt: recordedAt + params.retentionMs,
    retentionMs: params.retentionMs,
    sourceRefs,
    evidenceRefs,
    consentState: decision.consentState,
    privacyState: inferPrivacyState({ sourceRefs, evidenceRefs, textFields }),
    policyResult: decision.policyResult,
    risk: decision.risk,
    sourceSummary,
    ...(missionId ? { missionId } : {}),
    ...(operatorMessagePreview ? { operatorMessagePreview } : {}),
    ...(silenceReason ? { silenceReason } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(approvalBoundary ? { approvalBoundary } : {}),
    mutationCount: 0,
    dedupeKey,
  };
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

function sortRecords(records: AoiFieldShadowDecisionRecord[]): AoiFieldShadowDecisionRecord[] {
  return [...records].sort(
    (left, right) => left.recordedAt - right.recordedAt || left.id.localeCompare(right.id),
  );
}

export function normalizeAoiFieldShadowDecisionRecord(
  value: unknown,
  options: { sessionPath?: string; now?: number } = {},
): AoiFieldShadowDecisionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiFieldShadowDecisionRecord>;
  const sessionPath = normalizeAoiFieldShadowSessionPath(raw.sessionPath);
  if (!sessionPath || (options.sessionPath && sessionPath !== options.sessionPath)) {
    return null;
  }
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.sessionId !== 'string' ||
    typeof raw.decisionId !== 'string' ||
    !isDecisionKind(raw.decisionKind) ||
    !isSubsystemOrigin(raw.subsystemOrigin) ||
    !isConsentState(raw.consentState) ||
    !isPrivacyState(raw.privacyState) ||
    !isPolicyResult(raw.policyResult) ||
    !isRisk(raw.risk) ||
    typeof raw.sourceSummary !== 'string' ||
    typeof raw.dedupeKey !== 'string'
  ) {
    return null;
  }
  const now = options.now ?? DEFAULT_FIELD_SHADOW_NOW;
  const recordedAt = normalizeTimestamp(raw.recordedAt, now);
  const retentionMs = normalizeRetentionMs(raw.retentionMs);
  const missionId = sanitizeFieldShadowText(raw.missionId, 120);
  const operatorMessagePreview = sanitizeFieldShadowText(raw.operatorMessagePreview);
  const silenceReason = sanitizeFieldShadowText(raw.silenceReason);
  const suggestedAction = sanitizeFieldShadowText(raw.suggestedAction);
  const approvalBoundary = sanitizeFieldShadowText(raw.approvalBoundary);

  return {
    version: 1,
    id: sanitizeStablePart(raw.id, `field-shadow-${hashText(raw.dedupeKey)}`),
    sessionId: sanitizeStablePart(raw.sessionId, `field-session-${hashText(sessionPath)}`),
    sessionPath,
    decisionId: sanitizeFieldShadowText(raw.decisionId, 127),
    decisionKind: raw.decisionKind,
    subsystemOrigin: raw.subsystemOrigin,
    createdAt: normalizeTimestamp(raw.createdAt, recordedAt),
    recordedAt,
    expiresAt: normalizeTimestamp(raw.expiresAt, recordedAt + retentionMs),
    retentionMs,
    sourceRefs: normalizeRefs(raw.sourceRefs, MAX_REFS),
    evidenceRefs: normalizeRefs(raw.evidenceRefs, MAX_REFS),
    consentState: raw.consentState,
    privacyState: raw.privacyState,
    policyResult: raw.policyResult,
    risk: raw.risk,
    sourceSummary: sanitizeFieldShadowText(raw.sourceSummary),
    ...(missionId ? { missionId } : {}),
    ...(operatorMessagePreview ? { operatorMessagePreview } : {}),
    ...(silenceReason ? { silenceReason } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(approvalBoundary ? { approvalBoundary } : {}),
    mutationCount: 0,
    dedupeKey: sanitizeFieldShadowText(raw.dedupeKey, 180),
  };
}

export function pruneExpiredAoiFieldShadowRecords(
  records: AoiFieldShadowDecisionRecord[],
  now = DEFAULT_FIELD_SHADOW_NOW,
): AoiFieldShadowDecisionRecord[] {
  return records.filter((record) => record.expiresAt > now);
}

export function buildAoiFieldShadowRecordReport(
  input: AoiFieldShadowRecorderInput,
  existingRecords: AoiFieldShadowDecisionRecord[] = [],
): AoiFieldShadowRecordReport {
  const sessionPath = normalizeAoiFieldShadowSessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = normalizeTimestamp(input.now, DEFAULT_FIELD_SHADOW_NOW);
  const retentionMs = normalizeRetentionMs(input.retentionMs);
  const normalizedExistingRecords = existingRecords
    .map((record) => normalizeAoiFieldShadowDecisionRecord(record, { sessionPath, now }))
    .filter((record): record is AoiFieldShadowDecisionRecord => record !== null);
  const sessionId = makeSessionId(
    sessionPath,
    input.sessionId,
    normalizedExistingRecords[0]?.sessionId,
  );
  const globalEvidenceRefs = normalizeRefs(input.evidenceRefs, MAX_REFS);
  const recordsByDedupeKey = new Map<string, AoiFieldShadowDecisionRecord>();
  let dedupedRecordCount = 0;

  for (const normalized of normalizedExistingRecords) {
    if (recordsByDedupeKey.has(normalized.dedupeKey)) {
      dedupedRecordCount += 1;
      continue;
    }
    recordsByDedupeKey.set(normalized.dedupeKey, normalized);
  }

  for (const decision of input.decisions) {
    if (!isDecisionKind(decision.kind)) {
      continue;
    }
    const record = makeRecord({
      decision,
      sessionPath,
      sessionId,
      missionId: input.missionId,
      now,
      retentionMs,
      subsystemOrigin: input.subsystemOriginByDecisionId?.[decision.id],
      evidenceRefs: globalEvidenceRefs,
    });
    if (recordsByDedupeKey.has(record.dedupeKey)) {
      dedupedRecordCount += 1;
      continue;
    }
    recordsByDedupeKey.set(record.dedupeKey, record);
  }

  const records = sortRecords([...recordsByDedupeKey.values()]);
  const activeRecords = records.filter((record) => record.expiresAt > now);
  const expiredRecords = records.filter((record) => record.expiresAt <= now);
  const privacyCounts = normalizeCounts<AoiFieldShadowPrivacyState>([
    'redacted',
    'metadata_only',
    'synthetic',
    'unknown',
  ]);
  const decisionKindCounts = normalizeCounts<AoiShadowDecisionKind>([
    'would_speak',
    'would_stay_quiet',
    'would_propose',
    'would_prepare_approval',
    'would_mark_blind_spot',
  ]);
  const subsystemOriginCounts = normalizeCounts<AoiFieldShadowSubsystemOrigin>([
    'digest',
    'health',
    'source_consent',
    'personal_source_reality',
    'playbook',
    'approved_command_policy',
    'mission_memory',
    'voice_policy',
    'unknown',
  ]);
  const sourceKindCounts: Record<string, number> = {};
  const evidenceRefs = new Set<string>(globalEvidenceRefs);

  for (const record of activeRecords) {
    incrementCount(privacyCounts, record.privacyState);
    incrementCount(decisionKindCounts, record.decisionKind);
    incrementCount(subsystemOriginCounts, record.subsystemOrigin);
    for (const sourceKind of new Set(record.sourceRefs.map(sourceKindForRef))) {
      sourceKindCounts[sourceKind] = (sourceKindCounts[sourceKind] ?? 0) + 1;
    }
    for (const ref of record.evidenceRefs) {
      evidenceRefs.add(ref);
    }
  }

  const startedAt = records.reduce(
    (oldest, record) => Math.min(oldest, record.recordedAt),
    records[0]?.recordedAt ?? now,
  );
  const updatedAt = records.reduce(
    (latest, record) => Math.max(latest, record.recordedAt),
    records[0]?.recordedAt ?? now,
  );
  const expiresAt = records.reduce(
    (latest, record) => Math.max(latest, record.expiresAt),
    now + retentionMs,
  );
  const session: AoiFieldShadowSession = {
    version: 1,
    id: sessionId,
    sessionPath,
    startedAt,
    updatedAt,
    decisionCount: records.length,
    activeDecisionCount: activeRecords.length,
    expiredDecisionCount: expiredRecords.length,
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REFS),
    mutationCount: 0,
    expiresAt,
  };

  return {
    version: 1,
    id: `aoi-field-shadow-report-${hashText(`${sessionId}:${now}:${records.length}:${dedupedRecordCount}`)}`,
    sessionPath,
    generatedAt: now,
    session,
    records,
    activeRecords,
    expiredRecords,
    totalRecordCount: records.length,
    activeRecordCount: activeRecords.length,
    expiredRecordCount: expiredRecords.length,
    dedupedRecordCount,
    mutationCount: 0,
    zeroMutation: true,
    privacyCounts,
    decisionKindCounts,
    subsystemOriginCounts,
    sourceKindCounts,
    evidenceRefs: [...evidenceRefs].slice(0, MAX_REFS),
  };
}
