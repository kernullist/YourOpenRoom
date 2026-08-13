import { batchConcurrent, generateId, type FileNode } from '@/lib';
import type { FileOperations } from '@/types/fileSystem';
import { compareDayKey, type DayKey } from './dayKey';
import {
  DEFAULT_HABIT_GARDEN_STATE,
  HABIT_COLORS,
  HABIT_NAME_MAX,
  MAX_CHECKIN_DAYS,
  mergeHabitGardenState,
  normalizeHabit,
  type Habit,
  type HabitCadence,
  type HabitGardenState,
} from './types';

const HABITS_DIR = '/habits';
const STATE_FILE = '/state.json';

/**
 * `readFile` hands back either a JSON string or an already-parsed object
 * depending on the storage backend, and JSON.parse on the latter throws a
 * SyntaxError that a surrounding catch swallows into "no data".
 */
function parseContent(content: unknown): unknown {
  if (typeof content !== 'string') {
    return content;
  }
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function habitPath(id: string): string {
  return `${HABITS_DIR}/${id}.json`;
}

/**
 * Keep only the most recent check-ins.
 *
 * Applied on WRITE rather than on read so the file cannot grow without bound
 * over years of use. The cap is far beyond the widest heatmap the UI draws, so
 * nothing visible is ever trimmed away.
 */
export function trimCheckIns(checkIns: DayKey[], max = MAX_CHECKIN_DAYS): DayKey[] {
  const unique = [...new Set(checkIns)].sort(compareDayKey);
  return unique.length <= max ? unique : unique.slice(unique.length - max);
}

export function createHabitDraft(
  name: string,
  cadence: HabitCadence,
  color: string,
  now: number,
): Habit {
  return {
    version: 1,
    id: generateId(),
    name: name.trim().slice(0, HABIT_NAME_MAX),
    cadence,
    color,
    createdAt: now,
    updatedAt: now,
    checkIns: [],
  };
}

export function pickHabitColor(index: number): string {
  return HABIT_COLORS[index % HABIT_COLORS.length];
}

export interface HabitGardenRepository {
  loadHabits(): Promise<Habit[]>;
  refresh(): Promise<Habit[]>;
  saveHabit(habit: Habit): Promise<void>;
  deleteHabit(id: string): Promise<void>;
  loadState(): Promise<HabitGardenState>;
  saveState(state: HabitGardenState): Promise<void>;
}

export function createHabitGardenRepository(api: FileOperations): HabitGardenRepository {
  const loadHabits = async (): Promise<Habit[]> => {
    let entries: FileNode[] = [];
    try {
      entries = await api.listFiles(HABITS_DIR);
    } catch {
      // A missing habits directory is the normal first-run state, not an error.
      return [];
    }

    const jsonFiles = entries.filter(
      (entry) => entry.type === 'file' && entry.name.endsWith('.json'),
    );
    if (jsonFiles.length === 0) {
      return [];
    }

    // batchConcurrent, not Promise.all: a garden can hold more than the
    // concurrency limit and unbounded parallel reads are prohibited.
    const results = await batchConcurrent(jsonFiles, (file) => api.readFile(file.path));

    const habits: Habit[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        // One unreadable file must not take the whole garden down with it.
        continue;
      }
      const habit = normalizeHabit(parseContent(result.value?.content));
      if (habit) {
        habits.push(habit);
      }
    }
    return habits.sort((left, right) => left.createdAt - right.createdAt);
  };

  return {
    loadHabits,
    refresh: loadHabits,

    saveHabit: async (habit: Habit): Promise<void> => {
      await api.writeFile(habitPath(habit.id), {
        ...habit,
        checkIns: trimCheckIns(habit.checkIns),
      });
    },

    deleteHabit: async (id: string): Promise<void> => {
      await api.deleteFile(habitPath(id));
    },

    loadState: async (): Promise<HabitGardenState> => {
      try {
        // Check before reading: a missing state.json is the normal first-run
        // case, and a blind read makes every clean install log a failure.
        const rootFiles = await api.listFiles('/');
        const exists = rootFiles.some((file) => file.name === 'state.json');
        if (!exists) {
          await api.writeFile(STATE_FILE, DEFAULT_HABIT_GARDEN_STATE);
          return { ...DEFAULT_HABIT_GARDEN_STATE };
        }
        const result = await api.readFile(STATE_FILE);
        return mergeHabitGardenState(DEFAULT_HABIT_GARDEN_STATE, parseContent(result?.content));
      } catch {
        return { ...DEFAULT_HABIT_GARDEN_STATE };
      }
    },

    saveState: async (state: HabitGardenState): Promise<void> => {
      await api.writeFile(STATE_FILE, state);
    },
  };
}

/** Toggle one day on a habit, returning a new habit (never mutating the input). */
export function toggleCheckIn(habit: Habit, dayKey: DayKey, now: number): Habit {
  const done = new Set(habit.checkIns);
  if (done.has(dayKey)) {
    done.delete(dayKey);
  } else {
    done.add(dayKey);
  }
  return { ...habit, checkIns: trimCheckIns([...done]), updatedAt: now };
}

/** Idempotent: checking in twice is success, not an error. */
export function setCheckIn(habit: Habit, dayKey: DayKey, done: boolean, now: number): Habit {
  const set = new Set(habit.checkIns);
  if (done) {
    set.add(dayKey);
  } else {
    set.delete(dayKey);
  }
  return { ...habit, checkIns: trimCheckIns([...set]), updatedAt: now };
}
