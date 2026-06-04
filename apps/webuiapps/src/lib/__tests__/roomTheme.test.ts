import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOM_ITEM_ID,
  DEFAULT_VIDEO_WALLPAPER,
  buildRoomThemeSnapshot,
  createAppliedRoomThemeState,
  createPreviewRoomThemeState,
  createResetRoomThemeState,
  getWallpaperBackgroundImage,
  isVideoWallpaper,
  normalizeRoomThemeState,
} from '../roomTheme';

describe('room theme model', () => {
  it('keeps the active mood when applying a wallpaper-only item', () => {
    const moodState = createAppliedRoomThemeState('pixel-arcade', createResetRoomThemeState());
    const nextState = createAppliedRoomThemeState('minimal-white-studio', moodState);

    expect(nextState.activeWallpaperId).toBe('minimal-white-studio');
    expect(nextState.activeMoodId).toBe('pixel-arcade');
    expect(nextState.previewItemId).toBeNull();
    expect(nextState.liveWallpaper).toBe(true);
  });

  it('previews a wallpaper without replacing the active Aoi room or desk mood', () => {
    const moodState = createAppliedRoomThemeState('rainy-window-desk', createResetRoomThemeState());
    const previewState = createPreviewRoomThemeState('soft-pastel-desk', moodState);
    const snapshot = buildRoomThemeSnapshot(previewState);

    expect(snapshot.previewItem?.id).toBe('soft-pastel-desk');
    expect(snapshot.wallpaperItem.id).toBe('soft-pastel-desk');
    expect(snapshot.moodItem.id).toBe('rainy-window-desk');
    expect(snapshot.wallpaper).toBe(DEFAULT_VIDEO_WALLPAPER);
    expect(snapshot.liveWallpaper).toBe(true);
  });

  it('keeps the Aoi live wallpaper as the desktop base after applying a wallpaper item', () => {
    const moodState = createAppliedRoomThemeState('rainy-window-desk', createResetRoomThemeState());
    const wallpaperState = createAppliedRoomThemeState('soft-pastel-desk', moodState);
    const snapshot = buildRoomThemeSnapshot(wallpaperState);

    expect(snapshot.wallpaperItem.id).toBe('soft-pastel-desk');
    expect(snapshot.moodItem.id).toBe('rainy-window-desk');
    expect(snapshot.wallpaper).toBe(DEFAULT_VIDEO_WALLPAPER);
    expect(snapshot.liveWallpaper).toBe(true);
  });

  it('normalizes invalid active item IDs back to the default room', () => {
    const normalized = normalizeRoomThemeState({
      activeWallpaperId: 'missing-wallpaper',
      activeMoodId: 'minimal-white-studio',
      previewItemId: 'also-missing',
      liveWallpaper: 'yes',
      updatedAt: Number.NaN,
    });

    expect(normalized).toEqual({
      activeWallpaperId: DEFAULT_ROOM_ITEM_ID,
      activeMoodId: DEFAULT_ROOM_ITEM_ID,
      previewItemId: null,
      liveWallpaper: true,
      updatedAt: 0,
    });
  });

  it('keeps CSS gradients raw and quotes URLs for background-image usage', () => {
    expect(getWallpaperBackgroundImage(' linear-gradient(135deg, #000, #fff) ')).toBe(
      'linear-gradient(135deg, #000, #fff)',
    );
    expect(getWallpaperBackgroundImage('https://example.com/a"b.png')).toBe(
      'url("https://example.com/a\\"b.png")',
    );
  });

  it('detects only URL-like video wallpapers', () => {
    expect(isVideoWallpaper(DEFAULT_VIDEO_WALLPAPER)).toBe(true);
    expect(isVideoWallpaper('radial-gradient(circle, #000, #fff)')).toBe(false);
  });
});
