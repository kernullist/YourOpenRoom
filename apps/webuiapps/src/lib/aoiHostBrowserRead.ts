// Aoi host-bridge headless browser read (HP5): open a public http(s) page with
// local Chrome/Edge in headless mode, dump the rendered DOM, and extract a
// bounded reader snapshot for the model. The operator PC's real browser engine
// runs the page (JS/CSS), which is why this sits behind host-bridge gates rather
// than the simpler network-only /api/browser-reader proxy.
//
// Safety posture (load-bearing):
//   - CAPABILITY + CONSENT: kill-switch key `os_browser_read` and environment
//     source `host-browser-read` (caller enforces; this module is the data layer).
//   - SSRF FAIL-CLOSED: only http/https; blocks loopback, private, link-local,
//     and metadata IPs. file:/javascript:/data: never accepted.
//   - FIXED CHROME ARGV: shell:false, fixed headless dump-dom flags, URL is the
//     only caller-controlled string and is revalidated before spawn.
//   - BOUNDS: timeout, stdout byte cap, text/block caps.
//
// Server-only (child_process / fs / os). Pure helpers are exported for tests.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';

export const AOI_HOST_BROWSER_READ_CAPABILITY = 'os_browser_read';
export const AOI_HOST_BROWSER_READ_SOURCE_ID = 'host-browser-read';

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 24_000;
const MAX_BLOCKS = 24;
const MAX_TITLE_CHARS = 200;
const MAX_EXCERPT_CHARS = 400;

export type AoiHostBrowserReadDenyReason =
  | 'missing_url'
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'host_not_allowed'
  | 'browser_not_found'
  | 'timeout'
  | 'spawn_failed'
  | 'empty_document'
  | 'output_too_large';

export interface AoiHostBrowserReadBlock {
  type: 'heading' | 'paragraph';
  text: string;
}

export interface AoiHostBrowserReadResult {
  ok: true;
  url: string;
  finalUrl: string;
  title: string;
  excerpt: string;
  siteName: string;
  blocks: AoiHostBrowserReadBlock[];
  text: string;
  browserPath: string;
  sampledAt: number;
  durationMs: number;
  engine: 'chrome-headless' | 'edge-headless';
}

export interface AoiHostBrowserReadFailure {
  ok: false;
  reason: AoiHostBrowserReadDenyReason;
  detail?: string;
}

export type AoiHostBrowserReadOutcome = AoiHostBrowserReadResult | AoiHostBrowserReadFailure;

export interface ResolveAoiHostBrowserUrlResult {
  ok: true;
  url: string;
  hostname: string;
}

export interface ResolveAoiHostBrowserUrlFailure {
  ok: false;
  reason: Extract<
    AoiHostBrowserReadDenyReason,
    'missing_url' | 'invalid_url' | 'scheme_not_allowed' | 'host_not_allowed'
  >;
  detail?: string;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number.parseInt(digits, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }
  if (host === '::1' || host === '[::1]') {
    return true;
  }
  // IPv4 dotted forms (including partially-decoded hostnames).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true; // link-local / cloud metadata
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return true; // CGNAT
    }
  }
  // IPv6 unique-local / link-local (coarse; hostname usually not expanded).
  if (host.includes(':')) {
    if (
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host === '::' ||
      host.startsWith('::ffff:127.')
    ) {
      return true;
    }
  }
  return false;
}

export function resolveAoiHostBrowserUrl(
  raw: string,
): ResolveAoiHostBrowserUrlResult | ResolveAoiHostBrowserUrlFailure {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { ok: false, reason: 'missing_url' };
  }
  // Reject explicit non-http schemes before we prepend https:// (otherwise
  // "file://..." becomes "https://file//..." and slips through).
  const explicitScheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (explicitScheme) {
    const scheme = explicitScheme[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return { ok: false, reason: 'scheme_not_allowed', detail: `${scheme}:` };
    }
  }
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'invalid_url', detail: 'URL parse failed' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_allowed', detail: parsed.protocol };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'host_not_allowed', detail: 'userinfo_not_allowed' };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateOrLocalHostname(hostname)) {
    return { ok: false, reason: 'host_not_allowed', detail: hostname || 'empty_host' };
  }
  // Drop hash; keep query (caller may need it for articles).
  parsed.hash = '';
  return { ok: true, url: parsed.toString(), hostname };
}

