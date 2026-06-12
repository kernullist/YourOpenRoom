import * as fs from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { createAoiObservation } from './aoiAutonomyObserver';
import { createAoiAutonomyId } from './aoiAutonomyStore';
import type { AoiFailureClassificationInput } from './aoiAutonomyRecovery';
import type { AoiRelationIndex } from './aoiAutonomyRelations';
import { saveServerAoiMemoryCandidates } from './aoiMemoryServerWriter';
import {
  normalizeAoiProjectKey,
  redactAoiSensitiveContent,
  stripAoiSourceInstructions,
  type AoiMemoryCandidate,
} from './aoiMemoryShared';
import type {
  AoiGoal,
  AoiKiraOutcomeEvent,
  AoiKiraOutcomeKind,
  AoiObservation,
  AoiProposal,
} from './aoiAutonomyTypes';

const KIRA_DATA_DIR = ['apps', 'kira', 'data'];
const KIRA_WORKS_DIR = 'works';
const KIRA_ATTEMPTS_DIR = 'attempts';
const KIRA_REVIEWS_DIR = 'reviews';
const SUMMARY_MAX_CHARS = 240;
const CHANGED_FILE_MAX_ITEMS = 8;
const REVIEW_NOTE_MAX_ITEMS = 6;

interface RawKiraWork {
  id: string;
  projectName: string;
  title: string;
  description: string;
  status: string;
  updatedAt: number;
  createdAt: number;
  clarification?: {
    status?: string;
    summary?: string;
    questions?: Array<{ question?: string }>;
  };
  sourceProposalId?: string;
  aoiProposalId?: string;
  metadata?: Record<string, unknown>;
}

interface RawKiraAttempt {
  id?: string;
  workId: string;
  attemptNo: number;
  status: string;
  startedAt?: number;
  finishedAt?: number;
  changedFiles?: string[];
  patchedFiles?: string[];
  commandsRun?: string[];
  validationReruns?: {
    passed?: string[];
    failed?: string[];
  };
  toolCommandEvents?: Array<{
    id?: string;
    command?: string;
    status?: string;
    exitCode?: number | null;
  }>;
  fileChangeEvents?: Array<{
    path?: string;
    changeType?: string;
  }>;
  integration?: {
    status?: string;
    message?: string;
    commitHash?: string;
    pullRequestUrl?: string;
  };
  blockedReason?: string;
  risks?: string[];
}

interface RawKiraReview {
  id?: string;
  workId: string;
  attemptNo: number;
  approved: boolean;
  createdAt: number;
  summary: string;
  findings?: Array<{ severity?: string; message?: string; file?: string; line?: number | null }>;
  missingValidation?: string[];
  nextWorkerInstructions?: string[];
  residualRisk?: string[];
  filesChecked?: string[];
  evidenceChecked?: Array<{ file?: string; reason?: string; method?: string }>;
}

export interface AoiKiraOutcomeMemoryWrite {
  outcomeId: string;
  episodeId: string;
  memoryIds: string[];
}

export interface AoiKiraOutcomeLearningResult {
  outcomes: AoiKiraOutcomeEvent[];
  freshOutcomes: AoiKiraOutcomeEvent[];
  duplicateOutcomes: AoiKiraOutcomeEvent[];
  observations: AoiObservation[];
  memoryWrites: AoiKiraOutcomeMemoryWrite[];
  proposals: AoiProposal[];
  failureInputs: AoiFailureClassificationInput[];
  shouldRefreshMission: boolean;
}

export interface AoiKiraOutcomeLearningInput {
  sessionsDir: string;
  sessionPath: string;
  now: number;
  existingObservations: AoiObservation[];
  activeProposals: AoiProposal[];
  archivedProposals?: AoiProposal[];
  activeGoals?: AoiGoal[];
  archivedGoals?: AoiGoal[];
  relationIndex?: AoiRelationIndex | null;
  maxOutcomes?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: string, maxChars = SUMMARY_MAX_CHARS): string {
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value)),
  );
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function sanitizeSessionPath(sessionPath: string): string {
  return sessionPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
}

