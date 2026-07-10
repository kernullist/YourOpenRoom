import { beforeEach, describe, expect, it } from 'vitest';
import {
  AOI_PREFERENCE_POLL_STATE_VERSION,
  DEFAULT_AOI_PREFERENCE_POLL_STATE,
  PREFERENCE_ONLY_TAG,
  PREFERENCE_POLL_CATEGORIES,
  PREFERENCE_POLL_COOLDOWN_MS,
  PREFERENCE_POLL_MIN_IDLE_MS,
  PREFERENCE_POLL_QUESTIONS,
  buildPreferencePollMemoryCandidate,
  clearPreferenceAnswer,
  findPreferenceOption,
  findPreferenceQuestion,
  getPreferenceQuestionPrefKey,
  loadAoiPreferencePollState,
  pickNextPreferenceQuestion,
  recordPreferenceAnswer,
  recordPreferenceQuestionAsked,
  saveAoiPreferencePollState,
  selectStaleTasteMemoryIds,
  selectTasteMemoryIdsToForget,
  shouldAskPreferenceQuestion,
  tastePrefTag,
  type AoiPreferenceCategory,
  type AoiPreferenceLang,
  type AoiPreferencePollState,
  type ShouldAskPreferenceQuestionInput,
} from '../aoiPreferencePoll';
import { extractAoiInterestTopicsFromMemories } from '../aoiInterestProfile';
import type { AoiMemoryCandidate, AoiMemoryEntry } from '../aoiMemoryShared';

const NOW = 1_700_000_000_000;
const LANGS: readonly AoiPreferenceLang[] = ['ko', 'ja', 'zh', 'en'];
const CATEGORIES: readonly AoiPreferenceCategory[] = [
  'interest',
  'work_style',
  'collaboration',
  'personal',
];
const STORAGE_KEY = 'aoi-preference-poll-v1';
const SESSION_PATH = 'aoi/default';

// Minimal AoiMemoryEntry built from a poll candidate, for the interest-routing
// and supersede/forget selector tests.
function memoryFromCandidate(
  candidate: AoiMemoryCandidate,
  overrides: Partial<AoiMemoryEntry> = {},
): AoiMemoryEntry {
  return {
    version: 2,
    id: overrides.id ?? `mem-${Math.round((overrides.createdAt ?? NOW) % 1_000_000)}`,
    scope: candidate.scope ?? 'user',
    type: candidate.type,
    status: overrides.status ?? 'active',
    content: candidate.content,
    normalizedContent: overrides.normalizedContent ?? candidate.content.toLowerCase(),
    importance: candidate.importance ?? 0.8,
    confidence: candidate.confidence ?? 0.86,
    hits: 1,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    sourceEpisodeIds: ['ep-1'],
    sessionPath: overrides.sessionPath ?? SESSION_PATH,
    tags: candidate.tags ?? [],
    entities: candidate.entities ?? [],
    ...(candidate.permanent ? { permanent: true } : {}),
  };
}

function baseAskInput(
  overrides: Partial<ShouldAskPreferenceQuestionInput> = {},
): ShouldAskPreferenceQuestionInput {
  return {
    now: NOW,
    userIdleMs: PREFERENCE_POLL_MIN_IDLE_MS,
    autonomyEnabled: true,
    quietMode: false,
    otherOfferPending: false,
    lastAskedAt: 0,
    hasUnansweredQuestion: true,
    ...overrides,
  };
}

