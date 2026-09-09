import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CharacterAppAction } from '@/lib';

// Coverage for the orchestration layer of the window: the agent action surface
// and the request ordering. Neither is reachable from an e2e spec -- an agent
// action has no button to click, and a race between two clicks cannot be timed
// from the outside.

const { fileStore, listedFiles, capturedHandlers, client, saved, approvalsRun } = vi.hoisted(
  () => ({
    fileStore: new Map<string, unknown>(),
    listedFiles: { value: [] as Array<{ name: string }> },
    capturedHandlers: [] as Array<(action: CharacterAppAction) => Promise<string>>,
    client: {
      /** runId -> the report text and how long fetching it takes to resolve. */
      reports: new Map<string, { text: string; delayMs: number }>(),
      runs: [] as unknown[],
      sessions: [] as unknown[],
      entries: [] as unknown[],
      approvals: [] as unknown[],
      sessionPreview: { allowed: false, blockReasons: [] } as Record<string, unknown>,
      reportPreview: { allowed: false, blockReasons: [] } as Record<string, unknown>,
      queryView: { rows: [], rowCount: 0, truncated: false, mcpTool: 'x' } as Record<
        string,
        unknown
      >,
    },
    saved: { value: null as unknown },
    approvalsRun: { value: [] as string[] },
  }),
);

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

vi.mock('@/lib/aoiGhidraTools', () => ({ touchGhidraTools: vi.fn() }));

const HEALTH = {
  checks: [],
  availableModes: ['headless'],
  ghidraVersion: '12.1.3',
  jdkVersion: 'openjdk version "21.0.4"',
  jdkMajor: 21,
  pyghidraMcpVersion: '0.2.5',
  pyghidraLaunch: 'module',
  capaVersion: '',
  capabilityEnabled: true,
  config: {
    ghidraInstallDir: 'C:\\ghidra',
    jdkHome: 'C:\\jdk21',
    pythonExePath: 'C:\\venv\\python.exe',
    projectRoot: 'C:\\projects',
    capaExePath: '',
    binaryRoots: [{ id: 'bins', path: 'C:\\bins', label: 'Bins' }],
    maxMemMb: 8192,
    httpPortStart: 8500,
    httpPortEnd: 8599,
    sessionIdleTimeoutMs: 1800000,
    analysisTimeoutMs: 2700000,
    symbolDownloads: false,
    writeEnabled: false,
  },
};

