import { useMemo, useState } from 'react';
import { formatRelativeTime, timelineKindLabel, timelineKindTone } from '../format';
import type { PanelState, TimelinePayload } from '../types';
import PanelShell, { StatusBadge } from './PanelShell';
import styles from './TimelineSection.module.scss';

interface TimelineSectionProps {
  timeline: PanelState<TimelinePayload>;
  kindFilter: string | null;
  now: number;
  refreshIntervalMs: number;
  onChangeFilter: (kind: string | null) => void;
  onRetry: () => void;
}

export function TimelineSection({
  timeline,
  kindFilter,
  now,
  refreshIntervalMs,
  onChangeFilter,
  onRetry,
}: TimelineSectionProps): JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filter options come from the events actually present, not from the full
  // 21-kind enum: offering filters that can only ever return nothing is noise.
  const kinds = useMemo(() => {
    if (timeline.kind !== 'ready') {
      return [];
    }
    return [...new Set(timeline.data.events.map((event) => event.kind))].sort();
  }, [timeline]);

  return (
    <PanelShell
      title="Operator Timeline"
      state={timeline}
      now={now}
      refreshIntervalMs={refreshIntervalMs}
      onRetry={onRetry}
      actions={
        kinds.length > 0 ? (
          <select
            className={styles.filter}
            value={kindFilter ?? ''}
            onChange={(event) => onChangeFilter(event.target.value || null)}
            aria-label="이벤트 종류 필터"
          >
            <option value="">전체 ({kinds.length}종)</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {timelineKindLabel(kind)}
              </option>
            ))}
          </select>
        ) : null
      }
    >
      {(data) => {
        const events = kindFilter
          ? data.events.filter((event) => event.kind === kindFilter)
          : data.events;

        if (events.length === 0) {
          return (
            <p className={styles.filteredEmpty}>
              이 필터에 해당하는 이벤트가 없습니다. 데이터가 없는 것이 아니라 필터 결과가 비어
              있습니다.
            </p>
          );
        }

        return (
          <ul className={styles.list} data-testid="mission-control-timeline-list">
            {events.map((event) => {
              const expanded = expandedId === event.id;
              return (
                <li key={event.id} className={styles.item}>
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => setExpandedId(expanded ? null : event.id)}
                    aria-expanded={expanded}
                  >
                    <span className={styles.time}>{formatRelativeTime(event.createdAt, now)}</span>
                    <StatusBadge
                      tone={timelineKindTone(event.kind)}
                      label={timelineKindLabel(event.kind)}
                    />
                    <span className={styles.summary}>{event.summary || event.title}</span>
                    {event.risk ? <span className={styles.risk}>{event.risk}</span> : null}
                  </button>
                  {expanded ? (
                    <pre className={styles.raw}>{JSON.stringify(event, null, 2)}</pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        );
      }}
    </PanelShell>
  );
}

export default TimelineSection;
