import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterAppAction } from '@/lib';
import type { SignalItem, SignalsResponse, SignalBriefResponse } from '@/lib/signalDeskShared';
import type { PanelState } from '../types';

// Coverage for the orchestration layer (MissionControl pattern): state.json
// bootstrapping, the agent action surface, honesty banners, and the research
// handoff — the parts an e2e spec can only exercise indirectly.

const { fileStore, fileLists, capturedHandlers, liveSession, apiMocks, researchMock } = vi.hoisted(
  () => ({
    fileStore: new Map<string, unknown>(),
    fileLists: new Map<string, Array<{ name: string }>>(),
    capturedHandlers: [] as Array<(action: CharacterAppAction) => Promise<string>>,
    liveSession: { value: '' },
    apiMocks: {
      signals: { value: null as PanelState<SignalsResponse> | null },
      brief: { value: null as PanelState<SignalBriefResponse> | null },
    },
    researchMock: {
      impl: (() => Promise.resolve({ ok: true as const, run: {}, background: true })) as (
        params: unknown,
      ) => Promise<unknown>,
      calls: [] as unknown[],
    },
  }),
);

vi.mock('@/lib', () => ({
  createAppFileApi: () => ({
    listFiles: (path: string) => Promise.resolve(fileLists.get(path) ?? []),
    readFile: (path: string) => Promise.resolve({ content: fileStore.get(path) ?? null }),
    writeFile: (path: string, data: unknown) => {
      fileStore.set(path, data);
      return Promise.resolve();
    },
  }),
  reportLifecycle: vi.fn(),
  useAgentActionListener: (
    _appId: number,
    handler: (action: CharacterAppAction) => Promise<string>,
  ) => {
    capturedHandlers.push(handler);
  },
}));

vi.mock('@gui/vibe-container', () => ({
  AppLifecycle: {
    LOADING: 'LOADING',
    DOM_READY: 'DOM_READY',
    LOADED: 'LOADED',
    ERROR: 'ERROR',
    UNLOADING: 'UNLOADING',
    DESTROYED: 'DESTROYED',
  },
  initVibeApp: () => Promise.resolve({ ready: () => {} }),
}));

vi.mock('@/lib/sessionPath', () => ({
  getSessionPath: () => liveSession.value,
}));

vi.mock('@/lib/aoiResearchClient', () => ({
  startAoiResearchRun: (params: unknown) => {
    researchMock.calls.push(params);
    return researchMock.impl(params);
  },
}));

vi.mock('../api', () => ({
  fetchSignals: vi.fn(() =>
    Promise.resolve(apiMocks.signals.value ?? { kind: 'empty', reason: 'x', fetchedAt: 1 }),
  ),
  fetchBrief: vi.fn(() =>
    Promise.resolve(apiMocks.brief.value ?? { kind: 'empty', reason: 'x', fetchedAt: 1 }),
  ),
}));

import SignalDesk from '../index';
import * as api from '../api';

const NOW = Date.parse('2026-08-15T00:00:00Z');

function item(overrides: Partial<SignalItem>): SignalItem {
  return {
    id: 'sig-vuln',
    title: 'CVE-2026-1111: Kernel LPE',
    url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1111',
    summary: 'LPE in win32k',
    sourceId: 'cisa-kev',
    sourceName: 'CISA KEV',
    category: 'vuln',
    publishedAt: new Date(NOW - 3_600_000).toISOString(),
    score: 73,
    scoreReasons: ['KEV 등재(실제 악용)', '1시간 내 신규'],
    cveIds: ['CVE-2026-1111'],
    kev: true,
    duplicateCount: 1,
    otherSources: ['MSRC Update Guide'],
    ...overrides,
  };
}

