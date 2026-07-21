// Aoi browser-drive (BD) foundation: attach to the operator's OWN Chrome/Edge over
// the Chrome DevTools Protocol (CDP) so Aoi can act on already-logged-in sites on
// the user's behalf. This module is the PURE launch/endpoint layer -- it builds the
// CDP launch argv, resolves the pinned allow-origin, parses the DevToolsActivePort
// handshake file, and builds the connectOverCDP endpoints. No spawning and no
// Playwright here (that lives in the session manager); these helpers stay pure so
// they are fully unit-testable and both server- and browser-safe.
//
// Safety posture (load-bearing; see JARVIS/05-browser-drive-roadmap.md):
//   - CAPABILITY + CONSENT: kill-switch key `os_browser_drive`, environment source
//     `browser-drive` (the caller enforces the gate; this module is data-only).
//   - THE DEBUG PORT IS AN UNAUTHENTICATED LOCAL CONTROL SURFACE. Any local process
//     can drive a browser exposing it. So: bind loopback only, use a caller-picked
//     ephemeral port, and PIN --remote-allow-origins to that exact loopback endpoint
//     (never `*`). M111+ Chrome rejects the CDP websocket without a matching origin.
//   - BLAST RADIUS = EVERY LOGGED-IN SITE. Because we attach to the MAIN profile
//     (not a throwaway one), the domain allowlist (a later phase) is the ONLY
//     containment; there is no cryptographic isolation of cookies here.

export const AOI_BROWSER_DRIVE_CAPABILITY = 'os_browser_drive';
export const AOI_BROWSER_DRIVE_SOURCE_ID = 'browser-drive';

// Only loopback is ever a valid debug host; the port must never be reachable off-box.
const LOOPBACK_HOST = '127.0.0.1';
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export type AoiBrowserDriveEngine = 'chrome' | 'edge';

export interface AoiBrowserDriveLaunchOptions {
  // Concrete, caller-picked ephemeral port (find a free port FIRST, then launch and
  // pin the allow-origin to it). We do not use `--remote-debugging-port=0` because
  // the allow-origin must be pinned to the exact port, which is unknown with 0.
  port: number;
  // The user's real Chrome/Edge profile directory (attach to the MAIN session).
  userDataDir: string;
  // Defaults to the pinned loopback endpoint for `port`. Never widen to `*`.
  allowOrigin?: string;
  // Attaching to the user's visible browser means headed by default so they can
  // co-use it; only force headless when explicitly requested (isolated background).
  headless?: boolean;
}

export function isAoiBrowserDriveLoopbackHost(host: string): boolean {
  const value = typeof host === 'string' ? host.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!value) {
    return false;
  }
  if (value === 'localhost' || value === LOOPBACK_HOST || value === '::1' || value === '[::1]') {
    return true;
  }
  // 127.0.0.0/8 is all loopback.
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return false;
    }
    return parts[0] === 127;
  }
  return false;
}

export function isAoiBrowserDrivePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/** The pinned CDP allow-origin for a port. Loopback + exact port; never `*`. */
export function resolveAoiBrowserDriveAllowOrigin(port: number): string {
  if (!isAoiBrowserDrivePort(port)) {
    throw new Error(`invalid browser-drive debug port: ${String(port)}`);
  }
  return `http://${LOOPBACK_HOST}:${port}`;
}

/** connectOverCDP HTTP endpoint (Playwright fetches /json/version from it). */
export function buildAoiBrowserDriveCdpHttpEndpoint(port: number): string {
  if (!isAoiBrowserDrivePort(port)) {
    throw new Error(`invalid browser-drive debug port: ${String(port)}`);
  }
  return `http://${LOOPBACK_HOST}:${port}`;
}

