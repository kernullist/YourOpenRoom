import type { IncomingMessage, ServerResponse } from 'http';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { executeAoiProposal, previewAoiProposal } from './aoiAutonomyExecution';
import { runAoiAutonomyBackgroundTick } from './aoiAutonomyEngine';
import { buildAoiAutonomyEvaluation } from './aoiAutonomyEvaluation';
import { resetAoiTrustCalibrationCategory } from './aoiTrustCalibrationStore';
import {
  activateAoiGoalFromProposal,
  applyAoiGoalDecision,
  loadAoiActiveGoals,
  loadAoiArchivedGoals,
  loadAoiGoalProgressEvents,
  updateAoiGoalProgressFromObservations,
} from './aoiAutonomyGoals';
import {
  applyAoiProposalFeedback,
  applyAoiProposalDecision,
  buildAoiAutonomyStatus,
  loadAoiEnvironmentSourceRegistry,
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiObservations,
  loadAoiProposalDecisions,
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
  saveAoiAutonomyPolicy,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import { applyAoiMissionDecision, deriveAoiMissionState } from './aoiAutonomyMission';
import {
  collectAndPersistAoiWorkspaceSnapshot,
  loadAoiWorkspaceSnapshot,
  recordAoiValidationSignal,
} from './aoiWorkspaceSignals';
import { recordAoiPlaybookRelations } from './aoiAutonomyRelations';
import {
  buildAoiContextRouterResult,
  recordAoiBrowserContextMetadata,
  recordAoiContextSourceFeedback,
} from './aoiContextRouter';
import {
  buildAoiContextRouterTimelineEvents,
  exportAoiOperatorTrace,
  loadAoiOperatorTimelineEvents,
  loadAoiOperatorTimelineSummary,
  recordAoiOperatorVoiceDecisionTimelineEvent,
  recordAoiOperatorTimelineEvent,
  recordAoiProposalDecisionTimelineEvent,
  recordAoiProposalFeedbackTimelineEvent,
} from './aoiOperatorTimeline';
import {
  isAoiAutonomyWakeupReason,
  loadAoiAutonomySchedulerState,
  runAoiAutonomyWakeup,
} from './aoiAutonomyScheduler';
import { buildAoiOperatorHealthState } from './aoiOperatorHealthServer';
import {
  findAoiPlaybook,
  loadAoiActivePlaybooks,
  loadAoiArchivedPlaybooks,
  prepareAoiPlaybook,
  updateAoiPlaybookFromEvidence,
  upsertAoiPlaybook,
} from './aoiPlaybookOrchestrator';
import type {
  AoiCalibrationDimension,
  AoiAutonomyTickReason,
  AoiAutonomyWakeupBudget,
  AoiGoal,
  AoiOperatorTimelineEventKind,
  AoiPlaybookEvidenceKind,
  AoiPlaybookStepRefs,
  AoiProposal,
  AoiProposalFeedbackCategory,
  AoiVoiceRenderDecision,
} from './aoiAutonomyTypes';
import type { LLMConfig } from './llmModels';

const API_PREFIX = '/api/aoi-autonomy';
const MAX_BODY_BYTES = 128 * 1024;

export interface AoiAutonomyPluginOptions {
  sessionsDir: string;
  configFile: string;
  workspaceRoot?: string;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString() || '{}';
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Request body must be a JSON object.'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function getAoiAutonomyRoute(pathname: string): string | null {
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }
  return pathname.slice(API_PREFIX.length) || '/';
}

