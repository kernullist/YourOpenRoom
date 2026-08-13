import type {
  AoiClosedLoopCapabilityMetric,
  AoiClosedLoopMetricsReport,
} from '@/lib/aoiClosedLoopMetrics';
import { formatDuration, formatRatio, isRatioUnavailable } from '../format';
import type { PanelState } from '../types';
import PanelShell from './PanelShell';
import styles from './MetricsSection.module.scss';

interface MetricsSectionProps {
  metrics: PanelState<AoiClosedLoopMetricsReport>;
  now: number;
  refreshIntervalMs: number;
  onRetry: () => void;
}

interface RatioTileProps {
  label: string;
  value: number | null;
  sampleSize: number;
  minSample: number;
}

/**
 * A ratio tile that refuses to fake a number.
 *
 * buildAoiClosedLoopMetrics returns null below minSample, and the `unavailable`
 * treatment is deliberately different in colour AND size -- an operator scanning
 * the grid must not mistake "no signal" for a genuine low score, because that is
 * how a healthy-but-new system gets diagnosed as failing.
 */
function RatioTile({ label, value, sampleSize, minSample }: RatioTileProps): JSX.Element {
  const unavailable = isRatioUnavailable(value);
  return (
    <div className={styles.tile} data-unavailable={unavailable ? 'true' : undefined}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{formatRatio(value, sampleSize, minSample)}</span>
    </div>
  );
}

function CapabilityRow({
  metric,
  minSample,
}: {
  metric: AoiClosedLoopCapabilityMetric;
  minSample: number;
}): JSX.Element {
  return (
    <tr>
      <th scope="row" className={styles.capability}>
        {metric.capability}
      </th>
      <td>{metric.sampleSize}</td>
      <td>{metric.accepted}</td>
      <td>{metric.dismissed}</td>
      <td>{metric.executions}</td>
      <td>{metric.corrections}</td>
      <td data-unavailable={isRatioUnavailable(metric.proposalPrecision) ? 'true' : undefined}>
        {formatRatio(metric.proposalPrecision, metric.sampleSize, minSample)}
      </td>
      <td data-unavailable={isRatioUnavailable(metric.actionSuccessRate) ? 'true' : undefined}>
        {formatRatio(metric.actionSuccessRate, metric.executions, minSample)}
      </td>
    </tr>
  );
}

export function MetricsSection({
  metrics,
  now,
  refreshIntervalMs,
  onRetry,
}: MetricsSectionProps): JSX.Element {
  return (
    <PanelShell
      title="Closed-Loop Metrics"
      subtitle="결정과 성과 신호로부터 클라이언트에서 조립. 표본 미달 항목은 0%가 아니라 '표본 부족'으로 표기됩니다."
      state={metrics}
      now={now}
      refreshIntervalMs={refreshIntervalMs}
      onRetry={onRetry}
    >
      {(report) => (
        <div className={styles.wrap}>
          <div className={styles.window}>
            집계 창 {formatDuration(report.windowMs)} · 최소 표본 {report.minSample}건
          </div>

          <div className={styles.tiles}>
            <RatioTile
              label="proposal precision"
              value={report.overall.proposalPrecision}
              sampleSize={report.overall.sampleSize}
              minSample={report.minSample}
            />
            <RatioTile
              label="interruption precision"
              value={report.overall.interruptionPrecision}
              sampleSize={report.overall.sampleSize}
              minSample={report.minSample}
            />
            <RatioTile
              label="action success"
              value={report.overall.actionSuccessRate}
              sampleSize={report.overall.executions}
              minSample={report.minSample}
            />
            <RatioTile
              label="memory recall quality"
              value={report.overall.memoryRecallQuality}
              sampleSize={report.overall.sampleSize}
              minSample={report.minSample}
            />
            <div className={styles.tile}>
              <span className={styles.tileLabel}>terminal decisions</span>
              <span className={styles.tileValue}>{report.overall.sampleSize}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>corrections</span>
              <span className={styles.tileValue}>{report.overall.corrections}</span>
            </div>
          </div>

          {report.capabilities.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">capability</th>
                    <th scope="col">n</th>
                    <th scope="col">accept</th>
                    <th scope="col">dismiss</th>
                    <th scope="col">exec</th>
                    <th scope="col">corr</th>
                    <th scope="col">precision</th>
                    <th scope="col">success</th>
                  </tr>
                </thead>
                <tbody>
                  {report.capabilities.map((metric) => (
                    <CapabilityRow
                      key={metric.capability}
                      metric={metric}
                      minSample={report.minSample}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </PanelShell>
  );
}

export default MetricsSection;
