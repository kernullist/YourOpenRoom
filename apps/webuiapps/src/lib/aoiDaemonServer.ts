import { spawn } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { homedir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { superviseAoiDaemon } from './aoiDaemonSupervisor';
import {
  igniteAoiActiveAssistant,
  sleepAoiActiveAssistant,
  resolveAoiIgnitionCommand,
  type AoiIgnitionCommand,
} from './aoiActiveAssistantPolicy';
import {
  createAoiAutonomyMiddleware,
  startAoiAutonomyBackgroundFromEnv,
  startAoiMemoryEmbedSweepFromEnv,
  type AoiAutonomyMiddleware,
  type AoiAutonomyPluginOptions,
} from './aoiAutonomyPlugin';
import type { AoiAutonomyBackgroundRunnerHandle } from './aoiAutonomyBackgroundRunner';
import type { AoiMemoryEmbedSweepHandle } from './aoiMemoryEmbedSweep';
import { createAoiResearchMiddleware, type AoiResearchMiddleware } from './aoiResearchPlugin';
import { createAoiHostBridgeMiddleware, type AoiHostBridgeMiddleware } from './aoiHostBridgePlugin';
import { createIdaSqlMiddleware, type IdaSqlMiddleware } from './idaSqlPlugin';
import { ensureAoiHostBridgeToken } from './aoiHostBridgeAuth';
import { createSessionDataMiddleware, type SessionDataMiddleware } from './sessionDataServer';
import {
  createAoiDaemonHealthHooks,
  createAoiDaemonHealthTracker,
  type AoiDaemonHealthSnapshot,
  type AoiDaemonHealthTracker,
} from './aoiDaemonHealth';
import { recordAoiDaemonCycleFlightRecords } from './aoiDaemonFlightRecorder';

// Standalone headless autonomy daemon.
//
// This lifts the autonomy HTTP routes + the self-initiating background loop out
// of the Vite plugin (which only runs inside the dev/preview server) into a
// process that can run 24/7. It REUSES the plugin's request/loop factories
// (createAoiAutonomyMiddleware / startAoiAutonomyBackgroundFromEnv), so there is
// no forked routing or loop logic -- the daemon and the Vite plugin share one
// implementation and one on-disk session store.
//
// Safety posture (unchanged from the plugin):
//   - The daemon is a dedicated autonomy host, so it starts the background loop
//     by DEFAULT (defaultStart) -- AOI_AUTONOMY_BACKGROUND=0 is the hard-off
//     ceiling. The loop merely ticks; per-session policy.enabled (default false)
//     is the actual on/off, so a fresh daemon idles safely (every session
//     skipped) until the operator enables one from the settings UI. (An earlier
//     version of this comment claimed the loop was OFF-by-default; that describes
//     the Vite plugin, not the daemon -- see startAoiAutonomyBackgroundFromEnv.)
//   - Every execution gate (L5 + content-addressed approval for irreversible
//     effects, SSRF / DNS-rebind guards, and the structural no-self-promotion
//     barrier) lives in the reused modules and is not relaxed here.
//   - Loopback-only bind by default: the control surface includes side-effecting
//     routes (proposal/execute, policy), so it must never reach a public
//     interface without a deliberate opt-in plus an authenticating proxy.
//   - GET /healthz is an unauthenticated, metadata-only readiness probe (uptime,
//     loop-running, per-cycle counts, error total) with no session content.

const DEFAULT_DAEMON_HOST = '127.0.0.1';
const DEFAULT_DAEMON_PORT = 7333;

export interface AoiDaemonOptions {
  sessionsDir: string;
  configFile: string;
  workspaceRoot?: string;
  host?: string;
  // 0 binds an ephemeral port (used by tests). Defaults to DEFAULT_DAEMON_PORT.
  port?: number;
  // Env source for the background-loop gate. Defaults to process.env.
  env?: Record<string, string | undefined>;
}

export interface AoiDaemonHandle {
  server: Server;
  host: string;
  // The actually-bound port (resolved even when options.port was 0).
  port: number;
  // True when the env-gated background loop is running in this daemon.
  backgroundRunning: boolean;
  // Idempotent: stops the loop and closes the server.
  close: () => Promise<void>;
}

function writeNotFound(res: ServerResponse): void {
  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'Not found.', code: 'route_not_found' }));
}

