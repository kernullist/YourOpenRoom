import * as fs from 'fs';
import { dirname } from 'path';
import {
  createAoiAutonomyId,
  isValidAoiAutonomyId,
  normalizeAoiAutonomySessionPath,
  resolveAoiAutonomyPaths,
} from './aoiAutonomyStore';
import { buildAoiPreparedActionPlan } from './aoiSafeActionPlan';
import type {
  AoiAutonomyLevel,
  AoiAutonomyRisk,
  AoiGoal,
  AoiMissionState,
  AoiOperatorHealthIssue,
  AoiOperatorHealthState,
  AoiPlaybook,
  AoiPlaybookEdge,
  AoiPlaybookEvidenceKind,
  AoiPlaybookExecutionBoundary,
  AoiPlaybookStatus,
  AoiPlaybookStep,
  AoiPlaybookStepKind,
  AoiPlaybookStepRefs,
  AoiPlaybookStepStatus,
  AoiPreparedActionPlan,
  AoiProposal,
  AoiProposalAcceptActionKind,
} from './aoiAutonomyTypes';

const MAX_PLAYBOOKS = 50;
const MAX_STEPS = 12;
const MAX_REFS = 24;
const MAX_NOTES = 8;
const MAX_TEXT = 240;

export interface AoiPlaybookPreparationInput {
  sessionPath: string;
  proposal?: AoiProposal | null;
  activeGoal?: AoiGoal | null;
  mission?: AoiMissionState | null;
  health?: AoiOperatorHealthState | null;
  title?: string;
  objective?: string;
  now?: number;
  playbookId?: string;
}

export interface AoiPlaybookEvidenceUpdateInput {
  playbook: AoiPlaybook;
  kind: AoiPlaybookEvidenceKind;
  stepId?: string;
  resultSummary?: string;
  evidenceRefs?: string[];
  refs?: Partial<AoiPlaybookStepRefs>;
  failedReason?: string;
  now?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(value: unknown, fallback: string, maxChars = MAX_TEXT): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = normalizeWhitespace(raw).slice(0, maxChars);
  return normalized || fallback.slice(0, maxChars);
}

function normalizeStringList(value: unknown, maxItems = MAX_REFS, maxChars = MAX_TEXT): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = normalizeWhitespace(item).slice(0, maxChars);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function dedupeStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  return normalizeStringList(
    values.filter((value): value is string => typeof value === 'string'),
    maxItems,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStringParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  return typeof value === 'string' ? normalizeWhitespace(value) : '';
}

function inferResearchRunRef(proposal?: AoiProposal | null): string | undefined {
  const params = proposal?.acceptAction?.params;
  if (isRecord(params)) {
    const runId = getStringParam(params, 'runId');
    if (runId) {
      return `research:${runId}`;
    }
  }
  return proposal?.artifactRefs.find((ref) => ref.startsWith('research:'))?.split('/')[0];
}

function inferResearchArtifactRef(proposal?: AoiProposal | null): string | undefined {
  return proposal?.artifactRefs.find((ref) => ref.startsWith('research:'));
}

function isMutationProposalAccepted(proposal?: AoiProposal | null): boolean {
  return proposal?.status === 'accepted' || proposal?.status === 'executed';
}

function actionKind(proposal?: AoiProposal | null): AoiProposalAcceptActionKind | undefined {
  return proposal?.acceptAction?.kind;
}

function safeRefsForProposal(proposal?: AoiProposal | null): string[] {
  if (!proposal) {
    return [];
  }
  return dedupeStrings(
    [
      `proposal:${proposal.id}`,
      ...proposal.evidenceRefs,
      ...proposal.artifactRefs,
      ...proposal.memoryIds.map((id) => `memory:${id}`),
    ],
    MAX_REFS,
  );
}

function safeRefsForGoal(goal?: AoiGoal | null): string[] {
  if (!goal) {
    return [];
  }
  return dedupeStrings(
    [
      `goal:${goal.id}`,
      ...goal.sourceRefs,
      ...goal.plan.sourceRefs,
      ...goal.plan.steps.flatMap((step) => [
        `plan-step:${step.id}`,
        ...step.evidenceRefs,
        ...step.expectedEvidence,
      ]),
    ],
    MAX_REFS,
  );
}

function safeRefsForMission(mission?: AoiMissionState | null): string[] {
  if (!mission || mission.status === 'none') {
    return [];
  }
  return dedupeStrings(
    [
      `mission:${mission.activeGoalId || mission.sessionPath}`,
      mission.lastMeaningfulEventRef,
      ...mission.evidenceRefs,
      ...Object.values(mission.sourceRefs),
      mission.nextRecommendedAction.ref,
    ],
    MAX_REFS,
  );
}

function healthIssueRef(issue: AoiOperatorHealthIssue): string {
  return `health:${issue.capability}:${issue.code}`;
}

function healthRefs(health?: AoiOperatorHealthState | null): string[] {
  if (!health) {
    return [];
  }
  return health.issues
    .filter((issue) => issue.severity === 'error' || issue.severity === 'blocker')
    .map(healthIssueRef)
    .slice(0, MAX_REFS);
}