/** Browser-level CDP websocket endpoint, when connecting by ws path directly. */
export function buildAoiBrowserDriveCdpWsEndpoint(port: number, wsPath: string): string {
  if (!isAoiBrowserDrivePort(port)) {
    throw new Error(`invalid browser-drive debug port: ${String(port)}`);
  }
  const path = typeof wsPath === 'string' ? wsPath.trim() : '';
  if (!path.startsWith('/')) {
    throw new Error('invalid DevTools ws path');
  }
  return `ws://${LOOPBACK_HOST}:${port}${path}`;
}

/**
 * Build the Chrome/Edge launch argv for a CDP-attachable instance of the user's
 * OWN profile. Kept minimal: we do NOT alter the user's real browser (no
 * extension/sync disabling) beyond enabling the pinned, loopback-scoped debug port.
 */
export function buildAoiBrowserDriveLaunchArgs(options: AoiBrowserDriveLaunchOptions): string[] {
  const { port, userDataDir } = options;
  if (!isAoiBrowserDrivePort(port)) {
    throw new Error(`invalid browser-drive debug port: ${String(port)}`);
  }
  const dir = typeof userDataDir === 'string' ? userDataDir.trim() : '';
  if (!dir) {
    throw new Error('browser-drive requires a user-data-dir');
  }
  const allowOrigin = options.allowOrigin?.trim() || resolveAoiBrowserDriveAllowOrigin(port);
  // Reject a widened / non-loopback allow-origin fail-closed: pinning is the whole
  // point of the security posture.
  let originHost = '';
  try {
    originHost = new URL(allowOrigin).hostname;
  } catch {
    throw new Error('invalid browser-drive allow-origin');
  }
  if (allowOrigin.includes('*') || !isAoiBrowserDriveLoopbackHost(originHost)) {
    throw new Error('browser-drive allow-origin must be a pinned loopback endpoint');
  }
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=${allowOrigin}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (options.headless) {
    args.push('--headless=new');
  }
  return args;
}

export interface AoiDevToolsActivePort {
  port: number;
  wsPath: string;
}

/**
 * Parse the `<user-data-dir>/DevToolsActivePort` handshake file Chrome writes once
 * the debug endpoint is live: line 1 = the actual port, line 2 = the browser ws
 * path (e.g. `/devtools/browser/<uuid>`). Returns null on any malformed content.
 */
export function parseAoiDevToolsActivePort(content: string): AoiDevToolsActivePort | null {
  if (typeof content !== 'string') {
    return null;
  }
  const lines = content.split(/\r?\n/);
  if (lines.length < 1) {
    return null;
  }
  const port = Number.parseInt(lines[0].trim(), 10);
  if (!isAoiBrowserDrivePort(port)) {
    return null;
  }
  const wsPath = (lines[1] ?? '').trim();
  if (!wsPath.startsWith('/')) {
    return null;
  }
  return { port, wsPath };
}

/**
 * Resolve the user's real (MAIN) Chrome/Edge user-data-dir on the current OS. This
 * is the profile Aoi attaches to, so it must be the everyday one that holds the
 * logged-in sessions -- NOT a throwaway dir.
 */
export function resolveAoiBrowserDriveDefaultUserDataDir(
  engine: AoiBrowserDriveEngine = 'chrome',
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const localAppData = env.LOCALAPPDATA || '';
  const home = env.HOME || env.USERPROFILE || '';
  if (platform === 'win32') {
    if (!localAppData) {
      return null;
    }
    return engine === 'edge'
      ? `${localAppData}\\Microsoft\\Edge\\User Data`
      : `${localAppData}\\Google\\Chrome\\User Data`;
  }
  if (platform === 'darwin') {
    if (!home) {
      return null;
    }
    return engine === 'edge'
      ? `${home}/Library/Application Support/Microsoft Edge`
      : `${home}/Library/Application Support/Google/Chrome`;
  }
  if (!home) {
    return null;
  }
  return engine === 'edge' ? `${home}/.config/microsoft-edge` : `${home}/.config/google-chrome`;
}
