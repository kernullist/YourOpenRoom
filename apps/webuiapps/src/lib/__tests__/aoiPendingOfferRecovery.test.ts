import { describe, expect, it } from 'vitest';

import { TASTE_POLL_QUESTIONS } from '../aoiMusicTaste';
import type { AoiNewsCandidate } from '../aoiNewsNudge';
import { PREFERENCE_POLL_QUESTIONS } from '../aoiPreferencePoll';
import {
  IDLE_MUSIC_MOOD_OFFERS,
  IDLE_MUSIC_TIME_LINES,
  buildIdleMusicCardLine,
  extractCardMusicMood,
  extractCardMusicQuery,
  extractCardNewsTitle,
  identifyPendingNudgeCard,
  isAoiNewsPlayChip,
  parseNudgeCardStamp,
  recoverIdleMusicOffer,
  recoverNewsOffer,
  recoverPreferencePoll,
  recoverTastePoll,
  reconcileRecoveredIdleMusicOffer,
  type NudgeCardMessage,
} from '../aoiPendingOfferRecovery';

const QUERY = '2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST';
const HEADLINE = 'BDTHEMES SUPPLY CHAIN ATTACK POISONS JSON TO CREATE ROGUE WORDPRESS ADMINS';

const MUSIC_CARD_STAMP = 1786728972470;

// Mirrors buildIdleMusicCardCopy in ChatPanel. The clock half and the mood half
// vary independently, which is the whole point of the split.
function idleMusicCard(
  mood: 'focus' | 'chill' | 'upbeat' | 'ambient' = 'ambient',
  dayPhase: 'morning' | 'working' | 'evening' | 'late' = 'late',
): NudgeCardMessage {
  return {
    id: `aoi-idle-music-${MUSIC_CARD_STAMP}`,
    role: 'assistant',
    content: `${buildIdleMusicCardLine(dayPhase, mood, 'ko')}\n🎵 추천 (네 취향 반영): "${QUERY}"`,
    suggestedReplies: ['▶ 재생', '다음에'],
  };
}

// Mirrors buildAoiMusicTasteRecommendCopy (the re-roll card): no mood line.
// The genre-seed card is the same copy under a different id prefix.
function tasteMusicCard(id = 'aoi-taste-music-1786728999999'): NudgeCardMessage {
  return {
    id,
    role: 'assistant',
    content:
      '네 검색·재생 취향을 반영해서 이 곡/믹스 어때?\n' +
      `🎵 추천: "${QUERY}"\n` +
      `YouTube 검색어: \`${QUERY}\`\n` +
      '재생 누르면 바로 틀어줄게.',
    suggestedReplies: ['▶ 재생', '다른 거'],
  };
}

// Mirrors buildNewsCardCopy in ChatPanel.
function newsCard(title = HEADLINE): NudgeCardMessage {
  return {
    id: 'aoi-news-1786440518362',
    role: 'assistant',
    content: `📰 새 사이버보안 뉴스가 눈에 띄네: "${title}". 자세히 볼래?`,
    suggestedReplies: ['📰 관심 있어', '지금은 됐어'],
  };
}

function newsCandidate(overrides: Partial<AoiNewsCandidate> = {}): AoiNewsCandidate {
  return {
    id: 'article-1',
    title: HEADLINE,
    category: 'breaking',
    summary: 'summary',
    publishedAt: '2026-08-15T00:00:00.000Z',
    isLive: true,
    ...overrides,
  };
}

const TASTE_QUESTION = TASTE_POLL_QUESTIONS[0];
const PREFERENCE_QUESTION = PREFERENCE_POLL_QUESTIONS[0];

function tastePollCard(lang: 'ko' | 'en' = 'ko'): NudgeCardMessage {
  return {
    id: 'aoi-taste-poll-1786587310148',
    role: 'assistant',
    content: TASTE_QUESTION.prompts[lang],
    suggestedReplies: TASTE_QUESTION.options.map((option) => option.labels[lang]),
  };
}

function preferencePollCard(lang: 'ko' | 'en' = 'ko'): NudgeCardMessage {
  return {
    id: 'aoi-preference-poll-1787020961949',
    role: 'assistant',
    content: PREFERENCE_QUESTION.prompts[lang],
    suggestedReplies: PREFERENCE_QUESTION.options.map((option) => option.labels[lang]),
  };
}

