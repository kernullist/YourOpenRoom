import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import {
  Binary,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';
import {
  createAppFileApi,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import {
  bootstrapGhidraFloss,
  bootstrapGhidraPython,
  browseGhidraPath,
  cancelGhidraRun,
  fetchGhidraApprovals,
  fetchGhidraLabHealth,
  fetchGhidraReport,
  fetchGhidraRuns,
  fetchGhidraSessions,
  findGhidraBinaries,
  previewGhidraReport,
  previewGhidraSession,
  runGhidraApproval,
  runGhidraQuery,
  saveGhidraLabConfigRemote,
  stopGhidraSession,
} from '@/lib/ghidraLabClient';
import { touchGhidraTools } from '@/lib/aoiGhidraTools';
import { GHIDRA_QUERY_SPECS } from '@/lib/ghidraLabQuery';
import type {
  GhidraBinaryRoot,
  GhidraLabBrowseEntry,
  GhidraLabConfigView,
  GhidraLabHealthView,
  GhidraLabSessionView,
  GhidraReportRunView,
} from '@/lib/ghidraLabTypes';
import { APP_ID, APP_NAME, APP_STORAGE_NAME } from './actions/constants';
import {
  buildBreadcrumbs,
  createLatestOnlyGate,
  describeHealth,
  describeProgress,
  explainLabError,
  formatBytes,
  isRunActive,
  preflightTone,
  runStateLabel,
  sessionStateLabel,
  sortBrowseEntries,
  summarizeRunStages,
} from './labView';
import styles from './index.module.scss';

type TabKey = 'setup' | 'binaries' | 'sessions' | 'reports';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'binaries', label: 'Binaries' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'reports', label: 'Reports' },
];

interface PendingApproval {
  fingerprint: string;
  summary: string;
  kind: 'session' | 'report';
}

interface AppState {
  tab: TabKey;
  lastBinaryPath: string;
  lastRunId: string;
}

const DEFAULT_STATE: AppState = { tab: 'setup', lastBinaryPath: '', lastRunId: '' };

// Something is moving (a JVM booting, a sweep walking stages), so re-read.
const ACTIVE_POLL_MS = 3000;
// Aoi can record an approval at any time, so this poll does not depend on
// anything already running here.
const APPROVAL_POLL_MS = 8000;