function sanitizeIdPart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'kira'
  );
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function uniqueStrings(values: Array<string | undefined | null>, maxItems = 24): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = sanitizeText(value, 240);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
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

function listJsonFiles<T>(dirPath: string): T[] {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return [];
    }
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readJsonFile<T>(join(dirPath, entry.name)))
      .filter((entry): entry is T => entry !== null);
  } catch {
    return [];
  }
}

function getKiraDataDir(sessionsDir: string, sessionPath: string): string {
  return join(sessionsDir, sanitizeSessionPath(sessionPath), ...KIRA_DATA_DIR);
}

function normalizeRawWork(value: unknown): RawKiraWork | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<RawKiraWork>;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') {
    return null;
  }
  return {
    id: raw.id,
    projectName: typeof raw.projectName === 'string' ? raw.projectName : 'unknown',
    title: raw.title,
    description: typeof raw.description === 'string' ? raw.description : '',
    status: typeof raw.status === 'string' ? raw.status : 'todo',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    ...(raw.clarification && typeof raw.clarification === 'object'
      ? { clarification: raw.clarification }
      : {}),
    ...(typeof raw.sourceProposalId === 'string' ? { sourceProposalId: raw.sourceProposalId } : {}),
    ...(typeof raw.aoiProposalId === 'string' ? { aoiProposalId: raw.aoiProposalId } : {}),
    ...(raw.metadata && typeof raw.metadata === 'object' ? { metadata: raw.metadata } : {}),
  };
}

function normalizeRawAttempt(value: unknown): RawKiraAttempt | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<RawKiraAttempt>;
  if (typeof raw.workId !== 'string' || typeof raw.attemptNo !== 'number') {
    return null;
  }
  return {
    workId: raw.workId,
    attemptNo: raw.attemptNo,
    status: typeof raw.status === 'string' ? raw.status : 'planned',
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
    ...(typeof raw.finishedAt === 'number' ? { finishedAt: raw.finishedAt } : {}),
    changedFiles: uniqueStrings(raw.changedFiles ?? [], 40),
    patchedFiles: uniqueStrings(raw.patchedFiles ?? [], 40),
    commandsRun: uniqueStrings(raw.commandsRun ?? [], 40),
    ...(raw.validationReruns && typeof raw.validationReruns === 'object'
      ? {
          validationReruns: {
            passed: uniqueStrings(raw.validationReruns.passed ?? [], 40),
            failed: uniqueStrings(raw.validationReruns.failed ?? [], 40),
          },
        }
      : {}),
    ...(Array.isArray(raw.toolCommandEvents) ? { toolCommandEvents: raw.toolCommandEvents } : {}),
    ...(Array.isArray(raw.fileChangeEvents) ? { fileChangeEvents: raw.fileChangeEvents } : {}),
    ...(raw.integration && typeof raw.integration === 'object'
      ? { integration: raw.integration }
      : {}),
    ...(typeof raw.blockedReason === 'string' ? { blockedReason: raw.blockedReason } : {}),
    risks: uniqueStrings(raw.risks ?? [], 12),
  };
}

function normalizeRawReview(value: unknown): RawKiraReview | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<RawKiraReview>;
  if (
    typeof raw.workId !== 'string' ||
    typeof raw.attemptNo !== 'number' ||
    typeof raw.approved !== 'boolean'
  ) {
    return null;
  }
  return {
    workId: raw.workId,
    attemptNo: raw.attemptNo,
    approved: raw.approved,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    ...(Array.isArray(raw.findings) ? { findings: raw.findings } : {}),
    missingValidation: uniqueStrings(raw.missingValidation ?? [], 12),
    nextWorkerInstructions: uniqueStrings(raw.nextWorkerInstructions ?? [], 12),
    residualRisk: uniqueStrings(raw.residualRisk ?? [], 12),
    filesChecked: uniqueStrings(raw.filesChecked ?? [], 40),
    ...(Array.isArray(raw.evidenceChecked) ? { evidenceChecked: raw.evidenceChecked } : {}),
  };
}

