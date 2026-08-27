import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import {
  Binary,
  ChevronRight,
  Database,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
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
  attachIdaSqlGuiSession,
  browseIdaSqlPath,
  createIdaSqlGrant,
  deleteIdaSqlGrant,
  fetchIdaSqlGrants,
  fetchIdaSqlGuiWindow,
  fetchIdaSqlHealth,
  fetchIdaSqlSessionOutput,
  fetchIdaSqlSessions,
  findIdaSqlBinaries,
  previewIdaSqlSession,
  runIdaSqlApproval,
  runIdaSqlQuery,
  saveIdaSqlConfigPatch,
  stopIdaSqlSession,
} from '@/lib/idaSqlClient';
import type {
  IdaSqlBinaryRoot,
  IdaSqlBrowseEntry,
  IdaSqlConfigView,
  IdaSqlHealthView,
  IdaSqlQueryView,
  IdaSqlSessionMode,
  IdaSqlSessionView,
  IdaSqlStandingGrantView,
  IdaSqlWritePreviewView,
} from '@/lib/idaSqlTypes';
import { markIdaSqlSessionTouched } from '@/lib/aoiIdaSqlTools';
import { classifyIdaSqlBatch, summarizeIdaSqlBatch } from '@/lib/idaSqlPolicy';
import {
  buildBreadcrumbs,
  describeHealth,
  explainLabError,
  formatBytes,
  grantRemainingLabel,
  isSessionQueryable,
  describeProgress,
  sessionStateLabel,
  sortBrowseEntries,
} from './labView';
import { APP_ID, APP_NAME, APP_STORAGE_NAME } from './actions/constants';
import styles from './index.module.scss';

const STATE_FILE = '/state.json';
// While a headless session is analyzing there is nothing to do but wait, so poll
// instead of making the operator press refresh to find out it finished.
const STARTING_POLL_MS = 2500;
// The SQL editor lives in `state`, so persistence is debounced rather than
// per-change.
const STATE_WRITE_DEBOUNCE_MS = 600;

interface LabState {
  version: 1;
  sqlDraft: string;
  lastBinaryPath: string;
  mode: IdaSqlSessionMode;
}

const DEFAULT_STATE: LabState = {
  version: 1,
  sqlDraft: 'SELECT name, addr, size FROM funcs ORDER BY size DESC LIMIT 50;',
  lastBinaryPath: '',
  mode: 'headless',
};

// Real columns, checked against idasql v0.0.18.1 rather than guessed. The first
// draft used `start_ea` (which does not exist) and `.tables` (a REPL command the
// HTTP endpoint rejects as a syntax error), so every default landed on an error.
const SQL_SNIPPETS: { label: string; sql: string }[] = [
  {
    label: 'Tables',
    sql: "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;",
  },
  { label: 'Columns', sql: 'PRAGMA table_info(funcs);' },
  { label: 'Functions', sql: 'SELECT name, addr, size FROM funcs ORDER BY size DESC LIMIT 100;' },
  { label: 'Imports', sql: 'SELECT module, name, addr FROM imports LIMIT 100;' },
  { label: 'Strings', sql: 'SELECT addr, length, content FROM strings LIMIT 100;' },
  { label: 'Segments', sql: 'SELECT name, start_addr, end_addr, perm FROM segments;' },
  {
    label: 'Xrefs to',
    sql: 'SELECT from_addr, from_func, type FROM xrefs WHERE to_addr = 0 LIMIT 100;',
  },
];

