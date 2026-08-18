import { describe, expect, it } from 'vitest';
import {
  buildWebSearchPolicyPromptBlock,
  condenseConversationHistory,
  isVolatileClaimChallenge,
  resolveAoiActionConfirmationRequest,
  resolveAoiResearchConfirmationRequest,
  shouldEnableAppTools,
  shouldUseAoiResearchRun,
  shouldUseDialogModel,
  shouldUseWebSearch,
  summarizeToolResultForModel,
  truncateForTokenBudget,
} from '../chatTokenControl';
import { buildMemoryPrompt, selectMemoriesForPrompt, type MemoryEntry } from '../memoryManager';
import { buildFileReadResponse } from '../fileTools';

describe('condenseConversationHistory()', () => {
  it('keeps short histories unchanged', () => {
    const history = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];

    expect(condenseConversationHistory(history)).toEqual({
      summaryMessage: null,
      recentHistory: history,
    });
  });

  it('summarizes older history and preserves recent messages', () => {
    const history = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${index + 1}`,
    }));

    const condensed = condenseConversationHistory(history);
    expect(condensed.summaryMessage?.role).toBe('system');
    expect(condensed.summaryMessage?.content).toContain('Earlier conversation summary');
    expect(condensed.recentHistory).toHaveLength(12);
    expect(condensed.recentHistory[0].content).toBe('message 7');
  });
});

describe('summarizeToolResultForModel()', () => {
  it('shrinks Tavily search results to a compact JSON payload', () => {
    const raw = JSON.stringify({
      query: 'latest launch',
      answer: 'A'.repeat(800),
      results: [
        { title: 'One', url: 'https://one.test', content: 'B'.repeat(500) },
        { title: 'Two', url: 'https://two.test', content: 'C'.repeat(500) },
        { title: 'Three', url: 'https://three.test', content: 'D'.repeat(500) },
        { title: 'Four', url: 'https://four.test', content: 'E'.repeat(500) },
      ],
    });

    const summarized = summarizeToolResultForModel('search_web', raw);
    const parsed = JSON.parse(summarized) as {
      answer: string;
      results: Array<{ content: string }>;
    };

    expect(parsed.answer.length).toBeLessThan(520);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0].content.length).toBeLessThan(240);
  });

  it('caps list-like tool output to the first lines', () => {
    const raw = Array.from({ length: 100 }, (_, index) => `item ${index + 1}`).join('\n');
    const summarized = summarizeToolResultForModel('file_list', raw);
    expect(summarized).toContain('item 1');
    expect(summarized).toContain('more lines truncated');
    expect(summarized).not.toContain('item 100');
  });

  it('preserves app names in app_action results', () => {
    const summarized = summarizeToolResultForModel(
      'app_action',
      JSON.stringify({
        ok: true,
        source_app: { app_id: 1, app_name: 'os', display_name: 'OS' },
        target_app: {
          app_id: 22,
          app_name: 'dewdropcanvas',
          display_name: 'Dewdrop Canvas',
        },
        action_type: 'OPEN_APP',
        params: { app_id: '22' },
        user_facing_name: 'Dewdrop Canvas',
        raw_result: 'success',
      }),
    );
    const parsed = JSON.parse(summarized) as {
      target_app: { display_name: string };
      user_facing_name: string;
    };

    expect(parsed.target_app.display_name).toBe('Dewdrop Canvas');
    expect(parsed.user_facing_name).toBe('Dewdrop Canvas');
  });

  it('preserves app intent control surface gaps in compact summaries', () => {
    const summarized = summarizeToolResultForModel(
      'get_app_intents',
      JSON.stringify({
        ok: false,
        error: 'unsupported_app_intent',
        app: { app_id: 25, app_name: 'aoimemory', display_name: 'Aoi Memory' },
        requested_intent: 'delete memory',
        available_intents: Array.from({ length: 20 }, (_, index) => ({
          intent: `intent-${index}`,
        })),
        control_surface_summary: { surface_count: 4, partial_count: 1, gap_count: 1 },
        control_surfaces: [
          {
            surface: 'memory_records',
            coverage: 'partial',
            gaps: ['Missing action: DELETE_AOI_MEMORY', 'Missing schema: aoimemory-memory'],
          },
        ],
      }),
    );
    const parsed = JSON.parse(summarized) as {
      control_surface_summary: { surface_count: number };
      control_surfaces: Array<{ surface: string; gaps: string[] }>;
      intents: Array<{ intent: string }>;
    };

    expect(parsed.control_surface_summary.surface_count).toBe(4);
    expect(parsed.control_surfaces[0].surface).toBe('memory_records');
    expect(parsed.control_surfaces[0].gaps).toContain('Missing action: DELETE_AOI_MEMORY');
    expect(parsed.intents).toHaveLength(12);
  });

  it('keeps workspace search payloads compact', () => {
    const raw = JSON.stringify({
      query: 'notes',
      directory: 'apps',
      total_matches: 9,
      has_more: true,
      matches: Array.from({ length: 9 }, (_, index) => ({
        path: `apps/notes/data/notes/note-${index + 1}.json`,
        type: 'file',
        match_type: 'content',
        snippets: [
          { line: 1, text: 'A'.repeat(320) },
          { line: 2, text: 'B'.repeat(320) },
          { line: 3, text: 'C'.repeat(320) },
        ],
      })),
    });

    const summarized = summarizeToolResultForModel('workspace_search', raw);
    const parsed = JSON.parse(summarized) as {
      matches: Array<{ snippets: Array<{ text: string }> }>;
      total_matches: number;
      has_more: boolean;
    };

    expect(parsed.total_matches).toBe(9);
    expect(parsed.has_more).toBe(true);
    expect(parsed.matches).toHaveLength(5);
    expect(parsed.matches[0].snippets).toHaveLength(2);
    expect(parsed.matches[0].snippets[0].text.length).toBeLessThan(170);
  });

  it('preserves disk SHA-256 evidence in compact IDE read summaries', () => {
    const hash = 'a'.repeat(64);
    const summarized = JSON.parse(
      summarizeToolResultForModel(
        'ide_read_file',
        JSON.stringify({
          path: 'written-by-me/output/status.md',
          source: 'disk',
          line_count: 18,
          char_count: 700,
          byte_count: 712,
          modified_at: 1234,
          sha256: hash,
          hash_scope: 'full_disk_file_bytes',
          content_truncated: false,
          content: 'verified',
        }),
      ),
    ) as { sha256: string; hash_scope: string; byte_count: number };

    expect(summarized.sha256).toBe(hash);
    expect(summarized.hash_scope).toBe('full_disk_file_bytes');
    expect(summarized.byte_count).toBe(712);
  });

  it('compacts read_url and run_command payloads', () => {
    const urlSummary = JSON.parse(
      summarizeToolResultForModel(
        'read_url',
        JSON.stringify({
          url: 'https://example.com',
          final_url: 'https://example.com/final',
          title: 'Example',
          site_name: 'example.com',
          excerpt: 'X'.repeat(500),
          blocks: Array.from({ length: 10 }, () => ({
            type: 'paragraph',
            text: 'Y'.repeat(300),
          })),
        }),
      ),
    ) as { blocks: Array<{ text: string }>; excerpt: string };

    const commandSummary = JSON.parse(
      summarizeToolResultForModel(
        'run_command',
        JSON.stringify({
          command: 'pnpm test',
          cwd: 'apps/webuiapps',
          exitCode: 0,
          stdout: 'A'.repeat(1500),
          stderr: 'B'.repeat(1500),
        }),
      ),
    ) as { stdout: string; stderr: string };

    expect(urlSummary.blocks).toHaveLength(6);
    expect(urlSummary.blocks[0].text.length).toBeLessThan(190);
    expect(urlSummary.excerpt.length).toBeLessThan(230);
    expect(commandSummary.stdout.length).toBeLessThan(750);
    expect(commandSummary.stderr.length).toBeLessThan(750);
  });

  it('compacts Aoi research status and report artifacts', () => {
    const statusSummary = JSON.parse(
      summarizeToolResultForModel(
        'start_research',
        JSON.stringify({
          ok: true,
          background: true,
          run: {
            id: 'aoi-research-test-1234',
            status: 'running',
            phase: 'reading_sources',
            statusMessage: 'Reading candidate sources.',
            artifactAvailability: { manifest: true, report: true, sources: true, evidence: true },
            sourceCounts: { planned: 12, candidates: 4, accepted: 2, failed: 1 },
          },
          artifactPaths: { report: 'aoi-research/runs/aoi-research-test-1234/report.md' },
        }),
      ),
    ) as { run: { id: string; phase: string }; background: boolean };

    const reportSummary = JSON.parse(
      summarizeToolResultForModel(
        'read_research_artifact',
        JSON.stringify({
          ok: true,
          runId: 'aoi-research-test-1234',
          run: {
            id: 'aoi-research-test-1234',
            status: 'completed',
            phase: 'completed',
            reportTitle: 'Research report',
          },
          artifact: 'report',
          contentType: 'text/markdown',
          content: `# Research report\n\n${'A'.repeat(8000)}`,
        }),
      ),
    ) as { content: string; run: { status: string }; artifact: string };

    expect(statusSummary.background).toBe(true);
    expect(statusSummary.run.id).toBe('aoi-research-test-1234');
    expect(statusSummary.run.phase).toBe('reading_sources');
    expect(reportSummary.artifact).toBe('report');
    expect(reportSummary.run.status).toBe('completed');
    expect(reportSummary.content.length).toBeLessThan(6200);
  });
});

