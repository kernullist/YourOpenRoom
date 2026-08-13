import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Pause, Play, RefreshCw, Server } from 'lucide-react';
import {
  describeAoiAutonomyRuntime,
  formatAoiRuntimeUptime,
} from '@/lib/aoiAutonomyRuntimePanelModel';
import { formatRelativeTime, runtimeStatusLabel, runtimeStatusTone } from '../format';
import {
  MISSION_CONTROL_REFRESH_INTERVALS,
  type PanelState,
  type RuntimePayload,
  type SessionChoice,
} from '../types';
import { StatusBadge } from './PanelShell';
import styles from './StatusStrip.module.scss';

interface StatusStripProps {
  runtime: PanelState<RuntimePayload>;
  sessions: PanelState<SessionChoice[]>;
  activeSessionPath: string | null;
  autoRefresh: boolean;
  refreshIntervalMs: number;
  refreshing: boolean;
  now: number;
  onSelectSession: (sessionPath: string) => void;
  onToggleAutoRefresh: () => void;
  onChangeInterval: (intervalMs: number) => void;
  onManualRefresh: () => void;
}

/**
 * The one element that never collapses, at any window width.
 *
 * Its whole job is answering "is Aoi alive right now" before the operator reads
 * anything else, so the four runtime states are surfaced verbatim rather than
 * being folded into a healthy/unhealthy boolean -- 'unreachable' and
 * 'probe_failed' mean we do not know, and that is different from both.
 */
export function StatusStrip({
  runtime,
  sessions,
  activeSessionPath,
  autoRefresh,
  refreshIntervalMs,
  refreshing,
  now,
  onSelectSession,
  onToggleAutoRefresh,
  onChangeInterval,
  onManualRefresh,
}: StatusStripProps): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);

  const view = runtime.kind === 'ready' ? runtime.data.runtime : null;
  const status = view?.status ?? 'probe_failed';
  const snapshot = view?.snapshot ?? null;

  const headline = useMemo(() => {
    if (runtime.kind === 'error') {
      return runtime.message;
    }
    if (!view) {
      return '데몬 상태를 확인하는 중…';
    }
    return describeAoiAutonomyRuntime(view);
  }, [runtime, view]);

  const sessionList = sessions.kind === 'ready' ? sessions.data : [];

  const handlePick = useCallback(
    (sessionPath: string) => {
      onSelectSession(sessionPath);
      setPickerOpen(false);
    },
    [onSelectSession],
  );

  return (
    <header className={styles.strip}>
      <div className={styles.identity}>
        <Server size={15} className={styles.icon} />
        <StatusBadge
          tone={runtime.kind === 'error' ? 'unknown' : runtimeStatusTone(status)}
          label={runtime.kind === 'error' ? 'PROBE FAILED' : runtimeStatusLabel(status)}
          pulse={status === 'running' && snapshot?.loopRunning === true}
        />
      </div>

      <p className={styles.headline} title={headline}>
        {headline}
      </p>

      <div className={styles.metrics}>
        {snapshot ? (
          <>
            <span className={styles.metric}>
              <span className={styles.metricLabel}>uptime</span>
              {formatAoiRuntimeUptime(snapshot.uptimeMs)}
            </span>
            <span className={styles.metric}>
              <span className={styles.metricLabel}>cycles</span>
              {snapshot.cyclesCompleted}
            </span>
            <span
              className={styles.metric}
              data-alert={snapshot.errorsTotal > 0 ? 'true' : undefined}
            >
              <span className={styles.metricLabel}>errors</span>
              {snapshot.errorsTotal}
            </span>
          </>
        ) : null}
      </div>

      <div className={styles.controls}>
        <div className={styles.picker}>
          <button
            type="button"
            className={styles.sessionButton}
            onClick={() => setPickerOpen((open) => !open)}
            title={activeSessionPath ?? '세션 없음'}
          >
            <span className={styles.sessionPath}>{activeSessionPath ?? '세션 없음'}</span>
            <ChevronDown size={13} />
          </button>
          {pickerOpen ? (
            <div className={styles.pickerMenu} role="listbox">
              {sessionList.length === 0 ? (
                <p className={styles.pickerEmpty}>
                  {sessions.kind === 'error'
                    ? sessions.message
                    : '자율 스토어가 초기화된 세션이 없습니다.'}
                </p>
              ) : (
                sessionList.map((session) => (
                  <button
                    key={session.sessionPath}
                    type="button"
                    role="option"
                    aria-selected={session.sessionPath === activeSessionPath}
                    className={styles.pickerItem}
                    data-active={session.sessionPath === activeSessionPath ? 'true' : undefined}
                    onClick={() => handlePick(session.sessionPath)}
                  >
                    <span className={styles.pickerPath}>{session.sessionPath}</span>
                    <span className={styles.pickerTime}>
                      {formatRelativeTime(session.updatedAt, now)}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <select
          className={styles.interval}
          value={refreshIntervalMs}
          onChange={(event) => onChangeInterval(Number(event.target.value))}
          aria-label="갱신 주기"
        >
          {MISSION_CONTROL_REFRESH_INTERVALS.map((interval) => (
            <option key={interval} value={interval}>
              {interval / 1000}s
            </option>
          ))}
        </select>

        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleAutoRefresh}
          title={autoRefresh ? '자동 갱신 일시정지' : '자동 갱신 재개'}
          aria-label={autoRefresh ? '자동 갱신 일시정지' : '자동 갱신 재개'}
        >
          {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <button
          type="button"
          className={styles.iconButton}
          onClick={onManualRefresh}
          title="지금 갱신"
          aria-label="지금 갱신"
        >
          <RefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
        </button>
      </div>
    </header>
  );
}

export default StatusStrip;
