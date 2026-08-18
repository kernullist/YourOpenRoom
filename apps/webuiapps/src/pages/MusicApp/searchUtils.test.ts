import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDirectResult,
  extractYoutubeVideoId,
  fetchYoutubeSearchResults,
  normalizeExternalSearchResultsToYoutube,
  parseDuckDuckGoResults,
  parseGoogleSearchResults,
  pickAutoplayResult,
  type YoutubeSearchResult,
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

describe('pickAutoplayResult', () => {
  function result(id: string, title: string, channel = '달플리 𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕'): YoutubeSearchResult {
    return {
      id,
      title,
      channel,
      duration: '1:02:53',
      views: '112,033 views',
      published: '2 weeks ago',
      thumbnail: '',
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  const JULY = '2026년 7월 여돌 노래모음 | 🔥 KPOP PLAYLIST';
  const AUGUST = '2026년 8월 여돌 노래모음 | 🔥 KPOP PLAYLIST';

  it('starts the video the query names even when YouTube ranks a sibling first', () => {
    // The reported failure: Aoi announced the August mix, YouTube returned the
    // July upload first (older, more views), and autoplay took the top hit.
    const results = [result('july', JULY), result('august', AUGUST)];
    const picked = pickAutoplayResult(results, `${AUGUST} - 달플리 𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕`);
    expect(picked?.id).toBe('august');
  });

  it('matches an exact title anywhere in the list', () => {
    const results = [result('a', JULY), result('b', AUGUST)];
    expect(pickAutoplayResult(results, AUGUST)?.id).toBe('b');
  });

  it('folds styled unicode so a stored query still matches the returned title', () => {
    // Titles in this genre use mathematical bold italic letters; NFKC maps them
    // onto plain ones on both sides of the comparison.
    const results = [result('a', 'Chill Mix'), result('b', 'Late Night 𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕 vol 3')];
    expect(pickAutoplayResult(results, 'late night playlist VOL 3')?.id).toBe('b');
  });

  it('matches a title that carries an extra suffix', () => {
    const results = [
      result('a', 'Some Other Long Mix Title'),
      result('b', 'Deep Focus Coding Session [4K]'),
    ];
    expect(pickAutoplayResult(results, 'Deep Focus Coding Session')?.id).toBe('b');
  });

  it('prefers the least padded title when several carry the query', () => {
    const results = [
      result('padded', 'Deep Focus Coding Session [4K 60fps Extended Edition]'),
      result('tight', 'Deep Focus Coding Session [4K]'),
    ];
    expect(pickAutoplayResult(results, 'Deep Focus Coding Session')?.id).toBe('tight');
  });

  it('prefers the most specific title the query accounts for', () => {
    const results = [
      result('short', 'Summer Drive'),
      result('long', 'Summer Drive Night Mix 2026'),
    ];
    expect(pickAutoplayResult(results, 'Summer Drive Night Mix 2026 - 달플리')?.id).toBe('long');
  });

  it('keeps the top hit for a generic mood query', () => {
    // Pool queries describe a vibe, not a video; relevance order is the right
    // answer there and must not be second-guessed.
    const results = [result('a', 'lofi hip hop radio - beats to relax/study to'), result('b', 'x')];
    expect(pickAutoplayResult(results, 'deep focus music for coding')?.id).toBe('a');
  });

  it('does not let a short query substring-match its way to a worse pick', () => {
    // "jazz" appearing inside a title says nothing about intent, so relevance
    // order stands.
    const results = [result('a', 'Jazz Cafe Long Session Mix'), result('b', 'Smooth Jazz Hours')];
    expect(pickAutoplayResult(results, 'jazz')?.id).toBe('a');
  });

  it('still honours an exact title match on a short query', () => {
    // Exact equality is a precise signal at any length, unlike substrings.
    const results = [result('a', 'Jazz Cafe Long Session Mix'), result('b', 'Jazz')];
    expect(pickAutoplayResult(results, 'jazz')?.id).toBe('b');
  });

  it('returns null only for an empty result set', () => {
    expect(pickAutoplayResult([], AUGUST)).toBeNull();
    expect(pickAutoplayResult([result('a', JULY)], '')?.id).toBe('a');
  });
});
