import { isDayKey, type DayKey } from './dayKey';

export type HabitCadence = { kind: 'daily' } | { kind: 'weekly'; timesPerWeek: number };

export interface Habit {
  version: 1;
  id: string;
  name: string;
  cadence: HabitCadence;
  color: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Completed day keys. Order is NOT guaranteed and must not be relied on.
   *
   * Trusting a sort invariant that lives in a JSON file means one hand-edited or
   * half-written file can silently corrupt a streak. Every consumer normalizes
   * through checkInSet() instead.
   */
  checkIns: DayKey[];
  archived?: boolean;
}

/** Keeps a habit file from growing without bound; ~13 months covers the widest heatmap three times over. */
export const MAX_CHECKIN_DAYS = 400;

export const HABIT_COLORS = [
  'var(--color-yellow)',
  'var(--color-cyan)',
  'var(--color-purple)',
  'var(--color-blue)',
  'var(--color-red)',
  '#4cc3a5',
] as const;

export const HABIT_NAME_MAX = 40;

export type HabitGardenTab = 'garden' | 'settings';

export interface HabitGardenState {
  version: 1;
  activeTab: HabitGardenTab;
  selectedHabitId: string | null;
  /** Opt-in, default off: missing a habit must not silently repaint the user's desktop. */
  reflectWeatherInRoom: boolean;
  shareMomentumWithAoi: boolean;
  /** The room item to restore when weather reflection is turned back off. */
  restoreRoomItemId: string | null;
  /** Guards against re-applying the room theme on every render; only a CHANGE applies. */
  lastAppliedWeather: string | null;
}

export const DEFAULT_HABIT_GARDEN_STATE: HabitGardenState = {
  version: 1,
  activeTab: 'garden',
  selectedHabitId: null,
  reflectWeatherInRoom: false,
  shareMomentumWithAoi: true,
  restoreRoomItemId: null,
  lastAppliedWeather: null,
};

export const HABIT_SUGGESTIONS = ['물 마시기', '스트레칭', '30분 독서'] as const;

export function isHabitGardenTab(value: unknown): value is HabitGardenTab {
  return value === 'garden' || value === 'settings';
}

function normalizeCadence(value: unknown): HabitCadence {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (raw.kind === 'weekly') {
      const times = typeof raw.timesPerWeek === 'number' ? Math.trunc(raw.timesPerWeek) : 3;
      return { kind: 'weekly', timesPerWeek: Math.min(Math.max(times, 1), 7) };
    }
  }
  return { kind: 'daily' };
}

/**
 * Rebuild a habit from whatever is on disk.
 *
 * Returns null only when there is no usable identity. Everything else degrades to
 * a default, because one malformed file must not be able to stop the garden from
 * opening -- an app that refuses to load is worse than one showing a habit with a
 * default colour.
 */
export function normalizeHabit(value: unknown): Habit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) {
    return null;
  }

  const createdAt = typeof raw.createdAt === 'number' && raw.createdAt > 0 ? raw.createdAt : 0;
  const checkIns = Array.isArray(raw.checkIns) ? raw.checkIns.filter(isDayKey) : [];

  return {
    version: 1,
    id,
    name: name.slice(0, HABIT_NAME_MAX),
    cadence: normalizeCadence(raw.cadence),
    color: typeof raw.color === 'string' && raw.color ? raw.color : HABIT_COLORS[0],
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' && raw.updatedAt > 0 ? raw.updatedAt : createdAt,
    // Deduplicated here so a file with repeated entries cannot inflate a streak.
    checkIns: [...new Set(checkIns)],
    ...(raw.archived === true ? { archived: true } : {}),
  };
}

/**
 * Merge a persisted or agent-written state over the current one, field by field.
 *
 * A partial write must not reset the user's opt-in choices. That matters more
 * here than in most apps: `shareMomentumWithAoi` and `reflectWeatherInRoom` are
 * consent flags, and silently flipping one back to a default would be a privacy
 * regression rather than a cosmetic bug.
 */
export function mergeHabitGardenState(
  current: HabitGardenState,
  incoming: unknown,
): HabitGardenState {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return current;
  }
  const raw = incoming as Record<string, unknown>;
  const next: HabitGardenState = { ...current };

  if (isHabitGardenTab(raw.activeTab)) {
    next.activeTab = raw.activeTab;
  }
  if (typeof raw.selectedHabitId === 'string' && raw.selectedHabitId.trim()) {
    next.selectedHabitId = raw.selectedHabitId.trim();
  } else if (raw.selectedHabitId === null) {
    next.selectedHabitId = null;
  }
  if (typeof raw.reflectWeatherInRoom === 'boolean') {
    next.reflectWeatherInRoom = raw.reflectWeatherInRoom;
  }
  if (typeof raw.shareMomentumWithAoi === 'boolean') {
    next.shareMomentumWithAoi = raw.shareMomentumWithAoi;
  }
  if (typeof raw.restoreRoomItemId === 'string' && raw.restoreRoomItemId.trim()) {
    next.restoreRoomItemId = raw.restoreRoomItemId.trim();
  } else if (raw.restoreRoomItemId === null) {
    next.restoreRoomItemId = null;
  }
  if (typeof raw.lastAppliedWeather === 'string' && raw.lastAppliedWeather.trim()) {
    next.lastAppliedWeather = raw.lastAppliedWeather.trim();
  } else if (raw.lastAppliedWeather === null) {
    next.lastAppliedWeather = null;
  }
  return next;
}
