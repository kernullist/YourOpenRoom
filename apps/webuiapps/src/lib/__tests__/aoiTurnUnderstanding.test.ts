import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AoiTurnRecord } from '../aoiTurnRecord';
import {
  AOI_TURN_UNDERSTANDING_TOOL_NAME,
  MAX_AOI_TURN_CLASSIFIABLE_CHARS,
  buildAoiTurnUnderstandingMessages,
  canPinClassifierTemperature,
  classifyAoiTurn,
  getAoiTurnUnderstandingToolDefinition,
  inferAoiTurnUnderstandingFromRegex,
  isGroundedAoiReferent,
  parseAoiTurnUnderstandingToolCall,
  shouldClassifyAoiTurn,
  withThinkingDisabled,
} from '../aoiTurnUnderstanding';

vi.mock('../llmClient', async () => {
  const actual = await vi.importActual<typeof import('../llmClient')>('../llmClient');
  return { ...actual, chat: vi.fn() };
});
// eslint-disable-next-line import/first
import { chat } from '../llmClient';

const chatMock = vi.mocked(chat);

const CONFIG = {
  provider: 'openrouter',
  model: 'qwen/qwen3.7-flash',
  apiKey: 'k',
  baseUrl: 'https://example.test',
} as unknown as Parameters<typeof classifyAoiTurn>[1];

function record(over: Partial<AoiTurnRecord>): AoiTurnRecord {
  return {
    version: 1,
    id: over.id ?? 'r',
    turnIndex: over.turnIndex ?? 1,
    createdAt: over.createdAt ?? 1,
    userMessage: over.userMessage ?? '',
    assistantMessage: over.assistantMessage ?? '',
    route: over.route ?? 'main',
    routeReason: 'test',
    kind: over.kind ?? 'action_request',
    families: over.families ?? ['file'],
    tools: over.tools ?? [],
    entities: over.entities ?? [],
    offers: over.offers ?? [],
    openQuestion: over.openQuestion ?? null,
    outcome: over.outcome ?? 'delivered',
  };
}

const RECORDS: AoiTurnRecord[] = [
  record({
    id: 'a',
    turnIndex: 4,
    userMessage: 'src/lib/a.ts 읽어줘',
    assistantMessage: '읽었어.',
    tools: [{ name: 'ide_read_file', args: 'path=src/lib/a.ts', outcome: 'ok' }],
    entities: ['src/lib/a.ts'],
  }),
  record({
    id: 'b',
    turnIndex: 5,
    userMessage: '노래 추천해줘',
    assistantMessage: '에스파 KISS N TELL 어때? 틀어줄까?',
    offers: ['▶ 재생', '틀어줄까?'],
    openQuestion: '틀어줄까?',
    families: ['app'],
  }),
];