function boundary(params: {
  kind: AoiPlaybookStepKind;
  risk?: AoiAutonomyRisk;
  requiredLevel?: AoiAutonomyLevel;
  requiresApproval?: boolean;
  freshAcceptanceRequired?: boolean;
  mutationCapable?: boolean;
  commandCapable?: boolean;
  approver?: AoiPlaybookExecutionBoundary['approver'];
  existingGate?: AoiPlaybookExecutionBoundary['existingGate'];
  summary: string;
  approvalRef?: string;
}): AoiPlaybookExecutionBoundary {
  return {
    version: 1,
    mutationCapable: params.mutationCapable === true,
    commandCapable: params.commandCapable === true,
    requiresApproval: params.requiresApproval === true,
    requiredAutonomyLevel: params.requiredLevel ?? (params.risk === 'high' ? 'L5' : 'L3'),
    freshAcceptanceRequired: params.freshAcceptanceRequired === true,
    approver: params.approver ?? (params.requiresApproval ? 'user' : 'none'),
    existingGate: params.existingGate ?? 'none',
    canAutoRun: false,
    summary: normalizeText(params.summary, 'No autonomous execution is allowed.'),
    ...(params.approvalRef ? { approvalRef: params.approvalRef } : {}),
  };
}

function boundaryFromPreparedPlan(
  kind: AoiPlaybookStepKind,
  plan: AoiPreparedActionPlan | null,
  proposal?: AoiProposal | null,
): AoiPlaybookExecutionBoundary {
  if (!plan) {
    return boundary({
      kind,
      requiresApproval: false,
      summary: 'This step only coordinates existing evidence and does not execute tools.',
    });
  }
  if (kind === 'run_approved_command') {
    return boundary({
      kind,
      risk: 'high',
      commandCapable: true,
      requiresApproval: true,
      requiredLevel: 'L5',
      freshAcceptanceRequired: true,
      approver: 'user',
      existingGate: 'approved_command',
      summary: 'Validation command execution requires fresh approval for the exact command.',
      approvalRef: proposal ? `proposal:${proposal.id}` : undefined,
    });
  }
  const existingGate: AoiPlaybookExecutionBoundary['existingGate'] =
    kind === 'create_kira_work'
      ? 'kira_handoff'
      : kind === 'start_research'
        ? 'research_approval'
        : plan.approval.required
          ? 'proposal_acceptance'
          : 'none';
  return boundary({
    kind,
    risk: plan.risk.level,
    mutationCapable: plan.risk.mutationCapable,
    commandCapable: plan.risk.commandCapable,
    requiresApproval: plan.approval.required,
    requiredLevel: plan.approval.requiredLevel,
    freshAcceptanceRequired: plan.approval.freshAcceptanceRequired,
    approver: plan.approval.approver,
    existingGate,
    summary: plan.approval.required
      ? plan.approval.reason
      : 'This step may be marked complete from existing read-only evidence.',
    approvalRef: proposal ? `proposal:${proposal.id}` : undefined,
  });
}

function statusForStep(params: {
  kind: AoiPlaybookStepKind;
  proposal?: AoiProposal | null;
  plan?: AoiPreparedActionPlan | null;
  dependsOn?: string[];
}): AoiPlaybookStepStatus {
  if ((params.dependsOn ?? []).length > 0) {
    return 'pending';
  }
  if (params.kind === 'wait_for_external_event') {
    return 'waiting_for_external_event';
  }
  if (params.kind === 'run_approved_command') {
    return 'waiting_for_approval';
  }
  if (params.plan?.approval.required) {
    return isMutationProposalAccepted(params.proposal) ? 'ready' : 'waiting_for_approval';
  }
  return 'ready';
}

function makeStep(params: {
  playbookId: string;
  index: number;
  kind: AoiPlaybookStepKind;
  title: string;
  summary: string;
  proposal?: AoiProposal | null;
  plan?: AoiPreparedActionPlan | null;
  dependsOn?: string[];
  evidenceRefs: string[];
  sourceRefs: string[];
  refs?: AoiPlaybookStepRefs;
  checkpointNotes?: string[];
  rollbackNotes?: string[];
  validationNotes?: string[];
  now: number;
}): AoiPlaybookStep {
  const id = `${params.playbookId}-step-${String(params.index + 1).padStart(2, '0')}`;
  const stepBoundary =
    params.kind === 'preview_command'
      ? boundary({
          kind: params.kind,
          commandCapable: false,
          requiresApproval: false,
          existingGate: 'none',
          summary: 'Preview the exact validation command only. No command runs from this step.',
        })
      : params.kind === 'ask_user'
        ? boundary({
            kind: params.kind,
            requiresApproval: true,
            requiredLevel: 'L1',
            existingGate: 'user_decision',
            summary: 'Ask the operator for the next decision instead of continuing automatically.',
          })
        : boundaryFromPreparedPlan(params.kind, params.plan ?? null, params.proposal);
  return {
    version: 1,
    id,
    kind: params.kind,
    title: normalizeText(params.title, params.kind, 120),
    summary: normalizeText(params.summary, params.title),
    status: statusForStep({
      kind: params.kind,
      proposal: params.proposal,
      plan: params.plan,
      dependsOn: params.dependsOn,
    }),
    dependsOn: normalizeStringList(params.dependsOn ?? [], MAX_STEPS, 128),
    evidenceRefs: dedupeStrings(params.evidenceRefs, MAX_REFS),
    sourceRefs: dedupeStrings(params.sourceRefs, MAX_REFS),
    blockedReasons: [],
    executionBoundary: stepBoundary,
    checkpointNotes: normalizeStringList(params.checkpointNotes ?? [], MAX_NOTES),
    rollbackNotes: normalizeStringList(params.rollbackNotes ?? [], MAX_NOTES),
    validationNotes: normalizeStringList(params.validationNotes ?? [], MAX_NOTES),
    refs: params.refs ?? {},
    updatedAt: params.now,
  };
}

