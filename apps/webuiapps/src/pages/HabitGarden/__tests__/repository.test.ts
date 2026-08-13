import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode, FileOperations } from '@/types/fileSystem';
import {
  createHabitDraft,
  createHabitGardenRepository,
  HabitStoreUnavailableError,
  pickHabitColor,
  setCheckIn,
  trimCheckIns,
} from '../repository';
import { DEFAULT_HABIT_GARDEN_STATE, HABIT_COLORS, MAX_CHECKIN_DAYS, type Habit } from '../types';
import { lastDayKeys } from '../dayKey';

// The repository's job is to survive whatever is actually on disk. A habit
// tracker that refuses to open because one file is malformed is worse than one
// that shows a habit with a default colour.

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    version: 1,
    id: 'habit-1',
    name: '스트레칭',
    cadence: { kind: 'daily' },
    color: HABIT_COLORS[0],
    createdAt: 1000,
    updatedAt: 1000,
    checkIns: [],
    ...overrides,
  };
}

function fileNode(name: string, path: string): FileNode {
  return { id: path, name, path, type: 'file', parentId: null };
}

interface FakeApi extends FileOperations {
  files: Map<string, unknown>;
  listCalls: string[];
}

function makeApi(initial: Record<string, unknown> = {}): FakeApi {
  const files = new Map<string, unknown>(Object.entries(initial));
  const listCalls: string[] = [];

  const api: FakeApi = {
    files,
    listCalls,
    listFiles: vi.fn(async (path = '/') => {
      listCalls.push(path);
      const prefix = path === '/' ? '/' : `${path}/`;
      const nodes: FileNode[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) {
          continue;
        }
        nodes.push(fileNode(rest, key));
      }
      return nodes;
    }),
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) {
        throw new Error(`missing ${path}`);
      }
      return { content: files.get(path), metadata: {} as never };
    }),
    writeFile: vi.fn(async (path: string, content: unknown) => {
      files.set(path, content);
    }),
    deleteFile: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  return api;
}

let api: FakeApi;

beforeEach(() => {
  api = makeApi();
});

describe('trimCheckIns', () => {
  it('deduplicates and sorts', () => {
    expect(trimCheckIns(['2026-08-13', '2026-08-11', '2026-08-13', '2026-08-12'])).toEqual([
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
    ]);
  });

  it('keeps only the most recent entries when over the cap', () => {
    const many = lastDayKeys('2026-08-13', 10);
    const trimmed = trimCheckIns(many, 4);

    expect(trimmed).toHaveLength(4);
    // The NEWEST are kept -- trimming the recent end would erase the current streak.
    expect(trimmed[trimmed.length - 1]).toBe('2026-08-13');
    expect(trimmed[0]).toBe('2026-08-10');
  });

  it('leaves a short list untouched', () => {
    expect(trimCheckIns(['2026-08-13'], MAX_CHECKIN_DAYS)).toEqual(['2026-08-13']);
  });
});

