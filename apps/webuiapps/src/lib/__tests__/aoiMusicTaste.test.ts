import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AOI_MUSIC_TASTE_STATE_VERSION,
  DEFAULT_AOI_MUSIC_TASTE_STATE,
  TASTE_POLL_COOLDOWN_MS,
  TASTE_POLL_MIN_IDLE_MS,
  TASTE_POLL_QUESTIONS,
  awaitPendingAoiMusicCloudWrites,
  buildAoiMusicTasteNeedPreferenceCopy,
  buildAoiMusicTastePromptBlock,
  deriveTasteProfile,
  hydrateAoiMusicStateFromCloud,
  loadAoiIdleMusicLearningState,
  loadAoiMusicTasteState,
  mergeAoiIdleMusicLearningStates,
  mergeAoiMusicTasteStates,
  parseAoiIdleMusicLearningState,
  parseAoiMusicPreferenceSeed,
  parseAoiMusicTasteChatIntent,
  pickNextTasteQuestion,
  planIdleMusicNudge,
  recordTasteAnswer,
  recordTasteQuestionAsked,
  recordYouTubePlay,
  recordYouTubeSearch,
  resolveTastePollAnswer,
  sanitizeTasteSearchQuery,
  saveAoiIdleMusicLearningState,
  saveAoiMusicTasteState,
  shouldAskTasteQuestion,
  type AoiMusicTasteState,
  type AoiTasteLang,
  type PlanIdleMusicNudgeInput,
  type ShouldAskTasteQuestionInput,
} from '../aoiMusicTaste';
import {
  DEFAULT_AOI_IDLE_MUSIC_STATE,
  DEFAULT_IDLE_MUSIC_MIN_IDLE_MS,
  type AoiIdleMusicLearningState,
} from '../aoiIdleMusicNudge';
import { loadPersistedConfig, savePersistedConfig } from '../configPersistence';

// updatePersistedConfig is the real read-modify-write helper; here it is driven
// by the same mocked load/save pair so these tests keep asserting on the config
// payload the music sync produces.
vi.mock('../configPersistence', () => {
  const loadPersistedConfig = vi.fn().mockResolvedValue(null);
  const savePersistedConfig = vi.fn().mockResolvedValue(undefined);
  return {
    loadPersistedConfig,
    savePersistedConfig,
    updatePersistedConfig: vi.fn(
      async (
        mutate: (current: Record<string, unknown>) => Record<string, unknown>,
        options?: { createIfMissing?: boolean },
      ) => {
        const current = (await loadPersistedConfig()) ?? (options?.createIfMissing ? {} : null);
        if (!current) {
          return false;
        }
        await savePersistedConfig(await mutate(current));
        return true;
      },
    ),
  };
});

const loadPersistedConfigMock = vi.mocked(loadPersistedConfig);
const savePersistedConfigMock = vi.mocked(savePersistedConfig);

const NOW = 1_700_000_000_000;
const LANGS: readonly AoiTasteLang[] = ['ko', 'ja', 'zh', 'en'];

function baseAskInput(
  overrides: Partial<ShouldAskTasteQuestionInput> = {},
): ShouldAskTasteQuestionInput {
  return {
    now: NOW,
    userIdleMs: TASTE_POLL_MIN_IDLE_MS,
    autonomyEnabled: true,
    quietMode: false,
    otherOfferPending: false,
    lastAskedAt: 0,
    hasUnansweredQuestion: true,
    ...overrides,
  };
}

describe('sanitizeTasteSearchQuery', () => {
  it('keeps a normal query and collapses whitespace', () => {
    expect(sanitizeTasteSearchQuery('  IVE   I AM  ')).toBe('IVE I AM');
  });

  it('rejects blank, URL, symbol-only, and oversized input', () => {
    expect(sanitizeTasteSearchQuery('   ')).toBeNull();
    expect(sanitizeTasteSearchQuery('https://youtube.com/watch?v=abc')).toBeNull();
    expect(sanitizeTasteSearchQuery('▶ ★★★')).toBeNull();
    expect(sanitizeTasteSearchQuery('a'.repeat(81))).toBeNull();
  });
});

