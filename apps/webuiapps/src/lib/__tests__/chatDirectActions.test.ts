import { describe, expect, it } from 'vitest';
import {
  isAoiMusicPlayChip,
  isDeferredMusicPlaybackIntent,
  isDirectPlaylistPlaybackIntent,
  isFailedAgentActionResult,
  parseDirectMusicIntent,
  parseStartedVideo,
} from '../chatDirectActions';

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

  // Regression: "달플리 말고 2026년 8월 여돌 노래모음을 틀어줘" searched YouTube
  // for the whole utterance, rejected pick and object particle included, and
  // landed on the very series the user had just refused. The rejected pick now
  // also rides along so the app can minus-operator and filter it out.
  it('keeps the requested side of an "A 말고 B" rejection and carries A as exclusion', () => {
    expect(parseDirectMusicIntent('달플리 말고 2026년 8월 여돌 노래모음을 틀어줘')).toEqual({
      query: '2026년 8월 여돌 노래모음',
      exclude: ['달플리'],
    });
    // A pronoun rejection names nothing filterable, so no exclusion is carried.
    expect(parseDirectMusicIntent('그거 말고 aespa 틀어줘')).toEqual({
      query: 'aespa',
    });
  });

  it('handles 빼고/대신 variants, chained rejections, and rejected-term particles', () => {
    expect(parseDirectMusicIntent('달플리 대신 8월 여돌 모음 재생해줘')).toEqual({
      query: '8월 여돌 모음',
      exclude: ['달플리'],
    });
    expect(parseDirectMusicIntent('발라드 말고 힙합도 말고 시티팝 틀어줘')).toEqual({
      query: '시티팝',
      exclude: ['발라드', '힙합'],
    });
    expect(parseDirectMusicIntent('달플리는 말고 aespa 틀어줘')).toEqual({
      query: 'aespa',
      exclude: ['달플리'],
    });
  });

  // Adversarial-review regressions: every guard here exists because the naive
  // needle it prevents was verified to empty real result sets.
  it('never splits an exclusion marker embedded inside a word', () => {
    // "말고기" is a word, not "말고 + 기" -- a needle of "기" would filter
    // nearly every Korean title.
    expect(parseDirectMusicIntent('말고기 빼고 소불고기 틀어줘')).toEqual({
      query: '소불고기',
      exclude: ['말고기'],
    });
  });

  it('keeps a name-final 이 and refuses 1-char or deictic needles', () => {
    // 싸이 is a name, not "싸 + subject particle".
    expect(parseDirectMusicIntent('싸이 말고 지드래곤 틀어줘')).toEqual({
      query: '지드래곤',
      exclude: ['싸이'],
    });
    // A 1-char rejection ("너") is too broad for substring filtering; the
    // request side alone carries the intent. This also keeps the actual song
    // "너 말고 니 언니" playable when typed directly.
    expect(parseDirectMusicIntent('너 말고 니 언니 틀어줘')).toEqual({
      query: '니 언니',
    });
    // Demonstratives name nothing filterable.
    expect(parseDirectMusicIntent('그건 말고 백예린 틀어줘')).toEqual({
      query: '백예린',
    });
    expect(parseDirectMusicIntent('그 채널 빼고 뉴진스 틀어줘')).toEqual({
      query: '뉴진스',
    });
  });

  it('yields to the conversation when only a deferral pronoun remains after the rejection', () => {
    expect(parseDirectMusicIntent('그거 말고 다시 틀어줘')).toBeNull();
  });

  it('returns null when the rejection names no replacement', () => {
    // "not that one" with nothing else -- there is no query to build, so the
    // direct path must yield to the conversation instead of searching the
    // rejection words themselves.
    expect(parseDirectMusicIntent('달플리 말고 틀어줘')).toBeNull();
    expect(parseDirectMusicIntent('그거 빼고 재생해')).toBeNull();
  });

  it('drops a trailing object particle from the typed request', () => {
    expect(parseDirectMusicIntent('노래모음을 틀어줘')).toEqual({ query: '노래모음' });
    expect(parseDirectMusicIntent('이무진 라일락을 틀어줘')).toEqual({ query: '이무진 라일락' });
  });

  // Regression: the filler-word strip had no word boundary, so compounds lost
  // their final syllable -- "aespa 신곡" searched as "aespa 신", "soundtrack"
  // as "sound".
  it('strips a standalone filler word but never a compound ending in one', () => {
    expect(parseDirectMusicIntent('aespa 노래 틀어줘')).toEqual({ query: 'aespa' });
    expect(parseDirectMusicIntent('신곡 틀어줘')).toEqual({ query: '신곡' });
    expect(parseDirectMusicIntent('aespa 신곡을 틀어줘')).toEqual({ query: 'aespa 신곡' });
    expect(parseDirectMusicIntent('play soundtrack')).toEqual({ query: 'soundtrack' });
    // A bare filler word alone still yields nothing to search for.
    expect(parseDirectMusicIntent('노래 틀어줘')).toBeNull();
  });

  it('never strips exclusion words from a recovered recommendation title', () => {
    // A real title can contain " 말고 " -- the play chip resolves against the
    // taste card verbatim, bypassing the request-only cleanup.
    expect(
      parseDirectMusicIntent('▶ 재생', [
        {
          role: 'assistant',
          content: '이 노래 어때?\n🎵 추천 (네 취향 반영): "너 말고 니 언니"',
        },
      ]),
    ).toEqual({ query: '너 말고 니 언니' });
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

  it('recovers the idle-nudge pick when a restored play chip has no pending offer', () => {
    // The card lives in the server-persisted transcript while the pending offer
    // is browser-local, so a tap from another profile/origin arrives bare. The
    // chip must still open the recommendation instead of reaching the LLM.
    expect(
      parseDirectMusicIntent('▶ 재생', [
        {
          role: 'assistant',
          content:
            '늦은 시간이라 조용하네. 은은한 사운드 하나 깔아줄까?\n' +
            '🎵 추천 (네 취향 반영): "2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST"',
        },
        { role: 'user', content: '▶ 재생' },
      ]),
    ).toEqual({ query: '2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST' });
  });

  it('recovers the pick for localized play chips', () => {
    const history = [{ role: 'assistant' as const, content: 'YouTube 검색어: `aespa supernova`' }];
    expect(parseDirectMusicIntent('▶ Play', history)).toEqual({ query: 'aespa supernova' });
    expect(parseDirectMusicIntent('▶ 再生', history)).toEqual({ query: 'aespa supernova' });
    expect(parseDirectMusicIntent('▶ 播放', history)).toEqual({ query: 'aespa supernova' });
    expect(parseDirectMusicIntent('▶ 플레이', history)).toEqual({ query: 'aespa supernova' });
  });

  it('keeps a recommended title that contains its own quotes intact', () => {
    expect(
      parseDirectMusicIntent('▶ 재생', [
        { role: 'assistant', content: '🎵 추천: "KATSEYE "Gnarly" Official MV"' },
      ]),
    ).toEqual({ query: 'KATSEYE "Gnarly" Official MV' });
  });

  it('returns null for a play chip with no recoverable recommendation', () => {
    // ChatPanel answers this case honestly; it must never become a search for the marker.
    expect(parseDirectMusicIntent('▶ 재생', [{ role: 'assistant', content: '안녕!' }])).toBeNull();
  });
});