describe('shouldEnableAppTools()', () => {
  it('enables tools for explicit app mentions', () => {
    expect(shouldEnableAppTools("Open Aoi's IDE")).toBe(true);
    expect(shouldEnableAppTools('유튜브에서 틀어줘')).toBe(true);
    expect(shouldEnableAppTools('Open Dewdrop Canvas')).toBe(true);
    expect(shouldEnableAppTools('룸샵 열어줘')).toBe(true);
  });

  it('enables tools for URL-reading and app-state questions', () => {
    expect(shouldEnableAppTools('Can you summarize this URL for me?')).toBe(true);
    expect(shouldEnableAppTools('Which window is currently active?')).toBe(true);
    expect(shouldEnableAppTools('Find the ChatPanel component in the codebase')).toBe(true);
    expect(shouldEnableAppTools('현재 파일 내용을 검토해줘')).toBe(true);
    expect(shouldEnableAppTools('방금 말한 내용을 현재 파일에 써줘')).toBe(true);
  });

  it('does not enable tools for generic web questions', () => {
    expect(shouldEnableAppTools('Can you verify this fact on the web?')).toBe(false);
  });

  it('supports short follow-ups when recent context already mentions an app', () => {
    expect(
      shouldEnableAppTools('open it', [
        { role: 'user', content: 'Please use the browser app for this link' },
      ]),
    ).toBe(true);
  });

  it('enables tools for Kira settings changes and apply-style follow-ups', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'Kira 모델 설정은 reasoning을 high로 두고 run mode는 deep으로 맞추는 걸 추천해.',
      },
    ];

    expect(shouldEnableAppTools('Kira 모델 설정을 직접하게 변경해줘')).toBe(true);
    expect(shouldEnableAppTools('그렇게 설정해줘', history)).toBe(true);
    expect(shouldEnableAppTools('그대로 적용해줘', history)).toBe(true);
  });

  it('does not enable tools for descriptive app mentions', () => {
    expect(shouldEnableAppTools('Kira 설정 좋네')).toBe(false);
    expect(shouldEnableAppTools('Kira 좋네')).toBe(false);
    expect(shouldEnableAppTools('I use Kira daily')).toBe(false);
  });

  it('enables tools for app setting inspection requests', () => {
    expect(shouldEnableAppTools('Kira 모델 설정 뭐야?')).toBe(true);
    expect(shouldEnableAppTools('What are Kira model settings?')).toBe(true);
    expect(shouldEnableAppTools('Please use Kira for this')).toBe(true);
  });

  it('enables tools for common contextual execution follow-ups', () => {
    const scenarios: Array<{
      latest: string;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
    }> = [
      {
        latest: '좋아 진행해줘',
        history: [
          {
            role: 'assistant',
            content: 'Kira 모델 설정을 high/deep으로 맞추는 작업을 진행할 수 있어.',
          },
        ],
      },
      {
        latest: '거기에 방금 내용 붙여줘',
        history: [
          { role: 'user', content: '현재 파일에 새 섹션을 추가하고 싶어.' },
          { role: 'assistant', content: '현재 파일 위치를 확인했고 편집 준비가 됐어.' },
        ],
      },
      {
        latest: '실행해줘',
        history: [
          {
            role: 'assistant',
            content: '검증 명령은 pnpm --dir apps/webuiapps test -- chatTokenControl 이야.',
          },
        ],
      },
      {
        latest: '응, 열어줘',
        history: [
          {
            role: 'assistant',
            content: '브라우저에서 https://example.com 페이지를 열어볼까?',
          },
        ],
      },
      {
        latest: 'run it',
        history: [
          {
            role: 'assistant',
            content: 'The command to verify this is pnpm --dir apps/webuiapps test.',
          },
        ],
      },
      {
        latest: 'apply that',
        history: [
          {
            role: 'assistant',
            content: 'Aoi Research can record this as a cited research run.',
          },
        ],
      },
    ];

    for (const scenario of scenarios) {
      expect(shouldEnableAppTools(scenario.latest, scenario.history)).toBe(true);
    }
  });
});