function writeHealth(res: ServerResponse, snapshot: AoiDaemonHealthSnapshot): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(snapshot));
}

// GET /healthz (and the trailing-query form) -- a metadata-only readiness probe.
function isHealthzRequest(req: IncomingMessage): boolean {
  if ((req.method ?? 'GET') !== 'GET') {
    return false;
  }
  const url = req.url ?? '';
  return url === '/healthz' || url.startsWith('/healthz?');
}

// POST /shutdown -- a loopback-only graceful-stop trigger (P0.3). Lets Stop-App.ps1
// end the daemon cleanly (release the loop lock, close the server) before falling
// back to a force-kill, so the SIGINT/SIGTERM graceful path is actually exercised
// on Windows (where Stop-Process -Force never raises those signals).
function isShutdownRequest(req: IncomingMessage): boolean {
  if ((req.method ?? 'GET') !== 'POST') {
    return false;
  }
  const url = req.url ?? '';
  return url === '/shutdown' || url.startsWith('/shutdown?');
}

// Boot a headless autonomy server: serves /api/aoi-autonomy/* and (when opted
// in via env) runs the background loop. Does NOT install signal handlers or
// read process.argv -- that is the entrypoint's job (runAoiDaemonMain), which
// keeps this function safe to import and exercise from tests.
export async function startAoiDaemon(options: AoiDaemonOptions): Promise<AoiDaemonHandle> {
  const host = options.host ?? DEFAULT_DAEMON_HOST;
  const desiredPort = options.port ?? DEFAULT_DAEMON_PORT;
  const env = options.env ?? process.env;
  const pluginOptions: AoiAutonomyPluginOptions = {
    sessionsDir: options.sessionsDir,
    configFile: options.configFile,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
  };

  // Durable session-data store (browser memory / chat / disk writes). Mounting it
  // here lets a daemon-hosted deployment persist browser captures without the
  // Vite-only middleware. Same on-disk root as the autonomy loop and the dev
  // server -- no data migration. Idle until a browser is pointed at the daemon.
  const sessionDataMiddleware: SessionDataMiddleware = createSessionDataMiddleware({
    sessionsDir: pluginOptions.sessionsDir,
  });
  const researchMiddleware: AoiResearchMiddleware = createAoiResearchMiddleware({
    sessionsDir: pluginOptions.sessionsDir,
    configFile: pluginOptions.configFile,
  });

  // Real-PC host-bridge control surface (/api/aoi-host/*). It shares the same
  // ~/.openroom root as the session store; the auth token + kill switch live
  // under ~/.openroom/host-bridge/. Mint the token at boot so a client can
  // authenticate; a failure here is non-fatal (the routes reject unauthenticated
  // callers regardless).
  const openroomHome = resolve(pluginOptions.sessionsDir, '..');
  try {
    const tokenResult = ensureAoiHostBridgeToken(openroomHome);
    if (!tokenResult.aclApplied && tokenResult.aclReason) {
      logInfo(`host-bridge token ACL not applied (${tokenResult.aclReason}); relying on file mode`);
    }
  } catch (error) {
    logError('failed to ensure the host-bridge auth token', error);
  }
  const hostBridgeMiddleware: AoiHostBridgeMiddleware = createAoiHostBridgeMiddleware({
    sessionsDir: pluginOptions.sessionsDir,
    openroomHome,
  });

  // IDA Lab (/api/ida-sql/*). Mounted here so the autonomous loop can reach the
  // same session registry the browser does -- with the same kill-switch,
  // containment and approval gates. Note the sessions themselves are
  // process-scoped: a session the daemon started is not visible to the dev
  // server and vice versa.
  const idaSqlMiddleware: IdaSqlMiddleware = createIdaSqlMiddleware({
    configFile: pluginOptions.configFile,
    sessionsDir: pluginOptions.sessionsDir,
    openroomHome,
  });

  // Observability: the health tracker reads loop-running via a thunk so it can be
  // created here (before the post-listen loop start) without a boot-ordering dance.
  const bootAt = Date.now();
  let backgroundHandle: AoiAutonomyBackgroundRunnerHandle | null = null;
  const health: AoiDaemonHealthTracker = createAoiDaemonHealthTracker({
    startedAt: bootAt,
    loopRunning: () => backgroundHandle !== null,
  });
  pluginOptions.getDaemonHealthSnapshot = (now) => health.snapshot(now);
  const autonomyMiddleware: AoiAutonomyMiddleware = createAoiAutonomyMiddleware(pluginOptions);
  // Forward reference: assigned once close() is defined below, so the /shutdown
  // handler can trigger a graceful stop. A no-op until then (no request can arrive
  // before listen() resolves and the sync boot block finishes assigning it).
  let requestShutdown: () => void = () => {};

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Cheap, session-less readiness probe answered before any autonomy routing.
    if (isHealthzRequest(req)) {
      writeHealth(res, health.snapshot(Date.now()));
      return;
    }
    // Loopback-only graceful-stop trigger: ack first, then close on a later tick so
    // the 200 flushes before the socket goes away.
    if (isShutdownRequest(req)) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true, shuttingDown: true }));
      requestShutdown();
      return;
    }
    // Native http has no next(); chain the shared middlewares (autonomy first,
    // then host-bridge, IDA Lab, research, and session-data) and turn anything
    // none owns into a 404. The host-bridge and IDA Lab routes are
    // token-authenticated internally.
    autonomyMiddleware(req, res, () => {
      hostBridgeMiddleware(req, res, () => {
        idaSqlMiddleware(req, res, () => {
          researchMiddleware(req, res, () => {
            sessionDataMiddleware(req, res, () => {
              writeNotFound(res);
            });
          });
        });
      });
    });
  });

  // Bind first, so a port conflict fails before the loop is ever started (no
  // dangling interval to clean up on a failed boot).
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      rejectListen(error);
    };
    server.once('error', onError);
    server.listen(desiredPort, host, () => {
      server.removeListener('error', onError);
      resolveListen();
    });
  });

  // The background loop's interval is unref'd, so the listening server is what
  // keeps the process alive -- exactly what a daemon wants. The daemon is a
  // dedicated autonomy host, so it starts the loop by DEFAULT (defaultStart) --
  // the operator turns Aoi on/off from the settings UI (per-session policy.enabled,
  // default false -> a safe idle no-op) without touching env. Null only when
  // AOI_AUTONOMY_BACKGROUND is explicitly off (hard ceiling).
  const healthHooks = createAoiDaemonHealthHooks({
    tracker: health,
    now: Date.now,
    logCycle: logInfo,
    logError: (error) => logError('background cycle failed', error),
  });
  backgroundHandle = startAoiAutonomyBackgroundFromEnv(pluginOptions, env, {
    defaultStart: true,
    runImmediately: true,
    onCycle: (result) => {
      healthHooks.onCycle(result);
      // P2.4: mirror each self-initiated background wakeup into the operator flight
      // recorder so headless 24/7 activity is auditable in the same surface as
      // foreground decisions. recordAoiDaemonCycleFlightRecords is best-effort
      // internally -- a record write never stalls the loop.
      recordAoiDaemonCycleFlightRecords(pluginOptions.sessionsDir, result);
    },
    onError: healthHooks.onError,
  });
  // Loop-independent memory maintenance sweep (OFF unless opted in). Started only
  // when this process did NOT start the loop: the loop's own tick performs the same
  // embedding and consolidation, so a sweep here would be dead weight competing for
  // the same single-instance lock. In practice the daemon runs the loop and a dev
  // server runs the sweep. Its interval is unref'd, so like the loop it never keeps
  // the process alive on its own -- the listening server does.
  const sweepHandle: AoiMemoryEmbedSweepHandle | null = backgroundHandle
    ? null
    : startAoiMemoryEmbedSweepFromEnv(pluginOptions, env);

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : desiredPort;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // Await the drain: a graceful stop must not release the single-instance lock
    // (or exit) while a cycle is still writing the session store.
    await backgroundHandle?.stop();
    await sweepHandle?.stop();
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
  };

  // Wire the /shutdown handler now that close() exists. Deferred a tick so the 200
  // response flushes before the server stops accepting connections.
  requestShutdown = () => {
    setTimeout(() => {
      void close();
    }, 10);
  };

  return {
    server,
    host,
    port,
    backgroundRunning: backgroundHandle !== null,
    close,
  };
}

function parsePortEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  // Allow 0 (ephemeral) through 65535; fall back on anything out of range.
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

// Resolve daemon options from env, defaulting to the SAME paths the Vite config
// passes to aoiAutonomyPlugin (~/.openroom/{config.json,sessions}) so the daemon
// shares one data store with the dev server and the browser by default.
export function resolveAoiDaemonOptionsFromEnv(
  env: Record<string, string | undefined>,
): AoiDaemonOptions {
  // OPENROOM_HOME is what the dev server resolves its config and sessions under.
  // Honouring it here keeps the two pointed at the SAME files: the operator's
  // settings now decide autonomy capabilities, and a daemon reading a different
  // config.json would leave every toggle silently doing nothing.
  const openroomHome = env.OPENROOM_HOME
    ? resolve(env.OPENROOM_HOME)
    : resolve(homedir(), '.openroom');
  return {
    sessionsDir: env.AOI_DAEMON_SESSIONS_DIR ?? resolve(openroomHome, 'sessions'),
    configFile: env.AOI_DAEMON_CONFIG_FILE ?? resolve(openroomHome, 'config.json'),
    workspaceRoot: env.AOI_DAEMON_WORKSPACE_ROOT ?? process.cwd(),
    host: env.AOI_DAEMON_HOST ?? DEFAULT_DAEMON_HOST,
    port: parsePortEnv(env.AOI_DAEMON_PORT, DEFAULT_DAEMON_PORT),
    env,
  };
}

