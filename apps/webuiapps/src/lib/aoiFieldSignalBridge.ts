import { createHash } from 'crypto';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type { AoiAutonomyRisk, AoiSignalFreshness, AoiWorkspaceSnapshot } from './aoiAutonomyTypes';

const DEFAULT_SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;
const PRIVATE_BODY_TTL_MS = 60 * 60 * 1000;
const MAX_TEXT = 320;
const MAX_REFS = 24;

export type AoiFieldSignalSourceKind =
  | 'workspace'
  | 'research'
  | 'kira'
  | 'app_state'
  | 'personal_metadata'
  | 'memory'
  | 'manual';

export type AoiFieldSignalConsentState =
  | 'allowed'
  | 'disabled'
  | 'revoked'
  | 'disconnected'
  | 'unknown';

export type AoiFieldSignalBodyAccess = 'none' | 'metadata_only' | 'explicit_body_allowed';

export interface AoiFieldSignalPacket {
  version: 1;
  id: string;
  sessionPath: string;
  sourceKind: AoiFieldSignalSourceKind;
  summary: string;
  freshness: AoiSignalFreshness;
  consentState: AoiFieldSignalConsentState;
  bodyAccess: AoiFieldSignalBodyAccess;
  risk: AoiAutonomyRisk;
  evidenceRefs: string[];
  cannotKnow: string[];
  observedAt: number;
  expiresAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiFieldSignalPacketInput {
  id?: unknown;
  sessionPath: unknown;
  sourceKind: unknown;
  summary?: unknown;
  freshness?: unknown;
  consentState?: unknown;
  bodyAccess?: unknown;
  risk?: unknown;
  evidenceRefs?: unknown;
  cannotKnow?: unknown;
  observedAt?: unknown;
  expiresAt?: unknown;
  dedupeKey?: unknown;
}

export interface AoiResearchFieldSignalInput {
  sessionPath: unknown;
  runId?: unknown;
  title?: unknown;
  summary?: unknown;
  freshness?: unknown;
  completedAt?: unknown;
  expiresAt?: unknown;
  evidenceRefs?: unknown;
  cannotKnow?: unknown;
  risk?: unknown;
}

export interface AoiKiraOutcomeFieldSignalInput {
  sessionPath: unknown;
  outcomeId?: unknown;
  summary?: unknown;
  status?: unknown;
  validatedAt?: unknown;
  evidenceRefs?: unknown;
  cannotKnow?: unknown;
  risk?: unknown;
}

export interface AoiAppStateFieldSignalInput {
  sessionPath: unknown;
  stateId?: unknown;
  summary?: unknown;
  freshness?: unknown;
  observedAt?: unknown;
  evidenceRefs?: unknown;
  risk?: unknown;
}

export interface AoiPersonalMetadataFieldSignalInput {
  sessionPath: unknown;
  sourceId?: unknown;
  label?: unknown;
  kind?: unknown;
  consentState?: unknown;
  freshness?: unknown;
  metadataSummary?: unknown;
  bodyPreview?: unknown;
  observedAt?: unknown;
  evidenceRefs?: unknown;
  risk?: unknown;
}

export interface AoiManualFieldSignalInput {
  sessionPath: unknown;
  signalId?: unknown;
  sourceKind?: unknown;
  summary?: unknown;
  freshness?: unknown;
  evidenceRefs?: unknown;
  cannotKnow?: unknown;
  observedAt?: unknown;
  risk?: unknown;
}

export interface AoiFieldSignalBridgeInput {
  sessionPath: unknown;
  workspaceSnapshots?: AoiWorkspaceSnapshot[];
  researchSignals?: AoiResearchFieldSignalInput[];
  kiraOutcomes?: AoiKiraOutcomeFieldSignalInput[];
  appStateSignals?: AoiAppStateFieldSignalInput[];
  personalMetadataSources?: AoiPersonalMetadataFieldSignalInput[];
  memorySignals?: AoiManualFieldSignalInput[];
  manualSignals?: AoiManualFieldSignalInput[];
  now?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

function normalizeExpiresAt(
  value: unknown,
  observedAt: number,
  bodyAccess: AoiFieldSignalBodyAccess,
): number {
  const fallbackTtl =
    bodyAccess === 'explicit_body_allowed' ? PRIVATE_BODY_TTL_MS : DEFAULT_SIGNAL_TTL_MS;
  const fallback = observedAt + fallbackTtl;
  const normalized = normalizeTimestamp(value, fallback);
  return Math.max(normalized, observedAt);
}

export function sanitizeAoiFieldSignalText(value: unknown, maxChars = MAX_TEXT): string {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value))
      .replace(
        /\b(body|content|snippet|transcript|messageBody|rawText)\s*[:=]\s*[^.;\n]{6,}/gi,
        '$1=[redacted-private-body]',
      )
      .replace(/\b(?:[A-Za-z]:\\|\\\\)[^\s'"`<>|]+/g, '[redacted-path]')
      .replace(
        /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace)\/[^\s'"`<>|]+)/g,
        '[redacted-path]',
      )
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
      .replace(
        /\b(token|secret|api[_ -]?key|access[_ -]?token)\s*[:=]?\s*[A-Za-z0-9_=-]{16,}/gi,
        '$1=[redacted-token]',
      )
      .replace(
        /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
        '[redacted-secret]',
      ),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
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

function normalizeSourceKind(value: unknown): AoiFieldSignalSourceKind {
  if (
    value === 'workspace' ||
    value === 'research' ||
    value === 'kira' ||
    value === 'app_state' ||
    value === 'personal_metadata' ||
    value === 'memory' ||
    value === 'manual'
  ) {
    return value;
  }
  return 'manual';
}

function normalizeFreshness(value: unknown): AoiSignalFreshness {
  if (value === 'fresh' || value === 'stale' || value === 'failed' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

function normalizeConsentState(value: unknown): AoiFieldSignalConsentState {
  if (
    value === 'allowed' ||
    value === 'disabled' ||
    value === 'revoked' ||
    value === 'disconnected' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeBodyAccess(
  value: unknown,
  sourceKind: AoiFieldSignalSourceKind,
  consentState: AoiFieldSignalConsentState,
): AoiFieldSignalBodyAccess {
  if (value === 'none' || value === 'metadata_only' || value === 'explicit_body_allowed') {
    if (
      consentState === 'revoked' ||
      consentState === 'disabled' ||
      consentState === 'disconnected'
    ) {
      return 'none';
    }
    return value;
  }
  if (sourceKind === 'personal_metadata') {
    return consentState === 'allowed' ? 'metadata_only' : 'none';
  }
  return 'metadata_only';
}

function normalizeRisk(value: unknown): AoiAutonomyRisk {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'medium';
}

function normalizeStablePart(value: unknown, fallback: string): string {
  const sanitized = sanitizeAoiFieldSignalText(value, 120)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return sanitized || fallback;
}

function makeSignalId(params: {
  id?: unknown;
  sessionPath: string;
  sourceKind: AoiFieldSignalSourceKind;
  summary: string;
  dedupeKey?: unknown;
  observedAt: number;
}): string {
  const explicit = normalizeStablePart(params.id, '');
  if (explicit) {
    return explicit.startsWith('aoi-field-signal-') ? explicit : `aoi-field-signal-${explicit}`;
  }
  const dedupe = sanitizeAoiFieldSignalText(params.dedupeKey, 160);
  const key = [
    params.sessionPath,
    params.sourceKind,
    dedupe || params.summary,
    String(params.observedAt),
  ].join('|');
  return `aoi-field-signal-${hashText(key)}`;
}

function buildCannotKnow(params: {
  sourceKind: AoiFieldSignalSourceKind;
  freshness: AoiSignalFreshness;
  consentState: AoiFieldSignalConsentState;
  bodyAccess: AoiFieldSignalBodyAccess;
  cannotKnow: string[];
}): string[] {
  const out = new Set<string>(params.cannotKnow);
  if (params.freshness === 'stale') {
    out.add('Current state cannot be claimed from stale field evidence.');
  }
  if (params.freshness === 'failed') {
    out.add('Current state cannot be claimed because the field observation failed.');
  }
  if (params.freshness === 'unknown') {
    out.add('Current state cannot be claimed because source freshness is unknown.');
  }
  if (
    params.consentState === 'disabled' ||
    params.consentState === 'revoked' ||
    params.consentState === 'disconnected'
  ) {
    out.add('Source content is unavailable under the current consent state.');
  }
  if (params.sourceKind === 'personal_metadata' && params.bodyAccess !== 'explicit_body_allowed') {
    out.add('Private personal source body was not read and cannot be inferred.');
  }
  return [...out].slice(0, MAX_REFS);
}

export function buildAoiFieldSignalPacket(
  input: AoiFieldSignalPacketInput,
  now = Date.now(),
): AoiFieldSignalPacket {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }

  const sourceKind = normalizeSourceKind(input.sourceKind);
  const observedAt = normalizeTimestamp(input.observedAt, now);
  const freshness = normalizeFreshness(input.freshness);
  const consentState = normalizeConsentState(input.consentState);
  const bodyAccess = normalizeBodyAccess(input.bodyAccess, sourceKind, consentState);
  const summary =
    sanitizeAoiFieldSignalText(input.summary) ||
    `${sourceKind.replace(/_/g, ' ')} field signal observed.`;
  const evidenceRefs = normalizeStringList(input.evidenceRefs);
  const cannotKnow = buildCannotKnow({
    sourceKind,
    freshness,
    consentState,
    bodyAccess,
    cannotKnow: normalizeStringList(input.cannotKnow),
  });

  return {
    version: 1,
    id: makeSignalId({
      id: input.id,
      sessionPath,
      sourceKind,
      summary,
      dedupeKey: input.dedupeKey,
      observedAt,
    }),
    sessionPath,
    sourceKind,
    summary,
    freshness,
    consentState,
    bodyAccess,
    risk: normalizeRisk(input.risk),
    evidenceRefs,
    cannotKnow,
    observedAt,
    expiresAt: normalizeExpiresAt(input.expiresAt, observedAt, bodyAccess),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function buildAoiFieldSignalFromWorkspaceSnapshot(
  snapshot: AoiWorkspaceSnapshot,
  now = Date.now(),
): AoiFieldSignalPacket {
  const dirtySummary = snapshot.git?.isDirty
    ? `${snapshot.git.changedFileCount} changed files, ${snapshot.git.stagedFileCount} staged.`
    : 'Working tree clean or git signal unavailable.';
  const validationSummary =
    snapshot.validation.result === 'unknown'
      ? `Validation ${snapshot.validation.freshness}.`
      : `Validation ${snapshot.validation.result} / ${snapshot.validation.freshness}.`;
  return buildAoiFieldSignalPacket(
    {
      id: `workspace-${hashText(`${snapshot.workspaceLabel}:${snapshot.collectedAt}`)}`,
      sessionPath: snapshot.sessionPath,
      sourceKind: 'workspace',
      summary: `${snapshot.workspaceLabel}: ${dirtySummary} ${validationSummary}`,
      freshness: snapshot.freshness,
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: snapshot.validation.result === 'failed' ? 'medium' : 'low',
      evidenceRefs: [...snapshot.evidenceRefs, ...snapshot.validation.evidenceRefs],
      cannotKnow: snapshot.warnings,
      observedAt: snapshot.collectedAt,
      expiresAt: snapshot.collectedAt + DEFAULT_SIGNAL_TTL_MS,
      dedupeKey: `workspace:${snapshot.workspaceLabel}`,
    },
    now,
  );
}

export function buildAoiResearchFieldSignal(
  input: AoiResearchFieldSignalInput,
  now = Date.now(),
): AoiFieldSignalPacket {
  const title = sanitizeAoiFieldSignalText(input.title, 120) || 'Research run';
  const summary = sanitizeAoiFieldSignalText(input.summary) || `${title} has metadata only.`;
  return buildAoiFieldSignalPacket(
    {
      id: input.runId ? `research-${input.runId}` : undefined,
      sessionPath: input.sessionPath,
      sourceKind: 'research',
      summary: `${title}: ${summary}`,
      freshness: input.freshness,
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: input.risk,
      evidenceRefs: input.evidenceRefs,
      cannotKnow: input.cannotKnow,
      observedAt: input.completedAt,
      expiresAt: input.expiresAt,
      dedupeKey: input.runId ?? title,
    },
    now,
  );
}

export function buildAoiKiraOutcomeFieldSignal(
  input: AoiKiraOutcomeFieldSignalInput,
  now = Date.now(),
): AoiFieldSignalPacket {
  const status = sanitizeAoiFieldSignalText(input.status, 60) || 'unknown';
  const summary = sanitizeAoiFieldSignalText(input.summary) || 'Kira outcome metadata observed.';
  return buildAoiFieldSignalPacket(
    {
      id: input.outcomeId ? `kira-${input.outcomeId}` : undefined,
      sessionPath: input.sessionPath,
      sourceKind: 'kira',
      summary: `Kira ${status}: ${summary}`,
      freshness: status === 'failed' ? 'failed' : 'fresh',
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: input.risk ?? (status === 'failed' ? 'medium' : 'low'),
      evidenceRefs: input.evidenceRefs,
      cannotKnow: input.cannotKnow,
      observedAt: input.validatedAt,
      dedupeKey: input.outcomeId ?? status,
    },
    now,
  );
}

export function buildAoiAppStateFieldSignal(
  input: AoiAppStateFieldSignalInput,
  now = Date.now(),
): AoiFieldSignalPacket {
  return buildAoiFieldSignalPacket(
    {
      id: input.stateId ? `app-state-${input.stateId}` : undefined,
      sessionPath: input.sessionPath,
      sourceKind: 'app_state',
      summary: input.summary,
      freshness: input.freshness,
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: input.risk ?? 'low',
      evidenceRefs: input.evidenceRefs,
      observedAt: input.observedAt,
      dedupeKey: input.stateId ?? input.summary,
    },
    now,
  );
}

export function buildAoiPersonalMetadataFieldSignal(
  input: AoiPersonalMetadataFieldSignalInput,
  now = Date.now(),
): AoiFieldSignalPacket {
  const consentState = normalizeConsentState(input.consentState);
  const label = sanitizeAoiFieldSignalText(input.label, 120) || 'Personal metadata source';
  const kind = sanitizeAoiFieldSignalText(input.kind, 80) || 'metadata';
  const metadataSummary =
    consentState === 'allowed'
      ? sanitizeAoiFieldSignalText(input.metadataSummary) || `${kind} metadata available.`
      : `${kind} metadata unavailable: ${consentState}.`;
  const blindSpot =
    input.bodyPreview || consentState !== 'allowed'
      ? ['Private source body was withheld; only consent and metadata state can be recorded.']
      : [];
  return buildAoiFieldSignalPacket(
    {
      id: input.sourceId ? `personal-metadata-${input.sourceId}` : undefined,
      sessionPath: input.sessionPath,
      sourceKind: 'personal_metadata',
      summary: `${label}: ${metadataSummary}`,
      freshness: input.freshness,
      consentState,
      bodyAccess: 'metadata_only',
      risk: input.risk ?? 'medium',
      evidenceRefs: input.evidenceRefs,
      cannotKnow: blindSpot,
      observedAt: input.observedAt,
      dedupeKey: input.sourceId ?? label,
    },
    now,
  );
}

export function buildAoiManualFieldSignal(
  input: AoiManualFieldSignalInput,
  defaultSourceKind: AoiFieldSignalSourceKind,
  now = Date.now(),
): AoiFieldSignalPacket {
  return buildAoiFieldSignalPacket(
    {
      id: input.signalId,
      sessionPath: input.sessionPath,
      sourceKind: input.sourceKind ?? defaultSourceKind,
      summary: input.summary,
      freshness: input.freshness,
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: input.risk,
      evidenceRefs: input.evidenceRefs,
      cannotKnow: input.cannotKnow,
      observedAt: input.observedAt,
      dedupeKey: input.signalId ?? input.summary,
    },
    now,
  );
}

export function buildAoiFieldSignalPackets(
  input: AoiFieldSignalBridgeInput,
): AoiFieldSignalPacket[] {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  return [
    ...(input.workspaceSnapshots ?? []).map((snapshot) =>
      buildAoiFieldSignalFromWorkspaceSnapshot({ ...snapshot, sessionPath }, now),
    ),
    ...(input.researchSignals ?? []).map((signal) =>
      buildAoiResearchFieldSignal({ ...signal, sessionPath }, now),
    ),
    ...(input.kiraOutcomes ?? []).map((signal) =>
      buildAoiKiraOutcomeFieldSignal({ ...signal, sessionPath }, now),
    ),
    ...(input.appStateSignals ?? []).map((signal) =>
      buildAoiAppStateFieldSignal({ ...signal, sessionPath }, now),
    ),
    ...(input.personalMetadataSources ?? []).map((signal) =>
      buildAoiPersonalMetadataFieldSignal({ ...signal, sessionPath }, now),
    ),
    ...(input.memorySignals ?? []).map((signal) =>
      buildAoiManualFieldSignal({ ...signal, sessionPath }, 'memory', now),
    ),
    ...(input.manualSignals ?? []).map((signal) =>
      buildAoiManualFieldSignal({ ...signal, sessionPath }, 'manual', now),
    ),
  ];
}
