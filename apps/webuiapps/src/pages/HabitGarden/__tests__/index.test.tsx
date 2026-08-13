import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CharacterAppAction } from '@/lib';
import { toDayKey } from '../dayKey';
import { DEFAULT_HABIT_GARDEN_STATE, type Habit } from '../types';

// Orchestration coverage: the agent action surface, optimistic check-in with
// rollback, and the room-weather effect. An e2e spec can click a chip but cannot
// dispatch an agent action or make a write fail on demand.

const { store, capturedHandlers, roomCalls } = vi.hoisted(() => ({
  store: {
    habits: new Map<string, unknown>(),
    state: null as unknown,
    failWrite: false,
    failList: false,
  },
  capturedHandlers: [] as Array<(action: CharacterAppAction) => Promise<string>>,
  roomCalls: [] as string[],
}));

vi.mock('@/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib');
  return {
    ...actual,
    createAppFileApi: () => ({
      listFiles: (path = '/') =>
        store.failList
          ? Promise.reject(new Error('backend down'))
          : Promise.resolve(
              path === '/habits'
                ? [...store.habits.keys()].map((id) => ({
                    id,
                    name: `${id}.json`,
                    path: `/habits/${id}.json`,
                    type: 'file',
                    parentId: null,
                  }))
                : store.state
                  ? [
                      {
                        id: 's',
                        name: 'state.json',
                        path: '/state.json',
                        type: 'file',
                        parentId: null,
                      },
                    ]
                  : [],
            ),
      readFile: (path: string) => {
        if (path === '/state.json') {
          return Promise.resolve({ content: store.state });
        }
        const id = path.replace('/habits/', '').replace('.json', '');
        return Promise.resolve({ content: store.habits.get(id) });
      },
      writeFile: (path: string, content: unknown) => {
        if (store.failWrite && path.startsWith('/habits/')) {
          return Promise.reject(new Error('disk full'));
        }
        if (path === '/state.json') {
          store.state = content;
        } else {
          store.habits.set(path.replace('/habits/', '').replace('.json', ''), content);
        }
        return Promise.resolve();
      },
      deleteFile: (path: string) => {
        store.habits.delete(path.replace('/habits/', '').replace('.json', ''));
        return Promise.resolve();
      },
    }),
    reportAction: vi.fn(),
    reportLifecycle: vi.fn(),
    useAgentActionListener: (
      _appId: number,
      handler: (a: CharacterAppAction) => Promise<string>,
    ) => {
      capturedHandlers.push(handler);
    },
  };
});

vi.mock('../roomWeather', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../roomWeather');
  return {
    ...actual,
    applyRoomItem: (itemId: string) => {
      roomCalls.push(itemId);
      return null;
    },
    currentRoomItemId: () => 'moonlit-library',
  };
});

import HabitGarden from '../index';

const TODAY = toDayKey();

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    version: 1,
    id: 'h1',
    name: '스트레칭',
    cadence: { kind: 'daily' },
    color: 'var(--color-yellow)',
    createdAt: new Date(2026, 0, 1).getTime(),
    updatedAt: new Date(2026, 0, 1).getTime(),
    checkIns: [],
    ...overrides,
  };
}

function latestHandler(): (action: CharacterAppAction) => Promise<string> {
  return capturedHandlers[capturedHandlers.length - 1];
}

function action(type: string, params?: Record<string, string>): CharacterAppAction {
  return { action_type: type, params } as CharacterAppAction;
}

async function renderApp(): Promise<void> {
  render(<HabitGarden />);
  await waitFor(() => expect(screen.getByTestId('habit-garden')).toBeTruthy());
  await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0));
}

beforeEach(() => {
  store.habits.clear();
  store.state = null;
  store.failWrite = false;
  store.failList = false;
  capturedHandlers.length = 0;
  roomCalls.length = 0;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('HabitGarden bootstrapping', () => {
  it('creates state.json with defaults on first run', async () => {
    await renderApp();

    await waitFor(() => expect(store.state).toBeTruthy());
    expect(store.state).toMatchObject({
      reflectWeatherInRoom: false,
      shareMomentumWithAoi: true,
    });
  });

  it('shows onboarding rather than statistics for an empty garden', async () => {
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('habit-garden-empty')).toBeTruthy());
  });

  it('reports a failed load as a failure, not as an empty garden', async () => {
    // Onboarding here would invite the user to re-create habits they already
    // have, and would read as "your data is gone".
    store.failList = true;

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('habit-garden-load-error')).toBeTruthy());
    expect(screen.queryByTestId('habit-garden-empty')).toBeNull();
  });

  it('clamps an agent-supplied weekly target at the write', async () => {
    await renderApp();

    await act(async () =>
      latestHandler()(
        action('CREATE_HABIT', { name: '과한 목표', cadence: 'weekly', timesPerWeek: '99' }),
      ),
    );

    const created = [...store.habits.values()][0] as Habit;
    // normalizeHabit would fix this on read, but only after a file violating its
    // own schema had already been written.
    expect(created.cadence).toEqual({ kind: 'weekly', timesPerWeek: 7 });
  });

  it('falls back to the default weekly target for nonsense input', async () => {
    await renderApp();

    await act(async () =>
      latestHandler()(
        action('CREATE_HABIT', { name: '이상한 목표', cadence: 'weekly', timesPerWeek: 'many' }),
      ),
    );

    expect(([...store.habits.values()][0] as Habit).cadence).toEqual({
      kind: 'weekly',
      timesPerWeek: 3,
    });
  });

  it('renders existing habits as plants', async () => {
    store.habits.set('h1', makeHabit({ checkIns: [TODAY] }));
    await renderApp();

    await waitFor(() =>
      expect(screen.getByTestId('habit-garden-plant-h1').getAttribute('data-stage')).toBe('sprout'),
    );
  });
});

