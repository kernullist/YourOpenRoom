import { buildBrowserReaderProxyUrl, stripCollapsedText } from '@/lib/readerExtraction';

export interface YoutubeSearchResult {
  id: string;
  title: string;
  channel: string;
  duration: string;
  views: string;
  published: string;
  thumbnail: string;
  url: string;
}

interface YoutubeSearchApiResponse {
  results?: unknown;
  error?: string;
}

interface ExternalSearchResult {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
}

const MAX_FALLBACK_RESULTS = 24;

function isGoogleUrl(url: string): boolean {
  try {
    return /(\.|^)google\./.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function cleanYoutubeTitle(title: string): string {
  const normalized = stripCollapsedText(title)
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .trim();
  return normalized || 'YouTube Video';
}

function toFriendlyErrorMessage(message: string | null | undefined): string {
  const normalized = (message || '').trim();
  if (!normalized) return 'Failed to load YouTube results';
  if (/fetch failed|network|timed? out|abort/i.test(normalized)) {
    return 'YouTube search is temporarily unavailable.';
  }
  return normalized;
}

function isYoutubeSearchResult(value: unknown): value is YoutubeSearchResult {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.channel === 'string' &&
    typeof item.duration === 'string' &&
    typeof item.views === 'string' &&
    typeof item.published === 'string' &&
    typeof item.thumbnail === 'string' &&
    typeof item.url === 'string'
  );
}

function normalizePrimaryResults(results: unknown): YoutubeSearchResult[] {
  if (!Array.isArray(results)) return [];
  return results.filter(isYoutubeSearchResult).slice(0, MAX_FALLBACK_RESULTS);
}

async function readApiResponse(response: Response): Promise<YoutubeSearchApiResponse> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as YoutubeSearchApiResponse;
  }

  const text = stripCollapsedText(await response.text());
  return { error: text || response.statusText || 'Failed to load YouTube results' };
}

async function fetchBrowserReaderHtml(url: string): Promise<string> {
  const response = await fetch(buildBrowserReaderProxyUrl(url));
  if (!response.ok) {
    const data = await readApiResponse(response);
    throw new Error(data.error || 'Failed to load fallback search results');
  }
  return response.text();
}

async function loadFallbackResults(
  searchUrl: string,
  parser: (html: string) => ExternalSearchResult[],
): Promise<YoutubeSearchResult[]> {
  try {
    const html = await fetchBrowserReaderHtml(searchUrl);
    return normalizeExternalSearchResultsToYoutube(parser(html));
  } catch {
    return [];
  }
}

// Agent-driven autoplay must start the video Aoi NAMED, not whatever YouTube
// ranks first. Aoi's personal picks are title-derived ("<title> - <channel>",
// see aoiMusicTaste.recordYouTubePlay), and relevance ranking routinely puts a
// different upload of the same series on top: asking for the August mix and
// getting July, with the August one sitting second in the very same list.
//
// Matching is deliberately conservative. Only a query that clearly names one
// video overrides the top hit; a generic mood query ("lofi hip hop radio ...")
// matches nothing here and keeps the previous behaviour.
const MIN_TITLE_LIKE_QUERY_CHARS = 12;

// NFKC folds the styled unicode these titles like to use (mathematical bold
// italic "Playlist" and friends) onto plain letters, so a stored query and the
// title YouTube returns compare equal.
function normalizeForTitleMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function byNormalizedTitleLength(
  direction: 'longest' | 'shortest',
): (a: YoutubeSearchResult, b: YoutubeSearchResult) => number {
  return (a, b) => {
    const lengthA = normalizeForTitleMatch(a.title).length;
    const lengthB = normalizeForTitleMatch(b.title).length;
    return direction === 'longest' ? lengthB - lengthA : lengthA - lengthB;
  };
}

