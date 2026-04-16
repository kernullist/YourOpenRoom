import { loadPersistedConfig, type TavilyConfig } from './configPersistence';

const CONFIG_KEY = 'webuiapps-tavily-config';
const DEFAULT_BASE_URL = 'https://api.tavily.com/search';

export function loadTavilyConfigSync(): TavilyConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TavilyConfig;
    if (!parsed?.apiKey?.trim()) return null;
    return {
      ...parsed,
      baseUrl: parsed.baseUrl?.trim() || DEFAULT_BASE_URL,
    };
  } catch {
    return null;
  }
}

export async function loadTavilyConfig(): Promise<TavilyConfig | null> {
  try {
    const persisted = await loadPersistedConfig();
    if (persisted?.tavily?.apiKey?.trim()) {
      const config: TavilyConfig = {
        ...persisted.tavily,
        baseUrl: persisted.tavily.baseUrl?.trim() || DEFAULT_BASE_URL,
      };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return config;
    }
  } catch {
    // ignore and fall through
  }

  return loadTavilyConfigSync();
}

export type { TavilyConfig };
