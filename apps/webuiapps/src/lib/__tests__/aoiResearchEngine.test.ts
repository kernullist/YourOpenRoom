import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMConfig } from '../llmModels';
import {
  dedupeAoiResearchSearchCandidates,
  startAoiResearchRun,
  validateAoiResearchSourceUrl,
  type AoiResearchRunPaths,
  type AoiResearchTavilyConfig,
} from '../aoiResearchEngine';

const LLM_CONFIG: LLMConfig = {
  provider: 'codex-cli',
  apiKey: '',
  baseUrl: '',
  model: 'test-model',
};

const TAVILY_CONFIG: AoiResearchTavilyConfig = {
  apiKey: 'tvly-test',
  baseUrl: 'https://api.tavily.com/search',
};

function makeTempPaths(): { root: string; paths: AoiResearchRunPaths } {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-research-engine-'));
  const runDir = join(root, 'session', 'aoi-research', 'runs', 'run-test-001');
  return {
    root,
    paths: {
      runDir,
      manifest: join(runDir, 'manifest.json'),
      report: join(runDir, 'report.md'),
      sources: join(runDir, 'sources.json'),
      evidence: join(runDir, 'evidence.json'),
    },
  };
}

function makeHtml(title: string): string {
  return [
    '<!doctype html>',
    '<html><head>',
    `<title>${title}</title>`,
    '<meta name="description" content="This page has useful research evidence.">',
    '</head><body><article>',
    '<h1>Research heading</h1>',
    '<p>This source provides concrete evidence about the requested topic and explains the operational impact in detail.</p>',
    '<p>The support text is specific enough for evidence extraction and source attribution.</p>',
    '</article></body></html>',
  ].join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Aoi research URL safety', () => {
  it('rejects non-web, loopback, and privately resolved URLs', async () => {
    await expect(validateAoiResearchSourceUrl('file:///C:/secret.txt')).resolves.toMatchObject({
      ok: false,
      errorCode: 'unsupported_protocol',
    });
    await expect(validateAoiResearchSourceUrl('http://127.0.0.1/admin')).resolves.toMatchObject({
      ok: false,
      errorCode: 'private_network_rejected',
    });
    await expect(
      validateAoiResearchSourceUrl('https://private.example/page', async () => ['10.1.2.3']),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'private_network_rejected',
    });
    await expect(
      validateAoiResearchSourceUrl('https://example.com/page#section', async () => [
        '93.184.216.34',
      ]),
    ).resolves.toMatchObject({
      ok: true,
      normalizedUrl: 'https://example.com/page',
    });
  });
});

describe('Aoi research search candidate handling', () => {
  it('deduplicates by normalized URL and near-identical titles', () => {
    const deduped = dedupeAoiResearchSearchCandidates([
      {
        title: 'Windows telemetry research',
        url: 'https://example.com/post?utm_source=x#top',
        content: 'one',
        searchQuery: 'q1',
      },
      {
        title: 'Windows telemetry research',
        url: 'https://example.com/post',
        content: 'duplicate url',
        searchQuery: 'q2',
      },
      {
        title: 'Windows telemetry research!!!',
        url: 'https://other.example/post',
        content: 'duplicate title',
        searchQuery: 'q3',
      },
      {
        title: 'Independent source',
        url: 'https://third.example/post',
        content: 'unique',
        searchQuery: 'q4',
      },
    ]);

    expect(deduped.map((item) => item.url)).toEqual([
      'https://example.com/post?utm_source=x#top',
      'https://third.example/post',
    ]);
  });
});

