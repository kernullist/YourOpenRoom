import React from 'react';
import { AlertOctagon, Play, Terminal } from 'lucide-react';
import type { AoiAutonomySchedulerState, AoiAutonomyStatus } from '@/lib/aoiAutonomyTypes';
import type { AoiUnifiedOperatorSnapshotSummary } from '@/lib/aoiUnifiedOperatorModel';
import {
  formatRelativeTime,
  formatTimestamp,
  runtimeStatusLabel,
  runtimeStatusTone,
  type PanelTone,
} from '../format';
import type { PanelState, RuntimePayload } from '../types';
import PanelShell, { StatusBadge } from './PanelShell';
import styles from './RuntimeSection.module.scss';

interface RuntimeSectionProps {
  runtime: PanelState<RuntimePayload>;
  status: PanelState<AoiAutonomyStatus>;
  snapshot: PanelState<AoiUnifiedOperatorSnapshotSummary>;
  scheduler: PanelState<AoiAutonomySchedulerState>;
  now: number;
  refreshIntervalMs: number;
  tickBusy: boolean;
  canTick: boolean;
  onManualTick: () => void;
  onRetry: () => void;
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: PanelTone;
}): JSX.Element {
  return (
    <div className={styles.field} data-tone={tone}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </div>
  );
}

export function RuntimeSection({
  runtime,
  status,
  snapshot,
  scheduler,
  now,
  refreshIntervalMs,
  tickBusy,
  canTick,
  onManualTick,
  onRetry,
}: RuntimeSectionProps): JSX.Element {
  const view = runtime.kind === 'ready' ? runtime.data.runtime : null;

  return (
    <>
      {view && view.status === 'not_running' ? (
        // The one condition worth shouting about: it is certain, it invalidates
        // every panel below, and it has a one-line fix.
        <div className={styles.deadBanner} data-testid="mission-control-daemon-dead">
          <AlertOctagon size={16} />
          <div>
            <p className={styles.deadTitle}>Aoi 데몬이 실행 중이 아닙니다.</p>
            <p className={styles.deadBody}>
              아래의 어떤 정책도 실제로 동작하지 않습니다. <code>Start-App.ps1 -Aoi</code> 로 데몬을
              기동하세요.
            </p>
          </div>
        </div>
      ) : null}

      <PanelShell
        title="Daemon"
        state={runtime}
        now={now}
        refreshIntervalMs={refreshIntervalMs}
        onRetry={onRetry}
      >
        {(data) => {
          const snap = data.runtime.snapshot;
          return (
            <div className={styles.grid}>
              <Field
                label="status"
                tone={runtimeStatusTone(data.runtime.status)}
                value={
                  <StatusBadge
                    tone={runtimeStatusTone(data.runtime.status)}
                    label={runtimeStatusLabel(data.runtime.status)}
                  />
                }
              />
              <Field label="port" value={data.runtime.port ?? '-'} />
              {snap ? (
                <>
                  <Field
                    label="loop"
                    tone={snap.loopRunning ? 'ok' : 'danger'}
                    value={snap.loopRunning ? 'running' : 'stopped'}
                  />
                  <Field
                    label="cognition"
                    tone={snap.cognitionActive ? 'ok' : 'warn'}
                    value={snap.cognitionActive ? 'active' : 'idle'}
                  />
                  <Field label="cycles" value={snap.cyclesCompleted} />
                  <Field
                    label="errors"
                    tone={snap.errorsTotal > 0 ? 'danger' : undefined}
                    value={snap.errorsTotal}
                  />
                  {snap.lastError ? (
                    <Field
                      label="last error"
                      tone="danger"
                      value={`${formatRelativeTime(snap.lastError.at, now)} — ${snap.lastError.message}`}
                    />
                  ) : null}
                </>
              ) : (
                // No snapshot means we could not validate what the daemon said.
                // Say that, rather than leaving the grid suspiciously empty.
                <Field
                  label="health"
                  tone="unknown"
                  value="스냅샷을 검증하지 못했습니다 — 루프 상태 불명"
                />
              )}
            </div>
          );
        }}
      </PanelShell>

      <PanelShell
        title="Policy"
        subtitle="세션 단위 자율 정책. 데몬이 죽어 있으면 아래 값은 적용되지 않습니다."
        state={status}
        now={now}
        refreshIntervalMs={refreshIntervalMs}
        onRetry={onRetry}
        actions={
          <button
            type="button"
            className={styles.tickButton}
            onClick={onManualTick}
            disabled={tickBusy || !canTick}
            data-testid="mission-control-manual-tick"
          >
            {tickBusy ? <Terminal size={13} /> : <Play size={13} />}
            {tickBusy ? '실행 중…' : '수동 틱'}
          </button>
        }
      >
        {(data) => (
          <div className={styles.grid}>
            <Field
              label="enabled"
              tone={data.policy.enabled ? 'ok' : 'unknown'}
              value={data.policy.enabled ? 'on' : 'off'}
            />
            <Field label="level" value={data.policy.level} />
            <Field
              label="preview mode"
              tone={data.policy.previewMode ? 'warn' : undefined}
              value={data.policy.previewMode ? 'on (제안만)' : 'off'}
            />
            <Field
              label="allow network"
              tone={data.policy.allowNetwork ? 'warn' : undefined}
              value={data.policy.allowNetwork ? 'on' : 'off'}
            />
            <Field label="active proposals" value={data.activeProposalCount} />
            <Field label="blocked" value={data.blockedProposalCount} />
            <Field label="observations" value={data.observationCount} />
            <Field label="reflections" value={data.reflectionCount} />
            <Field label="last tick" value={formatRelativeTime(data.lastTickAt, now)} />
            <Field
              label="next allowed"
              value={data.nextAllowedTickAt ? formatTimestamp(data.nextAllowedTickAt) : '-'}
            />
            {data.currentGoalTitle ? (
              <Field label="current goal" value={data.currentGoalTitle} />
            ) : null}
          </div>
        )}
      </PanelShell>

      <PanelShell
        title="Unified Snapshot"
        state={snapshot}
        now={now}
        refreshIntervalMs={refreshIntervalMs}
        onRetry={onRetry}
      >
        {(data) => (
          <div className={styles.snapshot}>
            <div className={styles.grid}>
              <Field label="readiness" value={data.readiness} />
              <Field label="interruption" value={data.interruption} />
              <Field
                label="blind spots"
                tone={data.blindSpotCount > 0 ? 'warn' : undefined}
                value={data.blindSpotCount}
              />
              <Field label="generated" value={formatRelativeTime(data.generatedAt, now)} />
            </div>
            {data.summary ? <p className={styles.summary}>{data.summary}</p> : null}
            {data.cannotKnow.length > 0 ? (
              // Surfaced prominently on purpose: the model's own list of what it
              // cannot see is the most useful thing on this panel.
              <div className={styles.cannotKnow}>
                <span className={styles.cannotKnowTitle}>알 수 없는 것</span>
                <ul>
                  {data.cannotKnow.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </PanelShell>

      <PanelShell
        title="Scheduler"
        state={scheduler}
        now={now}
        refreshIntervalMs={refreshIntervalMs}
        onRetry={onRetry}
      >
        {(data) => <pre className={styles.raw}>{JSON.stringify(data, null, 2)}</pre>}
      </PanelShell>
    </>
  );
}

export default RuntimeSection;
