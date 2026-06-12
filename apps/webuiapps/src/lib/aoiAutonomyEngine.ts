import type { ChatMessage, ToolDef } from './llmClient';
import type { LLMConfig } from './llmModels';
import {
  applyAoiFeedbackCalibrationToProposal,
  checkAoiProposalPolicy,
  getAoiProposalFeedbackPriorityBoost,
  getAoiToolAutonomyPolicy,
} from './aoiAutonomyPolicy';
import {
  buildAoiGoalContinuationProposals,
  buildAoiGoalProposalFromUserMessage,
  loadAoiActiveGoals,
  recordAoiGoalContinuationProposed,
  recordAoiGoalRecoverySignal,
  updateAoiGoalProgressFromObservations,
} from './aoiAutonomyGoals';
import { runAoiAttentionBroker, type AoiAttentionBrokerResult } from './aoiAttentionBroker';
import { ingestAoiObservations } from './aoiAutonomyObserver';
import {
  buildAoiFailureRecoveryProposals,
  type AoiFailureClassificationInput,
  type AoiRecoveryProposalBuildResult,
} from './aoiAutonomyRecovery';
import {
  appendAoiReflection,
  beginAoiAutonomyTick,
  buildAoiAutonomyStatus,
  completeAoiAutonomyTick,
  createAoiAutonomyId,
  loadAoiAutonomyTickState,
  loadAoiActiveProposals,
  loadAoiAutonomyPolicy,
  loadAoiObservations,
  loadAoiProposalDecisions,
  markAoiAutonomyTickSkipped,
  normalizeAoiAutonomySessionPath,
  saveAoiActiveProposals,
} from './aoiAutonomyStore';
import {
  recordAoiAttentionEventRelations,
  recordAoiProposalCreatedRelations,
  recordAoiRecoveryProposalRelations,
} from './aoiAutonomyRelations';
import { deriveAoiMissionState, loadAoiMissionState } from './aoiAutonomyMission';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import type {
  AoiAutonomyBlockedProposal,
  AoiAutonomyRisk,
  AoiAutonomyTickReason,
  AoiAutonomyTickResult,
  AoiAutonomyTickState,
  AoiObservation,
  AoiProposal,
  AoiProposalAcceptAction,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
  AoiReflection,
} from './aoiAutonomyTypes';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  sanitizeAoiProcedureContent,
  stripAoiSourceInstructions,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import { listAoiResearchRunSummaries } from './aoiResearchPlugin';
import type { AoiResearchRunSummary } from './aoiResearchTypes';

const MAX_OBSERVATIONS_PER_TICK = 24;
const MAX_MEMORY_OBSERVATIONS = 12;
const MAX_REFLECTION_PROMPT_OBSERVATIONS = 16;
const MAX_REFLECTION_PROMPT_PROPOSALS = 8;
const MAX_REFLECTION_PROMPT_MEMORIES = 10;
const STALE_RESEARCH_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_RUN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TITLE_MAX_CHARS = 96;
const BODY_MAX_CHARS = 320;
const REASON_MAX_CHARS = 240;
const CLAIM_MAX_CHARS = 240;
const DEFAULT_BACKGROUND_TICK_MIN_INTERVAL_MS = 60_000;
const DEFAULT_BACKGROUND_TICK_LOCK_MS = 120_000;
const DEFAULT_BACKGROUND_TICK_MAX_RUNTIME_MS = 45_000;

interface AoiAutonomyReflectionResponse {
  content: string;
  toolCalls: unknown[];
  reasoningContent?: string;
}

export type AoiAutonomyReflectionChat = (
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
) => Promise<AoiAutonomyReflectionResponse>;

export interface AoiAutonomyTickParams {
  sessionsDir: string;
  sessionPath: string;
  reason: AoiAutonomyTickReason;
  latestUserMessage?: string;
  llmConfig?: LLMConfig | null;
  reflectionChat?: AoiAutonomyReflectionChat;
  now?: number;
  maxObservations?: number;
  quietMode?: boolean;
  userIdleMs?: number;
}

export interface AoiAutonomyBackgroundTickParams extends AoiAutonomyTickParams {
  minIntervalMs?: number;
  lockMs?: number;
  maxRuntimeMs?: number;
}

interface CandidateBundle {
  observations: AoiObservation[];
  memories: AoiMemoryEntry[];
  researchRuns: AoiResearchRunSummary[];
  activeProposals: AoiProposal[];
  decisions: AoiProposalDecision[];
}

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

function sanitizeIdPart(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function hasTag(memory: AoiMemoryEntry, tag: string): boolean {
  return memory.tags.includes(tag);
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

function overlapScore(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) {
      overlap++;
    }
  }
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function looksCurrentInfoRequest(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    /\b(?:latest|recent|current|today|now|202[5-9]|newer|updated)\b/i.test(value) ||
    /(?:최신|최근|현재|요즘|오늘|업데이트|새로운|신규)/u.test(value)
  );
}

function looksRepeatedPatternRequest(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    /\b(?:repeat|repeated|every time|from now on|procedure|workflow|checklist|playbook)\b/i.test(
      value,
    ) || /(?:반복|매번|항상|앞으로|절차|워크플로|체크리스트|플레이북|방법을 저장)/u.test(value)
  );
}

function looksSecretBearing(value: string): boolean {
  return containsAoiSensitiveContent(value);
}

function sanitizePromptText(value: string, maxChars: number): string {
  return truncateText(stripAoiSourceInstructions(redactAoiSensitiveContent(value)), maxChars);
}

function proposalClaimsExecution(value: string): boolean {
  return (
    /\b(?:executed|already ran|already completed|already started|finished running)\b/i.test(
      value,
    ) || /(?:이미\s*실행|이미\s*완료|방금\s*실행|시작해\s*뒀|완료해\s*뒀)/u.test(value)
  );
}

function makeEvidenceRefsFromObservation(observation: AoiObservation): string[] {
  return [
    `observation:${observation.id}`,
    ...observation.memoryIds.map((id) => `memory:${id}`),
    ...observation.proposalIds.map((id) => `proposal:${id}`),
    ...observation.artifactRefs,
  ];
}

function isObservationUseful(observation: AoiObservation): boolean {
  return (
    observation.summary.trim().length > 0 &&
    (observation.memoryIds.length > 0 ||
      observation.artifactRefs.length > 0 ||
      observation.proposalIds.length > 0 ||
      Boolean(observation.payloadRef))
  );
}

function makeObservationId(prefix: string, stableId: string): string {
  return `aoi-obs-${sanitizeIdPart(prefix)}-${sanitizeIdPart(stableId)}`.slice(0, 127);
}

function researchRunToObservation(run: AoiResearchRunSummary): AoiObservation | null {
  const interesting = run.status === 'completed' || run.status === 'failed';
  if (!interesting) {
    return null;
  }
  const artifactRefs = [
    `research:${run.id}`,
    ...(run.artifactAvailability?.report ? [`research:${run.id}/report`] : []),
  ];
  const riskSignals = [
    run.status === 'failed' ? 'research-failed' : null,
    run.error?.code ? `error:${run.error.code}` : null,
    run.warningCount > 0 ? 'research-warnings' : null,
  ].filter((item): item is string => Boolean(item));
  const observation: AoiObservation = {
    version: 1,
    id: makeObservationId('research', run.id),
    source: 'research_run',
    sessionPath: run.sessionPath,
    createdAt: run.updatedAt || run.createdAt,
    summary: truncateText(
      `${run.status} research "${run.title || run.request}" phase=${run.phase} accepted=${run.sourceCounts.accepted}`,
      260,
    ),
    payloadRef: `research:${run.id}`,
    memoryIds: [],
    artifactRefs,
    proposalIds: [],
    riskSignals,
    dedupeKey: `research_run:${run.id}`,
  };
  return isObservationUseful(observation) ? observation : null;
}

