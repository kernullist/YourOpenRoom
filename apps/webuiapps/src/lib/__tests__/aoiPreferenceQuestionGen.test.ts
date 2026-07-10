import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { LLMConfig } from '../llmModels';
import { buildPreferencePollMemoryCandidate } from '../aoiPreferencePoll';
import {
  AOI_GENERATED_QUESTIONS_VERSION,
  buildHeuristicGeneratedQuestions,
  buildQuestionGenGroundingText,
  deriveInterestLabelsFromMemories,
  expandAoiPreferenceQuestionBank,
  generatePreferenceQuestionsWithLlm,
  generatedQuestionToSeedShape,
  generatedQuestionsToSeedShape,
  hasUsableQuestionGenConfig,
  loadAoiGeneratedQuestionsState,
  mergeGeneratedQuestions,
  parseGeneratedQuestionsLlmResponse,
  saveAoiGeneratedQuestionsState,
  type AoiGeneratedQuestionsState,
  type GeneratedPreferenceQuestion,
  type QuestionGenChat,
} from '../aoiPreferenceQuestionGen';

const NOW = 1_700_000_000_000;
const STORAGE_KEY = 'aoi-preference-generated-v1';
const LLM_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
};

// A memory carrying interest entities (as answered interest polls / distilled
// chat would produce) -- the grounding source for generation.
function mem(over: Partial<AoiMemoryEntry> & { id: string; entities: string[] }): AoiMemoryEntry {
  return {
    version: 2,
    scope: 'user',
    type: 'preference',
    status: 'active',
    content: over.content ?? 'remembered interest',
    normalizedContent: (over.content ?? 'remembered interest').toLowerCase(),
    importance: 0.8,
    confidence: 0.86,
    hits: 1,
    createdAt: NOW,
    updatedAt: NOW,
    sourceEpisodeIds: [],
    tags: over.tags ?? ['preference'],
    ...over,
  };
}

function interestMemories(labels: string[]): AoiMemoryEntry[] {
  return labels.map((label, index) => mem({ id: `m${index}`, entities: [label] }));
}

function fakeChat(content: string): QuestionGenChat {
  return (async () => ({ content })) as unknown as QuestionGenChat;
}

describe('hasUsableQuestionGenConfig', () => {
  it('accepts a real chat config and rejects local/empty ones', () => {
    expect(hasUsableQuestionGenConfig(LLM_CONFIG)).toBe(true);
    expect(hasUsableQuestionGenConfig(null)).toBe(false);
    expect(hasUsableQuestionGenConfig({ ...LLM_CONFIG, model: '' })).toBe(false);
    expect(hasUsableQuestionGenConfig({ ...LLM_CONFIG, baseUrl: '' })).toBe(false);
    expect(hasUsableQuestionGenConfig({ ...LLM_CONFIG, provider: 'claude-cli' })).toBe(false);
    expect(hasUsableQuestionGenConfig({ ...LLM_CONFIG, provider: 'codex-cli' })).toBe(false);
    expect(hasUsableQuestionGenConfig({ ...LLM_CONFIG, provider: 'codex-auth' })).toBe(false);
  });
});

describe('deriveInterestLabelsFromMemories', () => {
  it('collects entity labels from active pref/fact memories, ranked by recurrence', () => {
    const labels = deriveInterestLabelsFromMemories([
      mem({ id: 'a', entities: ['Reversing'] }),
      mem({ id: 'b', entities: ['Reversing', 'Fuzzing'], type: 'fact' }),
    ]);
    expect(labels.map((l) => l.normalizedLabel)).toEqual(['reversing', 'fuzzing']);
    expect(labels[0].count).toBe(2);
    expect(labels[0].sourceMemoryIds.sort()).toEqual(['a', 'b']);
  });

  it('excludes inactive, non-pref/fact, private/identity, short, and date entities', () => {
    const labels = deriveInterestLabelsFromMemories([
      mem({ id: 'inactive', entities: ['Skipped'], status: 'archived' }),
      mem({ id: 'event', entities: ['EventTopic'], type: 'event' }),
      mem({ id: 'identity', entities: ['꿀보'], tags: ['identity'] }),
      mem({ id: 'prefonly', entities: ['StyleThing'], tags: ['preference', 'preference-only'] }),
      mem({ id: 'short', entities: ['ab'] }),
      mem({ id: 'date', entities: ['2026-01-01'] }),
      mem({ id: 'ok', entities: ['Cryptography'] }),
    ]);
    expect(labels.map((l) => l.normalizedLabel)).toEqual(['cryptography']);
  });
});

