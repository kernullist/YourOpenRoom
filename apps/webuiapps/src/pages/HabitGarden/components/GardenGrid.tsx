import type { HabitView } from '../garden';
import Plant from './Plant';
import styles from './GardenGrid.module.scss';

interface GardenGridProps {
  views: HabitView[];
  selectedId: string | null;
  plantSize: number;
  onSelect: (habitId: string) => void;
}

export function GardenGrid({
  views,
  selectedId,
  plantSize,
  onSelect,
}: GardenGridProps): JSX.Element {
  return (
    <div className={styles.grid} data-testid="habit-garden-grid">
      {views.map((view) => (
        <button
          key={view.habit.id}
          type="button"
          className={styles.cell}
          data-active={view.habit.id === selectedId ? 'true' : undefined}
          data-testid={`habit-garden-plant-${view.habit.id}`}
          data-stage={view.stage}
          data-vitality={view.vitality}
          onClick={() => onSelect(view.habit.id)}
          title={`${view.habit.name} — ${view.streak.current}일 연속`}
        >
          <Plant
            stage={view.stage}
            vitality={view.vitality}
            color={view.habit.color}
            doneToday={view.streak.doneToday}
            size={plantSize}
          />
          <span className={styles.name}>{view.habit.name}</span>
          <span className={styles.streak}>
            {view.streak.current > 0 ? `${view.streak.current}` : '—'}
          </span>
        </button>
      ))}
    </div>
  );
}

export default GardenGrid;
