import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maliciousProcedureSourceFixture,
  updatedFactMemoryFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import {
  buildAoiKiraAutomationMemoryCandidates,
  buildAoiMemoryPrompt,
  buildAoiSharedEpisodeBlock,
  formatAoiEpisodeAge,
  loadAoiRecentMemoryEpisodes,
  selectAoiSharedEpisodesForPrompt,
  type AoiMemoryEpisode,
  applyAoiMemoryRecallUsage,
  distillAoiMemoryCandidatesWithLlm,
  isAoiDistillerTimeoutError,
  pickAoiDistillerReasoningEffort,
  resolveAoiDistillerConfig,
  shouldRetryAoiDistiller,
  extractHeuristicAoiMemoryCandidates,
  forgetAoiPreferencePollMemory,
  loadAoiMemories,
  mergeAoiMemoryCandidates,
  normalizeAoiMemoryCandidate,
  parseAoiMemoryDistillerResponse,
  scoreAoiMemoryForQuery,
  selectAoiMemoriesForPrompt,
  syncAoiMemoryFromPreferencePoll,
  type AoiMemoryEntry,
} from '../aoiMemoryManager';
import {
  buildPreferencePollMemoryCandidate,
  getPreferenceQuestionPrefKey,
  tastePrefTag,
} from '../aoiPreferencePoll';
import type { ChatMessage, ToolDef } from '../llmClient';
import type { LLMConfig } from '../llmModels';
import type { AoiDistillerAttempt } from '../aoiMemoryDistillerHealth';

const MOCK_LLM_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
};

const EPISODE_NOW = 1_000_000_000;
const EPISODE_HOUR = 60 * 60 * 1000;
const EPISODE_DAY = 24 * EPISODE_HOUR;

function makeEpisode(partial: Partial<AoiMemoryEpisode>): AoiMemoryEpisode {
  return {
    version: 1,
    id: partial.id ?? 'aoi_ep_1_abc',
    sessionPath: partial.sessionPath ?? 'aoi/default',
    source: partial.source ?? 'chat_turn',
    userMessage: partial.userMessage ?? 'user said something',
    assistantMessage: partial.assistantMessage ?? 'aoi replied something',
    toolCalls: partial.toolCalls ?? [],
    createdAt: partial.createdAt ?? EPISODE_NOW,
    ...(partial.outcome !== undefined ? { outcome: partial.outcome } : {}),
  };
}

function makeMemory(partial: Partial<AoiMemoryEntry>): AoiMemoryEntry {
  return {
    version: 2,
    id: partial.id ?? 'mem-1',
    scope: partial.scope ?? 'user',
    type: partial.type ?? 'fact',
    status: partial.status ?? 'active',
    content: partial.content ?? 'The user prefers Korean responses.',
    normalizedContent:
      partial.normalizedContent ?? partial.content ?? 'The user prefers Korean responses.',
    importance: partial.importance ?? 0.7,
    confidence: partial.confidence ?? 0.8,
    hits: partial.hits ?? 1,
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['ep-1'],
    tags: partial.tags ?? [],
    entities: partial.entities ?? [],
    ...(partial.lastAccessedAt ? { lastAccessedAt: partial.lastAccessedAt } : {}),
    ...(partial.recallHits ? { recallHits: partial.recallHits } : {}),
    ...(partial.expiresAt ? { expiresAt: partial.expiresAt } : {}),
    ...(partial.permanent ? { permanent: partial.permanent } : {}),
    ...(partial.supersedes ? { supersedes: partial.supersedes } : {}),
    ...(partial.embedding ? { embedding: partial.embedding } : {}),
    ...(partial.embeddingModel ? { embeddingModel: partial.embeddingModel } : {}),
  };
}

describe('extractHeuristicAoiMemoryCandidates()', () => {
  it('extracts durable name and preference memories', () => {
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: '내 이름은 꿀보야. 나는 한국어 답변을 선호해.',
      assistantMessage: '알겠어.',
    });

    expect(candidates.some((candidate) => candidate.content === "The user's name is 꿀보.")).toBe(
      true,
    );
    expect(candidates.some((candidate) => candidate.type === 'preference')).toBe(true);
  });

  it('ignores short transient turns', () => {
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: '고마워',
      assistantMessage: '천만에.',
    });

    expect(candidates).toEqual([]);
  });

  it('keeps explicit remember requests', () => {
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: '기억해줘 나는 커밋할 때 gloryo@naver.com을 사용해.',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].tags).toContain('explicit');
  });

  it('marks explicit never-forget requests as permanent', () => {
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: '절대 잊지 마 나는 커밋할 때 kernullist 이름을 사용해.',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].permanent).toBe(true);
    expect(candidates[0].tags).toEqual(expect.arrayContaining(['explicit', 'permanent']));
  });

  it('emits ONE candidate for a preference statement with an explicit remember marker', () => {
    // "...좋아해. 기억해둬" used to fan out into a preference candidate (raw
    // message) AND an explicit fact candidate (cleaned message) -- two
    // near-identical memories from one sentence.
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: '나는 K-POP 걸그룹 노래들을 좋아해. 기억해둬',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('preference');
    expect(candidates[0].tags).toEqual(expect.arrayContaining(['preference', 'explicit']));
    expect(candidates[0].content).not.toContain('기억해둬');
  });

  it('auto-records technical interests from questions without explicit remember requests', () => {
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: 'Windows 커널 드라이버 보안 연구는 어떤 테스트 하네스를 설계하면 좋을까?',
      now: new Date(2026, 5, 11).getTime(),
    });

    const interest = candidates.find((candidate) => candidate.tags?.includes('interest'));
    expect(interest).toMatchObject({
      scope: 'user',
      type: 'preference',
    });
    expect(interest?.permanent).toBeUndefined();
    expect(interest?.content).toContain('On 2026-06-11');
    expect(interest?.content).toContain('Windows security engineering');
    expect(interest?.tags).toEqual(expect.arrayContaining(['interest', 'auto', 'question-topic']));
  });

  it('does not auto-record broad transient non-technical questions', () => {
    const candidates = extractHeuristicAoiMemoryCandidates({
      userMessage: '오늘 저녁 뭐 먹지?',
      now: new Date(2026, 5, 11).getTime(),
    });

    expect(candidates).toEqual([]);
  });
});

