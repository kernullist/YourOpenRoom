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
import { randomUUID } from 'crypto';
import {
  AOI_HOST_BRIDGE_AUTH_HEADER,
  loadAoiHostBridgeToken,
  verifyAoiHostBridgeToken,
} from './aoiHostBridgeAuth';
import {
  clearAoiHostBridgePanic,
  engageAoiHostBridgePanic,
  isAoiHostBridgeCapabilityEnabled,
  loadAoiHostBridgeKillSwitchState,
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
  type AoiHostBridgeKillSwitchState,
} from './aoiHostBridgeKillSwitch';
import { evaluateAoiHostBridgeGate } from './aoiHostBridgeGate';
import { listHostProcesses, type AoiHostProcessListing } from './aoiHostProcessInspect';
import {
  AOI_HOST_BROWSER_READ_CAPABILITY,
  AOI_HOST_BROWSER_READ_SOURCE_ID,
  runAoiHostBrowserRead,
  type AoiHostBrowserReadOutcome,
} from './aoiHostBrowserRead';
import { AOI_BROWSER_DRIVE_CAPABILITY, AOI_BROWSER_DRIVE_SOURCE_ID } from './aoiBrowserDrive';
import { AoiBrowserDriveStartError, startAoiBrowserDriveSession } from './aoiBrowserDriveSession';
import {
  addAoiBrowserDriveAllowlistEntry,
  isAoiBrowserDriveUrlAllowed,
  loadAoiBrowserDriveAllowlist,
  removeAoiBrowserDriveAllowlistEntry,
  saveAoiBrowserDriveAllowlist,
  type AoiBrowserDriveAllowlist,
} from './aoiBrowserDriveAllowlist';
import {
  navigateAndExtractAoiBrowserDrive,
  type AoiBrowserDriveNavigablePage,
  type AoiBrowserDriveReadOutcome,
} from './aoiBrowserDriveRead';
import {
  executeAoiBrowserDriveActStep,
  previewAoiBrowserDriveActStep,
  type AoiBrowserDriveActExecuteResult,
  type AoiBrowserDriveActPreviewResult,
  type AoiBrowserDriveRunFailure,
  type AoiBrowserDriveRunnerSession,
} from './aoiBrowserDriveActRunner';
import {
  buildAoiBrowserDriveActApprovalPreview,
  makeAoiBrowserDriveStoreApprovalGate,
  recordAoiBrowserDriveActPendingApproval,
} from './aoiBrowserDriveApproval';
import {
  loadAoiBrowserDriveAuditEntries,
  recordAoiBrowserDriveAuditEntry,
} from './aoiBrowserDriveAuditStore';
import { writeAoiBrowserDriveArtifact } from './aoiBrowserDriveAuditObserver';
import {
  AOI_BROWSER_DRIVE_STANDING_CAPABILITY,
  addAoiBrowserDriveStandingGrant,
  loadAoiBrowserDriveStandingGrantStore,
  pruneAoiBrowserDriveStandingGrants,
  removeAoiBrowserDriveStandingGrant,
  saveAoiBrowserDriveStandingGrantStore,
} from './aoiBrowserDriveStandingGrant';
import {
  AOI_BROWSER_DRIVE_TASK_CAPABILITY,
  executeAoiBrowserDriveTask,
  type AoiBrowserDriveTask,
  type AoiBrowserDriveTaskResult,
} from './aoiBrowserDriveTaskRunner';
import type { AoiBrowserDrivePlan } from './aoiBrowserDrivePlan';
import type { AoiBrowserDriveActablePage } from './aoiBrowserDriveExecutor';
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
  loadAoiScreenVisionStreamSummary,
  recordAoiScreenVisionEvent,
  type AoiScreenVisionEventInput,
} from './aoiScreenVisionStream';
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
  browserReadImpl?: (options: { url: string; now: number }) => Promise<AoiHostBrowserReadOutcome>;
  browserDriveReadImpl?: (options: {
    url: string;
    allowlist: AoiBrowserDriveAllowlist;
    now: number;
  }) => Promise<AoiBrowserDriveReadOutcome>;
  browserDrivePreviewImpl?: (options: {
    plan: AoiBrowserDrivePlan;
    targetStepIndex: number;
    allowlist: AoiBrowserDriveAllowlist;
    now: number;
  }) => Promise<AoiBrowserDriveActPreviewResult | AoiBrowserDriveRunFailure>;
  browserDriveExecuteImpl?: (options: {
    plan: AoiBrowserDrivePlan;
    targetStepIndex: number;
    allowlist: AoiBrowserDriveAllowlist;
    now: number;
    openroomHome: string;
  }) => Promise<AoiBrowserDriveActExecuteResult | AoiBrowserDriveRunFailure>;
  browserDriveTaskImpl?: (options: {
    task: AoiBrowserDriveTask;
    allowlist: AoiBrowserDriveAllowlist;
    now: number;
    openroomHome: string;
    maxActs?: number;
    maxSteps?: number;
  }) => Promise<AoiBrowserDriveTaskResult>;
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

