import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../llmClient';
import {
  MAX_AOI_TURN_RECORDS,
  appendAoiTurnRecord,
  buildAoiRecentTurnsPromptBlock,
  createAoiDirectActionTurnRecord,
  createAoiTurnRecord,
  deriveAoiTurnToolRecords,
  extractAoiAssistantOffers,
  extractAoiOpenQuestion,
  extractAoiTurnEntities,
  isAoiTurnRecord,
  loadAoiTurnRecords,
  mergeAoiTurnRecords,
  nextAoiTurnIndex,
  parseAoiDirectToolCallLabel,
  saveAoiTurnRecords,
  summarizeAoiToolArgs,
  type AoiTurnRecord,
} from '../aoiTurnRecord';

function messagesWithTools(): ChatMessage[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'src/lib/a.ts 읽고 테스트 돌려줘' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'ide_read_file', arguments: JSON.stringify({ path: 'src/lib/a.ts' }) },
        },
        {
          id: 'c2',
          type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ command: 'pnpm test' }) },
        },
        {
          id: 'c3',
          type: 'function',
          function: { name: 'respond_to_user', arguments: '{}' },
        },
        {
          id: 'c4',
          type: 'function',
          function: { name: 'host_process_list', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1;' },
    { role: 'tool', tool_call_id: 'c2', content: 'error: 2 tests failed' },
    { role: 'tool', tool_call_id: 'c3', content: 'Message delivered.' },
  ];
}

function record(over: Partial<AoiTurnRecord> = {}): AoiTurnRecord {
  return {
    version: 1,
    id: over.id ?? 'run-1',
    turnIndex: over.turnIndex ?? 1,
    createdAt: over.createdAt ?? 1_000,
    userMessage: over.userMessage ?? 'hello',
    assistantMessage: over.assistantMessage ?? 'hi',
    route: over.route ?? 'dialog',
    routeReason: over.routeReason ?? 'regex: dialog',
    kind: over.kind ?? 'chitchat',
    families: over.families ?? ['none'],
    tools: over.tools ?? [],
    entities: over.entities ?? [],
    offers: over.offers ?? [],
    openQuestion: over.openQuestion ?? null,
    outcome: over.outcome ?? 'delivered',
  };
}

describe('summarizeAoiToolArgs', () => {
  it('keeps the values that name the target and drops payload', () => {
    expect(
      summarizeAoiToolArgs(JSON.stringify({ path: 'docs/notes.md', content: 'a'.repeat(200) })),
    ).toBe('path=docs/notes.md, content=aaaaaaaaaaaaaaaaaaaaa...');
  });

  it('caps at three salient keys in a stable order', () => {
    expect(
      summarizeAoiToolArgs(
        JSON.stringify({ query: 'q', app_name: 'youtube', action_type: 'OPEN_SEARCH', url: 'u' }),
      ),
    ).toBe('app_name=youtube, action_type=OPEN_SEARCH, query=q');
  });

  it('falls back to a trimmed raw string for empty, unparseable, or unknown shapes', () => {
    expect(summarizeAoiToolArgs(undefined)).toBe('');
    expect(summarizeAoiToolArgs('{}')).toBe('');
    expect(summarizeAoiToolArgs('not json')).toBe('not json');
    expect(summarizeAoiToolArgs('[1,2]')).toBe('[1,2]');
    expect(summarizeAoiToolArgs(JSON.stringify({ unknown_key: 'x' }))).toBe('{"unknown_key":"x"}');
    expect(summarizeAoiToolArgs(JSON.stringify({ pid: 42 }))).toBe('pid=42');
    expect(summarizeAoiToolArgs(JSON.stringify({ path: null, query: '' }))).toBe(
      '{"path":null,"query":""}',
    );
  });
});

describe('deriveAoiTurnToolRecords', () => {
  it('pairs each call with its result and classifies the outcome', () => {
    expect(deriveAoiTurnToolRecords(messagesWithTools())).toEqual([
      { name: 'ide_read_file', args: 'path=src/lib/a.ts', outcome: 'ok' },
      { name: 'run_command', args: 'command=pnpm test', outcome: 'error' },
      { name: 'host_process_list', args: '', outcome: 'unknown' },
    ]);
  });

  it('skips turn plumbing and ignores messages without tool calls', () => {
    const records = deriveAoiTurnToolRecords([
      { role: 'assistant', content: 'plain' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'finish_target', arguments: '{}' } },
          { id: 'y', type: 'function', function: { name: '  ', arguments: '{}' } },
        ],
      },
    ]);
    expect(records).toEqual([]);
  });

  it('caps the number of tools per turn', () => {
    const calls = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      type: 'function' as const,
      function: { name: 'file_read', arguments: JSON.stringify({ path: `f${index}.ts` }) },
    }));
    const records = deriveAoiTurnToolRecords([
      { role: 'assistant', content: '', tool_calls: calls },
    ]);
    expect(records).toHaveLength(12);
  });
});

