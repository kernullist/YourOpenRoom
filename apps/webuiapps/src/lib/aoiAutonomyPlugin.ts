import type { IncomingMessage, ServerResponse } from 'http';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import { runAoiAutonomyTick } from './aoiAutonomyEngine';
import {
  applyAoiProposalDecision,
  buildAoiAutonomyStatus,
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
  saveAoiAutonomyPolicy,
} from './aoiAutonomyStore';
import type { AoiAutonomyTickReason } from './aoiAutonomyTypes';
import type { LLMConfig } from './llmModels';

const API_PREFIX = '/api/aoi-autonomy';
const MAX_BODY_BYTES = 128 * 1024;

export interface AoiAutonomyPluginOptions {
  sessionsDir: string;
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
    value === 'kira'
  );
}

async function handleAoiAutonomyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
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
          error: 'reason must be one of manual, turn, periodic, research_run, kira',
          code: 'invalid_tick_reason',
        });
        return true;
      }
      const llmConfig =
        body.llmConfig && typeof body.llmConfig === 'object' && !Array.isArray(body.llmConfig)
          ? (body.llmConfig as LLMConfig)
          : undefined;
      const result = await runAoiAutonomyTick({
        sessionsDir,
        sessionPath,
        reason: body.reason,
        latestUserMessage:
          typeof body.latestUserMessage === 'string' ? body.latestUserMessage : undefined,
        llmConfig,
      });
      writeJson(res, 200, result);
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
          snoozeMs: typeof body.snoozeMs === 'number' ? body.snoozeMs : undefined,
        });
        writeJson(res, 200, {
          ok: true,
          sessionPath,
          proposal: result.proposal,
          decision: result.decision,
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

  const mount = (middlewares: {
    use: (
      middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
    ) => void;
  }): void => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');
      void handleAoiAutonomyRequest(req, res, url, sessionsDir)
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
