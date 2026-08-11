import { describe, expect, it, vi } from 'vitest';
import {
  navigateAndExtractAoiBrowserDrive,
  type AoiBrowserDriveNavigablePage,
} from '../aoiBrowserDriveRead';
import {
  addAoiBrowserDriveAllowlistEntry,
  type AoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';

// Denylist: only evil.com (and subdomains) is blocked; everything else is allowed.
const DENYLIST: AoiBrowserDriveAllowlist = addAoiBrowserDriveAllowlistEntry(
  { version: 1, entries: [], updatedAt: 0 },
  { domain: 'evil.com' },
  1,
).allowlist;
const EMPTY: AoiBrowserDriveAllowlist = { version: 1, entries: [], updatedAt: 0 };

const SAMPLE_HTML =
  '<html><head><title>Dashboard</title></head><body><h1>My account</h1>' +
  '<p>You have three new messages waiting in the inbox for review today.</p></body></html>';

function fakePage(
  overrides: Partial<AoiBrowserDriveNavigablePage> & { landingUrl?: string } = {},
): AoiBrowserDriveNavigablePage & { goto: ReturnType<typeof vi.fn> } {
  let current = 'about:blank';
  const landingUrl = overrides.landingUrl ?? 'https://example.com/account';
  const page = {
    url: () => current,
    goto: vi.fn(async (target: string) => {
      // A real goto follows redirects; our fake lands on landingUrl for the first
      // real navigation and on the literal target for about:blank.
      current = target === 'about:blank' ? 'about:blank' : landingUrl;
    }),
    content: overrides.content ?? (async () => SAMPLE_HTML),
    title: overrides.title ?? (async () => 'Dashboard'),
  };
  return page as AoiBrowserDriveNavigablePage & { goto: ReturnType<typeof vi.fn> };
}

describe('navigateAndExtractAoiBrowserDrive', () => {
  it('navigates a non-denylisted page and returns a reader snapshot', async () => {
    const page = fakePage();
    const result = await navigateAndExtractAoiBrowserDrive({
      page,
      allowlist: EMPTY,
      url: 'https://example.com/account',
      now: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostname).toBe('example.com');
      expect(result.finalUrl).toBe('https://example.com/account');
      expect(result.title).toBe('Dashboard');
      expect(result.text).toContain('three new messages');
      expect(result.sampledAt).toBe(1000);
    }
  });

  it('blocks a denylisted URL before navigating', async () => {
    const page = fakePage();
    const result = await navigateAndExtractAoiBrowserDrive({
      page,
      allowlist: DENYLIST,
      url: 'https://evil.com/x',
      now: 1000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'url_denylisted' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('blocks and blanks the tab when a redirect drifts onto a denylisted host', async () => {
    const page = fakePage({ landingUrl: 'https://tracker.evil.com/landing' });
    const result = await navigateAndExtractAoiBrowserDrive({
      page,
      allowlist: DENYLIST,
      url: 'https://example.com/login',
      now: 1000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'drift_to_denylist' });
    // The tab was blanked after the drift was detected.
    expect(page.goto).toHaveBeenLastCalledWith('about:blank', expect.anything());
  });

  it('reports navigation_failed when goto throws', async () => {
    const page = fakePage();
    page.goto = vi.fn(async () => {
      throw new Error('net::ERR_TIMED_OUT');
    }) as unknown as typeof page.goto;
    const result = await navigateAndExtractAoiBrowserDrive({
      page,
      allowlist: EMPTY,
      url: 'https://example.com/slow',
      now: 1000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'navigation_failed' });
  });

  it('reports empty_document for a blank page', async () => {
    const page = fakePage({ content: async () => '   ' });
    const result = await navigateAndExtractAoiBrowserDrive({
      page,
      allowlist: EMPTY,
      url: 'https://example.com/empty',
      now: 1000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'empty_document' });
  });

  it('falls back to the extracted title when page.title() throws', async () => {
    const page = fakePage({
      title: async () => {
        throw new Error('no title');
      },
    });
    const result = await navigateAndExtractAoiBrowserDrive({
      page,
      allowlist: EMPTY,
      url: 'https://example.com/account',
      now: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toBe('Dashboard'); // from the <title> in the DOM
    }
  });
});
