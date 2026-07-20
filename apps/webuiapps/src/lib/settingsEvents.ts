export type AppSettingsTabKey = 'chat' | 'models' | 'kira' | 'image' | 'advanced';

/** Sub-sections inside Settings → Advanced (role-based navigation). */
export type AppSettingsAdvancedSection =
  | 'autonomy'
  | 'host'
  | 'operator'
  | 'memory'
  | 'integrations'
  | 'tools';

export interface OpenAppSettingsDetail {
  tab?: AppSettingsTabKey;
  advancedSection?: AppSettingsAdvancedSection;
}

export interface AppSettingsSavedDetail {
  tab?: AppSettingsTabKey;
}

export const OPEN_APP_SETTINGS_EVENT = 'openroom-open-app-settings';
export const APP_SETTINGS_SAVED_EVENT = 'openroom-app-settings-saved';

export function dispatchOpenAppSettings(tab: AppSettingsTabKey = 'chat'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OpenAppSettingsDetail>(OPEN_APP_SETTINGS_EVENT, {
      detail: { tab },
    }),
  );
}

export function dispatchAppSettingsSaved(tab?: AppSettingsTabKey): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<AppSettingsSavedDetail>(APP_SETTINGS_SAVED_EVENT, {
      detail: { tab },
    }),
  );
}
