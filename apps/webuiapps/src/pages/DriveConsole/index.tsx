import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import { ListChecks, PlayCircle, ScrollText } from 'lucide-react';
import {
  createAppFileApi,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import {
  fetchAoiBrowserDriveAudit,
  fetchAoiHostBrowserDriveActPreview,
  runAoiHostBrowserDriveActExecute,
  type AoiBrowserDriveAuditEntryView,
  type AoiHostBrowserDriveActPreviewView,
} from '@/lib/aoiHostBridgeClient';
import { classifyDraft, draftToPlan, summarizeDraft } from './planDraft';
import {
  classifyBridgeError,
  DEFAULT_DRIVE_CONSOLE_STATE,
  DRIVE_CONSOLE_VIEWS,
  isDriveConsoleViewId,
  mergeDriveConsoleState,
  type BridgeState,
  type DriveConsoleState,
  type DriveConsoleViewId,
} from './types';
import { APP_ID, APP_NAME, APP_STORAGE_NAME } from './actions/constants';
import BridgePanel from './components/BridgePanel';
import PlanEditor from './components/PlanEditor';
import styles from './index.module.scss';

const STATE_FILE = '/state.json';
const COMPACT_MAX_WIDTH = 700;

const VIEW_META: Record<DriveConsoleViewId, { label: string; Icon: typeof ListChecks }> = {
  plan: { label: 'Plan', Icon: ListChecks },
  run: { label: 'Run', Icon: PlayCircle },
  audit: { label: 'Audit', Icon: ScrollText },
};

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

function DriveConsole(): JSX.Element {
  const [state, setState] = useState<DriveConsoleState>(DEFAULT_DRIVE_CONSOLE_STATE);
  const [compact, setCompact] = useState(false);
  const [preview, setPreview] = useState<BridgeState<AoiHostBrowserDriveActPreviewView>>({
    kind: 'idle',
  });
  const [execution, setExecution] = useState<BridgeState<{ message: string }>>({ kind: 'idle' });
  const [audit, setAudit] = useState<BridgeState<AoiBrowserDriveAuditEntryView[]>>({
    kind: 'idle',
  });
  const [busy, setBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const stateLoadedRef = useRef(false);
  const fileApi = useMemo(() => createAppFileApi(APP_STORAGE_NAME), []);

  // Runs on every keystroke: this is the whole point of the console, and the
  // classifier is a pure function with no I/O, so it costs nothing to be live.
  const classification = useMemo(() => classifyDraft(state.draft), [state.draft]);
  const summary = useMemo(() => summarizeDraft(state.draft), [state.draft]);

  const loadState = useCallback(async (): Promise<void> => {
    try {
      const rootFiles = await fileApi.listFiles('/');
      const exists = Array.isArray(rootFiles)
        ? rootFiles.some((file) => file.name === 'state.json')
        : false;
      if (!exists) {
        await fileApi.writeFile(STATE_FILE, DEFAULT_DRIVE_CONSOLE_STATE);
        return;
      }
      const result = await fileApi.readFile(STATE_FILE);
      setState((current) => mergeDriveConsoleState(current, parseContent(result?.content)));
    } catch {
      // A malformed state file must not stop the console from opening.
    } finally {
      stateLoadedRef.current = true;
    }
  }, [fileApi]);

  useEffect(() => {
    if (!stateLoadedRef.current) {
      return;
    }
    void fileApi.writeFile(STATE_FILE, state).catch(() => {
      // Losing a draft preference is not worth interrupting the operator.
    });
  }, [fileApi, state]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setCompact(width < COMPACT_MAX_WIDTH);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const loadAudit = useCallback(async (): Promise<void> => {
    setAudit({ kind: 'loading' });
    try {
      const entries = await fetchAoiBrowserDriveAudit();
      setAudit(
        entries.length === 0
          ? { kind: 'empty', reason: '기록된 조종 이력이 없습니다.', fetchedAt: Date.now() }
          : { kind: 'ready', data: entries, fetchedAt: Date.now() },
      );
    } catch (error) {
      setAudit(classifyBridgeError(error, Date.now()));
    }
  }, []);

  useEffect(() => {
    if (state.activeView === 'audit') {
      void loadAudit();
    }
  }, [state.activeView, loadAudit]);

  /**
   * Step 1 of the three-step loop: propose.
   *
   * This only records a PENDING approval and returns its fingerprint. Nothing
   * touches the browser yet, and the console deliberately does not approve on
   * the operator's behalf -- the whole guarantee is that a human looked.
   */
  const runPreview = useCallback(async (): Promise<void> => {
    const index = stateRef.current.selectedStepIndex;
    // Re-validated against the current draft: a stale persisted index would
    // otherwise ask the bridge to preview a step that no longer exists.
    if (index === null || !stateRef.current.draft.steps[index]) {
      return;
    }
    setBusy(true);
    setPreview({ kind: 'loading' });
    setExecution({ kind: 'idle' });
    try {
      const result = await fetchAoiHostBrowserDriveActPreview(
        stateRef.current.sessionPath,
        draftToPlan(stateRef.current.draft),
        index,
      );
      setPreview({ kind: 'ready', data: result, fetchedAt: Date.now() });
    } catch (error) {
      setPreview(classifyBridgeError(error, Date.now()));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Step 3: run the one approved act.
   *
   * Fail-closed on the server: without a human-approved, single-use entry for
   * this exact fingerprint it returns 403, which surfaces as 'denied' rather
   * than as a generic error, because that is the system working.
   */
  const runExecute = useCallback(async (): Promise<void> => {
    const index = stateRef.current.selectedStepIndex;
    // Re-validated against the current draft: a stale persisted index would
    // otherwise ask the bridge to preview a step that no longer exists.
    if (index === null || !stateRef.current.draft.steps[index]) {
      return;
    }
    setBusy(true);
    setExecution({ kind: 'loading' });
    try {
      const result = await runAoiHostBrowserDriveActExecute(
        stateRef.current.sessionPath,
        draftToPlan(stateRef.current.draft),
        index,
      );
      setExecution({
        kind: 'ready',
        data: {
          message: result.ok
            ? `실행 완료 — ${result.finalUrl ?? '이동 없음'}`
            : `중단됨 — ${result.stopReason ?? '사유 불명'}`,
        },
        fetchedAt: Date.now(),
      });
    } catch (error) {
      setExecution(classifyBridgeError(error, Date.now()));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Agent surface: read and navigation only.
   *
   * No branch reaches preview, execute, approval, or the page reader. An agent
   * that could run this loop would be authorizing its own plan inside the user's
   * logged-in browser. Aoi drives through its own tool path, which passes the
   * same gates; this console belongs to the operator.
   */
  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'SELECT_DRIVE_CONSOLE_VIEW': {
          const view = action.params?.view;
          if (!isDriveConsoleViewId(view)) {
            return `error: unknown view ${String(view)}`;
          }
          setState((current) => ({ ...current, activeView: view }));
          return 'success';
        }
        case 'REFRESH_DRIVE_CONSOLE': {
          await loadAudit();
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
    [loadAudit, loadState],
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
          windowStyle: { width: 1180, height: 780 },
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

  // An out-of-range index has to read as "nothing selected", not as a selection.
  //
  // selectedStepIndex is persisted, so a state file written when the plan had
  // more steps (or restored after the steps were removed) leaves it pointing
  // past the end. Comparing only against null let `undefined` through, and the
  // run view then rendered as if a step were chosen and dereferenced its kind.
  const selectedStep =
    state.selectedStepIndex === null ? null : (state.draft.steps[state.selectedStepIndex] ?? null);
  const selectedStepIndex = selectedStep === null ? null : state.selectedStepIndex;

  return (
    <div
      className={styles.root}
      data-compact={compact ? 'true' : undefined}
      ref={rootRef}
      data-testid="drive-console"
    >
      <header className={styles.strip}>
        <nav className={styles.rail} aria-label="Drive Console 섹션">
          {DRIVE_CONSOLE_VIEWS.map((view) => {
            const { label, Icon } = VIEW_META[view];
            return (
              <button
                key={view}
                type="button"
                className={styles.railItem}
                data-active={state.activeView === view ? 'true' : undefined}
                data-testid={`drive-console-rail-${view}`}
                onClick={() => setState((current) => ({ ...current, activeView: view }))}
              >
                <Icon size={14} />
                <span className={styles.railLabel}>{label}</span>
              </button>
            );
          })}
        </nav>

        {/* The verdict line: how much of this plan is the operator vouching for. */}
        <p className={styles.summary} data-testid="drive-console-summary">
          {summary.total === 0
            ? '단계를 추가하면 여기서 바로 분류됩니다.'
            : `읽기 ${summary.read} · 승인 필요 ${summary.act} · 차단 ${summary.forbidden}`}
        </p>

        <input
          className={styles.session}
          value={state.sessionPath}
          placeholder="sessionPath (예: aoi/space_adventure)"
          data-testid="drive-console-session"
          onChange={(event) =>
            setState((current) => ({ ...current, sessionPath: event.target.value }))
          }
        />
      </header>

      <main className={styles.content}>
        {state.activeView === 'plan' ? (
          <PlanEditor
            draft={state.draft}
            classification={classification}
            selectedStepIndex={selectedStepIndex}
            onChange={(draft) =>
              setState((current) => ({
                ...current,
                draft,
                // Dropping a step must drop the selection with it. Keeping the
                // index would silently re-point it at whatever slid into that
                // slot, so the operator would be running a step they never
                // chose.
                selectedStepIndex:
                  draft.steps.length < current.draft.steps.length
                    ? null
                    : current.selectedStepIndex,
              }))
            }
            onSelectStep={(index) =>
              setState((current) => ({ ...current, selectedStepIndex: index }))
            }
          />
        ) : null}

        {state.activeView === 'run' ? (
          <div className={styles.run}>
            {selectedStep === null ? (
              <p className={styles.hint} data-testid="drive-console-no-step">
                Plan 에서 실행할 단계를 하나 고르세요.
              </p>
            ) : (
              <>
                <p className={styles.hint}>
                  {(selectedStepIndex ?? 0) + 1}번 단계 — {selectedStep.kind}
                </p>

                <BridgePanel
                  title="1. 제안 (preview)"
                  subtitle="승인 대기에 올립니다. 아직 브라우저를 건드리지 않습니다."
                  state={preview}
                  actions={
                    <button
                      type="button"
                      className={styles.action}
                      disabled={busy || !state.sessionPath.trim()}
                      onClick={() => void runPreview()}
                      data-testid="drive-console-preview"
                    >
                      제안하기
                    </button>
                  }
                >
                  {(data) => (
                    <dl className={styles.previewGrid}>
                      <dt>대상</dt>
                      <dd>{data.targetSummary || '-'}</dd>
                      <dt>호스트</dt>
                      <dd>{data.hostname || '-'}</dd>
                      <dt>승인 지문</dt>
                      <dd className={styles.mono}>{data.approvalFingerprint}</dd>
                    </dl>
                  )}
                </BridgePanel>

                <p className={styles.handoff}>
                  2. 승인은 <strong>Settings &gt; Host Bridge 승인함</strong>에서 직접 하세요. 이
                  콘솔은 대신 승인하지 않습니다.
                </p>

                <BridgePanel
                  title="3. 실행 (execute)"
                  subtitle="승인된 그 한 단계만 실행합니다. 승인이 없으면 거부됩니다."
                  state={execution}
                  actions={
                    <button
                      type="button"
                      className={styles.action}
                      disabled={busy || !state.sessionPath.trim()}
                      onClick={() => void runExecute()}
                      data-testid="drive-console-execute"
                    >
                      실행하기
                    </button>
                  }
                >
                  {(data) => <p className={styles.result}>{data.message}</p>}
                </BridgePanel>
              </>
            )}
          </div>
        ) : null}

        {state.activeView === 'audit' ? (
          <BridgePanel
            title="Audit"
            subtitle="브라우저 조종이 실제로 무엇을 했는지의 기록"
            state={audit}
          >
            {(entries) => (
              <ul className={styles.audit} data-testid="drive-console-audit">
                {entries.map((entry) => (
                  <li
                    key={entry.id}
                    className={styles.auditRow}
                    data-ok={entry.ok ? 'true' : 'false'}
                  >
                    <span className={styles.auditKind}>{entry.actionKind}</span>
                    <span className={styles.auditSummary}>{entry.actionSummary || entry.url}</span>
                    {/* A standing grant means nobody approved this one individually,
                        which is exactly the thing worth being able to spot later. */}
                    {entry.viaStanding ? (
                      <span className={styles.auditFlag}>standing grant</span>
                    ) : null}
                    {!entry.ok ? (
                      <span className={styles.auditStop}>{entry.stopReason ?? '중단'}</span>
                    ) : null}
                    <span className={styles.auditTime}>
                      {new Date(entry.recordedAt).toLocaleString('ko-KR')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </BridgePanel>
        ) : null}
      </main>
    </div>
  );
}

export default DriveConsole;