function memoryToObservation(sessionPath: string, memory: AoiMemoryEntry): AoiObservation | null {
  const isResearchMemory =
    memory.permanent && (hasTag(memory, 'research') || hasTag(memory, 'aoi-research'));
  const isKiraMemory =
    hasTag(memory, 'kira') &&
    (hasTag(memory, 'completed') ||
      hasTag(memory, 'needs-attention') ||
      hasTag(memory, 'interrupted'));
  if (!isResearchMemory && !isKiraMemory) {
    return null;
  }
  const source = isKiraMemory ? 'kira' : 'memory';
  const observation: AoiObservation = {
    version: 1,
    id: makeObservationId(source, memory.id),
    source,
    sessionPath,
    createdAt: memory.updatedAt || memory.createdAt,
    summary: sanitizePromptText(memory.content, 260),
    payloadRef: `memory:${memory.id}`,
    memoryIds: [memory.id],
    artifactRefs: memory.entities
      .filter((entity) => /^aoi-research-[A-Za-z0-9_-]+/.test(entity))
      .map((entity) => `research:${entity}`),
    proposalIds: [],
    riskSignals: [
      ...memory.tags.filter((tag) =>
        ['needs-attention', 'interrupted', 'validation-failed', 'integration-failed'].includes(tag),
      ),
    ],
    dedupeKey: `${source}:${memory.id}`,
  };
  return isObservationUseful(observation) ? observation : null;
}

function activeProposalToObservation(proposal: AoiProposal): AoiObservation | null {
  const observation: AoiObservation = {
    version: 1,
    id: makeObservationId('proposal', proposal.id),
    source: 'proposal',
    sessionPath: proposal.sessionPath,
    createdAt: proposal.updatedAt || proposal.createdAt,
    summary: truncateText(`Active proposal "${proposal.title}" status=${proposal.status}`, 220),
    payloadRef: `proposal:${proposal.id}`,
    memoryIds: proposal.memoryIds,
    artifactRefs: proposal.artifactRefs,
    proposalIds: [proposal.id],
    riskSignals: proposal.riskSignals,
    dedupeKey: `proposal:${proposal.id}:${proposal.status}`,
  };
  return isObservationUseful(observation) ? observation : null;
}

function decisionToObservation(decision: {
  id: string;
  proposalId: string;
  sessionPath: string;
  action: string;
  createdAt: number;
}): AoiObservation {
  return {
    version: 1,
    id: makeObservationId('decision', decision.id),
    source: 'proposal',
    sessionPath: decision.sessionPath,
    createdAt: decision.createdAt,
    summary: `Recent autonomy proposal decision ${decision.action} for ${decision.proposalId}.`,
    payloadRef: `decision:${decision.id}`,
    memoryIds: [],
    artifactRefs: [`decision:${decision.id}`],
    proposalIds: [decision.proposalId],
    riskSignals: [],
    dedupeKey: `decision:${decision.id}`,
  };
}

function collectAoiAutonomyObservations(params: {
  sessionsDir: string;
  sessionPath: string;
  now: number;
  maxObservations?: number;
}): CandidateBundle {
  const researchRuns = listAoiResearchRunSummaries(params.sessionsDir, params.sessionPath);
  const memories = loadServerAoiMemories(params.sessionsDir).filter(
    (memory) =>
      memory.status === 'active' &&
      (!memory.sessionPath || memory.sessionPath === params.sessionPath),
  );
  const activeProposals = loadAoiActiveProposals(params.sessionsDir, params.sessionPath);
  const decisions = loadAoiProposalDecisions(params.sessionsDir, params.sessionPath);
  const observations: AoiObservation[] = [];

  for (const run of researchRuns) {
    if (
      params.now - (run.updatedAt || run.createdAt) > RECENT_RUN_WINDOW_MS &&
      run.status !== 'failed'
    ) {
      continue;
    }
    const observation = researchRunToObservation(run);
    if (observation) {
      observations.push(observation);
    }
  }

  for (const memory of memories.slice(0, MAX_MEMORY_OBSERVATIONS)) {
    const observation = memoryToObservation(params.sessionPath, memory);
    if (observation) {
      observations.push(observation);
    }
  }

  for (const proposal of activeProposals.slice(0, 8)) {
    const observation = activeProposalToObservation(proposal);
    if (observation) {
      observations.push(observation);
    }
  }

  for (const decision of decisions.slice(0, 6)) {
    observations.push(decisionToObservation(decision));
  }

  const unique = new Map<string, AoiObservation>();
  for (const observation of observations) {
    if (!isObservationUseful(observation)) {
      continue;
    }
    unique.set(observation.id, observation);
  }

  return {
    observations: [...unique.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, params.maxObservations ?? MAX_OBSERVATIONS_PER_TICK),
    memories,
    researchRuns,
    activeProposals,
    decisions,
  };
}

function memoryHasAnyTag(memory: AoiMemoryEntry, tags: string[]): boolean {
  return tags.some((tag) => hasTag(memory, tag));
}

function buildFailureRecoveryInputs(
  bundle: CandidateBundle,
  sessionPath: string,
): AoiFailureClassificationInput[] {
  const failures: AoiFailureClassificationInput[] = [];

  for (const run of bundle.researchRuns) {
    if (run.status !== 'failed') {
      continue;
    }
    failures.push({
      source: 'research',
      sessionPath: run.sessionPath,
      sourceRef: `research:${run.id}`,
      summary: `Research "${run.title || run.request}" failed in phase ${run.phase}.`,
      evidenceRefs: [`research:${run.id}`],
      reasons: [
        run.error?.code,
        run.error?.message,
        run.error?.phase,
        `accepted_sources:${run.sourceCounts.accepted}`,
      ].filter((item): item is string => Boolean(item)),
      riskSignals: ['research-failed', ...(run.warningCount > 0 ? ['research-warnings'] : [])],
      suggestedTools: ['start_research'],
      acceptActionKind: 'start_research',
      researchRun: run,
    });
  }

  for (const memory of bundle.memories) {
    if (
      !hasTag(memory, 'kira') ||
      !memoryHasAnyTag(memory, [
        'needs-attention',
        'interrupted',
        'validation-failed',
        'integration-failed',
        'review-blocked',
        'needs-clarification',
      ])
    ) {
      continue;
    }
    failures.push({
      source: 'kira',
      sessionPath: memory.sessionPath || sessionPath,
      sourceRef: `memory:${memory.id}`,
      summary: memory.content,
      evidenceRefs: [`memory:${memory.id}`],
      reasons: memory.tags,
      riskSignals: memory.tags,
      suggestedTools: ['create_kira_work'],
      acceptActionKind: 'create_kira_work',
      memory,
    });
  }

  for (const proposal of bundle.activeProposals) {
    if (proposal.status !== 'blocked' && !proposal.blockedReason) {
      continue;
    }
    failures.push({
      source: proposal.blockedReason?.includes('policy') ? 'policy' : 'execution',
      sessionPath: proposal.sessionPath,
      sourceRef: `proposal:${proposal.id}`,
      summary: proposal.blockedReason || `Proposal "${proposal.title}" is blocked.`,
      evidenceRefs: [
        `proposal:${proposal.id}`,
        ...proposal.evidenceRefs,
        ...proposal.artifactRefs.filter((ref) => ref.startsWith('goal:')),
      ],
      reasons: [
        proposal.blockedReason,
        `status:${proposal.status}`,
        proposal.acceptAction?.kind ? `action:${proposal.acceptAction.kind}` : undefined,
      ].filter((item): item is string => Boolean(item)),
      riskSignals: proposal.riskSignals,
      suggestedTools: proposal.suggestedTools,
      acceptActionKind: proposal.acceptAction?.kind,
      proposal,
    });
  }

  return failures;
}

