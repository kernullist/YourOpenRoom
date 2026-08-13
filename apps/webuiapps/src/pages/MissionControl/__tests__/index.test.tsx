import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CharacterAppAction } from '@/lib';
import type { PanelState, SessionChoice } from '../types';

// Coverage for the orchestration layer: the agent action surface, state.json
// bootstrapping, and the polling rules. These are the parts an e2e spec can
// exercise only indirectly -- an agent action has no UI to click, and the
// state.json first-run path only happens once per isolated home.

const { fileStore, listedFiles, capturedHandlers, apiMocks } = vi.hoisted(() => ({
  fileStore: new Map<string, unknown>(),
  listedFiles: { value: [] as Array<{ name: string }> },
  capturedHandlers: [] as Array<(action: CharacterAppAction) => Promise<string>>,
  apiMocks: {
    sessions: { value: null as PanelState<SessionChoice[]> | null },
  },
}));

vi.mock('@/lib', () => ({
  createAppFileApi: () => ({
    listFiles: () => Promise.resolve(listedFiles.value),
    readFile: (path: string) => Promise.resolve({ content: fileStore.get(path) ?? null }),
    writeFile: (path: string, data: unknown) => {
      fileStore.set(path, data);
      return Promise.resolve();
    },
  }),
  reportLifecycle: vi.fn(),
  useAgentActionListener: (_appId: number, handler: (a: CharacterAppAction) => Promise<string>) => {
    capturedHandlers.push(handler);
  },
}));

const READY_SESSIONS: PanelState<SessionChoice[]> = {
  kind: 'ready',
  data: [
    { sessionPath: 'aoi/newest', updatedAt: 20 },
    { sessionPath: 'aoi/older', updatedAt: 10 },
  ],
  fetchedAt: 1,
};

vi.mock('../api', () => {
  const empty = (reason: string) => ({ kind: 'empty', reason, fetchedAt: 1 });
  return {
    fetchSessions: vi.fn(() => Promise.resolve(apiMocks.sessions.value ?? READY_SESSIONS)),
    fetchRuntime: vi.fn(() =>
      Promise.resolve({
        kind: 'ready',
        data: { runtime: { status: 'not_running', port: 7333, snapshot: null } },
        fetchedAt: 1,
      }),
    ),
    fetchStatus: vi.fn(() => Promise.resolve(empty('no status'))),
    fetchSnapshot: vi.fn(() => Promise.resolve(empty('no snapshot'))),
    fetchScheduler: vi.fn(() => Promise.resolve(empty('no scheduler'))),
    fetchProposals: vi.fn(() => Promise.resolve(empty('활성 제안이 없습니다.'))),
    fetchTimeline: vi.fn(() => Promise.resolve(empty('no timeline'))),
    fetchFlight: vi.fn(() => Promise.resolve(empty('no flight'))),
    fetchMetrics: vi.fn(() => Promise.resolve(empty('no metrics'))),
    decideProposal: vi.fn(() => Promise.resolve({ ok: true, message: 'ok' })),
    runManualTick: vi.fn(() => Promise.resolve({ ok: true, message: 'ticked' })),
  };
});

import MissionControl from '../index';
import * as api from '../api';

function latestHandler(): (action: CharacterAppAction) => Promise<string> {
  return capturedHandlers[capturedHandlers.length - 1];
}

function action(type: string, params?: Record<string, string>): CharacterAppAction {
  return { action_type: type, params } as CharacterAppAction;
}

async function renderApp(): Promise<void> {
  render(<MissionControl />);
  await waitFor(() => expect(screen.getByTestId('mission-control')).toBeTruthy());
  await waitFor(() => expect(api.fetchSessions).toHaveBeenCalled());
}

