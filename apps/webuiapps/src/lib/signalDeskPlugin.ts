import type { IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';
import { loadAoiInterestProfile } from './aoiProactiveBriefStore';
import {
  buildBrief,
  buildSignals,
  parseFeedEntries,
  parseKevEntries,
  type InterestKeyword,
  type RawFeedEntry,
  type SignalSourceDef,
  type SourceFetchResult,
} from './signalDeskCore';
import { isSignalCategory, type InterestMeta } from './signalDeskShared';

/**
 * Signal Desk collector: the only place external feeds are fetched.
 *
 * The app talks to local routes exclusively (cyberNewsProxyPlugin/gmailPlugin
 * precedent). The domain allowlist is enforced by construction: every outbound
 * URL comes from SIGNAL_DESK_SOURCES below, and no client-supplied parameter
 * participates in forming a URL. There is deliberately no per-article
 * enrichment fetch.
 *
 * Interest weighting reads Aoi's interest profile (node-only module chain:
 * crypto) — server-side only. The app receives the computed InterestMeta and
 * must never import aoiInterestProfile/aoiProactiveBriefStore itself; that
 * breaks `pnpm build` while typecheck and vitest stay green. Enforced by
 * src/pages/SignalDesk/__tests__/actionSafety.test.ts.
 */

export const SIGNAL_DESK_SOURCES: SignalSourceDef[] = [
  {
    id: 'cisa-kev',
    name: 'CISA KEV',
    url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    kind: 'kev-json',
    category: 'vuln',
    weight: 18,
  },
  {
    id: 'msrc',
    name: 'MSRC Update Guide',
    url: 'https://api.msrc.microsoft.com/update-guide/rss',
    kind: 'rss',
    category: 'msrc',
    weight: 14,
  },
  {
    id: 'secret-club',
    name: 'secret club',
    url: 'https://secret.club/feed.xml',
    kind: 'rss',
    category: 'research',
    weight: 16,
  },
  {
    id: 'connor-mcgarr',
    name: 'Connor McGarr',
    url: 'https://connormcgarr.github.io/feed.xml',
    kind: 'rss',
    category: 'research',
    weight: 14,
  },
  {
    id: 'arxiv-cscr',
    name: 'arXiv cs.CR',
    url: 'https://export.arxiv.org/api/query?search_query=cat:cs.CR&sortBy=submittedDate&sortOrder=descending&max_results=12',
    kind: 'atom',
    category: 'paper',
    weight: 8,
  },
  {
    id: 'gh-x64dbg',
    name: 'x64dbg releases',
    url: 'https://github.com/x64dbg/x64dbg/releases.atom',
    kind: 'atom',
    category: 'release',
    weight: 10,
  },
  {
    id: 'gh-hyperdbg',
    name: 'HyperDbg releases',
    url: 'https://github.com/HyperDbg/HyperDbg/releases.atom',
    kind: 'atom',
    category: 'release',
    weight: 10,
  },
  {
    id: 'openai-news',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    kind: 'rss',
    category: 'ai',
    weight: 12,
  },
  {
    id: 'deepmind',
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml',
    kind: 'rss',
    category: 'ai',
    weight: 10,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    kind: 'rss',
    category: 'ai',
    weight: 8,
  },
  {
    id: 'simonwillison',
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/everything/',
    kind: 'atom',
    category: 'ai',
    weight: 12,
  },
  {
    id: 'gh-claude-code',
    name: 'Claude Code releases',
    url: 'https://github.com/anthropics/claude-code/releases.atom',
    kind: 'atom',
    category: 'harness',
    weight: 12,
  },
  {
    id: 'gh-codex',
    name: 'Codex CLI releases',
    url: 'https://github.com/openai/codex/releases.atom',
    kind: 'atom',
    category: 'harness',
    weight: 12,
  },
  {
    id: 'gh-gemini-cli',
    name: 'Gemini CLI releases',
    url: 'https://github.com/google-gemini/gemini-cli/releases.atom',
    kind: 'atom',
    category: 'harness',
    weight: 8,
  },
];

const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_ENTRIES_PER_SOURCE = 12;
const DEFAULT_ITEM_LIMIT = 80;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export interface SignalDeskInterestResult {
  keywords: InterestKeyword[];
  meta: InterestMeta;
}

/** Minimal structural fetch response so tests can inject plain objects. */
export interface SignalDeskFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export interface SignalDeskHandlerDeps {
  fetchImpl: (url: string) => Promise<SignalDeskFetchResponse>;
  loadInterest: (sessionPath: string) => SignalDeskInterestResult;
  now: () => number;
  sources?: SignalSourceDef[];
  cacheTtlMs?: number;
  maxEntriesPerSource?: number;
}

export interface SignalDeskHandlers {
  handleSignals: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  handleBrief: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CollectedSnapshot {
  fetchedAt: number;
  results: SourceFetchResult[];
}

export function createSignalDeskHandlers(deps: SignalDeskHandlerDeps): SignalDeskHandlers {
  const sources = deps.sources ?? SIGNAL_DESK_SOURCES;
  const cacheTtlMs = deps.cacheTtlMs ?? CACHE_TTL_MS;
  const maxEntries = deps.maxEntriesPerSource ?? MAX_ENTRIES_PER_SOURCE;

  let snapshot: CollectedSnapshot | null = null;
  let inflight: Promise<{
    results: SourceFetchResult[];
    fetchedAt: number;
    cache: 'fresh' | 'cached';
  }> | null = null;

  async function fetchOneSource(source: SignalSourceDef): Promise<SourceFetchResult> {
    const startedAt = deps.now();
    try {
      const response = await deps.fetchImpl(source.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const parseOptions = { max: maxEntries, fallbackNowMs: deps.now() };
      // The declared kind is display metadata; xml feeds are auto-detected
      // because "feed.xml" is Atom on Jekyll blogs and RSS elsewhere.
      let entries: RawFeedEntry[];
      if (source.kind === 'kev-json') {
        entries = parseKevEntries(text, parseOptions);
      } else {
        entries = parseFeedEntries(text, parseOptions);
      }
      return { source, ok: true, entries, ms: deps.now() - startedAt };
    } catch (error) {
      // A failed source stays a *named failure with a reason*; it never
      // collapses into "zero items".
      return {
        source,
        ok: false,
        entries: [],
        error: errorMessage(error),
        ms: deps.now() - startedAt,
      };
    }
  }

  function collect(force: boolean): Promise<{
    results: SourceFetchResult[];
    fetchedAt: number;
    cache: 'fresh' | 'cached';
  }> {
    const nowMs = deps.now();
    if (!force && snapshot && nowMs - snapshot.fetchedAt < cacheTtlMs) {
      return Promise.resolve({
        results: snapshot.results,
        fetchedAt: snapshot.fetchedAt,
        cache: 'cached',
      });
    }
    if (inflight) {
      return inflight;
    }
    inflight = (async () => {
      const results = await Promise.all(sources.map((source) => fetchOneSource(source)));
      const fetchedAt = deps.now();
      snapshot = { fetchedAt, results };
      return { results, fetchedAt, cache: 'fresh' as const };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function handleSignals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const sessionPath = (url.searchParams.get('sessionPath') || '').trim();
      const force = url.searchParams.get('refresh') === '1';
      const categoryParam = url.searchParams.get('category');
      const limitRaw = Number(url.searchParams.get('limit') || DEFAULT_ITEM_LIMIT);
      const limit = Math.min(
        120,
        Math.max(10, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_ITEM_LIMIT),
      );

      const { results, fetchedAt, cache } = await collect(force);
      const interest = deps.loadInterest(sessionPath);
      const { items, outcomes } = buildSignals(results, {
        now: deps.now(),
        interestKeywords: interest.keywords,
        maxItems: limit,
      });
      const filtered = isSignalCategory(categoryParam)
        ? items.filter((item) => item.category === categoryParam)
        : items;

      writeJson(res, 200, {
        ok: true,
        fetchedAt,
        cache,
        sources: outcomes,
        items: filtered,
        interest: interest.meta,
      });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: errorMessage(error) });
    }
  }

  async function handleBrief(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const sessionPath = (url.searchParams.get('sessionPath') || '').trim();
      const force = url.searchParams.get('refresh') === '1';

      const { results, cache } = await collect(force);
      const interest = deps.loadInterest(sessionPath);
      const { items, outcomes } = buildSignals(results, {
        now: deps.now(),
        interestKeywords: interest.keywords,
        maxItems: DEFAULT_ITEM_LIMIT,
      });
      const brief = buildBrief(items, outcomes, { now: deps.now(), interest: interest.meta });

      writeJson(res, 200, { ok: true, cache, brief, sources: outcomes });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: errorMessage(error) });
    }
  }

  return { handleSignals, handleBrief };
}

