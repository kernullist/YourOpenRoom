import React, { useCallback, useEffect, useState } from 'react';

import {
  AOI_OPERATOR_SNAPSHOT_ROUTE,
  parseAoiOperatorSnapshotResponse,
  summarizeAoiOperatorSnapshotHeadline,
} from '@/lib/aoiOperatorSnapshotPanelModel';
import type { AoiUnifiedOperatorSnapshotSummary } from '@/lib/aoiUnifiedOperatorModel';

import styles from './index.module.scss';

// P5.3: surface the (previously dark) unified operator model in the UI. Read-only +
// display_only -- it fetches the server-built snapshot summary and renders it; it never
// mutates or acts. Mirrors AoiReplayPromotionPanel's self-contained fetch pattern.
export const AoiOperatorSnapshotPanel: React.FC = () => {
  const [summary, setSummary] = useState<AoiUnifiedOperatorSnapshotSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(AOI_OPERATOR_SNAPSHOT_ROUTE);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const parsed = parseAoiOperatorSnapshotResponse(await response.json());
      if (parsed) {
        setSummary(parsed);
      } else {
        setError('No operator snapshot available.');
      }
    } catch (err) {
      setError(`Failed to load operator snapshot: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-operator-snapshot-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Operator Snapshot</div>
        <span className={styles.modelHint}>display-only</span>
      </div>
      {loading ? <div className={styles.modelHint}>Loading operator snapshot...</div> : null}
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {summary ? (
        <div data-testid="aoi-operator-snapshot-body">
          <div className={styles.modelHint}>{summarizeAoiOperatorSnapshotHeadline(summary)}</div>
          <div>Readiness: {summary.readiness}</div>
          <div>Interruption: {summary.interruption}</div>
          <div>Blind spots: {summary.blindSpotCount}</div>
          <div>Authority: {summary.actionAuthority}</div>
          {summary.topInterestLabels.length > 0 ? (
            <div>Top interests: {summary.topInterestLabels.join(', ')}</div>
          ) : null}
          {summary.summary ? <div className={styles.modelHint}>{summary.summary}</div> : null}
        </div>
      ) : null}
    </div>
  );
};
