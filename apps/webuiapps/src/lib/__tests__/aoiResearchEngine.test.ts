import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMConfig } from '../llmModels';
import {
  AOI_RESEARCH_LIMITS,
  dedupeAoiResearchSearchCandidates,
  resolveAoiResearchRunTimeoutMs,
  startAoiResearchRun,
  validateAoiResearchSourceUrl,
  validateAoiResearchReport,
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

function makeLargeHtml(title: string): string {
  const paragraphs = Array.from(
    { length: AOI_RESEARCH_LIMITS.maxSourceBlocksPerSource + 24 },
    (_, index) =>
      `<p>Large source paragraph ${index + 1} contains concrete evidence and operational detail ${'A'.repeat(640)}</p>`,
  );
  return [
    '<!doctype html>',
    '<html><head>',
    `<title>${title}</title>`,
    '</head><body><article>',
    '<h1>Large research heading</h1>',
    ...paragraphs,
    '</article></body></html>',
  ].join('');
}

function makeValidSecurityReport(title: string, marker = '검증된 보고서'): string {
  return [
    `# ${title}`,
    '',
    '## Executive Summary',
    `${marker}는 수집된 근거를 기준으로 핵심 판단을 요약합니다 [S01].`,
    '',
    '## Scope and Assumptions',
    '이 보고서는 evidence ledger에 있는 주장만 근거로 사용하며 배경지식은 범위 밖으로 둡니다 [S01].',
    '',
    '## Key Findings',
    '- 수집된 출처는 요청 주제에 대한 구체적 근거를 제공합니다 [S01].',
    '',
    '## Technical Detail',
    '출처의 support text는 operational impact와 source attribution을 함께 설명합니다 [S01].',
    '',
    '## Comparison / Tradeoffs',
    '직접 인용 가능한 근거는 넓은 추정보다 우선되어야 하며, 약한 근거는 조건부로 다루어야 합니다 [S01].',
    '',
    '## Implementation Implications',
    '구현 단계에서는 인용 가능한 근거와 caveat를 함께 유지해야 합니다 [S01].',
    '',
    '## Risks and Unknowns',
    '수집 근거가 적거나 시간에 민감한 항목은 추가 검증 대상으로 남겨야 합니다 [S01].',
    '',
    '## Detection Opportunities',
    '탐지 설계는 근거가 있는 observable behavior부터 우선순위를 잡아야 합니다 [S01].',
    '',
    '## Operational Caveats',
    '운영 적용 전에는 오탐, 배포 환경, source freshness를 함께 점검해야 합니다 [S01].',
    '',
    '## Version Boundaries',
    '버전 의존 판단은 최신 제품 문서와 다시 대조해야 합니다 [S01].',
    '',
    '## Recommended Next Steps',
    '먼저 confidence가 높은 근거를 검증하고, caveat가 있는 주장은 후속 조사를 연결합니다 [S01].',
    '',
    '## Sources',
    '- [S01] src-001 - Accepted source. Site: source-a.example. Retrieved: 2027-01-15. URL: https://source-a.example/article',
    '',
  ].join('\n');
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

describe('Aoi research report validation', () => {
  it('detects citations that do not map to collected sources', () => {
    const report = makeValidSecurityReport('Missing citation test').replace(/\[S01\]/g, '[S99]');

    const issues = validateAoiResearchReport({
      report,
      request: 'Windows security telemetry',
      sources: [
        {
          version: 1,
          id: 'src-001',
          citationId: 'S01',
          url: 'https://source-a.example/article',
          finalUrl: 'https://source-a.example/article',
          title: 'Accepted source',
          siteName: 'source-a.example',
          blocks: [],
          status: 'accepted',
        },
      ],
      claims: [
        {
          version: 1,
          id: 'src-001-claim-1',
          sourceId: 'src-001',
          claim: 'Accepted source supports the requested research topic.',
          supportText: 'This source provides concrete evidence about the requested topic.',
          topicTags: ['evidence'],
          confidence: 0.82,
          caveats: [],
          createdAt: 1_800_000_000_000,
        },
      ],
    });

    expect(issues.map((issue) => issue.code)).toContain('unknown_citation_id');
  });

  it('requires citations in the report body, not only the Sources section', () => {
    const validReport = makeValidSecurityReport('Body citation test');
    const [body, sources] = validReport.split('\n## Sources\n');
    const report = `${body.replace(/\s\[S01\]/g, '')}\n## Sources\n${sources}`;

    const issues = validateAoiResearchReport({
      report,
      request: 'Windows security telemetry',
      sources: [
        {
          version: 1,
          id: 'src-001',
          citationId: 'S01',
          url: 'https://source-a.example/article',
          finalUrl: 'https://source-a.example/article',
          title: 'Accepted source',
          siteName: 'source-a.example',
          blocks: [],
          status: 'accepted',
        },
      ],
      claims: [
        {
          version: 1,
          id: 'src-001-claim-1',
          sourceId: 'src-001',
          claim: 'Accepted source supports the requested research topic.',
          supportText: 'This source provides concrete evidence about the requested topic.',
          topicTags: ['evidence'],
          confidence: 0.82,
          caveats: [],
          createdAt: 1_800_000_000_000,
        },
      ],
    });

    expect(issues.map((issue) => issue.code)).toContain('report_body_has_no_citations');
  });

  it('does not require evidence for citations that appear only in the Sources section', () => {
    const report = [
      makeValidSecurityReport('Sources-only citation test').trimEnd(),
      '- [S02] src-002 - Extra source. Site: source-b.example. Retrieved: 2027-01-15. URL: https://source-b.example/article',
      '',
    ].join('\n');

    const issues = validateAoiResearchReport({
      report,
      request: 'Windows security telemetry',
      sources: [
        {
          version: 1,
          id: 'src-001',
          citationId: 'S01',
          url: 'https://source-a.example/article',
          finalUrl: 'https://source-a.example/article',
          title: 'Accepted source',
          siteName: 'source-a.example',
          blocks: [],
          status: 'accepted',
        },
        {
          version: 1,
          id: 'src-002',
          citationId: 'S02',
          url: 'https://source-b.example/article',
          finalUrl: 'https://source-b.example/article',
          title: 'Extra source',
          siteName: 'source-b.example',
          blocks: [],
          status: 'accepted',
        },
      ],
      claims: [
        {
          version: 1,
          id: 'src-001-claim-1',
          sourceId: 'src-001',
          claim: 'Accepted source supports the requested research topic.',
          supportText: 'This source provides concrete evidence about the requested topic.',
          topicTags: ['evidence'],
          confidence: 0.82,
          caveats: [],
          createdAt: 1_800_000_000_000,
        },
      ],
    });

    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'citation_without_evidence',
          sourceIds: ['src-002'],
        }),
      ]),
    );
  });
});