function signalsReady(overrides: Partial<SignalsResponse> = {}): PanelState<SignalsResponse> {
  return {
    kind: 'ready',
    fetchedAt: NOW,
    data: {
      ok: true,
      fetchedAt: NOW,
      cache: 'fresh',
      sources: [
        {
          sourceId: 'cisa-kev',
          name: 'CISA KEV',
          kind: 'kev-json',
          category: 'vuln',
          ok: true,
          itemCount: 1,
          ms: 120,
        },
        {
          sourceId: 'secret-club',
          name: 'secret club',
          kind: 'rss',
          category: 'research',
          ok: true,
          itemCount: 1,
          ms: 80,
        },
      ],
      items: [
        item({}),
        item({
          id: 'sig-blog',
          title: 'EPT hooks',
          category: 'research',
          kev: false,
          cveIds: [],
          duplicateCount: 0,
          otherSources: [],
          scoreReasons: ['1시간 내 신규'],
        }),
      ],
      interest: { applied: true, keywordCount: 5 },
      ...overrides,
    },
  };
}

function briefReady(): PanelState<SignalBriefResponse> {
  return {
    kind: 'ready',
    fetchedAt: NOW,
    data: {
      ok: true,
      cache: 'fresh',
      brief: {
        version: 1,
        date: '2026-08-15',
        generatedAt: NOW,
        headline: '신호 2건 · KEV 1건 · 소스 2/2 정상',
        caveats: [],
        sections: [{ category: 'vuln', title: '취약점 / KEV', items: [item({})] }],
        interest: { applied: true, keywordCount: 5 },
      },
      sources: [],
    },
  };
}

function latestHandler(): (action: CharacterAppAction) => Promise<string> {
  return capturedHandlers[capturedHandlers.length - 1];
}

function agentAction(type: string, params?: Record<string, string>): CharacterAppAction {
  return { action_type: type, params } as CharacterAppAction;
}

async function renderDesk(): Promise<void> {
  render(<SignalDesk />);
  await waitFor(() => expect(screen.getByTestId('signal-desk')).toBeTruthy());
  await waitFor(() => expect(api.fetchSignals).toHaveBeenCalled());
}

