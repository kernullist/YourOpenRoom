import {
  compareDayKey,
  daysBetween,
  lastDayKeys,
  shiftDayKey,
  weekStartKey,
  type DayKey,
} from './dayKey';
import type { Habit, HabitCadence } from './types';

// All the real logic of this app lives here, and all of it is pure. Streaks are
// the only thing a habit tracker cannot get wrong: a miscounted streak looks
// exactly like a correct one, so the user finds out by losing trust rather than
// by seeing an error.

export type PlantStage = 'seed' | 'sprout' | 'leaf' | 'bud' | 'bloom';
export type Vitality = 'thriving' | 'ok' | 'wilting';
export type GardenWeatherKind = 'sunny' | 'cloudy' | 'rain' | 'unknown';
export type HabitMomentum = 'growing' | 'steady' | 'slipping';

export const WEATHER_WINDOW_DAYS = 7;
export const MIN_WEATHER_SAMPLE_DAYS = 3;

export interface StreakResult {
  current: number;
  best: number;
  doneToday: boolean;
  /** Days (or weeks, for weekly habits) since the last completion. */
  gap: number;
}

export function checkInSet(habit: Pick<Habit, 'checkIns'>): Set<DayKey> {
  // Normalized at every entry point rather than trusted from the file: a
  // hand-edited or partially-written habit file must not be able to corrupt a
  // streak through duplicate or unsorted entries.
  return new Set(habit.checkIns);
}

function weeklyTarget(cadence: HabitCadence): number {
  return cadence.kind === 'weekly' ? Math.min(Math.max(cadence.timesPerWeek, 1), 7) : 7;
}

function countInWeek(done: Set<DayKey>, weekStart: DayKey): number {
  let total = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    if (done.has(shiftDayKey(weekStart, offset))) {
      total += 1;
    }
  }
  return total;
}

function dailyStreak(done: Set<DayKey>, todayKey: DayKey): StreakResult {
  const doneToday = done.has(todayKey);

  // The start of the walk is yesterday when today is not yet done.
  //
  // A day is not over. Showing an 8-day streak as 0 because the user opened the
  // app at 10am -- before doing today's habit -- is the single most demoralizing
  // thing this app could do, and it would be wrong: nothing has been broken yet.
  let cursor = doneToday ? todayKey : shiftDayKey(todayKey, -1);
  let current = 0;
  while (done.has(cursor)) {
    current += 1;
    cursor = shiftDayKey(cursor, -1);
  }

  const sorted = [...done].sort(compareDayKey);
  let best = 0;
  let run = 0;
  let previous: DayKey | null = null;
  for (const key of sorted) {
    run = previous !== null && daysBetween(previous, key) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = key;
  }

  const last = sorted[sorted.length - 1];
  const gap = last ? Math.max(0, daysBetween(last, todayKey)) : Number.POSITIVE_INFINITY;

  return { current, best, doneToday, gap };
}

function weeklyStreak(done: Set<DayKey>, todayKey: DayKey, target: number): StreakResult {
  // Counting consecutive DAYS is meaningless for "3 times a week" -- a perfect
  // week of Mon/Wed/Fri would read as a 1-day streak. The unit has to match the
  // commitment, so the streak counts consecutive weeks that hit the target.
  const thisWeek = weekStartKey(todayKey);
  const doneToday = done.has(todayKey);
  const currentWeekCount = countInWeek(done, thisWeek);

  // The current week is only counted once it has actually met the target; an
  // in-progress week neither counts nor breaks the run.
  let cursor = currentWeekCount >= target ? thisWeek : shiftDayKey(thisWeek, -7);
  let current = 0;
  while (countInWeek(done, cursor) >= target) {
    current += 1;
    cursor = shiftDayKey(cursor, -7);
  }

  const weeks = [...new Set([...done].map(weekStartKey))].sort(compareDayKey);
  let best = 0;
  let run = 0;
  let previous: DayKey | null = null;
  for (const week of weeks) {
    if (countInWeek(done, week) < target) {
      run = 0;
      previous = week;
      continue;
    }
    run = previous !== null && daysBetween(previous, week) === 7 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = week;
  }

  const sorted = [...done].sort(compareDayKey);
  const last = sorted[sorted.length - 1];
  const gap = last ? Math.max(0, daysBetween(last, todayKey)) : Number.POSITIVE_INFINITY;

  return { current, best, doneToday, gap };
}

