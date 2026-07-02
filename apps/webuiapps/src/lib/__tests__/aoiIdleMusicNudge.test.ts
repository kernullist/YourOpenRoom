import { describe, expect, it } from 'vitest';
import {
  AOI_IDLE_MUSIC_STATE_VERSION,
  DEFAULT_AOI_IDLE_MUSIC_STATE,
  DEFAULT_IDLE_MUSIC_COOLDOWN_MS,
  DEFAULT_IDLE_MUSIC_MIN_IDLE_MS,
  recordIdleMusicOffered,
  recordIdleMusicOutcome,
  shouldOfferIdleMusic,
  type AoiIdleMusicLearningState,
  type ShouldOfferIdleMusicInput,
} from '../aoiIdleMusicNudge';

const NOW = 1_700_000_000_000;

function baseOfferInput(
  overrides: Partial<ShouldOfferIdleMusicInput> = {},
): ShouldOfferIdleMusicInput {
  return {
    now: NOW,
    userIdleMs: DEFAULT_IDLE_MUSIC_MIN_IDLE_MS,
    autonomyEnabled: true,
    quietMode: false,
    musicActive: false,
    lastOfferedAt: 0,
    ...overrides,
  };
}

describe('shouldOfferIdleMusic — gates', () => {
  it('offers when every gate passes (idle long enough, no prior offer)', () => {
    expect(shouldOfferIdleMusic(baseOfferInput())).toBe(true);
  });

  it('does not offer when autonomy is disabled', () => {
    expect(shouldOfferIdleMusic(baseOfferInput({ autonomyEnabled: false }))).toBe(false);
  });

  it('does not offer in quiet mode', () => {
    expect(shouldOfferIdleMusic(baseOfferInput({ quietMode: true }))).toBe(false);
  });

  it('does not offer while music is already active', () => {
    expect(shouldOfferIdleMusic(baseOfferInput({ musicActive: true }))).toBe(false);
  });

  it('does not offer when idle time is unknown', () => {
    expect(shouldOfferIdleMusic(baseOfferInput({ userIdleMs: undefined }))).toBe(false);
  });

  it('does not offer when idle time is not finite', () => {
    expect(shouldOfferIdleMusic(baseOfferInput({ userIdleMs: Number.NaN }))).toBe(false);
    expect(shouldOfferIdleMusic(baseOfferInput({ userIdleMs: Number.POSITIVE_INFINITY }))).toBe(
      false,
    );
  });

  it('does not offer before the minimum idle threshold', () => {
    expect(
      shouldOfferIdleMusic(baseOfferInput({ userIdleMs: DEFAULT_IDLE_MUSIC_MIN_IDLE_MS - 1 })),
    ).toBe(false);
  });

  it('respects a custom minimum idle threshold', () => {
    const input = baseOfferInput({ userIdleMs: 10_000, minIdleMs: 5_000 });
    expect(shouldOfferIdleMusic(input)).toBe(true);
    expect(shouldOfferIdleMusic({ ...input, minIdleMs: 20_000 })).toBe(false);
  });

  it('does not offer again while the cooldown is still active', () => {
    const input = baseOfferInput({
      lastOfferedAt: NOW - (DEFAULT_IDLE_MUSIC_COOLDOWN_MS - 1),
    });
    expect(shouldOfferIdleMusic(input)).toBe(false);
  });

  it('offers again once the cooldown has elapsed', () => {
    const input = baseOfferInput({
      lastOfferedAt: NOW - (DEFAULT_IDLE_MUSIC_COOLDOWN_MS + 1),
    });
    expect(shouldOfferIdleMusic(input)).toBe(true);
  });

  it('respects a custom cooldown', () => {
    const input = baseOfferInput({ lastOfferedAt: NOW - 10_000, cooldownMs: 5_000 });
    expect(shouldOfferIdleMusic(input)).toBe(true);
    expect(shouldOfferIdleMusic({ ...input, cooldownMs: 20_000 })).toBe(false);
  });
});

