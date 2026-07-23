import { describe, expect, it } from 'vitest';
import type { AoiProactiveBriefSource } from '../aoiAutonomyTypes';
import {
  aoiProactiveBriefMediaBucketLabel,
  aoiProactiveBriefMediaKindLabel,
  classifyAoiProactiveBriefMediaKind,
  deriveAoiProactiveBriefMediaBucket,
  mediaKindToBucket,
} from '../aoiProactiveMediaKind';

function makeSource(partial: Partial<AoiProactiveBriefSource>): AoiProactiveBriefSource {
  return {
    title: partial.title ?? 'Source',
    url: partial.url ?? 'https://example.com/a',
    host: partial.host ?? 'example.com',
    retrievedAt: partial.retrievedAt ?? 1000,
    snippet: partial.snippet ?? 'snippet',
    ...(partial.publishedAt ? { publishedAt: partial.publishedAt } : {}),
    ...(partial.mediaKind ? { mediaKind: partial.mediaKind } : {}),
  };
}

describe('classifyAoiProactiveBriefMediaKind', () => {
  it('classifies known video hosts as video', () => {
    expect(classifyAoiProactiveBriefMediaKind({ host: 'youtube.com' })).toBe('video');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'www.youtube.com' })).toBe('video');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'youtu.be' })).toBe('video');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'vimeo.com' })).toBe('video');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'clips.twitch.tv' })).toBe('video');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'www.ted.com' })).toBe('video');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'bilibili.com' })).toBe('video');
  });

  it('classifies known podcast hosts as podcast', () => {
    expect(classifyAoiProactiveBriefMediaKind({ host: 'overcast.fm' })).toBe('podcast');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'anchor.fm' })).toBe('podcast');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'podcasts.apple.com' })).toBe('podcast');
  });

  it('classifies known music hosts as music', () => {
    expect(classifyAoiProactiveBriefMediaKind({ host: 'soundcloud.com' })).toBe('music');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'bandcamp.com' })).toBe('music');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'music.youtube.com' })).toBe('music');
    expect(classifyAoiProactiveBriefMediaKind({ host: 'music.apple.com' })).toBe('music');
  });

  it('splits spotify into podcast vs music by path', () => {
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'open.spotify.com',
        url: 'https://open.spotify.com/episode/abc123',
      }),
    ).toBe('podcast');
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'open.spotify.com',
        url: 'https://open.spotify.com/show/abc123',
      }),
    ).toBe('podcast');
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'open.spotify.com',
        url: 'https://open.spotify.com/track/xyz789',
      }),
    ).toBe('music');
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'open.spotify.com',
        url: 'https://open.spotify.com/playlist/xyz789',
      }),
    ).toBe('music');
  });

  it('derives host from the url when host is missing', () => {
    expect(classifyAoiProactiveBriefMediaKind({ url: 'https://www.youtube.com/watch?v=abc' })).toBe(
      'video',
    );
  });

  it('uses generic url/title hints for unlisted hosts', () => {
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'conf.example.org',
        url: 'https://conf.example.org/watch/keynote',
      }),
    ).toBe('video');
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'blog.example.org',
        title: 'Our new security podcast episode',
      }),
    ).toBe('podcast');
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'blog.example.org',
        title: 'Curated boss-fight OST playlist',
      }),
    ).toBe('music');
  });

  it('falls back to article for plain web pages', () => {
    expect(
      classifyAoiProactiveBriefMediaKind({
        host: 'learn.microsoft.com',
        url: 'https://learn.microsoft.com/windows/kernel',
        title: 'Kernel-mode driver architecture',
      }),
    ).toBe('article');
    expect(classifyAoiProactiveBriefMediaKind({})).toBe('article');
  });

  it('is resilient to malformed urls', () => {
    expect(classifyAoiProactiveBriefMediaKind({ url: 'not a url' })).toBe('article');
    expect(classifyAoiProactiveBriefMediaKind({ host: '', url: '::::' })).toBe('article');
  });
});

describe('mediaKindToBucket', () => {
  it('maps kinds to watch/listen/read', () => {
    expect(mediaKindToBucket('video')).toBe('watch');
    expect(mediaKindToBucket('podcast')).toBe('listen');
    expect(mediaKindToBucket('music')).toBe('listen');
    expect(mediaKindToBucket('article')).toBe('read');
  });
});

describe('deriveAoiProactiveBriefMediaBucket', () => {
  it('returns read for an empty source list', () => {
    expect(deriveAoiProactiveBriefMediaBucket([])).toBe('read');
  });

  it('uses the dominant bucket', () => {
    const sources = [
      makeSource({ mediaKind: 'video' }),
      makeSource({ mediaKind: 'video' }),
      makeSource({ mediaKind: 'article' }),
    ];
    expect(deriveAoiProactiveBriefMediaBucket(sources)).toBe('watch');
  });

  it('groups podcast and music together as listen', () => {
    const sources = [
      makeSource({ mediaKind: 'podcast' }),
      makeSource({ mediaKind: 'music' }),
      makeSource({ mediaKind: 'article' }),
    ];
    expect(deriveAoiProactiveBriefMediaBucket(sources)).toBe('listen');
  });

  it('returns mixed on an exact tie between top buckets', () => {
    const sources = [makeSource({ mediaKind: 'video' }), makeSource({ mediaKind: 'article' })];
    expect(deriveAoiProactiveBriefMediaBucket(sources)).toBe('mixed');
  });

  it('classifies sources on the fly when mediaKind is absent', () => {
    const sources = [
      makeSource({ host: 'youtube.com', mediaKind: undefined }),
      makeSource({ host: 'youtu.be', mediaKind: undefined }),
      makeSource({ host: 'learn.microsoft.com', mediaKind: undefined }),
    ];
    expect(deriveAoiProactiveBriefMediaBucket(sources)).toBe('watch');
  });
});

describe('label helpers', () => {
  it('labels buckets', () => {
    expect(aoiProactiveBriefMediaBucketLabel('watch')).toBe('Watch');
    expect(aoiProactiveBriefMediaBucketLabel('listen')).toBe('Listen');
    expect(aoiProactiveBriefMediaBucketLabel('read')).toBe('Read');
    expect(aoiProactiveBriefMediaBucketLabel('mixed')).toBe('Mixed');
  });

  it('labels kinds', () => {
    expect(aoiProactiveBriefMediaKindLabel('video')).toBe('video');
    expect(aoiProactiveBriefMediaKindLabel('podcast')).toBe('podcast');
    expect(aoiProactiveBriefMediaKindLabel('music')).toBe('music');
    expect(aoiProactiveBriefMediaKindLabel('article')).toBe('article');
  });
});
