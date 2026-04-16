/**
 * MusicApp seed data
 * Following guide.md specification
 */

import type { Song, Playlist } from '../types';

export const SEED_SONGS: Song[] = [
  {
    id: 'song-001',
    title: 'Lo-fi Radio',
    artist: 'Lofi Girl',
    album: 'Live Stream',
    duration: 0,
    coverColor: '#E04848',
    createdAt: Date.now() - 86400000 * 7,
    youtubeVideoId: 'jfKfPfyJRdk',
  },
  {
    id: 'song-002',
    title: 'Synthwave Mix',
    artist: 'ThePrimeThanatos',
    album: 'Neon Drive',
    duration: 0,
    coverColor: '#4A90D9',
    createdAt: Date.now() - 86400000 * 6,
    youtubeVideoId: '4xDzrJKXOOY',
  },
  {
    id: 'song-003',
    title: 'Jazz Cafe',
    artist: 'Cafe Music BGM channel',
    album: 'Cafe Session',
    duration: 0,
    coverColor: '#2ECDA7',
    createdAt: Date.now() - 86400000 * 5,
    youtubeVideoId: 'Dx5qFachd3A',
  },
  {
    id: 'song-004',
    title: 'Coding Mode',
    artist: 'Chill Music Lab',
    album: 'Focus Flow',
    duration: 0,
    coverColor: '#9B59B6',
    createdAt: Date.now() - 86400000 * 4,
    youtubeVideoId: '5qap5aO4i9A',
  },
  {
    id: 'song-005',
    title: 'Ambient Space',
    artist: 'SpaceWave',
    album: 'Orbit Drift',
    duration: 0,
    coverColor: '#27AE60',
    createdAt: Date.now() - 86400000 * 3,
    youtubeVideoId: 'JfVOs4VSpmA',
  },
];

export const SEED_PLAYLISTS: Playlist[] = [
  {
    id: 'playlist-001',
    name: 'My Favorites',
    songIds: ['song-001', 'song-002', 'song-003'],
    createdAt: Date.now() - 86400000,
  },
  {
    id: 'playlist-002',
    name: 'Chill Vibes',
    songIds: ['song-003', 'song-005'],
    createdAt: Date.now() - 172800000,
  },
  {
    id: 'playlist-003',
    name: 'Workout Mix',
    songIds: ['song-002', 'song-004'],
    createdAt: Date.now() - 259200000,
  },
];