describe('loadHabits', () => {
  it('returns an empty garden when the habits directory does not exist', async () => {
    const repo = createHabitGardenRepository(api);

    expect(await repo.loadHabits()).toEqual([]);
  });

  it('raises rather than reporting an empty garden when the store cannot be read', async () => {
    // Returning [] here would render a backend outage as onboarding, inviting
    // the user to re-create habits they already have.
    const throwing = makeApi();
    throwing.listFiles = vi.fn(async () => {
      throw new Error('backend down');
    });

    await expect(createHabitGardenRepository(throwing).loadHabits()).rejects.toThrow(
      HabitStoreUnavailableError,
    );
    await expect(createHabitGardenRepository(throwing).loadHabits()).rejects.toThrow(
      'backend down',
    );
  });

  it('loads habits and sorts them by creation time', async () => {
    api.files.set('/habits/b.json', makeHabit({ id: 'b', createdAt: 2000 }));
    api.files.set('/habits/a.json', makeHabit({ id: 'a', createdAt: 1000 }));
    const repo = createHabitGardenRepository(api);

    const habits = await repo.loadHabits();

    expect(habits.map((habit) => habit.id)).toEqual(['a', 'b']);
  });

  it('skips a malformed file instead of failing the whole load', async () => {
    api.files.set('/habits/good.json', makeHabit({ id: 'good' }));
    api.files.set('/habits/broken.json', { nonsense: true });
    api.files.set('/habits/nameless.json', { id: 'x', name: '   ' });
    const repo = createHabitGardenRepository(api);

    const habits = await repo.loadHabits();

    expect(habits.map((habit) => habit.id)).toEqual(['good']);
  });

  it('survives a file whose read rejects', async () => {
    api.files.set('/habits/good.json', makeHabit({ id: 'good' }));
    api.files.set('/habits/locked.json', makeHabit({ id: 'locked' }));
    const originalRead = api.readFile;
    api.readFile = vi.fn(async (path: string) => {
      if (path.includes('locked')) {
        throw new Error('EACCES');
      }
      return originalRead(path);
    });

    const habits = await createHabitGardenRepository(api).loadHabits();

    expect(habits.map((habit) => habit.id)).toEqual(['good']);
  });

  it('parses habits stored as JSON strings', async () => {
    api.files.set('/habits/a.json', JSON.stringify(makeHabit({ id: 'a' })));

    const habits = await createHabitGardenRepository(api).loadHabits();

    expect(habits).toHaveLength(1);
    expect(habits[0].name).toBe('스트레칭');
  });

  it('ignores non-json entries in the habits directory', async () => {
    api.files.set('/habits/a.json', makeHabit({ id: 'a' }));
    api.files.set('/habits/notes.txt', 'hello');

    expect(await createHabitGardenRepository(api).loadHabits()).toHaveLength(1);
  });

  it('exposes refresh as a real reload', async () => {
    const repo = createHabitGardenRepository(api);
    expect(await repo.refresh()).toEqual([]);

    api.files.set('/habits/a.json', makeHabit({ id: 'a' }));

    expect(await repo.refresh()).toHaveLength(1);
  });
});

describe('saveHabit', () => {
  it('trims check-ins on write so the file cannot grow without bound', async () => {
    const habit = makeHabit({ checkIns: lastDayKeys('2026-08-13', MAX_CHECKIN_DAYS + 50) });

    await createHabitGardenRepository(api).saveHabit(habit);

    const written = api.files.get('/habits/habit-1.json') as Habit;
    expect(written.checkIns).toHaveLength(MAX_CHECKIN_DAYS);
    expect(written.checkIns[written.checkIns.length - 1]).toBe('2026-08-13');
  });

  it('writes to a path derived from the habit id', async () => {
    await createHabitGardenRepository(api).saveHabit(makeHabit({ id: 'xyz' }));

    expect(api.files.has('/habits/xyz.json')).toBe(true);
  });
});

describe('deleteHabit', () => {
  it('removes the habit file', async () => {
    api.files.set('/habits/gone.json', makeHabit({ id: 'gone' }));

    await createHabitGardenRepository(api).deleteHabit('gone');

    expect(api.files.has('/habits/gone.json')).toBe(false);
  });
});