beforeEach(() => {
  fileStore.clear();
  listedFiles.value = [];
  capturedHandlers.length = 0;
  apiMocks.sessions.value = null;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('MissionControl bootstrapping', () => {
  it('creates state.json with defaults when it does not exist yet', async () => {
    await renderApp();

    await waitFor(() => expect(fileStore.get('/state.json')).toBeTruthy());
    expect(fileStore.get('/state.json')).toMatchObject({
      version: 1,
      activeView: 'runtime',
      sessionPath: null,
      autoRefresh: true,
    });
  });

  it('restores a persisted view and session', async () => {
    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', {
      version: 1,
      activeView: 'timeline',
      sessionPath: 'aoi/older',
      autoRefresh: false,
      refreshIntervalMs: 30000,
      timelineKindFilter: null,
      selectedProposalId: null,
    });

    await renderApp();

    await waitFor(() =>
      expect(screen.getByTestId('mission-control-rail-timeline').getAttribute('data-active')).toBe(
        'true',
      ),
    );
    await waitFor(() => expect(api.fetchTimeline).toHaveBeenCalledWith('aoi/older'));
  });

  it('parses a state.json served as a raw JSON string', async () => {
    // readFile can hand back either a string or an already-parsed object
    // depending on the storage backend.
    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', JSON.stringify({ version: 1, activeView: 'flight' }));

    await renderApp();

    await waitFor(() =>
      expect(screen.getByTestId('mission-control-rail-flight').getAttribute('data-active')).toBe(
        'true',
      ),
    );
  });

  it('opens normally when state.json is unparseable', async () => {
    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', '{ not json');

    await renderApp();

    // Falls back to the default view rather than failing to mount.
    expect(screen.getByTestId('mission-control-rail-runtime').getAttribute('data-active')).toBe(
      'true',
    );
  });

  it('defaults to the newest session when none is pinned', async () => {
    await renderApp();

    await waitFor(() => expect(api.fetchStatus).toHaveBeenCalledWith('aoi/newest'));
  });

  it('shows the no-session notice and skips session-scoped reads when there are none', async () => {
    apiMocks.sessions.value = { kind: 'empty', reason: 'none', fetchedAt: 1 };

    await renderApp();

    await waitFor(() => expect(screen.getByTestId('mission-control-no-sessions')).toBeTruthy());
    expect(api.fetchStatus).not.toHaveBeenCalled();
  });
});

describe('MissionControl agent action surface', () => {
  it('switches view on SELECT_MISSION_CONTROL_VIEW', async () => {
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('SELECT_MISSION_CONTROL_VIEW', { view: 'metrics' })),
    );

    expect(result).toBe('success');
    await waitFor(() =>
      expect(screen.getByTestId('mission-control-rail-metrics').getAttribute('data-active')).toBe(
        'true',
      ),
    );
  });

  it('rejects an unknown view instead of silently doing nothing', async () => {
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('SELECT_MISSION_CONTROL_VIEW', { view: 'settings' })),
    );

    expect(result).toContain('error: unknown view');
  });

  it('switches the observed session on SELECT_MISSION_CONTROL_SESSION', async () => {
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('SELECT_MISSION_CONTROL_SESSION', { sessionPath: 'aoi/older' })),
    );

    expect(result).toBe('success');
    await waitFor(() => expect(api.fetchStatus).toHaveBeenCalledWith('aoi/older'));
  });

  it('refuses a session that is not in the discovered list', async () => {
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('SELECT_MISSION_CONTROL_SESSION', { sessionPath: 'aoi/ghost' })),
    );

    expect(result).toContain('error: session not found');
  });

  it('requires a sessionPath', async () => {
    await renderApp();

    const result = await act(async () => latestHandler()(action('SELECT_MISSION_CONTROL_SESSION')));

    expect(result).toBe('error: sessionPath is required');
  });

  it('re-reads the current section on REFRESH_MISSION_CONTROL', async () => {
    await renderApp();
    await waitFor(() => expect(api.fetchSnapshot).toHaveBeenCalled());
    vi.mocked(api.fetchSnapshot).mockClear();

    const result = await act(async () => latestHandler()(action('REFRESH_MISSION_CONTROL')));

    expect(result).toBe('success');
    await waitFor(() => expect(api.fetchSnapshot).toHaveBeenCalled());
  });

  it('switches to the requested section when REFRESH carries a view', async () => {
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('REFRESH_MISSION_CONTROL', { view: 'queue' })),
    );

    expect(result).toBe('success');
    await waitFor(() => expect(api.fetchProposals).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('mission-control-rail-queue').getAttribute('data-active')).toBe(
        'true',
      ),
    );
  });

  it('ignores an unknown REFRESH view rather than erroring the whole refresh', async () => {
    await renderApp();

    const result = await act(async () =>
      latestHandler()(action('REFRESH_MISSION_CONTROL', { view: 'nonsense' })),
    );

    expect(result).toBe('success');
    expect(screen.getByTestId('mission-control-rail-runtime').getAttribute('data-active')).toBe(
      'true',
    );
  });

  it('re-applies state.json on SYNC_STATE', async () => {
    await renderApp();
    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', { version: 1, activeView: 'flight' });

    const result = await act(async () => latestHandler()(action('SYNC_STATE')));

    expect(result).toBe('success');
    await waitFor(() =>
      expect(screen.getByTestId('mission-control-rail-flight').getAttribute('data-active')).toBe(
        'true',
      ),
    );
  });

  it('rejects an unknown action type', async () => {
    await renderApp();

    const result = await act(async () => latestHandler()(action('APPROVE_PROPOSAL')));

    // The agent surface is read/navigation only; an approval attempt is simply
    // not a thing this app can be asked to do.
    expect(result).toContain('error: unknown action_type');
    expect(api.decideProposal).not.toHaveBeenCalled();
  });
});