describe('mergeAoiMemoryCandidates()', () => {
  it('deduplicates existing active memories and increments hits', () => {
    const existing = [
      makeMemory({
        id: 'mem-a',
        content: 'The user prefers Korean responses.',
        normalizedContent: 'the user prefers korean responses.',
        hits: 1,
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [
        {
          type: 'preference',
          content: 'The user prefers Korean responses.',
          confidence: 0.9,
        },
      ],
      { sessionPath: 'aoi/default', episodeId: 'ep-2', now: 100 },
    );

    expect(merged.memories).toHaveLength(1);
    expect(merged.memories[0].hits).toBe(2);
    expect(merged.memories[0].sourceEpisodeIds).toContain('ep-2');
  });

  it('does not increment hits when the same episode is replayed', () => {
    const existing = [
      makeMemory({
        id: 'mem-a',
        content: 'Kira completed project work "Fix tests" for OpenRoom.',
        normalizedContent: 'kira completed project work "fix tests" for openroom.',
        hits: 1,
        updatedAt: 10,
        sourceEpisodeIds: ['ep-1'],
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [
        {
          scope: 'project',
          type: 'action',
          content: 'Kira completed project work "Fix tests" for OpenRoom.',
          confidence: 0.8,
        },
      ],
      { sessionPath: 'aoi/default', episodeId: 'ep-1', now: 100 },
    );

    expect(merged.changedIds).toEqual([]);
    expect(merged.memories[0].hits).toBe(1);
    expect(merged.memories[0].updatedAt).toBe(10);
  });

  it('reinforces a near-duplicate preference restatement instead of creating a new file', () => {
    const existing = [
      makeMemory({
        id: 'mem-kpop',
        type: 'preference',
        content: 'User likes K-POP girl group songs.',
        normalizedContent: 'user likes k-pop girl group songs.',
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [
        {
          type: 'preference',
          scope: 'user',
          content: 'User loves K-POP girl group songs. (7월 걸그룹 플레이리스트 자주 청취)',
          importance: 0.85,
          confidence: 0.82,
          tags: ['manual'],
        },
      ],
      { sessionPath: 'aoi/default', episodeId: 'ep-2', now: 2000 },
    );

    // Reinforced in place: still one memory, content kept verbatim, hits bumped.
    expect(merged.memories).toHaveLength(1);
    expect(merged.memories[0].id).toBe('mem-kpop');
    expect(merged.memories[0].content).toBe('User likes K-POP girl group songs.');
    expect(merged.memories[0].hits).toBe(2);
    expect(merged.memories[0].tags).toContain('manual');
  });

  it('keeps genuinely different or opposite-polarity preferences separate', () => {
    const existing = [
      makeMemory({
        id: 'mem-fps',
        type: 'preference',
        content: 'The user likes competitive FPS games.',
        normalizedContent: 'the user likes competitive fps games.',
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [
        {
          type: 'preference',
          scope: 'user',
          content: 'The user dislikes puzzle games and story-driven RPG titles.',
          importance: 0.75,
          confidence: 0.72,
          tags: ['preference'],
        },
      ],
      { sessionPath: 'aoi/default', episodeId: 'ep-3', now: 3000 },
    );

    expect(merged.memories).toHaveLength(2);
    expect(merged.memories.filter((memory) => memory.status === 'active')).toHaveLength(2);
  });

  it('supersedes stale name facts', () => {
    const existing = [
      makeMemory({
        id: 'old-name',
        content: "The user's name is OldName.",
        normalizedContent: "the user's name is oldname.",
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [{ type: 'fact', content: "The user's name is NewName.", confidence: 0.9 }],
      { sessionPath: 'aoi/default', episodeId: 'ep-2', now: 100 },
    );

    expect(merged.memories.find((memory) => memory.id === 'old-name')?.status).toBe('superseded');
    expect(
      merged.memories.find((memory) => memory.content.includes('NewName'))?.supersedes,
    ).toEqual(['old-name']);
  });

  it('protects permanent memories from non-permanent conflict replacement', () => {
    const existing = [
      makeMemory({
        id: 'permanent-name',
        content: "The user's name is PermanentName.",
        normalizedContent: "the user's name is permanentname.",
        permanent: true,
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [{ type: 'fact', content: "The user's name is TransientName.", confidence: 0.9 }],
      { sessionPath: 'aoi/default', episodeId: 'ep-2', now: 100 },
    );

    expect(merged.changedIds).toEqual([]);
    expect(merged.memories).toHaveLength(1);
    expect(merged.memories[0]).toMatchObject({
      id: 'permanent-name',
      status: 'active',
      permanent: true,
    });
  });

  it('allows explicit permanent memories to replace protected conflicts', () => {
    const existing = [
      makeMemory({
        id: 'old-permanent-name',
        content: "The user's name is OldPermanentName.",
        normalizedContent: "the user's name is oldpermanentname.",
        permanent: true,
      }),
    ];

    const merged = mergeAoiMemoryCandidates(
      existing,
      [
        {
          type: 'fact',
          content: "The user's name is NewPermanentName.",
          confidence: 0.92,
          permanent: true,
        },
      ],
      { sessionPath: 'aoi/default', episodeId: 'ep-2', now: 100 },
    );

    expect(merged.memories.find((memory) => memory.id === 'old-permanent-name')?.status).toBe(
      'superseded',
    );
    expect(merged.memories.find((memory) => memory.content.includes('NewPermanentName'))).toEqual(
      expect.objectContaining({
        status: 'active',
        permanent: true,
        supersedes: ['old-permanent-name'],
      }),
    );
  });

  it('prefers updated active facts and excludes superseded facts from prompt recall', () => {
    const memories = [
      makeMemory({
        id: 'memory-stale-fact',
        status: 'superseded',
        content: "The user's preferred commit identity is Old Name <old@example.com>.",
        normalizedContent: "the user's preferred commit identity is old name <old@example.com>.",
      }),
      updatedFactMemoryFixture,
    ];

    const selected = selectAoiMemoriesForPrompt(memories, '커밋 identity 기억나?', {
      maxChars: 500,
    });
    const prompt = buildAoiMemoryPrompt(selected, '커밋 identity 기억나?');

    expect(prompt).toContain('kernullist <gloryo@naver.com>');
    expect(prompt).not.toContain('Old Name');
  });

  it('boosts memories Aoi actually recalls, separately from re-capture hits', () => {
    const recalled = makeMemory({
      id: 'memory-recalled',
      content: 'User debugs kernel drivers with IDA first.',
      normalizedContent: 'user debugs kernel drivers with ida first.',
      recallHits: 8,
    });
    const never = makeMemory({
      id: 'memory-never-recalled',
      content: 'User debugs kernel drivers with IDA first (dup).',
      normalizedContent: 'user debugs kernel drivers with ida first (dup).',
    });

    // Identical on every other axis, so the ordering is the recall signal alone.
    expect(scoreAoiMemoryForQuery(recalled, '커널 디버깅')).toBeGreaterThan(
      scoreAoiMemoryForQuery(never, '커널 디버깅'),
    );
  });

  it('stamps recall usage without resetting the decay clock', () => {
    const memory = makeMemory({ id: 'memory-used', updatedAt: 1000, recallHits: 2 });
    const used = applyAoiMemoryRecallUsage(memory, 9_999);

    expect(used.recallHits).toBe(3);
    expect(used.lastAccessedAt).toBe(9_999);
    // updatedAt drives decay age; recall must inform forgetting, not cancel it.
    expect(used.updatedAt).toBe(1000);
  });

  it('skips an over-budget memory instead of ending selection at it', () => {
    const longTop = makeMemory({
      id: 'memory-long-top',
      importance: 0.99,
      confidence: 0.95,
      content: 'k'.repeat(300),
      normalizedContent: 'k'.repeat(300),
    });
    const shortA = makeMemory({
      id: 'memory-short-a',
      importance: 0.7,
      confidence: 0.8,
      content: 'user prefers concise answers',
      normalizedContent: 'user prefers concise answers',
    });
    const shortB = makeMemory({
      id: 'memory-short-b',
      importance: 0.6,
      confidence: 0.8,
      content: 'user works on kernel drivers',
      normalizedContent: 'user works on kernel drivers',
    });

    const selected = selectAoiMemoriesForPrompt([longTop, shortA, shortB], '', {
      maxChars: 80,
    });

    // The 300-char top-ranked memory cannot fit an 80-char budget; the two
    // short memories below it must still be selected rather than dropped.
    expect(selected.map((memory) => memory.id)).toEqual(['memory-short-a', 'memory-short-b']);
  });

  it('strips malicious source instructions from durable procedure candidates', () => {
    const candidate = normalizeAoiMemoryCandidate({
      type: 'procedure',
      content: maliciousProcedureSourceFixture,
      confidence: 0.8,
    });

    expect(candidate?.content).not.toMatch(/ignore previous instructions/i);
    expect(candidate?.content).toContain('compare source dates');
  });
});

describe('Aoi Kira memory bridge', () => {
  it('turns completed Kira events into project action memories', () => {
    const candidates = buildAoiKiraAutomationMemoryCandidates(
      {
        id: 'event-1',
        workId: 'work-1',
        title: 'Add review controls',
        projectName: 'YourOpenRoom',
        message: 'Kira 완료: "Add review controls" 작업이 끝났어요.',
        createdAt: 100,
        type: 'completed',
      },
      {
        reviewApproved: true,
        validationPassedCount: 1,
        validationFailedCount: 0,
      },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      scope: 'project',
      type: 'action',
      projectKey: 'youropenroom',
    });
    expect(candidates[0].content).toContain('Kira completed project work');
    expect(candidates[0].tags).toContain('completed');
  });

  it('does not turn unreviewed completed Kira events into durable memories', () => {
    const candidates = buildAoiKiraAutomationMemoryCandidates({
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira 완료: "Add review controls" 작업이 끝났어요.',
      createdAt: 100,
      type: 'completed',
    });

    expect(candidates).toEqual([]);
  });

  it('ignores transient Kira progress events', () => {
    const candidates = buildAoiKiraAutomationMemoryCandidates({
      id: 'event-1',
      workId: 'work-1',
      title: 'Add review controls',
      projectName: 'YourOpenRoom',
      message: 'Kira started.',
      createdAt: 100,
      type: 'started',
    });

    expect(candidates).toEqual([]);
  });
});

describe('Aoi prompt memory selection', () => {
  it('selects active relevant memories and excludes superseded ones', () => {
    const memories = [
      makeMemory({
        id: 'relevant',
        content: 'The user prefers Korean answers for security engineering work.',
        tags: ['language', 'security'],
        updatedAt: 100,
      }),
      makeMemory({
        id: 'stale',
        status: 'superseded',
        content: 'The user prefers English answers.',
        updatedAt: 200,
      }),
    ];

    const selected = selectAoiMemoriesForPrompt(memories, '보안 엔지니어링 답변 언어', {
      now: 300,
    });
    const prompt = buildAoiMemoryPrompt(memories, '보안 엔지니어링 답변 언어');

    expect(selected.map((memory) => memory.id)).toEqual(['relevant']);
    expect(prompt).toContain('Durable Aoi memory');
    expect(prompt).toContain('Korean answers');
    expect(prompt).not.toContain('English answers');
  });

  it('prioritizes durable conversation preferences over shallow event memories', () => {
    const now = 1_000;
    const preferenceMemory = makeMemory({
      id: 'conversation-preference',
      scope: 'user',
      type: 'preference',
      content:
        'The user prefers Korean security engineering answers with concrete implementation details.',
      importance: 0.7,
      confidence: 0.8,
      hits: 1,
      updatedAt: 100,
      sourceEpisodeIds: ['aoi_ep_preference'],
      tags: ['preference', 'llm-distilled'],
      entities: ['Korean', 'security engineering'],
    });
    const shallowEventMemory = makeMemory({
      id: 'shallow-event',
      scope: 'project',
      type: 'event',
      content: 'A temporary file scan completed during the previous turn.',
      importance: 0.7,
      confidence: 0.8,
      hits: 1,
      updatedAt: 100,
      sourceEpisodeIds: ['aoi_ep_event'],
      tags: ['event'],
    });

    const query = '앞으로 보안 엔지니어링 답변 스타일은 어떻게 맞춰야 해?';
    const preferenceScore = scoreAoiMemoryForQuery(preferenceMemory, query, now);
    const eventScore = scoreAoiMemoryForQuery(shallowEventMemory, query, now);
    const selected = selectAoiMemoriesForPrompt([shallowEventMemory, preferenceMemory], query, {
      now,
      limit: 1,
    });

    expect(preferenceScore).toBeGreaterThan(eventScore + 0.08);
    expect(selected.map((memory) => memory.id)).toEqual(['conversation-preference']);
  });

  it('keeps relevant permanent memories eligible despite expiry and low confidence', () => {
    const now = 1_000;
    const permanentMemory = makeMemory({
      id: 'permanent-low-confidence',
      content: 'The user always wants Windows kernel debugging answers in Korean.',
      confidence: 0.2,
      expiresAt: 900,
      permanent: true,
      updatedAt: 100,
      tags: ['permanent', 'kernel'],
    });

    const selected = selectAoiMemoriesForPrompt([permanentMemory], '커널 디버깅 답변 언어 기억', {
      now,
    });
    const prompt = buildAoiMemoryPrompt([permanentMemory], '커널 디버깅 답변 언어 기억');

    expect(selected.map((memory) => memory.id)).toEqual(['permanent-low-confidence']);
    expect(prompt).toContain('permanent user/fact');
  });

  it('threads queryEmbeddingModel so cross-model vectors fall back to lexical/importance', () => {
    const now = 1_000;
    // Neither memory shares a token with the query, so ranking is driven by the
    // embedding (when model-compatible) vs importance.
    const semanticMatch = makeMemory({
      id: 'semantic-match',
      scope: 'session',
      content: 'alpha bravo charlie',
      importance: 0.4,
      confidence: 0.8,
      updatedAt: 100,
      embedding: [1, 0, 0],
      embeddingModel: 'model-x',
    });
    const importantOrthogonal = makeMemory({
      id: 'important-orthogonal',
      scope: 'session',
      content: 'delta echo foxtrot',
      importance: 0.7,
      confidence: 0.8,
      updatedAt: 100,
      embedding: [0, 1, 0],
      embeddingModel: 'model-x',
    });
    const query = 'zulu yankee xray';
    const queryEmbedding = [1, 0, 0];

    // Matching model -> the cosine-aligned memory wins despite lower importance.
    const matched = selectAoiMemoriesForPrompt([importantOrthogonal, semanticMatch], query, {
      now,
      limit: 1,
      queryEmbedding,
      queryEmbeddingModel: 'model-x',
    });
    expect(matched.map((memory) => memory.id)).toEqual(['semantic-match']);

    // Mismatched model -> semantic is suppressed end-to-end, so the more
    // important memory wins. This proves queryEmbeddingModel threads from
    // selectAoiMemoriesForPrompt into scoreAoiMemoryForQuery.
    const mismatched = selectAoiMemoriesForPrompt([importantOrthogonal, semanticMatch], query, {
      now,
      limit: 1,
      queryEmbedding,
      queryEmbeddingModel: 'model-y',
    });
    expect(mismatched.map((memory) => memory.id)).toEqual(['important-orthogonal']);
  });
});

describe('Aoi LLM memory distiller', () => {
  it('parses fenced JSON memory candidates and filters sensitive content', () => {
    const raw = [
      '```json',
      '{',
      '  "memories": [',
      '    {',
      '      "scope": "user",',
      '      "type": "preference",',
      '      "content": "The user prefers Korean security engineering answers.",',
      '      "importance": 0.82,',
      '      "confidence": 0.88,',
      '      "tags": ["language"],',
      '      "entities": ["Korean"]',
      '    },',
      '    {',
      '      "scope": "user",',
      '      "type": "fact",',
      '      "content": "The user\'s API key is sk-secret.",',
      '      "importance": 0.99,',
      '      "confidence": 0.99',
      '    }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const candidates = parseAoiMemoryDistillerResponse(raw);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('preference');
    expect(candidates[0].tags).toContain('llm-distilled');
  });

  it('uses the configured chat client and returns normalized distiller candidates', async () => {
    const calls: Array<{ messageCount: number; toolCount: number; model: string }> = [];
    const distillerChat = async (messages: ChatMessage[], tools: ToolDef[], config: LLMConfig) => {
      calls.push({ messageCount: messages.length, toolCount: tools.length, model: config.model });
      return {
        content: JSON.stringify({
          memories: [
            {
              scope: 'project',
              type: 'decision',
              content: 'Aoi memory should use background distillation with heuristic fallback.',
              importance: 0.86,
              confidence: 0.84,
              tags: ['architecture'],
            },
          ],
        }),
        toolCalls: [],
      };
    };

    const candidates = await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '다음 단계는 LLM distiller fallback 구조로 하자.',
      assistantMessage:
        'LLM distiller를 background sync에 붙이고 실패 시 휴리스틱으로 유지하겠습니다.',
      llmConfig: MOCK_LLM_CONFIG,
      distillerChat,
    });

    expect(calls).toEqual([{ messageCount: 2, toolCount: 0, model: 'gpt-5-mini' }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].scope).toBe('project');
    expect(candidates[0].type).toBe('decision');
  });

  it('picks the cheapest reasoning effort the model actually supports', () => {
    // The bug this guards: 'low' is not a DeepSeek effort, and
    // applyDeepSeekChatRuntimeOptions maps any non-'none' value to
    // thinking:enabled + reasoning_effort 'high' -- a full thinking pass for a
    // JSON extraction, which blew the distiller timeout on every turn.
    expect(
      pickAoiDistillerReasoningEffort({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
    ).toBe('none');
    // GPT-5 does not accept 'none'; its cheapest published effort is 'low'.
    expect(pickAoiDistillerReasoningEffort({ provider: 'openai', model: 'gpt-5.4' })).toBe('low');
    // A model publishing no restriction keeps the historical value.
    expect(pickAoiDistillerReasoningEffort({ provider: 'anthropic', model: 'claude-opus-5' })).toBe(
      'low',
    );
  });

  it('sends the distiller config with thinking disabled on DeepSeek', async () => {
    const seen: LLMConfig[] = [];
    const distillerChat = async (_m: ChatMessage[], _t: ToolDef[], config: LLMConfig) => {
      seen.push(config);
      return { content: JSON.stringify({ memories: [] }), toolCalls: [] };
    };

    await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '커널 드라이버 얘기 계속하자',
      assistantMessage: '좋아, 이어서 보자.',
      llmConfig: { ...MOCK_LLM_CONFIG, provider: 'deepseek', model: 'deepseek-v4-flash' },
      distillerChat,
      recordDistillerAttempt: () => undefined,
    });

    expect(seen[0].reasoningEffort).toBe('none');
    expect(seen[0].verbosity).toBe('low');
  });

  it('retries once on a transient failure and records the outcome', async () => {
    const attempts: AoiDistillerAttempt[] = [];
    let calls = 0;
    const distillerChat = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('network error: failed to fetch');
      }
      return {
        content: JSON.stringify({
          memories: [{ scope: 'user', type: 'fact', content: 'User ships kernel drivers.' }],
        }),
        toolCalls: [],
      };
    };

    const candidates = await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '나는 커널 드라이버를 만든다',
      assistantMessage: '기록해둘게.',
      llmConfig: MOCK_LLM_CONFIG,
      distillerChat,
      recordDistillerAttempt: (attempt) => attempts.push(attempt),
    });

    expect(calls).toBe(2);
    expect(candidates).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'ok', attempts: 2, candidateCount: 1 });
  });

  it('does not retry a permanent provider error and records it as an error', async () => {
    const attempts: AoiDistillerAttempt[] = [];
    let calls = 0;
    const distillerChat = async () => {
      calls += 1;
      throw new Error('LLM API error 401: invalid api key');
    };

    await expect(
      distillAoiMemoryCandidatesWithLlm({
        sessionPath: 'aoi/default',
        userMessage: '테스트 메시지입니다 조금 길게',
        assistantMessage: '응답입니다.',
        llmConfig: MOCK_LLM_CONFIG,
        distillerChat,
        recordDistillerAttempt: (attempt) => attempts.push(attempt),
      }),
    ).rejects.toThrow(/401/);

    // A bad key fails identically every time; retrying only doubles the cost.
    expect(calls).toBe(1);
    expect(attempts[0]).toMatchObject({ outcome: 'error', attempts: 1 });
    expect(attempts[0].reason).toContain('401');
  });

  it('classifies retryable versus permanent distiller failures by status code', () => {
    expect(shouldRetryAoiDistiller(new Error('Aoi memory distiller timed out after 20000ms'))).toBe(
      true,
    );
    expect(shouldRetryAoiDistiller(new Error('network error'))).toBe(true);
    // Retryable statuses, across every provider's message format -- matching one
    // provider's prefix missed Anthropic's canonical 529 overload entirely.
    expect(shouldRetryAoiDistiller(new Error('LLM API error 429: Rate limit reached'))).toBe(true);
    expect(shouldRetryAoiDistiller(new Error('LLM API error 408: request timeout'))).toBe(true);
    expect(shouldRetryAoiDistiller(new Error('LLM API error 500: internal error'))).toBe(true);
    expect(shouldRetryAoiDistiller(new Error('Anthropic API error 529: overloaded_error'))).toBe(
      true,
    );
    // Permanent: a second identical request cannot fix these.
    expect(shouldRetryAoiDistiller(new Error('LLM API error 400: bad request'))).toBe(false);
    expect(shouldRetryAoiDistiller(new Error('LLM API error 401: invalid api key'))).toBe(false);
    expect(
      shouldRetryAoiDistiller(new Error('Responses API error 400: Unsupported parameter')),
    ).toBe(false);
    // Was retried purely because "upstream" contains the substring "stream".
    expect(shouldRetryAoiDistiller(new Error('Anthropic API error 400: upstream rejected'))).toBe(
      false,
    );
    expect(isAoiDistillerTimeoutError(new Error('timed out after 8000ms'))).toBe(true);
    expect(isAoiDistillerTimeoutError(new Error('nope'))).toBe(false);
  });

  it('falls back to an HTTP config when the main model is a CLI provider', () => {
    const cliMain: LLMConfig = {
      provider: 'claude-cli',
      apiKey: '',
      baseUrl: '',
      model: 'opus',
      command: 'claude',
    };

    // Without a fallback the distiller is skipped entirely, which left CLI
    // users on regex-only capture forever.
    expect(resolveAoiDistillerConfig(cliMain, null)).toBeNull();
    expect(resolveAoiDistillerConfig(cliMain, MOCK_LLM_CONFIG)).toBe(MOCK_LLM_CONFIG);
    // A usable main config always wins over the fallback.
    expect(resolveAoiDistillerConfig(MOCK_LLM_CONFIG, { ...MOCK_LLM_CONFIG, model: 'other' })).toBe(
      MOCK_LLM_CONFIG,
    );
    // Two CLI configs stay unusable rather than spawning a process per turn.
    expect(resolveAoiDistillerConfig(cliMain, { ...cliMain, provider: 'codex-cli' })).toBeNull();
  });

  it('runs the distiller on the fallback config when the main one is CLI', async () => {
    const seen: LLMConfig[] = [];
    const distillerChat = async (_m: ChatMessage[], _t: ToolDef[], config: LLMConfig) => {
      seen.push(config);
      return {
        content: JSON.stringify({
          memories: [{ scope: 'user', type: 'fact', content: 'User ships kernel drivers.' }],
        }),
        toolCalls: [],
      };
    };

    const candidates = await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '나는 커널 드라이버를 만든다',
      assistantMessage: '기록해둘게.',
      llmConfig: { provider: 'codex-cli', apiKey: '', baseUrl: '', model: 'gpt-5.5' },
      distillerFallbackConfig: MOCK_LLM_CONFIG,
      distillerChat,
      recordDistillerAttempt: () => undefined,
    });

    expect(candidates).toHaveLength(1);
    expect(seen[0].provider).toBe('openai');
  });

  it('disables thinking for every DeepSeek model, not just the ones with a table entry', () => {
    // getSupportedReasoningEfforts returns [] for models that declare nothing,
    // which sent deepseek-chat (a one-click preset) and any hand-typed id back
    // to 'low' -- the value that turns DeepSeek thinking ON.
    for (const model of [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-chat',
      'deepseek-v3.2',
    ]) {
      expect(pickAoiDistillerReasoningEffort({ provider: 'deepseek', model })).toBe('none');
    }
  });

  it('reports a non-JSON distiller response as malformed rather than an empty turn', () => {
    const attempts: AoiDistillerAttempt[] = [];
    const distillerChat = async () => ({
      content: '<think>Let me consider what to remember...</think> I could not decide.',
      toolCalls: [],
    });

    return distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '커널 드라이버 얘기 계속하자',
      assistantMessage: '좋아, 이어서 보자.',
      llmConfig: MOCK_LLM_CONFIG,
      distillerChat,
      recordDistillerAttempt: (attempt) => attempts.push(attempt),
    }).then((candidates) => {
      expect(candidates).toEqual([]);
      expect(attempts[0]).toMatchObject({ outcome: 'malformed', candidateCount: 0 });
    });
  });

  it('keeps candidates when the health recorder throws', () => {
    // Diagnostics must never eat the payload the provider already produced.
    const distillerChat = async () => ({
      content: JSON.stringify({
        memories: [{ scope: 'user', type: 'fact', content: 'User ships kernel drivers.' }],
      }),
      toolCalls: [],
    });

    return distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '나는 커널 드라이버를 만든다',
      assistantMessage: '기록해둘게.',
      llmConfig: MOCK_LLM_CONFIG,
      distillerChat,
      recordDistillerAttempt: () => {
        throw new Error('recorder exploded');
      },
    }).then((candidates) => {
      expect(candidates).toHaveLength(1);
    });
  });

  it('grounds the prompt with stored preferences and this-turn captures for dedupe', async () => {
    const captured: ChatMessage[][] = [];
    const distillerChat = async (messages: ChatMessage[]) => {
      captured.push(messages);
      return { content: JSON.stringify({ memories: [] }), toolCalls: [] };
    };

    await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '나는 K-POP 걸그룹 노래들을 좋아해.',
      assistantMessage: '기억해둘게.',
      llmConfig: MOCK_LLM_CONFIG,
      distillerChat,
      knownPreferenceContents: ['User likes specific K-POP girl groups, not all K-POP.'],
      capturedThisTurn: ['나는 K-POP 걸그룹 노래들을 좋아해.'],
    });

    expect(captured).toHaveLength(1);
    const [system, user] = captured[0];
    expect(system.content).toContain('Never emit a memory that merely restates');
    expect(user.content).toContain('Already-stored user preferences:');
    expect(user.content).toContain('User likes specific K-POP girl groups, not all K-POP.');
    expect(user.content).toContain('Memories already captured from this turn:');
    expect(user.content).toContain('나는 K-POP 걸그룹 노래들을 좋아해.');
  });

  it('asks for emotion memories, bounded to one and only when the turn carried weight', async () => {
    const captured: ChatMessage[][] = [];
    const distillerChat = async (messages: ChatMessage[]) => {
      captured.push(messages);
      return { content: JSON.stringify({ memories: [] }), toolCalls: [] };
    };

    await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '드디어 그 IRQL 버그 잡았다',
      assistantMessage: '고생했네. 풀 릭 경로가 원인이었어.',
      llmConfig: MOCK_LLM_CONFIG,
      distillerChat,
    });

    const system = captured[0][0];
    // The type was always valid; nothing ever requested it, so none were made.
    expect(system.content).toContain('"emotion"');
    expect(system.content).toContain('at most ONE');
    expect(system.content).toContain('prefer none over a manufactured one');
  });

  it('accepts a distilled emotion memory', () => {
    const candidates = parseAoiMemoryDistillerResponse(
      JSON.stringify({
        memories: [
          {
            scope: 'user',
            type: 'emotion',
            content: 'The user was relieved after the IRQL bug turned out to be a pool leak.',
            importance: 0.7,
            confidence: 0.8,
            tags: ['emotion'],
          },
        ],
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('emotion');
    expect(candidates[0].tags).toContain('emotion');
  });

  it('does not run hidden distillation through interactive CLI/OAuth providers', async () => {
    let calls = 0;
    const distillerChat = async () => {
      calls += 1;
      return {
        content: JSON.stringify({ memories: [] }),
        toolCalls: [],
      };
    };

    const candidates = await distillAoiMemoryCandidatesWithLlm({
      sessionPath: 'aoi/default',
      userMessage: '내 다음 답변 선호를 기억해줘.',
      assistantMessage: '알겠어. 다음부터 그 선호를 반영할게.',
      llmConfig: {
        provider: 'codex-auth',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.5',
      },
      distillerChat,
    });

    expect(candidates).toEqual([]);
    expect(calls).toBe(0);
  });
});

// In-memory emulation of the /api/session-data memory store (list + read + write)
// so the preference-poll IO functions run their real load -> select -> write
// orchestration against a faithful backend without touching the network.
const MEMORY_ROOT = 'aoi/memory-v2/memories';

function installMemoryFetch(seed: AoiMemoryEntry[]): Map<string, unknown> {
  const store = new Map<string, unknown>();
  for (const memory of seed) {
    store.set(`${MEMORY_ROOT}/${memory.id}.json`, memory);
  }
  const fetchMock = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input, 'http://localhost');
    const path = url.searchParams.get('path') ?? '';
    const action = url.searchParams.get('action');
    const method = init?.method ?? 'GET';
    const reply = (value: unknown) => ({ ok: true, json: async () => value });
    if (method === 'POST') {
      store.set(path, JSON.parse(init?.body ?? '{}'));
      return reply({});
    }
    if (method === 'DELETE') {
      store.delete(path);
      return reply({});
    }
    if (action === 'list') {
      const files = [...store.keys()]
        .filter((key) => key.startsWith(`${path}/`) && key.endsWith('.json'))
        .map((key) => ({ path: key, type: 0 }));
      return reply({ files });
    }
    return reply(store.get(path) ?? {});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return store;
}