describe('extractAoiTurnEntities', () => {
  it('collects tool targets, urls, quoted and backticked names, and paths', () => {
    const entities = extractAoiTurnEntities({
      userMessage: 'src/lib/aoiRunLedger.ts 읽고 https://example.com/a?b=1 도 봐줘',
      assistantMessage:
        '읽었어. `pnpm test` 는 "KISS N TELL" 처럼 「따옴표」 안 값도 잡아. 버전 1.2 는 숫자.',
      tools: [
        { name: 'ide_read_file', args: 'path=src/lib/aoiRunLedger.ts', outcome: 'ok' },
        {
          name: 'app_action',
          args: 'app_name=youtube, action_type=OPEN_SEARCH, content=aaaa...',
          outcome: 'ok',
        },
      ],
    });
    expect(entities).toEqual(
      expect.arrayContaining([
        'src/lib/aoiRunLedger.ts',
        'youtube',
        'OPEN_SEARCH',
        'https://example.com/a?b=1',
        'pnpm test',
        'KISS N TELL',
        '따옴표',
      ]),
    );
    expect(entities).not.toContain('1.2');
    expect(entities).not.toContain('aaaa...');
    // Deduped case-insensitively: the path from the tool and from the text is one entry.
    expect(entities.filter((entity) => entity === 'src/lib/aoiRunLedger.ts')).toHaveLength(1);
  });

  it('bounds the text it scans so a long single-line blob cannot stall the turn', () => {
    const blob = 'x'.repeat(60_000);
    const startedAt = Date.now();
    const entities = extractAoiTurnEntities({
      userMessage: `src/first.ts ${blob} src/hidden/after-the-bound.ts`,
      assistantMessage: `${blob} 저장할까?`,
      tools: [],
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(entities).toContain('src/first.ts');
    expect(entities).not.toContain('src/hidden/after-the-bound.ts');
    expect(extractAoiAssistantOffers(`${blob} 저장할까?`)).toEqual([]);
    expect(extractAoiOpenQuestion(`${blob} 저장할까?`)).toBeNull();
  });

  it('caps the list and the length of each entity', () => {
    const many = Array.from({ length: 30 }, (_, index) => `"name-${index}"`).join(' ');
    const entities = extractAoiTurnEntities({ userMessage: many, assistantMessage: '', tools: [] });
    expect(entities).toHaveLength(12);
    const long = extractAoiTurnEntities({
      userMessage: `\`${'x'.repeat(79)}\``,
      assistantMessage: '',
      tools: [],
    });
    expect(long[0]?.length).toBeLessThanOrEqual(80);
  });
});

describe('extractAoiAssistantOffers / extractAoiOpenQuestion', () => {
  it('lists chips first, then offer sentences, deduped and capped', () => {
    const offers = extractAoiAssistantOffers(
      '에스파 어때? YouTube 검색어: `x`. 이거 틀어줄까? 아니면 다른 걸로 갈까? Shall I queue it up?',
      ['▶ 재생', '다른 거', '▶ 재생'],
    );
    expect(offers[0]).toBe('▶ 재생');
    expect(offers[1]).toBe('다른 거');
    expect(offers).toHaveLength(4);
    expect(offers.some((offer) => offer.includes('틀어줄까'))).toBe(true);
  });

  it('does not read 노래 or 그래 as offers', () => {
    expect(extractAoiAssistantOffers('노래 재생했어. 그래, 알겠어.')).toEqual([]);
    expect(extractAoiAssistantOffers('다른 것도 들을래? 아니면 갈래?')).toHaveLength(2);
  });

  it('returns the closing question or null', () => {
    expect(extractAoiOpenQuestion('정리했어. notes.md에 저장할까?')).toBe('notes.md에 저장할까?');
    expect(extractAoiOpenQuestion('저장했어.')).toBeNull();
    expect(extractAoiOpenQuestion('   ')).toBeNull();
    expect(extractAoiOpenQuestion(`${'a'.repeat(200)}?`)).toHaveLength(140);
  });
});

describe('createAoiTurnRecord / appendAoiTurnRecord', () => {
  it('derives tools, entities, offers, and the open question from the turn', () => {
    const created = createAoiTurnRecord({
      id: 'run-9',
      turnIndex: 3,
      userMessage: 'src/lib/a.ts 읽고 테스트 돌려줘',
      assistantMessage: '읽었고 테스트는 2개 실패했어. 고쳐볼까?',
      route: 'main',
      routeReason: 'regex: main',
      kind: 'action_request',
      families: ['file', 'command', 'file'],
      messages: messagesWithTools(),
      suggestedReplies: ['응 고쳐줘', '아니 놔둬'],
      outcome: 'delivered',
      createdAt: 5_000,
    });
    expect(created.families).toEqual(['file', 'command']);
    expect(created.tools.map((tool) => tool.name)).toEqual([
      'ide_read_file',
      'run_command',
      'host_process_list',
    ]);
    expect(created.entities).toContain('src/lib/a.ts');
    expect(created.offers[0]).toBe('응 고쳐줘');
    expect(created.openQuestion).toBe('읽었고 테스트는 2개 실패했어. 고쳐볼까?'.split('. ')[1]);
    expect(created.createdAt).toBe(5_000);
    expect(isAoiTurnRecord(created)).toBe(true);
  });

  it('prefers an explicit open question and truncates long messages', () => {
    const created = createAoiTurnRecord({
      id: 'run-10',
      turnIndex: 1,
      userMessage: 'u'.repeat(400),
      assistantMessage: 'which file?',
      route: 'main',
      routeReason: 'r',
      kind: 'action_request',
      families: ['file'],
      messages: [],
      outcome: 'clarification_asked',
      openQuestion: '  어느 파일을 말하는 거야?  ',
    });
    expect(created.userMessage).toHaveLength(240);
    expect(created.openQuestion).toBe('어느 파일을 말하는 거야?');
    expect(created.createdAt).toBeGreaterThan(0);
  });

  it('replaces a record with the same id, orders by turn index, and caps the list', () => {
    let records: AoiTurnRecord[] = [];
    for (let index = 1; index <= MAX_AOI_TURN_RECORDS + 5; index += 1) {
      records = appendAoiTurnRecord(records, record({ id: `run-${index}`, turnIndex: index }));
    }
    expect(records).toHaveLength(MAX_AOI_TURN_RECORDS);
    expect(records[0].turnIndex).toBe(6);
    const replaced = appendAoiTurnRecord(
      records,
      record({ id: 'run-20', turnIndex: 20, userMessage: 'new' }),
    );
    expect(replaced).toHaveLength(MAX_AOI_TURN_RECORDS);
    expect(replaced.find((entry) => entry.id === 'run-20')?.userMessage).toBe('new');
    expect(nextAoiTurnIndex(replaced)).toBe(MAX_AOI_TURN_RECORDS + 6);
    expect(nextAoiTurnIndex([])).toBe(1);
  });
});

describe('mergeAoiTurnRecords', () => {
  it('keeps loaded indices and rebases in-memory records after them', () => {
    const loaded = [record({ id: 'p1', turnIndex: 1 }), record({ id: 'p2', turnIndex: 2 })];
    const inMemory = [record({ id: 'fresh', turnIndex: 1, userMessage: 'sent before load' })];
    const merged = mergeAoiTurnRecords(loaded, inMemory);
    expect(merged.map((entry) => [entry.id, entry.turnIndex])).toEqual([
      ['p1', 1],
      ['p2', 2],
      ['fresh', 3],
    ]);
    expect(merged[2].userMessage).toBe('sent before load');
  });

  it('drops duplicates by id, orders loaded records, and caps the list', () => {
    const loaded = [record({ id: 'b', turnIndex: 2 }), record({ id: 'a', turnIndex: 1 })];
    expect(mergeAoiTurnRecords(loaded, []).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(mergeAoiTurnRecords(loaded, [record({ id: 'a', turnIndex: 9 })])).toHaveLength(2);
    const many = Array.from({ length: MAX_AOI_TURN_RECORDS }, (_, index) =>
      record({ id: `l${index}`, turnIndex: index + 1 }),
    );
    const merged = mergeAoiTurnRecords(many, [record({ id: 'new', turnIndex: 1 })]);
    expect(merged).toHaveLength(MAX_AOI_TURN_RECORDS);
    expect(merged[merged.length - 1].id).toBe('new');
    expect(merged[merged.length - 1].turnIndex).toBe(MAX_AOI_TURN_RECORDS + 1);
  });
});

describe('buildAoiRecentTurnsPromptBlock', () => {
  const now = 10 * 60_000;
  const records = [
    record({
      id: 'a',
      turnIndex: 1,
      createdAt: now - 3 * 60_000,
      route: 'main',
      userMessage: 'src/a.ts 열어줘',
      assistantMessage: '열었어. 120줄이야.',
      tools: [{ name: 'ide_read_file', args: 'path=src/a.ts', outcome: 'ok' }],
      entities: ['src/a.ts'],
    }),
    record({
      id: 'b',
      turnIndex: 2,
      createdAt: now - 2 * 60_000,
      userMessage: '고마워',
      assistantMessage: '언제든. 더 볼까?',
      offers: ['더 볼까?'],
      openQuestion: '더 볼까?',
    }),
    record({
      id: 'c',
      turnIndex: 3,
      createdAt: now - 30_000,
      route: 'main',
      userMessage: '그거 정리해줘',
      assistantMessage: '어느 파일 말하는 거야?',
      outcome: 'clarification_asked',
      openQuestion: '어느 파일 말하는 거야?',
    }),
  ];

  it('renders oldest first with T-n positions, tools, refs, offers, and open questions', () => {
    const block = buildAoiRecentTurnsPromptBlock(records, { now });
    const lines = block.split('\n').filter((line) => line.startsWith('- T-'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('T-3 (3m ago) [main] user: "src/a.ts 열어줘"');
    expect(lines[0]).toContain('tools: ide_read_file(path=src/a.ts) ok');
    expect(lines[0]).toContain('refs: src/a.ts');
    expect(lines[1]).toContain('T-2 (2m ago) [dialog]');
    expect(lines[1]).toContain('no tools');
    expect(lines[1]).toContain('offered: "더 볼까?"');
    expect(lines[1]).toContain('open question: "더 볼까?"');
    expect(lines[2]).toContain('T-1 (just now)');
    expect(lines[2]).toContain('Aoi asked: "어느 파일 말하는 거야?"');
    expect(block).toContain('Resolve references such as');
  });

  it('marks failed turns, formats hours and days, and returns empty for no records', () => {
    const block = buildAoiRecentTurnsPromptBlock(
      [
        record({
          id: 'x',
          turnIndex: 1,
          createdAt: now - 3 * 3_600_000,
          outcome: 'failed',
          assistantMessage: 'boom',
        }),
        record({ id: 'y', turnIndex: 2, createdAt: now - 3 * 86_400_000 }),
      ],
      { now },
    );
    expect(block).toContain('turn failed: "boom"');
    expect(block).toContain('(3h ago)');
    expect(block).toContain('(3d ago)');
    expect(buildAoiRecentTurnsPromptBlock([], { now })).toBe('');
  });

  it('drops the oldest lines to fit the character budget, keeping at least one', () => {
    const block = buildAoiRecentTurnsPromptBlock(records, { now, maxChars: 420 });
    const lines = block.split('\n').filter((line) => line.startsWith('- T-'));
    expect(lines.length).toBeLessThan(3);
    expect(lines[lines.length - 1]).toContain('T-1');
    const tiny = buildAoiRecentTurnsPromptBlock(records, { now, maxChars: 10 });
    expect(tiny.split('\n').filter((line) => line.startsWith('- T-'))).toHaveLength(1);
  });

  it('shows at most six tools per line and counts the rest', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      name: `tool_${index}`,
      args: '',
      outcome: 'ok' as const,
    }));
    const block = buildAoiRecentTurnsPromptBlock(
      [record({ id: 'm', turnIndex: 1, createdAt: now, route: 'main', tools: many })],
      { now, maxChars: 4000 },
    );
    expect(block).toContain('tool_5 ok; +3 more');
    expect(block).not.toContain('tool_6');
  });

  it('respects maxTurns', () => {
    const block = buildAoiRecentTurnsPromptBlock(records, { now, maxTurns: 1 });
    expect(block.split('\n').filter((line) => line.startsWith('- T-'))).toHaveLength(1);
    expect(block).toContain('그거 정리해줘');
  });
});

describe('isAoiTurnRecord', () => {
  it('accepts a full record and rejects malformed shapes', () => {
    expect(isAoiTurnRecord(record())).toBe(true);
    expect(isAoiTurnRecord(null)).toBe(false);
    expect(isAoiTurnRecord({ ...record(), version: 2 })).toBe(false);
    expect(isAoiTurnRecord({ ...record(), route: 'other' })).toBe(false);
    expect(isAoiTurnRecord({ ...record(), kind: 'weird' })).toBe(false);
    expect(isAoiTurnRecord({ ...record(), outcome: 'weird' })).toBe(false);
    expect(isAoiTurnRecord({ ...record(), tools: 'no' })).toBe(false);
  });
});

describe('load/save', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads, filters, and orders persisted records', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          version: 1,
          savedAt: 1,
          turns: [
            record({ id: 'b', turnIndex: 2 }),
            { bad: true },
            record({ id: 'a', turnIndex: 1 }),
          ],
        }),
      })),
    );
    const loaded = await loadAoiTurnRecords('aoi/space');
    expect(loaded.map((entry) => entry.id)).toEqual(['a', 'b']);
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(decodeURIComponent(url)).toContain('aoi/space/aoi-turn-records/turns.json');
  });

  it('returns empty on http errors, bad payloads, and thrown fetches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    expect(await loadAoiTurnRecords('s')).toEqual([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: 3 }) })),
    );
    expect(await loadAoiTurnRecords('s')).toEqual([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadAoiTurnRecords('s')).toEqual([]);
  });

  it('saves the capped list and surfaces a failing status', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const many = Array.from({ length: MAX_AOI_TURN_RECORDS + 3 }, (_, index) =>
      record({ id: `r${index}`, turnIndex: index + 1 }),
    );
    await saveAoiTurnRecords('aoi/space', many);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
    const body = JSON.parse(init.body) as { turns: unknown[] };
    expect(body.turns).toHaveLength(MAX_AOI_TURN_RECORDS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await expect(saveAoiTurnRecords('aoi/space', many)).rejects.toThrow('500');
  });
});

