import React, { useCallback, useEffect, useState } from 'react';

import {
  buildAoiOperatorSnapshotRoute,
  parseAoiOperatorSnapshotResponse,
  summarizeAoiOperatorSnapshotHeadline,
} from '@/lib/aoiOperatorSnapshotPanelModel';
import type { AoiUnifiedOperatorSnapshotSummary } from '@/lib/aoiUnifiedOperatorModel';

import styles from './index.module.scss';

// P5.3: surface the (previously dark) unified operator model in the UI. Read-only +
// display_only -- it fetches the server-built snapshot summary and renders it; it never
// mutates or acts. Mirrors AoiReplayPromotionPanel's self-contained fetch pattern.
export const AoiOperatorSnapshotPanel: React.FC<{ sessionPath: string }> = ({ sessionPath }) => {
  const [summary, setSummary] = useState<AoiUnifiedOperatorSnapshotSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError('');
      setSummary(null);
      try {
        const response = await fetch(buildAoiOperatorSnapshotRoute(sessionPath), { signal });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const parsed = parseAoiOperatorSnapshotResponse(await response.json(), sessionPath);
        if (signal.aborted) {
          return;
        }
        if (parsed) {
          setSummary(parsed);
        } else {
          setError('No session-matched operator snapshot available.');
        }
      } catch (err) {
        if (!signal.aborted) {
          setError(`Failed to load operator snapshot: ${String(err)}`);
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    },
    [sessionPath],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const currentSummary = summary?.sessionPath === sessionPath ? summary : null;

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-operator-snapshot-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Operator Snapshot</div>
        <span className={styles.modelHint}>display-only</span>
      </div>
      {loading ? <div className={styles.modelHint}>Loading operator snapshot...</div> : null}
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {currentSummary ? (
        <div data-testid="aoi-operator-snapshot-body">
          <div className={styles.modelHint}>
            {summarizeAoiOperatorSnapshotHeadline(currentSummary)}
          </div>
          <div>Session: {currentSummary.sessionPath}</div>
          <div>Readiness: {currentSummary.readiness}</div>
          <div>Interruption: {currentSummary.interruption}</div>
          <div>Blind spots: {currentSummary.blindSpotCount}</div>
          <div>Authority: {currentSummary.actionAuthority}</div>
          {currentSummary.topInterestLabels.length > 0 ? (
            <div>Top interests: {currentSummary.topInterestLabels.join(', ')}</div>
          ) : null}
          {currentSummary.summary ? (
            <div className={styles.modelHint}>{currentSummary.summary}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
