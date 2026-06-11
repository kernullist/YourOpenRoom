import * as fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { DEFAULT_AOI_AUTONOMY_POLICY, normalizeAoiAutonomyPolicy } from './aoiAutonomyPolicy';
import { loadAoiActiveGoals } from './aoiAutonomyGoals';
import { recordAoiProposalDecisionRelations } from './aoiAutonomyRelations';
import type {
  AoiAutonomyPolicy,
  AoiAutonomyStatus,
  AoiAutonomyTickReason,
  AoiAutonomyTickState,
  AoiObservation,
  AoiObservationIndex,
  AoiObservationIndexEntry,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiReflection,
} from './aoiAutonomyTypes';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const MAX_LIST_ITEMS = 200;
const OBSERVATION_INDEX_FILE = 'index.json';
const MAX_OBSERVATION_INDEX_ITEMS = 200;
const MAX_OBSERVATION_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface AoiAutonomyPaths {
  root: string;
  policy: string;
  observationsDir: string;
  observationsIndex: string;
  reflectionsDir: string;
  proposalsDir: string;
  activeProposals: string;
  archivedProposals: string;
  decisionsDir: string;
  tickState: string;
  evalDir: string;
}

export interface AoiObservationUpsertResult {
  observation: AoiObservation;
  created: boolean;
}

export interface AoiAutonomyTickStartResult {
  started: boolean;
  state: AoiAutonomyTickState;
  skippedReason?: string;
}

export interface AoiProposalDecisionInput {
  proposalId: string;
  action: Extract<AoiProposalDecisionAction, 'accept' | 'dismiss' | 'snooze'>;
  actor?: 'user' | 'system';
  reason?: string;
  snoozeMs?: number;
  now?: number;
}

export interface AoiProposalExecutionTransitionInput {
  proposalId: string;
  nextStatus: Extract<AoiProposal['status'], 'executed' | 'blocked'>;
  actor?: 'user' | 'system';
  reason?: string;
  now?: number;
}

export interface AoiProposalDecisionResult {
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  activeProposals: AoiProposal[];
  archivedProposals: AoiProposal[];
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

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDirectory(filePath, true);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function listJsonFiles<T>(directory: string): T[] {
  try {
    if (!fs.existsSync(directory)) {
      return [];
    }
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJson<T>(join(directory, entry.name)))
      .filter((item): item is T => item !== null)
      .slice(0, MAX_LIST_ITEMS);
  } catch {
    return [];
  }
}

function isAoiObservationSource(value: unknown): value is AoiObservation['source'] {
  return (
    value === 'chat' ||
    value === 'tool' ||
    value === 'research_run' ||
    value === 'kira' ||
    value === 'proposal' ||
    value === 'memory' ||
    value === 'app' ||
    value === 'system'
  );
}

function isAoiAutonomyTickReason(value: unknown): value is AoiAutonomyTickReason {
  return (
    value === 'manual' ||
    value === 'turn' ||
    value === 'periodic' ||
    value === 'research_run' ||
    value === 'kira' ||
    value === 'proposal' ||
    value === 'memory' ||
    value === 'app'
  );
}

function normalizeStringList(value: unknown, maxItems = 24): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function normalizeObservationDedupeKey(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
  return normalized || fallback;
}

function isAoiObservation(value: unknown): value is AoiObservation {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const observation = value as Partial<AoiObservation>;
  return (
    observation.version === 1 &&
    isValidAoiAutonomyId(observation.id) &&
    isAoiObservationSource(observation.source) &&
    typeof observation.sessionPath === 'string' &&
    typeof observation.createdAt === 'number' &&
    typeof observation.summary === 'string' &&
    Array.isArray(observation.memoryIds) &&
    Array.isArray(observation.artifactRefs) &&
    Array.isArray(observation.proposalIds) &&
    Array.isArray(observation.riskSignals) &&
    typeof observation.dedupeKey === 'string'
  );
}

function isAoiObservationIndexEntry(value: unknown): value is AoiObservationIndexEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<AoiObservationIndexEntry>;
  return (
    isValidAoiAutonomyId(entry.id) &&
    typeof entry.dedupeKey === 'string' &&
    isAoiObservationSource(entry.source) &&
    typeof entry.createdAt === 'number' &&
    typeof entry.summary === 'string'
  );
}

