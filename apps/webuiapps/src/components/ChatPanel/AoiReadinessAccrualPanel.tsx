import React, { useCallback, useEffect, useState } from 'react';

import {
  AOI_READINESS_ACCRUAL_ROUTE,
  parseAoiReadinessAccrualResponse,
  summarizeAoiReadinessAccrual,
} from '@/lib/aoiReadinessAccrualPanelModel';
import type { AoiProactiveTrendAdvisorReadiness } from '@/lib/aoiAutonomyTypes';

import styles from './index.module.scss';

// P5.4: surface the trust on-ramp readiness accrual (sample count -> directChatReady +
// blockers) so the operator can see the trust ladder progress. Read-only display.
export const AoiReadinessAccrualPanel: React.FC = () => {
  const [readiness, setReadiness] = useState<AoiProactiveTrendAdvisorReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(AOI_READINESS_ACCRUAL_ROUTE);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const parsed = parseAoiReadinessAccrualResponse(await response.json());
      if (parsed) {
        setReadiness(parsed);
      } else {
        setError('No readiness accrual available.');
      }
    } catch (err) {
      setError(`Failed to load readiness accrual: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-readiness-accrual-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Trust On-ramp</div>
        <span className={styles.modelHint}>readiness accrual</span>
      </div>
      {loading ? <div className={styles.modelHint}>Loading readiness...</div> : null}
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {readiness ? (
        <div data-testid="aoi-readiness-accrual-body">
          <div className={styles.modelHint}>{summarizeAoiReadinessAccrual(readiness)}</div>
          <div>Status: {readiness.status}</div>
          <div>Field samples: {readiness.sampleCount}</div>
          <div>Direct-chat ready: {readiness.directChatReady ? 'yes' : 'no'}</div>
          {readiness.directChatBlockedReasons.length > 0 ? (
            <div>Blockers: {readiness.directChatBlockedReasons.join(', ')}</div>
          ) : null}
          {readiness.summary ? <div className={styles.modelHint}>{readiness.summary}</div> : null}
        </div>
      ) : null}
    </div>
  );
};
