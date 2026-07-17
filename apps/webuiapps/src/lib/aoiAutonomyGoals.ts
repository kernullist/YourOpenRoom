import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  makeAoiRelationEdge,
  makeAoiRelationNode,
  upsertAoiRelations,
} from './aoiAutonomyRelations';
import type {
  AoiAutonomyLevel,
  AoiAutonomyRisk,
  AoiGoal,
  AoiGoalOwner,
  AoiGoalProgressEvent,
  AoiGoalStatus,
  AoiKiraOutcomeEvent,
  AoiObservation,
  AoiOutcomeSignalRecord,
  AoiPlan,
  AoiPlanStep,
  AoiPlanStepKind,
  AoiProposal,
  AoiProposalAcceptActionKind,
} from './aoiAutonomyTypes';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import {
  aoiCardGoalContinuationBody,
  aoiCardGoalContinuationReason,
  aoiCardGoalContinuePrefix,
  aoiCardGoalText,
  aoiCardGoalTrackPrefix,
  type AoiCardLang,
} from './aoiAutonomyCardI18n';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const GOALS_DIR = 'goals';
const ACTIVE_GOALS_FILE = 'active.json';
const ARCHIVE_GOALS_FILE = 'archive.json';
const PROGRESS_EVENTS_FILE = 'progress.json';
const MAX_ACTIVE_GOALS = 20;
const MAX_ARCHIVED_GOALS = 120;
const MAX_PROGRESS_EVENTS = 240;
const TEXT_MAX_CHARS = 240;
const PLAN_STEP_MAX = 8;

export interface AoiGoalPaths {
  root: string;
  goalsDir: string;
  activeGoals: string;
  archivedGoals: string;
  progressEvents: string;
}

export interface AoiGoalDecisionInput {
  action: 'pause' | 'resume' | 'abandon' | 'complete' | 'block';
  goalId: string;
  now?: number;
  evidenceRefs?: string[];
  reason?: string;
  userConfirmed?: boolean;
}

export interface AoiGoalProgressUpdateResult {
  activeGoals: AoiGoal[];
  archivedGoals: AoiGoal[];
  events: AoiGoalProgressEvent[];
}

export interface AoiKiraOutcomeGoalProgressResult extends AoiGoalProgressUpdateResult {
  updatedOutcomeIds: string[];
}

export interface AoiOutcomeSignalGoalProgressResult extends AoiGoalProgressUpdateResult {
  updatedOutcomeIds: string[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars = TEXT_MAX_CHARS): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}

function sanitizeText(value: string, maxChars = TEXT_MAX_CHARS): string {
  return truncateText(stripAoiSourceInstructions(redactAoiSensitiveContent(value)), maxChars);
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sanitizeIdPart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item'
  );
}

function createGoalId(prefix: string, now = Date.now()): string {
  return `${sanitizeIdPart(prefix)}-${now.toString(36)}-${randomUUID().slice(0, 8)}`.slice(0, 96);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function normalizeSessionPath(value: unknown): string | null {
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

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
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

function normalizeStringArray(value: unknown, maxItems = 24): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
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

function clampConfidence(value: unknown, fallback = 0.7): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function isRisk(value: unknown): value is AoiAutonomyRisk {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isGoalStatus(value: unknown): value is AoiGoalStatus {
  return (
    value === 'proposed' ||
    value === 'active' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'abandoned' ||
    value === 'blocked'
  );
}

function isGoalOwner(value: unknown): value is AoiGoalOwner {
  return value === 'user' || value === 'aoi' || value === 'shared';
}

function isLevel(value: unknown): value is AoiAutonomyLevel {
  return (
    value === 'L0' ||
    value === 'L1' ||
    value === 'L2' ||
    value === 'L3' ||
    value === 'L4' ||
    value === 'L5'
  );
}

function isStepKind(value: unknown): value is AoiPlanStepKind {
  return (
    value === 'read' ||
    value === 'research' ||
    value === 'draft' ||
    value === 'review' ||
    value === 'execute_proposal' ||
    value === 'ask_user' ||
    value === 'handoff_kira'
  );
}

function isActionKind(value: unknown): value is AoiProposalAcceptActionKind | 'none' {
  return (
    value === 'none' ||
    value === 'open_research_artifact' ||
    value === 'read_research_artifact' ||
    value === 'get_research_status' ||
    value === 'start_research' ||
    value === 'create_kira_work' ||
    value === 'open_app' ||
    value === 'save_memory' ||
    value === 'activate_goal'
  );
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣_+-]+/i)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
}

function overlapScore(leftValue: string, rightValue: string): number {
  const left = tokenize(leftValue);
  const right = tokenize(rightValue);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

export function resolveAoiGoalPaths(sessionsDir: string, sessionPath: string): AoiGoalPaths {
  const normalizedSessionPath = normalizeSessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const root = resolve(sessionsRoot, normalizedSessionPath, AUTONOMY_ROOT_DIR);
  if (!isPathInsideRoot(sessionsRoot, root)) {
    throw new Error('Resolved Aoi goal path escaped the sessions directory.');
  }
  const goalsDir = join(root, GOALS_DIR);
  return {
    root,
    goalsDir,
    activeGoals: join(goalsDir, ACTIVE_GOALS_FILE),
    archivedGoals: join(goalsDir, ARCHIVE_GOALS_FILE),
    progressEvents: join(goalsDir, PROGRESS_EVENTS_FILE),
  };
}

export function aoiPlanStepRequiredLevel(
  kind: AoiPlanStepKind,
  risk: AoiAutonomyRisk,
): AoiAutonomyLevel {
  // Grant high autonomy: lowest practical gate per plan step so Aoi can
  // self-pursue goal plans under almost any policy level. The explicit
  // acceptance / requiresUserApproval gates remain the safety net.
  // Only high-risk steps and actual execution/handoff steps keep a minimal
  // L2 gate; information-gathering and low-risk steps drop to L1.
  if (risk === 'high') {
    return 'L2';
  }
  if (kind === 'execute_proposal' || kind === 'handoff_kira') {
    return risk === 'medium' ? 'L2' : 'L1';
  }
  return 'L1';
}

function makePlanStep(params: {
  goalId: string;
  kind: AoiPlanStepKind;
  title: string;
  expectedEvidence: string[];
  allowedActionKind: AoiProposalAcceptActionKind | 'none';
  doneCriteria: string[];
  evidenceRefs: string[];
  risk: AoiAutonomyRisk;
  now: number;
}): AoiPlanStep {
  return {
    version: 1,
    id: `step-${sanitizeIdPart(params.kind)}-${hashPart(`${params.goalId}:${params.title}`)}`,
    kind: params.kind,
    title: sanitizeText(params.title, 120),
    status: 'pending',
    expectedEvidence: normalizeStringArray(params.expectedEvidence, 8),
    allowedActionKind: params.allowedActionKind,
    requiredAutonomyLevel: aoiPlanStepRequiredLevel(params.kind, params.risk),
    doneCriteria: normalizeStringArray(params.doneCriteria, 8),
    evidenceRefs: normalizeStringArray(params.evidenceRefs, 12),
    risk: params.risk,
  };
}

function isCurrentInfoIntent(value: string): boolean {
  return (
    /\b(?:latest|recent|current|today|now|updated|research|investigate)\b/i.test(value) ||
    /(?:최신|최근|현재|오늘|요즘|업데이트|조사|리서치|연구)/u.test(value)
  );
}

function isKiraIntent(value: string): boolean {
  return /\bkira\b/i.test(value) || /(?:키라|자동화|작업자|리뷰)/u.test(value);
}

export function looksLikeExplicitAoiGoalIntent(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    /\b(?:goal|objective|track this|manage this|keep track|next steps|finish this|until done|end-to-end)\b/i.test(
      value,
    ) || /(?:목표|끝까지|다음\s*단계|관리하자|추적|이어가|완료할\s*때까지|마무리)/u.test(value)
  );
}

// P3.6: max LLM-decomposed plan steps. The broad-scope blocker rejects an over-long
// decomposition -- a novel objective that fans out too far is a review red flag, not a plan.
const MAX_LLM_PROPOSED_PLAN_STEPS = 4;

// P3.6: turn LLM-proposed plan-step descriptions into bounded, DISPLAY-ONLY AoiPlanSteps,
// or null when the decomposition is unusable (fail-closed -> the caller keeps the
// deterministic template). Every step is allowedActionKind:'none' -- purely descriptive; it
// carries no action authority, and buildAoiBoundedWorkOrderFromGoalStep still forces
// display_only + approval downstream. Safety blockers reject over-reach: a broad-scope
// decomposition (too many steps) or an ambiguous one (a step with no concrete title or
// done-criterion).
export function buildAoiPlanStepsFromLlmProposal(params: {
  goalId: string;
  rawSteps: unknown;
  sourceRefs: string[];
  risk: AoiAutonomyRisk;
  now: number;
}): AoiPlanStep[] | null {
  if (!Array.isArray(params.rawSteps) || params.rawSteps.length === 0) {
    return null;
  }
  if (params.rawSteps.length > MAX_LLM_PROPOSED_PLAN_STEPS) {
    return null; // broad-scope blocker
  }
  const sourceRefs = normalizeStringArray(params.sourceRefs, 12);
  const steps: AoiPlanStep[] = [];
  for (const raw of params.rawSteps) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const record = raw as { title?: unknown; doneCriteria?: unknown };
    const title = typeof record.title === 'string' ? sanitizeText(record.title, 120) : '';
    const doneCriteria = normalizeStringArray(record.doneCriteria, 4);
    if (!title || doneCriteria.length === 0) {
      return null; // ambiguous-objective blocker
    }
    steps.push(
      makePlanStep({
        goalId: params.goalId,
        kind: 'draft',
        title,
        expectedEvidence: doneCriteria,
        allowedActionKind: 'none',
        doneCriteria,
        evidenceRefs: sourceRefs,
        risk: params.risk === 'high' ? 'medium' : 'low',
        now: params.now,
      }),
    );
  }
  return steps;
}