describe('recordYouTubeSearch', () => {
  it('prepends newest-first with case-insensitive dedupe', () => {
    let state = recordYouTubeSearch(DEFAULT_AOI_MUSIC_TASTE_STATE, { query: 'Lofi Beats' });
    state = recordYouTubeSearch(state, { query: 'city pop mix' });
    state = recordYouTubeSearch(state, { query: 'lofi beats' });
    expect(state.recentSearches).toEqual(['lofi beats', 'city pop mix']);
  });

  it('caps the history at 12 entries', () => {
    let state: AoiMusicTasteState = DEFAULT_AOI_MUSIC_TASTE_STATE;
    for (let i = 0; i < 20; i += 1) {
      state = recordYouTubeSearch(state, { query: `query ${i}` });
    }
    expect(state.recentSearches).toHaveLength(12);
    expect(state.recentSearches[0]).toBe('query 19');
  });

  it('returns the same state for a junk query (no-op)', () => {
    const state = recordYouTubeSearch(DEFAULT_AOI_MUSIC_TASTE_STATE, { query: 'lofi' });
    expect(recordYouTubeSearch(state, { query: '▶' })).toBe(state);
    expect(recordYouTubeSearch(state, { query: 'https://x.test/a' })).toBe(state);
  });

  it('does not mutate the input state and normalizes a stale version', () => {
    const state = recordYouTubeSearch(DEFAULT_AOI_MUSIC_TASTE_STATE, { query: 'lofi' });
    recordYouTubeSearch(state, { query: 'second' });
    expect(state.recentSearches).toEqual(['lofi']);

    const stale = { version: 99, answers: { vibe: 'calm_lofi' }, recentSearches: ['old'] };
    const next = recordYouTubeSearch(stale as unknown as AoiMusicTasteState, { query: 'new' });
    expect(next.recentSearches).toEqual(['new']);
    expect(next.answers).toEqual({});
    expect(next.recentPlays).toEqual([]);
  });
});

describe('recordYouTubePlay', () => {
  it('stores title - channel labels and dedupes case-insensitively', () => {
    let state = recordYouTubePlay(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      title: 'I AM',
      channel: 'IVE',
    });
    state = recordYouTubePlay(state, { title: 'I AM', channel: 'ive' });
    // Newest casing wins; case-insensitive dedupe keeps a single entry.
    expect(state.recentPlays).toEqual(['I AM - ive']);
  });

  it('accepts an explicit query override', () => {
    const state = recordYouTubePlay(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      query: 'newjeans attention',
    });
    expect(state.recentPlays).toEqual(['newjeans attention']);
  });
});

