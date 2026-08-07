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
import type { AoiOperatorVoicePolicy } from './aoiAutonomyTypes';
import {
  normalizeAoiMcpConnectorsConfig,
  type AoiMcpConnectorsConfig,
} from './aoiMcpConnectorRegistry';

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
  requiredInstructions?: string;
  runMode?: 'quick' | 'standard' | 'deep';
  rulePacks?: Array<{ id: string; enabled?: boolean }>;
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
  workspaceHistory?: string[];
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
  operatorVoicePolicy?: AoiOperatorVoicePolicy;
}

export interface TavilyConfig {
  apiKey: string;
  baseUrl?: string;
}

// Optional OpenAI-compatible embedding provider for Aoi semantic memory. Reuses
// an existing key (OpenRouter / OpenAI / local) rather than a dedicated Gemini
// key. Defaults target OpenRouter so a user only needs to paste their key.
export const AOI_EMBEDDING_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const AOI_EMBEDDING_DEFAULT_MODEL = 'openai/text-embedding-3-small';

export interface AoiEmbeddingConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export function normalizeAoiEmbeddingConfig(
  raw: Partial<AoiEmbeddingConfig> | null | undefined,
): AoiEmbeddingConfig | null {
  const apiKey = (raw?.apiKey ?? '').trim();
  if (!apiKey) {
    return null;
  }
  return {
    apiKey,
    baseUrl: (raw?.baseUrl ?? '').trim() || AOI_EMBEDDING_DEFAULT_BASE_URL,
    model: (raw?.model ?? '').trim() || AOI_EMBEDDING_DEFAULT_MODEL,
  };
}

// Operator-facing memory maintenance settings (embed backfill + consolidation +
// the offline local embedder). These were env-var only, which meant editing
// system environment variables and restarting the server to turn semantic
// memory on. Persisted here so the settings UI owns them; the env vars stay as
// a fallback for headless deployments and are read only when the matching field
// is absent from this block.
export const AOI_MEMORY_MAINTENANCE_DEFAULT_INTERVAL_MINUTES = 5;
export const AOI_MEMORY_MAINTENANCE_MIN_INTERVAL_MINUTES = 1;
export const AOI_MEMORY_MAINTENANCE_MAX_INTERVAL_MINUTES = 120;
export const AOI_MEMORY_MAINTENANCE_DEFAULT_EMBED_MAX = 16;
export const AOI_MEMORY_MAINTENANCE_MAX_EMBED_MAX = 64;
export const AOI_MEMORY_MAINTENANCE_DEFAULT_CONSOLIDATION_MAX = 8;
export const AOI_MEMORY_MAINTENANCE_MAX_CONSOLIDATION_MAX = 32;