// P3.6: proposal acceptAction params are string-keyed, so LLM-proposed plan steps arrive as
// a JSON string; parse it to an array (fail-closed to undefined so a malformed value keeps
// the deterministic template). An already-array value passes through.
export function parseAoiProposedPlanStepsParam(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

export function buildAoiPlanForGoal(params: {
  goalId: string;
  sessionPath: string;
  userIntentSummary: string;
  sourceRefs: string[];
  risk: AoiAutonomyRisk;
  now: number;
  // P3.6: optional LLM-proposed plan steps. When they pass buildAoiPlanStepsFromLlmProposal
  // (bounded + concrete), they replace the deterministic intent-based middle step; otherwise
  // the template stands (fail-closed). The read + review bookends stay deterministic.
  llmProposedSteps?: unknown;
}): AoiPlan {
  const sourceRefs = normalizeStringArray(params.sourceRefs, 12);
  const steps: AoiPlanStep[] = [
    makePlanStep({
      goalId: params.goalId,
      kind: 'read',
      title: 'Review the goal context and current evidence',
      expectedEvidence: [
        'Relevant observations, memories, proposals, or artifacts are identified.',
      ],
      allowedActionKind: 'none',
      doneCriteria: ['Aoi can name the current objective and known evidence refs.'],
      evidenceRefs: sourceRefs,
      risk: 'low',
      now: params.now,
    }),
  ];

  const llmSteps =
    params.llmProposedSteps !== undefined
      ? buildAoiPlanStepsFromLlmProposal({
          goalId: params.goalId,
          rawSteps: params.llmProposedSteps,
          sourceRefs,
          risk: params.risk,
          now: params.now,
        })
      : null;
  if (llmSteps) {
    // P3.6: the LLM decomposed the objective into concrete, bounded steps -- use them in
    // place of the single deterministic intent step. The read + review bookends still frame
    // them, and each step stays display_only.
    steps.push(...llmSteps);
  } else if (isCurrentInfoIntent(params.userIntentSummary)) {
    steps.push(
      makePlanStep({
        goalId: params.goalId,
        kind: 'research',
        title: 'Refresh evidence with a bounded research pass',
        expectedEvidence: ['A completed research run or explicit reason research is unnecessary.'],
        allowedActionKind: 'start_research',
        doneCriteria: ['Research result, failure, or user cancellation is recorded as evidence.'],
        evidenceRefs: sourceRefs,
        risk: params.risk === 'high' ? 'high' : 'medium',
        now: params.now,
      }),
    );
  } else if (isKiraIntent(params.userIntentSummary)) {
    steps.push(
      makePlanStep({
        goalId: params.goalId,
        kind: 'handoff_kira',
        title: 'Break the work into a Kira handoff candidate',
        expectedEvidence: ['A Kira-ready task summary or explicit decision not to hand off.'],
        allowedActionKind: 'create_kira_work',
        doneCriteria: [
          'The handoff proposal is accepted, dismissed, or replaced by a smaller step.',
        ],
        evidenceRefs: sourceRefs,
        risk: params.risk === 'high' ? 'high' : 'medium',
        now: params.now,
      }),
    );
  } else {
    steps.push(
      makePlanStep({
        goalId: params.goalId,
        kind: 'draft',
        title: 'Draft the next concrete step',
        expectedEvidence: ['A draft, checklist, patch plan, or next-step proposal exists.'],
        allowedActionKind: 'none',
        doneCriteria: ['A small next step is ready for user review or execution proposal.'],
        evidenceRefs: sourceRefs,
        risk: params.risk === 'high' ? 'medium' : 'low',
        now: params.now,
      }),
    );
  }

  steps.push(
    makePlanStep({
      goalId: params.goalId,
      kind: 'review',
      title: 'Review progress and decide whether the goal is done, blocked, or needs another step',
      expectedEvidence: [
        'Observation, proposal decision, artifact, or explicit user confirmation.',
      ],
      allowedActionKind: 'none',
      doneCriteria: [
        'Goal status is evidence-backed and no completion is inferred from a mere plan.',
      ],
      evidenceRefs: sourceRefs,
      risk: 'low',
      now: params.now,
    }),
  );

  return {
    version: 1,
    id: `plan-${hashPart(params.goalId)}`,
    goalId: params.goalId,
    sessionPath: params.sessionPath,
    createdAt: params.now,
    updatedAt: params.now,
    sourceRefs,
    steps: steps.slice(0, PLAN_STEP_MAX),
  };
}

function normalizePlanStep(value: unknown): AoiPlanStep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiPlanStep>;
  if (
    record.version !== 1 ||
    typeof record.id !== 'string' ||
    !isStepKind(record.kind) ||
    typeof record.title !== 'string'
  ) {
    return null;
  }
  const risk = isRisk(record.risk) ? record.risk : 'low';
  return {
    version: 1,
    id: sanitizeIdPart(record.id).slice(0, 96),
    kind: record.kind,
    title: sanitizeText(record.title, 120),
    status:
      record.status === 'in_progress' || record.status === 'done' || record.status === 'blocked'
        ? record.status
        : 'pending',
    expectedEvidence: normalizeStringArray(record.expectedEvidence, 8),
    allowedActionKind: isActionKind(record.allowedActionKind) ? record.allowedActionKind : 'none',
    requiredAutonomyLevel: isLevel(record.requiredAutonomyLevel)
      ? record.requiredAutonomyLevel
      : aoiPlanStepRequiredLevel(record.kind, risk),
    doneCriteria: normalizeStringArray(record.doneCriteria, 8),
    evidenceRefs: normalizeStringArray(record.evidenceRefs, 12),
    risk,
  };
}