describe('shouldUseDialogModel()', () => {
  it('uses the cheaper dialog model for short social turns', () => {
    expect(shouldUseDialogModel('That sounds nice')).toBe(true);
    expect(shouldUseDialogModel('고마워, 그럼 그렇게 하자')).toBe(true);
    expect(shouldUseDialogModel('Kira 좋네')).toBe(true);
    expect(shouldUseDialogModel('Kira 설정 좋네')).toBe(true);
    expect(shouldUseDialogModel('I use Kira daily')).toBe(true);
    expect(shouldUseDialogModel("Aoi's IDE 꽤 마음에 들어")).toBe(true);
  });

  it('keeps heavier intents on the main model', () => {
    expect(shouldUseDialogModel('Open the browser and search for the latest news')).toBe(false);
    expect(shouldUseDialogModel('Open Written By Me')).toBe(false);
    expect(shouldUseDialogModel('Can you verify this fact on the web?')).toBe(false);
    expect(shouldUseDialogModel("Aoi's IDE 열어줘")).toBe(false);
    expect(shouldUseDialogModel('유튜브에서 틀어줘')).toBe(false);
    expect(shouldUseDialogModel('Can you summarize this URL for me?')).toBe(false);
    expect(shouldUseDialogModel('Which window is currently active?')).toBe(false);
    expect(shouldUseDialogModel('Find the ChatPanel component in the codebase')).toBe(false);
    expect(shouldUseDialogModel('현재 파일에 TODO 내용을 추가해줘')).toBe(false);
    expect(shouldUseDialogModel('방금 말한 내용을 현재 파일어 써줘')).toBe(false);
    expect(shouldUseDialogModel('Kira 모델 설정 뭐야?')).toBe(false);
    expect(shouldUseDialogModel('What are Kira model settings?')).toBe(false);
    expect(shouldUseDialogModel('Please use Kira for this')).toBe(false);
  });

  it('keeps host Chrome / browser-drive access requests on the main model', () => {
    // Regression: "접근해봐" used to fall through to the dialog route, which only
    // exposes respond_to_user/finish_target, so Aoi claimed she had no browser
    // tools even after Host PC browser capabilities were enabled.
    expect(shouldUseDialogModel('크롬브라우저 접근해봐')).toBe(false);
    expect(shouldUseDialogModel('내 PC 크롬 브라우저 접근해봐')).toBe(false);
    expect(shouldUseDialogModel('내 크롬에 접속해봐')).toBe(false);
    expect(shouldUseDialogModel('크롬 열어줘')).toBe(false);
    expect(shouldUseDialogModel('Chrome 열어봐')).toBe(false);
    expect(shouldUseDialogModel('Access my Chrome browser')).toBe(false);
    expect(shouldUseDialogModel('host_browser_read 로 example.com 읽어봐')).toBe(false);
    expect(shouldUseDialogModel('브라우저 드라이브로 네이버 확인해봐')).toBe(false);
  });

  it('keeps Kira settings execution requests on the main model with app tools', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'Kira 모델 설정은 reasoning을 high로 두고 run mode는 deep으로 맞추는 걸 추천해.',
      },
    ];

    expect(shouldUseDialogModel('Kira 모델 설정을 직접하게 변경해줘')).toBe(false);
    expect(shouldUseDialogModel('그렇게 설정해줘', history)).toBe(false);
  });

  it('keeps contextual execution follow-ups on the main model', () => {
    const scenarios: Array<{
      latest: string;
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
    }> = [
      {
        latest: '좋아 진행해줘',
        history: [
          {
            role: 'assistant',
            content: 'Kira 모델 설정을 high/deep으로 맞추는 작업을 진행할 수 있어.',
          },
        ],
      },
      {
        latest: '거기에 방금 내용 붙여줘',
        history: [
          { role: 'user', content: '현재 파일에 새 섹션을 추가하고 싶어.' },
          { role: 'assistant', content: '현재 파일 위치를 확인했고 편집 준비가 됐어.' },
        ],
      },
      {
        latest: '실행해줘',
        history: [
          {
            role: 'assistant',
            content: '검증 명령은 pnpm --dir apps/webuiapps test -- chatTokenControl 이야.',
          },
        ],
      },
      {
        latest: '응, 열어줘',
        history: [
          {
            role: 'assistant',
            content: '브라우저에서 https://example.com 페이지를 열어볼까?',
          },
        ],
      },
      {
        latest: 'run it',
        history: [
          {
            role: 'assistant',
            content: 'The command to verify this is pnpm --dir apps/webuiapps test.',
          },
        ],
      },
    ];

    for (const scenario of scenarios) {
      expect(shouldUseDialogModel(scenario.latest, scenario.history)).toBe(false);
    }
  });

  it('keeps affirmative research confirmations on the main model', () => {
    const history = [
      {
        role: 'assistant' as const,
        content:
          '꿀보, 아까 네가 "최신 Windows 커널 드라이버 보안 연구 동향 조사" 얘기했잖아? 웹에서 조사해볼까? 그 결과를 바로 이 Aoi Research 앱에 Run으로 기록해줄게. 어때, 한번 해볼까?',
      },
      { role: 'user' as const, content: '응' },
    ];

    expect(resolveAoiResearchConfirmationRequest('응', history)).toBe(
      '최신 Windows 커널 드라이버 보안 연구 동향 조사',
    );
    expect(resolveAoiActionConfirmationRequest('응', history)).toContain(
      'Aoi Research 앱에 Run으로 기록해줄게',
    );
    expect(shouldUseAoiResearchRun('응', history)).toBe(true);
    expect(shouldUseDialogModel('응', history)).toBe(false);
  });

  it('keeps affirmative app-action confirmations on the main model with app tools', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: "꿀보, Aoi's IDE를 열어줄까?",
      },
      { role: 'user' as const, content: '응' },
    ];

    expect(resolveAoiActionConfirmationRequest('응', history)).toBe("꿀보, Aoi's IDE를 열어줄까?");
    expect(shouldUseAoiResearchRun('응', history)).toBe(false);
    expect(shouldEnableAppTools('응', history)).toBe(true);
    expect(shouldUseDialogModel('응', history)).toBe(false);
  });

  it('supports concise English action proposals as confirmation context', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'Open Dewdrop Canvas?',
      },
      { role: 'user' as const, content: 'ok' },
    ];

    expect(resolveAoiActionConfirmationRequest('ok', history)).toBe('Open Dewdrop Canvas?');
    expect(shouldEnableAppTools('ok', history)).toBe(true);
    expect(shouldUseDialogModel('ok', history)).toBe(false);
  });

  it('does not promote affirmative replies to non-actionable assistant context', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '꿀보, 오늘은 천천히 해도 괜찮아.',
      },
      { role: 'user' as const, content: '응' },
    ];

    expect(resolveAoiActionConfirmationRequest('응', history)).toBeNull();
    expect(resolveAoiResearchConfirmationRequest('응', history)).toBeNull();
    expect(shouldUseDialogModel('응', history)).toBe(true);
  });

  it('keeps social follow-ups on the dialog model even when recent text mentions apps', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'Kira 보드가 열려 있고 Aoi Research도 사용할 수 있어.',
      },
    ];

    expect(shouldEnableAppTools('좋네', history)).toBe(false);
    expect(shouldUseDialogModel('좋네', history)).toBe(true);
    expect(shouldUseDialogModel('고마워, 그럼 그렇게 하자', history)).toBe(true);
  });
});

