import { describe, expect, it } from 'vitest';
import {
  AOI_SALIENCE_HALF_LIVES_MS,
  rankAoiSalientItems,
  salienceFreshnessAdjustment,
  scoreAoiSalience,
} from '../aoiSalienceModel';

const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('scoreAoiSalience', () => {
  it('halves the score exactly at one half-life per kind', () => {
    const fresh = scoreAoiSalience({ kind: 'app_activity', observedAt: NOW, baseWeight: 0.8 }, NOW);
    expect(fresh.score).toBeCloseTo(0.8, 3);
    expect(fresh.decayFactor).toBeCloseTo(1, 3);

    const oneHalfLife = scoreAoiSalience(
      { kind: 'app_activity', observedAt: NOW - 30 * MINUTE, baseWeight: 0.8 },
      NOW,
    );
    expect(oneHalfLife.decayFactor).toBeCloseTo(0.5, 3);
    expect(oneHalfLife.score).toBeCloseTo(0.4, 3);
    expect(oneHalfLife.halfLifeMs).toBe(AOI_SALIENCE_HALF_LIVES_MS.app_activity);
  });

  it('decays live activity faster than durable notes (per-kind half-lives)', () => {
    const twoHoursAgo = NOW - 2 * HOUR;
    const activity = scoreAoiSalience({ kind: 'app_activity', observedAt: twoHoursAgo }, NOW);
    const note = scoreAoiSalience({ kind: 'manual_note', observedAt: twoHoursAgo }, NOW);

    expect(activity.score).toBeLessThan(note.score);
    expect(activity.decayFactor).toBeCloseTo(Math.pow(2, -4), 3);
    expect(note.decayFactor).toBeGreaterThan(0.99);
  });

  it('ramps UP toward a future scheduled moment (calendar proximity)', () => {
    const eventInTwoDays = scoreAoiSalience(
      { kind: 'calendar_metadata', observedAt: NOW + 48 * HOUR, baseWeight: 0.9 },
      NOW,
    );
    const eventInOneHour = scoreAoiSalience(
      { kind: 'calendar_metadata', observedAt: NOW + HOUR, baseWeight: 0.9 },
      NOW,
    );

    expect(eventInOneHour.score).toBeGreaterThan(eventInTwoDays.score);
    expect(eventInOneHour.reasons.join(' ')).toContain('ramps up');
  });

  it('marks signals beyond the horizon as faded but honors the pinned floor', () => {
    const faded = scoreAoiSalience(
      { kind: 'app_activity', observedAt: NOW - 6 * HOUR, baseWeight: 1 },
      NOW,
    );
    expect(faded.faded).toBe(true);
    expect(faded.reasons.join(' ')).toContain('beyond the salience horizon');

    const pinned = scoreAoiSalience(
      { kind: 'app_activity', observedAt: NOW - 6 * HOUR, baseWeight: 1, pinned: true },
      NOW,
    );
    expect(pinned.faded).toBe(false);
    expect(pinned.score).toBeCloseTo(0.3, 3);
    expect(pinned.reasons.join(' ')).toContain('pinned floor');
  });

  it('clamps malformed weights and timestamps safely', () => {
    const weird = scoreAoiSalience({ kind: 'chat', observedAt: Number.NaN, baseWeight: 42 }, NOW);
    expect(weird.score).toBeCloseTo(1, 3);
    expect(weird.ageMs).toBe(0);

    const negative = scoreAoiSalience({ kind: 'chat', observedAt: NOW, baseWeight: -3 }, NOW);
    expect(negative.score).toBe(0);
  });
});

describe('rankAoiSalientItems', () => {
  const items = [
    { id: 'old-note', kind: 'manual_note' as const, at: NOW - 6 * 24 * HOUR, weight: 0.9 },
    { id: 'live-activity', kind: 'app_activity' as const, at: NOW - 5 * MINUTE, weight: 0.6 },
    { id: 'faded-activity', kind: 'app_activity' as const, at: NOW - 8 * HOUR, weight: 1 },
    { id: 'recent-chat', kind: 'chat' as const, at: NOW - 30 * MINUTE, weight: 0.7 },
  ];

  it('ranks a fresh small signal above a stale large one and drops faded items', () => {
    const ranked = rankAoiSalientItems(
      items,
      (item) => ({ kind: item.kind, observedAt: item.at, baseWeight: item.weight }),
      { now: NOW },
    );

    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'recent-chat',
      'live-activity',
      'old-note',
    ]);
    expect(ranked.some((entry) => entry.item.id === 'faded-activity')).toBe(false);
  });

  it('honors the limit and can include faded items on request', () => {
    const ranked = rankAoiSalientItems(
      items,
      (item) => ({ kind: item.kind, observedAt: item.at, baseWeight: item.weight }),
      { now: NOW, limit: 2, includeFaded: true },
    );
    expect(ranked).toHaveLength(2);
  });
});

describe('salienceFreshnessAdjustment', () => {
  it('maps the decay factor onto the router freshness range continuously', () => {
    expect(salienceFreshnessAdjustment(1)).toBeCloseTo(0.08, 4);
    expect(salienceFreshnessAdjustment(0)).toBeCloseTo(-0.18, 4);
    expect(salienceFreshnessAdjustment(0.5)).toBeCloseTo(-0.05, 4);
    expect(salienceFreshnessAdjustment(2)).toBeCloseTo(0.08, 4);
    expect(salienceFreshnessAdjustment(-1)).toBeCloseTo(-0.18, 4);
  });
});
