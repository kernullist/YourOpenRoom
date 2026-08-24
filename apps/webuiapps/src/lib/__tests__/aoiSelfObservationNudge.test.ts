import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_SELF_OBSERVATION_STATE,
  DEFAULT_SELF_OBSERVATION_SPACING_MS,
  normalizeAoiSelfObservationState,
  recordAoiSelfObservationOffered,
  MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY,
  shouldSubstituteAoiSelfObservation,
} from '../aoiSelfObservationNudge';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('shouldSubstituteAoiSelfObservation', () => {
  it('substitutes on a first-ever chance when there is something to report', () => {
    expect(
      shouldSubstituteAoiSelfObservation({
        now: NOW,
        lastSelfObservationAt: 0,
        hasSelfInquiry: true,
        hasHostContent: true,
      }),
    ).toBe(true);
  });

  it('requires a real inquiry, so nothing is manufactured', () => {
    expect(
      shouldSubstituteAoiSelfObservation({
        now: NOW,
        lastSelfObservationAt: 0,
        hasSelfInquiry: false,
        hasHostContent: true,
      }),
    ).toBe(false);
  });

  it('refuses without host content, because speaking would ADD an interruption', () => {
    // This is the constraint, not an optimization: the whole design rides an
    // interruption the user was already getting.
    expect(
      shouldSubstituteAoiSelfObservation({
        now: NOW,
        lastSelfObservationAt: 0,
        hasSelfInquiry: true,
        hasHostContent: false,
      }),
    ).toBe(false);
  });

  it('keeps self-observations spaced so they do not become the default', () => {
    const justSpoke = {
      now: NOW,
      lastSelfObservationAt: NOW - HOUR,
      hasSelfInquiry: true,
      hasHostContent: true,
    };
    expect(shouldSubstituteAoiSelfObservation(justSpoke)).toBe(false);

    expect(
      shouldSubstituteAoiSelfObservation({
        ...justSpoke,
        lastSelfObservationAt: NOW - DEFAULT_SELF_OBSERVATION_SPACING_MS,
      }),
    ).toBe(true);
  });

  it('honors a custom spacing', () => {
    expect(
      shouldSubstituteAoiSelfObservation({
        now: NOW,
        lastSelfObservationAt: NOW - HOUR,
        hasSelfInquiry: true,
        hasHostContent: true,
        spacingMs: HOUR,
      }),
    ).toBe(true);
  });

  it('refuses on non-finite timestamps rather than guessing', () => {
    expect(
      shouldSubstituteAoiSelfObservation({
        now: Number.NaN,
        lastSelfObservationAt: 0,
        hasSelfInquiry: true,
        hasHostContent: true,
      }),
    ).toBe(false);
    expect(
      shouldSubstituteAoiSelfObservation({
        now: NOW,
        lastSelfObservationAt: Number.NaN,
        hasSelfInquiry: true,
        hasHostContent: true,
      }),
    ).toBe(false);
  });
});

