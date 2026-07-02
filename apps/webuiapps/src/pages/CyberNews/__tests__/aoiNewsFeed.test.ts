import { describe, expect, it, vi } from 'vitest';
import { ARTICLES_DIR } from '../actions/constants';
import { loadCyberNewsCandidates, type CyberNewsFileApi } from '../aoiNewsFeed';
import type { LiveNewsItem } from '../liveNews';
import type { Article } from '../types';

const MIN = 60 * 1000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function liveArticle(id: string, over: Partial<Article> = {}): Article {
  return {
    id,
    title: id.toUpperCase(),
    category: 'tech',
    summary: 'summary',
    content: 'content',
    imageUrl: '',
    publishedAt: isoAgo(5 * MIN),
    sourceName: 'Example',
    sourceUrl: 'https://example.com/a',
    isLive: true,
    fetchedAt: isoAgo(5 * MIN),
    ...over,
  };
}

interface FakeEntry {
  path: string;
  name: string;
  type: string;
  content?: unknown;
  readThrows?: boolean;
}

function articleEntry(article: Article, over: Partial<FakeEntry> = {}): FakeEntry {
  const path = `${ARTICLES_DIR}/${article.id}.json`;
  return { path, name: `${article.id}.json`, type: 'file', content: article, ...over };
}

function makeFileApi(
  entries: FakeEntry[],
  opts: { listThrows?: boolean } = {},
): { api: CyberNewsFileApi; writes: Array<{ path: string; data: unknown }> } {
  const store = [...entries];
  const writes: Array<{ path: string; data: unknown }> = [];
  const api: CyberNewsFileApi = {
    listFiles: async () => {
      if (opts.listThrows) {
        throw new Error('list failed');
      }
      return store.map(({ path, name, type }) => ({ path, name, type }));
    },
    readFile: async (path: string) => {
      const entry = store.find((e) => e.path === path);
      if (entry?.readThrows) {
        throw new Error('read failed');
      }
      return { content: entry?.content ?? null };
    },
    writeFile: async (path: string, data: unknown) => {
      writes.push({ path, data });
      store.push({ path, name: path.split('/').pop() ?? path, type: 'file', content: data });
      return undefined;
    },
  };
  return { api, writes };
}

function liveItem(title: string, over: Partial<LiveNewsItem> = {}): LiveNewsItem {
  return {
    title,
    url: `https://example.com/${title.replace(/\s+/g, '-').toLowerCase()}`,
    summary: `${title} summary`,
    imageUrl: '',
    sourceName: 'Example',
    publishedAt: isoAgo(1 * MIN),
    category: 'tech',
    ...over,
  };
}