describe('HabitGarden check-in', () => {
  it('records a check-in and grows the plant', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-checkin-h1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-checkin-h1'));

    await waitFor(() => expect((store.habits.get('h1') as Habit).checkIns).toContain(TODAY));
    expect(screen.getByTestId('habit-garden-plant-h1').getAttribute('data-stage')).toBe('sprout');
  });

  it('rolls the optimistic update back when the write fails', async () => {
    // A user who believes a day was recorded when it was not finds out later via
    // a streak that mysteriously broke, so the failure has to surface now.
    store.habits.set('h1', makeHabit());
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-checkin-h1')).toBeTruthy());

    store.failWrite = true;
    fireEvent.click(screen.getByTestId('habit-garden-checkin-h1'));

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('disk full'));
    expect(screen.getByTestId('habit-garden-plant-h1').getAttribute('data-stage')).toBe('seed');
  });

  it('undoes a check-in with the same click', async () => {
    store.habits.set('h1', makeHabit({ checkIns: [TODAY] }));
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-checkin-h1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-checkin-h1'));

    await waitFor(() => expect((store.habits.get('h1') as Habit).checkIns).not.toContain(TODAY));
  });
});

describe('HabitGarden agent actions', () => {
  it('checks in idempotently', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();

    const first = await act(async () =>
      latestHandler()(action('CHECK_IN_HABIT', { habitId: 'h1' })),
    );
    const second = await act(async () =>
      latestHandler()(action('CHECK_IN_HABIT', { habitId: 'h1' })),
    );

    expect(first).toBe('success');
    // Saying "I stretched today" twice must not undo it.
    expect(second).toBe('success');
    expect((store.habits.get('h1') as Habit).checkIns).toEqual([TODAY]);
  });

  it('undoes a check-in', async () => {
    store.habits.set('h1', makeHabit({ checkIns: [TODAY] }));
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('UNDO_HABIT_CHECK_IN', { habitId: 'h1' })),
    );

    expect(result).toBe('success');
    expect((store.habits.get('h1') as Habit).checkIns).toEqual([]);
  });

  it('accepts an explicit day key and rejects a malformed one', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();

    const ok = await act(async () =>
      latestHandler()(action('CHECK_IN_HABIT', { habitId: 'h1', dayKey: '2026-08-11' })),
    );
    expect(ok).toBe('success');
    expect((store.habits.get('h1') as Habit).checkIns).toContain('2026-08-11');

    const bad = await act(async () =>
      latestHandler()(action('CHECK_IN_HABIT', { habitId: 'h1', dayKey: 'yesterday' })),
    );
    expect(bad).toContain('error: dayKey must be YYYY-MM-DD');
  });

  it('reports an unknown habit rather than silently doing nothing', async () => {
    await renderApp();

    expect(
      await act(async () => latestHandler()(action('CHECK_IN_HABIT', { habitId: 'ghost' }))),
    ).toContain('error: habit not found');
    expect(await act(async () => latestHandler()(action('CHECK_IN_HABIT')))).toBe(
      'error: habitId is required',
    );
  });

  it('creates a habit, including a weekly one', async () => {
    await renderApp();

    expect(await act(async () => latestHandler()(action('CREATE_HABIT', { name: '독서' })))).toBe(
      'success',
    );
    expect(
      await act(async () =>
        latestHandler()(
          action('CREATE_HABIT', { name: '운동', cadence: 'weekly', timesPerWeek: '4' }),
        ),
      ),
    ).toBe('success');

    const created = [...store.habits.values()] as Habit[];
    expect(created.map((habit) => habit.name).sort()).toEqual(['독서', '운동']);
    const weekly = created.find((habit) => habit.name === '운동');
    expect(weekly?.cadence).toEqual({ kind: 'weekly', timesPerWeek: 4 });
  });

  it('requires a name to create', async () => {
    await renderApp();

    expect(await act(async () => latestHandler()(action('CREATE_HABIT')))).toBe(
      'error: name is required',
    );
  });

  it('updates and deletes a habit', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();

    expect(
      await act(async () =>
        latestHandler()(action('UPDATE_HABIT', { habitId: 'h1', name: '명상' })),
      ),
    ).toBe('success');
    expect((store.habits.get('h1') as Habit).name).toBe('명상');

    expect(await act(async () => latestHandler()(action('DELETE_HABIT', { habitId: 'h1' })))).toBe(
      'success',
    );
    expect(store.habits.has('h1')).toBe(false);
  });

  it('rejects update and delete for an unknown habit', async () => {
    await renderApp();

    expect(
      await act(async () => latestHandler()(action('UPDATE_HABIT', { habitId: 'ghost' }))),
    ).toContain('error: habit not found');
    expect(
      await act(async () => latestHandler()(action('DELETE_HABIT', { habitId: 'ghost' }))),
    ).toContain('error: habit not found');
  });

  it('selects a habit and refuses an unknown one', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();

    expect(await act(async () => latestHandler()(action('SELECT_HABIT', { habitId: 'h1' })))).toBe(
      'success',
    );
    await waitFor(() => expect(screen.getByTestId('habit-garden-detail')).toBeTruthy());

    expect(
      await act(async () => latestHandler()(action('SELECT_HABIT', { habitId: 'ghost' }))),
    ).toContain('error: habit not found');
  });

  it('refreshes and optionally focuses', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();

    expect(
      await act(async () => latestHandler()(action('REFRESH_HABIT_GARDEN', { habitId: 'h1' }))),
    ).toBe('success');
    await waitFor(() => expect(screen.getByTestId('habit-garden-detail')).toBeTruthy());
  });

  it('re-applies state on SYNC_STATE', async () => {
    await renderApp();
    await waitFor(() => expect(store.state).toBeTruthy());
    store.state = { ...DEFAULT_HABIT_GARDEN_STATE, activeTab: 'settings' };

    expect(await act(async () => latestHandler()(action('SYNC_STATE')))).toBe('success');
    await waitFor(() => expect(screen.getByTestId('habit-garden-settings')).toBeTruthy());
  });

  it('rejects an unknown action type', async () => {
    await renderApp();

    expect(await act(async () => latestHandler()(action('SET_SHARE_MOMENTUM_WITH_AOI')))).toContain(
      'error: unknown action_type',
    );
  });
});

