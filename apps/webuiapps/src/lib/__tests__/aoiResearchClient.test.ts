import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAoiResearchRunRequest, startAoiResearchRun } from '../aoiResearchClient';

function makeJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeBrokenJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeAoiResearchRunRequest', () => {
  it('collapses internal whitespace and trims', () => {
    expect(normalizeAoiResearchRunRequest('  Investigate   ETW\n hardening  ')).toBe(
      'Investigate ETW hardening',
    );
    expect(normalizeAoiResearchRunRequest('   ')).toBe('');
  });
});

describe('startAoiResearchRun', () => {
  it('posts a normalized request with only the supplied fields', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(200, {
        ok: true,
        run: { id: 'aoi-research-test-1', status: 'queued', phase: 'queued' },
        background: true,
      }),
    );
    globalThis.fetch = mockFetch;

    const result = await startAoiResearchRun({
      sessionPath: 'aoi/space_adventure',
      request: '  Windows 11   kernel  attestation  ',
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/aoi-research/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionPath: 'aoi/space_adventure',
        request: 'Windows 11 kernel attestation',
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.run.id).toBe('aoi-research-test-1');
    expect(result.background).toBe(true);
  });

  it('includes optional mode, recency, maxSources and allowDuplicate when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(200, {
        ok: true,
        run: { id: 'aoi-research-test-2', status: 'queued', phase: 'queued' },
      }),
    );
    globalThis.fetch = mockFetch;

    await startAoiResearchRun({
      sessionPath: 'aoi/default',
      request: 'deep dive',
      mode: 'deep',
      recency: 'month',
      maxSources: 20,
      allowDuplicate: true,
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/aoi-research/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionPath: 'aoi/default',
        request: 'deep dive',
        mode: 'deep',
        recency: 'month',
        maxSources: 20,
        allowDuplicate: true,
      }),
    });
  });

  it('rejects an empty session without calling fetch', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(startAoiResearchRun({ sessionPath: '   ', request: 'something' })).rejects.toThrow(
      'Current session is not ready.',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an empty request without calling fetch', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(
      startAoiResearchRun({ sessionPath: 'aoi/default', request: '   \n  ' }),
    ).rejects.toThrow('Enter a research request first.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces the server 409 duplicate-run message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(409, {
        error: 'A matching research run is already queued or running for this session.',
        code: 'duplicate_active_run',
      }),
    );

    await expect(
      startAoiResearchRun({ sessionPath: 'aoi/default', request: 'dup' }),
    ).rejects.toThrow('A matching research run is already queued or running for this session.');
  });

  it('surfaces the server 429 too-many-runs message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(429, {
        error: 'Too many active Aoi research runs.',
        code: 'too_many_active_runs',
      }),
    );

    await expect(
      startAoiResearchRun({ sessionPath: 'aoi/default', request: 'busy' }),
    ).rejects.toThrow('Too many active Aoi research runs.');
  });

  it('falls back to a status message when the error body has no error field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeJsonResponse(500, {}));

    await expect(
      startAoiResearchRun({ sessionPath: 'aoi/default', request: 'boom' }),
    ).rejects.toThrow('Failed to start research (status 500).');
  });

  it('treats a 200 response with ok:false as a failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse(200, { ok: false, error: 'engine offline' }));

    await expect(startAoiResearchRun({ sessionPath: 'aoi/default', request: 'x' })).rejects.toThrow(
      'engine offline',
    );
  });

  it('handles an unparseable JSON body with the status fallback', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeBrokenJsonResponse(502));

    await expect(startAoiResearchRun({ sessionPath: 'aoi/default', request: 'x' })).rejects.toThrow(
      'Failed to start research (status 502).',
    );
  });
});
