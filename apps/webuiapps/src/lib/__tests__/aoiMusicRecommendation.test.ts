import { describe, expect, it } from 'vitest';
import {
  AOI_MUSIC_MOODS,
  buildAoiMusicRecommendation,
  chooseAoiMusicMood,
  composeAoiMusicQuery,
  dayPhaseForHour,
  type AoiMusicMood,
} from '../aoiMusicRecommendation';
import {
  DEFAULT_AOI_IDLE_MUSIC_STATE,
  recordIdleMusicOffered,
  type AoiIdleMusicLearningState,
} from '../aoiIdleMusicNudge';

describe('chooseAoiMusicMood — time-of-day default', () => {
  it('maps each part of the day to its default mood', () => {
    expect(chooseAoiMusicMood(8)).toBe('upbeat'); // morning
    expect(chooseAoiMusicMood(14)).toBe('focus'); // working hours
    expect(chooseAoiMusicMood(20)).toBe('chill'); // evening
    expect(chooseAoiMusicMood(2)).toBe('ambient'); // late night
    // Boundaries
    expect(chooseAoiMusicMood(6)).toBe('upbeat');
    expect(chooseAoiMusicMood(10)).toBe('focus');
    expect(chooseAoiMusicMood(18)).toBe('chill');
    expect(chooseAoiMusicMood(23)).toBe('ambient');
  });
});

describe('dayPhaseForHour — the clock, kept apart from the mood', () => {
  it('buckets the hour on the same boundaries as the time-of-day default', () => {
    expect(dayPhaseForHour(6)).toBe('morning');
    expect(dayPhaseForHour(9)).toBe('morning');
    expect(dayPhaseForHour(10)).toBe('working');
    expect(dayPhaseForHour(17)).toBe('working');
    expect(dayPhaseForHour(18)).toBe('evening');
    expect(dayPhaseForHour(22)).toBe('evening');
    expect(dayPhaseForHour(23)).toBe('late');
    expect(dayPhaseForHour(5)).toBe('late');
  });

  // The reported card: an upbeat taste bias outvoted the working-hours default,
  // so the mood became upbeat -- and the card, keyed only on mood, announced
  // "just starting your day" at 3pm. The phase must not follow the mood.
  it('reports the real phase even when taste flips the mood away from it', () => {
    const recommendation = buildAoiMusicRecommendation({
      now: 0,
      hourOfDay: 15,
      moodFeedback: { chill: -1, upbeat: -1, focus: -2 },
      tasteMoodBias: { upbeat: 2 },
    });
    expect(recommendation.mood).toBe('upbeat');
    expect(recommendation.dayPhase).toBe('working');
  });

  it('reports the phase the hour is in when nothing outvotes the default', () => {
    const recommendation = buildAoiMusicRecommendation({ now: 0, hourOfDay: 8 });
    expect(recommendation.mood).toBe('upbeat');
    expect(recommendation.dayPhase).toBe('morning');
  });
});

describe('chooseAoiMusicMood — learning from feedback', () => {
  it('keeps the time default when there is no feedback', () => {
    expect(chooseAoiMusicMood(14, {})).toBe('focus');
    expect(chooseAoiMusicMood(14, undefined)).toBe('focus');
  });

  it('lets a strongly-accepted mood outrank the time default', () => {
    // Working hours default to focus (+1); chill has learned +2 -> chill wins.
    expect(chooseAoiMusicMood(14, { chill: 2 })).toBe('chill');
  });

  it('does not flip on a weak signal that only ties the time default', () => {
    // chill learned +1 ties focus's base +1; ties resolve to the time default.
    expect(chooseAoiMusicMood(14, { chill: 1 })).toBe('focus');
  });

  it('pushes down a repeatedly-skipped default mood', () => {
    // focus default (+1) minus learned -2 = -1; the highest remaining score is 0,
    // and the first mood at 0 in iteration order (chill) wins deterministically.
    expect(chooseAoiMusicMood(14, { focus: -2 })).toBe('chill');
  });
});