describe('identifyPendingNudgeCard', () => {
  it('identifies each card kind from its persisted message id', () => {
    const cases: Array<[NudgeCardMessage, string]> = [
      [idleMusicCard(), 'idle-music'],
      [tasteMusicCard(), 'idle-music'],
      // The genre-seed card sets a pending idle-music offer like the others.
      // Leaving its prefix out made it the one card whose chips could not be
      // recovered from the transcript, which is what this module is for.
      [tasteMusicCard('aoi-taste-seed-1786729111111'), 'idle-music'],
      [newsCard(), 'news'],
      [tastePollCard(), 'taste-poll'],
      [preferencePollCard(), 'preference-poll'],
    ];
    for (const [card, kind] of cases) {
      expect(identifyPendingNudgeCard([card])?.kind, card.id).toBe(kind);
    }
  });

  it('treats a card as answered once the user has sent anything after it', () => {
    expect(
      identifyPendingNudgeCard([idleMusicCard(), { role: 'user', content: '▶ 재생', id: '1' }]),
    ).toBeNull();
    expect(
      identifyPendingNudgeCard([idleMusicCard(), { role: 'user', content: '딴 얘기', id: '1' }]),
    ).toBeNull();
  });

  it('looks past a later assistant message that left the chips in place', () => {
    // A self-observation is posted with updateSuggestedReplies: false, so the
    // card's chips are still the ones on screen.
    const card = identifyPendingNudgeCard([
      idleMusicCard(),
      { id: 'aoi-self-observation-2', role: 'assistant', content: '나 요즘 이런 걸 봤어.' },
    ]);
    expect(card?.kind).toBe('idle-music');
  });

  it('ignores ordinary assistant messages and empty transcripts', () => {
    expect(identifyPendingNudgeCard([])).toBeNull();
    expect(identifyPendingNudgeCard(null)).toBeNull();
    expect(
      identifyPendingNudgeCard([{ id: '123', role: 'assistant', content: '또 왔네.' }]),
    ).toBeNull();
  });

  it('does not recover a card whose chips are gone', () => {
    expect(identifyPendingNudgeCard([{ ...idleMusicCard(), suggestedReplies: [] }])).toBeNull();
    expect(
      identifyPendingNudgeCard([{ ...idleMusicCard(), suggestedReplies: ['▶ 재생'] }]),
    ).toBeNull();
  });
});

