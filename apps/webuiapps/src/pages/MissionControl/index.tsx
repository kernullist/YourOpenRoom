import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import {
  createAppFileApi,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import {
  decideProposal,
  fetchFlight,
  fetchMetrics,
  fetchProposals,
  fetchRuntime,
  fetchScheduler,
  fetchSessions,
  fetchSnapshot,
  fetchStatus,
  fetchTimeline,
  runManualTick,
  type ProposalDecisionAction,
} from './api';
import { APP_ID, APP_NAME, APP_STORAGE_NAME } from './actions/constants';
import SectionRail from './components/SectionRail';
import StatusStrip from './components/StatusStrip';
import RuntimeSection from './components/RuntimeSection';
import QueueSection from './components/QueueSection';
import TimelineSection from './components/TimelineSection';
import FlightSection from './components/FlightSection';
import MetricsSection from './components/MetricsSection';
import {
  DEFAULT_MISSION_CONTROL_STATE,
  isMissionControlViewId,
  mergeMissionControlState,
  STRIP_PANELS,
  VIEW_PANELS,
  type MissionControlPanelKey,
  type MissionControlPanels,
  type MissionControlState,
  type MissionControlViewId,
} from './types';
import styles from './index.module.scss';

const STATE_FILE = '/state.json';
const COMPACT_MAX_WIDTH = 600;
const REGULAR_MAX_WIDTH = 1200;

const IDLE_PANELS: MissionControlPanels = {
  sessions: { kind: 'idle' },
  runtime: { kind: 'idle' },
  status: { kind: 'idle' },
  snapshot: { kind: 'idle' },
  scheduler: { kind: 'idle' },
  proposals: { kind: 'idle' },
  timeline: { kind: 'idle' },
  flight: { kind: 'idle' },
  metrics: { kind: 'idle' },
};

function widthBucket(width: number): 'compact' | 'regular' | 'expanded' {
  if (width < COMPACT_MAX_WIDTH) {
    return 'compact';
  }
  if (width < REGULAR_MAX_WIDTH) {
    return 'regular';
  }
  return 'expanded';
}

function MissionControl(): JSX.Element {
  const [panels, setPanels] = useState<MissionControlPanels>(IDLE_PANELS);
  const [state, setState] = useState<MissionControlState>(DEFAULT_MISSION_CONTROL_STATE);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [tickBusy, setTickBusy] = useState(false);
  const [bucket, setBucket] = useState<'compact' | 'regular' | 'expanded'>('regular');

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Panel -> the session its in-flight request was issued for.
  const inFlightRef = useRef<Map<MissionControlPanelKey, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  const fileApi = useMemo(() => createAppFileApi(APP_STORAGE_NAME), []);
  // Written by the state loader; guards the persistence effect so the very first
  // render does not write the defaults back over a state.json we have not read.
  const stateLoadedRef = useRef(false);

  // The session actually being observed: an explicit pin if the operator made
  // one, otherwise the newest session the server reported.
  const effectiveSessionPath = useMemo(() => {
    if (state.sessionPath) {
      return state.sessionPath;
    }
    if (panels.sessions.kind === 'ready' && panels.sessions.data.length > 0) {
      return panels.sessions.data[0].sessionPath;
    }
    return null;
  }, [state.sessionPath, panels.sessions]);
  const sessionRef = useRef(effectiveSessionPath);
  sessionRef.current = effectiveSessionPath;

  const setPanel = useCallback(
    <K extends MissionControlPanelKey>(key: K, next: MissionControlPanels[K]) => {
      setPanels((current) => ({ ...current, [key]: next }));
    },
    [],
  );

  /**
   * Load one panel.
   *
   * The in-flight guard is keyed by SESSION, not just by panel. Keying it by
   * panel alone produced the one failure this console must never have: a read
   * for session A still in flight would make the switch to session B skip its
   * own fetch, then A's response would land and be rendered under B's label --
   * the operator reading one session's queue while the strip named another.
   *
   * So a request for a different session is allowed to overlap, and the result
   * is dropped on arrival if the observed session has moved on since. A slow
   * response can no longer install data that belongs to somewhere else.
   */
  const loadPanel = useCallback(
    async (key: MissionControlPanelKey): Promise<void> => {
      const sessionPath = sessionRef.current;
      const scoped = key !== 'sessions' && key !== 'runtime';
      if (scoped && !sessionPath) {
        return;
      }
      // Session-less panels use a fixed token so they still dedupe against
      // themselves.
      const requestSession = scoped ? (sessionPath as string) : '*';
      if (inFlightRef.current.get(key) === requestSession) {
        return;
      }
      inFlightRef.current.set(key, requestSession);
      try {
        // Every branch resolves its state first, then commits only if the
        // observed session still matches what was asked for.
        const commit = <K extends MissionControlPanelKey>(
          panelKey: K,
          next: MissionControlPanels[K],
        ): void => {
          if (scoped && sessionRef.current !== requestSession) {
            return;
          }
          setPanel(panelKey, next);
        };

        switch (key) {
          case 'sessions':
            commit('sessions', await fetchSessions());
            break;
          case 'runtime':
            commit('runtime', await fetchRuntime());
            break;
          case 'status':
            commit('status', await fetchStatus(requestSession));
            break;
          case 'snapshot':
            commit('snapshot', await fetchSnapshot(requestSession));
            break;
          case 'scheduler':
            commit('scheduler', await fetchScheduler(requestSession));
            break;
          case 'proposals':
            commit('proposals', await fetchProposals(requestSession));
            break;
          case 'timeline':
            commit('timeline', await fetchTimeline(requestSession));
            break;
          case 'flight':
            commit('flight', await fetchFlight(requestSession));
            break;
          case 'metrics':
            commit('metrics', await fetchMetrics(requestSession));
            break;
          default:
            break;
        }
      } finally {
        // Only clear the slot if it is still ours; a newer request for another
        // session may have taken it over.
        if (inFlightRef.current.get(key) === requestSession) {
          inFlightRef.current.delete(key);
        }
      }
    },
    [setPanel],
  );

  const refreshView = useCallback(
    async (view: MissionControlViewId): Promise<void> => {
      setRefreshing(true);
      try {
        await Promise.allSettled(
          [...STRIP_PANELS, ...VIEW_PANELS[view]].map((key) => loadPanel(key)),
        );
      } finally {
        setRefreshing(false);
        setNow(Date.now());
      }
    },
    [loadPanel],
  );

  // Sessions once on mount: nothing else can address a route without one.
  useEffect(() => {
    void loadPanel('sessions');
  }, [loadPanel]);

  // Load whenever the view or the observed session changes. Panels for other
  // views are deliberately left alone -- polling data nobody is looking at only
  // adds disk pressure on the machine the daemon is working on.
  useEffect(() => {
    void refreshView(state.activeView);
  }, [refreshView, state.activeView, effectiveSessionPath]);

  useEffect(() => {
    if (!state.autoRefresh) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      // A hidden window cannot be read, so polling it buys nothing.
      if (document.visibilityState === 'hidden') {
        return;
      }
      void refreshView(stateRef.current.activeView);
    }, state.refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [state.autoRefresh, state.refreshIntervalMs, refreshView]);

  // Drives the relative timestamps and the staleness warning even while a poll
  // is paused -- data ages whether or not we are still asking for it.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Width comes from the element, not the viewport: this app renders inside an
  // iframe whose size has nothing to do with the browser window, so media
  // queries would report the wrong breakpoint.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setBucket(widthBucket(width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const loadPersistedState = useCallback(async (): Promise<void> => {
    try {
      // Check before reading: a missing state.json is the normal first-run case,
      // and blind-reading it produces a spurious error on every clean install.
      const rootFiles = await fileApi.listFiles('/');
      const exists = Array.isArray(rootFiles)
        ? rootFiles.some((file) => file.name === 'state.json')
        : false;
      if (!exists) {
        await fileApi.writeFile(STATE_FILE, DEFAULT_MISSION_CONTROL_STATE);
        stateLoadedRef.current = true;
        return;
      }
      const result = await fileApi.readFile(STATE_FILE);
      // readFile may hand back a string or an already-parsed object depending on
      // the storage backend; JSON.parse on the latter throws.
      const parsed =
        typeof result?.content === 'string' ? JSON.parse(result.content) : result?.content;
      setState((current) => mergeMissionControlState(current, parsed));
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
      // Persistence is a convenience; failing to save a view preference is not
      // worth interrupting an operator mid-diagnosis.
    });
  }, [fileApi, state]);

  const handleSelectView = useCallback((view: MissionControlViewId) => {
    setState((current) => ({ ...current, activeView: view }));
  }, []);

  const handleSelectSession = useCallback((sessionPath: string) => {
    setState((current) => ({ ...current, sessionPath, selectedProposalId: null }));
  }, []);

  const handleToggleAutoRefresh = useCallback(() => {
    setState((current) => ({ ...current, autoRefresh: !current.autoRefresh }));
  }, []);

  const handleChangeInterval = useCallback((refreshIntervalMs: number) => {
    setState((current) => ({ ...current, refreshIntervalMs }));
  }, []);

  const handleManualRefresh = useCallback(() => {
    void loadPanel('sessions');
    void refreshView(stateRef.current.activeView);
  }, [loadPanel, refreshView]);

  const handleSelectProposal = useCallback((proposalId: string | null) => {
    setState((current) => ({ ...current, selectedProposalId: proposalId }));
  }, []);

  const handleChangeTimelineFilter = useCallback((kind: string | null) => {
    setState((current) => ({ ...current, timelineKindFilter: kind }));
  }, []);

  /**
   * Apply an operator decision.
   *
   * Reachable only from the inspector's buttons. It is intentionally NOT called
   * from handleAgentAction -- routing a decision through an agent action would
   * let Aoi accept its own proposals, which is exactly the self-approval the
   * autonomy model forbids structurally.
   */
  const handleDecide = useCallback(
    async (proposalId: string, action: ProposalDecisionAction): Promise<void> => {
      const sessionPath = sessionRef.current;
      if (!sessionPath) {
        return;
      }
      setBusyProposalId(proposalId);
      try {
        const result = await decideProposal(sessionPath, proposalId, action);
        setToast({ tone: result.ok ? 'ok' : 'error', text: result.message });
        if (result.ok) {
          handleSelectProposal(null);
        }
        // Re-read rather than patching locally: the server may archive, block, or
        // activate a goal as a side effect, and guessing at that would put the
        // console out of step with the store it is meant to report on.
        await Promise.allSettled([loadPanel('proposals'), loadPanel('status')]);
      } finally {
        setBusyProposalId(null);
      }
    },
    [handleSelectProposal, loadPanel],
  );

  const handleManualTick = useCallback(async (): Promise<void> => {
    const sessionPath = sessionRef.current;
    if (!sessionPath) {
      return;
    }
    setTickBusy(true);
    try {
      const result = await runManualTick(sessionPath);
      setToast({ tone: result.ok ? 'ok' : 'error', text: result.message });
      await refreshView(stateRef.current.activeView);
    } finally {
      setTickBusy(false);
    }
  }, [refreshView]);

  /**
   * Agent-facing surface: read and navigate only.
   *
   * No branch here reaches decideProposal, runManualTick, or the policy route.
   * Nothing calls reportAction either -- useAgentActionListener already returns
   * an action_result through sendResult, and reporting again would deliver the
   * agent two copies of every action.
   */
  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'REFRESH_MISSION_CONTROL': {
          const requested = action.params?.view;
          const view = isMissionControlViewId(requested) ? requested : stateRef.current.activeView;
          if (isMissionControlViewId(requested)) {
            handleSelectView(requested);
          }
          await loadPanel('sessions');
          await refreshView(view);
          return 'success';
        }
        case 'SELECT_MISSION_CONTROL_VIEW': {
          const view = action.params?.view;
          if (!isMissionControlViewId(view)) {
            return `error: unknown view ${String(view)}`;
          }
          handleSelectView(view);
          return 'success';
        }
        case 'SELECT_MISSION_CONTROL_SESSION': {
          const sessionPath = action.params?.sessionPath ?? action.params?.session_path;
          if (!sessionPath) {
            return 'error: sessionPath is required';
          }
          let known = panels.sessions;
          if (known.kind !== 'ready') {
            // One fetch, not two: loadPanel('sessions') followed by a bare
            // fetchSessions() hit the route twice for the same answer.
            known = await fetchSessions();
            setPanel('sessions', known);
          }
          if (
            known.kind === 'ready' &&
            !known.data.some((entry) => entry.sessionPath === sessionPath)
          ) {
            return `error: session not found ${sessionPath}`;
          }
          handleSelectSession(sessionPath);
          return 'success';
        }
        case 'SYNC_STATE': {
          await loadPersistedState();
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [
      handleSelectSession,
      handleSelectView,
      loadPanel,
      loadPersistedState,
      panels.sessions,
      refreshView,
      setPanel,
    ],
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
          windowStyle: { width: 1280, height: 800 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await loadPersistedState();
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
  }, [loadPersistedState]);

  const pendingProposalCount =
    panels.proposals.kind === 'ready'
      ? panels.proposals.data.filter((proposal) => proposal.status === 'active').length
      : panels.status.kind === 'ready'
        ? panels.status.data.activeProposalCount
        : null;

  const selectedProposal =
    panels.proposals.kind === 'ready'
      ? (panels.proposals.data.find((proposal) => proposal.id === state.selectedProposalId) ?? null)
      : null;

  const noSessions = panels.sessions.kind === 'empty';

  return (
    <div className={styles.root} data-width={bucket} ref={rootRef} data-testid="mission-control">
      <StatusStrip
        runtime={panels.runtime}
        sessions={panels.sessions}
        activeSessionPath={effectiveSessionPath}
        autoRefresh={state.autoRefresh}
        refreshIntervalMs={state.refreshIntervalMs}
        refreshing={refreshing}
        now={now}
        onSelectSession={handleSelectSession}
        onToggleAutoRefresh={handleToggleAutoRefresh}
        onChangeInterval={handleChangeInterval}
        onManualRefresh={handleManualRefresh}
      />

      <div className={styles.body}>
        <SectionRail
          activeView={state.activeView}
          pendingProposalCount={pendingProposalCount}
          onSelect={handleSelectView}
        />

        <main className={styles.content}>
          {noSessions ? (
            <div className={styles.notice} data-testid="mission-control-no-sessions">
              <p className={styles.noticeTitle}>관측할 세션이 없습니다.</p>
              <p className={styles.noticeBody}>
                자율 스토어(<code>aoi-autonomy/policy.json</code>)가 초기화된 세션이 아직 없습니다.
                채팅에서 Aoi 자율 기능을 한 번 켜면 세션이 생성되고 이 화면이 채워집니다.
              </p>
            </div>
          ) : null}

          {state.activeView === 'runtime' ? (
            <RuntimeSection
              runtime={panels.runtime}
              status={panels.status}
              snapshot={panels.snapshot}
              scheduler={panels.scheduler}
              now={now}
              refreshIntervalMs={state.refreshIntervalMs}
              tickBusy={tickBusy}
              canTick={Boolean(effectiveSessionPath)}
              onManualTick={handleManualTick}
              onRetry={() => void refreshView('runtime')}
            />
          ) : null}

          {state.activeView === 'queue' ? (
            <QueueSection
              proposals={panels.proposals}
              selectedProposal={selectedProposal}
              selectedProposalId={state.selectedProposalId}
              busyProposalId={busyProposalId}
              now={now}
              refreshIntervalMs={state.refreshIntervalMs}
              compact={bucket === 'compact'}
              onSelect={handleSelectProposal}
              onDecide={handleDecide}
              onRetry={() => void loadPanel('proposals')}
            />
          ) : null}

          {state.activeView === 'timeline' ? (
            <TimelineSection
              timeline={panels.timeline}
              kindFilter={state.timelineKindFilter}
              now={now}
              refreshIntervalMs={state.refreshIntervalMs}
              onChangeFilter={handleChangeTimelineFilter}
              onRetry={() => void loadPanel('timeline')}
            />
          ) : null}

          {state.activeView === 'flight' ? (
            <FlightSection
              flight={panels.flight}
              now={now}
              refreshIntervalMs={state.refreshIntervalMs}
              onRetry={() => void loadPanel('flight')}
            />
          ) : null}

          {state.activeView === 'metrics' ? (
            <MetricsSection
              metrics={panels.metrics}
              now={now}
              refreshIntervalMs={state.refreshIntervalMs}
              onRetry={() => void loadPanel('metrics')}
            />
          ) : null}
        </main>
      </div>

      {toast ? (
        <div className={styles.toast} data-tone={toast.tone} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

export default MissionControl;
