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
import {
  AOI_HOST_SPAWN_CAPABILITY,
  addAoiHostSpawnAllowlistEntry,
  evaluateAoiHostSpawnPolicy,
  loadAoiHostSpawnAllowlist,
  removeAoiHostSpawnAllowlistEntry,
  saveAoiHostSpawnAllowlist,
} from './aoiHostProcessSpawn';
import {
  AOI_HOST_FILE_READ_CAPABILITY,
  addAoiHostReadRoot,
  listAoiHostDirectory,
  loadAoiHostReadRoots,
  readAoiHostFileContent,
  removeAoiHostReadRoot,
  saveAoiHostReadRoots,
  statAoiHostPath,
} from './aoiHostFileRead';
import {
  addAoiHostWriteRoot,
  loadAoiHostWriteRoots,
  removeAoiHostWriteRoot,
  saveAoiHostWriteRoots,
} from './aoiHostFileWrite';
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

  // --- Registration CRUD (auth-only: configuring one's own consent) ----------
  // The spawn allowlist and the read/write roots are consent configuration, not
  // capability execution, so they need only the auth token (already verified).

  if (params.route === '/spawn-allowlist') {
    const current = loadAoiHostSpawnAllowlist(params.openroomHome);
    if (params.method === 'GET') {
      return { status: 200, payload: { ok: true, entries: current.entries } };
    }
    if (params.method === 'POST') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const path = typeof params.body.path === 'string' ? params.body.path : '';
      const label = typeof params.body.label === 'string' ? params.body.label : undefined;
      const fixedArgs = Array.isArray(params.body.fixedArgs)
        ? params.body.fixedArgs.filter((arg): arg is string => typeof arg === 'string')
        : undefined;
      const result = addAoiHostSpawnAllowlistEntry(
        current,
        { id, path, ...(label ? { label } : {}), ...(fixedArgs ? { fixedArgs } : {}) },
        params.now,
      );
      if (!result.added) {
        return { status: 400, payload: { ok: false, error: result.reason, code: 'bad_request' } };
      }
      const saved = saveAoiHostSpawnAllowlist(params.openroomHome, result.allowlist);
      return { status: 200, payload: { ok: true, entries: saved.entries } };
    }
    if (params.method === 'DELETE') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const saved = saveAoiHostSpawnAllowlist(
        params.openroomHome,
        removeAoiHostSpawnAllowlistEntry(current, id, params.now),
      );
      return { status: 200, payload: { ok: true, entries: saved.entries } };
    }
  }

  if (params.route === '/read-roots') {
    const current = loadAoiHostReadRoots(params.openroomHome);
    if (params.method === 'GET') {
      return { status: 200, payload: { ok: true, roots: current.roots } };
    }
    if (params.method === 'POST') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const path = typeof params.body.path === 'string' ? params.body.path : '';
      const label = typeof params.body.label === 'string' ? params.body.label : undefined;
      const result = addAoiHostReadRoot(
        current,
        { id, path, ...(label ? { label } : {}) },
        params.now,
      );
      if (!result.added) {
        return { status: 400, payload: { ok: false, error: result.reason, code: 'bad_request' } };
      }
      const saved = saveAoiHostReadRoots(params.openroomHome, result.config);
      return { status: 200, payload: { ok: true, roots: saved.roots } };
    }
    if (params.method === 'DELETE') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const saved = saveAoiHostReadRoots(
        params.openroomHome,
        removeAoiHostReadRoot(current, id, params.now),
      );
      return { status: 200, payload: { ok: true, roots: saved.roots } };
    }
  }

  if (params.route === '/write-roots') {
    const current = loadAoiHostWriteRoots(params.openroomHome);
    if (params.method === 'GET') {
      return { status: 200, payload: { ok: true, roots: current.roots } };
    }
    if (params.method === 'POST') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const path = typeof params.body.path === 'string' ? params.body.path : '';
      const label = typeof params.body.label === 'string' ? params.body.label : undefined;
      const result = addAoiHostWriteRoot(
        current,
        { id, path, ...(label ? { label } : {}) },
        params.now,
      );
      if (!result.added) {
        return { status: 400, payload: { ok: false, error: result.reason, code: 'bad_request' } };
      }
      const saved = saveAoiHostWriteRoots(params.openroomHome, result.config);
      return { status: 200, payload: { ok: true, roots: saved.roots } };
    }
    if (params.method === 'DELETE') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const saved = saveAoiHostWriteRoots(
        params.openroomHome,
        removeAoiHostWriteRoot(current, id, params.now),
      );
      return { status: 200, payload: { ok: true, roots: saved.roots } };
    }
  }

  // --- Filesystem read (HP3a): gate auth + kill-switch capability os_file_read.
  // The read roots ARE the fine-grained consent (enforced inside the resolver).
  if (
    params.method === 'GET' &&
    (params.route === '/fs/list' || params.route === '/fs/stat' || params.route === '/fs/read')
  ) {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_FILE_READ_CAPABILITY,
      irreversible: false,
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
    const requestedPath = typeof params.body.path === 'string' ? params.body.path : '';
    const roots = loadAoiHostReadRoots(params.openroomHome).roots;
    if (params.route === '/fs/list') {
      const listing = listAoiHostDirectory({ roots, requestedPath });
      return { status: listing.ok ? 200 : 400, payload: { ...listing } };
    }
    if (params.route === '/fs/stat') {
      const stat = statAoiHostPath({ roots, requestedPath });
      return { status: stat.ok ? 200 : 400, payload: { ...stat } };
    }
    const parsedMax =
      typeof params.body.maxBytes === 'string' ? Number.parseInt(params.body.maxBytes, 10) : NaN;
    const content = readAoiHostFileContent({
      roots,
      requestedPath,
      ...(Number.isFinite(parsedMax) ? { maxBytes: parsedMax } : {}),
    });
    return { status: content.ok ? 200 : 400, payload: { ...content } };
  }

  // --- Spawn preview (HP2a, display-only): return the content-addressed policy
  // + approval preview WITHOUT executing. The execute half (with an approved
  // preview) lands in the next slice. Gated on the kill-switch capability.
  if (params.method === 'POST' && params.route === '/spawn/preview') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_SPAWN_CAPABILITY,
      irreversible: false,
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
    const allowlistId = typeof params.body.allowlistId === 'string' ? params.body.allowlistId : '';
    const args = Array.isArray(params.body.args)
      ? params.body.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined;
    const policy = evaluateAoiHostSpawnPolicy({
      request: { allowlistId, ...(args ? { args } : {}), requestedAt: params.now },
      allowlist: loadAoiHostSpawnAllowlist(params.openroomHome),
      now: params.now,
    });
    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: policy.allowed,
          blockReasons: policy.blockReasons,
          allowlistId: policy.allowlistId,
          label: policy.label,
          program: policy.program,
          args: policy.args,
          approvalSandbox: policy.approvalSandbox,
          approvalFingerprint: policy.approvalFingerprint,
          expiresAt: policy.expiresAt,
        },
      },
    };
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
      // GET/DELETE read their params from the query string; POST from the body.
      const body: Record<string, unknown> =
        method === 'GET' || method === 'DELETE'
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