function loadRawKiraRecords(
  sessionsDir: string,
  sessionPath: string,
): {
  works: RawKiraWork[];
  attempts: RawKiraAttempt[];
  reviews: RawKiraReview[];
} {
  const dataDir = getKiraDataDir(sessionsDir, sessionPath);
  return {
    works: listJsonFiles<unknown>(join(dataDir, KIRA_WORKS_DIR))
      .map(normalizeRawWork)
      .filter((work): work is RawKiraWork => work !== null),
    attempts: listJsonFiles<unknown>(join(dataDir, KIRA_ATTEMPTS_DIR))
      .map(normalizeRawAttempt)
      .filter((attempt): attempt is RawKiraAttempt => attempt !== null),
    reviews: listJsonFiles<unknown>(join(dataDir, KIRA_REVIEWS_DIR))
      .map(normalizeRawReview)
      .filter((review): review is RawKiraReview => review !== null),
  };
}

function attemptId(workId: string, attempt: RawKiraAttempt | null): string | undefined {
  if (!attempt) {
    return undefined;
  }
  return attempt.id || `${workId}-${attempt.attemptNo}`;
}

function reviewId(workId: string, review: RawKiraReview | null): string | undefined {
  if (!review) {
    return undefined;
  }
  return review.id || `${workId}-${review.attemptNo}`;
}

function reviewNotes(review: RawKiraReview | null): string[] {
  if (!review) {
    return [];
  }
  return uniqueStrings(
    [
      ...uniqueStrings(review.residualRisk ?? [], REVIEW_NOTE_MAX_ITEMS),
      ...uniqueStrings(review.nextWorkerInstructions ?? [], REVIEW_NOTE_MAX_ITEMS),
      ...(review.findings ?? []).map((finding) => finding.message),
    ],
    REVIEW_NOTE_MAX_ITEMS,
  );
}

function countFailedCommands(attempt: RawKiraAttempt | null): number {
  if (!attempt?.toolCommandEvents) {
    return 0;
  }
  return attempt.toolCommandEvents.filter((event) =>
    ['failed', 'blocked', 'timed_out'].includes(String(event.status || '')),
  ).length;
}

function validationCounts(attempt: RawKiraAttempt | null): {
  passed: number;
  failed: number;
  commandFailed: number;
} {
  if (!attempt) {
    return { passed: 0, failed: 0, commandFailed: 0 };
  }
  return {
    passed:
      (attempt.validationReruns?.passed?.length ?? 0) +
      (attempt.toolCommandEvents?.filter((event) => event.status === 'completed').length ?? 0),
    failed: (attempt.validationReruns?.failed?.length ?? 0) + countFailedCommands(attempt),
    commandFailed: countFailedCommands(attempt),
  };
}

function validationPassed(attempt: RawKiraAttempt | null, review: RawKiraReview | null): boolean {
  if (!attempt) {
    return false;
  }
  const counts = validationCounts(attempt);
  if (counts.failed > 0) {
    return false;
  }
  return counts.passed > 0 || attempt.status === 'approved' || Boolean(review?.approved);
}

function selectAttempt(attempts: RawKiraAttempt[]): RawKiraAttempt | null {
  return (
    [...attempts].sort((left, right) => {
      const integrationDelta =
        Number(['committed', 'integrated'].includes(String(right.integration?.status || ''))) -
        Number(['committed', 'integrated'].includes(String(left.integration?.status || '')));
      if (integrationDelta !== 0) {
        return integrationDelta;
      }
      const approvedDelta =
        Number(right.status === 'approved') - Number(left.status === 'approved');
      if (approvedDelta !== 0) {
        return approvedDelta;
      }
      const finishedDelta = (right.finishedAt ?? 0) - (left.finishedAt ?? 0);
      if (finishedDelta !== 0) {
        return finishedDelta;
      }
      return right.attemptNo - left.attemptNo;
    })[0] ?? null
  );
}

