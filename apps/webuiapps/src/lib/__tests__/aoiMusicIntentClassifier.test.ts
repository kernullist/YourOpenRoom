import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectMusicPickCandidates, type MusicPickCandidate } from '../chatDirectActions';
import {
  MUSIC_INTENT_TOOL_NAME,
  buildMusicIntentMessages,
  classifyMusicIntent,
  getMusicIntentToolDefinition,
  isGroundedQuery,
  parseMusicIntentToolCall,
  shouldClassifyMusicIntent,
} from '../aoiMusicIntentClassifier';

vi.mock('../llmClient', () => ({
  chat: vi.fn(),
}));
// eslint-disable-next-line import/first
import { chat } from '../llmClient';

const chatMock = vi.mocked(chat);

const OFFER_QUERY = "aespa エスパ 'KISS N TELL' MV - SMTOWN and aespa";
const OFFER_CARD = [
  '에스파 "KISS N TELL" 어때?',
  `YouTube 검색어: \`${OFFER_QUERY}\``,
  '이거 틀어줄까? 아니면 프로미스나인 쪽으로 갈까?',
].join('\n');

const HISTORY = [{ role: 'assistant' as const, content: OFFER_CARD }];
const CANDIDATES: MusicPickCandidate[] = collectMusicPickCandidates(HISTORY);

const CONFIG = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKey: 'k',
  baseUrl: 'https://example.test',
} as unknown as Parameters<typeof classifyMusicIntent>[2];

function toolResponse(args: unknown) {
  return {
    content: '',
    toolCalls: [
      {
        id: 'c1',
        type: 'function' as const,
        function: { name: MUSIC_INTENT_TOOL_NAME, arguments: JSON.stringify(args) },
      },
    ],
  };
}

describe('collectMusicPickCandidates', () => {
  it('offers every pick the card names, newest first, with its source', () => {
    expect(CANDIDATES.length).toBeGreaterThan(0);
    expect(CANDIDATES[0]).toEqual({ id: 1, query: OFFER_QUERY, context: OFFER_CARD });
    // ids are contiguous from 1, which is what the model is told to choose from.
    expect(CANDIDATES.map((candidate) => candidate.id)).toEqual(
      CANDIDATES.map((_, index) => index + 1),
    );
  });

  it('dedupes and caps', () => {
    const repeated = [
      { role: 'assistant' as const, content: OFFER_CARD },
      { role: 'assistant' as const, content: OFFER_CARD },
    ];
    const queries = collectMusicPickCandidates(repeated).map((candidate) => candidate.query);
    expect(new Set(queries).size).toBe(queries.length);
    expect(collectMusicPickCandidates(repeated, { max: 1 })).toHaveLength(1);
  });

  it('is empty with no assistant picks', () => {
    expect(collectMusicPickCandidates([{ role: 'user', content: '뭐 듣지' }])).toEqual([]);
    expect(collectMusicPickCandidates([])).toEqual([]);
  });
});

describe('shouldClassifyMusicIntent', () => {
  it('needs a pick on the table and a short reply', () => {
    expect(shouldClassifyMusicIntent('그 노래 좀 부탁할게', CANDIDATES)).toBe(true);
    // No candidates: nothing to resolve against, so no call is worth making.
    expect(shouldClassifyMusicIntent('그 노래 좀 부탁할게', [])).toBe(false);
    expect(shouldClassifyMusicIntent('   ', CANDIDATES)).toBe(false);
    // Long messages are saying more than "play this".
    expect(shouldClassifyMusicIntent('가'.repeat(200), CANDIDATES)).toBe(false);
  });
});

describe('buildMusicIntentMessages', () => {
  it('lists the candidate ids and the card excerpt the user actually read', () => {
    const [system, user] = buildMusicIntentMessages('그거 부탁', CANDIDATES);
    expect(system.role).toBe('system');
    expect(system.content).toContain(MUSIC_INTENT_TOOL_NAME);
    expect(user.content).toContain('1. ' + OFFER_QUERY);
    // The excerpt is what makes a cross-script selection resolvable: the card
    // says 에스파 while the query says エスパ.
    expect(user.content).toContain('에스파');
    expect(user.content).toContain('그거 부탁');
  });

  it('never grows with a long card', () => {
    const long = [
      { role: 'assistant' as const, content: `${OFFER_CARD}\n${'긴 설명 '.repeat(400)}` },
    ];
    const [, user] = buildMusicIntentMessages('그거', collectMusicPickCandidates(long));
    expect(user.content.length).toBeLessThan(1200);
  });
});