// Default production browser-drive read: per-request CDP session against the
// operator's OWN browser -> navigate the allowlisted page -> extract -> close ONLY
// the Aoi tab. A start failure (browser not found, or the main browser is already
// running without the debug port -> SingletonLock -> attach_timeout) is mapped to a
// navigation failure so the caller gets a clean 422 with the real cause in detail.
// (Session pooling is a later optimization.)
async function runAoiBrowserDriveReadDefault(options: {
  url: string;
  allowlist: AoiBrowserDriveAllowlist;
  now: number;
}): Promise<AoiBrowserDriveReadOutcome> {
  let session;
  try {
    session = await startAoiBrowserDriveSession({});
  } catch (error) {
    if (error instanceof AoiBrowserDriveStartError) {
      return {
        ok: false,
        reason: 'navigation_failed',
        detail: `${error.reason}: ${error.message}`,
      };
    }
    throw error;
  }
  try {
    return await navigateAndExtractAoiBrowserDrive({
      page: session.page as unknown as AoiBrowserDriveNavigablePage,
      allowlist: options.allowlist,
      url: options.url,
      now: options.now,
    });
  } finally {
    await session.close();
  }
}

// Shared gate for the browser-drive ACT routes: auth is already verified; this adds
// the kill-switch + browser-drive consent (fail-closed). preview is reversible;
// execute is irreversible + approval-satisfied. Returns a denial result, or null
// when the caller may proceed.
function requireAoiBrowserDriveActGate(
  params: ResolveAoiHostBridgeRouteParams,
  opts: { irreversible: boolean; approvalSatisfied?: boolean },
): AoiHostBridgeRouteResult | null {
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
    sourceId: AOI_BROWSER_DRIVE_SOURCE_ID,
    operation: 'read_metadata',
  });
  const gate = evaluateAoiHostBridgeGate({
    authenticated: true,
    killSwitchState: killSwitch,
    capabilityKey: AOI_BROWSER_DRIVE_CAPABILITY,
    irreversible: opts.irreversible,
    ...(opts.approvalSatisfied ? { approvalSatisfied: true } : {}),
    consent: { allowed: consent.allowed, reasons: consent.reasons },
  });
  if (!gate.allowed) {
    return {
      status: 403,
      payload: { ok: false, error: 'blocked', denyReasons: gate.denyReasons, detail: gate.detail },
    };
  }
  return null;
}

// Parse a { plan, targetStepIndex } ACT request body. Returns null on a malformed
// request; the plan classifiers normalize the plan shape defensively downstream.
function parseAoiBrowserDriveActRequest(
  body: Record<string, unknown>,
): { plan: AoiBrowserDrivePlan; targetStepIndex: number } | null {
  const rawPlan = body.plan;
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    return null;
  }
  if (!Array.isArray((rawPlan as { steps?: unknown }).steps)) {
    return null;
  }
  const targetStepIndex = body.targetStepIndex;
  if (
    typeof targetStepIndex !== 'number' ||
    !Number.isInteger(targetStepIndex) ||
    targetStepIndex < 0
  ) {
    return null;
  }
  return { plan: rawPlan as AoiBrowserDrivePlan, targetStepIndex };
}

