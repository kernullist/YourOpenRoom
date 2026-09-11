import { describe, expect, it } from 'vitest';
import type { AoiMusicTasteState } from '../aoiMusicTaste';
import type { AoiTurnUnderstanding } from '../aoiTurnUnderstanding';
import {
  buildAoiPreferredMusicAck,
  decideAoiDirectMusicPlayback,
  expandArtistAliases,
  findKnownArtistIn,
  playLabelToQuery,
  playMatchesArtist,
  resolveAoiPreferredMusicPlay,
} from '../aoiMusicPreference';

const AESPA_PLAY = "aespa エスパ 'KISS N TELL' MV - SMTOWN and aespa";
const FROMIS_PLAY = "fromis_9 (프로미스나인) 'Vitamin ME' MV";
const PLAYLIST_PLAY = '2026년 8월 여돌 노래모음 | KPOP PLAYLIST - 달플리';

function state(recentPlays: string[]): AoiMusicTasteState {
  return { version: 1, answers: {}, recentSearches: [], recentPlays, lastAskedAt: 0 };
}

function reading(over: Partial<AoiTurnUnderstanding> = {}): AoiTurnUnderstanding {
  return {
    kind: 'action_request',
    families: ['app'],
    refersToTurn: null,
    referent: null,
    confidence: 'high',
    needsClarification: null,
    clarificationOptions: [],
    source: 'classifier',
    musicTarget: null,
    musicReference: 'none',
    ...over,
  };
}

describe('artist aliases', () => {
  it('expands a name to every spelling in its group, in any spelling', () => {
    expect(expandArtistAliases('에스파')).toEqual(
      expect.arrayContaining(['에스파', 'aespa', 'エスパ']),
    );
    expect(expandArtistAliases('AESPA')).toEqual(expect.arrayContaining(['에스파', 'エスパ']));
    expect(expandArtistAliases('fromis 9')).toEqual(
      expect.arrayContaining(['프로미스나인', 'fromis_9']),
    );
    expect(expandArtistAliases('Unknown Band')).toEqual(['Unknown Band']);
    expect(expandArtistAliases('   ')).toEqual([]);
  });

  it('matches plays by artist across scripts and never on a substring of a Latin word', () => {
    expect(playMatchesArtist(AESPA_PLAY, '에스파')).toBe(true);
    expect(playMatchesArtist(AESPA_PLAY, 'aespa')).toBe(true);
    expect(playMatchesArtist(FROMIS_PLAY, '프로미스 나인')).toBe(true);
    expect(playMatchesArtist(FROMIS_PLAY, '에스파')).toBe(false);
    // "ive" must not match "LOVE DIVE" or "live"; it matches the act as a token.
    expect(playMatchesArtist("aespa 'LOVE DIVE cover' live", '아이브')).toBe(false);
    expect(playMatchesArtist("IVE 'LOVE DIVE' MV", '아이브')).toBe(true);
    expect(playMatchesArtist(PLAYLIST_PLAY, '에스파')).toBe(false);
    expect(playMatchesArtist('Some Unknown Band - Live', 'Unknown Band')).toBe(true);
  });

  it('turns a play label into the searchable title', () => {
    expect(playLabelToQuery(AESPA_PLAY)).toBe("aespa エスパ 'KISS N TELL' MV");
    expect(playLabelToQuery(FROMIS_PLAY)).toBe(FROMIS_PLAY);
    expect(playLabelToQuery('  title only  ')).toBe('title only');
    // The channel is appended last; a title may carry a separator of its own.
    expect(playLabelToQuery('IVE 아이브 - LOVE DIVE MV - 1theK')).toBe('IVE 아이브 - LOVE DIVE MV');
  });

  it('finds the known act inside a longer target, at token starts only', () => {
    expect(findKnownArtistIn('에스파 내가 좋아하는 노래')).toBe('에스파');
    expect(findKnownArtistIn('에스파의 발라드')).toBe('에스파');
    expect(findKnownArtistIn('my favorite aespa song')).toBe('aespa');
    expect(findKnownArtistIn('the one by fromis_9 I like')).toBe('fromis_9');
    // "ive" inside "dive" / "live" and a name buried inside another word do not count.
    expect(findKnownArtistIn('love dive live')).toBeNull();
    expect(findKnownArtistIn('메에스파')).toBeNull();
    expect(findKnownArtistIn('내가 좋아하는 노래')).toBeNull();
    expect(findKnownArtistIn('')).toBeNull();
  });
});