describe('isVolatileClaimChallenge()', () => {
  // Verbatim shape of the turn that produced "이 환경에서는 살아있는 페이지를
  // 직접 긁어서 확인이 안 돼": Aoi reported a shipped pricing tier, the user said
  // it was not on their account, and the rebuttal routed to the dialog model,
  // which has no search_web to re-check with.
  const shippedPlanHistory = [
    {
      role: 'user' as const,
      content: 'Grok Build 구독 $100 플랜이 출시할거란 뉴스를 예전에 봤었는데 아직 소식이 없어?',
    },
    {
      role: 'assistant' as const,
      content:
        '소식 있어, 꿀보. 그 $100 플랜은 "SuperGrok Plus"라는 이름으로 떴어. 7월 31일 보도로 월 $100 미드티어 플랜 출시가 확인됐고, $30 SuperGrok과 $300 Heavy 사이 등급이야.',
    },
  ];

  it('routes a challenge to a just-made volatile claim back to the tool-capable model', () => {
    const message = '그런데 나한테는 $100 플랜이 안보여';

    // The user's own words carry no freshness cue, which is exactly why the
    // pre-existing router missed this turn.
    expect(shouldUseWebSearch(message)).toBe(false);

    expect(isVolatileClaimChallenge(message, shippedPlanHistory)).toBe(true);
    expect(shouldUseDialogModel(message, shippedPlanHistory)).toBe(false);
  });

  it('recognizes the same rebuttal in English and other Korean phrasings', () => {
    const englishHistory = [
      {
        role: 'assistant' as const,
        content: 'The $100 mid-tier plan launched on 2026-07-31 and is available now.',
      },
    ];

    expect(shouldUseWebSearch("I don't see it on my account")).toBe(false);
    expect(isVolatileClaimChallenge("I don't see it on my account", englishHistory)).toBe(true);
    expect(shouldUseDialogModel("I don't see it on my account", englishHistory)).toBe(false);

    expect(isVolatileClaimChallenge('내 계정에는 그런 거 없는데', shippedPlanHistory)).toBe(true);
    expect(isVolatileClaimChallenge('그거 진짜 맞아', shippedPlanHistory)).toBe(true);
  });

  it('ignores doubt when the preceding claim was not about volatile outside state', () => {
    const history = [{ role: 'assistant' as const, content: '네 말이 맞아, 그렇게 하자.' }];

    expect(isVolatileClaimChallenge('확실해?', history)).toBe(false);
    expect(shouldUseDialogModel('확실해?', history)).toBe(true);
  });

  it('does not treat doubt about our own workspace as a question about the world', () => {
    expect(isVolatileClaimChallenge('그 파일이 나한테는 안 보이는데?', shippedPlanHistory)).toBe(
      false,
    );
    expect(isVolatileClaimChallenge('그 함수 확실해?', shippedPlanHistory)).toBe(false);
  });

  it('requires both a challenge and a prior assistant turn', () => {
    expect(isVolatileClaimChallenge('그럼 그걸로 가자', shippedPlanHistory)).toBe(false);
    expect(isVolatileClaimChallenge('나한테는 안 보여')).toBe(false);
    expect(isVolatileClaimChallenge('', shippedPlanHistory)).toBe(false);
  });
});

