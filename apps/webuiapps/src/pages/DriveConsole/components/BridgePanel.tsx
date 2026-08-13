import { AlertTriangle, Inbox, Loader2, Lock, ShieldAlert } from 'lucide-react';
import type { BridgeState } from '../types';
import styles from './BridgePanel.module.scss';

interface BridgePanelProps<T> {
  title: string;
  subtitle?: string;
  state: BridgeState<T>;
  actions?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}

/**
 * The one place every host-bridge state is rendered.
 *
 * Four outcomes are kept apart because they call for four different reactions:
 * `empty` means nothing has happened yet, `unconfigured` means the bridge token
 * was never created (setup, not failure), `denied` means the request was fine
 * and an approval is simply missing (the system working), and `error` is the
 * only one that means something is actually wrong.
 */
export function BridgePanel<T>({
  title,
  subtitle,
  state,
  actions,
  children,
}: BridgePanelProps<T>): JSX.Element {
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
        <div className={styles.note}>
          <Loader2 size={15} className={styles.spinner} />
          <span>불러오는 중…</span>
        </div>
      ) : null}

      {state.kind === 'empty' ? (
        <div className={styles.note} data-variant="empty">
          <Inbox size={15} />
          <span>{state.reason}</span>
        </div>
      ) : null}

      {state.kind === 'unconfigured' ? (
        <div
          className={styles.note}
          data-variant="unconfigured"
          data-testid="drive-console-unconfigured"
        >
          <Lock size={15} />
          <div>
            <p className={styles.noteTitle}>호스트 브리지가 아직 설정되지 않았습니다.</p>
            <p className={styles.noteBody}>
              고장이 아니라 켜지지 않은 상태입니다. 브리지 토큰을 만들면 이 화면이 채워집니다.
            </p>
          </div>
        </div>
      ) : null}

      {state.kind === 'denied' ? (
        <div className={styles.note} data-variant="denied" data-testid="drive-console-denied">
          <ShieldAlert size={15} />
          <div>
            <p className={styles.noteTitle}>승인이 없어 거부되었습니다.</p>
            <p className={styles.noteBody}>{state.message}</p>
          </div>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className={styles.note} data-variant="error" data-testid="drive-console-error">
          <AlertTriangle size={15} />
          <span className={styles.noteBody}>{state.message}</span>
        </div>
      ) : null}

      {state.kind === 'ready' ? <div className={styles.body}>{children(state.data)}</div> : null}
    </section>
  );
}

export default BridgePanel;