describe('buildHeuristicGeneratedQuestions', () => {
  it('creates one depth question per remembered interest, capped', () => {
    const questions = buildHeuristicGeneratedQuestions({
      memories: interestMemories(['Reversing', 'Fuzzing', 'Emulation', 'Symexec']),
      existing: null,
      lang: 'ko',
      now: NOW,
    });
    expect(questions).toHaveLength(3); // capped at MAX_HEURISTIC_PER_RUN
    const q = questions[0];
    expect(q.category).toBe('interest_depth');
    expect(q.source).toBe('heuristic');
    expect(q.options.map((o) => o.id)).toEqual(['deeper', 'maintain', 'light', 'pause']);
    // Only the "go deeper" option seeds an interest topic.
    expect(q.options.find((o) => o.id === 'deeper')?.entities.length).toBe(1);
    expect(q.options.find((o) => o.id === 'pause')?.entities).toEqual([]);
    expect(new Set(q.options.map((o) => o.key)).size).toBe(1);
    expect(q.options[0].key.startsWith('gen.interest-depth.')).toBe(true);
    expect(q.sourceRefs.some((ref) => ref.startsWith('memory:'))).toBe(true);
  });

  it('skips interests already covered by an existing generated question', () => {
    const existingQuestions = buildHeuristicGeneratedQuestions({
      memories: interestMemories(['Kernel']),
      existing: null,
      lang: 'ko',
      now: NOW,
    });
    const existing: AoiGeneratedQuestionsState = {
      version: AOI_GENERATED_QUESTIONS_VERSION,
      questions: existingQuestions,
      lastGeneratedAt: NOW,
    };
    const questions = buildHeuristicGeneratedQuestions({
      memories: interestMemories(['Kernel', 'Cryptography']),
      existing,
      lang: 'ko',
      now: NOW,
    });
    expect(questions.map((q) => q.sourceTopicLabel)).toEqual(['cryptography']);
  });

  it('localizes depth questions across ko/en/ja/zh', () => {
    const build = (lang: 'ko' | 'en' | 'ja' | 'zh') =>
      buildHeuristicGeneratedQuestions({
        memories: interestMemories(['TPM']),
        existing: null,
        lang,
        now: NOW,
      })[0];
    expect(build('ko').prompt).toContain('TPM');
    expect(build('ko').prompt).not.toBe(build('en').prompt);
    expect(build('en').options.find((o) => o.id === 'deeper')?.label).toBe('Go deeper');
    expect(build('ja').categoryLabel).toBe('関心の深掘り');
    expect(build('ja').options.find((o) => o.id === 'deeper')?.label).toBe('もっと深掘りしたい');
    expect(build('zh').categoryLabel).toBe('兴趣深化');
    expect(build('zh').options.find((o) => o.id === 'deeper')?.label).toBe('想更深入');
  });

  it('returns nothing without interest memories', () => {
    expect(
      buildHeuristicGeneratedQuestions({ memories: [], existing: null, lang: 'ko', now: NOW }),
    ).toEqual([]);
  });
});

