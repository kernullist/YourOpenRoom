import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  Inbox as InboxIcon,
  Loader2,
  NotebookText,
  RefreshCw,
  Rss,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import {
  createAppFileApi,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import { startAoiResearchRun } from '@/lib/aoiResearchClient';
import { getSessionPath } from '@/lib/sessionPath';
import {
  describeInterestMeta,
  type SignalBriefDoc,
  type SignalBriefResponse,
  type SignalItem,
  type SignalsResponse,
} from '@/lib/signalDeskShared';
import { fetchBrief, fetchSignals } from './api';
import { APP_ID, APP_NAME, APP_STORAGE_NAME, ActionTypes } from './actions/constants';
import {
  briefFilePath,
  briefNameToDate,
  CATEGORY_FILTERS,
  CATEGORY_LABELS,
  composeResearchRequest,
  countByCategory,
  filterSignals,
  formatCacheAge,
  formatRelativeTime,
  isBriefFileName,
  markSeen,
  parseBriefDoc,
  scoreTier,
  summarizeOutcomes,
} from './signalView';
import {
  classifyResearchFailure,
  DEFAULT_SIGNAL_DESK_STATE,
  isSignalDeskViewId,
  mergeSignalDeskState,
  SIGNAL_DESK_VIEWS,
  type PanelState,
  type ResearchPhase,
  type SignalDeskState,
  type SignalDeskViewId,
} from './types';
import StatePanel from './components/StatePanel';
import styles from './index.module.scss';

const STATE_FILE = '/state.json';
const COMPACT_MAX_WIDTH = 700;

const VIEW_META: Record<SignalDeskViewId, { label: string; Icon: typeof InboxIcon }> = {
  inbox: { label: 'Inbox', Icon: InboxIcon },
  brief: { label: 'Brief', Icon: NotebookText },
  sources: { label: 'Sources', Icon: Rss },
};

/** Icon per research phase — a lookup, not a branch, so coverage stays honest. */
const RESEARCH_STATE_ICONS: Record<Exclude<ResearchPhase['kind'], 'idle'>, typeof CheckCircle2> = {
  starting: Loader2,
  started: CheckCircle2,
  denied: ShieldAlert,
  error: AlertTriangle,
};

type OpenedBrief =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string }
  | { kind: 'ready'; name: string; doc: SignalBriefDoc }
  | { kind: 'error'; name: string; message: string };

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