describe('buildWebSearchPolicyPromptBlock()', () => {
  it('instructs search_web only when search_web is in the turn tools', () => {
    const block = buildWebSearchPolicyPromptBlock({
      hasWebSearchTool: true,
      webSearchConfigured: true,
      toolCallRuntimeAvailable: true,
    });

    expect(block).toContain('Web search rule:');
    expect(block).toContain('use search_web first');
  });

  // The regression itself: a configured key used to emit the "use search_web
  // first" rule on a dialog turn, where the tools array holds only
  // respond_to_user/finish_target.
  it('never asks for a search_web call on a turn that was not given the tool', () => {
    const block = buildWebSearchPolicyPromptBlock({
      hasWebSearchTool: false,
      webSearchConfigured: true,
      toolCallRuntimeAvailable: true,
    });

    expect(block).not.toContain('use search_web first');
    expect(block).not.toContain('Web search rule:');
    expect(block).toContain('Web search availability:');
  });

  it('tells the model its lack of search is one turn, not the environment', () => {
    const block = buildWebSearchPolicyPromptBlock({
      hasWebSearchTool: false,
      webSearchConfigured: true,
      toolCallRuntimeAvailable: true,
    });

    expect(block).toContain('Live web search IS configured for you');
    expect(block).toContain('Never tell the user you cannot see the web');
    expect(block).toContain('Do not claim or imply that you searched anything on this turn.');
  });

  it('stays silent when web search is genuinely unavailable', () => {
    // No key at all: there is nothing truthful to promise.
    expect(
      buildWebSearchPolicyPromptBlock({
        hasWebSearchTool: false,
        webSearchConfigured: false,
        toolCallRuntimeAvailable: true,
      }),
    ).toBe('');

    // Provider cannot emit tool calls, so "the next turn will carry the tool"
    // would be false. The no-tool-runtime prompt branch covers this case.
    expect(
      buildWebSearchPolicyPromptBlock({
        hasWebSearchTool: false,
        webSearchConfigured: true,
        toolCallRuntimeAvailable: false,
      }),
    ).toBe('');
  });
});

