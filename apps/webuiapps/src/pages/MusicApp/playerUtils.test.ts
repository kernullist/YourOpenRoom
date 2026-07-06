import { describe, expect, it } from 'vitest';
import { buildEmbedUrl, clampPlayerZoom, MAX_PLAYER_ZOOM, MIN_PLAYER_ZOOM } from './playerUtils';

const ORIGIN = 'https://room.example';

function parseEmbedUrl(url: string): { videoId: string; params: URLSearchParams } {
  const parsed = new URL(url);
  return {
    videoId: parsed.pathname.replace('/embed/', ''),
    params: parsed.searchParams,
  };
}

describe('clampPlayerZoom', () => {
  it('keeps values inside the allowed range', () => {
    expect(clampPlayerZoom(1.5)).toBe(1.5);
  });

  it('clamps values below the minimum', () => {
    expect(clampPlayerZoom(0.25)).toBe(MIN_PLAYER_ZOOM);
  });

  it('clamps values above the maximum', () => {
    expect(clampPlayerZoom(5)).toBe(MAX_PLAYER_ZOOM);
  });

  it('falls back to 1 for non-finite values', () => {
    expect(clampPlayerZoom(Number.NaN)).toBe(1);
    expect(clampPlayerZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('buildEmbedUrl', () => {
  it('builds a single-video url with api access and no autoplay by default', () => {
    const { videoId, params } = parseEmbedUrl(buildEmbedUrl('abc123', { origin: ORIGIN }));
    expect(videoId).toBe('abc123');
    expect(params.get('enablejsapi')).toBe('1');
    expect(params.get('origin')).toBe(ORIGIN);
    expect(params.get('rel')).toBe('0');
    expect(params.get('autoplay')).toBeNull();
    expect(params.get('playlist')).toBeNull();
  });

  it('sets autoplay when requested', () => {
    const { params } = parseEmbedUrl(buildEmbedUrl('abc123', { autoplay: true, origin: ORIGIN }));
    expect(params.get('autoplay')).toBe('1');
  });

  it('encodes the remaining queue as the playlist parameter', () => {
    const { videoId, params } = parseEmbedUrl(
      buildEmbedUrl('a', { queueVideoIds: ['a', 'b', 'c'], origin: ORIGIN }),
    );
    expect(videoId).toBe('a');
    expect(params.get('playlist')).toBe('b,c');
  });

  it('does not add a playlist parameter for a single-item queue', () => {
    const { params } = parseEmbedUrl(buildEmbedUrl('a', { queueVideoIds: ['a'], origin: ORIGIN }));
    expect(params.get('playlist')).toBeNull();
  });

  it('never encodes loop into the url so loop toggles cannot reload the iframe', () => {
    const url = buildEmbedUrl('a', { queueVideoIds: ['a', 'b'], origin: ORIGIN });
    expect(url).not.toContain('loop');
  });

  it('uses the window origin when none is provided', () => {
    const { params } = parseEmbedUrl(buildEmbedUrl('abc123'));
    expect(params.get('origin')).toBe(window.location.origin);
  });
});
