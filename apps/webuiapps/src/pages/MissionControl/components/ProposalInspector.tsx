import { Check, Clock, X } from 'lucide-react';
import type { AoiProposal } from '@/lib/aoiAutonomyTypes';
import { formatRelativeTime, riskTone } from '../format';
import type { ProposalDecisionAction } from '../api';
import { StatusBadge } from './PanelShell';
import styles from './ProposalInspector.module.scss';

interface ProposalInspectorProps {
  proposal: AoiProposal;
  busy: boolean;
  compact: boolean;
  now: number;
  onClose: () => void;
  onDecide: (action: ProposalDecisionAction) => void;
}

function RefList({ label, refs }: { label: string; refs: string[] }): JSX.Element | null {
  if (refs.length === 0) {
    return null;
  }
  return (
    <div className={styles.block}>
      <span className={styles.blockLabel}>{label}</span>
      <ul className={styles.refs}>
        {refs.map((ref) => (
          <li key={ref}>{ref}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where an operator decides.
 *
 * The three buttons below are the ONLY path to decideProposal, and they are wired
 * straight to DOM click handlers. The agent action listener has no branch that
 * reaches them -- Aoi accepting its own proposals through its own console would
 * be self-approval, which the autonomy model forbids structurally rather than by
 * policy. See __tests__/actionSafety.test.ts, which fails if that changes.
 */
export function ProposalInspector({
  proposal,
  busy,
  compact,
  now,
  onClose,
  onDecide,
}: ProposalInspectorProps): JSX.Element {
  return (
    <aside
      className={styles.inspector}
      data-compact={compact ? 'true' : undefined}
      data-testid="mission-control-proposal-inspector"
    >
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h3 className={styles.title}>{proposal.title}</h3>
          <div className={styles.badges}>
            <StatusBadge tone={riskTone(proposal.risk)} label={proposal.risk} />
            <StatusBadge tone="info" label={proposal.requiredAutonomyLevel} />
            {proposal.requiresUserApproval ? (
              <StatusBadge tone="warn" label="APPROVAL REQUIRED" />
            ) : null}
          </div>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          <X size={15} />
        </button>
      </header>

      <div className={styles.scroll}>
        <div className={styles.block}>
          <span className={styles.blockLabel}>body</span>
          <p className={styles.text}>{proposal.body}</p>
        </div>

        <div className={styles.block}>
          <span className={styles.blockLabel}>reason</span>
          <p className={styles.text}>{proposal.reason}</p>
        </div>

        <div className={styles.metaGrid}>
          <div>
            <span className={styles.blockLabel}>trigger</span>
            <p className={styles.mono}>{proposal.trigger}</p>
          </div>
          <div>
            <span className={styles.blockLabel}>confidence</span>
            <p className={styles.mono}>{proposal.confidence.toFixed(2)}</p>
          </div>
          <div>
            <span className={styles.blockLabel}>created</span>
            <p className={styles.mono}>{formatRelativeTime(proposal.createdAt, now)}</p>
          </div>
          <div>
            <span className={styles.blockLabel}>status</span>
            <p className={styles.mono}>{proposal.status}</p>
          </div>
        </div>

        {proposal.blockedReason ? (
          <div className={styles.blocked}>
            <span className={styles.blockLabel}>blocked</span>
            <p className={styles.text}>{proposal.blockedReason}</p>
          </div>
        ) : null}

        {proposal.riskSignals.length > 0 ? (
          <div className={styles.block}>
            <span className={styles.blockLabel}>risk signals</span>
            <ul className={styles.riskSignals}>
              {proposal.riskSignals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <RefList label="suggested tools" refs={proposal.suggestedTools} />
        <RefList label="evidence" refs={proposal.evidenceRefs} />
        <RefList label="artifacts" refs={proposal.artifactRefs} />
      </div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.accept}
          disabled={busy}
          onClick={() => onDecide('accept')}
          data-testid="mission-control-proposal-accept"
        >
          <Check size={14} />
          승인
        </button>
        <button
          type="button"
          className={styles.snooze}
          disabled={busy}
          onClick={() => onDecide('snooze')}
        >
          <Clock size={14} />
          보류
        </button>
        <button
          type="button"
          className={styles.dismiss}
          disabled={busy}
          onClick={() => onDecide('dismiss')}
        >
          <X size={14} />
          거절
        </button>
      </footer>
    </aside>
  );
}

export default ProposalInspector;
