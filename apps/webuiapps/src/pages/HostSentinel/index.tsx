import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import { AlertTriangle, Inbox, Loader2, Lock, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  createAppFileApi,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import {
  fetchAoiHostBridgeStatus,
  fetchAoiHostKillPreview,
  fetchAoiHostProcesses,
  runAoiHostKillExecute,
  type AoiHostBridgeStatus,
  type AoiHostKillPreviewView,
  type AoiHostProcessListingView,
} from '@/lib/aoiHostBridgeClient';
import {
  buildProcessRows,
  filterProcessRows,
  isSampleStale,
  memoryLabel,
  processOverview,
  sampleAgeLabel,
  sortProcessRows,
  type ProcessRow,
  type ProcessSort,
} from './processView';
import { APP_ID, APP_NAME, APP_STORAGE_NAME } from './actions/constants';
import styles from './index.module.scss';

const STATE_FILE = '/state.json';

/** Mirrors Drive Console: not-configured and denied are not failures. */
type BridgeStateKind = 'idle' | 'loading' | 'ready' | 'unconfigured' | 'denied' | 'error';

interface SentinelState {
  version: 1;
  query: string;
  sort: ProcessSort;
  sessionPath: string;
}

const DEFAULT_STATE: SentinelState = { version: 1, query: '', sort: 'memory', sessionPath: '' };

function classifyKind(error: unknown): { kind: BridgeStateKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid_token|unauthorized|\b401\b/i.test(message)) {
    return { kind: 'unconfigured', message };
  }
  if (/\b403\b|blocked|denied|approval/i.test(message)) {
    return { kind: 'denied', message };
  }
  return { kind: 'error', message };
}

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