// Uploads that announce themselves as a DERIVATIVE of the thing that was asked
// for: lyric videos, one-hour loops, fancams, covers, recording sessions.
// "에스파 KISS N TELL" really does return a Color Coded Lyrics upload above the
// official MV, with a "Recording ver." upload further down -- and a play
// request means the song, not a version of it. Skipping these is a preference,
// never a filter: if every hit is one, relevance order still stands.
//
// Grouped by KIND rather than listed flat, because the exemption below is about
// what the user asked for, not which language they asked in: "가사" has to
// exempt an English "Lyrics" upload too.
const DERIVATIVE_UPLOAD_KINDS: readonly (readonly RegExp[])[] = [
  // Extended or looped re-uploads
  [/\b(?:1|one)\s*hour\b/i, /1\s*시간/u, /\bloop(?:ed)?\b/i],
  // Lyric videos
  [/\blyrics?\b/i, /가사/u, /歌詞/u],
  // Stage cuts and practice footage
  [/\bfancam\b/i, /직캠/u, /\bdance\s*practice\b/i, /안무/u, /\bchoreograph/i, /\bmirrored\b/i],
  // Covers and reactions
  [/\bcover(?:ed|s)?\b/i, /커버/u, /\breaction\b/i, /리액션/u],
  // Alternate audio
  [
    /\binstrumental\b/i,
    /\bkaraoke\b/i,
    /노래방/u,
    /반주/u,
    /\bsped\s*up\b/i,
    /\bslowed\b/i,
    /\bnightcore\b/i,
    /\b8d\s*audio\b/i,
  ],
  // Studio and behind-the-scenes versions
  [/\brecording\s*ver/i, /레코딩/u, /\bbehind\b/i, /메이킹/u, /\bmaking\s*film\b/i],
  // Promos
  [/\bteaser\b/i, /\bpreview\b/i, /예고/u],
];

// The derivative kinds the request itself asks for ("... 가사", "... 직캠",
// "1시간 ..."). Nothing in that list may be skipped for this query, and the
// highest-ranked result OF that kind is what the request means.
function requestedDerivativeKinds(target: string): readonly (readonly RegExp[])[] {
  return DERIVATIVE_UPLOAD_KINDS.filter((kind) => kind.some((pattern) => pattern.test(target)));
}

function describes(result: YoutubeSearchResult, kind: readonly RegExp[]): boolean {
  const haystack = normalizeForTitleMatch(`${result.title} ${result.channel}`);
  return kind.some((pattern) => pattern.test(haystack));
}

/**
 * True when a result announces itself as a derivative version AND the query did
 * not ask for that kind.
 *
 * The exemption is the whole reason this reads the query: someone asking for a
 * lyric video, a one-hour loop or a fancam must still get one.
 */
function isDerivativeUpload(result: YoutubeSearchResult, target: string): boolean {
  const asked = requestedDerivativeKinds(target);
  return DERIVATIVE_UPLOAD_KINDS.some((kind) => !asked.includes(kind) && describes(result, kind));
}

/**
 * The result relevance order actually recommends.
 *
 * In rank order: what the request asked for by kind, then anything that is not
 * a derivative upload, then -- when every hit is one -- the literal top hit.
 * Skipping is always a preference, never a filter.
 */
function preferredTopHit(
  results: readonly YoutubeSearchResult[],
  target: string,
): YoutubeSearchResult {
  const asked = requestedDerivativeKinds(target);
  if (asked.length > 0) {
    const requested = results.find((result) => asked.every((kind) => describes(result, kind)));
    if (requested) {
      return requested;
    }
  }
  return results.find((result) => !isDerivativeUpload(result, target)) ?? results[0];
}

// Single characters carry no identity ("n" in "kiss n tell" sits inside almost
// every title), so coverage is counted over the words that do.
function meaningfulQueryTokens(target: string): string[] {
  return target.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
}

/**
 * True when a result already answers the query well enough that a lower-ranked
 * substring match is not a better answer.
 *
 * All but at most one word: the odd word out is routinely the SAME name in
 * another script -- the official MV is titled "aespa エスパ 'KISS N TELL' MV"
 * while the request said 에스파 -- and a fan upload that happens to spell every
 * word the way the request did is not therefore the video that was asked for.
 * That mismatch is exactly how a "Recording ver." upload beat the MV here.
 */
function answersQuery(result: YoutubeSearchResult, target: string): boolean {
  const tokens = meaningfulQueryTokens(target);
  if (tokens.length === 0) {
    return false;
  }
  const haystack = normalizeForTitleMatch(`${result.title} ${result.channel}`);
  const covered = tokens.filter((token) => haystack.includes(token)).length;
  return covered >= Math.max(2, tokens.length - 1);
}