function makeEdges(steps: AoiPlaybookStep[], evidenceRefs: string[]): AoiPlaybookEdge[] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const edges: AoiPlaybookEdge[] = [];
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!stepById.has(dependency)) {
        continue;
      }
      edges.push({
        version: 1,
        id: `edge-${dependency}-${step.id}`.slice(0, 128),
        fromStepId: dependency,
        toStepId: step.id,
        kind: step.kind === 'wait_for_external_event' ? 'waits_for' : 'depends_on',
        evidenceRefs: evidenceRefs.slice(0, 8),
      });
    }
  }
  return edges;
}

function commandPreviewSummary(plan: AoiPreparedActionPlan | null): string {
  const command = plan?.validation.commands[0];
  if (!command) {
    return 'Prepare the validation command boundary. No command is approved or run yet.';
  }
  return `Preview exact command only: ${command}`;
}

function addDefaultSteps(params: {
  playbookId: string;
  proposal?: AoiProposal | null;
  goal?: AoiGoal | null;
  mission?: AoiMissionState | null;
  now: number;
  sourceRefs: string[];
  evidenceRefs: string[];
}): AoiPlaybookStep[] {
  const steps: AoiPlaybookStep[] = [];
  const kind = actionKind(params.proposal);
  const plan = params.proposal
    ? buildAoiPreparedActionPlan(params.proposal, { now: params.now })
    : null;
  const proposalRef = params.proposal ? `proposal:${params.proposal.id}` : undefined;
  const goalRef = params.goal ? `goal:${params.goal.id}` : params.mission?.sourceRefs.goalRef;
  const missionRef =
    params.mission && params.mission.status !== 'none'
      ? `mission:${params.mission.activeGoalId || params.mission.sessionPath}`
      : undefined;
  const baseRefs: AoiPlaybookStepRefs = {
    ...(proposalRef ? { proposalRef } : {}),
    ...(goalRef ? { goalRef } : {}),
    ...(missionRef ? { missionRef } : {}),
  };

  const push = (step: Omit<Parameters<typeof makeStep>[0], 'playbookId' | 'index' | 'now'>) => {
    steps.push(
      makeStep({
        ...step,
        playbookId: params.playbookId,
        index: steps.length,
        now: params.now,
      }),
    );
  };

  push({
    kind: 'inspect_context',
    title: 'Inspect current context',
    summary: 'Review the active goal, mission state, proposal evidence, and health limits.',
    proposal: params.proposal,
    evidenceRefs: params.evidenceRefs,
    sourceRefs: params.sourceRefs,
    refs: baseRefs,
  });
  const inspectStepId = steps[0].id;

  if (kind === 'start_research') {
    push({
      kind: 'start_research',
      title: 'Start scoped research',
      summary: 'Create a research run only after explicit approval for this proposal.',
      proposal: params.proposal,
      plan,
      dependsOn: [inspectStepId],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        researchRunRef: inferResearchRunRef(params.proposal),
      },
      checkpointNotes: [plan?.checkpoint.summary ?? 'No workspace checkpoint is required.'],
      rollbackNotes: [plan?.rollback.summary ?? 'Research can be superseded or ignored.'],
      validationNotes: [plan?.validation.summary ?? 'Confirm research artifacts after completion.'],
    });
    push({
      kind: 'wait_for_external_event',
      title: 'Wait for research completion',
      summary: 'Update this step only from a completed research event or artifact evidence.',
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        researchRunRef: inferResearchRunRef(params.proposal),
      },
    });
    push({
      kind: 'read_research_artifact',
      title: 'Read research artifact',
      summary: 'Read the accepted research artifact after the run reports completion.',
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        researchRunRef: inferResearchRunRef(params.proposal),
        researchArtifactRef: inferResearchArtifactRef(params.proposal),
      },
    });
  } else if (
    kind === 'read_research_artifact' ||
    kind === 'open_research_artifact' ||
    kind === 'get_research_status'
  ) {
    push({
      kind: 'read_research_artifact',
      title: 'Read research artifact',
      summary: 'Read existing research evidence through the existing read-only path.',
      proposal: params.proposal,
      plan,
      dependsOn: [inspectStepId],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        researchRunRef: inferResearchRunRef(params.proposal),
        researchArtifactRef: inferResearchArtifactRef(params.proposal),
      },
    });
  } else if (kind === 'create_kira_work') {
    push({
      kind: 'create_kira_work',
      title: 'Create reviewed Kira work',
      summary: 'Create one supervised Kira work item only through the accepted proposal path.',
      proposal: params.proposal,
      plan,
      dependsOn: [inspectStepId],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: baseRefs,
      checkpointNotes: [plan?.checkpoint.summary ?? 'Kira isolated worktree is required.'],
      rollbackNotes: [plan?.rollback.summary ?? 'Reject or revise Kira output before integration.'],
      validationNotes: [plan?.validation.summary ?? 'Kira validation evidence is required.'],
    });
    push({
      kind: 'wait_for_external_event',
      title: 'Wait for Kira review and validation',
      summary: 'Wait until Kira reports reviewed, validated work. Aoi does not integrate it here.',
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: baseRefs,
    });
    push({
      kind: 'preview_command',
      title: 'Preview validation command',
      summary: commandPreviewSummary(plan),
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: baseRefs,
      validationNotes: plan?.validation.commands ?? [],
    });
    push({
      kind: 'run_approved_command',
      title: 'Run approved validation command',
      summary: 'Run one exact validation command only after fresh command approval.',
      proposal: params.proposal,
      plan,
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: baseRefs,
      rollbackNotes: [
        'Validation success or failure does not mutate the playbook into code changes.',
      ],
      validationNotes: plan?.validation.commands ?? [],
    });
  } else if (kind === 'run_command') {
    push({
      kind: 'preview_command',
      title: 'Preview validation command',
      summary: commandPreviewSummary(plan),
      dependsOn: [inspectStepId],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: baseRefs,
      validationNotes: plan?.validation.commands ?? [],
    });
    push({
      kind: 'run_approved_command',
      title: 'Run approved validation command',
      summary: 'Run the exact command only through the approved command runner.',
      proposal: params.proposal,
      plan,
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: baseRefs,
      rollbackNotes: [
        plan?.rollback.summary ?? 'Validation-only command does not promise rollback.',
      ],
      validationNotes: plan?.validation.commands ?? [],
    });
  } else if (params.mission?.waitingOn === 'kira') {
    push({
      kind: 'wait_for_external_event',
      title: 'Wait for Kira event',
      summary: 'Wait for the linked Kira work to report reviewed progress.',
      dependsOn: [inspectStepId],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        kiraWorkRef: params.mission.sourceRefs.kiraWorkRef,
      },
    });
  } else if (params.mission?.waitingOn === 'research') {
    push({
      kind: 'wait_for_external_event',
      title: 'Wait for research event',
      summary: 'Wait for the linked research run to complete before summarizing.',
      dependsOn: [inspectStepId],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        researchRunRef: params.mission.sourceRefs.researchRunRef,
      },
    });
    push({
      kind: 'read_research_artifact',
      title: 'Read research artifact',
      summary: 'Read completed research evidence after the waiting step is satisfied.',
      dependsOn: [steps[steps.length - 1].id],
      evidenceRefs: params.evidenceRefs,
      sourceRefs: params.sourceRefs,
      refs: {
        ...baseRefs,
        researchRunRef: params.mission.sourceRefs.researchRunRef,
      },
    });
  }

  const previousStepId = steps[steps.length - 1]?.id ?? inspectStepId;
  push({
    kind: 'summarize_result',
    title: 'Summarize result',
    summary: 'Summarize only completed evidence and call out missing validation explicitly.',
    dependsOn: [previousStepId],
    evidenceRefs: params.evidenceRefs,
    sourceRefs: params.sourceRefs,
    refs: baseRefs,
  });
  push({
    kind: 'ask_user',
    title: 'Ask for next decision',
    summary: 'Ask whether to continue, stop, revise, or archive the playbook.',
    dependsOn: [steps[steps.length - 1].id],
    evidenceRefs: params.evidenceRefs,
    sourceRefs: params.sourceRefs,
    refs: baseRefs,
  });

  return steps.slice(0, MAX_STEPS);
}