describe('preference poll question bank', () => {
  it('localizes every prompt and option label in all four languages', () => {
    for (const question of PREFERENCE_POLL_QUESTIONS) {
      for (const lang of LANGS) {
        expect(question.prompts[lang]?.trim().length).toBeGreaterThan(0);
      }
      const ids = new Set(question.options.map((option) => option.id));
      expect(ids.size).toBe(question.options.length);
      for (const option of question.options) {
        for (const lang of LANGS) {
          expect(option.labels[lang]?.trim().length).toBeGreaterThan(0);
          expect(option.learn.statement[lang]?.trim().length).toBeGreaterThan(0);
        }
        expect(option.learn.key.length).toBeGreaterThan(0);
      }
    }
  });

  it('uses unique question ids', () => {
    const ids = PREFERENCE_POLL_QUESTIONS.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findPreferenceOption', () => {
  it('resolves a known question/option and returns null otherwise', () => {
    expect(findPreferenceOption('focus_area', 'anti_cheat')?.id).toBe('anti_cheat');
    expect(findPreferenceOption('focus_area', 'nope')).toBeNull();
    expect(findPreferenceOption('nope', 'anti_cheat')).toBeNull();
  });
});

describe('pickNextPreferenceQuestion', () => {
  it('walks the bank in order and returns null when everything is answered', () => {
    let state: AoiPreferencePollState = DEFAULT_AOI_PREFERENCE_POLL_STATE;
    expect(pickNextPreferenceQuestion(state)?.id).toBe(PREFERENCE_POLL_QUESTIONS[0].id);
    for (const question of PREFERENCE_POLL_QUESTIONS) {
      state = recordPreferenceAnswer(state, {
        questionId: question.id,
        optionId: question.options[0].id,
      });
    }
    expect(pickNextPreferenceQuestion(state)).toBeNull();
  });

  it('treats null/undefined state as fresh', () => {
    expect(pickNextPreferenceQuestion(null)?.id).toBe(PREFERENCE_POLL_QUESTIONS[0].id);
    expect(pickNextPreferenceQuestion(undefined)?.id).toBe(PREFERENCE_POLL_QUESTIONS[0].id);
  });
});

describe('shouldAskPreferenceQuestion', () => {
  it('asks when every gate passes', () => {
    expect(shouldAskPreferenceQuestion(baseAskInput())).toBe(true);
  });

  it('never asks when autonomy is off, quiet, or another card is pending', () => {
    expect(shouldAskPreferenceQuestion(baseAskInput({ autonomyEnabled: false }))).toBe(false);
    expect(shouldAskPreferenceQuestion(baseAskInput({ quietMode: true }))).toBe(false);
    expect(shouldAskPreferenceQuestion(baseAskInput({ otherOfferPending: true }))).toBe(false);
  });

  it('never asks when there is nothing left to ask', () => {
    expect(shouldAskPreferenceQuestion(baseAskInput({ hasUnansweredQuestion: false }))).toBe(false);
  });

  it('requires a known, long-enough idle time', () => {
    expect(shouldAskPreferenceQuestion(baseAskInput({ userIdleMs: undefined }))).toBe(false);
    expect(shouldAskPreferenceQuestion(baseAskInput({ userIdleMs: Number.NaN }))).toBe(false);
    expect(
      shouldAskPreferenceQuestion(baseAskInput({ userIdleMs: PREFERENCE_POLL_MIN_IDLE_MS - 1 })),
    ).toBe(false);
  });

  it('respects the daily cooldown', () => {
    expect(
      shouldAskPreferenceQuestion(
        baseAskInput({ lastAskedAt: NOW - (PREFERENCE_POLL_COOLDOWN_MS - 1) }),
      ),
    ).toBe(false);
    expect(
      shouldAskPreferenceQuestion(
        baseAskInput({ lastAskedAt: NOW - (PREFERENCE_POLL_COOLDOWN_MS + 1) }),
      ),
    ).toBe(true);
  });

  it('honors a custom cooldown and idle threshold', () => {
    const input = baseAskInput({
      lastAskedAt: NOW - 10_000,
      cooldownMs: 5_000,
      userIdleMs: 8_000,
      minIdleMs: 5_000,
    });
    expect(shouldAskPreferenceQuestion(input)).toBe(true);
    expect(shouldAskPreferenceQuestion({ ...input, cooldownMs: 20_000 })).toBe(false);
    expect(shouldAskPreferenceQuestion({ ...input, minIdleMs: 10_000 })).toBe(false);
  });
});

describe('recordPreferenceQuestionAsked / recordPreferenceAnswer', () => {
  it('stamps the cooldown without touching answers', () => {
    const next = recordPreferenceQuestionAsked(DEFAULT_AOI_PREFERENCE_POLL_STATE, { now: NOW });
    expect(next.lastAskedAt).toBe(NOW);
    expect(next.answers).toEqual({});
    expect(DEFAULT_AOI_PREFERENCE_POLL_STATE.lastAskedAt).toBe(0);
  });

  it('records a valid answer and ignores unknown ids', () => {
    const answered = recordPreferenceAnswer(DEFAULT_AOI_PREFERENCE_POLL_STATE, {
      questionId: 'focus_area',
      optionId: 'kernel_internals',
    });
    expect(answered.answers).toEqual({ focus_area: 'kernel_internals' });

    expect(
      recordPreferenceAnswer(answered, { questionId: 'nope', optionId: 'kernel_internals' })
        .answers,
    ).toEqual({ focus_area: 'kernel_internals' });
    expect(
      recordPreferenceAnswer(answered, { questionId: 'focus_area', optionId: 'nope' }).answers,
    ).toEqual({ focus_area: 'kernel_internals' });
  });

  it('does not mutate the input and normalizes a stale version', () => {
    const answered = recordPreferenceAnswer(DEFAULT_AOI_PREFERENCE_POLL_STATE, {
      questionId: 'focus_area',
      optionId: 'anti_cheat',
    });
    recordPreferenceAnswer(answered, { questionId: 'code_form', optionId: 'full_integrated' });
    expect(answered.answers).toEqual({ focus_area: 'anti_cheat' });

    const stale = { version: 99, answers: { focus_area: 'kernel_internals' }, lastAskedAt: 5 };
    const next = recordPreferenceAnswer(stale as unknown as AoiPreferencePollState, {
      questionId: 'code_form',
      optionId: 'minimal_snippet',
    });
    expect(next.answers).toEqual({ code_form: 'minimal_snippet' });
  });
});

describe('buildPreferencePollMemoryCandidate', () => {
  it('returns null for unknown ids', () => {
    expect(
      buildPreferencePollMemoryCandidate({ questionId: 'nope', optionId: 'x', lang: 'ko' }),
    ).toBeNull();
    expect(
      buildPreferencePollMemoryCandidate({ questionId: 'focus_area', optionId: 'x', lang: 'ko' }),
    ).toBeNull();
  });

  it('builds a durable preference candidate for an interest option', () => {
    const candidate = buildPreferencePollMemoryCandidate({
      questionId: 'focus_area',
      optionId: 'anti_cheat',
      lang: 'ko',
    });
    expect(candidate).not.toBeNull();
    expect(candidate?.type).toBe('preference');
    expect(candidate?.scope).toBe('user');
    expect(candidate?.permanent).toBe(true);
    expect(candidate?.confidence).toBeGreaterThan(0.8);
    expect(candidate?.content).toContain('안티치트');
    // Interest-like tags let the interest profile surface a topic; the taste key
    // gives it a stable preference key for conflict resolution / supersede.
    expect(candidate?.tags).toEqual(expect.arrayContaining(['preference', 'anti-cheat']));
    expect(candidate?.tags).toContain('pref:taste.focus-area');
    // Interest options are NOT preference-only: they must reach the interest profile.
    expect(candidate?.tags).not.toContain(PREFERENCE_ONLY_TAG);
    expect(candidate?.entities).toEqual(expect.arrayContaining(['anti-cheat', 'game security']));
  });

  it('localizes the stored statement per language', () => {
    const en = buildPreferencePollMemoryCandidate({
      questionId: 'focus_area',
      optionId: 'kernel_internals',
      lang: 'en',
    });
    expect(en?.content).toContain('kernel');
    const ja = buildPreferencePollMemoryCandidate({
      questionId: 'focus_area',
      optionId: 'kernel_internals',
      lang: 'ja',
    });
    expect(ja?.content).toContain('カーネル');
  });

  it('marks non-interest options preference-only with no topic-seeding entities', () => {
    const candidate = buildPreferencePollMemoryCandidate({
      questionId: 'code_form',
      optionId: 'full_integrated',
      lang: 'ko',
    });
    expect(candidate?.tags).toContain('pref:taste.code-form');
    expect(candidate?.tags).toContain(PREFERENCE_ONLY_TAG);
    // No entities at all, so nothing can surface as an interest topic.
    expect(candidate?.entities).toEqual([]);
  });

  it('caps tags and entities and de-duplicates', () => {
    const candidate = buildPreferencePollMemoryCandidate({
      questionId: 'verification_rigor',
      optionId: 'always_full',
      lang: 'ko',
    });
    expect(candidate).not.toBeNull();
    expect(new Set(candidate?.tags).size).toBe(candidate?.tags?.length);
    expect(candidate?.tags?.length).toBeLessThanOrEqual(10);
    expect(candidate?.entities?.length).toBeLessThanOrEqual(10);
  });
});

describe('storage round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a populated state', () => {
    let state = recordPreferenceAnswer(DEFAULT_AOI_PREFERENCE_POLL_STATE, {
      questionId: 'focus_area',
      optionId: 'reverse_engineering',
    });
    state = recordPreferenceQuestionAsked(state, { now: NOW });
    saveAoiPreferencePollState(state);
    expect(loadAoiPreferencePollState()).toEqual(state);
  });

  it('starts clean on empty, malformed, or version-mismatched storage', () => {
    expect(loadAoiPreferencePollState()).toEqual(DEFAULT_AOI_PREFERENCE_POLL_STATE);
    localStorage.setItem(STORAGE_KEY, '{broken');
    expect(loadAoiPreferencePollState()).toEqual(DEFAULT_AOI_PREFERENCE_POLL_STATE);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99, answers: {}, lastAskedAt: 5 }));
    expect(loadAoiPreferencePollState()).toEqual(DEFAULT_AOI_PREFERENCE_POLL_STATE);
  });

  it('drops non-string answer values and defaults a missing lastAskedAt', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: AOI_PREFERENCE_POLL_STATE_VERSION,
        answers: { focus_area: 'anti_cheat', broken: 7 },
      }),
    );
    const state = loadAoiPreferencePollState();
    expect(state.answers).toEqual({ focus_area: 'anti_cheat' });
    expect(state.lastAskedAt).toBe(0);
  });
});