describe('resolveAoiPreferredMusicPlay', () => {
  const taste = state([PLAYLIST_PLAY, AESPA_PLAY, FROMIS_PLAY]);

  it('returns the newest remembered play by the named artist', () => {
    expect(resolveAoiPreferredMusicPlay(taste, '에스파')).toEqual({
      kind: 'remembered_play',
      query: "aespa エスパ 'KISS N TELL' MV",
      play: AESPA_PLAY,
      target: '에스파',
    });
    expect(resolveAoiPreferredMusicPlay(taste, 'fromis_9')).toMatchObject({
      kind: 'remembered_play',
      play: FROMIS_PLAY,
    });
  });

  it('falls back to the artist as the search when nothing by them is remembered', () => {
    expect(resolveAoiPreferredMusicPlay(taste, '뉴진스')).toEqual({
      kind: 'artist_fallback',
      query: '뉴진스',
      target: '뉴진스',
    });
  });

  it('keys on the act inside a longer target, and searches the act alone when it has no play', () => {
    expect(resolveAoiPreferredMusicPlay(taste, '에스파 내가 좋아하는 노래')).toEqual({
      kind: 'remembered_play',
      query: "aespa エスパ 'KISS N TELL' MV",
      play: AESPA_PLAY,
      target: '에스파',
    });
    expect(resolveAoiPreferredMusicPlay(taste, '뉴진스 내가 좋아하는 노래')).toEqual({
      kind: 'artist_fallback',
      query: '뉴진스',
      target: '뉴진스',
    });
    // No known act in it: the words themselves are the search.
    expect(resolveAoiPreferredMusicPlay(taste, '어떤밴드 노래')).toEqual({
      kind: 'artist_fallback',
      query: '어떤밴드 노래',
      target: '어떤밴드 노래',
    });
  });

  it('skips a remembered label that is only the present request echoed back', () => {
    // The literal search this request ran last time was recorded as a play when
    // its result autoplayed; it names no song and must not be replayed as one.
    const echoed = state(['에스파 내가 좋아하는', '에스파', AESPA_PLAY]);
    expect(
      resolveAoiPreferredMusicPlay(echoed, '에스파', { requestQuery: '에스파 내가 좋아하는' }),
    ).toMatchObject({ kind: 'remembered_play', play: AESPA_PLAY });
    expect(
      resolveAoiPreferredMusicPlay(state(['에스파 내가 좋아하는']), '에스파', {
        requestQuery: '에스파 내가 좋아하는',
      }),
    ).toEqual({ kind: 'artist_fallback', query: '에스파', target: '에스파' });
    // Without a request to compare against, every label counts.
    expect(resolveAoiPreferredMusicPlay(echoed, '에스파')).toMatchObject({
      play: '에스파 내가 좋아하는',
    });
  });

  it('takes the newest play of all without an artist, and reports no memory when empty', () => {
    expect(resolveAoiPreferredMusicPlay(taste, null)).toMatchObject({
      kind: 'remembered_play',
      play: PLAYLIST_PLAY,
      target: null,
    });
    expect(resolveAoiPreferredMusicPlay(taste, '  ')).toMatchObject({ kind: 'remembered_play' });
    expect(resolveAoiPreferredMusicPlay(state([]), null)).toEqual({ kind: 'no_memory' });
    expect(resolveAoiPreferredMusicPlay(null, null)).toEqual({ kind: 'no_memory' });
    expect(resolveAoiPreferredMusicPlay(state([]), '에스파')).toEqual({
      kind: 'artist_fallback',
      query: '에스파',
      target: '에스파',
    });
  });
});