describe('generatedQuestionToSeedShape routing', () => {
  it('adapts to the seed shape so the memory candidate builder routes per option', () => {
    const generated = buildHeuristicGeneratedQuestions({
      memories: interestMemories(['Anti-Cheat']),
      existing: null,
      lang: 'ko',
      now: NOW,
    })[0];
    const seedShape = generatedQuestionToSeedShape(generated);
    expect(seedShape.generated).toBe(true);
    expect(seedShape.prompts.en).toBe(seedShape.prompts.ko); // replicated

    const deeper = buildPreferencePollMemoryCandidate(
      { questionId: generated.id, optionId: 'deeper', lang: 'ko' },
      [seedShape],
    );
    expect(deeper?.tags).not.toContain('preference-only');
    expect(deeper?.entities).toEqual(['Anti-Cheat']);

    const pause = buildPreferencePollMemoryCandidate(
      { questionId: generated.id, optionId: 'pause', lang: 'ko' },
      [seedShape],
    );
    expect(pause?.tags).toContain('preference-only');
    expect(pause?.entities).toEqual([]);
  });
});

describe('parseGeneratedQuestionsLlmResponse', () => {
  it('parses a valid response into normalized questions', () => {
    const raw = JSON.stringify({
      questions: [
        {
          category: 'Dev Environment',
          categoryLabel: '개발 환경',
          prompt: '주로 어떤 OS에서 개발해?',
          options: [
            {
              label: 'Windows',
              statement: '주로 Windows에서 개발한다.',
              interestEntities: ['Windows dev'],
            },
            { label: 'Linux', statement: '주로 Linux에서 개발한다.' },
          ],
        },
      ],
    });
    const questions = parseGeneratedQuestionsLlmResponse(raw, { lang: 'ko', now: NOW });
    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.category).toBe('dev-environment');
    expect(q.categoryLabel).toBe('개발 환경');
    expect(q.source).toBe('llm');
    expect(q.options.map((o) => o.id)).toEqual(['o0', 'o1']);
    expect(q.options[0].entities).toEqual(['Windows dev']);
    expect(q.options[1].entities).toEqual([]);
    expect(new Set(q.options.map((o) => o.key)).size).toBe(1);
  });

  it('handles fenced JSON', () => {
    const raw =
      '```json\n{"questions":[{"category":"c","categoryLabel":"C","prompt":"P?","options":[{"label":"a","statement":"sa"},{"label":"b","statement":"sb"}]}]}\n```';
    expect(parseGeneratedQuestionsLlmResponse(raw, { lang: 'en', now: NOW })).toHaveLength(1);
  });

  it('rejects malformed, empty, under-optioned, and sensitive content', () => {
    expect(parseGeneratedQuestionsLlmResponse('not json', { lang: 'ko', now: NOW })).toEqual([]);
    expect(parseGeneratedQuestionsLlmResponse('{}', { lang: 'ko', now: NOW })).toEqual([]);
    expect(
      parseGeneratedQuestionsLlmResponse('{ not: valid json }', { lang: 'ko', now: NOW }),
    ).toEqual([]);
    const oneOption = JSON.stringify({
      questions: [
        {
          category: 'c',
          categoryLabel: 'C',
          prompt: 'P?',
          options: [{ label: 'a', statement: 's' }],
        },
      ],
    });
    expect(parseGeneratedQuestionsLlmResponse(oneOption, { lang: 'ko', now: NOW })).toEqual([]);
    const secret = JSON.stringify({
      questions: [
        {
          category: 'c',
          categoryLabel: 'C',
          prompt: 'P?',
          options: [
            { label: 'a', statement: 'my password: hunter2xyz is set' },
            { label: 'b', statement: 'ok' },
          ],
        },
      ],
    });
    expect(parseGeneratedQuestionsLlmResponse(secret, { lang: 'ko', now: NOW })).toEqual([]);
  });

  it('caps questions and options, dedupes labels, handles non-object items and slug fallback', () => {
    const many = JSON.stringify({
      questions: Array.from({ length: 8 }, (_, qi) => ({
        category: `c${qi}`,
        categoryLabel: `C${qi}`,
        prompt: `Prompt ${qi}?`,
        options: Array.from({ length: 8 }, (_, oi) => ({
          label: `l${qi}-${oi}`,
          statement: `s${qi}-${oi}`,
        })),
      })),
    });
    const capped = parseGeneratedQuestionsLlmResponse(many, { lang: 'en', now: NOW });
    expect(capped.length).toBeLessThanOrEqual(4);
    expect(capped[0].options.length).toBeLessThanOrEqual(5);

    const edge = JSON.stringify({
      questions: [
        'not an object',
        {
          category: '!!!',
          categoryLabel: 'Fallback',
          prompt: 'P1?',
          options: [
            'bad',
            { label: 'Same', statement: 's1', interestEntities: 'nope' },
            { label: 'same', statement: 's2' }, // duplicate label -> skipped
            { label: 'Other', statement: 's3' },
          ],
        },
        { category: 'c', categoryLabel: 'C', prompt: '', options: [] }, // empty prompt -> skipped
      ],
    });
    const parsed = parseGeneratedQuestionsLlmResponse(edge, { lang: 'en', now: NOW });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].category).toBe('x'); // '!!!' slugs empty -> 'x'
    expect(parsed[0].options.map((o) => o.label)).toEqual(['Same', 'Other']);
    expect(parsed[0].options[0].entities).toEqual([]); // non-array interestEntities
  });

  it('derives category/label when missing and clamps a long prompt', () => {
    const raw = JSON.stringify({
      questions: [
        {
          prompt: `Which approach? ${'x'.repeat(300)}`,
          options: [
            { label: 'a', statement: 'sa' },
            { label: 'b', statement: 'sb' },
          ],
        },
      ],
    });
    const [q] = parseGeneratedQuestionsLlmResponse(raw, { lang: 'en', now: NOW });
    expect(q.prompt.length).toBeLessThanOrEqual(160);
    expect(q.category.length).toBeGreaterThan(0);
    expect(q.categoryLabel.length).toBeGreaterThan(0);
  });

  it('drops an option whose statement is a redacted key block', () => {
    const raw = JSON.stringify({
      questions: [
        {
          category: 'c',
          categoryLabel: 'C',
          prompt: 'P?',
          options: [
            {
              label: 'a',
              statement: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
            },
            { label: 'b', statement: 'fine' },
          ],
        },
      ],
    });
    expect(parseGeneratedQuestionsLlmResponse(raw, { lang: 'en', now: NOW })).toEqual([]);
  });
});