function HostSentinel(): JSX.Element {
  const [state, setState] = useState<SentinelState>(DEFAULT_STATE);
  // Rendered as data-hydrated on the root: loadState overwrites session/query
  // with persisted values, so anything driving the inputs (e2e above all)
  // must be able to wait until that write has landed before typing.
  const [hydrated, setHydrated] = useState(false);
  const [listing, setListing] = useState<AoiHostProcessListingView | null>(null);
  const [status, setStatus] = useState<AoiHostBridgeStatus | null>(null);
  const [bridge, setBridge] = useState<{ kind: BridgeStateKind; message: string }>({
    kind: 'idle',
    message: '',
  });
  const [now, setNow] = useState(() => Date.now());
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [preview, setPreview] = useState<AoiHostKillPreviewView | null>(null);
  const [killNote, setKillNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const stateLoadedRef = useRef(false);
  const fileApi = useMemo(() => createAppFileApi(APP_STORAGE_NAME), []);

  const rows = useMemo(
    () => sortProcessRows(filterProcessRows(buildProcessRows(listing), state.query), state.sort),
    [listing, state.query, state.sort],
  );
  const overview = useMemo(() => processOverview(listing), [listing]);
  const selectedRow = useMemo(
    () => rows.find((row) => row.pid === selectedPid) ?? null,
    [rows, selectedPid],
  );

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
          query: typeof raw.query === 'string' ? raw.query : current.query,
          sort:
            raw.sort === 'memory' || raw.sort === 'name' || raw.sort === 'pid'
              ? raw.sort
              : current.sort,
          sessionPath:
            typeof raw.sessionPath === 'string' ? raw.sessionPath.trim() : current.sessionPath,
        }));
      }
    } catch {
      // A malformed state file must not stop the sentinel from opening.
    } finally {
      stateLoadedRef.current = true;
      setHydrated(true);
    }
  }, [fileApi]);

  useEffect(() => {
    if (!stateLoadedRef.current) {
      return;
    }
    void fileApi.writeFile(STATE_FILE, state).catch(() => {
      // A lost filter preference is not worth interrupting anyone.
    });
  }, [fileApi, state]);

  const refresh = useCallback(async (): Promise<void> => {
    const sessionPath = stateRef.current.sessionPath.trim();
    if (!sessionPath) {
      setBridge({ kind: 'idle', message: '' });
      return;
    }
    setBridge({ kind: 'loading', message: '' });
    try {
      // Status comes along because a panic stop changes what every row below
      // can actually do.
      const [processes, bridgeStatus] = await Promise.all([
        fetchAoiHostProcesses(sessionPath),
        fetchAoiHostBridgeStatus().catch(() => null),
      ]);
      setListing(processes);
      setStatus(bridgeStatus);
      setBridge({ kind: 'ready', message: '' });
      setNow(Date.now());
    } catch (error) {
      setBridge(classifyKind(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, state.sessionPath]);

  // Drives the sample-age label so a photograph never looks fresher than it is.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!killNote) {
      return undefined;
    }
    const timer = window.setTimeout(() => setKillNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [killNote]);

  /**
   * Propose a kill. Records a pending approval; kills nothing.
   *
   * The allowlist passed here is caller-declared by design -- the protected
   * process list on the server is the real guard. The UI says so rather than
   * presenting the allowlist as a security boundary.
   */
  const runKillPreview = useCallback(async (): Promise<void> => {
    if (!selectedRow) {
      return;
    }
    setBusy(true);
    setPreview(null);
    try {
      const result = await fetchAoiHostKillPreview({
        pid: selectedRow.pid,
        expectedImageName: selectedRow.imageName,
        // Declared per action, for exactly the image being acted on. There is
        // no server-side list of killable images to read -- this value is
        // caller-declared by design, and the protected-process list is the
        // actual guard.
        killAllowlistImages: [selectedRow.imageName],
      });
      setPreview(result);
      if (!result.allowed) {
        setKillNote({
          tone: 'error',
          text: result.denyReasons.join(', ') || '정책이 거부했습니다.',
        });
      }
    } catch (error) {
      setKillNote({ tone: 'error', text: classifyKind(error).message });
    } finally {
      setBusy(false);
    }
  }, [selectedRow]);

  const runKillExecute = useCallback(async (): Promise<void> => {
    if (!selectedRow) {
      return;
    }
    setBusy(true);
    try {
      const result = await runAoiHostKillExecute({
        pid: selectedRow.pid,
        expectedImageName: selectedRow.imageName,
        killAllowlistImages: [selectedRow.imageName],
      });
      setKillNote(
        result.ok
          ? { tone: 'ok', text: `pid ${result.pid} 종료 요청 완료.` }
          : {
              tone: 'error',
              text: result.denyReasons.join(', ') || result.detail || '거부되었습니다.',
            },
      );
      if (result.ok) {
        await refresh();
      }
    } catch (error) {
      setKillNote({ tone: 'error', text: classifyKind(error).message });
    } finally {
      setBusy(false);
    }
  }, [refresh, selectedRow]);

  /**
   * Agent surface: read and filter only.
   *
   * Killing is irreversible and the kill switch is the operator's brake. Neither
   * is reachable from here; see DELIBERATELY_UNEXPOSED_ACTIONS.
   */
  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'FILTER_HOST_PROCESSES': {
          setState((current) => ({ ...current, query: action.params?.query ?? '' }));
          return 'success';
        }
        case 'REFRESH_HOST_SENTINEL': {
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
    [loadState, refresh],
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
          windowStyle: { width: 1180, height: 760 },
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

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [loadState]);

  const stale = overview ? isSampleStale(overview.sampledAt, now) : false;

  return (
    <div
      className={styles.root}
      data-testid="host-sentinel"
      data-hydrated={hydrated ? 'true' : undefined}
    >
      <header className={styles.strip}>
        <input
          className={styles.session}
          value={state.sessionPath}
          placeholder="sessionPath (예: aoi/space_adventure)"
          data-testid="host-sentinel-session"
          onChange={(event) =>
            setState((current) => ({ ...current, sessionPath: event.target.value }))
          }
        />
        <input
          className={styles.query}
          value={state.query}
          placeholder="이미지명 또는 pid"
          data-testid="host-sentinel-filter"
          onChange={(event) => setState((current) => ({ ...current, query: event.target.value }))}
        />
        <select
          className={styles.sort}
          value={state.sort}
          aria-label="정렬"
          onChange={(event) =>
            setState((current) => ({ ...current, sort: event.target.value as ProcessSort }))
          }
        >
          <option value="memory">메모리</option>
          <option value="name">이름</option>
          <option value="pid">PID</option>
        </select>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void refresh()}
          aria-label="다시 표본"
          data-testid="host-sentinel-refresh"
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {status?.killSwitch?.globalPanic ? (
        <div className={styles.panic} data-testid="host-sentinel-panic">
          <ShieldAlert size={15} />
          호스트 브리지가 패닉 정지 상태입니다. 아래 조작은 전부 거부됩니다.
        </div>
      ) : null}

      <main className={styles.content}>
        {bridge.kind === 'idle' ? (
          <p className={styles.note} data-testid="host-sentinel-need-session">
            sessionPath 를 입력하면 프로세스 표본을 가져옵니다.
          </p>
        ) : null}

        {bridge.kind === 'loading' ? (
          <p className={styles.note}>
            <Loader2 size={14} className={styles.spinner} /> 표본을 뜨는 중…
          </p>
        ) : null}

        {bridge.kind === 'unconfigured' ? (
          <div
            className={styles.note}
            data-variant="unconfigured"
            data-testid="host-sentinel-unconfigured"
          >
            <Lock size={15} />
            <div>
              <p className={styles.noteTitle}>호스트 브리지가 아직 설정되지 않았습니다.</p>
              <p className={styles.noteBody}>고장이 아니라 켜지지 않은 상태입니다.</p>
            </div>
          </div>
        ) : null}

        {bridge.kind === 'denied' ? (
          <div className={styles.note} data-variant="denied" data-testid="host-sentinel-denied">
            <ShieldAlert size={15} />
            <span className={styles.noteBody}>{bridge.message}</span>
          </div>
        ) : null}

        {bridge.kind === 'error' ? (
          <div className={styles.note} data-variant="error" data-testid="host-sentinel-error">
            <AlertTriangle size={15} />
            <span className={styles.noteBody}>{bridge.message}</span>
          </div>
        ) : null}

        {bridge.kind === 'ready' && overview ? (
          <>
            <div className={styles.overview}>
              <span className={styles.stat}>
                프로세스 {overview.total} · 이미지 {overview.distinctImages}
              </span>
              {/* The age is never omitted: a photograph presented as a feed is how
                  the wrong pid gets killed after reuse. */}
              <span
                className={styles.sample}
                data-stale={stale ? 'true' : undefined}
                data-testid="host-sentinel-sample-age"
              >
                {sampleAgeLabel(overview.sampledAt, now)}
              </span>
            </div>

            {rows.length === 0 ? (
              <p className={styles.note} data-variant="empty">
                <Inbox size={14} /> 조건에 맞는 프로세스가 없습니다.
              </p>
            ) : (
              <table className={styles.table} data-testid="host-sentinel-table">
                <thead>
                  <tr>
                    <th scope="col">pid</th>
                    <th scope="col">image</th>
                    <th scope="col">memory</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: ProcessRow) => (
                    <tr
                      key={row.pid}
                      data-active={row.pid === selectedPid ? 'true' : undefined}
                      data-testid={`host-sentinel-row-${row.pid}`}
                      onClick={() => {
                        setSelectedPid(row.pid === selectedPid ? null : row.pid);
                        setPreview(null);
                      }}
                    >
                      <td className={styles.mono}>{row.pid}</td>
                      <td>{row.imageName}</td>
                      <td className={styles.mono}>{memoryLabel(row.memKb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {selectedRow ? (
              <section className={styles.killPanel} data-testid="host-sentinel-kill">
                <p className={styles.killTarget}>
                  {selectedRow.imageName} (pid {selectedRow.pid})
                </p>
                <p className={styles.killWarning}>
                  종료는 되돌릴 수 없습니다. 요청에 실리는 kill allowlist 는 호출자가 선언하는
                  값이라 보안 경계가 아닙니다 — 실제 방어는 서버의 보호 프로세스 목록입니다.
                </p>
                <div className={styles.killActions}>
                  <button
                    type="button"
                    className={styles.action}
                    disabled={busy}
                    onClick={() => void runKillPreview()}
                    data-testid="host-sentinel-kill-preview"
                  >
                    1. 제안
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy}
                    onClick={() => void runKillExecute()}
                    data-testid="host-sentinel-kill-execute"
                  >
                    3. 종료
                  </button>
                </div>
                <p className={styles.handoff}>
                  2. 승인은 <strong>Settings &gt; Host Bridge 승인함</strong>에서 직접 하세요.
                </p>
                {preview ? (
                  <dl className={styles.previewGrid}>
                    <dt>정책</dt>
                    <dd>{preview.allowed ? '허용' : preview.denyReasons.join(', ') || '거부'}</dd>
                    {preview.approvalFingerprint ? (
                      <>
                        <dt>승인 지문</dt>
                        <dd className={styles.mono}>{preview.approvalFingerprint}</dd>
                      </>
                    ) : null}
                  </dl>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </main>

      {killNote ? (
        <div className={styles.toast} data-tone={killNote.tone} role="status">
          {killNote.text}
        </div>
      ) : null}
    </div>
  );
}

export default HostSentinel;
