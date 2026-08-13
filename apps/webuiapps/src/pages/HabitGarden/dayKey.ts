// Local calendar day keys, as strings.
//
// Everything downstream of this file compares strings and never touches Date.
// That is the whole point: deriving "which day was this?" from a timestamp goes
// wrong in three separate ways that all look like a streak bug --
//
//   1. A check-in at 01:00 KST is the previous day in UTC, so UTC math loses a day.
//   2. The daemon reads the same files in a process whose TZ may differ from the
//      browser's, and would disagree about the same record.
//   3. Travel or a DST shift moves the offset, retroactively relocating history.
//
// Writing the key once, at check-in time, and only ever comparing strings after
// that removes all three.

export type DayKey = string;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: unknown): value is DayKey {
  return typeof value === 'string' && DAY_KEY_PATTERN.test(value);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** The local calendar day of `date` (default: now). */
export function toDayKey(date: Date = new Date()): DayKey {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Shift a day key by whole days.
 *
 * Uses a LOCAL-noon anchor rather than midnight. On a spring-forward DST day the
 * local midnight can be a time that does not exist, and constructing it makes the
 * engine roll to the neighbouring day -- which would silently drop or duplicate a
 * day in the streak walk. Noon is at least 11 hours from any real-world DST
 * boundary, so the arithmetic stays on the intended date.
 */
export function shiftDayKey(key: DayKey, deltaDays: number): DayKey {
  const parts = key.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return key;
  }
  const anchor = new Date(year, month - 1, day, 12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + deltaDays);
  return toDayKey(anchor);
}

/** Negative when `a` is earlier, positive when later, 0 when equal. */
export function compareDayKey(a: DayKey, b: DayKey): number {
  // Zero-padded ISO-ish keys sort lexicographically, so no parsing is needed.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: DayKey, to: DayKey): number {
  const parse = (key: DayKey): number => {
    const parts = key.split('-');
    return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  };
  // UTC is safe HERE and only here: both operands are constructed the same way
  // from already-resolved calendar fields, so the offset cancels out. This is a
  // difference of two calendar dates, not a wall-clock conversion.
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** Day keys from `from` to `to` inclusive, oldest first. Empty when reversed. */
export function dayKeyRange(from: DayKey, to: DayKey): DayKey[] {
  const span = daysBetween(from, to);
  if (span < 0) {
    return [];
  }
  const keys: DayKey[] = [];
  let cursor = from;
  for (let index = 0; index <= span; index += 1) {
    keys.push(cursor);
    cursor = shiftDayKey(cursor, 1);
  }
  return keys;
}

/** The last `count` day keys ending at `endKey` (inclusive), oldest first. */
export function lastDayKeys(endKey: DayKey, count: number): DayKey[] {
  if (count <= 0) {
    return [];
  }
  return dayKeyRange(shiftDayKey(endKey, -(count - 1)), endKey);
}

/**
 * The Monday-anchored week a day belongs to, identified by its Monday's key.
 *
 * Weekly habits ("3 times a week") need a stable bucket, and the bucket boundary
 * has to be the same one the user thinks in. Monday is the ISO convention and
 * matches the week rollover people expect from a habit tracker.
 */
export function weekStartKey(key: DayKey): DayKey {
  const parts = key.split('-');
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0, 0);
  // getDay(): 0 = Sunday. Map to a Monday-first offset.
  const offset = (date.getDay() + 6) % 7;
  return shiftDayKey(key, -offset);
}
