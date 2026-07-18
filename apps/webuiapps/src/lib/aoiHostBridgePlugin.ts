// Aoi host-bridge daemon surface (wiring slice 1): the HTTP routes that make the
// host-bridge modules real. Mounted at /api/aoi-host/* on the same loopback
// daemon as the autonomy routes.
//
// Security posture:
//   - AUTH FIRST: every route requires the file-permission shared-secret token
//     (x-aoi-host-bridge-token) verified against the daemon's token. An
//     unauthenticated caller is rejected 401 before any state is touched (T2).
//   - The HP0 kill switch + consent + approval gate every capability. This slice
//     wires the read-only surfaces (status, kill-switch control, process list);
//     the mutate routes (spawn/write/kill/delete) come in the next slice behind
//     the same gate + approval sandbox.
//
// The routing core (resolveAoiHostBridgeRoute) is a PURE-ish function of parsed
// inputs returning { status, payload }, so it is unit-testable without HTTP
// mocking; the middleware is a thin req/res adapter.
import { type IncomingMessage, type ServerResponse } from 'http';
import { resolve } from 'path';
import {
  AOI_HOST_BRIDGE_AUTH_HEADER,
  loadAoiHostBridgeToken,
  verifyAoiHostBridgeToken,
} from './aoiHostBridgeAuth';
import {
  clearAoiHostBridgePanic,
  engageAoiHostBridgePanic,
  loadAoiHostBridgeKillSwitchState,
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
  type AoiHostBridgeKillSwitchState,
} from './aoiHostBridgeKillSwitch';
import { evaluateAoiHostBridgeGate } from './aoiHostBridgeGate';
import { listHostProcesses, type AoiHostProcessListing } from './aoiHostProcessInspect';
import { loadAoiEnvironmentSourceRegistry } from './aoiAutonomyStore';
import { checkAoiEnvironmentSourceOperation } from './aoiAutonomyPolicy';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';

export const AOI_HOST_BRIDGE_API_PREFIX = '/api/aoi-host';
const MAX_BODY_BYTES = 128 * 1024;

export function getAoiHostBridgeRoute(pathname: string): string | null {
  if (
    pathname !== AOI_HOST_BRIDGE_API_PREFIX &&
    !pathname.startsWith(`${AOI_HOST_BRIDGE_API_PREFIX}/`)
  ) {
    return null;
  }
  return pathname.slice(AOI_HOST_BRIDGE_API_PREFIX.length) || '/';
}

export interface AoiHostBridgeRouteResult {
  status: number;
  payload: unknown;
}

export interface ResolveAoiHostBridgeRouteParams {
  method: string;
  route: string;
  body: Record<string, unknown>;
  // The raw value of the auth-token header, or null when absent.
  token: string | null;
  openroomHome: string;
  sessionsDir: string;
  now: number;
  // Injected for tests so a route never spawns tasklist.
  listProcessesImpl?: (options: { now: number }) => Promise<AoiHostProcessListing>;
}

function summarizeKillSwitch(state: AoiHostBridgeKillSwitchState): {
  globalPanic: boolean;
  enabledCapabilities: string[];
  updatedAt: number;
} {
  return {
    globalPanic: state.globalPanic,
    enabledCapabilities: Object.keys(state.entries).sort(),
    updatedAt: state.updatedAt,
  };
}