describe('HabitGarden settings and room reflection', () => {
  it('does not touch the room while the toggle is off', async () => {
    store.habits.set('h1', makeHabit({ checkIns: [TODAY] }));
    await renderApp();
    await waitFor(() => expect(store.state).toBeTruthy());

    expect(roomCalls).toEqual([]);
  });

  it('backs up the current room item when the toggle is switched on', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-settings-open')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-settings-open'));
    fireEvent.click(screen.getByTestId('habit-garden-toggle-room'));

    // Captured so switching the toggle off can put the desktop back exactly as
    // it was rather than leaving the user hunting in RoomShop.
    await waitFor(() =>
      expect(store.state).toMatchObject({
        reflectWeatherInRoom: true,
        restoreRoomItemId: 'moonlit-library',
      }),
    );
  });

  it('applies a room item once the weather is known, and only once', async () => {
    // A garden old enough to have a weather verdict.
    store.habits.set(
      'h1',
      makeHabit({ createdAt: new Date(2026, 0, 1).getTime(), checkIns: [TODAY] }),
    );
    store.state = { ...DEFAULT_HABIT_GARDEN_STATE, reflectWeatherInRoom: true };

    await renderApp();

    await waitFor(() => expect(roomCalls.length).toBe(1));
    const applied = roomCalls[0];
    expect(['rainy-window-desk', 'lofi-cafe-night', 'pixel-arcade']).toContain(applied);

    // No repeat: re-applying on every render would fight whatever the user picks
    // in RoomShop.
    await waitFor(() =>
      expect(store.state).toMatchObject({ lastAppliedWeather: expect.any(String) }),
    );
    expect(roomCalls).toHaveLength(1);
  });

  it('lets the user turn momentum sharing off', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-settings-open')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-settings-open'));
    fireEvent.click(screen.getByTestId('habit-garden-toggle-aoi'));

    await waitFor(() => expect(store.state).toMatchObject({ shareMomentumWithAoi: false }));
  });
});

describe('HabitGarden habit editor', () => {
  it('creates a habit from the editor', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-add')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-add'));
    fireEvent.change(screen.getByTestId('habit-garden-editor-name'), {
      target: { value: '아침 산책' },
    });
    fireEvent.click(screen.getByTestId('habit-garden-editor-submit'));

    await waitFor(() => expect(store.habits.size).toBe(1));
    expect(([...store.habits.values()][0] as Habit).name).toBe('아침 산책');
  });

  it('adds a suggested habit from the empty state', async () => {
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-empty')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-suggestion-물 마시기'));

    await waitFor(() => expect(store.habits.size).toBe(1));
  });

  it('deletes a habit through the armed confirmation', async () => {
    store.habits.set('h1', makeHabit());
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('habit-garden-plant-h1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('habit-garden-plant-h1'));
    fireEvent.click(screen.getByTestId('habit-garden-delete'));
    fireEvent.click(screen.getByTestId('habit-garden-delete-confirm-yes'));

    await waitFor(() => expect(store.habits.size).toBe(0));
  });
});