function selectReview(
  reviews: RawKiraReview[],
  attempt: RawKiraAttempt | null,
): RawKiraReview | null {
  if (attempt) {
    const direct = reviews.find((review) => review.attemptNo === attempt.attemptNo);
    if (direct) {
      return direct;
    }
  }
  return [...reviews].sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

function classifyOutcome(
  work: RawKiraWork,
  attempt: RawKiraAttempt | null,
  review: RawKiraReview | null,
): AoiKiraOutcomeKind | null {
  if (work.clarification?.status === 'pending') {
    return 'kira_needs_clarification';
  }
  const counts = validationCounts(attempt);
  if (
    attempt &&
    (attempt.status === 'validation_failed' || counts.failed > 0) &&
    !review?.approved
  ) {
    return 'kira_validation_failed';
  }
  if (review && !review.approved) {
    return 'kira_review_rejected';
  }
  if (work.status === 'blocked' || attempt?.status === 'blocked') {
    return 'kira_work_blocked';
  }
  if (
    review?.approved &&
    validationPassed(attempt, review) &&
    ['committed', 'integrated'].includes(String(attempt?.integration?.status || ''))
  ) {
    return 'kira_integrated';
  }
  if (
    review?.approved &&
    validationPassed(attempt, review) &&
    (work.status === 'done' || attempt?.status === 'approved')
  ) {
    return 'kira_work_completed';
  }
  return null;
}

function extractProposalIdFromText(value: string): string | undefined {
  const match = value.match(/Source proposal:\s*([A-Za-z0-9._:-]+)/i);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/^proposal:/, '');
}

function extractMetadataProposalId(work: RawKiraWork): string | undefined {
  const raw =
    work.sourceProposalId ||
    work.aoiProposalId ||
    (typeof work.metadata?.sourceProposalId === 'string' ? work.metadata.sourceProposalId : '') ||
    (typeof work.metadata?.aoiProposalId === 'string' ? work.metadata.aoiProposalId : '');
  return raw ? raw.replace(/^proposal:/, '') : undefined;
}

function relationNodeRef(
  index: AoiRelationIndex | null | undefined,
  nodeId: string,
): string | null {
  return index?.nodes.find((node) => node.id === nodeId)?.ref ?? null;
}

function resolveProposalIdFromRelations(
  index: AoiRelationIndex | null | undefined,
  workRef: string,
): string | undefined {
  const workNode = index?.nodes.find((node) => node.ref === workRef);
  if (!index || !workNode) {
    return undefined;
  }
  for (const edge of index.edges) {
    if (edge.from !== workNode.id && edge.to !== workNode.id) {
      continue;
    }
    const otherRef = relationNodeRef(index, edge.from === workNode.id ? edge.to : edge.from);
    if (otherRef?.startsWith('proposal:')) {
      return otherRef.slice('proposal:'.length);
    }
  }
  return undefined;
}

function resolveRefFromRelations(
  index: AoiRelationIndex | null | undefined,
  workRef: string,
  prefix: string,
): string | undefined {
  const workNode = index?.nodes.find((node) => node.ref === workRef);
  if (!index || !workNode) {
    return undefined;
  }
  for (const edge of index.edges) {
    if (edge.from !== workNode.id && edge.to !== workNode.id) {
      continue;
    }
    const otherRef = relationNodeRef(index, edge.from === workNode.id ? edge.to : edge.from);
    if (otherRef?.startsWith(prefix)) {
      return otherRef;
    }
  }
  return undefined;
}

function findProposal(
  proposalId: string | undefined,
  proposals: AoiProposal[],
): AoiProposal | undefined {
  if (!proposalId) {
    return undefined;
  }
  return proposals.find((proposal) => proposal.id === proposalId);
}

function extractGoalRefFromProposal(proposal: AoiProposal | undefined): string | undefined {
  return [...(proposal?.evidenceRefs ?? []), ...(proposal?.artifactRefs ?? [])].find((ref) =>
    /^goal:[^/]+$/.test(ref),
  );
}