describe('categories and preference keys', () => {
  it('localizes every category label in all four languages', () => {
    expect(PREFERENCE_POLL_CATEGORIES.map((category) => category.id)).toEqual(CATEGORIES);
    for (const category of PREFERENCE_POLL_CATEGORIES) {
      for (const lang of LANGS) {
        expect(category.labels[lang]?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('assigns every question to a known category', () => {
    for (const question of PREFERENCE_POLL_QUESTIONS) {
      expect(CATEGORIES).toContain(question.category);
    }
  });

  it('shares one learn.key across all options of a question', () => {
    for (const question of PREFERENCE_POLL_QUESTIONS) {
      const keys = new Set(question.options.map((option) => option.learn.key));
      expect(keys.size).toBe(1);
      expect(getPreferenceQuestionPrefKey(question.id)).toBe(question.options[0].learn.key);
    }
  });

  it('has at least one interest question and several non-interest ones', () => {
    const interest = PREFERENCE_POLL_QUESTIONS.filter((q) => q.category === 'interest');
    expect(interest.length).toBeGreaterThanOrEqual(1);
    expect(PREFERENCE_POLL_QUESTIONS.length).toBeGreaterThan(interest.length);
  });

  it('returns null pref key for an unknown question', () => {
    expect(getPreferenceQuestionPrefKey('nope')).toBeNull();
    expect(findPreferenceQuestion('nope')).toBeNull();
  });
});

describe('clearPreferenceAnswer', () => {
  it('removes an existing answer and is a no-op otherwise', () => {
    const answered = recordPreferenceAnswer(DEFAULT_AOI_PREFERENCE_POLL_STATE, {
      questionId: 'downtime',
      optionId: 'gaming',
    });
    const cleared = clearPreferenceAnswer(answered, { questionId: 'downtime' });
    expect(cleared.answers).toEqual({});
    // No-op returns a normalized copy without throwing.
    expect(clearPreferenceAnswer(answered, { questionId: 'nope' }).answers).toEqual({
      downtime: 'gaming',
    });
    // Does not mutate the input.
    expect(answered.answers).toEqual({ downtime: 'gaming' });
  });
});

describe('interest routing (topic extraction)', () => {
  // The core guarantee: interest-category answers surface as technical interest
  // topics; every other category stays preference-only and yields no topic.
  for (const question of PREFERENCE_POLL_QUESTIONS) {
    const expectTopics = question.category === 'interest';
    it(`${question.id} (${question.category}) ${expectTopics ? 'creates' : 'creates no'} topics`, () => {
      for (const lang of LANGS) {
        const memories = question.options.map((option, index) => {
          const candidate = buildPreferencePollMemoryCandidate({
            questionId: question.id,
            optionId: option.id,
            lang,
          });
          expect(candidate).not.toBeNull();
          return memoryFromCandidate(candidate as AoiMemoryCandidate, {
            id: `${question.id}-${option.id}-${lang}`,
            createdAt: NOW + index,
            updatedAt: NOW + index,
          });
        });
        const topics = extractAoiInterestTopicsFromMemories({
          sessionPath: SESSION_PATH,
          memories,
          now: NOW,
        });
        if (expectTopics) {
          expect(topics.length).toBeGreaterThan(0);
        } else {
          expect(topics).toEqual([]);
        }
      }
    });
  }
});

describe('taste memory supersede / forget selection', () => {
  const prefTag = tastePrefTag('focus-area');
  const otherTag = tastePrefTag('code-form');

  function tasteMemory(
    over: Partial<AoiMemoryEntry> & { id: string; tags: string[] },
  ): AoiMemoryEntry {
    return {
      version: 2,
      scope: 'user',
      type: 'preference',
      status: 'active',
      content: over.content ?? 'x',
      normalizedContent: over.normalizedContent ?? 'x',
      importance: 0.8,
      confidence: 0.86,
      hits: 1,
      createdAt: NOW,
      updatedAt: NOW,
      sourceEpisodeIds: ['ep'],
      sessionPath: SESSION_PATH,
      entities: [],
      ...over,
    };
  }

  it('selects only active, same-tag, different-content, session-matching memories to supersede', () => {
    const memories: AoiMemoryEntry[] = [
      tasteMemory({ id: 'old', tags: [prefTag], normalizedContent: 'kernel' }),
      tasteMemory({ id: 'same', tags: [prefTag], normalizedContent: 'anti-cheat' }),
      tasteMemory({
        id: 'archived',
        tags: [prefTag],
        normalizedContent: 'tpm',
        status: 'archived',
      }),
      tasteMemory({ id: 'othertag', tags: [otherTag], normalizedContent: 'kernel' }),
      tasteMemory({
        id: 'othersession',
        tags: [prefTag],
        normalizedContent: 'kernel',
        sessionPath: 'other/session',
      }),
    ];
    const ids = selectStaleTasteMemoryIds(memories, {
      prefTag,
      newNormalizedContent: 'anti-cheat',
      sessionPath: SESSION_PATH,
    });
    expect(ids).toEqual(['old']);
  });

  it('matches memories without a session path regardless of caller session', () => {
    const memories: AoiMemoryEntry[] = [
      tasteMemory({
        id: 'nosession',
        tags: [prefTag],
        normalizedContent: 'kernel',
        sessionPath: undefined,
      }),
    ];
    expect(
      selectStaleTasteMemoryIds(memories, {
        prefTag,
        newNormalizedContent: 'anti-cheat',
        sessionPath: SESSION_PATH,
      }),
    ).toEqual(['nosession']);
  });

  it('selects all active same-tag session-matching memories to forget', () => {
    const memories: AoiMemoryEntry[] = [
      tasteMemory({ id: 'a', tags: [prefTag], normalizedContent: 'kernel' }),
      tasteMemory({ id: 'b', tags: [prefTag], normalizedContent: 'anti-cheat' }),
      tasteMemory({ id: 'archived', tags: [prefTag], status: 'archived' }),
      tasteMemory({ id: 'othertag', tags: [otherTag] }),
    ];
    expect(selectTasteMemoryIdsToForget(memories, { prefTag, sessionPath: SESSION_PATH })).toEqual([
      'a',
      'b',
    ]);
  });
});