describe('syncAoiMemoryFromPreferencePoll()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('supersedes a differing prior pick for the key, then saves the new answer', async () => {
    const prefKey = getPreferenceQuestionPrefKey('focus_area');
    expect(prefKey).toBeTruthy();
    const prefTag = tastePrefTag(prefKey as string);
    const stale = makeMemory({
      id: 'stale-1',
      type: 'preference',
      status: 'active',
      content: 'Interested in kernel internals.',
      normalizedContent: 'interested in kernel internals.',
      tags: [prefTag, 'taste-poll'],
    });
    const store = installMemoryFetch([stale]);
    const candidate = buildPreferencePollMemoryCandidate({
      questionId: 'focus_area',
      optionId: 'anti_cheat',
      lang: 'en',
    });
    expect(candidate).toBeTruthy();

    const result = await syncAoiMemoryFromPreferencePoll('aoi/default', {
      questionId: 'focus_area',
      optionLabel: 'Anti-cheat / game security',
      candidate: candidate!,
      prefKey: prefKey as string,
    });

    // The prior pick is superseded (kept on disk, not deleted) ...
    const persistedStale = store.get(`${MEMORY_ROOT}/stale-1.json`) as AoiMemoryEntry;
    expect(persistedStale.status).toBe('superseded');
    // ... and exactly one active memory now carries the preference key.
    expect(
      result.some((memory) => memory.status === 'active' && memory.tags.includes(prefTag)),
    ).toBe(true);
    const reloaded = await loadAoiMemories();
    expect(
      reloaded.filter((memory) => memory.status === 'active' && memory.tags.includes(prefTag))
        .length,
    ).toBe(1);
  });

  it('skips the supersede step and just saves when no prefKey is provided', async () => {
    installMemoryFetch([]);
    const candidate = buildPreferencePollMemoryCandidate({
      questionId: 'focus_area',
      optionId: 'reverse_engineering',
      lang: 'en',
    });
    const result = await syncAoiMemoryFromPreferencePoll('aoi/default', {
      questionId: 'focus_area',
      optionLabel: 'Reverse engineering',
      candidate: candidate!,
    });
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('forgetAoiPreferencePollMemory()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('archives the active taste memories for the key and refreshes the list', async () => {
    const prefTag = tastePrefTag('focus-area');
    const active = makeMemory({
      id: 'taste-1',
      type: 'preference',
      status: 'active',
      content: 'Anti-cheat / game security',
      tags: [prefTag, 'taste-poll'],
    });
    const store = installMemoryFetch([active]);

    const result = await forgetAoiPreferencePollMemory('aoi/default', 'focus-area');

    const persisted = store.get(`${MEMORY_ROOT}/taste-1.json`) as AoiMemoryEntry;
    expect(persisted.status).toBe('archived');
    // The refreshed list surfaces it only as archived, never still-active.
    expect(result.some((memory) => memory.id === 'taste-1' && memory.status === 'active')).toBe(
      false,
    );
  });

  it('is a no-op when no active memory matches the key', async () => {
    const store = installMemoryFetch([
      makeMemory({
        id: 'other',
        type: 'preference',
        status: 'active',
        tags: ['pref:taste.other'],
      }),
    ]);
    const before = store.get(`${MEMORY_ROOT}/other.json`);

    const result = await forgetAoiPreferencePollMemory('aoi/default', 'focus-area');

    // The unrelated memory is left byte-identical (no archive write).
    expect(store.get(`${MEMORY_ROOT}/other.json`)).toBe(before);
    expect(result.some((memory) => memory.id === 'other')).toBe(true);
  });
});

