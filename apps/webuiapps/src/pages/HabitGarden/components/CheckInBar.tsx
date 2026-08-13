import { Check, Circle } from 'lucide-react';
import type { HabitView } from '../garden';
import styles from './CheckInBar.module.scss';

interface CheckInBarProps {
  views: HabitView[];
  busyId: string | null;
  onToggle: (habitId: string, nextDone: boolean) => void;
}

/**
 * The only thing this app truly needs the user to do.
 *
 * One click, no confirmation, and the same click undoes it. Every bit of
 * friction here converts directly into skipped days: a user who has to think
 * before tapping will eventually stop tapping. Undo is what makes "no
 * confirmation" safe rather than reckless.
 */
export function CheckInBar({ views, busyId, onToggle }: CheckInBarProps): JSX.Element | null {
  if (views.length === 0) {
    return null;
  }

  const remaining = views.filter((view) => !view.streak.doneToday).length;

  return (
    <footer className={styles.bar} data-testid="habit-garden-checkin-bar">
      <span className={styles.title}>
        {remaining > 0 ? `오늘 남은 것 ${remaining}` : '오늘 다 했어요'}
      </span>
      <div className={styles.chips}>
        {views.map((view) => {
          const done = view.streak.doneToday;
          return (
            <button
              key={view.habit.id}
              type="button"
              className={styles.chip}
              data-done={done ? 'true' : undefined}
              data-testid={`habit-garden-checkin-${view.habit.id}`}
              aria-pressed={done}
              disabled={busyId === view.habit.id}
              onClick={() => onToggle(view.habit.id, !done)}
              style={{ color: done ? view.habit.color : undefined }}
            >
              {done ? <Check size={13} /> : <Circle size={13} />}
              <span className={styles.chipLabel}>{view.habit.name}</span>
            </button>
          );
        })}
      </div>
    </footer>
  );
}

export default CheckInBar;
