import type { Plugin } from 'vite';

type ArticleCategory = 'breaking' | 'corporate' | 'street' | 'tech';

interface FeedSource {
  name: string;
  feedUrl: string;
}

interface LiveNewsItem {
  title: string;
  url: string;
  summary: string;
  imageUrl: string;
  sourceName: string;
  publishedAt: string;
  category: ArticleCategory;
}

interface ArticleMeta {
  summary: string;
  imageUrl: string;
}

const CYBERNEWS_TIMEOUT_MS = 12_000;
const MAX_ITEMS_PER_FEED = 8;
const CONCURRENT_ENRICH_LIMIT = 4;
const FEED_SOURCES: FeedSource[] = [
  {
    name: 'BleepingComputer',
    feedUrl: 'https://www.bleepingcomputer.com/feed/',
  },
  {
    name: 'The Hacker News',
    feedUrl: 'https://feeds.feedburner.com/TheHackersNews',
  },
  {
    name: 'Krebs on Security',
    feedUrl: 'https://krebsonsecurity.com/feed/',
  },
  {
    name: 'SecurityWeek',
    feedUrl: 'https://feeds.feedburner.com/securityweek',
  },
];

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = CYBERNEWS_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...init,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

function decodeHtml(input = ''): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => HTML_ENTITIES[entity] || entity)
    .trim();
}

