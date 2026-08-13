import { describe, expect, it } from 'vitest';
import {
  compareDayKey,
  dayKeyRange,
  daysBetween,
  isDayKey,
  lastDayKeys,
  shiftDayKey,
  toDayKey,
  weekStartKey,
} from '../dayKey';

// Date handling is the only place in this app where a bug is invisible: a wrong
// streak looks like a plausible streak. These tests cover the boundaries that
// actually break naive implementations -- month ends, leap days, year rollover,
// and the DST transitions that make local midnight nonexistent or ambiguous.

describe('toDayKey', () => {
  it('formats the local calendar date with zero padding', () => {
    expect(toDayKey(new Date(2026, 0, 5, 13, 45))).toBe('2026-01-05');
    expect(toDayKey(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('uses the local date, not UTC', () => {
    // 01:00 local is the PREVIOUS day in UTC for any positive offset. The key
    // must follow what the user's calendar says, which is the whole reason this
    // module exists.
    const earlyMorning = new Date(2026, 5, 10, 1, 0, 0);
    expect(toDayKey(earlyMorning)).toBe('2026-06-10');
  });
});

describe('isDayKey', () => {
  it('accepts well-formed keys', () => {
    expect(isDayKey('2026-08-13')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDayKey('2026-8-13')).toBe(false);
    expect(isDayKey('26-08-13')).toBe(false);
    expect(isDayKey('2026-08-13T00:00:00Z')).toBe(false);
    expect(isDayKey(20260813)).toBe(false);
    expect(isDayKey(null)).toBe(false);
    expect(isDayKey(undefined)).toBe(false);
  });
});

describe('shiftDayKey', () => {
  it('moves forward and backward by whole days', () => {
    expect(shiftDayKey('2026-08-13', 1)).toBe('2026-08-14');
    expect(shiftDayKey('2026-08-13', -1)).toBe('2026-08-12');
    expect(shiftDayKey('2026-08-13', 0)).toBe('2026-08-13');
  });

  it('crosses month boundaries', () => {
    expect(shiftDayKey('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('crosses year boundaries', () => {
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles leap days', () => {
    // 2028 is a leap year; 2026 is not.
    expect(shiftDayKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDayKey('2028-02-29', 1)).toBe('2028-03-01');
    expect(shiftDayKey('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('survives a spring-forward date, where local midnight may not exist', () => {
    // US DST spring forward 2026-03-08. A midnight anchor can roll to the wrong
    // day in that zone; the noon anchor cannot. In a non-DST zone this is simply
    // ordinary arithmetic, so the assertion holds either way.
    expect(shiftDayKey('2026-03-07', 1)).toBe('2026-03-08');
    expect(shiftDayKey('2026-03-08', 1)).toBe('2026-03-09');
    expect(shiftDayKey('2026-03-09', -1)).toBe('2026-03-08');
  });

  it('survives a fall-back date, where a local hour repeats', () => {
    expect(shiftDayKey('2026-11-01', 1)).toBe('2026-11-02');
    expect(shiftDayKey('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('walks a long span without drifting', () => {
    let cursor = '2026-01-01';
    for (let index = 0; index < 365; index += 1) {
      cursor = shiftDayKey(cursor, 1);
    }
    expect(cursor).toBe('2027-01-01');
  });

  it('returns the input unchanged for a malformed key', () => {
    expect(shiftDayKey('not-a-date', 1)).toBe('not-a-date');
  });
});

describe('compareDayKey', () => {
  it('orders keys chronologically', () => {
    expect(compareDayKey('2026-08-12', '2026-08-13')).toBeLessThan(0);
    expect(compareDayKey('2026-08-13', '2026-08-12')).toBeGreaterThan(0);
    expect(compareDayKey('2026-08-13', '2026-08-13')).toBe(0);
  });

  it('orders across years and months lexicographically', () => {
    expect(compareDayKey('2025-12-31', '2026-01-01')).toBeLessThan(0);
    expect(compareDayKey('2026-09-01', '2026-10-01')).toBeLessThan(0);
  });

  it('sorts a shuffled list correctly', () => {
    const keys = ['2026-03-01', '2025-12-31', '2026-01-15', '2026-02-28'];
    expect([...keys].sort(compareDayKey)).toEqual([
      '2025-12-31',
      '2026-01-15',
      '2026-02-28',
      '2026-03-01',
    ]);
  });
});

describe('daysBetween', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-08-13', '2026-08-13')).toBe(0);
    expect(daysBetween('2026-08-13', '2026-08-20')).toBe(7);
    expect(daysBetween('2026-08-20', '2026-08-13')).toBe(-7);
  });

  it('counts across a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('counts across a DST boundary as whole days, not 23 or 25 hours', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('counts a full year', () => {
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
    expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366);
  });
});

describe('dayKeyRange', () => {
  it('is inclusive on both ends', () => {
    expect(dayKeyRange('2026-08-11', '2026-08-13')).toEqual([
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ]);
  });

  it('returns a single day when both ends match', () => {
    expect(dayKeyRange('2026-08-13', '2026-08-13')).toEqual(['2026-08-13']);
  });

  it('returns empty when the range is reversed', () => {
    expect(dayKeyRange('2026-08-13', '2026-08-11')).toEqual([]);
  });
});

describe('lastDayKeys', () => {
  it('returns the trailing window ending at the given day, oldest first', () => {
    expect(lastDayKeys('2026-08-13', 3)).toEqual(['2026-08-11', '2026-08-12', '2026-08-13']);
  });

  it('returns just the end day for a window of one', () => {
    expect(lastDayKeys('2026-08-13', 1)).toEqual(['2026-08-13']);
  });

  it('returns empty for a non-positive window', () => {
    expect(lastDayKeys('2026-08-13', 0)).toEqual([]);
    expect(lastDayKeys('2026-08-13', -5)).toEqual([]);
  });

  it('crosses a month boundary', () => {
    expect(lastDayKeys('2026-03-02', 4)).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });
});

describe('weekStartKey', () => {
  it('anchors to Monday', () => {
    // 2026-08-13 is a Thursday.
    expect(weekStartKey('2026-08-13')).toBe('2026-08-10');
  });

  it('treats Monday as its own week start', () => {
    expect(weekStartKey('2026-08-10')).toBe('2026-08-10');
  });

  it('puts Sunday at the END of its week, not the start', () => {
    // 2026-08-16 is a Sunday; a naive getDay() offset would send it forward a
    // week and silently split every weekly habit's weekend.
    expect(weekStartKey('2026-08-16')).toBe('2026-08-10');
  });

  it('crosses a month boundary', () => {
    // 2026-09-01 is a Tuesday.
    expect(weekStartKey('2026-09-01')).toBe('2026-08-31');
  });

  it('gives every day of one week the same anchor', () => {
    const anchors = dayKeyRange('2026-08-10', '2026-08-16').map(weekStartKey);
    expect(new Set(anchors).size).toBe(1);
    expect(anchors[0]).toBe('2026-08-10');
  });
});