vi.mock('@/lib/ghidraLabClient', () => ({
  fetchGhidraLabHealth: () => Promise.resolve(HEALTH),
  fetchGhidraSessions: () => Promise.resolve(client.sessions),
  fetchGhidraRuns: () => Promise.resolve(client.runs),
  fetchGhidraApprovals: () => Promise.resolve(client.approvals),
  browseGhidraPath: () =>
    Promise.resolve({ path: 'C:\\bins', rootId: 'bins', parentPath: '', entries: client.entries }),
  findGhidraBinaries: () =>
    Promise.resolve({ path: 'C:\\bins', rootId: 'bins', parentPath: '', entries: client.entries }),
  fetchGhidraReport: (runId: string) => {
    const entry = client.reports.get(runId) ?? { text: '', delayMs: 0 };
    return new Promise<string>((resolve) => {
      setTimeout(() => resolve(entry.text), entry.delayMs);
    });
  },
  saveGhidraLabConfigRemote: (patch: unknown) => {
    saved.value = patch;
    const merged = { ...HEALTH.config, ...(patch as Record<string, unknown>) };
    // The real route NORMALIZES: a root whose path is not absolute is dropped
    // and the save still succeeds, which is the case the UI has to notice.
    const roots = (merged.binaryRoots ?? []) as Array<{
      id: string;
      path: string;
      label: string;
    }>;
    merged.binaryRoots = roots.filter((root) => /^[a-zA-Z]:[\\/]|^\//.test(root.path));
    return Promise.resolve(merged);
  },
  bootstrapGhidraPython: () => Promise.resolve({ config: HEALTH.config, detail: '' }),
  previewGhidraSession: () => Promise.resolve(client.sessionPreview),
  previewGhidraReport: () => Promise.resolve(client.reportPreview),
  runGhidraApproval: (fingerprint: string) => {
    approvalsRun.value.push(fingerprint);
    return Promise.resolve({});
  },
  runGhidraQuery: () => Promise.resolve(client.queryView),
  stopGhidraSession: () => Promise.resolve(),
  cancelGhidraRun: () => Promise.resolve(),
}));

// Imported after the mocks so the component picks them up.
const { default: GhidraLab } = await import('../index');

function run(runId: string, binaryName: string): Record<string, unknown> {
  return {
    runId,
    sessionId: 'sess-1',
    binaryPath: `C:\\bins\\${binaryName}`,
    binaryName,
    state: 'done',
    stages: [],
    startedAt: 1,
    finishedAt: 2,
    anchorCount: 3,
    droppedClaims: 0,
    failureReason: '',
  };
}

async function mountAndSettle(): Promise<void> {
  render(<GhidraLab />);
  await waitFor(() => expect(screen.getByTestId('ghidra-lab')).toBeTruthy());
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  fileStore.clear();
  listedFiles.value = [];
  capturedHandlers.length = 0;
  client.reports.clear();
  client.runs = [];
  client.sessions = [];
  client.entries = [];
  client.approvals = [];
  client.sessionPreview = { allowed: false, blockReasons: [] };
  client.reportPreview = { allowed: false, blockReasons: [] };
  client.queryView = { rows: [], rowCount: 0, truncated: false, mcpTool: 'x' };
  saved.value = null;
  approvalsRun.value = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('state.json bootstrapping', () => {
  it('writes a default state when the file does not exist yet', async () => {
    await mountAndSettle();
    await waitFor(() => expect(fileStore.has('/state.json')).toBe(true));
    expect(fileStore.get('/state.json')).toMatchObject({ tab: 'setup' });
  });

  it('restores the tab the operator was last on', async () => {
    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', { tab: 'reports', lastBinaryPath: '', lastRunId: '' });
    await mountAndSettle();
    await waitFor(() =>
      expect(screen.getByTestId('ghidra-lab-tab-reports').getAttribute('data-active')).toBe('true'),
    );
  });

  it('ignores a stored tab that is not one of ours', async () => {
    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', { tab: 'evil', lastBinaryPath: 1, lastRunId: null });
    await mountAndSettle();
    await waitFor(() =>
      expect(screen.getByTestId('ghidra-lab-tab-setup').getAttribute('data-active')).toBe('true'),
    );
  });
});

describe('agent actions', () => {
  async function dispatch(action: CharacterAppAction): Promise<string> {
    const handler = capturedHandlers[capturedHandlers.length - 1];
    let answer = '';
    await act(async () => {
      answer = await handler(action);
    });
    return answer;
  }

  it('applies the state.json the agent wrote on SYNC_STATE', async () => {
    // The contract is that the agent WRITES the file and then sends the action.
    // Only refreshing the server views ignored the file it had just written, so
    // the tab and run the agent selected were silently dropped.
    await mountAndSettle();
    expect(screen.getByTestId('ghidra-lab-tab-setup').getAttribute('data-active')).toBe('true');

    listedFiles.value = [{ name: 'state.json' }];
    fileStore.set('/state.json', { tab: 'sessions', lastBinaryPath: '', lastRunId: '' });
    expect(await dispatch({ action_type: 'SYNC_STATE' } as CharacterAppAction)).toBe('success');

    await waitFor(() =>
      expect(screen.getByTestId('ghidra-lab-tab-sessions').getAttribute('data-active')).toBe(
        'true',
      ),
    );
  });

  it('switches tabs and persists the choice', async () => {
    await mountAndSettle();
    expect(
      await dispatch({
        action_type: 'SET_GHIDRA_TAB',
        params: { tab: 'binaries' },
      } as unknown as CharacterAppAction),
    ).toBe('success');
    await waitFor(() =>
      expect(screen.getByTestId('ghidra-lab-tab-binaries').getAttribute('data-active')).toBe(
        'true',
      ),
    );
    expect(fileStore.get('/state.json')).toMatchObject({ tab: 'binaries' });
  });

  it('refuses a tab, a session and a run it cannot find, rather than navigating nowhere', async () => {
    await mountAndSettle();
    expect(
      await dispatch({
        action_type: 'SET_GHIDRA_TAB',
        params: { tab: 'nope' },
      } as unknown as CharacterAppAction),
    ).toBe('error: unknown tab');
    expect(
      await dispatch({
        action_type: 'SELECT_GHIDRA_SESSION',
        params: { sessionId: 'nope' },
      } as unknown as CharacterAppAction),
    ).toBe('error: session not found');
    expect(
      await dispatch({
        action_type: 'SELECT_GHIDRA_RUN',
        params: { runId: 'nope' },
      } as unknown as CharacterAppAction),
    ).toBe('error: run not found');
  });

  it('names an action it does not implement instead of reporting success', async () => {
    await mountAndSettle();
    expect(
      await dispatch({ action_type: 'START_GHIDRA_ANALYSIS' } as unknown as CharacterAppAction),
    ).toBe('error: unsupported action START_GHIDRA_ANALYSIS');
  });

  it('opens a run that exists and shows its report', async () => {
    client.runs = [run('grun-a-1', 'client.exe')];
    client.reports.set('grun-a-1', { text: '# client.exe report', delayMs: 0 });
    await mountAndSettle();
    expect(
      await dispatch({
        action_type: 'SELECT_GHIDRA_RUN',
        params: { runId: 'grun-a-1' },
      } as unknown as CharacterAppAction),
    ).toBe('success');
    await waitFor(() => expect(screen.getByText('# client.exe report')).toBeTruthy());
  });
});

describe('request ordering', () => {
  it('never shows an older report under a newer run id', async () => {
    // The slow answer arrives LAST and used to win, putting run A's text under
    // run B's id -- the one thing a report reader has to be able to trust.
    client.runs = [run('grun-slow-1', 'slow.exe'), run('grun-fast-1', 'fast.exe')];
    client.reports.set('grun-slow-1', { text: 'SLOW REPORT', delayMs: 60 });
    client.reports.set('grun-fast-1', { text: 'FAST REPORT', delayMs: 0 });
    await mountAndSettle();

    const handler = capturedHandlers[capturedHandlers.length - 1];
    await act(async () => {
      const slow = handler({
        action_type: 'SELECT_GHIDRA_RUN',
        params: { runId: 'grun-slow-1' },
      } as unknown as CharacterAppAction);
      const fast = handler({
        action_type: 'SELECT_GHIDRA_RUN',
        params: { runId: 'grun-fast-1' },
      } as unknown as CharacterAppAction);
      await Promise.all([slow, fast]);
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(screen.queryByText('SLOW REPORT')).toBeNull();
    await waitFor(() => expect(screen.getByText('FAST REPORT')).toBeTruthy());
  });
});

describe('setup panel', () => {
  it('renders the preflight rows and the configured paths', async () => {
    await mountAndSettle();
    expect(screen.getByTestId('ghidra-lab-preflight')).toBeTruthy();
    expect((screen.getByTestId('ghidra-lab-ghidra-path') as HTMLInputElement).value).toBe(
      'C:\\ghidra',
    );
    expect((screen.getByTestId('ghidra-lab-jdk-path') as HTMLInputElement).value).toBe('C:\\jdk21');
  });

  it('saves an edited path through the config route', async () => {
    await mountAndSettle();
    const input = screen.getByTestId('ghidra-lab-project-path') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'C:\\projects2' } });
      fireEvent.click(screen.getByTestId('ghidra-lab-save-paths'));
    });
    await waitFor(() => expect(saved.value).toMatchObject({ projectRoot: 'C:\\projects2' }));
  });

  it('refuses a root with no id or no path, without calling the server', async () => {
    await mountAndSettle();
    saved.value = null;
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-add-root'));
    });
    expect(saved.value).toBeNull();
    expect(screen.getByTestId('ghidra-lab-note').textContent ?? '').toContain('absolute path');
  });

  it('says so when the server silently drops the root it was given', async () => {
    // The save succeeds and the root is simply not in the answer, so reporting
    // success would tell the operator a folder is registered when it is not.
    await mountAndSettle();
    await act(async () => {
      fireEvent.change(screen.getByTestId('ghidra-lab-root-id'), { target: { value: 'games' } });
      fireEvent.change(screen.getByTestId('ghidra-lab-root-path'), {
        target: { value: 'relative/path' },
      });
      fireEvent.click(screen.getByTestId('ghidra-lab-add-root'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('ghidra-lab-note').textContent ?? '').toContain('rejected'),
    );
  });
});