// Parse a bounded task body: { owner, goal, steps:[{plan, targetStepIndex}] }.
// Returns null on a malformed request; the orchestrator + step runner re-validate
// (owner='user', budget, per-step admissibility) downstream.
function parseAoiBrowserDriveTaskRequest(
  body: Record<string, unknown>,
): AoiBrowserDriveTask | null {
  const rawTask = body.task;
  if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
    return null;
  }
  const t = rawTask as { owner?: unknown; goal?: unknown; steps?: unknown };
  if (typeof t.owner !== 'string' || !Array.isArray(t.steps) || t.steps.length === 0) {
    return null;
  }
  const steps: AoiBrowserDriveTask['steps'] = [];
  for (const rawStep of t.steps) {
    const parsed = parseAoiBrowserDriveActRequest(
      (rawStep && typeof rawStep === 'object' ? rawStep : {}) as Record<string, unknown>,
    );
    if (!parsed) {
      return null;
    }
    steps.push({ plan: parsed.plan, targetStepIndex: parsed.targetStepIndex });
  }
  return { owner: t.owner, goal: typeof t.goal === 'string' ? t.goal : '', steps };
}

// Production session factory for the ACT runner: a fresh CDP session against the
// operator's OWN browser, adapted to the runner's minimal { page, close } shape.
// A start failure surfaces through the runner as session_start_failed.
async function makeAoiBrowserDriveRunnerSession(): Promise<AoiBrowserDriveRunnerSession> {
  const session = await startAoiBrowserDriveSession({});
  return {
    page: session.page as unknown as AoiBrowserDriveActablePage,
    close: () => session.close(),
  };
}

// Default production browser-drive ACT preview: replay the read prefix in a fresh
// session and screenshot the page the target act would touch (read-only, no effect).
async function runAoiBrowserDrivePreviewDefault(options: {
  plan: AoiBrowserDrivePlan;
  targetStepIndex: number;
  allowlist: AoiBrowserDriveAllowlist;
  now: number;
}): Promise<AoiBrowserDriveActPreviewResult | AoiBrowserDriveRunFailure> {
  return previewAoiBrowserDriveActStep({
    plan: options.plan,
    targetStepIndex: options.targetStepIndex,
    allowlist: options.allowlist,
    now: options.now,
    sessionFactory: makeAoiBrowserDriveRunnerSession,
  });
}

// Default production browser-drive ACT execute: consume the operator-approved,
// single-use store entry (via the store-backed gate) and run the ONE target act in
// a fresh session after replaying the read prefix. Without an approved entry the
// gate is fail-closed and nothing runs.
async function runAoiBrowserDriveExecuteDefault(options: {
  plan: AoiBrowserDrivePlan;
  targetStepIndex: number;
  allowlist: AoiBrowserDriveAllowlist;
  now: number;
  openroomHome: string;
}): Promise<AoiBrowserDriveActExecuteResult | AoiBrowserDriveRunFailure> {
  // Standing-grant fallback is honored ONLY when the os_browser_drive_standing
  // capability toggle is ON (and, via isAoiHostBridgeCapabilityEnabled, panic is off).
  const standingEnabled = isAoiHostBridgeCapabilityEnabled(
    loadAoiHostBridgeKillSwitchState(options.openroomHome),
    AOI_BROWSER_DRIVE_STANDING_CAPABILITY,
  );
  const gate = makeAoiBrowserDriveStoreApprovalGate({
    loadStore: () => loadAoiHostBridgeApprovalStore(options.openroomHome),
    saveStore: (store) => {
      saveAoiHostBridgeApprovalStore(options.openroomHome, store);
    },
    now: options.now,
    standing: {
      enabled: standingEnabled,
      loadGrants: () => loadAoiBrowserDriveStandingGrantStore(options.openroomHome),
      saveGrants: (store) => {
        saveAoiBrowserDriveStandingGrantStore(options.openroomHome, store);
      },
    },
  });
  // One run id per execute call groups its steps in the audit ledger; artifacts are
  // written under host-bridge/browser-drive-artifacts/<runId>/. Auditing is best-
  // effort (never fails the run).
  const runId = `run-${options.now.toString(36)}-${randomUUID().slice(0, 8)}`;
  return executeAoiBrowserDriveActStep({
    plan: options.plan,
    targetStepIndex: options.targetStepIndex,
    allowlist: options.allowlist,
    now: options.now,
    approvalGate: gate,
    sessionFactory: makeAoiBrowserDriveRunnerSession,
    // Cooperative panic abort during the read-prefix replay (the entry gate already
    // blocks a call that starts while panicked).
    isPanicked: () => loadAoiHostBridgeKillSwitchState(options.openroomHome).globalPanic === true,
    audit: {
      runId,
      writeArtifact: (relPath, data) =>
        writeAoiBrowserDriveArtifact(options.openroomHome, relPath, data),
      recordEntry: (entry) => {
        recordAoiBrowserDriveAuditEntry(options.openroomHome, entry, options.now);
      },
    },
  });
}