function logInfo(message: string): void {
  // ASCII-only operational logging for the headless service.
  console.info(`[aoi-daemon] ${message}`);
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[aoi-daemon] ${message}: ${detail}`);
}

// Full entrypoint: boot the daemon from env and wire process lifecycle
// (graceful shutdown on SIGINT/SIGTERM, fatal-isolation handlers). Returns the
// handle so a supervising caller can inspect/close it.
export async function runAoiDaemonMain(
  env: Record<string, string | undefined> = process.env,
): Promise<AoiDaemonHandle> {
  const options = resolveAoiDaemonOptionsFromEnv(env);
  const handle = await startAoiDaemon(options);
  logInfo(`listening on http://${handle.host}:${handle.port}`);
  logInfo(`sessions dir: ${options.sessionsDir}`);
  logInfo(
    handle.backgroundRunning
      ? 'background loop: RUNNING (per-session autonomy is controlled from the settings UI; ' +
          'set AOI_AUTONOMY_BACKGROUND=0 to hard-disable)'
      : 'background loop: OFF (AOI_AUTONOMY_BACKGROUND=0, or another process owns the lock)',
  );

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo(`received ${signal}, shutting down gracefully...`);
    try {
      await handle.close();
    } catch (error) {
      logError('error during shutdown', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
  // Per-cycle and per-session errors are already isolated inside the background
  // runner; an uncaught exception here means an unexpected fatal state. Close
  // cleanly and exit non-zero so a process supervisor can restart us from a
  // known-good state (all autonomy state is durable on disk).
  process.on('uncaughtException', (error) => {
    logError('uncaughtException (fatal, exiting)', error);
    handle
      .close()
      .catch(() => undefined)
      .finally(() => {
        process.exit(1);
      });
  });
  // Unhandled rejections are logged but non-fatal: the loop wraps each cycle in
  // its own try/catch, so the service keeps serving.
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection (non-fatal)', reason);
  });

  return handle;
}

