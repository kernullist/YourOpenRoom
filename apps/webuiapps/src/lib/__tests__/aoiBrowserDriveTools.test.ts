import { describe, expect, it } from 'vitest';
import {
  BROWSER_DRIVE_READ_TOOL,
  executeBrowserDriveTool,
  formatBrowserDrivePageForChat,
  getBrowserDriveToolDefinitions,
  getBrowserDriveToolPendingSummary,
  isBrowserDriveTool,
} from '../aoiBrowserDriveTools';
import type { AoiHostBrowserDrivePageView } from '../aoiHostBridgeClient';

const PAGE: AoiHostBrowserDrivePageView = {
  url: 'https://example.com/account',
  finalUrl: 'https://example.com/account',
  hostname: 'example.com',
  title: 'My Dashboard',
  excerpt: 'Welcome back',
  siteName: 'example.com',
  blocks: [{ type: 'paragraph', text: 'Three new messages today.' }],
  text: 'Three new messages today.',
  browserPath: 'chrome',
  sampledAt: 1,
  durationMs: 1,
  engine: 'chrome',
};

describe('browser-drive tool definition', () => {
  it('exposes browser_read_auth', () => {
    const defs = getBrowserDriveToolDefinitions();
    expect(defs[0].function.name).toBe(BROWSER_DRIVE_READ_TOOL);
    expect(isBrowserDriveTool('browser_read_auth')).toBe(true);
    expect(isBrowserDriveTool('host_browser_read')).toBe(false);
    expect(getBrowserDriveToolPendingSummary({ url: 'https://example.com/x' })).toContain(
      'browser_read_auth',
    );
  });
});

describe('formatBrowserDrivePageForChat', () => {
  it('emits a bounded read-only snapshot', () => {
    const parsed = JSON.parse(formatBrowserDrivePageForChat(PAGE));
    expect(parsed).toMatchObject({ ok: true, hostname: 'example.com', title: 'My Dashboard' });
    expect(parsed.note).toContain('Read-only');
  });
});

describe('executeBrowserDriveTool', () => {
  it('returns the formatted page on success', async () => {
    const result = await executeBrowserDriveTool(
      { url: 'https://example.com/account' },
      { sessionPath: 'aoi/default', fetchPage: async () => PAGE },
    );
    expect(JSON.parse(result)).toMatchObject({ ok: true, title: 'My Dashboard' });
  });

  it('requires a session and a url', async () => {
    expect(await executeBrowserDriveTool({ url: 'x' }, { sessionPath: '' })).toContain(
      'active Aoi session',
    );
    expect(await executeBrowserDriveTool({}, { sessionPath: 'aoi/default' })).toContain(
      'missing url',
    );
  });

  it('maps a denylist gate error to an actionable hint', async () => {
    const result = await executeBrowserDriveTool(
      { url: 'https://evil.com' },
      {
        sessionPath: 'aoi/default',
        fetchPage: async () => {
          throw new Error('url_denylisted [host_denylisted]');
        },
      },
    );
    expect(result).toContain('on the browser-drive denylist');
    expect(result).toContain('denylist');
  });

  it('maps a consent gate error to a settings hint', async () => {
    const result = await executeBrowserDriveTool(
      { url: 'https://example.com' },
      {
        sessionPath: 'aoi/default',
        fetchPage: async () => {
          throw new Error('blocked [source_not_consented]');
        },
      },
    );
    expect(result).toContain('Enable Browser drive');
  });
});
