import * as fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  isAoiEnvironmentSourceQuietModeBehavior,
  isAoiProposalFeedbackCategory,
  normalizeAoiEnvironmentSourceRegistry,
  normalizeAoiAutonomyPolicy,
} from './aoiAutonomyPolicy';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
  normalizeAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import {
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
  normalizeAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import {
  createAoiApprovedAppActionRequest,
  evaluateAoiApprovedAppActionPolicy,
  normalizeAoiApprovedAppActionPolicy,
} from './aoiApprovedAppActionPolicy';
import {
  buildAoiFollowThroughEventFromOpportunity,
  buildAoiFollowThroughEventFromProposalDecision,
  buildAoiFollowThroughLearningSummary,
  buildAoiFollowThroughSummaryIndex,
  normalizeAoiFollowThroughEvent,
} from './aoiFollowThroughLearning';
import {
  buildAoiFollowThroughEventFromOutcomeSignal,
  buildAoiOutcomeLearningSummary,
  normalizeAoiOutcomeSignalRecord,
  type AoiOutcomeSignalInput,
} from './aoiOutcomeLearning';
import { loadAoiActiveGoals } from './aoiAutonomyGoals';
import { recordAoiProposalDecisionRelations } from './aoiAutonomyRelations';
import {
  buildAoiFieldShadowRecordReport,
  normalizeAoiFieldShadowDecisionRecord,
  pruneExpiredAoiFieldShadowRecords,
  type AoiFieldShadowDecisionRecord,
  type AoiFieldShadowRecordReport,
  type AoiFieldShadowRecorderInput,
} from './aoiFieldShadowDogfooding';
import {
  createAoiOperatorFeedbackLabelAction,
  normalizeAoiOperatorFeedbackLabelAction,
  type AoiOperatorFeedbackLabelAction,
  type AoiOperatorFeedbackLabelInput,
} from './aoiOperatorFeedbackInbox';
import type {
  AoiAutonomyPolicy,
  AoiAutonomyStatus,
  AoiAutonomyTickReason,
  AoiAutonomyTickState,
  AoiCommandAuditRecord,
  AoiFileMutationAuditRecord,
  AoiAppActionAuditRecord,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiFollowThroughEvent,
  AoiFollowThroughLearningSummary,
  AoiFollowThroughSummaryIndex,
  AoiObservation,
  AoiObservationIndex,
  AoiObservationIndexEntry,
  AoiOpportunity,
  AoiOutcomeLearningSummary,
  AoiOutcomeSignalRecord,
  AoiProposal,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiProposalFeedbackCategory,
  AoiReflection,
} from './aoiAutonomyTypes';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const MAX_LIST_ITEMS = 200;
const OBSERVATION_INDEX_FILE = 'index.json';
const MAX_OBSERVATION_INDEX_ITEMS = 200;
const MAX_OBSERVATION_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const AOI_OPPORTUNITY_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const AOI_OPPORTUNITY_DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;
const MAX_FOLLOW_THROUGH_EVENTS = 500;
const MAX_FOLLOW_THROUGH_INDEX_ITEMS = 80;
const MAX_OUTCOME_SIGNAL_RECORDS = 500;

export { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';

export interface AoiAutonomyPaths {
  root: string;
  policy: string;
  observationsDir: string;
  observationsIndex: string;
  reflectionsDir: string;
  proposalsDir: string;
  activeProposals: string;
  archivedProposals: string;
  opportunitiesDir: string;
  activeOpportunities: string;
  archivedOpportunities: string;
  playbooksDir: string;
  activePlaybooks: string;
  archivedPlaybooks: string;
  decisionsDir: string;
  commandAuditDir: string;
  fileMutationAuditDir: string;
  appActionAuditDir: string;
  tickState: string;
  evalDir: string;
  environmentSources: string;
  timelineDir: string;
  timelineEvents: string;
  timelineExportsDir: string;
  fieldShadowDir: string;
  fieldShadowRecords: string;
  fieldShadowFeedbackLabels: string;
  schedulerState: string;
  proactiveInterestProfile: string;
  proactiveBriefsDir: string;
  proactiveBriefsIndex: string;
  proactiveBriefCandidatesDir: string;
  proactiveBriefFeedbackDir: string;
  proactiveBriefCooldowns: string;
  proactiveBriefFieldEventsDir: string;
  proactiveBriefFieldEventIndex: string;
  proactiveBriefFieldEventRecordsDir: string;
  proactiveBriefFieldMetrics: string;
  proactiveBriefCalibrationLabelsDir: string;
  proactiveBriefCalibrationLabelIndex: string;
  proactiveBriefCalibrationLabelRecordsDir: string;
  proactiveBriefCalibrationTuning: string;
  proactiveTrendsDir: string;
  proactiveTrendWatchProfile: string;
  proactiveTrendSnapshotsDir: string;
  proactiveTrendSnapshotIndex: string;
  proactiveTrendDeliveryEventsDir: string;
  proactiveTrendDeliveryEventIndex: string;
  proactiveTrendDeliveryEventRecordsDir: string;
  followThroughDir: string;
  followThroughEvents: string;
  followThroughSummaryIndex: string;
  outcomeLearningDir: string;
  outcomeSignals: string;
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
  feedbackCategory?: unknown;
  feedbackNote?: unknown;
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

export interface AoiProposalFeedbackInput {
  decisionId: string;
  feedbackCategory: unknown;
  feedbackNote?: unknown;
}

export interface AoiEnvironmentSourceUpdateInput {
  sourceId: string;
  patch: Partial<AoiEnvironmentSource>;
  now?: number;
}

export interface AoiProposalDecisionResult {
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  activeProposals: AoiProposal[];
  archivedProposals: AoiProposal[];
}

export interface AoiOpportunityInbox {
  sessionPath: string;
  active: AoiOpportunity[];
  archived: AoiOpportunity[];
}

export interface AoiOpportunityUpsertInput {
  id?: unknown;
  sourceKind?: unknown;
  title?: unknown;
  curiosityQuestion?: unknown;
  whyNow?: unknown;
  evidenceNeed?: unknown;
  suggestedNextAction?: unknown;
  risk?: unknown;
  confidence?: unknown;
  urgency?: unknown;
  novelty?: unknown;
  deliveryRecommendation?: unknown;
  status?: unknown;
  evidenceRefs?: unknown;
  dedupeKey?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  snoozedUntil?: unknown;
}

export interface AoiOpportunityUpsertResult extends AoiOpportunityInbox {
  opportunity: AoiOpportunity;
  created: boolean;
}

export interface AoiOpportunityStatusTransitionResult extends AoiOpportunityInbox {
  opportunity: AoiOpportunity;
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

function appendJsonLine(filePath: string, value: unknown): void {
  ensureDirectory(filePath, true);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
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

function isAoiObservationSource(value: unknown): value is AoiObservation['source'] {
  return (
    value === 'chat' ||
    value === 'tool' ||
    value === 'research_run' ||
    value === 'kira' ||
    value === 'proposal' ||
    value === 'memory' ||
    value === 'workspace' ||
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

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return normalized || undefined;
}

function normalizeAoiProposalFeedbackCategory(
  value: unknown,
): AoiProposalFeedbackCategory | undefined {
  return isAoiProposalFeedbackCategory(value) ? value : undefined;
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

export function isValidAoiAutonomyId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$/.test(value);
}

export function createAoiAutonomyId(prefix: string, now = Date.now()): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'aoi';
  return `${safePrefix}-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

// Discover every session under sessionsDir that has an initialized Aoi
// autonomy store (an aoi-autonomy/policy.json). Used by the background runner
// to know which sessions to tick on its own. Bounded by maxDepth and never
// descends into the autonomy data dir itself.
export function listAoiAutonomySessionPaths(
  sessionsDir: string,
  options: { maxDepth?: number } = {},
): string[] {
  const root = resolve(sessionsDir);
  const maxDepth = Math.max(1, options.maxDepth ?? 6);
  const found = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === AUTONOMY_ROOT_DIR) {
        if (fs.existsSync(join(dir, AUTONOMY_ROOT_DIR, 'policy.json'))) {
          const rel = relative(root, dir).replace(/\\/g, '/');
          const normalized = normalizeAoiAutonomySessionPath(rel);
          if (normalized) {
            found.add(normalized);
          }
        }
        continue;
      }
      if (depth < maxDepth) {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(root, 1);
  return [...found];
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
  const opportunitiesDir = join(root, 'opportunities');
  const playbooksDir = join(root, 'playbooks');
  const timelineDir = join(root, 'timeline');
  const fieldShadowDir = join(root, 'field-shadow');
  const proactiveBriefsDir = join(root, 'proactive-briefs');
  const proactiveBriefFieldEventsDir = join(proactiveBriefsDir, 'field-events');
  const proactiveBriefCalibrationLabelsDir = join(proactiveBriefsDir, 'calibration-labels');
  const proactiveTrendsDir = join(root, 'proactive-trends');
  const proactiveTrendDeliveryEventsDir = join(proactiveTrendsDir, 'delivery-events');
  const followThroughDir = join(root, 'follow-through');
  const outcomeLearningDir = join(root, 'outcome-learning');
  return {
    root,
    policy: join(root, 'policy.json'),
    observationsDir: join(root, 'observations'),
    observationsIndex: join(root, 'observations', OBSERVATION_INDEX_FILE),
    reflectionsDir: join(root, 'reflections'),
    proposalsDir,
    activeProposals: join(proposalsDir, 'active.json'),
    archivedProposals: join(proposalsDir, 'archived.json'),
    opportunitiesDir,
    activeOpportunities: join(opportunitiesDir, 'active.json'),
    archivedOpportunities: join(opportunitiesDir, 'archived.json'),
    playbooksDir,
    activePlaybooks: join(playbooksDir, 'active.json'),
    archivedPlaybooks: join(playbooksDir, 'archived.json'),
    decisionsDir: join(root, 'decisions'),
    commandAuditDir: join(root, 'command-audit'),
    fileMutationAuditDir: join(root, 'file-mutation-audit'),
    appActionAuditDir: join(root, 'app-action-audit'),
    tickState: join(root, 'tick-state.json'),
    evalDir: join(root, 'eval'),
    environmentSources: join(root, 'environment-sources.json'),
    timelineDir,
    timelineEvents: join(timelineDir, 'events.jsonl'),
    timelineExportsDir: join(timelineDir, 'exports'),
    fieldShadowDir,
    fieldShadowRecords: join(fieldShadowDir, 'records.json'),
    fieldShadowFeedbackLabels: join(fieldShadowDir, 'feedback-labels.json'),
    schedulerState: join(root, 'scheduler-state.json'),
    proactiveInterestProfile: join(root, 'proactive-interest-profile.json'),
    proactiveBriefsDir,
    proactiveBriefsIndex: join(proactiveBriefsDir, 'index.json'),
    proactiveBriefCandidatesDir: join(proactiveBriefsDir, 'candidates'),
    proactiveBriefFeedbackDir: join(proactiveBriefsDir, 'feedback'),
    proactiveBriefCooldowns: join(proactiveBriefsDir, 'cooldowns.json'),
    proactiveBriefFieldEventsDir,
    proactiveBriefFieldEventIndex: join(proactiveBriefFieldEventsDir, 'index.json'),
    proactiveBriefFieldEventRecordsDir: join(proactiveBriefFieldEventsDir, 'events'),
    proactiveBriefFieldMetrics: join(proactiveBriefsDir, 'field-metrics.json'),
    proactiveBriefCalibrationLabelsDir,
    proactiveBriefCalibrationLabelIndex: join(proactiveBriefCalibrationLabelsDir, 'index.json'),
    proactiveBriefCalibrationLabelRecordsDir: join(proactiveBriefCalibrationLabelsDir, 'labels'),
    proactiveBriefCalibrationTuning: join(proactiveBriefsDir, 'calibration-tuning.json'),
    proactiveTrendsDir,
    proactiveTrendWatchProfile: join(proactiveTrendsDir, 'watch-profile.json'),
    proactiveTrendSnapshotsDir: join(proactiveTrendsDir, 'snapshots'),
    proactiveTrendSnapshotIndex: join(proactiveTrendsDir, 'snapshot-index.json'),
    proactiveTrendDeliveryEventsDir,
    proactiveTrendDeliveryEventIndex: join(proactiveTrendDeliveryEventsDir, 'index.json'),
    proactiveTrendDeliveryEventRecordsDir: join(proactiveTrendDeliveryEventsDir, 'events'),
    followThroughDir,
    followThroughEvents: join(followThroughDir, 'events.jsonl'),
    followThroughSummaryIndex: join(followThroughDir, 'summary-index.json'),
    outcomeLearningDir,
    outcomeSignals: join(outcomeLearningDir, 'signals.jsonl'),
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

export function loadAoiEnvironmentSourceRegistry(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiEnvironmentSourceRegistry {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return normalizeAoiEnvironmentSourceRegistry(
    readJson<Partial<AoiEnvironmentSourceRegistry>>(paths.environmentSources),
    normalizedSessionPath,
    now,
  );
}

export function saveAoiEnvironmentSourceRegistry(
  sessionsDir: string,
  sessionPath: string,
  registry: unknown,
  now = Date.now(),
): AoiEnvironmentSourceRegistry {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const normalized = normalizeAoiEnvironmentSourceRegistry(registry, normalizedSessionPath, now);
  writeJsonAtomic(paths.environmentSources, normalized);
  return normalized;
}

export function updateAoiEnvironmentSource(
  sessionsDir: string,
  sessionPath: string,
  input: AoiEnvironmentSourceUpdateInput,
): AoiEnvironmentSourceRegistry {
  const now = input.now ?? Date.now();
  const current = loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath, now);
  const target = current.sources.find((source) => source.id === input.sourceId);
  if (!target) {
    throw new Error('Aoi environment source not found.');
  }
  const nextConsentReason = Object.prototype.hasOwnProperty.call(input.patch, 'consentReason')
    ? normalizeOptionalText(input.patch.consentReason, 180)
    : target.consentReason;
  const nextLastObservedAt = Object.prototype.hasOwnProperty.call(input.patch, 'lastObservedAt')
    ? typeof input.patch.lastObservedAt === 'number'
      ? input.patch.lastObservedAt
      : undefined
    : target.lastObservedAt;
  const nextLastReviewedAt = Object.prototype.hasOwnProperty.call(input.patch, 'lastReviewedAt')
    ? typeof input.patch.lastReviewedAt === 'number' && input.patch.lastReviewedAt > 0
      ? input.patch.lastReviewedAt
      : undefined
    : target.lastReviewedAt;
  const nextQuietModeBehavior = isAoiEnvironmentSourceQuietModeBehavior(
    input.patch.quietModeBehavior,
  )
    ? input.patch.quietModeBehavior
    : target.quietModeBehavior;
  const next: AoiEnvironmentSourceRegistry = {
    ...current,
    sources: current.sources.map((source) =>
      source.id === input.sourceId
        ? {
            ...source,
            enabled:
              typeof input.patch.enabled === 'boolean' ? input.patch.enabled : source.enabled,
            quietModeBehavior: nextQuietModeBehavior,
            consentReason: nextConsentReason,
            lastObservedAt: nextLastObservedAt,
            lastReviewedAt: nextLastReviewedAt,
            updatedAt: now,
          }
        : source,
    ),
    updatedAt: now,
  };
  return saveAoiEnvironmentSourceRegistry(sessionsDir, sessionPath, next, now);
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

function makeAoiProposalDecisionRecord(params: {
  proposal: AoiProposal;
  sessionPath: string;
  action: AoiProposalDecisionAction;
  actor: 'user' | 'system';
  previousStatus: AoiProposal['status'];
  nextStatus: AoiProposal['status'];
  now: number;
  reason?: unknown;
  feedbackCategory?: unknown;
  feedbackNote?: unknown;
  snoozedUntil?: number;
}): AoiProposalDecision {
  const reason = normalizeOptionalText(params.reason, 240);
  const feedbackCategory = normalizeAoiProposalFeedbackCategory(params.feedbackCategory);
  const feedbackNote = normalizeOptionalText(params.feedbackNote, 240);
  const actionParams = params.proposal.acceptAction?.params ?? {};
  const approvedCommand =
    params.action === 'accept' && params.proposal.acceptAction?.kind === 'run_command'
      ? evaluateAoiApprovedCommandPolicy(
          createAoiApprovedCommandRequest({
            sessionPath: params.sessionPath,
            proposalId: params.proposal.id,
            command: actionParams.command,
            cwd: actionParams.cwd ?? actionParams.directory,
            purpose: actionParams.purpose ?? params.proposal.title,
            risk: params.proposal.risk,
            timeoutMs: actionParams.timeoutMs ?? actionParams.timeout_ms,
            requestedAt: params.now,
            evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
          }),
        )
      : undefined;
  const fileMutationKind = params.proposal.acceptAction?.kind;
  const approvedFileMutation =
    params.action === 'accept' &&
    (fileMutationKind === 'file_write' ||
      fileMutationKind === 'file_patch' ||
      fileMutationKind === 'file_delete')
      ? evaluateAoiApprovedFileMutationPolicy(
          createAoiApprovedFileMutationRequest({
            sessionPath: params.sessionPath,
            proposalId: params.proposal.id,
            operation:
              fileMutationKind === 'file_patch'
                ? 'patch'
                : fileMutationKind === 'file_delete'
                  ? 'delete'
                  : 'write',
            path: actionParams.path,
            content: actionParams.content,
            patchOps: actionParams.patchOps ?? actionParams.patch_ops,
            purpose: actionParams.purpose ?? params.proposal.title,
            risk: params.proposal.risk,
            requestedAt: params.now,
            evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
          }),
        )
      : undefined;
  const approvedAppAction =
    params.action === 'accept' && params.proposal.acceptAction?.kind === 'app_action'
      ? evaluateAoiApprovedAppActionPolicy(
          createAoiApprovedAppActionRequest({
            sessionPath: params.sessionPath,
            proposalId: params.proposal.id,
            appReference: actionParams.appReference ?? actionParams.appName ?? actionParams.app,
            capabilityId: actionParams.capabilityId,
            intentReference: actionParams.intentReference ?? actionParams.intent,
            actionType: actionParams.actionType ?? actionParams.action,
            requestedOperation: actionParams.requestedOperation ?? actionParams.operation,
            operationParams: actionParams.operationParams ?? actionParams.actionParams,
            path: actionParams.path,
            content: actionParams.content,
            patchOps: actionParams.patchOps ?? actionParams.patch_ops,
            purpose: actionParams.purpose ?? params.proposal.title,
            risk: params.proposal.risk,
            requestedAt: params.now,
            evidenceRefs: [...params.proposal.evidenceRefs, ...params.proposal.artifactRefs],
          }),
        )
      : undefined;
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-decision', params.now),
    proposalId: params.proposal.id,
    sessionPath: params.sessionPath,
    cooldownKey: params.proposal.cooldownKey,
    action: params.action,
    actor: params.actor,
    createdAt: params.now,
    previousStatus: params.previousStatus,
    nextStatus: params.nextStatus,
    ...(reason ? { reason } : {}),
    ...(feedbackCategory ? { feedbackCategory } : {}),
    ...(feedbackCategory && feedbackNote ? { feedbackNote } : {}),
    ...(params.snoozedUntil ? { snoozedUntil: params.snoozedUntil } : {}),
    proposalTrigger: params.proposal.trigger,
    proposalRisk: params.proposal.risk,
    ...(params.proposal.acceptAction ? { actionKind: params.proposal.acceptAction.kind } : {}),
    suggestedTools: normalizeStringList(params.proposal.suggestedTools, 12),
    evidenceRefs: normalizeStringList(params.proposal.evidenceRefs, 24),
    memoryIds: normalizeStringList(params.proposal.memoryIds, 24),
    ...(approvedCommand ? { approvedCommand } : {}),
    ...(approvedFileMutation ? { approvedFileMutation } : {}),
    ...(approvedAppAction ? { approvedAppAction } : {}),
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

function isAoiOpportunitySourceKind(value: unknown): value is AoiOpportunity['sourceKind'] {
  return (
    value === 'memory' ||
    value === 'interest' ||
    value === 'workspace' ||
    value === 'kira' ||
    value === 'research' ||
    value === 'app_state' ||
    value === 'agenda' ||
    value === 'manual'
  );
}

function isAoiOpportunityDeliveryRecommendation(
  value: unknown,
): value is AoiOpportunity['deliveryRecommendation'] {
  return (
    value === 'dashboard' ||
    value === 'inline_card' ||
    value === 'quiet_notification' ||
    value === 'direct_chat'
  );
}

function isAoiOpportunityStatus(value: unknown): value is AoiOpportunity['status'] {
  return (
    value === 'active' ||
    value === 'accepted' ||
    value === 'dismissed' ||
    value === 'snoozed' ||
    value === 'converted' ||
    value === 'expired' ||
    value === 'archived'
  );
}

function isAoiOpportunityRisk(value: unknown): value is AoiOpportunity['risk'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isArchivedAoiOpportunityStatus(status: AoiOpportunity['status']): boolean {
  return (
    status === 'accepted' ||
    status === 'dismissed' ||
    status === 'converted' ||
    status === 'expired' ||
    status === 'archived'
  );
}

function normalizeAoiOpportunityScore(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, numeric));
}

function normalizeAoiOpportunityTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function normalizeAoiOpportunityRequiredText(
  value: unknown,
  fallback: string,
  maxChars: number,
): string {
  return normalizeOptionalText(value, maxChars) ?? fallback;
}

function normalizeAoiOpportunityDedupeKey(value: unknown, fallback: string): string {
  const normalized =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 180) : fallback;
  return normalized || fallback;
}

function buildAoiOpportunityDedupeFallback(
  raw: Partial<AoiOpportunity>,
  sourceKind: AoiOpportunity['sourceKind'],
  id: string,
): string {
  const semanticParts = [
    sourceKind,
    normalizeOptionalText(raw.title, 80),
    normalizeOptionalText(raw.curiosityQuestion, 120),
    normalizeOptionalText(raw.suggestedNextAction, 80),
  ].filter((part): part is string => Boolean(part));
  const semanticKey = semanticParts
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return semanticKey ? `opportunity:${semanticKey}` : `opportunity:${sourceKind}:${id}`;
}

function normalizeAoiOpportunityRecord(
  value: unknown,
  sessionPath: string,
  now = Date.now(),
): AoiOpportunity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiOpportunity>;
  const id = isValidAoiAutonomyId(raw.id) ? raw.id : createAoiAutonomyId('aoi-opportunity', now);
  const sourceKind = isAoiOpportunitySourceKind(raw.sourceKind) ? raw.sourceKind : 'manual';
  const fallbackDedupeKey = buildAoiOpportunityDedupeFallback(raw, sourceKind, id);
  const status = isAoiOpportunityStatus(raw.status) ? raw.status : 'active';
  const createdAt = normalizeAoiOpportunityTimestamp(raw.createdAt, now);
  const updatedAt = normalizeAoiOpportunityTimestamp(raw.updatedAt, now);
  const expiresAt = normalizeAoiOpportunityTimestamp(
    raw.expiresAt,
    createdAt + AOI_OPPORTUNITY_DEFAULT_TTL_MS,
  );
  const snoozedUntil =
    status === 'snoozed'
      ? normalizeAoiOpportunityTimestamp(raw.snoozedUntil, now + AOI_OPPORTUNITY_DEFAULT_SNOOZE_MS)
      : undefined;
  const archivedAt = isArchivedAoiOpportunityStatus(status)
    ? normalizeAoiOpportunityTimestamp(raw.archivedAt, updatedAt)
    : undefined;

  return {
    version: 1,
    id,
    sessionPath,
    sourceKind,
    title: normalizeAoiOpportunityRequiredText(raw.title, 'Untitled opportunity', 160),
    curiosityQuestion: normalizeAoiOpportunityRequiredText(
      raw.curiosityQuestion,
      'What should Aoi inspect next?',
      240,
    ),
    whyNow: normalizeAoiOpportunityRequiredText(
      raw.whyNow,
      'Aoi recorded this as a proactive observation candidate.',
      300,
    ),
    evidenceNeed: normalizeAoiOpportunityRequiredText(
      raw.evidenceNeed,
      'Needs evidence before becoming an action.',
      300,
    ),
    suggestedNextAction: normalizeAoiOpportunityRequiredText(
      raw.suggestedNextAction,
      'Keep this visible in the Opportunity Inbox.',
      260,
    ),
    risk: isAoiOpportunityRisk(raw.risk) ? raw.risk : 'low',
    confidence: normalizeAoiOpportunityScore(raw.confidence, 0.5),
    urgency: normalizeAoiOpportunityScore(raw.urgency, 0.4),
    novelty: normalizeAoiOpportunityScore(raw.novelty, 0.5),
    deliveryRecommendation: isAoiOpportunityDeliveryRecommendation(raw.deliveryRecommendation)
      ? raw.deliveryRecommendation
      : 'dashboard',
    status,
    evidenceRefs: normalizeStringList(raw.evidenceRefs, 24),
    dedupeKey: normalizeAoiOpportunityDedupeKey(raw.dedupeKey, fallbackDedupeKey),
    createdAt,
    updatedAt,
    expiresAt,
    ...(snoozedUntil ? { snoozedUntil } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function loadAoiOpportunityList(
  filePath: string,
  sessionPath: string,
  now = Date.now(),
): AoiOpportunity[] {
  const parsed = readJson<unknown>(filePath);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => normalizeAoiOpportunityRecord(item, sessionPath, now))
    .filter((item): item is AoiOpportunity => item !== null)
    .slice(0, MAX_LIST_ITEMS);
}

function splitExpiredAoiOpportunities(
  active: AoiOpportunity[],
  archived: AoiOpportunity[],
  now = Date.now(),
): {
  active: AoiOpportunity[];
  archived: AoiOpportunity[];
  changed: boolean;
} {
  const retainedActive: AoiOpportunity[] = [];
  const expired: AoiOpportunity[] = [];
  for (const opportunity of active) {
    if (
      opportunity.expiresAt <= now &&
      (opportunity.status === 'active' || opportunity.status === 'snoozed')
    ) {
      expired.push({
        ...opportunity,
        status: 'expired',
        updatedAt: Math.max(now, opportunity.updatedAt),
        archivedAt: Math.max(now, opportunity.updatedAt),
        snoozedUntil: undefined,
        actionAuthority: 'display_only',
        mutationCount: 0,
      });
      continue;
    }
    retainedActive.push(opportunity);
  }

  if (expired.length === 0) {
    return {
      active,
      archived,
      changed: false,
    };
  }

  const archivedById = new Map<string, AoiOpportunity>();
  for (const item of [...archived, ...expired]) {
    archivedById.set(item.id, item);
  }
  return {
    active: retainedActive,
    archived: [...archivedById.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_LIST_ITEMS),
    changed: true,
  };
}

function reconcileAoiOpportunityInbox(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiOpportunityInbox {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const active = loadAoiOpportunityList(paths.activeOpportunities, normalizedSessionPath, now);
  const archived = loadAoiOpportunityList(paths.archivedOpportunities, normalizedSessionPath, now);
  const reconciled = splitExpiredAoiOpportunities(active, archived, now);
  if (reconciled.changed) {
    writeJsonAtomic(paths.activeOpportunities, reconciled.active);
    writeJsonAtomic(paths.archivedOpportunities, reconciled.archived);
  }
  return {
    sessionPath: normalizedSessionPath,
    active: reconciled.active,
    archived: reconciled.archived,
  };
}

export function loadAoiOpportunityInbox(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiOpportunityInbox {
  return reconcileAoiOpportunityInbox(sessionsDir, sessionPath, now);
}

export function loadAoiActiveOpportunities(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiOpportunity[] {
  return reconcileAoiOpportunityInbox(sessionsDir, sessionPath, now).active;
}

export function loadAoiArchivedOpportunities(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiOpportunity[] {
  return reconcileAoiOpportunityInbox(sessionsDir, sessionPath, now).archived;
}

export function saveAoiActiveOpportunities(
  sessionsDir: string,
  sessionPath: string,
  opportunities: AoiOpportunity[],
): AoiOpportunity[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const normalized = opportunities
    .map((item) => normalizeAoiOpportunityRecord(item, normalizedSessionPath, item.updatedAt))
    .filter((item): item is AoiOpportunity => item !== null)
    .filter((item) => !isArchivedAoiOpportunityStatus(item.status))
    .slice(0, MAX_LIST_ITEMS);
  writeJsonAtomic(paths.activeOpportunities, normalized);
  return normalized;
}

export function saveAoiArchivedOpportunities(
  sessionsDir: string,
  sessionPath: string,
  opportunities: AoiOpportunity[],
): AoiOpportunity[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const normalized = opportunities
    .map((item) => normalizeAoiOpportunityRecord(item, normalizedSessionPath, item.updatedAt))
    .filter((item): item is AoiOpportunity => item !== null)
    .filter((item) => isArchivedAoiOpportunityStatus(item.status))
    .slice(0, MAX_LIST_ITEMS);
  writeJsonAtomic(paths.archivedOpportunities, normalized);
  return normalized;
}

function buildAoiOpportunityFromInput(
  input: AoiOpportunityUpsertInput,
  sessionPath: string,
  now: number,
  existing?: AoiOpportunity,
): AoiOpportunity {
  const nextStatus =
    existing?.status === 'snoozed' && (existing.snoozedUntil ?? 0) > now
      ? 'snoozed'
      : input.status === 'snoozed'
        ? 'snoozed'
        : 'active';
  const nextSnoozedUntil =
    nextStatus === 'snoozed'
      ? normalizeAoiOpportunityTimestamp(
          input.snoozedUntil,
          existing?.snoozedUntil && existing.snoozedUntil > now
            ? existing.snoozedUntil
            : now + AOI_OPPORTUNITY_DEFAULT_SNOOZE_MS,
        )
      : undefined;
  const normalized = normalizeAoiOpportunityRecord(
    {
      version: 1,
      id: existing?.id ?? input.id,
      sessionPath,
      sourceKind: input.sourceKind ?? existing?.sourceKind,
      title: input.title ?? existing?.title,
      curiosityQuestion: input.curiosityQuestion ?? existing?.curiosityQuestion,
      whyNow: input.whyNow ?? existing?.whyNow,
      evidenceNeed: input.evidenceNeed ?? existing?.evidenceNeed,
      suggestedNextAction: input.suggestedNextAction ?? existing?.suggestedNextAction,
      risk: input.risk ?? existing?.risk,
      confidence: input.confidence ?? existing?.confidence,
      urgency: input.urgency ?? existing?.urgency,
      novelty: input.novelty ?? existing?.novelty,
      deliveryRecommendation: input.deliveryRecommendation ?? existing?.deliveryRecommendation,
      status: nextStatus,
      evidenceRefs: input.evidenceRefs ?? existing?.evidenceRefs,
      dedupeKey: input.dedupeKey ?? existing?.dedupeKey,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? now + AOI_OPPORTUNITY_DEFAULT_TTL_MS,
      snoozedUntil: nextSnoozedUntil,
      actionAuthority: 'display_only',
      mutationCount: 0,
    },
    sessionPath,
    now,
  );
  if (!normalized) {
    throw new Error('Invalid Aoi opportunity input.');
  }
  return normalized;
}

export function upsertAoiOpportunity(
  sessionsDir: string,
  sessionPath: string,
  input: AoiOpportunityUpsertInput,
  now = Date.now(),
): AoiOpportunityUpsertResult {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const inbox = reconcileAoiOpportunityInbox(sessionsDir, normalizedSessionPath, now);
  const probe = buildAoiOpportunityFromInput(input, normalizedSessionPath, now);
  const existingIndex = inbox.active.findIndex(
    (item) => item.dedupeKey === probe.dedupeKey && item.expiresAt > now,
  );
  const existing = existingIndex >= 0 ? inbox.active[existingIndex] : undefined;
  const opportunity = buildAoiOpportunityFromInput(input, normalizedSessionPath, now, existing);
  const nextActive =
    existingIndex >= 0
      ? inbox.active.map((item, index) => (index === existingIndex ? opportunity : item))
      : [opportunity, ...inbox.active];
  const sortedActive = nextActive
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_LIST_ITEMS);

  saveAoiActiveOpportunities(sessionsDir, normalizedSessionPath, sortedActive);
  saveAoiArchivedOpportunities(sessionsDir, normalizedSessionPath, inbox.archived);

  return {
    sessionPath: normalizedSessionPath,
    opportunity,
    created: existingIndex < 0,
    active: sortedActive,
    archived: inbox.archived,
  };
}

function transitionAoiOpportunityStatus(
  sessionsDir: string,
  sessionPath: string,
  opportunityId: string,
  status: AoiOpportunity['status'],
  input: {
    now?: number;
    snoozeMs?: number;
  } = {},
): AoiOpportunityStatusTransitionResult {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(opportunityId)) {
    throw new Error('Invalid or missing opportunityId.');
  }
  const now = input.now ?? Date.now();
  const inbox = reconcileAoiOpportunityInbox(sessionsDir, normalizedSessionPath, now);
  const activeIndex = inbox.active.findIndex((item) => item.id === opportunityId);
  const archivedIndex = inbox.archived.findIndex((item) => item.id === opportunityId);
  const current =
    activeIndex >= 0
      ? inbox.active[activeIndex]
      : archivedIndex >= 0
        ? inbox.archived[archivedIndex]
        : null;
  if (!current) {
    throw new Error('Aoi opportunity not found.');
  }
  const nextSnoozedUntil =
    status === 'snoozed'
      ? now +
        (input.snoozeMs && input.snoozeMs > 0 ? input.snoozeMs : AOI_OPPORTUNITY_DEFAULT_SNOOZE_MS)
      : undefined;
  const next: AoiOpportunity = {
    ...current,
    status,
    updatedAt: now,
    ...(nextSnoozedUntil ? { snoozedUntil: nextSnoozedUntil } : { snoozedUntil: undefined }),
    ...(isArchivedAoiOpportunityStatus(status) ? { archivedAt: now } : { archivedAt: undefined }),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };

  let nextActive = inbox.active.filter((item) => item.id !== opportunityId);
  let nextArchived = inbox.archived.filter((item) => item.id !== opportunityId);
  if (isArchivedAoiOpportunityStatus(status)) {
    nextArchived = [next, ...nextArchived].slice(0, MAX_LIST_ITEMS);
  } else {
    nextActive = [next, ...nextActive].slice(0, MAX_LIST_ITEMS);
  }
  saveAoiActiveOpportunities(sessionsDir, normalizedSessionPath, nextActive);
  saveAoiArchivedOpportunities(sessionsDir, normalizedSessionPath, nextArchived);
  const followThroughEvent = buildAoiFollowThroughEventFromOpportunity(next, now);
  if (followThroughEvent) {
    try {
      appendAoiFollowThroughEvent(sessionsDir, followThroughEvent, now);
    } catch {
      // Follow-through learning must not block the user's explicit inbox transition.
    }
  }

  return {
    sessionPath: normalizedSessionPath,
    opportunity: next,
    active: nextActive,
    archived: nextArchived,
  };
}

export function archiveAoiOpportunity(
  sessionsDir: string,
  sessionPath: string,
  opportunityId: string,
  now = Date.now(),
): AoiOpportunityStatusTransitionResult {
  return transitionAoiOpportunityStatus(sessionsDir, sessionPath, opportunityId, 'archived', {
    now,
  });
}

export function dismissAoiOpportunity(
  sessionsDir: string,
  sessionPath: string,
  opportunityId: string,
  now = Date.now(),
): AoiOpportunityStatusTransitionResult {
  return transitionAoiOpportunityStatus(sessionsDir, sessionPath, opportunityId, 'dismissed', {
    now,
  });
}

export function snoozeAoiOpportunity(
  sessionsDir: string,
  sessionPath: string,
  opportunityId: string,
  input: {
    now?: number;
    snoozeMs?: number;
  } = {},
): AoiOpportunityStatusTransitionResult {
  return transitionAoiOpportunityStatus(sessionsDir, sessionPath, opportunityId, 'snoozed', input);
}

export function loadAoiFollowThroughEvents(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_FOLLOW_THROUGH_EVENTS,
): AoiFollowThroughEvent[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  return readJsonLines(paths.followThroughEvents)
    .map((item) =>
      normalizeAoiFollowThroughEvent(
        item as Partial<AoiFollowThroughEvent>,
        normalizedSessionPath,
        now,
      ),
    )
    .filter((item): item is AoiFollowThroughEvent => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, Math.max(1, Math.min(MAX_FOLLOW_THROUGH_EVENTS, Math.trunc(limit))));
}

export function saveAoiFollowThroughSummaryIndex(
  sessionsDir: string,
  sessionPath: string,
  index: AoiFollowThroughSummaryIndex,
): AoiFollowThroughSummaryIndex {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const normalized: AoiFollowThroughSummaryIndex = {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt: Number.isFinite(index.updatedAt) ? index.updatedAt : Date.now(),
    entries: (index.entries ?? []).slice(0, MAX_FOLLOW_THROUGH_INDEX_ITEMS),
    evidenceRefs: normalizeStringList(index.evidenceRefs, 24),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  writeJsonAtomic(paths.followThroughSummaryIndex, normalized);
  return normalized;
}

export function loadAoiFollowThroughSummaryIndex(
  sessionsDir: string,
  sessionPath: string,
): AoiFollowThroughSummaryIndex | null {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const parsed = readJson<Partial<AoiFollowThroughSummaryIndex>>(paths.followThroughSummaryIndex);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return null;
  }
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    updatedAt:
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
    entries: parsed.entries.slice(0, MAX_FOLLOW_THROUGH_INDEX_ITEMS),
    evidenceRefs: normalizeStringList(parsed.evidenceRefs, 24),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function loadAoiFollowThroughLearningSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFollowThroughLearningSummary {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return buildAoiFollowThroughLearningSummary({
    sessionPath: normalizedSessionPath,
    followThroughEvents: loadAoiFollowThroughEvents(
      sessionsDir,
      normalizedSessionPath,
      now,
      MAX_FOLLOW_THROUGH_EVENTS,
    ),
    now,
  });
}

export function appendAoiFollowThroughEvent(
  sessionsDir: string,
  event: Partial<AoiFollowThroughEvent>,
  now = Date.now(),
): AoiFollowThroughEvent {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(event.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const normalized = normalizeAoiFollowThroughEvent(event, normalizedSessionPath, now);
  if (!normalized) {
    throw new Error('Invalid Aoi follow-through event.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  appendJsonLine(paths.followThroughEvents, normalized);
  const summary = buildAoiFollowThroughLearningSummary({
    sessionPath: normalizedSessionPath,
    followThroughEvents: loadAoiFollowThroughEvents(
      sessionsDir,
      normalizedSessionPath,
      now,
      MAX_FOLLOW_THROUGH_EVENTS,
    ),
    now,
  });
  saveAoiFollowThroughSummaryIndex(
    sessionsDir,
    normalizedSessionPath,
    buildAoiFollowThroughSummaryIndex(summary),
  );
  return normalized;
}

export function loadAoiOutcomeSignalRecords(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  limit = MAX_OUTCOME_SIGNAL_RECORDS,
): AoiOutcomeSignalRecord[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  return readJsonLines(paths.outcomeSignals)
    .map((item) =>
      normalizeAoiOutcomeSignalRecord(
        item as Partial<AoiOutcomeSignalRecord>,
        normalizedSessionPath,
        now,
      ),
    )
    .filter((item): item is AoiOutcomeSignalRecord => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(MAX_OUTCOME_SIGNAL_RECORDS, Math.trunc(limit))));
}

export function loadAoiOutcomeLearningSummary(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
  fieldReadinessEvidence = false,
): AoiOutcomeLearningSummary {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return buildAoiOutcomeLearningSummary({
    sessionPath: normalizedSessionPath,
    outcomes: loadAoiOutcomeSignalRecords(
      sessionsDir,
      normalizedSessionPath,
      now,
      MAX_OUTCOME_SIGNAL_RECORDS,
    ),
    fieldReadinessEvidence,
    now,
  });
}

export function appendAoiOutcomeSignalRecord(
  sessionsDir: string,
  record: Partial<AoiOutcomeSignalRecord> & Partial<AoiOutcomeSignalInput>,
  now = Date.now(),
): AoiOutcomeSignalRecord {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const normalized = normalizeAoiOutcomeSignalRecord(record, normalizedSessionPath, now);
  if (!normalized) {
    throw new Error('Invalid Aoi outcome signal record.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  appendJsonLine(paths.outcomeSignals, normalized);
  appendAoiFollowThroughEvent(
    sessionsDir,
    buildAoiFollowThroughEventFromOutcomeSignal(normalized, now),
    now,
  );
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

function isAoiCommandAuditRecord(value: unknown): value is AoiCommandAuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<AoiCommandAuditRecord>;
  return (
    record.version === 1 &&
    typeof record.id === 'string' &&
    typeof record.sessionPath === 'string' &&
    typeof record.command === 'string' &&
    typeof record.cwdLabel === 'string' &&
    typeof record.cwdHash === 'string' &&
    typeof record.purpose === 'string' &&
    (record.risk === 'low' || record.risk === 'medium' || record.risk === 'high') &&
    typeof record.allowed === 'boolean' &&
    Array.isArray(record.blockReasons) &&
    typeof record.startedAt === 'number' &&
    typeof record.completedAt === 'number' &&
    typeof record.durationMs === 'number' &&
    (typeof record.exitCode === 'number' || record.exitCode === null) &&
    typeof record.timedOut === 'boolean' &&
    typeof record.stdoutExcerpt === 'string' &&
    typeof record.stderrExcerpt === 'string' &&
    typeof record.stdoutTruncated === 'boolean' &&
    typeof record.stderrTruncated === 'boolean' &&
    Array.isArray(record.evidenceRefs) &&
    typeof record.approvalFingerprint === 'string'
  );
}

export function appendAoiCommandAuditRecord(
  sessionsDir: string,
  record: AoiCommandAuditRecord,
): AoiCommandAuditRecord {
  if (!isAoiCommandAuditRecord(record)) {
    throw new Error('Invalid Aoi command audit record.');
  }
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const item: AoiCommandAuditRecord = {
    ...record,
    sessionPath,
    evidenceRefs: normalizeStringList(record.evidenceRefs, 24),
    blockReasons: normalizeStringList(
      record.blockReasons,
      24,
    ) as AoiCommandAuditRecord['blockReasons'],
  };
  writeJsonAtomic(join(paths.commandAuditDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiCommandAuditRecords(
  sessionsDir: string,
  sessionPath: string,
): AoiCommandAuditRecord[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<unknown>(paths.commandAuditDir)
    .filter(isAoiCommandAuditRecord)
    .sort((a, b) => b.completedAt - a.completedAt);
}

function isAoiFileMutationAuditRecord(value: unknown): value is AoiFileMutationAuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<AoiFileMutationAuditRecord>;
  return (
    record.version === 1 &&
    typeof record.id === 'string' &&
    typeof record.sessionPath === 'string' &&
    (record.operation === 'write' ||
      record.operation === 'patch' ||
      record.operation === 'delete') &&
    typeof record.pathLabel === 'string' &&
    typeof record.pathHash === 'string' &&
    typeof record.purpose === 'string' &&
    (record.risk === 'low' || record.risk === 'medium' || record.risk === 'high') &&
    typeof record.allowed === 'boolean' &&
    Array.isArray(record.blockReasons) &&
    typeof record.startedAt === 'number' &&
    typeof record.completedAt === 'number' &&
    typeof record.durationMs === 'number' &&
    typeof record.applied === 'boolean' &&
    typeof record.rolledBack === 'boolean' &&
    typeof record.contentHash === 'string' &&
    Array.isArray(record.evidenceRefs) &&
    typeof record.approvalFingerprint === 'string'
  );
}

export function appendAoiFileMutationAuditRecord(
  sessionsDir: string,
  record: AoiFileMutationAuditRecord,
): AoiFileMutationAuditRecord {
  if (!isAoiFileMutationAuditRecord(record)) {
    throw new Error('Invalid Aoi file mutation audit record.');
  }
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const item: AoiFileMutationAuditRecord = {
    ...record,
    sessionPath,
    evidenceRefs: normalizeStringList(record.evidenceRefs, 24),
    blockReasons: normalizeStringList(
      record.blockReasons,
      24,
    ) as AoiFileMutationAuditRecord['blockReasons'],
  };
  writeJsonAtomic(join(paths.fileMutationAuditDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiFileMutationAuditRecords(
  sessionsDir: string,
  sessionPath: string,
): AoiFileMutationAuditRecord[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<unknown>(paths.fileMutationAuditDir)
    .filter(isAoiFileMutationAuditRecord)
    .sort((a, b) => b.completedAt - a.completedAt);
}

function isAoiAppActionAuditRecord(value: unknown): value is AoiAppActionAuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<AoiAppActionAuditRecord>;
  return (
    record.version === 1 &&
    typeof record.id === 'string' &&
    typeof record.sessionPath === 'string' &&
    typeof record.appName === 'string' &&
    typeof record.capabilityId === 'string' &&
    typeof record.executionKind === 'string' &&
    (record.routing === 'file_backed' || record.routing === 'app_operation') &&
    typeof record.purpose === 'string' &&
    (record.risk === 'low' || record.risk === 'medium' || record.risk === 'high') &&
    typeof record.allowed === 'boolean' &&
    Array.isArray(record.blockReasons) &&
    typeof record.startedAt === 'number' &&
    typeof record.completedAt === 'number' &&
    typeof record.durationMs === 'number' &&
    typeof record.applied === 'boolean' &&
    typeof record.rolledBack === 'boolean' &&
    typeof record.reviewHandoff === 'boolean' &&
    typeof record.operationHash === 'string' &&
    Array.isArray(record.evidenceRefs) &&
    typeof record.approvalFingerprint === 'string'
  );
}

export function appendAoiAppActionAuditRecord(
  sessionsDir: string,
  record: AoiAppActionAuditRecord,
): AoiAppActionAuditRecord {
  if (!isAoiAppActionAuditRecord(record)) {
    throw new Error('Invalid Aoi app action audit record.');
  }
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const item: AoiAppActionAuditRecord = {
    ...record,
    sessionPath,
    evidenceRefs: normalizeStringList(record.evidenceRefs, 24),
    blockReasons: normalizeStringList(
      record.blockReasons,
      24,
    ) as AoiAppActionAuditRecord['blockReasons'],
  };
  writeJsonAtomic(join(paths.appActionAuditDir, `${item.id}.json`), item);
  return item;
}

export function loadAoiAppActionAuditRecords(
  sessionsDir: string,
  sessionPath: string,
): AoiAppActionAuditRecord[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<unknown>(paths.appActionAuditDir)
    .filter(isAoiAppActionAuditRecord)
    .sort((a, b) => b.completedAt - a.completedAt);
}

function loadAoiFieldShadowRecordList(
  filePath: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldShadowDecisionRecord[] {
  const records = readJson<unknown[]>(filePath);
  if (!Array.isArray(records)) {
    return [];
  }
  return records
    .map((record) => normalizeAoiFieldShadowDecisionRecord(record, { sessionPath, now }))
    .filter((record): record is AoiFieldShadowDecisionRecord => record !== null)
    .sort((left, right) => left.recordedAt - right.recordedAt || left.id.localeCompare(right.id));
}

export function loadAoiFieldShadowDecisionRecords(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldShadowDecisionRecord[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  return loadAoiFieldShadowRecordList(paths.fieldShadowRecords, normalizedSessionPath, now);
}

export function recordAoiFieldShadowDecisions(
  sessionsDir: string,
  input: AoiFieldShadowRecorderInput,
): AoiFieldShadowRecordReport {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const existingRecords = loadAoiFieldShadowRecordList(
    paths.fieldShadowRecords,
    normalizedSessionPath,
    input.now,
  );
  const report = buildAoiFieldShadowRecordReport(
    {
      ...input,
      sessionPath: normalizedSessionPath,
    },
    existingRecords,
  );
  if (report.records.length > existingRecords.length) {
    writeJsonAtomic(paths.fieldShadowRecords, report.records);
  }
  return report;
}

export function loadAoiFieldShadowRecordReport(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldShadowRecordReport {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const records = loadAoiFieldShadowDecisionRecords(sessionsDir, normalizedSessionPath, now);
  return buildAoiFieldShadowRecordReport(
    {
      sessionPath: normalizedSessionPath,
      decisions: [],
      now,
    },
    records,
  );
}

export function cleanupExpiredAoiFieldShadowDecisionRecords(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiFieldShadowDecisionRecord[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const records = loadAoiFieldShadowRecordList(
    paths.fieldShadowRecords,
    normalizedSessionPath,
    now,
  );
  const retainedRecords = pruneExpiredAoiFieldShadowRecords(records, now);
  writeJsonAtomic(paths.fieldShadowRecords, retainedRecords);
  return retainedRecords;
}

function loadAoiOperatorFeedbackLabelActionList(
  filePath: string,
  sessionPath: string,
): AoiOperatorFeedbackLabelAction[] {
  const labels = readJson<unknown[]>(filePath);
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => normalizeAoiOperatorFeedbackLabelAction(label, sessionPath))
    .filter((label): label is AoiOperatorFeedbackLabelAction => label !== null)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function loadAoiOperatorFeedbackLabelActions(
  sessionsDir: string,
  sessionPath: string,
): AoiOperatorFeedbackLabelAction[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  return loadAoiOperatorFeedbackLabelActionList(
    paths.fieldShadowFeedbackLabels,
    normalizedSessionPath,
  );
}

export function recordAoiOperatorFeedbackLabelAction(
  sessionsDir: string,
  input: AoiOperatorFeedbackLabelInput,
): AoiOperatorFeedbackLabelAction {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const action = createAoiOperatorFeedbackLabelAction({
    ...input,
    sessionPath: normalizedSessionPath,
  });
  const existing = loadAoiOperatorFeedbackLabelActionList(
    paths.fieldShadowFeedbackLabels,
    normalizedSessionPath,
  );
  writeJsonAtomic(paths.fieldShadowFeedbackLabels, [...existing, action]);
  return action;
}

function isAoiProposalDecisionAction(value: unknown): value is AoiProposalDecisionAction {
  return (
    value === 'accept' ||
    value === 'dismiss' ||
    value === 'snooze' ||
    value === 'execute' ||
    value === 'block'
  );
}

function isAoiProposalStatus(value: unknown): value is AoiProposal['status'] {
  return (
    value === 'active' ||
    value === 'accepted' ||
    value === 'dismissed' ||
    value === 'snoozed' ||
    value === 'expired' ||
    value === 'executed' ||
    value === 'blocked'
  );
}

function isAoiProposalAcceptActionKind(value: unknown): value is AoiProposalAcceptActionKind {
  return (
    value === 'open_research_artifact' ||
    value === 'read_research_artifact' ||
    value === 'get_research_status' ||
    value === 'start_research' ||
    value === 'create_kira_work' ||
    value === 'run_command' ||
    value === 'file_write' ||
    value === 'file_patch' ||
    value === 'file_delete' ||
    value === 'app_action' ||
    value === 'open_app' ||
    value === 'save_memory' ||
    value === 'activate_goal'
  );
}

function normalizeLoadedAoiProposalDecision(value: unknown): AoiProposalDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const item = value as Partial<AoiProposalDecision>;
  if (
    item.version !== 1 ||
    !isValidAoiAutonomyId(item.id) ||
    !isValidAoiAutonomyId(item.proposalId) ||
    typeof item.sessionPath !== 'string' ||
    typeof item.cooldownKey !== 'string' ||
    !isAoiProposalDecisionAction(item.action) ||
    (item.actor !== 'user' && item.actor !== 'system') ||
    typeof item.createdAt !== 'number' ||
    !isAoiProposalStatus(item.previousStatus) ||
    !isAoiProposalStatus(item.nextStatus)
  ) {
    return null;
  }
  const feedbackCategory = normalizeAoiProposalFeedbackCategory(item.feedbackCategory);
  const approvedCommand = normalizeAoiApprovedCommandPolicy(item.approvedCommand);
  const approvedFileMutation = normalizeAoiApprovedFileMutationPolicy(item.approvedFileMutation);
  const approvedAppAction = normalizeAoiApprovedAppActionPolicy(item.approvedAppAction);
  return {
    version: 1,
    id: item.id,
    proposalId: item.proposalId,
    sessionPath: normalizeAoiAutonomySessionPath(item.sessionPath) || item.sessionPath,
    cooldownKey: normalizeOptionalText(item.cooldownKey, 180) || item.cooldownKey,
    action: item.action,
    actor: item.actor,
    createdAt: item.createdAt,
    previousStatus: item.previousStatus,
    nextStatus: item.nextStatus,
    ...(normalizeOptionalText(item.reason, 240)
      ? { reason: normalizeOptionalText(item.reason, 240) }
      : {}),
    ...(feedbackCategory ? { feedbackCategory } : {}),
    ...(feedbackCategory && normalizeOptionalText(item.feedbackNote, 240)
      ? { feedbackNote: normalizeOptionalText(item.feedbackNote, 240) }
      : {}),
    ...(typeof item.snoozedUntil === 'number' ? { snoozedUntil: item.snoozedUntil } : {}),
    ...(normalizeOptionalText(item.proposalTrigger, 80)
      ? { proposalTrigger: normalizeOptionalText(item.proposalTrigger, 80) }
      : {}),
    ...(item.proposalRisk === 'low' ||
    item.proposalRisk === 'medium' ||
    item.proposalRisk === 'high'
      ? { proposalRisk: item.proposalRisk }
      : {}),
    ...(isAoiProposalAcceptActionKind(item.actionKind) ? { actionKind: item.actionKind } : {}),
    suggestedTools: normalizeStringList(item.suggestedTools, 12),
    evidenceRefs: normalizeStringList(item.evidenceRefs, 24),
    memoryIds: normalizeStringList(item.memoryIds, 24),
    ...(approvedCommand ? { approvedCommand } : {}),
    ...(approvedFileMutation ? { approvedFileMutation } : {}),
    ...(approvedAppAction ? { approvedAppAction } : {}),
  };
}

export function loadAoiProposalDecisions(
  sessionsDir: string,
  sessionPath: string,
): AoiProposalDecision[] {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  return listJsonFiles<unknown>(paths.decisionsDir)
    .map(normalizeLoadedAoiProposalDecision)
    .filter((item): item is AoiProposalDecision => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function findAoiFollowThroughOpportunityForProposal(
  proposal: AoiProposal,
  opportunities: readonly AoiOpportunity[],
): AoiOpportunity | null {
  const proposalRefs = new Set(
    [
      proposal.id,
      `proposal:${proposal.id}`,
      proposal.cooldownKey,
      proposal.trigger,
      ...proposal.evidenceRefs,
      ...proposal.artifactRefs,
      ...proposal.memoryIds.map((id) => `memory:${id}`),
    ]
      .map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean),
  );
  return (
    opportunities
      .map((opportunity) => {
        const refs = [
          opportunity.id,
          `opportunity:${opportunity.id}`,
          opportunity.dedupeKey,
          ...opportunity.evidenceRefs,
        ]
          .map((value) => value.replace(/\s+/g, ' ').trim().toLowerCase())
          .filter(Boolean);
        return {
          opportunity,
          score: refs.reduce((count, ref) => count + (proposalRefs.has(ref) ? 1 : 0), 0),
        };
      })
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.opportunity.updatedAt - left.opportunity.updatedAt,
      )[0]?.opportunity ?? null
  );
}

function recordAoiProposalFollowThroughEvent(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  now: number;
}): void {
  try {
    const inbox = loadAoiOpportunityInbox(params.sessionsDir, params.sessionPath, params.now);
    const opportunity = findAoiFollowThroughOpportunityForProposal(params.proposal, [
      ...inbox.active,
      ...inbox.archived,
    ]);
    appendAoiFollowThroughEvent(
      params.sessionsDir,
      buildAoiFollowThroughEventFromProposalDecision(params.decision, opportunity, params.now),
      params.now,
    );
  } catch {
    // Follow-through learning must not block the existing proposal decision path.
  }
}

export function applyAoiProposalFeedback(
  sessionsDir: string,
  sessionPath: string,
  input: AoiProposalFeedbackInput,
): AoiProposalDecision {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isValidAoiAutonomyId(input.decisionId)) {
    throw new Error('Invalid or missing decisionId.');
  }

  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const decisions = loadAoiProposalDecisions(sessionsDir, normalizedSessionPath);
  const current = decisions.find((decision) => decision.id === input.decisionId);
  if (!current) {
    throw new Error('Aoi proposal decision not found.');
  }

  const feedbackCategory = normalizeAoiProposalFeedbackCategory(input.feedbackCategory);
  if (!feedbackCategory) {
    return current;
  }

  const feedbackNote = normalizeOptionalText(input.feedbackNote, 240);
  const currentWithoutNote = { ...current };
  delete currentWithoutNote.feedbackNote;
  const next: AoiProposalDecision = feedbackNote
    ? {
        ...current,
        feedbackCategory,
        feedbackNote,
      }
    : {
        ...currentWithoutNote,
        feedbackCategory,
      };
  writeJsonAtomic(join(paths.decisionsDir, `${next.id}.json`), next);
  return normalizeLoadedAoiProposalDecision(next) ?? next;
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
  const decision = makeAoiProposalDecisionRecord({
    proposal: current,
    sessionPath: normalizedSessionPath,
    action: input.action,
    actor: input.actor ?? 'user',
    previousStatus: current.status,
    nextStatus,
    now,
    reason: input.reason,
    feedbackCategory: input.feedbackCategory,
    feedbackNote: input.feedbackNote,
    snoozedUntil,
  });

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
  recordAoiProposalFollowThroughEvent({
    sessionsDir,
    sessionPath: normalizedSessionPath,
    proposal: nextProposal,
    decision,
    now,
  });
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
  const decision = makeAoiProposalDecisionRecord({
    proposal: current,
    sessionPath: normalizedSessionPath,
    action: input.nextStatus === 'executed' ? 'execute' : 'block',
    actor: input.actor ?? 'system',
    previousStatus: current.status,
    nextStatus: input.nextStatus,
    now,
    reason: input.reason,
  });
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
  recordAoiProposalFollowThroughEvent({
    sessionsDir,
    sessionPath: normalizedSessionPath,
    proposal: nextProposal,
    decision,
    now,
  });

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
  const opportunities = loadAoiOpportunityInbox(sessionsDir, normalizedSessionPath, now);
  const observations = loadAoiObservations(sessionsDir, normalizedSessionPath);
  const reflections = loadAoiReflections(sessionsDir, normalizedSessionPath);
  const decisions = loadAoiProposalDecisions(sessionsDir, normalizedSessionPath);
  const tickState = loadAoiAutonomyTickState(sessionsDir, normalizedSessionPath, now);
  const environmentSources = loadAoiEnvironmentSourceRegistry(
    sessionsDir,
    normalizedSessionPath,
    now,
  );
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
    activeOpportunityCount: opportunities.active.filter(
      (opportunity) => opportunity.status === 'active',
    ).length,
    archivedOpportunityCount: opportunities.archived.length,
    snoozedOpportunityCount: opportunities.active.filter(
      (opportunity) => opportunity.status === 'snoozed',
    ).length,
    expiredOpportunityCount: opportunities.archived.filter(
      (opportunity) => opportunity.status === 'expired',
    ).length,
    lastOpportunityAt: [...opportunities.active, ...opportunities.archived]
      .map((opportunity) => opportunity.updatedAt)
      .filter((updatedAt) => updatedAt > 0)
      .sort((left, right) => right - left)[0],
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
    recentObservationCount: tickState.recentObservationCount,
    proposalsCreatedInLastTick: tickState.proposalsCreatedInLastTick,
    activeGoalCount: activeGoals.length,
    currentGoalTitle: currentGoal?.title,
    nextGoalStepTitle: nextGoalStep?.title,
    environmentSourceCount: environmentSources.sources.length,
    enabledEnvironmentSourceCount: environmentSources.sources.filter((source) => source.enabled)
      .length,
    highRiskEnvironmentSourceCount: environmentSources.sources.filter(
      (source) => source.risk === 'high',
    ).length,
    privateEnvironmentSourceCount: environmentSources.sources.filter(
      (source) => source.privateByDefault,
    ).length,
    lastEnvironmentSourceObservedAt: environmentSources.sources
      .map((source) => source.lastObservedAt ?? 0)
      .filter((observedAt) => observedAt > 0)
      .sort((left, right) => right - left)[0],
    updatedAt: now,
  };
}
