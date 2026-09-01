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
  const fallback = { result: results[0], matchedQuery: false };
  const target = normalizeForTitleMatch(query);
  if (!target) {
    return fallback;
  }

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
    normalizeForTitleMatch(results[0].title).includes(target)
  ) {
    return { result: results[0], matchedQuery: true };
  }

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

  // Below this a query is too generic for substring matching to mean anything.
  if (target.length < MIN_TITLE_LIKE_QUERY_CHARS) {
    return fallback;
  }

  // The query spells this title out and adds something (usually the channel).
  // Longest wins: it is the most specific title the query can account for.
  const spelledOutByQuery = [...results]
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
  const titleContainsQuery = [...results]
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
