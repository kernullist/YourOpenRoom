import { describe, expect, it } from 'vitest';
import {
  AOI_NEWS_STATE_VERSION,
  DEFAULT_AOI_NEWS_STATE,
  DEFAULT_NEWS_COOLDOWN_MS,
  DEFAULT_NEWS_MIN_IDLE_MS,
  pickInterestingArticle,
  recordNewsOffered,
  recordNewsOutcome,
  shouldOfferNewsNudge,
  type AoiNewsCandidate,
  type AoiNewsCategory,
  type AoiNewsLearningState,
  type ShouldOfferNewsNudgeInput,
} from '../aoiNewsNudge';

const NOW = 1_700_000_000_000;

function baseOfferInput(
  overrides: Partial<ShouldOfferNewsNudgeInput> = {},
): ShouldOfferNewsNudgeInput {
  return {
    now: NOW,
    userIdleMs: DEFAULT_NEWS_MIN_IDLE_MS,
    autonomyEnabled: true,
    quietMode: false,
    newsAppActive: false,
    lastOfferedAt: 0,
    ...overrides,
  };
}

function candidate(overrides: Partial<AoiNewsCandidate> = {}): AoiNewsCandidate {
  return {
    id: 'live-feed-a',
    title: 'A',
    category: 'tech',
    summary: 'summary',
    publishedAt: new Date(NOW).toISOString(),
    isLive: true,
    ...overrides,
  };
}

describe('shouldOfferNewsNudge — gates', () => {
  it('offers when every gate passes', () => {
    expect(shouldOfferNewsNudge(baseOfferInput())).toBe(true);
  });

  it('does not offer when autonomy is disabled', () => {
    expect(shouldOfferNewsNudge(baseOfferInput({ autonomyEnabled: false }))).toBe(false);
  });

  it('does not offer in quiet mode', () => {
    expect(shouldOfferNewsNudge(baseOfferInput({ quietMode: true }))).toBe(false);
  });

  it('does not offer while the news app is already active', () => {
    expect(shouldOfferNewsNudge(baseOfferInput({ newsAppActive: true }))).toBe(false);
  });

  it('does not offer when idle time is unknown or not finite', () => {
    expect(shouldOfferNewsNudge(baseOfferInput({ userIdleMs: undefined }))).toBe(false);
    expect(shouldOfferNewsNudge(baseOfferInput({ userIdleMs: Number.NaN }))).toBe(false);
    expect(shouldOfferNewsNudge(baseOfferInput({ userIdleMs: Number.POSITIVE_INFINITY }))).toBe(
      false,
    );
  });

  it('does not offer before the minimum idle threshold', () => {
    expect(shouldOfferNewsNudge(baseOfferInput({ userIdleMs: DEFAULT_NEWS_MIN_IDLE_MS - 1 }))).toBe(
      false,
    );
  });

  it('respects a custom minimum idle threshold', () => {
    const input = baseOfferInput({ userIdleMs: 10_000, minIdleMs: 5_000 });
    expect(shouldOfferNewsNudge(input)).toBe(true);
    expect(shouldOfferNewsNudge({ ...input, minIdleMs: 20_000 })).toBe(false);
  });

  it('honors the cooldown and offers again once it elapses', () => {
    expect(
      shouldOfferNewsNudge(baseOfferInput({ lastOfferedAt: NOW - (DEFAULT_NEWS_COOLDOWN_MS - 1) })),
    ).toBe(false);
    expect(
      shouldOfferNewsNudge(baseOfferInput({ lastOfferedAt: NOW - (DEFAULT_NEWS_COOLDOWN_MS + 1) })),
    ).toBe(true);
  });

  it('respects a custom cooldown', () => {
    const input = baseOfferInput({ lastOfferedAt: NOW - 10_000, cooldownMs: 5_000 });
    expect(shouldOfferNewsNudge(input)).toBe(true);
    expect(shouldOfferNewsNudge({ ...input, cooldownMs: 20_000 })).toBe(false);
  });
});

