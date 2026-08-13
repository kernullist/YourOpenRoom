import { Pencil, Trash2, X } from 'lucide-react';
import { habitAdherence, type HabitView } from '../garden';
import { checkInSet } from '../garden';
import { lastDayKeys, type DayKey } from '../dayKey';
import Plant from './Plant';
import styles from './HabitDetail.module.scss';

interface StreakHeatmapProps {
  checkIns: Set<DayKey>;
  todayKey: DayKey;
  weeks: number;
  color: string;
}

function StreakHeatmap({ checkIns, todayKey, weeks, color }: StreakHeatmapProps): JSX.Element {
  const days = lastDayKeys(todayKey, weeks * 7);
  return (
    <div className={styles.heatmap} data-testid="habit-garden-heatmap">
      {days.map((day) => (
        <span
          key={day}
          className={styles.cell}
          data-done={checkIns.has(day) ? 'true' : undefined}
          data-today={day === todayKey ? 'true' : undefined}
          title={day}
          style={checkIns.has(day) ? { background: color } : undefined}
        />
      ))}
    </div>
  );
}

interface HabitDetailProps {
  view: HabitView;
  todayKey: DayKey;
  weeks: number;
  compact: boolean;
  deleteArmed: boolean;
  busy: boolean;
  onEdit: () => void;
  onArmDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClose: () => void;
}

export function HabitDetail({
  view,
  todayKey,
  weeks,
  compact,
  deleteArmed,
  busy,
  onEdit,
  onArmDelete,
  onConfirmDelete,
  onCancelDelete,
  onClose,
}: HabitDetailProps): JSX.Element {
  const adherence = habitAdherence(view.habit, todayKey, weeks * 7);
  const cadenceLabel =
    view.habit.cadence.kind === 'weekly' ? `주 ${view.habit.cadence.timesPerWeek}회` : '매일';

  return (
    <aside
      className={styles.detail}
      data-compact={compact ? 'true' : undefined}
      data-testid="habit-garden-detail"
    >
      <header className={styles.header}>
        <Plant
          stage={view.stage}
          vitality={view.vitality}
          color={view.habit.color}
          doneToday={view.streak.doneToday}
          size={56}
        />
        <div className={styles.headerText}>
          <h3 className={styles.title}>{view.habit.name}</h3>
          <p className={styles.cadence}>{cadenceLabel}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          <X size={15} />
        </button>
      </header>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>현재</span>
          <span className={styles.statValue}>{view.streak.current}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>최장</span>
          <span className={styles.statValue}>{view.streak.best}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>이행률</span>
          <span className={styles.statValue}>
            {adherence.rate === null ? '—' : `${Math.round(adherence.rate * 100)}%`}
          </span>
        </div>
      </div>

      <StreakHeatmap
        checkIns={checkInSet(view.habit)}
        todayKey={todayKey}
        weeks={weeks}
        color={view.habit.color}
      />

      <div className={styles.actions}>
        <button type="button" className={styles.edit} onClick={onEdit} disabled={busy}>
          <Pencil size={13} />
          편집
        </button>
        {deleteArmed ? (
          // Deletion takes the history with it and cannot be undone, so unlike
          // check-in it earns a confirmation step.
          <div className={styles.confirm} data-testid="habit-garden-delete-confirm">
            <span className={styles.confirmText}>기록까지 삭제됩니다.</span>
            <button
              type="button"
              className={styles.confirmDelete}
              onClick={onConfirmDelete}
              disabled={busy}
              data-testid="habit-garden-delete-confirm-yes"
            >
              삭제
            </button>
            <button type="button" className={styles.cancel} onClick={onCancelDelete}>
              취소
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.delete}
            onClick={onArmDelete}
            disabled={busy}
            data-testid="habit-garden-delete"
          >
            <Trash2 size={13} />
            삭제
          </button>
        )}
      </div>
    </aside>
  );
}

export default HabitDetail;
