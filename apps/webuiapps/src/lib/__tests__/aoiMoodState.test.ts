import { describe, expect, it } from 'vitest';

import {
  AOI_MOOD_WINDOW_MS,
  deriveAoiMoodState,
  normalizeAoiMoodState,
  shouldAoiMoodBeVoiced,
} from '../aoiMoodState';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function outcome(result: string, ageHours = 1) {
  return { result, createdAt: NOW - ageHours * HOUR };
}

describe('deriveAoiMoodState', () => {
  it('stays neutral with nothing to go on', () => {
    const mood = deriveAoiMoodState({ now: NOW });
    expect(mood.mood).toBe('neutral');
    expect(mood.reasons).toEqual([]);
    expect(mood.expression).toBe('default');
    expect(mood.actionAuthority).toBe('display_only');
    expect(mood.mutationCount).toBe(0);
  });

  it('lets something going wrong outweigh something going right', () => {
    const mood = deriveAoiMoodState({
      now: NOW,
      recentOutcomes: [outcome('failed'), outcome('blocked'), outcome('positive')],
      newMilestoneCount: 1,
    });
    // Reporting pride while work is failing would read as not paying attention.
    expect(mood.mood).toBe('worried');
    expect(mood.expression).toBe('worried');
    expect(mood.reasons).toContain('recent_failures');
    expect(mood.reasons).toContain('milestone_crossed');
  });

  it('is proud when a milestone was just crossed and nothing is failing', () => {
    const mood = deriveAoiMoodState({
      now: NOW,
      recentOutcomes: [outcome('positive')],
      newMilestoneCount: 1,
    });
    expect(mood.mood).toBe('proud');
    expect(mood.expression).toBe('proud');
  });

  it('is content on wins alone', () => {
    const mood = deriveAoiMoodState({ now: NOW, recentOutcomes: [outcome('positive')] });
    expect(mood.mood).toBe('content');
    expect(mood.expression).toBe('peaceful');
    expect(mood.reasons).toEqual(['recent_wins']);
  });

  it('is curious when things are merely pending', () => {
    expect(deriveAoiMoodState({ now: NOW, openThreadCount: 2 }).mood).toBe('curious');
    expect(deriveAoiMoodState({ now: NOW, pendingApprovalCount: 1 }).mood).toBe('curious');
    expect(deriveAoiMoodState({ now: NOW, pendingApprovalCount: 1 }).reasons).toContain(
      'approvals_waiting',
    );
  });

  it('does not treat an equal split as worried', () => {
    const mood = deriveAoiMoodState({
      now: NOW,
      recentOutcomes: [outcome('failed'), outcome('positive')],
    });
    // failures must EXCEED wins to tip the mood; a tie falls through to wins.
    expect(mood.mood).toBe('content');
  });

  it('ignores outcomes outside the window', () => {
    const mood = deriveAoiMoodState({
      now: NOW,
      recentOutcomes: [
        { result: 'failed', createdAt: NOW - AOI_MOOD_WINDOW_MS - HOUR },
        { result: 'failed', createdAt: NOW + HOUR },
        { result: 'positive', createdAt: NOW - HOUR },
      ],
    });
    expect(mood.mood).toBe('content');
    expect(mood.reasons).not.toContain('recent_failures');
  });

  it('honors a custom window and non-finite timestamps', () => {
    const outside = deriveAoiMoodState({
      now: NOW,
      windowMs: HOUR,
      recentOutcomes: [outcome('failed', 5)],
    });
    expect(outside.mood).toBe('neutral');
    const nonFinite = deriveAoiMoodState({
      now: NOW,
      recentOutcomes: [{ result: 'failed', createdAt: Number.NaN }],
    });
    expect(nonFinite.mood).toBe('neutral');
  });

  it('floors implausible counts instead of trusting them', () => {
    const mood = deriveAoiMoodState({
      now: NOW,
      newMilestoneCount: -3,
      openThreadCount: -1,
      pendingApprovalCount: 0.4,
    });
    expect(mood.mood).toBe('neutral');
    expect(mood.reasons).toEqual([]);
  });
});

describe('normalizeAoiMoodState', () => {
  it('round-trips a derived mood', () => {
    const derived = deriveAoiMoodState({ now: NOW, recentOutcomes: [outcome('positive')] });
    expect(normalizeAoiMoodState(derived, NOW)).toEqual(derived);
  });

  it('rejects an unversioned or unknown mood', () => {
    expect(normalizeAoiMoodState(null, NOW)).toBeNull();
    expect(normalizeAoiMoodState({ version: 2, mood: 'content' }, NOW)).toBeNull();
    expect(normalizeAoiMoodState({ version: 1, mood: 'elated' }, NOW)).toBeNull();
    expect(normalizeAoiMoodState({ version: 1 }, NOW)).toBeNull();
  });

  it('re-asserts display-only authority whatever the stored record claims', () => {
    const normalized = normalizeAoiMoodState(
      {
        version: 1,
        mood: 'worried',
        expression: 'happy',
        reasons: ['recent_failures', 42],
        updatedAt: 'nonsense',
        actionAuthority: 'execute',
        mutationCount: 9,
      },
      NOW,
    );
    expect(normalized?.actionAuthority).toBe('display_only');
    expect(normalized?.mutationCount).toBe(0);
    // The expression is derived from the mood, not trusted from disk.
    expect(normalized?.expression).toBe('worried');
    expect(normalized?.reasons).toEqual(['recent_failures']);
    expect(normalized?.updatedAt).toBe(NOW);
  });
});

describe('shouldAoiMoodBeVoiced', () => {
  it('stays quiet for neutral or reasonless moods', () => {
    expect(shouldAoiMoodBeVoiced(null)).toBe(false);
    expect(shouldAoiMoodBeVoiced(deriveAoiMoodState({ now: NOW }))).toBe(false);
    // A mood with no reason behind it would be "I am feeling fine" filler.
    expect(
      shouldAoiMoodBeVoiced({
        version: 1,
        mood: 'content',
        expression: 'peaceful',
        reasons: [],
        updatedAt: NOW,
        actionAuthority: 'display_only',
        mutationCount: 0,
      }),
    ).toBe(false);
  });

  it('speaks up for a mood with something behind it', () => {
    expect(
      shouldAoiMoodBeVoiced(
        deriveAoiMoodState({ now: NOW, recentOutcomes: [outcome('positive')] }),
      ),
    ).toBe(true);
  });
});
