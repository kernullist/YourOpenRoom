import { describe, expect, it, vi } from 'vitest';

import type { YoutubeSearchResult } from './searchUtils';
import {
  addResultToPlaylist,
  buildPlaylistPlayback,
  createDefaultPlaylist,
  createPlaylist,
  createPlaylistItem,
  ensureActivePlaylistId,
  movePlaylistItem,
  normalizePlaylists,
  playlistItemsToResults,
  removePlaylistItem,
  resolvePlaybackItems,
  resolvePlaylist,
} from './playlistUtils';

function makeResult(id: string, title: string): YoutubeSearchResult {
  return {
    id,
    title,
    channel: 'OpenRoom',
    duration: '4:20',
    views: '1M views',
    published: 'today',
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

describe('playlistUtils', () => {
  it('creates and normalizes playlist records', () => {
    const playlist = createPlaylist(
      'Late Night',
      [createPlaylistItem(makeResult('aaa111', 'One'))],
      10,
      'playlist-1',
    );
    const normalized = normalizePlaylists([playlist, { bad: true }]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      id: 'playlist-1',
      name: 'Late Night',
      createdAt: 10,
      updatedAt: 10,
    });
  });

  it('falls back to a valid active playlist id', () => {
    const playlists = [createDefaultPlaylist(), createPlaylist('Focus', [], 20, 'playlist-2')];

    expect(ensureActivePlaylistId(playlists, 'playlist-2')).toBe('playlist-2');
    expect(ensureActivePlaylistId(playlists, 'missing')).toBe('playlist-default');
    expect(resolvePlaylist(playlists, 'playlist-2')?.name).toBe('Focus');
  });

  it('adds a search result to a playlist once', () => {
    const result = makeResult('aaa111', 'First Video');
    const firstAdd = addResultToPlaylist([], result, 100);
    const secondAdd = addResultToPlaylist(firstAdd, result, 200);

    expect(firstAdd).toHaveLength(1);
    expect(secondAdd).toHaveLength(1);
    expect(secondAdd[0]).toMatchObject({
      id: 'aaa111',
      title: 'First Video',
      addedAt: 100,
    });
  });

  it('moves and removes playlist items', () => {
    const items = [
      createPlaylistItem(makeResult('aaa111', 'First'), 100),
      createPlaylistItem(makeResult('bbb222', 'Second'), 200),
      createPlaylistItem(makeResult('ccc333', 'Third'), 300),
    ];

    const moved = movePlaylistItem(items, 'ccc333', 'up');
    const trimmed = removePlaylistItem(moved, 'bbb222');

    expect(moved.map((item) => item.id)).toEqual(['aaa111', 'ccc333', 'bbb222']);
    expect(trimmed.map((item) => item.id)).toEqual(['aaa111', 'ccc333']);
  });

  it('builds playlist playback queues and resolves ordered items', () => {
    const items = [
      createPlaylistItem(makeResult('aaa111', 'First'), 100),
      createPlaylistItem(makeResult('bbb222', 'Second'), 200),
      createPlaylistItem(makeResult('ccc333', 'Third'), 300),
    ];

    const sequential = buildPlaylistPlayback('playlist-1', items, 'sequential', 'bbb222', 500);
    expect(sequential).toEqual({
      playlistId: 'playlist-1',
      mode: 'sequential',
      order: ['bbb222', 'ccc333', 'aaa111'],
      startedAt: 500,
    });

    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.4);

    const shuffle = buildPlaylistPlayback('playlist-1', items, 'shuffle', 'aaa111', 700);
    const resolved = resolvePlaybackItems(items, shuffle);
    const resultItems = playlistItemsToResults(resolved);

    expect(shuffle).toEqual({
      playlistId: 'playlist-1',
      mode: 'shuffle',
      order: ['aaa111', 'bbb222', 'ccc333'],
      startedAt: 700,
    });
    expect(resultItems.map((item) => item.id)).toEqual(['aaa111', 'bbb222', 'ccc333']);
  });
});
