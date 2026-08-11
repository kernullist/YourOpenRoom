import { describe, expect, it } from 'vitest';
import { isDirectPlaylistPlaybackIntent, parseDirectMusicIntent } from '../chatDirectActions';

describe('isDirectPlaylistPlaybackIntent', () => {
  it('matches natural Korean "play my playlist" variants including spaces', () => {
    const positives = [
      '내 플레이 리스트 틀어줘',
      '내 플레이리스트 틀어줘',
      '플레이리스트 틀어줘',
      '플레이 리스트 틀어줘',
      '저장한 플레이리스트 틀어줘',
      '인앱 유튜브 플레이리스트 틀어줘',
      '마지막 플레이리스트 틀어줘',
      '유튜브 플레이리스트 재생해',
      'My Playlist 틀어줘',
      'my playlist 재생해',
      'play my playlist',
      'play the last playlist',
      'resume playlist',
    ];

    for (const text of positives) {
      expect(isDirectPlaylistPlaybackIntent(text), text).toBe(true);
    }
  });

  it('does not steal topical playlist search queries', () => {
    const negatives = [
      'lofi chill playlist 틀어줘',
      'kpop playlist 재생해',
      'summer vibes playlist play',
      '플레이리스트 만들어줘',
      '플레이리스트 뭐 있어',
      '내 노래 틀어줘',
    ];

    for (const text of negatives) {
      expect(isDirectPlaylistPlaybackIntent(text), text).toBe(false);
    }
  });
});

describe('parseDirectMusicIntent', () => {
  it('does not treat saved-playlist playback as a YouTube search query', () => {
    expect(parseDirectMusicIntent('내 플레이 리스트 틀어줘')).toBeNull();
    expect(parseDirectMusicIntent('My Playlist 틀어줘')).toBeNull();
    expect(parseDirectMusicIntent('저장한 플레이리스트 재생해')).toBeNull();
  });

  it('still treats topical "…playlist" phrases as music search', () => {
    expect(parseDirectMusicIntent('lofi chill playlist 틀어줘')).toEqual({
      query: 'lofi chill playlist',
    });
  });

  it('treats Korean go-with phrasing as a direct YouTube music search', () => {
    expect(parseDirectMusicIntent('6월 걸그룹 노래로 가자')).toEqual({
      query: '6월 걸그룹',
    });
  });

  it('enriches generic girl group replies from recent assistant context', () => {
    expect(
      parseDirectMusicIntent('걸그룹 노래로 가자', [
        {
          role: 'assistant',
          content: '내 추천은 **6월 걸그룹 쪽으로 가볍게 시작**. 틀어줄 곡만 골라.',
        },
      ]),
    ).toEqual({
      query: '6월 걸그룹',
    });
  });

  it('uses the latest explicit YouTube query when the user asks Aoi to choose', () => {
    expect(
      parseDirectMusicIntent('네가 골라', [
        {
          role: 'assistant',
          content: 'YouTube 검색어:\n`KATSEYE Gabriela Official MV`',
        },
      ]),
    ).toEqual({
      query: 'KATSEYE Gabriela Official MV',
    });
  });

  it('extracts a taste-card quoted pick when the user asks Aoi to choose', () => {
    expect(
      parseDirectMusicIntent('그걸로 가자', [
        {
          role: 'assistant',
          content: '네 검색·재생 취향을 반영해서 이 곡/믹스 어때?\n🎵 추천: "aespa supernova"',
        },
      ]),
    ).toEqual({ query: 'aespa supernova' });
  });

  it('extracts a bold recommendation when the user asks Aoi to choose', () => {
    expect(
      parseDirectMusicIntent('네가 골라', [
        { role: 'assistant', content: '내 추천은 **sunset chill beats** 어때?' },
      ]),
    ).toEqual({ query: 'sunset chill beats' });
  });

  it('falls back to a dated girl-group mention in recent context', () => {
    expect(
      parseDirectMusicIntent('그걸로 가자', [
        { role: 'assistant', content: '오늘은 6월 걸그룹 느낌이 좋겠는데.' },
      ]),
    ).toEqual({ query: '6월 걸그룹' });
  });

  it('returns null when the user defers but no recommendation exists', () => {
    expect(
      parseDirectMusicIntent('네가 골라', [{ role: 'assistant', content: '안녕!' }]),
    ).toBeNull();
  });

  it('still extracts a normal title before a playback suffix', () => {
    expect(parseDirectMusicIntent('chill lofi evening mix 재생')).toEqual({
      query: 'chill lofi evening mix',
    });
  });

  it('rejects a symbol-only title from a tapped play chip (regression)', () => {
    // A restored "▶ 재생" reply chip must not become a YouTube search for "▶".
    expect(parseDirectMusicIntent('▶ 재생')).toBeNull();
    expect(parseDirectMusicIntent('🎵 재생')).toBeNull();
    expect(parseDirectMusicIntent('play ▶')).toBeNull();
    expect(parseDirectMusicIntent('틀어줘 ★★★')).toBeNull();
  });
});