describe('generatePreferenceQuestionsWithLlm', () => {
  const memories = interestMemories(['Reversing']);

  it('returns nothing without a usable config', async () => {
    const spy = vi.fn(async () => ({ content: '{"questions":[]}' }));
    const result = await generatePreferenceQuestionsWithLlm({
      memories,
      existingPrompts: [],
      lang: 'ko',
      llmConfig: null,
      now: NOW,
      chatFn: spy as unknown as QuestionGenChat,
    });
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips the chat call when grounding is empty', async () => {
    const spy = vi.fn(async () => ({ content: '{"questions":[]}' }));
    const result = await generatePreferenceQuestionsWithLlm({
      memories: [],
      existingPrompts: [],
      lang: 'ko',
      llmConfig: LLM_CONFIG,
      now: NOW,
      chatFn: spy as unknown as QuestionGenChat,
    });
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses questions from the injected chat', async () => {
    const raw = JSON.stringify({
      questions: [
        {
          category: 'c',
          categoryLabel: 'C',
          prompt: 'P?',
          options: [
            { label: 'a', statement: 'sa' },
            { label: 'b', statement: 'sb' },
          ],
        },
      ],
    });
    const result = await generatePreferenceQuestionsWithLlm({
      memories,
      existingPrompts: [],
      lang: 'ko',
      llmConfig: LLM_CONFIG,
      now: NOW,
      chatFn: fakeChat(raw),
    });
    expect(result).toHaveLength(1);
  });

  it('propagates a rejected chat promise (caller catches)', async () => {
    const rejectingChat = (async () => {
      throw new Error('boom');
    }) as unknown as QuestionGenChat;
    await expect(
      generatePreferenceQuestionsWithLlm({
        memories,
        existingPrompts: [],
        lang: 'ko',
        llmConfig: LLM_CONFIG,
        now: NOW,
        chatFn: rejectingChat,
      }),
    ).rejects.toThrow('boom');
  });
});