describe('isFailedAgentActionResult', () => {
  it('treats every non-success dispatch outcome as a failure', () => {
    // dispatchAgentAction RESOLVES with these; a try/catch never sees them, so
    // an ack gated only on exceptions claims success for actions that did
    // nothing at all.
    const failures = [
      'error: cannot open target app window for app_id=3',
      'error: track not found',
      'timeout: no response from app',
      'TIMEOUT: no response from app',
      '  error: whatever  ',
      '',
      '   ',
      null,
      undefined,
    ];
    for (const result of failures) {
      expect(isFailedAgentActionResult(result), JSON.stringify(result)).toBe(true);
    }
  });

  it('accepts the shapes a real success comes back in', () => {
    for (const result of ['success', 'done', 'success {"id":"abc"}', 'restored']) {
      expect(isFailedAgentActionResult(result), result).toBe(false);
    }
  });
});

describe('isDeferredMusicPlaybackIntent', () => {
  it('recognizes a request to replay what Aoi just named', () => {
    const positives = [
      '다시 틀어줘',
      '다시 재생해',
      '또 들려줘',
      '한 번 더 틀어줘',
      '한번 더 재생해줘',
      '그거 틀어줘',
      '아까 그거 다시 틀어줘',
      '아니 아까 너가 말한거 틀어달란거야',
      '아까 네가 말한 곡 틀어줘',
      '방금 추천한 노래 다시 재생해줘',
      'play it again',
      'Play the one you said',
      'again',
    ];
    for (const text of positives) {
      expect(isDeferredMusicPlaybackIntent(text), text).toBe(true);
    }
  });

  it('leaves a request that names its own title alone', () => {
    // These carry a real query, so the normal extraction must handle them
    // rather than collapsing them into "play that again".
    const negatives = [
      'aespa supernova 틀어줘',
      'lofi chill playlist 재생해',
      '다시 얘기해줘',
      '아까 그 뉴스 다시 보여줘',
      '내 플레이리스트 틀어줘',
      '',
    ];
    for (const text of negatives) {
      expect(isDeferredMusicPlaybackIntent(text), text).toBe(false);
    }
  });
});