function healthIssuesForStep(
  step: AoiPlaybookStep,
  health?: AoiOperatorHealthState | null,
): AoiOperatorHealthIssue[] {
  if (!health) {
    return [];
  }
  const capabilityByKind: Partial<Record<AoiPlaybookStepKind, string[]>> = {
    inspect_context: ['memory', 'workspace'],
    read_research_artifact: ['research'],
    start_research: ['research'],
    create_kira_work: ['kira'],
    preview_command: ['workspace', 'approved_commands'],
    run_approved_command: ['approved_commands', 'workspace'],
    wait_for_external_event:
      step.refs.kiraWorkRef || step.title.toLowerCase().includes('kira') ? ['kira'] : ['research'],
  };
  const capabilities = capabilityByKind[step.kind] ?? [];
  return health.issues.filter(
    (issue) =>
      capabilities.includes(issue.capability) &&
      (issue.severity === 'error' || issue.severity === 'blocker'),
  );
}

function applyHealthPrerequisites(
  steps: AoiPlaybookStep[],
  health?: AoiOperatorHealthState | null,
): {
  steps: AoiPlaybookStep[];
  blockedReasons: string[];
  healthIssueRefs: string[];
} {
  const blockedReasons: string[] = [];
  const issueRefs: string[] = [];
  const nextSteps = steps.map((step) => {
    const issues = healthIssuesForStep(step, health);
    if (issues.length === 0) {
      return step;
    }
    const reasons = issues.map((issue) => `${issue.capability}:${issue.code}`);
    blockedReasons.push(...reasons);
    issueRefs.push(...issues.map(healthIssueRef));
    return {
      ...step,
      status: 'blocked' as const,
      blockedReasons: dedupeStrings([...step.blockedReasons, ...reasons], MAX_NOTES),
      evidenceRefs: dedupeStrings([...step.evidenceRefs, ...issues.map(healthIssueRef)], MAX_REFS),
      updatedAt: Math.max(step.updatedAt, health?.generatedAt ?? step.updatedAt),
    };
  });
  return {
    steps: nextSteps,
    blockedReasons: dedupeStrings(blockedReasons, MAX_REFS),
    healthIssueRefs: dedupeStrings(issueRefs, MAX_REFS),
  };
}