describe('loadCyberNewsCandidates', () => {
  it('returns only live candidates and does not fetch when network is disallowed', async () => {
    const { api, writes } = makeFileApi([
      articleEntry(liveArticle('live-feed-one')),
      articleEntry(liveArticle('article-002', { isLive: false, id: 'article-002' })),
    ]);
    const fetchLive = vi.fn();

    const candidates = await loadCyberNewsCandidates({
      fileApi: api,
      allowNetwork: false,
      fetchLive,
    });

    expect(fetchLive).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(candidates.map((c) => c.id)).toEqual(['live-feed-one']);
    expect(candidates[0].isLive).toBe(true);
  });

  it('fetches, persists, and merges fresh news when allowed and the set is stale', async () => {
    // Only a stale live article exists -> shouldRefreshLiveArticles is true.
    const { api, writes } = makeFileApi([
      articleEntry(liveArticle('live-feed-old', { fetchedAt: isoAgo(45 * MIN) })),
    ]);
    const fetchLive = vi.fn(async () => ({
      fetchedAt: new Date().toISOString(),
      items: [liveItem('Fresh One'), liveItem('Fresh Two')],
    }));

    const candidates = await loadCyberNewsCandidates({
      fileApi: api,
      allowNetwork: true,
      fetchLive,
    });

    expect(fetchLive).toHaveBeenCalledTimes(1);
    // Two fresh articles persisted.
    expect(writes).toHaveLength(2);
    expect(writes.every((w) => w.path.startsWith(`${ARTICLES_DIR}/live-feed-`))).toBe(true);
    // Merged: the stale existing live one plus the two fresh ones.
    expect(candidates).toHaveLength(3);
    expect(candidates.some((c) => c.id === 'live-feed-old')).toBe(true);
  });

  it('does not fetch when the live set is still fresh', async () => {
    const { api } = makeFileApi([
      articleEntry(liveArticle('live-feed-recent', { fetchedAt: new Date().toISOString() })),
    ]);
    const fetchLive = vi.fn();

    const candidates = await loadCyberNewsCandidates({
      fileApi: api,
      allowNetwork: true,
      fetchLive,
    });

    expect(fetchLive).not.toHaveBeenCalled();
    expect(candidates.map((c) => c.id)).toEqual(['live-feed-recent']);
  });

  it('falls back to persisted articles when the fetch throws', async () => {
    const { api, writes } = makeFileApi([
      articleEntry(liveArticle('live-feed-old', { fetchedAt: isoAgo(45 * MIN) })),
    ]);
    const fetchLive = vi.fn(async () => {
      throw new Error('network down');
    });

    const candidates = await loadCyberNewsCandidates({
      fileApi: api,
      allowNetwork: true,
      fetchLive,
    });

    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
    expect(candidates.map((c) => c.id)).toEqual(['live-feed-old']);
  });

  it('writes nothing when the fetch returns no items', async () => {
    const { api, writes } = makeFileApi([]);
    const fetchLive = vi.fn(async () => ({ fetchedAt: new Date().toISOString(), items: [] }));

    const candidates = await loadCyberNewsCandidates({
      fileApi: api,
      allowNetwork: true,
      fetchLive,
    });

    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
    expect(candidates).toEqual([]);
  });

  it('skips non-json files, malformed json, and failed reads', async () => {
    const good = liveArticle('live-feed-good');
    const { api } = makeFileApi([
      articleEntry(good),
      { path: `${ARTICLES_DIR}/notes.txt`, name: 'notes.txt', type: 'file', content: 'ignore me' },
      {
        path: `${ARTICLES_DIR}/broken.json`,
        name: 'broken.json',
        type: 'file',
        content: '{bad json',
      },
      {
        path: `${ARTICLES_DIR}/unreadable.json`,
        name: 'unreadable.json',
        type: 'file',
        readThrows: true,
      },
      { path: ARTICLES_DIR, name: 'articles', type: 'dir', content: null },
    ]);

    const candidates = await loadCyberNewsCandidates({ fileApi: api, allowNetwork: false });

    expect(candidates.map((c) => c.id)).toEqual(['live-feed-good']);
  });

  it('recovers with an empty base when listing throws, still fetching when allowed', async () => {
    const { api, writes } = makeFileApi([], { listThrows: true });
    const fetchLive = vi.fn(async () => ({
      fetchedAt: new Date().toISOString(),
      items: [liveItem('Fresh One')],
    }));

    const candidates = await loadCyberNewsCandidates({
      fileApi: api,
      allowNetwork: true,
      fetchLive,
    });

    expect(fetchLive).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(candidates).toHaveLength(1);
  });

  it('parses article content stored as a JSON string and skips non-object json', async () => {
    const stringified = liveArticle('live-feed-str');
    const { api } = makeFileApi([
      {
        path: `${ARTICLES_DIR}/live-feed-str.json`,
        name: 'live-feed-str.json',
        type: 'file',
        content: JSON.stringify(stringified),
      },
      { path: `${ARTICLES_DIR}/number.json`, name: 'number.json', type: 'file', content: '123' },
    ]);

    const candidates = await loadCyberNewsCandidates({ fileApi: api, allowNetwork: false });

    expect(candidates.map((c) => c.id)).toEqual(['live-feed-str']);
  });

  it('defaults an unknown runtime category to a security-relevant bucket', async () => {
    const weird = liveArticle('live-feed-weird', {
      category: 'weird' as Article['category'],
    });
    const { api } = makeFileApi([articleEntry(weird)]);

    const candidates = await loadCyberNewsCandidates({ fileApi: api, allowNetwork: false });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe('tech');
  });
});
