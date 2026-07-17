import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { AoiFieldEvidenceClass } from '@/lib/aoiFieldEvidenceManifest';
import {
  AOI_NON_VOICE_EVIDENCE_CLASSES,
  buildAoiNonVoiceScorecardRoute,
  describeAoiNonVoiceEvidenceClass,
  labelAoiNonVoiceEvidenceClass,
  parseAoiNonVoiceScorecardResponse,
  selectAoiNonVoiceNextEvidenceAction,
  type AoiNonVoiceScorecardPanelResult,
} from '@/lib/aoiNonVoiceScorecardPanelModel';

import styles from './index.module.scss';

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) {
    return 'No current broad validation';
  }
  return new Date(timestamp).toLocaleString();
}

export const AoiNonVoiceScorecardPanel: React.FC<{ sessionPath: string }> = ({ sessionPath }) => {
  const [evidenceClass, setEvidenceClass] = useState<AoiFieldEvidenceClass>('live_field');
  const [result, setResult] = useState<AoiNonVoiceScorecardPanelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError('');
      setResult(null);
      try {
        const response = await fetch(buildAoiNonVoiceScorecardRoute(sessionPath, evidenceClass), {
          signal,
        });
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const parsed = parseAoiNonVoiceScorecardResponse(
          await response.json(),
          sessionPath,
          evidenceClass,
        );
        if (signal.aborted) {
          return;
        }
        if (!parsed) {
          setError(
            'Scorecard provenance or claim invariants did not match this request. No readiness claim is shown.',
          );
          return;
        }
        setResult(parsed);
      } catch (cause) {
        if (!signal.aborted) {
          setError(
            `Scorecard unavailable: ${String(cause)}. Verify the daemon and active session; no readiness claim is shown.`,
          );
        }
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    },
    [evidenceClass, sessionPath],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, refreshVersion]);

  const currentResult =
    result?.requestedSessionPath === sessionPath &&
    result.requestedEvidenceClass === evidenceClass &&
    result.resolvedSessionPath === sessionPath &&
    result.resolvedEvidenceClass === evidenceClass
      ? result
      : null;
  const scorecard = currentResult?.scorecard ?? null;
  const failedGates = useMemo(
    () => scorecard?.hardGates.filter((gate) => !gate.passed) ?? [],
    [scorecard],
  );
  const passedGateCount = scorecard ? scorecard.hardGates.length - failedGates.length : 0;

  return (
    <section
      className={`${styles.settingsSectionCard} ${styles.aoiClaimConsole}`}
      data-testid="aoi-non-voice-scorecard-panel"
      aria-labelledby="aoi-non-voice-scorecard-title"
    >
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle} id="aoi-non-voice-scorecard-title">
            Aoi Non-Voice Claim Console
          </div>
          <span className={styles.modelHint}>
            canonical scorecard · display-only · voice excluded
          </span>
        </div>
        <button
          type="button"
          className={styles.inlineActionBtn}
          onClick={() => setRefreshVersion((value) => value + 1)}
          disabled={loading}
          aria-label="Refresh non-voice scorecard"
        >
          Refresh
        </button>
      </div>

      <div className={styles.aoiClaimToolbar}>
        <label htmlFor="aoi-non-voice-evidence-class">Evidence class</label>
        <select
          id="aoi-non-voice-evidence-class"
          className={styles.select}
          value={evidenceClass}
          onChange={(event) => setEvidenceClass(event.target.value as AoiFieldEvidenceClass)}
          aria-label="Evidence class"
        >
          {AOI_NON_VOICE_EVIDENCE_CLASSES.map((item) => (
            <option key={item} value={item}>
              {labelAoiNonVoiceEvidenceClass(item)}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`${styles.aoiEvidenceClassBanner} ${
          evidenceClass === 'live_field'
            ? styles.aoiEvidenceClassLive
            : styles.aoiEvidenceClassLimited
        }`}
        data-testid="aoi-non-voice-evidence-class-banner"
      >
        <strong>{labelAoiNonVoiceEvidenceClass(evidenceClass)}</strong>
        <span>{describeAoiNonVoiceEvidenceClass(evidenceClass)}</span>
      </div>

      {loading ? (
        <div className={styles.aoiClaimLoading} role="status">
          Reading canonical session evidence...
        </div>
      ) : null}
      {error ? (
        <div className={styles.aoiAutonomyError} role="alert">
          {error}
        </div>
      ) : null}

      {currentResult && scorecard ? (
        <div className={styles.aoiClaimBody} data-testid="aoi-non-voice-scorecard-body">
          <div
            className={`${styles.aoiClaimPlate} ${
              scorecard.claimEligible ? styles.aoiClaimPlateReady : styles.aoiClaimPlateBlocked
            }`}
          >
            <div>
              <div className={styles.aoiClaimEyebrow}>Canonical claim state</div>
              <div className={styles.aoiClaimVerdict} data-testid="aoi-non-voice-claim-verdict">
                {scorecard.claimEligible ? '90+ CLAIM READY' : 'NOT CLAIM READY'}
              </div>
              <div className={styles.aoiClaimLevel}>
                {scorecard.level.replace(/_/g, ' ')} · cap {scorecard.scoreCap}
              </div>
            </div>
            <div
              className={styles.aoiClaimScore}
              aria-label={`Canonical score ${scorecard.score} out of 100`}
            >
              <strong>{scorecard.score}</strong>
              <span>/100</span>
              <small>raw {scorecard.rawScore}</small>
            </div>
          </div>

          <dl className={styles.aoiAttestationRail} aria-label="Scorecard provenance">
            <div>
              <dt>Requested session</dt>
              <dd>{currentResult.requestedSessionPath}</dd>
            </div>
            <div>
              <dt>Resolved session</dt>
              <dd>{currentResult.resolvedSessionPath}</dd>
            </div>
            <div>
              <dt>Evidence class</dt>
              <dd>{labelAoiNonVoiceEvidenceClass(currentResult.resolvedEvidenceClass)}</dd>
            </div>
            <div className={styles.aoiAttestationFingerprint}>
              <dt>Manifest SHA-256</dt>
              <dd>
                <code>{scorecard.manifestFingerprint}</code>
              </dd>
            </div>
          </dl>

          <div className={styles.aoiClaimTimes}>
            <span>Evaluated {formatTimestamp(scorecard.generatedAt)}</span>
            <span>Last validated {formatTimestamp(scorecard.lastValidatedAt)}</span>
          </div>

          <div className={styles.aoiClaimNextAction} data-testid="aoi-non-voice-next-action">
            <span>Next evidence action</span>
            <strong>{selectAoiNonVoiceNextEvidenceAction(scorecard)}</strong>
          </div>

          <div className={styles.aoiClaimSection}>
            <div className={styles.aoiClaimSectionHeader}>
              <strong>Weighted axes</strong>
              <span>
                {scorecard.axes.reduce((sum, axis) => sum + axis.sampleCount, 0)} real samples
              </span>
            </div>
            <div className={styles.aoiClaimAxisList} aria-label="Non-voice score axes">
              {scorecard.axes.map((axis) => (
                <div className={styles.aoiClaimAxis} key={axis.id}>
                  <div className={styles.aoiClaimAxisHeading}>
                    <span>{axis.label}</span>
                    <strong>
                      {axis.score}/{axis.weight}
                    </strong>
                  </div>
                  <div
                    className={styles.aoiClaimAxisTrack}
                    role="progressbar"
                    aria-label={axis.label}
                    aria-valuemin={0}
                    aria-valuemax={axis.weight}
                    aria-valuenow={axis.score}
                  >
                    <span style={{ width: `${(axis.score / axis.weight) * 100}%` }} />
                  </div>
                  <div className={styles.aoiClaimAxisMeta}>
                    <span>{axis.sampleCount} samples</span>
                    <span
                      className={axis.minimumEvidenceMet ? styles.aoiGatePass : styles.aoiGateFail}
                    >
                      minimum {axis.minimumEvidenceMet ? 'met' : 'missing'}
                    </span>
                    {axis.blockers[0] ? <span>{axis.blockers[0]}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.aoiClaimSection}>
            <div className={styles.aoiClaimSectionHeader}>
              <strong>Hard gates</strong>
              <span>
                {passedGateCount}/{scorecard.hardGates.length} passed
              </span>
            </div>
            <div className={styles.aoiClaimGateList} aria-label="Non-voice hard gates">
              {[...scorecard.hardGates]
                .sort((left, right) => Number(left.passed) - Number(right.passed))
                .map((gate) => (
                  <div className={styles.aoiClaimGate} key={gate.id}>
                    <span className={gate.passed ? styles.aoiGatePass : styles.aoiGateFail}>
                      {gate.passed ? 'PASS' : 'FAIL'}
                    </span>
                    <div>
                      <strong>{gate.label}</strong>
                      <span>{gate.reason}</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
