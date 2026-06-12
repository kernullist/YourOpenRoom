import { evaluateAoiProposalExecution } from './aoiAutonomyPolicy';
import {
  applyAoiProposalExecutionTransition,
  buildAoiAutonomyStatus,
  loadAoiActiveProposals,
  loadAoiAutonomyPolicy,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import { ingestAoiObservation } from './aoiAutonomyObserver';
import {
  readAoiResearchRunArtifact,
  readAoiResearchRunStatus,
  startAoiResearchRunFromServer,
  toAoiResearchRunSummary,
  type AoiResearchServerArtifactResult,
  type AoiResearchServerStartResult,
} from './aoiResearchPlugin';
import {
  recordAoiKiraHandoffRelations,
  recordAoiProcedurePromotionRelations,
  recordAoiResearchFollowupExecutionRelations,
} from './aoiAutonomyRelations';
import { saveServerAoiMemoryCandidates, saveServerAoiMemoryEpisode } from './aoiMemoryServerWriter';
import { sanitizeAoiProcedureContent, type AoiMemoryEntry } from './aoiMemoryShared';
import {
  buildAoiKiraHandoffPreview,
  getAoiKiraSafeNarrowingSuggestion,
  type AoiKiraHandoffCreateResult,
  type AoiKiraHandoffPreview,
} from './aoiKiraHandoff';
import { createSupervisedKiraWorkItem } from './kiraAutomationPlugin';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import type { AoiAutonomyStatus, AoiProposal, AoiProposalDecision } from './aoiAutonomyTypes';
import type { AoiResearchArtifactName, AoiResearchManifest } from './aoiResearchTypes';

const MAX_EXECUTION_TEXT_CHARS = 4000;

export interface AoiProposalExecutionDependencies {
  readResearchStatus?: (
    sessionsDir: string,
    sessionPath: string,
    runId: string,
  ) => AoiResearchManifest;
  readResearchArtifact?: (
    sessionsDir: string,
    sessionPath: string,
    runId: string,
    artifact: AoiResearchArtifactName,
  ) => AoiResearchServerArtifactResult;
  startResearch?: (params: {
    sessionsDir: string;
    configFile: string;
    serverOrigin: string;
    request: {
      sessionPath: string;
      request: string;
      mode: 'quick' | 'standard' | 'deep';
      language?: 'match-user' | 'ko' | 'en';
      recency?: 'any' | 'day' | 'week' | 'month' | 'year';
      maxSources?: number;
    };
    allowDuplicate?: boolean;
  }) => Promise<AoiResearchServerStartResult>;
  createKiraWork?: (params: {
    sessionsDir: string;
    sessionPath: string;
    proposal: AoiProposal;
    preview: AoiKiraHandoffPreview;
    now: number;
  }) => AoiKiraHandoffCreateResult;
}

export interface AoiProposalExecutionResult {
  ok: boolean;
  sessionPath: string;
  proposal: AoiProposal;
  decision: AoiProposalDecision;
  status: AoiAutonomyStatus;
  executed: boolean;
  outcome: 'executed' | 'blocked' | 'failed';
  reasons: string[];
  result?: Record<string, unknown>;
}

export interface AoiProposalPreviewResult {
  ok: boolean;
  sessionPath: string;
  proposal: AoiProposal;
  status: AoiAutonomyStatus;
  previewed: boolean;
  outcome: 'previewed' | 'blocked';
  reasons: string[];
  result?: Record<string, unknown>;
}

function getStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getRunId(params: Record<string, unknown>): string {
  return getStringParam(params, 'runId') || getStringParam(params, 'run_id');
}

function getArtifact(params: Record<string, unknown>): AoiResearchArtifactName | null {
  const artifact = getStringParam(params, 'artifact') || 'report';
  if (
    artifact === 'manifest' ||
    artifact === 'report' ||
    artifact === 'sources' ||
    artifact === 'evidence'
  ) {
    return artifact;
  }
  return null;
}

function compactContent(value: unknown): {
  contentPreview: string;
  contentLength: number;
  truncated: boolean;
} {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const content = raw || '';
  if (content.length <= MAX_EXECUTION_TEXT_CHARS) {
    return {
      contentPreview: content,
      contentLength: content.length,
      truncated: false,
    };
  }
  return {
    contentPreview: `${content.slice(0, MAX_EXECUTION_TEXT_CHARS - 3).trimEnd()}...`,
    contentLength: content.length,
    truncated: true,
  };
}

function normalizeStartMode(value: unknown): 'quick' | 'standard' | 'deep' | null {
  if (value === 'quick' || value === 'standard' || value === 'deep') {
    return value;
  }
  return null;
}

function normalizeLanguage(value: unknown): 'match-user' | 'ko' | 'en' | undefined {
  if (value === 'match-user' || value === 'ko' || value === 'en') {
    return value;
  }
  return undefined;
}

function normalizeRecency(value: unknown): 'any' | 'day' | 'week' | 'month' | 'year' | undefined {
  if (
    value === 'any' ||
    value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'year'
  ) {
    return value;
  }
  return undefined;
}

function normalizeMaxSources(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(40, Math.max(1, Math.trunc(parsed)));
}

function sanitizeEpisodeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'procedure';
}

