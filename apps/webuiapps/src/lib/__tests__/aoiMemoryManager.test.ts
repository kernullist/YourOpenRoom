import { describe, expect, it } from 'vitest';
import {
  maliciousProcedureSourceFixture,
  updatedFactMemoryFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import {
  buildAoiKiraAutomationMemoryCandidates,
  buildAoiMemoryPrompt,
  distillAoiMemoryCandidatesWithLlm,
  extractHeuristicAoiMemoryCandidates,
  mergeAoiMemoryCandidates,
  normalizeAoiMemoryCandidate,
  parseAoiMemoryDistillerResponse,
  scoreAoiMemoryForQuery,
  selectAoiMemoriesForPrompt,
  type AoiMemoryEntry,
} from '../aoiMemoryManager';
import type { ChatMessage, ToolDef } from '../llmClient';
import type { LLMConfig } from '../llmModels';

const MOCK_LLM_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
};

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
    ...(partial.expiresAt ? { expiresAt: partial.expiresAt } : {}),
    ...(partial.permanent ? { permanent: partial.permanent } : {}),
    ...(partial.supersedes ? { supersedes: partial.supersedes } : {}),
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
