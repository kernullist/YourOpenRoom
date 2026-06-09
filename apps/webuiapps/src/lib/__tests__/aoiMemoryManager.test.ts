import { describe, expect, it } from 'vitest';
import {
  buildAoiMemoryPrompt,
  distillAoiMemoryCandidatesWithLlm,
  extractHeuristicAoiMemoryCandidates,
  mergeAoiMemoryCandidates,
  parseAoiMemoryDistillerResponse,
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
});
