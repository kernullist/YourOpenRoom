import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import {
  buildReviewDecisionBody,
  parseReviewQueueResponse,
  toReplayPromotionViewModel,
  type AoiOperatorReviewAction,
  type AoiReplayPromotionViewModel,
} from '@/lib/aoiReplayPromotionPanelModel';

import styles from './index.module.scss';

const API_PREFIX = '/api/aoi-autonomy';

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return fallback;
}

export interface AoiReplayPromotionPanelProps {
  sessionPath: string;
}

// Operator-only replay-promotion review panel (roadmap item 1, step 4). It is the
// operator's surface for the promotion pipeline: it lists the trace / adaptive replay
// candidates from /review-candidates and promotes / defers / rejects them via
// /review-decision. Promoting the whole set satisfies the promoted-replay gate that
// unlocks trusted_operator. The route forces actor=user, so this human review is the
// only way a promotion is ever created -- the autonomy loop cannot self-escalate.
export const AoiReplayPromotionPanel: React.FC<AoiReplayPromotionPanelProps> = ({
  sessionPath,
}) => {
  const [view, setView] = useState<AoiReplayPromotionViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState('');

  const loadQueue = useCallback(async () => {
    if (!sessionPath) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        `${API_PREFIX}/review-candidates?sessionPath=${encodeURIComponent(sessionPath)}`,
      );
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(errorMessage(payload, 'Failed to load replay candidates.'));
      }
      const queue = parseReviewQueueResponse(payload);
      if (!queue) {
        throw new Error('Unexpected review-candidates response.');
      }
      setView(toReplayPromotionViewModel(queue));
    } catch (err) {
      setView(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionPath]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const submitDecision = useCallback(
    async (kind: 'trace' | 'adaptive', candidateId: string, action: AoiOperatorReviewAction) => {
      setPendingId(candidateId);
      setError('');
      try {
        const response = await fetch(`${API_PREFIX}/review-decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildReviewDecisionBody({
              sessionPath,
              kind,
              candidateId,
              action,
              reason: reasons[candidateId],
            }),
          ),
        });
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          throw new Error(errorMessage(payload, 'Review decision failed.'));
        }
        const queue = parseReviewQueueResponse(payload);
        if (queue) {
          setView(toReplayPromotionViewModel(queue));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingId('');
      }
    },
    [reasons, sessionPath],
  );

  return (
    <div className={styles.settingsSectionCard} data-testid="aoi-replay-promotion-panel">
      <div className={styles.settingsSectionHeader}>
        <div>
          <div className={styles.settingsSectionTitle}>Aoi Replay Promotion</div>
          <span className={styles.modelHint}>
            Operator-only review of replay candidates. Promoting the full set satisfies the
            promoted-replay gate that unlocks trusted_operator; the system cannot promote on its
            own.
          </span>
        </div>
        <button
          type="button"
          className={styles.inlineActionBtn}
          onClick={() => void loadQueue()}
          disabled={loading}
          title="Refresh replay candidates"
        >
          <RotateCcw size={14} />
          Refresh
        </button>
      </div>

      {error ? <div className={styles.aoiAutonomyError}>{error}</div> : null}
      {loading ? <span className={styles.modelHint}>Loading replay candidates...</span> : null}

      {view ? (
        <>
          <span className={styles.modelHint} data-testid="aoi-replay-progress">
            {view.progressLabel}
          </span>
          {view.candidates.length > 0 ? (
            <div className={styles.connectorList}>
              {view.candidates.map((candidate) => (
                <div
                  key={candidate.candidateId}
                  className={styles.connectorRow}
                  data-testid="aoi-replay-candidate"
                >
                  <div className={styles.connectorRowHeader}>
                    <strong>{candidate.title}</strong>
                    <span className={styles.modelHint}>
                      {candidate.kind} · {candidate.statusLabel}
                    </span>
                  </div>
                  <span className={styles.modelHint}>{candidate.summary}</span>
                  <div className={styles.field}>
                    <input
                      className={styles.fieldInput}
                      value={reasons[candidate.candidateId] ?? ''}
                      onChange={(event) =>
                        setReasons((prev) => ({
                          ...prev,
                          [candidate.candidateId]: event.target.value,
                        }))
                      }
                      placeholder="Reason (required to promote or reject)"
                      aria-label="Review reason"
                      disabled={pendingId === candidate.candidateId}
                    />
                  </div>
                  <div className={styles.connectorToggleRow}>
                    <button
                      type="button"
                      className={styles.saveBtn}
                      onClick={() =>
                        void submitDecision(candidate.kind, candidate.candidateId, 'promote')
                      }
                      disabled={!candidate.canPromote || pendingId === candidate.candidateId}
                      title={
                        candidate.promotable
                          ? 'Promote this candidate into replay coverage'
                          : 'Blocked candidates cannot be promoted'
                      }
                    >
                      Promote
                    </button>
                    <button
                      type="button"
                      className={styles.inlineActionBtn}
                      onClick={() =>
                        void submitDecision(candidate.kind, candidate.candidateId, 'defer')
                      }
                      disabled={pendingId === candidate.candidateId}
                    >
                      Defer
                    </button>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      onClick={() =>
                        void submitDecision(candidate.kind, candidate.candidateId, 'reject')
                      }
                      disabled={pendingId === candidate.candidateId}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