describe('shouldUseWebSearch()', () => {
  it('separates long research-document requests from one-off web search', () => {
    expect(shouldUseAoiResearchRun('웹에서 관련 자료를 조사해서 구조화된 문서로 만들어줘')).toBe(
      true,
    );
    expect(shouldUseAoiResearchRun('Create a cited research report about TPM attestation')).toBe(
      true,
    );
    expect(shouldUseAoiResearchRun('최신 Tavily API 변경점 검색해서 알려줘')).toBe(false);
    expect(shouldUseAoiResearchRun('https://example.com 이 URL 요약해줘')).toBe(false);
  });

  it('detects Korean time-sensitive fact checks', () => {
    const message = '앤트로픽의 fable 은 6/22 이후로는 API로만 사용 가능하다던데 진짜야?';

    expect(shouldUseWebSearch(message)).toBe(true);
    expect(shouldUseDialogModel(message)).toBe(false);
  });

  it('does not treat casual intensifiers as search requests', () => {
    expect(shouldUseWebSearch('고마워 진짜 좋아')).toBe(false);
  });

  it('detects explicit live web search requests', () => {
    expect(shouldUseWebSearch('Can you verify this fact on the web?')).toBe(true);
    expect(shouldUseWebSearch('최신 Tavily API 변경점 검색해줘')).toBe(true);
  });

  it('routes Korean API pricing questions away from the dialog model', () => {
    const message =
      'X API로 내가 팔로잉 중인 사람들의 게시글을 주기적으로 확인하려면 비용이 얼마나 들어?';

    expect(shouldUseWebSearch(message)).toBe(true);
    expect(shouldUseAoiResearchRun(message)).toBe(false);
    expect(shouldUseDialogModel(message)).toBe(false);
  });

  it('detects implicit freshness questions about volatile product state', () => {
    expect(shouldUseWebSearch('Windows Recall은 지금 opt-in 이야?')).toBe(true);
    expect(shouldUseWebSearch('윈도우 리콜 요즘도 기본값 꺼짐이야?')).toBe(true);
    expect(shouldUseWebSearch('is Windows Recall still opt-in now?')).toBe(true);
    expect(shouldUseWebSearch('DeepSeek V4 Flash 지원 여부 확인해줘')).toBe(true);
  });

  it('leaves freshness-worded small talk alone when no volatile fact is involved', () => {
    expect(shouldUseWebSearch('지금 몇시야?')).toBe(false);
    expect(shouldUseWebSearch('지금 뭐해?')).toBe(false);
    expect(shouldUseWebSearch('요즘 어떻게 지내?')).toBe(false);
    expect(shouldUseWebSearch('이 코드 확인해줘')).toBe(false);
  });

  it('does not send ordinary coding requests to the web (freshness false positives)', () => {
    // Every one of these searched the live web before the local-context gate:
    // the volatile-fact list is full of words a security engineer uses about
    // their own code (모델, 정책, 접근, 지원, 변경, 배포, 활성화).
    const codingRequests = [
      '변경 사항 확인해줘',
      '모델 클래스 확인해줘',
      '접근 지정자 확인해줘',
      '드라이버 로드 정책 확인해줘',
      '이 커널 모듈 지원 여부 확인해줘',
      '기본값 확인해줘',
      '현재 model 필드 타입 확인해줘',
      '현재 정책 파일 내용 알아봐 줘',
      '메모리 접근 위반 원인 알아봐 줘',
      '지금 이 기능 활성화돼 있어?',
      '이제 이거 배포해도 될까?',
      'I have the model file open now, can you refactor it',
      'can you do the model refactor today',
      'have you finished the policy refactor now',
    ];
    for (const message of codingRequests) {
      expect(shouldUseWebSearch(message), `should not web-search: ${message}`).toBe(false);
    }
  });

  it('still searches when the freshness question is about the outside world', () => {
    // The gate must not swallow the real use case it was built for.
    expect(shouldUseWebSearch('Windows Recall은 지금 opt-in 이야?')).toBe(true);
    expect(shouldUseWebSearch('DeepSeek 요금제 지금 어떻게 돼?')).toBe(true);
    expect(shouldUseWebSearch('is Windows Recall still opt-in now?')).toBe(true);
    // Explicit search requests bypass the local-context gate entirely.
    expect(shouldUseWebSearch('이 코드 관련 최신 CVE 검색해줘')).toBe(true);
  });
});