function recordAoiRecoveryLedgerEvent(params: {
  sessionsDir: string;
  sessionPath: string;
  type:
    | 'failure_classified'
    | 'recovery_proposal_created'
    | 'recovery_suppressed_by_loop_guard'
    | 'recovery_blocked_by_policy';
  message: string;
  toolNames?: string[];
  now: number;
}): void {
  try {
    recordServerAoiRunLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: params.type,
      message: truncateText(params.message, 240),
      goalSummary: 'Aoi failure recovery',
      toolNames: params.toolNames,
      now: params.now,
    });
  } catch {
    // Recovery ledger writes are audit-only.
  }
}

function recordAoiAttentionLedgerEvent(params: {
  sessionsDir: string;
  sessionPath: string;
  type:
    | 'background_event_observed'
    | 'attention_broker_decision'
    | 'notification_suppressed'
    | 'direct_clarification_requested';
  message: string;
  now: number;
}): void {
  try {
    recordServerAoiRunLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: params.type,
      message: truncateText(params.message, 240),
      goalSummary: 'Aoi attention broker',
      toolNames: [],
      now: params.now,
    });
  } catch {
    // Attention ledger writes are audit-only.
  }
}

function recordAoiAttentionBrokerLedgerEvents(params: {
  sessionsDir: string;
  sessionPath: string;
  result: AoiAttentionBrokerResult;
  now: number;
}): void {
  for (const event of params.result.events) {
    recordAoiAttentionLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: 'background_event_observed',
      message: `${event.kind}: ${event.summary}`,
      now: params.now,
    });
  }
  for (const decision of params.result.decisions) {
    recordAoiAttentionLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: 'attention_broker_decision',
      message: `${decision.kind} for ${decision.eventId}: ${decision.reason}`,
      now: params.now,
    });
  }
  if (params.result.suppressedNotifications > 0) {
    recordAoiAttentionLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: 'notification_suppressed',
      message: `Suppressed ${params.result.suppressedNotifications} background notification(s).`,
      now: params.now,
    });
  }
  if (params.result.directClarificationRequested) {
    recordAoiAttentionLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: 'direct_clarification_requested',
      message: 'A background event is user-blocking and needs direct clarification.',
      now: params.now,
    });
  }
}

function recordFailureRecoveryBuildEvents(params: {
  sessionsDir: string;
  sessionPath: string;
  result: AoiRecoveryProposalBuildResult;
  now: number;
}): void {
  for (const failure of params.result.classifiedFailures) {
    recordAoiRecoveryLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: 'failure_classified',
      message: `Classified ${failure.sourceRef} as ${failure.kind}.`,
      toolNames: failure.suggestedTools,
      now: params.now,
    });
  }
  for (const suppression of params.result.suppressed) {
    recordAoiRecoveryLedgerEvent({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      type: 'recovery_suppressed_by_loop_guard',
      message: `Suppressed ${suppression.failure.sourceRef}: ${suppression.reason}.`,
      toolNames: suppression.failure.suggestedTools,
      now: params.now,
    });
    recordAoiGoalRecoverySignal({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      evidenceRefs: suppression.failure.evidenceRefs,
      summary: `Recovery for ${suppression.failure.sourceRef} is blocked: ${suppression.reason}.`,
      now: params.now,
    });
  }
}

function buildResearchFollowupProposal(params: {
  run: AoiResearchRunSummary;
  latestUserMessage: string;
  now: number;
}): AoiProposal | null {
  const topicText = `${params.run.request} ${params.run.title || ''}`;
  if (!params.latestUserMessage || overlapScore(params.latestUserMessage, topicText) < 0.2) {
    return null;
  }
  const evidenceRefs = [`research:${params.run.id}`, `research:${params.run.id}/report`];
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-research-open', params.now),
    sessionPath: params.run.sessionPath,
    status: 'active',
    title: truncateText('Open the matching Aoi research report', TITLE_MAX_CHARS),
    body: truncateText(
      `A completed research run looks relevant to the current topic: ${params.run.title || params.run.request}`,
      BODY_MAX_CHARS,
    ),
    reason: truncateText(
      'The latest user message overlaps with a completed Aoi research run.',
      REASON_MAX_CHARS,
    ),
    trigger: 'research_followup',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: `research-followup:${params.run.id}`,
    confidence: 0.82,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs,
    memoryIds: [],
    artifactRefs: evidenceRefs,
    riskSignals: [],
    acceptAction: {
      kind: 'read_research_artifact',
      params: {
        runId: params.run.id,
        artifact: 'report',
      },
    },
  };
}

function buildStaleResearchMemoryProposal(params: {
  memory: AoiMemoryEntry;
  latestUserMessage: string;
  now: number;
  sessionPath: string;
}): AoiProposal | null {
  if (!looksCurrentInfoRequest(params.latestUserMessage)) {
    return null;
  }
  if (params.now - params.memory.updatedAt < STALE_RESEARCH_MEMORY_MS) {
    return null;
  }
  if (
    overlapScore(
      params.latestUserMessage,
      `${params.memory.content} ${params.memory.tags.join(' ')}`,
    ) < 0.12
  ) {
    return null;
  }
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-research-refresh', params.now),
    sessionPath: params.sessionPath,
    status: 'active',
    title: truncateText('Refresh stale Aoi research', TITLE_MAX_CHARS),
    body: truncateText(
      'The matching research memory is older than the freshness window for current-information questions.',
      BODY_MAX_CHARS,
    ),
    reason: truncateText(
      'The user appears to need current information, but the relevant research memory is stale.',
      REASON_MAX_CHARS,
    ),
    trigger: 'stale_research_memory',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: `research-refresh:${params.memory.id}`,
    confidence: 0.74,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['start_research'],
    evidenceRefs: [`memory:${params.memory.id}`],
    memoryIds: [params.memory.id],
    artifactRefs: [],
    riskSignals: ['stale-memory'],
    acceptAction: {
      kind: 'start_research',
      params: {
        sessionPath: params.sessionPath,
        request: params.latestUserMessage,
        mode: 'standard',
        maxSources: 12,
      },
    },
  };
}