function extractPlanStepRefFromProposal(proposal: AoiProposal | undefined): string | undefined {
  return [...(proposal?.evidenceRefs ?? []), ...(proposal?.artifactRefs ?? [])].find(
    (ref) => /^goal:[^/]+\/step:[^/]+$/.test(ref) || /^plan-step:[^/]+$/.test(ref),
  );
}

function goalIdFromRef(ref: string | undefined): string | undefined {
  if (!ref?.startsWith('goal:')) {
    return undefined;
  }
  return ref.slice('goal:'.length).split('/')[0];
}

function planStepIdFromRef(ref: string | undefined): string | undefined {
  if (!ref) {
    return undefined;
  }
  if (ref.startsWith('plan-step:')) {
    return ref.slice('plan-step:'.length);
  }
  const match = ref.match(/^goal:[^/]+\/step:([^/]+)$/);
  return match?.[1];
}

function changedFilesForAttempt(attempt: RawKiraAttempt | null): string[] {
  if (!attempt) {
    return [];
  }
  return uniqueStrings(
    [
      ...(attempt.changedFiles ?? []),
      ...(attempt.patchedFiles ?? []),
      ...(attempt.fileChangeEvents ?? []).map((event) => event.path),
    ],
    CHANGED_FILE_MAX_ITEMS,
  );
}

function makeOutcomeId(kind: AoiKiraOutcomeKind, signature: string): string {
  return `aoi-kira-outcome-${sanitizeIdPart(kind)}-${hashPart(signature)}`.slice(0, 127);
}

function buildOutcome(params: {
  sessionPath: string;
  work: RawKiraWork;
  attempt: RawKiraAttempt | null;
  review: RawKiraReview | null;
  kind: AoiKiraOutcomeKind;
  proposal?: AoiProposal;
  proposalId?: string;
  relationGoalRef?: string;
  relationPlanStepRef?: string;
}): AoiKiraOutcomeEvent {
  const attemptRef = attemptId(params.work.id, params.attempt);
  const reviewRef = reviewId(params.work.id, params.review);
  const changedFiles = changedFilesForAttempt(params.attempt);
  const counts = validationCounts(params.attempt);
  const validationSummary = `passed=${counts.passed} failed=${counts.failed}`;
  const changedFilesSummary =
    changedFiles.length > 0 ? changedFiles.join(', ') : 'No changed files reported';
  const goalRef = extractGoalRefFromProposal(params.proposal) ?? params.relationGoalRef;
  const planStepRef = extractPlanStepRefFromProposal(params.proposal) ?? params.relationPlanStepRef;
  const workRef = `kira-work:${params.work.id}`;
  const sourceProposalId = params.proposal?.id ?? params.proposalId;
  const sourceGoalId = goalIdFromRef(goalRef);
  const sourcePlanStepId = planStepIdFromRef(planStepRef);
  const signature = [
    params.kind,
    params.work.id,
    attemptRef ?? 'no-attempt',
    reviewRef ?? 'no-review',
    params.attempt?.finishedAt ?? params.work.updatedAt,
    params.review?.createdAt ?? 0,
    params.attempt?.integration?.status ?? 'no-integration',
  ].join(':');
  const evidenceRefs = uniqueStrings([
    workRef,
    attemptRef ? `kira-attempt:${attemptRef}` : undefined,
    reviewRef ? `kira-review:${reviewRef}` : undefined,
    sourceProposalId ? `proposal:${sourceProposalId}` : undefined,
    goalRef,
    planStepRef,
    ...changedFiles.map((file) => `file:${file}`),
  ]);
  const notes = reviewNotes(params.review);
  const createdAt =
    params.review?.createdAt ??
    params.attempt?.finishedAt ??
    params.work.updatedAt ??
    params.work.createdAt;
  return {
    version: 1,
    id: makeOutcomeId(params.kind, signature),
    sessionPath: params.sessionPath,
    kind: params.kind,
    workId: params.work.id,
    workRef,
    workTitle: sanitizeText(params.work.title, 140),
    projectName: sanitizeText(params.work.projectName, 120),
    ...(attemptRef ? { attemptId: attemptRef } : {}),
    ...(typeof params.attempt?.attemptNo === 'number'
      ? { attemptNo: params.attempt.attemptNo }
      : {}),
    ...(reviewRef ? { reviewId: reviewRef } : {}),
    ...(sourceProposalId ? { sourceProposalId } : {}),
    ...(sourceGoalId ? { sourceGoalId } : {}),
    ...(sourcePlanStepId ? { sourcePlanStepId } : {}),
    validationSummary,
    changedFilesSummary: sanitizeText(changedFilesSummary, 220),
    evidenceRefs,
    reviewApproved: params.review?.approved,
    validationPassed: validationPassed(params.attempt, params.review),
    integrated: ['committed', 'integrated'].includes(
      String(params.attempt?.integration?.status || ''),
    ),
    reviewerNotes: notes,
    createdAt,
    dedupeKey: `kira-outcome:${signature}`,
  };
}