describe('decideAoiDirectMusicPlayback', () => {
  const typed = { query: '에스파 내가 좋아하는', exclude: ['달플리'] };
  const taste = state([AESPA_PLAY]);

  it('keeps the literal query when there is no reading (classifier off or failed)', () => {
    expect(decideAoiDirectMusicPlayback({ typed, understanding: null, tasteState: taste })).toEqual(
      {
        kind: 'play_literal',
        intent: typed,
      },
    );
  });

  it('plays the remembered track for a taste reference, carrying exclusions', () => {
    // The echoed literal search from last time sits newest in the memory and
    // is passed over for the real play.
    const decision = decideAoiDirectMusicPlayback({
      typed,
      understanding: reading({ musicReference: 'taste', musicTarget: '에스파' }),
      tasteState: state(['에스파 내가 좋아하는', AESPA_PLAY]),
    });
    expect(decision).toEqual({
      kind: 'play_remembered',
      intent: { query: "aespa エスパ 'KISS N TELL' MV", exclude: ['달플리'] },
      play: AESPA_PLAY,
      target: '에스파',
    });
  });

  it('falls back to the artist, or to a taste recommendation when nothing is remembered', () => {
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '뉴진스 내가 좋아하는' },
        understanding: reading({ musicReference: 'taste', musicTarget: '뉴진스' }),
        tasteState: taste,
      }),
    ).toEqual({ kind: 'play_artist_fallback', intent: { query: '뉴진스' }, target: '뉴진스' });
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '내가 좋아하는' },
        understanding: reading({ musicReference: 'taste', musicTarget: null }),
        tasteState: state([]),
      }),
    ).toEqual({ kind: 'taste_recommend' });
  });

  it('keeps the parser query for a literal request whatever the classifier isolated', () => {
    // Measured: the target dropped the artist on half the literal cases, and a
    // bare title is how an unrelated upload with that title gets played.
    for (const musicTarget of [
      'KISS N TELL',
      '에스파 KISS N TELL',
      '에스파 KISS N TELL 틀어줘',
      null,
    ]) {
      expect(
        decideAoiDirectMusicPlayback({
          typed: { query: '에스파 KISS N TELL', exclude: ['달플리'] },
          understanding: reading({ musicReference: 'none', musicTarget }),
          tasteState: taste,
        }),
      ).toEqual({
        kind: 'play_literal',
        intent: { query: '에스파 KISS N TELL', exclude: ['달플리'] },
      });
    }
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '뉴진스 supernatural' },
        understanding: reading({ musicReference: null, musicTarget: null }),
        tasteState: taste,
      }),
    ).toEqual({ kind: 'play_literal', intent: { query: '뉴진스 supernatural' } });
  });

  it('reads a taste target that merely echoes the whole request as no artist', () => {
    // "내가 좋아하는 곡" copied back isolates nothing: newest remembered play of
    // all, or the taste recommender when nothing is remembered.
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '내가 좋아하는 곡' },
        understanding: reading({ musicReference: 'taste', musicTarget: '내가 좋아하는 곡' }),
        tasteState: taste,
      }),
    ).toMatchObject({ kind: 'play_remembered', play: AESPA_PLAY, target: null });
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: 'the one I always listen to' },
        understanding: reading({
          musicReference: 'taste',
          musicTarget: 'The one I always listen to',
        }),
        tasteState: state([]),
      }),
    ).toEqual({ kind: 'taste_recommend' });
    // A longer target with the act inside it still keys on the act.
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '에스파 내가 좋아하는' },
        understanding: reading({
          musicReference: 'taste',
          musicTarget: '에스파 내가 좋아하는 노래',
        }),
        tasteState: taste,
      }),
    ).toMatchObject({ kind: 'play_remembered', play: AESPA_PLAY, target: '에스파' });
  });

  it('hands a confident non-playback reading to the model instead of playing a misread', () => {
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '어제 밤에 틀어놓고 잔 게 뭐였지' },
        understanding: reading({ kind: 'question', families: ['none'] }),
        tasteState: taste,
      }),
    ).toEqual({ kind: 'defer_to_model', reason: 'question/high/none' });
    // A confident request for another family is not a playback request either.
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: '발표 자료는 어제 만든 버전' },
        understanding: reading({ kind: 'action_request', families: ['file'] }),
        tasteState: taste,
      }),
    ).toEqual({ kind: 'defer_to_model', reason: 'action_request/high/file' });
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: 'x' },
        understanding: reading({ kind: 'action_request', families: ['none'] }),
        tasteState: taste,
      }).kind,
    ).toBe('play_literal');
    // Not when it is only medium, not when the model still names app, not for taste.
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: 'x' },
        understanding: reading({ kind: 'question', families: ['none'], confidence: 'medium' }),
        tasteState: taste,
      }).kind,
    ).toBe('play_literal');
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: 'x' },
        understanding: reading({ kind: 'chitchat', families: ['app'] }),
        tasteState: taste,
      }).kind,
    ).toBe('play_literal');
    expect(
      decideAoiDirectMusicPlayback({
        typed: { query: 'x' },
        understanding: reading({ kind: 'question', families: ['none'], musicReference: 'taste' }),
        tasteState: taste,
      }).kind,
    ).toBe('play_remembered');
  });
});