export interface AutoplaySelection {
  result: YoutubeSearchResult;
  // True when the query identified this specific video. False means nothing
  // matched and the top hit was taken instead -- the caller must not then claim
  // it is playing what the query asked for.
  matchedQuery: boolean;
}

/**
 * Choose which search hit an autoplay request should start.
 *
 * Returns null only for an empty result set; otherwise it always yields
 * something, falling back to the top hit when the query does not name a
 * specific video.
 */
export function pickAutoplayResult(
  results: readonly YoutubeSearchResult[],
  query: string,
): AutoplaySelection | null {
  if (results.length === 0) {
    return null;
  }
  const target = normalizeForTitleMatch(query);
  if (!target) {
    return { result: results[0], matchedQuery: false };
  }

  // What relevance order recommends once self-declared derivative uploads are
  // stepped over. Everything below compares against THIS, not results[0].
  const top = preferredTopHit(results, target);
  const fallback = { result: top, matchedQuery: false };

  // Relevance order is evidence too: YouTube ranked these FOR THIS QUERY.
  // Below the title-like floor the query is a fragment rather than a title, and
  // a video whose whole title equals a fragment is routinely a DIFFERENT song
  // that happens to share the name. Searching "KISS N TELL" put aespa's MV
  // first and an unrelated Topic upload titled exactly "KISS N TELL" fourth --
  // and the exact rule below played the fourth. So when the top hit already
  // spells the fragment out, ranking stands, and the match is real enough to
  // announce: its title contains what was asked for.
  if (
    target.length < MIN_TITLE_LIKE_QUERY_CHARS &&
    normalizeForTitleMatch(top.title).includes(target)
  ) {
    return { result: top, matchedQuery: true };
  }

  // Exact identity is the one signal allowed to override ranking outright: it
  // is the shape a taste-derived pick takes, and equality cannot be coincidence
  // at this length. Derivatives are searched too -- a query that spells one out
  // exactly is a request for that upload.
  const exactTitle = results.find((result) => normalizeForTitleMatch(result.title) === target);
  if (exactTitle) {
    return { result: exactTitle, matchedQuery: true };
  }

  // The shape a taste-derived query takes when the channel is not already part
  // of the title.
  const exactTitleAndChannel = results.find(
    (result) => normalizeForTitleMatch(`${result.title} - ${result.channel}`) === target,
  );
  if (exactTitleAndChannel) {
    return { result: exactTitleAndChannel, matchedQuery: true };
  }

  // Nothing was named exactly, so the recommended hit is the answer unless it
  // plainly does not answer the query. The substring rules below may only reach
  // past a top hit that fails this: letting them override a good one is what
  // started a "Recording ver." upload for a request the MV already answered.
  if (answersQuery(top, target)) {
    // Only claim the query named it when the title really carries the whole
    // request; a word short (a name in another script) gets the honest ack.
    return { result: top, matchedQuery: normalizeForTitleMatch(top.title).includes(target) };
  }

  // Below this a query is too generic for substring matching to mean anything.
  if (target.length < MIN_TITLE_LIKE_QUERY_CHARS) {
    return fallback;
  }

  // Derivatives stay out of the substring rules entirely: their titles quote the
  // original in full, which is exactly what these rules reward.
  const substringCandidates = results.filter((result) => !isDerivativeUpload(result, target));

  // The query spells this title out and adds something (usually the channel).
  // Longest wins: it is the most specific title the query can account for.
  const spelledOutByQuery = [...substringCandidates]
    .filter((result) => {
      const title = normalizeForTitleMatch(result.title);
      return title.length >= MIN_TITLE_LIKE_QUERY_CHARS && target.includes(title);
    })
    .sort(byNormalizedTitleLength('longest'))[0];
  if (spelledOutByQuery) {
    return { result: spelledOutByQuery, matchedQuery: true };
  }

  // The title spells the query out and adds a suffix ("... [4K]", "(Official)").
  // Shortest wins: least padding around what was asked for.
  const titleContainsQuery = [...substringCandidates]
    .filter((result) => normalizeForTitleMatch(result.title).includes(target))
    .sort(byNormalizedTitleLength('shortest'))[0];
  if (titleContainsQuery) {
    return { result: titleContainsQuery, matchedQuery: true };
  }

  return fallback;
}