export function collectAoiKiraOutcomeEvents(
  input: Omit<AoiKiraOutcomeLearningInput, 'existingObservations'>,
): AoiKiraOutcomeEvent[] {
  const records = loadRawKiraRecords(input.sessionsDir, input.sessionPath);
  const proposals = [...input.activeProposals, ...(input.archivedProposals ?? [])];
  const attemptsByWork = new Map<string, RawKiraAttempt[]>();
  const reviewsByWork = new Map<string, RawKiraReview[]>();
  for (const attempt of records.attempts) {
    attemptsByWork.set(attempt.workId, [...(attemptsByWork.get(attempt.workId) ?? []), attempt]);
  }
  for (const review of records.reviews) {
    reviewsByWork.set(review.workId, [...(reviewsByWork.get(review.workId) ?? []), review]);
  }

  const outcomes: AoiKiraOutcomeEvent[] = [];
  for (const work of records.works) {
    const workRef = `kira-work:${work.id}`;
    const attempts = attemptsByWork.get(work.id) ?? [];
    const reviews = reviewsByWork.get(work.id) ?? [];
    const attempt = selectAttempt(attempts);
    const review = selectReview(reviews, attempt);
    const kind = classifyOutcome(work, attempt, review);
    if (!kind) {
      continue;
    }
    const proposalId =
      extractMetadataProposalId(work) ||
      extractProposalIdFromText(work.description) ||
      resolveProposalIdFromRelations(input.relationIndex, workRef);
    const proposal = findProposal(proposalId, proposals);
    outcomes.push(
      buildOutcome({
        sessionPath: input.sessionPath,
        work,
        attempt,
        review,
        kind,
        proposal,
        proposalId,
        relationGoalRef: resolveRefFromRelations(input.relationIndex, workRef, 'goal:'),
        relationPlanStepRef:
          resolveRefFromRelations(input.relationIndex, workRef, 'plan-step:') ??
          resolveRefFromRelations(input.relationIndex, workRef, 'goal:'),
      }),
    );
  }

  return outcomes
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, input.maxOutcomes ?? 12);
}

function outcomeToObservation(outcome: AoiKiraOutcomeEvent): AoiObservation {
  return createAoiObservation({
    source: 'kira',
    sessionPath: outcome.sessionPath,
    stableKey: outcome.dedupeKey,
    createdAt: outcome.createdAt,
    summary: `Kira reviewed outcome for "${outcome.workTitle}": ${outcome.kind}; validation ${outcome.validationSummary}.`,
    payloadRef: `event:${outcome.id}`,
    artifactRefs: outcome.evidenceRefs,
    proposalIds: outcome.sourceProposalId ? [outcome.sourceProposalId] : [],
    riskSignals: [
      `kira-outcome:${outcome.kind}`,
      outcome.validationPassed ? 'kira-validation-passed' : 'kira-validation-not-passed',
      outcome.reviewApproved === true ? 'kira-review-approved' : '',
      outcome.reviewApproved === false ? 'kira-review-rejected' : '',
      outcome.kind === 'kira_needs_clarification' ? 'needs-user-input' : '',
    ].filter(Boolean),
  });
}