describe('recordIdleMusicOffered', () => {
  it('adds the query newest-first and stamps the cooldown', () => {
    const next = recordIdleMusicOffered(DEFAULT_AOI_IDLE_MUSIC_STATE, {
      query: 'lofi beats',
      now: NOW,
    });
    expect(next.recentQueries[0]).toBe('lofi beats');
    expect(next.lastOfferedAt).toBe(NOW);
    expect(next.version).toBe(AOI_IDLE_MUSIC_STATE_VERSION);
  });

  it('does not mutate the input state', () => {
    const state: AoiIdleMusicLearningState = {
      version: AOI_IDLE_MUSIC_STATE_VERSION,
      moodFeedback: {},
      recentQueries: [],
      lastOfferedAt: 0,
    };
    recordIdleMusicOffered(state, { query: 'lofi beats', now: NOW });
    expect(state.recentQueries).toEqual([]);
    expect(state.lastOfferedAt).toBe(0);
  });

  it('de-duplicates case-insensitively, moving the repeat to the front', () => {
    let state = recordIdleMusicOffered(DEFAULT_AOI_IDLE_MUSIC_STATE, {
      query: 'Lofi Beats',
      now: NOW,
    });
    state = recordIdleMusicOffered(state, { query: 'deep focus', now: NOW + 1 });
    state = recordIdleMusicOffered(state, { query: 'lofi beats', now: NOW + 2 });
    expect(state.recentQueries).toEqual(['lofi beats', 'deep focus']);
  });

  it('caps the recent-query history at 12 entries', () => {
    let state: AoiIdleMusicLearningState = DEFAULT_AOI_IDLE_MUSIC_STATE;
    for (let i = 0; i < 20; i += 1) {
      state = recordIdleMusicOffered(state, { query: `query ${i}`, now: NOW + i });
    }
    expect(state.recentQueries).toHaveLength(12);
    expect(state.recentQueries[0]).toBe('query 19');
  });

  it('ignores a blank query but still stamps the cooldown', () => {
    const next = recordIdleMusicOffered(DEFAULT_AOI_IDLE_MUSIC_STATE, { query: '   ', now: NOW });
    expect(next.recentQueries).toEqual([]);
    expect(next.lastOfferedAt).toBe(NOW);
  });

  it('normalizes a null or version-mismatched state', () => {
    const fromNull = recordIdleMusicOffered(null, { query: 'lofi', now: NOW });
    expect(fromNull.recentQueries).toEqual(['lofi']);
    const stale = {
      version: 99,
      moodFeedback: { focus: 5 },
      recentQueries: ['old'],
      lastOfferedAt: 1,
    };
    const fromStale = recordIdleMusicOffered(stale as unknown as AoiIdleMusicLearningState, {
      query: 'lofi',
      now: NOW,
    });
    expect(fromStale.recentQueries).toEqual(['lofi']);
    expect(fromStale.moodFeedback).toEqual({});
  });
});

describe('recordIdleMusicOutcome', () => {
  it('increments the mood on accept and decrements on skip', () => {
    const accepted = recordIdleMusicOutcome(DEFAULT_AOI_IDLE_MUSIC_STATE, {
      mood: 'focus',
      accepted: true,
    });
    expect(accepted.moodFeedback.focus).toBe(1);
    const skipped = recordIdleMusicOutcome(accepted, { mood: 'focus', accepted: false });
    expect(skipped.moodFeedback.focus).toBe(0);
  });

  it('clamps feedback within [-3, 3]', () => {
    let state: AoiIdleMusicLearningState = DEFAULT_AOI_IDLE_MUSIC_STATE;
    for (let i = 0; i < 6; i += 1) {
      state = recordIdleMusicOutcome(state, { mood: 'chill', accepted: true });
    }
    expect(state.moodFeedback.chill).toBe(3);
    for (let i = 0; i < 12; i += 1) {
      state = recordIdleMusicOutcome(state, { mood: 'chill', accepted: false });
    }
    expect(state.moodFeedback.chill).toBe(-3);
  });

  it('preserves recentQueries and lastOfferedAt', () => {
    const seeded = recordIdleMusicOffered(DEFAULT_AOI_IDLE_MUSIC_STATE, {
      query: 'lofi beats',
      now: NOW,
    });
    const next = recordIdleMusicOutcome(seeded, { mood: 'focus', accepted: true });
    expect(next.recentQueries).toEqual(['lofi beats']);
    expect(next.lastOfferedAt).toBe(NOW);
  });

  it('does not mutate the input state', () => {
    const state: AoiIdleMusicLearningState = {
      version: AOI_IDLE_MUSIC_STATE_VERSION,
      moodFeedback: { focus: 1 },
      recentQueries: [],
      lastOfferedAt: 0,
    };
    recordIdleMusicOutcome(state, { mood: 'focus', accepted: true });
    expect(state.moodFeedback.focus).toBe(1);
  });

  it('normalizes a null or version-mismatched state', () => {
    const fromNull = recordIdleMusicOutcome(null, { mood: 'upbeat', accepted: true });
    expect(fromNull.moodFeedback.upbeat).toBe(1);
    const stale = {
      version: 99,
      moodFeedback: { focus: 5 },
      recentQueries: ['old'],
      lastOfferedAt: 1,
    };
    const fromStale = recordIdleMusicOutcome(stale as unknown as AoiIdleMusicLearningState, {
      mood: 'focus',
      accepted: true,
    });
    // Stale feedback is discarded, so focus starts from 0 -> +1.
    expect(fromStale.moodFeedback.focus).toBe(1);
    expect(fromStale.recentQueries).toEqual([]);
  });
});
