import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeAoiResearchTool,
  getAoiResearchToolPendingSummary,
  getAoiResearchToolDefinitions,
  isAoiResearchTool,
  normalizeAoiResearchArtifact,
  normalizeAoiResearchMaxSources,
  normalizeAoiResearchMode,
  normalizeStartResearchParams,
} from '../aoiResearchTools';
import {
  getAoiResearchRoute,
  isValidAoiResearchRunId,
  normalizeAoiResearchSessionPath,
} from '../aoiResearchPlugin';

function makeJsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Aoi research tool definitions', () => {
  it('exposes the foundation research tools without caller-controlled paths', () => {
    const tools = getAoiResearchToolDefinitions();
    const names = tools.map((tool) => tool.function.name);

    expect(names).toEqual([
      'start_research',
      'get_research_status',
      'read_research_artifact',
      'cancel_research',
    ]);
    expect(isAoiResearchTool('start_research')).toBe(true);
    expect(isAoiResearchTool('search_web')).toBe(false);

    const schemas = JSON.stringify(tools.map((tool) => tool.function.parameters));
    expect(schemas).not.toContain('sessionPath');
    expect(schemas).not.toContain('file_path');
    expect(schemas).not.toContain('output_path');
  });

  it('builds compact pending summaries for chat progress', () => {
    expect(
      getAoiResearchToolPendingSummary('start_research', {
        request: 'Investigate Windows ETW detection opportunities in depth',
      }),
    ).toMatch(/^start_research\(Investigate Windows ETW detection opportunities/);
    expect(
      getAoiResearchToolPendingSummary('get_research_status', {
        run_id: 'aoi-research-test-1234',
      }),
    ).toBe('get_research_status(aoi-research-test-1234)');
    expect(
      getAoiResearchToolPendingSummary('read_research_artifact', {
        run_id: 'aoi-research-test-1234',
        artifact: 'report',
      }),
    ).toBe('read_research_artifact(report:aoi-research-test-1234)');
    expect(
      getAoiResearchToolPendingSummary('cancel_research', {
        run_id: 'aoi-research-test-1234',
      }),
    ).toBe('cancel_research(aoi-research-test-1234)');
  });

  it('normalizes start params with conservative bounded defaults', () => {
    expect(
      normalizeStartResearchParams({
        request: '  Windows ETW detection research  ',
        mode: 'deep',
        language: 'ko',
        recency: 'week',
        max_sources: '99',
      }),
    ).toEqual({
      request: 'Windows ETW detection research',
      mode: 'deep',
      language: 'ko',
      recency: 'week',
      maxSources: 40,
    });
    expect(normalizeStartResearchParams({ request: '' })).toBe('error: request is required');
    expect(normalizeAoiResearchMode('invalid')).toBe('standard');
    expect(normalizeAoiResearchMaxSources('bad', 'quick')).toBe(5);
    expect(normalizeAoiResearchArtifact('report')).toBe('report');
    expect(normalizeAoiResearchArtifact('private-path')).toBeNull();
  });
});

describe('Aoi research tool execution', () => {
  it('posts a normalized start request with sessionPath supplied by the caller', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(200, {
        ok: true,
        run: {
          id: 'aoi-research-test-1234',
          status: 'failed',
          phase: 'engine_not_implemented',
        },
      }),
    );
    globalThis.fetch = mockFetch;

    const result = await executeAoiResearchTool(
      'start_research',
      {
        request: '  Investigate ETW hardening  ',
        mode: 'deep',
        language: 'ko',
        recency: 'month',
        max_sources: '30',
        sessionPath: 'model-controlled-path',
      },
      'aoi/default',
    );

    expect(mockFetch).toHaveBeenCalledWith('/api/aoi-research/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionPath: 'aoi/default',
        request: 'Investigate ETW hardening',
        mode: 'deep',
        language: 'ko',
        recency: 'month',
        maxSources: 30,
      }),
    });
    expect(JSON.parse(result)).toEqual({
      ok: true,
      run: {
        id: 'aoi-research-test-1234',
        status: 'failed',
        phase: 'engine_not_implemented',
      },
    });
  });

  it('reads status through a session-scoped local endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(200, {
        ok: true,
        run: { id: 'aoi-research-test-1234', status: 'failed' },
      }),
    );
    globalThis.fetch = mockFetch;

    const result = await executeAoiResearchTool(
      'get_research_status',
      { run_id: 'aoi-research-test-1234' },
      'aoi/default',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/aoi-research/status?sessionPath=aoi%2Fdefault&runId=aoi-research-test-1234',
    );
    expect(JSON.parse(result)).toEqual({
      ok: true,
      run: { id: 'aoi-research-test-1234', status: 'failed' },
    });
  });

  it('rejects bad artifact names before making a request', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(
      executeAoiResearchTool(
        'read_research_artifact',
        { run_id: 'aoi-research-test-1234', artifact: '../manifest' },
        'aoi/default',
      ),
    ).resolves.toBe('error: artifact must be one of manifest, report, sources, evidence');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('posts cancellation without letting the model override sessionPath', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      makeJsonResponse(200, {
        ok: true,
        run: { id: 'aoi-research-test-1234', status: 'cancelled' },
      }),
    );
    globalThis.fetch = mockFetch;

    const result = await executeAoiResearchTool(
      'cancel_research',
      {
        run_id: 'aoi-research-test-1234',
        reason: 'user changed direction',
        sessionPath: 'ignored',
      },
      'aoi/default',
    );

    expect(mockFetch).toHaveBeenCalledWith('/api/aoi-research/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionPath: 'aoi/default',
        runId: 'aoi-research-test-1234',
        reason: 'user changed direction',
      }),
    });
    expect(JSON.parse(result)).toEqual({
      ok: true,
      run: { id: 'aoi-research-test-1234', status: 'cancelled' },
    });
  });
});

describe('Aoi research path guards', () => {
  it('derives routes from full API paths', () => {
    expect(getAoiResearchRoute('/api/aoi-research/start')).toBe('/start');
    expect(getAoiResearchRoute('/api/aoi-research')).toBe('/');
    expect(getAoiResearchRoute('/api/tavily-search')).toBeNull();
  });

  it('accepts normal session paths and rejects traversal or absolute path attempts', () => {
    expect(normalizeAoiResearchSessionPath('aoi/default-mod')).toBe('aoi/default-mod');
    expect(normalizeAoiResearchSessionPath('/aoi/default-mod/')).toBe('aoi/default-mod');
    expect(normalizeAoiResearchSessionPath('../aoi')).toBeNull();
    expect(normalizeAoiResearchSessionPath('aoi/../other')).toBeNull();
    expect(normalizeAoiResearchSessionPath('C:\\Users\\secret')).toBeNull();
    expect(normalizeAoiResearchSessionPath('aoi//default')).toBeNull();
  });

  it('accepts only single-segment run ids', () => {
    expect(isValidAoiResearchRunId('aoi-research-labc123-deadbeef')).toBe(true);
    expect(isValidAoiResearchRunId('run_123')).toBe(true);
    expect(isValidAoiResearchRunId('../run_123')).toBe(false);
    expect(isValidAoiResearchRunId('run/123')).toBe(false);
    expect(isValidAoiResearchRunId('.')).toBe(false);
  });
});