function BriefDocContent({ doc }: { doc: SignalBriefDoc }): JSX.Element {
  return (
    <div data-testid="signal-desk-brief-doc" className={styles.briefDoc}>
      <div className={styles.briefMast}>
        <span className={styles.briefDate}>{doc.date}</span>
        <span className={styles.briefStamp}>
          {new Date(doc.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
        </span>
        <span
          className={styles.briefInterest}
          data-applied={doc.interest.applied ? 'true' : undefined}
        >
          {describeInterestMeta(doc.interest)}
        </span>
      </div>
      <p className={styles.briefHeadline}>{doc.headline}</p>
      {doc.caveats.length > 0 ? (
        <ul className={styles.caveats} data-testid="signal-desk-brief-caveats">
          {doc.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}
      {doc.sections.map((section) => (
        <div key={section.category} className={styles.briefSection} data-cat={section.category}>
          <h3 className={styles.briefSectionTitle}>{section.title}</h3>
          {section.items.map((item) => (
            <p key={item.id} className={styles.briefItem}>
              <span className={styles.briefItemScore}>{item.score}</span>
              <span className={styles.briefItemTitle}>{item.title}</span>
              <span className={styles.briefItemMeta}>{item.sourceName}</span>
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

function SignalDesk(): JSX.Element {
  const [state, setState] = useState<SignalDeskState>(DEFAULT_SIGNAL_DESK_STATE);
  const [compact, setCompact] = useState(false);
  const [signals, setSignals] = useState<PanelState<SignalsResponse>>({ kind: 'idle' });
  const [brief, setBrief] = useState<PanelState<SignalBriefResponse>>({ kind: 'idle' });
  const [savedBriefs, setSavedBriefs] = useState<PanelState<string[]>>({ kind: 'idle' });
  const [openedBrief, setOpenedBrief] = useState<OpenedBrief>({ kind: 'idle' });
  const [research, setResearch] = useState<ResearchPhase>({ kind: 'idle' });
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const briefRef = useRef(brief);
  briefRef.current = brief;
  const stateLoadedRef = useRef(false);
  const fileApi = useMemo(() => createAppFileApi(APP_STORAGE_NAME), []);

  /**
   * Returns the effective sessionPath so the first signals fetch can carry it
   * — waiting for the state commit would race the fetch and silently drop the
   * interest weighting on first load.
   */
  const loadState = useCallback(async (): Promise<string> => {
    try {
      const rootFiles = await fileApi.listFiles('/');
      const exists = Array.isArray(rootFiles)
        ? rootFiles.some((file) => file.name === 'state.json')
        : false;
      if (!exists) {
        // First run: adopt the live session (same-runtime case) so the
        // research handoff works without retyping.
        const seeded = { ...DEFAULT_SIGNAL_DESK_STATE, sessionPath: getSessionPath().trim() };
        setState(seeded);
        await fileApi.writeFile(STATE_FILE, seeded);
        return seeded.sessionPath;
      }
      const result = await fileApi.readFile(STATE_FILE);
      const merged = mergeSignalDeskState(stateRef.current, parseContent(result?.content));
      const live = getSessionPath().trim();
      const next =
        merged.sessionPath === '' && live !== '' ? { ...merged, sessionPath: live } : merged;
      setState(next);
      return next.sessionPath;
    } catch {
      // A malformed state file must not stop the desk from opening.
      return stateRef.current.sessionPath;
    } finally {
      stateLoadedRef.current = true;
    }
  }, [fileApi]);

  useEffect(() => {
    if (!stateLoadedRef.current) {
      return;
    }
    void fileApi.writeFile(STATE_FILE, state).catch(() => {
      // Losing a filter preference is not worth interrupting triage.
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

  const loadSignals = useCallback(
    async (force: boolean, sessionOverride?: string): Promise<void> => {
      const sessionPath = sessionOverride ?? stateRef.current.sessionPath;
      setSignals({ kind: 'loading' });
      setSignals(await fetchSignals(sessionPath, force));
    },
    [],
  );

  const loadBrief = useCallback(async (force: boolean): Promise<void> => {
    setSavedNote(null);
    setBrief({ kind: 'loading' });
    setBrief(await fetchBrief(stateRef.current.sessionPath, force));
  }, []);

  const loadSavedBriefs = useCallback(async (): Promise<void> => {
    setSavedBriefs({ kind: 'loading' });
    try {
      const rootFiles = await fileApi.listFiles('/');
      const hasDir = Array.isArray(rootFiles)
        ? rootFiles.some((file) => file.name === 'briefs')
        : false;
      if (!hasDir) {
        setSavedBriefs({
          kind: 'empty',
          reason: '저장된 브리프가 없습니다.',
          fetchedAt: Date.now(),
        });
        return;
      }
      const files = await fileApi.listFiles('/briefs');
      const names = (Array.isArray(files) ? files : [])
        .map((file) => file.name)
        .filter(isBriefFileName)
        .sort()
        .reverse();
      setSavedBriefs(
        names.length === 0
          ? { kind: 'empty', reason: '저장된 브리프가 없습니다.', fetchedAt: Date.now() }
          : { kind: 'ready', data: names, fetchedAt: Date.now() },
      );
    } catch (error) {
      // Listing failure is a read failure, not "no briefs".
      const message = error instanceof Error ? error.message : String(error);
      setSavedBriefs({
        kind: 'error',
        message: `브리프 목록을 읽지 못했습니다: ${message}`,
        fetchedAt: Date.now(),
      });
    }
  }, [fileApi]);

  const saveBrief = useCallback(async (): Promise<void> => {
    const current = briefRef.current;
    if (current.kind !== 'ready') {
      return;
    }
    const doc = current.data.brief;
    try {
      await fileApi.writeFile(briefFilePath(doc.date), doc);
      setSavedNote(`저장됨 · ${briefFilePath(doc.date)}`);
      await loadSavedBriefs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSavedNote(`저장 실패: ${message}`);
    }
  }, [fileApi, loadSavedBriefs]);

  const openSavedBrief = useCallback(
    async (name: string): Promise<void> => {
      setOpenedBrief({ kind: 'loading', name });
      try {
        const result = await fileApi.readFile(`/briefs/${name}`);
        const doc = parseBriefDoc(result?.content);
        if (!doc) {
          setOpenedBrief({
            kind: 'error',
            name,
            message: '브리프 파일 형식이 올바르지 않습니다.',
          });
          return;
        }
        setOpenedBrief({ kind: 'ready', name, doc });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setOpenedBrief({ kind: 'error', name, message: `읽지 못했습니다: ${message}` });
      }
    },
    [fileApi],
  );

  /**
   * Operator-click only. This spawns an AoiResearch run (LLM + web pipeline),
   * which is exactly the class of action the agent surface must not reach —
   * see DELIBERATELY_UNEXPOSED_ACTIONS and __tests__/actionSafety.test.ts.
   */
  const runHandoff = useCallback(async (item: SignalItem): Promise<void> => {
    const sessionPath = stateRef.current.sessionPath.trim();
    if (!sessionPath) {
      return;
    }
    setResearch({ kind: 'starting', itemId: item.id });
    try {
      const response = await startAoiResearchRun({
        sessionPath,
        request: composeResearchRequest(item),
      });
      setResearch({
        kind: 'started',
        itemId: item.id,
        message: response.background
          ? '리서치가 백그라운드에서 시작되었습니다. Aoi Research 앱에서 확인하세요.'
          : '리서치가 시작되었습니다. Aoi Research 앱에서 확인하세요.',
      });
    } catch (error) {
      setResearch(classifyResearchFailure(item.id, error));
    }
  }, []);

  const toggleRow = useCallback((id: string): void => {
    setExpandedId((current) => (current === id ? null : id));
    setState((current) =>
      current.seenIds.includes(id)
        ? current
        : { ...current, seenIds: markSeen(current.seenIds, id) },
    );
  }, []);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case ActionTypes.SELECT_VIEW: {
          const view = action.params?.view;
          if (!isSignalDeskViewId(view)) {
            return `error: unknown view ${String(view)}`;
          }
          setState((current) => ({ ...current, activeView: view }));
          return 'success';
        }
        case ActionTypes.REFRESH_SIGNALS: {
          await loadSignals(true);
          return 'success';
        }
        case ActionTypes.SYNC_STATE: {
          await loadState();
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [loadSignals, loadState],
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
          windowStyle: { width: 1240, height: 800 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        const sessionPath = await loadState();
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
        void loadSignals(false, sessionPath);
      } catch (error) {
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [loadSignals, loadState]);

  useEffect(() => {
    if (state.activeView !== 'brief') {
      return;
    }
    if (brief.kind === 'idle') {
      void loadBrief(false);
    }
    if (savedBriefs.kind === 'idle') {
      void loadSavedBriefs();
    }
  }, [state.activeView, brief.kind, savedBriefs.kind, loadBrief, loadSavedBriefs]);

  const nowMs = Date.now();
  const categoryCounts = signals.kind === 'ready' ? countByCategory(signals.data.items) : null;

  return (
    <div
      className={styles.root}
      data-compact={compact ? 'true' : undefined}
      ref={rootRef}
      data-testid="signal-desk"
    >
      <header className={styles.strip}>
        <nav className={styles.rail} aria-label="Signal Desk 섹션">
          {SIGNAL_DESK_VIEWS.map((view) => {
            const { label, Icon } = VIEW_META[view];
            return (
              <button
                key={view}
                type="button"
                className={styles.railItem}
                data-active={state.activeView === view ? 'true' : undefined}
                data-testid={`signal-desk-rail-${view}`}
                onClick={() => setState((current) => ({ ...current, activeView: view }))}
              >
                <Icon size={14} />
                <span className={styles.railLabel}>{label}</span>
              </button>
            );
          })}
        </nav>

        {/* Collection honesty at a glance: how old the snapshot is, whether it
            came from cache, and whether interest weighting actually applied. */}
        <p className={styles.summary} data-testid="signal-desk-meta">
          {signals.kind === 'ready' ? (
            <>
              <span
                className={styles.statusDot}
                data-cache={signals.data.cache}
                aria-hidden="true"
              />
              <span className={styles.summaryLabel}>
                {formatCacheAge(nowMs, signals.data.fetchedAt, signals.data.cache)} ·{' '}
                {describeInterestMeta(signals.data.interest)}
              </span>
            </>
          ) : (
            <span className={styles.summaryLabel}>
              실피드 트리아지 — CVE/KEV · MSRC · 커널 리서치 · arXiv · 릴리스
            </span>
          )}
        </p>

        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void loadSignals(true)}
          disabled={signals.kind === 'loading'}
          data-loading={signals.kind === 'loading' ? 'true' : undefined}
          data-testid="signal-desk-refresh"
          aria-label="다시 수집"
        >
          <RefreshCw size={14} />
        </button>

        <label className={styles.sessionField}>
          <Terminal size={12} aria-hidden="true" />
          <input
            className={styles.session}
            value={state.sessionPath}
            placeholder="sessionPath (예: aoi/space_adventure)"
            data-testid="signal-desk-session"
            onChange={(event) =>
              setState((current) => ({ ...current, sessionPath: event.target.value }))
            }
          />
        </label>
      </header>

      <main className={styles.content}>
        {state.activeView === 'inbox' ? (
          <>
            <div className={styles.chips} role="group" aria-label="카테고리 필터">
              {CATEGORY_FILTERS.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={styles.chip}
                  data-active={state.category === category ? 'true' : undefined}
                  data-cat={category === 'all' ? undefined : category}
                  data-testid={`signal-desk-chip-${category}`}
                  onClick={() => setState((current) => ({ ...current, category }))}
                >
                  {CATEGORY_LABELS[category]}
                  {categoryCounts ? (
                    <span className={styles.chipCount}>{categoryCounts[category]}</span>
                  ) : null}
                </button>
              ))}
            </div>

            <StatePanel
              title="Inbox"
              subtitle="점수순 신호 — 근거 칩과 함께. 클릭하면 펼쳐지고 본 것으로 표시됩니다."
              state={signals}
            >
              {(data) => {
                const summary = summarizeOutcomes(data.sources);
                const allFailed = summary.total > 0 && summary.okCount === 0;
                const visible = filterSignals(data.items, state.category);
                return (
                  <div className={styles.inboxBody}>
                    {allFailed ? (
                      <p className={styles.allFailed} data-testid="signal-desk-all-failed">
                        모든 소스({summary.total}개) 수집 실패 — 빈 것이 아니라 읽지 못한 것입니다.
                        Sources 탭에서 사유를 확인하세요.
                      </p>
                    ) : summary.failedNames.length > 0 ? (
                      <p className={styles.partial} data-testid="signal-desk-partial">
                        소스 {summary.failedNames.length}개 수집 실패(
                        {summary.failedNames.join(', ')}) — 아래 목록은 부분 결과입니다.
                      </p>
                    ) : null}

                    {visible.length === 0 && !allFailed ? (
                      <p className={styles.emptyNote} data-testid="signal-desk-inbox-empty">
                        {state.category === 'all'
                          ? '수집된 신호가 없습니다.'
                          : `${CATEGORY_LABELS[state.category]} 카테고리에 신호가 없습니다.`}
                      </p>
                    ) : null}

                    <ul className={styles.list}>
                      {visible.map((item) => {
                        const seen = state.seenIds.includes(item.id);
                        const expanded = expandedId === item.id;
                        const rowResearch =
                          research.kind !== 'idle' && research.itemId === item.id ? research : null;
                        const PhaseIcon = rowResearch
                          ? RESEARCH_STATE_ICONS[rowResearch.kind]
                          : null;
                        return (
                          <li
                            key={item.id}
                            className={styles.row}
                            data-seen={seen ? 'true' : undefined}
                            data-cat={item.category}
                            data-testid={`signal-desk-row-${item.id}`}
                          >
                            <button
                              type="button"
                              className={styles.rowMain}
                              data-expanded={expanded ? 'true' : undefined}
                              onClick={() => toggleRow(item.id)}
                            >
                              <span
                                className={styles.score}
                                data-tier={scoreTier(item.score)}
                                data-kev={item.kev ? 'true' : undefined}
                              >
                                {item.score}
                              </span>
                              <span className={styles.rowTitle}>{item.title}</span>
                              <span className={styles.rowBadges}>
                                {item.kev ? <span className={styles.kevBadge}>KEV</span> : null}
                                {item.duplicateCount > 0 ? (
                                  <span className={styles.dupBadge}>
                                    x{item.duplicateCount + 1}
                                  </span>
                                ) : null}
                                <span className={styles.catBadge}>
                                  {CATEGORY_LABELS[item.category]}
                                </span>
                              </span>
                              <span className={styles.rowMeta}>
                                {item.sourceName} · {formatRelativeTime(nowMs, item.publishedAt)}
                              </span>
                              <ChevronRight
                                size={13}
                                className={styles.chevron}
                                aria-hidden="true"
                              />
                            </button>

                            {expanded ? (
                              <div
                                className={styles.expand}
                                data-testid={`signal-desk-expand-${item.id}`}
                              >
                                {item.summary ? (
                                  <p className={styles.summaryText}>{item.summary}</p>
                                ) : (
                                  <p className={styles.noSummary}>
                                    요약이 제공되지 않은 항목입니다.
                                  </p>
                                )}
                                <div className={styles.reasons}>
                                  {item.scoreReasons.map((reason) => (
                                    <span key={reason} className={styles.reason}>
                                      {reason}
                                    </span>
                                  ))}
                                </div>
                                {item.cveIds.length > 0 ? (
                                  <p className={styles.cves}>CVE: {item.cveIds.join(', ')}</p>
                                ) : null}
                                {item.otherSources.length > 0 ? (
                                  <p className={styles.others}>
                                    중복 출처: {item.otherSources.join(', ')}
                                  </p>
                                ) : null}
                                <div className={styles.rowActions}>
                                  <button
                                    type="button"
                                    className={styles.secondary}
                                    onClick={() =>
                                      window.open(item.url, '_blank', 'noopener,noreferrer')
                                    }
                                    data-testid="signal-desk-open-url"
                                  >
                                    <ExternalLink size={12} aria-hidden="true" />
                                    원문 열기
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.primary}
                                    disabled={
                                      !state.sessionPath.trim() || research.kind === 'starting'
                                    }
                                    onClick={() => void runHandoff(item)}
                                    data-testid="signal-desk-handoff"
                                  >
                                    <FlaskConical size={12} aria-hidden="true" />
                                    Research 인계
                                  </button>
                                  {!state.sessionPath.trim() ? (
                                    <span
                                      className={styles.hint}
                                      data-testid="signal-desk-need-session"
                                    >
                                      sessionPath 를 입력하면 인계할 수 있습니다.
                                    </span>
                                  ) : null}
                                </div>
                                {rowResearch && PhaseIcon ? (
                                  <p
                                    className={styles.research}
                                    data-variant={rowResearch.kind}
                                    data-testid="signal-desk-research-state"
                                  >
                                    <PhaseIcon
                                      size={13}
                                      className={styles.researchIcon}
                                      aria-hidden="true"
                                    />
                                    <span>
                                      {rowResearch.kind === 'starting'
                                        ? '리서치 시작 중…'
                                        : rowResearch.message}
                                    </span>
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              }}
            </StatePanel>
          </>
        ) : null}

        {state.activeView === 'brief' ? (
          <div className={styles.briefView}>
            <StatePanel
              title="오늘의 브리프"
              subtitle="현재 수집 스냅샷에서 서버가 구성합니다."
              state={brief}
              actions={
                <div className={styles.panelActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => void loadBrief(true)}
                    disabled={brief.kind === 'loading'}
                    data-testid="signal-desk-brief-generate"
                  >
                    새로 생성
                  </button>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => void saveBrief()}
                    disabled={brief.kind !== 'ready'}
                    data-testid="signal-desk-brief-save"
                  >
                    저장
                  </button>
                </div>
              }
            >
              {(data) => (
                <>
                  <BriefDocContent doc={data.brief} />
                  {savedNote ? (
                    <p className={styles.savedNote} data-testid="signal-desk-brief-saved-note">
                      {savedNote}
                    </p>
                  ) : null}
                </>
              )}
            </StatePanel>

            <StatePanel title="저장된 브리프" state={savedBriefs}>
              {(names) => (
                <ul className={styles.savedList} data-testid="signal-desk-saved-list">
                  {names.map((name) => (
                    <li key={name} className={styles.savedItem}>
                      <button
                        type="button"
                        className={styles.savedButton}
                        onClick={() => void openSavedBrief(name)}
                        data-testid={`signal-desk-saved-${name}`}
                      >
                        <NotebookText size={12} aria-hidden="true" />
                        {briefNameToDate(name)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </StatePanel>

            {openedBrief.kind === 'loading' ? (
              <p className={styles.emptyNote}>{openedBrief.name} 여는 중…</p>
            ) : null}
            {openedBrief.kind === 'error' ? (
              <p className={styles.openedError} data-testid="signal-desk-opened-error">
                {openedBrief.name}: {openedBrief.message}
              </p>
            ) : null}
            {openedBrief.kind === 'ready' ? (
              <StatePanel
                title={`저장본 · ${briefNameToDate(openedBrief.name)}`}
                state={{ kind: 'ready', data: openedBrief.doc, fetchedAt: nowMs }}
              >
                {(doc) => <BriefDocContent doc={doc} />}
              </StatePanel>
            ) : null}
          </div>
        ) : null}

        {state.activeView === 'sources' ? (
          <StatePanel
            title="Sources"
            subtitle="고정 레지스트리 — 실패는 사유와 함께, 0건과 구분해서 표시합니다."
            state={signals}
          >
            {(data) => {
              const summary = summarizeOutcomes(data.sources);
              return (
                <div className={styles.sourcesBody}>
                  <p
                    className={styles.sourcesAgg}
                    data-degraded={summary.okCount < summary.total ? 'true' : undefined}
                  >
                    {summary.okCount}/{summary.total} 정상
                  </p>
                  <ul className={styles.sourceList} data-testid="signal-desk-sources">
                    {data.sources.map((source) => (
                      <li
                        key={source.sourceId}
                        className={styles.sourceRow}
                        data-ok={source.ok ? 'true' : 'false'}
                        data-cat={source.category}
                        data-testid={`signal-desk-source-${source.sourceId}`}
                      >
                        <span className={styles.srcDot} aria-hidden="true" />
                        <span className={styles.sourceName}>{source.name}</span>
                        <span className={styles.sourceKind}>{source.kind}</span>
                        <span className={styles.sourceCat}>{CATEGORY_LABELS[source.category]}</span>
                        {source.ok ? (
                          <span className={styles.sourceOk}>
                            정상 · {source.itemCount}건 · {source.ms}ms
                          </span>
                        ) : (
                          <span className={styles.sourceFail}>
                            실패 · {source.error || '원인 불명'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            }}
          </StatePanel>
        ) : null}
      </main>
    </div>
  );
}

export default SignalDesk;