function computeNextRequiredDecision(steps: AoiPlaybookStep[], blockedReasons: string[]): string {
  if (blockedReasons.length > 0) {
    return `Resolve prerequisite: ${blockedReasons[0]}`;
  }
  const next = steps.find((step) => step.status !== 'completed' && step.status !== 'skipped');
  if (!next) {
    return 'Review the completed playbook and archive it.';
  }
  if (next.status === 'waiting_for_approval') {
    return next.executionBoundary.summary;
  }
  if (next.status === 'waiting_for_external_event') {
    return `Wait for external evidence: ${next.title}`;
  }
  if (next.status === 'blocked') {
    return `Resolve blocked step: ${next.blockedReasons[0] || next.title}`;
  }
  return next.summary;
}

function computePlaybookStatus(
  steps: AoiPlaybookStep[],
  blockedReasons: string[],
  fallback: AoiPlaybookStatus,
): AoiPlaybookStatus {
  if (blockedReasons.length > 0 || steps.some((step) => step.status === 'blocked')) {
    return 'blocked';
  }
  if (steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
    return 'completed';
  }
  if (
    steps.some(
      (step) =>
        step.status === 'waiting_for_approval' || step.status === 'waiting_for_external_event',
    )
  ) {
    return fallback === 'preview' ? 'preview' : 'waiting';
  }
  return fallback;
}

function withDerivedPlaybookState(playbook: AoiPlaybook): AoiPlaybook {
  const next = playbook.steps.find(
    (step) => step.status !== 'completed' && step.status !== 'skipped',
  );
  return {
    ...playbook,
    status:
      playbook.status === 'archived'
        ? 'archived'
        : computePlaybookStatus(playbook.steps, playbook.blockedReasons, playbook.status),
    ...(next ? { nextStepId: next.id } : {}),
    ...(!next ? { nextStepId: undefined } : {}),
    nextRequiredDecision: computeNextRequiredDecision(playbook.steps, playbook.blockedReasons),
  };
}

export function prepareAoiPlaybook(input: AoiPlaybookPreparationInput): AoiPlaybook {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const playbookId =
    input.playbookId && isValidAoiAutonomyId(input.playbookId)
      ? input.playbookId
      : createAoiAutonomyId('aoi-playbook', now);
  const sourceRefs = dedupeStrings(
    [
      ...safeRefsForProposal(input.proposal),
      ...safeRefsForGoal(input.activeGoal),
      ...safeRefsForMission(input.mission),
      ...healthRefs(input.health),
    ],
    MAX_REFS,
  );
  const evidenceRefs = dedupeStrings(
    [
      ...sourceRefs,
      ...(input.proposal?.evidenceRefs ?? []),
      ...(input.activeGoal?.sourceRefs ?? []),
      ...(input.mission?.evidenceRefs ?? []),
    ],
    MAX_REFS,
  );
  const initialSteps = addDefaultSteps({
    playbookId,
    proposal: input.proposal,
    goal: input.activeGoal,
    mission: input.mission,
    now,
    sourceRefs,
    evidenceRefs,
  });
  const healthResult = applyHealthPrerequisites(initialSteps, input.health);
  const edges = makeEdges(healthResult.steps, evidenceRefs);
  const title =
    input.title ??
    input.proposal?.title ??
    input.activeGoal?.title ??
    input.mission?.focusSummary ??
    'Aoi coordinated playbook';
  const objective =
    input.objective ??
    input.proposal?.reason ??
    input.activeGoal?.userIntentSummary ??
    input.mission?.focusSummary ??
    title;
  return withDerivedPlaybookState({
    version: 1,
    id: playbookId,
    sessionPath,
    title: normalizeText(title, 'Aoi coordinated playbook', 140),
    objective: normalizeText(objective, title, 360),
    status: 'preview',
    createdAt: now,
    updatedAt: now,
    sourceRefs,
    evidenceRefs,
    ...(input.activeGoal ? { goalId: input.activeGoal.id } : {}),
    ...(input.proposal ? { proposalId: input.proposal.id } : {}),
    ...(input.mission && input.mission.status !== 'none'
      ? { missionRef: `mission:${input.mission.activeGoalId || input.mission.sessionPath}` }
      : {}),
    healthIssueRefs: healthResult.healthIssueRefs,
    blockedReasons: healthResult.blockedReasons,
    nextRequiredDecision: '',
    steps: healthResult.steps,
    edges,
  });
}