describe('buildAoiMusicRecommendation', () => {
  const NOW = 1_700_000_000_000;

  it('returns a complete recommendation shaped for the suggestion card', () => {
    const rec = buildAoiMusicRecommendation({ now: NOW, hourOfDay: 14 });
    expect(rec.mood).toBe('focus');
    expect(rec.query).toBe('lofi hip hop radio beats to relax study to');
    expect(rec.why).toContain('focus music');
    expect(rec.cooldownKey).toBe('music:focus:lofi-hip-hop-radio-beats-to-relax-study-to');
    expect(rec.source).toBe('pool');
    expect(AOI_MUSIC_MOODS).toContain(rec.mood);
  });

  it('avoids a recently-used query and moves to the next in the mood pool', () => {
    const first = buildAoiMusicRecommendation({ now: NOW, hourOfDay: 14 });
    const second = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      recentQueries: [first.query],
    });
    expect(second.query).not.toBe(first.query);
    expect(second.mood).toBe('focus');
  });

  it('falls back to the least-recently-offered query when every pooled query is recent', () => {
    const focusPool = [
      'lofi hip hop radio beats to relax study to',
      'deep focus music for coding',
      'instrumental concentration music',
      'programming ambient focus mix',
    ];
    // recentQueries is newest-first, so the last entry is the least recent one.
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      recentQueries: focusPool,
    });
    expect(rec.query).toBe(focusPool[3]);
  });

  it('keeps cycling the pool across repeated offers instead of repeating one query (regression)', () => {
    // Simulate the real ChatPanel loop: build a recommendation, record the offer,
    // feed the updated state back in. Before the LRU fallback, offer 5 onward
    // returned the same query forever because the recent list only reordered and
    // its length (the old rotation index) stopped changing.
    let state: AoiIdleMusicLearningState = DEFAULT_AOI_IDLE_MUSIC_STATE;
    const picks: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const rec = buildAoiMusicRecommendation({
        now: NOW + i,
        hourOfDay: 14,
        recentQueries: state.recentQueries,
        moodFeedback: state.moodFeedback,
      });
      picks.push(rec.query);
      state = recordIdleMusicOffered(state, { query: rec.query, now: NOW + i });
    }
    for (let i = 1; i < picks.length; i += 1) {
      expect(picks[i]).not.toBe(picks[i - 1]);
    }
    // Each lap of 4 offers covers the whole focus pool again.
    expect(new Set(picks.slice(0, 4)).size).toBe(4);
    expect(new Set(picks.slice(4, 8)).size).toBe(4);
    expect(new Set(picks.slice(8, 12)).size).toBe(4);
  });

  it('ranks a duplicated recent entry by its most recent occurrence', () => {
    const focusPool = [
      'lofi hip hop radio beats to relax study to',
      'deep focus music for coding',
      'instrumental concentration music',
      'programming ambient focus mix',
    ];
    // pool[0] appears twice (newest and, as a stale duplicate, oldest). Its rank
    // must come from the newest occurrence, so the fallback picks pool[1] -- the
    // true least-recent -- instead of re-offering the query from moments ago.
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      recentQueries: [
        focusPool[0],
        focusPool[3],
        focusPool[2],
        focusPool[1],
        focusPool[0].toUpperCase(),
      ],
    });
    expect(rec.query).toBe(focusPool[1]);
  });

  it('is case-insensitive when matching recent queries', () => {
    const first = buildAoiMusicRecommendation({ now: NOW, hourOfDay: 14 });
    const second = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      recentQueries: [first.query.toUpperCase()],
    });
    expect(second.query).not.toBe(first.query);
  });

  it('clamps an out-of-range hourOfDay instead of misbucketing', () => {
    // 99 -> clamped to 23 -> ambient.
    expect(buildAoiMusicRecommendation({ now: NOW, hourOfDay: 99 }).mood).toBe('ambient');
    // -5 -> clamped to 0 -> ambient (late night bucket).
    expect(buildAoiMusicRecommendation({ now: NOW, hourOfDay: -5 }).mood).toBe('ambient');
  });

  it('derives the hour from now when hourOfDay is omitted', () => {
    const rec = buildAoiMusicRecommendation({ now: NOW });
    // Whatever the local hour resolves to, the result is a valid, complete rec.
    expect(AOI_MUSIC_MOODS).toContain(rec.mood);
    expect(rec.query.length).toBeGreaterThan(0);
    expect(rec.cooldownKey.startsWith(`music:${rec.mood}:`)).toBe(true);
  });

  it('honors learned feedback end to end', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      moodFeedback: { chill: 3 } as Partial<Record<AoiMusicMood, number>>,
    });
    expect(rec.mood).toBe('chill');
    expect(rec.query).toBe('chill lofi evening mix');
  });
});

describe('composeAoiMusicQuery', () => {
  it('folds the mood into the seed, in the conversation language', () => {
    expect(composeAoiMusicQuery('에스파', 'upbeat', 'ko')).toBe('에스파 신나는 노래 모음');
    expect(composeAoiMusicQuery('에스파', 'ambient', 'ko')).toBe('에스파 은은한 앰비언트 믹스');
    expect(composeAoiMusicQuery('IVE', 'focus', 'en')).toBe('IVE focus playlist');
    expect(composeAoiMusicQuery('IVE', 'chill', 'en')).toBe('IVE chill mix');
  });

  it('does not bolt a second noun onto a seed that already names a playlist', () => {
    expect(composeAoiMusicQuery('2026년 8월 여돌 노래모음', 'upbeat', 'ko')).toBe(
      '신나는 2026년 8월 여돌 노래모음',
    );
    expect(composeAoiMusicQuery('city pop mix', 'chill', 'en')).toBe('chill city pop mix');
    expect(composeAoiMusicQuery('kpop hits playlist', 'focus', 'en')).toBe(
      'focus kpop hits playlist',
    );
  });

  it('falls back to English for a language it has no terms for', () => {
    expect(composeAoiMusicQuery('IVE', 'upbeat', 'de' as never)).toBe('IVE upbeat mix');
  });

  it('defaults to English when no language is given', () => {
    expect(composeAoiMusicQuery('IVE', 'upbeat')).toBe('IVE upbeat mix');
  });

  it('returns nothing for an empty seed and collapses whitespace', () => {
    expect(composeAoiMusicQuery('   ', 'upbeat', 'en')).toBe('');
    expect(composeAoiMusicQuery('  IVE   I  AM ', 'focus', 'en')).toBe('IVE I AM focus playlist');
  });
});

