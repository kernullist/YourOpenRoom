import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';

import { AOI_LOCAL_EMBEDDING_MODEL } from './aoiLocalEmbedding';
import { selectAoiMemoryDecayCandidates } from './aoiMemoryDecay';
import type { AoiMemoryEmbeddingStatus } from './aoiMemoryEmbeddingStatus';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';

const MAX_RECALL_TRIALS = 200;
const MAX_MEMORY_IDS = 16;
const RECALL_EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type AoiMemoryRetrievalPath = 'lexical_only' | 'local_semantic' | 'provider_semantic';

export type AoiMemoryRecallMissReason =
  | 'no_candidates'
  | 'no_selection'
  | 'expected_memory_not_selected';

export interface AoiMemoryRecallTrial {
  version: 1;
  id: string;
  sessionPath: string;
  createdAt: number;
  queryFingerprint: string;
  retrievalPath: AoiMemoryRetrievalPath;
  candidateCount: number;
  selectedMemoryIds: string[];
  expectedMemoryIds: string[];
  hitMemoryIds: string[];
  success: boolean;
  missReason?: AoiMemoryRecallMissReason;
  evidenceRefs: string[];
  privacyState: 'metadata_only';
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiMemoryDiagnostics {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  retrievalPath: AoiMemoryRetrievalPath;
  providerConfigured: boolean;
  providerModel: string | null;
  localFallbackConfigured: boolean;
  localFallbackVerified: boolean;
  providerSemanticVerified: boolean;
  lexicalFallbackVerified: boolean;
  activeCount: number;
  embeddedCount: number;
  embeddingCoverage: number;
  recallSampleCount: number;
  successfulRecallCount: number;
  recallMissCount: number;
  recallMissReasons: Record<AoiMemoryRecallMissReason, number>;
  lexicalTrialCount: number;
  localSemanticTrialCount: number;
  providerSemanticTrialCount: number;
  updateEvidenceCount: number;
  conflictResolutionCount: number;
  supersessionCount: number;
  archivedCount: number;
  supersededCount: number;
  expiredActiveCount: number;
  decayCandidateCount: number;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiMemoryRecallTrialInput {
  sessionsDir: string;
  sessionPath: string;
  query: string;
  retrievalPath: AoiMemoryRetrievalPath;
  candidateCount: number;
  selectedMemoryIds: string[];
  expectedMemoryIds: string[];
  createdAt?: number;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(resolve(root), resolve(target));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function normalizeId(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/[^A-Za-z0-9_.:-]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 160)
    : '';
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.map(normalizeId).filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_MEMORY_IDS);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveRecallTrialsPath(sessionsDir: string, sessionPath: string): string {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const sessionRoot = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath).root;
  const target = resolve(sessionRoot, 'memory-diagnostics', 'recall-trials.json');
  if (!isPathInsideRoot(sessionsRoot, sessionRoot) || !isPathInsideRoot(sessionRoot, target)) {
    throw new Error('Memory recall diagnostics path escaped the session root.');
  }
  let candidate = sessionsRoot;
  const relativeSegments = relative(sessionsRoot, target)
    .split(/[\\/]+/)
    .filter(Boolean);
  for (const segment of relativeSegments) {
    candidate = resolve(candidate, segment);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error('Memory recall diagnostics may not traverse a symbolic link.');
    }
  }
  if (fs.existsSync(sessionsRoot) && fs.existsSync(sessionRoot)) {
    const realSessionsRoot = fs.realpathSync(sessionsRoot);
    const realSessionRoot = fs.realpathSync(sessionRoot);
    if (!isPathInsideRoot(realSessionsRoot, realSessionRoot)) {
      throw new Error('Memory recall diagnostics escaped through a symbolic link.');
    }
  }
  return target;
}

function normalizeRetrievalPath(value: unknown): AoiMemoryRetrievalPath | null {
  if (value === 'lexical_only' || value === 'local_semantic' || value === 'provider_semantic') {
    return value;
  }
  return null;
}