describe('pickInterestingArticle — security-weighted selection', () => {
  it('prefers a security-relevant category over tabloid/street', () => {
    const picked = pickInterestingArticle([
      candidate({ id: 'street', category: 'street' }),
      candidate({ id: 'tech', category: 'tech' }),
      candidate({ id: 'corporate', category: 'corporate' }),
    ]);
    expect(picked?.id).toBe('tech');
  });

  it('lets learned feedback outrank the base weight', () => {
    // street base 0, but learned +3 -> beats tech base 2.
    const picked = pickInterestingArticle(
      [
        candidate({ id: 'tech', category: 'tech' }),
        candidate({ id: 'street', category: 'street' }),
      ],
      { categoryFeedback: { street: 3 } },
    );
    expect(picked?.id).toBe('street');
  });

  it('pushes down a repeatedly-skipped category', () => {
    // tech base 2 with learned -2 = 0; breaking base 2 stays -> breaking wins.
    const picked = pickInterestingArticle(
      [
        candidate({ id: 'tech', category: 'tech' }),
        candidate({ id: 'breaking', category: 'breaking' }),
      ],
      { categoryFeedback: { tech: -2 } },
    );
    expect(picked?.id).toBe('breaking');
  });

  it('breaks ties by recency (newer wins)', () => {
    const older = candidate({
      id: 'older',
      category: 'tech',
      publishedAt: new Date(NOW - 10_000).toISOString(),
    });
    const newer = candidate({
      id: 'newer',
      category: 'tech',
      publishedAt: new Date(NOW).toISOString(),
    });
    expect(pickInterestingArticle([older, newer])?.id).toBe('newer');
    // Order-independent.
    expect(pickInterestingArticle([newer, older])?.id).toBe('newer');
  });

  it('skips recently-offered ids', () => {
    const picked = pickInterestingArticle(
      [
        candidate({ id: 'tech', category: 'tech' }),
        candidate({ id: 'breaking', category: 'breaking' }),
      ],
      { recentArticleIds: ['tech'] },
    );
    expect(picked?.id).toBe('breaking');
  });

  it('ignores non-live (seed/fiction) articles', () => {
    const picked = pickInterestingArticle([
      candidate({ id: 'seed', category: 'tech', isLive: false }),
      candidate({ id: 'live', category: 'corporate', isLive: true }),
    ]);
    expect(picked?.id).toBe('live');
  });

  it('scores an unknown runtime category as zero without throwing (defensive)', () => {
    const weird = candidate({ id: 'weird', category: 'unknown' as AoiNewsCategory });
    // Alone it is still eligible (score 0).
    expect(pickInterestingArticle([weird])?.id).toBe('weird');
    // But a tech article (base weight 2) outranks a zero-weight unknown category.
    expect(pickInterestingArticle([weird, candidate({ id: 'tech', category: 'tech' })])?.id).toBe(
      'tech',
    );
  });

  it('returns null when nothing is eligible', () => {
    expect(pickInterestingArticle([])).toBeNull();
    expect(pickInterestingArticle([candidate({ isLive: false })])).toBeNull();
    expect(
      pickInterestingArticle([candidate({ id: 'a' })], { recentArticleIds: ['a'] }),
    ).toBeNull();
  });

  it('treats an unparseable publishedAt as oldest without throwing', () => {
    const good = candidate({
      id: 'good',
      category: 'tech',
      publishedAt: new Date(NOW).toISOString(),
    });
    const bad = candidate({ id: 'bad', category: 'tech', publishedAt: 'not-a-date' });
    expect(pickInterestingArticle([bad, good])?.id).toBe('good');
  });
});

