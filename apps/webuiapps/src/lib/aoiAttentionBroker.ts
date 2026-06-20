import { createHash } from 'crypto';
import { createAoiObservation } from './aoiAutonomyObserver';
import type { AoiMemoryEntry } from './aoiMemoryShared';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import { createAoiAutonomyId } from './aoiAutonomyStore';
import { applyAoiTrustCalibration } from './aoiTrustCalibration';
import { scoreAoiFollowThroughLearningForKey } from './aoiFollowThroughLearning';
import type { AoiResearchRunSummary } from './aoiResearchTypes';
import type {
  AoiAttentionBrokerDecision,
  AoiAttentionBrokerDecisionKind,
  AoiAttentionEvent,
  AoiAttentionEventKind,
  AoiAttentionLevel,
  AoiAutonomyPolicy,
  AoiAutonomyRisk,
  AoiFollowThroughLearningSummary,
  AoiGoal,
  AoiMissionState,
  AoiObservation,
  AoiProposal,
  AoiProposalDecision,
  AoiTrustCalibrationProfile,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

const ATTENTION_SUMMARY_MAX_CHARS = 240;
const STALE_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const WAITING_TOO_LONG_MS = 45 * 60 * 1000;
const USER_IDLE_RETURN_THRESHOLD_MS = 15 * 60 * 1000;

export interface AoiAttentionBrokerInput {
  sessionPath: string;
  now: number;
  policy: AoiAutonomyPolicy;
  researchRuns: AoiResearchRunSummary[];
  memories: AoiMemoryEntry[];
  activeProposals: AoiProposal[];
  recentDecisions: AoiProposalDecision[];
  activeGoals: AoiGoal[];
  mission?: AoiMissionState | null;
  workspaceSnapshots?: AoiWorkspaceSnapshot[];
  quietMode?: boolean;
  userIdleMs?: number;
  maxActionableEvents?: number;
  trustCalibrationProfile?: AoiTrustCalibrationProfile | null;
  followThroughLearning?: AoiFollowThroughLearningSummary | null;
}

export interface AoiAttentionBrokerResult {
  events: AoiAttentionEvent[];
  decisions: AoiAttentionBrokerDecision[];
  observations: AoiObservation[];
  proposals: AoiProposal[];
  updateMission: boolean;
  directClarificationRequested: boolean;
  suppressedNotifications: number;
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

function sanitizeSummary(value: string): string {
  return truncateText(
    stripAoiSourceInstructions(redactAoiSensitiveContent(value)),
    ATTENTION_SUMMARY_MAX_CHARS,
  );
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sanitizeIdPart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'event'
  );
}

function makeEventId(kind: AoiAttentionEventKind, sourceSignature: string): string {
  return `aoi-attn-event-${sanitizeIdPart(kind)}-${hashPart(sourceSignature)}`.slice(0, 127);
}

function makeEvent(params: {
  sessionPath: string;
  kind: AoiAttentionEventKind;
  sourceRef: string;
  sourceSignature?: string;
  summary: string;
  risk: AoiAutonomyRisk;
  evidenceRefs: string[];
  suggestedAttentionLevel: AoiAttentionLevel;
  createdAt: number;
}): AoiAttentionEvent {
  const sourceSignature = params.sourceSignature ?? `${params.kind}:${params.sourceRef}`;
  return {
    version: 1,
    id: makeEventId(params.kind, sourceSignature),
    sessionPath: params.sessionPath,
    kind: params.kind,
    sourceRef: params.sourceRef,
    sourceSignature,
    summary: sanitizeSummary(params.summary),
    risk: params.risk,
    evidenceRefs: [...new Set(params.evidenceRefs)].slice(0, 12),
    suggestedAttentionLevel: params.suggestedAttentionLevel,
    createdAt: params.createdAt,
    dedupeKey: `attention:${sourceSignature}`,
  };
}

function memoryHasTag(memory: AoiMemoryEntry, tag: string): boolean {
  return memory.tags.includes(tag);
}

function collectResearchEvents(params: AoiAttentionBrokerInput): AoiAttentionEvent[] {
  const events: AoiAttentionEvent[] = [];
  for (const run of params.researchRuns) {
    const sourceRef = `research:${run.id}`;
    const updatedAt = run.updatedAt || run.completedAt || run.createdAt;
    if (run.status === 'completed' && run.artifactAvailability?.report) {
      events.push(
        makeEvent({
          sessionPath: run.sessionPath,
          kind: 'research_completed',
          sourceRef,
          sourceSignature: `research_completed:${run.id}`,
          summary: `Research completed: ${run.title || run.request}`,
          risk: 'low',
          evidenceRefs: [sourceRef, `${sourceRef}/report`],
          suggestedAttentionLevel: 'inline',
          createdAt: updatedAt,
        }),
      );
      continue;
    }
    if (
      run.status === 'failed' ||
      (run.status === 'completed' && run.sourceCounts.accepted <= 0) ||
      run.warningCount + run.verificationWarningCount > 0
    ) {
      events.push(
        makeEvent({
          sessionPath: run.sessionPath,
          kind: 'research_failed_or_insufficient',
          sourceRef,
          sourceSignature: `research_attention:${run.id}:${run.status}`,
          summary: `Research needs attention: ${run.title || run.request}`,
          risk: run.status === 'failed' ? 'medium' : 'low',
          evidenceRefs: [sourceRef],
          suggestedAttentionLevel: run.status === 'failed' ? 'inline' : 'badge',
          createdAt: updatedAt,
        }),
      );
    }
  }
  return events;
}

function collectKiraEvents(params: AoiAttentionBrokerInput): AoiAttentionEvent[] {
  const events: AoiAttentionEvent[] = [];
  for (const memory of params.memories) {
    if (!memoryHasTag(memory, 'kira')) {
      continue;
    }
    const sourceRef = `memory:${memory.id}`;
    const tags = new Set(memory.tags);
    if (tags.has('needs-clarification')) {
      events.push(
        makeEvent({
          sessionPath: memory.sessionPath || params.sessionPath,
          kind: 'kira_needs_clarification',
          sourceRef,
          sourceSignature: `kira_needs_clarification:${memory.id}`,
          summary: memory.content,
          risk: 'medium',
          evidenceRefs: [sourceRef],
          suggestedAttentionLevel: 'direct',
          createdAt: memory.updatedAt || memory.createdAt,
        }),
      );
      continue;
    }
    if (tags.has('completed') && tags.has('reviewed')) {
      events.push(
        makeEvent({
          sessionPath: memory.sessionPath || params.sessionPath,
          kind: 'kira_completed_reviewed_work',
          sourceRef,
          sourceSignature: `kira_completed_reviewed_work:${memory.id}`,
          summary: memory.content,
          risk: 'low',
          evidenceRefs: [sourceRef],
          suggestedAttentionLevel: 'inline',
          createdAt: memory.updatedAt || memory.createdAt,
        }),
      );
      continue;
    }
    if (
      tags.has('needs-attention') ||
      tags.has('interrupted') ||
      tags.has('validation-failed') ||
      tags.has('review-blocked')
    ) {
      events.push(
        makeEvent({
          sessionPath: memory.sessionPath || params.sessionPath,
          kind: 'kira_work_status_changed',
          sourceRef,
          sourceSignature: `kira_work_status_changed:${memory.id}:${[...tags].sort().join(',')}`,
          summary: memory.content,
          risk: tags.has('validation-failed') || tags.has('review-blocked') ? 'medium' : 'low',
          evidenceRefs: [sourceRef],
          suggestedAttentionLevel: 'badge',
          createdAt: memory.updatedAt || memory.createdAt,
        }),
      );
    }
  }
  return events;
}

function collectGoalAndFeedbackEvents(params: AoiAttentionBrokerInput): AoiAttentionEvent[] {
  const events: AoiAttentionEvent[] = [];
  const mission = params.mission;
  if (
    mission &&
    mission.status !== 'none' &&
    mission.status !== 'paused' &&
    mission.status !== 'completed' &&
    params.now - mission.updatedAt >= WAITING_TOO_LONG_MS
  ) {
    events.push(
      makeEvent({
        sessionPath: params.sessionPath,
        kind: 'active_goal_waiting_too_long',
        sourceRef: mission.sourceRefs.goalRef ?? `mission:${params.sessionPath}`,
        sourceSignature: `active_goal_waiting_too_long:${mission.activeGoalId || params.sessionPath}:${mission.status}`,
        summary: `Active goal has been waiting too long: ${mission.focusSummary}`,
        risk: mission.status === 'blocked' ? 'medium' : 'low',
        evidenceRefs: mission.evidenceRefs,
        suggestedAttentionLevel: mission.status === 'waiting_on_user' ? 'badge' : 'silent',
        createdAt: params.now,
      }),
    );
  }

  if ((params.userIdleMs ?? 0) >= USER_IDLE_RETURN_THRESHOLD_MS) {
    const activeGoal = params.activeGoals
      .filter((goal) => goal.status === 'active' || goal.status === 'paused')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    events.push(
      makeEvent({
        sessionPath: params.sessionPath,
        kind: 'user_returned_after_idle',
        sourceRef: activeGoal ? `goal:${activeGoal.id}` : `session:${params.sessionPath}`,
        sourceSignature: `user_returned_after_idle:${params.sessionPath}:${activeGoal?.id || 'none'}`,
        summary: activeGoal
          ? `User returned after idle interval; active goal is ${activeGoal.title}.`
          : 'User returned after idle interval.',
        risk: 'low',
        evidenceRefs: activeGoal ? [`goal:${activeGoal.id}`, ...activeGoal.sourceRefs] : [],
        suggestedAttentionLevel: activeGoal ? 'badge' : 'silent',
        createdAt: params.now,
      }),
    );
  }

  for (const decision of params.recentDecisions.slice(0, 12)) {
    if (!decision.feedbackCategory) {
      continue;
    }
    const proposal = params.activeProposals.find((item) => item.id === decision.proposalId);
    if (!proposal) {
      continue;
    }
    events.push(
      makeEvent({
        sessionPath: params.sessionPath,
        kind: 'proposal_feedback_trust_changed',
        sourceRef: `decision:${decision.id}`,
        sourceSignature: `proposal_feedback_trust_changed:${decision.id}:${decision.feedbackCategory}`,
        summary: `Feedback changed trust for active proposal "${proposal.title}": ${decision.feedbackCategory}.`,
        risk: decision.feedbackCategory === 'unsafe' ? 'medium' : 'low',
        evidenceRefs: [
          `decision:${decision.id}`,
          `proposal:${proposal.id}`,
          ...proposal.evidenceRefs,
        ],
        suggestedAttentionLevel: 'silent',
        createdAt: decision.createdAt,
      }),
    );
  }

  return events;
}

function collectWorkspaceEvents(params: AoiAttentionBrokerInput): AoiAttentionEvent[] {
  const events: AoiAttentionEvent[] = [];
  const missionGoalRef = params.mission?.activeGoalId
    ? `goal:${params.mission.activeGoalId}`
    : undefined;

  for (const snapshot of params.workspaceSnapshots ?? []) {
    const validationFreshness = snapshot.validation.freshness;
    const relevantValidation = validationFreshness === 'stale' || validationFreshness === 'failed';
    const branchChanged = snapshot.git?.branchChanged === true;
    if (!relevantValidation && !branchChanged) {
      continue;
    }
    if (!params.mission || params.mission.status === 'none' || params.mission.status === 'paused') {
      continue;
    }
    const sourceRef = snapshot.evidenceRefs[0] ?? `workspace:${snapshot.sessionPath}`;
    const evidenceRefs = [
      sourceRef,
      ...snapshot.evidenceRefs,
      ...(missionGoalRef ? [missionGoalRef] : []),
    ];
    const branchSummary = branchChanged
      ? ` Branch changed from ${snapshot.git?.previousBranchName ?? 'unknown'} to ${
          snapshot.git?.branchName ?? 'unknown'
        }.`
      : '';
    const validationSummary = relevantValidation
      ? ` Previous validation is ${validationFreshness}.`
      : '';
    const dirtySummary = snapshot.git?.isDirty
      ? ` ${snapshot.git.changedFileCount} changed files are present.`
      : '';
    events.push(
      makeEvent({
        sessionPath: snapshot.sessionPath,
        kind: 'workspace_validation_stale',
        sourceRef,
        sourceSignature: `workspace_validation:${snapshot.sessionPath}:${validationFreshness}:${
          snapshot.git?.branchName ?? 'no-branch'
        }:${snapshot.git?.statusSummary ?? 'no-status'}`,
        summary: `The mission is still active.${branchSummary}${validationSummary}${dirtySummary} I can prepare the next safe check.`,
        risk: validationFreshness === 'failed' ? 'medium' : 'low',
        evidenceRefs,
        suggestedAttentionLevel: 'badge',
        createdAt: snapshot.collectedAt,
      }),
    );
  }

  return events;
}

export function collectAoiAttentionEvents(params: AoiAttentionBrokerInput): AoiAttentionEvent[] {
  const events = [
    ...collectResearchEvents(params),
    ...collectKiraEvents(params),
    ...collectGoalAndFeedbackEvents(params),
    ...collectWorkspaceEvents(params),
  ];
  const bySignature = new Map<string, AoiAttentionEvent>();
  for (const event of events) {
    const existing = bySignature.get(event.sourceSignature);
    if (!existing || existing.createdAt < event.createdAt) {
      bySignature.set(event.sourceSignature, event);
    }
  }
  return [...bySignature.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function eventFamily(event: AoiAttentionEvent): string {
  return `attention:${event.kind}:${event.sourceRef}`;
}

function hasActiveProposalForEvent(
  event: AoiAttentionEvent,
  activeProposals: AoiProposal[],
): boolean {
  const family = eventFamily(event);
  return activeProposals.some(
    (proposal) =>
      (proposal.status === 'active' ||
        proposal.status === 'accepted' ||
        proposal.status === 'snoozed') &&
      proposal.cooldownKey === family,
  );
}

function hasRecentNegativeFeedback(
  event: AoiAttentionEvent,
  decisions: AoiProposalDecision[],
): boolean {
  const family = eventFamily(event);
  return decisions.some(
    (decision) =>
      decision.cooldownKey === family &&
      (decision.feedbackCategory === 'too_frequent' ||
        decision.feedbackCategory === 'too_much' ||
        decision.feedbackCategory === 'wrong_timing' ||
        decision.feedbackCategory === 'not_useful' ||
        decision.feedbackCategory === 'unsafe' ||
        decision.feedbackCategory === 'wrong_memory' ||
        decision.feedbackCategory === 'wrong_evidence' ||
        decision.feedbackCategory === 'wrong_source'),
  );
}

function sourceKindFromRef(ref: string): string | undefined {
  if (ref.startsWith('research:')) {
    return 'research_runs';
  }
  if (ref.startsWith('workspace:')) {
    return ref.includes('validation') || ref.includes('build')
      ? 'workspace_build'
      : 'workspace_git';
  }
  if (ref.startsWith('memory:') || ref.startsWith('kira:')) {
    return 'kira_board';
  }
  if (ref.startsWith('browser:') || ref.includes('browser-context')) {
    return 'browser_context';
  }
  if (ref.includes('calendar')) {
    return 'calendar_metadata';
  }
  if (ref.includes('gmail')) {
    return 'gmail_metadata';
  }
  if (ref.includes('notes')) {
    return 'notes_metadata';
  }
  return undefined;
}

function eventTouchesMission(event: AoiAttentionEvent, mission?: AoiMissionState | null): boolean {
  if (!mission || mission.status === 'none') {
    return false;
  }
  const refs = new Set([
    mission.sourceRefs.goalRef,
    mission.sourceRefs.proposalRef,
    mission.sourceRefs.researchRunRef,
    mission.sourceRefs.kiraWorkRef,
    mission.lastMeaningfulEventRef,
    ...mission.evidenceRefs,
  ]);
  return [event.sourceRef, ...event.evidenceRefs].some((ref) => refs.has(ref));
}

export function scoreAoiAttentionEvent(
  event: AoiAttentionEvent,
  params: Pick<
    AoiAttentionBrokerInput,
    | 'now'
    | 'recentDecisions'
    | 'activeProposals'
    | 'mission'
    | 'trustCalibrationProfile'
    | 'followThroughLearning'
  >,
): number {
  let score =
    event.suggestedAttentionLevel === 'direct'
      ? 0.78
      : event.suggestedAttentionLevel === 'inline'
        ? 0.64
        : event.suggestedAttentionLevel === 'badge'
          ? 0.46
          : 0.28;

  if (eventTouchesMission(event, params.mission)) {
    score += 0.18;
  }
  if (event.kind === 'kira_needs_clarification') {
    score += 0.22;
  }
  if (event.kind === 'kira_completed_reviewed_work') {
    score += 0.16;
  }
  if (event.kind === 'research_completed') {
    score += 0.12;
  }
  if (event.kind === 'research_failed_or_insufficient') {
    score += 0.18;
  }
  if (event.kind === 'workspace_validation_stale') {
    score += 0.14;
  }
  if (event.kind === 'active_goal_waiting_too_long') {
    score += 0.08;
  }
  if (params.now - event.createdAt > STALE_EVENT_AGE_MS) {
    score -= 0.42;
  }
  if (hasActiveProposalForEvent(event, params.activeProposals)) {
    score -= 0.5;
  }
  if (hasRecentNegativeFeedback(event, params.recentDecisions)) {
    score -= 0.35;
  }
  const followThrough = scoreAoiFollowThroughLearningForKey(
    eventFamily(event),
    params.followThroughLearning,
    params.now,
  );
  if (followThrough.suppressed) {
    score -= 0.35;
  } else if (followThrough.rankingFactor > 1) {
    score += Math.min(0.08, (followThrough.rankingFactor - 1) * 0.4);
  }
  if (event.suggestedAttentionLevel === 'direct') {
    score *= followThrough.directChatFactor;
  }
  if (event.risk === 'high') {
    score -= 0.35;
  }
  const calibration = applyAoiTrustCalibration({
    profile: params.trustCalibrationProfile,
    triggerKind: event.kind,
    sourceKind: sourceKindFromRef(event.sourceRef),
    risk: event.risk,
    score,
  });
  score +=
    calibration.rankingAdjustment +
    calibration.interruptionAdjustment -
    calibration.sourceSelectionPenalty;
  if (calibration.suppress && event.kind !== 'kira_needs_clarification') {
    score = Math.min(
      score,
      (params.trustCalibrationProfile?.interruptionPolicy.suppressThreshold ?? 0.24) - 0.01,
    );
  }

  return Math.min(1, Math.max(0, Number(score.toFixed(3))));
}

function eventToObservation(event: AoiAttentionEvent): AoiObservation {
  return createAoiObservation({
    source:
      event.kind === 'research_completed' || event.kind === 'research_failed_or_insufficient'
        ? 'research_run'
        : event.kind.startsWith('kira')
          ? 'kira'
          : event.kind === 'workspace_validation_stale'
            ? 'workspace'
            : event.kind === 'proposal_feedback_trust_changed'
              ? 'proposal'
              : 'system',
    sessionPath: event.sessionPath,
    stableKey: event.dedupeKey,
    createdAt: event.createdAt,
    summary: event.summary,
    payloadRef: `event:${event.id}`,
    artifactRefs: [event.sourceRef, ...event.evidenceRefs].filter(
      (ref) => !ref.startsWith('memory:'),
    ),
    memoryIds: event.evidenceRefs
      .filter((ref) => ref.startsWith('memory:'))
      .map((ref) => ref.slice('memory:'.length)),
    riskSignals: [`attention:${event.kind}`, `attention-level:${event.suggestedAttentionLevel}`],
  });
}

function makeAttentionProposal(params: {
  event: AoiAttentionEvent;
  observation: AoiObservation;
  now: number;
}): AoiProposal | null {
  const evidenceRefs = [
    `observation:${params.observation.id}`,
    params.event.sourceRef,
    ...params.event.evidenceRefs,
  ];
  if (params.event.kind === 'research_completed') {
    const runId = params.event.sourceRef.replace(/^research:/, '').split('/')[0];
    return {
      version: 1,
      id: createAoiAutonomyId('aoi-proposal-attention-research', params.now),
      sessionPath: params.event.sessionPath,
      status: 'active',
      title: 'Review completed Aoi research',
      body: params.event.summary,
      reason:
        'Background research finished while you were away; the useful next step is to review the report.',
      trigger: 'attention_broker',
      createdAt: params.now,
      updatedAt: params.now,
      cooldownKey: eventFamily(params.event),
      confidence: 0.82,
      risk: 'low',
      requiredAutonomyLevel: 'L3',
      requiresUserApproval: false,
      suggestedTools: ['read_research_artifact'],
      evidenceRefs,
      memoryIds: [],
      artifactRefs: [`research:${runId}`, `research:${runId}/report`],
      riskSignals: ['attention-broker', 'background-event'],
      acceptAction: {
        kind: 'read_research_artifact',
        params: {
          runId,
          artifact: 'report',
        },
      },
    };
  }
  if (params.event.kind === 'kira_completed_reviewed_work') {
    return {
      version: 1,
      id: createAoiAutonomyId('aoi-proposal-attention-kira', params.now),
      sessionPath: params.event.sessionPath,
      status: 'active',
      title: 'Review completed Kira work',
      body: params.event.summary,
      reason:
        'Kira completed reviewed work while you were away; inspect the result before continuing.',
      trigger: 'attention_broker',
      createdAt: params.now,
      updatedAt: params.now,
      cooldownKey: eventFamily(params.event),
      confidence: 0.78,
      risk: 'low',
      requiredAutonomyLevel: 'L2',
      requiresUserApproval: false,
      suggestedTools: [],
      evidenceRefs,
      memoryIds: params.event.evidenceRefs
        .filter((ref) => ref.startsWith('memory:'))
        .map((ref) => ref.slice('memory:'.length)),
      artifactRefs: [],
      riskSignals: ['attention-broker', 'background-event', 'kira-reviewed'],
      acceptAction: {
        kind: 'open_app',
        params: {
          appName: 'kira',
        },
      },
    };
  }
  return null;
}

function decideEvent(params: {
  event: AoiAttentionEvent;
  observation: AoiObservation;
  score: number;
  input: AoiAttentionBrokerInput;
  proposal?: AoiProposal | null;
  actionableBudgetRemaining: boolean;
}): AoiAttentionBrokerDecision {
  let kind: AoiAttentionBrokerDecisionKind = 'record_observation_only';
  let reason = 'Recorded as a quiet background observation.';

  if (params.score < 0.18) {
    kind = 'ignore';
    reason = 'Ignored stale or low-priority background event.';
  } else if (params.input.quietMode) {
    kind = 'record_observation_only';
    reason = 'Quiet mode suppressed user-facing attention.';
  } else if (
    params.event.kind === 'kira_needs_clarification' &&
    params.score >= 0.82 &&
    params.event.suggestedAttentionLevel === 'direct'
  ) {
    kind = 'ask_direct_clarification';
    reason = 'Kira is user-blocked and needs clarification.';
  } else if (params.proposal && params.actionableBudgetRemaining && params.score >= 0.62) {
    kind = 'create_proposal';
    reason = 'Actionable background event has one safe next step.';
  } else if (eventTouchesMission(params.event, params.input.mission) && params.score >= 0.42) {
    kind = 'update_mission_state';
    reason = 'Event is tied to the active mission and can update mission state silently.';
  } else if (params.score >= 0.42) {
    kind = 'show_dashboard_badge';
    reason = 'Event is relevant enough for a dashboard badge.';
  }

  return {
    version: 1,
    eventId: params.event.id,
    kind,
    reason,
    score: params.score,
    createdAt: params.input.now,
    ...(kind !== 'ignore' ? { observationId: params.observation.id } : {}),
    ...(kind === 'create_proposal' && params.proposal ? { proposalId: params.proposal.id } : {}),
  };
}

export function runAoiAttentionBroker(input: AoiAttentionBrokerInput): AoiAttentionBrokerResult {
  const events = collectAoiAttentionEvents(input);
  const decisions: AoiAttentionBrokerDecision[] = [];
  const observations: AoiObservation[] = [];
  const proposals: AoiProposal[] = [];
  let updateMission = false;
  let directClarificationRequested = false;
  let suppressedNotifications = 0;
  let actionableCount = 0;
  const maxActionableEvents = Math.max(0, input.maxActionableEvents ?? 1);

  for (const event of events) {
    const observation = eventToObservation(event);
    const score = scoreAoiAttentionEvent(event, input);
    const candidateProposal = makeAttentionProposal({ event, observation, now: input.now });
    const decision = decideEvent({
      event,
      observation,
      score,
      input,
      proposal: candidateProposal,
      actionableBudgetRemaining: actionableCount < maxActionableEvents,
    });

    decisions.push(decision);
    if (decision.kind !== 'ignore') {
      observations.push(observation);
    }
    if (decision.kind === 'create_proposal' && candidateProposal) {
      proposals.push(candidateProposal);
      actionableCount += 1;
    }
    if (decision.kind === 'update_mission_state') {
      updateMission = true;
    }
    if (decision.kind === 'ask_direct_clarification') {
      directClarificationRequested = true;
    }
    if (
      input.quietMode &&
      event.suggestedAttentionLevel !== 'silent' &&
      decision.kind === 'record_observation_only'
    ) {
      suppressedNotifications += 1;
    }
  }

  return {
    events,
    decisions,
    observations,
    proposals,
    updateMission,
    directClarificationRequested,
    suppressedNotifications,
  };
}