beforeEach(() => {
  fileStore.clear();
  fileLists.clear();
  capturedHandlers.length = 0;
  liveSession.value = '';
  apiMocks.signals.value = signalsReady();
  apiMocks.brief.value = briefReady();
  researchMock.calls.length = 0;
  researchMock.impl = () => Promise.resolve({ ok: true as const, run: {}, background: true });
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('bootstrapping', () => {
  it('creates state.json with defaults and adopts the live session on first run', async () => {
    liveSession.value = 'aoi/space_adventure';
    await renderDesk();

    await waitFor(() => expect(fileStore.get('/state.json')).toBeTruthy());
    expect(fileStore.get('/state.json')).toMatchObject({
      version: 1,
      activeView: 'inbox',
      sessionPath: 'aoi/space_adventure',
    });
    // The first fetch must already carry the adopted session — waiting for the
    // state commit would silently drop interest weighting on first load.
    await waitFor(() =>
      expect(api.fetchSignals).toHaveBeenCalledWith('aoi/space_adventure', false),
    );
  });

  it('restores a persisted view without inheriting defaults', async () => {
    fileLists.set('/', [{ name: 'state.json' }]);
    fileStore.set('/state.json', {
      version: 1,
      activeView: 'sources',
      category: 'vuln',
      sessionPath: 'aoi/persisted',
      seenIds: [],
    });
    await renderDesk();

    await waitFor(() =>
      expect(screen.getByTestId('signal-desk-rail-sources').getAttribute('data-active')).toBe(
        'true',
      ),
    );
    await waitFor(() => expect(screen.getByTestId('signal-desk-source-cisa-kev')).toBeTruthy());
  });
});

describe('inbox honesty', () => {
  it('renders rows with score reasons and marks a row seen on expand', async () => {
    await renderDesk();
    const row = await screen.findByTestId('signal-desk-row-sig-vuln');
    expect(row.textContent).toContain('CVE-2026-1111');

    fireEvent.click(row.querySelector('button') as HTMLButtonElement);
    const expand = await screen.findByTestId('signal-desk-expand-sig-vuln');
    expect(expand.textContent).toContain('KEV 등재(실제 악용)');
    expect(expand.textContent).toContain('중복 출처: MSRC Update Guide');

    await waitFor(() =>
      expect(fileStore.get('/state.json')).toMatchObject({ seenIds: ['sig-vuln'] }),
    );
  });

  it('shows a partial-failure caveat when some sources failed', async () => {
    apiMocks.signals.value = signalsReady({
      sources: [
        {
          sourceId: 'cisa-kev',
          name: 'CISA KEV',
          kind: 'kev-json',
          category: 'vuln',
          ok: true,
          itemCount: 1,
          ms: 120,
        },
        {
          sourceId: 'msrc',
          name: 'MSRC Update Guide',
          kind: 'rss',
          category: 'msrc',
          ok: false,
          itemCount: 0,
          error: 'HTTP 503',
          ms: 12_000,
        },
      ],
    });
    await renderDesk();
    const banner = await screen.findByTestId('signal-desk-partial');
    expect(banner.textContent).toContain('MSRC Update Guide');
    expect(screen.queryByTestId('signal-desk-all-failed')).toBeNull();
  });

  it('renders all-sources-failed as error-grade, never as an empty inbox', async () => {
    apiMocks.signals.value = signalsReady({
      items: [],
      sources: [
        {
          sourceId: 'cisa-kev',
          name: 'CISA KEV',
          kind: 'kev-json',
          category: 'vuln',
          ok: false,
          itemCount: 0,
          error: 'timeout',
          ms: 12_000,
        },
      ],
      interest: { applied: false, keywordCount: 0, reason: 'no-session' },
    });
    await renderDesk();
    const block = await screen.findByTestId('signal-desk-all-failed');
    expect(block.textContent).toContain('읽지 못한 것');
    expect(screen.queryByTestId('signal-desk-inbox-empty')).toBeNull();
  });

  it('filters by category chips', async () => {
    await renderDesk();
    await screen.findByTestId('signal-desk-row-sig-vuln');

    fireEvent.click(screen.getByTestId('signal-desk-chip-research'));
    await waitFor(() => expect(screen.queryByTestId('signal-desk-row-sig-vuln')).toBeNull());
    expect(screen.getByTestId('signal-desk-row-sig-blog')).toBeTruthy();
  });
});

describe('agent surface', () => {
  it('switches views, refreshes with force, and syncs state', async () => {
    await renderDesk();
    const handler = latestHandler();

    expect(await handler(agentAction('SELECT_SIGNAL_DESK_VIEW', { view: 'sources' }))).toBe(
      'success',
    );
    await waitFor(() =>
      expect(screen.getByTestId('signal-desk-rail-sources').getAttribute('data-active')).toBe(
        'true',
      ),
    );

    expect(await handler(agentAction('SELECT_SIGNAL_DESK_VIEW', { view: 'bogus' }))).toContain(
      'error',
    );

    expect(await handler(agentAction('REFRESH_SIGNALS'))).toBe('success');
    expect(api.fetchSignals).toHaveBeenLastCalledWith(expect.any(String), true);

    fileLists.set('/', [{ name: 'state.json' }]);
    fileStore.set('/state.json', {
      version: 1,
      activeView: 'brief',
      category: 'all',
      sessionPath: '',
      seenIds: [],
    });
    expect(await handler(agentAction('SYNC_STATE'))).toBe('success');
    await waitFor(() =>
      expect(screen.getByTestId('signal-desk-rail-brief').getAttribute('data-active')).toBe('true'),
    );

    expect(await handler(agentAction('START_RESEARCH'))).toContain('error');
  });
});

describe('research handoff', () => {
  it('is disabled without a session and says why', async () => {
    await renderDesk();
    const row = await screen.findByTestId('signal-desk-row-sig-vuln');
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);

    const handoff = await screen.findByTestId('signal-desk-handoff');
    expect((handoff as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('signal-desk-need-session')).toBeTruthy();
  });

  it('starts a run with the composed request and reports success', async () => {
    await renderDesk();
    fireEvent.change(screen.getByTestId('signal-desk-session'), {
      target: { value: 'aoi/test' },
    });
    const row = await screen.findByTestId('signal-desk-row-sig-vuln');
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);

    const handoff = await screen.findByTestId('signal-desk-handoff');
    fireEvent.click(handoff);

    await waitFor(() => expect(researchMock.calls).toHaveLength(1));
    expect(researchMock.calls[0]).toMatchObject({ sessionPath: 'aoi/test' });
    expect((researchMock.calls[0] as { request: string }).request).toContain(
      'Deep dive: CVE-2026-1111',
    );
    const state = await screen.findByTestId('signal-desk-research-state');
    expect(state.textContent).toContain('리서치가 백그라운드에서 시작');
  });

  it('renders a duplicate-run answer as denied, not as an error', async () => {
    researchMock.impl = () => Promise.reject(new Error('HTTP 409: duplicate active run'));
    await renderDesk();
    fireEvent.change(screen.getByTestId('signal-desk-session'), {
      target: { value: 'aoi/test' },
    });
    const row = await screen.findByTestId('signal-desk-row-sig-vuln');
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);
    fireEvent.click(await screen.findByTestId('signal-desk-handoff'));

    const state = await screen.findByTestId('signal-desk-research-state');
    await waitFor(() => expect(state.getAttribute('data-variant')).toBe('denied'));
    expect(state.textContent).toContain('이미 진행 중');
  });
});

