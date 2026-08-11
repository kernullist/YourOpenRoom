import { describe, expect, it, vi } from 'vitest';
import type { AoiHostProcessListingView } from '../aoiHostBridgeClient';
import {
  executeHostProcessTool,
  formatHostProcessListingForChat,
  getHostProcessToolDefinitions,
  getHostProcessToolPendingSummary,
  HOST_PROCESS_SPAWN_PREVIEW_TOOL,
  HOST_PROCESS_SPAWN_RUN_TOOL,
  isHostProcessTool,
  parseHostSpawnApprovalRequired,
  resolveHostSpawnTarget,
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
  it('registers list + spawn preview/run tools', () => {
    const defs = getHostProcessToolDefinitions();
    expect(defs.map((d) => d.function.name)).toEqual([
      'host_process_list',
      'host_process_spawn_preview',
      'host_process_spawn_run',
    ]);
    expect(isHostProcessTool('host_process_list')).toBe(true);
    expect(isHostProcessTool(HOST_PROCESS_SPAWN_PREVIEW_TOOL)).toBe(true);
    expect(isHostProcessTool(HOST_PROCESS_SPAWN_RUN_TOOL)).toBe(true);
    expect(isHostProcessTool('file_list')).toBe(false);
    expect(getHostProcessToolPendingSummary({ mode: 'list', query: 'chrome' })).toContain('chrome');
  });

  it('resolves Korean 메모장 against a notepad allowlist entry', () => {
    const resolved = resolveHostSpawnTarget({ query: '메모장' }, [
      { id: 'exe-notepad', path: 'C:\\Windows\\System32\\notepad.exe', label: 'Notepad' },
    ]);
    expect(resolved).toMatchObject({
      body: { allowlistId: 'exe-notepad' },
    });
  });

  it('returns a clear error when the spawn allowlist has no match', () => {
    const resolved = resolveHostSpawnTarget({ query: '메모장' }, []);
    expect(resolved).toMatchObject({ error: expect.stringMatching(/no spawn allowlist/i) });
    if ('error' in resolved) {
      expect(resolved.error).toMatch(/OPEN_APP/i);
    }
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
          throw new Error('blocked [capability_disabled]');
        },
      },
    );
    expect(result.startsWith('error:')).toBe(true);
    expect(result).toMatch(/process_activity/);
  });

  it('returns consent-specific guidance when source_not_consented', async () => {
    const result = await executeHostProcessTool(
      {},
      {
        sessionPath: 'aoi/default',
        fetchListing: async () => {
          throw new Error('blocked [source_not_consented]');
        },
      },
    );
    expect(result).toMatch(/session consent/i);
    expect(result).toMatch(/toggle Process list/i);
  });

  it('spawn preview records approval_required and does not claim launch', async () => {
    const previewSpawn = vi.fn(async () => ({
      allowed: true,
      blockReasons: [],
      allowlistId: 'exe-notepad',
      label: 'Notepad',
      program: 'C:\\Windows\\System32\\notepad.exe',
      args: [],
      approvalFingerprint: 'fp-1',
      expiresAt: 9_999,
    }));
    const result = await executeHostProcessTool(
      { query: '메모장' },
      {
        sessionPath: 'aoi/default',
        fetchAllowlist: async () => [
          { id: 'exe-notepad', path: 'C:\\Windows\\System32\\notepad.exe', label: 'Notepad' },
        ],
        previewSpawn,
      },
      HOST_PROCESS_SPAWN_PREVIEW_TOOL,
    );
    const parsed = JSON.parse(result) as {
      status: string;
      ok: boolean;
      approval_fingerprint: string;
      note: string;
    };
    expect(previewSpawn).toHaveBeenCalledWith({ allowlistId: 'exe-notepad' });
    expect(parsed.status).toBe('approval_required');
    expect(parsed.ok).toBe(true);
    expect(parsed.approval_fingerprint).toBe('fp-1');
    expect(parsed.note).toMatch(/did NOT start/i);
    expect(parsed.note).toMatch(/chat/i);
    expect(parseHostSpawnApprovalRequired(result)).toEqual({
      approvalFingerprint: 'fp-1',
      label: 'Notepad',
      program: 'C:\\Windows\\System32\\notepad.exe',
      args: [],
      allowlistId: 'exe-notepad',
      expiresAt: 9_999,
      match: expect.stringContaining('exe-notepad'),
    });
  });

  it('spawn run only reports done when execute returns ok with pid', async () => {
    const executeSpawn = vi.fn(async () => ({
      ok: true,
      allowlistId: 'exe-notepad',
      program: 'C:\\Windows\\System32\\notepad.exe',
      spawnedPid: 4242,
      blockReasons: [],
    }));
    const result = await executeHostProcessTool(
      { allowlist_id: 'exe-notepad' },
      {
        sessionPath: 'aoi/default',
        fetchAllowlist: async () => [
          { id: 'exe-notepad', path: 'C:\\Windows\\System32\\notepad.exe', label: 'Notepad' },
        ],
        executeSpawn,
      },
      HOST_PROCESS_SPAWN_RUN_TOOL,
    );
    const parsed = JSON.parse(result) as {
      status: string;
      ok: boolean;
      spawned_pid: number;
      note: string;
    };
    expect(parsed.status).toBe('done');
    expect(parsed.ok).toBe(true);
    expect(parsed.spawned_pid).toBe(4242);
    expect(parsed.note).toMatch(/succeeded/i);
  });
});