describe('aoiSelfObservationNudge state', () => {
  it('normalizes missing, unversioned, and implausible records', () => {
    expect(normalizeAoiSelfObservationState(null)).toEqual(DEFAULT_AOI_SELF_OBSERVATION_STATE);
    expect(normalizeAoiSelfObservationState({ version: 2, lastSelfObservationAt: 5 })).toEqual(
      DEFAULT_AOI_SELF_OBSERVATION_STATE,
    );
    expect(
      normalizeAoiSelfObservationState({ version: 1, lastSelfObservationAt: -5 })
        .lastSelfObservationAt,
    ).toBe(0);
    expect(
      normalizeAoiSelfObservationState({ version: 1, lastSelfObservationAt: 'x' })
        .lastSelfObservationAt,
    ).toBe(0);
    expect(
      normalizeAoiSelfObservationState({ version: 1, lastSelfObservationAt: NOW })
        .lastSelfObservationAt,
    ).toBe(NOW);
  });

  it('stamps the offer time and ignores an implausible clock', () => {
    expect(recordAoiSelfObservationOffered(null, NOW).lastSelfObservationAt).toBe(NOW);
    expect(
      recordAoiSelfObservationOffered({ version: 1, lastSelfObservationAt: NOW }, Number.NaN)
        .lastSelfObservationAt,
    ).toBe(NOW);
    expect(
      recordAoiSelfObservationOffered({ version: 1, lastSelfObservationAt: NOW }, -1)
        .lastSelfObservationAt,
    ).toBe(NOW);
  });

  it('records the last spoken topic key for rotation', () => {
    const next = recordAoiSelfObservationOffered(null, NOW, {
      topicKey: 'privacy-metadata',
    });
    expect(next.lastSelfObservationAt).toBe(NOW);
    expect(next.lastTopicKey).toBe('privacy-metadata');
    expect(
      normalizeAoiSelfObservationState({
        version: 1,
        lastSelfObservationAt: NOW,
        lastTopicKey: '  privacy-metadata  ',
      }).lastTopicKey,
    ).toBe('privacy-metadata');
  });

  it('remembers a rotation window, not just the last topic', () => {
    // Regression: a one-slot memory let a three-topic pool alternate between its
    // two newest entries forever.
    let state = recordAoiSelfObservationOffered(null, NOW, { topicKey: 'topic-a' });
    state = recordAoiSelfObservationOffered(state, NOW + 1, { topicKey: 'topic-b' });
    state = recordAoiSelfObservationOffered(state, NOW + 2, { topicKey: 'topic-c' });
    expect(state.recentTopicKeys).toEqual(['topic-c', 'topic-b', 'topic-a']);
    expect(state.offeredCount).toBe(3);

    // Re-voicing moves the topic to the head instead of duplicating it.
    state = recordAoiSelfObservationOffered(state, NOW + 3, { topicKey: 'topic-a' });
    expect(state.recentTopicKeys).toEqual(['topic-a', 'topic-c', 'topic-b']);
    expect(state.offeredCount).toBe(4);

    // An offer with no topic key still counts, and leaves the window intact.
    state = recordAoiSelfObservationOffered(state, NOW + 4);
    expect(state.recentTopicKeys).toEqual(['topic-a', 'topic-c', 'topic-b']);
    expect(state.offeredCount).toBe(5);
  });

  it('caps the rotation window', () => {
    let state = recordAoiSelfObservationOffered(null, NOW, { topicKey: 'seed' });
    for (let index = 0; index < MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY + 5; index += 1) {
      state = recordAoiSelfObservationOffered(state, NOW + index + 1, {
        topicKey: `topic-${index}`,
      });
    }
    expect(state.recentTopicKeys).toHaveLength(MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY);
    expect(state.recentTopicKeys?.[0]).toBe(`topic-${MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY + 4}`);
    expect(state.recentTopicKeys).not.toContain('seed');
  });

  it('migrates a pre-history record and rejects junk entries', () => {
    // Older records only carry lastTopicKey; it is by definition the newest.
    expect(
      normalizeAoiSelfObservationState({
        version: 1,
        lastSelfObservationAt: NOW,
        lastTopicKey: 'privacy-metadata',
      }).recentTopicKeys,
    ).toEqual(['privacy-metadata']);
    // offeredCount is unknown for those records, so it starts at history depth.
    expect(
      normalizeAoiSelfObservationState({
        version: 1,
        lastSelfObservationAt: NOW,
        lastTopicKey: 'privacy-metadata',
      }).offeredCount,
    ).toBe(1);
    const normalized = normalizeAoiSelfObservationState({
      version: 1,
      lastSelfObservationAt: NOW,
      lastTopicKey: 'topic-a',
      recentTopicKeys: ['topic-a', '  topic-b  ', '', 42, null, 'topic-b'],
      offeredCount: -3,
    });
    expect(normalized.recentTopicKeys).toEqual(['topic-a', 'topic-b']);
    expect(normalized.offeredCount).toBe(2);
    expect(
      normalizeAoiSelfObservationState({
        version: 1,
        lastSelfObservationAt: NOW,
        recentTopicKeys: 'not-an-array',
      }).recentTopicKeys,
    ).toEqual([]);
  });

  it('does not mutate the state passed in', () => {
    const state = { version: 1 as const, lastSelfObservationAt: 0 };
    recordAoiSelfObservationOffered(state, NOW);
    expect(state.lastSelfObservationAt).toBe(0);
  });
});