function dependenciesComplete(step: AoiPlaybookStep, steps: AoiPlaybookStep[]): boolean {
  const byId = new Map(steps.map((item) => [item.id, item]));
  return step.dependsOn.every((id) => {
    const dependency = byId.get(id);
    return dependency?.status === 'completed' || dependency?.status === 'skipped';
  });
}

function readyStatusForUnblockedStep(step: AoiPlaybookStep): AoiPlaybookStepStatus {
  if (step.executionBoundary.requiresApproval) {
    return 'waiting_for_approval';
  }
  if (step.kind === 'wait_for_external_event') {
    return 'waiting_for_external_event';
  }
  return 'ready';
}

function advanceReadySteps(steps: AoiPlaybookStep[], now: number): AoiPlaybookStep[] {
  return steps.map((step) => {
    if (step.status !== 'pending' || !dependenciesComplete(step, steps)) {
      return step;
    }
    return {
      ...step,
      status: readyStatusForUnblockedStep(step),
      updatedAt: now,
    };
  });
}

function findStepForEvidence(
  playbook: AoiPlaybook,
  input: AoiPlaybookEvidenceUpdateInput,
): AoiPlaybookStep | undefined {
  if (input.stepId) {
    return playbook.steps.find((step) => step.id === input.stepId);
  }
  if (input.kind === 'inspect_context_completed') {
    return playbook.steps.find((step) => step.kind === 'inspect_context');
  }
  if (input.kind === 'read_research_artifact_completed') {
    return playbook.steps.find((step) => step.kind === 'read_research_artifact');
  }
  if (input.kind === 'research_completed') {
    return (
      playbook.steps.find(
        (step) => step.kind === 'wait_for_external_event' && !step.refs.kiraWorkRef,
      ) ?? playbook.steps.find((step) => step.kind === 'start_research')
    );
  }
  if (input.kind === 'kira_work_created') {
    return playbook.steps.find((step) => step.kind === 'create_kira_work');
  }
  if (input.kind === 'kira_work_completed') {
    return playbook.steps.find(
      (step) =>
        step.kind === 'wait_for_external_event' &&
        (step.refs.kiraWorkRef || /kira/i.test(step.title)),
    );
  }
  if (input.kind === 'approved_command_recorded') {
    return playbook.steps.find((step) => step.kind === 'run_approved_command');
  }
  if (input.kind === 'summarize_result_completed') {
    return playbook.steps.find((step) => step.kind === 'summarize_result');
  }
  if (input.kind === 'user_decision_recorded') {
    return playbook.steps.find((step) => step.kind === 'ask_user');
  }
  return playbook.steps.find((step) => step.id === input.stepId);
}

export function updateAoiPlaybookFromEvidence(input: AoiPlaybookEvidenceUpdateInput): AoiPlaybook {
  const now = input.now ?? Date.now();
  const target = findStepForEvidence(input.playbook, input);
  if (!target) {
    return {
      ...input.playbook,
      updatedAt: now,
      blockedReasons: dedupeStrings(
        [...input.playbook.blockedReasons, `missing_step_for_${input.kind}`],
        MAX_REFS,
      ),
    };
  }
  const evidenceRefs = dedupeStrings(input.evidenceRefs ?? [], MAX_REFS);
  const status: AoiPlaybookStepStatus = input.kind === 'step_failed' ? 'blocked' : 'completed';
  const failedReason =
    input.kind === 'step_failed'
      ? normalizeText(input.failedReason, 'step_failed', 160)
      : undefined;
  const shouldCompleteFromSameEvidence = (step: AoiPlaybookStep): boolean => {
    if (input.kind === 'research_completed') {
      return step.kind === 'start_research';
    }
    if (input.kind === 'kira_work_completed') {
      return step.kind === 'create_kira_work';
    }
    if (input.kind === 'approved_command_recorded') {
      return step.kind === 'preview_command';
    }
    return false;
  };
  const updatedSteps = input.playbook.steps.map((step) => {
    if (step.id !== target.id && !shouldCompleteFromSameEvidence(step)) {
      return step;
    }
    return {
      ...step,
      status: step.id === target.id ? status : 'completed',
      resultSummary: normalizeText(
        input.resultSummary,
        input.kind === 'step_failed' ? 'Step failed.' : 'Step completed from existing evidence.',
      ),
      evidenceRefs: dedupeStrings([...step.evidenceRefs, ...evidenceRefs], MAX_REFS),
      refs: {
        ...step.refs,
        ...(input.refs ?? {}),
      },
      blockedReasons:
        input.kind === 'step_failed'
          ? dedupeStrings([...step.blockedReasons, failedReason], MAX_NOTES)
          : step.blockedReasons,
      updatedAt: now,
    };
  });
  const advancedSteps = advanceReadySteps(updatedSteps, now);
  const blockedReasons =
    input.kind === 'step_failed'
      ? dedupeStrings([...input.playbook.blockedReasons, failedReason], MAX_REFS)
      : input.playbook.blockedReasons;
  return withDerivedPlaybookState({
    ...input.playbook,
    updatedAt: now,
    sourceRefs: dedupeStrings([...input.playbook.sourceRefs, ...evidenceRefs], MAX_REFS),
    evidenceRefs: dedupeStrings([...input.playbook.evidenceRefs, ...evidenceRefs], MAX_REFS),
    blockedReasons,
    steps: advancedSteps,
  });
}

