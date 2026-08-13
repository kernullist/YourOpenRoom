import * as fs from 'fs';
import { join, resolve } from 'path';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';

// SERVER-ONLY. Reads the Habit Garden app's stored habits so Aoi's mood can
// reflect how the user's week is actually going.
//
// This module uses node fs and must never be imported from browser code -- doing
// so breaks `pnpm build` while leaving typecheck and vitest green, which makes it
// an easy mistake to ship.
//
// What it produces is a THREE-VALUE summary and nothing else. Handing the raw
// habit records to the mood layer would couple a pure expression function to a
// whole app's domain, and would put far more personal detail into the autonomy
// store than the feature needs.

export type HabitMomentumValue = 'growing' | 'steady' | 'slipping';

const APP_STORAGE_NAME = 'habitgarden';
const WINDOW_DAYS = 7;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isHabitDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY_PATTERN.test(value);
}

function shiftDayKey(key: string, deltaDays: number): string {
  const [year, month, day] = key.split('-').map(Number);
  // Local noon anchor: midnight can be a nonexistent local time on a DST
  // spring-forward date, which would silently move the result to another day.
  const anchor = new Date(year, month - 1, day, 12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + deltaDays);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}-${pad(anchor.getDate())}`;
}

function windowKeys(endKey: string, count: number): Set<string> {
  const keys = new Set<string>();
  for (let offset = 0; offset < count; offset += 1) {
    keys.add(shiftDayKey(endKey, -offset));
  }
  return keys;
}

interface StoredHabit {
  checkIns?: unknown;
  archived?: unknown;
}

function readHabits(sessionsDir: string, sessionPath: string): StoredHabit[] {
  const normalized = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalized) {
    return [];
  }
  const habitsDir = resolve(sessionsDir, normalized, 'apps', APP_STORAGE_NAME, 'data', 'habits');
  let entries: string[];
  try {
    entries = fs.readdirSync(habitsDir);
  } catch {
    // No garden yet is the common case, not an error.
    return [];
  }

  const habits: StoredHabit[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(join(habitsDir, entry), 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        habits.push(parsed as StoredHabit);
      }
    } catch {
      // One unreadable habit file must not suppress the whole signal.
    }
  }
  return habits;
}

function countInWindow(habits: StoredHabit[], keys: Set<string>): number {
  let total = 0;
  for (const habit of habits) {
    if (habit.archived === true || !Array.isArray(habit.checkIns)) {
      continue;
    }
    for (const raw of habit.checkIns) {
      if (isHabitDayKey(raw) && keys.has(raw)) {
        total += 1;
      }
    }
  }
  return total;
}

/**
 * Direction of travel over the last two weeks.
 *
 * Trend, not level: someone climbing from a rough patch should not be met with
 * concern just because their absolute rate is still low, and someone falling
 * from near-perfect is slipping even at a respectable number.
 *
 * Returns null when there is no garden at all, so the caller can omit the input
 * entirely rather than assert 'steady' about a user who does not use this app.
 */
export function loadHabitMomentumForSession(
  sessionsDir: string,
  sessionPath: string,
  todayKey: string,
): HabitMomentumValue | null {
  if (!isHabitDayKey(todayKey)) {
    return null;
  }
  const habits = readHabits(sessionsDir, sessionPath).filter((habit) => habit.archived !== true);
  if (habits.length === 0) {
    return null;
  }

  const recent = countInWindow(habits, windowKeys(todayKey, WINDOW_DAYS));
  const previous = countInWindow(
    habits,
    windowKeys(shiftDayKey(todayKey, -WINDOW_DAYS), WINDOW_DAYS),
  );

  if (previous === 0 && recent === 0) {
    return 'steady';
  }
  if (previous === 0) {
    return 'growing';
  }
  const ratio = recent / previous;
  if (ratio >= 1.15) {
    return 'growing';
  }
  if (ratio <= 0.7) {
    return 'slipping';
  }
  return 'steady';
}
