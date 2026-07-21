// Aoi browser-drive (BD) session manager (P0.2): launch a CDP-attachable instance
// of the operator's OWN Chrome/Edge, wait for the DevTools handshake, connect over
// CDP with Playwright, and open an Aoi-only page to drive. This is the runtime that
// realizes "act on my already-logged-in browser on my behalf".
//
// SERVER-ONLY (child_process / fs / net / lazy playwright-core). Every external
// effect is an injectable dependency so the whole flow is unit-testable WITHOUT a
// real browser or Playwright; production defaults resolve the real impls. Nothing
// here is wired to a route/tool yet -> importing this changes no runtime behavior.
//
// Safety posture (see JARVIS/05-browser-drive-roadmap.md):
//   - The caller enforces the os_browser_drive kill-switch + browser-drive consent
//     BEFORE starting a session; this module is the transport, not the gate.
//   - Teardown closes ONLY the page(s) Aoi opened. It never closes the shared
//     browser (that would kill the user's live session); the launcher owns the
//     browser process lifecycle.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { join } from 'path';
import {
  type AoiBrowserDriveEngine,
  type AoiDevToolsActivePort,
  buildAoiBrowserDriveCdpHttpEndpoint,
  buildAoiBrowserDriveLaunchArgs,
  parseAoiDevToolsActivePort,
  resolveAoiBrowserDriveDefaultUserDataDir,
} from './aoiBrowserDrive';
import { resolveAoiHostBrowserExecutable } from './aoiHostBrowserRead';

const DEFAULT_ATTACH_TIMEOUT_MS = 20_000;
const MAX_ATTACH_TIMEOUT_MS = 60_000;
const DEVTOOLS_POLL_INTERVAL_MS = 150;
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

export type AoiBrowserDriveStartDenyReason =
  | 'browser_not_found'
  | 'user_data_dir_unresolved'
  | 'port_unavailable'
  | 'spawn_failed'
  | 'attach_timeout'
  | 'connect_failed';

// Minimal structural surface of the Playwright objects we use -- avoids a static
// import of playwright-core (kept lazy + injectable) and keeps the client bundle
// free of it.
export interface AoiBrowserDrivePage {
  url(): string;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
}

export interface AoiBrowserDriveContext {
  newPage(): Promise<AoiBrowserDrivePage>;
}

export interface AoiBrowserDriveBrowser {
  contexts(): AoiBrowserDriveContext[];
  isConnected(): boolean;
  close(): Promise<void>;
}

export type AoiBrowserDriveConnect = (cdpHttpEndpoint: string) => Promise<AoiBrowserDriveBrowser>;

export interface AoiBrowserDriveStartOptions {
  userDataDir?: string;
  engine?: AoiBrowserDriveEngine;
  headless?: boolean;
  timeoutMs?: number;
  browserExecutablePath?: string;
}

export interface AoiBrowserDriveSessionDeps {
  spawnImpl?: typeof spawn;
  resolveExecutable?: (overridePath?: string) => { path: string; engine: string } | null;
  pickPort?: () => Promise<number>;
  resolveDefaultUserDataDir?: (engine: AoiBrowserDriveEngine) => string | null;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  connect?: AoiBrowserDriveConnect;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AoiBrowserDriveSession {
  browser: AoiBrowserDriveBrowser;
  page: AoiBrowserDrivePage;
  port: number;
  cdpHttpEndpoint: string;
  engine: AoiBrowserDriveEngine;
  userDataDir: string;
  child: ChildProcess | null;
  close(): Promise<void>;
}

export class AoiBrowserDriveStartError extends Error {
  readonly reason: AoiBrowserDriveStartDenyReason;

  constructor(reason: AoiBrowserDriveStartDenyReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'AoiBrowserDriveStartError';
    this.reason = reason;
  }
}

/** Bind an ephemeral loopback TCP port, then release it so Chrome can claim it. */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('could not resolve an ephemeral port')));
    });
  });
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `<userDataDir>/DevToolsActivePort` until Chrome writes the port/ws handshake
 * (proving the debug endpoint is live), or the deadline passes. If the file never
 * appears, the profile was likely already locked by a running browser without the
 * debug flag -> attach_timeout.
 */