function stripHtml(input = ''): string {
  return decodeHtml(input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function normalizeWhitespace(input = ''): string {
  return input.replace(/\s+/g, ' ').trim();
}

function safeIsoDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function readTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() || '';
}

function readSource(block: string, fallbackName: string): string {
  const sourceMatch =
    block.match(/<source(?:\s+url=(?:"[^"]*"|'[^']*'))?[^>]*>([\s\S]*?)<\/source>/i) || [];
  return stripHtml(sourceMatch[1] || '') || fallbackName;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMetaContent(html: string, key: string): string {
  const escaped = escapeRegExp(key);
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([\\s\\S]*?)["'][^>]*>`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }

  return '';
}

function toAbsoluteUrl(value: string, baseUrl: string): string {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function scoreCategory(text: string): Record<ArticleCategory, number> {
  const scores: Record<ArticleCategory, number> = {
    breaking: 0,
    corporate: 0,
    street: 0,
    tech: 0,
  };

  const keywordGroups: Array<{ category: ArticleCategory; words: string[]; weight: number }> = [
    {
      category: 'breaking',
      weight: 3,
      words: [
        'zero-day',
        'actively exploited',
        'critical flaw',
        'critical vulnerability',
        'breach',
        'ransomware',
        'data theft',
        'stolen data',
        'attack',
        'compromised',
        'heist',
        'leak',
        'emergency update',
      ],
    },
    {
      category: 'corporate',
      weight: 2,
      words: [
        'acquisition',
        'acquires',
        'buy',
        'funding',
        'raises',
        'merger',
        'partner',
        'enterprise',
        'expands',
        'stock',
        'market',
        'services',
        'platform',
        'vendor',
      ],
    },
    {
      category: 'street',
      weight: 2,
      words: [
        'threat actor',
        'gang',
        'scam',
        'fraud',
        'arrest',
        'seized',
        'dark web',
        'criminal',
        'cybercrime',
        'lazarus',
        'espionage',
        'botnet',
      ],
    },
    {
      category: 'tech',
      weight: 2,
      words: [
        'research',
        'analysis',
        'patch',
        'update',
        'malware',
        'vulnerability',
        'exploit',
        'phishing',
        'windows',
        'android',
        'ios',
        'linux',
        'firewall',
        'mcp',
        'supply chain',
      ],
    },
  ];

  for (const group of keywordGroups) {
    for (const word of group.words) {
      if (text.includes(word)) {
        scores[group.category] += group.weight;
      }
    }
  }

  if (text.includes('securityweek') || text.includes('krebsonsecurity')) {
    scores.tech += 1;
  }
  if (text.includes('bleepingcomputer')) {
    scores.breaking += 1;
  }
  if (text.includes('the hacker news')) {
    scores.street += 1;
  }

  return scores;
}

function classifyCategory(item: Pick<LiveNewsItem, 'title' | 'summary' | 'sourceName'>): ArticleCategory {
  const haystack = `${item.title} ${item.summary} ${item.sourceName}`.toLowerCase();
  const scores = scoreCategory(haystack);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return (ranked[0]?.[0] as ArticleCategory) || 'tech';
}

function dedupeItems(items: LiveNewsItem[]): LiveNewsItem[] {
  const seen = new Set<string>();
  const deduped: LiveNewsItem[] = [];

  for (const item of items) {
    const key = item.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function parseFeed(xml: string, source: FeedSource): LiveNewsItem[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  return items
    .slice(0, MAX_ITEMS_PER_FEED)
    .map((block) => {
      const title = stripHtml(readTag(block, 'title'));
      const url = decodeHtml(readTag(block, 'link'));
      const summary = stripHtml(readTag(block, 'description'));
      const publishedAt = safeIsoDate(readTag(block, 'pubDate'));
      const sourceName = readSource(block, source.name);

      return {
        title,
        url,
        summary,
        imageUrl: '',
        sourceName,
        publishedAt,
        category: 'tech',
      } satisfies LiveNewsItem;
    })
    .filter((item) => item.title && item.url);
}

async function extractArticleMeta(url: string): Promise<ArticleMeta> {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) return { summary: '', imageUrl: '' };

    const html = await response.text();
    const finalUrl = response.url || url;
    const summary =
      readMetaContent(html, 'og:description') ||
      readMetaContent(html, 'twitter:description') ||
      readMetaContent(html, 'description');
    const imageUrl =
      readMetaContent(html, 'og:image') || readMetaContent(html, 'twitter:image') || '';

    return {
      summary: normalizeWhitespace(stripHtml(summary)).slice(0, 280),
      imageUrl: toAbsoluteUrl(imageUrl, finalUrl),
    };
  } catch {
    return { summary: '', imageUrl: '' };
  }
}

async function batchMap<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    const batchResults = await Promise.all(batch.map((item, offset) => mapper(item, index + offset)));
    results.push(...batchResults);
  }

  return results;
}

export function cyberNewsProxyPlugin(): Plugin {
  return {
    name: 'cybernews-proxy',
    configureServer(server) {
      server.middlewares.use('/api/cybernews/live', async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const requestedCategory = url.searchParams.get('category');
          const limit = Math.min(16, Math.max(4, Number(url.searchParams.get('limit') || 10)));

          const feedResults = await Promise.allSettled(
            FEED_SOURCES.map(async (source) => {
              const response = await fetchWithTimeout(source.feedUrl, {
                headers: {
                  'user-agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
                  accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
                },
              });

              if (!response.ok) {
                throw new Error(`${source.name} feed failed with ${response.status}`);
              }

              return parseFeed(await response.text(), source);
            }),
          );

          const combined = dedupeItems(
            feedResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
          )
            .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
            .slice(0, Math.max(limit * 2, 12));

          if (combined.length === 0) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unable to load live news from configured feeds' }));
            return;
          }

          const enriched = await batchMap(combined, CONCURRENT_ENRICH_LIMIT, async (item) => {
            const meta = await extractArticleMeta(item.url);
            const summary = meta.summary || item.summary || item.title;
            const nextItem: LiveNewsItem = {
              ...item,
              summary,
              imageUrl: meta.imageUrl || item.imageUrl,
            };
            return {
              ...nextItem,
              category: classifyCategory(nextItem),
            };
          });

          const filtered =
            requestedCategory && ['breaking', 'corporate', 'street', 'tech'].includes(requestedCategory)
              ? enriched.filter((item) => item.category === requestedCategory)
              : enriched;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              provider: 'rss',
              fetchedAt: new Date().toISOString(),
              items: filtered.slice(0, limit),
            }),
          );
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    },
  };
}