function GhidraLab(): JSX.Element {
  const fileApi = useMemo(() => createAppFileApi(APP_STORAGE_NAME), []);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>('setup');
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const [health, setHealth] = useState<GhidraLabHealthView | null>(null);
  const [configDraft, setConfigDraft] = useState<GhidraLabConfigView | null>(null);
  const [rootDraft, setRootDraft] = useState({ id: '', path: '' });

  const [browsePath, setBrowsePath] = useState('');
  const [browseEntries, setBrowseEntries] = useState<GhidraLabBrowseEntry[]>([]);
  const [findQuery, setFindQuery] = useState('');
  const [selectedBinary, setSelectedBinary] = useState('');

  const [sessions, setSessions] = useState<GhidraLabSessionView[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [queryKind, setQueryKind] = useState('imports');
  const [queryArg, setQueryArg] = useState('');
  const [queryRows, setQueryRows] = useState<unknown[] | null>(null);

  const [runs, setRuns] = useState<GhidraReportRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [reportText, setReportText] = useState('');

  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const stateRef = useRef<AppState>(DEFAULT_STATE);
  // One gate per pane: a second click must be able to win even while the first
  // request is still in flight.
  const reportGate = useRef(createLatestOnlyGate());
  const browseGate = useRef(createLatestOnlyGate());
  const queryGate = useRef(createLatestOnlyGate());
  // Approvals the operator dismissed here. Without this, an approval Aoi
  // recorded would reappear on the next poll immediately after being waved away.
  const dismissedRef = useRef<Set<string>>(new Set());

  const status = useMemo(() => describeHealth(health), [health]);
  const config = configDraft ?? health?.config ?? null;
  const roots = useMemo(() => health?.config.binaryRoots ?? [], [health]);
  const breadcrumbs = useMemo(() => buildBreadcrumbs(browsePath, roots), [browsePath, roots]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const showError = useCallback((error: unknown) => {
    setNote({ tone: 'error', text: explainLabError(error) });
  }, []);

  const persistState = useCallback(
    async (patch: Partial<AppState>) => {
      const next = { ...stateRef.current, ...patch };
      stateRef.current = next;
      try {
        await fileApi.writeFile('/state.json', next);
      } catch {
        // State is a convenience; a failed write must not break the window.
      }
    },
    [fileApi],
  );

  const refreshHealth = useCallback(async () => {
    const next = await fetchGhidraLabHealth();
    setHealth(next);
    setConfigDraft((current) => current ?? next.config);
    return next;
  }, []);

  const refreshSessions = useCallback(async () => {
    const next = await fetchGhidraSessions();
    setSessions(next);
    return next;
  }, []);

  const refreshRuns = useCallback(async () => {
    const next = await fetchGhidraRuns();
    setRuns(next);
    return next;
  }, []);

  /**
   * Pick up approvals the window did not itself request.
   *
   * When Aoi proposes an analysis from chat, the pending approval is recorded
   * server-side and this window has no other way to learn about it. Without this
   * the operator would be told "an approval is pending" with nowhere to click.
   * A local preview still wins: it is the more specific thing the operator just
   * asked for.
   */
  const refreshApprovals = useCallback(async () => {
    const approvals = await fetchGhidraApprovals();
    setPending((current) => {
      if (current) {
        return current;
      }
      const next = approvals.find((entry) => !dismissedRef.current.has(entry.approvalFingerprint));
      if (!next) {
        return null;
      }
      return {
        fingerprint: next.approvalFingerprint,
        summary: next.targetSummary,
        kind: next.targetSummary.toLowerCase().startsWith('full sweep') ? 'report' : 'session',
      };
    });
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([refreshHealth(), refreshSessions(), refreshRuns(), refreshApprovals()]);
    } catch (error) {
      showError(error);
    }
  }, [refreshApprovals, refreshHealth, refreshRuns, refreshSessions, showError]);

  const loadBrowse = useCallback(
    async (path?: string) => {
      const ticket = browseGate.current.begin();
      try {
        const view = await browseGhidraPath(path);
        if (browseGate.current.isStale(ticket)) {
          return;
        }
        setBrowsePath(view.path);
        setBrowseEntries(sortBrowseEntries(view.entries));
      } catch (error) {
        if (!browseGate.current.isStale(ticket)) {
          showError(error);
        }
      }
    },
    [showError],
  );

  const loadState = useCallback(async () => {
    try {
      // state.json may not exist yet: check the listing before reading, per the
      // data-interaction rule, so a fresh install does not read a missing file.
      const rootFiles = await fileApi.listFiles('/');
      const exists = Array.isArray(rootFiles)
        ? rootFiles.some((file) => file.name === 'state.json')
        : false;
      if (exists) {
        const result = await fileApi.readFile('/state.json');
        const raw =
          typeof result.content === 'string'
            ? (JSON.parse(result.content) as Partial<AppState>)
            : ((result.content ?? {}) as Partial<AppState>);
        const next: AppState = {
          tab: TABS.some((entry) => entry.key === raw.tab) ? (raw.tab as TabKey) : 'setup',
          lastBinaryPath: typeof raw.lastBinaryPath === 'string' ? raw.lastBinaryPath : '',
          lastRunId: typeof raw.lastRunId === 'string' ? raw.lastRunId : '',
        };
        stateRef.current = next;
        setTab(next.tab);
        setSelectedBinary(next.lastBinaryPath);
        setSelectedRunId(next.lastRunId);
      } else {
        await fileApi.writeFile('/state.json', DEFAULT_STATE);
      }
    } catch {
      // Fall through to defaults.
    }
    await refreshAll();
    await loadBrowse();
    setHydrated(true);
  }, [fileApi, loadBrowse, refreshAll]);

  // --- Polling --------------------------------------------------------------

  const hasActiveWork = useMemo(
    () =>
      sessions.some((session) => session.state === 'starting') ||
      runs.some((run) => isRunActive(run)),
    [runs, sessions],
  );

  useEffect(() => {
    if (!hasActiveWork) {
      return;
    }
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refreshSessions().catch(() => undefined);
      void refreshRuns().catch(() => undefined);
    }, ACTIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveWork, refreshRuns, refreshSessions]);

  // Approvals are polled whether or not anything is running: Aoi can propose an
  // analysis at any moment, and the click has to be reachable when it does.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshApprovals().catch(() => undefined);
    }, APPROVAL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hydrated, refreshApprovals]);

  // --- Config ---------------------------------------------------------------

  const saveConfig = useCallback(
    async (patch: Partial<GhidraLabConfigView>) => {
      setBusy(true);
      try {
        const saved = await saveGhidraLabConfigRemote(patch);
        setConfigDraft(saved);
        await refreshHealth();
        setNote({ tone: 'ok', text: 'Saved.' });
        return saved;
      } catch (error) {
        showError(error);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refreshHealth, showError],
  );

  const addRoot = useCallback(async () => {
    const id = rootDraft.id.trim().toLowerCase();
    const path = rootDraft.path.trim();
    if (!id || !path) {
      setNote({ tone: 'error', text: 'A root needs an id and an absolute path.' });
      return;
    }
    const nextRoots: GhidraBinaryRoot[] = [
      ...(config?.binaryRoots ?? []).filter((root) => root.id !== id),
      { id, path, label: path },
    ];
    const saved = await saveConfig({ binaryRoots: nextRoots });
    // The server DROPS a root it cannot normalize (bad id characters, a relative
    // path), and the save still succeeds -- so check the root actually landed
    // rather than reporting success for a silent no-op.
    if (saved && !saved.binaryRoots.some((root) => root.id === id)) {
      setNote({
        tone: 'error',
        text: `Root "${id}" was rejected. Use an absolute path and a simple id.`,
      });
      return;
    }
    setRootDraft({ id: '', path: '' });
    await loadBrowse();
  }, [config, loadBrowse, rootDraft, saveConfig]);

  const removeRoot = useCallback(
    async (rootId: string) => {
      await saveConfig({
        binaryRoots: (config?.binaryRoots ?? []).filter((root) => root.id !== rootId),
      });
      await loadBrowse();
    },
    [config, loadBrowse, saveConfig],
  );

  const bootstrapFloss = useCallback(async () => {
    setBusy(true);
    setNote({ tone: 'warn', text: 'Downloading FLOSS from its official release...' });
    try {
      const result = await bootstrapGhidraFloss();
      setConfigDraft(result.config);
      await refreshHealth();
      setNote({ tone: 'ok', text: result.detail || 'FLOSS installed.' });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [refreshHealth, showError]);

  const bootstrapPython = useCallback(async () => {
    setBusy(true);
    setNote({
      tone: 'warn',
      text: 'Creating the virtual environment and installing pyghidra-mcp...',
    });
    try {
      const result = await bootstrapGhidraPython();
      setConfigDraft(result.config);
      await refreshHealth();
      setNote({ tone: 'ok', text: result.detail || 'pyghidra-mcp installed.' });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [refreshHealth, showError]);

  // --- Approvals ------------------------------------------------------------

  const startAnalysis = useCallback(async () => {
    if (!selectedBinary) {
      return;
    }
    setBusy(true);
    try {
      const preview = await previewGhidraSession(selectedBinary);
      if (!preview.allowed) {
        setNote({
          tone: 'error',
          text: `Cannot start: ${preview.blockReasons.map((reason) => explainLabError(reason)).join(' ')}`,
        });
        return;
      }
      setPending({
        fingerprint: preview.approvalFingerprint,
        summary: preview.targetSummary,
        kind: 'session',
      });
      setNote(null);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [selectedBinary, showError]);

  const startSweep = useCallback(async () => {
    if (!selectedSessionId) {
      return;
    }
    setBusy(true);
    try {
      const preview = await previewGhidraReport(selectedSessionId);
      if (!preview.allowed) {
        setNote({
          tone: 'error',
          text: `Cannot sweep: ${preview.blockReasons.join(', ')}`,
        });
        return;
      }
      setPending({
        fingerprint: preview.approvalFingerprint,
        summary: preview.targetSummary,
        kind: 'report',
      });
      setNote(null);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [selectedSessionId, showError]);

  const runApproval = useCallback(async () => {
    if (!pending) {
      return;
    }
    setBusy(true);
    try {
      const result = await runGhidraApproval(pending.fingerprint);
      touchGhidraTools();
      setPending(null);
      if (result.session) {
        setSelectedSessionId(result.session.id);
        setTab('sessions');
        setNote({
          tone: 'ok',
          text: 'Session starting. Ghidra analysis can take several minutes.',
        });
      }
      if (result.runId) {
        setSelectedRunId(result.runId);
        setTab('reports');
        void persistState({ lastRunId: result.runId });
        setNote({ tone: 'ok', text: 'Sweep started. This runs in the background.' });
      }
      await refreshAll();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [pending, persistState, refreshAll, showError]);

  // --- Sessions -------------------------------------------------------------

  const stopSession = useCallback(
    async (sessionId: string) => {
      setBusy(true);
      try {
        await stopGhidraSession(sessionId);
        await refreshSessions();
        setNote({ tone: 'ok', text: 'Session stopped. The Ghidra project is kept for next time.' });
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    },
    [refreshSessions, showError],
  );

  const runQuery = useCallback(async () => {
    if (!selectedSessionId) {
      return;
    }
    setBusy(true);
    setQueryRows(null);
    const ticket = queryGate.current.begin();
    try {
      const spec = GHIDRA_QUERY_SPECS.find((entry) => entry.kind === queryKind);
      const args: Record<string, unknown> = {};
      if (queryArg.trim() && spec) {
        // One free-text box, routed to whichever argument this sub-command takes.
        args[spec.requiredArgs[0] ?? (spec.allowedArgs.includes('name') ? 'name' : 'query')] =
          queryArg.trim();
      }
      const view = await runGhidraQuery({ sessionId: selectedSessionId, kind: queryKind, args });
      if (queryGate.current.isStale(ticket)) {
        return;
      }
      setQueryRows(view.rows);
      touchGhidraTools();
      setNote({
        tone: 'ok',
        text: `${view.mcpTool}: ${view.rowCount} row${view.rowCount === 1 ? '' : 's'}${view.truncated ? ' (truncated)' : ''}.`,
      });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [queryArg, queryKind, selectedSessionId, showError]);

  // --- Reports --------------------------------------------------------------

  const openReport = useCallback(
    async (runId: string) => {
      setSelectedRunId(runId);
      void persistState({ lastRunId: runId });
      setReportText('');
      // Two clicks race, and the slower answer wins by landing last. Showing run
      // A's text under run B's id is the exact failure this whole stack exists
      // to prevent, so an answer that is no longer the current one is dropped.
      const ticket = reportGate.current.begin();
      try {
        const text = await fetchGhidraReport(runId);
        if (reportGate.current.isStale(ticket)) {
          return;
        }
        setReportText(text);
      } catch (error) {
        if (!reportGate.current.isStale(ticket)) {
          showError(error);
        }
      }
    },
    [persistState, showError],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        await cancelGhidraRun(runId);
        await refreshRuns();
        setNote({
          tone: 'warn',
          text: 'Cancelling after the current stage. Findings so far are kept.',
        });
      } catch (error) {
        showError(error);
      }
    },
    [refreshRuns, showError],
  );

  // --- Agent actions (read and navigate only) -------------------------------

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'SET_GHIDRA_TAB': {
          const requested = String(action.params?.tab ?? '');
          if (!TABS.some((entry) => entry.key === requested)) {
            return 'error: unknown tab';
          }
          setTab(requested as TabKey);
          void persistState({ tab: requested as TabKey });
          return 'success';
        }
        case 'SELECT_GHIDRA_SESSION': {
          const sessionId = String(action.params?.sessionId ?? '');
          const list = await refreshSessions();
          if (!list.some((session) => session.id === sessionId)) {
            return 'error: session not found';
          }
          setSelectedSessionId(sessionId);
          setTab('sessions');
          return 'success';
        }
        case 'SELECT_GHIDRA_RUN': {
          const runId = String(action.params?.runId ?? '');
          const list = await refreshRuns();
          if (!list.some((run) => run.runId === runId)) {
            return 'error: run not found';
          }
          await openReport(runId);
          setTab('reports');
          return 'success';
        }
        case 'BROWSE_GHIDRA_BINARIES': {
          await loadBrowse(String(action.params?.path ?? '') || undefined);
          setTab('binaries');
          return 'success';
        }
        case 'REFRESH_GHIDRA_LAB': {
          await refreshAll();
          return 'success';
        }
        case 'SYNC_STATE': {
          // The contract (data-interaction.md 2.4, and this app's own meta.yaml)
          // is that the agent WRITES state.json and then sends SYNC_STATE. Only
          // refreshing the server views ignored the file the agent had just
          // written, so the tab and run it selected were silently dropped.
          await loadState();
          return 'success';
        }
        default:
          return `error: unsupported action ${action.action_type}`;
      }
    },
    [loadBrowse, loadState, openReport, persistState, refreshAll, refreshRuns, refreshSessions],
  );

  useAgentActionListener(APP_ID, handleAgentAction);

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: APP_NAME,
          windowStyle: { width: 1320, height: 880 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await loadState();
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };
    void init();
    // Mount-only: the lifecycle contract reports once per app load.
  }, []);

  // --- Render ---------------------------------------------------------------

  return (
    <div
      className={styles.root}
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="ghidra-lab"
    >
      <header className={styles.header}>
        <h1 className={styles.title}>
          <Binary size={16} />
          Ghidra Lab
        </h1>
        <span className={styles.statusPill} data-tone={status.tone} data-testid="ghidra-lab-status">
          {status.label}
        </span>
        <span className={styles.statusDetail}>{status.detail}</span>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => void refreshAll()}
          disabled={busy}
          data-testid="ghidra-lab-refresh"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </header>

      <nav className={styles.tabs}>
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={styles.tab}
            data-active={tab === entry.key ? 'true' : 'false'}
            data-testid={`ghidra-lab-tab-${entry.key}`}
            onClick={() => {
              setTab(entry.key);
              void persistState({ tab: entry.key });
            }}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        {note ? (
          <div className={styles.note} data-tone={note.tone} data-testid="ghidra-lab-note">
            {note.text}
          </div>
        ) : null}

        {pending ? (
          <div className={styles.approval} data-testid="ghidra-lab-approval">
            <strong>Approval required</strong>
            <div className={styles.approvalTarget}>{pending.summary}</div>
            <div className={styles.hint}>
              Nothing has started. Approving spawns a real process on this PC
              {pending.kind === 'report' ? ' and can run for many minutes.' : '.'}
            </div>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void runApproval()}
                disabled={busy}
                data-testid="ghidra-lab-approve"
              >
                <ShieldCheck size={12} /> Approve &amp; Run
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => {
                  dismissedRef.current.add(pending.fingerprint);
                  setPending(null);
                }}
                disabled={busy}
                data-testid="ghidra-lab-dismiss"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'setup' ? (
          <>
            <section className={styles.panel} data-testid="ghidra-lab-preflight">
              <h2 className={styles.panelTitle}>Preflight</h2>
              <div className={styles.hint}>
                Checked before anything is spawned. Ghidra asks for a Java home on stdin when it
                cannot find one, and a background process has no way to answer -- so a wrong JDK
                would hang instead of failing.
              </div>
              {(health?.checks ?? []).map((check) => (
                <div
                  key={check.id}
                  className={styles.checkRow}
                  data-testid={`ghidra-check-${check.id}`}
                >
                  <div className={styles.checkLabel}>{check.label}</div>
                  <div className={styles.checkValue}>
                    <span className={styles.checkFound} data-tone={preflightTone(check)}>
                      {check.found}
                    </span>
                    {check.remedy ? (
                      <span className={styles.checkRemedy}>{check.remedy}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>Paths</h2>
              <label className={styles.field}>
                <span>Ghidra install folder</span>
                <input
                  className={styles.input}
                  value={config?.ghidraInstallDir ?? ''}
                  placeholder="C:\ghidra_12.1.3_PUBLIC"
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, ghidraInstallDir: event.target.value } : current,
                    )
                  }
                  data-testid="ghidra-lab-ghidra-path"
                />
              </label>
              <label className={styles.field}>
                <span>JDK 21+ home</span>
                <input
                  className={styles.input}
                  value={config?.jdkHome ?? ''}
                  placeholder="C:\Program Files\Amazon Corretto\jdk21.0.4_7"
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, jdkHome: event.target.value } : current,
                    )
                  }
                  data-testid="ghidra-lab-jdk-path"
                />
              </label>
              <div className={styles.hint}>
                Injected into the Ghidra process only. Your system JAVA_HOME is left alone, so other
                toolchains keep whatever JDK they expect.
              </div>
              <label className={styles.field}>
                <span>Python interpreter (headless MCP mode)</span>
                <input
                  className={styles.input}
                  value={config?.pythonExePath ?? ''}
                  placeholder="C:\Python\Python311\python.exe"
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, pythonExePath: event.target.value } : current,
                    )
                  }
                  data-testid="ghidra-lab-python-path"
                />
              </label>
              <label className={styles.field}>
                <span>Ghidra project folder</span>
                <input
                  className={styles.input}
                  value={config?.projectRoot ?? ''}
                  placeholder="C:\Users\you\GhidraProjects"
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, projectRoot: event.target.value } : current,
                    )
                  }
                  data-testid="ghidra-lab-project-path"
                />
              </label>
              <div className={styles.hint}>
                No element of this path may start with a dot. Ghidra refuses those, and it only says
                so once the JVM is already up.
              </div>
              <label className={styles.field}>
                <span>capa executable (optional)</span>
                <input
                  className={styles.input}
                  value={config?.capaExePath ?? ''}
                  placeholder="C:\tools\capa.exe"
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, capaExePath: event.target.value } : current,
                    )
                  }
                  data-testid="ghidra-lab-capa-path"
                />
              </label>
              <label className={styles.field}>
                <span>FLOSS executable (optional)</span>
                <input
                  className={styles.input}
                  value={config?.flossExePath ?? ''}
                  placeholder="C:\tools\floss.exe"
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, flossExePath: event.target.value } : current,
                    )
                  }
                  data-testid="ghidra-lab-floss-path"
                />
              </label>
              <div className={styles.hint}>
                Recovers stack strings, tight strings and strings a routine decodes at run time --
                the ones a string dump cannot see. On an obfuscated binary these are usually the
                only interesting strings there are.
              </div>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={config?.symbolDownloads ?? false}
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, symbolDownloads: event.target.checked } : current,
                    )
                  }
                  data-testid="ghidra-lab-symbols"
                />
                <span>
                  Download PDBs from Microsoft&apos;s symbol server during analysis. Off by default:
                  behind a filtering proxy the request never returns and analysis never finishes,
                  and third-party binaries have no public PDBs anyway.
                </span>
              </label>
              <label className={styles.field}>
                <span>Max memory (MB)</span>
                <input
                  className={styles.input}
                  type="number"
                  value={config?.maxMemMb ?? 4096}
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current
                        ? { ...current, maxMemMb: Number(event.target.value) || 4096 }
                        : current,
                    )
                  }
                  data-testid="ghidra-lab-maxmem"
                />
              </label>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={busy || !config}
                  onClick={() =>
                    void saveConfig({
                      ghidraInstallDir: config?.ghidraInstallDir ?? '',
                      jdkHome: config?.jdkHome ?? '',
                      pythonExePath: config?.pythonExePath ?? '',
                      projectRoot: config?.projectRoot ?? '',
                      capaExePath: config?.capaExePath ?? '',
                      symbolDownloads: config?.symbolDownloads ?? false,
                      maxMemMb: config?.maxMemMb ?? 4096,
                    })
                  }
                  data-testid="ghidra-lab-save-paths"
                >
                  Save paths
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={busy || !config?.pythonExePath}
                  onClick={() => void bootstrapPython()}
                  data-testid="ghidra-lab-bootstrap"
                >
                  Bootstrap pyghidra-mcp
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={busy}
                  onClick={() => void bootstrapFloss()}
                  data-testid="ghidra-lab-download-floss"
                >
                  Download FLOSS
                </button>
              </div>
              <div className={styles.hint}>
                Bootstrap creates a private virtual environment and installs pyghidra-mcp into it,
                so your system Python is not modified.
              </div>
            </section>

            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>Binary roots</h2>
              <div className={styles.hint}>
                The reach limit. With no roots, nothing can be analyzed -- by design.
              </div>
              <div className={styles.list}>
                {(config?.binaryRoots ?? []).map((root) => (
                  <div key={root.id} className={styles.rootRow}>
                    <span className={styles.rootId}>{root.id}</span>
                    <span className={styles.rootPath}>{root.path}</span>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      onClick={() => void removeRoot(root.id)}
                      disabled={busy}
                      aria-label={`Remove ${root.id}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                {(config?.binaryRoots ?? []).length === 0 ? (
                  <div className={styles.empty}>No roots registered.</div>
                ) : null}
              </div>
              <div className={styles.inlineForm}>
                <input
                  className={styles.input}
                  placeholder="id"
                  value={rootDraft.id}
                  onChange={(event) =>
                    setRootDraft((current) => ({ ...current, id: event.target.value }))
                  }
                  data-testid="ghidra-lab-root-id"
                />
                <input
                  className={styles.input}
                  placeholder="C:\path\to\binaries"
                  value={rootDraft.path}
                  onChange={(event) =>
                    setRootDraft((current) => ({ ...current, path: event.target.value }))
                  }
                  data-testid="ghidra-lab-root-path"
                />
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => void addRoot()}
                  disabled={busy}
                  data-testid="ghidra-lab-add-root"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            </section>
          </>
        ) : null}

        {tab === 'binaries' ? (
          <section className={styles.panel} data-testid="ghidra-lab-binaries">
            <h2 className={styles.panelTitle}>Binaries</h2>
            <div className={styles.rowActions}>
              <input
                className={styles.input}
                placeholder="Search by name inside the roots"
                value={findQuery}
                onChange={(event) => setFindQuery(event.target.value)}
                data-testid="ghidra-lab-find"
              />
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={busy || !findQuery.trim()}
                onClick={() => {
                  void (async () => {
                    try {
                      const view = await findGhidraBinaries({
                        find: findQuery.trim(),
                        ...(browsePath ? { path: browsePath } : {}),
                      });
                      setBrowseEntries(sortBrowseEntries(view.entries));
                      if (view.entries.length === 0) {
                        setNote({ tone: 'warn', text: `No match for "${findQuery.trim()}".` });
                      }
                    } catch (error) {
                      showError(error);
                    }
                  })();
                }}
              >
                Find
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => void loadBrowse()}
                disabled={busy}
              >
                <FolderOpen size={12} /> Roots
              </button>
            </div>

            {breadcrumbs.length > 0 ? (
              <div className={styles.breadcrumbs}>
                {breadcrumbs.map((crumb, index) => (
                  <span key={crumb.path}>
                    {index > 0 ? <ChevronRight size={10} /> : null}
                    <button
                      type="button"
                      className={styles.crumb}
                      onClick={() => void loadBrowse(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className={styles.list}>
              {browseEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={styles.listItem}
                  data-selected={selectedBinary === entry.path ? 'true' : 'false'}
                  data-testid={`ghidra-entry-${entry.name}`}
                  onClick={() => {
                    if (entry.kind === 'directory') {
                      void loadBrowse(entry.path);
                      return;
                    }
                    setSelectedBinary(entry.path);
                    void persistState({ lastBinaryPath: entry.path });
                  }}
                >
                  <span className={styles.itemName}>
                    {entry.kind === 'directory' ? '📁 ' : ''}
                    {entry.name}
                  </span>
                  <span className={styles.itemMeta}>
                    {entry.kind === 'file' ? formatBytes(entry.sizeBytes) : ''}
                  </span>
                </button>
              ))}
              {browseEntries.length === 0 ? (
                <div className={styles.empty}>Nothing here.</div>
              ) : null}
            </div>

            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={busy || !selectedBinary}
                onClick={() => void startAnalysis()}
                data-testid="ghidra-lab-start"
              >
                <Play size={12} /> Analyze{' '}
                {selectedBinary ? selectedBinary.split(/[\\/]/).pop() : ''}
              </button>
            </div>
          </section>
        ) : null}

        {tab === 'sessions' ? (
          <>
            <section className={styles.panel} data-testid="ghidra-lab-sessions">
              <h2 className={styles.panelTitle}>Sessions</h2>
              <div className={styles.list}>
                {sessions.map((session) => {
                  const progress = describeProgress(session, now);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={styles.listItem}
                      data-selected={selectedSessionId === session.id ? 'true' : 'false'}
                      onClick={() => setSelectedSessionId(session.id)}
                      data-testid={`ghidra-session-${session.id}`}
                    >
                      <span className={styles.itemName}>
                        {session.binaryName}
                        {progress ? ` — ${progress.headline}` : ''}
                      </span>
                      <span className={styles.itemMeta}>{sessionStateLabel(session)}</span>
                    </button>
                  );
                })}
                {sessions.length === 0 ? (
                  <div className={styles.empty}>No sessions. Start one from the Binaries tab.</div>
                ) : null}
              </div>
              {selectedSession ? (
                <>
                  {describeProgress(selectedSession, now) ? (
                    <div className={styles.hint}>
                      {describeProgress(selectedSession, now)?.detail}
                    </div>
                  ) : null}
                  {selectedSession.failureReason ? (
                    <div className={styles.note} data-tone="error">
                      {selectedSession.failureReason}
                    </div>
                  ) : null}
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      disabled={busy || selectedSession.state !== 'ready'}
                      onClick={() => void startSweep()}
                      data-testid="ghidra-lab-sweep"
                    >
                      <FileText size={12} /> Full sweep &amp; report
                    </button>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      disabled={busy}
                      onClick={() => void stopSession(selectedSession.id)}
                    >
                      <Square size={12} /> Stop
                    </button>
                  </div>
                </>
              ) : null}
            </section>

            {selectedSession && selectedSession.state === 'ready' ? (
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>Ask the engine</h2>
                <div className={styles.rowActions}>
                  <select
                    className={styles.input}
                    value={queryKind}
                    onChange={(event) => setQueryKind(event.target.value)}
                    data-testid="ghidra-lab-query-kind"
                  >
                    {GHIDRA_QUERY_SPECS.map((spec) => (
                      <option key={spec.kind} value={spec.kind}>
                        {spec.kind}
                      </option>
                    ))}
                  </select>
                  <input
                    className={styles.input}
                    placeholder="name or pattern (optional for some)"
                    value={queryArg}
                    onChange={(event) => setQueryArg(event.target.value)}
                    data-testid="ghidra-lab-query-arg"
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    disabled={busy}
                    onClick={() => void runQuery()}
                    data-testid="ghidra-lab-query-run"
                  >
                    Run
                  </button>
                </div>
                {queryRows ? (
                  <pre className={styles.report}>{JSON.stringify(queryRows, null, 2)}</pre>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}

        {tab === 'reports' ? (
          <>
            <section className={styles.panel} data-testid="ghidra-lab-runs">
              <h2 className={styles.panelTitle}>Sweep runs</h2>
              <div className={styles.list}>
                {runs.map((run) => {
                  const summary = summarizeRunStages(run.stages);
                  return (
                    <button
                      key={run.runId}
                      type="button"
                      className={styles.listItem}
                      data-selected={selectedRunId === run.runId ? 'true' : 'false'}
                      onClick={() => void openReport(run.runId)}
                      data-testid={`ghidra-run-${run.runId}`}
                    >
                      <span className={styles.itemName}>{run.binaryName}</span>
                      <span className={styles.itemMeta}>
                        {runStateLabel(run)} — {summary.done}/{summary.total}
                        {summary.current ? ` (${summary.current})` : ''}
                      </span>
                    </button>
                  );
                })}
                {runs.length === 0 ? (
                  <div className={styles.empty}>No sweeps yet. Start one from a ready session.</div>
                ) : null}
              </div>
              {selectedRun ? (
                <>
                  <div className={styles.stageGrid}>
                    {selectedRun.stages.map((stage) => (
                      <span key={stage.stage} className={styles.stageChip} data-state={stage.state}>
                        {stage.stage}
                      </span>
                    ))}
                  </div>
                  {selectedRun.droppedClaims > 0 ? (
                    <div className={styles.hint}>
                      {selectedRun.droppedClaims} unsupported claim
                      {selectedRun.droppedClaims === 1 ? ' was' : 's were'} removed from the report
                      for citing no evidence.
                    </div>
                  ) : null}
                  {isRunActive(selectedRun) ? (
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        onClick={() => void cancelRun(selectedRun.runId)}
                      >
                        Cancel sweep
                      </button>
                      <span className={styles.hint}>
                        <Loader2 size={12} /> Cancelling stops after the current stage and keeps
                        what was collected.
                      </span>
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>

            {reportText ? (
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>Report</h2>
                <pre className={styles.report} data-testid="ghidra-lab-report">
                  {reportText}
                </pre>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default GhidraLab;