describe('recordNewsOffered', () => {
  it('adds the article id newest-first and stamps the cooldown', () => {
    const next = recordNewsOffered(DEFAULT_AOI_NEWS_STATE, { articleId: 'live-1', now: NOW });
    expect(next.recentArticleIds[0]).toBe('live-1');
    expect(next.lastOfferedAt).toBe(NOW);
    expect(next.version).toBe(AOI_NEWS_STATE_VERSION);
  });

  it('de-duplicates, moving the repeat to the front', () => {
    let state = recordNewsOffered(DEFAULT_AOI_NEWS_STATE, { articleId: 'a', now: NOW });
    state = recordNewsOffered(state, { articleId: 'b', now: NOW + 1 });
    state = recordNewsOffered(state, { articleId: 'a', now: NOW + 2 });
    expect(state.recentArticleIds).toEqual(['a', 'b']);
  });

  it('caps the recent-id history at 40 entries', () => {
    let state: AoiNewsLearningState = DEFAULT_AOI_NEWS_STATE;
    for (let i = 0; i < 50; i += 1) {
      state = recordNewsOffered(state, { articleId: `id-${i}`, now: NOW + i });
    }
    expect(state.recentArticleIds).toHaveLength(40);
    expect(state.recentArticleIds[0]).toBe('id-49');
  });

  it('ignores a blank id but still stamps the cooldown', () => {
    const next = recordNewsOffered(DEFAULT_AOI_NEWS_STATE, { articleId: '  ', now: NOW });
    expect(next.recentArticleIds).toEqual([]);
    expect(next.lastOfferedAt).toBe(NOW);
  });

  it('does not mutate the input state', () => {
    const state: AoiNewsLearningState = {
      version: AOI_NEWS_STATE_VERSION,
      categoryFeedback: {},
      recentArticleIds: [],
      lastOfferedAt: 0,
    };
    recordNewsOffered(state, { articleId: 'a', now: NOW });
    expect(state.recentArticleIds).toEqual([]);
  });

  it('normalizes a null or version-mismatched state', () => {
    expect(recordNewsOffered(null, { articleId: 'a', now: NOW }).recentArticleIds).toEqual(['a']);
    const stale = {
      version: 99,
      categoryFeedback: { tech: 5 },
      recentArticleIds: ['x'],
      lastOfferedAt: 1,
    };
    const next = recordNewsOffered(stale as unknown as AoiNewsLearningState, {
      articleId: 'a',
      now: NOW,
    });
    expect(next.recentArticleIds).toEqual(['a']);
    expect(next.categoryFeedback).toEqual({});
  });
});

describe('recordNewsOutcome', () => {
  it('increments the category on accept and decrements on skip', () => {
    const accepted = recordNewsOutcome(DEFAULT_AOI_NEWS_STATE, {
      category: 'tech',
      accepted: true,
    });
    expect(accepted.categoryFeedback.tech).toBe(1);
    const skipped = recordNewsOutcome(accepted, { category: 'tech', accepted: false });
    expect(skipped.categoryFeedback.tech).toBe(0);
  });

  it('clamps feedback within [-3, 3]', () => {
    let state: AoiNewsLearningState = DEFAULT_AOI_NEWS_STATE;
    const bump = (accepted: boolean, times: number) => {
      for (let i = 0; i < times; i += 1) {
        state = recordNewsOutcome(state, { category: 'breaking' as AoiNewsCategory, accepted });
      }
    };
    bump(true, 6);
    expect(state.categoryFeedback.breaking).toBe(3);
    bump(false, 12);
    expect(state.categoryFeedback.breaking).toBe(-3);
  });

  it('preserves recentArticleIds and lastOfferedAt', () => {
    const seeded = recordNewsOffered(DEFAULT_AOI_NEWS_STATE, { articleId: 'a', now: NOW });
    const next = recordNewsOutcome(seeded, { category: 'tech', accepted: true });
    expect(next.recentArticleIds).toEqual(['a']);
    expect(next.lastOfferedAt).toBe(NOW);
  });

  it('does not mutate the input state', () => {
    const state: AoiNewsLearningState = {
      version: AOI_NEWS_STATE_VERSION,
      categoryFeedback: { tech: 1 },
      recentArticleIds: [],
      lastOfferedAt: 0,
    };
    recordNewsOutcome(state, { category: 'tech', accepted: true });
    expect(state.categoryFeedback.tech).toBe(1);
  });

  it('normalizes a null or version-mismatched state', () => {
    expect(
      recordNewsOutcome(null, { category: 'tech', accepted: true }).categoryFeedback.tech,
    ).toBe(1);
    const stale = {
      version: 99,
      categoryFeedback: { tech: 5 },
      recentArticleIds: ['x'],
      lastOfferedAt: 1,
    };
    const next = recordNewsOutcome(stale as unknown as AoiNewsLearningState, {
      category: 'tech',
      accepted: true,
    });
    expect(next.categoryFeedback.tech).toBe(1);
    expect(next.recentArticleIds).toEqual([]);
  });
});