describe('buildAoiMusicRecommendation — personal taste signals', () => {
  const NOW = 1_700_000_000_000;
  const FOCUS_POOL = [
    'lofi hip hop radio beats to relax study to',
    'deep focus music for coding',
    'instrumental concentration music',
    'programming ambient focus mix',
  ];

  // A personal candidate is a SEED, not a finished query. Handing one back
  // verbatim is what made a search the user typed ("에스파") come back as a
  // recommendation, and it left the mood reaching only the card's opening line.
  it('composes the mood into a personal seed instead of echoing it back', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: ['IVE I AM'],
    });
    expect(rec.query).toBe('IVE I AM focus playlist');
    expect(rec.source).toBe('personal');
    expect(rec.cooldownKey).toBe('music:focus:IVE-I-AM-focus-playlist');
  });

  // Two seeds can compose to the same query (a bare artist and the same artist
  // written with padding), and an unusable seed composes to nothing. Neither may
  // take up a candidate slot.
  it('drops duplicate and unusable seeds after composing', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: ['IVE', '  IVE  ', '   ', 'city pop'],
      preferPersonal: true,
      recentQueries: ['IVE focus playlist'],
    });
    // The duplicate did not become a second candidate, so the next seed is used.
    expect(rec.query).toBe('city pop focus playlist');
    expect(rec.source).toBe('personal');
  });

  it('gives the same seed a different query per mood', () => {
    const queries = new Set(
      ([2, 8, 14, 20] as const).map(
        (hourOfDay) =>
          buildAoiMusicRecommendation({ now: NOW, hourOfDay, personalQueries: ['IVE I AM'] }).query,
      ),
    );
    // Four moods, four distinct queries: one seed is no longer spent on the
    // first card that used it.
    expect(queries.size).toBe(4);
  });

  it('keeps preferring personal after a personal pick (no forced pool mix)', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: ['IVE I AM', 'city pop'],
      recentQueries: ['IVE I AM focus playlist'],
      preferPersonal: true,
    });
    expect(rec.query).toBe('city pop focus playlist');
    expect(rec.source).toBe('personal');
  });

  it('can still alternate to the pool when preferPersonal is false', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: ['IVE I AM', 'city pop'],
      recentQueries: ['IVE I AM focus playlist'],
      preferPersonal: false,
    });
    expect(rec.query).toBe(FOCUS_POOL[0]);
    expect(rec.source).toBe('pool');
  });

  // Changed deliberately: strict personal mode used to recycle its handful
  // forever and never reach the pool, so a user with a few seeds saw the same
  // picks for good. The pool is only reached once every seed is spent.
  it('falls to the pool once every personal seed has been offered for this mood', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: ['IVE I AM'],
      preferPersonal: true,
      recentQueries: ['IVE I AM focus playlist'],
    });
    expect(rec.query).toBe(FOCUS_POOL[0]);
    expect(rec.source).toBe('pool');
  });

  it('cycles the least-recently-offered personal query when the pool is spent too', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: ['IVE I AM', 'city pop'],
      preferPersonal: true,
      recentQueries: ['city pop focus playlist', 'IVE I AM focus playlist', ...FOCUS_POOL],
    });
    // Oldest personal offer wins (higher recency rank).
    expect(rec.query).toBe('IVE I AM focus playlist');
    expect(rec.source).toBe('personal');
  });

  it('considers more than eight personal candidates', () => {
    const personals = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      personalQueries: personals,
      preferPersonal: true,
      recentQueries: personals.slice(0, 8).map((seed) => `${seed} focus playlist`),
    });
    expect(rec.query).toBe('p9 focus playlist');
    expect(rec.source).toBe('personal');
  });

  it('lets taste bias steer the mood over the time default', () => {
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      tasteMoodBias: { chill: 2 },
    });
    expect(rec.mood).toBe('chill');
  });

  it('keeps learned skip feedback stronger than taste bias', () => {
    // Taste says chill (+2) but the user kept skipping chill cards (-3):
    // the focus time default (+1) wins again.
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      tasteMoodBias: { chill: 2 },
      moodFeedback: { chill: -3 },
    });
    expect(rec.mood).toBe('focus');
  });
});