function ensureDirectory(filePath: string): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDirectory(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
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

function isAoiPlaybookStepKind(value: unknown): value is AoiPlaybookStepKind {
  return (
    value === 'inspect_context' ||
    value === 'read_research_artifact' ||
    value === 'start_research' ||
    value === 'create_kira_work' ||
    value === 'preview_command' ||
    value === 'run_approved_command' ||
    value === 'summarize_result' ||
    value === 'ask_user' ||
    value === 'wait_for_external_event'
  );
}

function isAoiPlaybookStepStatus(value: unknown): value is AoiPlaybookStepStatus {
  return (
    value === 'pending' ||
    value === 'ready' ||
    value === 'waiting_for_approval' ||
    value === 'waiting_for_external_event' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'skipped'
  );
}

function isAoiPlaybookStatus(value: unknown): value is AoiPlaybookStatus {
  return (
    value === 'preview' ||
    value === 'active' ||
    value === 'waiting' ||
    value === 'blocked' ||
    value === 'completed' ||
    value === 'archived'
  );
}

function normalizeBoundary(value: unknown): AoiPlaybookExecutionBoundary {
  const raw = isRecord(value) ? value : {};
  return {
    version: 1,
    mutationCapable: raw.mutationCapable === true,
    commandCapable: raw.commandCapable === true,
    requiresApproval: raw.requiresApproval === true,
    requiredAutonomyLevel:
      raw.requiredAutonomyLevel === 'L1' ||
      raw.requiredAutonomyLevel === 'L2' ||
      raw.requiredAutonomyLevel === 'L3' ||
      raw.requiredAutonomyLevel === 'L4' ||
      raw.requiredAutonomyLevel === 'L5'
        ? raw.requiredAutonomyLevel
        : 'L3',
    freshAcceptanceRequired: raw.freshAcceptanceRequired === true,
    approver:
      raw.approver === 'user' || raw.approver === 'kira_reviewer' || raw.approver === 'none'
        ? raw.approver
        : raw.requiresApproval === true
          ? 'user'
          : 'none',
    existingGate:
      raw.existingGate === 'proposal_acceptance' ||
      raw.existingGate === 'research_approval' ||
      raw.existingGate === 'kira_handoff' ||
      raw.existingGate === 'approved_command' ||
      raw.existingGate === 'user_decision' ||
      raw.existingGate === 'none'
        ? raw.existingGate
        : 'none',
    canAutoRun: false,
    summary: normalizeText(raw.summary, 'No autonomous execution is allowed.'),
    ...(typeof raw.approvalRef === 'string' && raw.approvalRef.trim()
      ? { approvalRef: normalizeText(raw.approvalRef, '', 160) }
      : {}),
  };
}

function normalizeStep(value: unknown, now: number): AoiPlaybookStep | null {
  if (!isRecord(value) || value.version !== 1 || !isValidAoiAutonomyId(value.id)) {
    return null;
  }
  if (!isAoiPlaybookStepKind(value.kind)) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    kind: value.kind,
    title: normalizeText(value.title, value.kind, 120),
    summary: normalizeText(value.summary, value.kind),
    status: isAoiPlaybookStepStatus(value.status) ? value.status : 'pending',
    dependsOn: normalizeStringList(value.dependsOn, MAX_STEPS, 128),
    evidenceRefs: normalizeStringList(value.evidenceRefs),
    sourceRefs: normalizeStringList(value.sourceRefs),
    ...(typeof value.resultSummary === 'string' && value.resultSummary.trim()
      ? { resultSummary: normalizeText(value.resultSummary, '', 240) }
      : {}),
    blockedReasons: normalizeStringList(value.blockedReasons, MAX_NOTES, 160),
    executionBoundary: normalizeBoundary(value.executionBoundary),
    checkpointNotes: normalizeStringList(value.checkpointNotes, MAX_NOTES),
    rollbackNotes: normalizeStringList(value.rollbackNotes, MAX_NOTES),
    validationNotes: normalizeStringList(value.validationNotes, MAX_NOTES),
    refs: isRecord(value.refs) ? (value.refs as AoiPlaybookStepRefs) : {},
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
  };
}

function normalizeEdge(value: unknown): AoiPlaybookEdge | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.fromStepId !== 'string' ||
    typeof value.toStepId !== 'string'
  ) {
    return null;
  }
  return {
    version: 1,
    id: normalizeText(value.id, 'edge', 128),
    fromStepId: normalizeText(value.fromStepId, '', 128),
    toStepId: normalizeText(value.toStepId, '', 128),
    kind:
      value.kind === 'unblocks' || value.kind === 'waits_for' || value.kind === 'depends_on'
        ? value.kind
        : 'depends_on',
    evidenceRefs: normalizeStringList(value.evidenceRefs, 12),
  };
}