function normalizePromotionTarget(value: unknown): 'memory' | 'skill' {
  return value === 'skill' ? 'skill' : 'memory';
}

function normalizeStringListParam(...values: unknown[]): string[] {
  const terms: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) {
        continue;
      }
      terms.push(item.trim().slice(0, 48));
      if (terms.length >= 12) {
        return [...new Set(terms)];
      }
    }
  }
  return [...new Set(terms)];
}

function summarizePromotedMemory(memory: AoiMemoryEntry): Record<string, unknown> {
  return {
    id: memory.id,
    type: memory.type,
    status: memory.status,
    content: memory.content,
    confidence: memory.confidence,
    tags: memory.tags,
  };
}

function createDefaultKiraWorkFromPreview(params: {
  sessionsDir: string;
  sessionPath: string;
  proposal: AoiProposal;
  preview: AoiKiraHandoffPreview;
  now: number;
}): AoiKiraHandoffCreateResult {
  const created = createSupervisedKiraWorkItem({
    sessionsDir: params.sessionsDir,
    input: {
      sessionPath: params.sessionPath,
      projectName: params.preview.projectName,
      title: params.preview.title,
      objective: params.preview.objective,
      scope: params.preview.scope,
      likelyFilesOrModules: params.preview.likelyFilesOrModules,
      nonGoals: params.preview.nonGoals,
      validationCommands: params.preview.validationCommands,
      riskLevel: params.preview.riskLevel,
      rollbackExpectations: params.preview.rollbackExpectations,
      reviewExpectations: params.preview.reviewExpectations,
      evidenceRefs: params.preview.evidenceRefs,
      constraints: params.preview.constraints,
      sourceProposalId: params.proposal.id,
      now: params.now,
    },
  });
  return {
    kind: 'create_kira_work',
    preview: params.preview,
    work: {
      id: created.work.id,
      ref: created.workRef,
      title: created.work.title,
      projectName: created.work.projectName,
      status: created.work.status,
    },
    reviewRequired: true,
    route: '/kira',
    openPayload: {
      workId: created.work.id,
      focusType: 'work',
    },
  };
}

function blockProposal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
  reason: string;
  now?: number;
  outcome?: 'blocked' | 'failed';
  result?: Record<string, unknown>;
}): AoiProposalExecutionResult {
  const transition = applyAoiProposalExecutionTransition(params.sessionsDir, params.sessionPath, {
    proposalId: params.proposalId,
    nextStatus: 'blocked',
    actor: 'system',
    reason: params.reason,
    now: params.now,
  });
  return {
    ok: true,
    sessionPath: params.sessionPath,
    proposal: transition.proposal,
    decision: transition.decision,
    status: buildAoiAutonomyStatus(params.sessionsDir, params.sessionPath, params.now),
    executed: false,
    outcome: params.outcome ?? 'blocked',
    reasons: [params.reason],
    ...(params.result ? { result: params.result } : {}),
  };
}