function getSessionPathFromUrl(url: URL): string | null {
  return normalizeAoiAutonomySessionPath(url.searchParams.get('sessionPath'));
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

function isAoiOperatorTimelineEventKind(value: unknown): value is AoiOperatorTimelineEventKind {
  return (
    value === 'observation_ingested' ||
    value === 'source_selected' ||
    value === 'source_suppressed' ||
    value === 'proposal_created' ||
    value === 'proposal_blocked' ||
    value === 'proposal_accepted' ||
    value === 'proposal_dismissed' ||
    value === 'proposal_snoozed' ||
    value === 'proposal_executed' ||
    value === 'proposal_failed' ||
    value === 'mission_state_changed' ||
    value === 'goal_state_changed' ||
    value === 'digest_item_surfaced' ||
    value === 'digest_item_hidden' ||
    value === 'approved_command_previewed' ||
    value === 'approved_command_recorded' ||
    value === 'feedback_recorded' ||
    value === 'operator_voice_decision' ||
    value === 'wakeup_recorded' ||
    value === 'trace_exported'
  );
}

function isAoiCalibrationDimension(value: unknown): value is AoiCalibrationDimension {
  return (
    value === 'source_kind' ||
    value === 'trigger_kind' ||
    value === 'action_kind' ||
    value === 'risk_level' ||
    value === 'notification_lane' ||
    value === 'voice_category' ||
    value === 'interruption_gap' ||
    value === 'feedback_category'
  );
}

function isAoiPlaybookEvidenceKind(value: unknown): value is AoiPlaybookEvidenceKind {
  return (
    value === 'inspect_context_completed' ||
    value === 'read_research_artifact_completed' ||
    value === 'research_completed' ||
    value === 'kira_work_created' ||
    value === 'kira_work_completed' ||
    value === 'approved_command_recorded' ||
    value === 'summarize_result_completed' ||
    value === 'user_decision_recorded' ||
    value === 'step_failed'
  );
}

function getWakeupBudgetFromBody(value: unknown): Partial<AoiAutonomyWakeupBudget> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Partial<AoiAutonomyWakeupBudget>;
}

function getHeaderString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function getRequestOrigin(req: IncomingMessage): string {
  const forwardedProto = getHeaderString(req.headers['x-forwarded-proto']).trim();
  const host = getHeaderString(req.headers.host).trim() || '127.0.0.1:3000';
  return `${forwardedProto || 'http'}://${host}`;
}

function recordAoiTimelineBestEffort(record: () => void): void {
  try {
    record();
  } catch (error) {
    console.warn('[AoiAutonomyPlugin] Failed to record Aoi timeline event', error);
  }
}

function recordAoiPlaybookRelationsBestEffort(params: {
  sessionsDir: string;
  sessionPath: string;
  playbook: Parameters<typeof recordAoiPlaybookRelations>[0]['playbook'];
}): void {
  try {
    recordAoiPlaybookRelations(params);
  } catch (error) {
    console.warn('[AoiAutonomyPlugin] Failed to record Aoi playbook relations', error);
  }
}

function idFromRef(ref: string | undefined, prefix: string): string | undefined {
  if (!ref?.startsWith(prefix)) {
    return undefined;
  }
  return ref.slice(prefix.length);
}

function findProposalForPlaybook(
  sessionsDir: string,
  sessionPath: string,
  proposalId: unknown,
): AoiProposal | null {
  const id = typeof proposalId === 'string' ? proposalId.trim() : '';
  if (!id) {
    return null;
  }
  return (
    [
      ...loadAoiActiveProposals(sessionsDir, sessionPath),
      ...loadAoiArchivedProposals(sessionsDir, sessionPath),
    ].find((proposal) => proposal.id === id) ?? null
  );
}

function findGoalForPlaybook(
  sessionsDir: string,
  sessionPath: string,
  goalId: unknown,
): AoiGoal | null {
  const id = typeof goalId === 'string' ? goalId.trim() : '';
  if (!id) {
    return null;
  }
  return (
    [
      ...loadAoiActiveGoals(sessionsDir, sessionPath),
      ...loadAoiArchivedGoals(sessionsDir, sessionPath),
    ].find((goal) => goal.id === id) ?? null
  );
}

