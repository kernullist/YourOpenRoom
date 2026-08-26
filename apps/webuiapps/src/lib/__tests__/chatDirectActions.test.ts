import { describe, expect, it } from 'vitest';
import {
  collectMusicPickCandidates,
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
describe('parseDirectMusicIntent pick references', () => {
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

describe('parseDirectMusicIntent lead-in and placeholders', () => {
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

// The contract after the parser shrink. Three branches, and the middle one is the
// whole point: when a pick is on the table, which pick the user means is a
// question about language, so the parser hands the turn to the classifier instead
// of guessing. Every case this block asserts as null used to be answered here --
// and all seven defects found reviewing this file were in those answers.
describe('parseDirectMusicIntent: the three branches', () => {
  const OFFER_QUERY = "aespa エスパ 'KISS N TELL' MV - SMTOWN and aespa";
  const CARD = {
    role: 'assistant' as const,
    content: [
      '뉴진스도 좋지만 오늘은 에스파 "KISS N TELL" 어때?',
      `YouTube 검색어: \`${OFFER_QUERY}\``,
      '이거 틀어줄까? 아니면 프로미스나인 쪽으로 갈까?',
    ].join('\n'),
  };

  it('1. a tapped chip resolves from the card with no model call', () => {
    // Not language: the chip means "the pick above", and the card printed it.
    expect(parseDirectMusicIntent('▶ 재생', [CARD])).toEqual({ query: OFFER_QUERY });
  });

  it('1. exact recall still reads every shape the app prints', () => {
    const shapes: [string, string][] = [
      ['YouTube 검색어: `KATSEYE Gabriela Official MV`', 'KATSEYE Gabriela Official MV'],
      ['🎵 추천: "aespa supernova"', 'aespa supernova'],
      ['오케이, 못 틀었어. 다음 턴에 `aespa Whiplash MV` 열어줄게.', 'aespa Whiplash MV'],
      ['"진짜 재생중인 제목" 틀었어.', '진짜 재생중인 제목'],
    ];
    for (const [content, query] of shapes) {
      expect(parseDirectMusicIntent('▶ 재생', [{ role: 'assistant', content }]), content).toEqual({
        query,
      });
    }
  });

  it('1. never recovers backticked code as a pick', () => {
    // Aoi backticks paths and commands constantly, and a message can mention
    // playback in the same breath.
    expect(
      parseDirectMusicIntent('▶ 재생', [
        {
          role: 'assistant',
          content: '재생 로직은 `src/lib/playerUtils.ts` 에 있어. `pnpm test` 돌렸어.',
        },
      ]),
    ).toBeNull();
  });

  it('2. defers to the classifier whenever a pick is on the table', () => {
    // Selecting an offer by name, in another script, confirming it, referring to
    // it, filler in front of it, naming an alternative -- every one of these was
    // parsed here before, and each produced at least one defect.
    for (const text of [
      '에스파로 가자',
      'aespa로 가자',
      'KISS N TELL 틀어줘',
      '너가 추천한 에스파 노래 말야',
      '응 맞아',
      '그래 에스파 틀어줘',
      '다시 틀어줘',
      '그걸로 가자',
      '네가 골라',
      '뉴진스로 가자',
      '프로미스나인으로 가자',
      '그래서 그대는 틀어줘',
      '에스파 말고 뉴진스로 가자',
    ]) {
      expect(parseDirectMusicIntent(text, [CARD]), text).toBeNull();
    }
  });

  it('3. takes an explicit request verbatim when nothing is on the table', () => {
    // No history to misread, so nothing here can substitute one pick for another.
    const cases: [string, string][] = [
      ['에스파 틀어줘', '에스파'],
      ['그래서 그대는 틀어줘', '그래서 그대는'],
      ['네 생각 틀어줘', '네 생각'],
      ['lofi chill playlist 틀어줘', 'lofi chill playlist'],
      ['6월 걸그룹 노래로 가자', '6월 걸그룹'],
      ['play soundtrack', 'soundtrack'],
    ];
    for (const [text, query] of cases) {
      expect(parseDirectMusicIntent(text, []), text).toEqual({ query });
    }
  });

  it('3. still refuses a word that names nothing', () => {
    // Refusing is safe -- the conversation picks it up -- while searching the
    // word is how "다른거로 해줘" became a YouTube search for "다른거".
    for (const text of ['다른거로 해줘', '아무거나 틀어줘', '다시 틀어줘', '노래 틀어줘']) {
      expect(parseDirectMusicIntent(text, []), text).toBeNull();
    }
  });

  it('looks back the same number of messages however the pick is asked for', () => {
    // These used to disagree -- 3 messages for the chip, 2 for the candidate list.
    // A pick three back meant a tapped chip resolved it while the equivalent typed
    // request saw no candidate, fell past the classifier, and was answered with
    // "미안, 못 찾겠어" about a pick the chip on the same history finds.
    const threeBack = [
      { role: 'assistant' as const, content: 'YouTube 검색어: `aespa Whiplash MV`' },
      { role: 'user' as const, content: '고마워' },
      { role: 'assistant' as const, content: '응 뭐 필요하면 말해.' },
      { role: 'user' as const, content: '커널 얘기 좀' },
      { role: 'assistant' as const, content: '커널은 말이지...' },
    ];
    expect(parseDirectMusicIntent('▶ 재생', threeBack)).toEqual({ query: 'aespa Whiplash MV' });
    // Same history, typed instead of tapped: deferred to the classifier, which is
    // what the honest "cannot find it" ack keys off NOT happening.
    expect(parseDirectMusicIntent('다시 틀어줘', threeBack)).toBeNull();
    expect(collectMusicPickCandidates(threeBack)).toHaveLength(1);
  });

  it('3. still splits an explicit "A 말고 B"', () => {
    expect(parseDirectMusicIntent('달플리 말고 8월 여돌 노래모음을 틀어줘', [])).toEqual({
      query: '8월 여돌 노래모음',
      exclude: ['달플리'],
    });
  });
});