describe('memory prompt limits', () => {
  it('caps prompt memories and trims content', () => {
    const memories: MemoryEntry[] = Array.from({ length: 20 }, (_, index) => ({
      id: `mem-${index}`,
      content: `memory ${index} ${'x'.repeat(200)}`,
      category: 'fact',
      createdAt: index,
    }));

    const selected = selectMemoriesForPrompt(memories);
    expect(selected.length).toBeLessThanOrEqual(12);
    expect(selected.every((entry) => entry.content.length <= 160)).toBe(true);

    const prompt = buildMemoryPrompt(memories);
    expect(prompt).toContain('most relevant memories');
  });
});

describe('buildFileReadResponse()', () => {
  it('returns full content for short files', () => {
    expect(buildFileReadResponse('notes.txt', 'one\ntwo')).toBe('one\ntwo');
  });

  it('returns an excerpt for large files and mentions line ranges', () => {
    const content = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n');
    const response = buildFileReadResponse('big.ts', content);
    expect(response).toContain('File big.ts is large');
    expect(response).toContain('Use file_read with start_line/end_line');
    expect(response).toContain('1: line 1');
    expect(response).toContain('400: line 400');
  });

  it('honors explicit line ranges', () => {
    const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    const response = buildFileReadResponse('focus.ts', content, {
      startLine: 10,
      endLine: 14,
    });
    expect(response).toContain('showing lines 10-14');
    expect(response).toContain('10: line 10');
    expect(response).toContain('14: line 14');
  });
});