function toolResponse(args: unknown, name = AOI_TURN_UNDERSTANDING_TOOL_NAME) {
  return {
    content: '',
    toolCalls: [
      { id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

describe('shouldClassifyAoiTurn', () => {
  it('is structural: on, text present, short enough, no image', () => {
    expect(shouldClassifyAoiTurn({ text: '응', hasAttachments: false, enabled: true })).toBe(true);
    expect(shouldClassifyAoiTurn({ text: '응', hasAttachments: false, enabled: false })).toBe(
      false,
    );
    expect(shouldClassifyAoiTurn({ text: '응', hasAttachments: true, enabled: true })).toBe(false);
    expect(shouldClassifyAoiTurn({ text: '   ', hasAttachments: false, enabled: true })).toBe(
      false,
    );
    expect(
      shouldClassifyAoiTurn({
        text: 'x'.repeat(MAX_AOI_TURN_CLASSIFIABLE_CHARS + 1),
        hasAttachments: false,
        enabled: true,
      }),
    ).toBe(false);
  });
});

describe('getAoiTurnUnderstandingToolDefinition / buildAoiTurnUnderstandingMessages', () => {
  it('declares the enum-typed slots and requires kind, families, confidence', () => {
    const def = getAoiTurnUnderstandingToolDefinition();
    expect(def.function.name).toBe(AOI_TURN_UNDERSTANDING_TOOL_NAME);
    expect(def.function.parameters.required).toEqual(['kind', 'families', 'confidence']);
    const kind = def.function.parameters.properties.kind as { enum: string[] };
    expect(kind.enum).not.toContain('unknown');
    expect(kind.enum).toContain('rejection_or_correction');
  });

  it('puts the recent turns, the open question, the offers, and the message in the prompt', () => {
    const messages = buildAoiTurnUnderstandingMessages({
      text: '응 그거',
      recentTurnsBlock: '\n\nRecent turns\n- T-1 ...',
      records: RECORDS,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(AOI_TURN_UNDERSTANDING_TOOL_NAME);
    expect(messages[1].content).toContain('Recent turns');
    // The label counts the lines actually in the block, not the records on file.
    expect(messages[1].content).toContain('Turns listed: T-1 (previous) through T-1');
    const twoLines = buildAoiTurnUnderstandingMessages({
      text: '응',
      recentTurnsBlock:
        'header\n- T-2 (1m ago) [main] user: "a"\n- T-1 (just now) [main] user: "b"',
      records: RECORDS,
    });
    expect(twoLines[1].content).toContain('Turns listed: T-1 (previous) through T-2');
    expect(messages[1].content).toContain('Open question from Aoi: "틀어줄까?"');
    expect(messages[1].content).toContain('"▶ 재생"');
    expect(messages[1].content).toContain('User message: "응 그거"');
  });

  it('states the first-turn case and truncates a long message', () => {
    const messages = buildAoiTurnUnderstandingMessages({
      text: 'y'.repeat(500),
      recentTurnsBlock: '',
      records: [],
    });
    expect(messages[1].content).toContain('(none, this is the first turn)');
    expect(messages[1].content).toContain('Open question from Aoi: (none)');
    expect(messages[1].content).toContain('Offers on the table: (none)');
    expect(messages[1].content).not.toContain('Turns listed');
    expect(messages[1].content).toContain('...');
  });
});

describe('isGroundedAoiReferent', () => {
  it('accepts strings that appear in the message or the records, normalized', () => {
    expect(isGroundedAoiReferent('src/lib/a.ts', '그거', RECORDS)).toBe(true);
    expect(isGroundedAoiReferent('KISS N TELL', '그거', RECORDS)).toBe(true);
    expect(isGroundedAoiReferent('kiss n tell', '그거', RECORDS)).toBe(true);
    expect(isGroundedAoiReferent('notes.md', '그거 notes.md', RECORDS)).toBe(true);
  });

  it('rejects invented or trivial referents', () => {
    expect(isGroundedAoiReferent('Dynamite', '그거', RECORDS)).toBe(false);
    expect(isGroundedAoiReferent('a', '그거', RECORDS)).toBe(false);
    expect(isGroundedAoiReferent('  ', '그거', RECORDS)).toBe(false);
  });
});

describe('parseAoiTurnUnderstandingToolCall', () => {
  const context = { text: '그거 다시 읽어줘', records: RECORDS };

  it('returns a validated reading with a grounded referent and resolved turn', () => {
    const reading = parseAoiTurnUnderstandingToolCall(
      {
        kind: 'action_request',
        families: ['file', 'FILE', 'none'],
        refers_to_turn: 2,
        referent: 'src/lib/a.ts',
        confidence: 'high',
        needs_clarification: 'ignored at high confidence',
        clarification_options: ['a'],
      },
      context,
    );
    expect(reading).toEqual({
      kind: 'action_request',
      families: ['file'],
      refersToTurn: 4,
      referent: 'src/lib/a.ts',
      confidence: 'high',
      needsClarification: null,
      clarificationOptions: [],
      source: 'classifier',
    });
  });

  it('reads refers_to_turn as a T-n position, never as an absolute turn index', () => {
    // Records carry turn indices 4 and 5. "4" is not a listed position, so it
    // resolves to nothing rather than to the record whose index happens to be 4.
    expect(
      parseAoiTurnUnderstandingToolCall(
        { kind: 'action_request', families: ['file'], refers_to_turn: 4, confidence: 'high' },
        context,
      )?.refersToTurn,
    ).toBeNull();
    expect(
      parseAoiTurnUnderstandingToolCall(
        { kind: 'action_request', families: ['file'], refers_to_turn: 0, confidence: 'high' },
        context,
      )?.refersToTurn,
    ).toBeNull();
  });

  it('accepts a relative T-n position for refers_to_turn', () => {
    const reading = parseAoiTurnUnderstandingToolCall(
      { kind: 'action_request', families: ['file'], refers_to_turn: 2, confidence: 'high' },
      context,
    );
    expect(reading?.refersToTurn).toBe(4);
    const previous = parseAoiTurnUnderstandingToolCall(
      { kind: 'confirmation', families: ['app'], refers_to_turn: 1, confidence: 'high' },
      context,
    );
    expect(previous?.refersToTurn).toBe(5);
  });

  it('drops an ungrounded referent, an unknown turn, and non-integer turns without failing', () => {
    const reading = parseAoiTurnUnderstandingToolCall(
      {
        kind: 'action_request',
        families: ['file'],
        refers_to_turn: 99,
        referent: 'Dynamite',
        confidence: 'medium',
      },
      context,
    );
    expect(reading?.refersToTurn).toBeNull();
    expect(reading?.referent).toBeNull();
    expect(reading?.confidence).toBe('medium');
    const fractional = parseAoiTurnUnderstandingToolCall(
      {
        kind: 'question',
        families: ['none'],
        refers_to_turn: 1.5,
        referent: 'x'.repeat(200),
        confidence: 'x',
      },
      context,
    );
    expect(fractional?.refersToTurn).toBeNull();
    expect(fractional?.referent).toBeNull();
    // An unknown confidence value is medium: context only, never actionable.
    expect(fractional?.confidence).toBe('medium');
    expect(
      parseAoiTurnUnderstandingToolCall({ kind: 'action_request', families: ['file'] }, context)
        ?.confidence,
    ).toBe('medium');
  });

  it('keeps the clarification question and options only below high confidence', () => {
    const reading = parseAoiTurnUnderstandingToolCall(
      {
        kind: 'action_request',
        families: ['file'],
        confidence: 'low',
        needs_clarification: '  어느 파일을  말하는 거야?  ',
        clarification_options: ['a.ts', 'A.TS', 'b.ts', 'c.ts', 'd.ts', 42, 'x'.repeat(41)],
      },
      context,
    );
    expect(reading?.needsClarification).toBe('어느 파일을 말하는 거야?');
    expect(reading?.clarificationOptions).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const long = parseAoiTurnUnderstandingToolCall(
      {
        kind: 'action_request',
        families: ['file'],
        confidence: 'low',
        needs_clarification: 'q'.repeat(300),
      },
      context,
    );
    expect(long?.needsClarification).toHaveLength(200);
    const short = parseAoiTurnUnderstandingToolCall(
      { kind: 'action_request', families: ['file'], confidence: 'low', needs_clarification: 'q' },
      context,
    );
    expect(short?.needsClarification).toBeNull();
    expect(short?.clarificationOptions).toEqual([]);
  });

  it('rejects unknown kinds, missing or empty families, and non-object input', () => {
    expect(
      parseAoiTurnUnderstandingToolCall(
        { kind: 'unknown', families: ['app'], confidence: 'high' },
        context,
      ),
    ).toBeNull();
    expect(
      parseAoiTurnUnderstandingToolCall(
        { kind: 'weird', families: ['app'], confidence: 'high' },
        context,
      ),
    ).toBeNull();
    expect(
      parseAoiTurnUnderstandingToolCall({ kind: 'question', confidence: 'high' }, context),
    ).toBeNull();
    expect(
      parseAoiTurnUnderstandingToolCall(
        { kind: 'question', families: ['bogus', 7], confidence: 'high' },
        context,
      ),
    ).toBeNull();
    expect(parseAoiTurnUnderstandingToolCall(null, context)).toBeNull();
    expect(parseAoiTurnUnderstandingToolCall({ kind: 7, families: ['app'] }, context)).toBeNull();
  });

  it('accepts a kind in any letter case and keeps a question only at low confidence', () => {
    expect(
      parseAoiTurnUnderstandingToolCall(
        { kind: 'Action_Request', families: ['file'], confidence: 'high' },
        context,
      )?.kind,
    ).toBe('action_request');
    const medium = parseAoiTurnUnderstandingToolCall(
      {
        kind: 'action_request',
        families: ['file'],
        confidence: 'medium',
        needs_clarification: '어느 파일?',
        clarification_options: ['a.ts'],
      },
      context,
    );
    expect(medium?.needsClarification).toBeNull();
    expect(medium?.clarificationOptions).toEqual([]);
  });

  it('collapses "none" beside a real family to the real family', () => {
    const reading = parseAoiTurnUnderstandingToolCall(
      { kind: 'question', families: ['none', 'host'], confidence: 'high' },
      context,
    );
    expect(reading?.families).toEqual(['host']);
    const onlyNone = parseAoiTurnUnderstandingToolCall(
      { kind: 'chitchat', families: ['none', 'none'], confidence: 'high' },
      context,
    );
    expect(onlyNone?.families).toEqual(['none']);
  });
});

describe('inferAoiTurnUnderstandingFromRegex', () => {
  it('reads plain requests, questions, confirmations, rejections, and chat', () => {
    expect(inferAoiTurnUnderstandingFromRegex('빌드 돌려줘')).toMatchObject({
      kind: 'action_request',
      families: ['command'],
      source: 'regex',
      confidence: 'medium',
    });
    expect(inferAoiTurnUnderstandingFromRegex('오늘 좀 피곤하다')).toMatchObject({
      kind: 'chitchat',
      families: ['none'],
    });
    expect(inferAoiTurnUnderstandingFromRegex('왜 그렇게 생각해?')).toMatchObject({
      kind: 'question',
      families: ['none'],
    });
    expect(inferAoiTurnUnderstandingFromRegex('아니 그거 말고')).toMatchObject({
      kind: 'rejection_or_correction',
    });
    // Bare Korean refusals: JS  never matched after Hangul, so these used to read as chit-chat.
    for (const text of ['아니', '아니야', '됐어', '그만', '아니요.']) {
      expect(inferAoiTurnUnderstandingFromRegex(text).kind, text).toBe('rejection_or_correction');
    }
    expect(inferAoiTurnUnderstandingFromRegex('앱 열어줘').families).toEqual(['app']);
    expect(inferAoiTurnUnderstandingFromRegex('그 곡 틀어줘').families).toEqual(['app']);
    expect(inferAoiTurnUnderstandingFromRegex('너 어떤 모델이야?')).toMatchObject({ kind: 'meta' });
    expect(inferAoiTurnUnderstandingFromRegex('메모장 켜줘').families).toEqual(['host']);
    expect(
      inferAoiTurnUnderstandingFromRegex('Ghidra에서 main 함수 디컴파일해줘').families,
    ).not.toContain('file');
  });

  it('reads a bare yes after an actionable offer as confirmation', () => {
    const history = [{ role: 'assistant' as const, content: '정리했어. notes.md에 저장할까?' }];
    expect(inferAoiTurnUnderstandingFromRegex('응', history)).toMatchObject({
      kind: 'confirmation',
    });
    expect(inferAoiTurnUnderstandingFromRegex('그래')).toMatchObject({
      kind: 'confirmation',
      families: ['none'],
    });
  });

  it('never resolves references or asks for clarification', () => {
    const reading = inferAoiTurnUnderstandingFromRegex('그거 다시 해줘', [
      { role: 'assistant', content: 'pnpm test 돌렸는데 실패했어.' },
    ]);
    expect(reading.refersToTurn).toBeNull();
    expect(reading.referent).toBeNull();
    expect(reading.needsClarification).toBeNull();
  });

  it('names app only when no more specific family fired', () => {
    expect(inferAoiTurnUnderstandingFromRegex('크롬 열어줘').families).toEqual(['browser']);
    expect(inferAoiTurnUnderstandingFromRegex('유튜브 켜줘').families).toEqual(['app']);
  });
});

describe('classifyAoiTurn', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it('returns null without a call when the gate is closed', async () => {
    const result = await classifyAoiTurn(
      { text: '', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
      CONFIG,
    );
    expect(result).toBeNull();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('returns the validated reading with latency, with thinking disabled', async () => {
    chatMock.mockResolvedValue(
      toolResponse({
        kind: 'action_request',
        families: ['file'],
        refers_to_turn: 4,
        referent: 'src/lib/a.ts',
        confidence: 'high',
      }) as never,
    );
    let tick = 100;
    const result = await classifyAoiTurn(
      {
        text: '그거 다시 읽어줘',
        records: RECORDS,
        recentTurnsBlock: 'block',
        hasAttachments: false,
        enabled: true,
      },
      { ...CONFIG, reasoningEffort: 'high' } as never,
      {
        now: () => {
          tick += 250;
          return tick;
        },
      },
    );
    expect(result).toMatchObject({
      kind: 'action_request',
      referent: 'src/lib/a.ts',
      latencyMs: 250,
    });
    const [, tools, config, options] = chatMock.mock.calls[0];
    expect((tools as Array<{ function: { name: string } }>)[0].function.name).toBe(
      AOI_TURN_UNDERSTANDING_TOOL_NAME,
    );
    // Thinking is disabled for the classifier whatever the caller's setting was.
    expect((config as { reasoningEffort?: string }).reasoningEffort).toBe('none');
    expect((options as { temperature?: number }).temperature).toBe(0);
    expect((options as { maxOutputTokens?: number }).maxOutputTokens).toBe(2048);
  });

  it('leaves a model that rejects "none" alone and never sends it temperature', async () => {
    const responsesConfig = {
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      reasoningEffort: 'medium',
    } as unknown as Parameters<typeof classifyAoiTurn>[1];
    // gpt-5 publishes low/medium/high/xhigh; a forced 'none' would be a 400 and a
    // classifier that never runs, so the caller's effort stays.
    expect(withThinkingDisabled(responsesConfig).reasoningEffort).toBe('medium');
    expect(canPinClassifierTemperature(responsesConfig)).toBe(false);
    // Any Responses-API config is left alone, published list or not.
    const oSeries = {
      provider: 'openai',
      model: 'o4-mini',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      apiStyle: 'openai-responses',
    } as unknown as Parameters<typeof classifyAoiTurn>[1];
    expect(withThinkingDisabled(oSeries).reasoningEffort).toBeUndefined();
    expect(canPinClassifierTemperature(oSeries)).toBe(false);
    // MiniMax documents temperature in (0, 1]; thinking off is still requested.
    const minimax = {
      provider: 'minimax',
      model: 'MiniMax-M2.5',
      apiKey: 'k',
      baseUrl: 'https://api.minimax.io/anthropic',
    } as unknown as Parameters<typeof classifyAoiTurn>[1];
    expect(withThinkingDisabled(minimax).reasoningEffort).toBe('none');
    expect(canPinClassifierTemperature(minimax)).toBe(false);
    // An unrestricted model (OpenRouter qwen, DeepSeek) takes both.
    expect(withThinkingDisabled(CONFIG).reasoningEffort).toBe('none');
    expect(canPinClassifierTemperature(CONFIG)).toBe(true);
    expect(
      withThinkingDisabled({ ...CONFIG, provider: 'deepseek', model: 'deepseek-v4-flash' } as never)
        .reasoningEffort,
    ).toBe('none');

    chatMock.mockResolvedValue(
      toolResponse({ kind: 'chitchat', families: ['none'], confidence: 'high' }) as never,
    );
    await classifyAoiTurn(
      { text: '고마워', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
      responsesConfig,
    );
    const [, , config, options] = chatMock.mock.calls[0];
    expect((config as { reasoningEffort?: string }).reasoningEffort).toBe('medium');
    expect((options as { temperature?: number }).temperature).toBeUndefined();
  });

  it('pins temperature 0 when the caller has no reasoning setting', async () => {
    chatMock.mockResolvedValue(
      toolResponse({ kind: 'chitchat', families: ['none'], confidence: 'high' }) as never,
    );
    await classifyAoiTurn(
      { text: '고마워', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
      CONFIG,
    );
    const options = chatMock.mock.calls[0][3] as { temperature?: number };
    expect(options.temperature).toBe(0);
  });

  it('returns null when the model answers without the tool, with bad json, or with an invalid reading', async () => {
    chatMock.mockResolvedValue({ content: 'prose', toolCalls: [] } as never);
    expect(
      await classifyAoiTurn(
        { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
        CONFIG,
      ),
    ).toBeNull();
    chatMock.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'c',
          type: 'function',
          function: { name: AOI_TURN_UNDERSTANDING_TOOL_NAME, arguments: '{not' },
        },
      ],
    } as never);
    expect(
      await classifyAoiTurn(
        { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
        CONFIG,
      ),
    ).toBeNull();
    chatMock.mockResolvedValue(
      toolResponse({ kind: 'weird', families: ['app'], confidence: 'high' }) as never,
    );
    expect(
      await classifyAoiTurn(
        { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
        CONFIG,
      ),
    ).toBeNull();
  });

  it('returns null on a provider error and on a timeout', async () => {
    chatMock.mockRejectedValue(new Error('429'));
    expect(
      await classifyAoiTurn(
        { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
        CONFIG,
      ),
    ).toBeNull();

    chatMock.mockImplementation(
      (_messages, _tools, _config, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await classifyAoiTurn(
      { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
      CONFIG,
      { timeoutMs: 5 },
    );
    expect(result).toBeNull();
  });

  it('honours an already-aborted or later-aborted outer signal', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await classifyAoiTurn(
        { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
        CONFIG,
        { signal: aborted.signal },
      ),
    ).toBeNull();
    expect(chatMock).not.toHaveBeenCalled();

    const outer = new AbortController();
    chatMock.mockImplementation(
      (_messages, _tools, _config, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = classifyAoiTurn(
      { text: '응', records: [], recentTurnsBlock: '', hasAttachments: false, enabled: true },
      CONFIG,
      { signal: outer.signal, timeoutMs: 60_000 },
    );
    outer.abort();
    expect(await pending).toBeNull();
  });
});