describe('loadState', () => {
  it('creates state.json with defaults on first run instead of reading a missing file', async () => {
    const repo = createHabitGardenRepository(api);

    const state = await repo.loadState();

    expect(state).toEqual(DEFAULT_HABIT_GARDEN_STATE);
    expect(api.files.get('/state.json')).toEqual(DEFAULT_HABIT_GARDEN_STATE);
    // The existence check must happen before any read.
    expect(api.listCalls).toContain('/');
    expect(api.readFile).not.toHaveBeenCalled();
  });

  it('reads an existing state file', async () => {
    api.files.set('/state.json', {
      ...DEFAULT_HABIT_GARDEN_STATE,
      activeTab: 'settings',
      reflectWeatherInRoom: true,
    });

    const state = await createHabitGardenRepository(api).loadState();

    expect(state.activeTab).toBe('settings');
    expect(state.reflectWeatherInRoom).toBe(true);
  });

  it('parses a state file stored as a JSON string', async () => {
    api.files.set('/state.json', JSON.stringify({ activeTab: 'settings' }));

    expect((await createHabitGardenRepository(api).loadState()).activeTab).toBe('settings');
  });

  it('falls back to defaults for an unparseable state file', async () => {
    api.files.set('/state.json', '{ not json');

    expect(await createHabitGardenRepository(api).loadState()).toEqual(DEFAULT_HABIT_GARDEN_STATE);
  });

  it('does not let a consent flag be flipped by a partial write', async () => {
    // shareMomentumWithAoi is an opt-in; a state file that omits it must leave
    // the current value alone rather than resetting it.
    api.files.set('/state.json', { activeTab: 'garden' });

    const state = await createHabitGardenRepository(api).loadState();

    expect(state.shareMomentumWithAoi).toBe(DEFAULT_HABIT_GARDEN_STATE.shareMomentumWithAoi);
    expect(state.reflectWeatherInRoom).toBe(false);
  });
});

describe('saveState', () => {
  it('writes the state file', async () => {
    const next = { ...DEFAULT_HABIT_GARDEN_STATE, activeTab: 'settings' as const };

    await createHabitGardenRepository(api).saveState(next);

    expect(api.files.get('/state.json')).toEqual(next);
  });
});

describe('setCheckIn', () => {
  it('adds a day and clears it again', () => {
    const base = makeHabit();

    const added = setCheckIn(base, '2026-08-13', true, 5000);
    expect(added.checkIns).toEqual(['2026-08-13']);
    expect(added.updatedAt).toBe(5000);

    const removed = setCheckIn(added, '2026-08-13', false, 6000);
    expect(removed.checkIns).toEqual([]);
  });

  it('never mutates the input habit', () => {
    const base = makeHabit({ checkIns: ['2026-08-12'] });
    const snapshot = [...base.checkIns];

    setCheckIn(base, '2026-08-13', true, 1);

    expect(base.checkIns).toEqual(snapshot);
  });

  it('treats a repeated check-in as success rather than a toggle', () => {
    // The agent action is idempotent: "I ran today" said twice must not undo it.
    const once = setCheckIn(makeHabit(), '2026-08-13', true, 1);
    const twice = setCheckIn(once, '2026-08-13', true, 2);

    expect(twice.checkIns).toEqual(['2026-08-13']);
  });

  it('clears a day that was never set without error', () => {
    expect(setCheckIn(makeHabit(), '2026-08-13', false, 1).checkIns).toEqual([]);
  });
});

describe('createHabitDraft / pickHabitColor', () => {
  it('creates a habit with a fresh id and no history', () => {
    const habit = createHabitDraft('  물 마시기  ', { kind: 'daily' }, HABIT_COLORS[1], 9000);

    expect(habit.name).toBe('물 마시기');
    expect(habit.id).toBeTruthy();
    expect(habit.checkIns).toEqual([]);
    expect(habit.createdAt).toBe(9000);
    expect(habit.updatedAt).toBe(9000);
  });

  it('truncates an over-long name', () => {
    const habit = createHabitDraft('가'.repeat(120), { kind: 'daily' }, HABIT_COLORS[0], 1);

    expect(habit.name.length).toBeLessThanOrEqual(40);
  });

  it('cycles the palette so a new habit always differs from its neighbour', () => {
    expect(pickHabitColor(0)).toBe(HABIT_COLORS[0]);
    expect(pickHabitColor(HABIT_COLORS.length)).toBe(HABIT_COLORS[0]);
    expect(pickHabitColor(1)).not.toBe(pickHabitColor(0));
  });
});