/**
 * Maps Aoi's interest profile to flat keyword weights. Every non-application
 * is a stated reason — an unreadable profile must never masquerade as
 * "default ranking by choice".
 */
export function buildSignalDeskInterestLoader(
  sessionsDir: string,
): (sessionPath: string) => SignalDeskInterestResult {
  return (sessionPath: string) => {
    if (!sessionPath) {
      return { keywords: [], meta: { applied: false, keywordCount: 0, reason: 'no-session' } };
    }
    try {
      const profile = loadAoiInterestProfile(sessionsDir, sessionPath);
      const topics = Array.isArray(profile?.topics) ? profile.topics : [];
      const byTerm = new Map<string, InterestKeyword>();
      for (const topic of topics) {
        const weight = clamp01((topic.importance ?? 0) * (topic.confidence ?? 0));
        for (const rawTerm of [topic.label, ...(topic.aliases ?? [])]) {
          const term = (rawTerm || '').trim();
          if (term.length < 2) {
            continue;
          }
          const key = term.toLowerCase();
          const existing = byTerm.get(key);
          if (!existing || existing.weight < weight) {
            byTerm.set(key, { term, weight });
          }
        }
      }
      const keywords = [...byTerm.values()];
      if (keywords.length === 0) {
        return { keywords: [], meta: { applied: false, keywordCount: 0, reason: 'no-profile' } };
      }
      return { keywords, meta: { applied: true, keywordCount: keywords.length } };
    } catch (error) {
      return {
        keywords: [],
        meta: {
          applied: false,
          keywordCount: 0,
          reason: 'profile-error',
          detail: errorMessage(error).slice(0, 160),
        },
      };
    }
  };
}

function fetchWithTimeout(url: string): Promise<SignalDeskFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      accept:
        'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml;q=0.9, */*;q=0.8',
    },
  }).finally(() => clearTimeout(timer));
}

export interface SignalDeskPluginOptions {
  sessionsDir: string;
}

export function signalDeskPlugin(options: SignalDeskPluginOptions): Plugin {
  const handlers = createSignalDeskHandlers({
    fetchImpl: (url) => fetchWithTimeout(url),
    loadInterest: buildSignalDeskInterestLoader(options.sessionsDir),
    now: () => Date.now(),
  });
  return {
    name: 'signal-desk',
    configureServer(server) {
      server.middlewares.use('/api/signal-desk/signals', (req, res) => {
        void handlers.handleSignals(req, res);
      });
      server.middlewares.use('/api/signal-desk/brief', (req, res) => {
        void handlers.handleBrief(req, res);
      });
    },
  };
}
