import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDirectResult,
  buildExclusionSearchText,
  extractYoutubeVideoId,
  fetchYoutubeSearchResults,
  filterExcludedResults,
  normalizeExternalSearchResultsToYoutube,
  parseDuckDuckGoResults,
  parseExcludeParam,
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
    expect(picked?.result.id).toBe('august');
    expect(picked?.matchedQuery).toBe(true);
  });

  it('matches an exact title anywhere in the list', () => {
    const results = [result('a', JULY), result('b', AUGUST)];
    expect(pickAutoplayResult(results, AUGUST)?.result.id).toBe('b');
  });

  it('folds styled unicode so a stored query still matches the returned title', () => {
    // Titles in this genre use mathematical bold italic letters; NFKC maps them
    // onto plain ones on both sides of the comparison.
    const results = [result('a', 'Chill Mix'), result('b', 'Late Night 𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕 vol 3')];
    expect(pickAutoplayResult(results, 'late night playlist VOL 3')?.result.id).toBe('b');
  });

  it('matches a title that carries an extra suffix', () => {
    const results = [
      result('a', 'Some Other Long Mix Title'),
      result('b', 'Deep Focus Coding Session [4K]'),
    ];
    expect(pickAutoplayResult(results, 'Deep Focus Coding Session')?.result.id).toBe('b');
  });

  it('leaves two uploads of the same session to relevance order', () => {
    // Both titles carry the query, so picking on title length alone was
    // choosing between two copies of the same thing by padding. Ranking knows
    // better, and preferring the shorter title is how a lower-ranked upload of
    // the right song kept winning.
    const results = [
      result('padded', 'Deep Focus Coding Session [4K 60fps Extended Edition]'),
      result('tight', 'Deep Focus Coding Session [4K]'),
    ];
    expect(pickAutoplayResult(results, 'Deep Focus Coding Session')?.result.id).toBe('padded');
  });

  // The live result set for "에스파 KISS N TELL", in the order the search API
  // returned it: a fan lyrics upload ranks above the official MV, hour-long
  // loops and fancams fill the middle, and a "Recording ver." spells the
  // request out word for word. That last one is what actually played.
  const KISS_N_TELL = [
    result('lyrics', "aespa (에스파) 'Kiss n tell' (Color Coded Lyrics)", 'Jaeguchi'),
    result('mv', "aespa \u30a8\u30b9\u30d1 'KISS N TELL' MV", 'SMTOWN'),
    result('fuji', "aespa 'KISS N TELL' from Fuji Television [STAR]", 'Warner Music Japan'),
    result(
      'hour',
      '1시간 │ aespa (에스파) - KISS N TELL │ 가사해석 / 1 Hour Lyrics',
      '1 Hour Lyrics',
    ),
    result('fancam', '260807 에스파 aespa KISS N TELL 직캠 @SYNK SEOUL', 'Coating'),
    result(
      'recording',
      "aespa 'KISS N TELL' Recording ver. | 에스파 KISS N TELL 레코딩 버전",
      '강양',
    ),
  ];

  it('starts the song, not a derivative upload that spells the query out', () => {
    // The reported failure: 'recording' is the only title carrying "에스파 KISS N
    // TELL" verbatim -- the MV says \u30a8\u30b9\u30d1 -- so substring matching promoted it
    // over both the top hit and the MV.
    const picked = pickAutoplayResult(KISS_N_TELL, '에스파 KISS N TELL');
    expect(picked?.result.id).toBe('mv');
    // A word short of the request (the artist name in another script), so the
    // caller must name what really started instead of echoing the query.
    expect(picked?.matchedQuery).toBe(false);
  });

  it('steps over a lyrics upload that outranks the song itself', () => {
    // 'lyrics' is rank 1 here. Relevance order is kept everywhere else, but a
    // request to play a song is not a request for someone's lyric video.
    expect(pickAutoplayResult(KISS_N_TELL, 'aespa KISS N TELL')?.result.id).toBe('mv');
  });

  it('returns the derivative when the request asks for that kind', () => {
    // Asked for in Korean, answered by an English-titled upload: the exemption
    // is per kind, not per word.
    expect(pickAutoplayResult(KISS_N_TELL, '에스파 KISS N TELL 가사')?.result.id).toBe('lyrics');
    expect(pickAutoplayResult(KISS_N_TELL, '에스파 KISS N TELL 직캠')?.result.id).toBe('fancam');
  });

  it('keeps relevance order when every hit is a derivative', () => {
    // Preference, not a filter: with nothing else on offer the top hit stands.
    const results = [KISS_N_TELL[0], KISS_N_TELL[3], KISS_N_TELL[5]];
    expect(pickAutoplayResult(results, '에스파 KISS N TELL')?.result.id).toBe('lyrics');
  });

  it('prefers the most specific title the query accounts for', () => {
    const results = [
      result('short', 'Summer Drive'),
      result('long', 'Summer Drive Night Mix 2026'),
    ];
    expect(pickAutoplayResult(results, 'Summer Drive Night Mix 2026 - 달플리')?.result.id).toBe(
      'long',
    );
  });

  it('keeps the top hit for a generic mood query, and says it did not match', () => {
    // Pool queries describe a vibe, not a video; relevance order is the right
    // answer there and must not be second-guessed. The flag is what lets the
    // caller word the ack around the video it really started.
    const results = [result('a', 'lofi hip hop radio - beats to relax/study to'), result('b', 'x')];
    const picked = pickAutoplayResult(results, 'deep focus music for coding');
    expect(picked?.result.id).toBe('a');
    expect(picked?.matchedQuery).toBe(false);
  });

  it('flags a named video that is absent from the results as unmatched', () => {
    // The video was taken down or never surfaced: something still plays, but
    // the caller must not claim it is the one that was named.
    const results = [result('other', 'A COMPLETELY UNRELATED LONG MIX TITLE')];
    const picked = pickAutoplayResult(results, `${AUGUST} - 달플리 𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕`);
    expect(picked?.result.id).toBe('other');
    expect(picked?.matchedQuery).toBe(false);
  });

  it('does not let a short query substring-match its way to a worse pick', () => {
    // "jazz" appearing inside a title says nothing about intent, so relevance
    // order stands.
    const results = [result('a', 'Jazz Cafe Long Session Mix'), result('b', 'Smooth Jazz Hours')];
    expect(pickAutoplayResult(results, 'jazz')?.result.id).toBe('a');
  });

  it('takes the top hit unannounced when a short query matches nothing', () => {
    // Neither the top hit nor anything below carries the fragment, so relevance
    // order is all there is -- and the caller must not claim it played what was
    // asked for.
    const results = [result('a', 'Chill Cafe Long Session Mix'), result('b', 'Smooth Beats Hours')];
    const picked = pickAutoplayResult(results, 'jazz');
    expect(picked?.result.id).toBe('a');
    expect(picked?.matchedQuery).toBe(false);
  });

  it('keeps the top hit when a short query is already spelled out there', () => {
    // The reported failure: "KISS N TELL" ranked aespa's MV first and an
    // unrelated Topic upload titled exactly "KISS N TELL" fourth -- exact
    // equality took the fourth. Title equality on a fragment names a different
    // song as often as the right one, so relevance order stands whenever the
    // top hit already carries the fragment.
    const results = [
      result('mv', "aespa エスパ 'KISS N TELL' MV", 'SMTOWN'),
      result('lyrics', "aespa (에스파) 'Kiss n tell' (Color Coded Lyrics)", 'Jaeguchi'),
      result('topic', 'KISS N TELL', 'untiljapan - Topic'),
    ];
    const picked = pickAutoplayResult(results, 'KISS N TELL');
    expect(picked?.result.id).toBe('mv');
    // The title contains what was asked for, so the caller may name it.
    expect(picked?.matchedQuery).toBe(true);
  });

  it('still honours an exact title match on a short query the top hit ignores', () => {
    // Equality remains the only signal available when nothing at the top
    // accounts for the query at all.
    const results = [result('a', 'Chill Cafe Long Session Mix'), result('b', 'Jazz')];
    expect(pickAutoplayResult(results, 'jazz')?.result.id).toBe('b');
  });

  it('has no coverage to measure when a query is all single characters', () => {
    // Single characters sit inside almost every title, so there is no word to
    // check the top hit against -- the substring rules and relevance order are
    // all that is left.
    const results = [
      result('a', 'A B C D E F G H I J K L [4K]'),
      result('b', 'Something Else Long'),
    ];
    const picked = pickAutoplayResult(results, 'a b c d e f g h i j k l');
    expect(picked?.result.id).toBe('a');
    expect(picked?.matchedQuery).toBe(true);
  });

  it('returns null only for an empty result set', () => {
    expect(pickAutoplayResult([], AUGUST)).toBeNull();
    expect(pickAutoplayResult([result('a', JULY)], '')?.result.id).toBe('a');
  });
});

