import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_SELF_OBSERVATION_STATE,
  DEFAULT_SELF_OBSERVATION_SPACING_MS,
  normalizeAoiSelfObservationState,
  recordAoiSelfObservationOffered,
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

  it('does not mutate the state passed in', () => {
    const state = { version: 1 as const, lastSelfObservationAt: 0 };
    recordAoiSelfObservationOffered(state, NOW);
    expect(state.lastSelfObservationAt).toBe(0);
  });
});