function outcomeMemoryCandidate(outcome: AoiKiraOutcomeEvent): AoiMemoryCandidate | null {
  if (!outcome.reviewId || typeof outcome.reviewApproved !== 'boolean') {
    return null;
  }
  const positive = outcome.reviewApproved && outcome.validationPassed;
  const content = sanitizeText(
    [
      `Kira reviewed outcome for "${outcome.workTitle}" in ${outcome.projectName}.`,
      `Outcome=${outcome.kind}.`,
      `Validation ${outcome.validationSummary}.`,
      `Review=${outcome.reviewApproved ? 'approved' : 'rejected'}.`,
      `Files=${outcome.changedFilesSummary}.`,
      outcome.reviewerNotes.length > 0
        ? `Reviewer notes=${outcome.reviewerNotes.slice(0, 3).join(' / ')}.`
        : '',
    ].join(' '),
    720,
  );
  return {
    scope: 'project',
    type: positive ? 'action' : 'event',
    content,
    importance: positive ? 0.78 : 0.68,
    confidence: positive ? 0.84 : 0.74,
    projectKey: normalizeAoiProjectKey(outcome.projectName),
    tags: [
      'kira',
      'automation',
      'project-automation',
      'kira-outcome',
      'reviewed',
      outcome.kind,
      outcome.reviewApproved ? 'review-approved' : 'review-rejected',
      outcome.validationPassed ? 'validation-passed' : 'validation-failed',
      ...(outcome.integrated ? ['integrated'] : []),
    ],
    entities: uniqueStrings([
      outcome.projectName,
      outcome.workTitle,
      outcome.workRef,
      outcome.sourceProposalId ? `proposal:${outcome.sourceProposalId}` : undefined,
      outcome.sourceGoalId ? `goal:${outcome.sourceGoalId}` : undefined,
    ]),
  };
}

function saveOutcomeMemory(
  sessionsDir: string,
  sessionPath: string,
  outcome: AoiKiraOutcomeEvent,
): AoiKiraOutcomeMemoryWrite | null {
  const candidate = outcomeMemoryCandidate(outcome);
  if (!candidate) {
    return null;
  }
  const episodeId = `aoi_kira_outcome_${sanitizeIdPart(outcome.id)}`;
  const memories = saveServerAoiMemoryCandidates(sessionsDir, sessionPath, [candidate], episodeId);
  const memoryIds = memories
    .filter((memory) => memory.sourceEpisodeIds.includes(episodeId))
    .map((memory) => memory.id);
  return {
    outcomeId: outcome.id,
    episodeId,
    memoryIds,
  };
}

function hasActiveProposalForOutcome(
  outcome: AoiKiraOutcomeEvent,
  activeProposals: AoiProposal[],
): boolean {
  const cooldownKey = `kira-outcome-followup:${outcome.workId}:${outcome.reviewId ?? outcome.attemptId ?? outcome.kind}`;
  return activeProposals.some(
    (proposal) =>
      (proposal.status === 'active' ||
        proposal.status === 'accepted' ||
        proposal.status === 'snoozed') &&
      proposal.cooldownKey === cooldownKey,
  );
}