describe('buildAoiPreferredMusicAck', () => {
  const remembered = {
    kind: 'play_remembered' as const,
    intent: { query: "aespa エスパ 'KISS N TELL' MV" },
    play: AESPA_PLAY,
    target: '에스파',
  };
  const fallback = {
    kind: 'play_artist_fallback' as const,
    intent: { query: '뉴진스' },
    target: '뉴진스',
  };

  it('names the memory it used, in the user language', () => {
    expect(
      buildAoiPreferredMusicAck({ lang: 'ko', decision: remembered, startedTitle: 'KISS N TELL' }),
    ).toBe('전에 네가 들었던 에스파 곡으로 "KISS N TELL" 틀었어. 다른 곡이 좋았으면 말해줘.');
    expect(
      buildAoiPreferredMusicAck({
        lang: 'ko',
        decision: { ...remembered, target: null },
        startedTitle: null,
      }),
    ).toContain(`"aespa エスパ 'KISS N TELL' MV"`);
    expect(
      buildAoiPreferredMusicAck({ lang: 'en', decision: remembered, startedTitle: 'KISS N TELL' }),
    ).toBe(
      'Playing "KISS N TELL", the 에스파 track you played before. Tell me if you meant a different one.',
    );
    expect(
      buildAoiPreferredMusicAck({ lang: 'ja', decision: remembered, startedTitle: null }),
    ).toContain('前に');
    expect(
      buildAoiPreferredMusicAck({ lang: 'zh', decision: remembered, startedTitle: null }),
    ).toContain('之前');
    expect(
      buildAoiPreferredMusicAck({ lang: 'fr', decision: remembered, startedTitle: null }),
    ).toContain('Playing');
  });

  it('says when nothing was remembered and asks for the song to remember', () => {
    const ko = buildAoiPreferredMusicAck({
      lang: 'ko',
      decision: fallback,
      startedTitle: 'NewJeans Supernatural',
    });
    expect(ko).toContain('기억해 둔 뉴진스 곡이 없어서');
    expect(ko).toContain('"NewJeans Supernatural"');
    expect(ko).toContain('다음엔 그걸로 틀게');
    const en = buildAoiPreferredMusicAck({ lang: 'en', decision: fallback, startedTitle: null });
    expect(en).toContain('no 뉴진스 track remembered');
    expect(en).not.toContain('started "');
  });
});