function buildProcedureCandidateProposal(params: {
  latestUserMessage: string;
  now: number;
  sessionPath: string;
}): AoiProposal | null {
  if (
    !looksRepeatedPatternRequest(params.latestUserMessage) ||
    looksSecretBearing(params.latestUserMessage)
  ) {
    return null;
  }
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-procedure', params.now),
    sessionPath: params.sessionPath,
    status: 'active',
    title: truncateText('Save this as a reusable Aoi procedure', TITLE_MAX_CHARS),
    body: truncateText(
      'The latest request sounds like a repeated workflow or preference that may be worth saving as a procedure.',
      BODY_MAX_CHARS,
    ),
    reason: truncateText(
      'Repeated workflows should be promoted only after explicit user approval.',
      REASON_MAX_CHARS,
    ),
    trigger: 'procedure_candidate',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: `procedure:${tokenize(params.latestUserMessage).values().next().value || 'general'}`,
    confidence: 0.68,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['save_memory'],
    evidenceRefs: ['observation:latest-user-message'],
    memoryIds: [],
    artifactRefs: [],
    riskSignals: ['procedure-candidate'],
    acceptAction: {
      kind: 'save_memory',
      params: {
        type: 'procedure',
        content: sanitizeAoiProcedureContent(params.latestUserMessage),
      },
    },
  };
}

function buildRepeatedResearchProcedureProposal(params: {
  memories: AoiMemoryEntry[];
  latestUserMessage: string;
  now: number;
  sessionPath: string;
}): AoiProposal | null {
  if (!looksRepeatedPatternRequest(params.latestUserMessage)) {
    return null;
  }
  const researchMemories = params.memories
    .filter(
      (memory) =>
        memory.status === 'active' &&
        memory.permanent &&
        hasTag(memory, 'research') &&
        hasTag(memory, 'completed'),
    )
    .slice(0, 4);
  if (researchMemories.length < 2) {
    return null;
  }
  const evidenceRefs = researchMemories.map((memory) => `memory:${memory.id}`);
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-procedure-research', params.now),
    sessionPath: params.sessionPath,
    status: 'active',
    title: truncateText('Promote repeated research workflow procedure', TITLE_MAX_CHARS),
    body: truncateText(
      'Aoi has multiple successful research memories that can be promoted into an approval-gated reusable procedure.',
      BODY_MAX_CHARS,
    ),
    reason: truncateText(
      'Repeated successful research workflows should become durable only after explicit user approval.',
      REASON_MAX_CHARS,
    ),
    trigger: 'procedure_candidate',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: 'procedure:repeated-research-workflow',
    confidence: 0.74,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['save_memory'],
    evidenceRefs,
    memoryIds: researchMemories.map((memory) => memory.id),
    artifactRefs: [],
    riskSignals: ['procedure-candidate', 'repeated-research'],
    acceptAction: {
      kind: 'save_memory',
      params: {
        type: 'procedure',
        content: sanitizeAoiProcedureContent(
          'When Aoi repeats a successful research workflow, clarify the current request, run a bounded web research pass, prefer primary sources, compare source dates, persist report/evidence artifacts, and refresh stale research memory only after user-visible evidence exists.',
        ),
        triggerTerms: ['research', 'latest', '최신', '조사'],
      },
    },
  };
}

function buildRepeatedKiraProcedureProposal(params: {
  memories: AoiMemoryEntry[];
  latestUserMessage: string;
  now: number;
  sessionPath: string;
}): AoiProposal | null {
  if (!looksRepeatedPatternRequest(params.latestUserMessage)) {
    return null;
  }
  const kiraMemories = params.memories
    .filter(
      (memory) =>
        memory.status === 'active' &&
        hasTag(memory, 'kira') &&
        hasTag(memory, 'completed') &&
        hasTag(memory, 'reviewed'),
    )
    .slice(0, 4);
  if (kiraMemories.length < 2) {
    return null;
  }
  const evidenceRefs = kiraMemories.map((memory) => `memory:${memory.id}`);
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-procedure-kira', params.now),
    sessionPath: params.sessionPath,
    status: 'active',
    title: truncateText('Promote repeated Kira review workflow procedure', TITLE_MAX_CHARS),
    body: truncateText(
      'Aoi has multiple reviewed Kira completion memories that can be promoted into a reusable procedure.',
      BODY_MAX_CHARS,
    ),
    reason: truncateText(
      'Repeated successful Kira outcomes should be saved as procedure memory only with explicit approval.',
      REASON_MAX_CHARS,
    ),
    trigger: 'procedure_candidate',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: 'procedure:repeated-kira-review-workflow',
    confidence: 0.72,
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['save_memory'],
    evidenceRefs,
    memoryIds: kiraMemories.map((memory) => memory.id),
    artifactRefs: [],
    riskSignals: ['procedure-candidate', 'repeated-kira'],
    acceptAction: {
      kind: 'save_memory',
      params: {
        type: 'procedure',
        content: sanitizeAoiProcedureContent(
          'When Kira repeatedly completes reviewed work, preserve the worker plan, validation commands, review evidence, residual risks, and integration status before summarizing the reusable workflow.',
        ),
        triggerTerms: ['kira', 'review', 'validation', '자동화'],
      },
    },
  };
}

function buildKiraAttentionProposal(params: {
  memory: AoiMemoryEntry;
  now: number;
  sessionPath: string;
}): AoiProposal | null {
  if (!hasTag(params.memory, 'needs-attention') && !hasTag(params.memory, 'interrupted')) {
    return null;
  }
  return {
    version: 1,
    id: createAoiAutonomyId('aoi-proposal-kira-attention', params.now),
    sessionPath: params.sessionPath,
    status: 'active',
    title: truncateText('Review waiting Kira automation', TITLE_MAX_CHARS),
    body: sanitizePromptText(params.memory.content, BODY_MAX_CHARS),
    reason: truncateText(
      'Kira has a stored automation outcome that may need user attention.',
      REASON_MAX_CHARS,
    ),
    trigger: 'kira_attention',
    createdAt: params.now,
    updatedAt: params.now,
    cooldownKey: `kira-attention:${params.memory.id}`,
    confidence: 0.72,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: false,
    suggestedTools: [],
    evidenceRefs: [`memory:${params.memory.id}`],
    memoryIds: [params.memory.id],
    artifactRefs: [],
    riskSignals: params.memory.tags.filter(
      (tag) => tag === 'needs-attention' || tag === 'interrupted',
    ),
    acceptAction: {
      kind: 'open_app',
      params: {
        appName: 'kira',
      },
    },
  };
}

