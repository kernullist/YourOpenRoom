import { describe, expect, it } from 'vitest';
import {
  isAoiMusicPlayChip,
  isDeferredMusicPlaybackIntent,
  isMusicPickConfirmationIntent,
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

// The transcript this was reported from, turn by turn. Aoi recommended aespa
// "KISS N TELL" with its exact search query, and every follow-up went wrong in a
// different way: the named selection searched the bare artist word and played an
// unrelated variety-show episode, the correction that named her own pick was not
// recognized at all, and the confirmation of her own "그거 맞지?" resolved to
// nothing -- so that turn reached the LLM with no app tools and it promised
// playback for the next turn, then promised it again.
const AESPA_OFFER_QUERY = "aespa 에스파 'KISS N TELL' MV - SMTOWN and aespa";
const AESPA_OFFER_CARD = {
  role: 'assistant' as const,
  content: [
    '좋아, 그럼 내가 네 취향에 딱 맞는 거 하나 집어줄게. 에스파 "KISS N TELL" 어때?',
    '',
    `YouTube 검색어: \`${AESPA_OFFER_QUERY}\``,
    '',
    '이거 틀어줄까? 아니면 프로미스나인 쪽으로 갈까?',
  ].join('\n'),
};
const AESPA_CONFIRM_ASK = {
  role: 'assistant' as const,
  content:
    '아, 그거! "KISS N TELL" 맞지? 근데 지금 이 타이밍엔 재생 버튼이 내 손에 안 잡혀서 바로 못 틀었어. ' +
    "다음 턴에 YouTube 검색으로 `aespa 에스파 'KISS N TELL' MV` 바로 열어줄게. 그거 맞는 거지? 확인만 해줘.",
};

describe('parseDirectMusicIntent offer selection', () => {
  it('answers a named selection with the offer’s exact query', () => {
    // "에스파로 가자" selects the offer above. Searching "에스파" alone is what
    // played "[EP.07] 아우디즈의 찾아서 투어" instead of the MV.
    for (const text of ['에스파로 가자', 'aespa로 가자', 'KISS N TELL 틀어줘', '에스파 들려줘']) {
      expect(parseDirectMusicIntent(text, [AESPA_OFFER_CARD]), text).toEqual({
        query: AESPA_OFFER_QUERY,
      });
    }
  });

  it('leaves a request the offer does not cover as a real search', () => {
    // The alternative Aoi named in the same breath, a different artist, and a
    // different song by the offered artist are all genuinely new searches. Only
    // the recovered query is compared, so the card text mentioning 프로미스나인
    // cannot pull it in.
    const cases: [string, string][] = [
      ['프로미스나인으로 가자', '프로미스나인'],
      ['뉴진스 틀어줘', '뉴진스'],
      ['에스파 신곡 틀어줘', '에스파 신곡'],
    ];
    for (const [text, query] of cases) {
      expect(parseDirectMusicIntent(text, [AESPA_OFFER_CARD]), text).toEqual({ query });
    }
  });

  it('never upgrades a request that rejected the offer', () => {
    expect(parseDirectMusicIntent('에스파 말고 뉴진스로 가자', [AESPA_OFFER_CARD])).toEqual({
      query: '뉴진스',
      exclude: ['에스파'],
    });
    // A rejection with only a pronoun left must stay unresolved: recovering the
    // pick would replay exactly what was refused.
    expect(parseDirectMusicIntent('그거 말고 다시 틀어줘', [AESPA_OFFER_CARD])).toBeNull();
  });

  it('needs an offer to upgrade against', () => {
    expect(parseDirectMusicIntent('에스파로 가자', [])).toEqual({ query: '에스파' });
  });

  // The query Aoi prints is the real upload title, and that title is often in a
  // different script than the one she just spoke: the pick stored for this very
  // case is "aespa エスパ 'KISS N TELL' MV - SMTOWN and aespa" while the card says
  // 에스파. Comparing against the query alone left the reported bug live for
  // every mixed-script pick -- "에스파로 가자" went back to searching "에스파".
  const KATAKANA_OFFER_QUERY = "aespa エスパ 'KISS N TELL' MV - SMTOWN and aespa";
  const KATAKANA_OFFER_CARD = {
    role: 'assistant' as const,
    content: [
      '좋아, 네 취향에 딱 맞는 거 하나. 에스파 "KISS N TELL" 어때?',
      `YouTube 검색어: \`${KATAKANA_OFFER_QUERY}\``,
      '이거 틀어줄까? 아니면 프로미스나인 쪽으로 갈까?',
    ].join('\n'),
  };

  it('resolves a selection named in a different script than the query', () => {
    for (const text of ['에스파로 가자', 'aespa로 가자', 'KISS N TELL 틀어줘', '에스파 들려줘']) {
      expect(parseDirectMusicIntent(text, [KATAKANA_OFFER_CARD]), text).toEqual({
        query: KATAKANA_OFFER_QUERY,
      });
    }
  });

  it('still refuses the alternative named in the same card', () => {
    // The card's prose is only trusted up to the first alternative marker, so
    // 프로미스나인 -- which Aoi offers after "아니면" -- can never resolve to the
    // pick the user just passed over.
    const cases: [string, string][] = [
      ['프로미스나인으로 가자', '프로미스나인'],
      ['뉴진스 틀어줘', '뉴진스'],
      ['에스파 신곡 틀어줘', '에스파 신곡'],
    ];
    for (const [text, query] of cases) {
      expect(parseDirectMusicIntent(text, [KATAKANA_OFFER_CARD]), text).toEqual({ query });
    }
    expect(parseDirectMusicIntent('에스파 말고 뉴진스로 가자', [KATAKANA_OFFER_CARD])).toEqual({
      query: '뉴진스',
      exclude: ['에스파'],
    });
  });
});

describe('parseDirectMusicIntent pick references', () => {
  it('resolves a reference to Aoi’s own pick that carries no playback verb', () => {
    for (const text of [
      '아니, 너가 추천한 에스파 노래 말야',
      '너가 추천한 곡 말야',
      '아니 네가 말한 그 노래 말이야',
      'no, i meant the song you recommended',
    ]) {
      expect(parseDirectMusicIntent(text, [AESPA_OFFER_CARD]), text).toEqual({
        query: AESPA_OFFER_QUERY,
      });
      expect(isDeferredMusicPlaybackIntent(text), text).toBe(true);
    }
  });

  it('does not read an opinion or a question as a play request', () => {
    for (const text of [
      '너가 추천한 노래 별로였어',
      '너가 추천한 노래 뭐였지?',
      '너가 추천한 노래',
      '아까 추천한 곡 가사 알려줘',
    ]) {
      expect(isDeferredMusicPlaybackIntent(text), text).toBe(false);
    }
  });
});

describe('isMusicPickConfirmationIntent', () => {
  it('reads a bare yes to Aoi’s own confirm ask as consent to play', () => {
    for (const text of ['응 맞아', '맞아', '어 그거', '응', 'yes', "yeah that's right"]) {
      expect(isMusicPickConfirmationIntent(text, [AESPA_CONFIRM_ASK]), text).toBe(true);
    }
    expect(parseDirectMusicIntent('응 맞아', [AESPA_OFFER_CARD, AESPA_CONFIRM_ASK])).toEqual({
      // The backticked query in the confirm ask is the pick, verbatim.
      query: "aespa 에스파 'KISS N TELL' MV",
    });
  });

  it('stays out of every other context', () => {
    const notMusic = [{ role: 'assistant' as const, content: '커밋 3개 밀었어. 이거 맞지?' }];
    expect(isMusicPickConfirmationIntent('응 맞아', notMusic)).toBe(false);

    // Music was discussed, but nothing was asked -- consent needs a question.
    const noAsk = [{ role: 'assistant' as const, content: '"KISS N TELL" 틀었어.' }];
    expect(isMusicPickConfirmationIntent('응 맞아', noAsk)).toBe(false);

    // Says something past "yes", so it is not a bare confirmation.
    for (const text of ['응 근데 좀 이따가', '맞아 그런데 다른 곡으로', '아니 틀렸어']) {
      expect(isMusicPickConfirmationIntent(text, [AESPA_CONFIRM_ASK]), text).toBe(false);
    }
    expect(isMusicPickConfirmationIntent('응 맞아', [])).toBe(false);
  });
});

describe('parseDirectMusicIntent lead-in and placeholders', () => {
  it('drops conversational lead-in instead of searching it', () => {
    // The suffix patterns anchor on the verb at the end, so the filler in front
    // rode along inside the query: "응 그런데 다른거로 해줘" was searched verbatim.
    expect(parseDirectMusicIntent('응 그런데 에스파로 가자', [AESPA_OFFER_CARD])).toEqual({
      query: AESPA_OFFER_QUERY,
    });
    for (const text of ['그래 틀어줘', '응 틀어줘', '응 그거 틀어줘']) {
      expect(parseDirectMusicIntent(text, [AESPA_OFFER_CARD]), text).toEqual({
        query: AESPA_OFFER_QUERY,
      });
    }
    // Titles that merely start with the same syllables must survive whole.
    expect(parseDirectMusicIntent('어디에도 틀어줘', [])).toEqual({ query: '어디에도' });
    expect(parseDirectMusicIntent('네가 좋아 틀어줘', [])).toEqual({ query: '네가 좋아' });
  });

  it('asks the conversation for a new pick instead of searching a placeholder', () => {
    // "다른거" names nothing, and recovering the last pick would replay the very
    // thing being refused.
    for (const text of [
      '응 그런데 다른거로 해줘',
      '다른거로 해줘',
      '다른 노래 틀어줘',
      '딴거 틀어줘',
      '아무거나 틀어줘',
      'play something else',
    ]) {
      expect(parseDirectMusicIntent(text, [AESPA_OFFER_CARD]), text).toBeNull();
    }
  });
});

describe('recommended-pick recovery', () => {
  it('recovers a backticked query from a playback message', () => {
    const backtickOnly = [
      {
        role: 'assistant' as const,
        content:
          '오케이, 그걸로 확정. 근데 지금은 바로 못 틀었어. ' +
          '다음 턴에 `aespa 에스파 Whiplash MV` 검색으로 바로 열어줄게.',
      },
    ];
    expect(parseDirectMusicIntent('다시 틀어줘', backtickOnly)).toEqual({
      query: 'aespa 에스파 Whiplash MV',
    });
  });

  it('never recovers backticked code as a pick', () => {
    // Aoi backticks paths and commands constantly, and a message can mention
    // playback in the same breath. Searching YouTube for a filename is worse
    // than not recovering anything.
    const codeTalk = [
      {
        role: 'assistant' as const,
        content: '재생 로직은 `src/lib/playerUtils.ts` 에 있어. 고치고 `pnpm test` 돌렸어.',
      },
    ];
    expect(parseDirectMusicIntent('다시 틀어줘', codeTalk)).toBeNull();
  });
});

// Found by reviewing this file's own additions adversarially. Each of these was a
// real defect at the time it was written, so they are pinned rather than described.
describe('offer selection, adversarially', () => {
  // The card names a DIFFERENT artist in passing, with no alternative marker in
  // front of it and in the same sentence as the pick. Comparing against the whole
  // prose window resolved "뉴진스로 가자" to the aespa query -- the exact
  // substitution the offer resolution exists to prevent.
  const PASSING_MENTION_QUERY = 'aespa エスパ KISS N TELL MV';
  const PASSING_MENTION_CARD = {
    role: 'assistant' as const,
    content: [
      '뉴진스도 좋지만 오늘은 에스파 "KISS N TELL" 어때?',
      `YouTube 검색어: \`${PASSING_MENTION_QUERY}\``,
      '이거 틀어줄까?',
    ].join('\n'),
  };

  it('does not resolve an artist the card only mentioned in passing', () => {
    expect(parseDirectMusicIntent('뉴진스로 가자', [PASSING_MENTION_CARD])).toEqual({
      query: '뉴진스',
    });
  });

  it('still resolves the artist named right before the quoted title', () => {
    // Only the few words in front of the quote are trusted, which is where the
    // card writes the pick in the script the reader sees.
    expect(parseDirectMusicIntent('에스파로 가자', [PASSING_MENTION_CARD])).toEqual({
      query: PASSING_MENTION_QUERY,
    });
  });

  it('reaches only the words immediately before the title', () => {
    const wordy = {
      role: 'assistant' as const,
      content: [
        '좋아, 네 취향에 딱 맞는 하나 집어줄게. 에스파 "KISS N TELL" 어때?',
        `YouTube 검색어: \`${PASSING_MENTION_QUERY}\``,
      ].join('\n'),
    };
    // Inside the window resolves -- that is what makes a cross-script pick work,
    // and it is the design rather than a defect.
    expect(parseDirectMusicIntent('에스파로 가자', [wordy])).toEqual({
      query: PASSING_MENTION_QUERY,
    });
    // Outside it does not, which is what keeps a neighbouring name from winning.
    expect(parseDirectMusicIntent('취향에로 가자', [wordy])?.query).not.toBe(PASSING_MENTION_QUERY);
    expect(parseDirectMusicIntent('맞는거로 가자', [wordy])?.query).not.toBe(PASSING_MENTION_QUERY);
  });
});

describe('conversational lead-in, adversarially', () => {
  it('keeps a title whose first word doubles as a lead-in', () => {
    // Dropping every lead-in unconditionally cut these down to their second word.
    const cases: [string, string][] = [
      ['그래서 그대는 틀어줘', '그래서 그대는'],
      ['네 생각 틀어줘', '네 생각'],
      ['그런데 그런 밤 틀어줘', '그런데 그런 밤'],
    ];
    for (const [text, query] of cases) {
      expect(parseDirectMusicIntent(text, []), text).toEqual({ query });
    }
  });

  it('still drops lead-in that leaves nothing searchable behind it', () => {
    const card = {
      role: 'assistant' as const,
      content: '에스파 "KISS N TELL" 어때?\nYouTube 검색어: `aespa KISS N TELL MV`',
    };
    // Nothing but the filler: resolve against the pick instead of searching it.
    expect(parseDirectMusicIntent('그래 틀어줘', [card])).toEqual({
      query: 'aespa KISS N TELL MV',
    });
    // Filler in front of a placeholder: refuse, rather than replay the refused pick.
    expect(parseDirectMusicIntent('근데 다른거로 해줘', [card])).toBeNull();
    expect(parseDirectMusicIntent('아니 아니 틀어줘', [])).toBeNull();
    // An interjection in front of a real request still gets dropped.
    expect(parseDirectMusicIntent('응 그런데 뉴진스로 가자', [card])).toEqual({ query: '뉴진스' });
  });
});

describe('lead-in that blocked the offer from resolving', () => {
  const OFFER = 'aespa エスパ KISS N TELL MV';
  const CARD = {
    role: 'assistant' as const,
    content: ['에스파 "KISS N TELL" 어때?', 'YouTube 검색어: `' + OFFER + '`'].join('\n'),
  };

  it('retries once with the lead-in dropped when the offer would resolve without it', () => {
    // The conservative strip keeps an ambiguous lead-in whenever something
    // searchable follows, which is right for a title and wrong here: "그래" is
    // what stopped "에스파" from resolving to the offer.
    expect(parseDirectMusicIntent('그래 에스파 틀어줘', [CARD])).toEqual({ query: OFFER });
  });

  it('leaves a real title alone when the retry does not resolve', () => {
    // The retry is only taken when it lands on a pick, so a miss cannot cost a
    // title its first word.
    expect(parseDirectMusicIntent('그래서 그대는 틀어줘', [CARD])).toEqual({
      query: '그래서 그대는',
    });
    expect(parseDirectMusicIntent('네 생각 틀어줘', [CARD])).toEqual({ query: '네 생각' });
  });

  it('accepted limit: filler in front of an unrelated artist keeps the filler', () => {
    // Nothing distinguishes "그래 뉴진스" from a two-word title here, and the
    // retry has no pick to land on. The cost is a slightly noisier query, not a
    // wrong action, which is the better side of the trade.
    expect(parseDirectMusicIntent('그래 뉴진스 틀어줘', [CARD])).toEqual({ query: '그래 뉴진스' });
  });
});

describe('pick references that are questions', () => {
  it('does not answer a question about the pick by playing it', () => {
    // "맞지?" asks whether the user has it right. Starting playback is not an
    // answer to that.
    for (const text of ['너가 추천한 노래 맞지?', '너가 추천한 곡 맞아?', '아까 추천한 거 맞지']) {
      expect(isDeferredMusicPlaybackIntent(text), text).toBe(false);
    }
  });

  it('still resolves a correction that names the pick', () => {
    expect(isDeferredMusicPlaybackIntent('아니, 너가 추천한 에스파 노래')).toBe(true);
    expect(isDeferredMusicPlaybackIntent('너가 추천한 곡 말야')).toBe(true);
  });
});
