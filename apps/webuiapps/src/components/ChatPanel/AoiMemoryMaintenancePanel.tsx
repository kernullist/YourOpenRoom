import React, { useCallback, useEffect, useState } from 'react';

import {
  AOI_MEMORY_MAINTENANCE_ROUTE,
  AOI_MEMORY_MAINTENANCE_RUN_ROUTE,
  buildAoiMemoryMaintenanceBody,
  describeAoiMaintenanceSource,
  formatAoiEmbeddingCoverage,
  parseAoiMemoryMaintenanceResponse,
  parseAoiMemoryMaintenanceRunResponse,
  type AoiMemoryEmbeddingCoverage,
  type AoiMemoryMaintenanceRunResult,
  type AoiMemoryMaintenanceView,
} from '@/lib/aoiMemoryMaintenancePanelModel';

import {
  describeAoiDistillerHealth,
  summarizeAoiDistillerHealth,
  type AoiDistillerHealth,
} from '@/lib/aoiMemoryDistillerHealth';

import styles from './index.module.scss';

// Operator surface for Aoi memory maintenance. These three switches used to be
// environment variables, so turning semantic memory on meant editing system env
// vars and restarting the server. They now live in config.json and are edited
// here; the env vars remain a fallback for headless deployments, which is why a
// toggle can read "on via environment".
//
// "Run now" performs one bounded pass immediately, because the periodic sweep
// only starts with the server -- without it a freshly enabled sweep would still
// be waiting for a restart.
export const AoiMemoryMaintenancePanel: React.FC = () => {
  const [view, setView] = useState<AoiMemoryMaintenanceView | null>(null);
  const [coverage, setCoverage] = useState<AoiMemoryEmbeddingCoverage | null>(null);
  const [runResult, setRunResult] = useState<AoiMemoryMaintenanceRunResult | null>(null);
  const [distiller, setDistiller] = useState<AoiDistillerHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const applyResponse = useCallback((raw: unknown): boolean => {
    const parsed = parseAoiMemoryMaintenanceResponse(raw);
    if (!parsed) {
      return false;
    }
    setView(parsed.settings);
    setCoverage(parsed.coverage);
    return true;
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    // Local diagnostic, read on every refresh so a distiller that started
    // failing shows up here instead of only in the console.
    setDistiller(summarizeAoiDistillerHealth());
    try {
      const response = await fetch(AOI_MEMORY_MAINTENANCE_ROUTE);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      if (!applyResponse(await response.json())) {
        setError('No maintenance settings available.');
      }
    } catch (err) {
      setError(`Failed to load maintenance settings: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: AoiMemoryMaintenanceView) => {
      // Optimistic: the switch flips immediately, the server response replaces
      // it (and corrects the source labels) a moment later.
      setView(next);
      setBusy(true);
      setError('');
      setRunResult(null);
      try {
        const response = await fetch(AOI_MEMORY_MAINTENANCE_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildAoiMemoryMaintenanceBody(next)),
        });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        applyResponse(await response.json());
      } catch (err) {
        setError(`Failed to save maintenance settings: ${String(err)}`);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [applyResponse, load],
  );

  const runNow = useCallback(async () => {
    setBusy(true);
    setError('');
    setRunResult(null);
    try {
      const response = await fetch(AOI_MEMORY_MAINTENANCE_RUN_ROUTE, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const body = await response.json();
      setRunResult(parseAoiMemoryMaintenanceRunResponse(body));
      applyResponse(body);
    } catch (err) {
      setError(`Maintenance run failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyResponse]);

  const renderToggle = (
    label: string,
    hint: string,
    enabled: boolean,
    source: 'config' | 'env' | 'default',
    testId: string,
    onToggle: () => void,
  ) => (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <button
        type="button"
        className={enabled ? styles.saveBtn : styles.cancelBtn}
        disabled={busy || !view}
        onClick={onToggle}
        data-testid={testId}
      >
        {enabled ? 'Enabled' : 'Disabled'}
      </button>
      <span className={styles.modelHint}>
        {hint} ({describeAoiMaintenanceSource(source)})
      </span>
    </div>
  );

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-memory-maintenance-panel">
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle}>Memory Maintenance</div>
          <span className={styles.modelHint}>
            Keeps semantic recall warm: embeds memories that have no vector yet and merges
            near-duplicates.
          </span>
        </div>
        <button
          type="button"
          className={styles.inlineActionBtn}
          disabled={busy}
          onClick={() => void load()}
          title="Reload maintenance settings"
        >
          Refresh
        </button>
      </div>

      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}

      {coverage ? (
        <div className={styles.modelHint} data-testid="aoi-memory-embedding-coverage">
          {formatAoiEmbeddingCoverage(coverage)}
          {coverage.providerModel ? ` — provider: ${coverage.providerModel}` : ''}
          {coverage.pendingCount > 0 ? ` — ${coverage.pendingCount} pending` : ''}
        </div>
      ) : null}

      {distiller ? (
        <div
          className={
            distiller.total > 0 && distiller.successRate < 0.5
              ? styles.aoiAutonomyError
              : styles.modelHint
          }
          data-testid="aoi-distiller-health"
        >
          Memory capture: {describeAoiDistillerHealth(distiller)}
          {distiller.lastOutcome === 'timeout' || distiller.lastOutcome === 'error'
            ? ' — falling back to keyword capture'
            : ''}
        </div>
      ) : null}

      {view ? (
        <>
          {renderToggle(
            'Embed backfill sweep',
            'Gives new memories a vector so recall can match meaning, not just keywords.',
            view.embedSweepEnabled,
            view.sources.embedSweep,
            'aoi-maintenance-embed-toggle',
            () => void save({ ...view, embedSweepEnabled: !view.embedSweepEnabled }),
          )}
          {renderToggle(
            'Consolidate near-duplicates',
            'Merges memories that say the same thing. Needs vectors; never deletes.',
            view.consolidationEnabled,
            view.sources.consolidation,
            'aoi-maintenance-consolidation-toggle',
            () => void save({ ...view, consolidationEnabled: !view.consolidationEnabled }),
          )}
          {renderToggle(
            'Offline local embedder',
            'Semantic recall with no API key and no network. A configured embedding key always wins.',
            view.localEmbedderEnabled,
            view.sources.localEmbedder,
            'aoi-maintenance-local-embedder-toggle',
            () => void save({ ...view, localEmbedderEnabled: !view.localEmbedderEnabled }),
          )}

          <div className={styles.field}>
            <button
              type="button"
              className={styles.inlineActionBtn}
              disabled={busy}
              onClick={() => void runNow()}
              data-testid="aoi-maintenance-run-btn"
            >
              {busy ? 'Running...' : 'Run maintenance now'}
            </button>
            <span className={styles.modelHint}>
              Runs one bounded pass immediately. The periodic sweep starts with the server, so use
              this after switching it on.
            </span>
          </div>

          {runResult ? (
            <div className={styles.modelHint} data-testid="aoi-maintenance-run-result">
              Embedded {runResult.embeddedCount}, {runResult.pendingCount} still pending; merged{' '}
              {runResult.clusterCount} cluster(s) ({runResult.supersededCount} superseded).
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
