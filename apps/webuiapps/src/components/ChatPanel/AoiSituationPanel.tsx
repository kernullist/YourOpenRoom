import React, { useCallback, useEffect, useState } from 'react';

import {
  buildAoiCognitionReadinessRoute,
  buildAoiSituationPanelViewModel,
  buildAoiSituationRoute,
  parseAoiCognitionReadinessResponse,
  parseAoiSituationResponse,
  summarizeAoiCognitionReadinessLine,
  type AoiSituationPanelViewModel,
} from '@/lib/aoiSituationPanelModel';

import styles from './index.module.scss';

// SA4.4: the operator's view of Aoi's evidence-cited "current situation" brief.
// Read-only + display_only -- it fetches the tick-fused situation and renders
// its headline, focus items with citations, and explicit blind spots; it never
// mutates or acts. Mirrors AoiOperatorSnapshotPanel's self-contained pattern.
export const AoiSituationPanel: React.FC<{ sessionPath: string }> = ({ sessionPath }) => {
  const [view, setView] = useState<AoiSituationPanelViewModel | null>(null);
  const [readinessLine, setReadinessLine] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(buildAoiSituationRoute(sessionPath));
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const parsed = parseAoiSituationResponse(await response.json());
      if (parsed) {
        setView(buildAoiSituationPanelViewModel(parsed));
      } else {
        setError('Situation response was malformed.');
      }
      // SA5.2: the grounding scorecard line is best-effort display data --
      // a failed readiness fetch never hides the situation brief itself.
      try {
        const readinessResponse = await fetch(buildAoiCognitionReadinessRoute(sessionPath));
        const scorecard = readinessResponse.ok
          ? parseAoiCognitionReadinessResponse(await readinessResponse.json())
          : null;
        setReadinessLine(scorecard ? summarizeAoiCognitionReadinessLine(scorecard) : '');
      } catch {
        setReadinessLine('');
      }
    } catch (err) {
      setError(`Failed to load the situation brief: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionPath]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-situation-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Current Situation</div>
        <span className={styles.modelHint}>display-only</span>
      </div>
      {loading ? <div className={styles.modelHint}>Loading situation brief...</div> : null}
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {view ? (
        <div data-testid="aoi-situation-panel-body">
          <div className={styles.modelHint}>{view.headline}</div>
          {readinessLine ? (
            <div data-testid="aoi-cognition-readiness-line">{readinessLine}</div>
          ) : null}
          {view.hasSituation ? (
            <>
              <div>
                State: {view.stateLabel} | confidence {view.confidenceLabel} | evidence refs{' '}
                {view.evidenceCount}
              </div>
              <div>Intent: {view.intentLabel}</div>
              {view.focusRows.length > 0 ? (
                <div data-testid="aoi-situation-focus-list">
                  {view.focusRows.map((row) => (
                    <div key={row.title} className={styles.modelHint}>
                      {row.title} (salience {row.salienceLabel}; evidence: {row.evidenceLabel})
                    </div>
                  ))}
                </div>
              ) : null}
              {view.cannotKnow.length > 0 ? (
                <div data-testid="aoi-situation-cannot-know">
                  {view.cannotKnow.map((statement) => (
                    <div key={statement} className={styles.modelHint}>
                      {statement}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