describe('buildQuestionGenGroundingText', () => {
  it('summarizes interest labels, non-private memories, and existing prompts', () => {
    const memories: AoiMemoryEntry[] = [
      mem({ id: 'm1', entities: ['Kernel'], content: 'Prefers full integrated code.' }),
      mem({
        id: 'm2',
        entities: [],
        content: 'downtime is gaming',
        tags: ['preference', 'preference-only'],
      }),
    ];
    const text = buildQuestionGenGroundingText({
      memories,
      existingPrompts: ['Existing question?'],
    });
    expect(text).toContain('Kernel');
    expect(text).toContain('Prefers full integrated code.');
    expect(text).not.toContain('downtime is gaming'); // preference-only excluded
    expect(text).toContain('Existing question?');
  });

  it('is empty when there is nothing known', () => {
    expect(buildQuestionGenGroundingText({ memories: [], existingPrompts: [] })).toBe('');
  });
});

describe('mergeGeneratedQuestions', () => {
  function gen(id: string, prompt: string, key: string): GeneratedPreferenceQuestion {
    return {
      version: 1,
      id,
      category: 'c',
      categoryLabel: 'C',
      lang: 'ko',
      prompt,
      options: [
        { id: 'o0', label: 'a', key, statement: 'sa', tags: [], entities: [] },
        { id: 'o1', label: 'b', key, statement: 'sb', tags: [], entities: [] },
      ],
      source: 'llm',
      sourceRefs: [],
      createdAt: NOW,
    };
  }

  it('dedupes by id, prompt, and pref key, prepending new ones', () => {
    const existing: AoiGeneratedQuestionsState = {
      version: 1,
      questions: [gen('a', 'First?', 'gen.c.1')],
      lastGeneratedAt: NOW - 1000,
    };
    const { state, addedCount } = mergeGeneratedQuestions(
      existing,
      [
        gen('a', 'Different?', 'gen.c.9'),
        gen('b', 'First?', 'gen.c.9'),
        gen('c', 'Third?', 'gen.c.1'),
        gen('d', 'Fourth?', 'gen.c.4'),
      ],
      { now: NOW },
    );
    expect(addedCount).toBe(1);
    expect(state.questions.map((q) => q.id)).toEqual(['d', 'a']);
    expect(state.lastGeneratedAt).toBe(NOW);
  });

  it('is a no-op when incoming is empty', () => {
    expect(mergeGeneratedQuestions(null, [], { now: NOW }).addedCount).toBe(0);
  });

  it('caps the store but always keeps answered questions', () => {
    const existing: AoiGeneratedQuestionsState = {
      version: 1,
      questions: [gen('keep', 'Keep?', 'gen.c.keep'), gen('old', 'Old?', 'gen.c.old')],
      lastGeneratedAt: NOW,
    };
    const incoming = Array.from({ length: 5 }, (_, i) => gen(`n${i}`, `New ${i}?`, `gen.c.n${i}`));
    const { state } = mergeGeneratedQuestions(existing, incoming, {
      now: NOW,
      max: 3,
      keepIds: ['keep'],
    });
    expect(state.questions).toHaveLength(3);
    expect(state.questions.map((q) => q.id)).toContain('keep');
  });
});

