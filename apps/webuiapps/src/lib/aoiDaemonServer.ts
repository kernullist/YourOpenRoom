import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { homedir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  createAoiAutonomyMiddleware,
  startAoiAutonomyBackgroundFromEnv,
  startAoiMemoryEmbedSweepFromEnv,
  type AoiAutonomyMiddleware,
  type AoiAutonomyPluginOptions,
} from './aoiAutonomyPlugin';
import type { AoiAutonomyBackgroundRunnerHandle } from './aoiAutonomyBackgroundRunner';
import type { AoiMemoryEmbedSweepHandle } from './aoiMemoryEmbedSweep';
import { createSessionDataMiddleware, type SessionDataMiddleware } from './sessionDataServer';

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
//   - The background loop stays OFF unless AOI_AUTONOMY_BACKGROUND is opted in;
//     running the daemon with the flag unset only serves the inspection routes.
//   - Every execution gate (L5 + content-addressed approval for irreversible
//     effects, SSRF / DNS-rebind guards, and the structural no-self-promotion
//     barrier) lives in the reused modules and is not relaxed here.
//   - Loopback-only bind by default: the control surface includes side-effecting
//     routes (proposal/execute, policy), so it must never reach a public
//     interface without a deliberate opt-in plus an authenticating proxy.

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

  const autonomyMiddleware: AoiAutonomyMiddleware = createAoiAutonomyMiddleware(pluginOptions);
  // Durable session-data store (browser memory / chat / disk writes). Mounting it
  // here lets a daemon-hosted deployment persist browser captures without the
  // Vite-only middleware. Same on-disk root as the autonomy loop and the dev
  // server -- no data migration. Idle until a browser is pointed at the daemon.
  const sessionDataMiddleware: SessionDataMiddleware = createSessionDataMiddleware({
    sessionsDir: pluginOptions.sessionsDir,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Native http has no next(); chain the shared middlewares (autonomy first,
    // then session-data) and turn anything neither owns into a 404.
    autonomyMiddleware(req, res, () => {
      sessionDataMiddleware(req, res, () => {
        writeNotFound(res);
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
  const backgroundHandle: AoiAutonomyBackgroundRunnerHandle | null =
    startAoiAutonomyBackgroundFromEnv(pluginOptions, env, { defaultStart: true });
  // Loop-independent memory embed sweep (OFF unless AOI_AUTONOMY_EMBED_SWEEP is
  // opted in). Started AFTER the loop so an enabled loop holds the single-instance
  // lock and the sweep no-ops; the sweep only embeds when the loop is off. Its
  // interval is unref'd, so like the loop it never keeps the process alive on its
  // own -- the listening server does.
  const sweepHandle: AoiMemoryEmbedSweepHandle | null = startAoiMemoryEmbedSweepFromEnv(
    pluginOptions,
    env,
  );

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : desiredPort;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    backgroundHandle?.stop();
    sweepHandle?.stop();
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
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
  const home = homedir();
  return {
    sessionsDir: env.AOI_DAEMON_SESSIONS_DIR ?? resolve(home, '.openroom', 'sessions'),
    configFile: env.AOI_DAEMON_CONFIG_FILE ?? resolve(home, '.openroom', 'config.json'),
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

if (isMainEntry()) {
  void runAoiDaemonMain().catch((error) => {
    logError('failed to start', error);
    process.exit(1);
  });
}
