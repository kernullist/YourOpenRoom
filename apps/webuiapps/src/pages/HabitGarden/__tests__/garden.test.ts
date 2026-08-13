import { describe, expect, it } from 'vitest';
import {
  buildHabitViews,
  computeGardenWeather,
  computeHabitMomentum,
  computeStreak,
  habitAdherence,
  MIN_WEATHER_SAMPLE_DAYS,
  plantStageForStreak,
  vitalityForGap,
} from '../garden';
import { lastDayKeys, shiftDayKey } from '../dayKey';
import type { Habit, HabitCadence } from '../types';

const TODAY = '2026-08-13'; // Thursday

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    version: 1,
    id: 'habit-1',
    name: '스트레칭',
    cadence: { kind: 'daily' } as HabitCadence,
    color: 'var(--color-yellow)',
    // Old enough that the garden-age clamp never limits a test window.
    createdAt: new Date(2026, 0, 1).getTime(),
    updatedAt: new Date(2026, 0, 1).getTime(),
    checkIns: [],
    ...overrides,
  };
}

/** Consecutive days ending `endOffset` days before TODAY. */
function runEndingAt(endOffset: number, length: number): string[] {
  return lastDayKeys(shiftDayKey(TODAY, -endOffset), length);
}

describe('computeStreak (daily)', () => {
  it('counts a run that includes today', () => {
    const habit = makeHabit({ checkIns: runEndingAt(0, 5) });
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(5);
    expect(streak.doneToday).toBe(true);
    expect(streak.gap).toBe(0);
  });

  it('does NOT break the streak when today is not done yet', () => {
    // The load-bearing behavior of the whole app: opening it at 10am, before
    // today's habit, must not show yesterday's 8-day streak as 0. Nothing has
    // been broken -- the day is not over.
    const habit = makeHabit({ checkIns: runEndingAt(1, 8) });
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(8);
    expect(streak.doneToday).toBe(false);
    expect(streak.gap).toBe(1);
  });

  it('breaks once a full day has been missed', () => {
    // Last check-in two days ago: yesterday was genuinely missed.
    const habit = makeHabit({ checkIns: runEndingAt(2, 8) });
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(0);
    expect(streak.gap).toBe(2);
  });

  it('restarts the count after a break when today is done', () => {
    const habit = makeHabit({ checkIns: [...runEndingAt(5, 4), TODAY] });
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(1);
    expect(streak.best).toBe(4);
  });

  it('remembers the best run even after it ends', () => {
    const habit = makeHabit({ checkIns: [...runEndingAt(20, 10), ...runEndingAt(0, 2)] });
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(2);
    expect(streak.best).toBe(10);
  });

  it('handles a habit with no check-ins at all', () => {
    const streak = computeStreak(makeHabit(), TODAY);

    expect(streak.current).toBe(0);
    expect(streak.best).toBe(0);
    expect(streak.doneToday).toBe(false);
    expect(streak.gap).toBe(Number.POSITIVE_INFINITY);
  });

  it('is unaffected by unsorted or duplicated entries on disk', () => {
    const run = runEndingAt(0, 4);
    const scrambled = [run[2], run[0], run[3], run[1], run[1]];
    const streak = computeStreak(makeHabit({ checkIns: scrambled }), TODAY);

    expect(streak.current).toBe(4);
    expect(streak.best).toBe(4);
  });

  it('counts a run that spans a month boundary', () => {
    const habit = makeHabit({ checkIns: lastDayKeys('2026-09-02', 5) });
    const streak = computeStreak(habit, '2026-09-02');

    expect(streak.current).toBe(5);
  });
});