describe('Aoi research engine', () => {
  it('uses a bounded configurable production run timeout', () => {
    expect(resolveAoiResearchRunTimeoutMs({})).toBe(12 * 60_000);
    expect(
      resolveAoiResearchRunTimeoutMs({ AOI_RESEARCH_RUN_TIMEOUT_MS: String(15 * 60_000) }),
    ).toBe(15 * 60_000);
    expect(resolveAoiResearchRunTimeoutMs({ AOI_RESEARCH_RUN_TIMEOUT_MS: '1' })).toBe(60_000);
    expect(resolveAoiResearchRunTimeoutMs({ AOI_RESEARCH_RUN_TIMEOUT_MS: '99999999' })).toBe(
      30 * 60_000,
    );
    expect(resolveAoiResearchRunTimeoutMs({ AOI_RESEARCH_RUN_TIMEOUT_MS: 'invalid' })).toBe(
      AOI_RESEARCH_LIMITS.defaultRunTimeoutMs,
    );
  });

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
      )
      .mockResolvedValueOnce(
        makeValidSecurityReport('Investigate Windows telemetry hardening', '최종 보고서'),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRewrite: false,
          findings: [],
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
    expect(phases).toContain('drafting_report');
    expect(phases).toContain('verifying_report');
    expect(manifest.reportTitle).toBe('Investigate Windows telemetry hardening');
    expect(manifest.claimCount).toBe(1);

    const sourcesArtifact = JSON.parse(fs.readFileSync(paths.sources, 'utf-8')) as {
      sources: Array<{ id: string; citationId?: string; status: string; error?: { code: string } }>;
    };
    const evidenceArtifact = JSON.parse(fs.readFileSync(paths.evidence, 'utf-8')) as {
      claims: Array<{ sourceId: string }>;
    };
    const report = fs.readFileSync(paths.report, 'utf-8');

    expect(sourcesArtifact.sources.map((source) => source.status)).toEqual(['accepted', 'failed']);
    expect(sourcesArtifact.sources[0].citationId).toBe('S01');
    expect(sourcesArtifact.sources[1].error?.code).toBe('source_http_error');
    expect(evidenceArtifact.claims.map((claim) => claim.sourceId)).toEqual(['src-001']);
    expect(report).toContain('## Executive Summary');
    expect(report).toContain('## Detection Opportunities');
    expect(report).toContain('## Operational Caveats');
    expect(report).toContain('## Version Boundaries');
    expect(report).toContain('[S01]');
    expect(report).toContain('## Sources');
  });

  it('does not keep stale blocking warnings after deterministic fallback fixes the report', async () => {
    const { root, paths } = makeTempPaths();
    const brokenDraft = makeValidSecurityReport(
      'Investigate Windows telemetry hardening',
      '초안 보고서',
    ).replace(/\n## Sources\n[\s\S]*$/u, '\n');
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
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(makeHtml('Accepted source'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const callModel = vi
      .fn()
      .mockResolvedValueOnce('planner returned malformed json')
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [
            {
              sourceId: 'src-001',
              claim: 'Accepted source supports the requested research topic.',
              supportText: 'This source provides concrete evidence about the requested topic.',
              tags: ['evidence'],
              confidence: 0.82,
              caveats: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(brokenDraft)
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRewrite: false,
          findings: [],
        }),
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRewrite: false,
          findings: [],
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
        maxSources: 1,
      },
      dependencies: {
        fetch: fetchImpl,
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => TAVILY_CONFIG,
        callModel,
        resolveHost: async () => ['93.184.216.34'],
        now: () => 1_800_000_000_000,
      },
    });

    const warningCodes = (manifest.verificationWarnings ?? []).map((warning) => warning.code);
    const blockingCodes = (manifest.verificationWarnings ?? [])
      .filter((warning) => warning.severity === 'blocking')
      .map((warning) => warning.code);
    const report = fs.readFileSync(paths.report, 'utf-8');

    expect(manifest.status).toBe('completed');
    expect(report).toContain('## Sources');
    expect(report).toContain('[S01]');
    expect(warningCodes).not.toContain('source_missing_from_sources_section');
    expect(warningCodes).not.toContain('missing_required_section');
    expect(blockingCodes).toEqual([]);
  });

  it('rewrites once for verifier blocking findings and persists remaining warnings', async () => {
    const { root, paths } = makeTempPaths();
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
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(makeHtml('Accepted source'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'Windows anti-cheat detection',
          researchQuestions: ['What can be detected?'],
          searchQueries: ['windows anti cheat detection evidence'],
          sourcePriorityRules: ['prefer primary'],
          exclusionRules: ['avoid spam'],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [
            {
              sourceId: 'src-001',
              claim: 'Accepted source supports anti-cheat detection analysis.',
              supportText: 'This source provides concrete evidence about the requested topic.',
              tags: ['anti-cheat', 'detection'],
              confidence: 0.82,
              caveats: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce('# Windows anti-cheat detection\n\nUnsupported body [S99]')
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRewrite: true,
          findings: [
            {
              severity: 'blocking',
              code: 'bad_citation',
              message: 'Report cites unknown source S99.',
              recommendation: 'Rewrite with S01 only.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeValidSecurityReport('Windows anti-cheat detection', '재작성된 보고서'),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRewrite: false,
          findings: [
            {
              severity: 'warning',
              code: 'time_sensitive_claim',
              message: 'Version-specific recommendations should be rechecked before release.',
              recommendation: 'Refresh vendor docs before enforcement.',
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
        request: 'Windows anti-cheat detection',
        mode: 'quick',
        language: 'ko',
        maxSources: 1,
      },
      dependencies: {
        fetch: fetchImpl,
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => TAVILY_CONFIG,
        callModel,
        resolveHost: async () => ['93.184.216.34'],
        now: () => 1_800_000_000_000,
      },
    });

    const report = fs.readFileSync(paths.report, 'utf-8');

    expect(manifest.status).toBe('completed');
    expect(callModel).toHaveBeenCalledTimes(6);
    expect(report).toContain('재작성된 보고서');
    expect(report).not.toContain('[S99]');
    expect(manifest.verificationWarnings?.map((warning) => warning.code)).toContain(
      'time_sensitive_claim',
    );
    expect(report).toContain('## Verification Warnings');
    expect(report).toContain('time_sensitive_claim');
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

  it('fails with a timeout checkpoint before starting the next phase', async () => {
    const { root, paths } = makeTempPaths();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const nowValues = [1_800_000_000_000, 1_800_000_000_000, 1_800_000_000_000, 1_800_000_000_010];
    const callModel = vi.fn(async () =>
      JSON.stringify({
        title: 'Timeout research',
        researchQuestions: ['question'],
        searchQueries: ['timeout query'],
        sourcePriorityRules: ['rule'],
        exclusionRules: ['rule'],
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
        request: 'Timeout this research',
      },
      dependencies: {
        fetch: fetchImpl,
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => TAVILY_CONFIG,
        callModel,
        now: () => nowValues.shift() ?? 1_800_000_000_010,
        runTimeoutMs: 5,
      },
    });

    expect(manifest.status).toBe('failed');
    expect(manifest.error?.code).toBe('research_run_timeout');
    expect(manifest.error?.phase).toBe('searching');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.report, 'utf-8')).toContain('Research run timed out');
  });

  it('caps source artifact blocks and keeps artifact JSON bounded', async () => {
    const { root, paths } = makeTempPaths();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TAVILY_CONFIG.baseUrl) {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'Large accepted source',
                url: 'https://source-large.example/article',
                content: 'Large accepted source summary',
                score: 0.9,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(makeLargeHtml('Large accepted source'), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const callModel = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'Large artifact cap',
          researchQuestions: ['question'],
          searchQueries: ['large source query'],
          sourcePriorityRules: ['rule'],
          exclusionRules: ['rule'],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          claims: [
            {
              sourceId: 'src-001',
              claim: 'Large source supports artifact cap validation.',
              supportText:
                'Large source paragraph contains concrete evidence and operational detail.',
              tags: ['artifact'],
              confidence: 0.82,
              caveats: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(makeValidSecurityReport('Large artifact cap', '대형 artifact 테스트'))
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRewrite: false,
          findings: [],
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
        request: 'Large artifact cap',
        mode: 'quick',
        maxSources: 1,
      },
      dependencies: {
        fetch: fetchImpl,
        loadLlmConfig: () => LLM_CONFIG,
        loadTavilyConfig: () => TAVILY_CONFIG,
        callModel,
        resolveHost: async () => ['93.184.216.34'],
        now: () => 1_800_000_000_000,
      },
    });

    const rawSources = fs.readFileSync(paths.sources, 'utf-8');
    const sourcesArtifact = JSON.parse(rawSources) as {
      sources: Array<{ blocks: Array<{ text: string }> }>;
    };

    expect(manifest.status).toBe('completed');
    expect(Buffer.byteLength(rawSources, 'utf-8')).toBeLessThanOrEqual(
      AOI_RESEARCH_LIMITS.maxJsonArtifactBytes,
    );
    expect(sourcesArtifact.sources[0].blocks.length).toBeLessThanOrEqual(
      AOI_RESEARCH_LIMITS.maxSourceBlocksPerSource,
    );
    expect(sourcesArtifact.sources[0].blocks[0].text.length).toBeLessThanOrEqual(360);
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
