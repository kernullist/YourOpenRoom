import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HABIT_GARDEN_STATE,
  isHabitGardenTab,
  mergeHabitGardenState,
  normalizeHabit,
  type HabitGardenState,
} from '../types';
import { applyRoomItem, currentRoomItemId } from '../roomWeather';
import { ROOM_THEME_STORAGE_KEY } from '@/lib/roomTheme';

// mergeHabitGardenState backs SYNC_STATE and the persisted load. Two of the six
// fields are consent switches, so a partial or hostile write silently flipping
// one is a privacy regression rather than a cosmetic bug.

const CURRENT: HabitGardenState = {
  version: 1,
  activeTab: 'settings',
  selectedHabitId: 'h1',
  reflectWeatherInRoom: true,
  shareMomentumWithAoi: false,
  restoreRoomItemId: 'moonlit-library',
  lastAppliedWeather: 'rain',
};

describe('isHabitGardenTab', () => {
  it('accepts only the two real tabs', () => {
    expect(isHabitGardenTab('garden')).toBe(true);
    expect(isHabitGardenTab('settings')).toBe(true);
    expect(isHabitGardenTab('stats')).toBe(false);
    expect(isHabitGardenTab(null)).toBe(false);
  });
});

describe('mergeHabitGardenState', () => {
  it('leaves untouched fields alone on a partial write', () => {
    const next = mergeHabitGardenState(CURRENT, { activeTab: 'garden' });

    expect(next.activeTab).toBe('garden');
    // Both consent switches survive.
    expect(next.reflectWeatherInRoom).toBe(true);
    expect(next.shareMomentumWithAoi).toBe(false);
    expect(next.restoreRoomItemId).toBe('moonlit-library');
  });

  it('returns the current state for non-object payloads', () => {
    expect(mergeHabitGardenState(CURRENT, null)).toEqual(CURRENT);
    expect(mergeHabitGardenState(CURRENT, 'nope')).toEqual(CURRENT);
    expect(mergeHabitGardenState(CURRENT, [1])).toEqual(CURRENT);
  });

  it('ignores an unknown tab rather than falling back to a default', () => {
    expect(mergeHabitGardenState(CURRENT, { activeTab: 'hacked' }).activeTab).toBe('settings');
  });

  it('ignores wrongly typed consent values', () => {
    const next = mergeHabitGardenState(CURRENT, {
      reflectWeatherInRoom: 'yes',
      shareMomentumWithAoi: 1,
    });

    expect(next.reflectWeatherInRoom).toBe(true);
    expect(next.shareMomentumWithAoi).toBe(false);
  });

  it('accepts explicit nulls to clear nullable fields', () => {
    const next = mergeHabitGardenState(CURRENT, {
      selectedHabitId: null,
      restoreRoomItemId: null,
      lastAppliedWeather: null,
    });

    expect(next.selectedHabitId).toBeNull();
    expect(next.restoreRoomItemId).toBeNull();
    expect(next.lastAppliedWeather).toBeNull();
  });

  it('treats blank strings as no instruction', () => {
    const next = mergeHabitGardenState(CURRENT, {
      selectedHabitId: '   ',
      restoreRoomItemId: '',
      lastAppliedWeather: '  ',
    });

    expect(next.selectedHabitId).toBe('h1');
    expect(next.restoreRoomItemId).toBe('moonlit-library');
    expect(next.lastAppliedWeather).toBe('rain');
  });

  it('trims accepted strings and does not mutate the input', () => {
    const snapshot = { ...CURRENT };
    const next = mergeHabitGardenState(CURRENT, { selectedHabitId: '  h2  ' });

    expect(next.selectedHabitId).toBe('h2');
    expect(CURRENT).toEqual(snapshot);
  });

  it('defaults to sharing momentum but not to repainting the desktop', () => {
    expect(DEFAULT_HABIT_GARDEN_STATE.shareMomentumWithAoi).toBe(true);
    expect(DEFAULT_HABIT_GARDEN_STATE.reflectWeatherInRoom).toBe(false);
  });
});

describe('normalizeHabit', () => {
  it('rejects anything without a usable identity', () => {
    expect(normalizeHabit(null)).toBeNull();
    expect(normalizeHabit([])).toBeNull();
    expect(normalizeHabit({ name: 'x' })).toBeNull();
    expect(normalizeHabit({ id: 'a', name: '   ' })).toBeNull();
  });

  it('degrades unusable fields instead of rejecting the habit', () => {
    // One malformed file must not stop the garden from opening.
    const habit = normalizeHabit({ id: 'a', name: '독서', color: 42, createdAt: 'soon' });

    expect(habit).not.toBeNull();
    expect(habit?.color).toBeTruthy();
    expect(habit?.createdAt).toBe(0);
    expect(habit?.cadence).toEqual({ kind: 'daily' });
  });

  it('clamps a weekly target into range', () => {
    expect(
      normalizeHabit({ id: 'a', name: 'x', cadence: { kind: 'weekly', timesPerWeek: 99 } })
        ?.cadence,
    ).toEqual({ kind: 'weekly', timesPerWeek: 7 });
    expect(
      normalizeHabit({ id: 'a', name: 'x', cadence: { kind: 'weekly', timesPerWeek: 0 } })?.cadence,
    ).toEqual({ kind: 'weekly', timesPerWeek: 1 });
  });

  it('drops non-day-key check-ins and deduplicates the rest', () => {
    const habit = normalizeHabit({
      id: 'a',
      name: 'x',
      checkIns: ['2026-08-13', '2026-08-13', 'yesterday', 42, null],
    });

    expect(habit?.checkIns).toEqual(['2026-08-13']);
  });

  it('truncates an over-long name', () => {
    expect(normalizeHabit({ id: 'a', name: '가'.repeat(200) })?.name.length).toBeLessThanOrEqual(
      40,
    );
  });

  it('preserves the archived flag only when it is true', () => {
    expect(normalizeHabit({ id: 'a', name: 'x', archived: true })?.archived).toBe(true);
    expect(normalizeHabit({ id: 'a', name: 'x', archived: 'yes' })).not.toHaveProperty('archived');
  });
});

describe('room theme access', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('reads the active room item id', () => {
    localStorage.setItem(
      ROOM_THEME_STORAGE_KEY,
      JSON.stringify({ activeWallpaperId: 'moonlit-library', activeMoodId: 'moonlit-library' }),
    );

    expect(currentRoomItemId()).toBe('moonlit-library');
  });

  it('returns a value even with no stored theme rather than throwing', () => {
    expect(() => currentRoomItemId()).not.toThrow();
  });

  it('applies an item through the shared RoomShop path', () => {
    const next = applyRoomItem('rainy-window-desk');

    expect(next?.activeWallpaperId).toBe('rainy-window-desk');
    // Written to the key the Shell watches, which is how the change crosses the
    // iframe boundary.
    const stored = JSON.parse(localStorage.getItem(ROOM_THEME_STORAGE_KEY) ?? '{}') as {
      activeWallpaperId?: string;
    };
    expect(stored.activeWallpaperId).toBe('rainy-window-desk');
  });

  it('never lets a bad item id take the garden down', () => {
    expect(() => applyRoomItem('does-not-exist')).not.toThrow();
  });
});
