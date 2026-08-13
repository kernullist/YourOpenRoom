import { CloudRain, Cloud, HelpCircle, Plus, Settings, Sun } from 'lucide-react';
import type { GardenWeather, GardenWeatherKind } from '../garden';
import styles from './WeatherStrip.module.scss';

interface WeatherStripProps {
  weather: GardenWeather;
  onAddHabit: () => void;
  onOpenSettings: () => void;
}

const WEATHER_LABEL: Record<GardenWeatherKind, string> = {
  sunny: '맑음',
  cloudy: '흐림',
  rain: '비',
  // Not "no data" -- a garden that has barely started has not failed at anything.
  unknown: '아직 지켜보는 중',
};

const WEATHER_ICON = {
  sunny: Sun,
  cloudy: Cloud,
  rain: CloudRain,
  unknown: HelpCircle,
} as const;

export function WeatherStrip({
  weather,
  onAddHabit,
  onOpenSettings,
}: WeatherStripProps): JSX.Element {
  const Icon = WEATHER_ICON[weather.weather];

  return (
    <header className={styles.strip} data-weather={weather.weather}>
      <span className={styles.weather}>
        <Icon size={16} className={styles.icon} />
        <span className={styles.label}>{WEATHER_LABEL[weather.weather]}</span>
      </span>

      {/* The rate is secondary and hidden on narrow widths: this app opens with a
          garden, not a percentage. */}
      {weather.adherenceRate !== null ? (
        <span className={styles.rate} data-testid="habit-garden-adherence">
          최근 {weather.sampleDays}일 {Math.round(weather.adherenceRate * 100)}%
        </span>
      ) : (
        <span className={styles.rate} data-testid="habit-garden-adherence">
          기록이 {weather.sampleDays}일치라 아직 날씨를 말하기 이릅니다
        </span>
      )}

      <span className={styles.spacer} />

      <button
        type="button"
        className={styles.action}
        onClick={onAddHabit}
        data-testid="habit-garden-add"
      >
        <Plus size={14} />
        <span className={styles.actionLabel}>습관 추가</span>
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={onOpenSettings}
        title="설정"
        aria-label="설정"
        data-testid="habit-garden-settings-open"
      >
        <Settings size={15} />
      </button>
    </header>
  );
}

export default WeatherStrip;