function normalizeGoal(value: unknown): AoiGoal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiGoal>;
  const sessionPath = normalizeSessionPath(record.sessionPath);
  if (
    record.version !== 1 ||
    typeof record.id !== 'string' ||
    !sessionPath ||
    typeof record.title !== 'string' ||
    typeof record.userIntentSummary !== 'string' ||
    !isGoalStatus(record.status)
  ) {
    return null;
  }
  const risk = isRisk(record.risk) ? record.risk : 'low';
  const now = Date.now();
  const rawPlan =
    record.plan && typeof record.plan === 'object' && !Array.isArray(record.plan)
      ? (record.plan as Partial<AoiPlan>)
      : {};
  const sourceRefs = normalizeStringArray(record.sourceRefs, 16);
  const steps = Array.isArray(rawPlan.steps)
    ? rawPlan.steps.map(normalizePlanStep).filter((step): step is AoiPlanStep => step !== null)
    : [];
  const goal: AoiGoal = {
    version: 1,
    id: sanitizeIdPart(record.id).slice(0, 96),
    sessionPath,
    title: sanitizeText(record.title, 120),
    userIntentSummary: sanitizeText(record.userIntentSummary, TEXT_MAX_CHARS),
    sourceRefs,
    status: record.status,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
    lastCheckedAt: typeof record.lastCheckedAt === 'number' ? record.lastCheckedAt : 0,
    confidence: clampConfidence(record.confidence),
    risk,
    owner: isGoalOwner(record.owner) ? record.owner : 'shared',
    plan: {
      version: 1,
      id: typeof rawPlan.id === 'string' ? sanitizeIdPart(rawPlan.id).slice(0, 96) : 'plan',
      goalId: sanitizeIdPart(record.id).slice(0, 96),
      sessionPath,
      createdAt: typeof rawPlan.createdAt === 'number' ? rawPlan.createdAt : now,
      updatedAt: typeof rawPlan.updatedAt === 'number' ? rawPlan.updatedAt : now,
      sourceRefs: normalizeStringArray(rawPlan.sourceRefs, 16),
      steps,
    },
  };
  if (goal.plan.steps.length === 0) {
    goal.plan = buildAoiPlanForGoal({
      goalId: goal.id,
      sessionPath,
      userIntentSummary: goal.userIntentSummary,
      sourceRefs,
      risk,
      now: goal.createdAt,
    });
  }
  return goal;
}

function normalizeProgressEvent(value: unknown): AoiGoalProgressEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<AoiGoalProgressEvent>;
  const sessionPath = normalizeSessionPath(record.sessionPath);
  if (
    record.version !== 1 ||
    typeof record.id !== 'string' ||
    typeof record.goalId !== 'string' ||
    !sessionPath ||
    typeof record.createdAt !== 'number' ||
    typeof record.summary !== 'string'
  ) {
    return null;
  }
  const kind =
    record.kind === 'proposed' ||
    record.kind === 'activated' ||
    record.kind === 'progress' ||
    record.kind === 'blocked' ||
    record.kind === 'completed' ||
    record.kind === 'abandoned' ||
    record.kind === 'paused' ||
    record.kind === 'resumed' ||
    record.kind === 'continuation_proposed'
      ? record.kind
      : 'progress';
  return {
    version: 1,
    id: sanitizeIdPart(record.id).slice(0, 96),
    goalId: sanitizeIdPart(record.goalId).slice(0, 96),
    sessionPath,
    createdAt: record.createdAt,
    kind,
    summary: sanitizeText(record.summary, 200),
    evidenceRefs: normalizeStringArray(record.evidenceRefs, 16),
    observationIds: normalizeStringArray(record.observationIds, 16),
    proposalIds: normalizeStringArray(record.proposalIds, 16),
    ...(typeof record.planStepId === 'string' ? { planStepId: record.planStepId } : {}),
    ...(isGoalStatus(record.fromStatus) ? { fromStatus: record.fromStatus } : {}),
    ...(isGoalStatus(record.toStatus) ? { toStatus: record.toStatus } : {}),
  };
}

function loadGoalList(filePath: string): AoiGoal[] {
  const parsed = readJson<unknown>(filePath);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map(normalizeGoal).filter((goal): goal is AoiGoal => goal !== null);
}

function saveGoalList(filePath: string, goals: AoiGoal[], maxItems: number): AoiGoal[] {
  const normalized = goals
    .map(normalizeGoal)
    .filter((goal): goal is AoiGoal => goal !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maxItems);
  writeJsonAtomic(filePath, normalized);
  return normalized;
}

export function loadAoiActiveGoals(sessionsDir: string, sessionPath: string): AoiGoal[] {
  return loadGoalList(resolveAoiGoalPaths(sessionsDir, sessionPath).activeGoals);
}

export function loadAoiArchivedGoals(sessionsDir: string, sessionPath: string): AoiGoal[] {
  return loadGoalList(resolveAoiGoalPaths(sessionsDir, sessionPath).archivedGoals);
}

export function saveAoiActiveGoals(
  sessionsDir: string,
  sessionPath: string,
  goals: AoiGoal[],
): AoiGoal[] {
  return saveGoalList(
    resolveAoiGoalPaths(sessionsDir, sessionPath).activeGoals,
    goals.filter((goal) => goal.status !== 'completed' && goal.status !== 'abandoned'),
    MAX_ACTIVE_GOALS,
  );
}

export function saveAoiArchivedGoals(
  sessionsDir: string,
  sessionPath: string,
  goals: AoiGoal[],
): AoiGoal[] {
  return saveGoalList(
    resolveAoiGoalPaths(sessionsDir, sessionPath).archivedGoals,
    goals,
    MAX_ARCHIVED_GOALS,
  );
}

export function loadAoiGoalProgressEvents(
  sessionsDir: string,
  sessionPath: string,
): AoiGoalProgressEvent[] {
  const parsed = readJson<unknown>(resolveAoiGoalPaths(sessionsDir, sessionPath).progressEvents);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map(normalizeProgressEvent)
    .filter((event): event is AoiGoalProgressEvent => event !== null)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_PROGRESS_EVENTS);
}

export function appendAoiGoalProgressEvent(
  sessionsDir: string,
  event: AoiGoalProgressEvent,
): AoiGoalProgressEvent {
  const normalized = normalizeProgressEvent(event);
  if (!normalized) {
    throw new Error('Invalid Aoi goal progress event.');
  }
  const paths = resolveAoiGoalPaths(sessionsDir, normalized.sessionPath);
  const events = [
    normalized,
    ...loadAoiGoalProgressEvents(sessionsDir, normalized.sessionPath).filter(
      (item) => item.id !== normalized.id,
    ),
  ]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_PROGRESS_EVENTS);
  writeJsonAtomic(paths.progressEvents, events);
  return normalized;
}

function makeProgressEvent(params: {
  goal: AoiGoal;
  kind: AoiGoalProgressEvent['kind'];
  summary: string;
  now: number;
  evidenceRefs?: string[];
  observationIds?: string[];
  proposalIds?: string[];
  planStepId?: string;
  fromStatus?: AoiGoalStatus;
  toStatus?: AoiGoalStatus;
}): AoiGoalProgressEvent {
  return {
    version: 1,
    id: createGoalId(`aoi-goal-event-${params.kind}`, params.now),
    goalId: params.goal.id,
    sessionPath: params.goal.sessionPath,
    createdAt: params.now,
    kind: params.kind,
    summary: sanitizeText(params.summary, 200),
    evidenceRefs: normalizeStringArray(params.evidenceRefs, 16),
    observationIds: normalizeStringArray(params.observationIds, 16),
    proposalIds: normalizeStringArray(params.proposalIds, 16),
    ...(params.planStepId ? { planStepId: params.planStepId } : {}),
    ...(params.fromStatus ? { fromStatus: params.fromStatus } : {}),
    ...(params.toStatus ? { toStatus: params.toStatus } : {}),
  };
}

function recordGoalRelations(params: {
  sessionsDir: string;
  goal: AoiGoal;
  evidenceRefs: string[];
  proposalIds?: string[];
  observationIds?: string[];
  now: number;
}): void {
  try {
    const goalRef = `goal:${params.goal.id}`;
    const goalNode = makeAoiRelationNode({
      ref: goalRef,
      kind: 'goal',
      label: params.goal.title,
      status:
        params.goal.status === 'completed' || params.goal.status === 'abandoned'
          ? 'archived'
          : 'active',
      now: params.now,
    });
    const nodes = [goalNode];
    const edges = [];
    const refs = [
      ...params.goal.sourceRefs,
      ...params.evidenceRefs,
      ...(params.proposalIds ?? []).map((id) => `proposal:${id}`),
      ...(params.observationIds ?? []).map((id) => `observation:${id}`),
    ];
    for (const ref of [...new Set(refs)].filter(Boolean)) {
      const node = makeAoiRelationNode({ ref, now: params.now });
      nodes.push(node);
      edges.push(
        makeAoiRelationEdge({
          from: node.id,
          to: goalNode.id,
          kind: 'supports',
          evidenceRefs: [ref, goalRef],
          now: params.now,
        }),
      );
    }
    for (const step of params.goal.plan.steps) {
      const stepNode = makeAoiRelationNode({
        ref: `${goalRef}/step:${step.id}`,
        kind: 'topic',
        label: step.title,
        status: step.status === 'done' ? 'archived' : 'active',
        now: params.now,
      });
      nodes.push(stepNode);
      edges.push(
        makeAoiRelationEdge({
          from: goalNode.id,
          to: stepNode.id,
          kind: 'followed_by',
          evidenceRefs: [goalRef, ...step.evidenceRefs].slice(0, 12),
          now: params.now,
        }),
      );
    }
    upsertAoiRelations(params.sessionsDir, params.goal.sessionPath, {
      nodes,
      edges,
      now: params.now,
    });
  } catch {
    // Goal relation writes must never block user-governed goal state.
  }
}