describe('isGroundedQuery', () => {
  it('accepts words already present in the conversation or the message', () => {
    expect(isGroundedQuery('KISS N TELL', '그거 틀어줘', CANDIDATES)).toBe(true);
    expect(isGroundedQuery('프로미스나인', '프로미스나인으로 가자', CANDIDATES)).toBe(true);
  });

  it('rejects an invented title', () => {
    expect(isGroundedQuery('BLACKPINK Jump MV', '그거 틀어줘', CANDIDATES)).toBe(false);
    expect(isGroundedQuery('   ', '그거', CANDIDATES)).toBe(false);
  });
});

describe('parseMusicIntentToolCall', () => {
  it('resolves a candidate id to that candidate’s exact query', () => {
    expect(
      parseMusicIntentToolCall(
        { action: 'play_candidate', candidate_id: 1, confidence: 'high' },
        '그거',
        CANDIDATES,
      ),
    ).toEqual({ action: 'play_candidate', query: OFFER_QUERY, confidence: 'high' });
  });

  it('refuses an id that is not in the list', () => {
    // A miscounted or invented id is not a pick from this conversation, so there
    // is nothing safe to play.
    for (const candidate_id of [0, 99, -1, '1', null, undefined]) {
      expect(
        parseMusicIntentToolCall(
          { action: 'play_candidate', candidate_id, confidence: 'high' },
          '그거',
          CANDIDATES,
        ),
        String(candidate_id),
      ).toBeNull();
    }
  });

  it('accepts a grounded search and refuses an invented one', () => {
    expect(
      parseMusicIntentToolCall(
        { action: 'search', query: '프로미스나인', confidence: 'high' },
        '프로미스나인으로 가자',
        CANDIDATES,
      ),
    ).toEqual({ action: 'search', query: '프로미스나인', confidence: 'high' });

    expect(
      parseMusicIntentToolCall(
        { action: 'search', query: 'BLACKPINK Jump MV', confidence: 'high' },
        '그거 틀어줘',
        CANDIDATES,
      ),
    ).toBeNull();
    expect(
      parseMusicIntentToolCall(
        { action: 'search', query: '', confidence: 'high' },
        '그거',
        CANDIDATES,
      ),
    ).toBeNull();
    expect(
      parseMusicIntentToolCall(
        { action: 'search', query: '에스파 '.repeat(60), confidence: 'high' },
        '그거',
        CANDIDATES,
      ),
    ).toBeNull();
  });

  it('passes through the no-action outcomes and the refusal', () => {
    expect(
      parseMusicIntentToolCall({ action: 'none', confidence: 'high' }, '배고파', CANDIDATES),
    ).toEqual({
      action: 'none',
      confidence: 'high',
    });
    expect(
      parseMusicIntentToolCall(
        { action: 'reject_and_repick', exclude: ['에스파', '에스파', 'x'], confidence: 'low' },
        '다른거',
        CANDIDATES,
      ),
      // 'x' is a single char -- too short to filter by -- and the duplicate is dropped.
    ).toEqual({ action: 'reject_and_repick', confidence: 'low', exclude: ['에스파'] });
  });

  it('caps and cleans the exclude list', () => {
    // Caps at 4 so a runaway list cannot turn into a wall of minus operators;
    // non-strings are dropped rather than coerced, and single-char terms are
    // dropped because the app filters by substring -- a one-char needle would
    // nuke unrelated results.
    expect(
      parseMusicIntentToolCall(
        {
          action: 'reject_and_repick',
          exclude: ['에스파', '뉴진스', '아이브', '르세라핌', '트와이스'],
          confidence: 'high',
        },
        '다 말고',
        CANDIDATES,
      ),
    ).toEqual({
      action: 'reject_and_repick',
      confidence: 'high',
      exclude: ['에스파', '뉴진스', '아이브', '르세라핌'],
    });
    expect(
      parseMusicIntentToolCall(
        { action: 'reject_and_repick', exclude: [1, null, {}, '  '], confidence: 'high' },
        '다 말고',
        CANDIDATES,
      ),
    ).toEqual({ action: 'reject_and_repick', confidence: 'high' });
    expect(
      parseMusicIntentToolCall(
        { action: 'reject_and_repick', exclude: 'not-an-array', confidence: 'high' },
        '다 말고',
        CANDIDATES,
      ),
    ).toEqual({ action: 'reject_and_repick', confidence: 'high' });
  });

  it('rejects an unknown or missing action', () => {
    for (const raw of [{}, { action: 'play' }, { action: 42 }, null, undefined]) {
      expect(parseMusicIntentToolCall(raw, '그거', CANDIDATES)).toBeNull();
    }
  });

  it('keeps low confidence visible to the caller', () => {
    expect(
      parseMusicIntentToolCall(
        { action: 'play_candidate', candidate_id: 1, confidence: 'low' },
        '음',
        CANDIDATES,
      )?.confidence,
    ).toBe('low');
  });
});

