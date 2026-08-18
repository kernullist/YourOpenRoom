import { describe, expect, it } from 'vitest';

import { TASTE_POLL_QUESTIONS } from '../aoiMusicTaste';
import type { AoiNewsCandidate } from '../aoiNewsNudge';
import { PREFERENCE_POLL_QUESTIONS } from '../aoiPreferencePoll';
import {
  IDLE_MUSIC_MOOD_LINES,
  extractCardMusicMood,
  extractCardMusicQuery,
  extractCardNewsTitle,
  identifyPendingNudgeCard,
  isAoiNewsPlayChip,
  recoverIdleMusicOffer,
  recoverNewsOffer,
  recoverPreferencePoll,
  recoverTastePoll,
  reconcileRecoveredIdleMusicOffer,
  type NudgeCardMessage,
} from '../aoiPendingOfferRecovery';

const QUERY = '2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST';
const HEADLINE = 'BDTHEMES SUPPLY CHAIN ATTACK POISONS JSON TO CREATE ROGUE WORDPRESS ADMINS';

// Mirrors buildIdleMusicCardCopy in ChatPanel.
function idleMusicCard(
  mood: 'focus' | 'chill' | 'upbeat' | 'ambient' = 'ambient',
): NudgeCardMessage {
  return {
    id: 'aoi-idle-music-1786728972470',
    role: 'assistant',
    content: `${IDLE_MUSIC_MOOD_LINES.ko[mood]}\n🎵 추천 (네 취향 반영): "${QUERY}"`,
    suggestedReplies: ['▶ 재생', '다음에'],
  };
}

// Mirrors buildAoiMusicTasteRecommendCopy (the re-roll card): no mood line.
function tasteMusicCard(): NudgeCardMessage {
  return {
    id: 'aoi-taste-music-1786728999999',
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
    });
  });

  it('recovers the mood for every language and mood the card is emitted in', () => {
    for (const lang of ['ko', 'ja', 'zh', 'en'] as const) {
      for (const mood of ['focus', 'chill', 'upbeat', 'ambient'] as const) {
        const content = `${IDLE_MUSIC_MOOD_LINES[lang][mood]}\n🎵 Pick: "${QUERY}"`;
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
    });
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
      { ...idleMusicCard(), content: IDLE_MUSIC_MOOD_LINES.ko.ambient },
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
  };

  it('falls back to storage when the card yields nothing', () => {
    expect(reconcileRecoveredIdleMusicOffer(null, stored)).toBe(stored);
    expect(reconcileRecoveredIdleMusicOffer(null, null)).toBeNull();
  });

  it('lets the card on screen win over a stored offer for a different pick', () => {
    // Two browsers on the same session: this one still holds an unanswered
    // offer while the shared transcript has moved on to a newer card. The chips
    // are identical, so trusting storage would play the previous pick.
    const recovered = { ...stored, query: 'card pick', mood: 'ambient' as const };
    expect(reconcileRecoveredIdleMusicOffer(recovered, stored)).toEqual(recovered);
  });

  it('merges the same offer: card chip labels, stored mood', () => {
    // The re-roll card prints no mood, and the user may have switched language
    // since the card was posted -- each side knows something the other cannot.
    const recovered = {
      playPrompt: '▶ Play',
      dismissPrompt: 'Not now',
      query: 'stored pick',
      mood: null,
    };
    expect(reconcileRecoveredIdleMusicOffer(recovered, stored)).toEqual({
      playPrompt: '▶ Play',
      dismissPrompt: 'Not now',
      query: 'stored pick',
      mood: 'focus',
    });
  });

  it('keeps the mood the card itself states', () => {
    const recovered = { ...stored, mood: 'upbeat' as const };
    expect(reconcileRecoveredIdleMusicOffer(recovered, stored)?.mood).toBe('upbeat');
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
    });
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
