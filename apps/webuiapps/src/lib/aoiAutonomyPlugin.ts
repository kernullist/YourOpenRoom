import type { IncomingMessage, ServerResponse } from 'http';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { executeAoiProposal, previewAoiProposal } from './aoiAutonomyExecution';
import { runAoiAutonomyBackgroundTick } from './aoiAutonomyEngine';
import { buildAoiAutonomyEvaluation } from './aoiAutonomyEvaluation';
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
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
  saveAoiAutonomyPolicy,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import { applyAoiMissionDecision, deriveAoiMissionState } from './aoiAutonomyMission';
import type { AoiAutonomyTickReason } from './aoiAutonomyTypes';
import type { LLMConfig } from './llmModels';

const API_PREFIX = '/api/aoi-autonomy';
const MAX_BODY_BYTES = 128 * 1024;

export interface AoiAutonomyPluginOptions {
  sessionsDir: string;
  configFile: string;
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

function getHeaderString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function getRequestOrigin(req: IncomingMessage): string {
  const forwardedProto = getHeaderString(req.headers['x-forwarded-proto']).trim();
  const host = getHeaderString(req.headers.host).trim() || '127.0.0.1:3000';
  return `${forwardedProto || 'http'}://${host}`;
}

async function handleAoiAutonomyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
  configFile: string,
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

  const mount = (middlewares: {
    use: (
      middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
    ) => void;
  }): void => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');
      void handleAoiAutonomyRequest(req, res, url, sessionsDir, configFile)
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