describe('expandAoiPreferenceQuestionBank', () => {
  const base = {
    memories: interestMemories(['Reversing']),
    existing: null,
    seedPrompts: [] as string[],
    lang: 'ko' as const,
    now: NOW,
  };

  it('produces heuristic questions with no LLM config', async () => {
    const { state, addedCount } = await expandAoiPreferenceQuestionBank({
      ...base,
      llmConfig: null,
    });
    expect(addedCount).toBeGreaterThan(0);
    expect(state.questions.every((q) => q.source === 'heuristic')).toBe(true);
  });

  it('adds LLM questions on top of heuristic when configured', async () => {
    const raw = JSON.stringify({
      questions: [
        {
          category: 'os',
          categoryLabel: 'OS',
          prompt: 'Which OS?',
          options: [
            { label: 'win', statement: 'w' },
            { label: 'lin', statement: 'l' },
          ],
        },
      ],
    });
    const { state } = await expandAoiPreferenceQuestionBank({
      ...base,
      llmConfig: LLM_CONFIG,
      chatFn: fakeChat(raw),
    });
    expect(state.questions.some((q) => q.source === 'heuristic')).toBe(true);
    expect(state.questions.some((q) => q.source === 'llm')).toBe(true);
  });

  it('degrades to heuristic-only when the LLM call throws', async () => {
    const throwingChat = (() => {
      throw new Error('network');
    }) as unknown as QuestionGenChat;
    const { state } = await expandAoiPreferenceQuestionBank({
      ...base,
      llmConfig: LLM_CONFIG,
      chatFn: throwingChat,
    });
    expect(state.questions.length).toBeGreaterThan(0);
    expect(state.questions.every((q) => q.source === 'heuristic')).toBe(true);
  });

  it('does not call chat when config is unusable, and threads answeredIds', async () => {
    const spy = vi.fn();
    const { state } = await expandAoiPreferenceQuestionBank({
      ...base,
      answeredIds: ['some-answered-id'],
      llmConfig: { ...LLM_CONFIG, provider: 'codex-cli' },
      chatFn: spy as unknown as QuestionGenChat,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(state.questions.length).toBeGreaterThan(0);
  });
});

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a valid store', () => {
    const generated = buildHeuristicGeneratedQuestions({
      memories: interestMemories(['Kernel']),
      existing: null,
      lang: 'ko',
      now: NOW,
    });
    const state: AoiGeneratedQuestionsState = {
      version: 1,
      questions: generated,
      lastGeneratedAt: NOW,
    };
    saveAoiGeneratedQuestionsState(state);
    expect(loadAoiGeneratedQuestionsState()).toEqual(state);
  });

  it('starts clean on empty / malformed / version-mismatched storage', () => {
    expect(loadAoiGeneratedQuestionsState().questions).toEqual([]);
    localStorage.setItem(STORAGE_KEY, '{broken');
    expect(loadAoiGeneratedQuestionsState().questions).toEqual([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, questions: [] }));
    expect(loadAoiGeneratedQuestionsState().questions).toEqual([]);
  });

  it('filters invalid questions and options and defaults a bad lastGeneratedAt', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: AOI_GENERATED_QUESTIONS_VERSION,
        lastGeneratedAt: 'soon',
        questions: [
          null,
          'x',
          { version: 1, id: 'bad', category: 'c', categoryLabel: 'C', prompt: '', options: [] },
          {
            version: 1,
            id: 'bad-option',
            category: 'c',
            categoryLabel: 'C',
            prompt: 'P?',
            options: [
              { id: 'o0', label: 'a', key: 'k', statement: 's', tags: 'nope', entities: [] },
              { id: 'o1', label: 'b', key: 'k', statement: 's', tags: [], entities: [] },
            ],
          },
          {
            version: 1,
            id: 'good',
            category: 'c',
            categoryLabel: 'C',
            prompt: 'P?',
            options: [
              { id: 'o0', label: 'a', key: 'k', statement: 's', tags: [], entities: [] },
              { id: 'o1', label: 'b', key: 'k', statement: 's', tags: [], entities: [] },
            ],
          },
        ],
      }),
    );
    const state = loadAoiGeneratedQuestionsState();
    expect(state.questions.map((q) => q.id)).toEqual(['good']);
    expect(state.lastGeneratedAt).toBe(0);
  });

  it('generatedQuestionsToSeedShape maps the whole store', () => {
    const generated = buildHeuristicGeneratedQuestions({
      memories: interestMemories(['Reversing']),
      existing: null,
      lang: 'ko',
      now: NOW,
    });
    const shapes = generatedQuestionsToSeedShape({
      version: 1,
      questions: generated,
      lastGeneratedAt: NOW,
    });
    expect(shapes).toHaveLength(generated.length);
    expect(shapes[0].generated).toBe(true);
  });
});
