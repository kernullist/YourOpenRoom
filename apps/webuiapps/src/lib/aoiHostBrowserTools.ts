// Chat-facing host headless browser read tools (HP5).
// Opens a public page with the operator PC's Chrome/Edge headless, extracts
// reader text, and returns a bounded JSON snapshot. Capability kill-switch
// (`os_browser_read`) + session consent (`host-browser-read`) are enforced
// server-side.

import type { ToolDef } from './llmClient';
import { fetchAoiHostBrowserRead, type AoiHostBrowserPageView } from './aoiHostBridgeClient';

export const HOST_BROWSER_READ_TOOL = 'host_browser_read';

export interface HostBrowserToolContext {
  sessionPath: string;
  fetchPage?: (sessionPath: string, url: string) => Promise<AoiHostBrowserPageView>;
}

export function getHostBrowserToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: HOST_BROWSER_READ_TOOL,
        description:
          'Open a public http(s) URL with the operator PC headless Chrome/Edge, render the page, ' +
          'and return a reader-style title/excerpt/text extract. Use when the user asks Aoi to ' +
          'visit/read a webpage on their PC (JS-rendered sites, live articles). ' +
          'Not for local/private network URLs. Requires Host Bridge os_browser_read capability ' +
          'and host-browser-read consent. Prefer this over read_url when the user wants real PC ' +
          'browser rendering; use read_url for quick network-only extracts when host browser is off.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Absolute http(s) URL or hostname/path (https is assumed).',
            },
          },
          required: ['url'],
        },
      },
    },
  ];
}

export function isHostBrowserTool(toolName: string): boolean {
  return toolName === HOST_BROWSER_READ_TOOL;
}

export function getHostBrowserToolPendingSummary(params: Record<string, unknown>): string {
  const url = typeof params.url === 'string' ? params.url.trim() : '';
  return `${HOST_BROWSER_READ_TOOL}(${url.slice(0, 64)})`;
}

function formatGateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('source_not_consented') || lowered.includes('consent')) {
    return (
      `error: host browser read blocked by session consent: ${message}. ` +
      'Enable Headless browser read in Settings → Advanced → Host PC (that also grants ' +
      'host-browser-read consent), then retry.'
    );
  }
  if (lowered.includes('capability_disabled')) {
    return (
      `error: host browser read blocked: capability os_browser_read is disabled. ` +
      'Enable Headless browser read in Settings → Advanced → Host PC, then retry.'
    );
  }
  if (lowered.includes('host_bridge_panic') || lowered.includes('panic')) {
    return `error: host browser read blocked by host-bridge panic: ${message}`;
  }
  if (lowered.includes('browser_not_found')) {
    return (
      `error: Chrome/Edge was not found on this PC: ${message}. ` +
      'Install Google Chrome or Microsoft Edge, then retry.'
    );
  }
  if (
    lowered.includes('host_not_allowed') ||
    lowered.includes('scheme_not_allowed') ||
    lowered.includes('invalid_url')
  ) {
    return (
      `error: URL not allowed for host browser read: ${message}. ` +
      'Only public http(s) pages are permitted (no localhost/private networks).'
    );
  }
  if (lowered.includes('blocked') || lowered.includes('deny') || lowered.includes('unauthorized')) {
    return `error: host browser read blocked: ${message}`;
  }
  return `error: host browser read failed: ${message}`;
}

export function formatHostBrowserPageForChat(page: AoiHostBrowserPageView): string {
  return JSON.stringify({
    ok: true,
    url: page.url,
    final_url: page.finalUrl,
    title: page.title,
    site_name: page.siteName,
    excerpt: page.excerpt,
    blocks: page.blocks.slice(0, 16),
    text: page.text,
    engine: page.engine,
    duration_ms: page.durationMs,
    privacy: 'public_http_only_ssrf_blocked',
    note:
      'Rendered with the operator PC headless Chrome/Edge. Private/local hosts are blocked. ' +
      'This is a snapshot, not an interactive browser session.',
  });
}

export async function executeHostBrowserTool(
  params: Record<string, unknown>,
  context: HostBrowserToolContext,
): Promise<string> {
  const sessionPath = typeof context.sessionPath === 'string' ? context.sessionPath.trim() : '';
  if (!sessionPath) {
    return 'error: host browser read needs an active Aoi session (sessionPath missing).';
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
    return 'error: missing url for host_browser_read';
  }
  const fetchPage = context.fetchPage ?? fetchAoiHostBrowserRead;
  try {
    const page = await fetchPage(sessionPath, url);
    return formatHostBrowserPageForChat(page);
  } catch (error) {
    return formatGateError(error);
  }
}