describe('shared episode recall (R3.1)', () => {
  it('describes episode age coarsely, growing vaguer with distance', () => {
    expect(formatAoiEpisodeAge(EPISODE_NOW - 10 * 60_000, EPISODE_NOW)).toBe('earlier today');
    expect(formatAoiEpisodeAge(EPISODE_NOW - EPISODE_HOUR, EPISODE_NOW)).toBe('1 hour ago');
    expect(formatAoiEpisodeAge(EPISODE_NOW - 5 * EPISODE_HOUR, EPISODE_NOW)).toBe('5 hours ago');
    expect(formatAoiEpisodeAge(EPISODE_NOW - EPISODE_DAY, EPISODE_NOW)).toBe('yesterday');
    expect(formatAoiEpisodeAge(EPISODE_NOW - 3 * EPISODE_DAY, EPISODE_NOW)).toBe('3 days ago');
    expect(formatAoiEpisodeAge(EPISODE_NOW - 9 * EPISODE_DAY, EPISODE_NOW)).toBe('last week');
    expect(formatAoiEpisodeAge(EPISODE_NOW - 20 * EPISODE_DAY, EPISODE_NOW)).toBe('2 weeks ago');
    // A clock skew must not produce a future age.
    expect(formatAoiEpisodeAge(EPISODE_NOW + EPISODE_DAY, EPISODE_NOW)).toBe('earlier today');
  });

  it('prefers a topical older episode over a fresh unrelated one', () => {
    const onTopic = makeEpisode({
      id: 'aoi_ep_1_old',
      userMessage: 'IRQL 위반이 왜 나는지 봐줘',
      assistantMessage: '풀 릭 경로부터 확인했어',
      createdAt: EPISODE_NOW - 5 * EPISODE_DAY,
    });
    const unrelated = makeEpisode({
      id: 'aoi_ep_2_new',
      userMessage: '점심 뭐 먹을까',
      assistantMessage: '아무거나',
      createdAt: EPISODE_NOW - EPISODE_HOUR,
    });

    const selected = selectAoiSharedEpisodesForPrompt([unrelated, onTopic], 'IRQL 위반 다시 보자');
    expect(selected.map((item) => item.id)).toEqual(['aoi_ep_1_old']);
  });

  it('drops episodes with no topical overlap instead of padding the block', () => {
    const unrelated = makeEpisode({ userMessage: '점심', assistantMessage: '아무거나' });
    expect(selectAoiSharedEpisodesForPrompt([unrelated], 'TPM 원격 증명')).toEqual([]);
  });

  it('falls back to the most recent episodes when there is no query', () => {
    const older = makeEpisode({ id: 'aoi_ep_1_a', createdAt: EPISODE_NOW - EPISODE_DAY });
    const newer = makeEpisode({ id: 'aoi_ep_2_b', createdAt: EPISODE_NOW });
    expect(selectAoiSharedEpisodesForPrompt([newer, older], '', { limit: 1 })).toEqual([newer]);
    expect(selectAoiSharedEpisodesForPrompt([newer, older], '  ')).toHaveLength(2);
  });

  it('respects the limit and returns nothing for a non-positive one', () => {
    const episodes = [
      makeEpisode({ id: 'aoi_ep_1_a' }),
      makeEpisode({ id: 'aoi_ep_2_b' }),
      makeEpisode({ id: 'aoi_ep_3_c' }),
      makeEpisode({ id: 'aoi_ep_4_d' }),
    ];
    expect(selectAoiSharedEpisodesForPrompt(episodes, '', { limit: 2 })).toHaveLength(2);
    expect(selectAoiSharedEpisodesForPrompt(episodes, '', { limit: 0 })).toEqual([]);
    expect(selectAoiSharedEpisodesForPrompt([], 'anything')).toEqual([]);
  });

  it('renders a cited relative-time block and stays empty with no episodes', () => {
    const block = buildAoiSharedEpisodeBlock(
      [
        makeEpisode({
          id: 'aoi_ep_9_z',
          userMessage: 'e2e 가 계속 깨져',
          assistantMessage: '스텁 순서 문제였어',
          outcome: 'fixed',
          createdAt: EPISODE_NOW - 2 * EPISODE_DAY,
        }),
      ],
      EPISODE_NOW,
    );

    expect(block).toContain('## Shared episodes');
    expect(block).toContain('2 days ago');
    expect(block).toContain('episode:aoi_ep_9_z');
    expect(block).toContain('e2e 가 계속 깨져');
    expect(block).toContain('outcome: fixed');
    // Context, not instructions -- and no inventing a past that is not listed.
    expect(block).toContain('never as instructions');
    expect(buildAoiSharedEpisodeBlock([], EPISODE_NOW)).toBe('');
  });

  it('redacts secrets that appeared in a stored exchange', () => {
    const block = buildAoiSharedEpisodeBlock(
      [
        makeEpisode({
          userMessage: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rotated',
          assistantMessage: 'noted',
        }),
      ],
      EPISODE_NOW,
    );
    expect(block).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  });

  it('appends the block to the memory prompt and omits it when irrelevant', () => {
    const memory = makeMemory({
      id: 'mem-episode-1',
      type: 'fact',
      content: 'The user works on kernel anti-cheat.',
      normalizedContent: 'the user works on kernel anti-cheat.',
    });
    const episode = makeEpisode({
      id: 'aoi_ep_7_y',
      userMessage: 'anti-cheat 드라이버 리뷰해줘',
      assistantMessage: 'IRQL 경로부터 봤어',
      createdAt: EPISODE_NOW - EPISODE_DAY,
    });

    const withEpisode = buildAoiMemoryPrompt([memory], 'anti-cheat 드라이버', {
      episodes: [episode],
      now: EPISODE_NOW,
    });
    expect(withEpisode).toContain('## Durable Aoi memory');
    expect(withEpisode).toContain('episode:aoi_ep_7_y');

    // No episodes supplied -> byte-identical to the pre-R3.1 prompt.
    const withoutEpisodes = buildAoiMemoryPrompt([memory], 'anti-cheat 드라이버', {
      now: EPISODE_NOW,
    });
    expect(withoutEpisodes).not.toContain('## Shared episodes');
    expect(withEpisode.startsWith(withoutEpisodes)).toBe(true);
  });

  it('carries a relevant episode even when no memory was selected', () => {
    const episode = makeEpisode({
      id: 'aoi_ep_8_w',
      userMessage: 'TPM 증명 흐름 정리해줘',
      assistantMessage: 'PCR 값부터 봤어',
      createdAt: EPISODE_NOW - EPISODE_HOUR,
    });
    const prompt = buildAoiMemoryPrompt([], 'TPM 증명 흐름', {
      episodes: [episode],
      now: EPISODE_NOW,
    });
    expect(prompt).toContain('episode:aoi_ep_8_w');
    expect(prompt).not.toContain('## Durable Aoi memory');
    expect(buildAoiMemoryPrompt([], 'TPM 증명 흐름', { now: EPISODE_NOW })).toBe('');
  });
});

