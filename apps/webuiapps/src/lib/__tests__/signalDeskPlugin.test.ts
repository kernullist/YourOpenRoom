import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSignalDeskInterestLoader,
  createSignalDeskHandlers,
  SIGNAL_DESK_SOURCES,
  signalDeskPlugin,
  type SignalDeskFetchResponse,
  type SignalDeskHandlerDeps,
} from '../signalDeskPlugin';
import type { SignalSourceDef } from '../signalDeskCore';
import { loadAoiInterestProfile } from '../aoiProactiveBriefStore';

vi.mock('../aoiProactiveBriefStore', () => ({
  loadAoiInterestProfile: vi.fn(),
}));

const NOW = Date.parse('2026-08-15T00:00:00Z');

const RSS_OK = `<rss><channel><item>
  <title>Kernel patch analysis</title>
  <link>https://blog.example/kernel-patch</link>
  <description>CVE-2026-1111 details</description>
  <pubDate>Fri, 14 Aug 2026 12:00:00 GMT</pubDate>
</item></channel></rss>`;

const TEST_SOURCES: SignalSourceDef[] = [
  {
    id: 'blog',
    name: 'Blog',
    url: 'https://blog.example/feed',
    kind: 'rss',
    category: 'research',
    weight: 10,
  },
  {
    id: 'down',
    name: 'Down Feed',
    url: 'https://down.example/feed',
    kind: 'rss',
    category: 'msrc',
    weight: 10,
  },
];

function okResponse(text: string): SignalDeskFetchResponse {
  return { ok: true, status: 200, text: () => Promise.resolve(text) };
}

function failResponse(status: number): SignalDeskFetchResponse {
  return { ok: false, status, text: () => Promise.resolve('') };
}

function mockReq(url: string, method = 'GET'): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

interface MockRes {
  res: ServerResponse;
  status: () => number;
  json: () => Record<string, unknown>;
}

function mockRes(): MockRes {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead: (code: number) => {
      statusCode = code;
      return res;
    },
    end: (chunk?: string) => {
      if (typeof chunk === 'string') {
        body = chunk;
      }
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => statusCode,
    json: () => JSON.parse(body) as Record<string, unknown>,
  };
}

function makeDeps(overrides: Partial<SignalDeskHandlerDeps> = {}): {
  deps: SignalDeskHandlerDeps;
  fetchImpl: SignalDeskHandlerDeps['fetchImpl'];
  loadInterest: SignalDeskHandlerDeps['loadInterest'];
} {
  const fetchImpl = vi.fn((url: string) => {
    if (url.startsWith('https://blog.example')) {
      return Promise.resolve(okResponse(RSS_OK));
    }
    return Promise.resolve(failResponse(500));
  });
  const loadInterest = vi.fn(() => ({
    keywords: [],
    meta: { applied: false, keywordCount: 0, reason: 'no-session' as const },
  }));
  const deps: SignalDeskHandlerDeps = {
    fetchImpl,
    loadInterest,
    now: () => NOW,
    sources: TEST_SOURCES,
    ...overrides,
  };
  return { deps, fetchImpl, loadInterest };
}