function normalizeAoiObservation(observation: AoiObservation): AoiObservation {
  const sessionPath = normalizeAoiAutonomySessionPath(observation.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(observation.id)) {
    throw new Error('Invalid observation id.');
  }
  if (!isAoiObservationSource(observation.source)) {
    throw new Error('Invalid observation source.');
  }
  const summary = observation.summary.replace(/\s+/g, ' ').trim().slice(0, 360);
  if (!summary) {
    throw new Error('Observation summary is required.');
  }
  return {
    version: 1,
    id: observation.id,
    source: observation.source,
    sessionPath,
    createdAt: observation.createdAt,
    summary,
    ...(typeof observation.payloadRef === 'string' && observation.payloadRef.trim()
      ? { payloadRef: observation.payloadRef.trim().slice(0, 240) }
      : {}),
    memoryIds: normalizeStringList(observation.memoryIds, 24),
    artifactRefs: normalizeStringList(observation.artifactRefs, 24),
    proposalIds: normalizeStringList(observation.proposalIds, 24),
    riskSignals: normalizeStringList(observation.riskSignals, 12),
    dedupeKey: normalizeObservationDedupeKey(observation.dedupeKey, observation.id),
  };
}

export function normalizeAoiAutonomySessionPath(value: unknown): string | null {
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

export function isValidAoiAutonomyId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/.test(value);
}

