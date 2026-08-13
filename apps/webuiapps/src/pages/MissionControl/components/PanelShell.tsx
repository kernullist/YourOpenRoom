import React from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { formatRelativeTime, isPanelStale, type PanelTone } from '../format';
import type { PanelState } from '../types';
import styles from './PanelShell.module.scss';

interface StatusBadgeProps {
  tone: PanelTone;
  label: string;
  pulse?: boolean;
  title?: string;
}

export function StatusBadge({ tone, label, pulse, title }: StatusBadgeProps): JSX.Element {
  return (
    <span className={styles.badge} data-tone={tone} title={title}>
      <span className={styles.badgeDot} data-pulse={pulse ? 'true' : undefined} />
      {label}
    </span>
  );
}

interface PanelShellProps<T> {
  title: string;
  subtitle?: string;
  state: PanelState<T>;
  now: number;
  refreshIntervalMs: number;
  onRetry?: () => void;
  actions?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}

/**
 * The single place every section's four states are rendered.
 *
 * Sections receive a render function for the ready case only, so there is no
 * path by which one of them can quietly draw a failed read as an empty list --
 * the distinction is structural, not a convention each section has to remember.
 */
export function PanelShell<T>({
  title,
  subtitle,
  state,
  now,
  refreshIntervalMs,
  onRetry,
  actions,
  children,
}: PanelShellProps<T>): JSX.Element {
  const stale = isPanelStale(state, now, refreshIntervalMs);
  const fetchedAt = state.kind === 'idle' || state.kind === 'loading' ? null : state.fetchedAt;

  return (
    <section className={styles.panel} data-state={state.kind}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>{title}</h2>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        <div className={styles.headerMeta}>
          {stale ? (
            <StatusBadge
              tone="warn"
              label="STALE"
              title="마지막 성공 조회가 갱신 주기의 3배를 넘었습니다. 아래 데이터는 그 시점 기준입니다."
            />
          ) : null}
          {fetchedAt !== null ? (
            <span className={styles.fetchedAt}>{formatRelativeTime(fetchedAt, now)}</span>
          ) : null}
          {actions}
        </div>
      </header>

      {state.kind === 'idle' || state.kind === 'loading' ? (
        <div className={styles.placeholder}>
          <Loader2 className={styles.spinner} size={16} />
          <span>불러오는 중…</span>
        </div>
      ) : null}

      {state.kind === 'empty' ? (
        // Visually distinct from the error case on purpose: "nothing happened
        // yet" and "we could not look" must never read the same.
        <div className={styles.placeholder} data-variant="empty">
          <Inbox size={16} />
          <span>{state.reason}</span>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className={styles.placeholder} data-variant="error">
          <AlertTriangle size={16} />
          <div className={styles.errorBody}>
            <span className={styles.errorMessage}>{state.message}</span>
            <span className={styles.errorMeta}>
              {state.status ? `HTTP ${state.status}` : '전송 실패'}
              {state.code ? ` · ${state.code}` : ''}
            </span>
          </div>
          {onRetry ? (
            <button type="button" className={styles.retry} onClick={onRetry}>
              <RefreshCw size={13} />
              다시 시도
            </button>
          ) : null}
        </div>
      ) : null}

      {state.kind === 'ready' ? <div className={styles.body}>{children(state.data)}</div> : null}
    </section>
  );
}

export default PanelShell;