describe('classifyMusicIntent', () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it('classifies through the tool call', async () => {
    chatMock.mockResolvedValue(
      toolResponse({ action: 'play_candidate', candidate_id: 1, confidence: 'high' }) as never,
    );
    await expect(classifyMusicIntent('그 노래 좀 부탁할게', CANDIDATES, CONFIG)).resolves.toEqual({
      action: 'play_candidate',
      query: OFFER_QUERY,
      confidence: 'high',
    });
    expect(chatMock).toHaveBeenCalledTimes(1);
    const [, tools] = chatMock.mock.calls[0];
    expect(tools).toEqual([getMusicIntentToolDefinition()]);
  });

  it('asks for a deterministic answer, and skips temperature on reasoning models', async () => {
    chatMock.mockResolvedValue(toolResponse({ action: 'none', confidence: 'high' }) as never);

    await classifyMusicIntent('그거 부탁', CANDIDATES, CONFIG);
    const [, , , options] = chatMock.mock.calls[0];
    // A slot that changes between identical inputs is a bug, not personality.
    expect(options).toMatchObject({ temperature: 0 });
    expect((options as { maxOutputTokens?: number }).maxOutputTokens).toBeGreaterThan(0);

    // gpt-5 / o-series endpoints reject temperature, and a rejected request would
    // silently cost the whole classification -- so it is left off there.
    chatMock.mockClear();
    await classifyMusicIntent('그거 부탁', CANDIDATES, {
      ...(CONFIG as object),
      reasoningEffort: 'medium',
    } as typeof CONFIG);
    const [, , , reasoningOptions] = chatMock.mock.calls[0];
    expect(reasoningOptions).not.toHaveProperty('temperature');
    expect((reasoningOptions as { maxOutputTokens?: number }).maxOutputTokens).toBeGreaterThan(0);
  });

  it('never calls the provider when the gate says no', async () => {
    await expect(classifyMusicIntent('그거', [], CONFIG)).resolves.toBeNull();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('falls back to null on anything unusual', async () => {
    // A provider outage must not break the turn.
    chatMock.mockRejectedValueOnce(new Error('boom'));
    await expect(classifyMusicIntent('그거 부탁', CANDIDATES, CONFIG)).resolves.toBeNull();

    // Prose instead of a tool call.
    chatMock.mockResolvedValueOnce({ content: 'sure!', toolCalls: [] } as never);
    await expect(classifyMusicIntent('그거 부탁', CANDIDATES, CONFIG)).resolves.toBeNull();

    // Unparseable arguments.
    chatMock.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: MUSIC_INTENT_TOOL_NAME, arguments: '{not json' },
        },
      ],
    } as never);
    await expect(classifyMusicIntent('그거 부탁', CANDIDATES, CONFIG)).resolves.toBeNull();

    // A different tool than the one it was given.
    chatMock.mockResolvedValueOnce({
      content: '',
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'respond_to_user', arguments: '{}' } },
      ],
    } as never);
    await expect(classifyMusicIntent('그거 부탁', CANDIDATES, CONFIG)).resolves.toBeNull();
  });
});