export function createAoiAutonomyId(prefix: string, now = Date.now()): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'aoi';
  return `${safePrefix}-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function resolveAoiAutonomyPaths(
  sessionsDir: string,
  sessionPath: string,
): AoiAutonomyPaths {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const root = resolve(sessionsRoot, normalizedSessionPath, AUTONOMY_ROOT_DIR);
  if (!isPathInsideRoot(sessionsRoot, root)) {
    throw new Error('Resolved Aoi autonomy path escaped the sessions directory.');
  }
  const proposalsDir = join(root, 'proposals');
  return {
    root,
    policy: join(root, 'policy.json'),
    observationsDir: join(root, 'observations'),
    observationsIndex: join(root, 'observations', OBSERVATION_INDEX_FILE),
    reflectionsDir: join(root, 'reflections'),
    proposalsDir,
    activeProposals: join(proposalsDir, 'active.json'),
    archivedProposals: join(proposalsDir, 'archived.json'),
    decisionsDir: join(root, 'decisions'),
    tickState: join(root, 'tick-state.json'),
    evalDir: join(root, 'eval'),
  };
}

export function loadAoiAutonomyPolicy(sessionsDir: string, sessionPath: string): AoiAutonomyPolicy {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return normalizeAoiAutonomyPolicy(
    readJson<Partial<AoiAutonomyPolicy>>(paths.policy),
    DEFAULT_AOI_AUTONOMY_POLICY,
    readJson<Partial<AoiAutonomyPolicy>>(paths.policy)?.updatedAt || 0,
  );
}

export function saveAoiAutonomyPolicy(
  sessionsDir: string,
  sessionPath: string,
  policy: unknown,
  now = Date.now(),
): AoiAutonomyPolicy {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const current = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
  const normalized = normalizeAoiAutonomyPolicy(policy, current, now);
  writeJsonAtomic(paths.policy, normalized);
  return normalized;
}

function normalizeRecordSessionPath<T extends { sessionPath: string }>(record: T): T {
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return {
    ...record,
    sessionPath,
  };
}

function makeProposalDecisionObservation(
  proposal: AoiProposal,
  decision: AoiProposalDecision,
): AoiObservation {
  return {
    version: 1,
    id: `aoi-obs-decision-${decision.id}`.slice(0, 127),
    source: 'proposal',
    sessionPath: decision.sessionPath,
    createdAt: decision.createdAt,
    summary: `Aoi proposal ${decision.action}: ${proposal.title}`.slice(0, 240),
    payloadRef: `decision:${decision.id}`,
    memoryIds: proposal.memoryIds,
    artifactRefs: [`decision:${decision.id}`, ...proposal.artifactRefs],
    proposalIds: [proposal.id],
    riskSignals: proposal.riskSignals,
    dedupeKey: `decision:${decision.id}`,
  };
}

export function appendAoiObservation(
  sessionsDir: string,
  observation: AoiObservation,
): AoiObservation {
  return upsertAoiObservation(sessionsDir, observation).observation;
}

export function loadAoiObservationIndex(
  sessionsDir: string,
  sessionPath: string,
): AoiObservationIndex {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiObservationIndex>>(paths.observationsIndex);
  return {
    version: 1,
    sessionPath: normalizeAoiAutonomySessionPath(sessionPath) || sessionPath,
    updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0,
    entries:
      parsed?.version === 1 && Array.isArray(parsed.entries)
        ? parsed.entries
            .filter(isAoiObservationIndexEntry)
            .sort((left, right) => right.createdAt - left.createdAt)
            .slice(0, MAX_OBSERVATION_INDEX_ITEMS)
        : [],
  };
}

function saveAoiObservationIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiObservationIndex,
): AoiObservationIndex {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalized: AoiObservationIndex = {
    version: 1,
    sessionPath: normalizeAoiAutonomySessionPath(sessionPath) || sessionPath,
    updatedAt: index.updatedAt,
    entries: index.entries.slice(0, MAX_OBSERVATION_INDEX_ITEMS),
  };
  writeJsonAtomic(paths.observationsIndex, normalized);
  return normalized;
}

function pruneAoiObservationFiles(paths: AoiAutonomyPaths, keepIds: Set<string>): void {
  try {
    if (!fs.existsSync(paths.observationsDir)) {
      return;
    }
    for (const entry of fs.readdirSync(paths.observationsDir, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith('.json') ||
        entry.name === OBSERVATION_INDEX_FILE
      ) {
        continue;
      }
      const id = entry.name.slice(0, -'.json'.length);
      if (!keepIds.has(id)) {
        fs.rmSync(join(paths.observationsDir, entry.name), { force: true });
      }
    }
  } catch {
    // Observation pruning is best-effort.
  }
}

export function upsertAoiObservation(
  sessionsDir: string,
  observation: AoiObservation,
): AoiObservationUpsertResult {
  const item = normalizeAoiObservation(observation);
  const paths = resolveAoiAutonomyPaths(sessionsDir, item.sessionPath);
  const index = loadAoiObservationIndex(sessionsDir, item.sessionPath);
  const existingEntry = index.entries.find(
    (entry) => entry.id === item.id || entry.dedupeKey === item.dedupeKey,
  );
  const storedItem: AoiObservation = existingEntry
    ? {
        ...item,
        id: existingEntry.id,
      }
    : item;
  const now = Math.max(storedItem.createdAt, index.updatedAt || 0);
  const minCreatedAt = now - MAX_OBSERVATION_AGE_MS;
  const nextEntry: AoiObservationIndexEntry = {
    id: storedItem.id,
    dedupeKey: storedItem.dedupeKey,
    source: storedItem.source,
    createdAt: storedItem.createdAt,
    summary: storedItem.summary.slice(0, 180),
  };
  const nextEntries = [
    nextEntry,
    ...index.entries.filter(
      (entry) => entry.id !== storedItem.id && entry.dedupeKey !== storedItem.dedupeKey,
    ),
  ]
    .filter((entry) => entry.createdAt >= minCreatedAt)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_OBSERVATION_INDEX_ITEMS);
  const keepIds = new Set(nextEntries.map((entry) => entry.id));

  writeJsonAtomic(join(paths.observationsDir, `${storedItem.id}.json`), storedItem);
  saveAoiObservationIndex(sessionsDir, storedItem.sessionPath, {
    version: 1,
    sessionPath: storedItem.sessionPath,
    updatedAt: now,
    entries: nextEntries,
  });
  pruneAoiObservationFiles(paths, keepIds);

  return {
    observation: storedItem,
    created: !existingEntry,
  };
}

export function loadAoiObservations(sessionsDir: string, sessionPath: string): AoiObservation[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const index = loadAoiObservationIndex(sessionsDir, sessionPath);
  const indexed = index.entries
    .map((entry) => readJson<AoiObservation>(join(paths.observationsDir, `${entry.id}.json`)))
    .filter((item): item is AoiObservation => isAoiObservation(item))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (indexed.length > 0 || index.updatedAt > 0) {
    return indexed;
  }
  return listJsonFiles<AoiObservation>(paths.observationsDir)
    .filter(isAoiObservation)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function loadAoiAutonomyTickState(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiAutonomyTickState {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const parsed = readJson<Partial<AoiAutonomyTickState>>(paths.tickState);
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath) || sessionPath;
  const activeTick =
    parsed?.activeTick === true &&
    typeof parsed.lockExpiresAt === 'number' &&
    parsed.lockExpiresAt > now;

  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    activeTick,
    ...(activeTick && typeof parsed?.activeTickId === 'string'
      ? { activeTickId: parsed.activeTickId }
      : {}),
    ...(activeTick && isAoiAutonomyTickReason(parsed?.activeTickReason)
      ? { activeTickReason: parsed.activeTickReason }
      : {}),
    ...(activeTick && typeof parsed?.lockExpiresAt === 'number'
      ? { lockExpiresAt: parsed.lockExpiresAt }
      : {}),
    ...(typeof parsed?.lastTickAt === 'number' ? { lastTickAt: parsed.lastTickAt } : {}),
    ...(isAoiAutonomyTickReason(parsed?.lastTickReason)
      ? { lastTickReason: parsed.lastTickReason }
      : {}),
    ...(typeof parsed?.lastTickStartedAt === 'number'
      ? { lastTickStartedAt: parsed.lastTickStartedAt }
      : {}),
    ...(typeof parsed?.lastTickCompletedAt === 'number'
      ? { lastTickCompletedAt: parsed.lastTickCompletedAt }
      : {}),
    ...(typeof parsed?.nextAllowedTickAt === 'number'
      ? { nextAllowedTickAt: parsed.nextAllowedTickAt }
      : {}),
    recentObservationCount:
      typeof parsed?.recentObservationCount === 'number' ? parsed.recentObservationCount : 0,
    proposalsCreatedInLastTick:
      typeof parsed?.proposalsCreatedInLastTick === 'number'
        ? parsed.proposalsCreatedInLastTick
        : 0,
    ...(typeof parsed?.lastSkippedReason === 'string' && parsed.lastSkippedReason.trim()
      ? { lastSkippedReason: parsed.lastSkippedReason.trim().slice(0, 120) }
      : {}),
    updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0,
  };
}

function saveAoiAutonomyTickState(
  sessionsDir: string,
  sessionPath: string,
  state: AoiAutonomyTickState,
): AoiAutonomyTickState {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  writeJsonAtomic(paths.tickState, state);
  return state;
}

export function beginAoiAutonomyTick(
  sessionsDir: string,
  sessionPath: string,
  input: {
    reason: AoiAutonomyTickReason;
    now?: number;
    minIntervalMs?: number;
    lockMs?: number;
  },
): AoiAutonomyTickStartResult {
  const now = input.now ?? Date.now();
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const current = loadAoiAutonomyTickState(sessionsDir, normalizedSessionPath, now);
  if (current.activeTick) {
    return {
      started: false,
      state: current,
      skippedReason: 'tick_already_running',
    };
  }
  if (input.minIntervalMs && current.nextAllowedTickAt && current.nextAllowedTickAt > now) {
    return {
      started: false,
      state: saveAoiAutonomyTickState(sessionsDir, normalizedSessionPath, {
        ...current,
        activeTick: false,
        lastSkippedReason: 'tick_cooldown_active',
        updatedAt: now,
      }),
      skippedReason: 'tick_cooldown_active',
    };
  }

  const state: AoiAutonomyTickState = {
    ...current,
    version: 1,
    sessionPath: normalizedSessionPath,
    activeTick: true,
    activeTickId: createAoiAutonomyId('aoi-tick', now),
    activeTickReason: input.reason,
    lockExpiresAt: now + (input.lockMs && input.lockMs > 0 ? input.lockMs : 120_000),
    lastTickStartedAt: now,
    lastSkippedReason: undefined,
    updatedAt: now,
  };

  return {
    started: true,
    state: saveAoiAutonomyTickState(sessionsDir, normalizedSessionPath, state),
  };
}

export function completeAoiAutonomyTick(
  sessionsDir: string,
  sessionPath: string,
  input: {
    reason: AoiAutonomyTickReason;
    now?: number;
    minIntervalMs?: number;
    recentObservationCount: number;
    proposalsCreatedInLastTick: number;
    skippedReason?: string;
  },
): AoiAutonomyTickState {
  const now = input.now ?? Date.now();
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const current = loadAoiAutonomyTickState(sessionsDir, normalizedSessionPath, now);
  return saveAoiAutonomyTickState(sessionsDir, normalizedSessionPath, {
    ...current,
    version: 1,
    sessionPath: normalizedSessionPath,
    activeTick: false,
    activeTickId: undefined,
    activeTickReason: undefined,
    lockExpiresAt: undefined,
    lastTickAt: now,
    lastTickReason: input.reason,
    lastTickCompletedAt: now,
    nextAllowedTickAt: now + Math.max(0, input.minIntervalMs ?? 0),
    recentObservationCount: Math.max(0, input.recentObservationCount),
    proposalsCreatedInLastTick: Math.max(0, input.proposalsCreatedInLastTick),
    ...(input.skippedReason ? { lastSkippedReason: input.skippedReason.slice(0, 120) } : {}),
    updatedAt: now,
  });
}

export function markAoiAutonomyTickSkipped(
  sessionsDir: string,
  sessionPath: string,
  input: {
    skippedReason: string;
    now?: number;
  },
): AoiAutonomyTickState {
  const now = input.now ?? Date.now();
  const current = loadAoiAutonomyTickState(sessionsDir, sessionPath, now);
  return saveAoiAutonomyTickState(sessionsDir, sessionPath, {
    ...current,
    activeTick: false,
    activeTickId: undefined,
    activeTickReason: undefined,
    lockExpiresAt: undefined,
    lastSkippedReason: input.skippedReason.slice(0, 120),
    updatedAt: now,
  });
}

export function appendAoiReflection(sessionsDir: string, reflection: AoiReflection): AoiReflection {
  const item = normalizeRecordSessionPath(reflection);
  if (!isValidAoiAutonomyId(item.id)) {
    throw new Error('Invalid reflection id.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, item.sessionPath);
  writeJsonAtomic(join(paths.reflectionsDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiReflections(sessionsDir: string, sessionPath: string): AoiReflection[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<AoiReflection>(paths.reflectionsDir)
    .filter((item) => item.version === 1 && isValidAoiAutonomyId(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function loadProposalList(filePath: string): AoiProposal[] {
  const parsed = readJson<unknown>(filePath);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter(
      (item): item is AoiProposal =>
        item &&
        typeof item === 'object' &&
        (item as AoiProposal).version === 1 &&
        isValidAoiAutonomyId((item as AoiProposal).id),
    )
    .slice(0, MAX_LIST_ITEMS);
}

export function loadAoiActiveProposals(sessionsDir: string, sessionPath: string): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return loadProposalList(paths.activeProposals);
}

export function loadAoiArchivedProposals(sessionsDir: string, sessionPath: string): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return loadProposalList(paths.archivedProposals);
}

export function saveAoiActiveProposals(
  sessionsDir: string,
  sessionPath: string,
  proposals: AoiProposal[],
): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalized = proposals.map(normalizeRecordSessionPath);
  writeJsonAtomic(paths.activeProposals, normalized);
  return normalized;
}

export function saveAoiArchivedProposals(
  sessionsDir: string,
  sessionPath: string,
  proposals: AoiProposal[],
): AoiProposal[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalized = proposals.map(normalizeRecordSessionPath);
  writeJsonAtomic(paths.archivedProposals, normalized);
  return normalized;
}

export function appendAoiProposalDecision(
  sessionsDir: string,
  decision: AoiProposalDecision,
): AoiProposalDecision {
  const item = normalizeRecordSessionPath(decision);
  if (!isValidAoiAutonomyId(item.id)) {
    throw new Error('Invalid decision id.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, item.sessionPath);
  writeJsonAtomic(join(paths.decisionsDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiProposalDecisions(
  sessionsDir: string,
  sessionPath: string,
): AoiProposalDecision[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<AoiProposalDecision>(paths.decisionsDir)
    .filter((item) => item.version === 1 && isValidAoiAutonomyId(item.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function applyAoiProposalDecision(
  sessionsDir: string,
  sessionPath: string,
  input: AoiProposalDecisionInput,
): AoiProposalDecisionResult {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(input.proposalId)) {
    throw new Error('Invalid or missing proposalId.');
  }
  if (input.action !== 'accept' && input.action !== 'dismiss' && input.action !== 'snooze') {
    throw new Error('Invalid proposal decision action.');
  }
  const now = input.now ?? Date.now();
  const policy = loadAoiAutonomyPolicy(sessionsDir, normalizedSessionPath);
  const activeProposals = loadAoiActiveProposals(sessionsDir, normalizedSessionPath);
  const archivedProposals = loadAoiArchivedProposals(sessionsDir, normalizedSessionPath);
  const index = activeProposals.findIndex((proposal) => proposal.id === input.proposalId);
  if (index < 0) {
    throw new Error('Aoi proposal not found.');
  }
  const current = activeProposals[index];
  if (current.status !== 'active' && current.status !== 'snoozed') {
    throw new Error(`Cannot ${input.action} proposal while status is ${current.status}.`);
  }
  const nextStatus =
    input.action === 'accept' ? 'accepted' : input.action === 'snooze' ? 'snoozed' : 'dismissed';
  const snoozedUntil =
    input.action === 'snooze'
      ? now + (input.snoozeMs && input.snoozeMs > 0 ? input.snoozeMs : policy.defaultSnoozeMs)
      : undefined;
  const nextProposal: AoiProposal = {
    ...current,
    status: nextStatus,
    updatedAt: now,
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
  const decision: AoiProposalDecision = {
    version: 1,
    id: createAoiAutonomyId('aoi-decision', now),
    proposalId: current.id,
    sessionPath: normalizedSessionPath,
    cooldownKey: current.cooldownKey,
    action: input.action,
    actor: input.actor ?? 'user',
    createdAt: now,
    previousStatus: current.status,
    nextStatus,
    ...(typeof input.reason === 'string' && input.reason.trim()
      ? { reason: input.reason.trim().slice(0, 240) }
      : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };

  let nextActive = [...activeProposals];
  let nextArchived = [...archivedProposals];
  if (nextStatus === 'dismissed') {
    nextActive = activeProposals.filter((proposal) => proposal.id !== current.id);
    nextArchived = [nextProposal, ...nextArchived.filter((proposal) => proposal.id !== current.id)];
  } else {
    nextActive[index] = nextProposal;
  }
  saveAoiActiveProposals(sessionsDir, normalizedSessionPath, nextActive);
  saveAoiArchivedProposals(sessionsDir, normalizedSessionPath, nextArchived);
  appendAoiProposalDecision(sessionsDir, decision);
  upsertAoiObservation(sessionsDir, makeProposalDecisionObservation(nextProposal, decision));
  recordAoiProposalDecisionRelations(
    sessionsDir,
    normalizedSessionPath,
    nextProposal,
    decision,
    now,
  );
  return {
    proposal: nextProposal,
    decision,
    activeProposals: nextActive,
    archivedProposals: nextArchived,
  };
}

export function applyAoiProposalExecutionTransition(
  sessionsDir: string,
  sessionPath: string,
  input: AoiProposalExecutionTransitionInput,
): AoiProposalDecisionResult {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(input.proposalId)) {
    throw new Error('Invalid or missing proposalId.');
  }
  if (input.nextStatus !== 'executed' && input.nextStatus !== 'blocked') {
    throw new Error('Invalid proposal execution status.');
  }

  const now = input.now ?? Date.now();
  const activeProposals = loadAoiActiveProposals(sessionsDir, normalizedSessionPath);
  const archivedProposals = loadAoiArchivedProposals(sessionsDir, normalizedSessionPath);
  const index = activeProposals.findIndex((proposal) => proposal.id === input.proposalId);
  if (index < 0) {
    throw new Error('Aoi proposal not found.');
  }

  const current = activeProposals[index];
  const nextProposal: AoiProposal = {
    ...current,
    status: input.nextStatus,
    updatedAt: now,
    ...(input.nextStatus === 'blocked' && input.reason
      ? { blockedReason: input.reason.trim().slice(0, 240) }
      : {}),
  };
  const decision: AoiProposalDecision = {
    version: 1,
    id: createAoiAutonomyId('aoi-decision', now),
    proposalId: current.id,
    sessionPath: normalizedSessionPath,
    cooldownKey: current.cooldownKey,
    action: input.nextStatus === 'executed' ? 'execute' : 'block',
    actor: input.actor ?? 'system',
    createdAt: now,
    previousStatus: current.status,
    nextStatus: input.nextStatus,
    ...(typeof input.reason === 'string' && input.reason.trim()
      ? { reason: input.reason.trim().slice(0, 240) }
      : {}),
  };
  const nextActive = [...activeProposals];
  nextActive[index] = nextProposal;
  saveAoiActiveProposals(sessionsDir, normalizedSessionPath, nextActive);
  appendAoiProposalDecision(sessionsDir, decision);
  upsertAoiObservation(sessionsDir, makeProposalDecisionObservation(nextProposal, decision));
  recordAoiProposalDecisionRelations(
    sessionsDir,
    normalizedSessionPath,
    nextProposal,
    decision,
    now,
  );

  return {
    proposal: nextProposal,
    decision,
    activeProposals: nextActive,
    archivedProposals,
  };
}

export function buildAoiAutonomyStatus(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiAutonomyStatus {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const policy = loadAoiAutonomyPolicy(sessionsDir, normalizedSessionPath);
  const activeProposals = loadAoiActiveProposals(sessionsDir, normalizedSessionPath);
  const archivedProposals = loadAoiArchivedProposals(sessionsDir, normalizedSessionPath);
  const observations = loadAoiObservations(sessionsDir, normalizedSessionPath);
  const reflections = loadAoiReflections(sessionsDir, normalizedSessionPath);
  const decisions = loadAoiProposalDecisions(sessionsDir, normalizedSessionPath);
  const tickState = loadAoiAutonomyTickState(sessionsDir, normalizedSessionPath, now);
  const activeGoals = loadAoiActiveGoals(sessionsDir, normalizedSessionPath).filter(
    (goal) => goal.status === 'active' || goal.status === 'blocked' || goal.status === 'paused',
  );
  const currentGoal = activeGoals[0];
  const nextGoalStep = currentGoal?.plan.steps.find(
    (step) => step.status === 'pending' || step.status === 'blocked',
  );
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    policy,
    activeProposalCount: activeProposals.filter((proposal) => proposal.status === 'active').length,
    archivedProposalCount: archivedProposals.length,
    acceptedProposalCount: activeProposals.filter((proposal) => proposal.status === 'accepted')
      .length,
    snoozedProposalCount: activeProposals.filter((proposal) => proposal.status === 'snoozed')
      .length,
    blockedProposalCount: [...activeProposals, ...archivedProposals].filter(
      (proposal) => proposal.status === 'blocked',
    ).length,
    observationCount: observations.length,
    reflectionCount: reflections.length,
    decisionCount: decisions.length,
    lastDecisionAt: decisions[0]?.createdAt,
    lastObservationAt: observations[0]?.createdAt,
    lastReflectionAt: reflections[0]?.createdAt,
    lastTickAt: tickState.lastTickAt,
    nextAllowedTickAt: tickState.nextAllowedTickAt,
    lastTickReason: tickState.lastTickReason,
    activeTick: tickState.activeTick,
    recentObservationCount: tickState.recentObservationCount || observations.length,
    proposalsCreatedInLastTick: tickState.proposalsCreatedInLastTick,
    activeGoalCount: activeGoals.length,
    currentGoalTitle: currentGoal?.title,
    nextGoalStepTitle: nextGoalStep?.title,
    updatedAt: now,
  };
}
