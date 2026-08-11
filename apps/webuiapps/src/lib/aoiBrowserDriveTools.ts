// Chat-facing browser-drive read tool (BD P1.3b). Reads a page from the operator's
// OWN already-logged-in browser over CDP and returns a bounded reader snapshot.
// Triple-gated server-side: os_browser_drive kill-switch + browser-drive consent +
// domain denylist (default-allow; private/loopback hosts always blocked).

import type { ToolDef } from './llmClient';
import {
  fetchAoiHostBrowserDriveRead,
  type AoiHostBrowserDrivePageView,
} from './aoiHostBridgeClient';

export const BROWSER_DRIVE_READ_TOOL = 'browser_read_auth';

export interface BrowserDriveToolContext {
  sessionPath: string;
  fetchPage?: (sessionPath: string, url: string) => Promise<AoiHostBrowserDrivePageView>;
}

export function getBrowserDriveToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: BROWSER_DRIVE_READ_TOOL,
        description:
          "Read a page from the user's OWN already-logged-in browser (Chrome/Edge over CDP) " +
          'and return a reader-style title/excerpt/text extract. Use this when the user asks Aoi ' +
          'to read/check a page on a site they are signed in to (their dashboard, feed, inbox ' +
          'listing, account page) -- content that host_browser_read/read_url cannot see because ' +
          'they are not authenticated. Domains default to allowed; only browser-drive denylist ' +
          'domains are blocked. Read-only: it never clicks, types, or submits. Requires Host ' +
          'Bridge os_browser_drive capability + browser-drive consent.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description:
                'Absolute http(s) URL (blocked only if the host is on the browser-drive denylist).',
            },
          },
          required: ['url'],
        },
      },
    },
  ];
}

export function isBrowserDriveTool(toolName: string): boolean {
  return toolName === BROWSER_DRIVE_READ_TOOL;
}

export function getBrowserDriveToolPendingSummary(params: Record<string, unknown>): string {
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  return `${BROWSER_DRIVE_READ_TOOL}(${url.slice(0, 64)})`;
}

function formatGateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('host_private')) {
    return (
      `error: private/loopback hosts are never driven by browser-drive: ${message}. ` +
      'Use a public https host, or host_browser_read is also blocked for private targets.'
    );
  }
  if (
    lowered.includes('url_denylisted') ||
    lowered.includes('host_denylisted') ||
    lowered.includes('url_not_allowlisted') ||
    lowered.includes('host_not_allowlisted')
  ) {
    return (
      `error: that domain is on the browser-drive denylist: ${message}. ` +
      'Remove it in Settings -> Advanced -> Host PC -> Browser drive denylist, then retry.'
    );
  }
  if (lowered.includes('drift_to_denylist') || lowered.includes('drift_off_allowlist')) {
    return (
      `error: the page redirected onto a denylisted domain and was blocked: ${message}. ` +
      'Remove the destination from Settings -> Advanced -> Host PC -> Browser drive denylist if you trust it, then retry.'
    );
  }
  if (lowered.includes('source_not_consented') || lowered.includes('consent')) {
    return (
      `error: browser drive blocked by session consent: ${message}. ` +
      'Enable Browser drive in Settings -> Advanced -> Host PC (that also grants browser-drive ' +
      'consent), then retry.'
    );
  }
  if (lowered.includes('capability_disabled')) {
    return (
      `error: browser drive blocked: capability os_browser_drive is disabled. ` +
      'Enable Browser drive in Settings -> Advanced -> Host PC, then retry.'
    );
  }
  if (lowered.includes('host_bridge_panic') || lowered.includes('panic')) {
    return `error: browser drive blocked by host-bridge panic: ${message}`;
  }
  if (lowered.includes('attach_timeout') || lowered.includes('navigation_failed')) {
    return (
      `error: could not drive the browser: ${message}. ` +
      'Make sure the Aoi browser is started with the debug port (the daemon launches it); if your ' +
      'main Chrome/Edge is already open without it, close it first, then retry.'
    );
  }
  if (lowered.includes('blocked') || lowered.includes('deny') || lowered.includes('unauthorized')) {
    return `error: browser drive blocked: ${message}`;
  }
  return `error: browser drive read failed: ${message}`;
}

export function formatBrowserDrivePageForChat(page: AoiHostBrowserDrivePageView): string {
  return JSON.stringify({
    ok: true,
    url: page.url,
    final_url: page.finalUrl,
    hostname: page.hostname,
    title: page.title,
    site_name: page.siteName,
    excerpt: page.excerpt,
    blocks: page.blocks.slice(0, 16),
    text: page.text,
    note:
      "Read from the operator's OWN logged-in browser over CDP (denylist-gated, default-allow). " +
      'Read-only snapshot; no clicks/typing/submits were performed.',
  });
}

export async function executeBrowserDriveTool(
  params: Record<string, unknown>,
  context: BrowserDriveToolContext,
): Promise<string> {
  const sessionPath = typeof context.sessionPath === 'string' ? context.sessionPath.trim() : '';
  if (!sessionPath) {
    return 'error: browser drive needs an active Aoi session (sessionPath missing).';
  }
  const url =
    typeof params.url === 'string'
      ? params.url.trim()
      : typeof params.href === 'string'
        ? params.href.trim()
        : typeof params.link === 'string'
          ? params.link.trim()
          : '';
  if (!url) {
    return 'error: missing url for browser_read_auth';
  }
  const fetchPage = context.fetchPage ?? fetchAoiHostBrowserDriveRead;
  try {
    const page = await fetchPage(sessionPath, url);
    return formatBrowserDrivePageForChat(page);
  } catch (error) {
    return formatGateError(error);
  }
}
