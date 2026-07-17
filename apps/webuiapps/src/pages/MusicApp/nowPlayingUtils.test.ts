import { describe, expect, it } from 'vitest';
import { buildNowPlaying, buildPlayVideoParams, normalizeNowPlaying } from './nowPlayingUtils';

const ITEM = { id: 'vid-aaa', title: 'First Fixture Video', channel: 'OpenRoom' };

describe('buildNowPlaying', () => {
  it('builds a fresh snapshot with startedAt = now for a new video', () => {
    const snapshot = buildNowPlaying(ITEM, 'Queue Mix', 1_000, null);
    expect(snapshot).toEqual({
      videoId: 'vid-aaa',
      title: 'First Fixture Video',
      channel: 'OpenRoom',
      queueName: 'Queue Mix',
      startedAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it('preserves startedAt while the same video keeps playing', () => {
    const first = buildNowPlaying(ITEM, null, 1_000, null);
    const second = buildNowPlaying(ITEM, 'Queue Mix', 5_000, first);
    expect(second.startedAt).toBe(1_000);
    expect(second.updatedAt).toBe(5_000);
    expect(second.queueName).toBe('Queue Mix');
  });

  it('restarts the clock when a different video starts', () => {
    const first = buildNowPlaying(ITEM, null, 1_000, null);
    const second = buildNowPlaying(
      { id: 'vid-bbb', title: 'Second Fixture Video', channel: 'OpenRoom' },
      null,
      5_000,
      first,
    );
    expect(second.videoId).toBe('vid-bbb');
    expect(second.startedAt).toBe(5_000);
  });

  it('collapses blank queue names to null', () => {
    expect(buildNowPlaying(ITEM, '   ', 1_000, null).queueName).toBeNull();
    expect(buildNowPlaying(ITEM, '', 1_000, null).queueName).toBeNull();
  });
});

describe('normalizeNowPlaying', () => {
  it('returns null for non-objects and arrays', () => {
    expect(normalizeNowPlaying(undefined)).toBeNull();
    expect(normalizeNowPlaying(null)).toBeNull();
    expect(normalizeNowPlaying('vid-aaa')).toBeNull();
    expect(normalizeNowPlaying(42)).toBeNull();
    expect(normalizeNowPlaying([])).toBeNull();
  });

  it('returns null when videoId or title is missing or blank', () => {
    expect(normalizeNowPlaying({ title: 'x' })).toBeNull();
    expect(normalizeNowPlaying({ videoId: 'vid-aaa' })).toBeNull();
    expect(normalizeNowPlaying({ videoId: '  ', title: 'x' })).toBeNull();
    expect(normalizeNowPlaying({ videoId: 'vid-aaa', title: '  ' })).toBeNull();
  });

  it('fills defensive defaults for malformed optional fields', () => {
    expect(
      normalizeNowPlaying({
        videoId: 'vid-aaa',
        title: 'First Fixture Video',
        channel: 7,
        queueName: 9,
        startedAt: 'nope',
        updatedAt: Number.NaN,
      }),
    ).toEqual({
      videoId: 'vid-aaa',
      title: 'First Fixture Video',
      channel: '',
      queueName: null,
      startedAt: 0,
      updatedAt: 0,
    });
  });

  it('round-trips a valid snapshot', () => {
    const snapshot = buildNowPlaying(ITEM, 'Queue Mix', 1_234, null);
    expect(normalizeNowPlaying(snapshot)).toEqual(snapshot);
  });

  it('collapses a blank persisted queueName to null', () => {
    const parsed = normalizeNowPlaying({
      videoId: 'vid-aaa',
      title: 'First Fixture Video',
      queueName: '   ',
    });
    expect(parsed?.queueName).toBeNull();
  });
});

describe('buildPlayVideoParams', () => {
  it('produces string-only params with the queue name', () => {
    expect(buildPlayVideoParams(ITEM, 'Queue Mix')).toEqual({
      video_id: 'vid-aaa',
      title: 'First Fixture Video',
      channel: 'OpenRoom',
      queue: 'Queue Mix',
    });
  });

  it('uses an empty queue string outside queue playback', () => {
    expect(buildPlayVideoParams(ITEM, null).queue).toBe('');
    expect(buildPlayVideoParams(ITEM, '  ').queue).toBe('');
  });
});
