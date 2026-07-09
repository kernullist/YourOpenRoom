import { describe, expect, it } from 'vitest';
import {
  AOI_MUSIC_MOODS,
  buildAoiMusicRecommendation,
  chooseAoiMusicMood,
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