function normalizePlaybook(value: unknown, sessionPath: string): AoiPlaybook | null {
  if (!isRecord(value) || value.version !== 1 || !isValidAoiAutonomyId(value.id)) {
    return null;
  }
  const now = typeof value.updatedAt === 'number' ? value.updatedAt : Date.now();
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map((step) => normalizeStep(step, now))
        .filter((step): step is AoiPlaybookStep => step !== null)
        .slice(0, MAX_STEPS)
    : [];
  if (steps.length === 0) {
    return null;
  }
  const playbook: AoiPlaybook = {
    version: 1,
    id: value.id,
    sessionPath,
    title: normalizeText(value.title, 'Aoi coordinated playbook', 140),
    objective: normalizeText(value.objective, 'Coordinate Aoi work.', 360),
    status: isAoiPlaybookStatus(value.status) ? value.status : 'preview',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: now,
    ...(typeof value.archivedAt === 'number' ? { archivedAt: value.archivedAt } : {}),
    sourceRefs: normalizeStringList(value.sourceRefs),
    evidenceRefs: normalizeStringList(value.evidenceRefs),
    ...(typeof value.goalId === 'string' ? { goalId: normalizeText(value.goalId, '', 128) } : {}),
    ...(typeof value.proposalId === 'string'
      ? { proposalId: normalizeText(value.proposalId, '', 128) }
      : {}),
    ...(typeof value.missionRef === 'string'
      ? { missionRef: normalizeText(value.missionRef, '', 160) }
      : {}),
    healthIssueRefs: normalizeStringList(value.healthIssueRefs),
    blockedReasons: normalizeStringList(value.blockedReasons),
    ...(typeof value.nextStepId === 'string'
      ? { nextStepId: normalizeText(value.nextStepId, '', 128) }
      : {}),
    nextRequiredDecision: normalizeText(value.nextRequiredDecision, 'Review next playbook step.'),
    steps,
    edges: Array.isArray(value.edges)
      ? value.edges.map(normalizeEdge).filter((edge): edge is AoiPlaybookEdge => edge !== null)
      : makeEdges(steps, normalizeStringList(value.evidenceRefs)),
  };
  return withDerivedPlaybookState(playbook);
}

export function loadAoiActivePlaybooks(sessionsDir: string, sessionPath: string): AoiPlaybook[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return [];
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const parsed = readJson<unknown[]>(paths.activePlaybooks);
  return Array.isArray(parsed)
    ? parsed
        .map((item) => normalizePlaybook(item, normalizedSessionPath))
        .filter((item): item is AoiPlaybook => item !== null)
        .slice(0, MAX_PLAYBOOKS)
    : [];
}

export function loadAoiArchivedPlaybooks(sessionsDir: string, sessionPath: string): AoiPlaybook[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return [];
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const parsed = readJson<unknown[]>(paths.archivedPlaybooks);
  return Array.isArray(parsed)
    ? parsed
        .map((item) => normalizePlaybook(item, normalizedSessionPath))
        .filter((item): item is AoiPlaybook => item !== null)
        .slice(0, MAX_PLAYBOOKS)
    : [];
}

export function saveAoiActivePlaybooks(
  sessionsDir: string,
  sessionPath: string,
  playbooks: AoiPlaybook[],
): AoiPlaybook[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const normalized = playbooks
    .map((item) => normalizePlaybook(item, normalizedSessionPath))
    .filter((item): item is AoiPlaybook => item !== null)
    .filter((item) => item.status !== 'archived')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PLAYBOOKS);
  writeJsonAtomic(paths.activePlaybooks, normalized);
  return normalized;
}

export function saveAoiArchivedPlaybooks(
  sessionsDir: string,
  sessionPath: string,
  playbooks: AoiPlaybook[],
): AoiPlaybook[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const normalized = playbooks
    .map((item) => normalizePlaybook(item, normalizedSessionPath))
    .filter((item): item is AoiPlaybook => item !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PLAYBOOKS);
  writeJsonAtomic(paths.archivedPlaybooks, normalized);
  return normalized;
}

export function upsertAoiPlaybook(
  sessionsDir: string,
  sessionPath: string,
  playbook: AoiPlaybook,
): AoiPlaybook {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const normalized = normalizePlaybook(playbook, normalizedSessionPath);
  if (!normalized) {
    throw new Error('Invalid Aoi playbook.');
  }
  const active = loadAoiActivePlaybooks(sessionsDir, normalizedSessionPath).filter(
    (item) => item.id !== normalized.id,
  );
  const archived = loadAoiArchivedPlaybooks(sessionsDir, normalizedSessionPath).filter(
    (item) => item.id !== normalized.id,
  );
  if (normalized.status === 'archived') {
    saveAoiActivePlaybooks(sessionsDir, normalizedSessionPath, active);
    saveAoiArchivedPlaybooks(sessionsDir, normalizedSessionPath, [normalized, ...archived]);
  } else {
    saveAoiActivePlaybooks(sessionsDir, normalizedSessionPath, [normalized, ...active]);
    saveAoiArchivedPlaybooks(sessionsDir, normalizedSessionPath, archived);
  }
  return normalized;
}

export function findAoiPlaybook(
  sessionsDir: string,
  sessionPath: string,
  playbookId: string,
): AoiPlaybook | null {
  if (!isValidAoiAutonomyId(playbookId)) {
    return null;
  }
  return (
    loadAoiActivePlaybooks(sessionsDir, sessionPath).find((item) => item.id === playbookId) ??
    loadAoiArchivedPlaybooks(sessionsDir, sessionPath).find((item) => item.id === playbookId) ??
    null
  );
}