describe('direct-action records', () => {
  it('parses source-tagged labels into tool records', () => {
    expect(parseAoiDirectToolCallLabel('direct:play_music')).toEqual({
      name: 'play_music',
      args: '',
      outcome: 'ok',
    });
    expect(parseAoiDirectToolCallLabel('classified:play_music:search')).toEqual({
      name: 'play_music',
      args: 'search',
      outcome: 'ok',
    });
    expect(
      parseAoiDirectToolCallLabel('direct:aoi_taste_music_play:personal:aespa KISS N TELL MV'),
    ).toEqual({
      name: 'aoi_taste_music_play',
      args: 'personal:aespa KISS N TELL MV',
      outcome: 'ok',
    });
    expect(parseAoiDirectToolCallLabel('save_memory')).toEqual({
      name: 'save_memory',
      args: '',
      outcome: 'ok',
    });
    expect(parseAoiDirectToolCallLabel(' : : ')).toEqual({
      name: 'direct_action',
      args: '',
      outcome: 'ok',
    });
  });

  it('builds a delivered main-route record and reads app actions as requests', () => {
    const created = createAoiDirectActionTurnRecord({
      id: 'direct-1',
      turnIndex: 4,
      userMessage: '에스파 KISS N TELL 틀어줘',
      assistantMessage: '`aespa KISS N TELL MV` 재생 시작했어. 다른 것도 들을래?',
      toolCallLabels: ['direct:play_music', '  '],
      createdAt: 77,
    });
    expect(created).toMatchObject({
      version: 1,
      id: 'direct-1',
      turnIndex: 4,
      createdAt: 77,
      route: 'main',
      routeReason: 'direct action: play_music',
      kind: 'action_request',
      families: ['app'],
      tools: [{ name: 'play_music', args: '', outcome: 'ok' }],
      outcome: 'delivered',
      openQuestion: '다른 것도 들을래?',
    });
    expect(created.entities).toContain('aespa KISS N TELL MV');
    expect(created.offers.some((offer) => offer.includes('들을래'))).toBe(true);
    expect(isAoiTurnRecord(created)).toBe(true);
  });

  it('reads a non-app direct reply as conversation', () => {
    const created = createAoiDirectActionTurnRecord({
      id: 'direct-2',
      turnIndex: 1,
      userMessage: '지금 수준 유지',
      assistantMessage: '알겠어, 지금 수준으로 갈게.',
      toolCallLabels: ['direct:aoi_agenda_followup:keep:dedupe-1'],
    });
    expect(created.kind).toBe('chitchat');
    expect(created.families).toEqual(['none']);
    expect(created.routeReason).toBe('direct action: aoi_agenda_followup');
    expect(created.createdAt).toBeGreaterThan(0);
    expect(
      createAoiDirectActionTurnRecord({
        id: 'direct-3',
        turnIndex: 2,
        userMessage: 'x',
        assistantMessage: 'y',
        toolCallLabels: [],
      }).routeReason,
    ).toBe('direct action: none');
  });
});