describe('replaying the pick Aoi just started', () => {
  const PLAY_ACK =
    '틀어줄게. 유튜브에서 "2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST - 달플리 𝑷𝒍𝒂𝒆𝒍𝒊𝒌𝒕" 찾아서 재생 준비해뒀어.';
  const TITLE = '2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST - 달플리 𝑷𝒍𝒂𝒆𝒍𝒊𝒌𝒕';

  it('resolves "다시 틀어줘" against the playback ack instead of searching for "다시"', () => {
    // The reported failure: the suffix patterns turned this into a YouTube
    // search for the adverb, and Aoi answered '"다시" 유튜브에서 틀어볼게.'
    expect(
      parseDirectMusicIntent('다시 틀어줘', [{ role: 'assistant', content: PLAY_ACK }]),
    ).toEqual({ query: TITLE });
  });

  it('resolves the follow-up correction that used to reach the model', () => {
    expect(
      parseDirectMusicIntent('아니 아까 너가 말한거 틀어달란거야', [
        { role: 'assistant', content: PLAY_ACK },
      ]),
    ).toEqual({ query: TITLE });
  });

  it('takes the video actually playing from a substitution ack, not the query', () => {
    const substituteAck =
      '"검색한 제목"로 찾아서 "진짜 재생중인 제목" 틀었어. 원하던 게 아니면 말해줘.';
    expect(
      parseDirectMusicIntent('다시 틀어줘', [{ role: 'assistant', content: substituteAck }]),
    ).toEqual({ query: '진짜 재생중인 제목' });
  });

  it('never recovers a pronoun Aoi quoted back from a mis-parse', () => {
    // Aoi's own '"다시" 유튜브에서 틀어볼게.' must not become the next query.
    expect(
      parseDirectMusicIntent('다시 틀어줘', [
        { role: 'assistant', content: '"다시" 유튜브에서 틀어볼게.' },
      ]),
    ).toBeNull();
  });

  it('returns null when there is nothing to replay', () => {
    expect(
      parseDirectMusicIntent('다시 틀어줘', [{ role: 'assistant', content: '오늘 뭐 할까?' }]),
    ).toBeNull();
  });
});

describe('parseStartedVideo', () => {
  it('reads the video the app reports it started', () => {
    expect(
      parseStartedVideo('success {"title":"2026 8월 여돌 노래모음","matchedQuery":true}'),
    ).toEqual({ title: '2026 8월 여돌 노래모음', matchedQuery: true });
  });

  it('carries through that the started video is NOT the one that was named', () => {
    // The whole point: the caller has to be able to tell these apart, or it
    // announces the query over a video the query never matched.
    expect(parseStartedVideo('success {"title":"7월 노래모음","matchedQuery":false}')).toEqual({
      title: '7월 노래모음',
      matchedQuery: false,
    });
  });

  it('treats a missing flag as unmatched rather than assuming success', () => {
    expect(parseStartedVideo('success {"title":"Something"}')?.matchedQuery).toBe(false);
  });

  it('returns null for results that carry no video, so the caller keeps its old wording', () => {
    for (const result of [
      'success',
      'done',
      '',
      null,
      undefined,
      'success {broken',
      'success {}',
    ]) {
      expect(parseStartedVideo(result), JSON.stringify(result)).toBeNull();
    }
  });
});

describe('isAoiMusicPlayChip', () => {
  it('matches the play chips Aoi emits, including emoji presentation', () => {
    const positives = [
      '▶ 재생',
      '▶재생',
      '▶ Play',
      '▶ play',
      '▶ 再生',
      '▶ 播放',
      '▶️ 재생',
      '► 재생',
    ];
    for (const text of positives) {
      expect(isAoiMusicPlayChip(text), text).toBe(true);
    }
  });

  it('does not claim typed text or other chips', () => {
    const negatives = [
      '재생',
      '재생해줘',
      '다음에',
      '▶ 다음 곡',
      'aespa supernova 재생',
      '📰 관심 있어',
      '',
    ];
    for (const text of negatives) {
      expect(isAoiMusicPlayChip(text), text).toBe(false);
    }
  });
});