export function buildAoiGoalProposalFromUserMessage(params: {
  sessionPath: string;
  latestUserMessage: string;
  now: number;
  sourceRefs?: string[];
  lang?: AoiCardLang;
}): AoiProposal | null {
  const message = sanitizeText(params.latestUserMessage, TEXT_MAX_CHARS);
  if (!looksLikeExplicitAoiGoalIntent(message)) {
    return null;
  }
  const cardText = aoiCardGoalText(params.lang ?? 'en', 'from_user');
  const sourceRefs = normalizeStringArray(params.sourceRefs ?? ['observation:latest-user-message']);
  const goalId = `goal-candidate-${hashPart(`${params.sessionPath}:${message}`)}`;
  const risk: AoiAutonomyRisk = /(?:보안|security|driver|kernel|커널|위험|배포|release)/i.test(
    message,
  )
    ? 'medium'
    : 'low';
  const plan = buildAoiPlanForGoal({
    goalId,
    sessionPath: params.sessionPath,
    userIntentSummary: message,
    sourceRefs,
    risk,
    now: params.now,
  });
  const title = truncateText(
    message
      .replace(/^(?:목표|goal|objective)\s*[:：-]?\s*/i, '')
      .replace(/(?:관리하자|추적해줘|track this|manage this)/gi, '')
      .trim() || message,
    96,
  );
  return {
    version: 1,
    id: createGoalId('aoi-proposal-goal', params.now),
    sessionPath: params.sessionPath,
    status: 'active',
    title: truncateText(aoiCardGoalTrackPrefix(params.lang ?? 'en', title), 96),
    body: truncateText(cardText.body, 320),
    reason: truncateText(cardText.reason, 240),
    trigger: 'goal_candidate',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: `goal-candidate:${hashPart(`${params.sessionPath}:${message}`)}`,
    confidence: 0.78,
    risk,
    requiredAutonomyLevel: 'L1',
    requiresUserApproval: true,
    suggestedTools: [],
    evidenceRefs: sourceRefs,
    memoryIds: [],
    artifactRefs: [`goal:${goalId}`],
    riskSignals: ['goal-candidate'],
    acceptAction: {
      kind: 'activate_goal',
      params: {
        title,
        userIntentSummary: message,
        sourceRefs,
        confidence: 0.78,
        risk,
        owner: 'shared',
        plan,
      },
    },
  };
}

// P1a c4 (LLM goal-synthesis): build a goal-candidate proposal from an
// LLM-supplied title + intent that was synthesized from observed patterns
// (NOT a user message). The proposal is forced display-only (goal_candidate +
// requiresUserApproval + L1) and carries a DETERMINISTICALLY built plan, so the
// model never fabricates a plan and a goal only ever activates through the
// existing user-acceptance path (activateAoiGoalFromProposal). Evidence-grounded:
// returns null without source refs.
export function buildAoiGoalCandidateProposal(params: {
  sessionPath: string;
  title: string;
  userIntentSummary: string;
  sourceRefs: string[];
  now: number;
  risk?: AoiAutonomyRisk;
  confidence?: number;
  lang?: AoiCardLang;
  // P3.6: LLM-proposed plan steps from the reflection. When they pass the decomposition
  // safety blockers, the candidate carries a decomposed plan; otherwise the deterministic
  // template (buildAoiPlanForGoal is fail-closed).
  planSteps?: unknown;
}): AoiProposal | null {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    return null;
  }
  const title = truncateText(sanitizeText(params.title, 120), 96);
  const userIntentSummary = sanitizeText(params.userIntentSummary, TEXT_MAX_CHARS);
  const sourceRefs = normalizeStringArray(params.sourceRefs, 16);
  if (!title || !userIntentSummary || sourceRefs.length === 0) {
    return null;
  }
  // Goals are not high-risk actions; clamp an over-claimed risk to medium.
  const risk: AoiAutonomyRisk = params.risk === 'high' ? 'medium' : (params.risk ?? 'low');
  const confidence =
    typeof params.confidence === 'number' && params.confidence >= 0 && params.confidence <= 1
      ? params.confidence
      : 0.7;
  const goalId = `goal-candidate-${hashPart(`${sessionPath}:${userIntentSummary}`)}`;
  const plan = buildAoiPlanForGoal({
    goalId,
    sessionPath,
    userIntentSummary,
    sourceRefs,
    risk,
    now: params.now,
    llmProposedSteps: params.planSteps,
  });
  return {
    version: 1,
    id: createGoalId('aoi-proposal-goal-llm', params.now),
    sessionPath,
    status: 'active',
    title: truncateText(aoiCardGoalTrackPrefix(params.lang ?? 'en', title), 96),
    body: truncateText(aoiCardGoalText(params.lang ?? 'en', 'candidate').body, 320),
    reason: truncateText(aoiCardGoalText(params.lang ?? 'en', 'candidate').reason, 240),
    trigger: 'goal_candidate',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: `goal-candidate:${hashPart(`${sessionPath}:${userIntentSummary}`)}`,
    confidence,
    risk,
    requiredAutonomyLevel: 'L1',
    requiresUserApproval: true,
    suggestedTools: [],
    evidenceRefs: sourceRefs,
    memoryIds: [],
    artifactRefs: [`goal:${goalId}`],
    riskSignals: ['goal-candidate', 'llm-goal-synthesis'],
    acceptAction: {
      kind: 'activate_goal',
      params: {
        title,
        userIntentSummary,
        sourceRefs,
        confidence,
        risk,
        owner: 'shared',
        plan,
      },
    },
  };
}

export function activateAoiGoalFromProposal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  now?: number;
}): AoiGoal | null {
  if (params.proposal.acceptAction?.kind !== 'activate_goal') {
    return null;
  }
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath || params.proposal.sessionPath !== sessionPath) {
    throw new Error('Invalid or mismatched sessionPath.');
  }
  const now = params.now ?? Date.now();
  const actionParams = params.proposal.acceptAction.params ?? {};
  const title = sanitizeText(
    typeof actionParams.title === 'string' ? actionParams.title : params.proposal.title,
    120,
  );
  const userIntentSummary = sanitizeText(
    typeof actionParams.userIntentSummary === 'string'
      ? actionParams.userIntentSummary
      : params.proposal.body,
    TEXT_MAX_CHARS,
  );
  const sourceRefs = normalizeStringArray(actionParams.sourceRefs, 16);
  const risk = isRisk(actionParams.risk) ? actionParams.risk : params.proposal.risk;
  const owner = isGoalOwner(actionParams.owner) ? actionParams.owner : 'shared';
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath);
  const duplicate = activeGoals.find(
    (goal) =>
      goal.status !== 'abandoned' &&
      goal.status !== 'completed' &&
      (goal.sourceRefs.some((ref) => sourceRefs.includes(ref)) ||
        overlapScore(goal.userIntentSummary, userIntentSummary) >= 0.75),
  );
  if (duplicate) {
    return duplicate;
  }

  const goalId = createGoalId('aoi-goal', now);
  const providedPlan = normalizeGoal({
    version: 1,
    id: goalId,
    sessionPath,
    title,
    userIntentSummary,
    sourceRefs,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    confidence: clampConfidence(actionParams.confidence, params.proposal.confidence),
    risk,
    owner,
    plan: actionParams.plan,
  })?.plan;
  // P3.6: LLM-decomposed plan steps take precedence over a defaulted template so the
  // reflection's decomposition actually shapes the plan; buildAoiPlanForGoal still safety-
  // blocks + falls back to the template when the steps are unusable.
  const llmProposedSteps = parseAoiProposedPlanStepsParam(actionParams.planSteps);
  const goal: AoiGoal = {
    version: 1,
    id: goalId,
    sessionPath,
    title,
    userIntentSummary,
    sourceRefs,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    confidence: clampConfidence(actionParams.confidence, params.proposal.confidence),
    risk,
    owner,
    plan:
      llmProposedSteps === undefined && providedPlan && providedPlan.steps.length > 0
        ? {
            ...providedPlan,
            id: `plan-${hashPart(goalId)}`,
            goalId,
            sessionPath,
            createdAt: now,
            updatedAt: now,
            sourceRefs,
            steps: providedPlan.steps.map((step) => ({
              ...step,
              id: `step-${sanitizeIdPart(step.kind)}-${hashPart(`${goalId}:${step.title}`)}`,
            })),
          }
        : buildAoiPlanForGoal({
            goalId,
            sessionPath,
            userIntentSummary,
            sourceRefs,
            risk,
            now,
            llmProposedSteps,
          }),
  };
  saveAoiActiveGoals(params.sessionsDir, sessionPath, [goal, ...activeGoals]);
  const event = appendAoiGoalProgressEvent(
    params.sessionsDir,
    makeProgressEvent({
      goal,
      kind: 'activated',
      summary: `Activated Aoi goal from proposal "${params.proposal.title}".`,
      now,
      evidenceRefs: [`proposal:${params.proposal.id}`, ...sourceRefs],
      proposalIds: [params.proposal.id],
      fromStatus: 'proposed',
      toStatus: 'active',
    }),
  );
  recordGoalRelations({
    sessionsDir: params.sessionsDir,
    goal,
    evidenceRefs: event.evidenceRefs,
    proposalIds: [params.proposal.id],
    now,
  });
  return goal;
}

