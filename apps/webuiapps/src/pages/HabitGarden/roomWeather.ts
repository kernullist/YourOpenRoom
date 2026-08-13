import {
  createAppliedRoomThemeState,
  emitRoomThemeChanged,
  findRoomShopItem,
  loadRoomThemeState,
  persistRoomThemeState,
  type RoomThemeState,
} from '@/lib/roomTheme';
import type { GardenWeatherKind } from './garden';

// Reflecting the garden's weather onto the desktop.
//
// This goes through the SAME path RoomShop uses -- createAppliedRoomThemeState
// plus persistRoomThemeState -- rather than writing the theme key directly. Two
// apps with two ways of changing the room end up fighting each other, and the
// user experiences it as a wallpaper that flickers back for no reason.

export const WEATHER_ROOM_ITEMS: Record<GardenWeatherKind, string | null> = {
  rain: 'rainy-window-desk',
  cloudy: 'lofi-cafe-night',
  sunny: 'pixel-arcade',
  // Nothing is claimed about an unknown garden, so nothing is applied.
  unknown: null,
};

export function roomItemForWeather(weather: GardenWeatherKind): string | null {
  const id = WEATHER_ROOM_ITEMS[weather];
  return id && findRoomShopItem(id) ? id : null;
}

export interface WeatherRoomDecision {
  /** The room item to apply, or null to leave the room alone. */
  applyItemId: string | null;
  /** The weather value to record as applied (null keeps the previous record). */
  nextAppliedWeather: string | null;
  reason: 'disabled' | 'unknown-weather' | 'unchanged' | 'apply' | 'restore';
}

/**
 * Decide whether the room should change.
 *
 * The `lastAppliedWeather` comparison is what stops this from re-applying on
 * every render. Without it, a user who picks a theme in RoomShop would watch it
 * revert on the garden's next poll, and would rightly conclude the app is broken.
 */
export function decideWeatherRoom(params: {
  enabled: boolean;
  weather: GardenWeatherKind;
  lastAppliedWeather: string | null;
  restoreRoomItemId: string | null;
}): WeatherRoomDecision {
  if (!params.enabled) {
    // Turning the toggle off restores what the user had before it was turned on.
    if (params.lastAppliedWeather !== null) {
      return {
        applyItemId: params.restoreRoomItemId,
        nextAppliedWeather: null,
        reason: 'restore',
      };
    }
    return { applyItemId: null, nextAppliedWeather: null, reason: 'disabled' };
  }

  const itemId = roomItemForWeather(params.weather);
  if (!itemId) {
    return {
      applyItemId: null,
      nextAppliedWeather: params.lastAppliedWeather,
      reason: 'unknown-weather',
    };
  }
  if (params.lastAppliedWeather === params.weather) {
    return {
      applyItemId: null,
      nextAppliedWeather: params.lastAppliedWeather,
      reason: 'unchanged',
    };
  }
  return { applyItemId: itemId, nextAppliedWeather: params.weather, reason: 'apply' };
}

export function currentRoomItemId(): string | null {
  try {
    return loadRoomThemeState().activeWallpaperId ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply a room item.
 *
 * Persists to localStorage and fires the room-theme event. The Shell listens for
 * both that event and the `storage` event, and since this app runs in its own
 * iframe it is the storage event that actually carries the change across.
 */
export function applyRoomItem(itemId: string): RoomThemeState | null {
  try {
    const next = persistRoomThemeState(createAppliedRoomThemeState(itemId, loadRoomThemeState()));
    emitRoomThemeChanged(next, 'habit-garden-weather');
    return next;
  } catch {
    // A theme that fails to apply must never take the garden down with it.
    return null;
  }
}