// Auto-start ONLY when this module is the executed entrypoint
// (node dist-daemon/aoiDaemonServer.js). When imported (tests, other modules)
// it stays inert: no port binding, no signal handlers. Fails safe -- any error
// resolving the entry path yields false, so an import never auto-runs.
function isMainEntry(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) {
      return false;
    }
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Supervisor entry (P0.1): `node aoiDaemonServer.js --supervise` keeps a child
// daemon (this same bundle, run without --supervise) alive across crashes with
// restart-on-exit + backoff + crash-loop give-up. The restart brain lives in
// aoiDaemonSupervisor (fully unit-tested); this is the thin real-process adapter
// (spawn / signal wiring), the same untested-entry-glue class as runAoiDaemonMain.
function runAoiDaemonSupervisorMain(): void {
  const selfPath = fileURLToPath(import.meta.url);
  logInfo('supervisor: keeping the Aoi daemon alive (restart-on-crash + crash-loop guard).');
  const handle = superviseAoiDaemon({
    spawnChild: () => {
      const child = spawn(process.execPath, [selfPath], { stdio: 'inherit', env: process.env });
      return {
        onExit: (listener) => {
          child.on('exit', (code) => listener(code));
        },
        kill: () => {
          child.kill();
        },
      };
    },
    onEvent: (event) => {
      if (event.type === 'gave_up') {
        logError(
          'supervisor: the daemon is crash-looping; giving up',
          `${event.recentCrashes} crashes inside the window`,
        );
        process.exit(1);
      } else if (event.type === 'crashed') {
        logInfo(
          `supervisor: daemon exited (code ${event.code}); restart #${event.recentCrashes} in ${event.restartInMs}ms`,
        );
      } else {
        logInfo(`supervisor: ${event.type}`);
      }
    },
  });
  const stop = (signal: string): void => {
    logInfo(`supervisor received ${signal}, stopping the daemon.`);
    handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

// Ignition entry: `node aoiDaemonServer.js --ignite [sessionPath]` wakes Aoi into the SAFE
// active-assistant tier (proposes / reaches out / reasons / learns; every real action stays
// supervised; autonomous self-execution stays OFF -- it is env-gated, unreachable from a policy).
// `--sleep [sessionPath]` reverts. This writes the session policy and exits; it does not boot the
// server. Idempotent and reversible.
function runAoiIgnitionCliMain(
  command: AoiIgnitionCommand,
  env: Record<string, string | undefined>,
): void {
  const { sessionsDir } = resolveAoiDaemonOptionsFromEnv(env);
  const result =
    command.action === 'ignite'
      ? igniteAoiActiveAssistant({ sessionsDir, sessionPath: command.sessionPath })
      : sleepAoiActiveAssistant({ sessionsDir, sessionPath: command.sessionPath });
  logInfo(`sessions dir: ${sessionsDir}`);
  if (command.action === 'ignite') {
    logInfo(
      `Aoi ACTIVE-ASSISTANT ignited for ${result.sessionPath}` +
        (result.wasEnabled ? ' (was already enabled; refreshed).' : '.'),
    );
    logInfo(
      'It now proposes, reaches out, reasons, and earns trust -- but every real action stays ' +
        'behind your approval. Autonomous self-execution is OFF (env-gated, unreachable here).',
    );
  } else {
    logInfo(`Aoi returned to DORMANT for ${result.sessionPath} (all autonomy layers off).`);
  }
  logInfo(
    `enabled=${result.policy.enabled} previewMode=${result.policy.previewMode} ` +
      `proactive=${result.policy.proactiveSuggestionsEnabled} cognition=${result.policy.agenticReflectionEnabled} ` +
      `fieldShadow=${result.policy.fieldShadowCaptureEnabled} directChatOptIn=${result.policy.proactiveBriefing.directChatHookOptIn}`,
  );
  if (command.action === 'ignite') {
    logInfo('Keep the daemon running (or a client mounted) for the loop to act on this.');
  }
}

if (isMainEntry()) {
  const ignition = resolveAoiIgnitionCommand(process.argv);
  if (ignition) {
    try {
      runAoiIgnitionCliMain(ignition, process.env);
    } catch (error) {
      logError('ignition failed', error);
      process.exit(1);
    }
  } else if (process.argv.includes('--supervise')) {
    runAoiDaemonSupervisorMain();
  } else {
    void runAoiDaemonMain().catch((error) => {
      logError('failed to start', error);
      process.exit(1);
    });
  }
}
