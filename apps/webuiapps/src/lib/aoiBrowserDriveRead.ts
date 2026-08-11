// Aoi browser-drive authenticated read (P1.2): navigate an already-logged-in page
// in the Aoi-driven tab and return a reader snapshot. Read-only — no side effects.
// Ties together the CDP session page (P0.2), the domain denylist drift-block
// (P1.1, default-allow), and the existing pure reader extractor.
//
// DRIFT BLOCK IS ENFORCED TWICE: before navigation (requested URL must not be
// denylisted) AND after (FINAL URL after redirects must still not be denylisted).
// A redirect onto a denylisted host is refused and the tab is blanked so no
// blocked content is ever read. Fail-closed on denylist hits.

import {
  isAoiBrowserDriveUrlAllowed,
  type AoiBrowserDriveAllowlist,
} from './aoiBrowserDriveAllowlist';
import { extractAoiHostBrowserReadable, type AoiHostBrowserReadBlock } from './aoiHostBrowserRead';

const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const MAX_NAV_TIMEOUT_MS = 45_000;
const BLANK_URL = 'about:blank';

// The subset of a Playwright Page this operation needs. Kept local so the session
// module's page type stays minimal and no static playwright import is pulled in.
export interface AoiBrowserDriveNavigablePage {
  url(): string;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
}

export type AoiBrowserDriveReadDenyReason =
  | 'url_denylisted'
  | 'drift_to_denylist'
  // Legacy aliases (older logs / clients).
  | 'url_not_allowlisted'
  | 'drift_off_allowlist'
  | 'navigation_failed'
  | 'empty_document';

export interface AoiBrowserDriveReadResult {
  ok: true;
  url: string;
  finalUrl: string;
  hostname: string;
  title: string;
  excerpt: string;
  siteName: string;
  blocks: AoiHostBrowserReadBlock[];
  text: string;
  sampledAt: number;
}

export interface AoiBrowserDriveReadFailure {
  ok: false;
  reason: AoiBrowserDriveReadDenyReason;
  detail?: string;
  hostname?: string;
}

export type AoiBrowserDriveReadOutcome = AoiBrowserDriveReadResult | AoiBrowserDriveReadFailure;

export async function navigateAndExtractAoiBrowserDrive(params: {
  page: AoiBrowserDriveNavigablePage;
  allowlist: AoiBrowserDriveAllowlist | null | undefined;
  url: string;
  now: number;
  timeoutMs?: number;
}): Promise<AoiBrowserDriveReadOutcome> {
  const { page, allowlist, url } = params;

  // 1) Pre-navigation denylist block: the requested URL must not be denylisted.
  const pre = isAoiBrowserDriveUrlAllowed(allowlist, url);
  if (!pre.allowed) {
    return {
      ok: false,
      reason: 'url_denylisted',
      detail: pre.reason,
      hostname: pre.hostname,
    };
  }

  const timeout = Math.min(
    MAX_NAV_TIMEOUT_MS,
    Math.max(1_000, params.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS),
  );

  // 2) Navigate.
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    return {
      ok: false,
      reason: 'navigation_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // 3) Post-navigation denylist block: the FINAL url (after redirects) must STILL
  //    not be denylisted. If it drifted onto a blocked host, blank the tab.
  const finalUrl = page.url();
  const post = isAoiBrowserDriveUrlAllowed(allowlist, finalUrl);
  if (!post.allowed) {
    try {
      await page.goto(BLANK_URL, { waitUntil: 'domcontentloaded', timeout: 5_000 });
    } catch {
      // best-effort blanking
    }
    return {
      ok: false,
      reason: 'drift_to_denylist',
      detail: post.reason,
      hostname: post.hostname,
    };
  }

  // 4) Extract a bounded reader snapshot from the rendered DOM.
  let html = '';
  try {
    html = await page.content();
  } catch (error) {
    return {
      ok: false,
      reason: 'navigation_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!html || html.trim().length === 0) {
    return { ok: false, reason: 'empty_document', hostname: post.hostname };
  }

  let pageTitle = '';
  try {
    pageTitle = await page.title();
  } catch {
    // title is best-effort; the extractor derives one from the DOM otherwise
  }

  const extracted = extractAoiHostBrowserReadable(html, finalUrl);
  return {
    ok: true,
    url,
    finalUrl,
    hostname: post.hostname,
    title: pageTitle.trim() || extracted.title,
    excerpt: extracted.excerpt,
    siteName: extracted.siteName,
    blocks: extracted.blocks,
    text: extracted.text,
    sampledAt: params.now,
  };
}