// ---- rejection-aware search ("A 말고 B" requests) -------------------------

const MAX_EXCLUDE_TERMS = 4;
const MAX_EXCLUDE_TERM_CHARS = 60;

// A term arriving over the agent wire can carry a lone UTF-16 surrogate half;
// encodeURIComponent throws URIError on those, killing the whole search, and
// NFKC matching stops folding the styled titles the filter exists to catch.
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const EXCLUDE_TERM_WORD_CHAR_PATTERN = /[\p{L}\p{N}]/u;

/**
 * Parse the newline-separated `exclude` action param. The param crosses the
 * app boundary as a plain string from the agent surface, so everything here is
 * bounded rather than trusted: count and length caps, no lone surrogates, no
 * symbol-only or single-char needles (a substring filter fed "|" or "기" would
 * nuke most of a result set).
 */
export function parseExcludeParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const line of raw.split('\n')) {
    // Code-point slice: a UTF-16 slice at the cap could split an emoji or
    // math-bold pair and manufacture the very lone surrogate removed above.
    const term = [...line.trim().replace(LONE_SURROGATE_PATTERN, '')]
      .slice(0, MAX_EXCLUDE_TERM_CHARS)
      .join('')
      .trim();
    if (term.length < 2 || !EXCLUDE_TERM_WORD_CHAR_PATTERN.test(term)) continue;
    const key = normalizeForTitleMatch(term);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_EXCLUDE_TERMS) break;
  }
  return terms;
}

/**
 * Append the search-engine minus operator for each excluded term. Verified
 * against the backends this app actually uses: /api/youtube-search scrapes
 * youtube.com/results (native operator support), and both fallbacks (DDG HTML,
 * Google web) honor the same syntax. Multi-word terms are quoted so they
 * exclude as a phrase; embedded quotes are dropped to keep the operator whole.
 */
export function buildExclusionSearchText(query: string, exclude: string[]): string {
  if (exclude.length === 0) return query;
  const operators = exclude
    // Embedded quotes would break the phrase form; a leading dash would stack
    // into "--term", which the engines read as a literal.
    .map((term) => term.replace(/["“”]/g, '').replace(/^-+/, '').trim())
    .filter(Boolean)
    .map((term) => (/\s/.test(term) ? `-"${term}"` : `-${term}`));
  return operators.length > 0 ? `${query} ${operators.join(' ')}` : query;
}

/**
 * The guarantee behind the operator: whatever the engines did with the minus
 * terms, nothing whose title or channel names a rejected pick may be offered
 * or played. NFKC matching folds the styled unicode these titles favor
 * (mathematical bold "Playlist" etc.) onto plain letters.
 */
export function filterExcludedResults(
  results: readonly YoutubeSearchResult[],
  exclude: string[],
): YoutubeSearchResult[] {
  // Same needle floor as parseExcludeParam, enforced again because this is
  // exported: a 1-char substring needle silently empties result sets.
  const needles = exclude.map(normalizeForTitleMatch).filter((needle) => needle.length >= 2);
  if (needles.length === 0) return [...results];
  return results.filter((result) => {
    const haystack = normalizeForTitleMatch(`${result.title} ${result.channel}`);
    return !needles.some((needle) => haystack.includes(needle));
  });
}

export function extractYoutubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') {
      return parsed.pathname.replace(/^\/+/, '') || null;
    }
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v');
      }
      if (parsed.pathname.startsWith('/shorts/') || parsed.pathname.startsWith('/embed/')) {
        return parsed.pathname.split('/')[2] || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function buildDirectResult(url: string): YoutubeSearchResult | null {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) return null;
  return {
    id: videoId,
    title: 'YouTube Video',
    channel: '',
    duration: '',
    views: '',
    published: '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url,
  };
}

export function parseGoogleSearchResults(html: string): ExternalSearchResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  const results: ExternalSearchResult[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href') || '';
    let targetUrl = '';

    if (rawHref.startsWith('/url?')) {
      try {
        const parsed = new URL(rawHref, 'https://www.google.com');
        targetUrl =
          parsed.searchParams.get('q') ||
          parsed.searchParams.get('url') ||
          parsed.searchParams.get('adurl') ||
          '';
      } catch {
        targetUrl = '';
      }
    } else if (/^https?:\/\//i.test(rawHref)) {
      targetUrl = rawHref;
    }

    if (!targetUrl || isGoogleUrl(targetUrl) || seen.has(targetUrl)) continue;

    const title = stripCollapsedText(
      anchor.querySelector('h3')?.textContent ||
        anchor.querySelector('span')?.textContent ||
        anchor.textContent ||
        '',
    );
    if (!title || title.length < 3) continue;

    const container = anchor.closest('div');
    const surroundingText = stripCollapsedText(
      container?.parentElement?.textContent || container?.textContent || '',
    );
    const snippet = surroundingText.replace(title, '').replace(targetUrl, '').trim();

    let displayUrl = targetUrl;
    try {
      displayUrl = new URL(targetUrl).hostname.replace(/^www\./, '');
    } catch {
      // Keep the raw URL when URL parsing fails.
    }

    results.push({
      title,
      url: targetUrl,
      snippet: snippet.length > 260 ? `${snippet.slice(0, 260)}...` : snippet,
      displayUrl,
    });
    seen.add(targetUrl);
    if (results.length >= 12) break;
  }

  return results;
}

