import { describe, expect, it } from 'vitest';
import { decideWeatherRoom, roomItemForWeather, WEATHER_ROOM_ITEMS } from '../roomWeather';
import { findRoomShopItem } from '@/lib/roomTheme';

// The decision layer is pure so the "do not fight RoomShop" rule is testable
// without a DOM. The failure this guards against is subtle: a theme that keeps
// reverting after the user picks one reads as a broken app, not as a feature.

describe('roomItemForWeather', () => {
  it('maps each real weather to an item that actually exists in the catalogue', () => {
    for (const weather of ['sunny', 'cloudy', 'rain'] as const) {
      const id = roomItemForWeather(weather);
      expect(id).toBe(WEATHER_ROOM_ITEMS[weather]);
      expect(findRoomShopItem(id as string)).not.toBeNull();
    }
  });

  it('maps unknown weather to nothing', () => {
    expect(roomItemForWeather('unknown')).toBeNull();
  });
});

describe('decideWeatherRoom', () => {
  it('does nothing while the toggle is off and nothing was applied', () => {
    const decision = decideWeatherRoom({
      enabled: false,
      weather: 'rain',
      lastAppliedWeather: null,
      restoreRoomItemId: 'moonlit-library',
    });

    expect(decision.applyItemId).toBeNull();
    expect(decision.reason).toBe('disabled');
  });

  it('restores the previous room when the toggle is switched off', () => {
    const decision = decideWeatherRoom({
      enabled: false,
      weather: 'rain',
      lastAppliedWeather: 'rain',
      restoreRoomItemId: 'moonlit-library',
    });

    expect(decision.applyItemId).toBe('moonlit-library');
    expect(decision.nextAppliedWeather).toBeNull();
    expect(decision.reason).toBe('restore');
  });

  it('applies on a weather change', () => {
    const decision = decideWeatherRoom({
      enabled: true,
      weather: 'rain',
      lastAppliedWeather: 'sunny',
      restoreRoomItemId: null,
    });

    expect(decision.applyItemId).toBe('rainy-window-desk');
    expect(decision.nextAppliedWeather).toBe('rain');
    expect(decision.reason).toBe('apply');
  });

  it('applies the first time, from no previous record', () => {
    const decision = decideWeatherRoom({
      enabled: true,
      weather: 'cloudy',
      lastAppliedWeather: null,
      restoreRoomItemId: null,
    });

    expect(decision.applyItemId).toBe('lofi-cafe-night');
  });

  it('does NOT re-apply when the weather has not changed', () => {
    // Without this, every poll would overwrite whatever the user just chose in
    // RoomShop, and the desktop would appear to reject their choice.
    const decision = decideWeatherRoom({
      enabled: true,
      weather: 'rain',
      lastAppliedWeather: 'rain',
      restoreRoomItemId: null,
    });

    expect(decision.applyItemId).toBeNull();
    expect(decision.reason).toBe('unchanged');
  });

  it('leaves the room alone for unknown weather', () => {
    const decision = decideWeatherRoom({
      enabled: true,
      weather: 'unknown',
      lastAppliedWeather: 'sunny',
      restoreRoomItemId: null,
    });

    expect(decision.applyItemId).toBeNull();
    expect(decision.reason).toBe('unknown-weather');
    // The previous record survives, so returning to 'sunny' later still counts
    // as unchanged rather than triggering a redundant re-apply.
    expect(decision.nextAppliedWeather).toBe('sunny');
  });

  it('restores to nothing when there is no backup to return to', () => {
    const decision = decideWeatherRoom({
      enabled: false,
      weather: 'sunny',
      lastAppliedWeather: 'sunny',
      restoreRoomItemId: null,
    });

    expect(decision.applyItemId).toBeNull();
    expect(decision.reason).toBe('restore');
  });
});
