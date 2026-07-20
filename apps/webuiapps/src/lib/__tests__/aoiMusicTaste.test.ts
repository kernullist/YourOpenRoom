import { beforeEach, describe, expect, it } from 'vitest';
import {
  AOI_MUSIC_TASTE_STATE_VERSION,
  DEFAULT_AOI_MUSIC_TASTE_STATE,
  TASTE_POLL_COOLDOWN_MS,
  TASTE_POLL_MIN_IDLE_MS,
  TASTE_POLL_QUESTIONS,
  buildAoiMusicTastePromptBlock,
  deriveTasteProfile,
  loadAoiMusicTasteState,
  parseAoiMusicTasteChatIntent,
  pickNextTasteQuestion,
  recordTasteAnswer,
  recordTasteQuestionAsked,
  recordYouTubePlay,
  recordYouTubeSearch,
  sanitizeTasteSearchQuery,
  saveAoiMusicTasteState,
  shouldAskTasteQuestion,
  type AoiMusicTasteState,
  type AoiTasteLang,
  type ShouldAskTasteQuestionInput,
} from '../aoiMusicTaste';

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
