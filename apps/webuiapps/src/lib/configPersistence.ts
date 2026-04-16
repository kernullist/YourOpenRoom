/**
 * Unified config persistence for ~/.openroom/config.json
 *
 * The persisted format is:
 * { llm: LLMConfig, imageGen?: ImageGenConfig, album?: AlbumConfig, kira?: KiraConfig, app?: AppConfig, tavily?: TavilyConfig }
 * Legacy files that contain a flat LLMConfig (with top-level "provider") are
 * automatically migrated on read.
 */

import type { LLMConfig } from './llmModels';
import type { ImageGenConfig } from './imageGenClient';

export interface AlbumConfig {
  photoDirectory?: string;
}

export interface KiraRoleLlmConfig extends Partial<LLMConfig> {}

export interface KiraProjectDefaults {
  autoCommit?: boolean;
}

export interface KiraConfig {
  workRootDirectory?: string;
  workerModel?: string;
  reviewerModel?: string;
  workerLlm?: KiraRoleLlmConfig;
  reviewerLlm?: KiraRoleLlmConfig;
  projectDefaults?: KiraProjectDefaults;
}

export interface AppConfig {
  title?: string;
}

export interface TavilyConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface PersistedConfig {
  llm: LLMConfig;
  imageGen?: ImageGenConfig;
  album?: AlbumConfig;
  kira?: KiraConfig;
  app?: AppConfig;
  tavily?: TavilyConfig;
}

const CONFIG_API = '/api/llm-config';

/** Detect legacy flat LLMConfig (has "provider" at top level, no "llm" key). */
function isLegacyConfig(obj: unknown): obj is LLMConfig {
  return typeof obj === 'object' && obj !== null && 'provider' in obj && !('llm' in obj);
}

/**
 * Load the full persisted config from ~/.openroom/config.json via the dev-server API.
 * Handles legacy flat LLMConfig format for backward compatibility.
 * Returns null if the API is unavailable or the file doesn't exist.
 */
export async function loadPersistedConfig(): Promise<PersistedConfig | null> {
  try {
    const res = await fetch(CONFIG_API);
    if (res.ok) {
      const data: unknown = await res.json();
      if (isLegacyConfig(data)) {
        return { llm: data };
      }
      if (typeof data === 'object' && data !== null && 'llm' in data) {
        return data as PersistedConfig;
      }
    }
  } catch {
    // API not available (production / network error)
  }
  return null;
}

/**
 * Save the full config to ~/.openroom/config.json via the dev-server API.
 * Always writes the new { llm, imageGen? } format.
 */
export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
  try {
    await fetch(CONFIG_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  } catch {
    // Silently ignore if API is not available
  }
}
