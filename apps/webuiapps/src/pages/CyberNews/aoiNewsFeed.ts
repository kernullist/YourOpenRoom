// Client-side loader that gives Aoi's proactive news nudge a fresh set of live
// cybersecurity articles to choose from. Co-located with CyberNews so it can
// reuse the app's own live-feed helpers (fetch / convert / freshness) and write
// to the same /articles store -- so an article Aoi offers already exists when
// the tap dispatches VIEW_ARTICLE.
//
// I/O is injected (fileApi, fetchLive) so this is unit-testable with fakes.
// Never throws: a failed fetch or read falls back to whatever is persisted.

import { batchConcurrent } from '@/lib';
import type { AoiNewsCandidate, AoiNewsCategory } from '@/lib/aoiNewsNudge';
import { ARTICLES_DIR } from './actions/constants';
import {
  fetchLiveNews,
  isLiveArticle,
  LIVE_NEWS_LIMIT,
  shouldRefreshLiveArticles,
  toLiveArticle,
  type LiveNewsItem,
} from './liveNews';
import type { Article } from './types';

// Minimal file-api surface; createAppFileApi('cyberNews') satisfies it.
export interface CyberNewsFileApi {
  listFiles: (dir: string) => Promise<Array<{ path: string; name: string; type: string }>>;
  readFile: (path: string) => Promise<{ content: unknown }>;
  writeFile: (path: string, data: unknown) => Promise<unknown>;
}

export interface LoadCyberNewsCandidatesParams {
  fileApi: CyberNewsFileApi;
  // Whether Aoi may hit the network to refresh; mirrors autonomy allowNetwork.
  allowNetwork: boolean;
  // Injected for tests; defaults to the app's real live-feed fetch.
  fetchLive?: (limit?: number) => Promise<{ fetchedAt: string; items: LiveNewsItem[] }>;
  limit?: number;
}

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(['breaking', 'corporate', 'street', 'tech']);

function parseArticle(content: unknown): Article | null {
  try {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (parsed && typeof parsed === 'object' && typeof (parsed as Article).id === 'string') {
      return parsed as Article;
    }
  } catch {
    // Ignore malformed article files.
  }
  return null;
}

async function readAllArticles(fileApi: CyberNewsFileApi): Promise<Article[]> {
  const files = await fileApi.listFiles(ARTICLES_DIR);
  const jsonFiles = files.filter((file) => file.type === 'file' && file.name.endsWith('.json'));
  const results = await batchConcurrent(jsonFiles, (file) => fileApi.readFile(file.path));
  const articles: Article[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const article = parseArticle(result.value?.content);
      if (article) {
        articles.push(article);
      }
    }
  }
  return articles;
}

function toCandidate(article: Article): AoiNewsCandidate {
  // Unknown runtime categories default to a security-relevant bucket rather
  // than being dropped; the picker still weights by category afterwards.
  const category: AoiNewsCategory = KNOWN_CATEGORIES.has(article.category)
    ? (article.category as AoiNewsCategory)
    : 'tech';
  return {
    id: article.id,
    title: article.title,
    category,
    summary: article.summary,
    publishedAt: article.publishedAt,
    isLive: isLiveArticle(article),
  };
}

// Load current live news as nudge candidates. Reads persisted /articles; when
// the network is allowed and the live set is stale (>30 min), fetches fresh
// news, persists it, and merges (fresh wins by id).
export async function loadCyberNewsCandidates(
  params: LoadCyberNewsCandidatesParams,
): Promise<AoiNewsCandidate[]> {
  const { fileApi, allowNetwork } = params;
  const fetchLive = params.fetchLive ?? fetchLiveNews;
  const limit = params.limit ?? LIVE_NEWS_LIMIT;

  let existing: Article[] = [];
  try {
    existing = await readAllArticles(fileApi);
  } catch {
    existing = [];
  }

  const liveById = new Map<string, Article>();
  for (const article of existing.filter(isLiveArticle)) {
    liveById.set(article.id, article);
  }

  if (allowNetwork && shouldRefreshLiveArticles(existing)) {
    try {
      const { fetchedAt, items } = await fetchLive(limit);
      const fresh = items.map((item) => toLiveArticle(item, fetchedAt));
      if (fresh.length > 0) {
        await batchConcurrent(fresh, (article) =>
          fileApi.writeFile(`${ARTICLES_DIR}/${article.id}.json`, article),
        );
        for (const article of fresh) {
          liveById.set(article.id, article);
        }
      }
    } catch {
      // Keep whatever is already persisted.
    }
  }

  return Array.from(liveById.values()).map(toCandidate);
}
