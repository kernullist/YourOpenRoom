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

// Operator-facing autonomy CAPABILITY settings. Same problem the maintenance
// block above solved: these were env-var only, so the panel showed autonomy
// toggles while the capabilities behind them could only be turned on by editing
// system environment variables and restarting.
//
// The line drawn here is deliberate and narrow: what moves into the app is
// capability ENABLEMENT. Trust escalation and approval weakening stay env-only
// (AOI_AUTONOMY_AUTO_PROMOTE, AOI_AUTONOMY_APPROVAL_TTL, AOI_MCP_SIDE_EFFECTING_RPC)
// because moving those would change the safety posture, not just its
// accessibility -- an operator with the app open must not be able to raise Aoi's
// own trust level or widen the fresh-approval window for irreversible actions.
// The hard-off env ceilings (AOI_AUTONOMY_BACKGROUND=0 and friends) likewise stay
// authoritative over anything set here.
export interface AoiAutonomyCapabilitiesConfig {
  version: 1;
  // Lets accepted proposals execute without a per-execution human click. The
  // 7-invariant eligibility gate behind it is untouched: this only decides
  // whether that gate is consulted at all.
  selfExecuteEnabled?: boolean;
  // Dispatches an approved app_operation to a connected client instead of handing
  // it to a Kira review. The L5 + content-addressed approval gate still governs it.
  appOpLiveDispatchEnabled?: boolean;
  // Out-of-panel push for direct-chat cards. A URL, not a toggle: empty means off.
  pushWebhookUrl?: string;
  // Lets the loop synthesize new goals from observed patterns (LLM, network).
  goalSynthesisEnabled?: boolean;
  // Raises proposal confidence while the user is idle.
  idleConfidenceSurgeEnabled?: boolean;
}

function normalizeWebhookUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // An explicit empty string is a real setting -- "off, decided here" -- and
    // must survive so it beats an env-supplied URL.
    return '';
  }
  // Only http(s) is a push transport. Anything else (file:, javascript:, a bare
  // hostname) is rejected rather than stored, so a typo cannot become an
  // outbound target that silently fails or reaches somewhere unintended.
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

// Absent fields are preserved as absent (undefined), NOT defaulted: absence is
// what hands the decision to the env fallback.
export function normalizeAoiAutonomyCapabilitiesConfig(
  raw: Partial<AoiAutonomyCapabilitiesConfig> | null | undefined,
): AoiAutonomyCapabilitiesConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const webhookUrl = normalizeWebhookUrl(raw.pushWebhookUrl);
  const normalized: AoiAutonomyCapabilitiesConfig = {
    version: 1,
    ...(typeof raw.selfExecuteEnabled === 'boolean'
      ? { selfExecuteEnabled: raw.selfExecuteEnabled }
      : {}),
    ...(typeof raw.appOpLiveDispatchEnabled === 'boolean'
      ? { appOpLiveDispatchEnabled: raw.appOpLiveDispatchEnabled }
      : {}),
    ...(webhookUrl !== undefined ? { pushWebhookUrl: webhookUrl } : {}),
    ...(typeof raw.goalSynthesisEnabled === 'boolean'
      ? { goalSynthesisEnabled: raw.goalSynthesisEnabled }
      : {}),
    ...(typeof raw.idleConfidenceSurgeEnabled === 'boolean'
      ? { idleConfidenceSurgeEnabled: raw.idleConfidenceSurgeEnabled }
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
  aoiAutonomyCapabilities?: AoiAutonomyCapabilitiesConfig;
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
  'aoiAutonomyCapabilities',
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
// Version token of the last config read, used as If-Match on the next write.
// config.json has several independent whole-file writers, so without this an
// overlapping write silently drops whichever change landed first.
let lastKnownConfigEtag: string | null = null;

export class ConfigVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigVersionConflictError';
  }
}

export function isConfigVersionConflict(error: unknown): boolean {
  return error instanceof ConfigVersionConflictError;
}

// Test seam: forget the cached token so a fresh read is required.
export function resetPersistedConfigVersion(): void {
  lastKnownConfigEtag = null;
}

export async function loadPersistedConfig(): Promise<PersistedConfig | null> {
  try {
    const res = await fetch(CONFIG_API);
    if (res.ok) {
      lastKnownConfigEtag = res.headers?.get?.('ETag') ?? null;
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
 *
 * Sends If-Match with the token from the last read, so a write that would
 * clobber a newer file fails with ConfigVersionConflictError instead. Callers
 * that own a read-modify-write cycle should use updatePersistedConfig, which
 * re-reads and retries for them.
 */
export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
  const res = await fetch(CONFIG_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(lastKnownConfigEtag ? { 'If-Match': lastKnownConfigEtag } : {}),
    },
    body: JSON.stringify(config),
  });

  if (res.ok) {
    lastKnownConfigEtag = res.headers?.get?.('ETag') ?? null;
    return;
  }

  let detail = `Config API error ${res.status}`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data?.error) detail = data.error;
  } catch {
    // Ignore JSON parse errors and keep the generic message.
  }
  if (res.status === 409) {
    // Our snapshot is stale; drop the token so the retry re-reads.
    lastKnownConfigEtag = null;
    throw new ConfigVersionConflictError(detail);
  }
  throw new Error(detail);
}

const MAX_CONFIG_UPDATE_ATTEMPTS = 4;

/**
 * Read-modify-write one part of config.json safely.
 *
 * The mutator receives the CURRENT config (never a cached copy) and returns the
 * object to write. On a version conflict the whole cycle is retried against the
 * newly-read config, so a concurrent writer's change is preserved instead of
 * being overwritten. Returns false when the config could not be read at all.
 */
export async function updatePersistedConfig(
  mutate: (current: PersistedConfig) => PersistedConfig | Promise<PersistedConfig>,
  options?: {
    // Write against an empty config when none exists yet. Explicit user saves
    // need this (a fresh install has no config.json and must still be able to
    // store the first model); background writers must NOT, because they cannot
    // tell "no config" apart from "could not read the config" and would clobber
    // every other setting.
    createIfMissing?: boolean;
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_CONFIG_UPDATE_ATTEMPTS; attempt += 1) {
    const loaded = await loadPersistedConfig();
    const current = loaded ?? (options?.createIfMissing ? {} : null);
    if (!current) {
      return false;
    }
    try {
      await savePersistedConfig(await mutate(current));
      return true;
    } catch (error) {
      if (!isConfigVersionConflict(error) || attempt === MAX_CONFIG_UPDATE_ATTEMPTS - 1) {
        throw error;
      }
      // Another writer won the race; loop to re-read and re-apply.
    }
  }
  return false;
}

/**
 * Read-modify-write just the Aoi embedding config, preserving every other
 * persisted field. Passing an empty/blank key clears it.
 */
export async function saveAoiEmbeddingConfig(
  config: Partial<AoiEmbeddingConfig> | null,
): Promise<void> {
  const normalized = normalizeAoiEmbeddingConfig(config);
  await updatePersistedConfig(
    (existing) => {
      const next: PersistedConfig = { ...existing };
      if (normalized) {
        next.aoiEmbedding = normalized;
      } else {
        delete next.aoiEmbedding;
      }
      return next;
    },
    { createIfMissing: true },
  );
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
  await updatePersistedConfig(
    (existing) => {
      const next: PersistedConfig = { ...existing };
      if (normalized.connectors.length > 0) {
        next.aoiMcpConnectors = normalized;
      } else {
        delete next.aoiMcpConnectors;
      }
      return next;
    },
    { createIfMissing: true },
  );
}
