import { ArrowLeft } from 'lucide-react';
import type { HabitGardenState } from '../types';
import { WEATHER_ROOM_ITEMS } from '../roomWeather';
import styles from './SettingsPanel.module.scss';

interface SettingsPanelProps {
  state: HabitGardenState;
  busy: boolean;
  onChange: (patch: Partial<HabitGardenState>) => void;
  onBack: () => void;
}

interface ToggleProps {
  checked: boolean;
  disabled: boolean;
  label: string;
  description: string;
  testId: string;
  onChange: (next: boolean) => void;
}

function Toggle({
  checked,
  disabled,
  label,
  description,
  testId,
  onChange,
}: ToggleProps): JSX.Element {
  return (
    <label className={styles.row}>
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowDescription}>{description}</span>
      </span>
    </label>
  );
}

export function SettingsPanel({ state, busy, onChange, onBack }: SettingsPanelProps): JSX.Element {
  return (
    <section className={styles.panel} data-testid="habit-garden-settings">
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack} aria-label="정원으로">
          <ArrowLeft size={15} />
        </button>
        <h2 className={styles.title}>설정</h2>
      </header>

      <Toggle
        checked={state.reflectWeatherInRoom}
        disabled={busy}
        label="정원 날씨를 방에도 반영"
        description="날씨가 바뀔 때만 방 테마를 바꿉니다. 끄면 켜기 직전의 테마로 되돌립니다."
        testId="habit-garden-toggle-room"
        onChange={(next) => onChange({ reflectWeatherInRoom: next })}
      />

      <ul className={styles.mapping}>
        {(['sunny', 'cloudy', 'rain'] as const).map((weather) => (
          <li key={weather}>
            {weather} → {WEATHER_ROOM_ITEMS[weather]}
          </li>
        ))}
      </ul>

      <Toggle
        checked={state.shareMomentumWithAoi}
        disabled={busy}
        label="Aoi에게 습관 흐름 공유"
        description="최근 흐름을 growing / steady / slipping 세 값으로만 전달합니다. 표현에만 쓰이고 Aoi의 권한이나 판단에는 영향을 주지 않습니다."
        testId="habit-garden-toggle-aoi"
        onChange={(next) => onChange({ shareMomentumWithAoi: next })}
      />

      <p className={styles.note}>
        두 설정 모두 Agent가 켜거나 끌 수 없습니다. 직접 조작해야 바뀝니다.
      </p>
    </section>
  );
}

export default SettingsPanel;