describe('taste poll question bank', () => {
  it('localizes every prompt and option label in all four languages', () => {
    for (const question of TASTE_POLL_QUESTIONS) {
      for (const lang of LANGS) {
        expect(question.prompts[lang]?.trim().length).toBeGreaterThan(0);
      }
      const ids = new Set(question.options.map((option) => option.id));
      expect(ids.size).toBe(question.options.length);
      for (const option of question.options) {
        for (const lang of LANGS) {
          expect(option.labels[lang]?.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('pickNextTasteQuestion', () => {
  it('walks the bank in order and returns null when everything is answered', () => {
    let state: AoiMusicTasteState = DEFAULT_AOI_MUSIC_TASTE_STATE;
    expect(pickNextTasteQuestion(state)?.id).toBe('vibe');
    state = recordTasteAnswer(state, { questionId: 'vibe', optionId: 'calm_lofi' });
    expect(pickNextTasteQuestion(state)?.id).toBe('vocals');
    state = recordTasteAnswer(state, { questionId: 'vocals', optionId: 'vocals_ok' });
    state = recordTasteAnswer(state, { questionId: 'genre', optionId: 'jazz_lofi' });
    expect(pickNextTasteQuestion(state)).toBeNull();
  });
});

describe('shouldAskTasteQuestion', () => {
  it('asks when every gate passes', () => {
    expect(shouldAskTasteQuestion(baseAskInput())).toBe(true);
  });

  it('never asks when autonomy is off, quiet, or another card is pending', () => {
    expect(shouldAskTasteQuestion(baseAskInput({ autonomyEnabled: false }))).toBe(false);
    expect(shouldAskTasteQuestion(baseAskInput({ quietMode: true }))).toBe(false);
    expect(shouldAskTasteQuestion(baseAskInput({ otherOfferPending: true }))).toBe(false);
  });

  it('never asks when there is nothing left to ask', () => {
    expect(shouldAskTasteQuestion(baseAskInput({ hasUnansweredQuestion: false }))).toBe(false);
  });

  it('requires a known, long-enough idle time', () => {
    expect(shouldAskTasteQuestion(baseAskInput({ userIdleMs: undefined }))).toBe(false);
    expect(shouldAskTasteQuestion(baseAskInput({ userIdleMs: Number.NaN }))).toBe(false);
    expect(shouldAskTasteQuestion(baseAskInput({ userIdleMs: TASTE_POLL_MIN_IDLE_MS - 1 }))).toBe(
      false,
    );
  });

  it('respects the daily cooldown', () => {
    expect(
      shouldAskTasteQuestion(baseAskInput({ lastAskedAt: NOW - (TASTE_POLL_COOLDOWN_MS - 1) })),
    ).toBe(false);
    expect(
      shouldAskTasteQuestion(baseAskInput({ lastAskedAt: NOW - (TASTE_POLL_COOLDOWN_MS + 1) })),
    ).toBe(true);
  });

  it('honors a custom cooldown and idle threshold', () => {
    const input = baseAskInput({
      lastAskedAt: NOW - 10_000,
      cooldownMs: 5_000,
      userIdleMs: 8_000,
      minIdleMs: 5_000,
    });
    expect(shouldAskTasteQuestion(input)).toBe(true);
    expect(shouldAskTasteQuestion({ ...input, cooldownMs: 20_000 })).toBe(false);
    expect(shouldAskTasteQuestion({ ...input, minIdleMs: 10_000 })).toBe(false);
  });
});

describe('resolveTastePollAnswer', () => {
  const pending = {
    questionId: 'vibe',
    options: [
      { id: 'calm_lofi', label: '잔잔한 로파이·칠' },
      { id: 'energetic_pop', label: '신나는 팝·케이팝' },
    ],
  };

  it('records an answer whose question and option are still in the bank', () => {
    const resolution = resolveTastePollAnswer(pending, {
      messageText: '신나는 팝·케이팝',
      state: DEFAULT_AOI_MUSIC_TASTE_STATE,
    });
    expect(resolution.kind).toBe('recorded');
    if (resolution.kind !== 'recorded') return;
    expect(resolution.chosenLabel).toBe('신나는 팝·케이팝');
    expect(resolution.nextState.answers).toEqual({ vibe: 'energetic_pop' });
  });

  it('ignores a message that is not one of the chips', () => {
    expect(
      resolveTastePollAnswer(pending, {
        messageText: '아무 말',
        state: DEFAULT_AOI_MUSIC_TASTE_STATE,
      }).kind,
    ).toBe('ignored');
  });

  // A poll restored from localStorage carries only strings, validated for shape
  // and never against the bank. A deploy that renames a question or option id
  // leaves exactly this, and recordTasteAnswer drops the answer in silence --
  // which the caller used to follow with "I'll remember that".
  it('reports a question pruned from the bank as expired, not as remembered', () => {
    const stalePoll = {
      questionId: 'vibe_v1_removed',
      options: [{ id: 'calm_lofi', label: '잔잔한 로파이·칠' }],
    };
    const resolution = resolveTastePollAnswer(stalePoll, {
      messageText: '잔잔한 로파이·칠',
      state: DEFAULT_AOI_MUSIC_TASTE_STATE,
    });
    expect(resolution.kind).toBe('expired');
    if (resolution.kind !== 'expired') return;
    expect(resolution.chosenLabel).toBe('잔잔한 로파이·칠');
  });

  it('reports a pruned option the same way', () => {
    const resolution = resolveTastePollAnswer(
      { questionId: 'vibe', options: [{ id: 'renamed_option', label: '잔잔한 로파이·칠' }] },
      { messageText: '잔잔한 로파이·칠', state: DEFAULT_AOI_MUSIC_TASTE_STATE },
    );
    expect(resolution.kind).toBe('expired');
  });

  it('accepts re-answering the same question with the same option', () => {
    const answered = recordTasteAnswer(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      questionId: 'vibe',
      optionId: 'calm_lofi',
    });
    expect(
      resolveTastePollAnswer(pending, { messageText: '잔잔한 로파이·칠', state: answered }).kind,
    ).toBe('recorded');
  });
});

describe('recordTasteQuestionAsked / recordTasteAnswer', () => {
  it('stamps the cooldown without touching answers', () => {
    const next = recordTasteQuestionAsked(DEFAULT_AOI_MUSIC_TASTE_STATE, { now: NOW });
    expect(next.lastAskedAt).toBe(NOW);
    expect(next.answers).toEqual({});
    expect(DEFAULT_AOI_MUSIC_TASTE_STATE.lastAskedAt).toBe(0);
  });

  it('records a valid answer and ignores unknown ids', () => {
    const answered = recordTasteAnswer(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      questionId: 'vibe',
      optionId: 'energetic_pop',
    });
    expect(answered.answers).toEqual({ vibe: 'energetic_pop' });

    expect(
      recordTasteAnswer(answered, { questionId: 'nope', optionId: 'calm_lofi' }).answers,
    ).toEqual({ vibe: 'energetic_pop' });
    expect(recordTasteAnswer(answered, { questionId: 'vibe', optionId: 'nope' }).answers).toEqual({
      vibe: 'energetic_pop',
    });
  });
});

describe('deriveTasteProfile', () => {
  it('returns an empty profile for a fresh state', () => {
    const profile = deriveTasteProfile(DEFAULT_AOI_MUSIC_TASTE_STATE);
    expect(profile.moodBias).toEqual({});
    expect(profile.personalQueries).toEqual([]);
    expect(profile.hasTasteSignal).toBe(false);
  });

  it('orders user searches and plays before poll seeds', () => {
    let state = recordTasteAnswer(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      questionId: 'vibe',
      optionId: 'deep_focus',
    });
    state = recordTasteAnswer(state, { questionId: 'genre', optionId: 'game_ost' });
    state = recordYouTubeSearch(state, { query: 'IVE I AM' });
    state = recordYouTubePlay(state, { title: 'I AM', channel: 'IVE' });

    const profile = deriveTasteProfile(state);
    expect(profile.moodBias).toEqual({ focus: 2, ambient: 1 });
    expect(profile.personalQueries[0]).toBe('IVE I AM');
    expect(profile.personalQueries[1]).toBe('I AM - IVE');
    // Title / channel fragments expand searchability without leaving the lane.
    expect(profile.personalQueries).toContain('I AM');
    expect(profile.personalQueries).toContain('IVE');
    expect(profile.personalQueries).toContain('deep focus instrumental mix');
    expect(profile.personalQueries).toContain('game ost focus mix');
    expect(profile.hasTasteSignal).toBe(true);
  });

  it('dedupes a search that matches an answer seed case-insensitively', () => {
    let state = recordTasteAnswer(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      questionId: 'genre',
      optionId: 'jazz_lofi',
    });
    state = recordYouTubeSearch(state, { query: 'JAZZ LOFI CAFE MIX' });
    const profile = deriveTasteProfile(state);
    expect(profile.personalQueries).toEqual(['JAZZ LOFI CAFE MIX']);
  });
});

describe('buildAoiMusicTastePromptBlock', () => {
  it('warns when no taste is stored', () => {
    const block = buildAoiMusicTastePromptBlock(DEFAULT_AOI_MUSIC_TASTE_STATE);
    expect(block).toContain('No durable music taste is stored yet');
  });

  it('lists personal searches and plays for the model', () => {
    let state = recordYouTubeSearch(DEFAULT_AOI_MUSIC_TASTE_STATE, { query: 'aespa supernova' });
    state = recordYouTubePlay(state, { title: 'Supernova', channel: 'aespa' });
    const block = buildAoiMusicTastePromptBlock(state);
    expect(block).toContain('aespa supernova');
    expect(block).toContain('Supernova - aespa');
    expect(block).toContain('must follow for music recommendations');
  });
});

describe('parseAoiMusicPreferenceSeed + need-preference copy', () => {
  it('accepts common genre chips as personal seeds', () => {
    expect(parseAoiMusicPreferenceSeed('케이팝')).toBe('케이팝');
    expect(parseAoiMusicPreferenceSeed('lofi')).toMatch(/lofi/i);
    expect(parseAoiMusicPreferenceSeed('IVE I AM 틀어줘')).toBeNull();
  });

  it('asks for a lane instead of inventing a pool mix', () => {
    const copy = buildAoiMusicTasteNeedPreferenceCopy('ko');
    expect(copy.text).toMatch(/취향/);
    expect(copy.suggestedReplies.length).toBeGreaterThan(0);
    expect(copy.text.toLowerCase()).not.toContain('sunset');
  });
});

describe('parseAoiMusicTasteChatIntent', () => {
  it('detects bare recommend requests', () => {
    expect(parseAoiMusicTasteChatIntent('노래 추천해줘')).toEqual({
      kind: 'recommend',
      autoplay: false,
    });
    expect(parseAoiMusicTasteChatIntent('recommend a song')).toEqual({
      kind: 'recommend',
      autoplay: false,
    });
    expect(parseAoiMusicTasteChatIntent('뭐 듣지?')).toEqual({
      kind: 'recommend',
      autoplay: false,
    });
  });

  it('detects play-something requests', () => {
    expect(parseAoiMusicTasteChatIntent('아무거나 틀어줘')).toEqual({
      kind: 'recommend',
      autoplay: true,
    });
    expect(parseAoiMusicTasteChatIntent('음악 틀어줘')).toEqual({
      kind: 'recommend',
      autoplay: true,
    });
    expect(parseAoiMusicTasteChatIntent('play something')).toEqual({
      kind: 'recommend',
      autoplay: true,
    });
  });

  it('ignores specific-title playback so direct music intent can handle it', () => {
    expect(parseAoiMusicTasteChatIntent('IVE I AM 틀어줘')).toEqual({ kind: 'none' });
    expect(parseAoiMusicTasteChatIntent('play newjeans attention')).toEqual({ kind: 'none' });
  });
});

describe('storage round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a populated state including plays', () => {
    let state = recordTasteAnswer(DEFAULT_AOI_MUSIC_TASTE_STATE, {
      questionId: 'vibe',
      optionId: 'calm_lofi',
    });
    state = recordYouTubeSearch(state, { query: 'city pop mix' });
    state = recordYouTubePlay(state, { title: 'Midnight City', channel: 'M83' });
    state = recordTasteQuestionAsked(state, { now: NOW });
    saveAoiMusicTasteState(state);
    expect(loadAoiMusicTasteState()).toEqual(state);
  });

  it('starts clean on empty, malformed, or version-mismatched storage', () => {
    expect(loadAoiMusicTasteState()).toEqual(DEFAULT_AOI_MUSIC_TASTE_STATE);
    localStorage.setItem('aoi-music-taste-v1', '{broken');
    expect(loadAoiMusicTasteState()).toEqual(DEFAULT_AOI_MUSIC_TASTE_STATE);
    localStorage.setItem(
      'aoi-music-taste-v1',
      JSON.stringify({ version: 99, answers: {}, recentSearches: [], lastAskedAt: 5 }),
    );
    expect(loadAoiMusicTasteState()).toEqual(DEFAULT_AOI_MUSIC_TASTE_STATE);
  });

  it('loads legacy state without recentPlays and drops non-string answers', () => {
    localStorage.setItem(
      'aoi-music-taste-v1',
      JSON.stringify({
        version: AOI_MUSIC_TASTE_STATE_VERSION,
        answers: { vibe: 'calm_lofi', broken: 7 },
        recentSearches: ['lofi'],
      }),
    );
    const state = loadAoiMusicTasteState();
    expect(state.answers).toEqual({ vibe: 'calm_lofi' });
    expect(state.recentSearches).toEqual(['lofi']);
    expect(state.recentPlays).toEqual([]);
    expect(state.lastAskedAt).toBe(0);
  });
});

function makeIdleState(
  overrides: Partial<AoiIdleMusicLearningState> = {},
): AoiIdleMusicLearningState {
  return {
    ...DEFAULT_AOI_IDLE_MUSIC_STATE,
    moodFeedback: {},
    recentQueries: [],
    ...overrides,
  };
}

function makeTasteState(overrides: Partial<AoiMusicTasteState> = {}): AoiMusicTasteState {
  return {
    ...DEFAULT_AOI_MUSIC_TASTE_STATE,
    answers: {},
    recentSearches: [],
    recentPlays: [],
    ...overrides,
  };
}

describe('planIdleMusicNudge', () => {
  function baseInput(overrides: Partial<PlanIdleMusicNudgeInput> = {}): PlanIdleMusicNudgeInput {
    return {
      now: NOW,
      userIdleMs: DEFAULT_IDLE_MUSIC_MIN_IDLE_MS,
      autonomyEnabled: true,
      quietMode: false,
      musicActive: false,
      otherOfferPending: false,
      idleMusicLastOfferedAt: 0,
      hasTasteSignal: true,
      hasUnansweredTasteQuestion: true,
      tastePollLastAskedAt: 0,
      ...overrides,
    };
  }

  it('offers music when taste evidence exists', () => {
    expect(planIdleMusicNudge(baseInput())).toBe('offer-music');
  });

  it('diverts to a taste question instead of a pool pick when no taste exists', () => {
    expect(planIdleMusicNudge(baseInput({ hasTasteSignal: false }))).toBe('ask-taste-question');
  });

  it('stays quiet with no taste when the poll cooldown has not elapsed', () => {
    expect(
      planIdleMusicNudge(
        baseInput({
          hasTasteSignal: false,
          tastePollLastAskedAt: NOW - TASTE_POLL_COOLDOWN_MS + 60_000,
        }),
      ),
    ).toBe('skip');
  });

  it('stays quiet with no taste when the question bank is exhausted', () => {
    expect(
      planIdleMusicNudge(baseInput({ hasTasteSignal: false, hasUnansweredTasteQuestion: false })),
    ).toBe('skip');
  });

  it('skips when the music gates fail regardless of taste', () => {
    expect(planIdleMusicNudge(baseInput({ userIdleMs: 1_000 }))).toBe('skip');
    expect(planIdleMusicNudge(baseInput({ musicActive: true }))).toBe('skip');
    expect(planIdleMusicNudge(baseInput({ autonomyEnabled: false }))).toBe('skip');
    expect(planIdleMusicNudge(baseInput({ otherOfferPending: true }))).toBe('skip');
  });
});

describe('merge helpers', () => {
  it('unions taste states with the local side winning conflicts', () => {
    const local = makeTasteState({
      answers: { vibe: 'calm_lofi' },
      recentSearches: ['fromis_9', 'aespa lemonade'],
      recentPlays: ['Vitamin ME - fromis_9'],
      lastAskedAt: 200,
    });
    const cloud = makeTasteState({
      answers: { vibe: 'energetic_pop', vocals: 'korean_songs' },
      recentSearches: ['ive i am'],
      recentPlays: [],
      lastAskedAt: 500,
    });

    const merged = mergeAoiMusicTasteStates(local, cloud);

    expect(merged.answers).toEqual({ vibe: 'calm_lofi', vocals: 'korean_songs' });
    expect(merged.recentSearches).toEqual(['fromis_9', 'aespa lemonade', 'ive i am']);
    expect(merged.recentPlays).toEqual(['Vitamin ME - fromis_9']);
    expect(merged.lastAskedAt).toBe(500);
  });

  it('takes the max lastOfferedAt so the cooldown holds across browsers', () => {
    const local = makeIdleState({ lastOfferedAt: 100, moodFeedback: { focus: 2 } });
    const cloud = makeIdleState({
      lastOfferedAt: 900,
      moodFeedback: { focus: -1, chill: 1 },
      recentQueries: ['lofi hip hop radio beats to relax study to'],
    });

    const merged = mergeAoiIdleMusicLearningStates(local, cloud);

    expect(merged.lastOfferedAt).toBe(900);
    expect(merged.moodFeedback).toEqual({ focus: 2, chill: 1 });
    expect(merged.recentQueries).toEqual(['lofi hip hop radio beats to relax study to']);
  });
});

describe('parseAoiIdleMusicLearningState', () => {
  it('accepts a valid state and drops junk mood values', () => {
    const parsed = parseAoiIdleMusicLearningState({
      version: 1,
      moodFeedback: { focus: 2, chill: 'broken' },
      recentQueries: ['fromis_9'],
      lastOfferedAt: 42,
    });
    expect(parsed).toEqual({
      version: 1,
      moodFeedback: { focus: 2 },
      recentQueries: ['fromis_9'],
      lastOfferedAt: 42,
    });
  });

  it('rejects version mismatches and malformed shapes', () => {
    expect(parseAoiIdleMusicLearningState(null)).toBeNull();
    expect(
      parseAoiIdleMusicLearningState({ version: 2, moodFeedback: {}, recentQueries: [] }),
    ).toBeNull();
    expect(
      parseAoiIdleMusicLearningState({ version: 1, moodFeedback: {}, recentQueries: [7] }),
    ).toBeNull();
  });
});

describe('server-side persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    loadPersistedConfigMock.mockReset().mockResolvedValue(null);
    savePersistedConfigMock.mockReset().mockResolvedValue(undefined);
  });

  it('writes through to the server copy on save', async () => {
    loadPersistedConfigMock.mockResolvedValue({ llm: undefined });
    const state = recordYouTubeSearch(DEFAULT_AOI_MUSIC_TASTE_STATE, { query: 'fromis_9' });
    saveAoiMusicTasteState(state);
    await awaitPendingAoiMusicCloudWrites();

    expect(savePersistedConfigMock).toHaveBeenCalled();
    const written = savePersistedConfigMock.mock.calls.at(-1)?.[0];
    expect(written?.aoiMusicTaste?.taste).toMatchObject({ recentSearches: ['fromis_9'] });
    expect(written?.aoiMusicTaste?.idleLearning).toMatchObject({ version: 1 });
  });

  it('coalesces a burst of saves into serialized writes', async () => {
    loadPersistedConfigMock.mockResolvedValue({});
    saveAoiMusicTasteState(makeTasteState({ recentSearches: ['a'] }));
    saveAoiIdleMusicLearningState(makeIdleState({ lastOfferedAt: 1 }));
    saveAoiMusicTasteState(makeTasteState({ recentSearches: ['b'] }));
    await awaitPendingAoiMusicCloudWrites();

    // The queued flag collapses back-to-back saves; at least one write must
    // carry the final localStorage contents.
    const written = savePersistedConfigMock.mock.calls.at(-1)?.[0];
    expect(written?.aoiMusicTaste?.taste).toMatchObject({ recentSearches: ['b'] });
  });

  it('hydrates a fresh browser from the server copy', async () => {
    loadPersistedConfigMock.mockResolvedValue({
      aoiMusicTaste: {
        version: 1,
        updatedAt: NOW,
        taste: makeTasteState({
          recentSearches: ['fromis_9'],
          recentPlays: ['Vitamin ME - fromis_9'],
        }) as unknown as Record<string, unknown>,
        idleLearning: makeIdleState({ lastOfferedAt: 777 }) as unknown as Record<string, unknown>,
      },
    });

    const hydrated = await hydrateAoiMusicStateFromCloud();

    expect(hydrated?.taste.recentSearches).toEqual(['fromis_9']);
    expect(hydrated?.idleLearning.lastOfferedAt).toBe(777);
    // The merged state must land in localStorage for the next sync load.
    expect(loadAoiMusicTasteState().recentSearches).toEqual(['fromis_9']);
    expect(loadAoiIdleMusicLearningState().lastOfferedAt).toBe(777);
  });

  it('keeps local state and seeds the server when the cloud field is missing', async () => {
    loadPersistedConfigMock.mockResolvedValue({});
    saveAoiMusicTasteState(makeTasteState({ recentSearches: ['fromis_9'] }));
    await awaitPendingAoiMusicCloudWrites();
    savePersistedConfigMock.mockClear();

    const hydrated = await hydrateAoiMusicStateFromCloud();
    await awaitPendingAoiMusicCloudWrites();

    expect(hydrated?.taste.recentSearches).toEqual(['fromis_9']);
    expect(savePersistedConfigMock).toHaveBeenCalled();
  });

  it('returns null and keeps local state when the config API is unreachable', async () => {
    loadPersistedConfigMock.mockResolvedValue(null);
    saveAoiMusicTasteState(makeTasteState({ recentSearches: ['fromis_9'] }));
    await awaitPendingAoiMusicCloudWrites();

    expect(await hydrateAoiMusicStateFromCloud()).toBeNull();
    expect(loadAoiMusicTasteState().recentSearches).toEqual(['fromis_9']);
  });

  it('does not re-upload when the server copy already matches', async () => {
    const taste = makeTasteState({ recentSearches: ['fromis_9'] });
    const idle = makeIdleState({ lastOfferedAt: 5 });
    localStorage.setItem('aoi-music-taste-v1', JSON.stringify(taste));
    localStorage.setItem('aoi:idleMusicState:v1', JSON.stringify(idle));
    loadPersistedConfigMock.mockResolvedValue({
      aoiMusicTaste: {
        version: 1,
        updatedAt: NOW,
        taste: taste as unknown as Record<string, unknown>,
        idleLearning: idle as unknown as Record<string, unknown>,
      },
    });

    await hydrateAoiMusicStateFromCloud();
    await awaitPendingAoiMusicCloudWrites();

    expect(savePersistedConfigMock).not.toHaveBeenCalled();
  });
});