export function parseDuckDuckGoResults(html: string): ExternalSearchResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a.result__a, a[data-testid="result-title-a"]'));
  const results: ExternalSearchResult[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const url = anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;

    const container =
      anchor.closest('.result') || anchor.closest('[data-testid="result"]') || anchor.parentElement;

    const title = stripCollapsedText(anchor.textContent || '');
    if (!title) continue;

    const snippet = stripCollapsedText(
      container?.querySelector('.result__snippet')?.textContent ||
        container?.querySelector('[data-result="snippet"]')?.textContent ||
        container?.textContent ||
        '',
    ).replace(title, '');

    let displayUrl = url;
    try {
      displayUrl = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // Keep the raw URL when URL parsing fails.
    }

    results.push({
      title,
      url,
      snippet: snippet.length > 260 ? `${snippet.slice(0, 260)}...` : snippet,
      displayUrl,
    });
    seen.add(url);
    if (results.length >= 12) break;
  }

  return results;
}

export function normalizeExternalSearchResultsToYoutube(
  results: ExternalSearchResult[],
): YoutubeSearchResult[] {
  const seen = new Set<string>();
  const normalized: YoutubeSearchResult[] = [];

  for (const result of results) {
    const videoId = extractYoutubeVideoId(result.url);
    if (!videoId || seen.has(videoId)) continue;

    normalized.push({
      id: videoId,
      title: cleanYoutubeTitle(result.title),
      channel: result.displayUrl || 'youtube.com',
      duration: '',
      views: '',
      published: '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      url: result.url,
    });
    seen.add(videoId);

    if (normalized.length >= MAX_FALLBACK_RESULTS) break;
  }

  return normalized;
}

export async function fetchYoutubeSearchResults(query: string): Promise<YoutubeSearchResult[]> {
  let primaryError: string | null = null;

  try {
    const response = await fetch(`/api/youtube-search?query=${encodeURIComponent(query)}`);
    const data = await readApiResponse(response);
    if (response.ok) {
      const results = normalizePrimaryResults(data.results);
      if (results.length > 0) {
        return results;
      }
      primaryError = data.error || 'No playable YouTube results were found.';
    } else {
      primaryError = data.error || 'Failed to load YouTube results';
    }
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
  }

  const fallbackQuery = `site:youtube.com/watch ${query}`;
  const fallbackUrls = [
    {
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fallbackQuery)}`,
      parser: parseDuckDuckGoResults,
    },
    {
      url: `https://www.google.com/search?hl=en&gbv=1&num=10&q=${encodeURIComponent(fallbackQuery)}`,
      parser: parseGoogleSearchResults,
    },
  ];

  for (const fallback of fallbackUrls) {
    const results = await loadFallbackResults(fallback.url, fallback.parser);
    if (results.length > 0) {
      return results;
    }
  }

  throw new Error(toFriendlyErrorMessage(primaryError));
}