function observationRefs(observation: AoiObservation): string[] {
  return [
    `observation:${observation.id}`,
    ...(observation.payloadRef ? [observation.payloadRef] : []),
    ...observation.memoryIds.map((id) => `memory:${id}`),
    ...observation.proposalIds.map((id) => `proposal:${id}`),
    ...observation.artifactRefs,
  ];
}

function observationMatchesGoal(observation: AoiObservation, goal: AoiGoal): boolean {
  const refs = new Set(observationRefs(observation));
  if (goal.sourceRefs.some((ref) => refs.has(ref))) {
    return true;
  }
  if (refs.has(`goal:${goal.id}`) || [...refs].some((ref) => ref.startsWith(`goal:${goal.id}/`))) {
    return true;
  }
  return (
    overlapScore(observation.summary, goal.title) >= 0.35 ||
    overlapScore(observation.summary, goal.userIntentSummary) >= 0.28
  );
}

function observationLooksFailed(observation: AoiObservation): boolean {
  return (
    observation.riskSignals.some((signal) => /(?:fail|error|interrupted|blocked)/i.test(signal)) ||
    /\b(?:failed|blocked|error|interrupted)\b/i.test(observation.summary) ||
    /(?:실패|차단|오류|중단)/u.test(observation.summary)
  );
}

function observationNeedsUserInput(observation: AoiObservation): boolean {
  return (
    observation.riskSignals.some((signal) => /(?:needs-user|clarification|input)/i.test(signal)) ||
    /\b(?:needs user|waiting for user|clarification required|need input)\b/i.test(
      observation.summary,
    ) ||
    /(?:사용자\s*입력|확인\s*필요|질문이\s*필요|명확화)/u.test(observation.summary)
  );
}

export function firstOpenStep(goal: AoiGoal): AoiPlanStep | null {
  return (
    goal.plan.steps.find((step) => step.status === 'pending' || step.status === 'blocked') ?? null
  );
}

function markFirstOpenStepDone(goal: AoiGoal, evidenceRefs: string[], now: number): AoiGoal {
  let updated = false;
  const steps = goal.plan.steps.map((step) => {
    if (updated || (step.status !== 'pending' && step.status !== 'blocked')) {
      return step;
    }
    updated = true;
    return {
      ...step,
      status: 'done' as const,
      evidenceRefs: [...new Set([...step.evidenceRefs, ...evidenceRefs])].slice(0, 12),
    };
  });
  return {
    ...goal,
    updatedAt: now,
    lastCheckedAt: now,
    plan: {
      ...goal.plan,
      updatedAt: now,
      steps,
    },
  };
}

function transitionGoal(params: {
  goal: AoiGoal;
  status: AoiGoalStatus;
  now: number;
  evidenceRefs: string[];
}): AoiGoal {
  return {
    ...params.goal,
    status: params.status,
    updatedAt: params.now,
    lastCheckedAt: params.now,
    sourceRefs: [...new Set([...params.goal.sourceRefs, ...params.evidenceRefs])].slice(0, 16),
    plan: {
      ...params.goal.plan,
      updatedAt: params.now,
    },
  };
}

export function updateAoiGoalProgressFromObservations(params: {
  sessionsDir: string;
  sessionPath: string;
  observations: AoiObservation[];
  activeProposals?: AoiProposal[];
  now?: number;
}): AoiGoalProgressUpdateResult {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath);
  const archivedGoals = loadAoiArchivedGoals(params.sessionsDir, sessionPath);
  const nextActive: AoiGoal[] = [];
  const nextArchived = [...archivedGoals];
  const events: AoiGoalProgressEvent[] = [];
  const proposals = params.activeProposals ?? [];

  for (const goal of activeGoals) {
    if (goal.status === 'proposed') {
      nextActive.push(goal);
      continue;
    }
    const matching = params.observations.filter((observation) =>
      observationMatchesGoal(observation, goal),
    );
    const evidenceRefs = [...new Set(matching.flatMap(observationRefs))].slice(0, 16);
    const observationIds = matching.map((observation) => observation.id);
    const blockedByPolicy = proposals.some(
      (proposal) =>
        proposal.status === 'blocked' &&
        (proposal.evidenceRefs.includes(`goal:${goal.id}`) ||
          proposal.artifactRefs.includes(`goal:${goal.id}`)),
    );
    const failedCount = matching.filter(observationLooksFailed).length;
    const needsInput = matching.some(observationNeedsUserInput);

    let nextGoal = {
      ...goal,
      lastCheckedAt: now,
      updatedAt: matching.length > 0 ? now : goal.updatedAt,
    };

    if (matching.length > 0 && goal.status === 'active') {
      nextGoal = markFirstOpenStepDone(nextGoal, evidenceRefs, now);
      const step = nextGoal.plan.steps.find((item) => item.status === 'done');
      events.push(
        makeProgressEvent({
          goal: nextGoal,
          kind: 'progress',
          summary: `Observed progress for goal "${goal.title}".`,
          now,
          evidenceRefs,
          observationIds,
          planStepId: step?.id,
        }),
      );
    }

    if ((needsInput || failedCount >= 2 || blockedByPolicy) && evidenceRefs.length > 0) {
      nextGoal = transitionGoal({
        goal: nextGoal,
        status: 'blocked',
        now,
        evidenceRefs,
      });
      const openStep = firstOpenStep(nextGoal);
      if (openStep) {
        nextGoal = {
          ...nextGoal,
          plan: {
            ...nextGoal.plan,
            steps: nextGoal.plan.steps.map((step) =>
              step.id === openStep.id ? { ...step, status: 'blocked' as const } : step,
            ),
          },
        };
      }
      events.push(
        makeProgressEvent({
          goal: nextGoal,
          kind: 'blocked',
          summary: `Goal "${goal.title}" is blocked by evidence.`,
          now,
          evidenceRefs,
          observationIds,
          fromStatus: goal.status,
          toStatus: 'blocked',
          planStepId: openStep?.id,
        }),
      );
    }

    nextActive.push(nextGoal);
  }

  saveAoiActiveGoals(params.sessionsDir, sessionPath, nextActive);
  saveAoiArchivedGoals(params.sessionsDir, sessionPath, nextArchived);
  for (const event of events) {
    appendAoiGoalProgressEvent(params.sessionsDir, event);
    const goal = [...nextActive, ...nextArchived].find((item) => item.id === event.goalId);
    if (goal) {
      recordGoalRelations({
        sessionsDir: params.sessionsDir,
        goal,
        evidenceRefs: event.evidenceRefs,
        observationIds: event.observationIds,
        proposalIds: event.proposalIds,
        now,
      });
    }
  }

  return {
    activeGoals: nextActive,
    archivedGoals: nextArchived.slice(0, MAX_ARCHIVED_GOALS),
    events,
  };
}