async function executeAllowedProposalAction(params: {
  sessionsDir: string;
  configFile: string;
  serverOrigin: string;
  sessionPath: string;
  proposal: AoiProposal;
  dependencies: AoiProposalExecutionDependencies;
  now: number;
}): Promise<Record<string, unknown>> {
  const action = params.proposal.acceptAction;
  if (!action) {
    throw new Error('Proposal has no accept action.');
  }

  const actionParams = action.params ?? {};
  if (action.kind === 'get_research_status') {
    const runId = getRunId(actionParams);
    if (!runId) {
      throw new Error('runId is required for get_research_status.');
    }
    const run = (params.dependencies.readResearchStatus ?? readAoiResearchRunStatus)(
      params.sessionsDir,
      params.sessionPath,
      runId,
    );
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(run),
    };
  }

  if (action.kind === 'open_research_artifact') {
    const runId = getRunId(actionParams);
    const artifact = getArtifact(actionParams);
    if (!runId || !artifact) {
      throw new Error('runId and artifact are required for open_research_artifact.');
    }
    const run = (params.dependencies.readResearchStatus ?? readAoiResearchRunStatus)(
      params.sessionsDir,
      params.sessionPath,
      runId,
    );
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(run),
      artifact,
      route: '/aoi-research',
      openPayload: {
        runId,
        artifact,
      },
    };
  }

  if (action.kind === 'read_research_artifact') {
    const runId = getRunId(actionParams);
    const artifact = getArtifact(actionParams);
    if (!runId || !artifact) {
      throw new Error('runId and artifact are required for read_research_artifact.');
    }
    const artifactResult = (params.dependencies.readResearchArtifact ?? readAoiResearchRunArtifact)(
      params.sessionsDir,
      params.sessionPath,
      runId,
      artifact,
    );
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(artifactResult.run),
      artifact,
      contentType: artifactResult.contentType,
      ...compactContent(artifactResult.content),
    };
  }

  if (action.kind === 'start_research') {
    const request = getStringParam(actionParams, 'request');
    const mode = normalizeStartMode(actionParams.mode);
    const requestedSessionPath = normalizeAoiAutonomySessionPath(actionParams.sessionPath);
    if (!request || !mode || requestedSessionPath !== params.sessionPath) {
      throw new Error('request, mode, and matching sessionPath are required for start_research.');
    }
    const startResult = await (params.dependencies.startResearch ?? startAoiResearchRunFromServer)({
      sessionsDir: params.sessionsDir,
      configFile: params.configFile,
      serverOrigin: params.serverOrigin,
      request: {
        sessionPath: params.sessionPath,
        request,
        mode,
        language: normalizeLanguage(actionParams.language),
        recency: normalizeRecency(actionParams.recency),
        maxSources: normalizeMaxSources(actionParams.maxSources ?? actionParams.max_sources),
      },
      allowDuplicate: actionParams.allowDuplicate === true || actionParams.allow_duplicate === true,
    });
    return {
      kind: action.kind,
      run: toAoiResearchRunSummary(startResult.run),
      background: startResult.background,
      maxConcurrentRuns: startResult.maxConcurrentRuns,
    };
  }

  if (action.kind === 'save_memory') {
    if (actionParams.type !== 'procedure') {
      throw new Error('Only procedure memory promotion is supported for save_memory proposals.');
    }
    const content = sanitizeAoiProcedureContent(getStringParam(actionParams, 'content'));
    if (content.length < 8) {
      throw new Error('Procedure content was empty after safety filtering.');
    }
    const target = normalizePromotionTarget(actionParams.target);
    const name = getStringParam(actionParams, 'name') || params.proposal.title;
    const description =
      getStringParam(actionParams, 'description') ||
      'User-approved Aoi procedure candidate promoted from an autonomy proposal.';
    const triggerTerms = normalizeStringListParam(
      actionParams.triggerTerms,
      actionParams.trigger_terms,
    );

    if (target === 'skill') {
      return {
        kind: action.kind,
        target,
        skillDraft: {
          name,
          description,
          triggerTerms,
          body: content,
          enabled: true,
          trusted: false,
        },
      };
    }

    const episode = saveServerAoiMemoryEpisode(params.sessionsDir, params.sessionPath, {
      id: `aoi_procedure_${sanitizeEpisodeIdPart(params.proposal.id)}`,
      source: 'manual_memory',
      userMessage: content,
      assistantMessage: params.proposal.title,
      toolCalls: ['save_memory'],
      outcome: 'procedure_promoted',
    });
    const memories = saveServerAoiMemoryCandidates(
      params.sessionsDir,
      params.sessionPath,
      [
        {
          scope: 'agent',
          type: 'procedure',
          content,
          importance: 0.82,
          confidence: 0.78,
          tags: ['procedure', 'aoi-autonomy', 'approved'],
          entities: [name, ...triggerTerms],
        },
      ],
      episode.id,
    );
    const promoted = memories.filter(
      (memory) => memory.type === 'procedure' && memory.sourceEpisodeIds.includes(episode.id),
    );
    return {
      kind: action.kind,
      target,
      episodeId: episode.id,
      memories: promoted.map(summarizePromotedMemory),
    };
  }

  if (action.kind === 'create_kira_work') {
    const preview = buildAoiKiraHandoffPreview(params.proposal, { now: params.now });
    const createKiraWork = params.dependencies.createKiraWork ?? createDefaultKiraWorkFromPreview;
    return createKiraWork({
      sessionsDir: params.sessionsDir,
      sessionPath: params.sessionPath,
      proposal: params.proposal,
      preview,
      now: params.now,
    }) as unknown as Record<string, unknown>;
  }

  throw new Error(`Unsupported proposal action kind: ${action.kind}`);
}

