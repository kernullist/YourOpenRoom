import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  AOI_DAEMON_HEALTH_ROUTE,
  describeAoiAutonomyRuntime,
  isAoiAutonomyRuntimeLive,
  parseAoiAutonomyRuntimeResponse,
  type AoiAutonomyRuntimeView,
} from '@/lib/aoiAutonomyRuntimePanelModel';

import styles from './index.module.scss';

// Runtime truth for the Autonomy section.
//
// Everything below this card is per-session POLICY -- it decides what the
// background loop may do, not whether a loop exists. With the daemon stopped,
// those toggles happily report "Enabled / Thinking On" while nothing runs at
// all, which is the most misleading state in the settings UI. This card answers
// the prior question first: is anything actually running?
//
// Kept deliberately cheap for an always-on daemon: it polls only while the
// section is mounted (leaving Advanced > Autonomy unmounts it), pauses while the
// tab is hidden, and the probe itself has a 2s timeout so a dead daemon cannot
// stall the panel.
const POLL_INTERVAL_MS = 15_000;

export const AoiAutonomyRuntimePanel: React.FC = () => {
  const [view, setView] = useState<AoiAutonomyRuntimeView | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const inFlightRef = useRef(false);

  const probe = useCallback(async () => {
    // Never stack probes: a hung request must not queue more of them.
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    try {
      const response = await fetch(AOI_DAEMON_HEALTH_ROUTE);
      setView(parseAoiAutonomyRuntimeResponse(response.ok ? await response.json() : null));
    } catch {
      setView({ status: 'probe_failed', port: null, snapshot: null });
    } finally {
      inFlightRef.current = false;
      setCheckedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    void probe();
    const timer = window.setInterval(() => {
      // A background tab does not need runtime status; skip the work entirely.
      if (document.visibilityState === 'visible') {
        void probe();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [probe]);

  const live = view ? isAoiAutonomyRuntimeLive(view) : false;
  const snapshot = view?.snapshot ?? null;

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-autonomy-runtime-panel">
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle}>Autonomy Runtime</div>
          <span className={styles.modelHint}>
            Whether a background loop is actually running. The settings below only take effect while
            it is.
          </span>
        </div>
        <button
          type="button"
          className={styles.inlineActionBtn}
          onClick={() => void probe()}
          title="Re-check the Aoi daemon"
        >
          Check
        </button>
      </div>

      {view ? (
        <div
          className={live ? styles.modelHint : styles.aoiAutonomyError}
          data-testid="aoi-autonomy-runtime-status"
        >
          {describeAoiAutonomyRuntime(view)}
        </div>
      ) : (
        <div className={styles.modelHint}>Checking the Aoi daemon...</div>
      )}

      {snapshot ? (
        <div className={styles.promptBudgetGrid} data-testid="aoi-autonomy-runtime-metrics">
          <div className={styles.promptBudgetMetric}>
            <span className={styles.promptBudgetLabel}>Loop</span>
            <strong>{snapshot.loopRunning ? 'running' : 'stopped'}</strong>
          </div>
          <div className={styles.promptBudgetMetric}>
            <span className={styles.promptBudgetLabel}>Thinking</span>
            <strong>{snapshot.cognitionActive ? 'active' : 'idle'}</strong>
          </div>
          <div className={styles.promptBudgetMetric}>
            <span className={styles.promptBudgetLabel}>Cycles</span>
            <strong>{snapshot.cyclesCompleted}</strong>
          </div>
          <div className={styles.promptBudgetMetric}>
            <span className={styles.promptBudgetLabel}>Errors</span>
            <strong>{snapshot.errorsTotal}</strong>
          </div>
        </div>
      ) : null}

      {snapshot?.lastCycle ? (
        <div className={styles.modelHint}>
          Last cycle: {snapshot.lastCycle.sessionsRun} run / {snapshot.lastCycle.sessionsSkipped}{' '}
          skipped of {snapshot.lastCycle.sessionsConsidered} considered,{' '}
          {snapshot.lastCycle.durationMs}ms
        </div>
      ) : null}

      {snapshot?.lastError ? (
        <div className={styles.aoiAutonomyError}>
          Last daemon error: {snapshot.lastError.message.slice(0, 200)}
        </div>
      ) : null}

      {checkedAt ? (
        <div className={styles.modelHint}>
          Checked {new Date(checkedAt).toLocaleTimeString()}
          {view?.port ? ` · daemon port ${view.port}` : ''}
        </div>
      ) : null}
    </div>
  );
};
