import type { YoutubeSearchResult } from './searchUtils';

export const DEFAULT_PLAYLIST_ID = 'playlist-default';
export const DEFAULT_PLAYLIST_NAME = 'My Playlist';

export interface PlaylistItem extends YoutubeSearchResult {
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
  createdAt: number;
  updatedAt: number;
}

export type PlaylistPlaybackMode = 'sequential' | 'shuffle';

export interface PlaylistPlayback {
  playlistId: string;
  mode: PlaylistPlaybackMode;
  order: string[];
  startedAt: number;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isPlaylistItem(value: unknown): value is PlaylistItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    isString(item.id) &&
    isString(item.title) &&
    isString(item.channel) &&
    isString(item.duration) &&
    isString(item.views) &&
    isString(item.published) &&
    isString(item.thumbnail) &&
    isString(item.url) &&
    typeof item.addedAt === 'number'
  );
}

function isPlaylist(value: unknown): value is Playlist {
  if (!value || typeof value !== 'object') return false;
  const playlist = value as Record<string, unknown>;
  return (
    isString(playlist.id) &&
    isString(playlist.name) &&
    Array.isArray(playlist.items) &&
    playlist.items.every(isPlaylistItem) &&
    typeof playlist.createdAt === 'number' &&
    typeof playlist.updatedAt === 'number'
  );
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items;
  }

  const nextItems = [...items];
  const [moved] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, moved);
  return nextItems;
}

function rotateItems<T extends { id: string }>(items: T[], startItemId?: string): T[] {
  if (!startItemId) return [...items];
  const startIndex = items.findIndex((item) => item.id === startItemId);
  if (startIndex <= 0) return [...items];
  return [...items.slice(startIndex), ...items.slice(0, startIndex)];
}

function shuffleItems<T>(items: T[]): T[] {
  const nextItems = [...items];
  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]];
  }
  return nextItems;
}

export function normalizePlaylistItems(raw: unknown): PlaylistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlaylistItem);
}

export function createPlaylistItem(
  result: YoutubeSearchResult,
  addedAt: number = Date.now(),
): PlaylistItem {
  return {
    ...result,
    addedAt,
  };
}

export function createPlaylist(
  name: string = DEFAULT_PLAYLIST_NAME,
  items: PlaylistItem[] = [],
  createdAt: number = Date.now(),
  id: string = `playlist_${createdAt}`,
): Playlist {
  return {
    id,
    name: name.trim() || DEFAULT_PLAYLIST_NAME,
    items,
    createdAt,
    updatedAt: createdAt,
  };
}

export function createDefaultPlaylist(): Playlist {
  return createPlaylist(DEFAULT_PLAYLIST_NAME, [], 0, DEFAULT_PLAYLIST_ID);
}

export function normalizePlaylists(raw: unknown): Playlist[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlaylist);
}

export function ensureActivePlaylistId(
  playlists: Playlist[],
  activePlaylistId?: string | null,
): string | null {
  if (activePlaylistId && playlists.some((playlist) => playlist.id === activePlaylistId)) {
    return activePlaylistId;
  }
  return playlists[0]?.id ?? null;
}

export function resolvePlaylist(
  playlists: Playlist[],
  playlistId?: string | null,
): Playlist | null {
  if (!playlistId) return playlists[0] ?? null;
  return playlists.find((playlist) => playlist.id === playlistId) ?? playlists[0] ?? null;
}

export function addResultToPlaylist(
  items: PlaylistItem[],
  result: YoutubeSearchResult,
  addedAt: number = Date.now(),
): PlaylistItem[] {
  if (items.some((item) => item.id === result.id)) {
    return items;
  }
  return [...items, createPlaylistItem(result, addedAt)];
}

export function removePlaylistItem(items: PlaylistItem[], itemId: string): PlaylistItem[] {
  return items.filter((item) => item.id !== itemId);
}

export function movePlaylistItem(
  items: PlaylistItem[],
  itemId: string,
  direction: 'up' | 'down',
): PlaylistItem[] {
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) return items;
  const nextIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1;
  return moveItem(items, itemIndex, nextIndex);
}

export function playlistItemsToResults(items: PlaylistItem[]): YoutubeSearchResult[] {
  return items.map(({ addedAt: _addedAt, ...result }) => result);
}

export function buildPlaylistPlayback(
  playlistId: string,
  items: PlaylistItem[],
  mode: PlaylistPlaybackMode,
  startItemId?: string,
  startedAt: number = Date.now(),
): PlaylistPlayback | null {
  if (items.length === 0) return null;

  const rotated = rotateItems(items, startItemId);
  let orderedItems: PlaylistItem[];

  if (mode === 'shuffle') {
    const [firstItem, ...restItems] = rotated;
    orderedItems =
      firstItem && startItemId ? [firstItem, ...shuffleItems(restItems)] : shuffleItems(rotated);
  } else {
    orderedItems = rotated;
  }

  return {
    playlistId,
    mode,
    order: orderedItems.map((item) => item.id),
    startedAt,
  };
}

export function resolvePlaybackItems(
  items: PlaylistItem[],
  playback: PlaylistPlayback | null,
): PlaylistItem[] {
  if (!playback) return [];
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return playback.order
    .map((itemId) => itemsById.get(itemId) || null)
    .filter((item): item is PlaylistItem => item !== null);
}