describe('recoverIdleMusicOffer', () => {
  it('rebuilds the offer with the mood the card was written from', () => {
    const card = identifyPendingNudgeCard([idleMusicCard('ambient')])!;
    expect(recoverIdleMusicOffer(card)).toEqual({
      playPrompt: '▶ 재생',
      dismissPrompt: '다음에',
      query: QUERY,
      mood: 'ambient',
      offeredAt: MUSIC_CARD_STAMP,
    });
  });

  // The bug this split fixes: an upbeat taste bias outvotes the working-hours
  // default, and the card then opened with "just starting your day" at 3pm.
  // The clock half must not move when the mood does, and vice versa.
  it('states the clock and the mood independently', () => {
    const afternoonUpbeat = buildIdleMusicCardLine('working', 'upbeat', 'ko');
    expect(afternoonUpbeat).toContain(IDLE_MUSIC_TIME_LINES.ko.working);
    expect(afternoonUpbeat).toContain(IDLE_MUSIC_MOOD_OFFERS.ko.upbeat);
    expect(afternoonUpbeat).not.toContain(IDLE_MUSIC_TIME_LINES.ko.morning);
    // ...and the mood is still what comes back out.
    expect(extractCardMusicMood(afternoonUpbeat)).toBe('upbeat');
  });

  // Cards written before the split hold the old one-sentence form. They are
  // still in transcripts, and their chips must still resolve.
  it('recovers the mood from a card written before the line was split', () => {
    const legacy = '이제 하루 시작하는 참이네. 기분 올릴 만한 곡 틀어줄까?';
    expect(legacy).toBe(buildIdleMusicCardLine('morning', 'upbeat', 'ko'));
    expect(extractCardMusicMood(legacy)).toBe('upbeat');
  });

  it('recovers the mood for every language, mood and day phase', () => {
    for (const lang of ['ko', 'ja', 'zh', 'en'] as const) {
      for (const mood of ['focus', 'chill', 'upbeat', 'ambient'] as const) {
        for (const phase of ['morning', 'working', 'evening', 'late'] as const) {
          const line = buildIdleMusicCardLine(phase, mood, lang);
          expect(extractCardMusicMood(line), `${lang}/${mood}/${phase}`).toBe(mood);
        }
        const content = `${buildIdleMusicCardLine('late', mood, lang)}\n🎵 Pick: "${QUERY}"`;
        expect(extractCardMusicMood(content), `${lang}/${mood}`).toBe(mood);
      }
    }
  });

  it('leaves mood null for the re-roll card rather than inventing one', () => {
    const card = identifyPendingNudgeCard([tasteMusicCard()])!;
    expect(recoverIdleMusicOffer(card)).toEqual({
      playPrompt: '▶ 재생',
      dismissPrompt: '다른 거',
      query: QUERY,
      mood: null,
      offeredAt: 1786728999999,
    });
  });

  it('recovers the genre-seed card the same way as the re-roll card', () => {
    const card = identifyPendingNudgeCard([tasteMusicCard('aoi-taste-seed-1786729111111')])!;
    expect(recoverIdleMusicOffer(card)).toEqual({
      playPrompt: '▶ 재생',
      dismissPrompt: '다른 거',
      query: QUERY,
      mood: null,
      offeredAt: 1786729111111,
    });
  });

  it('leaves an undateable card stale rather than dating it now', () => {
    const card = identifyPendingNudgeCard([{ ...idleMusicCard(), id: 'aoi-idle-music-card' }])!;
    expect(recoverIdleMusicOffer(card)?.offeredAt).toBe(0);
  });

  it('prefers the explicit search-query line over the quoted pick', () => {
    expect(extractCardMusicQuery('🎵 추천: "quoted pick"\nYouTube 검색어: `explicit query`')).toBe(
      'explicit query',
    );
  });

  it('keeps a pick whose own title contains quotes intact', () => {
    const title = 'KATSEYE "Gnarly" Official MV';
    expect(extractCardMusicQuery(`🎵 추천 (네 취향 반영): "${title}"`)).toBe(title);
  });

  it('returns null when no query is recoverable', () => {
    const card = identifyPendingNudgeCard([
      { ...idleMusicCard(), content: buildIdleMusicCardLine('late', 'ambient', 'ko') },
    ])!;
    expect(recoverIdleMusicOffer(card)).toBeNull();
  });
});

describe('reconcileRecoveredIdleMusicOffer', () => {
  const stored = {
    playPrompt: '▶ 재생',
    dismissPrompt: '다음에',
    query: 'stored pick',
    mood: 'focus' as const,
    offeredAt: MUSIC_CARD_STAMP,
  };
  const cardNaming = (query: string) => `늦은 시간이라 조용하네. 은은한 사운드 하나 깔아줄까?
🎵 추천: "${query}"`;

  it('falls back to storage only when the card names the stored pick', () => {
    expect(reconcileRecoveredIdleMusicOffer(null, stored, cardNaming('stored pick'))).toBe(stored);
    expect(reconcileRecoveredIdleMusicOffer(null, null, cardNaming('stored pick'))).toBeNull();
  });

  // Trusting storage blind is how a chip plays a pick the card never named --
  // the same unconditional fallback that kept a dead news offer armed.
  it('refuses a stored pick the card on screen does not mention', () => {
    expect(
      reconcileRecoveredIdleMusicOffer(null, stored, cardNaming('a different pick')),
    ).toBeNull();
    expect(reconcileRecoveredIdleMusicOffer(null, stored, '')).toBeNull();
  });

  it('lets the card on screen win over a stored offer for a different pick', () => {
    // Two browsers on the same session: this one still holds an unanswered
    // offer while the shared transcript has moved on to a newer card. The chips
    // are identical, so trusting storage would play the previous pick.
    const recovered = { ...stored, query: 'card pick', mood: 'ambient' as const };
    expect(reconcileRecoveredIdleMusicOffer(recovered, stored, cardNaming('card pick'))).toEqual(
      recovered,
    );
  });

  it('merges the same offer: card chip labels, stored mood', () => {
    // The re-roll card prints no mood, and the user may have switched language
    // since the card was posted -- each side knows something the other cannot.
    const recovered = {
      playPrompt: '▶ Play',
      dismissPrompt: 'Not now',
      query: 'stored pick',
      mood: null,
      offeredAt: MUSIC_CARD_STAMP,
    };
    expect(reconcileRecoveredIdleMusicOffer(recovered, stored, cardNaming('stored pick'))).toEqual({
      playPrompt: '▶ Play',
      dismissPrompt: 'Not now',
      query: 'stored pick',
      mood: 'focus',
      offeredAt: MUSIC_CARD_STAMP,
    });
  });

  it('keeps the mood the card itself states', () => {
    const recovered = { ...stored, mood: 'upbeat' as const };
    expect(
      reconcileRecoveredIdleMusicOffer(recovered, stored, cardNaming('stored pick'))?.mood,
    ).toBe('upbeat');
  });
});

