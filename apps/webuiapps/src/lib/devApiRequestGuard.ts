// Gate in front of the dev server's local backend (every /api/* route).
//
// The routes are mounted from plugins' configureServer hooks, which Vite runs
// BEFORE its own CORS and host-check middlewares -- so Vite's DNS-rebinding
// protection never sees them, and none of them looked at Origin. Their bodies
// are JSON.parse'd whatever the Content-Type, so any page the operator visited
// could send a CORS-"simple" text/plain POST (no preflight) and change state:
// rewrite config and policy, write a file and then run a package script, drive
// the host bridge (whose dev mount trusts any loopback socket), start research.
// The browser could not read the responses, but every write landed.
//
// This guard runs first and refuses what only a foreign site produces:
//   - a Host header that is not a loopback name or an IP literal (DNS rebinding:
//     the attacker's own hostname, resolved to 127.0.0.1);
//   - an Origin that is not this server's own origin;
//   - Sec-Fetch-Site cross-site/same-site, except a top-level GET navigation
//     (an OAuth provider redirecting back, a link the operator clicked).
// Requests with none of these headers come from non-browser clients (the daemon,
// CLIs, tests) and pass; the routes' own auth still applies to them.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { isIP } from 'net';

export type DevApiRequestRejection =
  | 'host_not_allowed'
  | 'cross_origin'
  | 'cross_site_request'
  | 'cross_site_document';

export type DevApiRequestVerdict =
  | { allowed: true }
  | { allowed: false; reason: DevApiRequestRejection };

export interface DevApiRequestGuardOptions {
  // Extra hostnames to accept (Vite's server.allowedHosts). `true` disables the
  // Host check, mirroring Vite.
  allowedHosts?: readonly string[] | true;
  // Path prefixes the guard applies to.
  pathPrefixes?: readonly string[];
  // Routes that answer with third-party HTML. Even a top-level navigation to
  // them is refused cross-site: that document would run on this origin.
  documentProxyPrefixes?: readonly string[];
}

const DEFAULT_PATH_PREFIXES = ['/api/'];
const DEFAULT_DOCUMENT_PROXY_PREFIXES = ['/api/browser-reader'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host.trim()}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizedHostOf(host: string): string | null {
  try {
    return new URL(`http://${host.trim()}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is this Host header one a browser can only send for a loopback name, an IP
 * literal, or a host the config explicitly allows? Same rule as Vite's own host
 * check: DNS rebinding cannot produce an IP-literal Host.
 */
export function isDevApiHostAllowed(
  host: string | undefined,
  allowedHosts: readonly string[] | true = [],
): boolean {
  if (allowedHosts === true) {
    return true;
  }
  if (!host || !host.trim()) {
    return false;
  }
  const hostname = hostnameOf(host);
  if (!hostname) {
    return false;
  }
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) {
    return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }
  return allowedHosts.some((allowed) => {
    const entry = allowed.toLowerCase();
    if (entry.startsWith('.')) {
      return hostname === entry.slice(1) || hostname.endsWith(entry);
    }
    return hostname === entry;
  });
}

export function evaluateDevApiRequest(
  request: { method?: string; url?: string; headers: IncomingHttpHeaders },
  options: DevApiRequestGuardOptions = {},
): DevApiRequestVerdict {
  const host = headerValue(request.headers, 'host');
  const origin = headerValue(request.headers, 'origin');
  const hasBrowserMarkers =
    origin !== undefined || headerValue(request.headers, 'sec-fetch-site') !== undefined;
  // Browsers always send Host. A request without one is a non-browser client
  // (HTTP/1.0 tooling, in-process callers) and passes -- unless it also carries
  // browser headers, which no legitimate Host-less request does.
  if (host === undefined || !host.trim()) {
    return hasBrowserMarkers ? { allowed: false, reason: 'host_not_allowed' } : { allowed: true };
  }
  if (!isDevApiHostAllowed(host, options.allowedHosts ?? [])) {
    return { allowed: false, reason: 'host_not_allowed' };
  }

  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = origin === 'null' ? null : new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (!originHost || !host || originHost !== normalizedHostOf(host)) {
      return { allowed: false, reason: 'cross_origin' };
    }
  }

  const fetchSite = headerValue(request.headers, 'sec-fetch-site')?.toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    const method = (request.method ?? 'GET').toUpperCase();
    const mode = headerValue(request.headers, 'sec-fetch-mode')?.toLowerCase();
    const path = (request.url ?? '').split('?')[0] ?? '';
    const documentProxies = options.documentProxyPrefixes ?? DEFAULT_DOCUMENT_PROXY_PREFIXES;
    if (documentProxies.some((prefix) => path.startsWith(prefix))) {
      return { allowed: false, reason: 'cross_site_document' };
    }
    if (!(SAFE_METHODS.has(method) && mode === 'navigate')) {
      return { allowed: false, reason: 'cross_site_request' };
    }
  }

  return { allowed: true };
}

export type DevApiRequestGuard = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

export function createDevApiRequestGuard(
  options: DevApiRequestGuardOptions = {},
): DevApiRequestGuard {
  const prefixes = options.pathPrefixes ?? DEFAULT_PATH_PREFIXES;
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!prefixes.some((prefix) => path.startsWith(prefix))) {
      next();
      return;
    }
    const verdict = evaluateDevApiRequest(req, options);
    if (verdict.allowed) {
      next();
      return;
    }
    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({ ok: false, error: 'forbidden_request_origin', reason: verdict.reason }),
    );
  };
}
