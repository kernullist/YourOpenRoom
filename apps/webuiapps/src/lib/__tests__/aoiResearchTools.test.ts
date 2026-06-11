import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
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
  AOI_RESEARCH_MAX_CONCURRENT_RUNS,
  getActiveResearchStartConflict,
  getAoiResearchRoute,
  isValidAoiResearchRunId,
  listAoiResearchRunSummaries,
  normalizeAoiResearchSessionPath,
} from '../aoiResearchPlugin';
import type { AoiResearchManifest } from '../aoiResearchTypes';

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
      allowDuplicate: false,
    });
    expect(normalizeStartResearchParams({ request: 'rerun', allow_duplicate: true })).toMatchObject(
      {
        allowDuplicate: true,
      },
    );
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
        allowDuplicate: false,
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

describe('Aoi research run listing and lifecycle gates', () => {
  function makeManifest(params: {
    id: string;
    request: string;
    status: AoiResearchManifest['status'];
    updatedAt: number;
  }): AoiResearchManifest {
    return {
      version: 1,
      id: params.id,
      sessionPath: 'aoi/default',
      request: params.request,
      mode: 'standard',
      language: 'match-user',
      recency: 'any',
      maxSources: 12,
      createdAt: params.updatedAt - 100,
      updatedAt: params.updatedAt,
      status: params.status,
      phase: params.status === 'completed' ? 'completed' : 'searching',
      statusMessage: `${params.status} run`,
      sourceCounts: {
        planned: 12,
        candidates: 5,
        accepted: 3,
        failed: 1,
      },
      artifactPaths: {
        manifest: `aoi-research/runs/${params.id}/manifest.json`,
        report: `aoi-research/runs/${params.id}/report.md`,
        sources: `aoi-research/runs/${params.id}/sources.json`,
        evidence: `aoi-research/runs/${params.id}/evidence.json`,
      },
      artifactAvailability: {
        manifest: true,
        report: true,
        sources: true,
        evidence: true,
      },
      reportTitle: params.request,
      completedAt: params.status === 'completed' ? params.updatedAt : undefined,
    };
  }

  function writeManifest(root: string, manifest: AoiResearchManifest): void {
    const runDir = join(root, manifest.sessionPath, 'aoi-research', 'runs', manifest.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    fs.writeFileSync(join(runDir, 'report.md'), '# Report', 'utf-8');
  }

  it('lists compact manifest summaries without report content', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-research-list-'));
    writeManifest(
      root,
      makeManifest({
        id: 'aoi-research-old-001',
        request: 'Old research',
        status: 'completed',
        updatedAt: 1_800_000_000_000,
      }),
    );
    writeManifest(
      root,
      makeManifest({
        id: 'aoi-research-new-001',
        request: 'New research',
        status: 'running',
        updatedAt: 1_800_000_001_000,
      }),
    );

    const summaries = listAoiResearchRunSummaries(root, 'aoi/default');

    expect(summaries.map((run) => run.id)).toEqual([
      'aoi-research-new-001',
      'aoi-research-old-001',
    ]);
    expect(JSON.stringify(summaries)).not.toContain('# Report');
    expect(summaries[0]).toMatchObject({
      request: 'New research',
      status: 'running',
      warningCount: 0,
      verificationWarningCount: 0,
    });
  });

  it('blocks duplicate active runs unless explicitly allowed and enforces concurrency cap', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-research-conflict-'));
    writeManifest(
      root,
      makeManifest({
        id: 'aoi-research-active-001',
        request: 'Investigate ETW telemetry',
        status: 'running',
        updatedAt: 1_800_000_001_000,
      }),
    );
    writeManifest(
      root,
      makeManifest({
        id: 'aoi-research-active-002',
        request: 'Investigate TPM posture',
        status: 'queued',
        updatedAt: 1_800_000_002_000,
      }),
    );

    expect(
      getActiveResearchStartConflict({
        sessionsDir: root,
        sessionPath: 'aoi/default',
        request: {
          sessionPath: 'aoi/default',
          request: '  Investigate ETW telemetry  ',
        },
        allowDuplicate: false,
      })?.code,
    ).toBe('duplicate_active_run');

    const duplicateAllowedRoot = fs.mkdtempSync(join(os.tmpdir(), 'aoi-research-allow-'));
    writeManifest(
      duplicateAllowedRoot,
      makeManifest({
        id: 'aoi-research-active-003',
        request: 'Investigate ETW telemetry',
        status: 'running',
        updatedAt: 1_800_000_003_000,
      }),
    );
    expect(
      getActiveResearchStartConflict({
        sessionsDir: duplicateAllowedRoot,
        sessionPath: 'aoi/default',
        request: {
          sessionPath: 'aoi/default',
          request: 'Investigate ETW telemetry',
        },
        allowDuplicate: true,
      }),
    ).toBeNull();

    expect(
      getActiveResearchStartConflict({
        sessionsDir: root,
        sessionPath: 'aoi/default',
        request: {
          sessionPath: 'aoi/default',
          request: 'Different topic',
        },
        allowDuplicate: false,
      })?.code,
    ).toBe('too_many_active_runs');
    expect(AOI_RESEARCH_MAX_CONCURRENT_RUNS).toBe(2);
  });
});

describe('Aoi research docs/config examples', () => {
  it('keeps the checked-in config example valid JSON with Tavily config present', () => {
    const raw = fs.readFileSync(join(process.cwd(), '../../docs/config.example.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { tavily?: { apiKey?: string; baseUrl?: string } };

    expect(parsed.tavily?.apiKey).toBeTruthy();
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
