import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatRelativeTime, humanizeKey } from '../format';
import type { FlightPayload, PanelState } from '../types';
import PanelShell, { StatusBadge } from './PanelShell';
import styles from './FlightSection.module.scss';

interface FlightSectionProps {
  flight: PanelState<FlightPayload>;
  now: number;
  refreshIntervalMs: number;
  onRetry: () => void;
}

type Tone = 'ok' | 'warn' | 'danger' | 'unknown' | 'info';

const APPROVAL_TONES: Record<string, Tone> = {
  approved: 'ok',
  not_required: 'unknown',
  required: 'warn',
  pending: 'warn',
  expired: 'danger',
  blocked: 'danger',
  unknown: 'unknown',
};

const FRESHNESS_TONES: Record<string, Tone> = {
  fresh: 'ok',
  stale: 'warn',
  failed: 'danger',
  unknown: 'unknown',
};

// A lane says where the decision surfaced. 'direct_chat' and 'approval_request'
// actually reached the user, 'blocked' is a failure, and the rest stayed quiet --
// which is a normal outcome here, not a degraded one, so it reads neutral.
const LANE_TONES: Record<string, Tone> = {
  direct_chat: 'info',
  approval_request: 'warn',
  digest: 'info',
  dashboard: 'unknown',
  hidden: 'unknown',
  blocked: 'danger',
};

export function FlightSection({
  flight,
  now,
  refreshIntervalMs,
  onRetry,
}: FlightSectionProps): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <PanelShell
      title="Flight Recorder"
      subtitle="결정 시점의 근거, 소스 신선도, 승인 상태 기록 (display_only)"
      state={flight}
      now={now}
      refreshIntervalMs={refreshIntervalMs}
      onRetry={onRetry}
    >
      {(data) => (
        <div className={styles.wrap}>
          {data.summary ? (
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <span className={styles.tileLabel}>records</span>
                <span className={styles.tileValue}>{data.summary.totalRecordCount}</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.tileLabel}>replay drafts</span>
                <span className={styles.tileValue}>{data.summary.replayDraftCount}</span>
              </div>
              {Object.entries(data.summary.laneCounts ?? {}).map(([lane, count]) => (
                <div key={lane} className={styles.tile}>
                  <span className={styles.tileLabel}>{humanizeKey(lane)}</span>
                  <span className={styles.tileValue}>{count}</span>
                </div>
              ))}
            </div>
          ) : null}

          {data.summary && data.summary.latestBlindSpotLabels.length > 0 ? (
            <div className={styles.blindSpots}>
              <span className={styles.tileLabel}>최근 블라인드 스팟</span>
              <ul>
                {data.summary.latestBlindSpotLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.records.length === 0 ? (
            <p className={styles.noRecords}>요약은 있으나 개별 레코드가 아직 없습니다.</p>
          ) : (
            <ul className={styles.list} data-testid="mission-control-flight-list">
              {data.records.map((record) => {
                const expanded = expandedId === record.id;
                const hardFails = Object.entries(record.hardFailCounters ?? {}).filter(
                  ([, count]) => typeof count === 'number' && count > 0,
                );
                return (
                  <li key={record.id} className={styles.item}>
                    <button
                      type="button"
                      className={styles.row}
                      onClick={() => setExpandedId(expanded ? null : record.id)}
                      aria-expanded={expanded}
                    >
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span className={styles.time}>
                        {formatRelativeTime(record.createdAt, now)}
                      </span>
                      <StatusBadge
                        tone={LANE_TONES[record.decisionLane] ?? 'unknown'}
                        label={humanizeKey(record.decisionLane)}
                      />
                      <span className={styles.signal}>{record.signalClass}</span>
                      <StatusBadge
                        tone={APPROVAL_TONES[record.approvalState?.status] ?? 'unknown'}
                        label={record.approvalState?.status ?? 'unknown'}
                      />
                      {hardFails.length > 0 ? (
                        <StatusBadge tone="danger" label={`hard-fail ${hardFails.length}`} />
                      ) : null}
                    </button>

                    {expanded ? (
                      <div className={styles.detail}>
                        {record.whySpeak.length > 0 ? (
                          <div className={styles.reasonBlock}>
                            <span className={styles.tileLabel}>why speak</span>
                            <ul>
                              {record.whySpeak.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {record.whyQuiet.length > 0 ? (
                          <div className={styles.reasonBlock}>
                            <span className={styles.tileLabel}>why quiet</span>
                            <ul>
                              {record.whyQuiet.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {record.sourceStates.length > 0 ? (
                          <div className={styles.reasonBlock}>
                            <span className={styles.tileLabel}>sources</span>
                            <div className={styles.sourceRows}>
                              {record.sourceStates.map((source) => (
                                <div key={source.sourceId} className={styles.sourceRow}>
                                  <span className={styles.sourceLabel}>
                                    {source.label || source.kind}
                                  </span>
                                  <StatusBadge
                                    tone={FRESHNESS_TONES[source.freshness] ?? 'unknown'}
                                    label={source.freshness}
                                  />
                                  <span className={styles.sourceStatus}>{source.state}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {hardFails.length > 0 ? (
                          <div className={styles.reasonBlock}>
                            <span className={styles.tileLabel}>hard fail counters</span>
                            <ul className={styles.hardFail}>
                              {hardFails.map(([name, count]) => (
                                <li key={name}>
                                  {humanizeKey(name)}: {String(count)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <div className={styles.reasonBlock}>
                          <span className={styles.tileLabel}>redaction</span>
                          <p className={styles.redaction}>
                            {record.redaction?.replacementCount ?? 0} replacement(s)
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </PanelShell>
  );
}

export default FlightSection;
