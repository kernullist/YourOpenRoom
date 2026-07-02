import { describe, expect, it } from 'vitest';
import {
  AOI_MUSIC_MOODS,
  buildAoiMusicRecommendation,
  chooseAoiMusicMood,
  type AoiMusicMood,
} from '../aoiMusicRecommendation';

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

  it('rotates deterministically when every pooled query is recent', () => {
    const focusPool = [
      'lofi hip hop radio beats to relax study to',
      'deep focus music for coding',
      'instrumental concentration music',
      'programming ambient focus mix',
    ];
    // All four used -> rotate by recent count % pool length (4 % 4 = 0).
    const rec = buildAoiMusicRecommendation({
      now: NOW,
      hourOfDay: 14,
      recentQueries: focusPool,
    });
    expect(rec.query).toBe(focusPool[0]);
    expect(focusPool).toContain(rec.query);
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
