import { describe, expect, it, vi } from 'vitest';
import type { AoiHostProcessListingView } from '../aoiHostBridgeClient';
import {
  executeHostProcessTool,
  formatHostProcessListingForChat,
  getHostProcessToolDefinitions,
  getHostProcessToolPendingSummary,
  isHostProcessTool,
} from '../aoiHostProcessTools';

const SAMPLE_LISTING: AoiHostProcessListingView = {
  version: 1,
  sampledAt: 1_700_000_000_000,
  records: [
    { pid: 100, imageName: 'chrome.exe', memKb: 200_000 },
    { pid: 101, imageName: 'chrome.exe', memKb: 180_000 },
    { pid: 200, imageName: 'notepad.exe', sessionName: 'Console' },
    { pid: 300, imageName: 'Code.exe', memKb: 400_000 },
  ],
  summary: {
    version: 1,
    sampledAt: 1_700_000_000_000,
    totalCount: 4,
    distinctImageCount: 3,
    topImages: [
      { imageName: 'chrome.exe', count: 2 },
      { imageName: 'Code.exe', count: 1 },
      { imageName: 'notepad.exe', count: 1 },
    ],
  },
};

describe('aoiHostProcessTools', () => {
  it('registers host_process_list', () => {
    const defs = getHostProcessToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe('host_process_list');
    expect(isHostProcessTool('host_process_list')).toBe(true);
    expect(isHostProcessTool('file_list')).toBe(false);
    expect(getHostProcessToolPendingSummary({ mode: 'list', query: 'chrome' })).toContain('chrome');
  });

  it('formats a summary snapshot with optional image filter', () => {
    const all = JSON.parse(formatHostProcessListingForChat(SAMPLE_LISTING)) as {
      ok: boolean;
      mode: string;
      totalCount: number;
      topImages: Array<{ imageName: string; count: number }>;
      privacy: string;
    };
    expect(all.ok).toBe(true);
    expect(all.mode).toBe('summary');
    expect(all.totalCount).toBe(4);
    expect(all.topImages[0].imageName).toBe('chrome.exe');
    expect(all.privacy).toBe('metadata_only_no_command_line');

    const filtered = JSON.parse(
      formatHostProcessListingForChat(SAMPLE_LISTING, { query: 'chrome' }),
    ) as { matchCount: number; topImages: Array<{ imageName: string; count: number }> };
    expect(filtered.matchCount).toBe(2);
    expect(filtered.topImages).toEqual([{ imageName: 'chrome.exe', count: 2 }]);
  });

  it('formats list mode with cap and no command-line field', () => {
    const listed = JSON.parse(
      formatHostProcessListingForChat(SAMPLE_LISTING, {
        mode: 'list',
        query: 'exe',
        maxResults: 2,
      }),
    ) as {
      mode: string;
      returnedCount: number;
      truncated: boolean;
      records: Array<Record<string, unknown>>;
    };
    expect(listed.mode).toBe('list');
    expect(listed.returnedCount).toBe(2);
    expect(listed.truncated).toBe(true);
    expect(listed.records[0]).toHaveProperty('pid');
    expect(listed.records[0]).toHaveProperty('imageName');
    expect(listed.records[0]).not.toHaveProperty('commandLine');
    expect(listed.records[0]).not.toHaveProperty('args');
  });

  it('executeHostProcessTool uses sessionPath and injects fetch listing', async () => {
    const fetchListing = vi.fn(async () => SAMPLE_LISTING);
    const result = await executeHostProcessTool(
      { query: 'notepad', mode: 'list' },
      { sessionPath: 'aoi/default', fetchListing },
    );
    expect(fetchListing).toHaveBeenCalledWith('aoi/default');
    const parsed = JSON.parse(result) as {
      ok: boolean;
      matchCount: number;
      records: Array<{ imageName: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.records[0].imageName).toBe('notepad.exe');
  });

  it('returns a guidance error when sessionPath is missing', async () => {
    const result = await executeHostProcessTool({}, { sessionPath: '' });
    expect(result.startsWith('error:')).toBe(true);
    expect(result).toMatch(/session/i);
  });

  it('returns enable guidance when the host bridge gate blocks', async () => {
    const result = await executeHostProcessTool(
      {},
      {
        sessionPath: 'aoi/default',
        fetchListing: async () => {
          throw new Error('blocked [capability_disabled, consent_disabled]');
        },
      },
    );
    expect(result.startsWith('error:')).toBe(true);
    expect(result).toMatch(/process_activity/);
    expect(result).toMatch(/process-activity/);
  });
});
