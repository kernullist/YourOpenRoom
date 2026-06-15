import { createHash } from 'crypto';
import { recordAoiObservationRelations } from './aoiAutonomyRelations';
import { upsertAoiObservation } from './aoiAutonomyStore';
import { recordAoiObservationTimelineEvent } from './aoiOperatorTimeline';
import type { AoiObservation, AoiObservationSource } from './aoiAutonomyTypes';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';

const OBSERVATION_SUMMARY_MAX_CHARS = 360;
const OBSERVATION_REF_MAX_ITEMS = 24;

export interface AoiObservationInput {
  source: AoiObservationSource;
  sessionPath: string;
  stableKey: string;
  summary: string;
  createdAt?: number;
  payloadRef?: string;
  memoryIds?: string[];
  artifactRefs?: string[];
  proposalIds?: string[];
  riskSignals?: string[];
}

export interface AoiObservationIngestResult {
  observation: AoiObservation;
  created: boolean;
  relationRecorded: boolean;
  warnings: string[];
}

type RecordObservationRelations = typeof recordAoiObservationRelations;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}

function sanitizeSummary(value: string): string {
  return truncateText(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value)),
    OBSERVATION_SUMMARY_MAX_CHARS,
  );
}

function sanitizeIdPart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'event'
  );
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function makeStableObservationId(source: AoiObservationSource, stableKey: string): string {
  return `aoi-obs-${sanitizeIdPart(source)}-${sanitizeIdPart(stableKey)}-${hashPart(
    `${source}:${stableKey}`,
  )}`.slice(0, 127);
}

function normalizeStringList(
  value: string[] | undefined,
  maxItems = OBSERVATION_REF_MAX_ITEMS,
): string[] {
  const seen = new Set<string>();
  for (const item of value ?? []) {
    const normalized = normalizeWhitespace(item).slice(0, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

export function createAoiObservation(input: AoiObservationInput): AoiObservation {
  const stableKey = normalizeWhitespace(input.stableKey).slice(0, 180);
  if (!stableKey) {
    throw new Error('Observation stableKey is required.');
  }
  const summary = sanitizeSummary(input.summary);
  if (!summary) {
    throw new Error('Observation summary is required.');
  }
  return {
    version: 1,
    id: makeStableObservationId(input.source, stableKey),
    source: input.source,
    sessionPath: input.sessionPath,
    createdAt: input.createdAt ?? Date.now(),
    summary,
    ...(typeof input.payloadRef === 'string' && input.payloadRef.trim()
      ? { payloadRef: input.payloadRef.trim().slice(0, 240) }
      : {}),
    memoryIds: normalizeStringList(input.memoryIds),
    artifactRefs: normalizeStringList(input.artifactRefs),
    proposalIds: normalizeStringList(input.proposalIds),
    riskSignals: normalizeStringList(input.riskSignals, 12),
    dedupeKey: `${input.source}:${stableKey}`,
  };
}

export function ingestAoiObservation(
  sessionsDir: string,
  input: AoiObservation | AoiObservationInput,
  options: {
    recordRelations?: RecordObservationRelations;
    now?: number;
  } = {},
): AoiObservationIngestResult {
  const observation =
    'version' in input && input.version === 1 ? input : createAoiObservation(input);
  const stored = upsertAoiObservation(sessionsDir, observation);
  const warnings: string[] = [];
  const recordRelations = options.recordRelations ?? recordAoiObservationRelations;
  let relationRecorded = false;

  try {
    recordRelations(sessionsDir, stored.observation, options.now ?? stored.observation.createdAt);
    relationRecorded = true;
  } catch {
    warnings.push('observation_relation_write_failed');
  }

  if (stored.created) {
    try {
      recordAoiObservationTimelineEvent({
        sessionsDir,
        observation: stored.observation,
        created: stored.created,
      });
    } catch {
      warnings.push('observation_timeline_write_failed');
    }
  }

  return {
    observation: stored.observation,
    created: stored.created,
    relationRecorded,
    warnings,
  };
}

export function ingestAoiObservations(
  sessionsDir: string,
  observations: Array<AoiObservation | AoiObservationInput>,
  options: {
    recordRelations?: RecordObservationRelations;
    now?: number;
  } = {},
): AoiObservationIngestResult[] {
  return observations.map((observation) => ingestAoiObservation(sessionsDir, observation, options));
}
