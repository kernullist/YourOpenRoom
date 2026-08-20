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
import { resolve } from 'path';
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
import {
  attachAoiBrowserDriveDialogs,
  attachAoiBrowserDriveTabs,
  downloadAoiBrowserDriveFile,
  type AoiBrowserDriveDownloadablePage,
  type AoiBrowserDriveRawContext,
  type AoiBrowserDriveRawPage,
} from './aoiBrowserDrivePageAdapter';

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
  // Ask the browser's own DevTools HTTP endpoint who it is. See the handshake
  // below for why this exists at all.
  probeDevTools?: (port: number) => Promise<string | null>;
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
/**
 * Ask http://127.0.0.1:<port>/json/version for the browser WebSocket URL.
 *
 * This replaced waiting for a DevToolsActivePort FILE, which current Chrome no
 * longer writes. Verified against Chrome 151: the browser starts, DevTools
 * listens, and that file appears nowhere -- not in the profile, not in temp --
 * so the wait could only ever time out. Worse, it timed out as "attach_timeout:
 * DevToolsActivePort never appeared", which reads as "the browser did not
 * start" when the browser had started perfectly well.
 *
 * The HTTP endpoint is the documented way to discover this and answered in
 * ~400ms on the same machine. The port is ours -- we pass it on the command
 * line -- so nothing is being guessed here.
 */