export interface AoiMemoryMaintenanceConfig {
  version: 1;
  embedSweepEnabled?: boolean;
  embedSweepIntervalMinutes?: number;
  embedSweepMax?: number;
  consolidationEnabled?: boolean;
  consolidationMax?: number;
  localEmbedderEnabled?: boolean;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// Absent fields are preserved as absent (undefined), NOT defaulted: absence is
// what hands the decision to the env fallback, so writing a default here would
// silently override a headless deployment's env var.
export function normalizeAoiMemoryMaintenanceConfig(
  raw: Partial<AoiMemoryMaintenanceConfig> | null | undefined,
): AoiMemoryMaintenanceConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const intervalMinutes = clampInt(
    raw.embedSweepIntervalMinutes,
    AOI_MEMORY_MAINTENANCE_MIN_INTERVAL_MINUTES,
    AOI_MEMORY_MAINTENANCE_MAX_INTERVAL_MINUTES,
  );
  const embedMax = clampInt(raw.embedSweepMax, 1, AOI_MEMORY_MAINTENANCE_MAX_EMBED_MAX);
  const consolidationMax = clampInt(
    raw.consolidationMax,
    1,
    AOI_MEMORY_MAINTENANCE_MAX_CONSOLIDATION_MAX,
  );
  const normalized: AoiMemoryMaintenanceConfig = {
    version: 1,
    ...(typeof raw.embedSweepEnabled === 'boolean'
      ? { embedSweepEnabled: raw.embedSweepEnabled }
      : {}),
    ...(intervalMinutes !== undefined ? { embedSweepIntervalMinutes: intervalMinutes } : {}),
    ...(embedMax !== undefined ? { embedSweepMax: embedMax } : {}),
    ...(typeof raw.consolidationEnabled === 'boolean'
      ? { consolidationEnabled: raw.consolidationEnabled }
      : {}),
    ...(consolidationMax !== undefined ? { consolidationMax } : {}),
    ...(typeof raw.localEmbedderEnabled === 'boolean'
      ? { localEmbedderEnabled: raw.localEmbedderEnabled }
      : {}),
  };
  return Object.keys(normalized).length > 1 ? normalized : null;
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

// Server copy of the learned music taste + idle-music learning state. The
// canonical field types and all validation live in aoiMusicTaste.ts; this
// wrapper stays structural so configPersistence never imports that module.
// Purpose: taste must follow the USER, not one browser profile -- a fresh
// profile (in-app preview browser, second PC) with empty localStorage used to
// emit generic mood-pool picks into the shared conversation.
export interface AoiMusicPersistedState {
  version: 1;
  updatedAt: number;
  taste?: Record<string, unknown>;
  idleLearning?: Record<string, unknown>;
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
  aoiEmbedding?: AoiEmbeddingConfig;
  // Server-readable trusted-connector allow-list for Aoi live MCP RPC. The
  // server resolves a connector by id from here; the proposal never supplies a
  // raw endpoint. See aoiMcpConnectorRegistry.ts.
  aoiMcpConnectors?: AoiMcpConnectorsConfig;
  aoiMusicTaste?: AoiMusicPersistedState;
  aoiMemoryMaintenance?: AoiMemoryMaintenanceConfig;
}

const CONFIG_API = '/api/llm-config';
const USER_PROFILE_STORAGE_KEY = 'webuiapps-user-profile';
const CONVERSATION_PREFERENCES_STORAGE_KEY = 'webuiapps-conversation-preferences';
// Exported so a test can assert that every persisted block survives a partial
// write, without that test needing its own copy of the list.
export const KNOWN_CONFIG_KEYS = [
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
  'aoiEmbedding',
  'aoiMcpConnectors',
  'aoiMusicTaste',
  'aoiMemoryMaintenance',
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
      ...(parsed?.operatorVoicePolicy ? { operatorVoicePolicy: parsed.operatorVoicePolicy } : {}),
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
      ...(config.operatorVoicePolicy ? { operatorVoicePolicy: config.operatorVoicePolicy } : {}),
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

/**
 * Read-modify-write just the Aoi embedding config, preserving every other
 * persisted field. Passing an empty/blank key clears it.
 */
export async function saveAoiEmbeddingConfig(
  config: Partial<AoiEmbeddingConfig> | null,
): Promise<void> {
  const normalized = normalizeAoiEmbeddingConfig(config);
  const existing = (await loadPersistedConfig()) ?? {};
  const next: PersistedConfig = { ...existing };
  if (normalized) {
    next.aoiEmbedding = normalized;
  } else {
    delete next.aoiEmbedding;
  }
  await savePersistedConfig(next);
}

/**
 * Read-modify-write just the Aoi MCP connector allow-list, preserving every
 * other persisted field. An empty allow-list clears the block. The list is
 * normalized (deduped by id, host-validated lazily by consumers) on write.
 */
export async function saveAoiMcpConnectorsConfig(
  config: Partial<AoiMcpConnectorsConfig> | null,
): Promise<void> {
  const normalized = normalizeAoiMcpConnectorsConfig(config);
  const existing = (await loadPersistedConfig()) ?? {};
  const next: PersistedConfig = { ...existing };
  if (normalized.connectors.length > 0) {
    next.aoiMcpConnectors = normalized;
  } else {
    delete next.aoiMcpConnectors;
  }
  await savePersistedConfig(next);
}
