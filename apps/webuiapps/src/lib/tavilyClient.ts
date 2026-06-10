import { loadPersistedConfig, savePersistedConfig, type TavilyConfig } from './configPersistence';

const CONFIG_KEY = 'webuiapps-tavily-config';
export const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com/search';

export function normalizeTavilyBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim() || DEFAULT_TAVILY_BASE_URL;
  if (/\/search\/?$/i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `${trimmed.replace(/\/+$/, '')}/search`;
}

export function normalizeTavilyConfig(
  config: TavilyConfig | null | undefined,
): TavilyConfig | null {
  const apiKey = config?.apiKey?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: normalizeTavilyBaseUrl(config?.baseUrl),
  };
}

export function loadTavilyConfigSync(): TavilyConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    return normalizeTavilyConfig(JSON.parse(raw) as TavilyConfig);
  } catch {
    return null;
  }
}

export async function loadTavilyConfig(): Promise<TavilyConfig | null> {
  try {
    const persisted = await loadPersistedConfig();
    const config = normalizeTavilyConfig(persisted?.tavily);
    if (config) {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return config;
    }
  } catch {
    // ignore and fall through
  }

  return loadTavilyConfigSync();
}

export function saveTavilyConfigSync(config: TavilyConfig | null): TavilyConfig | null {
  const normalized = normalizeTavilyConfig(config);
  if (!normalized) {
    localStorage.removeItem(CONFIG_KEY);
    return null;
  }

  localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function saveTavilyConfig(config: TavilyConfig | null): Promise<TavilyConfig | null> {
  const normalized = saveTavilyConfigSync(config);
  const persisted = (await loadPersistedConfig()) ?? {};

  if (normalized) {
    persisted.tavily = normalized;
  } else {
    delete persisted.tavily;
  }

  await savePersistedConfig(persisted);
  return normalized;
}

export type { TavilyConfig };