describe('MissionControl operator controls', () => {
  it('runs a manual tick from the runtime section', async () => {
    await renderApp();

    fireEvent.click(screen.getByTestId('mission-control-manual-tick'));

    await waitFor(() => expect(api.runManualTick).toHaveBeenCalledWith('aoi/newest'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('ticked'));
  });

  it('surfaces a failed tick as an error toast', async () => {
    vi.mocked(api.runManualTick).mockResolvedValueOnce({
      ok: false,
      message: '틱이 건너뛰어졌습니다 (tick_already_running).',
    });

    await renderApp();
    fireEvent.click(screen.getByTestId('mission-control-manual-tick'));

    await waitFor(() => expect(screen.getByRole('status').getAttribute('data-tone')).toBe('error'));
  });

  it('only polls the panels of the active section', async () => {
    await renderApp();
    await waitFor(() => expect(api.fetchSnapshot).toHaveBeenCalled());

    // Runtime is active on open, so the queue/timeline/flight/metrics readers
    // must not have run at all.
    expect(api.fetchProposals).not.toHaveBeenCalled();
    expect(api.fetchTimeline).not.toHaveBeenCalled();
    expect(api.fetchFlight).not.toHaveBeenCalled();
    expect(api.fetchMetrics).not.toHaveBeenCalled();
    // The strip panels are read regardless of section.
    expect(api.fetchRuntime).toHaveBeenCalled();
    expect(api.fetchStatus).toHaveBeenCalled();
  });

  it('reads a section the first time it is opened', async () => {
    await renderApp();

    fireEvent.click(screen.getByTestId('mission-control-rail-metrics'));

    await waitFor(() => expect(api.fetchMetrics).toHaveBeenCalledWith('aoi/newest'));
  });

  it('lets the operator decide a proposal and re-reads the queue afterwards', async () => {
    const proposal = {
      version: 1,
      id: 'proposal-x',
      sessionPath: 'aoi/newest',
      status: 'active',
      title: 'Re-read the kernel report',
      body: 'body',
      reason: 'reason',
      trigger: 'research_followup',
      createdAt: 1,
      updatedAt: 1,
      cooldownKey: 'k',
      confidence: 0.8,
      risk: 'low',
      requiredAutonomyLevel: 'L2',
      requiresUserApproval: false,
      suggestedTools: [],
      evidenceRefs: [],
      memoryIds: [],
      artifactRefs: [],
      riskSignals: [],
    };
    vi.mocked(api.fetchProposals).mockResolvedValue({
      kind: 'ready',
      data: [proposal],
      fetchedAt: 1,
    } as never);

    await renderApp();
    fireEvent.click(screen.getByTestId('mission-control-rail-queue'));

    await waitFor(() => expect(screen.getByTestId('mission-control-proposal-list')).toBeTruthy());
    fireEvent.click(screen.getByText('Re-read the kernel report'));

    await waitFor(() =>
      expect(screen.getByTestId('mission-control-proposal-inspector')).toBeTruthy(),
    );
    vi.mocked(api.fetchProposals).mockClear();
    fireEvent.click(screen.getByTestId('mission-control-proposal-accept'));

    await waitFor(() =>
      expect(api.decideProposal).toHaveBeenCalledWith('aoi/newest', 'proposal-x', 'accept'),
    );
    // The store may archive or activate a goal as a side effect, so the queue is
    // re-read rather than patched locally.
    await waitFor(() => expect(api.fetchProposals).toHaveBeenCalled());
  });

  it('reports a rejected decision without clearing the selection', async () => {
    vi.mocked(api.decideProposal).mockResolvedValueOnce({
      ok: false,
      message: 'blocked transition',
    });
    vi.mocked(api.fetchProposals).mockResolvedValue({
      kind: 'ready',
      data: [
        {
          version: 1,
          id: 'proposal-y',
          sessionPath: 'aoi/newest',
          status: 'active',
          title: 'Blocked proposal',
          body: 'body',
          reason: 'reason',
          trigger: 't',
          createdAt: 1,
          updatedAt: 1,
          cooldownKey: 'k',
          confidence: 0.5,
          risk: 'high',
          requiredAutonomyLevel: 'L5',
          requiresUserApproval: true,
          suggestedTools: [],
          evidenceRefs: [],
          memoryIds: [],
          artifactRefs: [],
          riskSignals: [],
        },
      ],
      fetchedAt: 1,
    } as never);

    await renderApp();
    fireEvent.click(screen.getByTestId('mission-control-rail-queue'));
    await waitFor(() => expect(screen.getByTestId('mission-control-proposal-list')).toBeTruthy());
    fireEvent.click(screen.getByText('Blocked proposal'));
    await waitFor(() =>
      expect(screen.getByTestId('mission-control-proposal-inspector')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('mission-control-proposal-accept'));

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('blocked transition'));
    // Still open, so the operator can see what they were acting on.
    expect(screen.getByTestId('mission-control-proposal-inspector')).toBeTruthy();
  });

  it('persists a timeline filter choice', async () => {
    vi.mocked(api.fetchTimeline).mockResolvedValue({
      kind: 'ready',
      data: {
        events: [
          {
            version: 1,
            id: 'e1',
            sessionPath: 'aoi/newest',
            kind: 'proposal_failed',
            visibility: 'operator',
            createdAt: 1,
            title: 'failed',
            summary: 'Execution failed',
            redactionState: 'clean',
            evidenceRefs: [],
            relatedRefs: [],
          },
        ],
      },
      fetchedAt: 1,
    } as never);

    await renderApp();
    fireEvent.click(screen.getByTestId('mission-control-rail-timeline'));

    await waitFor(() => expect(screen.getByLabelText('이벤트 종류 필터')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('이벤트 종류 필터'), {
      target: { value: 'proposal_failed' },
    });

    await waitFor(() =>
      expect(fileStore.get('/state.json')).toMatchObject({
        timelineKindFilter: 'proposal_failed',
      }),
    );
  });

  it('renders the flight section and the scheduler payload when present', async () => {
    vi.mocked(api.fetchScheduler).mockResolvedValue({
      kind: 'ready',
      data: { version: 1, sessionPath: 'aoi/newest', nextWakeupAt: 42 },
      fetchedAt: 1,
    } as never);

    await renderApp();
    await waitFor(() => expect(screen.getByText(/nextWakeupAt/)).toBeTruthy());

    fireEvent.click(screen.getByTestId('mission-control-rail-flight'));
    await waitFor(() => expect(api.fetchFlight).toHaveBeenCalledWith('aoi/newest'));
  });

  it('persists operator preferences back to state.json', async () => {
    await renderApp();
    await waitFor(() => expect(fileStore.get('/state.json')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '자동 갱신 일시정지' }));

    await waitFor(() => expect(fileStore.get('/state.json')).toMatchObject({ autoRefresh: false }));
  });
});