function buildDeterministicProposals(params: {
  sessionsDir: string;
  bundle: CandidateBundle;
  sessionPath: string;
  latestUserMessage: string;
  now: number;
}): AoiProposal[] {
  const proposals: AoiProposal[] = [];
  const goalCandidate = buildAoiGoalProposalFromUserMessage({
    sessionPath: params.sessionPath,
    latestUserMessage: params.latestUserMessage,
    now: params.now,
    sourceRefs: ['observation:latest-user-message'],
  });
  if (goalCandidate) {
    proposals.push(goalCandidate);
  }

  for (const run of params.bundle.researchRuns) {
    if (run.status === 'completed' && run.artifactAvailability?.report) {
      const proposal = buildResearchFollowupProposal({
        run,
        latestUserMessage: params.latestUserMessage,
        now: params.now,
      });
      if (proposal) {
        proposals.push(proposal);
      }
    }
  }

  const recoveryResult = buildAoiFailureRecoveryProposals({
    failures: buildFailureRecoveryInputs(params.bundle, params.sessionPath),
    context: {
      activeProposals: [...params.bundle.activeProposals],
      recentDecisions: params.bundle.decisions,
      now: params.now,
    },
  });
  recordFailureRecoveryBuildEvents({
    sessionsDir: params.sessionsDir,
    sessionPath: params.sessionPath,
    result: recoveryResult,
    now: params.now,
  });
  proposals.push(...recoveryResult.proposals);

  for (const memory of params.bundle.memories) {
    if (memory.permanent && (hasTag(memory, 'research') || hasTag(memory, 'aoi-research'))) {
      const stale = buildStaleResearchMemoryProposal({
        memory,
        latestUserMessage: params.latestUserMessage,
        now: params.now,
        sessionPath: params.sessionPath,
      });
      if (stale) {
        proposals.push(stale);
      }
    }
    if (hasTag(memory, 'kira')) {
      const kira = buildKiraAttentionProposal({
        memory,
        now: params.now,
        sessionPath: params.sessionPath,
      });
      if (kira) {
        proposals.push(kira);
      }
    }
  }

  const procedure = buildProcedureCandidateProposal({
    latestUserMessage: params.latestUserMessage,
    now: params.now,
    sessionPath: params.sessionPath,
  });
  if (procedure) {
    proposals.push(procedure);
  }
  const repeatedResearch = buildRepeatedResearchProcedureProposal({
    memories: params.bundle.memories,
    latestUserMessage: params.latestUserMessage,
    now: params.now,
    sessionPath: params.sessionPath,
  });
  if (repeatedResearch) {
    proposals.push(repeatedResearch);
  }
  const repeatedKira = buildRepeatedKiraProcedureProposal({
    memories: params.bundle.memories,
    latestUserMessage: params.latestUserMessage,
    now: params.now,
    sessionPath: params.sessionPath,
  });
  if (repeatedKira) {
    proposals.push(repeatedKira);
  }

  proposals.push(
    ...buildAoiGoalContinuationProposals({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      observations: params.bundle.observations,
      activeProposals: params.bundle.activeProposals,
      now: params.now,
    }),
  );

  return proposals;
}

function buildEvidenceRefSet(params: {
  observations: AoiObservation[];
  activeProposals: AoiProposal[];
}): Set<string> {
  const refs = new Set<string>(['observation:latest-user-message']);
  for (const observation of params.observations) {
    refs.add(`observation:${observation.id}`);
    for (const ref of makeEvidenceRefsFromObservation(observation)) {
      refs.add(ref);
    }
  }
  for (const proposal of params.activeProposals) {
    refs.add(`proposal:${proposal.id}`);
    for (const ref of proposal.evidenceRefs) {
      refs.add(ref);
    }
  }
  return refs;
}

function recordAoiAttentionRelations(params: {
  sessionsDir: string;
  sessionPath: string;
  result: AoiAttentionBrokerResult;
  storedObservations: AoiObservation[];
  proposals: AoiProposal[];
  mission?: ReturnType<typeof deriveAoiMissionState> | null;
  now: number;
}): void {
  const observationsById = new Map(
    params.storedObservations.map((observation) => [observation.id, observation]),
  );
  const proposalsById = new Map(params.proposals.map((proposal) => [proposal.id, proposal]));
  const eventsById = new Map(params.result.events.map((event) => [event.id, event]));

  for (const decision of params.result.decisions) {
    if (decision.kind === 'ignore' || !decision.observationId) {
      continue;
    }
    const event = eventsById.get(decision.eventId);
    const observation = observationsById.get(decision.observationId);
    if (!event || !observation) {
      continue;
    }
    try {
      recordAoiAttentionEventRelations({
        sessionsDir: params.sessionsDir,
        event,
        observation,
        proposal: decision.proposalId ? proposalsById.get(decision.proposalId) : undefined,
        mission: params.mission,
        now: params.now,
      });
    } catch {
      // Attention relation writes are audit-only.
    }
  }
}

export function buildAoiAutonomyReflectionMessages(params: {
  observations: AoiObservation[];
  memories: AoiMemoryEntry[];
  activeProposals: AoiProposal[];
  latestUserMessage?: string;
}): ChatMessage[] {
  const observations = params.observations
    .slice(0, MAX_REFLECTION_PROMPT_OBSERVATIONS)
    .map((observation) => ({
      id: observation.id,
      source: observation.source,
      summary: observation.summary,
      evidenceRefs: makeEvidenceRefsFromObservation(observation),
      riskSignals: observation.riskSignals,
    }));
  const memories = params.memories.slice(0, MAX_REFLECTION_PROMPT_MEMORIES).map((memory) => ({
    id: memory.id,
    type: `${memory.scope}/${memory.type}`,
    content: sanitizePromptText(memory.content, 220),
    tags: memory.tags,
    updatedAt: memory.updatedAt,
  }));
  const activeProposals = params.activeProposals
    .slice(0, MAX_REFLECTION_PROMPT_PROPOSALS)
    .map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      cooldownKey: proposal.cooldownKey,
      evidenceRefs: proposal.evidenceRefs,
    }));

  return [
    {
      role: 'system',
      content: [
        'You are Aoi Autonomy read-only reflection evaluator.',
        'Return strict JSON only.',
        'Do not claim actions were executed.',
        'Use only supplied evidenceRefs.',
        'If confidence is low, return no proposal.',
        'Never store secrets, credentials, private keys, or tokens.',
        'High-risk proposals must set requiresUserApproval=true.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        latestUserMessage: sanitizePromptText(params.latestUserMessage || '', 400),
        observations,
        memories,
        activeProposals,
        outputSchema: {
          reflections: [
            {
              kind: 'memory_audit|failure_postmortem|opportunity|procedure_candidate',
              claim: 'short evidence-backed claim',
              evidenceRefs: ['observation:id'],
              confidence: 0.0,
              risk: 'low|medium|high',
              proposedActions: ['tool_or_action_name'],
              proposedMemoryCandidates: ['short memory candidate'],
            },
          ],
          proposals: [
            {
              title: 'short title',
              body: 'short body',
              reason: 'why now',
              trigger: 'short trigger id',
              cooldownKey: 'stable dedupe key',
              confidence: 0.0,
              risk: 'low|medium|high',
              requiredAutonomyLevel: 'L2|L3|L4|L5',
              requiresUserApproval: false,
              suggestedTools: ['read_research_artifact'],
              evidenceRefs: ['observation:id'],
            },
          ],
        },
      }),
    },
  ];
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() || trimmed;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  return source.slice(start, end + 1);
}