function normalizeRecallTrial(value: unknown, sessionPath: string): AoiMemoryRecallTrial | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath);
  const expectedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  const retrievalPath = normalizeRetrievalPath(raw.retrievalPath);
  const selectedMemoryIds = normalizeIds(raw.selectedMemoryIds);
  const expectedMemoryIds = normalizeIds(raw.expectedMemoryIds);
  const hitMemoryIds = expectedMemoryIds.filter((id) => selectedMemoryIds.includes(id));
  const candidateCount = Number.isFinite(raw.candidateCount)
    ? Math.max(0, Math.trunc(Number(raw.candidateCount)))
    : -1;
  const success = hitMemoryIds.length > 0;
  const missReason: AoiMemoryRecallMissReason | undefined = success
    ? undefined
    : candidateCount === 0
      ? 'no_candidates'
      : selectedMemoryIds.length === 0
        ? 'no_selection'
        : 'expected_memory_not_selected';
  if (
    raw.version !== 1 ||
    !normalizedSessionPath ||
    normalizedSessionPath !== expectedSessionPath ||
    !retrievalPath ||
    typeof raw.id !== 'string' ||
    !normalizeId(raw.id) ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.queryFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.queryFingerprint) ||
    candidateCount < 0 ||
    expectedMemoryIds.length === 0 ||
    raw.success !== success ||
    (raw.missReason !== undefined && raw.missReason !== missReason) ||
    raw.privacyState !== 'metadata_only' ||
    raw.actionAuthority !== 'display_only' ||
    raw.mutationCount !== 0
  ) {
    return null;
  }
  return {
    version: 1,
    id: normalizeId(raw.id),
    sessionPath: normalizedSessionPath,
    createdAt: Math.trunc(Number(raw.createdAt)),
    queryFingerprint: raw.queryFingerprint,
    retrievalPath,
    candidateCount,
    selectedMemoryIds,
    expectedMemoryIds,
    hitMemoryIds,
    success,
    ...(missReason ? { missReason } : {}),
    evidenceRefs: [
      `memory-recall-trial:${normalizeId(raw.id)}`,
      ...hitMemoryIds.map((id) => `memory:${id}`),
    ],
    privacyState: 'metadata_only',
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function loadAoiMemoryRecallTrials(
  sessionsDir: string,
  sessionPath: string,
): AoiMemoryRecallTrial[] {
  try {
    const filePath = resolveRecallTrialsPath(sessionsDir, sessionPath);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const trials: AoiMemoryRecallTrial[] = [];
    for (const value of parsed) {
      const trial = normalizeRecallTrial(value, sessionPath);
      if (!trial || seen.has(trial.id)) {
        continue;
      }
      seen.add(trial.id);
      trials.push(trial);
    }
    return trials
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, MAX_RECALL_TRIALS);
  } catch {
    return [];
  }
}