export function listAoiHostBrowserExecutableCandidates(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = env.LOCALAPPDATA || env.USERPROFILE || env.HOME || '';
  const candidates: string[] = [];
  if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ...(home ? [join(home, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ...(home ? [join(home, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
    );
  }
  return candidates;
}

export function resolveAoiHostBrowserExecutable(
  options: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    existsSyncImpl?: (path: string) => boolean;
    overridePath?: string;
  } = {},
): { path: string; engine: 'chrome-headless' | 'edge-headless' } | null {
  const existsSyncImpl = options.existsSyncImpl ?? fs.existsSync;
  if (options.overridePath && existsSyncImpl(options.overridePath)) {
    const lower = options.overridePath.toLowerCase();
    return {
      path: options.overridePath,
      engine: lower.includes('edge') ? 'edge-headless' : 'chrome-headless',
    };
  }
  for (const candidate of listAoiHostBrowserExecutableCandidates(
    options.env ?? process.env,
    options.platform ?? process.platform,
  )) {
    if (!existsSyncImpl(candidate)) {
      continue;
    }
    const lower = candidate.toLowerCase();
    return {
      path: candidate,
      engine:
        lower.includes('edge') || lower.includes('msedge') ? 'edge-headless' : 'chrome-headless',
    };
  }
  return null;
}

export function buildAoiHostBrowserHeadlessArgs(url: string, userDataDir: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`,
    '--virtual-time-budget=12000',
    '--timeout=20000',
    '--dump-dom',
    url,
  ];
}

/** Pure HTML → reader blocks (no DOMParser; Node + browser safe). */
export function extractAoiHostBrowserReadable(
  html: string,
  sourceUrl: string,
  options: { maxBlocks?: number; maxTextChars?: number } = {},
): {
  title: string;
  excerpt: string;
  siteName: string;
  blocks: AoiHostBrowserReadBlock[];
  text: string;
} {
  const maxBlocks = Math.max(1, Math.min(MAX_BLOCKS, options.maxBlocks ?? 16));
  const maxTextChars = Math.max(500, Math.min(MAX_TEXT_CHARS, options.maxTextChars ?? 12_000));
  const raw = typeof html === 'string' ? html : '';
  const withoutNoise = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const titleMatch =
    withoutNoise.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    withoutNoise.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    withoutNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = truncate(
    collapseWhitespace(decodeBasicEntities(titleMatch?.[1] || sourceUrl)),
    MAX_TITLE_CHARS,
  );

  let siteName = sourceUrl;
  try {
    siteName = new URL(sourceUrl).hostname.replace(/^www\./, '');
  } catch {
    // keep sourceUrl
  }
  const siteMatch =
    withoutNoise.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
    withoutNoise.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (siteMatch?.[1]) {
    siteName = truncate(collapseWhitespace(decodeBasicEntities(siteMatch[1])), 120);
  }

  const blocks: AoiHostBrowserReadBlock[] = [];
  const seen = new Set<string>();
  const push = (type: AoiHostBrowserReadBlock['type'], textRaw: string) => {
    const text = truncate(collapseWhitespace(decodeBasicEntities(textRaw)), 800);
    if (text.length < 24) {
      return;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    blocks.push({ type, text });
  };

  const headingRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(withoutNoise)) && blocks.length < maxBlocks) {
    const text = match[1].replace(/<[^>]+>/g, ' ');
    push('heading', text);
  }

  const paragraphRe = /<(p|li|article|section)[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((match = paragraphRe.exec(withoutNoise)) && blocks.length < maxBlocks) {
    const text = match[2].replace(/<[^>]+>/g, ' ');
    push('paragraph', text);
  }

  if (blocks.length === 0) {
    const bodyMatch = withoutNoise.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyText = (bodyMatch?.[1] || withoutNoise).replace(/<[^>]+>/g, ' ');
    const collapsed = collapseWhitespace(decodeBasicEntities(bodyText));
    if (collapsed.length >= 24) {
      // Split long body into rough paragraphs.
      for (const chunk of collapsed.split(/(?<=\.)\s+/).slice(0, maxBlocks)) {
        push('paragraph', chunk);
      }
    }
  }

  const text = truncate(blocks.map((block) => block.text).join('\n\n'), maxTextChars);
  const excerpt = truncate(blocks[0]?.text || title, MAX_EXCERPT_CHARS);
  return { title, excerpt, siteName, blocks: blocks.slice(0, maxBlocks), text };
}

export interface RunAoiHostBrowserReadOptions {
  url: string;
  now?: number;
  timeoutMs?: number;
  maxBlocks?: number;
  maxTextChars?: number;
  browserPath?: string;
  spawnImpl?: typeof spawn;
  existsSyncImpl?: (path: string) => boolean;
  mkdtempImpl?: (prefix: string) => string;
  rmImpl?: (path: string, options: { recursive: boolean; force: boolean }) => void;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

export async function runAoiHostBrowserRead(
  options: RunAoiHostBrowserReadOptions,
): Promise<AoiHostBrowserReadOutcome> {
  const resolved = resolveAoiHostBrowserUrl(options.url);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, detail: resolved.detail };
  }

  const browser = resolveAoiHostBrowserExecutable({
    env: options.env,
    platform: options.platform,
    existsSyncImpl: options.existsSyncImpl,
    overridePath: options.browserPath,
  });
  if (!browser) {
    return {
      ok: false,
      reason: 'browser_not_found',
      detail: 'Install Google Chrome or Microsoft Edge for host browser read.',
    };
  }

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(5_000, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  );
  const now = options.now ?? Date.now();
  const spawnImpl = options.spawnImpl ?? spawn;
  const mkdtempImpl = options.mkdtempImpl ?? ((prefix: string) => fs.mkdtempSync(prefix));
  const rmImpl =
    options.rmImpl ??
    ((path: string, rmOptions: { recursive: boolean; force: boolean }) => {
      try {
        fs.rmSync(path, rmOptions);
      } catch {
        // best-effort cleanup
      }
    });

  let userDataDir = '';
  try {
    userDataDir = mkdtempImpl(join(os.tmpdir(), 'aoi-host-browser-'));
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const args = buildAoiHostBrowserHeadlessArgs(resolved.url, userDataDir);
  const started = Date.now();

  try {
    const html = await new Promise<string>((resolveHtml, rejectHtml) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnImpl(browser.path, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        rejectHtml(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
        rejectHtml(new Error(`timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const size = Buffer.byteLength(chunk);
        bytes += size;
        if (bytes > MAX_OUTPUT_BYTES) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try {
              child.kill();
            } catch {
              // ignore
            }
            rejectHtml(new Error('output_too_large'));
          }
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString('utf8').slice(0, 4000);
      });
      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rejectHtml(error instanceof Error ? error : new Error(String(error)));
      });
      child.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // Chrome dump-dom often exits 0 with HTML on stdout even when stderr has noise.
        if (stdout.trim().length > 0) {
          resolveHtml(stdout);
          return;
        }
        rejectHtml(
          new Error(
            `browser exited ${code ?? 'null'}${stderr.trim() ? `: ${stderr.trim().slice(0, 240)}` : ''}`,
          ),
        );
      });
    });

    if (!html.trim()) {
      return { ok: false, reason: 'empty_document' };
    }

    const readable = extractAoiHostBrowserReadable(html, resolved.url, {
      maxBlocks: options.maxBlocks,
      maxTextChars: options.maxTextChars,
    });
    if (!readable.text.trim() && readable.blocks.length === 0) {
      return { ok: false, reason: 'empty_document' };
    }

    return {
      ok: true,
      url: resolved.url,
      finalUrl: resolved.url,
      title: readable.title,
      excerpt: readable.excerpt,
      siteName: readable.siteName,
      blocks: readable.blocks,
      text: readable.text,
      browserPath: browser.path,
      sampledAt: now,
      durationMs: Math.max(0, Date.now() - started),
      engine: browser.engine,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timeout')) {
      return { ok: false, reason: 'timeout', detail: message };
    }
    if (message.includes('output_too_large')) {
      return { ok: false, reason: 'output_too_large', detail: message };
    }
    return { ok: false, reason: 'spawn_failed', detail: message };
  } finally {
    if (userDataDir) {
      // Parent of user-data-dir may be the tmp root; only remove the temp profile.
      rmImpl(userDataDir, { recursive: true, force: true });
      // Defensive: if mkdtemp created nested path, ensure we never climb above tmp.
      void dirname(userDataDir);
    }
  }
}