function isRisk(value: unknown): value is AoiAutonomyRisk {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isLevel(value: unknown): value is AoiProposal['requiredAutonomyLevel'] {
  return (
    value === 'L0' ||
    value === 'L1' ||
    value === 'L2' ||
    value === 'L3' ||
    value === 'L4' ||
    value === 'L5'
  );
}

function isAcceptActionKind(value: unknown): value is AoiProposalAcceptActionKind {
  return (
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

function normalizeAcceptAction(value: unknown): AoiProposalAcceptAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isAcceptActionKind(record.kind)) {
    return undefined;
  }
  if (!record.params || typeof record.params !== 'object' || Array.isArray(record.params)) {
    return undefined;
  }
  return {
    kind: record.kind,
    params: record.params as Record<string, unknown>,
  };
}

function acceptActionLooksSecretBearing(action: AoiProposalAcceptAction | undefined): boolean {
  if (!action) {
    return false;
  }
  try {
    return looksSecretBearing(JSON.stringify(action.params).slice(0, 2048));
  } catch {
    return true;
  }
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = normalizeWhitespace(item).slice(0, 160);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function hasOnlyKnownEvidenceRefs(refs: string[], knownEvidenceRefs: Set<string>): boolean {
  return refs.length > 0 && refs.every((ref) => knownEvidenceRefs.has(ref));
}

export function parseAoiAutonomyReflectionResponse(
  raw: string,
  params: {
    sessionPath: string;
    knownEvidenceRefs: Set<string>;
    now?: number;
  },
): { reflections: AoiReflection[]; proposals: AoiProposal[]; warnings: string[] } {
  const warnings: string[] = [];
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { reflections: [], proposals: [], warnings: ['reflection_json_missing'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return { reflections: [], proposals: [], warnings: ['reflection_json_invalid'] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reflections: [], proposals: [], warnings: ['reflection_json_not_object'] };
  }

  const now = params.now ?? Date.now();
  const record = parsed as Record<string, unknown>;
  const reflections: AoiReflection[] = [];
  const proposals: AoiProposal[] = [];

  for (const item of Array.isArray(record.reflections) ? record.reflections : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const reflection = item as Record<string, unknown>;
    const claim =
      typeof reflection.claim === 'string'
        ? sanitizePromptText(reflection.claim, CLAIM_MAX_CHARS)
        : '';
    const evidenceRefs = normalizeStringArray(reflection.evidenceRefs, 8);
    const confidence = typeof reflection.confidence === 'number' ? reflection.confidence : NaN;
    if (!claim || claim.length > CLAIM_MAX_CHARS || !Number.isFinite(confidence)) {
      warnings.push('reflection_rejected_shape');
      continue;
    }
    if (!hasOnlyKnownEvidenceRefs(evidenceRefs, params.knownEvidenceRefs)) {
      warnings.push('reflection_rejected_evidence');
      continue;
    }
    if (looksSecretBearing(claim) || proposalClaimsExecution(claim)) {
      warnings.push('reflection_rejected_content');
      continue;
    }
    reflections.push({
      version: 1,
      id: createAoiAutonomyId('aoi-reflection-llm', now),
      observationIds: evidenceRefs
        .filter((ref) => ref.startsWith('observation:'))
        .map((ref) => ref.slice('observation:'.length)),
      sessionPath: params.sessionPath,
      createdAt: now,
      kind:
        reflection.kind === 'memory_audit' ||
        reflection.kind === 'failure_postmortem' ||
        reflection.kind === 'opportunity' ||
        reflection.kind === 'procedure_candidate'
          ? reflection.kind
          : 'opportunity',
      claim,
      evidenceRefs,
      confidence: Math.min(1, Math.max(0, confidence)),
      risk: isRisk(reflection.risk) ? reflection.risk : 'low',
      proposedMemoryCandidates: normalizeStringArray(reflection.proposedMemoryCandidates, 4),
      proposedActions: normalizeStringArray(reflection.proposedActions, 4),
    });
  }

  for (const item of Array.isArray(record.proposals) ? record.proposals : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const proposal = item as Record<string, unknown>;
    const title =
      typeof proposal.title === 'string' ? sanitizePromptText(proposal.title, TITLE_MAX_CHARS) : '';
    const body =
      typeof proposal.body === 'string' ? sanitizePromptText(proposal.body, BODY_MAX_CHARS) : '';
    const reason =
      typeof proposal.reason === 'string'
        ? sanitizePromptText(proposal.reason, REASON_MAX_CHARS)
        : '';
    const evidenceRefs = normalizeStringArray(proposal.evidenceRefs, 8);
    const confidence = typeof proposal.confidence === 'number' ? proposal.confidence : NaN;
    const risk = isRisk(proposal.risk) ? proposal.risk : 'low';
    const requiresUserApproval = proposal.requiresUserApproval === true;
    if (
      !title ||
      !reason ||
      title.length > TITLE_MAX_CHARS ||
      body.length > BODY_MAX_CHARS ||
      reason.length > REASON_MAX_CHARS ||
      !Number.isFinite(confidence)
    ) {
      warnings.push('proposal_rejected_shape');
      continue;
    }
    if (!hasOnlyKnownEvidenceRefs(evidenceRefs, params.knownEvidenceRefs)) {
      warnings.push('proposal_rejected_evidence');
      continue;
    }
    if (risk === 'high' && !requiresUserApproval) {
      warnings.push('proposal_rejected_high_risk_without_approval');
      continue;
    }
    if (
      looksSecretBearing(`${title} ${body} ${reason}`) ||
      proposalClaimsExecution(`${title} ${body} ${reason}`)
    ) {
      warnings.push('proposal_rejected_content');
      continue;
    }
    const suggestedTools = normalizeStringArray(proposal.suggestedTools, 6);
    const memoryIds = normalizeStringArray(proposal.memoryIds, 8);
    const artifactRefs = normalizeStringArray(proposal.artifactRefs, 8);
    proposals.push({
      version: 1,
      id: createAoiAutonomyId('aoi-proposal-llm', now),
      sessionPath: params.sessionPath,
      status: 'active',
      title,
      body: body || title,
      reason,
      trigger:
        typeof proposal.trigger === 'string' && proposal.trigger.trim()
          ? truncateText(proposal.trigger, 64)
          : 'llm_reflection',
      createdAt: now,
      updatedAt: now,
      cooldownKey:
        typeof proposal.cooldownKey === 'string' && proposal.cooldownKey.trim()
          ? truncateText(proposal.cooldownKey, 120)
          : `llm:${title.toLowerCase()}`,
      confidence: Math.min(1, Math.max(0, confidence)),
      risk,
      requiredAutonomyLevel: isLevel(proposal.requiredAutonomyLevel)
        ? proposal.requiredAutonomyLevel
        : 'L2',
      requiresUserApproval,
      suggestedTools,
      evidenceRefs,
      memoryIds,
      artifactRefs,
      riskSignals: normalizeStringArray(proposal.riskSignals, 6),
      acceptAction: normalizeAcceptAction(proposal.acceptAction),
    });
  }

  return { reflections, proposals, warnings };
}

async function runLlmReflection(params: {
  bundle: CandidateBundle;
  sessionPath: string;
  latestUserMessage: string;
  llmConfig?: LLMConfig | null;
  reflectionChat?: AoiAutonomyReflectionChat;
  knownEvidenceRefs: Set<string>;
  now: number;
}): Promise<{ reflections: AoiReflection[]; proposals: AoiProposal[]; warnings: string[] }> {
  if (!params.llmConfig) {
    return { reflections: [], proposals: [], warnings: [] };
  }
  try {
    const reflectionChat =
      params.reflectionChat ?? ((await import('./llmClient')).chat as AoiAutonomyReflectionChat);
    const response = await reflectionChat(
      buildAoiAutonomyReflectionMessages({
        observations: params.bundle.observations,
        memories: params.bundle.memories,
        activeProposals: params.bundle.activeProposals,
        latestUserMessage: params.latestUserMessage,
      }),
      [],
      params.llmConfig,
    );
    return parseAoiAutonomyReflectionResponse(response.content, {
      sessionPath: params.sessionPath,
      knownEvidenceRefs: params.knownEvidenceRefs,
      now: params.now,
    });
  } catch {
    return { reflections: [], proposals: [], warnings: ['reflection_llm_failed'] };
  }
}

function makeBlockedReflection(params: {
  proposal: AoiProposal;
  reasons: string[];
  sessionPath: string;
  now: number;
}): AoiReflection {
  return {
    version: 1,
    id: `aoi-reflection-blocked-${sanitizeIdPart(params.proposal.id)}`.slice(0, 127),
    observationIds: params.proposal.evidenceRefs
      .filter((ref) => ref.startsWith('observation:'))
      .map((ref) => ref.slice('observation:'.length)),
    sessionPath: params.sessionPath,
    createdAt: params.now,
    kind: 'memory_audit',
    claim: truncateText(
      `Blocked proposal "${params.proposal.title}" because ${params.reasons.join(', ')}.`,
      CLAIM_MAX_CHARS,
    ),
    evidenceRefs: params.proposal.evidenceRefs,
    confidence: 0.9,
    risk: params.proposal.risk,
    proposedMemoryCandidates: [],
    proposedActions: params.proposal.suggestedTools,
  };
}

function makeBlockedProposalSafeAlternative(proposal: AoiProposal, reasons: string[]): string {
  if (reasons.some((reason) => reason.includes('autonomy_level_too_low'))) {
    return `Raise autonomy to ${proposal.requiredAutonomyLevel} or keep this as a proposal.`;
  }
  if (reasons.some((reason) => reason.includes('high_risk_requires_approval'))) {
    return 'Require explicit approval before continuing.';
  }
  if (reasons.some((reason) => reason.includes('tool_level_too_low'))) {
    return 'Use a lower-risk read-only proposal or raise the autonomy level.';
  }
  if (reasons.some((reason) => reason.includes('cooldown'))) {
    return 'Wait for cooldown or run a manual check later.';
  }
  if (proposal.risk === 'high') {
    return 'Review the evidence and keep execution manual.';
  }
  return 'Inspect evidence before continuing.';
}

function sortProposalPriority(
  a: AoiProposal,
  b: AoiProposal,
  recentDecisions: AoiProposalDecision[],
): number {
  const leftScore = a.confidence + getAoiProposalFeedbackPriorityBoost(a, recentDecisions);
  const rightScore = b.confidence + getAoiProposalFeedbackPriorityBoost(b, recentDecisions);
  return rightScore - leftScore || a.createdAt - b.createdAt;
}

function makeSkippedTickResult(params: {
  sessionsDir: string;
  sessionPath: string;
  reason: AoiAutonomyTickReason;
  now: number;
  tickState: AoiAutonomyTickState;
  skippedReason: string;
}): AoiAutonomyTickResult {
  return {
    ok: true,
    sessionPath: params.sessionPath,
    reason: params.reason,
    status: buildAoiAutonomyStatus(params.sessionsDir, params.sessionPath, params.now),
    tickState: params.tickState,
    skipped: true,
    newObservationCount: 0,
    newReflectionCount: 0,
    newActiveProposalCount: 0,
    blockedProposalCount: 0,
    blockedProposals: [],
    warnings: [params.skippedReason],
  };
}

function makeFailedTickResult(params: {
  sessionsDir: string;
  sessionPath: string;
  reason: AoiAutonomyTickReason;
  now: number;
  tickState: AoiAutonomyTickState;
  warning: string;
}): AoiAutonomyTickResult {
  return {
    ok: false,
    sessionPath: params.sessionPath,
    reason: params.reason,
    status: buildAoiAutonomyStatus(params.sessionsDir, params.sessionPath, params.now),
    tickState: params.tickState,
    skipped: false,
    newObservationCount: 0,
    newReflectionCount: 0,
    newActiveProposalCount: 0,
    blockedProposalCount: 0,
    blockedProposals: [],
    warnings: [params.warning],
  };
}

function withTickTimeout<T>(promise: Promise<T>, maxRuntimeMs: number): Promise<T> {
  if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0) {
    return promise;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Aoi autonomy tick exceeded runtime budget.'));
    }, maxRuntimeMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export async function runAoiAutonomyBackgroundTick(
  params: AoiAutonomyBackgroundTickParams,
): Promise<AoiAutonomyTickResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }

  const now = params.now ?? Date.now();
  const minIntervalMs = Math.max(
    0,
    params.minIntervalMs ?? DEFAULT_BACKGROUND_TICK_MIN_INTERVAL_MS,
  );
  const start = beginAoiAutonomyTick(params.sessionsDir, sessionPath, {
    reason: params.reason,
    now,
    minIntervalMs,
    lockMs: params.lockMs ?? DEFAULT_BACKGROUND_TICK_LOCK_MS,
  });

  if (!start.started) {
    const tickState =
      start.skippedReason === 'tick_already_running'
        ? start.state
        : markAoiAutonomyTickSkipped(params.sessionsDir, sessionPath, {
            skippedReason: start.skippedReason ?? 'tick_skipped',
            now,
          });
    return makeSkippedTickResult({
      sessionsDir: params.sessionsDir,
      sessionPath,
      reason: params.reason,
      now,
      tickState,
      skippedReason: start.skippedReason ?? 'tick_skipped',
    });
  }

  try {
    const result = await withTickTimeout(
      runAoiAutonomyTick({
        ...params,
        sessionPath,
        now,
        maxObservations: Math.min(
          Math.max(1, params.maxObservations ?? MAX_OBSERVATIONS_PER_TICK),
          MAX_OBSERVATIONS_PER_TICK,
        ),
      }),
      params.maxRuntimeMs ?? DEFAULT_BACKGROUND_TICK_MAX_RUNTIME_MS,
    );
    const completedAt = params.now ?? Date.now();
    const tickState = completeAoiAutonomyTick(params.sessionsDir, sessionPath, {
      reason: params.reason,
      now: completedAt,
      minIntervalMs,
      recentObservationCount: loadAoiObservations(params.sessionsDir, sessionPath).length,
      proposalsCreatedInLastTick: result.newActiveProposalCount,
    });

    return {
      ...result,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, completedAt),
      tickState,
      skipped: false,
    };
  } catch (error) {
    const completedAt = params.now ?? Date.now();
    const tickState = completeAoiAutonomyTick(params.sessionsDir, sessionPath, {
      reason: params.reason,
      now: completedAt,
      minIntervalMs,
      recentObservationCount: loadAoiObservations(params.sessionsDir, sessionPath).length,
      proposalsCreatedInLastTick: 0,
      skippedReason: 'tick_failed',
    });
    return makeFailedTickResult({
      sessionsDir: params.sessionsDir,
      sessionPath,
      reason: params.reason,
      now: completedAt,
      tickState,
      warning: error instanceof Error ? error.message : 'Aoi autonomy tick failed.',
    });
  }
}