// Default production browser-drive TASK run (P3.2): the bounded orchestrator over the
// per-step execute default. Each step still opens its own stateless session and
// passes every gate; the orchestrator only bounds acts/steps + fail-stops.
async function runAoiBrowserDriveTaskDefault(options: {
  task: AoiBrowserDriveTask;
  allowlist: AoiBrowserDriveAllowlist;
  now: number;
  openroomHome: string;
  maxActs?: number;
  maxSteps?: number;
}): Promise<AoiBrowserDriveTaskResult> {
  return executeAoiBrowserDriveTask({
    task: options.task,
    ...(typeof options.maxActs === 'number' ? { maxActs: options.maxActs } : {}),
    ...(typeof options.maxSteps === 'number' ? { maxSteps: options.maxSteps } : {}),
    runStep: (step) =>
      runAoiBrowserDriveExecuteDefault({
        plan: step.plan,
        targetStepIndex: step.targetStepIndex,
        allowlist: options.allowlist,
        // Fresh wall-clock per step so a standing grant's TTL/expiry is measured
        // against the moment each step runs, not frozen at task start (a long task
        // must not keep honoring a grant that expired mid-run).
        now: Date.now(),
        openroomHome: options.openroomHome,
      }),
  });
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

  // --- POST /browser-read (HP5): headless Chrome/Edge page extract -------------
  if (params.method === 'POST' && params.route === '/browser-read') {
    const sessionPath = normalizeAoiAutonomySessionPath(
      typeof params.body.sessionPath === 'string' ? params.body.sessionPath : '',
    );
    if (!sessionPath) {
      return {
        status: 400,
        payload: { ok: false, error: 'sessionPath is required', code: 'invalid_session_path' },
      };
    }
    const url = typeof params.body.url === 'string' ? params.body.url : '';
    const killSwitch = loadAoiHostBridgeKillSwitchState(params.openroomHome);
    const registry = loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, params.now);
    const consent = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: AOI_HOST_BROWSER_READ_SOURCE_ID,
      operation: 'read_metadata',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: killSwitch,
      capabilityKey: AOI_HOST_BROWSER_READ_CAPABILITY,
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
      const browserRead =
        params.browserReadImpl ??
        ((options: { url: string; now: number }) =>
          runAoiHostBrowserRead({ url: options.url, now: options.now }));
      const result = await browserRead({ url, now: params.now });
      if (!result.ok) {
        return {
          status: 422,
          payload: {
            ok: false,
            error: result.reason,
            code: result.reason,
            detail: result.detail,
          },
        };
      }
      return { status: 200, payload: { ok: true, page: result } };
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'browser_read_failed',
        },
      };
    }
  }

  // --- POST /browser-drive-read (BD P1.3): drive the operator's OWN logged-in
  //     browser over CDP and extract an allowlisted page (read-only) -----------
  if (params.method === 'POST' && params.route === '/browser-drive-read') {
    const sessionPath = normalizeAoiAutonomySessionPath(
      typeof params.body.sessionPath === 'string' ? params.body.sessionPath : '',
    );
    if (!sessionPath) {
      return {
        status: 400,
        payload: { ok: false, error: 'sessionPath is required', code: 'invalid_session_path' },
      };
    }
    const url = typeof params.body.url === 'string' ? params.body.url : '';
    const killSwitch = loadAoiHostBridgeKillSwitchState(params.openroomHome);
    const registry = loadAoiEnvironmentSourceRegistry(params.sessionsDir, sessionPath, params.now);
    const consent = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: AOI_BROWSER_DRIVE_SOURCE_ID,
      operation: 'read_metadata',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: killSwitch,
      capabilityKey: AOI_BROWSER_DRIVE_CAPABILITY,
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
    // Containment pre-check: refuse a non-allowlisted URL BEFORE launching a
    // browser. navigateAndExtract re-checks (incl. redirect drift) fail-closed.
    const allowlist = loadAoiBrowserDriveAllowlist(params.openroomHome);
    const allowed = isAoiBrowserDriveUrlAllowed(allowlist, url);
    if (!allowed.allowed) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'url_not_allowlisted',
          code: 'url_not_allowlisted',
          denyReasons: [allowed.reason ?? 'host_not_allowlisted'],
          detail: allowed.hostname,
        },
      };
    }
    try {
      const driveRead = params.browserDriveReadImpl ?? runAoiBrowserDriveReadDefault;
      const result = await driveRead({ url, allowlist, now: params.now });
      if (!result.ok) {
        return {
          status: 422,
          payload: {
            ok: false,
            error: result.reason,
            code: result.reason,
            detail: result.detail,
            hostname: result.hostname,
          },
        };
      }
      return { status: 200, payload: { ok: true, page: result } };
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'browser_drive_read_failed',
        },
      };
    }
  }

  // --- POST /browser-drive/preview (BD P2.3): replay the plan's read prefix in a
  //     fresh session and return the per-ACT approval preview (fingerprint + before-
  //     screenshot). Records a PENDING approval so execute cannot self-approve.
  //     Read-only: no side effect runs here. ------------------------------------
  if (params.method === 'POST' && params.route === '/browser-drive/preview') {
    const denied = requireAoiBrowserDriveActGate(params, { irreversible: false });
    if (denied) {
      return denied;
    }
    const parsed = parseAoiBrowserDriveActRequest(params.body);
    if (!parsed) {
      return {
        status: 400,
        payload: { ok: false, error: 'plan and targetStepIndex are required', code: 'bad_request' },
      };
    }
    // Cheap pure reject BEFORE opening a browser: only an admissible plan's ACT step
    // is approvable (read needs no approval, forbidden can never run).
    const preValidate = buildAoiBrowserDriveActApprovalPreview({
      plan: parsed.plan,
      stepIndex: parsed.targetStepIndex,
      now: params.now,
    });
    if (!preValidate.ok) {
      return {
        status: 422,
        payload: {
          ok: false,
          error: preValidate.reason,
          code: preValidate.reason,
          detail: preValidate.detail,
        },
      };
    }
    const allowlist = loadAoiBrowserDriveAllowlist(params.openroomHome);
    try {
      const previewImpl = params.browserDrivePreviewImpl ?? runAoiBrowserDrivePreviewDefault;
      const browserPreview = await previewImpl({
        plan: parsed.plan,
        targetStepIndex: parsed.targetStepIndex,
        allowlist,
        now: params.now,
      });
      if (!browserPreview.ok) {
        return {
          status: 422,
          payload: {
            ok: false,
            error: browserPreview.reason,
            code: browserPreview.reason,
            detail: browserPreview.detail,
          },
        };
      }
      const approval = buildAoiBrowserDriveActApprovalPreview({
        plan: parsed.plan,
        stepIndex: parsed.targetStepIndex,
        hostname: browserPreview.hostname,
        ...(browserPreview.beforeScreenshotBase64
          ? { beforeScreenshotBase64: browserPreview.beforeScreenshotBase64 }
          : {}),
        now: params.now,
      });
      if (!approval.ok) {
        return {
          status: 422,
          payload: {
            ok: false,
            error: approval.reason,
            code: approval.reason,
            detail: approval.detail,
          },
        };
      }
      const recorded = recordAoiBrowserDriveActPendingApproval(
        loadAoiHostBridgeApprovalStore(params.openroomHome),
        approval,
        params.now,
      );
      saveAoiHostBridgeApprovalStore(params.openroomHome, recorded.store);
      return {
        status: 200,
        payload: {
          ok: true,
          preview: {
            capability: approval.capability,
            approvalFingerprint: approval.fingerprint,
            targetSummary: approval.targetSummary,
            stepIndex: approval.stepIndex,
            hostname: approval.hostname,
            finalUrl: browserPreview.finalUrl,
            expiresAt: approval.expiresAt,
            ...(approval.beforeScreenshotBase64
              ? { beforeScreenshotBase64: approval.beforeScreenshotBase64 }
              : {}),
          },
        },
      };
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'browser_drive_preview_failed',
        },
      };
    }
  }

  // --- POST /browser-drive/execute (BD P2.3): run the ONE approved target act.
  //     Reached only after consuming an operator-approved, single-use store entry
  //     for this exact action fingerprint; the gate is fail-closed otherwise. -----
  if (params.method === 'POST' && params.route === '/browser-drive/execute') {
    const denied = requireAoiBrowserDriveActGate(params, {
      irreversible: true,
      approvalSatisfied: true,
    });
    if (denied) {
      return denied;
    }
    const parsed = parseAoiBrowserDriveActRequest(params.body);
    if (!parsed) {
      return {
        status: 400,
        payload: { ok: false, error: 'plan and targetStepIndex are required', code: 'bad_request' },
      };
    }
    const allowlist = loadAoiBrowserDriveAllowlist(params.openroomHome);
    try {
      const executeImpl = params.browserDriveExecuteImpl ?? runAoiBrowserDriveExecuteDefault;
      const result = await executeImpl({
        plan: parsed.plan,
        targetStepIndex: parsed.targetStepIndex,
        allowlist,
        now: params.now,
        openroomHome: params.openroomHome,
      });
      // Runner-level failure (bad plan / prefix / session) -> 422; panic -> 403.
      if ('reason' in result) {
        return {
          status: result.reason === 'panicked' ? 403 : 422,
          payload: { ok: false, error: result.reason, code: result.reason, detail: result.detail },
        };
      }
      // The target ran (or was gated). A blocked target is 403, a soft failure 422.
      if (!result.ok) {
        const stop = result.target.stopReason;
        const blocked = stop === 'approval_denied' || stop === 'approval_gate_error';
        return {
          status: blocked ? 403 : 422,
          payload: {
            ok: false,
            error: stop ?? 'action_failed',
            code: stop ?? 'action_failed',
            detail: result.target.detail,
            result,
          },
        };
      }
      return { status: 200, payload: { ok: true, result } };
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'browser_drive_execute_failed',
        },
      };
    }
  }

  // --- POST /browser-drive/task (BD P3.2): run a bounded, operator-authored multi-
  //     act task. Gated like execute PLUS a distinct os_browser_drive_task toggle
  //     (autonomy opts in separately). Each step still passes every gate; the
  //     orchestrator only bounds acts/steps + fail-stops. ------------------------
  if (params.method === 'POST' && params.route === '/browser-drive/task') {
    const denied = requireAoiBrowserDriveActGate(params, {
      irreversible: true,
      approvalSatisfied: true,
    });
    if (denied) {
      return denied;
    }
    // The multi-act autonomy toggle is a separate, human-only opt-in.
    const taskEnabled = isAoiHostBridgeCapabilityEnabled(
      loadAoiHostBridgeKillSwitchState(params.openroomHome),
      AOI_BROWSER_DRIVE_TASK_CAPABILITY,
    );
    if (!taskEnabled) {
      return {
        status: 403,
        payload: {
          ok: false,
          error: 'blocked',
          code: 'task_capability_disabled',
          denyReasons: ['os_browser_drive_task disabled'],
        },
      };
    }
    const task = parseAoiBrowserDriveTaskRequest(params.body);
    if (!task) {
      return {
        status: 400,
        payload: { ok: false, error: 'task with owner+steps is required', code: 'bad_request' },
      };
    }
    const allowlist = loadAoiBrowserDriveAllowlist(params.openroomHome);
    const maxActs = typeof params.body.maxActs === 'number' ? params.body.maxActs : undefined;
    const maxSteps = typeof params.body.maxSteps === 'number' ? params.body.maxSteps : undefined;
    try {
      const taskImpl = params.browserDriveTaskImpl ?? runAoiBrowserDriveTaskDefault;
      const result = await taskImpl({
        task,
        allowlist,
        now: params.now,
        openroomHome: params.openroomHome,
        ...(maxActs !== undefined ? { maxActs } : {}),
        ...(maxSteps !== undefined ? { maxSteps } : {}),
      });
      if (result.ok) {
        return { status: 200, payload: { ok: true, result } };
      }
      // not_operator_authored is a provenance refusal -> 403; other stops -> 422.
      return {
        status: result.stopReason === 'not_operator_authored' ? 403 : 422,
        payload: {
          ok: false,
          error: result.stopReason,
          code: result.stopReason,
          detail: result.detail,
          result,
        },
      };
    } catch (error) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'browser_drive_task_failed',
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
      const match = params.body.match === 'directory' ? 'directory' : 'file';
      const fixedArgs = Array.isArray(params.body.fixedArgs)
        ? params.body.fixedArgs.filter((arg): arg is string => typeof arg === 'string')
        : undefined;
      const result = addAoiHostSpawnAllowlistEntry(
        current,
        {
          ...(id ? { id } : {}),
          path,
          match,
          ...(label ? { label } : {}),
          ...(fixedArgs ? { fixedArgs } : {}),
        },
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

  if (params.route === '/browser-drive-allowlist') {
    const current = loadAoiBrowserDriveAllowlist(params.openroomHome);
    if (params.method === 'GET') {
      return { status: 200, payload: { ok: true, entries: current.entries } };
    }
    if (params.method === 'POST') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const domain = typeof params.body.domain === 'string' ? params.body.domain : '';
      const label = typeof params.body.label === 'string' ? params.body.label : undefined;
      const result = addAoiBrowserDriveAllowlistEntry(
        current,
        { ...(id ? { id } : {}), domain, ...(label ? { label } : {}) },
        params.now,
      );
      if (!result.added) {
        return { status: 400, payload: { ok: false, error: result.reason, code: 'bad_request' } };
      }
      const saved = saveAoiBrowserDriveAllowlist(params.openroomHome, result.allowlist);
      return { status: 200, payload: { ok: true, entries: saved.entries } };
    }
    if (params.method === 'DELETE') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const saved = saveAoiBrowserDriveAllowlist(
        params.openroomHome,
        removeAoiBrowserDriveAllowlistEntry(current, id, params.now),
      );
      return { status: 200, payload: { ok: true, entries: saved.entries } };
    }
  }

  // --- Standing grants CRUD (BD P3.1c, auth-only config): the operator creates /
  //     revokes a TTL+quota domain grant that lets Aoi act without a per-action click
  //     WHEN the os_browser_drive_standing toggle is on. Creating a grant is consent
  //     configuration (actor='user'), not capability execution, so auth-only.
  if (params.route === '/browser-drive/standing-grants') {
    const current = loadAoiBrowserDriveStandingGrantStore(params.openroomHome);
    if (params.method === 'GET') {
      return {
        status: 200,
        payload: {
          ok: true,
          grants: pruneAoiBrowserDriveStandingGrants(current.grants, params.now),
        },
      };
    }
    if (params.method === 'POST') {
      const domain = typeof params.body.domain === 'string' ? params.body.domain : '';
      const label = typeof params.body.label === 'string' ? params.body.label : undefined;
      const ttlMs = typeof params.body.ttlMs === 'number' ? params.body.ttlMs : undefined;
      const maxActions =
        typeof params.body.maxActions === 'number' ? params.body.maxActions : undefined;
      const result = addAoiBrowserDriveStandingGrant(
        current,
        {
          domain,
          ...(label ? { label } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(maxActions !== undefined ? { maxActions } : {}),
        },
        params.now,
      );
      if (!result.grant) {
        return {
          status: 400,
          payload: { ok: false, error: result.reason ?? 'bad_request', code: 'bad_request' },
        };
      }
      const saved = saveAoiBrowserDriveStandingGrantStore(params.openroomHome, result.store);
      return { status: 200, payload: { ok: true, grants: saved.grants } };
    }
    if (params.method === 'DELETE') {
      const id = typeof params.body.id === 'string' ? params.body.id : '';
      const saved = saveAoiBrowserDriveStandingGrantStore(
        params.openroomHome,
        removeAoiBrowserDriveStandingGrant(current, id, params.now),
      );
      return { status: 200, payload: { ok: true, grants: saved.grants } };
    }
  }

  // --- GET /browser-drive/audit (BD P3.3, auth-only): the read-only step-audit
  //     ledger for the observability dashboard. Newest-first, pruned to live TTL.
  if (params.method === 'GET' && params.route === '/browser-drive/audit') {
    const entries = loadAoiBrowserDriveAuditEntries(params.openroomHome, params.now);
    // Newest-first for the dashboard; cap the payload defensively.
    const recent = entries.slice(-200).reverse();
    return { status: 200, payload: { ok: true, entries: recent } };
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
        { ...(id ? { id } : {}), path, ...(label ? { label } : {}) },
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
        { ...(id ? { id } : {}), path, ...(label ? { label } : {}) },
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
    const programPath = typeof params.body.programPath === 'string' ? params.body.programPath : '';
    const args = Array.isArray(params.body.args)
      ? params.body.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined;
    const policy = evaluateAoiHostSpawnPolicy({
      request: {
        ...(allowlistId ? { allowlistId } : {}),
        ...(programPath ? { programPath } : {}),
        ...(args ? { args } : {}),
        requestedAt: params.now,
      },
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
          // Show the argument vector (bounded) so the operator approves what will
          // actually run, not just the program name. The full args are bound in
          // the fingerprint (aoiHostProcessSpawn), so a hidden tail cannot slip in.
          targetSummary:
            `spawn ${policy.label} (${policy.program} ${policy.args.join(' ').slice(0, 200)})`.trim(),
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
    const programPath = typeof params.body.programPath === 'string' ? params.body.programPath : '';
    const args = Array.isArray(params.body.args)
      ? params.body.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined;
    const allowlist = loadAoiHostSpawnAllowlist(params.openroomHome);
    const spawnRequest = {
      ...(allowlistId ? { allowlistId } : {}),
      ...(programPath ? { programPath } : {}),
      ...(args ? { args } : {}),
      requestedAt: params.now,
    };
    const policy = evaluateAoiHostSpawnPolicy({
      request: spawnRequest,
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
      request: spawnRequest,
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

  // --- POST /screen-vision (SV3.2 ingest): the capture helper posts one
  // REDACTED focused-window summary. Gate auth (already checked) + kill-switch
  // capability screen_vision + the screen-vision env-source consent. The ledger
  // re-checks consent and re-redacts at the record boundary (defense in depth);
  // the kill switch is enforced HERE (the ledger does not know about it).
  if (params.method === 'POST' && params.route === '/screen-vision') {
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
      sourceId: 'screen-vision',
      operation: 'read_metadata',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: 'screen_vision',
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
    const rawSample =
      params.body.sample && typeof params.body.sample === 'object'
        ? (params.body.sample as AoiScreenVisionEventInput)
        : {};
    const result = recordAoiScreenVisionEvent(
      params.sessionsDir,
      sessionPath,
      rawSample,
      params.now,
    );
    if (!result.recorded) {
      return {
        status: 400,
        payload: {
          ok: false,
          error: 'sample was not recorded',
          code: result.reasons[0] ?? 'bad_sample',
          reasons: result.reasons,
        },
      };
    }
    return { status: 200, payload: { ok: true, eventId: result.event?.id } };
  }

  // --- GET /screen-vision/summary?sessionPath: the redacted screen-vision read.
  if (params.method === 'GET' && params.route === '/screen-vision/summary') {
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
      sourceId: 'screen-vision',
      operation: 'summarize_counts',
    });
    const gate = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: loadAoiHostBridgeKillSwitchState(params.openroomHome),
      capabilityKey: 'screen_vision',
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
    const summary = loadAoiScreenVisionStreamSummary(params.sessionsDir, sessionPath, params.now);
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
  // Dev-server convenience: when a request arrives over loopback WITHOUT the
  // auth-token header, use the daemon's own token instead of rejecting it. The
  // browser never sees the secret; a loopback caller is already the same OS user
  // on the same machine, which is exactly what the token proves. Off by default
  // -- the standalone daemon still requires the header. Only the same-origin
  // Vite dev mount turns this on.
  trustLoopbackToken?: boolean;
}

// A request is loopback when its peer address is the local host. Used only to
// gate the dev-server token convenience above; a bound-to-0.0.0.0 dev server
// reached from another host is NOT loopback and still needs the header.
function isAoiHostBridgeLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
    let token = Array.isArray(tokenHeader) ? (tokenHeader[0] ?? null) : (tokenHeader ?? null);
    if (!token && options.trustLoopbackToken && isAoiHostBridgeLoopbackRequest(req)) {
      token = loadAoiHostBridgeToken(openroomHome);
    }

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
