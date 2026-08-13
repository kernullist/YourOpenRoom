import { HABIT_COLORS, HABIT_NAME_MAX } from '../types';
import styles from './HabitEditor.module.scss';

export interface HabitDraft {
  id: string | null;
  name: string;
  cadenceKind: 'daily' | 'weekly';
  timesPerWeek: number;
  color: string;
}

interface HabitEditorProps {
  draft: HabitDraft;
  busy: boolean;
  onChange: (next: HabitDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function HabitEditor({
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: HabitEditorProps): JSX.Element {
  const nameValid = draft.name.trim().length > 0;

  return (
    <form
      className={styles.editor}
      data-testid="habit-garden-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (nameValid && !busy) {
          onSubmit();
        }
      }}
    >
      <label className={styles.field}>
        <span className={styles.label}>이름</span>
        <input
          className={styles.input}
          value={draft.name}
          maxLength={HABIT_NAME_MAX}
          autoFocus
          placeholder="예: 아침 스트레칭"
          data-testid="habit-garden-editor-name"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.label}>주기</span>
        <div className={styles.cadence}>
          <button
            type="button"
            className={styles.cadenceOption}
            data-active={draft.cadenceKind === 'daily' ? 'true' : undefined}
            onClick={() => onChange({ ...draft, cadenceKind: 'daily' })}
          >
            매일
          </button>
          <button
            type="button"
            className={styles.cadenceOption}
            data-active={draft.cadenceKind === 'weekly' ? 'true' : undefined}
            onClick={() => onChange({ ...draft, cadenceKind: 'weekly' })}
            data-testid="habit-garden-editor-weekly"
          >
            주 N회
          </button>
          {draft.cadenceKind === 'weekly' ? (
            <select
              className={styles.times}
              value={draft.timesPerWeek}
              aria-label="주당 횟수"
              onChange={(event) => onChange({ ...draft, timesPerWeek: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((times) => (
                <option key={times} value={times}>
                  {times}회
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>색</span>
        <div className={styles.colors}>
          {HABIT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={styles.swatch}
              data-active={color === draft.color ? 'true' : undefined}
              style={{ background: color }}
              aria-label={`색 ${color}`}
              onClick={() => onChange({ ...draft, color })}
            />
          ))}
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="submit"
          className={styles.submit}
          disabled={!nameValid || busy}
          data-testid="habit-garden-editor-submit"
        >
          {draft.id ? '저장' : '심기'}
        </button>
        <button type="button" className={styles.cancel} onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}

export default HabitEditor;