describe('inbox interactions', () => {
  it('forces a re-collection from the refresh button', async () => {
    await renderDesk();
    fireEvent.click(screen.getByTestId('signal-desk-refresh'));
    await waitFor(() =>
      expect(api.fetchSignals).toHaveBeenLastCalledWith(expect.any(String), true),
    );
  });

  it('opens the original url in a new window without opener access', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    await renderDesk();
    const row = await screen.findByTestId('signal-desk-row-sig-vuln');
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);

    fireEvent.click(await screen.findByTestId('signal-desk-open-url'));
    expect(openSpy).toHaveBeenCalledWith(
      'https://nvd.nist.gov/vuln/detail/CVE-2026-1111',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});

describe('saved briefs', () => {
  it('lists date-named files only and opens a valid saved brief', async () => {
    fileLists.set('/', [{ name: 'state.json' }, { name: 'briefs' }]);
    fileStore.set('/state.json', {
      version: 1,
      activeView: 'brief',
      category: 'all',
      sessionPath: '',
      seenIds: [],
    });
    fileLists.set('/briefs', [{ name: '2026-08-14.json' }, { name: 'junk.txt' }]);
    fileStore.set(
      '/briefs/2026-08-14.json',
      JSON.stringify({
        version: 1,
        date: '2026-08-14',
        generatedAt: NOW,
        headline: '저장된 헤드라인',
        caveats: [],
        sections: [],
        interest: { applied: false, keywordCount: 0, reason: 'no-session' },
      }),
    );

    await renderDesk();
    const saved = await screen.findByTestId('signal-desk-saved-2026-08-14.json');
    expect(screen.queryByTestId('signal-desk-saved-junk.txt')).toBeNull();

    fireEvent.click(saved);
    await waitFor(() => expect(screen.getByText('저장된 헤드라인')).toBeTruthy());
  });

  it('reports a malformed saved brief as a format error, not as empty', async () => {
    fileLists.set('/', [{ name: 'state.json' }, { name: 'briefs' }]);
    fileStore.set('/state.json', {
      version: 1,
      activeView: 'brief',
      category: 'all',
      sessionPath: '',
      seenIds: [],
    });
    fileLists.set('/briefs', [{ name: '2026-08-13.json' }]);
    fileStore.set('/briefs/2026-08-13.json', '{ not json');

    await renderDesk();
    fireEvent.click(await screen.findByTestId('signal-desk-saved-2026-08-13.json'));
    const error = await screen.findByTestId('signal-desk-opened-error');
    expect(error.textContent).toContain('형식이 올바르지 않습니다');
  });
});

describe('brief', () => {
  it('loads the brief on view switch and saves it to /briefs/{date}.json', async () => {
    await renderDesk();
    fireEvent.click(screen.getByTestId('signal-desk-rail-brief'));

    await waitFor(() => expect(api.fetchBrief).toHaveBeenCalled());
    const doc = await screen.findByTestId('signal-desk-brief-doc');
    expect(doc.textContent).toContain('신호 2건');

    fireEvent.click(screen.getByTestId('signal-desk-brief-save'));
    await waitFor(() =>
      expect(fileStore.get('/briefs/2026-08-15.json')).toMatchObject({ version: 1 }),
    );
    expect((await screen.findByTestId('signal-desk-brief-saved-note')).textContent).toContain(
      '저장됨',
    );
  });
});
