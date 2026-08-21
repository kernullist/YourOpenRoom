import { AlertTriangle, Inbox, Loader2, Plug, ShieldAlert } from 'lucide-react';
import type { PanelState } from '../types';
import styles from './StatePanel.module.scss';

interface StatePanelProps<T> {
  title: string;
  subtitle?: string;
  state: PanelState<T>;
  actions?: React.ReactNode;
  children: (data: T, fetchedAt: number) => React.ReactNode;
}

/**
 * The one place every panel state is rendered (BridgePanel lineage).
 *
 * The kinds are kept apart because they call for different reactions:
 * `empty` means the call worked and there is nothing, `unconfigured` means the
 * dev-server plugin is not mounted (setup, not failure), `denied` means a
 * guard answered as designed, and `error` is the only one that means something
 * is actually wrong.
 */
export function StatePanel<T>({
  title,
  subtitle,
  state,
  actions,
  children,
}: StatePanelProps<T>): JSX.Element {
  return (
    <section className={styles.panel} data-state={state.kind}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{title}</h2>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        {actions}
      </header>

      {state.kind === 'idle' || state.kind === 'loading' ? (
        <div className={styles.loading}>
          <div className={styles.note}>
            <Loader2 size={15} className={styles.spinner} />
            <span>불러오는 중…</span>
          </div>
          <div className={styles.skeleton} aria-hidden="true">
            <span className={styles.skeletonBar} />
            <span className={styles.skeletonBar} />
            <span className={styles.skeletonBar} />
          </div>
        </div>
      ) : null}

      {state.kind === 'empty' ? (
        <div className={styles.note} data-variant="empty" data-testid="signal-desk-empty">
          <span className={styles.noteIcon}>
            <Inbox size={16} />
          </span>
          <span>{state.reason}</span>
        </div>
      ) : null}

      {state.kind === 'unconfigured' ? (
        <div
          className={styles.note}
          data-variant="unconfigured"
          data-testid="signal-desk-unconfigured"
        >
          <span className={styles.noteIcon}>
            <Plug size={16} />
          </span>
          <div>
            <p className={styles.noteTitle}>수집 라우트가 아직 없습니다.</p>
            <p className={styles.noteBody}>
              고장이 아니라 켜지지 않은 상태입니다. dev 서버의 signalDeskPlugin 이 이 라우트를
              제공합니다.
            </p>
          </div>
        </div>
      ) : null}

      {state.kind === 'denied' ? (
        <div className={styles.note} data-variant="denied" data-testid="signal-desk-denied">
          <span className={styles.noteIcon}>
            <ShieldAlert size={16} />
          </span>
          <span className={styles.noteBody}>{state.message}</span>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className={styles.note} data-variant="error" data-testid="signal-desk-error">
          <span className={styles.noteIcon}>
            <AlertTriangle size={16} />
          </span>
          <span className={styles.noteBody}>{state.message}</span>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div className={styles.body}>{children(state.data, state.fetchedAt)}</div>
      ) : null}
    </section>
  );
}

export default StatePanel;
