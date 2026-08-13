import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isHabitDayKey, loadHabitMomentumForSession } from '../habitGardenMomentum';

// The server-side half of the habit -> mood link. What matters here is that a
// user who does not use the app produces NO signal (rather than a neutral one
// that would still be an assertion about them), and that nothing on disk can
// break the caller.

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'habit-momentum-test-'));
  tempRoots.push(root);
  return root;
}

function habitsDir(root: string, sessionPath = 'aoi/space_adventure'): string {
  return join(root, ...sessionPath.split('/'), 'apps', 'habitgarden', 'data', 'habits');
}

function writeHabit(root: string, id: string, habit: unknown): void {
  const dir = habitsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, `${id}.json`), JSON.stringify(habit), 'utf8');
}

/** Day keys counting back from an anchor, using the same local-noon walk as the module. */
function daysBack(anchor: string, offsets: number[]): string[] {
  const [year, month, day] = anchor.split('-').map(Number);
  return offsets.map((offset) => {
    const date = new Date(year, month - 1, day, 12);
    date.setDate(date.getDate() - offset);
    const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });
}

const TODAY = '2026-08-13';

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('isHabitDayKey', () => {
  it('accepts only YYYY-MM-DD', () => {
    expect(isHabitDayKey('2026-08-13')).toBe(true);
    expect(isHabitDayKey('2026-8-13')).toBe(false);
    expect(isHabitDayKey('')).toBe(false);
    expect(isHabitDayKey(20260813)).toBe(false);
  });
});

describe('loadHabitMomentumForSession', () => {
  it('returns null when the user has no garden at all', () => {
    // Null, not 'steady': asserting steadiness about someone who does not use the
    // app would put a claim in Aoi's mood that nothing supports.
    expect(loadHabitMomentumForSession(makeTempRoot(), 'aoi/space_adventure', TODAY)).toBeNull();
  });

  it('returns null for a malformed day key rather than guessing today', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', { checkIns: [TODAY] });

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', 'not-a-date')).toBeNull();
    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', '')).toBeNull();
  });

  it('returns null for an invalid session path', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', { checkIns: [TODAY] });

    expect(loadHabitMomentumForSession(root, '../escape', TODAY)).toBeNull();
  });

  it('reports growing on a first active week', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', { checkIns: daysBack(TODAY, [0, 1, 2, 3]) });

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBe('growing');
  });

  it('reports steady when both windows are empty', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', { checkIns: daysBack(TODAY, [40, 41]) });

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBe('steady');
  });

  it('reports slipping when the recent window falls well behind', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', {
      checkIns: [...daysBack(TODAY, [7, 8, 9, 10, 11, 12, 13]), ...daysBack(TODAY, [1])],
    });

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBe('slipping');
  });

  it('reports steady for an unchanged pace', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', {
      checkIns: [...daysBack(TODAY, [0, 1, 2, 3, 4]), ...daysBack(TODAY, [7, 8, 9, 10, 11])],
    });

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBe('steady');
  });

  it('ignores archived habits', () => {
    const root = makeTempRoot();
    writeHabit(root, 'archived', { archived: true, checkIns: daysBack(TODAY, [0, 1, 2]) });

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBeNull();
  });

  it('survives an unreadable or malformed habit file', () => {
    const root = makeTempRoot();
    writeHabit(root, 'good', { checkIns: daysBack(TODAY, [0, 1, 2]) });
    fs.writeFileSync(join(habitsDir(root), 'broken.json'), '{ not json', 'utf8');
    fs.writeFileSync(join(habitsDir(root), 'notes.txt'), 'ignored', 'utf8');

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBe('growing');
  });

  it('ignores check-in entries that are not day keys', () => {
    const root = makeTempRoot();
    writeHabit(root, 'a', { checkIns: [123, null, 'yesterday', ...daysBack(TODAY, [0])] });

    // Only the one real key counts, and it lands in the recent window.
    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBe('growing');
  });

  it('treats a habit file that is an array as unusable', () => {
    const root = makeTempRoot();
    const dir = habitsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'weird.json'), JSON.stringify([1, 2, 3]), 'utf8');

    expect(loadHabitMomentumForSession(root, 'aoi/space_adventure', TODAY)).toBeNull();
  });
});