export function computeStreak(habit: Habit, todayKey: DayKey): StreakResult {
  const done = checkInSet(habit);
  if (habit.cadence.kind === 'weekly') {
    return weeklyStreak(done, todayKey, weeklyTarget(habit.cadence));
  }
  return dailyStreak(done, todayKey);
}

const STAGE_THRESHOLDS: Array<{ min: number; stage: PlantStage }> = [
  { min: 21, stage: 'bloom' },
  { min: 7, stage: 'bud' },
  { min: 3, stage: 'leaf' },
  { min: 1, stage: 'sprout' },
  { min: 0, stage: 'seed' },
];

/**
 * Growth stage from the current streak.
 *
 * The thresholds (3 / 7 / 21) are the first hurdle, one week, and the popular
 * habit-formation figure. They are not a scientific claim -- they are spaced so
 * the next stage always feels reachable from where the user is standing.
 */
export function plantStageForStreak(streak: number): PlantStage {
  const safe = Number.isFinite(streak) ? Math.max(0, Math.trunc(streak)) : 0;
  for (const entry of STAGE_THRESHOLDS) {
    if (safe >= entry.min) {
      return entry.stage;
    }
  }
  return 'seed';
}

/**
 * Vitality is deliberately SEPARATE from stage.
 *
 * Stage is accumulated achievement; vitality is recent condition. A habit with a
 * 12-day history that was missed twice is a wilting bud, not a seed. Collapsing
 * the two would erase what the user built the moment they had a bad week, which
 * is exactly when a habit app needs to keep them.
 */
export function vitalityForGap(gap: number, doneToday: boolean): Vitality {
  if (doneToday || gap <= 0) {
    return 'thriving';
  }
  if (!Number.isFinite(gap) || gap >= 3) {
    return 'wilting';
  }
  return gap <= 1 ? 'thriving' : 'ok';
}

export interface GardenWeather {
  weather: GardenWeatherKind;
  /** null when the sample is too small to claim anything. */
  adherenceRate: number | null;
  sampleDays: number;
  expected: number;
  completed: number;
}

function expectedForWindow(cadence: HabitCadence, windowDays: number): number {
  if (cadence.kind === 'weekly') {
    return (weeklyTarget(cadence) * windowDays) / 7;
  }
  return windowDays;
}

/**
 * Garden-wide weather from recent adherence.
 *
 * Returns 'unknown' below MIN_WEATHER_SAMPLE_DAYS of history. Declaring "rain"
 * over a garden that is two days old would be a verdict on data that does not
 * exist -- the same rule the operator console applies to its metrics.
 */
export function computeGardenWeather(
  habits: Habit[],
  todayKey: DayKey,
  windowDays: number = WEATHER_WINDOW_DAYS,
): GardenWeather {
  const active = habits.filter((habit) => !habit.archived);
  if (active.length === 0) {
    return { weather: 'unknown', adherenceRate: null, sampleDays: 0, expected: 0, completed: 0 };
  }

  const window = lastDayKeys(todayKey, windowDays);
  const windowSet = new Set(window);

  // The sample is bounded by how long the garden has existed, so a brand-new
  // garden cannot borrow credibility from an empty window.
  const oldestCreatedAt = Math.min(...active.map((habit) => habit.createdAt));
  const gardenAgeDays = Number.isFinite(oldestCreatedAt)
    ? daysBetween(toDayKeyFromTimestamp(oldestCreatedAt), todayKey) + 1
    : 0;
  const sampleDays = Math.max(0, Math.min(windowDays, gardenAgeDays));

  let completed = 0;
  let expected = 0;
  for (const habit of active) {
    const done = checkInSet(habit);
    for (const key of done) {
      if (windowSet.has(key)) {
        completed += 1;
      }
    }
    expected += expectedForWindow(habit.cadence, sampleDays);
  }

  if (sampleDays < MIN_WEATHER_SAMPLE_DAYS || expected <= 0) {
    return { weather: 'unknown', adherenceRate: null, sampleDays, expected, completed };
  }

  const adherenceRate = Math.min(1, completed / expected);
  const weather: GardenWeatherKind =
    adherenceRate >= 0.8 ? 'sunny' : adherenceRate >= 0.5 ? 'cloudy' : 'rain';

  return { weather, adherenceRate, sampleDays, expected, completed };
}

