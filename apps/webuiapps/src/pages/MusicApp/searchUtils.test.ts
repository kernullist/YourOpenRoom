import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDirectResult,
  extractYoutubeVideoId,
  fetchYoutubeSearchResults,
  normalizeExternalSearchResultsToYoutube,
  parseDuckDuckGoResults,
  parseGoogleSearchResults,
} from './searchUtils';

describe('MusicApp search utils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('extracts video ids from common YouTube URLs', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=jfKfPfyJRdk')).toBe(
      'jfKfPfyJRdk',
    );
    expect(extractYoutubeVideoId('https://youtu.be/jfKfPfyJRdk')).toBe('jfKfPfyJRdk');
    expect(extractYoutubeVideoId('https://www.youtube.com/shorts/jfKfPfyJRdk')).toBe('jfKfPfyJRdk');
  });

  it('parses search engine results into YouTube entries', () => {
    const googleResults = parseGoogleSearchResults(`
      <html>
        <body>
          <div>
            <a href="/url?q=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjfKfPfyJRdk">
              <h3>Lofi Beats - YouTube</h3>
            </a>
          </div>
        </body>
      </html>
    `);
    const normalized = normalizeExternalSearchResultsToYoutube(googleResults);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      id: 'jfKfPfyJRdk',
      title: 'Lofi Beats',
      url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    });
  });

  it('falls back to browser-reader search results when the YouTube API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'fetch failed' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            `
              <html>
                <body>
                  <div class="result">
                    <a class="result__a" href="https://www.youtube.com/watch?v=jfKfPfyJRdk">
                      Lofi Beats - YouTube
                    </a>
                    <div class="result__snippet">A fallback result.</div>
                  </div>
                </body>
              </html>
            `,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            },
          ),
        ),
    );

    const results = await fetchYoutubeSearchResults('lofi beats');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'jfKfPfyJRdk',
      title: 'Lofi Beats',
      url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    });
  });

  it('builds a direct playable result from a YouTube URL', () => {
    expect(buildDirectResult('https://www.youtube.com/watch?v=jfKfPfyJRdk')).toMatchObject({
      id: 'jfKfPfyJRdk',
      title: 'YouTube Video',
    });
  });

  it('parses DuckDuckGo HTML result links', () => {
    const results = parseDuckDuckGoResults(`
      <html>
        <body>
          <div class="result">
            <a class="result__a" href="https://youtu.be/jfKfPfyJRdk">Study Stream - YouTube</a>
            <div class="result__snippet">DDG fallback.</div>
          </div>
        </body>
      </html>
    `);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://youtu.be/jfKfPfyJRdk');
  });
});
