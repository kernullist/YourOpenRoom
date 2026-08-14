import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSignalDeskUrl,
  fetchBrief,
  fetchSignals,
  SIGNAL_DESK_BRIEF_ROUTE,
  SIGNAL_DESK_SIGNALS_ROUTE,
} from '../api';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function htmlResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new Error('not json')),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildSignalDeskUrl', () => {
  it('adds sessionPath and refresh only when present', () => {
    expect(buildSignalDeskUrl(SIGNAL_DESK_SIGNALS_ROUTE, '', false)).toBe(
      SIGNAL_DESK_SIGNALS_ROUTE,
    );
    expect(buildSignalDeskUrl(SIGNAL_DESK_SIGNALS_ROUTE, ' aoi/test ', true)).toBe(
      `${SIGNAL_DESK_SIGNALS_ROUTE}?sessionPath=aoi%2Ftest&refresh=1`,
    );
  });
});

describe('fetchSignals classification', () => {
  it('classifies a 404 as unconfigured — the plugin is off, not broken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(htmlResponse(404))),
    );
    expect((await fetchSignals('', false)).kind).toBe('unconfigured');
  });

  it('classifies a 2xx non-JSON body (SPA fallback) as unconfigured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(htmlResponse(200))),
    );
    expect((await fetchSignals('', false)).kind).toBe('unconfigured');
  });

  it('classifies a transport throw as an error, not as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const state = await fetchSignals('', false);
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.message).toContain('ECONNREFUSED');
    }
  });

  it('surfaces the server error message on non-2xx JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(500, { ok: false, error: 'collector exploded' }))),
    );
    const state = await fetchSignals('', false);
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.message).toBe('collector exploded');
    }
  });

  it('treats ok:false 2xx payloads as errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, { ok: false, error: 'nope' }))),
    );
    const state = await fetchSignals('', false);
    expect(state.kind).toBe('error');
  });

  it('returns ready with the payload on success and sends the right url', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          fetchedAt: 1,
          cache: 'fresh',
          sources: [],
          items: [],
          interest: { applied: false, keywordCount: 0, reason: 'no-session' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const state = await fetchSignals('aoi/test', true);
    expect(state.kind).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith(
      `${SIGNAL_DESK_SIGNALS_ROUTE}?sessionPath=aoi%2Ftest&refresh=1`,
    );
  });
});

describe('fetchBrief', () => {
  it('shares the same classification and route building', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          cache: 'cached',
          brief: {
            version: 1,
            date: '2026-08-15',
            generatedAt: 1,
            headline: 'h',
            caveats: [],
            sections: [],
            interest: { applied: false, keywordCount: 0 },
          },
          sources: [],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const state = await fetchBrief('', false);
    expect(state.kind).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith(SIGNAL_DESK_BRIEF_ROUTE);
  });
});
