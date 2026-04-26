import type { Article, ArticleCategory } from './types';

export interface LiveNewsItem {
  title: string;
  url: string;
  summary: string;
  imageUrl: string;
  sourceName: string;
  publishedAt: string;
  category: ArticleCategory;
}

interface LiveNewsResponse {
  provider?: string;
  fetchedAt?: string;
  items?: LiveNewsItem[];
  error?: string;
}

export const LIVE_NEWS_LIMIT = 10;
export const LIVE_ARTICLE_PREFIX = 'live-feed-';
export const LEGACY_SEED_IDS = new Set([
  'article-001',
  'article-002',
  'article-003',
  'article-004',
  'article-005',
  'article-006',
]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function hashString(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function buildLiveArticleId(item: Pick<LiveNewsItem, 'title' | 'url'>): string {
  const base = slugify(item.title) || 'news-item';
  return `${LIVE_ARTICLE_PREFIX}${base}-${hashString(item.url)}`;
}

function formatIsoDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function extractSourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function buildArticleBody(item: LiveNewsItem): string {
  const lines = [
    item.summary || item.title,
    '',
    '### Source',
    `- Outlet: ${item.sourceName || extractSourceHost(item.url) || 'Unknown source'}`,
    `- Published: ${formatIsoDate(item.publishedAt)}`,
    `- Original article: [Open source report](${item.url})`,
  ];

  if (item.category === 'breaking') {
    lines.splice(2, 0, '> Active incident coverage. Treat details as evolving.');
  }

  return lines.join('\n');
}

export function isLiveArticle(article: Article): boolean {
  return article.isLive === true || article.id.startsWith(LIVE_ARTICLE_PREFIX);
}

export function isLegacySeedArticle(article: Article): boolean {
  if (LEGACY_SEED_IDS.has(article.id)) return true;

  const text = `${article.title} ${article.summary} ${article.content}`.toLowerCase();
  return /night city|arasaka|maelstrom|netwatch|biotechnica|militech|takemura/.test(text);
}

export function shouldRefreshLiveArticles(articleList: Article[]): boolean {
  const liveArticles = articleList.filter(isLiveArticle);
  if (liveArticles.length === 0) return true;

  const freshest = liveArticles.reduce<number>((latest, article) => {
    const candidate = Date.parse(article.fetchedAt || article.publishedAt || '');
    return Number.isNaN(candidate) ? latest : Math.max(latest, candidate);
  }, 0);

  if (!freshest) return true;

  return Date.now() - freshest > 30 * 60 * 1000;
}

export async function fetchLiveNews(limit = LIVE_NEWS_LIMIT): Promise<{
  provider: string;
  fetchedAt: string;
  items: LiveNewsItem[];
}> {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`/api/cybernews/live?${params.toString()}`);
  const data = (await response.json()) as LiveNewsResponse;

  if (!response.ok) {
    throw new Error(data.error || 'Unable to fetch live news');
  }

  return {
    provider: data.provider || 'rss',
    fetchedAt: data.fetchedAt || new Date().toISOString(),
    items: Array.isArray(data.items) ? data.items : [],
  };
}

export function toLiveArticle(item: LiveNewsItem, fetchedAt: string): Article {
  return {
    id: buildLiveArticleId(item),
    title: item.title.toUpperCase(),
    category: item.category,
    summary: item.summary || item.title,
    content: buildArticleBody(item),
    imageUrl: item.imageUrl || '',
    publishedAt: formatIsoDate(item.publishedAt),
    sourceName: item.sourceName || extractSourceHost(item.url),
    sourceUrl: item.url,
    isLive: true,
    fetchedAt: formatIsoDate(fetchedAt),
  };
}
