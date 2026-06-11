import { evaluateAoiProposalExecution } from './aoiAutonomyPolicy';
import {
  applyAoiProposalExecutionTransition,
  buildAoiAutonomyStatus,
  loadAoiActiveProposals,
  loadAoiAutonomyPolicy,
  loadAoiProposalDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import {
  readAoiResearchRunArtifact,
  readAoiResearchRunStatus,
  startAoiResearchRunFromServer,
  toAoiResearchRunSummary,
  type AoiResearchServerArtifactResult,
  type AoiResearchServerStartResult,
} from './aoiResearchPlugin';
import {
  recordAoiProcedurePromotionRelations,
  recordAoiResearchFollowupExecutionRelations,
} from './aoiAutonomyRelations';
import { saveServerAoiMemoryCandidates, saveServerAoiMemoryEpisode } from './aoiMemoryServerWriter';
import { sanitizeAoiProcedureContent, type AoiMemoryEntry } from './aoiMemoryShared';
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

function blockProposal(params: {
  sessionsDir: string;
  sessionPath: string;
  proposalId: string;
  reason: string;
  now?: number;
  outcome?: 'blocked' | 'failed';
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
  };
}

async function executeAllowedProposalAction(params: {
  sessionsDir: string;
  configFile: string;
  serverOrigin: string;
  sessionPath: string;
  proposal: AoiProposal;
  dependencies: AoiProposalExecutionDependencies;
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

  throw new Error(`Unsupported proposal action kind: ${action.kind}`);
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
  const proposals = loadAoiActiveProposals(params.sessionsDir, sessionPath);
  const proposal = proposals.find((item) => item.id === params.proposalId);
  if (!proposal) {
    throw new Error('Aoi proposal not found.');
  }

  const policy = loadAoiAutonomyPolicy(params.sessionsDir, sessionPath);
  const decisions = loadAoiProposalDecisions(params.sessionsDir, sessionPath);
  const evaluation = evaluateAoiProposalExecution(proposal, policy, {
    now,
    decisions,
    decisionId: params.decisionId,
  });
  if (!evaluation.allowed) {
    return blockProposal({
      sessionsDir: params.sessionsDir,
      sessionPath,
      proposalId: proposal.id,
      reason: evaluation.reasons.join(', '),
      now,
      outcome: 'blocked',
    });
  }

  try {
    const result = await executeAllowedProposalAction({
      sessionsDir: params.sessionsDir,
      configFile: params.configFile,
      serverOrigin: params.serverOrigin,
      sessionPath,
      proposal,
      dependencies: params.dependencies ?? {},
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
