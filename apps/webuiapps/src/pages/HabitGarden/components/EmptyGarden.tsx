import { Sprout } from 'lucide-react';
import styles from './EmptyGarden.module.scss';

interface EmptyGardenProps {
  suggestions: readonly string[];
  busy: boolean;
  onAdd: (name: string) => void;
}

/**
 * The first screen a new user sees.
 *
 * Deliberately shows no statistics -- 0%, 0 streaks, and an empty chart are a
 * scoreboard of nothing, which is a discouraging way to open a habit app. The
 * suggestions are one click each but are NOT created automatically: a garden
 * pre-filled with habits nobody chose is somebody else's garden.
 */
export function EmptyGarden({ suggestions, busy, onAdd }: EmptyGardenProps): JSX.Element {
  return (
    <div className={styles.empty} data-testid="habit-garden-empty">
      <Sprout size={28} className={styles.icon} />
      <p className={styles.title}>아직 심은 것이 없어요.</p>
      <p className={styles.body}>
        습관을 하나 등록하면 화분이 생기고, 체크할 때마다 자랍니다. 며칠 걸러도 죽지 않으니 편하게
        시작하세요.
      </p>
      <div className={styles.suggestions}>
        {suggestions.map((name) => (
          <button
            key={name}
            type="button"
            className={styles.suggestion}
            disabled={busy}
            onClick={() => onAdd(name)}
            data-testid={`habit-garden-suggestion-${name}`}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

export default EmptyGarden;