function outcomeSignalIsValidatedCompletion(outcome: AoiOutcomeSignalRecord): boolean {
  if (outcome.privacyState === 'synthetic' || outcome.validationPassed !== true) {
    return false;
  }
  if (
    outcome.outcomeKind !== 'validation_run' &&
    outcome.outcomeKind !== 'proposal_executed' &&
    outcome.outcomeKind !== 'commit_created'
  ) {
    return false;
  }
  if (outcome.outcomeKind === 'commit_created') {
    return Boolean(outcome.sourceCommitRef && outcome.sourceValidationRef);
  }
  return Boolean(outcome.sourceValidationRef);
}

function outcomeSignalRefs(outcome: AoiOutcomeSignalRecord): string[] {
  return [
    `outcome:${outcome.id}`,
    `outcome:${outcome.eventId}`,
    ...(outcome.sourceProposalId ? [`proposal:${outcome.sourceProposalId}`] : []),
    ...(outcome.sourceDecisionId ? [`decision:${outcome.sourceDecisionId}`] : []),
    ...(outcome.sourceValidationRef ? [outcome.sourceValidationRef] : []),
    ...(outcome.sourceCommitRef ? [outcome.sourceCommitRef] : []),
    ...outcome.evidenceRefs,
  ];
}

function proposalMatchesGoal(proposal: AoiProposal, goal: AoiGoal): boolean {
  return [...proposal.evidenceRefs, ...proposal.artifactRefs].some(
    (ref) => ref === `goal:${goal.id}` || ref.startsWith(`goal:${goal.id}/step:`),
  );
}

function outcomeSignalMatchesGoal(params: {
  outcome: AoiOutcomeSignalRecord;
  goal: AoiGoal;
  proposals: readonly AoiProposal[];
}): boolean {
  if (
    outcomeSignalRefs(params.outcome).some(
      (ref) => ref === `goal:${params.goal.id}` || ref.startsWith(`goal:${params.goal.id}/step:`),
    )
  ) {
    return true;
  }
  const sourceProposal = params.outcome.sourceProposalId
    ? params.proposals.find((proposal) => proposal.id === params.outcome.sourceProposalId)
    : undefined;
  return sourceProposal ? proposalMatchesGoal(sourceProposal, params.goal) : false;
}

function findOutcomeSignalGoalStep(params: {
  goal: AoiGoal;
  outcome: AoiOutcomeSignalRecord;
  proposals: readonly AoiProposal[];
}): AoiPlanStep | null {
  const sourceProposal = params.outcome.sourceProposalId
    ? params.proposals.find((proposal) => proposal.id === params.outcome.sourceProposalId)
    : undefined;
  const refs = [
    ...outcomeSignalRefs(params.outcome),
    ...(sourceProposal?.evidenceRefs ?? []),
    ...(sourceProposal?.artifactRefs ?? []),
  ];
  const stepPrefix = `goal:${params.goal.id}/step:`;
  const directStepId = refs.find((ref) => ref.startsWith(stepPrefix))?.slice(stepPrefix.length);
  if (directStepId) {
    const direct = params.goal.plan.steps.find((step) => step.id === directStepId);
    if (direct) {
      return direct;
    }
  }
  return params.goal.plan.steps.length === 1 ? firstOpenStep(params.goal) : null;
}

export function updateAoiGoalProgressFromOutcomeSignals(params: {
  sessionsDir: string;
  sessionPath: string;
  outcomes: readonly AoiOutcomeSignalRecord[];
  proposals?: readonly AoiProposal[];
  now?: number;
}): AoiOutcomeSignalGoalProgressResult {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const proposals = params.proposals ?? [];
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath);
  const archivedGoals = loadAoiArchivedGoals(params.sessionsDir, sessionPath);
  const nextActive: AoiGoal[] = [];
  const nextArchived = [...archivedGoals];
  const events: AoiGoalProgressEvent[] = [];
  const updatedOutcomeIds: string[] = [];

  for (const goal of activeGoals) {
    if (goal.status !== 'active') {
      nextActive.push(goal);
      continue;
    }
    let nextGoal = goal;
    let completed = false;
    for (const outcome of params.outcomes) {
      if (
        !outcomeSignalIsValidatedCompletion(outcome) ||
        !outcomeSignalMatchesGoal({ outcome, goal: nextGoal, proposals })
      ) {
        continue;
      }
      const evidenceRefs = [...new Set(outcomeSignalRefs(outcome))].slice(0, 16);
      if (
        nextGoal.plan.steps.length > 0 &&
        nextGoal.plan.steps.every((item) => item.status === 'done')
      ) {
        nextGoal = transitionGoal({
          goal: {
            ...nextGoal,
            updatedAt: now,
            lastCheckedAt: now,
            sourceRefs: [...new Set([...nextGoal.sourceRefs, ...evidenceRefs])].slice(0, 16),
          },
          status: 'completed',
          now,
          evidenceRefs,
        });
        updatedOutcomeIds.push(outcome.id);
        events.push(
          makeProgressEvent({
            goal: nextGoal,
            kind: 'completed',
            summary: `Goal "${goal.title}" completed from validated outcome evidence.`,
            now,
            evidenceRefs,
            proposalIds: outcome.sourceProposalId ? [outcome.sourceProposalId] : [],
            fromStatus: goal.status,
            toStatus: 'completed',
          }),
        );
        completed = true;
        break;
      }
      const step = findOutcomeSignalGoalStep({ goal: nextGoal, outcome, proposals });
      if (!step || step.status === 'done') {
        continue;
      }
      nextGoal = {
        ...nextGoal,
        updatedAt: now,
        lastCheckedAt: now,
        sourceRefs: [...new Set([...nextGoal.sourceRefs, ...evidenceRefs])].slice(0, 16),
        plan: {
          ...nextGoal.plan,
          updatedAt: now,
          steps: nextGoal.plan.steps.map((item) =>
            item.id === step.id
              ? {
                  ...item,
                  status: 'done' as const,
                  evidenceRefs: [...new Set([...item.evidenceRefs, ...evidenceRefs])].slice(0, 12),
                }
              : item,
          ),
        },
      };
      updatedOutcomeIds.push(outcome.id);
      if (nextGoal.plan.steps.every((item) => item.status === 'done')) {
        nextGoal = transitionGoal({
          goal: nextGoal,
          status: 'completed',
          now,
          evidenceRefs,
        });
        events.push(
          makeProgressEvent({
            goal: nextGoal,
            kind: 'completed',
            summary: `Goal "${goal.title}" completed from validated outcome evidence.`,
            now,
            evidenceRefs,
            proposalIds: outcome.sourceProposalId ? [outcome.sourceProposalId] : [],
            planStepId: step.id,
            fromStatus: goal.status,
            toStatus: 'completed',
          }),
        );
        completed = true;
        break;
      }
      events.push(
        makeProgressEvent({
          goal: nextGoal,
          kind: 'progress',
          summary: `Validated outcome completed plan step "${step.title}".`,
          now,
          evidenceRefs,
          proposalIds: outcome.sourceProposalId ? [outcome.sourceProposalId] : [],
          planStepId: step.id,
        }),
      );
    }
    if (completed) {
      nextArchived.unshift(nextGoal);
    } else {
      nextActive.push(nextGoal);
    }
  }

  saveAoiActiveGoals(params.sessionsDir, sessionPath, nextActive);
  saveAoiArchivedGoals(params.sessionsDir, sessionPath, nextArchived);
  for (const event of events) {
    appendAoiGoalProgressEvent(params.sessionsDir, event);
    const goal = [...nextActive, ...nextArchived].find((item) => item.id === event.goalId);
    if (goal) {
      recordGoalRelations({
        sessionsDir: params.sessionsDir,
        goal,
        evidenceRefs: event.evidenceRefs,
        proposalIds: event.proposalIds,
        now,
      });
    }
  }
  return {
    activeGoals: nextActive,
    archivedGoals: nextArchived.slice(0, MAX_ARCHIVED_GOALS),
    events,
    updatedOutcomeIds: [...new Set(updatedOutcomeIds)],
  };
}

function outcomeRefs(outcome: AoiKiraOutcomeEvent): string[] {
  return [
    `event:${outcome.id}`,
    outcome.workRef,
    outcome.attemptId ? `kira-attempt:${outcome.attemptId}` : undefined,
    outcome.reviewId ? `kira-review:${outcome.reviewId}` : undefined,
    outcome.sourceProposalId ? `proposal:${outcome.sourceProposalId}` : undefined,
    outcome.sourceGoalId ? `goal:${outcome.sourceGoalId}` : undefined,
    outcome.sourceGoalId && outcome.sourcePlanStepId
      ? `goal:${outcome.sourceGoalId}/step:${outcome.sourcePlanStepId}`
      : undefined,
    ...outcome.evidenceRefs,
  ].filter((ref): ref is string => Boolean(ref));
}