function buildOutcomeFollowupProposal(
  outcome: AoiKiraOutcomeEvent,
  activeProposals: AoiProposal[],
  now: number,
): AoiProposal | null {
  if (
    !['kira_work_completed', 'kira_integrated'].includes(outcome.kind) ||
    !outcome.reviewApproved ||
    !outcome.validationPassed ||
    outcome.reviewerNotes.length === 0 ||
    hasActiveProposalForOutcome(outcome, activeProposals)
  ) {
    return null;
  }
  const note = outcome.reviewerNotes[0];
  const cooldownKey = `kira-outcome-followup:${outcome.workId}:${outcome.reviewId ?? outcome.attemptId ?? outcome.kind}`;
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-kira-outcome-followup', now),
    sessionPath: outcome.sessionPath,
    status: 'active',
    title: sanitizeText(`Review one Kira follow-up: ${outcome.workTitle}`, 96),
    body: sanitizeText(note, 320),
    reason:
      'Kira finished reviewed work with reviewer notes; inspect one narrow follow-up before moving on.',
    trigger: 'kira_outcome_followup',
    createdAt: now,
    updatedAt: now,
    cooldownKey,
    confidence: 0.76,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: false,
    suggestedTools: [],
    evidenceRefs: uniqueStrings([`event:${outcome.id}`, ...outcome.evidenceRefs]),
    memoryIds: [],
    artifactRefs: uniqueStrings([
      outcome.workRef,
      outcome.attemptId ? `kira-attempt:${outcome.attemptId}` : undefined,
      outcome.reviewId ? `kira-review:${outcome.reviewId}` : undefined,
      outcome.sourceGoalId ? `goal:${outcome.sourceGoalId}` : undefined,
      outcome.sourcePlanStepId && outcome.sourceGoalId
        ? `goal:${outcome.sourceGoalId}/step:${outcome.sourcePlanStepId}`
        : undefined,
    ]),
    riskSignals: ['kira-outcome-followup', 'reviewer-notes'],
  };
}

function outcomeFailureInput(outcome: AoiKiraOutcomeEvent): AoiFailureClassificationInput | null {
  if (
    outcome.kind !== 'kira_work_blocked' &&
    outcome.kind !== 'kira_validation_failed' &&
    outcome.kind !== 'kira_review_rejected'
  ) {
    return null;
  }
  return {
    source: 'kira',
    sessionPath: outcome.sessionPath,
    sourceRef: `event:${outcome.id}`,
    summary: `Kira outcome ${outcome.kind} for "${outcome.workTitle}".`,
    evidenceRefs: uniqueStrings([`event:${outcome.id}`, ...outcome.evidenceRefs]),
    reasons: uniqueStrings([
      outcome.kind,
      outcome.validationSummary,
      outcome.reviewApproved === false ? 'review_rejected' : undefined,
      ...outcome.reviewerNotes,
    ]),
    riskSignals: [`kira-outcome:${outcome.kind}`, 'kira-needs-recovery'],
    suggestedTools: ['create_kira_work'],
    acceptActionKind: 'create_kira_work',
  };
}

export function runAoiKiraOutcomeLearning(
  input: AoiKiraOutcomeLearningInput,
): AoiKiraOutcomeLearningResult {
  const outcomes = collectAoiKiraOutcomeEvents(input);
  const existingDedupeKeys = new Set(
    input.existingObservations.map((observation) => observation.dedupeKey),
  );
  const freshOutcomes: AoiKiraOutcomeEvent[] = [];
  const duplicateOutcomes: AoiKiraOutcomeEvent[] = [];
  const observations: AoiObservation[] = [];
  const memoryWrites: AoiKiraOutcomeMemoryWrite[] = [];
  const proposals: AoiProposal[] = [];
  const failureInputs: AoiFailureClassificationInput[] = [];

  for (const outcome of outcomes) {
    const observation = outcomeToObservation(outcome);
    if (existingDedupeKeys.has(observation.dedupeKey)) {
      duplicateOutcomes.push(outcome);
      continue;
    }
    freshOutcomes.push(outcome);
    observations.push(observation);

    const memoryWrite = saveOutcomeMemory(input.sessionsDir, input.sessionPath, outcome);
    if (memoryWrite) {
      memoryWrites.push(memoryWrite);
    }

    const followup = buildOutcomeFollowupProposal(outcome, input.activeProposals, input.now);
    if (followup) {
      proposals.push(followup);
    }

    const failure = outcomeFailureInput(outcome);
    if (failure) {
      failureInputs.push(failure);
    }
  }

  return {
    outcomes,
    freshOutcomes,
    duplicateOutcomes,
    observations,
    memoryWrites,
    proposals,
    failureInputs,
    shouldRefreshMission: freshOutcomes.some((outcome) =>
      ['kira_work_completed', 'kira_integrated', 'kira_needs_clarification'].includes(outcome.kind),
    ),
  };
}