describe('computeStreak (weekly)', () => {
  const weekly = (timesPerWeek: number, checkIns: string[]): Habit =>
    makeHabit({ cadence: { kind: 'weekly', timesPerWeek }, checkIns });

  it('counts consecutive weeks that hit the target, not consecutive days', () => {
    // Mon/Wed/Fri for two full weeks. A day-based count would read this as 1.
    const habit = weekly(3, [
      '2026-08-03',
      '2026-08-05',
      '2026-08-07',
      '2026-08-10',
      '2026-08-12',
      '2026-08-13',
    ]);
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(2);
  });

  it('does not count an in-progress week that has not hit the target yet', () => {
    // Last week complete, this week only 1 of 3 so far. The run is intact but
    // this week has not earned its place in it.
    const habit = weekly(3, ['2026-08-03', '2026-08-05', '2026-08-07', '2026-08-10']);
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(1);
  });

  it('does not let an unfinished current week break the run', () => {
    const habit = weekly(2, ['2026-08-03', '2026-08-05']);

    expect(computeStreak(habit, TODAY).current).toBe(1);
  });

  it('breaks when a whole week misses the target', () => {
    // Two weeks ago complete, last week empty.
    const habit = weekly(2, ['2026-07-27', '2026-07-29']);
    const streak = computeStreak(habit, TODAY);

    expect(streak.current).toBe(0);
    expect(streak.best).toBe(1);
  });

  it('clamps an out-of-range target instead of trusting it', () => {
    const habit = weekly(99, ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']);

    // 99 clamps to 7, which 4 days cannot satisfy.
    expect(computeStreak(habit, TODAY).current).toBe(0);
  });

  it('treats Sunday as part of the week that started on Monday', () => {
    // 2026-08-09 is a Sunday, belonging to the week of 2026-08-03.
    const habit = weekly(2, ['2026-08-08', '2026-08-09']);

    expect(computeStreak(habit, TODAY).best).toBe(1);
  });
});

describe('plantStageForStreak', () => {
  it('maps streak lengths to stages at the documented thresholds', () => {
    expect(plantStageForStreak(0)).toBe('seed');
    expect(plantStageForStreak(1)).toBe('sprout');
    expect(plantStageForStreak(2)).toBe('sprout');
    expect(plantStageForStreak(3)).toBe('leaf');
    expect(plantStageForStreak(6)).toBe('leaf');
    expect(plantStageForStreak(7)).toBe('bud');
    expect(plantStageForStreak(20)).toBe('bud');
    expect(plantStageForStreak(21)).toBe('bloom');
    expect(plantStageForStreak(365)).toBe('bloom');
  });

  it('refuses to be confused by nonsense input', () => {
    expect(plantStageForStreak(-5)).toBe('seed');
    expect(plantStageForStreak(Number.NaN)).toBe('seed');
    expect(plantStageForStreak(Number.POSITIVE_INFINITY)).toBe('seed');
  });
});

describe('vitalityForGap', () => {
  it('is thriving when today is done', () => {
    expect(vitalityForGap(0, true)).toBe('thriving');
    expect(vitalityForGap(5, true)).toBe('thriving');
  });

  it('stays thriving one day out, since the day is not over', () => {
    expect(vitalityForGap(1, false)).toBe('thriving');
  });

  it('dips to ok at two days and wilts at three', () => {
    expect(vitalityForGap(2, false)).toBe('ok');
    expect(vitalityForGap(3, false)).toBe('wilting');
    expect(vitalityForGap(30, false)).toBe('wilting');
  });

  it('wilts a habit that has never been done', () => {
    expect(vitalityForGap(Number.POSITIVE_INFINITY, false)).toBe('wilting');
  });
});

describe('stage and vitality stay independent', () => {
  it('keeps accumulated growth after a lapse', () => {
    // A 12-day run that ended 3 days ago: the plant is a wilting BUD, not a seed.
    // Collapsing stage into vitality would erase everything the user built at the
    // exact moment the app most needs to keep them.
    const habit = makeHabit({ checkIns: runEndingAt(3, 12) });
    const streak = computeStreak(habit, TODAY);

    expect(streak.best).toBe(12);
    expect(plantStageForStreak(streak.best)).toBe('bud');
    expect(vitalityForGap(streak.gap, streak.doneToday)).toBe('wilting');
  });
});

describe('computeGardenWeather', () => {
  it('refuses to declare weather for a brand-new garden', () => {
    const young = makeHabit({
      createdAt: new Date(2026, 7, 12).getTime(), // yesterday
      checkIns: [TODAY],
    });
    const result = computeGardenWeather([young], TODAY);

    expect(result.weather).toBe('unknown');
    expect(result.adherenceRate).toBeNull();
    expect(result.sampleDays).toBeLessThan(MIN_WEATHER_SAMPLE_DAYS);
  });

  it('is unknown for an empty garden', () => {
    expect(computeGardenWeather([], TODAY).weather).toBe('unknown');
  });

  it('is sunny at high adherence', () => {
    const result = computeGardenWeather([makeHabit({ checkIns: lastDayKeys(TODAY, 7) })], TODAY);

    expect(result.weather).toBe('sunny');
    expect(result.adherenceRate).toBe(1);
  });

  it('is cloudy in the middle band', () => {
    const result = computeGardenWeather(
      [
        makeHabit({
          checkIns: [TODAY, shiftDayKey(TODAY, -1), shiftDayKey(TODAY, -3), shiftDayKey(TODAY, -5)],
        }),
      ],
      TODAY,
    );

    expect(result.weather).toBe('cloudy');
  });

  it('is rain at low adherence', () => {
    const result = computeGardenWeather([makeHabit({ checkIns: [shiftDayKey(TODAY, -6)] })], TODAY);

    expect(result.weather).toBe('rain');
  });

  it('scales expectations for weekly habits instead of penalizing them', () => {
    // 3-a-week done exactly 3 times must not read as 3/7.
    const habit = makeHabit({
      cadence: { kind: 'weekly', timesPerWeek: 3 },
      checkIns: [TODAY, shiftDayKey(TODAY, -2), shiftDayKey(TODAY, -4)],
    });
    const result = computeGardenWeather([habit], TODAY);

    expect(result.weather).toBe('sunny');
  });

  it('ignores archived habits', () => {
    const result = computeGardenWeather(
      [
        makeHabit({ id: 'a', archived: true, checkIns: [] }),
        makeHabit({ id: 'b', checkIns: lastDayKeys(TODAY, 7) }),
      ],
      TODAY,
    );

    expect(result.weather).toBe('sunny');
  });

  it('never reports a rate above 1', () => {
    const habit = makeHabit({
      cadence: { kind: 'weekly', timesPerWeek: 1 },
      checkIns: lastDayKeys(TODAY, 7),
    });

    expect(computeGardenWeather([habit], TODAY).adherenceRate).toBe(1);
  });
});

describe('computeHabitMomentum', () => {
  it('is steady for an empty garden', () => {
    expect(computeHabitMomentum([], TODAY)).toBe('steady');
  });

  it('is steady when there is no history to compare against', () => {
    expect(computeHabitMomentum([makeHabit()], TODAY)).toBe('steady');
  });

  it('is growing when the recent window beats the previous one', () => {
    const habit = makeHabit({
      checkIns: [...lastDayKeys(TODAY, 7), ...lastDayKeys(shiftDayKey(TODAY, -7), 2)],
    });

    expect(computeHabitMomentum([habit], TODAY)).toBe('growing');
  });

  it('is growing on a first active week', () => {
    expect(computeHabitMomentum([makeHabit({ checkIns: lastDayKeys(TODAY, 5) })], TODAY)).toBe(
      'growing',
    );
  });

  it('is slipping when the recent window falls well behind', () => {
    const habit = makeHabit({
      checkIns: [...lastDayKeys(shiftDayKey(TODAY, -7), 7), shiftDayKey(TODAY, -1)],
    });

    expect(computeHabitMomentum([habit], TODAY)).toBe('slipping');
  });

  it('reads a small change as steady rather than as a verdict', () => {
    // 6 last week, 6 this week. Trend, not level -- and nothing has moved.
    const habit = makeHabit({
      checkIns: [...lastDayKeys(TODAY, 6), ...lastDayKeys(shiftDayKey(TODAY, -7), 6)],
    });

    expect(computeHabitMomentum([habit], TODAY)).toBe('steady');
  });

  it('judges direction, not absolute level', () => {
    // A modest but IMPROVING record must not be reported as slipping.
    const climbing = makeHabit({
      checkIns: [...lastDayKeys(TODAY, 4), ...lastDayKeys(shiftDayKey(TODAY, -7), 2)],
    });

    expect(computeHabitMomentum([climbing], TODAY)).toBe('growing');
  });
});

describe('buildHabitViews', () => {
  it('puts habits still due today first', () => {
    const done = makeHabit({ id: 'done', name: '완료', checkIns: [TODAY], createdAt: 1 });
    const due = makeHabit({ id: 'due', name: '미완료', checkIns: [], createdAt: 2 });

    const views = buildHabitViews([done, due], TODAY);

    expect(views.map((view) => view.habit.id)).toEqual(['due', 'done']);
    expect(views[0].dueToday).toBe(true);
  });

  it('drops archived habits', () => {
    const views = buildHabitViews([makeHabit({ archived: true })], TODAY);

    expect(views).toHaveLength(0);
  });

  it('carries stage and vitality onto the view', () => {
    const [view] = buildHabitViews([makeHabit({ checkIns: lastDayKeys(TODAY, 8) })], TODAY);

    expect(view.stage).toBe('bud');
    expect(view.vitality).toBe('thriving');
  });
});

describe('habitAdherence', () => {
  it('reports the completed-over-expected rate', () => {
    const result = habitAdherence(makeHabit({ checkIns: lastDayKeys(TODAY, 5) }), TODAY, 10);

    expect(result.completed).toBe(5);
    expect(result.expected).toBe(10);
    expect(result.rate).toBe(0.5);
  });

  it('scales expectations for weekly cadence', () => {
    const habit = makeHabit({
      cadence: { kind: 'weekly', timesPerWeek: 2 },
      checkIns: lastDayKeys(TODAY, 2),
    });
    const result = habitAdherence(habit, TODAY, 7);

    expect(result.expected).toBe(2);
    expect(result.rate).toBe(1);
  });

  it('returns a null rate rather than dividing by zero', () => {
    expect(habitAdherence(makeHabit(), TODAY, 0).rate).toBeNull();
  });
});