describe('recoverNewsOffer', () => {
  it('resolves the article id and category by matching the headline on disk', () => {
    const card = identifyPendingNudgeCard([newsCard()])!;
    expect(recoverNewsOffer(card, [newsCandidate({ id: 'a-9', category: 'corporate' })])).toEqual({
      playPrompt: '📰 관심 있어',
      dismissPrompt: '지금은 됐어',
      articleId: 'a-9',
      category: 'corporate',
      title: HEADLINE,
      offeredAt: 1786440518362,
    });
  });

  // The card id carries the emit time, and it is the only record of the offer's
  // age once localStorage is out of the picture. An offer that cannot be dated
  // cannot be aged out, so it must not be rebuilt at all.
  it('dates the offer from the card id and refuses a card without a stamp', () => {
    const stamped = identifyPendingNudgeCard([newsCard()])!;
    expect(recoverNewsOffer(stamped, [newsCandidate()])?.offeredAt).toBe(1786440518362);
    const unstamped = identifyPendingNudgeCard([{ ...newsCard(), id: 'aoi-news-card' }])!;
    expect(recoverNewsOffer(unstamped, [newsCandidate()])).toBeNull();
  });

  it('parses the stamp out of a card id, or reports it as unknown', () => {
    expect(parseNudgeCardStamp('aoi-news-1786440518362')).toBe(1786440518362);
    expect(parseNudgeCardStamp('aoi-idle-music-1786440518362')).toBe(1786440518362);
    expect(parseNudgeCardStamp('aoi-news-card')).toBeNull();
    expect(parseNudgeCardStamp('aoi-news-42')).toBeNull();
  });

  it('keeps a headline that itself contains quotes intact', () => {
    const quoted = 'Ransomware crew claims "full access" to vendor network';
    const card = identifyPendingNudgeCard([newsCard(quoted)])!;
    expect(extractCardNewsTitle(card.content)).toBe(quoted);
    expect(recoverNewsOffer(card, [newsCandidate({ title: quoted })])?.articleId).toBe('article-1');
  });

  it('prefers the longest containment match when no title matches exactly', () => {
    const card = identifyPendingNudgeCard([newsCard(`${HEADLINE} — analysis`)])!;
    const recovered = recoverNewsOffer(card, [
      newsCandidate({ id: 'short', title: 'BDTHEMES SUPPLY CHAIN ATTACK' }),
      newsCandidate({ id: 'long', title: HEADLINE }),
    ]);
    expect(recovered?.articleId).toBe('long');
  });

  it('returns null when the article aged out of the local store', () => {
    const card = identifyPendingNudgeCard([newsCard()])!;
    expect(recoverNewsOffer(card, [])).toBeNull();
    expect(
      recoverNewsOffer(card, [newsCandidate({ title: 'Something else entirely' })]),
    ).toBeNull();
  });
});

