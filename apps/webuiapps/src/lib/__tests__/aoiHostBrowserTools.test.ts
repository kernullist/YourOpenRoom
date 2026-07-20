import { describe, expect, it, vi } from 'vitest';
import {
  executeHostBrowserTool,
  formatHostBrowserPageForChat,
  getHostBrowserToolDefinitions,
  isHostBrowserTool,
} from '../aoiHostBrowserTools';

describe('aoiHostBrowserTools', () => {
  it('registers host_browser_read', () => {
    const defs = getHostBrowserToolDefinitions();
    expect(defs[0].function.name).toBe('host_browser_read');
    expect(isHostBrowserTool('host_browser_read')).toBe(true);
  });

  it('formats a page snapshot for the model', () => {
    const json = formatHostBrowserPageForChat({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      title: 'Example',
      excerpt: 'Hi',
      siteName: 'example.com',
      blocks: [{ type: 'paragraph', text: 'Hello there this is long enough content.' }],
      text: 'Hello there this is long enough content.',
      browserPath: 'C:\\chrome.exe',
      sampledAt: 1,
      durationMs: 12,
      engine: 'chrome-headless',
    });
    const parsed = JSON.parse(json) as { ok: boolean; title: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.title).toBe('Example');
  });

  it('executeHostBrowserTool uses sessionPath and returns JSON', async () => {
    const fetchPage = vi.fn(async () => ({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      title: 'T',
      excerpt: 'E',
      siteName: 'example.com',
      blocks: [],
      text: 'body text for the page extract',
      browserPath: 'chrome',
      sampledAt: 1,
      durationMs: 5,
      engine: 'chrome-headless',
    }));
    const result = await executeHostBrowserTool(
      { url: 'https://example.com' },
      { sessionPath: 'aoi/default', fetchPage },
    );
    expect(fetchPage).toHaveBeenCalledWith('aoi/default', 'https://example.com');
    expect(JSON.parse(result).ok).toBe(true);
  });

  it('returns enable guidance when blocked', async () => {
    const result = await executeHostBrowserTool(
      { url: 'https://example.com' },
      {
        sessionPath: 'aoi/default',
        fetchPage: async () => {
          throw new Error('blocked [capability_disabled]');
        },
      },
    );
    expect(result).toMatch(/os_browser_read/);
  });
});