async function probeAoiDevToolsEndpoint(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      // The endpoint is loopback and answers instantly when it is up; a long
      // wait here would just delay the retry.
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    const url = payload?.webSocketDebuggerUrl;
    return typeof url === 'string' && url.startsWith('ws://') ? url : null;
  } catch {
    // Not up yet, or not answering. The caller retries.
    return null;
  }
}

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
  const probeDevTools = deps.probeDevTools ?? probeAoiDevToolsEndpoint;
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
  // The profile is REQUIRED; there is deliberately no fallback.
  //
  // The obvious fallback -- the browser's own default profile -- is the one
  // directory that can never work: Chrome 136+ refuses remote debugging there.
  // Falling back to it produced an attempt that looked reasonable and then
  // failed seconds later complaining about a missing DevTools port, which is a
  // symptom of an entirely different problem and sends you looking in the wrong
  // place. A caller with no profile has not been configured yet, and hearing
  // that immediately is more useful than a plausible-looking failure.
  const userDataDir = typeof options.userDataDir === 'string' ? options.userDataDir.trim() : '';
  if (!userDataDir) {
    throw new AoiBrowserDriveStartError(
      'user_data_dir_unresolved',
      'no browser profile is configured. Chrome refuses remote debugging on its own default ' +
        'profile, so this needs a separate signed-in profile directory: set it in Settings > ' +
        'Advanced > Host bridge > Browser profile.',
    );
  }

  // And refuse the default profile even when it is named explicitly, so the same
  // impossible configuration cannot be reached the long way round.
  //
  // BOTH engines, not just the one being launched. The settings route validates
  // against both, but a hand-edited config never passes through it, and pointing
  // Chrome at Edge's default directory is just as unusable as pointing it at its
  // own -- checking only the launching engine would let exactly that through.
  const requestedDir = resolve(userDataDir).toLowerCase();
  const browserDefault = (['chrome', 'edge'] as const)
    .map((kind) => resolveDefaultUserDataDir(kind))
    .find((dir) => Boolean(dir) && resolve(dir as string).toLowerCase() === requestedDir);
  if (browserDefault) {
    throw new AoiBrowserDriveStartError(
      'user_data_dir_unresolved',
      'that is the browser default profile, which refuses remote debugging. Use a separate ' +
        'signed-in profile directory.',
    );
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
    // Ask the browser directly first. The DevToolsActivePort file is a legacy
    // signal that current Chrome does not write at all, so the file poll is kept
    // only as a fallback for older builds -- it can no longer be the primary
    // path without the attach failing on every modern browser.
    const deadline = now() + timeoutMs;
    const probeIntervalMs = 200;
    // Bounded by BOTH the clock and a count. The clock is injected, so a caller
    // that holds it still -- every test harness does -- would otherwise turn
    // this into a tight loop that never ends and never reports anything.
    const maxProbes = Math.max(1, Math.ceil(timeoutMs / probeIntervalMs));
    let socketUrl: string | null = null;
    for (let attempt = 0; attempt < maxProbes && now() < deadline; attempt += 1) {
      socketUrl = await probeDevTools(port);
      if (socketUrl) {
        break;
      }
      await sleep(probeIntervalMs);
    }
    if (socketUrl) {
      const wsPath = (() => {
        try {
          return new URL(socketUrl).pathname;
        } catch {
          return '';
        }
      })();
      handshake = { port, wsPath };
    } else {
      handshake = await pollForAoiDevToolsActivePort({
        userDataDir,
        // Whatever is left of the budget; the probe already spent most of it.
        timeoutMs: Math.max(1_000, deadline - now()),
        fileExists,
        readFile,
        now,
        sleep,
      });
    }
  } catch (error) {
    safeKill(child);
    if (error instanceof AoiBrowserDriveStartError && error.reason === 'attach_timeout') {
      // A browser already running on this profile is the usual cause, and it
      // fails in the least helpful way: the second launch hands its command line
      // to the running instance and exits, so no debug port ever opens and the
      // wait times out talking about DevTools. Chrome keeps a `lockfile` in the
      // profile while it is running, so say what is actually in the way.
      //
      // Reported, not enforced: a crashed browser can leave the file behind, and
      // refusing on a stale marker would block a profile that is perfectly free.
      let profileBusy = false;
      try {
        profileBusy =
          fileExists(`${userDataDir}\\lockfile`) || fileExists(`${userDataDir}/lockfile`);
      } catch {
        profileBusy = false;
      }
      if (profileBusy) {
        throw new AoiBrowserDriveStartError(
          'attach_timeout',
          'the debug port never opened, and this profile has a lockfile. That usually means a ' +
            'browser window is open on it -- close the window and try again. If none is open, a ' +
            'previous browser was killed and left the file behind; deleting it is safe.',
        );
      }
    }
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

  // Playwright's Page covers click/fill/hover/dragAndDrop/setInputFiles
  // directly, but dialogs arrive as an EVENT and tabs live on the context, so
  // neither is reachable through the page alone. Attach both and expose them as
  // ordinary methods, which is what the executor's capability checks look for.
  //
  // Tab selection has to REDIRECT the page, not merely record a choice: every
  // later step goes through this same object, so a switch that did not redirect
  // would leave the caller acting on a tab nobody chose. Delivery is forwarded
  // to whichever page the tab handle says is current.
  // Detect, do not assume. The page contract this module declares is url() +
  // close(); everything else is a Playwright extra. A session factory that
  // satisfies the declared contract must not crash here, so each capability is
  // attached only if the underlying object really provides what it needs -- and
  // when it does not, the executor reports "this session cannot ..." , which is
  // the honest fail-closed answer rather than a TypeError mid-run.
  const rawPage = page as unknown as AoiBrowserDriveRawPage;
  const rawContext = browser.contexts()[0] as unknown as AoiBrowserDriveRawContext;
  const dialogs = typeof rawPage?.on === 'function' ? attachAoiBrowserDriveDialogs(rawPage) : null;
  const tabs =
    typeof rawContext?.pages === 'function' ? attachAoiBrowserDriveTabs(rawContext, rawPage) : null;

  const target = () => (tabs ? tabs.currentPage() : rawPage) as unknown as Record<string, unknown>;
  const own = page as unknown as Record<string, unknown>;

  // Keep the ORIGINAL methods before any of them are replaced.
  //
  // Forwarding cannot simply look the method up on the current page, because
  // when the current page is Aoi's own tab that IS the object whose methods were
  // replaced -- so the lookup finds the forwarder and calls itself until the
  // stack runs out. That is not an exotic case: it is every ordinary act, since
  // most drives never switch tabs at all.
  const originals = new Map<string, (...args: unknown[]) => unknown>();

  const forward =
    (method: string) =>
    (...args: unknown[]): unknown => {
      const current = target();
      // Own tab: use the method we saved, not the one we overwrote.
      const fn = current === own ? originals.get(method) : (current[method] as unknown);
      if (typeof fn !== 'function') {
        throw new Error(`the current tab cannot ${method}`);
      }
      return (fn as (...inner: unknown[]) => unknown).apply(current, args);
    };

  // Only the members the executor actually calls are forwarded; anything else
  // keeps pointing at the page this session opened.
  const FORWARDED = [
    'click',
    'fill',
    'selectOption',
    'press',
    'hover',
    'dragAndDrop',
    'setInputFiles',
    'goto',
    'goBack',
    'content',
    'title',
    'screenshot',
    'textContent',
    'getAttribute',
    'inputValue',
  ];
  const drivable = page as unknown as Record<string, unknown>;
  // Forwarding only matters when tabs can actually change which page is current.
  // Without that, rewriting these members would be pure indirection over the
  // same object -- and one more place for a mistake to hide.
  if (tabs) {
    for (const method of FORWARDED) {
      const existing = drivable[method];
      if (typeof existing === 'function') {
        // Bind to the page it came from: Playwright methods carry internal
        // state through `this`, and a detached reference would lose it.
        originals.set(method, (existing as (...args: unknown[]) => unknown).bind(page));
        drivable[method] = forward(method);
      }
    }
    const ownUrl = drivable.url;
    if (typeof ownUrl === 'function') {
      originals.set('url', (ownUrl as (...args: unknown[]) => unknown).bind(page));
    }
    drivable.url = () => {
      const current = target();
      const fn = current === own ? originals.get('url') : current.url;
      return typeof fn === 'function' ? (fn as () => string).call(current) : '';
    };
    drivable.listTabs = tabs.listTabs;
    drivable.selectTab = tabs.selectTab;
    drivable.returnToOwnTab = () => {
      tabs.returnToOwnTab();
    };
  }
  if (dialogs) {
    drivable.answerDialog = dialogs.answerDialog;
  }
  // Saving a download is the same story as dialogs: the file arrives as an event
  // and is discarded unless something writes it out, so a plain Page cannot do
  // it. Attached only when the page can actually wait for one.
  if (typeof (page as unknown as { waitForEvent?: unknown }).waitForEvent === 'function') {
    drivable.downloadTo = (selector: string, directory: string, opts?: { timeout?: number }) =>
      downloadAoiBrowserDriveFile(
        target() as unknown as AoiBrowserDriveDownloadablePage,
        selector,
        directory,
        opts ?? {},
      );
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // A queued dialog this session took responsibility for would otherwise keep
    // the operator's tab blocked after Aoi has gone.
    if (dialogs) {
      await dialogs.releasePendingDialogs().catch(() => {});
    }
    // Close ONLY Aoi's page; the shared browser stays up (the user is using it).
    try {
      await page.close();
    } catch {
      // best-effort teardown
    }
    // Then release the CDP client. Over connectOverCDP, close() DISCONNECTS --
    // measured against Chrome 151: the browser stays running, the operator's
    // tabs survive, and a later attach reconnects fine. Leaving it out did not
    // keep anything safe; it just leaked one websocket and one Playwright
    // browser object per act, for the whole life of the daemon.
    await safeCloseBrowser(browser);
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