beforeEach(() => {
  vi.mocked(loadAoiInterestProfile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

describe('signals route', () => {
  it('serves items with per-source outcomes: the dead feed is a named failure', async () => {
    const { deps } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleSignals(mockReq('/?sessionPath=aoi/test'), out.res);

    expect(out.status()).toBe(200);
    const payload = out.json();
    expect(payload.ok).toBe(true);
    expect(payload.cache).toBe('fresh');
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Kernel patch analysis');
    const sources = payload.sources as Array<Record<string, unknown>>;
    expect(sources.find((entry) => entry.sourceId === 'down')).toMatchObject({
      ok: false,
      itemCount: 0,
      error: 'HTTP 500',
    });
    expect(sources.find((entry) => entry.sourceId === 'blog')).toMatchObject({
      ok: true,
      itemCount: 1,
    });
  });

  it('passes the query sessionPath to the interest loader and echoes its meta', async () => {
    const { deps, loadInterest } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleSignals(mockReq('/?sessionPath=aoi/space'), out.res);

    expect(loadInterest).toHaveBeenCalledWith('aoi/space');
    expect(out.json().interest).toMatchObject({ applied: false, reason: 'no-session' });
  });

  it('serves from cache inside the TTL and refetches on refresh=1', async () => {
    const { deps, fetchImpl } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);

    const first = mockRes();
    await handlers.handleSignals(mockReq('/'), first.res);
    expect(first.json().cache).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(TEST_SOURCES.length);

    const second = mockRes();
    await handlers.handleSignals(mockReq('/'), second.res);
    expect(second.json().cache).toBe('cached');
    expect(fetchImpl).toHaveBeenCalledTimes(TEST_SOURCES.length);

    const third = mockRes();
    await handlers.handleSignals(mockReq('/?refresh=1'), third.res);
    expect(third.json().cache).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(TEST_SOURCES.length * 2);
  });

  it('filters by category when the param is valid', async () => {
    const { deps } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);

    const research = mockRes();
    await handlers.handleSignals(mockReq('/?category=research'), research.res);
    expect(research.json().items).toHaveLength(1);

    const vuln = mockRes();
    await handlers.handleSignals(mockReq('/?category=vuln'), vuln.res);
    expect(vuln.json().items).toHaveLength(0);
  });

  it('rejects non-GET methods', async () => {
    const { deps } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleSignals(mockReq('/', 'POST'), out.res);
    expect(out.status()).toBe(405);
  });

  it('tolerates a non-numeric limit param', async () => {
    const { deps } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleSignals(mockReq('/?limit=abc'), out.res);
    expect(out.status()).toBe(200);
    expect(out.json().items).toHaveLength(1);
  });

  it('answers 500 with the message when a dependency throws', async () => {
    const { deps } = makeDeps({
      loadInterest: vi.fn(() => {
        throw new Error('loader blew up');
      }),
    });
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleSignals(mockReq('/?sessionPath=aoi/x'), out.res);
    expect(out.status()).toBe(500);
    expect(String(out.json().error)).toContain('loader blew up');
  });
});

describe('vite plugin wiring', () => {
  it('registers both routes and serves them through the real fetch wrapper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(RSS_OK),
        } as unknown as Response),
      ),
    );
    vi.mocked(loadAoiInterestProfile).mockReturnValue({
      version: 1,
      sessionPath: 'aoi/x',
      generatedAt: NOW,
      sourceMemoryCount: 0,
      warnings: [],
      topics: [],
    } as unknown as ReturnType<typeof loadAoiInterestProfile>);

    const plugin = signalDeskPlugin({ sessionsDir: '/sessions' });
    const use = vi.fn();
    const configureServer = plugin.configureServer as (server: unknown) => void;
    configureServer({ middlewares: { use } });

    expect(use).toHaveBeenCalledTimes(2);
    const mounted = use.mock.calls.map((call) => call[0] as string);
    expect(mounted).toContain('/api/signal-desk/signals');
    expect(mounted).toContain('/api/signal-desk/brief');

    const signalsMiddleware = use.mock.calls.find(
      (call) => call[0] === '/api/signal-desk/signals',
    )?.[1] as (req: IncomingMessage, res: ServerResponse) => void;
    const out = mockRes();
    signalsMiddleware(mockReq('/?sessionPath=aoi/x'), out.res);
    await until(() => out.status() !== 0);

    expect(out.status()).toBe(200);
    const payload = out.json();
    expect(payload.ok).toBe(true);
    // Every registry source got an outcome; the KEV source fails to parse RSS
    // text as JSON and must surface as a named failure, not disappear.
    const sources = payload.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(SIGNAL_DESK_SOURCES.length);
    const kev = sources.find((entry) => entry.sourceId === 'cisa-kev');
    expect(kev).toMatchObject({ ok: false });
    expect(payload.interest).toMatchObject({ applied: false, reason: 'no-profile' });
  });
});

