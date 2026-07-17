import { describe, expect, it } from 'vitest';

import { validateAppDataWrite } from '../appDataSchemas';

describe('validateAppDataWrite()', () => {
  it('validates and normalizes a notes note payload', () => {
    const result = validateAppDataWrite(
      'apps/notes/data/notes/weekly-synthesis.json',
      JSON.stringify({
        id: 'weekly-synthesis',
        title: 'Weekly synthesis',
        content: '# Notes',
        tags: ['weekly'],
        pinned: false,
        createdAt: 1776200000000,
        updatedAt: 1776203600000,
      }),
    );

    expect(result?.ok).toBe(true);
    if (result && result.ok) {
      expect(result.schemaId).toBe('notes-note');
      expect(JSON.parse(result.normalizedContent).id).toBe('weekly-synthesis');
    }
  });

  it('rejects invalid email folder values', () => {
    const result = validateAppDataWrite(
      'apps/email/data/emails/mail-1.json',
      JSON.stringify({
        id: 'mail-1',
        from: { name: 'Alice', address: 'alice@example.com' },
        to: [{ name: 'Bob', address: 'bob@example.com' }],
        cc: [],
        subject: 'Hello',
        content: 'Hi',
        timestamp: 1776200000000,
        isRead: false,
        isStarred: false,
        folder: 'archive',
      }),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.errors[0]).toContain('folder must be one of');
    }
  });

  it('validates a room shop state payload', () => {
    const result = validateAppDataWrite(
      'apps/roomshop/data/state.json',
      JSON.stringify({
        activeWallpaperId: 'rainy-window-desk',
        activeMoodId: 'rainy-window-desk',
        previewItemId: null,
        liveWallpaper: false,
        updatedAt: 1776200000000,
      }),
    );

    expect(result?.ok).toBe(true);
    if (result && result.ok) {
      expect(result.schemaId).toBe('roomshop-state');
      expect(JSON.parse(result.normalizedContent).activeWallpaperId).toBe('rainy-window-desk');
    }
  });

  // The registry validator treats null as missing for required nullable-string
  // fields, so the base payload uses concrete values for the playlist ids.
  const YOUTUBE_STATE_BASE = {
    searchQuery: 'lofi beats',
    recentSearches: [],
    favoriteTopics: ['lofi hip hop'],
    playlists: [],
    activePlaylistId: 'pl-default',
    lastPlayedPlaylistId: 'pl-default',
    lastPlayedPlaylistMode: 'sequential',
    sidebarOpen: false,
    resultsAutoHide: false,
    loopPlayback: false,
    playerZoom: 1,
  };

  it('accepts a youtube state payload with a now-playing snapshot', () => {
    const result = validateAppDataWrite(
      'apps/youtube/data/state.json',
      JSON.stringify({
        ...YOUTUBE_STATE_BASE,
        nowPlaying: {
          videoId: 'vid-aaa',
          title: 'First Fixture Video',
          channel: 'OpenRoom',
          queueName: 'Queue Mix',
          startedAt: 1776200000000,
          updatedAt: 1776200005000,
        },
      }),
    );

    expect(result?.ok).toBe(true);
    if (result && result.ok) {
      expect(result.schemaId).toBe('youtube-state');
      expect(JSON.parse(result.normalizedContent).nowPlaying).toEqual({
        videoId: 'vid-aaa',
        title: 'First Fixture Video',
        channel: 'OpenRoom',
        queueName: 'Queue Mix',
        startedAt: 1776200000000,
        updatedAt: 1776200005000,
      });
    }
  });

  it('accepts a youtube state payload with nowPlaying null or absent', () => {
    const withNull = validateAppDataWrite(
      'apps/youtube/data/state.json',
      JSON.stringify({ ...YOUTUBE_STATE_BASE, nowPlaying: null }),
    );
    expect(withNull?.ok).toBe(true);
    if (withNull && withNull.ok) {
      expect(JSON.parse(withNull.normalizedContent).nowPlaying).toBeNull();
    }

    const absent = validateAppDataWrite(
      'apps/youtube/data/state.json',
      JSON.stringify(YOUTUBE_STATE_BASE),
    );
    expect(absent?.ok).toBe(true);
    if (absent && absent.ok) {
      expect(JSON.parse(absent.normalizedContent).nowPlaying).toBeNull();
    }
  });

  it('rejects a malformed youtube now-playing snapshot', () => {
    const result = validateAppDataWrite(
      'apps/youtube/data/state.json',
      JSON.stringify({
        ...YOUTUBE_STATE_BASE,
        nowPlaying: { videoId: 42, startedAt: 'later' },
      }),
    );

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.errors.some((error) => error.includes('videoId must be a string'))).toBe(true);
      expect(result.errors.some((error) => error.includes('startedAt must be an integer'))).toBe(
        true,
      );
    }
  });
});