describe('binaries panel', () => {
  it('lists what the browse route returned and selects an analyzable file', async () => {
    client.entries = [
      { name: 'sub', path: 'C:\\bins\\sub', kind: 'directory', sizeBytes: 0, analyzable: false },
      {
        name: 'client.exe',
        path: 'C:\\bins\\client.exe',
        kind: 'file',
        sizeBytes: 4096,
        analyzable: true,
      },
    ];
    await mountAndSettle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-tab-binaries'));
    });
    await waitFor(() => expect(screen.getByTestId('ghidra-entry-client.exe')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-entry-client.exe'));
    });
    expect(screen.getByTestId('ghidra-lab-start')).toBeTruthy();
  });

  it('explains a blocked analysis rather than starting nothing quietly', async () => {
    client.entries = [
      {
        name: 'client.exe',
        path: 'C:\\bins\\client.exe',
        kind: 'file',
        sizeBytes: 4096,
        analyzable: true,
      },
    ];
    client.sessionPreview = { allowed: false, blockReasons: ['preflight_jdk'] };
    await mountAndSettle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-tab-binaries'));
    });
    await waitFor(() => expect(screen.getByTestId('ghidra-entry-client.exe')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-entry-client.exe'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-start'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('ghidra-lab-note').textContent ?? '').toContain('JDK'),
    );
  });

  it('offers an approval to click when the preview is allowed, and starts nothing before it', async () => {
    client.entries = [
      {
        name: 'client.exe',
        path: 'C:\\bins\\client.exe',
        kind: 'file',
        sizeBytes: 4096,
        analyzable: true,
      },
    ];
    client.sessionPreview = {
      allowed: true,
      blockReasons: [],
      approvalFingerprint: 'f'.repeat(64),
      targetSummary: 'Ghidra headless: C:\\bins\\client.exe',
    };
    await mountAndSettle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-tab-binaries'));
    });
    await waitFor(() => expect(screen.getByTestId('ghidra-entry-client.exe')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-entry-client.exe'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-start'));
    });
    await waitFor(() => expect(screen.getByTestId('ghidra-lab-approval')).toBeTruthy());
    expect(approvalsRun.value).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-approve'));
    });
    await waitFor(() => expect(approvalsRun.value).toEqual(['f'.repeat(64)]));
  });

  it('does not resurrect an approval the operator dismissed', async () => {
    client.approvals = [
      {
        approvalFingerprint: 'a'.repeat(64),
        capability: 'os_ghidra_analysis',
        targetSummary: 'Full sweep + report: client.exe',
        state: 'pending',
        expiresAt: 0,
      },
    ];
    await mountAndSettle();
    await waitFor(() => expect(screen.getByTestId('ghidra-lab-approval')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-dismiss'));
    });
    expect(screen.queryByTestId('ghidra-lab-approval')).toBeNull();

    const handler = capturedHandlers[capturedHandlers.length - 1];
    await act(async () => {
      await handler({ action_type: 'REFRESH_GHIDRA_LAB' } as CharacterAppAction);
    });
    expect(screen.queryByTestId('ghidra-lab-approval')).toBeNull();
  });
});

