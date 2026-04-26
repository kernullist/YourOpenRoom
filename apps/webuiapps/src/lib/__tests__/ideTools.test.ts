import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeIdeTool } from '../ideTools';

describe('executeIdeTool()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an error when query is missing', async () => {
    await expect(executeIdeTool({})).resolves.toBe('error: missing query');
  });

  it('requests the IDE search endpoint and returns the JSON payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          query: 'ChatPanel',
          total_matches: 1,
          matches: [{ path: 'src/components/ChatPanel/index.tsx', match_type: 'path' }],
        }),
    } as unknown as Response);

    const result = await executeIdeTool({
      query: 'ChatPanel',
      directory: 'apps/webuiapps/src',
      mode: 'path',
      max_results: 3,
    });

    const parsed = JSON.parse(result) as { query: string; total_matches: number };
    expect(parsed.query).toBe('ChatPanel');
    expect(parsed.total_matches).toBe(1);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain('/api/openvscode/search?');
  });
});
