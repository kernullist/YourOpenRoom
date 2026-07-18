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
  AOI_HOST_FILE_WRITE_CAPABILITY,
  addAoiHostWriteRoot,
  evaluateAoiHostFileWritePolicy,
  loadAoiHostWriteRoots,
  removeAoiHostWriteRoot,
  runAoiHostFileWrite,
  saveAoiHostWriteRoots,
} from './aoiHostFileWrite';
import { runAoiHostSpawn } from './aoiHostProcessSpawn';
import { recordAoiHostSpawnedProcess, loadAoiHostSpawnedPids } from './aoiHostSpawnAudit';
import {
  AOI_HOST_KILL_CAPABILITY,
  evaluateAoiHostKillPolicy,
  runAoiHostKill,
} from './aoiHostProcessKill';
import {
  AOI_HOST_FILE_DELETE_CAPABILITY,
  evaluateAoiHostFileDeletePolicy,
  runAoiHostFileDelete,
} from './aoiHostFileDelete';
import { normalizeAoiDesktopActivitySample } from './aoiHostDesktopActivity';
import type { AoiHostLiveProcess } from './aoiHostProcessKill';
import {
  appendAoiHostDesktopActivitySample,
  loadAoiHostDesktopActivitySummary,
} from './aoiHostDesktopActivityStore';
import {
  readAoiHostProcessByPid,
  killAoiHostProcess,
  recycleAoiHostFile,
} from './aoiHostBridgeOsImpl';
import {
  approveAoiHostBridgeApproval,
  consumeAoiHostBridgeApproval,
  loadAoiHostBridgeApprovalStore,
  recordAoiHostBridgePendingApproval,
  saveAoiHostBridgeApprovalStore,
} from './aoiHostBridgeApprovalStore';
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
  // Injected for tests so a route never spawns tasklist / kills a real process
  // / recycles a real file. Production uses the real OS impls by default.
  listProcessesImpl?: (options: { now: number }) => Promise<AoiHostProcessListing>;
  readProcessImpl?: (pid: number) => AoiHostLiveProcess | null;
  killImpl?: (pid: number) => boolean;
  recycleImpl?: (path: string) => boolean;
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
    // Record a server-side PENDING approval so execute cannot self-approve by
    // echoing the preview: the operator must explicitly approve the fingerprint.
    if (policy.allowed) {
      const recorded = recordAoiHostBridgePendingApproval(
        loadAoiHostBridgeApprovalStore(params.openroomHome),
        {
          capability: AOI_HOST_SPAWN_CAPABILITY,
          approvalFingerprint: policy.approvalFingerprint,
          targetSummary: `spawn ${policy.label} (${policy.program})`,
          expiresAt: policy.expiresAt,
          now: params.now,
        },
      );
      saveAoiHostBridgeApprovalStore(params.openroomHome, recorded.store);
    }
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

  // --- POST /spawn/execute (HP2a): run ONLY after consuming an operator-approved
  // store entry for this exact fingerprint. Single-use + time-bounded.
  if (params.method === 'POST' && params.route === '/spawn/execute') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_SPAWN_CAPABILITY,
      irreversible: true,
      approvalSatisfied: true,
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
    const allowlist = loadAoiHostSpawnAllowlist(params.openroomHome);
    const policy = evaluateAoiHostSpawnPolicy({
      request: { allowlistId, ...(args ? { args } : {}), requestedAt: params.now },
      allowlist,
      now: params.now,
    });
    const consumed = consumeAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(params.openroomHome),
      {
        capability: AOI_HOST_SPAWN_CAPABILITY,
        approvalFingerprint: policy.approvalFingerprint,
        now: params.now,
      },
    );
    if (!consumed.ok) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'blocked',
          denyReasons: [consumed.reason ?? 'approval_missing'],
        },
      };
    }
    saveAoiHostBridgeApprovalStore(params.openroomHome, consumed.store);
    const result = runAoiHostSpawn({
      request: { allowlistId, ...(args ? { args } : {}), requestedAt: params.now },
      allowlist,
      approvedSandbox: policy.approvalSandbox,
      approvedExpiresAt: policy.expiresAt,
      now: params.now,
    });
    // Record the ownership so a later kill can reclaim this Aoi-spawned pid.
    if (result.ok && typeof result.spawnedPid === 'number' && result.spawnedPid > 0) {
      recordAoiHostSpawnedProcess(
        params.openroomHome,
        { pid: result.spawnedPid, imageName: result.program },
        params.now,
      );
    }
    return { status: result.ok ? 200 : 400, payload: { ...result } };
  }

  // --- POST /fs/write/preview (HP3b): records a pending approval like spawn.
  if (params.method === 'POST' && params.route === '/fs/write/preview') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_FILE_WRITE_CAPABILITY,
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
    const content = typeof params.body.content === 'string' ? params.body.content : '';
    const policy = evaluateAoiHostFileWritePolicy({
      request: { requestedPath, content, requestedAt: params.now },
      roots: loadAoiHostWriteRoots(params.openroomHome).roots,
    });
    if (policy.allowed) {
      const recorded = recordAoiHostBridgePendingApproval(
        loadAoiHostBridgeApprovalStore(params.openroomHome),
        {
          capability: AOI_HOST_FILE_WRITE_CAPABILITY,
          approvalFingerprint: policy.approvalFingerprint,
          targetSummary: `write ${policy.resolvedPath} (${policy.byteLength} bytes)`,
          expiresAt: policy.expiresAt,
          now: params.now,
        },
      );
      saveAoiHostBridgeApprovalStore(params.openroomHome, recorded.store);
    }
    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: policy.allowed,
          blockReasons: policy.blockReasons,
          resolvedPath: policy.resolvedPath,
          willOverwrite: policy.willOverwrite,
          byteLength: policy.byteLength,
          approvalSandbox: policy.approvalSandbox,
          approvalFingerprint: policy.approvalFingerprint,
          expiresAt: policy.expiresAt,
        },
      },
    };
  }

  // --- POST /fs/write/execute (HP3b): write ONLY after consuming an approved
  // entry for this exact { path, contentHash } fingerprint.
  if (params.method === 'POST' && params.route === '/fs/write/execute') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_FILE_WRITE_CAPABILITY,
      irreversible: true,
      approvalSatisfied: true,
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
    const content = typeof params.body.content === 'string' ? params.body.content : '';
    const roots = loadAoiHostWriteRoots(params.openroomHome).roots;
    const policy = evaluateAoiHostFileWritePolicy({
      request: { requestedPath, content, requestedAt: params.now },
      roots,
    });
    const consumed = consumeAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(params.openroomHome),
      {
        capability: AOI_HOST_FILE_WRITE_CAPABILITY,
        approvalFingerprint: policy.approvalFingerprint,
        now: params.now,
      },
    );
    if (!consumed.ok) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'blocked',
          denyReasons: [consumed.reason ?? 'approval_missing'],
        },
      };
    }
    saveAoiHostBridgeApprovalStore(params.openroomHome, consumed.store);
    const result = runAoiHostFileWrite({
      request: { requestedPath, content, requestedAt: params.now },
      roots,
      approvedSandbox: policy.approvalSandbox,
      approvedExpiresAt: policy.expiresAt,
      now: params.now,
    });
    return { status: result.ok ? 200 : 400, payload: { ...result } };
  }

  // --- Approvals management (auth-only; the operator approve step) ------------
  if (params.method === 'GET' && params.route === '/approvals') {
    const store = loadAoiHostBridgeApprovalStore(params.openroomHome);
    const approvals = store.approvals
      .filter((entry) => entry.state !== 'consumed' && entry.expiresAt > params.now)
      .map((entry) => ({
        id: entry.id,
        capability: entry.capability,
        approvalFingerprint: entry.approvalFingerprint,
        targetSummary: entry.targetSummary,
        state: entry.state,
        expiresAt: entry.expiresAt,
      }));
    return { status: 200, payload: { ok: true, approvals } };
  }

  if (params.method === 'POST' && params.route === '/approvals/approve') {
    const approvalFingerprint =
      typeof params.body.approvalFingerprint === 'string' ? params.body.approvalFingerprint : '';
    if (!approvalFingerprint) {
      return {
        status: 400,
        payload: { ok: false, error: 'approvalFingerprint is required', code: 'bad_request' },
      };
    }
    const result = approveAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(params.openroomHome),
      approvalFingerprint,
      params.now,
    );
    saveAoiHostBridgeApprovalStore(params.openroomHome, result.store);
    return {
      status: result.approved ? 200 : 404,
      payload: result.approved
        ? { ok: true, approved: true }
        : {
            ok: false,
            error: 'no pending approval for that fingerprint',
            code: 'approval_missing',
          },
    };
  }

  // --- POST /kill/preview (final): records a pending approval like spawn. Body
  // pins { pid, expectedImageName, expectedStartTime? }. The policy enforces the
  // protected-process list + allowlist/spawned-pid killability.
  if (params.method === 'POST' && params.route === '/kill/preview') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_KILL_CAPABILITY,
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
    const pid = typeof params.body.pid === 'number' ? params.body.pid : Number(params.body.pid);
    const expectedImageName =
      typeof params.body.expectedImageName === 'string' ? params.body.expectedImageName : '';
    const expectedStartTime =
      typeof params.body.expectedStartTime === 'string' ||
      typeof params.body.expectedStartTime === 'number'
        ? params.body.expectedStartTime
        : undefined;
    const killAllowlistImages = Array.isArray(params.body.killAllowlistImages)
      ? params.body.killAllowlistImages.filter((v): v is string => typeof v === 'string')
      : [];
    const aoiSpawnedPids = collectAoiSpawnedPids(params.openroomHome, params.now);
    const policy = evaluateAoiHostKillPolicy({
      request: {
        pid: Number.isFinite(pid) ? pid : -1,
        expectedImageName,
        ...(expectedStartTime !== undefined ? { expectedStartTime } : {}),
        requestedAt: params.now,
      },
      context: { killAllowlistImages, aoiSpawnedPids },
      now: params.now,
    });
    if (policy.allowed) {
      const recorded = recordAoiHostBridgePendingApproval(
        loadAoiHostBridgeApprovalStore(params.openroomHome),
        {
          capability: AOI_HOST_KILL_CAPABILITY,
          approvalFingerprint: policy.approvalFingerprint,
          targetSummary: `kill ${policy.imageName} (pid ${policy.pid})`,
          expiresAt: policy.expiresAt,
          now: params.now,
        },
      );
      saveAoiHostBridgeApprovalStore(params.openroomHome, recorded.store);
    }
    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: policy.allowed,
          blockReasons: policy.blockReasons,
          pid: policy.pid,
          imageName: policy.imageName,
          approvalSandbox: policy.approvalSandbox,
          approvalFingerprint: policy.approvalFingerprint,
          expiresAt: policy.expiresAt,
        },
      },
    };
  }

  // --- POST /kill/execute (final): terminate ONLY after consuming an approved
  // entry. The runner re-checks the protected list + TOCTOU before killing.
  if (params.method === 'POST' && params.route === '/kill/execute') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_KILL_CAPABILITY,
      irreversible: true,
      approvalSatisfied: true,
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
    const pid = typeof params.body.pid === 'number' ? params.body.pid : Number(params.body.pid);
    const expectedImageName =
      typeof params.body.expectedImageName === 'string' ? params.body.expectedImageName : '';
    const expectedStartTime =
      typeof params.body.expectedStartTime === 'string' ||
      typeof params.body.expectedStartTime === 'number'
        ? params.body.expectedStartTime
        : undefined;
    const killAllowlistImages = Array.isArray(params.body.killAllowlistImages)
      ? params.body.killAllowlistImages.filter((v): v is string => typeof v === 'string')
      : [];
    const context = {
      killAllowlistImages,
      aoiSpawnedPids: collectAoiSpawnedPids(params.openroomHome, params.now),
    };
    const request = {
      pid: Number.isFinite(pid) ? pid : -1,
      expectedImageName,
      ...(expectedStartTime !== undefined ? { expectedStartTime } : {}),
      requestedAt: params.now,
    };
    const policy = evaluateAoiHostKillPolicy({ request, context, now: params.now });
    const consumed = consumeAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(params.openroomHome),
      {
        capability: AOI_HOST_KILL_CAPABILITY,
        approvalFingerprint: policy.approvalFingerprint,
        now: params.now,
      },
    );
    if (!consumed.ok) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'blocked',
          denyReasons: [consumed.reason ?? 'approval_missing'],
        },
      };
    }
    saveAoiHostBridgeApprovalStore(params.openroomHome, consumed.store);
    const result = runAoiHostKill({
      request,
      context,
      approvedSandbox: policy.approvalSandbox,
      approvedExpiresAt: policy.expiresAt,
      now: params.now,
      readProcessImpl: params.readProcessImpl ?? readAoiHostProcessByPid,
      killImpl: params.killImpl ?? killAoiHostProcess,
    });
    return { status: result.ok ? 200 : 400, payload: { ...result } };
  }

  // --- POST /fs/delete/preview (final): records a pending approval. Delete
  // routes through the Recycle Bin only.
  if (params.method === 'POST' && params.route === '/fs/delete/preview') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_FILE_DELETE_CAPABILITY,
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
    const policy = evaluateAoiHostFileDeletePolicy({
      request: { requestedPath, requestedAt: params.now },
      roots: loadAoiHostWriteRoots(params.openroomHome).roots,
    });
    if (policy.allowed) {
      const recorded = recordAoiHostBridgePendingApproval(
        loadAoiHostBridgeApprovalStore(params.openroomHome),
        {
          capability: AOI_HOST_FILE_DELETE_CAPABILITY,
          approvalFingerprint: policy.approvalFingerprint,
          targetSummary: `recycle ${policy.resolvedPath}`,
          expiresAt: policy.expiresAt,
          now: params.now,
        },
      );
      saveAoiHostBridgeApprovalStore(params.openroomHome, recorded.store);
    }
    return {
      status: 200,
      payload: {
        ok: true,
        preview: {
          allowed: policy.allowed,
          blockReasons: policy.blockReasons,
          resolvedPath: policy.resolvedPath,
          approvalSandbox: policy.approvalSandbox,
          approvalFingerprint: policy.approvalFingerprint,
          expiresAt: policy.expiresAt,
        },
      },
    };
  }

  // --- POST /fs/delete/execute (final): recycle ONLY after consuming approval.
  if (params.method === 'POST' && params.route === '/fs/delete/execute') {
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: AOI_HOST_FILE_DELETE_CAPABILITY,
      irreversible: true,
      approvalSatisfied: true,
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
    const roots = loadAoiHostWriteRoots(params.openroomHome).roots;
    const policy = evaluateAoiHostFileDeletePolicy({
      request: { requestedPath, requestedAt: params.now },
      roots,
    });
    const consumed = consumeAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(params.openroomHome),
      {
        capability: AOI_HOST_FILE_DELETE_CAPABILITY,
        approvalFingerprint: policy.approvalFingerprint,
        now: params.now,
      },
    );
    if (!consumed.ok) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'blocked',
          denyReasons: [consumed.reason ?? 'approval_missing'],
        },
      };
    }
    saveAoiHostBridgeApprovalStore(params.openroomHome, consumed.store);
    const result = runAoiHostFileDelete({
      request: { requestedPath, requestedAt: params.now },
      roots,
      approvedSandbox: policy.approvalSandbox,
      approvedExpiresAt: policy.expiresAt,
      now: params.now,
      recycleImpl: params.recycleImpl ?? recycleAoiHostFile,
    });
    return { status: result.ok ? 200 : 400, payload: { ...result } };
  }

  // --- POST /desktop-activity (HP4 ingest): the capture helper posts one
  // metadata-only foreground sample. Gate auth + kill-switch capability
  // desktop_activity + the desktop-activity env-source consent for the session.
  if (params.method === 'POST' && params.route === '/desktop-activity') {
    const sessionPath = normalizeAoiAutonomySessionPath(
      typeof params.body.sessionPath === 'string' ? params.body.sessionPath : '',
    );
    if (!sessionPath) {
      return {
        status: 400,
        payload: { ok: false, error: 'sessionPath is required', code: 'invalid_session_path' },
      };
    }
    const registry = loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, params.now);
    const consent = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: 'desktop-activity',
      operation: 'read_metadata',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: 'desktop_activity',
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
    const captureWindowTitles = params.body.captureWindowTitles === true;
    const rawSample =
      params.body.sample && typeof params.body.sample === 'object' ? params.body.sample : {};
    const sample = normalizeAoiDesktopActivitySample(rawSample as Record<string, unknown>, {
      captureWindowTitles,
      now: params.now,
    });
    if (!sample) {
      return {
        status: 400,
        payload: { ok: false, error: 'sample has no usable app name', code: 'bad_sample' },
      };
    }
    const count = appendAoiHostDesktopActivitySample(params.openroomHome, sample, params.now);
    return { status: 200, payload: { ok: true, storedSampleCount: count } };
  }

  // --- GET /desktop-activity/summary?sessionPath: the taste signal read.
  if (params.method === 'GET' && params.route === '/desktop-activity/summary') {
    const sessionPath = normalizeAoiAutonomySessionPath(
      typeof params.body.sessionPath === 'string' ? params.body.sessionPath : '',
    );
    if (!sessionPath) {
      return {
        status: 400,
        payload: { ok: false, error: 'sessionPath is required', code: 'invalid_session_path' },
      };
    }
    const registry = loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, params.now);
    const consent = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: 'desktop-activity',
      operation: 'summarize_counts',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: 'desktop_activity',
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
    const summary = loadAoiHostDesktopActivitySummary(params.openroomHome, params.now);
    return { status: 200, payload: { ok: true, summary } };
  }

  return { status: 404, payload: { ok: false, error: 'not found', code: 'route_not_found' } };
}

// Pids Aoi itself spawned (from the persisted spawn audit) are implicitly
// killable. The audit is written by /spawn/execute and pruned on read (TTL +
// cap); the kill runner still re-verifies pid + image + start time (TOCTOU)
// before terminating, so a reused pid whose identity no longer matches is
// refused regardless of this set.
function collectAoiSpawnedPids(openroomHome: string, now: number): number[] {
  return loadAoiHostSpawnedPids(openroomHome, now);
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