export async function runAoiAutonomyTick(
  params: AoiAutonomyTickParams,
): Promise<AoiAutonomyTickResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const policy = loadAoiAutonomyPolicy(params.sessionsDir, sessionPath);
  const latestUserMessage = normalizeWhitespace(params.latestUserMessage || '');
  const bundle = collectAoiAutonomyObservations({
    sessionsDir: params.sessionsDir,
    sessionPath,
    now,
    maxObservations: params.maxObservations,
  });
  const missionForAttention =
    loadAoiMissionState(params.sessionsDir, sessionPath) ??
    deriveAoiMissionState({
      sessionsDir: params.sessionsDir,
      sessionPath,
      now,
      persist: false,
    });
  const attentionResult = runAoiAttentionBroker({
    sessionPath,
    now,
    policy,
    researchRuns: bundle.researchRuns,
    memories: bundle.memories,
    activeProposals: bundle.activeProposals,
    recentDecisions: bundle.decisions,
    activeGoals: loadAoiActiveGoals(params.sessionsDir, sessionPath),
    mission: missionForAttention,
    quietMode: params.quietMode,
    userIdleMs: params.userIdleMs,
    maxActionableEvents: latestUserMessage ? 0 : 1,
  });
  if (latestUserMessage) {
    bundle.observations.unshift({
      version: 1,
      id: 'latest-user-message',
      source: 'chat',
      sessionPath,
      createdAt: now,
      summary: sanitizePromptText(latestUserMessage, 260),
      payloadRef: 'chat:latest-user-message',
      memoryIds: [],
      artifactRefs: [],
      proposalIds: [],
      riskSignals: [],
      dedupeKey: `chat:latest-user-message:${sanitizeIdPart(latestUserMessage).slice(0, 64)}`,
    });
  }
  bundle.observations.push(...attentionResult.observations);

  const observationIngestResults = ingestAoiObservations(params.sessionsDir, bundle.observations, {
    now,
  });
  bundle.observations = observationIngestResults.map((result) => result.observation);
  const observationWarnings = observationIngestResults.flatMap((result) => result.warnings);
  const attentionMission = attentionResult.updateMission
    ? deriveAoiMissionState({
        sessionsDir: params.sessionsDir,
        sessionPath,
        now,
        persist: true,
      })
    : missionForAttention;
  recordAoiAttentionBrokerLedgerEvents({
    sessionsDir: params.sessionsDir,
    sessionPath,
    result: attentionResult,
    now,
  });
  updateAoiGoalProgressFromObservations({
    sessionsDir: params.sessionsDir,
    sessionPath,
    observations: bundle.observations,
    activeProposals: bundle.activeProposals,
    now,
  });

  const knownEvidenceRefs = buildEvidenceRefSet({
    observations: bundle.observations,
    activeProposals: bundle.activeProposals,
  });
  const deterministicProposals = buildDeterministicProposals({
    sessionsDir: params.sessionsDir,
    bundle,
    sessionPath,
    latestUserMessage,
    now,
  });
  const llmResult = await runLlmReflection({
    bundle,
    sessionPath,
    latestUserMessage,
    llmConfig: params.llmConfig,
    reflectionChat: params.reflectionChat,
    knownEvidenceRefs,
    now,
  });

  for (const reflection of llmResult.reflections) {
    appendAoiReflection(params.sessionsDir, reflection);
  }

  let activeProposals = loadAoiActiveProposals(params.sessionsDir, sessionPath);
  const recentDecisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const candidates = [
    ...attentionResult.proposals,
    ...deterministicProposals,
    ...llmResult.proposals,
  ]
    .map((proposal) => applyAoiFeedbackCalibrationToProposal(proposal, recentDecisions))
    .sort((left, right) => sortProposalPriority(left, right, recentDecisions));
  const blockedProposals: AoiAutonomyBlockedProposal[] = [];
  const acceptedProposals: AoiProposal[] = [];
  let newReflectionCount = llmResult.reflections.length;

  for (const proposal of candidates.slice(0, Math.max(1, policy.maxProposalsPerTick * 3))) {
    const reasons: string[] = [];
    if (acceptActionLooksSecretBearing(proposal.acceptAction)) {
      reasons.push('accept_action_contains_secret');
    }
    for (const toolName of proposal.suggestedTools) {
      const toolPolicy = getAoiToolAutonomyPolicy(toolName);
      if (proposal.requiresUserApproval !== true && toolPolicy.requiresApproval) {
        reasons.push(`tool_requires_approval:${toolName}`);
      }
    }
    const policyResult = checkAoiProposalPolicy({
      policy,
      proposal,
      activeProposals,
      recentDecisions,
      now,
    });
    reasons.push(...policyResult.reasons);

    if (reasons.length > 0) {
      blockedProposals.push({
        proposalId: proposal.id,
        title: proposal.title,
        reasons: [...new Set(reasons)],
        evidenceRefs: proposal.evidenceRefs,
        actionKind: proposal.acceptAction?.kind,
        requiredAutonomyLevel: proposal.requiredAutonomyLevel,
        requiresUserApproval: proposal.requiresUserApproval,
        risk: proposal.risk,
        safeAlternative: makeBlockedProposalSafeAlternative(proposal, [...new Set(reasons)]),
      });
      if (proposal.recoveryPreview) {
        recordAoiRecoveryLedgerEvent({
          sessionsDir: params.sessionsDir,
          sessionPath,
          type: 'recovery_blocked_by_policy',
          message: `Recovery proposal ${proposal.id} was blocked: ${[...new Set(reasons)].join(', ')}.`,
          toolNames: proposal.suggestedTools,
          now,
        });
        recordAoiGoalRecoverySignal({
          sessionsDir: params.sessionsDir,
          sessionPath,
          proposal,
          evidenceRefs: proposal.evidenceRefs,
          summary: `Recovery proposal "${proposal.title}" was blocked by policy.`,
          now,
        });
      }
      appendAoiReflection(
        params.sessionsDir,
        makeBlockedReflection({
          proposal,
          reasons: [...new Set(reasons)],
          sessionPath,
          now,
        }),
      );
      newReflectionCount += 1;
      continue;
    }

    activeProposals = [proposal, ...activeProposals];
    acceptedProposals.push(proposal);
    recordAoiProposalCreatedRelations(params.sessionsDir, proposal, now);
    if (proposal.recoveryPreview) {
      recordAoiRecoveryProposalRelations(params.sessionsDir, proposal, now);
      recordAoiRecoveryLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'recovery_proposal_created',
        message: `Created recovery proposal ${proposal.id} for ${proposal.recoveryPreview.sourceRef}.`,
        toolNames: proposal.suggestedTools,
        now,
      });
      recordAoiGoalRecoverySignal({
        sessionsDir: params.sessionsDir,
        sessionPath,
        proposal,
        evidenceRefs: proposal.evidenceRefs,
        summary: `Proposed recovery for ${proposal.recoveryPreview.sourceRef}.`,
        now,
      });
    }
    recordAoiGoalContinuationProposed({
      sessionsDir: params.sessionsDir,
      sessionPath,
      proposal,
      now,
    });
    if (acceptedProposals.length >= policy.maxProposalsPerTick) {
      break;
    }
  }

  if (acceptedProposals.length > 0) {
    saveAoiActiveProposals(params.sessionsDir, sessionPath, activeProposals);
  }
  recordAoiAttentionRelations({
    sessionsDir: params.sessionsDir,
    sessionPath,
    result: attentionResult,
    storedObservations: bundle.observations,
    proposals: acceptedProposals,
    mission: attentionMission,
    now,
  });

  return {
    ok: true,
    sessionPath,
    reason: params.reason,
    status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
    tickState: loadAoiAutonomyTickState(params.sessionsDir, sessionPath, now),
    skipped: false,
    newObservationCount: observationIngestResults.filter((result) => result.created).length,
    newReflectionCount,
    newActiveProposalCount: acceptedProposals.length,
    blockedProposalCount: blockedProposals.length,
    blockedProposals,
    warnings: [...observationWarnings, ...llmResult.warnings],
  };
}
