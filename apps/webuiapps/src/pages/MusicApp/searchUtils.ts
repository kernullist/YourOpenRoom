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