describe('truncateForTokenBudget()', () => {
  it('keeps short text intact and truncates long text with a suffix', () => {
    expect(truncateForTokenBudget('short', 20)).toBe('short');
    expect(truncateForTokenBudget('x'.repeat(100), 20)).toContain('truncated for token budget');
  });
});

// Regression for the routing half of the "Aoi said it played something and
// nothing played" reports. Both failures in the real run ledger were turns that
// reached the model with NO app tools: shouldEnableAppTools wanted a music noun
// in the latest message, which a deferred replay never has, and the dialog route
// (respond_to_user + finish_target only) had already been chosen anyway.
describe('playback turns that only point back at the previous one', () => {
  const IDLE_CARD = {
    role: 'assistant' as const,
    content:
      '늦은 시간이라 조용하네. 은은한 사운드 하나 깔아줄까?\n' +
      '🎵 추천 (네 취향 반영): "2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST"',
  };
  const PLAY_ACK = {
    role: 'assistant' as const,
    content: '"다시" 유튜브에서 틀어볼게.',
  };

  it('gives app tools to a replay request whose subject is in the previous turn', () => {
    expect(shouldEnableAppTools('▶ 재생', [IDLE_CARD])).toBe(true);
    expect(shouldEnableAppTools('아니 아까 너가 말한거 틀어달란거야', [PLAY_ACK])).toBe(true);
    expect(shouldEnableAppTools('다시 틀어줘', [IDLE_CARD])).toBe(true);
  });

  it('keeps those turns off the dialog route, which has no app tools', () => {
    expect(shouldUseDialogModel('▶ 재생', [IDLE_CARD])).toBe(false);
    expect(shouldUseDialogModel('아니 아까 너가 말한거 틀어달란거야', [PLAY_ACK])).toBe(false);
    expect(shouldUseDialogModel('다시 틀어줘', [IDLE_CARD])).toBe(false);
  });

  it('never lets the two decisions disagree', () => {
    // The invariant the coupling buys: app tools judged necessary and then
    // withheld because the route was already downgraded is what produced a
    // playback turn with nothing to play it.
    const cases: Array<[string, { role: 'assistant'; content: string }[]]> = [
      ['▶ 재생', [IDLE_CARD]],
      ['다시 틀어줘', [IDLE_CARD]],
      ['아니 아까 너가 말한거 틀어달란거야', [PLAY_ACK]],
      ['노래 틀어줘', []],
      ['유튜브 열어줘', []],
    ];
    for (const [message, history] of cases) {
      if (shouldEnableAppTools(message, history)) {
        expect(shouldUseDialogModel(message, history), message).toBe(false);
      }
    }
  });

  it('still leaves ordinary chat on the cheap route', () => {
    // The coupling must not drag unrelated small talk onto the main model.
    expect(shouldEnableAppTools('오늘 좀 피곤하다', [IDLE_CARD])).toBe(false);
    expect(shouldUseDialogModel('오늘 좀 피곤하다', [IDLE_CARD])).toBe(true);
  });

  it('does not arm on playback words with no music anywhere in sight', () => {
    const unrelated = [{ role: 'assistant' as const, content: '어제 회의는 어땠어?' }];
    expect(shouldEnableAppTools('다시 말해줘', unrelated)).toBe(false);
  });
});