function parseContent(content: unknown): unknown {
  if (typeof content !== 'string') {
    return content;
  }
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function IdaLab(): JSX.Element {
  const [state, setState] = useState<LabState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<'workbench' | 'setup'>('workbench');
  const [health, setHealth] = useState<IdaSqlHealthView | null>(null);
  const [sessions, setSessions] = useState<IdaSqlSessionView[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [entries, setEntries] = useState<IdaSqlBrowseEntry[]>([]);
  const [findQuery, setFindQuery] = useState('');
  const [selectedBinary, setSelectedBinary] = useState('');
  const [writeSession, setWriteSession] = useState(false);
  const [queryResult, setQueryResult] = useState<IdaSqlQueryView | null>(null);
  const [sessionOutput, setSessionOutput] = useState('');
  const [writePreview, setWritePreview] = useState<IdaSqlWritePreviewView | null>(null);
  const [sessionPreviewFingerprint, setSessionPreviewFingerprint] = useState('');
  const [sessionPreviewSummary, setSessionPreviewSummary] = useState('');
  const [grants, setGrants] = useState<IdaSqlStandingGrantView[]>([]);
  const [configDraft, setConfigDraft] = useState<IdaSqlConfigView | null>(null);
  const [rootDraft, setRootDraft] = useState({ id: '', path: '', label: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const stateRef = useRef(state);
  stateRef.current = state;
  const stateLoadedRef = useRef(false);
  const fileApi = useMemo(() => createAppFileApi(APP_STORAGE_NAME), []);

  const status = useMemo(() => describeHealth(health), [health]);
  const roots = useMemo(() => health?.config.binaryRoots ?? [], [health]);
  const breadcrumbs = useMemo(() => buildBreadcrumbs(browsePath, roots), [browsePath, roots]);
  const sortedEntries = useMemo(() => sortBrowseEntries(entries), [entries]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const draftClassification = useMemo(() => classifyIdaSqlBatch(state.sqlDraft), [state.sqlDraft]);
  // Tell the chat router that IDA work is live on this machine.
  //
  // The tools Aoi needs to answer a reversing question ride only on turns that
  // look like reversing work, and a follow-up like "제일 큰 함수 몇 개만" does
  // not look like anything. The signal that it IS reversing work is that a
  // session is open -- but the operator opens it HERE, not by asking Aoi, so
  // without this the whole app was invisible to the chat route.
  useEffect(() => {
    if (sessions.some((session) => session.state === 'ready' || session.state === 'starting')) {
      markIdaSqlSessionTouched();
    }
  }, [sessions]);
  // A toast is the wrong place for a line the operator has to retype into
  // another program. GUI mode hands back a `.http start` with a port and token
  // on it, and it has to stay on screen until they have used it.
  const [guiHandoff, setGuiHandoff] = useState<{
    command: string;
    port: number;
    token: string;
    detail: string;
    pid: number;
    /** Filled in once the launch's window hint settles; IDA takes ~3s to draw. */
    whereItIs: string;
  } | null>(null);
  // Reuses the single `now` state rather than adding a clock of its own: two
  // clocks in one component drift the moment someone updates only one of them,
  // and the standing-grant labels already read this one.
  const sessionProgress = useMemo(
    () => (selectedSession ? describeProgress(selectedSession, now) : null),
    [selectedSession, now],
  );

  // Ask where the window went, until we know.
  //
  // The launch fires one measurement server-side and does not wait for it: IDA
  // needs about three seconds to draw, and the approval response must not be
  // held for that. So the location arrives here instead, and stops being asked
  // for the moment it is known.
  useEffect(() => {
    if (!guiHandoff || guiHandoff.whereItIs || !guiHandoff.pid) {
      return undefined;
    }
    let cancelled = false;
    const ask = async (): Promise<void> => {
      try {
        const found = await fetchIdaSqlGuiWindow(guiHandoff.pid);
        if (!cancelled && found.detail) {
          setGuiHandoff((current) =>
            current && current.pid === guiHandoff.pid
              ? { ...current, whereItIs: found.detail }
              : current,
          );
        }
      } catch {
        // A missing location is not worth an error banner.
      }
    };
    void ask();
    const timer = window.setInterval(() => void ask(), 2000);
    // Bounded: the helper gives up on the window after 10s, so asking forever
    // would just be a timer nobody clears.
    const stop = window.setTimeout(() => window.clearInterval(timer), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [guiHandoff]);

  const showError = useCallback((error: unknown) => {
    setNote({ tone: 'error', text: explainLabError(error) });
  }, []);

  const loadState = useCallback(async (): Promise<void> => {
    try {
      const rootFiles = await fileApi.listFiles('/');
      const exists = Array.isArray(rootFiles)
        ? rootFiles.some((file) => file.name === 'state.json')
        : false;
      if (!exists) {
        await fileApi.writeFile(STATE_FILE, DEFAULT_STATE);
        return;
      }
      const parsed = parseContent((await fileApi.readFile(STATE_FILE))?.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const raw = parsed as Record<string, unknown>;
        setState((current) => ({
          ...current,
          sqlDraft: typeof raw.sqlDraft === 'string' ? raw.sqlDraft : current.sqlDraft,
          lastBinaryPath:
            typeof raw.lastBinaryPath === 'string' ? raw.lastBinaryPath : current.lastBinaryPath,
          mode: raw.mode === 'gui' ? 'gui' : 'headless',
        }));
        if (typeof raw.lastBinaryPath === 'string' && raw.lastBinaryPath) {
          setSelectedBinary(raw.lastBinaryPath);
        }
      }
    } catch {
      // A malformed state file must not stop the app from opening.
    } finally {
      stateLoadedRef.current = true;
      setHydrated(true);
    }
  }, [fileApi]);

  // Debounced, because `state` holds the SQL editor contents: writing on every
  // change meant one storage round trip PER KEYSTROKE while typing a query. The
  // pending write is flushed on unmount so closing the window does not lose the
  // last edit.
  useEffect(() => {
    if (!stateLoadedRef.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void fileApi.writeFile(STATE_FILE, stateRef.current).catch(() => {
        // A lost draft is not worth interrupting anyone.
      });
    }, STATE_WRITE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [fileApi, state]);

  useEffect(() => {
    return () => {
      if (!stateLoadedRef.current) {
        return;
      }
      void fileApi.writeFile(STATE_FILE, stateRef.current).catch(() => {
        // Unmount flush: best effort by definition.
      });
    };
  }, [fileApi]);

  const refresh = useCallback(async (): Promise<IdaSqlHealthView | null> => {
    try {
      // Three independent reads: one round trip each, run together (<= 6, so
      // Promise.all rather than batchConcurrent).
      const [nextHealth, nextSessions, nextGrants] = await Promise.all([
        fetchIdaSqlHealth(),
        fetchIdaSqlSessions().catch(() => [] as IdaSqlSessionView[]),
        fetchIdaSqlGrants().catch(() => [] as IdaSqlStandingGrantView[]),
      ]);
      setHealth(nextHealth);
      setSessions(nextSessions);
      setGrants(nextGrants);
      setConfigDraft((current) => current ?? nextHealth.config);
      setSelectedSessionId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }
        // Prefer something queryable, but fall back to the newest session
        // whatever its state: a lone FAILED session is the case most in need of
        // explanation, and selecting nothing left the operator with a one-word
        // label and no way to reach the diagnostic.
        return (
          nextSessions.find((session) => session.state === 'ready')?.id ?? nextSessions[0]?.id ?? ''
        );
      });
      setNow(Date.now());
      return nextHealth;
    } catch (error) {
      showError(error);
      return null;
    }
  }, [showError]);

  /** Can this machine browse right now? Panic outranks the capability toggle. */
  const canBrowse = useCallback(
    (view: IdaSqlHealthView | null): boolean =>
      Boolean(view && view.analysisCapabilityEnabled && !view.globalPanic),
    [],
  );

  const loadBrowse = useCallback(
    async (path: string): Promise<void> => {
      try {
        const view = await browseIdaSqlPath(path);
        setBrowsePath(view.path);
        setEntries(view.entries);
      } catch (error) {
        showError(error);
      }
    },
    [showError],
  );

  const runFind = useCallback(async (): Promise<void> => {
    const find = findQuery.trim();
    if (!find) {
      await loadBrowse(browsePath);
      return;
    }
    setBusy(true);
    try {
      const view = await findIdaSqlBinaries({ find, ...(browsePath ? { path: browsePath } : {}) });
      setEntries(view.entries);
      if (view.entries.length === 0) {
        setNote({ tone: 'error', text: `No match for "${find}" inside the registered roots.` });
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [browsePath, findQuery, loadBrowse, showError]);

  useEffect(() => {
    void (async () => {
      // Health first, then browse only if browsing can succeed. Firing both at
      // once meant a machine with the capability off greeted the operator with a
      // red banner repeating what the status chip already said.
      const view = await refresh();
      if (canBrowse(view)) {
        await loadBrowse('');
      }
    })();
  }, [canBrowse, loadBrowse, refresh]);

  // Poll only while something is actually starting, and stop as soon as it is not.
  useEffect(() => {
    if (!sessions.some((session) => session.state === 'starting')) {
      return undefined;
    }
    // Advance the clock here, not only inside refresh(): refresh stamps it after
    // a SUCCESSFUL read, so a server that stopped answering would freeze elapsed
    // time and make a running analysis read as a stalled one.
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, STARTING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, sessions]);

  // A pending confirmation is content-addressed to the binary and mode it was
  // previewed for. Changing either would leave a box that says one thing and
  // starts another, so the proposal is dropped instead.
  useEffect(() => {
    setSessionPreviewFingerprint('');
    setSessionPreviewSummary('');
  }, [selectedBinary, state.mode, writeSession]);

  // Turning writes off in Setup must also drop a checkbox left ticked from
  // before: the box goes disabled but keeps its value, and the next Analyze would
  // ask for a write session the settings no longer allow.
  useEffect(() => {
    if (health && !health.config.writeEnabled && writeSession) {
      setWriteSession(false);
    }
  }, [health, writeSession]);

  // Results belong to the session that produced them. Leaving them on screen
  // after switching sessions showed one database's rows under another one's
  // header, and left a write confirmation pointing at the previous session.
  useEffect(() => {
    setQueryResult(null);
    setWritePreview(null);
    // The diagnostic tail belongs to one session too.
    setSessionOutput('');
  }, [selectedSessionId]);

  useEffect(() => {
    if (!note) {
      return undefined;
    }
    const timer = window.setTimeout(() => setNote(null), 7000);
    return () => window.clearTimeout(timer);
  }, [note]);

  /** Propose a session. Starts nothing: it returns a fingerprint to approve. */
  const previewSession = useCallback(async (): Promise<void> => {
    if (!selectedBinary) {
      return;
    }
    setBusy(true);
    setSessionPreviewFingerprint('');
    setSessionPreviewSummary('');
    try {
      const outcome = await previewIdaSqlSession({
        binaryPath: selectedBinary,
        mode: stateRef.current.mode,
        ...(writeSession ? { write: true } : {}),
      });
      if (outcome.session) {
        // A standing grant covered it; the session is already running.
        setNote({ tone: 'ok', text: `Session started for ${outcome.session.binaryName}.` });
        await refresh();
        return;
      }
      const preview = outcome.preview;
      if (!preview) {
        setNote({ tone: 'error', text: 'No preview returned.' });
        return;
      }
      if (!preview.allowed) {
        setNote({ tone: 'error', text: `Blocked: ${preview.blockReasons.join(', ')}` });
        return;
      }
      setSessionPreviewFingerprint(preview.approvalFingerprint);
      setSessionPreviewSummary(preview.targetSummary);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedBinary, showError, writeSession]);

  const approveSession = useCallback(async (): Promise<void> => {
    if (!sessionPreviewFingerprint) {
      return;
    }
    setBusy(true);
    try {
      const result = await runIdaSqlApproval(sessionPreviewFingerprint);
      setSessionPreviewFingerprint('');
      setSessionPreviewSummary('');
      if (result.session) {
        setSelectedSessionId(result.session.id);
        setNote({
          tone: 'ok',
          text:
            result.session.state === 'ready'
              ? `Session ready: ${result.session.binaryName}`
              : `Analyzing ${result.session.binaryName}...`,
        });
      } else {
        setNote({ tone: 'ok', text: result.detail || 'IDA launched.' });
        if (result.guiStartCommand) {
          setGuiHandoff({
            command: result.guiStartCommand,
            port: result.guiSuggestedPort,
            token: result.guiSuggestedToken,
            detail: result.detail,
            pid: result.launchedPid ?? 0,
            whereItIs: '',
          });
        }
      }
      setState((current) => ({ ...current, lastBinaryPath: selectedBinary }));
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedBinary, sessionPreviewFingerprint, showError]);

  const runSql = useCallback(async (): Promise<void> => {
    if (!selectedSessionId) {
      setNote({ tone: 'error', text: 'Select a ready session first.' });
      return;
    }
    setBusy(true);
    setWritePreview(null);
    // Drop the previous answer before asking a new question. Leaving it up meant
    // a query that failed on the way out (transport, stopped session) left the
    // PREVIOUS query's table on screen under a one-word error note.
    setQueryResult(null);
    try {
      const outcome = await runIdaSqlQuery({
        sessionId: selectedSessionId,
        sql: stateRef.current.sqlDraft,
      });
      if (outcome.writePreview) {
        // A mutation never runs from the Run button; it becomes a confirmation.
        setWritePreview(outcome.writePreview);
        setQueryResult(null);
        return;
      }
      setQueryResult(outcome.query);
      if (outcome.query?.engineError) {
        setNote({ tone: 'error', text: outcome.query.engineError });
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [selectedSessionId, showError]);

  const approveWrite = useCallback(async (): Promise<void> => {
    if (!writePreview) {
      return;
    }
    setBusy(true);
    try {
      const result = await runIdaSqlApproval(writePreview.approvalFingerprint);
      setWritePreview(null);
      setQueryResult(result.query);
      setNote({
        tone: result.query?.engineError ? 'error' : 'ok',
        text: result.query?.engineError || 'Write applied.',
      });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }, [refresh, showError, writePreview]);

  const loadSessionOutput = useCallback(
    async (sessionId: string): Promise<void> => {
      setBusy(true);
      try {
        const output = await fetchIdaSqlSessionOutput(sessionId);
        setSessionOutput(
          output.trim() || 'idasql printed nothing. It may have exited before writing anything.',
        );
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    },
    [showError],
  );

  const stopSession = useCallback(
    async (sessionId: string): Promise<void> => {
      setBusy(true);
      try {
        await stopIdaSqlSession(sessionId);
        await refresh();
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    },
    [refresh, showError],
  );

  // Set only when attach found something on the port that did not identify
  // itself as idasql. The override is offered from here and nowhere else: a
  // person has to have seen the refusal before they can wave it through.
  const [unrecognizedPort, setUnrecognizedPort] = useState(0);

  const attachGui = useCallback(
    async (declarePort = false): Promise<void> => {
      setBusy(true);
      try {
        // Use the port and token we told the operator to bind. Probing blind was
        // never going to work: the plugin's own default is a random port, so the
        // 8100-8199 range only holds when we are the one who named it.
        const session = await attachIdaSqlGuiSession({
          ...(selectedBinary ? { binaryPath: selectedBinary } : {}),
          ...(guiHandoff?.port ? { port: guiHandoff.port } : {}),
          ...(guiHandoff?.token ? { token: guiHandoff.token } : {}),
          ...(declarePort ? { portDeclared: true } : {}),
        });
        setSelectedSessionId(session.id);
        setGuiHandoff(null);
        setUnrecognizedPort(0);
        setNote({ tone: 'ok', text: `Attached to IDA on port ${session.port}.` });
        await refresh();
      } catch (error) {
        // The one failure a person can overrule, because only they can see what
        // is on that port. Everything else stays a plain error.
        const message = error instanceof Error ? error.message : String(error);
        if (/gui_server_unrecognized/.test(message) && guiHandoff?.port) {
          setUnrecognizedPort(guiHandoff.port);
        }
        showError(error);
      } finally {
        setBusy(false);
      }
    },
    [guiHandoff, refresh, selectedBinary, showError],
  );

  const saveConfig = useCallback(
    async (patch: Partial<IdaSqlConfigView>): Promise<IdaSqlConfigView | null> => {
      setBusy(true);
      try {
        const next = await saveIdaSqlConfigPatch(patch);
        setConfigDraft(next);
        const view = await refresh();
        // Saving usually changed the roots, so the listing has to be re-read --
        // but only when browsing is permitted at all.
        if (canBrowse(view)) {
          await loadBrowse('');
        }
        setNote({ tone: 'ok', text: 'Saved.' });
        // Returned so a caller can check what the server actually kept: fields it
        // could not normalize are dropped, not rejected.
        return next;
      } catch (error) {
        showError(error);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [canBrowse, loadBrowse, refresh, showError],
  );

  const addRoot = useCallback(async (): Promise<void> => {
    const id = rootDraft.id.trim().toLowerCase();
    const path = rootDraft.path.trim();
    if (!id || !path) {
      setNote({ tone: 'error', text: 'A root needs an id and an absolute path.' });
      return;
    }
    const nextRoots: IdaSqlBinaryRoot[] = [
      ...(configDraft?.binaryRoots ?? []).filter((root) => root.id !== id),
      { id, path, label: rootDraft.label.trim() || path },
    ];
    // The server DROPS a root it cannot normalize (bad id characters, a relative
    // path) and answers 200 with the rest. Reported as "Saved." that looked like
    // success while nothing had been added, so check that the root actually
    // landed and say why if it did not.
    const saved = await saveConfig({ binaryRoots: nextRoots });
    if (saved && !saved.binaryRoots.some((root) => root.id === id)) {
      setNote({
        tone: 'error',
        text: `Root "${id}" was rejected. The id must be lowercase letters, digits, - or _, and the path must be absolute and free of | & ; < > \` $ characters.`,
      });
      return;
    }
    setRootDraft({ id: '', path: '', label: '' });
  }, [configDraft, rootDraft, saveConfig]);

  const removeRoot = useCallback(
    async (rootId: string): Promise<void> => {
      const nextRoots = (configDraft?.binaryRoots ?? []).filter((root) => root.id !== rootId);
      await saveConfig({ binaryRoots: nextRoots });
    },
    [configDraft, saveConfig],
  );

  const addGrant = useCallback(
    async (rootId: string): Promise<void> => {
      setBusy(true);
      try {
        await createIdaSqlGrant({ rootId });
        await refresh();
        setNote({ tone: 'ok', text: `Standing grant created for ${rootId}.` });
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    },
    [refresh, showError],
  );

  const revokeGrant = useCallback(
    async (grantId: string): Promise<void> => {
      setBusy(true);
      try {
        await deleteIdaSqlGrant(grantId);
        await refresh();
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    },
    [refresh, showError],
  );

  /**
   * Agent surface: navigate and read only.
   *
   * Aoi starts sessions and runs SQL through its own tools, which go through the
   * approval popup. Exposing those here would be a second door past the popup;
   * see DELIBERATELY_UNEXPOSED_ACTIONS.
   */
  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'SELECT_IDA_SESSION': {
          const sessionId = action.params?.session_id ?? '';
          if (!sessions.some((session) => session.id === sessionId)) {
            await refresh();
          }
          setSelectedSessionId(sessionId);
          return 'success';
        }
        case 'SET_IDA_SQL_DRAFT': {
          setState((current) => ({ ...current, sqlDraft: action.params?.sql ?? '' }));
          return 'success';
        }
        case 'BROWSE_IDA_BINARIES': {
          await loadBrowse(action.params?.path ?? '');
          return 'success';
        }
        case 'REFRESH_IDA_LAB': {
          await refresh();
          return 'success';
        }
        case 'SYNC_STATE': {
          await loadState();
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [loadBrowse, loadState, refresh, sessions],
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
          windowStyle: { width: 1360, height: 860 },
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
    // Mount-only: the lifecycle contract reports once per app load, so loadState
    // is deliberately not a dependency here.
  }, []);

  const config = configDraft ?? health?.config ?? null;

  return (
    <div className={styles.root} data-hydrated={hydrated ? 'true' : 'false'} data-testid="ida-lab">
      <header className={styles.header}>
        <div className={styles.brand}>
          <Binary size={18} />
          <span>IDA Lab</span>
        </div>
        <div className={styles.statusRow}>
          <span
            className={`${styles.statusChip} ${styles[`tone_${status.tone}`]}`}
            data-testid="ida-lab-status"
          >
            {status.tone === 'error' ? <ShieldAlert size={13} /> : null}
            {status.text}
          </span>
          {status.action ? <span className={styles.statusAction}>{status.action}</span> : null}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => void refresh()}
            disabled={busy}
            data-testid="ida-lab-refresh"
          >
            {busy ? <Loader2 size={14} className={styles.spin} /> : <RefreshCw size={14} />}
            Refresh
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setView(view === 'setup' ? 'workbench' : 'setup')}
            data-testid="ida-lab-setup-toggle"
          >
            <Settings2 size={14} />
            {view === 'setup' ? 'Workbench' : 'Setup'}
          </button>
        </div>
      </header>

      {note ? (
        <div
          className={note.tone === 'ok' ? styles.noteOk : styles.noteError}
          data-testid="ida-lab-note"
        >
          {note.text}
        </div>
      ) : null}

      {view === 'setup' ? (
        <section className={styles.setup} data-testid="ida-lab-setup">
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Paths</h2>
            <label className={styles.field}>
              <span>idasql executable</span>
              <input
                className={styles.input}
                value={config?.idasqlExePath ?? ''}
                placeholder="C:\Program Files\IDA Professional 9.4\idasql.exe"
                onChange={(event) =>
                  setConfigDraft((current) =>
                    current ? { ...current, idasqlExePath: event.target.value } : current,
                  )
                }
                data-testid="ida-lab-idasql-path"
              />
            </label>
            <label className={styles.field}>
              <span>ida.exe (GUI mode)</span>
              <input
                className={styles.input}
                value={config?.idaExePath ?? ''}
                placeholder="C:\Program Files\IDA Professional 9.4\ida.exe"
                onChange={(event) =>
                  setConfigDraft((current) =>
                    current ? { ...current, idaExePath: event.target.value } : current,
                  )
                }
                data-testid="ida-lab-ida-path"
              />
            </label>
            <div className={styles.hint}>
              idasql has to sit next to the IDA binary: that folder is put on PATH when it runs, and
              it is how idasql finds the engine.
            </div>
            <div className={styles.rowActions}>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={config?.writeEnabled ?? false}
                  onChange={(event) =>
                    setConfigDraft((current) =>
                      current ? { ...current, writeEnabled: event.target.checked } : current,
                    )
                  }
                  data-testid="ida-lab-write-enabled"
                />
                <span>
                  Allow write sessions (<code>-w</code>). Each write query still needs its own
                  approval, and the os_ida_write capability must be on.
                </span>
              </label>
            </div>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy || !config}
              onClick={() =>
                void saveConfig({
                  idasqlExePath: config?.idasqlExePath ?? '',
                  idaExePath: config?.idaExePath ?? '',
                  writeEnabled: config?.writeEnabled ?? false,
                })
              }
              data-testid="ida-lab-save-paths"
            >
              Save paths
            </button>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Binary roots</h2>
            <div className={styles.hint}>
              The reach limit. A binary outside every root cannot be analyzed, browsed, or found -
              by you or by Aoi.
            </div>
            <ul className={styles.list}>
              {(config?.binaryRoots ?? []).map((root) => (
                <li key={root.id} className={styles.listRow}>
                  <div className={styles.listMain}>
                    <strong>{root.label}</strong>
                    <span className={styles.mono}>{root.path}</span>
                  </div>
                  <div className={styles.listActions}>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => void addGrant(root.id)}
                      disabled={busy || !health?.autoSessionCapabilityEnabled}
                      title={
                        health?.autoSessionCapabilityEnabled
                          ? 'Let the autonomous loop start sessions in this root without a click (TTL and quota bounded)'
                          : 'Enable "IDA Lab: autonomous session start" in Settings > Advanced > Host PC first'
                      }
                    >
                      <Plus size={13} />
                      Grant
                    </button>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      onClick={() => void removeRoot(root.id)}
                      disabled={busy}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
              {(config?.binaryRoots ?? []).length === 0 ? (
                <li className={styles.empty}>No roots yet.</li>
              ) : null}
            </ul>
            <div className={styles.inlineForm}>
              <input
                className={styles.input}
                placeholder="id (a-z0-9-_)"
                value={rootDraft.id}
                onChange={(event) => setRootDraft({ ...rootDraft, id: event.target.value })}
                data-testid="ida-lab-root-id"
              />
              <input
                className={styles.input}
                placeholder="absolute folder path"
                value={rootDraft.path}
                onChange={(event) => setRootDraft({ ...rootDraft, path: event.target.value })}
                data-testid="ida-lab-root-path"
              />
              <input
                className={styles.input}
                placeholder="label (optional)"
                value={rootDraft.label}
                onChange={(event) => setRootDraft({ ...rootDraft, label: event.target.value })}
              />
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void addRoot()}
                disabled={busy}
                data-testid="ida-lab-add-root"
              >
                Add root
              </button>
            </div>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Standing grants</h2>
            <div className={styles.hint}>
              A grant is the only way a session starts without a click. Scoped to one root, TTL and
              session-quota bounded, and never covers a write query.
            </div>
            <ul className={styles.list}>
              {grants.map((grant) => (
                <li key={grant.id} className={styles.listRow}>
                  <div className={styles.listMain}>
                    <strong>{grant.label}</strong>
                    <span>{grantRemainingLabel(grant, now)}</span>
                  </div>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    onClick={() => void revokeGrant(grant.id)}
                    disabled={busy}
                  >
                    Revoke
                  </button>
                </li>
              ))}
              {grants.length === 0 ? <li className={styles.empty}>None.</li> : null}
            </ul>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Diagnostics</h2>
            <dl className={styles.diag}>
              <dt>idasql</dt>
              <dd>{health?.idasqlPresent ? health.idasqlVersion || 'present' : 'not found'}</dd>
              <dt>ida.exe</dt>
              <dd>{health?.idaExePresent ? 'present' : 'not found'}</dd>
              <dt>idalib</dt>
              <dd>{health?.idalibPresent ? 'present' : 'not found'}</dd>
              <dt>analysis capability</dt>
              <dd>{health?.analysisCapabilityEnabled ? 'on' : 'off'}</dd>
              <dt>write capability</dt>
              <dd>{health?.writeCapabilityEnabled ? 'on' : 'off'}</dd>
              <dt>autonomous start</dt>
              <dd>{health?.autoSessionCapabilityEnabled ? 'on' : 'off'}</dd>
            </dl>
            {(health?.problems ?? []).length > 0 ? (
              <ul className={styles.problems}>
                {(health?.problems ?? []).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : (
        <section className={styles.workbench}>
          <div className={styles.browser}>
            <div className={styles.panelHead}>
              <FolderOpen size={14} />
              <span>Binaries</span>
            </div>
            <div className={styles.inlineForm}>
              <input
                className={styles.input}
                placeholder="find by name (e.g. tavern)"
                value={findQuery}
                onChange={(event) => setFindQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void runFind();
                  }
                }}
                data-testid="ida-lab-find"
              />
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => void runFind()}
                disabled={busy}
              >
                Find
              </button>
            </div>
            <div className={styles.crumbs}>
              <button type="button" className={styles.crumb} onClick={() => void loadBrowse('')}>
                roots
              </button>
              {breadcrumbs.map((crumb) => (
                <span key={crumb.path} className={styles.crumbGroup}>
                  <ChevronRight size={11} />
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
            <ul className={styles.entries} data-testid="ida-lab-entries">
              {sortedEntries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className={`${styles.entry} ${
                      entry.path === selectedBinary ? styles.entrySelected : ''
                    }`}
                    onClick={() => {
                      if (entry.kind === 'directory') {
                        void loadBrowse(entry.path);
                        return;
                      }
                      setSelectedBinary(entry.path);
                    }}
                    title={entry.path}
                  >
                    <span className={styles.entryName}>
                      {entry.kind === 'directory' ? <FolderOpen size={13} /> : <Binary size={13} />}
                      {entry.name}
                    </span>
                    <span className={styles.entryMeta}>
                      {entry.kind === 'file' ? formatBytes(entry.sizeBytes) : ''}
                    </span>
                  </button>
                </li>
              ))}
              {sortedEntries.length === 0 ? (
                <li className={styles.empty}>Nothing here. Add a binary root under Setup.</li>
              ) : null}
            </ul>
            <div className={styles.analyzeBox}>
              <div className={styles.mono} data-testid="ida-lab-selected">
                {selectedBinary || 'no binary selected'}
              </div>
              <div className={styles.rowActions}>
                <select
                  className={styles.input}
                  value={state.mode}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      mode: event.target.value === 'gui' ? 'gui' : 'headless',
                    }))
                  }
                  data-testid="ida-lab-mode"
                >
                  <option value="headless">headless (idalib)</option>
                  <option value="gui">GUI (real IDA window)</option>
                </select>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={writeSession}
                    onChange={(event) => setWriteSession(event.target.checked)}
                    disabled={!health?.config.writeEnabled}
                    data-testid="ida-lab-write-session"
                  />
                  <span>write session</span>
                </label>
              </div>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void previewSession()}
                disabled={busy || !selectedBinary}
                data-testid="ida-lab-analyze"
              >
                <Play size={13} />
                Analyze
              </button>
              {state.mode === 'gui' ? (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => void attachGui()}
                  disabled={busy}
                  data-testid="ida-lab-attach"
                >
                  Attach to open IDA
                </button>
              ) : null}
              {sessionPreviewFingerprint ? (
                <div className={styles.confirmBox} data-testid="ida-lab-session-confirm">
                  <div>{sessionPreviewSummary}</div>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => {
                        setSessionPreviewFingerprint('');
                        setSessionPreviewSummary('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => void approveSession()}
                      disabled={busy}
                      data-testid="ida-lab-session-approve"
                    >
                      Approve &amp; Run
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className={styles.console}>
            <div className={styles.panelHead}>
              <Database size={14} />
              <span>Sessions</span>
            </div>
            <ul className={styles.sessions} data-testid="ida-lab-sessions">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`${styles.sessionRow} ${
                      session.id === selectedSessionId ? styles.sessionSelected : ''
                    }`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <span className={styles.sessionName}>{session.binaryName}</span>
                    <span className={styles.sessionMeta}>
                      {session.mode}
                      {session.write ? ' / write' : ' / read-only'} - {sessionStateLabel(session)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    onClick={() => void stopSession(session.id)}
                    disabled={busy}
                    title={
                      session.mode === 'gui'
                        ? 'Detach (your IDA window stays open)'
                        : 'Shut down this idasql process'
                    }
                  >
                    <Square size={12} />
                  </button>
                </li>
              ))}
              {sessions.length === 0 ? <li className={styles.empty}>No sessions.</li> : null}
            </ul>

            {selectedSession && selectedSession.unreviewedFunctions.length > 0 ? (
              <div className={styles.confirmBox} data-testid="ida-lab-unreviewed">
                <strong>This idasql exposes functions IDA Lab has not reviewed.</strong>
                <div className={styles.hint}>
                  Statements calling them are treated as writes and will ask for approval, so
                  nothing runs unchecked - but the classification was written against an older build
                  and should be revisited.
                </div>
                <pre className={styles.pre}>{selectedSession.unreviewedFunctions.join(', ')}</pre>
              </div>
            ) : null}

            {guiHandoff ? (
              <div className={styles.confirmBox} data-testid="ida-lab-gui-handoff">
                <strong>IDA is open. One line to make it queryable.</strong>
                <div className={styles.hint} data-testid="ida-lab-gui-handoff-detail">
                  {guiHandoff.detail}
                </div>
                {guiHandoff.whereItIs ? (
                  <div className={styles.hint} data-testid="ida-lab-gui-window-where">
                    {guiHandoff.whereItIs}
                  </div>
                ) : null}
                <pre className={styles.pre} data-testid="ida-lab-gui-command">
                  {guiHandoff.command}
                </pre>
                <div className={styles.hint}>
                  Type it in IDA&apos;s idasql CLI window (Windows &gt; idasql). The port and token
                  are not optional decoration: a bare <code>.http start</code> binds a random port
                  with no auth, which nothing here can find and anything on this machine could
                  query.
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => {
                      // A silent failure here is worse than no button: the
                      // operator clicks, nothing visible happens, and they paste
                      // whatever was on the clipboard before into IDA. The API is
                      // absent in an insecure context and rejects when permission
                      // is denied, so both paths have to say so.
                      const copy = navigator.clipboard?.writeText(guiHandoff.command);
                      if (!copy) {
                        setNote({
                          tone: 'error',
                          text: 'Clipboard is not available here - select the command above and copy it manually.',
                        });
                        return;
                      }
                      void copy.then(
                        () => setNote({ tone: 'ok', text: 'Command copied.' }),
                        () =>
                          setNote({
                            tone: 'error',
                            text: 'The browser refused clipboard access - select the command above and copy it manually.',
                          }),
                      );
                    }}
                    data-testid="ida-lab-copy-gui-command"
                  >
                    Copy command
                  </button>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => void attachGui()}
                    disabled={busy}
                    data-testid="ida-lab-attach-after-handoff"
                  >
                    I ran it - attach now
                  </button>
                  {unrecognizedPort === guiHandoff.port ? (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => void attachGui(true)}
                      disabled={busy}
                      data-testid="ida-lab-declare-port"
                    >
                      That port IS my IDA - attach anyway
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => {
                      setGuiHandoff(null);
                      setUnrecognizedPort(0);
                    }}
                    data-testid="ida-lab-dismiss-handoff"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}

            {sessionProgress ? (
              <div className={styles.confirmBox} data-testid="ida-lab-progress">
                <strong>
                  {selectedSession?.mode === 'headless' ? 'Analyzing' : 'Attaching'} -{' '}
                  {sessionProgress.elapsed}
                  {sessionProgress.size ? ` - database ${sessionProgress.size}` : ''}
                  {sessionProgress.delta ? ` (${sessionProgress.delta})` : ''}
                </strong>
                <div className={styles.hint} data-testid="ida-lab-progress-detail">
                  {sessionProgress.detail}
                </div>
              </div>
            ) : null}

            {selectedSession && selectedSession.state === 'failed' ? (
              <div className={styles.confirmBox} data-testid="ida-lab-failure">
                <strong>{sessionStateLabel(selectedSession)}</strong>
                <div className={styles.hint}>
                  Wrong CLI flags, a licence problem or an engine idasql could not find all look
                  like this. Its own output is the diagnostic.
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => void loadSessionOutput(selectedSession.id)}
                    disabled={busy}
                    data-testid="ida-lab-show-output"
                  >
                    Show idasql output
                  </button>
                </div>
                {sessionOutput ? (
                  <pre className={styles.pre} data-testid="ida-lab-output">
                    {sessionOutput}
                  </pre>
                ) : null}
              </div>
            ) : null}

            <div className={styles.panelHead}>
              <span>SQL</span>
              <span className={styles.classChip} data-testid="ida-lab-sql-class">
                {draftClassification.statementClass}
              </span>
            </div>
            <div className={styles.snippets}>
              {SQL_SNIPPETS.map((snippet) => (
                <button
                  key={snippet.label}
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => setState((current) => ({ ...current, sqlDraft: snippet.sql }))}
                >
                  {snippet.label}
                </button>
              ))}
            </div>
            <textarea
              className={styles.sqlInput}
              value={state.sqlDraft}
              spellCheck={false}
              onChange={(event) =>
                setState((current) => ({ ...current, sqlDraft: event.target.value }))
              }
              data-testid="ida-lab-sql"
            />
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => void runSql()}
                disabled={busy || !isSessionQueryable(selectedSession)}
                data-testid="ida-lab-run-sql"
              >
                <Play size={13} />
                Run
              </button>
              <span className={styles.hint}>{summarizeIdaSqlBatch(draftClassification)}</span>
            </div>

            {writePreview ? (
              <div className={styles.confirmBox} data-testid="ida-lab-write-confirm">
                <strong>This writes to the IDA database.</strong>
                <pre className={styles.pre}>{writePreview.sql}</pre>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => setWritePreview(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => void approveWrite()}
                    disabled={busy}
                    data-testid="ida-lab-write-approve"
                  >
                    Approve &amp; Run
                  </button>
                </div>
              </div>
            ) : null}

            {queryResult ? (
              <div className={styles.results} data-testid="ida-lab-results">
                <div className={styles.hint}>
                  {queryResult.elapsedMs} ms
                  {queryResult.engineError ? ` - ${queryResult.engineError}` : ''}
                </div>
                {/* An empty answer and a broken one must not look the same. A
                    statement that returns no result set at all (a write, or an
                    engine that answered with nothing) previously rendered as a
                    bare timing line under an empty box. */}
                {queryResult.resultSets.length === 0 ? (
                  <div className={styles.hint} data-testid="ida-lab-no-result-set">
                    {queryResult.engineError
                      ? 'The engine returned an error and no rows.'
                      : 'Ran successfully and returned no result set. A write statement answers this way.'}
                  </div>
                ) : null}
                {queryResult.resultSets.map((set, setIndex) => (
                  <div key={`set-${setIndex}`} className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          {set.columns.map((column, columnIndex) => (
                            <th key={`${column}-${columnIndex}`}>{column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {set.rows.map((row, rowIndex) => (
                          <tr key={`row-${rowIndex}`}>
                            {row.map((cell, cellIndex) => (
                              <td key={`cell-${cellIndex}`}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {set.rows.length === 0 && !queryResult.engineError ? (
                      // Only when the statement actually ran. Saying "the query
                      // ran; nothing matched" under an engine error would be
                      // describing something that never happened.
                      <div className={styles.hint} data-testid="ida-lab-zero-rows">
                        0 rows. The query ran; nothing matched.
                      </div>
                    ) : null}
                    {set.truncated ? (
                      <div className={styles.hint}>
                        Showing the first {set.rows.length} of {set.rowCount} rows.
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

export default IdaLab;
