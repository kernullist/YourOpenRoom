import type { AoiProposal } from '@/lib/aoiAutonomyTypes';
import { formatRelativeTime, riskTone, truncate } from '../format';
import type { PanelState } from '../types';
import type { ProposalDecisionAction } from '../api';
import PanelShell, { StatusBadge } from './PanelShell';
import ProposalInspector from './ProposalInspector';
import styles from './QueueSection.module.scss';

interface QueueSectionProps {
  proposals: PanelState<AoiProposal[]>;
  selectedProposal: AoiProposal | null;
  selectedProposalId: string | null;
  busyProposalId: string | null;
  now: number;
  refreshIntervalMs: number;
  compact: boolean;
  onSelect: (proposalId: string | null) => void;
  onDecide: (proposalId: string, action: ProposalDecisionAction) => void;
  onRetry: () => void;
}

export function QueueSection({
  proposals,
  selectedProposal,
  selectedProposalId,
  busyProposalId,
  now,
  refreshIntervalMs,
  compact,
  onSelect,
  onDecide,
  onRetry,
}: QueueSectionProps): JSX.Element {
  return (
    <div className={styles.layout} data-inspector={selectedProposal ? 'open' : undefined}>
      <div className={styles.listColumn}>
        <PanelShell
          title="Proposal Queue"
          subtitle="승인·거절은 오퍼레이터 조작으로만 이루어집니다."
          state={proposals}
          now={now}
          refreshIntervalMs={refreshIntervalMs}
          onRetry={onRetry}
        >
          {(items) => (
            <ul className={styles.list} data-testid="mission-control-proposal-list">
              {items.map((proposal) => (
                <li key={proposal.id}>
                  <button
                    type="button"
                    className={styles.row}
                    data-active={proposal.id === selectedProposalId ? 'true' : undefined}
                    onClick={() =>
                      onSelect(proposal.id === selectedProposalId ? null : proposal.id)
                    }
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowTitle}>{proposal.title}</span>
                      <span className={styles.rowReason}>{truncate(proposal.reason, 110)}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      <StatusBadge tone={riskTone(proposal.risk)} label={proposal.risk} />
                      <span className={styles.rowLevel}>{proposal.requiredAutonomyLevel}</span>
                      <span className={styles.rowTime}>
                        {formatRelativeTime(proposal.createdAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PanelShell>
      </div>

      {selectedProposal ? (
        <ProposalInspector
          proposal={selectedProposal}
          busy={busyProposalId === selectedProposal.id}
          compact={compact}
          now={now}
          onClose={() => onSelect(null)}
          onDecide={(action) => onDecide(selectedProposal.id, action)}
        />
      ) : null}
    </div>
  );
}

export default QueueSection;
