/**
 * Unified config persistence for ~/.openroom/config.json
 *
 * The persisted format is:
 * { llm: LLMConfig, imageGen?: ImageGenConfig, album?: AlbumConfig, kira?: KiraConfig, app?: AppConfig, tavily?: TavilyConfig, userProfile?: UserProfileConfig }
 * Legacy files that contain a flat LLMConfig (with top-level "provider") are
 * automatically migrated on read.
 */

import type { LLMConfig } from './llmModels';
import type { ImageGenConfig } from './imageGenClient';

export interface AlbumConfig {
  photoDirectory?: string;
}

export type KiraAgentProvider = LLMConfig['provider'];
export type KiraAgentApiStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface KiraRoleLlmConfig extends Partial<Omit<LLMConfig, 'provider'>> {
  provider?: KiraAgentProvider;
  command?: string;
  apiStyle?: KiraAgentApiStyle;
  name?: string;
}

export interface KiraProjectDefaults {
  autoCommit?: boolean;
}

export interface KiraConfig {
  workRootDirectory?: string;
  workerModel?: string;
  reviewerModel?: string;
  workers?: KiraRoleLlmConfig[];
  workerLlm?: KiraRoleLlmConfig;
  reviewerLlm?: KiraRoleLlmConfig;
  projectDefaults?: KiraProjectDefaults;
}

export interface OpenVscodeConfig {
  baseUrl?: string;
  executablePath?: string;
  workspacePath?: string;
  host?: string;
  port?: number;
  connectionToken?: string;
}

export interface DialogLlmConfig extends Partial<LLMConfig> {}

export interface AppConfig {
  title?: string;
}

export interface UserProfileConfig {
  displayName?: string;
}

export type ResponseLanguageMode = 'match-user' | 'english';

export interface ConversationPreferencesConfig {
  responseLanguageMode?: ResponseLanguageMode;
  ttsEnabled?: boolean;
  ttsPreloadCommonPhrases?: boolean;
}

export interface TavilyConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface GmailConfig {
  clientId?: string;
  clientSecret?: string;
  connectedEmail?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
  scope?: string;
  historyId?: string;
  lastSyncAt?: number;
}

export interface IdaPeConfig {
  mode?: 'prescan-only' | 'mcp-http';
  backendUrl?: string;
}

export interface PersistedConfig {
  llm?: LLMConfig;
  dialogLlm?: DialogLlmConfig;
  imageGen?: ImageGenConfig;
  album?: AlbumConfig;
  kira?: KiraConfig;
  openvscode?: OpenVscodeConfig;
  app?: AppConfig;
  userProfile?: UserProfileConfig;
  conversationPreferences?: ConversationPreferencesConfig;
  tavily?: TavilyConfig;
  gmail?: GmailConfig;
  idaPe?: IdaPeConfig;
}

const CONFIG_API = '/api/llm-config';
const USER_PROFILE_STORAGE_KEY = 'webuiapps-user-profile';
const CONVERSATION_PREFERENCES_STORAGE_KEY = 'webuiapps-conversation-preferences';
const KNOWN_CONFIG_KEYS = [
  'llm',
  'dialogLlm',
  'imageGen',
  'album',
  'kira',
  'openvscode',
  'app',
  'userProfile',
  'conversationPreferences',
  'tavily',
  'gmail',
  'idaPe',
];

export function normalizeUserProfileDisplayName(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function loadUserProfileConfigSync(): UserProfileConfig | null {
  try {
    const raw = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserProfileConfig;
    const displayName = normalizeUserProfileDisplayName(parsed?.displayName);
    return displayName ? { displayName } : null;
  } catch {
    return null;
  }
}

export function saveUserProfileConfig(config: UserProfileConfig | null): void {
  const displayName = normalizeUserProfileDisplayName(config?.displayName);
  if (!displayName) {
    localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
    return;
  }
  localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify({ displayName }));
}

export function normalizeResponseLanguageMode(
  raw: string | null | undefined,
): ResponseLanguageMode {
  return raw === 'english' ? 'english' : 'match-user';
}

export function loadConversationPreferencesSync(): ConversationPreferencesConfig | null {
  try {
    const raw = localStorage.getItem(CONVERSATION_PREFERENCES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConversationPreferencesConfig;
    return {
      responseLanguageMode: normalizeResponseLanguageMode(parsed?.responseLanguageMode),
      ttsEnabled: parsed?.ttsEnabled === true,
      ttsPreloadCommonPhrases: parsed?.ttsPreloadCommonPhrases !== false,
    };
  } catch {
    return null;
  }
}

export function saveConversationPreferences(config: ConversationPreferencesConfig | null): void {
  if (!config) {
    localStorage.removeItem(CONVERSATION_PREFERENCES_STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    CONVERSATION_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      responseLanguageMode: normalizeResponseLanguageMode(config.responseLanguageMode),
      ttsEnabled: config.ttsEnabled === true,
      ttsPreloadCommonPhrases: config.ttsPreloadCommonPhrases !== false,
    }),
  );
}

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
      if (
        typeof data === 'object' &&
        data !== null &&
        KNOWN_CONFIG_KEYS.some((key) => key in (data as Record<string, unknown>))
      ) {
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
 * Writes the unified config object as-is.
 */
export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
  const res = await fetch(CONFIG_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!res.ok) {
    let detail = `Config API error ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) detail = data.error;
    } catch {
      // Ignore JSON parse errors and keep the generic message.
    }
    throw new Error(detail);
  }
}