export function recordAoiMemoryRecallTrial(input: AoiMemoryRecallTrialInput): AoiMemoryRecallTrial {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const query = input.query.replace(/\s+/g, ' ').trim();
  if (!query) {
    throw new Error('A measured memory recall requires a non-empty query.');
  }
  const retrievalPath = normalizeRetrievalPath(input.retrievalPath);
  if (!retrievalPath) {
    throw new Error('A measured memory recall requires a valid retrieval path.');
  }
  const selectedMemoryIds = normalizeIds(input.selectedMemoryIds);
  const expectedMemoryIds = normalizeIds(input.expectedMemoryIds);
  if (expectedMemoryIds.length === 0) {
    throw new Error('A measured memory recall requires at least one expected memory id.');
  }
  const createdAt = Math.trunc(input.createdAt ?? Date.now());
  const queryFingerprint = hashText(query);
  const hitMemoryIds = expectedMemoryIds.filter((id) => selectedMemoryIds.includes(id));
  const candidateCount = Math.max(0, Math.trunc(input.candidateCount));
  const success = hitMemoryIds.length > 0;
  const missReason: AoiMemoryRecallMissReason | undefined = success
    ? undefined
    : candidateCount === 0
      ? 'no_candidates'
      : selectedMemoryIds.length === 0
        ? 'no_selection'
        : 'expected_memory_not_selected';
  const id = `aoi-memory-recall-${hashText(
    [
      sessionPath,
      queryFingerprint,
      retrievalPath,
      expectedMemoryIds.join(','),
      selectedMemoryIds.join(','),
      String(createdAt),
    ].join('|'),
  ).slice(0, 20)}`;
  const trial: AoiMemoryRecallTrial = {
    version: 1,
    id,
    sessionPath,
    createdAt,
    queryFingerprint,
    retrievalPath,
    candidateCount,
    selectedMemoryIds,
    expectedMemoryIds,
    hitMemoryIds,
    success,
    ...(missReason ? { missReason } : {}),
    evidenceRefs: [
      `memory-recall-trial:${id}`,
      ...hitMemoryIds.map((memoryId) => `memory:${memoryId}`),
    ],
    privacyState: 'metadata_only',
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  const filePath = resolveRecallTrialsPath(input.sessionsDir, sessionPath);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const current = loadAoiMemoryRecallTrials(input.sessionsDir, sessionPath).filter(
    (item) => item.id !== trial.id,
  );
  const next = [trial, ...current].slice(0, MAX_RECALL_TRIALS);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return trial;
}

export function buildAoiMemoryDiagnostics(params: {
  sessionPath: string;
  memories: readonly AoiMemoryEntry[];
  embeddingStatus: AoiMemoryEmbeddingStatus | null;
  recallTrials: readonly AoiMemoryRecallTrial[];
  now?: number;
}): AoiMemoryDiagnostics {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const memories = params.memories.filter((memory) => memory.sessionPath === sessionPath);
  const active = memories.filter((memory) => memory.status === 'active');
  const embedded = active.filter(
    (memory) => Array.isArray(memory.embedding) && memory.embedding.length > 0,
  );
  const trials = params.recallTrials.filter(
    (trial) =>
      trial.sessionPath === sessionPath &&
      now - trial.createdAt <= RECALL_EVIDENCE_WINDOW_MS &&
      trial.createdAt - now <= MAX_FUTURE_SKEW_MS,
  );
  const successful = trials.filter((trial) => trial.success);
  const providerModel = params.embeddingStatus?.providerModel ?? null;
  const localFallbackConfigured = providerModel === AOI_LOCAL_EMBEDDING_MODEL;
  const localFallbackVerified = successful.some(
    (trial) => trial.retrievalPath === 'local_semantic',
  );
  const lexicalFallbackVerified = successful.some(
    (trial) => trial.retrievalPath === 'lexical_only',
  );
  const providerSemanticVerified = successful.some(
    (trial) => trial.retrievalPath === 'provider_semantic',
  );
  const recallMissReasons: Record<AoiMemoryRecallMissReason, number> = {
    no_candidates: 0,
    no_selection: 0,
    expected_memory_not_selected: 0,
  };
  for (const trial of trials) {
    if (trial.missReason) {
      recallMissReasons[trial.missReason] += 1;
    }
  }
  const supersessionCount = memories.reduce(
    (total, memory) => total + (memory.supersedes?.length ?? 0),
    0,
  );
  const decayCandidateCount = selectAoiMemoryDecayCandidates(memories, { now }).length;
  const retrievalPath: AoiMemoryRetrievalPath = providerModel
    ? localFallbackConfigured
      ? 'local_semantic'
      : 'provider_semantic'
    : 'lexical_only';
  return {
    version: 1,
    sessionPath,
    generatedAt: now,
    retrievalPath,
    providerConfigured: params.embeddingStatus?.providerConfigured ?? false,
    providerModel,
    localFallbackConfigured,
    localFallbackVerified,
    providerSemanticVerified,
    lexicalFallbackVerified,
    activeCount: active.length,
    embeddedCount: embedded.length,
    embeddingCoverage: active.length > 0 ? embedded.length / active.length : 0,
    recallSampleCount: trials.length,
    successfulRecallCount: successful.length,
    recallMissCount: trials.length - successful.length,
    recallMissReasons,
    lexicalTrialCount: trials.filter((trial) => trial.retrievalPath === 'lexical_only').length,
    localSemanticTrialCount: trials.filter((trial) => trial.retrievalPath === 'local_semantic')
      .length,
    providerSemanticTrialCount: trials.filter(
      (trial) => trial.retrievalPath === 'provider_semantic',
    ).length,
    updateEvidenceCount: active.filter((memory) => memory.updatedAt > memory.createdAt).length,
    conflictResolutionCount: active.filter((memory) => (memory.supersedes?.length ?? 0) > 0).length,
    supersessionCount,
    archivedCount: memories.filter((memory) => memory.status === 'archived').length,
    supersededCount: memories.filter((memory) => memory.status === 'superseded').length,
    expiredActiveCount: active.filter(
      (memory) => typeof memory.expiresAt === 'number' && memory.expiresAt <= now,
    ).length,
    decayCandidateCount,
    evidenceRefs: [
      ...trials.slice(0, 8).map((trial) => `memory-recall-trial:${trial.id}`),
      ...active.slice(0, 8).map((memory) => `memory:${memory.id}`),
    ].slice(0, 16),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}
