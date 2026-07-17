import React, { useCallback, useEffect, useState } from 'react';

import {
  AOI_DECAY_APPLY_ROUTE,
  AOI_DECAY_PREVIEW_ROUTE,
  AOI_DECAY_RESTORE_ROUTE,
  buildAoiDecayApplyBody,
  parseAoiDecayApplyResponse,
  parseAoiDecayPreviewResponse,
  type AoiDecayApplyResult,
  type AoiDecayPreview,
} from '@/lib/aoiMemoryDecayPanelModel';

import styles from './index.module.scss';

// P4.1: operator surface for memory decay/forgetting. Preview archive candidates ->
// approve-to-archive (content-addressed: the server re-derives the fingerprint and rejects
// on any drift, so a wrong id-set can only 409) -> restore. Soft-delete only; every write
// goes through the fingerprint-gated routes.
export const AoiMemoryDecayPanel: React.FC<{ sessionPath: string }> = ({ sessionPath }) => {
  const [preview, setPreview] = useState<AoiDecayPreview | null>(null);
  const [applyResult, setApplyResult] = useState<AoiDecayApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadPreview = useCallback(async () => {
    setBusy(true);
    setError('');
    setApplyResult(null);
    try {
      const response = await fetch(AOI_DECAY_PREVIEW_ROUTE);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const parsed = parseAoiDecayPreviewResponse(await response.json());
      if (parsed) {
        setPreview(parsed);
      } else {
        setError('No decay preview available.');
      }
    } catch (err) {
      setError(`Failed to load decay preview: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const archive = useCallback(async () => {
    if (!preview || preview.candidates.length === 0) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(AOI_DECAY_APPLY_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAoiDecayApplyBody(preview, sessionPath)),
      });
      const parsed = parseAoiDecayApplyResponse(await response.json(), sessionPath);
      if (!parsed) {
        setError('Archive failed: unexpected response.');
      } else if (parsed.rejected) {
        setError('Archive rejected: the reviewed set drifted -- reload the preview and retry.');
      } else {
        setApplyResult(parsed);
        setPreview(null);
      }
    } catch (err) {
      setError(`Archive failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [preview, sessionPath]);

  const restore = useCallback(async () => {
    if (!applyResult || applyResult.changedIds.length === 0) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(AOI_DECAY_RESTORE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath, ids: applyResult.changedIds }),
      });
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      setApplyResult(null);
      await loadPreview();
    } catch (err) {
      setError(`Restore failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyResult, loadPreview, sessionPath]);

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-memory-decay-panel">
      <div className={styles.settingsSectionHeader}>
        <div className={styles.settingsSectionTitle}>Aoi Memory Decay</div>
        <span className={styles.modelHint}>soft-delete, operator-approved</span>
      </div>
      <div className={styles.modelHint}>Audit session: {sessionPath}</div>
      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {preview ? (
        <div data-testid="aoi-memory-decay-preview">
          <div className={styles.modelHint}>
            {preview.candidates.length} archive candidate(s) of {preview.totalActive} active
            memory(ies).
          </div>
          {preview.candidates.slice(0, 8).map((candidate) => (
            <div key={candidate.id}>
              {candidate.contentPreview} ({candidate.reasons.join(', ')})
            </div>
          ))}
          <button
            type="button"
            className={styles.inlineActionBtn}
            disabled={busy || preview.candidates.length === 0}
            onClick={() => void archive()}
            data-testid="aoi-memory-decay-archive-btn"
          >
            Archive {preview.candidates.length} candidate(s)
          </button>
        </div>
      ) : null}
      {applyResult ? (
        <div data-testid="aoi-memory-decay-applied">
          <div className={styles.modelHint}>Archived {applyResult.archivedCount} memory(ies).</div>
          <button
            type="button"
            className={styles.inlineActionBtn}
            disabled={busy}
            onClick={() => void restore()}
            data-testid="aoi-memory-decay-restore-btn"
          >
            Restore archived memory(ies)
          </button>
        </div>
      ) : null}
    </div>
  );
};
