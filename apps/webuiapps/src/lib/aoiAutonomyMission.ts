import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  loadAoiActiveGoals,
  loadAoiArchivedGoals,
  loadAoiGoalProgressEvents,
} from './aoiAutonomyGoals';
import {
  loadAoiActiveProposals,
  loadAoiObservations,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import { loadAoiRelationIndex, recordAoiMissionStateRelations } from './aoiAutonomyRelations';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import { listAoiResearchRunSummaries } from './aoiResearchPlugin';
import type {
  AoiGoal,
  AoiMissionDecisionAction,
  AoiMissionRecommendedAction,
  AoiMissionSourceRefs,
  AoiMissionState,
  AoiMissionStatus,
  AoiMissionTransitionRef,
  AoiMissionWaitingOn,
  AoiObservation,
  AoiPlanStep,
  AoiProposal,
  AoiProposalDecision,
} from './aoiAutonomyTypes';
import type { AoiResearchRunSummary } from './aoiResearchTypes';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const MISSION_FILE_NAME = 'mission-state.json';
const MAX_EVIDENCE_REFS = 16;
const MAX_TRANSITIONS = 12;
const FOCUS_MAX_CHARS = 180;
const ACTION_MAX_CHARS = 160;

export interface AoiMissionDecisionInput {
  action: AoiMissionDecisionAction;
  reason?: string;
  evidenceRefs?: string[];
  now?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeStringArray(value: unknown, maxItems = MAX_EVIDENCE_REFS): string[] {
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

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = truncateText(value, maxChars);
  return normalized || undefined;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveMissionFile(
  sessionsDir: string,
  sessionPath: string,
): {
  sessionPath: string;
  filePath: string;
} {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(
    sessionsRoot,
    normalizedSessionPath,
    AUTONOMY_ROOT_DIR,
    MISSION_FILE_NAME,
  );
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi mission state path escaped the sessions directory.');
  }
  return {
    sessionPath: normalizedSessionPath,
    filePath,
  };
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

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function isMissionStatus(value: unknown): value is AoiMissionStatus {
  return (
    value === 'none' ||
    value === 'active' ||
    value === 'waiting_on_user' ||
    value === 'waiting_on_kira' ||
    value === 'waiting_on_research' ||
    value === 'paused' ||
    value === 'completed' ||
    value === 'blocked'
  );
}

function isMissionWaitingOn(value: unknown): value is AoiMissionWaitingOn {
  return (
    value === 'none' ||
    value === 'aoi' ||
    value === 'user' ||
    value === 'kira' ||
    value === 'research'
  );
}

function normalizeRecommendedAction(value: unknown): AoiMissionRecommendedAction {
  const raw =
    value && typeof value === 'object' ? (value as Partial<AoiMissionRecommendedAction>) : {};
  const kind =
    raw.kind === 'review_goal' ||
    raw.kind === 'answer_user' ||
    raw.kind === 'wait_for_user' ||
    raw.kind === 'inspect_kira' ||
    raw.kind === 'inspect_research' ||
    raw.kind === 'prepare_research' ||
    raw.kind === 'prepare_kira' ||
    raw.kind === 'resume_mission'
      ? raw.kind
      : 'none';
  return {
    kind,
    label: normalizeOptionalText(raw.label, ACTION_MAX_CHARS) || 'No immediate action.',
    reason: normalizeOptionalText(raw.reason, ACTION_MAX_CHARS) || 'No active mission focus.',
    ...(normalizeOptionalText(raw.ref, 240) ? { ref: normalizeOptionalText(raw.ref, 240) } : {}),
  };
}

function normalizeSourceRefs(value: unknown): AoiMissionSourceRefs {
  const raw = value && typeof value === 'object' ? (value as Partial<AoiMissionSourceRefs>) : {};
  return {
    ...(normalizeOptionalText(raw.goalRef, 240)
      ? { goalRef: normalizeOptionalText(raw.goalRef, 240) }
      : {}),
    ...(normalizeOptionalText(raw.planStepRef, 240)
      ? { planStepRef: normalizeOptionalText(raw.planStepRef, 240) }
      : {}),
    ...(normalizeOptionalText(raw.proposalRef, 240)
      ? { proposalRef: normalizeOptionalText(raw.proposalRef, 240) }
      : {}),
    ...(normalizeOptionalText(raw.decisionRef, 240)
      ? { decisionRef: normalizeOptionalText(raw.decisionRef, 240) }
      : {}),
    ...(normalizeOptionalText(raw.observationRef, 240)
      ? { observationRef: normalizeOptionalText(raw.observationRef, 240) }
      : {}),
    ...(normalizeOptionalText(raw.researchRunRef, 240)
      ? { researchRunRef: normalizeOptionalText(raw.researchRunRef, 240) }
      : {}),
    ...(normalizeOptionalText(raw.kiraWorkRef, 240)
      ? { kiraWorkRef: normalizeOptionalText(raw.kiraWorkRef, 240) }
      : {}),
  };
}

function normalizeTransition(value: unknown): AoiMissionTransitionRef | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<AoiMissionTransitionRef>;
  if (!isMissionStatus(raw.from) || !isMissionStatus(raw.to) || typeof raw.createdAt !== 'number') {
    return null;
  }
  return {
    from: raw.from,
    to: raw.to,
    createdAt: raw.createdAt,
    reason: normalizeOptionalText(raw.reason, ACTION_MAX_CHARS) || `${raw.from} -> ${raw.to}`,
    evidenceRefs: normalizeStringArray(raw.evidenceRefs, MAX_EVIDENCE_REFS),
  };
}

function normalizeMissionState(value: unknown, sessionPath: string): AoiMissionState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<AoiMissionState>;
  if (raw.version !== 1 || !isMissionStatus(raw.status) || !isMissionWaitingOn(raw.waitingOn)) {
    return null;
  }
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath) || sessionPath;
  if (normalizedSessionPath !== sessionPath) {
    return null;
  }
  return {
    version: 1,
    sessionPath,
    status: raw.status,
    ...(typeof raw.activeGoalId === 'string' && raw.activeGoalId.trim()
      ? { activeGoalId: raw.activeGoalId.trim().slice(0, 120) }
      : {}),
    focusSummary: normalizeOptionalText(raw.focusSummary, FOCUS_MAX_CHARS) || 'No active mission.',
    waitingOn: raw.waitingOn,
    ...(normalizeOptionalText(raw.lastMeaningfulEventRef, 240)
      ? { lastMeaningfulEventRef: normalizeOptionalText(raw.lastMeaningfulEventRef, 240) }
      : {}),
    nextRecommendedAction: normalizeRecommendedAction(raw.nextRecommendedAction),
    evidenceRefs: normalizeStringArray(raw.evidenceRefs, MAX_EVIDENCE_REFS),
    sourceRefs: normalizeSourceRefs(raw.sourceRefs),
    transitions: Array.isArray(raw.transitions)
      ? raw.transitions
          .map(normalizeTransition)
          .filter((item): item is AoiMissionTransitionRef => item !== null)
          .slice(0, MAX_TRANSITIONS)
      : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    ...(typeof raw.pausedAt === 'number' ? { pausedAt: raw.pausedAt } : {}),
    ...(normalizeOptionalText(raw.blockedReason, ACTION_MAX_CHARS)
      ? { blockedReason: normalizeOptionalText(raw.blockedReason, ACTION_MAX_CHARS) }
      : {}),
  };
}