describe('recoverTastePoll / recoverPreferencePoll', () => {
  it('maps every chip back to the option id that records the answer', () => {
    const card = identifyPendingNudgeCard([tastePollCard()])!;
    expect(recoverTastePoll(card)).toEqual({
      questionId: TASTE_QUESTION.id,
      options: TASTE_QUESTION.options.map((option) => ({
        id: option.id,
        label: option.labels.ko,
      })),
    });
  });

  it('recovers a preference poll from the static bank', () => {
    const card = identifyPendingNudgeCard([preferencePollCard()])!;
    expect(recoverPreferencePoll(card)).toEqual({
      questionId: PREFERENCE_QUESTION.id,
      options: PREFERENCE_QUESTION.options.map((option) => ({
        id: option.id,
        label: option.labels.ko,
      })),
    });
  });

  it('recovers a card posted in a language the user has since switched away from', () => {
    const card = identifyPendingNudgeCard([preferencePollCard('en')])!;
    const recovered = recoverPreferencePoll(card);
    expect(recovered?.questionId).toBe(PREFERENCE_QUESTION.id);
    expect(recovered?.options.map((option) => option.label)).toEqual(
      PREFERENCE_QUESTION.options.map((option) => option.labels.en),
    );
  });

  it('recovers an Aoi-generated question that is not in the static bank', () => {
    const generated = {
      id: 'gen-1',
      category: 'interest_depth',
      generated: true,
      prompts: { ko: '커널 후킹, 얼마나 더 파고들래?', ja: 'x', zh: 'y', en: 'z' },
      options: [
        { id: 'deep', labels: { ko: '깊게', ja: 'a', zh: 'b', en: 'c' }, learn: {} },
        { id: 'light', labels: { ko: '가볍게', ja: 'd', zh: 'e', en: 'f' }, learn: {} },
      ],
    };
    const card = identifyPendingNudgeCard([
      {
        id: 'aoi-preference-poll-9',
        role: 'assistant',
        content: generated.prompts.ko,
        suggestedReplies: ['깊게', '가볍게'],
      },
    ])!;
    expect(recoverPreferencePoll(card, [generated as never])).toEqual({
      questionId: 'gen-1',
      options: [
        { id: 'deep', label: '깊게' },
        { id: 'light', label: '가볍게' },
      ],
    });
  });

  it('refuses a partial match rather than recording the wrong answer', () => {
    // The bank was edited between asking and answering: one chip no longer maps
    // to an option, so the whole recovery is abandoned.
    const card = identifyPendingNudgeCard([
      {
        ...tastePollCard(),
        suggestedReplies: [TASTE_QUESTION.options[0].labels.ko, '없는 선택지'],
      },
    ])!;
    expect(recoverTastePoll(card)).toBeNull();
  });

  it('returns null for a question that is no longer in any bank', () => {
    const card = identifyPendingNudgeCard([
      {
        id: 'aoi-preference-poll-9',
        role: 'assistant',
        content: '삭제된 질문이야?',
        suggestedReplies: ['하나', '둘'],
      },
    ])!;
    expect(recoverPreferencePoll(card)).toBeNull();
  });

  it('does not cross-recover between card kinds', () => {
    const musicCard = identifyPendingNudgeCard([idleMusicCard()])!;
    expect(recoverTastePoll(musicCard)).toBeNull();
    expect(recoverPreferencePoll(musicCard)).toBeNull();
    expect(recoverNewsOffer(musicCard, [newsCandidate()])).toBeNull();
    const poll = identifyPendingNudgeCard([tastePollCard()])!;
    expect(recoverIdleMusicOffer(poll)).toBeNull();
  });
});

describe('degenerate cards', () => {
  it('skips messages that are neither user nor assistant', () => {
    const card = identifyPendingNudgeCard([
      idleMusicCard(),
      { id: 'sys-1', role: 'system', content: 'session resumed' },
    ]);
    expect(card?.kind).toBe('idle-music');
  });

  it('returns null instead of guessing from empty card text', () => {
    expect(extractCardMusicMood('')).toBeNull();
    expect(extractCardNewsTitle('📰 no quoted headline here')).toBeNull();
    const blankNews = identifyPendingNudgeCard([{ ...newsCard(), content: '' }])!;
    expect(recoverNewsOffer(blankNews, [newsCandidate()])).toBeNull();
    const blankPoll = identifyPendingNudgeCard([{ ...tastePollCard(), content: '   ' }])!;
    expect(recoverTastePoll(blankPoll)).toBeNull();
  });
});

describe('isAoiNewsPlayChip', () => {
  it('matches the interested chip in every language, with or without emoji presentation', () => {
    for (const text of [
      '📰 관심 있어',
      '📰 気になる',
      '📰 有兴趣',
      '📰 Interested',
      '📰️ 관심 있어',
    ]) {
      expect(isAoiNewsPlayChip(text), text).toBe(true);
    }
  });

  it('does not claim the dismiss chip or ordinary text', () => {
    for (const text of ['지금은 됐어', '관심 있어', '📰 뉴스 보여줘', '▶ 재생', '']) {
      expect(isAoiNewsPlayChip(text), text).toBe(false);
    }
  });
});