function toDayKeyFromTimestamp(timestamp: number): DayKey {
  const date = new Date(timestamp);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function completionsInWindow(habits: Habit[], window: DayKey[]): number {
  const windowSet = new Set(window);
  let total = 0;
  for (const habit of habits) {
    if (habit.archived) {
      continue;
    }
    for (const key of checkInSet(habit)) {
      if (windowSet.has(key)) {
        total += 1;
      }
    }
  }
  return total;
}

/**
 * Direction of travel, for Aoi's mood.
 *
 * Trend rather than level, on purpose. Someone who climbed from 40% to 55% is
 * doing well and should not be met with concern; someone who fell from 95% to
 * 70% is slipping even though 70% is a fine number in isolation. A mood built on
 * the absolute rate would get both backwards.
 */
export function computeHabitMomentum(habits: Habit[], todayKey: DayKey): HabitMomentum {
  const active = habits.filter((habit) => !habit.archived);
  if (active.length === 0) {
    return 'steady';
  }

  const recent = lastDayKeys(todayKey, WEATHER_WINDOW_DAYS);
  const previous = lastDayKeys(shiftDayKey(todayKey, -WEATHER_WINDOW_DAYS), WEATHER_WINDOW_DAYS);

  const recentCount = completionsInWindow(active, recent);
  const previousCount = completionsInWindow(active, previous);

  // With nothing to compare against, "steady" is the honest answer -- a first
  // week is not evidence of a direction.
  if (previousCount === 0 && recentCount === 0) {
    return 'steady';
  }
  if (previousCount === 0) {
    return 'growing';
  }

  const ratio = recentCount / previousCount;
  if (ratio >= 1.15) {
    return 'growing';
  }
  if (ratio <= 0.7) {
    return 'slipping';
  }
  return 'steady';
}

export interface HabitView {
  habit: Habit;
  streak: StreakResult;
  stage: PlantStage;
  vitality: Vitality;
  /** True when the habit still needs a check-in today. */
  dueToday: boolean;
}

export function buildHabitView(habit: Habit, todayKey: DayKey): HabitView {
  const streak = computeStreak(habit, todayKey);
  return {
    habit,
    streak,
    stage: plantStageForStreak(streak.current),
    vitality: vitalityForGap(streak.gap, streak.doneToday),
    dueToday: !streak.doneToday,
  };
}

export function buildHabitViews(habits: Habit[], todayKey: DayKey): HabitView[] {
  return habits
    .filter((habit) => !habit.archived)
    .map((habit) => buildHabitView(habit, todayKey))
    .sort((left, right) => {
      // Due first: the point of opening this app is to see what still needs doing.
      if (left.dueToday !== right.dueToday) {
        return left.dueToday ? -1 : 1;
      }
      return left.habit.createdAt - right.habit.createdAt;
    });
}

/** Adherence over a window for one habit, for the detail panel. */
export function habitAdherence(
  habit: Habit,
  todayKey: DayKey,
  windowDays: number,
): { rate: number | null; completed: number; expected: number } {
  const window = lastDayKeys(todayKey, windowDays);
  const completed = completionsInWindow([habit], window);
  const expected = expectedForWindow(habit.cadence, windowDays);
  if (expected <= 0) {
    return { rate: null, completed, expected: 0 };
  }
  return { rate: Math.min(1, completed / expected), completed, expected };
}