function findActiveProposalOrThrow(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
}): AoiProposal {
  const proposals = loadAoiActiveProposals(params.sessionsDir, params.sessionPath);
  const proposal = proposals.find((item) => item.id === params.proposalId);
  if (!proposal) {
    throw new Error('Aoi proposal not found.');
  }
  return proposal;
}

export function previewAoiProposal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
  now?: number;
}): AoiProposalPreviewResult {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const proposal = findActiveProposalOrThrow({
    sessionsDir: params.sessionsDir,
    sessionPath,
    proposalId: params.proposalId,
  });
  const policy = loadAoiAutonomyPolicy(params.sessionsDir, sessionPath);
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const evaluation = evaluateAoiProposalExecution(proposal, policy, {
    now,
    decisions,
    executionMode: 'preview',
  });
  if (!evaluation.allowed) {
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'kira_handoff_policy_blocked',
        message: `Kira handoff preview blocked: ${evaluation.reasons.join(', ')}.`,
        goalSummary: `Aoi Kira handoff: ${proposal.title}`,
        toolNames: ['create_kira_work'],
        status: 'failed',
        now,
      });
    }
    return {
      ok: true,
      sessionPath,
      proposal,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
      previewed: false,
      outcome: 'blocked',
      reasons: evaluation.reasons,
      result: {
        safeAlternative:
          evaluation.safeAlternative ??
          (proposal.acceptAction?.kind === 'create_kira_work'
            ? getAoiKiraSafeNarrowingSuggestion()
            : undefined),
      },
    };
  }
  if (proposal.acceptAction?.kind !== 'create_kira_work') {
    return {
      ok: true,
      sessionPath,
      proposal,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
      previewed: false,
      outcome: 'blocked',
      reasons: ['preview_not_supported_for_action'],
    };
  }

  const preview = buildAoiKiraHandoffPreview(proposal, { now });
  recordServerAoiRunLedgerEvent({
    sessionsDir: params.sessionsDir,
    sessionPath,
    type: 'kira_handoff_preview_created',
    message: `Kira handoff preview created for proposal ${proposal.id}.`,
    goalSummary: `Aoi Kira handoff: ${proposal.title}`,
    toolNames: ['create_kira_work'],
    now,
  });
  return {
    ok: true,
    sessionPath,
    proposal,
    status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
    previewed: true,
    outcome: 'previewed',
    reasons: [],
    result: {
      preview: preview as unknown as Record<string, unknown>,
    },
  };
}