describe('rejection-aware search helpers', () => {
  function entry(id: string, title: string, channel = 'OpenRoom'): YoutubeSearchResult {
    return {
      id,
      title,
      channel,
      duration: '3:20',
      views: '1M views',
      published: 'today',
      thumbnail: '',
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  it('parses the exclude param with trimming, dedupe, and caps', () => {
    expect(parseExcludeParam(undefined)).toEqual([]);
    expect(parseExcludeParam('  ')).toEqual([]);
    expect(parseExcludeParam('달플리\n 달플리 \nBIGBANG')).toEqual(['달플리', 'BIGBANG']);
    expect(parseExcludeParam('aa\nbb\ncc\ndd\nee\nff')).toHaveLength(4);
  });

  it('refuses needles a substring filter cannot be trusted with', () => {
    // 1-char and symbol-only terms match most titles ("기", "|", "너").
    expect(parseExcludeParam('기\n너\n|\n--\n달플리')).toEqual(['달플리']);
  });

  it('never manufactures a lone surrogate at the length cap and scrubs arriving ones', () => {
    // 59 filler chars put the 60-char cap in the middle of the emoji pair.
    const nearCap = `${'가'.repeat(59)}\u{1F525}`;
    for (const term of parseExcludeParam(nearCap)) {
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(term)).toBe(false);
      expect(() => encodeURIComponent(term)).not.toThrow();
    }
    // A lone surrogate arriving over the agent wire is removed, keeping the
    // NFKC needle able to match the styled title it names.
    expect(parseExcludeParam('달플리\uD83D')).toEqual(['달플리']);
  });

  it('appends minus operators, quoting multi-word terms and dropping quotes', () => {
    expect(buildExclusionSearchText('여돌 노래모음', [])).toBe('여돌 노래모음');
    expect(buildExclusionSearchText('여돌 노래모음', ['달플리'])).toBe('여돌 노래모음 -달플리');
    expect(buildExclusionSearchText('mix', ['달플리 Playlist'])).toBe('mix -"달플리 Playlist"');
    expect(buildExclusionSearchText('mix', ['bad"quote'])).toBe('mix -badquote');
    // A leading dash must not stack into a "--term" literal.
    expect(buildExclusionSearchText('mix', ['-달플리'])).toBe('mix -달플리');
  });

  it('ignores sub-minimum needles even when called directly', () => {
    const results = [entry('a', 'A | B mix'), entry('b', 'clean mix')];
    expect(filterExcludedResults(results, ['|', '기'])).toHaveLength(2);
  });

  it('filters results whose title or channel names a rejected pick', () => {
    const results = [
      entry('july', '2026년 7월 여돌 노래모음 | 달플리 Playlist'),
      entry('august', '2026년 8월 여돌 노래모음'),
      entry('channel-hit', 'Fresh Idol Mix', '달플리'),
    ];
    const filtered = filterExcludedResults(results, ['달플리']);
    expect(filtered.map((item) => item.id)).toEqual(['august']);
    expect(filterExcludedResults(results, [])).toHaveLength(3);
  });

  it('folds styled unicode so the rejected pick cannot hide behind math-bold letters', () => {
    const results = [entry('styled', '여돌 모음 | 달플리 𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕'), entry('clean', '여돌 모음')];
    expect(filterExcludedResults(results, ['playlist']).map((item) => item.id)).toEqual(['clean']);
  });
});