async function handleAoiAutonomyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
  configFile: string,
  workspaceRoot: string,
): Promise<boolean> {
  const route = getAoiAutonomyRoute(url.pathname);
  if (route === null) {
    return false;
  }

  try {
    if (req.method === 'GET' && route === '/status') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/proposals') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActiveProposals(sessionsDir, sessionPath),
        archived: includeArchived ? loadAoiArchivedProposals(sessionsDir, sessionPath) : [],
      });
      return true;
    }

    if (req.method === 'GET' && route === '/decisions') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        decisions: loadAoiProposalDecisions(sessionsDir, sessionPath).slice(
          0,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
        ),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/reflections') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        reflections: loadAoiReflections(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/observations') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        observations: loadAoiObservations(sessionsDir, sessionPath).slice(
          0,
          Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
        ),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/timeline') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        events: loadAoiOperatorTimelineEvents(sessionsDir, sessionPath, {
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
        }),
        summary: loadAoiOperatorTimelineSummary(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/scheduler') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        state: loadAoiAutonomySchedulerState(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/health') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        health: buildAoiOperatorHealthState({
          sessionsDir,
          sessionPath,
          configFile,
        }),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/playbooks') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActivePlaybooks(sessionsDir, sessionPath),
        archived: includeArchived ? loadAoiArchivedPlaybooks(sessionsDir, sessionPath) : [],
      });
      return true;
    }

    if (req.method === 'POST' && route === '/playbooks/prepare') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const mission = deriveAoiMissionState({ sessionsDir, sessionPath });
      const proposal =
        findProposalForPlaybook(sessionsDir, sessionPath, body.proposalId) ??
        findProposalForPlaybook(
          sessionsDir,
          sessionPath,
          idFromRef(mission.sourceRefs.proposalRef, 'proposal:'),
        );
      const goal =
        findGoalForPlaybook(sessionsDir, sessionPath, body.goalId) ??
        findGoalForPlaybook(sessionsDir, sessionPath, mission.activeGoalId);
      const health = buildAoiOperatorHealthState({
        sessionsDir,
        sessionPath,
        configFile,
      });
      const playbook = upsertAoiPlaybook(
        sessionsDir,
        sessionPath,
        prepareAoiPlaybook({
          sessionPath,
          proposal,
          activeGoal: goal,
          mission,
          health,
          title: typeof body.title === 'string' ? body.title : undefined,
          objective: typeof body.objective === 'string' ? body.objective : undefined,
        }),
      );
      recordAoiPlaybookRelationsBestEffort({
        sessionsDir,
        sessionPath,
        playbook,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        playbook,
        active: loadAoiActivePlaybooks(sessionsDir, sessionPath),
        archived: loadAoiArchivedPlaybooks(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/playbooks/update') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const playbookId = typeof body.playbookId === 'string' ? body.playbookId.trim() : '';
      const playbook = findAoiPlaybook(sessionsDir, sessionPath, playbookId);
      if (!playbook) {
        writeJson(res, 404, {
          error: 'Aoi playbook was not found.',
          code: 'playbook_not_found',
        });
        return true;
      }
      if (!isAoiPlaybookEvidenceKind(body.kind)) {
        writeJson(res, 400, {
          error: 'Invalid playbook evidence kind.',
          code: 'invalid_playbook_evidence_kind',
        });
        return true;
      }
      const updated = upsertAoiPlaybook(
        sessionsDir,
        sessionPath,
        updateAoiPlaybookFromEvidence({
          playbook,
          kind: body.kind,
          stepId: typeof body.stepId === 'string' ? body.stepId : undefined,
          resultSummary: typeof body.resultSummary === 'string' ? body.resultSummary : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
          refs:
            body.refs && typeof body.refs === 'object' && !Array.isArray(body.refs)
              ? (body.refs as Partial<AoiPlaybookStepRefs>)
              : undefined,
          failedReason: typeof body.failedReason === 'string' ? body.failedReason : undefined,
        }),
      );
      recordAoiPlaybookRelationsBestEffort({
        sessionsDir,
        sessionPath,
        playbook: updated,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        playbook: updated,
        active: loadAoiActivePlaybooks(sessionsDir, sessionPath),
        archived: loadAoiArchivedPlaybooks(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/goals') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: loadAoiActiveGoals(sessionsDir, sessionPath),
        archived: loadAoiArchivedGoals(sessionsDir, sessionPath),
        progress: loadAoiGoalProgressEvents(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/evaluation') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/calibration/reset') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiCalibrationDimension(body.dimension)) {
        writeJson(res, 400, {
          error: 'Invalid calibration dimension.',
          code: 'invalid_calibration_dimension',
        });
        return true;
      }
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) {
        writeJson(res, 400, {
          error: 'Calibration key is required.',
          code: 'invalid_calibration_key',
        });
        return true;
      }
      const reset = resetAoiTrustCalibrationCategory({
        sessionsDir,
        sessionPath,
        dimension: body.dimension,
        key,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        reset,
        evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/mission') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        mission: deriveAoiMissionState({ sessionsDir, sessionPath }),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/sources') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        registry: loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/workspace') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const collect = url.searchParams.get('collect') !== 'false';
      const snapshot = collect
        ? collectAndPersistAoiWorkspaceSnapshot({
            sessionsDir,
            sessionPath,
            workspaceRoot,
          })
        : loadAoiWorkspaceSnapshot(sessionsDir, sessionPath);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        snapshot,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/context') {
      const sessionPath = getSessionPathFromUrl(url);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const latestUserMessage = url.searchParams.get('latestUserMessage') || '';
      const context = buildAoiContextRouterResult({
        sessionsDir,
        sessionPath,
        configFile,
        latestUserMessage,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        context,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/wakeup') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiAutonomyWakeupReason(body.reason)) {
        writeJson(res, 400, {
          error:
            'reason must be one of session_open, user_return_idle, manual_refresh, source_ttl_expired, mission_waiting_too_long, kira_event, research_event, health_check',
          code: 'invalid_wakeup_reason',
        });
        return true;
      }
      const llmConfig =
        body.llmConfig && typeof body.llmConfig === 'object' && !Array.isArray(body.llmConfig)
          ? (body.llmConfig as LLMConfig)
          : undefined;
      const result = await runAoiAutonomyWakeup({
        sessionsDir,
        sessionPath,
        reason: body.reason,
        workspaceRoot,
        latestUserMessage:
          typeof body.latestUserMessage === 'string' ? body.latestUserMessage : undefined,
        llmConfig,
        sourceIds: Array.isArray(body.sourceIds)
          ? body.sourceIds.filter((item): item is string => typeof item === 'string')
          : undefined,
        budget: getWakeupBudgetFromBody(body.budget),
        quietMode: typeof body.quietMode === 'boolean' ? body.quietMode : undefined,
        userIdleMs: typeof body.userIdleMs === 'number' ? body.userIdleMs : undefined,
      });
      writeJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && route === '/timeline/export') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const limit = typeof body.limit === 'number' ? body.limit : undefined;
      const eventKinds = Array.isArray(body.eventKinds)
        ? body.eventKinds.filter(isAoiOperatorTimelineEventKind)
        : undefined;
      const traceExport = exportAoiOperatorTrace(sessionsDir, sessionPath, {
        limit,
        eventKinds,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        traceExport,
        summary: loadAoiOperatorTimelineSummary(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/voice/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!body.decision || typeof body.decision !== 'object' || Array.isArray(body.decision)) {
        writeJson(res, 400, {
          error: 'Invalid or missing voice decision.',
          code: 'invalid_voice_decision',
        });
        return true;
      }
      const decision = {
        ...(body.decision as AoiVoiceRenderDecision),
        sessionPath,
      };
      const event = recordAoiOperatorVoiceDecisionTimelineEvent({
        sessionsDir,
        sessionPath,
        decision,
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        event,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/policy') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const policy = saveAoiAutonomyPolicy(sessionsDir, sessionPath, body.policy ?? body);
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        policy,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/sources') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
      const patch =
        body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
          ? body.patch
          : {};
      try {
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          registry: updateAoiEnvironmentSource(sessionsDir, sessionPath, {
            sourceId,
            patch,
          }),
          status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'source_not_found' : 'invalid_source_update',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/context/browser') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const urlValue = typeof body.url === 'string' ? body.url : '';
      if (!urlValue.trim()) {
        writeJson(res, 400, {
          error: 'url is required.',
          code: 'invalid_browser_context',
        });
        return true;
      }
      const context = recordAoiBrowserContextMetadata({
        sessionsDir,
        sessionPath,
        pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle : 'Untitled page',
        url: urlValue,
        purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
        capturedAt: typeof body.capturedAt === 'number' ? body.capturedAt : undefined,
      });
      const routerContext = buildAoiContextRouterResult({
        sessionsDir,
        sessionPath,
        configFile,
      });
      recordAoiTimelineBestEffort(() => {
        for (const event of buildAoiContextRouterTimelineEvents(routerContext)) {
          recordAoiOperatorTimelineEvent(sessionsDir, event);
        }
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        browserContext: context,
        context: routerContext,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/context/feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const feedback = recordAoiContextSourceFeedback({
          sessionsDir,
          sessionPath,
          sourceId: typeof body.sourceId === 'string' ? body.sourceId : '',
          contextSummaryId:
            typeof body.contextSummaryId === 'string' ? body.contextSummaryId : undefined,
          feedbackCategory: body.feedbackCategory as AoiProposalFeedbackCategory,
          feedbackNote: typeof body.feedbackNote === 'string' ? body.feedbackNote : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
        });
        const routerContext = buildAoiContextRouterResult({
          sessionsDir,
          sessionPath,
          configFile,
        });
        recordAoiTimelineBestEffort(() => {
          recordAoiOperatorTimelineEvent(sessionsDir, {
            sessionPath,
            kind: 'feedback_recorded',
            visibility: 'operator_visible',
            createdAt: feedback.createdAt,
            title: 'Context source feedback recorded',
            summary: `Feedback category ${feedback.feedbackCategory} recorded for source ${feedback.sourceId}.`,
            sourceRef: feedback.contextSummaryId
              ? `context-source:${feedback.contextSummaryId}`
              : `environment-source:${feedback.sourceId}`,
            sourceKind: feedback.sourceId,
            evidenceRefs: feedback.evidenceRefs,
            relatedRefs: [
              `environment-source:${feedback.sourceId}`,
              ...(feedback.contextSummaryId ? [`context-source:${feedback.contextSummaryId}`] : []),
            ],
            metadata: {
              feedbackCategory: feedback.feedbackCategory,
            },
          });
          for (const event of buildAoiContextRouterTimelineEvents(routerContext)) {
            recordAoiOperatorTimelineEvent(sessionsDir, event);
          }
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          feedback,
          context: routerContext,
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_context_feedback',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/workspace/validation') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const result = body.result;
      if (result !== 'unknown' && result !== 'passed' && result !== 'failed') {
        writeJson(res, 400, {
          error: 'result must be one of unknown, passed, failed',
          code: 'invalid_validation_result',
        });
        return true;
      }
      const snapshot = recordAoiValidationSignal({
        sessionsDir,
        sessionPath,
        signal: {
          result,
          command: typeof body.command === 'string' ? body.command : undefined,
          completedAt: typeof body.completedAt === 'number' ? body.completedAt : Date.now(),
          touchedFileScopes: Array.isArray(body.touchedFileScopes)
            ? body.touchedFileScopes.filter((item): item is string => typeof item === 'string')
            : [],
        },
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        snapshot,
        status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/mission/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const action = body.action;
      if (
        action !== 'pause' &&
        action !== 'resume' &&
        action !== 'clear' &&
        action !== 'complete' &&
        action !== 'block'
      ) {
        writeJson(res, 400, {
          error: 'action must be one of pause, resume, clear, complete, block',
          code: 'invalid_mission_decision_action',
        });
        return true;
      }
      try {
        const mission = applyAoiMissionDecision(sessionsDir, sessionPath, {
          action,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          mission,
          status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
        });
      } catch (error) {
        writeJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
          code: 'blocked_mission_transition',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/tick') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      if (!isAoiAutonomyTickReason(body.reason)) {
        writeJson(res, 400, {
          error:
            'reason must be one of manual, turn, periodic, research_run, kira, proposal, memory, app',
          code: 'invalid_tick_reason',
        });
        return true;
      }
      const llmConfig =
        body.llmConfig && typeof body.llmConfig === 'object' && !Array.isArray(body.llmConfig)
          ? (body.llmConfig as LLMConfig)
          : undefined;
      const result = await runAoiAutonomyBackgroundTick({
        sessionsDir,
        sessionPath,
        reason: body.reason,
        latestUserMessage:
          typeof body.latestUserMessage === 'string' ? body.latestUserMessage : undefined,
        llmConfig,
        maxRuntimeMs: typeof body.maxRuntimeMs === 'number' ? body.maxRuntimeMs : undefined,
        quietMode: typeof body.quietMode === 'boolean' ? body.quietMode : undefined,
        userIdleMs: typeof body.userIdleMs === 'number' ? body.userIdleMs : undefined,
        workspaceRoot,
      });
      writeJson(res, 200, result);
      return true;
    }

    if (req.method === 'POST' && route === '/goal/check') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const result = updateAoiGoalProgressFromObservations({
        sessionsDir,
        sessionPath,
        observations: loadAoiObservations(sessionsDir, sessionPath),
        activeProposals: loadAoiActiveProposals(sessionsDir, sessionPath),
      });
      writeJson(res, 200, {
        ok: true,
        sessionPath,
        active: result.activeGoals,
        archived: result.archivedGoals,
        progress: result.events,
        status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
      });
      return true;
    }

    if (req.method === 'POST' && route === '/goal/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const action = body.action;
      try {
        if (action === 'accept') {
          const result = applyAoiProposalDecision(sessionsDir, sessionPath, {
            proposalId: String(body.proposalId ?? ''),
            action: 'accept',
            actor: 'user',
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          });
          const goal = activateAoiGoalFromProposal({
            sessionsDir,
            sessionPath,
            proposal: result.proposal,
          });
          recordAoiTimelineBestEffort(() => {
            recordAoiProposalDecisionTimelineEvent({
              sessionsDir,
              proposal: result.proposal,
              decision: result.decision,
            });
          });
          writeJson(res, 200, {
            ok: true,
            sessionPath,
            proposal: result.proposal,
            decision: result.decision,
            goal,
            active: loadAoiActiveGoals(sessionsDir, sessionPath),
            archived: loadAoiArchivedGoals(sessionsDir, sessionPath),
          });
          return true;
        }
        if (
          action !== 'pause' &&
          action !== 'resume' &&
          action !== 'abandon' &&
          action !== 'complete' &&
          action !== 'block'
        ) {
          writeJson(res, 400, {
            error: 'action must be one of accept, pause, resume, abandon, complete, block',
            code: 'invalid_goal_decision_action',
          });
          return true;
        }
        const goal = applyAoiGoalDecision(sessionsDir, sessionPath, {
          goalId: String(body.goalId ?? ''),
          action,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          evidenceRefs: Array.isArray(body.evidenceRefs)
            ? body.evidenceRefs.filter((item): item is string => typeof item === 'string')
            : undefined,
          userConfirmed: body.userConfirmed === true,
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          goal,
          active: loadAoiActiveGoals(sessionsDir, sessionPath),
          archived: loadAoiArchivedGoals(sessionsDir, sessionPath),
          status: buildAoiAutonomyStatus(sessionsDir, sessionPath),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'goal_not_found' : 'blocked_goal_transition',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/decision') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      const action = body.action;
      if (action !== 'accept' && action !== 'dismiss' && action !== 'snooze') {
        writeJson(res, 400, {
          error: 'action must be one of accept, dismiss, snooze',
          code: 'invalid_decision_action',
        });
        return true;
      }
      try {
        const result = applyAoiProposalDecision(sessionsDir, sessionPath, {
          proposalId: String(body.proposalId ?? ''),
          action,
          actor: body.actor === 'system' ? 'system' : 'user',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          feedbackCategory: body.feedbackCategory,
          feedbackNote: body.feedbackNote,
          snoozeMs: typeof body.snoozeMs === 'number' ? body.snoozeMs : undefined,
        });
        const goal =
          action === 'accept'
            ? activateAoiGoalFromProposal({
                sessionsDir,
                sessionPath,
                proposal: result.proposal,
              })
            : null;
        recordAoiTimelineBestEffort(() => {
          recordAoiProposalDecisionTimelineEvent({
            sessionsDir,
            proposal: result.proposal,
            decision: result.decision,
          });
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          proposal: result.proposal,
          decision: result.decision,
          goal,
          active: result.activeProposals,
          archived: result.archivedProposals,
          executed: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'proposal_not_found' : 'blocked_transition',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/feedback') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const decision = applyAoiProposalFeedback(sessionsDir, sessionPath, {
          decisionId: String(body.decisionId ?? ''),
          feedbackCategory: body.feedbackCategory,
          feedbackNote: body.feedbackNote,
        });
        recordAoiTimelineBestEffort(() => {
          recordAoiProposalFeedbackTimelineEvent({
            sessionsDir,
            decision,
          });
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          decision,
          evaluation: buildAoiAutonomyEvaluation({ sessionsDir, sessionPath }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          error: message,
          code: statusCode === 404 ? 'decision_not_found' : 'invalid_feedback',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/preview') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const result = previewAoiProposal({
          sessionsDir,
          sessionPath,
          proposalId: String(body.proposalId ?? ''),
        });
        writeJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          ok: false,
          error: message,
          code: statusCode === 404 ? 'proposal_not_found' : 'preview_failed',
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/proposal/execute') {
      const body = await readJsonBody(req);
      const sessionPath = normalizeAoiAutonomySessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, {
          error: 'Invalid or missing sessionPath.',
          code: 'invalid_session_path',
        });
        return true;
      }
      try {
        const result = await executeAoiProposal({
          sessionsDir,
          configFile,
          serverOrigin: getRequestOrigin(req),
          workspaceRoot,
          sessionPath,
          proposalId: String(body.proposalId ?? ''),
          decisionId: typeof body.decisionId === 'string' ? body.decisionId : undefined,
        });
        writeJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('not found') ? 404 : 400;
        writeJson(res, statusCode, {
          ok: false,
          error: message,
          code: statusCode === 404 ? 'proposal_not_found' : 'execution_failed',
        });
      }
      return true;
    }

    writeJson(res, 404, { error: 'Unknown Aoi autonomy route.', code: 'unknown_route' });
    return true;
  } catch (error) {
    writeJson(res, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof SyntaxError ? 'invalid_json' : 'internal_error',
    });
    return true;
  }
}

export function aoiAutonomyPlugin(options: AoiAutonomyPluginOptions): Plugin {
  const sessionsDir = resolve(options.sessionsDir);
  const configFile = resolve(options.configFile);
  const workspaceRoot = resolve(options.workspaceRoot || process.cwd());

  const mount = (middlewares: {
    use: (
      middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
    ) => void;
  }): void => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');
      void handleAoiAutonomyRequest(req, res, url, sessionsDir, configFile, workspaceRoot)
        .then((handled) => {
          if (!handled) {
            next();
          }
        })
        .catch((error) => {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
    });
  };

  return {
    name: 'aoi-autonomy',
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
