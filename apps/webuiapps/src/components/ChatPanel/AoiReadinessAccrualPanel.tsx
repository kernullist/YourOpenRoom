import React, { useCallback, useEffect, useState } from 'react';

import {
  buildAoiReadinessAccrualRoute,
  parseAoiReadinessAccrualResponse,
  summarizeAoiReadinessAccrual,
} from '@/lib/aoiReadinessAccrualPanelModel';
import type { AoiProactiveTrendAdvisorReadiness } from '@/lib/aoiAutonomyTypes';

import styles from './index.module.scss';

// P5.4: surface the trust on-ramp readiness accrual (sample count -> directChatReady +
// blockers) so the operator can see the trust ladder progress. Read-only display.
export const AoiReadinessAccrualPanel: React.FC<{ sessionPath: string }> = ({ sessionPath }) => {
  const [readiness, setReadiness] = useState<AoiProactiveTrendAdvisorReadiness | null>(null);
  const [readinessSessionPath, setReadinessSessionPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError('');
      setReadiness(null);
      setReadinessSessionPath('');
      try {
        const response = await fetch(buildAoiReadinessAccrualRoute(sessionPath), { signal });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const parsed = parseAoiReadinessAccrualResponse(await response.json(), sessionPath);
        if (signal.aborted) {
          return;
        }
        if (parsed) {
          setReadiness(parsed);
          setReadinessSessionPath(sessionPath);
        } else {
          setError('No session-matched readiness accrual available.');
        }
      } catch (err) {
        if (!signal.aborted) {
          setError(`Failed to load readiness accrual: ${String(err)}`);
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

  const currentReadiness = readinessSessionPath === sessionPath ? readiness : null;

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-readiness-accrual-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Trust On-ramp</div>
        <span className={styles.modelHint}>readiness accrual</span>
      </div>
      {loading ? <div className={styles.modelHint}>Loading readiness...</div> : null}
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {currentReadiness ? (
        <div data-testid="aoi-readiness-accrual-body">
          <div className={styles.modelHint}>{summarizeAoiReadinessAccrual(currentReadiness)}</div>
          <div>Session: {sessionPath}</div>
          <div>Status: {currentReadiness.status}</div>
          <div>Field samples: {currentReadiness.sampleCount}</div>
          <div>Direct-chat ready: {currentReadiness.directChatReady ? 'yes' : 'no'}</div>
          {currentReadiness.directChatBlockedReasons.length > 0 ? (
            <div>Blockers: {currentReadiness.directChatBlockedReasons.join(', ')}</div>
          ) : null}
          {currentReadiness.summary ? (
            <div className={styles.modelHint}>{currentReadiness.summary}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