export async function executeAoiProposal(params: {
  sessionsDir: string;
  configFile: string;
  serverOrigin: string;
  sessionPath: string;
  proposalId: string;
  decisionId?: string;
  now?: number;
  dependencies?: AoiProposalExecutionDependencies;
}): Promise<AoiProposalExecutionResult> {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = params.now ?? Date.now();
  const proposal = findActiveProposalOrThrow({
    sessionsDir: params.sessionsDir,
    sessionPath,
    proposalId: params.proposalId,
  });

  const policy = loadAoiAutonomyPolicy(params.sessionsDir, sessionPath);
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const evaluation = evaluateAoiProposalExecution(proposal, policy, {
    now,
    decisions,
    decisionId: params.decisionId,
  });
  if (!evaluation.allowed) {
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'kira_handoff_policy_blocked',
        message: `Kira handoff execution blocked: ${evaluation.reasons.join(', ')}.`,
        goalSummary: `Aoi Kira handoff: ${proposal.title}`,
        toolNames: ['create_kira_work'],
        status: 'failed',
        now,
      });
    }
    return blockProposal({
      sessionsDir: params.sessionsDir,
      sessionPath,
      proposalId: proposal.id,
      reason: evaluation.reasons.join(', '),
      now,
      outcome: 'blocked',
      ...(evaluation.safeAlternative
        ? {
            result: {
              safeAlternative: evaluation.safeAlternative,
            },
          }
        : {}),
    });
  }

  try {
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      recordServerAoiRunLedgerEvent({
        sessionsDir: params.sessionsDir,
        sessionPath,
        type: 'kira_handoff_execution_approved',
        message: `Kira handoff execution approved for proposal ${proposal.id}.`,
        goalSummary: `Aoi Kira handoff: ${proposal.title}`,
        toolNames: ['create_kira_work'],
        now,
      });
    }
    const result = await executeAllowedProposalAction({
      sessionsDir: params.sessionsDir,
      configFile: params.configFile,
      serverOrigin: params.serverOrigin,
      sessionPath,
      proposal,
      dependencies: params.dependencies ?? {},
      now,
    });
    const transition = applyAoiProposalExecutionTransition(params.sessionsDir, sessionPath, {
      proposalId: proposal.id,
      nextStatus: 'executed',
      actor: 'system',
      reason: `Executed ${proposal.acceptAction?.kind ?? 'proposal action'}.`,
      now,
    });
    if (proposal.acceptAction?.kind === 'start_research') {
      const run = result.run as { id?: unknown } | undefined;
      if (typeof run?.id === 'string') {
        recordAoiResearchFollowupExecutionRelations({
          sessionsDir: params.sessionsDir,
          sessionPath,
          proposal,
          runId: run.id,
          priorRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
          now,
        });
      }
    }
    if (proposal.acceptAction?.kind === 'save_memory') {
      const memories = Array.isArray(result.memories) ? result.memories : [];
      const targetMemory = memories.find(
        (memory): memory is { id: string } =>
          Boolean(memory) &&
          typeof memory === 'object' &&
          typeof (memory as { id?: unknown }).id === 'string',
      );
      recordAoiProcedurePromotionRelations({
        sessionsDir: params.sessionsDir,
        sessionPath,
        procedureId: proposal.id,
        targetRef: targetMemory ? `memory:${targetMemory.id}` : `procedure:${proposal.id}:skill`,
        sourceRefs: [
          `proposal:${proposal.id}`,
          `decision:${transition.decision.id}`,
          ...proposal.evidenceRefs,
          ...proposal.artifactRefs,
        ],
        decisionId: transition.decision.id,
        now,
      });
      try {
        ingestAoiObservation(
          params.sessionsDir,
          {
            source: 'proposal',
            sessionPath,
            stableKey: `procedure-promotion:${proposal.id}:${transition.decision.id}`,
            createdAt: now,
            summary: `Procedure promotion executed from proposal "${proposal.title}".`,
            payloadRef: `decision:${transition.decision.id}`,
            memoryIds: targetMemory ? [targetMemory.id] : [],
            artifactRefs: [
              `procedure:${proposal.id}`,
              targetMemory ? `memory:${targetMemory.id}` : `procedure:${proposal.id}:skill`,
              `decision:${transition.decision.id}`,
            ],
            proposalIds: [proposal.id],
            riskSignals: [...proposal.riskSignals, 'procedure-promoted'],
          },
          { now },
        );
      } catch (error) {
        console.warn(
          '[AoiAutonomyExecution] Failed to ingest procedure promotion observation',
          error,
        );
      }
    }
    if (proposal.acceptAction?.kind === 'create_kira_work') {
      const work = result.work as
        | { id?: unknown; ref?: unknown; title?: unknown; projectName?: unknown; status?: unknown }
        | undefined;
      const preview = result.preview as { evidenceRefs?: unknown } | undefined;
      const workRef = typeof work?.ref === 'string' ? work.ref : undefined;
      const workTitle = typeof work?.title === 'string' ? work.title : proposal.title;
      const evidenceRefs = Array.isArray(preview?.evidenceRefs)
        ? preview.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
        : [...proposal.evidenceRefs, ...proposal.artifactRefs];
      if (workRef) {
        recordAoiKiraHandoffRelations({
          sessionsDir: params.sessionsDir,
          sessionPath,
          proposal,
          workRef,
          workTitle,
          decisionId: transition.decision.id,
          evidenceRefs,
          goalRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs].filter(
            (ref) => ref.startsWith('goal:') || ref.startsWith('plan-step:'),
          ),
          now,
        });
        recordServerAoiRunLedgerEvent({
          sessionsDir: params.sessionsDir,
          sessionPath,
          type: 'kira_work_item_created',
          message: `Kira work item ${workRef} created from proposal ${proposal.id}.`,
          goalSummary: `Aoi Kira handoff: ${proposal.title}`,
          toolNames: ['create_kira_work'],
          now,
        });
        try {
          ingestAoiObservation(
            params.sessionsDir,
            {
              source: 'proposal',
              sessionPath,
              stableKey: `kira-handoff:${proposal.id}:${workRef}`,
              createdAt: now,
              summary: `Kira work item created from Aoi proposal "${proposal.title}".`,
              payloadRef: workRef,
              memoryIds: [],
              artifactRefs: [workRef, `decision:${transition.decision.id}`, ...evidenceRefs],
              proposalIds: [proposal.id],
              riskSignals: [...proposal.riskSignals, 'kira-handoff-created'],
            },
            { now },
          );
        } catch (error) {
          console.warn('[AoiAutonomyExecution] Failed to ingest Kira handoff observation', error);
        }
      }
    }
    return {
      ok: true,
      sessionPath,
      proposal: transition.proposal,
      decision: transition.decision,
      status: buildAoiAutonomyStatus(params.sessionsDir, sessionPath, now),
      executed: true,
      outcome: 'executed',
      reasons: [],
      result,
    };
  } catch (error) {
    return blockProposal({
      sessionsDir: params.sessionsDir,
      sessionPath,
      proposalId: proposal.id,
      reason: `execution_failed:${error instanceof Error ? error.message : String(error)}`,
      now,
      outcome: 'failed',
    });
  }
}