export async function pollForAoiDevToolsActivePort(params: {
  userDataDir: string;
  timeoutMs: number;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<AoiDevToolsActivePort> {
  const filePath = join(params.userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
  const deadline = params.now() + Math.max(1, params.timeoutMs);
  // Try immediately, then poll until the deadline.
  for (;;) {
    if (params.fileExists(filePath)) {
      try {
        const parsed = parseAoiDevToolsActivePort(params.readFile(filePath));
        if (parsed) {
          return parsed;
        }
      } catch {
        // File may be mid-write; fall through and retry.
      }
    }
    if (params.now() >= deadline) {
      throw new AoiBrowserDriveStartError('attach_timeout', 'DevToolsActivePort never appeared');
    }
    await params.sleep(DEVTOOLS_POLL_INTERVAL_MS);
  }
}

const lazyConnect: AoiBrowserDriveConnect = async (cdpHttpEndpoint) => {
  // Lazy runtime import so the client bundle never pulls playwright-core and the
  // daemon externalizes it. Structurally typed to our minimal surface.
  const mod = (await import('playwright-core')) as unknown as {
    chromium: { connectOverCDP: (endpoint: string) => Promise<AoiBrowserDriveBrowser> };
  };
  return mod.chromium.connectOverCDP(cdpHttpEndpoint);
};

/**
 * Launch + attach + open an Aoi-only page. Returns a session handle whose close()
 * tears down ONLY the Aoi page (never the shared browser).
 */
export async function startAoiBrowserDriveSession(
  options: AoiBrowserDriveStartOptions = {},
  deps: AoiBrowserDriveSessionDeps = {},
): Promise<AoiBrowserDriveSession> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const resolveExecutable =
    deps.resolveExecutable ??
    ((overridePath?: string) => resolveAoiHostBrowserExecutable({ overridePath }));
  const pickPort = deps.pickPort ?? pickFreeLoopbackPort;
  const readFile = deps.readFile ?? ((path: string) => fs.readFileSync(path, 'utf8'));
  const fileExists = deps.fileExists ?? ((path: string) => fs.existsSync(path));
  const connect = deps.connect ?? lazyConnect;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;

  const engine: AoiBrowserDriveEngine = options.engine === 'edge' ? 'edge' : 'chrome';
  const executable = resolveExecutable(options.browserExecutablePath);
  if (!executable) {
    throw new AoiBrowserDriveStartError('browser_not_found', 'no Chrome/Edge executable resolved');
  }

  const resolveDefaultUserDataDir =
    deps.resolveDefaultUserDataDir ??
    ((engineKind: AoiBrowserDriveEngine) => resolveAoiBrowserDriveDefaultUserDataDir(engineKind));
  const userDataDir =
    (typeof options.userDataDir === 'string' ? options.userDataDir.trim() : '') ||
    resolveDefaultUserDataDir(engine) ||
    '';
  if (!userDataDir) {
    throw new AoiBrowserDriveStartError('user_data_dir_unresolved');
  }

  let port: number;
  try {
    port = await pickPort();
  } catch (error) {
    throw new AoiBrowserDriveStartError(
      'port_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }

  const args = buildAoiBrowserDriveLaunchArgs({
    port,
    userDataDir,
    headless: options.headless === true,
  });

  let child: ChildProcess;
  try {
    child = spawnImpl(executable.path, args, {
      shell: false,
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    });
  } catch (error) {
    throw new AoiBrowserDriveStartError(
      'spawn_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  const timeoutMs = Math.min(
    MAX_ATTACH_TIMEOUT_MS,
    Math.max(1_000, options.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS),
  );

  let handshake: AoiDevToolsActivePort;
  try {
    handshake = await pollForAoiDevToolsActivePort({
      userDataDir,
      timeoutMs,
      fileExists,
      readFile,
      now,
      sleep,
    });
  } catch (error) {
    safeKill(child);
    if (error instanceof AoiBrowserDriveStartError) {
      throw error;
    }
    throw new AoiBrowserDriveStartError(
      'attach_timeout',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Chrome may pick its own port (we passed a concrete one, but honor the handshake).
  const cdpHttpEndpoint = buildAoiBrowserDriveCdpHttpEndpoint(handshake.port);

  let browser: AoiBrowserDriveBrowser;
  try {
    browser = await connect(cdpHttpEndpoint);
  } catch (error) {
    safeKill(child);
    throw new AoiBrowserDriveStartError(
      'connect_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  let page: AoiBrowserDrivePage;
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('no browser context available over CDP');
    }
    page = await context.newPage();
  } catch (error) {
    // Do NOT kill the shared browser on a page-open failure; just drop the connection.
    await safeCloseBrowser(browser);
    throw new AoiBrowserDriveStartError(
      'connect_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // Close ONLY Aoi's page; the shared browser stays up (the user is using it).
    try {
      await page.close();
    } catch {
      // best-effort teardown
    }
  };

  return {
    browser,
    page,
    port: handshake.port,
    cdpHttpEndpoint,
    engine,
    userDataDir,
    child,
    close,
  };
}

function safeKill(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // best-effort
  }
}

async function safeCloseBrowser(browser: AoiBrowserDriveBrowser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // best-effort
  }
}