function outcomeMatchesGoal(outcome: AoiKiraOutcomeEvent, goal: AoiGoal): boolean {
  if (outcome.sourceGoalId === goal.id) {
    return true;
  }
  const refs = new Set(outcomeRefs(outcome));
  if (refs.has(`goal:${goal.id}`)) {
    return true;
  }
  return goal.sourceRefs.some((ref) => refs.has(ref));
}

function findKiraOutcomeStep(goal: AoiGoal, outcome: AoiKiraOutcomeEvent): AoiPlanStep | null {
  if (outcome.sourcePlanStepId) {
    const direct = goal.plan.steps.find((step) => step.id === outcome.sourcePlanStepId);
    if (direct) {
      return direct;
    }
  }
  const refs = new Set(outcomeRefs(outcome));
  const evidenceMatch = goal.plan.steps.find((step) =>
    [...step.expectedEvidence, ...step.evidenceRefs].some((ref) => refs.has(ref)),
  );
  if (evidenceMatch) {
    return evidenceMatch;
  }
  return (
    goal.plan.steps.find(
      (step) =>
        step.kind === 'handoff_kira' &&
        (step.status === 'pending' || step.status === 'in_progress' || step.status === 'blocked'),
    ) ??
    goal.plan.steps.find(
      (step) =>
        step.status === 'pending' || step.status === 'in_progress' || step.status === 'blocked',
    ) ??
    null
  );
}

function kiraOutcomeIsReviewedCompletion(outcome: AoiKiraOutcomeEvent): boolean {
  return (
    (outcome.kind === 'kira_work_completed' || outcome.kind === 'kira_integrated') &&
    outcome.reviewApproved === true &&
    outcome.validationPassed
  );
}

function updateStepForKiraOutcome(params: {
  step: AoiPlanStep;
  outcome: AoiKiraOutcomeEvent;
  evidenceRefs: string[];
}): AoiPlanStep {
  if (kiraOutcomeIsReviewedCompletion(params.outcome)) {
    return {
      ...params.step,
      status: 'done',
      evidenceRefs: [...new Set([...params.step.evidenceRefs, ...params.evidenceRefs])].slice(
        0,
        12,
      ),
    };
  }
  if (params.outcome.kind === 'kira_needs_clarification') {
    return {
      ...params.step,
      kind: 'ask_user',
      title: truncateText(`Answer Kira clarification: ${params.outcome.workTitle}`, 120),
      status: 'pending',
      allowedActionKind: 'none',
      doneCriteria: ['User answers the Kira clarification request.'],
      evidenceRefs: [...new Set([...params.step.evidenceRefs, ...params.evidenceRefs])].slice(
        0,
        12,
      ),
    };
  }
  return {
    ...params.step,
    status: 'blocked',
    evidenceRefs: [...new Set([...params.step.evidenceRefs, ...params.evidenceRefs])].slice(0, 12),
  };
}

export function updateAoiGoalProgressFromKiraOutcomes(params: {
  sessionsDir: string;
  sessionPath: string;
  outcomes: AoiKiraOutcomeEvent[];
  observations?: AoiObservation[];
  now?: number;
}): AoiKiraOutcomeGoalProgressResult {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath);
  const archivedGoals = loadAoiArchivedGoals(params.sessionsDir, sessionPath);
  const nextActive: AoiGoal[] = [];
  const events: AoiGoalProgressEvent[] = [];
  const updatedOutcomeIds: string[] = [];
  const observationsByOutcomeId = new Map(
    (params.observations ?? [])
      .filter((observation) => observation.payloadRef?.startsWith('event:'))
      .map((observation) => [observation.payloadRef?.slice('event:'.length), observation]),
  );

  for (const goal of activeGoals) {
    let nextGoal = goal;
    for (const outcome of params.outcomes) {
      if (!outcomeMatchesGoal(outcome, nextGoal)) {
        continue;
      }
      const step = findKiraOutcomeStep(nextGoal, outcome);
      if (!step) {
        continue;
      }
      const evidenceRefs = [...new Set(outcomeRefs(outcome))].slice(0, 16);
      const nextStep = updateStepForKiraOutcome({ step, outcome, evidenceRefs });
      if (
        nextStep.status === step.status &&
        nextStep.kind === step.kind &&
        nextStep.evidenceRefs.join('\n') === step.evidenceRefs.join('\n')
      ) {
        continue;
      }
      const fromStatus = nextGoal.status;
      const nextStatus: AoiGoalStatus =
        nextStep.status === 'blocked'
          ? 'blocked'
          : nextGoal.status === 'blocked'
            ? 'active'
            : nextGoal.status;
      nextGoal = {
        ...nextGoal,
        status: nextStatus,
        updatedAt: now,
        lastCheckedAt: now,
        sourceRefs: [...new Set([...nextGoal.sourceRefs, ...evidenceRefs])].slice(0, 16),
        plan: {
          ...nextGoal.plan,
          updatedAt: now,
          steps: nextGoal.plan.steps.map((item) => (item.id === step.id ? nextStep : item)),
        },
      };
      const observation = observationsByOutcomeId.get(outcome.id);
      const event = makeProgressEvent({
        goal: nextGoal,
        kind: nextStep.status === 'blocked' ? 'blocked' : 'progress',
        summary:
          nextStep.status === 'done'
            ? `Kira reviewed outcome completed plan step "${step.title}".`
            : outcome.kind === 'kira_needs_clarification'
              ? `Kira needs clarification for plan step "${step.title}".`
              : `Kira outcome blocked plan step "${step.title}".`,
        now,
        evidenceRefs,
        observationIds: observation ? [observation.id] : [],
        proposalIds: outcome.sourceProposalId ? [outcome.sourceProposalId] : [],
        planStepId: step.id,
        fromStatus,
        toStatus: nextStatus,
      });
      events.push(event);
      updatedOutcomeIds.push(outcome.id);
    }
    nextActive.push(nextGoal);
  }

  const savedActive = saveAoiActiveGoals(params.sessionsDir, sessionPath, nextActive);
  const savedArchived = saveAoiArchivedGoals(params.sessionsDir, sessionPath, archivedGoals);
  for (const event of events) {
    appendAoiGoalProgressEvent(params.sessionsDir, event);
    const goal = savedActive.find((item) => item.id === event.goalId);
    if (goal) {
      recordGoalRelations({
        sessionsDir: params.sessionsDir,
        goal,
        evidenceRefs: event.evidenceRefs,
        observationIds: event.observationIds,
        proposalIds: event.proposalIds,
        now,
      });
    }
  }

  return {
    activeGoals: savedActive,
    archivedGoals: savedArchived,
    events,
    updatedOutcomeIds,
  };
}