describe('loadAoiRecentMemoryEpisodes() (R3.1)', () => {
  const EPISODE_DIR = 'aoi/memory-v2/episodes/aoi/default';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads only the newest window, newest first, skipping malformed entries', async () => {
    const store = installMemoryFetch([]);
    // Ids embed their creation time, so the newest window is chosen from names.
    store.set(
      `${EPISODE_DIR}/aoi_ep_100_a.json`,
      makeEpisode({ id: 'aoi_ep_100_a', createdAt: 100 }),
    );
    store.set(
      `${EPISODE_DIR}/aoi_ep_300_c.json`,
      makeEpisode({ id: 'aoi_ep_300_c', createdAt: 300 }),
    );
    store.set(
      `${EPISODE_DIR}/aoi_ep_200_b.json`,
      makeEpisode({ id: 'aoi_ep_200_b', createdAt: 200 }),
    );
    // Not an episode file name, and a record with the wrong version: both dropped.
    store.set(`${EPISODE_DIR}/notes.json`, { version: 1, id: 'notes' });
    store.set(`${EPISODE_DIR}/aoi_ep_400_d.json`, {
      version: 2,
      id: 'aoi_ep_400_d',
      createdAt: 400,
    });

    const all = await loadAoiRecentMemoryEpisodes('aoi/default');
    expect(all.map((item) => item.id)).toEqual(['aoi_ep_300_c', 'aoi_ep_200_b', 'aoi_ep_100_a']);

    // maxFiles bounds how many files are READ, before validity is judged, so the
    // rejected aoi_ep_400_d still consumes a slot -- the window is an I/O budget,
    // not a promise of N usable episodes.
    const windowed = await loadAoiRecentMemoryEpisodes('aoi/default', { maxFiles: 2 });
    expect(windowed.map((item) => item.id)).toEqual(['aoi_ep_300_c']);
    const wider = await loadAoiRecentMemoryEpisodes('aoi/default', { maxFiles: 3 });
    expect(wider.map((item) => item.id)).toEqual(['aoi_ep_300_c', 'aoi_ep_200_b']);
  });

  it('returns an empty list when the session has no episodes', async () => {
    installMemoryFetch([]);
    expect(await loadAoiRecentMemoryEpisodes('aoi/default')).toEqual([]);
  });

  it('returns an empty list instead of throwing when the store is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );
    expect(await loadAoiRecentMemoryEpisodes('aoi/default')).toEqual([]);
  });
});