// The pure routing core. Auth is enforced first; then the route is dispatched.
export async function resolveAoiHostBridgeRoute(
  params: ResolveAoiHostBridgeRouteParams,
): Promise<AoiHostBridgeRouteResult> {
  // --- Authentication (outermost gate) --------------------------------------
  const expectedToken = loadAoiHostBridgeToken(params.openroomHome);
  if (!expectedToken || !verifyAoiHostBridgeToken(expectedToken, params.token)) {
    return { status: 401, payload: { ok: false, error: 'unauthorized', code: 'invalid_token' } };
  }

  // --- GET /status ----------------------------------------------------------
  if (params.method === 'GET' && params.route === '/status') {
    const killSwitch = loadAoiHostBridgeKillSwitchState(params.openroomHome);
    return {
      status: 200,
      payload: {
        ok: true,
        tokenConfigured: true,
        killSwitch: summarizeKillSwitch(killSwitch),
      },
    };
  }

  // --- POST /killswitch ------------------------------------------------------
  // body: { action: 'panic' | 'clear_panic' | 'set', capability?, enabled? }
  if (params.method === 'POST' && params.route === '/killswitch') {
    const action = typeof params.body.action === 'string' ? params.body.action : '';
    const current = loadAoiHostBridgeKillSwitchState(params.openroomHome);
    let next: AoiHostBridgeKillSwitchState;
    if (action === 'panic') {
      next = engageAoiHostBridgePanic(current, params.now);
    } else if (action === 'clear_panic') {
      next = clearAoiHostBridgePanic(current, params.now);
    } else if (action === 'set') {
      const capability = typeof params.body.capability === 'string' ? params.body.capability : '';
      const enabled = params.body.enabled === true;
      if (!capability) {
        return {
          status: 400,
          payload: {
            ok: false,
            error: 'capability is required for action=set',
            code: 'bad_request',
          },
        };
      }
      next = setAoiHostBridgeCapability(current, capability, enabled, params.now);
    } else {
      return {
        status: 400,
        payload: {
          ok: false,
          error: 'action must be panic, clear_panic, or set',
          code: 'bad_request',
        },
      };
    }
    const saved = saveAoiHostBridgeKillSwitchState(params.openroomHome, next);
    return { status: 200, payload: { ok: true, killSwitch: summarizeKillSwitch(saved) } };
  }

  // --- GET /processes?sessionPath=... (HP1 read) -----------------------------
  if (params.method === 'GET' && params.route === '/processes') {
    const sessionPath = normalizeAoiAutonomySessionPath(
      typeof params.body.sessionPath === 'string' ? params.body.sessionPath : '',
    );
    if (!sessionPath) {
      return {
        status: 400,
        payload: { ok: false, error: 'sessionPath is required', code: 'invalid_session_path' },
      };
    }
    const killSwitch = loadAoiHostBridgeKillSwitchState(params.openroomHome);
    const registry = loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, params.now);
    const consent = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: 'process-activity',
      operation: 'read_metadata',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: killSwitch,
      capabilityKey: 'process_activity',
      irreversible: false,
      consent: { allowed: consent.allowed, reasons: consent.reasons },
    });
    if (!gate.allowed) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'blocked',
          denyReasons: gate.denyReasons,
          detail: gate.detail,
        },
      };
    }
    try {
      const listProcesses = params.listProcessesImpl ?? ((options) => listHostProcesses(options));
      const listing = await listProcesses({ now: params.now });
      return { status: 200, payload: { ok: true, listing } };
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'process_listing_failed',
        },
      };
    }
  }

  return { status: 404, payload: { ok: false, error: 'not found', code: 'route_not_found' } };
}

// --- HTTP middleware (thin adapter) ------------------------------------------

export type AoiHostBridgeMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export interface AoiHostBridgePluginOptions {
  sessionsDir: string;
  // ~/.openroom -- where host-bridge/ (token + kill switch) lives. Defaults to
  // the parent of sessionsDir (~/.openroom/sessions -> ~/.openroom).
  openroomHome?: string;
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

export function createAoiHostBridgeMiddleware(
  options: AoiHostBridgePluginOptions,
): AoiHostBridgeMiddleware {
  const sessionsDir = resolve(options.sessionsDir);
  const openroomHome = resolve(options.openroomHome || resolve(sessionsDir, '..'));
  return (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = getAoiHostBridgeRoute(url.pathname);
    if (route === null) {
      next();
      return;
    }
    const method = req.method ?? 'GET';
    const tokenHeader = req.headers[AOI_HOST_BRIDGE_AUTH_HEADER];
    const token = Array.isArray(tokenHeader) ? (tokenHeader[0] ?? null) : (tokenHeader ?? null);

    void (async () => {
      // GET routes read their params from the query string; POST from the body.
      const body: Record<string, unknown> =
        method === 'GET'
          ? Object.fromEntries(url.searchParams.entries())
          : await readJsonBody(req).catch(() => ({}));
      const result = await resolveAoiHostBridgeRoute({
        method,
        route,
        body,
        token,
        openroomHome,
        sessionsDir,
        now: Date.now(),
      });
      writeJson(res, result.status, result.payload);
    })().catch((error) => {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}