describe('brief route', () => {
  it('composes a brief with an honest headline and failure caveats', async () => {
    const { deps } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleBrief(mockReq('/?sessionPath=aoi/test'), out.res);

    expect(out.status()).toBe(200);
    const brief = out.json().brief as Record<string, unknown>;
    expect(brief.headline).toBe('신호 1건 · KEV 0건 · 소스 1/2 정상');
    const caveats = brief.caveats as string[];
    expect(caveats.some((caveat) => caveat.includes('Down Feed 수집 실패'))).toBe(true);
  });

  it('rejects non-GET methods', async () => {
    const { deps } = makeDeps();
    const handlers = createSignalDeskHandlers(deps);
    const out = mockRes();
    await handlers.handleBrief(mockReq('/', 'DELETE'), out.res);
    expect(out.status()).toBe(405);
  });
});

describe('interest loader', () => {
  it('reports no-session without touching the profile store', () => {
    const loader = buildSignalDeskInterestLoader('/sessions');
    const result = loader('');
    expect(result.meta).toMatchObject({ applied: false, reason: 'no-session' });
    expect(loadAoiInterestProfile).not.toHaveBeenCalled();
  });

  it('maps topics to deduped keywords weighted by importance*confidence', () => {
    vi.mocked(loadAoiInterestProfile).mockReturnValue({
      version: 1,
      sessionPath: 'aoi/test',
      generatedAt: NOW,
      sourceMemoryCount: 3,
      warnings: [],
      topics: [
        {
          label: 'Windows Kernel Internals',
          aliases: ['kernel', 'KMDF'],
          importance: 1,
          confidence: 0.8,
        },
        {
          label: 'kernel',
          aliases: [],
          importance: 0.2,
          confidence: 0.2,
        },
      ],
    } as unknown as ReturnType<typeof loadAoiInterestProfile>);

    const loader = buildSignalDeskInterestLoader('/sessions');
    const result = loader('aoi/test');
    expect(result.meta).toMatchObject({ applied: true, keywordCount: 3 });
    const kernel = result.keywords.find((keyword) => keyword.term.toLowerCase() === 'kernel');
    expect(kernel?.weight).toBeCloseTo(0.8);
  });

  it('reports an empty profile as no-profile, not as default-by-choice', () => {
    vi.mocked(loadAoiInterestProfile).mockReturnValue({
      version: 1,
      sessionPath: 'aoi/test',
      generatedAt: NOW,
      sourceMemoryCount: 0,
      warnings: [],
      topics: [],
    } as unknown as ReturnType<typeof loadAoiInterestProfile>);

    const loader = buildSignalDeskInterestLoader('/sessions');
    expect(loader('aoi/test').meta).toMatchObject({ applied: false, reason: 'no-profile' });
  });

  it('reports a throwing profile read as profile-error with the message', () => {
    vi.mocked(loadAoiInterestProfile).mockImplementation(() => {
      throw new Error('EACCES: denied');
    });
    const loader = buildSignalDeskInterestLoader('/sessions');
    const result = loader('aoi/test');
    expect(result.meta).toMatchObject({ applied: false, reason: 'profile-error' });
    expect(result.meta.detail).toContain('EACCES');
  });
});

describe('source registry', () => {
  it('keeps every outbound url https and key-free (the allowlist is the registry)', () => {
    expect(SIGNAL_DESK_SOURCES.length).toBeGreaterThanOrEqual(5);
    for (const entry of SIGNAL_DESK_SOURCES) {
      expect(entry.url.startsWith('https://')).toBe(true);
      expect(entry.url).not.toMatch(/api[_-]?key|token=/i);
    }
  });
});
