import React, { useCallback, useEffect, useState } from 'react';

import {
  buildAoiRelationshipHistoryRoute,
  buildAoiRelationshipHistoryViewModel,
  parseAoiRelationshipHistoryResponse,
  type AoiRelationshipHistoryViewModel,
} from '@/lib/aoiRelationshipHistoryPanelModel';

import styles from './index.module.scss';

// R4.2: the shared-history surface -- the latest "our week" retrospective, the
// weeks before it, and the milestones behind them. Read-only and display_only:
// it renders stored records and never acts. Mirrors AoiSituationPanel.
export const AoiRelationshipHistoryPanel: React.FC<{ sessionPath: string }> = ({ sessionPath }) => {
  const [view, setView] = useState<AoiRelationshipHistoryViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(buildAoiRelationshipHistoryRoute(sessionPath));
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const parsed = parseAoiRelationshipHistoryResponse(await response.json());
      if (parsed) {
        setView(buildAoiRelationshipHistoryViewModel(parsed));
      } else {
        setError('Relationship history response was malformed.');
      }
    } catch (err) {
      setError(`Failed to load the relationship history: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionPath]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-relationship-history-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Shared History</div>
        <span className={styles.modelHint}>display-only</span>
      </div>
      {loading ? <div className={styles.modelHint}>Loading shared history...</div> : null}
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {view ? (
        <div data-testid="aoi-relationship-history-body">
          <div className={styles.modelHint}>{view.summaryLabel}</div>
          {view.hasHistory ? (
            <>
              {view.latest ? (
                <div data-testid="aoi-relationship-history-latest">
                  <div>{view.latest.periodLabel}</div>
                  <div>{view.latest.narrative}</div>
                  <div className={styles.modelHint}>{view.latest.detailLabel}</div>
                </div>
              ) : null}
              {view.milestoneRows.length > 0 ? (
                <div data-testid="aoi-relationship-history-milestones">
                  {view.milestoneRows.map((row) => (
                    <div key={row.id} className={styles.modelHint}>
                      {row.dateLabel} - {row.label}
                    </div>
                  ))}
                </div>
              ) : null}
              {view.pastRows.length > 0 ? (
                <div data-testid="aoi-relationship-history-past">
                  {view.pastRows.map((row) => (
                    <div key={row.id} className={styles.modelHint}>
                      {row.periodLabel}: {row.narrative}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            // Explicitly empty rather than a vague gesture at a shared past.
            <div data-testid="aoi-relationship-history-empty" className={styles.modelHint}>
              No shared history recorded yet.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