export function buildAoiGoalContinuationProposals(params: {
  sessionsDir: string;
  sessionPath: string;
  observations: AoiObservation[];
  activeProposals: AoiProposal[];
  now: number;
  lang?: AoiCardLang;
}): AoiProposal[] {
  const lang: AoiCardLang = params.lang ?? 'en';
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath).filter(
    (goal) => goal.status === 'active' || goal.status === 'blocked',
  );
  const existingCooldowns = new Set(
    params.activeProposals
      .filter(
        (proposal) =>
          proposal.status === 'active' ||
          proposal.status === 'accepted' ||
          proposal.status === 'snoozed',
      )
      .map((proposal) => proposal.cooldownKey),
  );
  const proposals: AoiProposal[] = [];

  for (const goal of activeGoals) {
    const step = firstOpenStep(goal);
    if (!step) {
      continue;
    }
    const matching = params.observations.filter((observation) =>
      observationMatchesGoal(observation, goal),
    );
    const evidenceRefs = [
      `goal:${goal.id}`,
      `goal:${goal.id}/step:${step.id}`,
      ...goal.sourceRefs,
      ...matching.slice(0, 4).map((observation) => `observation:${observation.id}`),
    ];
    const cooldownKey = `goal-continuation:${goal.id}:${step.id}:${step.status}`;
    if (existingCooldowns.has(cooldownKey)) {
      continue;
    }
    const suggestedTools = step.allowedActionKind === 'start_research' ? ['start_research'] : [];
    const acceptAction =
      step.allowedActionKind === 'start_research'
        ? {
            kind: 'start_research' as const,
            params: {
              sessionPath,
              request: goal.userIntentSummary,
              mode: 'standard',
              maxSources: 12,
            },
          }
        : undefined;
    proposals.push({
      version: 1,
      id: createGoalId('aoi-proposal-goal-continuation', params.now),
      sessionPath,
      status: 'active',
      title: truncateText(aoiCardGoalContinuePrefix(lang, step.title), 96),
      body: truncateText(
        aoiCardGoalContinuationBody(lang, { goalTitle: goal.title, stepTitle: step.title }),
        320,
      ),
      reason: truncateText(aoiCardGoalContinuationReason(lang, goal.status === 'blocked'), 240),
      trigger: 'goal_continuation',
      createdAt: params.now,
      updatedAt: params.now,
      cooldownKey,
      confidence: goal.status === 'blocked' ? 0.74 : 0.78,
      risk: step.risk,
      requiredAutonomyLevel: step.requiredAutonomyLevel,
      requiresUserApproval: step.risk === 'high' || suggestedTools.length > 0,
      suggestedTools,
      evidenceRefs: [...new Set(evidenceRefs)].slice(0, 12),
      memoryIds: [],
      artifactRefs: [`goal:${goal.id}`, `goal:${goal.id}/step:${step.id}`],
      riskSignals: ['goal-continuation', ...(goal.status === 'blocked' ? ['goal-blocked'] : [])],
      ...(acceptAction ? { acceptAction } : {}),
    });
    existingCooldowns.add(cooldownKey);
  }

  return proposals;
}

export function recordAoiGoalContinuationProposed(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  now?: number;
}): void {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath || params.proposal.trigger !== 'goal_continuation') {
    return;
  }
  const goalRef = params.proposal.artifactRefs.find((ref) => /^goal:[^/]+$/.test(ref));
  const goalId = goalRef?.slice('goal:'.length);
  if (!goalId) {
    return;
  }
  const goal = loadAoiActiveGoals(params.sessionsDir, sessionPath).find(
    (item) => item.id === goalId,
  );
  if (!goal) {
    return;
  }
  const now = params.now ?? Date.now();
  const stepRef = params.proposal.artifactRefs.find((ref) => ref.startsWith(`${goalRef}/step:`));
  const event = appendAoiGoalProgressEvent(
    params.sessionsDir,
    makeProgressEvent({
      goal,
      kind: 'continuation_proposed',
      summary: `Proposed continuation for goal "${goal.title}".`,
      now,
      evidenceRefs: params.proposal.evidenceRefs,
      proposalIds: [params.proposal.id],
      planStepId: stepRef?.slice(`${goalRef}/step:`.length),
    }),
  );
  recordGoalRelations({
    sessionsDir: params.sessionsDir,
    goal,
    evidenceRefs: event.evidenceRefs,
    proposalIds: [params.proposal.id],
    now,
  });
}

export function recordAoiGoalRecoverySignal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal?: AoiProposal;
  evidenceRefs: string[];
  summary: string;
  now?: number;
}): AoiGoalProgressEvent | null {
  const sessionPath = normalizeSessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const evidenceRefs = normalizeStringArray(params.evidenceRefs, 16);
  const goalRef = evidenceRefs.find((ref) => /^goal:[^/]+$/.test(ref));
  const goalId = goalRef?.slice('goal:'.length);
  if (!goalId) {
    return null;
  }
  const now = params.now ?? Date.now();
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath);
  const index = activeGoals.findIndex((goal) => goal.id === goalId);
  if (index < 0) {
    return null;
  }
  const current = activeGoals[index];
  const stepRef = evidenceRefs.find((ref) => ref.startsWith(`${goalRef}/step:`));
  const stepId = stepRef?.slice(`${goalRef}/step:`.length);
  const openStep =
    (stepId ? current.plan.steps.find((step) => step.id === stepId) : null) ??
    firstOpenStep(current);
  const nextStatus: AoiGoalStatus = current.status === 'active' ? 'blocked' : current.status;
  const nextGoal: AoiGoal = {
    ...current,
    status: nextStatus,
    updatedAt: now,
    lastCheckedAt: now,
    sourceRefs: [...new Set([...current.sourceRefs, ...evidenceRefs])].slice(0, 16),
    plan: {
      ...current.plan,
      updatedAt: now,
      steps: current.plan.steps.map((step) =>
        openStep && step.id === openStep.id
          ? {
              ...step,
              status: 'blocked' as const,
              evidenceRefs: [...new Set([...step.evidenceRefs, ...evidenceRefs])].slice(0, 12),
            }
          : step,
      ),
    },
  };
  const nextActive = [...activeGoals];
  nextActive[index] = nextGoal;
  saveAoiActiveGoals(params.sessionsDir, sessionPath, nextActive);

  const event = appendAoiGoalProgressEvent(
    params.sessionsDir,
    makeProgressEvent({
      goal: nextGoal,
      kind: 'blocked',
      summary: params.summary,
      now,
      evidenceRefs: [
        ...(params.proposal ? [`proposal:${params.proposal.id}`] : []),
        ...evidenceRefs,
      ],
      proposalIds: params.proposal ? [params.proposal.id] : [],
      planStepId: openStep?.id,
      fromStatus: current.status,
      toStatus: nextStatus,
    }),
  );
  recordGoalRelations({
    sessionsDir: params.sessionsDir,
    goal: nextGoal,
    evidenceRefs: event.evidenceRefs,
    proposalIds: params.proposal ? [params.proposal.id] : [],
    now,
  });
  return event;
}

export function applyAoiGoalDecision(
  sessionsDir: string,
  sessionPath: string,
  input: AoiGoalDecisionInput,
): AoiGoal {
  const normalizedSessionPath = normalizeSessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const activeGoals = loadAoiActiveGoals(sessionsDir, normalizedSessionPath);
  const archivedGoals = loadAoiArchivedGoals(sessionsDir, normalizedSessionPath);
  const index = activeGoals.findIndex((goal) => goal.id === input.goalId);
  if (index < 0) {
    throw new Error('Aoi goal not found.');
  }
  const current = activeGoals[index];
  const evidenceRefs = normalizeStringArray(input.evidenceRefs, 16);
  if ((input.action === 'block' || input.action === 'complete') && evidenceRefs.length === 0) {
    if (input.action !== 'complete' || input.userConfirmed !== true) {
      throw new Error('Goal status transition requires evidence or explicit user confirmation.');
    }
  }
  const nextStatus: AoiGoalStatus =
    input.action === 'pause'
      ? 'paused'
      : input.action === 'resume'
        ? 'active'
        : input.action === 'abandon'
          ? 'abandoned'
          : input.action === 'block'
            ? 'blocked'
            : 'completed';
  const nextGoal = transitionGoal({
    goal: current,
    status: nextStatus,
    now,
    evidenceRefs,
  });
  const nextActive = [...activeGoals];
  nextActive.splice(index, 1);
  if (nextStatus !== 'completed' && nextStatus !== 'abandoned') {
    nextActive.unshift(nextGoal);
  }
  const nextArchived =
    nextStatus === 'completed' || nextStatus === 'abandoned'
      ? [nextGoal, ...archivedGoals]
      : archivedGoals;
  saveAoiActiveGoals(sessionsDir, normalizedSessionPath, nextActive);
  saveAoiArchivedGoals(sessionsDir, normalizedSessionPath, nextArchived);
  const eventKind =
    nextStatus === 'paused'
      ? 'paused'
      : nextStatus === 'active'
        ? 'resumed'
        : nextStatus === 'abandoned'
          ? 'abandoned'
          : nextStatus === 'blocked'
            ? 'blocked'
            : 'completed';
  const event = appendAoiGoalProgressEvent(
    sessionsDir,
    makeProgressEvent({
      goal: nextGoal,
      kind: eventKind,
      summary: input.reason || `Goal "${nextGoal.title}" moved to ${nextStatus}.`,
      now,
      evidenceRefs,
      fromStatus: current.status,
      toStatus: nextStatus,
    }),
  );
  recordGoalRelations({
    sessionsDir,
    goal: nextGoal,
    evidenceRefs: event.evidenceRefs,
    now,
  });
  return nextGoal;
}