describe('Aoi research engine', () => {
  it('completes with a fallback plan, partial source failure, and real source ids', async () => {
    const { root, paths } = makeTempPaths();
    const phases: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TAVILY_CONFIG.baseUrl) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Accepted source',
                url: 'https://source-a.example/article',
                content: 'Accepted source summary',
                score: 0.9,
              },
              {
                title: 'Failing source',
                url: 'https://source-b.example/article',
                content: 'Failing source summary',
                score: 0.8,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://source-a.example/article') {
        return new Response(makeHtml('Accepted source'), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('nope', { status: 500 });
    });
    const callModel = vi
      .fn()
      .mockResolvedValueOnce('planner returned malformed json')
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [
            {
              sourceId: 'model-chosen-id',
              claim: 'Accepted source supports the requested research topic.',
              supportText: 'This source provides concrete evidence about the requested topic.',
              tags: ['evidence'],
              confidence: 0.82,
              caveats: [],
            },
          ],
        }),
      );

    const manifest = await startAoiResearchRun({
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://localhost:3000',
      sessionPath: 'aoi/default',
      runId: 'run-test-001',
      paths,
      request: {
        sessionPath: 'aoi/default',
        request: 'Investigate Windows telemetry hardening',
        mode: 'standard',
        language: 'ko',
        maxSources: 2,
      },
      dependencies: {
        fetch: fetchImpl,
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => TAVILY_CONFIG,
        callModel,
        resolveHost: async () => ['93.184.216.34'],
        now: () => 1_800_000_000_000,
        onPhase: (phase) => {
          phases.push(phase);
        },
      },
    });

    expect(manifest.status).toBe('completed');
    expect(manifest.phase).toBe('completed');
    expect(manifest.plan?.title).toBe('Investigate Windows telemetry hardening');
    expect(manifest.sourceCounts).toMatchObject({ candidates: 2, accepted: 1, failed: 1 });
    expect(manifest.artifactAvailability).toEqual({
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    });
    expect(phases).toContain('planning');
    expect(phases).toContain('reading_sources');
    expect(phases).toContain('extracting_evidence');

    const sourcesArtifact = JSON.parse(fs.readFileSync(paths.sources, 'utf-8')) as {
      sources: Array<{ id: string; status: string; error?: { code: string } }>;
    };
    const evidenceArtifact = JSON.parse(fs.readFileSync(paths.evidence, 'utf-8')) as {
      claims: Array<{ sourceId: string }>;
    };

    expect(sourcesArtifact.sources.map((source) => source.status)).toEqual(['accepted', 'failed']);
    expect(sourcesArtifact.sources[1].error?.code).toBe('source_http_error');
    expect(evidenceArtifact.claims.map((claim) => claim.sourceId)).toEqual(['src-001']);
    expect(fs.readFileSync(paths.report, 'utf-8')).toContain('Accepted sources: 1');
  });

  it('cancels before search work when cancellation is observed', async () => {
    const { root, paths } = makeTempPaths();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const manifest = await startAoiResearchRun({
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://localhost:3000',
      sessionPath: 'aoi/default',
      runId: 'run-test-001',
      paths,
      request: {
        sessionPath: 'aoi/default',
        request: 'Cancel this research',
      },
      dependencies: {
        fetch: fetchImpl,
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => TAVILY_CONFIG,
        callModel: async () =>
          JSON.stringify({
            title: 'Cancel this research',
            researchQuestions: ['question'],
            searchQueries: ['cancel query'],
            sourcePriorityRules: ['rule'],
            exclusionRules: ['rule'],
          }),
        shouldCancel: async (_runId, phase) => phase === 'searching',
        now: () => 1_800_000_000_000,
      },
    });

    expect(manifest.status).toBe('cancelled');
    expect(manifest.phase).toBe('cancelled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails clearly when Tavily is not configured', async () => {
    const { root, paths } = makeTempPaths();

    const manifest = await startAoiResearchRun({
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://localhost:3000',
      sessionPath: 'aoi/default',
      runId: 'run-test-001',
      paths,
      request: {
        sessionPath: 'aoi/default',
        request: 'Investigate missing Tavily config',
      },
      dependencies: {
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => null,
        now: () => 1_800_000_000_000,
      },
    });

    expect(manifest.status).toBe('failed');
    expect(manifest.error?.code).toBe('tavily_not_configured');
    expect(JSON.parse(fs.readFileSync(paths.evidence, 'utf-8'))).toMatchObject({
      claims: [],
    });
  });
});