function makeEmptyMissionState(sessionPath: string, now: number): AoiMissionState {
  return {
    version: 1,
    sessionPath,
    status: 'none',
    focusSummary: 'No active mission.',
    waitingOn: 'none',
    nextRecommendedAction: {
      kind: 'none',
      label: 'No immediate action.',
      reason: 'No active mission focus.',
    },
    evidenceRefs: [],
    sourceRefs: {},
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function dedupeRefs(refs: Array<string | undefined>): string[] {
  return [...new Set(refs.filter((ref): ref is string => Boolean(ref && ref.trim())))].slice(
    0,
    MAX_EVIDENCE_REFS,
  );
}

function firstOpenStep(goal: AoiGoal): AoiPlanStep | null {
  return (
    goal.plan.steps.find((step) => step.status === 'in_progress') ??
    goal.plan.steps.find((step) => step.status === 'pending') ??
    goal.plan.steps.find((step) => step.status === 'blocked') ??
    null
  );
}

function proposalRefs(proposal: AoiProposal): string[] {
  return [
    `proposal:${proposal.id}`,
    ...proposal.evidenceRefs,
    ...proposal.artifactRefs,
    ...proposal.memoryIds.map((id) => `memory:${id}`),
  ];
}

function proposalMatchesGoal(
  proposal: AoiProposal,
  goal: AoiGoal,
  step: AoiPlanStep | null,
): boolean {
  const refs = new Set(proposalRefs(proposal));
  const goalRef = `goal:${goal.id}`;
  const stepRef = step ? `${goalRef}/step:${step.id}` : '';
  return (
    refs.has(goalRef) ||
    (stepRef ? refs.has(stepRef) : false) ||
    proposal.cooldownKey.startsWith(`goal-continuation:${goal.id}:`)
  );
}

function latestObservationRef(observations: AoiObservation[], goal: AoiGoal): string | undefined {
  const goalRef = `goal:${goal.id}`;
  const match = observations
    .filter((observation) =>
      [
        observation.payloadRef,
        ...observation.artifactRefs,
        ...observation.proposalIds.map((id) => `proposal:${id}`),
      ].some((ref) => typeof ref === 'string' && ref.startsWith(goalRef)),
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return match ? `observation:${match.id}` : undefined;
}

function latestDecisionRef(
  decisions: AoiProposalDecision[],
  proposal: AoiProposal | undefined,
): string | undefined {
  if (!proposal) {
    return decisions[0] ? `decision:${decisions[0].id}` : undefined;
  }
  const match = decisions.find((decision) => decision.proposalId === proposal.id);
  return match ? `decision:${match.id}` : undefined;
}

function findKiraWorkRef(params: {
  sessionsDir: string;
  sessionPath: string;
  goalRef: string;
  proposalRef?: string;
}): string | undefined {
  const index = loadAoiRelationIndex(params.sessionsDir, params.sessionPath);
  const workNodes = index.nodes.filter((node) => node.kind === 'kira_work');
  for (const workNode of workNodes) {
    const linked = index.edges.some(
      (edge) =>
        (edge.from === workNode.id || edge.to === workNode.id) &&
        edge.evidenceRefs.some(
          (ref) =>
            ref === params.goalRef || (params.proposalRef ? ref === params.proposalRef : false),
        ),
    );
    if (linked) {
      return workNode.ref;
    }
  }
  return undefined;
}

function findResearchRunRef(params: {
  researchRuns: AoiResearchRunSummary[];
  goal: AoiGoal;
  proposal?: AoiProposal;
}): string | undefined {
  const explicitRef = [
    ...(params.proposal?.evidenceRefs ?? []),
    ...(params.proposal?.artifactRefs ?? []),
    ...params.goal.sourceRefs,
  ].find((ref) => /^research:[^/]+$/.test(ref) || /^research:[^/]+\//.test(ref));
  if (explicitRef) {
    const parts = explicitRef.split('/');
    return parts[0];
  }
  const activeRun = params.researchRuns.find(
    (run) =>
      (run.status === 'queued' || run.status === 'running') &&
      normalizeWhitespace(run.request).toLowerCase() ===
        normalizeWhitespace(params.goal.userIntentSummary).toLowerCase(),
  );
  return activeRun ? `research:${activeRun.id}` : undefined;
}

function activeResearchRunForRef(
  researchRuns: AoiResearchRunSummary[],
  researchRunRef: string | undefined,
): AoiResearchRunSummary | undefined {
  if (!researchRunRef) {
    return undefined;
  }
  const runId = researchRunRef.replace(/^research:/, '').split('/')[0];
  return researchRuns.find(
    (run) => run.id === runId && (run.status === 'queued' || run.status === 'running'),
  );
}

function waitingAction(params: {
  status: AoiMissionStatus;
  waitingOn: AoiMissionWaitingOn;
  step: AoiPlanStep | null;
  proposal?: AoiProposal;
  researchRunRef?: string;
  kiraWorkRef?: string;
}): AoiMissionRecommendedAction {
  if (params.status === 'paused') {
    return {
      kind: 'resume_mission',
      label: 'Resume mission when ready.',
      reason: 'Mission focus is paused without deleting evidence.',
    };
  }
  if (params.status === 'blocked') {
    return {
      kind: 'answer_user',
      label: 'Ask for clarification or a smaller safe continuation.',
      reason: 'Current mission is blocked by evidence.',
      ref: params.step ? `plan-step:${params.step.id}` : undefined,
    };
  }
  if (params.waitingOn === 'user') {
    return {
      kind: 'wait_for_user',
      label: 'Wait for user approval or clarification.',
      reason: 'A proposal or plan step needs explicit user input.',
      ref: params.proposal ? `proposal:${params.proposal.id}` : undefined,
    };
  }
  if (params.waitingOn === 'kira') {
    return {
      kind: params.kiraWorkRef ? 'inspect_kira' : 'prepare_kira',
      label: params.kiraWorkRef ? 'Inspect Kira work status.' : 'Prepare Kira handoff preview.',
      reason: params.kiraWorkRef
        ? 'A Kira work item is linked to the mission.'
        : 'The next plan step is a Kira handoff.',
      ref: params.kiraWorkRef,
    };
  }
  if (params.waitingOn === 'research') {
    return {
      kind: params.researchRunRef ? 'inspect_research' : 'prepare_research',
      label: params.researchRunRef ? 'Inspect research run status.' : 'Prepare bounded research.',
      reason: params.researchRunRef
        ? 'A research run is linked to the mission.'
        : 'The next plan step requires fresh evidence.',
      ref: params.researchRunRef,
    };
  }
  return {
    kind: 'review_goal',
    label: params.step ? `Continue: ${truncateText(params.step.title, 96)}` : 'Review goal state.',
    reason: params.step ? 'The mission has an open plan step.' : 'The mission is active.',
    ref: params.step ? `plan-step:${params.step.id}` : undefined,
  };
}

function deriveWaitingState(params: {
  goal: AoiGoal;
  step: AoiPlanStep | null;
  proposal?: AoiProposal;
  researchRunRef?: string;
  activeResearchRun?: AoiResearchRunSummary;
  kiraWorkRef?: string;
}): {
  status: AoiMissionStatus;
  waitingOn: AoiMissionWaitingOn;
  blockedReason?: string;
} {
  if (params.goal.status === 'paused') {
    return { status: 'paused', waitingOn: 'none' };
  }
  if (params.goal.status === 'blocked' || params.step?.status === 'blocked') {
    return {
      status: 'blocked',
      waitingOn: 'user',
      blockedReason: 'Goal or plan step is blocked by evidence.',
    };
  }
  if (
    params.proposal?.status === 'active' &&
    (params.proposal.requiresUserApproval || params.proposal.acceptAction?.kind === 'activate_goal')
  ) {
    return { status: 'waiting_on_user', waitingOn: 'user' };
  }
  if (params.step?.kind === 'ask_user') {
    return { status: 'waiting_on_user', waitingOn: 'user' };
  }
  if (params.kiraWorkRef || params.step?.kind === 'handoff_kira') {
    return { status: 'waiting_on_kira', waitingOn: 'kira' };
  }
  if (params.activeResearchRun || params.step?.kind === 'research') {
    return { status: 'waiting_on_research', waitingOn: 'research' };
  }
  return { status: 'active', waitingOn: 'aoi' };
}

function findCurrentGoal(activeGoals: AoiGoal[]): AoiGoal | null {
  return (
    activeGoals
      .filter((goal) => goal.status !== 'completed' && goal.status !== 'abandoned')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  );
}

function mergeTransition(params: {
  previous: AoiMissionState | null;
  next: AoiMissionState;
  reason: string;
  now: number;
}): AoiMissionState {
  if (!params.previous || params.previous.status === params.next.status) {
    return params.next;
  }
  const transition: AoiMissionTransitionRef = {
    from: params.previous.status,
    to: params.next.status,
    createdAt: params.now,
    reason: truncateText(params.reason, ACTION_MAX_CHARS),
    evidenceRefs: params.next.evidenceRefs,
  };
  return {
    ...params.next,
    createdAt: params.previous.createdAt || params.next.createdAt,
    transitions: [transition, ...params.previous.transitions].slice(0, MAX_TRANSITIONS),
  };
}

function recordMissionSideEffects(params: {
  sessionsDir: string;
  sessionPath: string;
  previous: AoiMissionState | null;
  next: AoiMissionState;
  now: number;
}): void {
  if (
    params.previous?.status === params.next.status &&
    params.previous?.waitingOn === params.next.waitingOn &&
    params.previous?.activeGoalId === params.next.activeGoalId &&
    params.previous?.sourceRefs.goalRef === params.next.sourceRefs.goalRef
  ) {
    return;
  }
  try {
    recordAoiMissionStateRelations({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      mission: params.next,
      now: params.now,
    });
  } catch {
    // Mission relation writes are audit-only.
  }
  try {
    const eventType =
      params.next.status === 'paused'
        ? 'mission_paused'
        : params.next.status === 'completed'
          ? 'mission_completed'
          : params.next.status === 'blocked'
            ? 'mission_blocked'
            : params.next.status === 'none'
              ? 'mission_cleared'
              : params.previous?.status === 'paused'
                ? 'mission_resumed'
                : params.previous && params.previous.waitingOn !== params.next.waitingOn
                  ? 'mission_waiting_state_changed'
                  : 'mission_activated';
    recordServerAoiRunLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: eventType,
      message: `Mission ${params.next.status}: ${params.next.focusSummary}`,
      goalSummary: `Aoi mission: ${params.next.focusSummary}`,
      toolNames: [],
      status: params.next.status === 'blocked' ? 'failed' : 'completed',
      now: params.now,
    });
  } catch {
    // Ledger writes are audit-only.
  }
}

export function loadAoiMissionState(
  sessionsDir: string,
  sessionPath: string,
): AoiMissionState | null {
  const resolved = resolveMissionFile(sessionsDir, sessionPath);
  return normalizeMissionState(readJson<unknown>(resolved.filePath), resolved.sessionPath);
}

export function saveAoiMissionState(
  sessionsDir: string,
  sessionPath: string,
  mission: AoiMissionState,
): AoiMissionState {
  const resolved = resolveMissionFile(sessionsDir, sessionPath);
  const normalized = normalizeMissionState(mission, resolved.sessionPath);
  if (!normalized) {
    throw new Error('Invalid Aoi mission state.');
  }
  writeJsonAtomic(resolved.filePath, normalized);
  return normalized;
}

export function deriveAoiMissionState(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
  persist?: boolean;
  ignorePaused?: boolean;
}): AoiMissionState {
  const resolved = resolveMissionFile(params.sessionsDir, params.sessionPath);
  const sessionPath = resolved.sessionPath;
  const now = params.now ?? Date.now();
  const previous = loadAoiMissionState(params.sessionsDir, sessionPath);
  const activeGoals = loadAoiActiveGoals(params.sessionsDir, sessionPath);
  const archivedGoals = loadAoiArchivedGoals(params.sessionsDir, sessionPath);
  const activeGoal = findCurrentGoal(activeGoals);

  if (!activeGoal) {
    const archivedMatch = previous?.activeGoalId
      ? archivedGoals.find((goal) => goal.id === previous.activeGoalId)
      : undefined;
    const completedState =
      archivedMatch?.status === 'completed'
        ? {
            ...makeEmptyMissionState(sessionPath, now),
            status: 'completed' as const,
            focusSummary: `Completed: ${truncateText(archivedMatch.title, 140)}`,
            evidenceRefs: dedupeRefs([`goal:${archivedMatch.id}`, ...archivedMatch.sourceRefs]),
            sourceRefs: { goalRef: `goal:${archivedMatch.id}` },
            lastMeaningfulEventRef: `goal:${archivedMatch.id}`,
          }
        : makeEmptyMissionState(sessionPath, now);
    const next = mergeTransition({
      previous,
      next: completedState,
      reason: archivedMatch?.status === 'completed' ? 'Active goal completed.' : 'No active goal.',
      now,
    });
    if (params.persist !== false) {
      saveAoiMissionState(params.sessionsDir, sessionPath, next);
      recordMissionSideEffects({
        sessionsDir: params.sessionsDir,
        sessionPath,
        previous,
        next,
        now,
      });
    }
    return next;
  }

  if (
    !params.ignorePaused &&
    previous?.status === 'paused' &&
    previous.activeGoalId === activeGoal.id
  ) {
    const next = {
      ...previous,
      updatedAt: now,
    };
    if (params.persist !== false) {
      saveAoiMissionState(params.sessionsDir, sessionPath, next);
    }
    return next;
  }

  const step = firstOpenStep(activeGoal);
  const goalRef = `goal:${activeGoal.id}`;
  const stepRef = step ? `${goalRef}/step:${step.id}` : undefined;
  const activeProposals = loadAoiActiveProposals(params.sessionsDir, sessionPath);
  const currentProposal = activeProposals
    .filter((proposal) => proposal.status === 'active' || proposal.status === 'accepted')
    .filter((proposal) => proposalMatchesGoal(proposal, activeGoal, step))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const proposalRef = currentProposal ? `proposal:${currentProposal.id}` : undefined;
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const observations = loadAoiObservations(params.sessionsDir, sessionPath);
  const progress = loadAoiGoalProgressEvents(params.sessionsDir, sessionPath);
  const researchRuns = listAoiResearchRunSummaries(params.sessionsDir, sessionPath);
  const kiraWorkRef = findKiraWorkRef({
    sessionsDir: params.sessionsDir,
    sessionPath,
    goalRef,
    proposalRef,
  });
  const researchRunRef = findResearchRunRef({
    researchRuns,
    goal: activeGoal,
    proposal: currentProposal,
  });
  const activeResearchRun = activeResearchRunForRef(researchRuns, researchRunRef);
  const waiting = deriveWaitingState({
    goal: activeGoal,
    step,
    proposal: currentProposal,
    researchRunRef,
    activeResearchRun,
    kiraWorkRef,
  });
  const observationRef = latestObservationRef(observations, activeGoal);
  const decisionRef = latestDecisionRef(decisions, currentProposal);
  const progressRef = progress.find((event) => event.goalId === activeGoal.id);
  const lastMeaningfulEventRef =
    observationRef ?? decisionRef ?? (progressRef ? `goal-progress:${progressRef.id}` : goalRef);
  const sourceRefs: AoiMissionSourceRefs = {
    goalRef,
    ...(stepRef ? { planStepRef: stepRef } : {}),
    ...(proposalRef ? { proposalRef } : {}),
    ...(decisionRef ? { decisionRef } : {}),
    ...(observationRef ? { observationRef } : {}),
    ...(researchRunRef ? { researchRunRef } : {}),
    ...(kiraWorkRef ? { kiraWorkRef } : {}),
  };
  const evidenceRefs = dedupeRefs([
    goalRef,
    stepRef,
    proposalRef,
    decisionRef,
    observationRef,
    researchRunRef,
    kiraWorkRef,
    lastMeaningfulEventRef,
    ...activeGoal.sourceRefs,
    ...(step?.evidenceRefs ?? []),
    ...(currentProposal?.evidenceRefs ?? []),
    ...(currentProposal?.artifactRefs ?? []),
  ]);
  const next: AoiMissionState = {
    version: 1,
    sessionPath,
    status: waiting.status,
    activeGoalId: activeGoal.id,
    focusSummary: truncateText(activeGoal.title, FOCUS_MAX_CHARS),
    waitingOn: waiting.waitingOn,
    lastMeaningfulEventRef,
    nextRecommendedAction: waitingAction({
      status: waiting.status,
      waitingOn: waiting.waitingOn,
      step,
      proposal: currentProposal,
      researchRunRef,
      kiraWorkRef,
    }),
    evidenceRefs,
    sourceRefs,
    transitions: previous?.activeGoalId === activeGoal.id ? previous.transitions : [],
    createdAt: previous?.activeGoalId === activeGoal.id ? previous.createdAt : now,
    updatedAt: now,
    ...(waiting.blockedReason ? { blockedReason: waiting.blockedReason } : {}),
  };
  const withTransition = mergeTransition({
    previous,
    next,
    reason: `Mission derived from goal ${activeGoal.id}.`,
    now,
  });
  if (params.persist !== false) {
    saveAoiMissionState(params.sessionsDir, sessionPath, withTransition);
    recordMissionSideEffects({
      sessionsDir: params.sessionsDir,
      sessionPath,
      previous,
      next: withTransition,
      now,
    });
  }
  return withTransition;
}

export function applyAoiMissionDecision(
  sessionsDir: string,
  sessionPath: string,
  input: AoiMissionDecisionInput,
): AoiMissionState {
  const resolved = resolveMissionFile(sessionsDir, sessionPath);
  const now = input.now ?? Date.now();
  const previous =
    loadAoiMissionState(sessionsDir, resolved.sessionPath) ??
    deriveAoiMissionState({
      sessionsDir,
      sessionPath: resolved.sessionPath,
      now,
      persist: false,
    });
  const evidenceRefs = dedupeRefs([
    ...(input.evidenceRefs ?? []),
    ...previous.evidenceRefs,
    previous.lastMeaningfulEventRef,
  ]);
  let next: AoiMissionState;

  if (input.action === 'resume') {
    const derived = deriveAoiMissionState({
      sessionsDir,
      sessionPath: resolved.sessionPath,
      now,
      persist: false,
      ignorePaused: true,
    });
    next = {
      ...derived,
      transitions: previous.transitions,
      createdAt: previous.createdAt || derived.createdAt,
    };
  } else if (input.action === 'clear') {
    next = {
      ...makeEmptyMissionState(resolved.sessionPath, now),
      evidenceRefs,
      lastMeaningfulEventRef: previous.lastMeaningfulEventRef,
      transitions: previous.transitions,
      createdAt: previous.createdAt || now,
    };
  } else {
    const status =
      input.action === 'pause' ? 'paused' : input.action === 'block' ? 'blocked' : 'completed';
    const waitingOn: AoiMissionWaitingOn =
      status === 'blocked' ? 'user' : status === 'paused' ? 'none' : 'none';
    next = {
      ...previous,
      status,
      waitingOn,
      evidenceRefs,
      updatedAt: now,
      ...(status === 'paused' ? { pausedAt: now } : {}),
      ...(status === 'blocked'
        ? {
            blockedReason:
              normalizeOptionalText(input.reason, ACTION_MAX_CHARS) || 'Mission blocked.',
          }
        : {}),
      nextRecommendedAction:
        status === 'paused'
          ? {
              kind: 'resume_mission',
              label: 'Resume mission when ready.',
              reason: 'Mission focus is paused without deleting evidence.',
            }
          : status === 'blocked'
            ? {
                kind: 'answer_user',
                label: 'Ask for clarification or a smaller safe continuation.',
                reason: normalizeOptionalText(input.reason, ACTION_MAX_CHARS) || 'Mission blocked.',
              }
            : {
                kind: 'none',
                label: 'No immediate action.',
                reason: 'Mission marked completed.',
              },
    };
  }

  const withTransition = mergeTransition({
    previous,
    next,
    reason: normalizeOptionalText(input.reason, ACTION_MAX_CHARS) || `Mission ${input.action}.`,
    now,
  });
  saveAoiMissionState(sessionsDir, resolved.sessionPath, withTransition);
  recordMissionSideEffects({
    sessionsDir,
    sessionPath: resolved.sessionPath,
    previous,
    next: withTransition,
    now,
  });
  return withTransition;
}