describe('sessions panel', () => {
  it('shows a ready session and runs a query against it', async () => {
    client.sessions = [
      {
        id: 'sess-1',
        binaryPath: 'C:\\bins\\client.exe',
        binaryName: 'client.exe',
        projectName: 'client-abc',
        state: 'ready',
        port: 8500,
        pid: 4242,
        startedAt: 1,
        readyAt: 2,
        lastUsedAt: 2,
        queryCount: 0,
        failureReason: '',
        progress: null,
      },
    ];
    client.queryView = {
      rows: [{ name: 'NtLoadDriver' }],
      rowCount: 1,
      truncated: false,
      mcpTool: 'list_imports',
      kind: 'imports',
    };
    await mountAndSettle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-tab-sessions'));
    });
    await waitFor(() => expect(screen.getByTestId('ghidra-session-sess-1')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-session-sess-1'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('ghidra-lab-query-arg'), {
        target: { value: 'NtLoad' },
      });
      fireEvent.click(screen.getByTestId('ghidra-lab-query-run'));
    });
    await waitFor(() => expect(screen.getByText(/NtLoadDriver/)).toBeTruthy());
    expect(screen.getByTestId('ghidra-lab-note').textContent ?? '').toContain('list_imports');
  });
});

describe('reports panel', () => {
  it('lists runs and opens one by click', async () => {
    client.runs = [run('grun-a-1', 'client.exe')];
    client.reports.set('grun-a-1', { text: '# client.exe report', delayMs: 0 });
    await mountAndSettle();
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-lab-tab-reports'));
    });
    await waitFor(() => expect(screen.getByTestId('ghidra-run-grun-a-1')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ghidra-run-grun-a-1'));
    });
    await waitFor(() => expect(screen.getByText('# client.exe report')).toBeTruthy());
    expect(fileStore.get('/state.json')).toMatchObject({ lastRunId: 'grun-a-1' });
  });
});
