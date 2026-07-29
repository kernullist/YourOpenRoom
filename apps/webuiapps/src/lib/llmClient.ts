/**
 * Minimal LLM API Client
 * Supports OpenAI-compatible / Anthropic-compatible formats
 */

import type { LLMApiStyle, LLMConfig, LLMProvider } from './llmModels';
import {
  applyDeepSeekChatRuntimeOptions,
  applyOpenAiResponsesRuntimeOptions,
  getExplicitModelRuntimeOptions,
  isDeepSeekProvider,
  modelSupportsAnthropicServerSideFallback,
  modelSupportsMidConversationSystem,
  normalizeProviderModelId,
  normalizeReasoningEffort,
  normalizeReasoningSummary,
  normalizeServiceTier,
  normalizeVerbosity,
  providerSupportsAnthropicNativeFeatures,
} from './llmModels';

import { logger } from './logger';
import {
  loadPersistedConfig,
  normalizeResponseLanguageMode,
  normalizeUserProfileDisplayName,
  savePersistedConfig,
  type TavilyConfig,
} from './configPersistence';
import { normalizeTavilyConfig, saveTavilyConfigSync } from './tavilyClient';

const CONFIG_KEY = 'webuiapps-llm-config';
const LLM_MAX_OUTPUT_TOKENS = 8192;
const KIMI_TOOL_CALL_REASONING_FALLBACK =
  'Continuing a tool-call turn where the provider did not return reasoning_content.';

export interface ClaudeCliAuthCheck {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  summary: string;
}

export interface ClaudeCliConnectionCheckResult {
  ok: boolean;
  provider: 'claude-cli';
  command?: string;
  model?: string;
  safeMode?: boolean;
  version?: string;
  auth?: ClaudeCliAuthCheck;
  smokeTest?: string;
  durationMs?: number;
  error?: string;
}

export interface CodexAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  summary: string;
}

export interface CodexAuthStatusResult {
  ok: boolean;
  provider: 'codex-auth';
  version?: string;
  auth?: CodexAuthStatus;
  durationMs?: number;
  error?: string;
}

export interface CodexAuthDeviceLoginSession {
  id: string;
  provider: 'codex-auth';
  state: 'running' | 'completed' | 'error';
  startedAt: number;
  updatedAt: number;
  output: string;
  authorizationUrl?: string;
  userCode?: string;
  browserOpened?: boolean;
  error?: string;
  exitCode?: number | null;
}

export type ModelUsageStatus = 'available' | 'unavailable' | 'error';

export interface ModelUsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  percent?: number;
  unit?: string;
  resetAt?: string;
}

export interface ModelUsageAccount {
  label?: string;
  authMethod?: string;
}

export interface CurrentModelUsageStatus {
  ok: boolean;
  provider: LLMProvider;
  model: string;
  period: 'week';
  status: ModelUsageStatus;
  source: string;
  refreshedAt: number;
  nextRefreshAt?: number;
  account?: ModelUsageAccount;
  usage?: ModelUsageAmount;
  message?: string;
  error?: string;
}

export async function loadConfig(): Promise<LLMConfig | null> {
  try {
    const persisted = await loadPersistedConfig();
    if (persisted?.llm) {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(persisted.llm));
      return persisted.llm;
    }
  } catch {
    // API not available (production / network error)
  }

  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    return null;
  }

  return null;
}

export async function saveConfig(
  config: LLMConfig,
  imageGenConfig?: import('./imageGenClient').ImageGenConfig | null,
  dialogLlmConfig?: import('./configPersistence').DialogLlmConfig | null,
  idaPeConfig?: import('./configPersistence').IdaPeConfig | null,
  userProfileConfig?: import('./configPersistence').UserProfileConfig | null,
  conversationPreferencesConfig?:
    | import('./configPersistence').ConversationPreferencesConfig
    | null,
  kiraConfig?: import('./configPersistence').KiraConfig | null,
  tavilyConfig?: TavilyConfig | null,
): Promise<void> {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));

  const existing = await loadPersistedConfig();
  const persisted: import('./configPersistence').PersistedConfig = {
    llm: config,
    ...(existing?.album ? { album: existing.album } : {}),
    ...(existing?.openvscode ? { openvscode: existing.openvscode } : {}),
    ...(existing?.app ? { app: existing.app } : {}),
    ...(existing?.userProfile ? { userProfile: existing.userProfile } : {}),
    ...(existing?.conversationPreferences
      ? { conversationPreferences: existing.conversationPreferences }
      : {}),
    ...(existing?.gmail ? { gmail: existing.gmail } : {}),
    ...(existing?.aoiEmbedding ? { aoiEmbedding: existing.aoiEmbedding } : {}),
  };
  if (dialogLlmConfig && Object.keys(dialogLlmConfig).length > 0) {
    persisted.dialogLlm = dialogLlmConfig;
  } else if (dialogLlmConfig === undefined && existing?.dialogLlm) {
    persisted.dialogLlm = existing.dialogLlm;
  }
  if (imageGenConfig) {
    persisted.imageGen = imageGenConfig;
  } else if (imageGenConfig === undefined && existing?.imageGen) {
    persisted.imageGen = existing.imageGen;
  }
  if (kiraConfig && Object.keys(kiraConfig).length > 0) {
    persisted.kira = kiraConfig;
  } else if (kiraConfig === undefined && existing?.kira) {
    persisted.kira = existing.kira;
  } else if (kiraConfig !== undefined) {
    delete persisted.kira;
  }
  if (idaPeConfig) {
    persisted.idaPe = idaPeConfig;
  } else if (idaPeConfig === undefined && existing?.idaPe) {
    persisted.idaPe = existing.idaPe;
  }
  if (tavilyConfig !== undefined) {
    const normalizedTavilyConfig = normalizeTavilyConfig(tavilyConfig);
    saveTavilyConfigSync(normalizedTavilyConfig);
    if (normalizedTavilyConfig) {
      persisted.tavily = normalizedTavilyConfig;
    } else {
      delete persisted.tavily;
    }
  } else if (existing?.tavily) {
    persisted.tavily = normalizeTavilyConfig(existing.tavily) ?? existing.tavily;
  }
  const normalizedDisplayName = normalizeUserProfileDisplayName(userProfileConfig?.displayName);
  if (normalizedDisplayName) {
    persisted.userProfile = { displayName: normalizedDisplayName };
  } else if (userProfileConfig === undefined && existing?.userProfile) {
    persisted.userProfile = existing.userProfile;
  } else if (userProfileConfig !== undefined) {
    delete persisted.userProfile;
  }
  if (conversationPreferencesConfig) {
    persisted.conversationPreferences = {
      responseLanguageMode: normalizeResponseLanguageMode(
        conversationPreferencesConfig.responseLanguageMode,
      ),
      ttsEnabled: conversationPreferencesConfig.ttsEnabled === true,
      ttsPreloadCommonPhrases: conversationPreferencesConfig.ttsPreloadCommonPhrases !== false,
      ...(conversationPreferencesConfig.operatorVoicePolicy
        ? { operatorVoicePolicy: conversationPreferencesConfig.operatorVoicePolicy }
        : {}),
    };
  } else if (conversationPreferencesConfig === undefined && existing?.conversationPreferences) {
    persisted.conversationPreferences = existing.conversationPreferences;
  } else if (conversationPreferencesConfig !== undefined) {
    delete persisted.conversationPreferences;
  }

  try {
    await savePersistedConfig(persisted);
  } catch {
    // Keep localStorage in sync even when the dev-server config API is unavailable.
  }
}

export function resolveLlmOverride(
  baseConfig: LLMConfig | null,
  override?: Partial<LLMConfig> | null,
): LLMConfig | null {
  const provider = override?.provider ?? baseConfig?.provider;
  const canInheritBase = !override?.provider || override.provider === baseConfig?.provider;
  const baseUrl =
    override?.baseUrl?.trim() || (canInheritBase ? baseConfig?.baseUrl : undefined) || '';
  const model = override?.model?.trim() || (canInheritBase ? baseConfig?.model : undefined) || '';
  const apiKey = override?.apiKey ?? (canInheritBase ? baseConfig?.apiKey : undefined) ?? '';
  const customHeaders =
    override?.customHeaders?.trim() || (canInheritBase ? baseConfig?.customHeaders : undefined);
  const command = override?.command?.trim() || (canInheritBase ? baseConfig?.command : undefined);
  const apiStyle = override?.apiStyle || (canInheritBase ? baseConfig?.apiStyle : undefined);
  const reasoningEffort =
    normalizeReasoningEffort(override?.reasoningEffort) ??
    (canInheritBase ? normalizeReasoningEffort(baseConfig?.reasoningEffort) : undefined);
  const reasoningSummary =
    normalizeReasoningSummary(override?.reasoningSummary) ??
    (canInheritBase ? normalizeReasoningSummary(baseConfig?.reasoningSummary) : undefined);
  const verbosity =
    normalizeVerbosity(override?.verbosity) ??
    (canInheritBase ? normalizeVerbosity(baseConfig?.verbosity) : undefined);
  const serviceTier =
    normalizeServiceTier(override?.serviceTier) ??
    (canInheritBase ? normalizeServiceTier(baseConfig?.serviceTier) : undefined);
  const parallelToolCalls =
    override?.parallelToolCalls ?? (canInheritBase ? baseConfig?.parallelToolCalls : undefined);

  if (!provider || !model) return null;
  if (!isLoginCliProvider(provider) && !baseUrl) return null;

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    ...(customHeaders ? { customHeaders } : {}),
    ...(command ? { command } : {}),
    ...(apiStyle ? { apiStyle } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(verbosity ? { verbosity } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
  };
}

export function loadConfigSync(): LLMConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    return null;
  }

  return null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  attachments?: ChatImageAttachment[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface ChatImageAttachment {
  id: string;
  type: 'image';
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
  width?: number;
  height?: number;
}

export const SUPPORTED_CHAT_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  reasoningContent?: string;
  // P3.4: real provider token usage (total prompt+completion) when the provider returns
  // it; omitted when the provider/response does not expose usage.
  usage?: { totalTokens: number };
}

// P3.4: extract a positive total-token count from a provider usage object (OpenAI-style
// total_tokens, or input+output). Returns undefined when unavailable so accounting falls
// back to the estimate.
export function extractLlmUsageTotalTokens(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const usage = raw as {
    total_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  const asInt = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);
  const total =
    asInt(usage.total_tokens) ||
    asInt(usage.input_tokens) + asInt(usage.output_tokens) ||
    asInt(usage.prompt_tokens) + asInt(usage.completion_tokens);
  return total > 0 ? Math.trunc(total) : undefined;
}

export interface ChatRequestOptions {
  signal?: AbortSignal;
}

interface InlineToolParseResult {
  content: string;
  toolCalls: ToolCall[];
}

function stripThinkTags(content: string): string {
  const withoutBlocks = content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '');
  return withoutBlocks === content ? content : withoutBlocks.trim();
}

function parseInlineArgValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function extractInlineToolCalls(rawContent: string): InlineToolParseResult {
  const content = stripThinkTags(rawContent);
  if (!content.includes('<arg_key>') || !content.includes('<arg_value>')) {
    return { content, toolCalls: [] };
  }

  const blockRegex = /(?:<tool_call>\s*|\()([a-zA-Z0-9_.-]+)\s*([\s\S]*?)<\/tool_call>/g;
  const toolCalls: ToolCall[] = [];
  let cleanedContent = content;
  let matchIndex = 0;

  for (const match of content.matchAll(blockRegex)) {
    const toolName = match[1]?.trim();
    const body = match[2] ?? '';
    if (!toolName) continue;

    const args: Record<string, unknown> = {};
    const pairRegex =
      /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g;

    for (const pair of body.matchAll(pairRegex)) {
      const key = pair[1]?.trim();
      if (!key) continue;
      args[key] = parseInlineArgValue(pair[2] ?? '');
    }

    if (Object.keys(args).length === 0) continue;

    toolCalls.push({
      id: `inline_tool_${matchIndex++}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
    cleanedContent = cleanedContent.replace(match[0], '');
  }

  return {
    content: cleanedContent.trim(),
    toolCalls,
  };
}

function buildTextProviderResponse(rawContent: string | undefined): LLMResponse {
  const parsedInline = extractInlineToolCalls(rawContent?.trim() || '');
  return {
    content: parsedInline.content,
    toolCalls: parsedInline.toolCalls,
  };
}

function hasVersionSuffix(url: string): boolean {
  return /\/v\d+\/?$/.test(url);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function getOpenAICompletionsPath(baseUrl: string, provider?: LLMConfig['provider']): string {
  if (isDeepSeekProvider(provider)) {
    return 'chat/completions';
  }
  return hasVersionSuffix(baseUrl) ? 'chat/completions' : 'v1/chat/completions';
}

function getAnthropicMessagesPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'messages' : 'v1/messages';
}

function getOpenAIResponsesPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'responses' : 'v1/responses';
}

function isOpenCodeProvider(provider: LLMConfig['provider']): boolean {
  return provider === 'opencode' || provider === 'opencode-go';
}

function isLoginCliProvider(provider: LLMConfig['provider'] | undefined): boolean {
  return provider === 'codex-cli' || provider === 'claude-cli';
}

export function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2],
  };
}

export function isSupportedChatImageMimeType(mimeType: string): boolean {
  return SUPPORTED_CHAT_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

function getChatImageAttachments(message: ChatMessage): ChatImageAttachment[] {
  return (message.attachments ?? []).filter((attachment) => {
    const parsed = parseImageDataUrl(attachment.dataUrl);
    return (
      attachment.type === 'image' &&
      Boolean(parsed) &&
      isSupportedChatImageMimeType(parsed?.mimeType ?? '')
    );
  });
}

function countChatImageAttachments(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => count + getChatImageAttachments(message).length, 0);
}

function validateChatImageAttachments(messages: ChatMessage[]): void {
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== 'image') continue;
      const parsed = parseImageDataUrl(attachment.dataUrl);
      if (!parsed || !isSupportedChatImageMimeType(parsed.mimeType)) {
        throw new Error(
          `Invalid image attachment "${attachment.name || 'image'}". Only PNG, JPEG, WebP, and GIF image data URLs are supported.`,
        );
      }
    }
  }
}

function modelLooksVisionCapable(modelId: string): boolean {
  const model = modelId.toLowerCase();
  return /(?:gpt-4o|gpt-4\.1|gpt-5|claude-|gemini|vision|llava|pixtral|\bvl\b|qwen[-_.]?vl|mimo[-_.]?v2[-_.]?omni)/i.test(
    model,
  );
}

export function supportsChatImageAttachments(
  config: Pick<LLMConfig, 'provider' | 'model' | 'apiStyle'>,
): boolean {
  const normalizedModel = normalizeProviderModel(config).toLowerCase();
  switch (config.provider) {
    case 'openai':
    case 'anthropic':
      return modelLooksVisionCapable(normalizedModel);
    case 'openrouter':
    case 'opencode':
      return modelLooksVisionCapable(normalizedModel);
    case 'llama.cpp':
    case 'minimax':
    case 'opencode-go':
      return modelLooksVisionCapable(normalizedModel);
    default:
      return false;
  }
}

function ensureImageInputSupport(messages: ChatMessage[], config: LLMConfig): void {
  validateChatImageAttachments(messages);
  const imageCount = countChatImageAttachments(messages);
  if (imageCount === 0) return;
  if (supportsChatImageAttachments(config)) return;
  throw new Error(
    `Image input is not supported for ${config.provider}/${config.model}. Select a vision-capable main model before sending images.`,
  );
}

function stripLocalMessageFields(message: ChatMessage): Omit<ChatMessage, 'attachments'> {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content !== undefined
      ? { reasoning_content: message.reasoning_content }
      : {}),
  };
}

function buildOpenAiChatContent(message: ChatMessage): string | Array<Record<string, unknown>> {
  const attachments = getChatImageAttachments(message);
  if (message.role !== 'user' || attachments.length === 0) {
    return message.content;
  }

  return [
    ...(message.content.trim() ? [{ type: 'text', text: message.content }] : []),
    ...attachments.map((attachment) => ({
      type: 'image_url',
      image_url: {
        url: attachment.dataUrl,
        detail: 'auto',
      },
    })),
  ];
}

function buildOpenAiResponsesContent(
  message: ChatMessage,
): string | Array<Record<string, unknown>> {
  const attachments = getChatImageAttachments(message);
  if (message.role !== 'user' || attachments.length === 0) {
    return message.content;
  }

  return [
    ...(message.content.trim() ? [{ type: 'input_text', text: message.content }] : []),
    ...attachments.map((attachment) => ({
      type: 'input_image',
      image_url: attachment.dataUrl,
      detail: 'auto',
    })),
  ];
}

function buildAnthropicContent(message: ChatMessage): string | Array<Record<string, unknown>> {
  const attachments = getChatImageAttachments(message);
  if (message.role !== 'user' || attachments.length === 0) {
    return message.content;
  }

  return [
    ...attachments.flatMap((attachment) => {
      const parsed = parseImageDataUrl(attachment.dataUrl);
      if (!parsed) return [];
      return [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mimeType,
            data: parsed.base64,
          },
        },
      ];
    }),
    ...(message.content.trim() ? [{ type: 'text', text: message.content }] : []),
  ];
}

function normalizeProviderModel(config: Pick<LLMConfig, 'provider' | 'model'>): string {
  return normalizeProviderModelId(config.provider, config.model);
}

function resolveOpenCodeApiStyle(config: LLMConfig): LLMApiStyle {
  if (config.apiStyle) return config.apiStyle;
  const model = normalizeProviderModel(config).toLowerCase();
  if (model.startsWith('gpt-')) return 'openai-responses';
  if (model.startsWith('claude-')) return 'anthropic-messages';
  if (config.provider === 'opencode-go' && /^minimax-m2\./.test(model)) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function shouldUseOpenAIResponses(config: LLMConfig): boolean {
  if (config.apiStyle === 'openai-responses') return true;
  return (
    config.provider === 'openai' && normalizeProviderModel(config).toLowerCase().startsWith('gpt-5')
  );
}

function isKimiToolReasoningSensitiveModel(config: Pick<LLMConfig, 'provider' | 'model'>): boolean {
  const model = normalizeProviderModel(config).toLowerCase();
  return model.includes('kimi-k2');
}

function shouldDisableOpenAiThinking(config: LLMConfig): boolean {
  if (!isOpenCodeProvider(config.provider) && config.provider !== 'kimi') return false;
  return isKimiToolReasoningSensitiveModel(config);
}

function getOpenAiAssistantReasoningContent(
  config: Pick<LLMConfig, 'provider' | 'model'>,
  message: Pick<ChatMessage, 'reasoning_content' | 'tool_calls'>,
): string | undefined {
  const existing = message.reasoning_content?.trim();
  if (existing) return existing;
  if (message.tool_calls?.length && isKimiToolReasoningSensitiveModel(config)) {
    return KIMI_TOOL_CALL_REASONING_FALLBACK;
  }
  return undefined;
}

function parseCustomHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim().toLowerCase();
      const val = trimmed.slice(idx + 1).trim();
      headers[`x-custom-${key}`] = val;
    }
  }
  return headers;
}

export async function chat(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions = {},
): Promise<LLMResponse> {
  ensureImageInputSupport(messages, config);
  console.info('[LLM] chat() start', {
    provider: config.provider,
    model: config.model,
    messageCount: messages.length,
    toolCount: tools.length,
  });
  logger.info(
    'LLM',
    'chat() called, provider:',
    config.provider,
    'model:',
    config.model,
    'messages:',
    messages.length,
  );
  if (config.provider === 'codex-cli') {
    return chatCodexCli(messages, tools, config, options);
  }
  if (config.provider === 'codex-auth') {
    return chatCodexAuth(messages, tools, config, options);
  }
  if (config.provider === 'claude-cli') {
    return chatClaudeCli(messages, tools, config, options);
  }
  if (isOpenCodeProvider(config.provider)) {
    const apiStyle = resolveOpenCodeApiStyle(config);
    if (apiStyle === 'openai-responses') {
      return chatOpenAIResponses(messages, tools, config, options);
    }
    if (apiStyle === 'anthropic-messages') {
      return chatAnthropic(messages, tools, config, options);
    }
    return chatOpenAI(messages, tools, config, options);
  }
  if (config.provider === 'anthropic' || config.provider === 'minimax') {
    return chatAnthropic(messages, tools, config, options);
  }
  if (shouldUseOpenAIResponses(config)) {
    return chatOpenAIResponses(messages, tools, config, options);
  }
  return chatOpenAI(messages, tools, config, options);
}

async function chatClaudeCli(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions,
): Promise<LLMResponse> {
  const runtimeOptions = getExplicitModelRuntimeOptions(config);
  const res = await fetch('/api/claude-cli-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      tools,
      model: config.model,
      command: config.command?.trim() || 'claude',
      reasoningEffort: runtimeOptions.reasoningEffort,
    }),
    signal: options.signal,
  });
  const data = (await res.json()) as { content?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Claude CLI error ${res.status}`);
  }
  return buildTextProviderResponse(data.content);
}

export async function checkClaudeCliConnection(
  config: Pick<LLMConfig, 'provider' | 'model' | 'command' | 'reasoningEffort'>,
): Promise<ClaudeCliConnectionCheckResult> {
  if (config.provider !== 'claude-cli') {
    throw new Error('Claude CLI connection check only supports the claude-cli provider.');
  }

  const res = await fetch('/api/claude-cli-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      command: config.command?.trim() || 'claude',
      reasoningEffort: config.reasoningEffort,
    }),
  });
  const data = (await res.json()) as ClaudeCliConnectionCheckResult;
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Claude CLI connection check failed with ${res.status}`);
  }
  return data;
}

export async function checkCodexAuthStatus(
  config: Pick<LLMConfig, 'provider'>,
): Promise<CodexAuthStatusResult> {
  if (config.provider !== 'codex-auth') {
    throw new Error('Codex Auth status check only supports the codex-auth provider.');
  }

  const res = await fetch('/api/codex-auth-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = (await res.json()) as CodexAuthStatusResult;
  if (!res.ok) {
    throw new Error(data.error || `Codex Auth status check failed with ${res.status}`);
  }
  return data;
}

export async function startCodexAuthDeviceLogin(
  config: Pick<LLMConfig, 'provider'>,
): Promise<CodexAuthDeviceLoginSession> {
  if (config.provider !== 'codex-auth') {
    throw new Error('Codex Auth device login only supports the codex-auth provider.');
  }

  const res = await fetch('/api/codex-auth-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = (await res.json()) as CodexAuthDeviceLoginSession & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Codex Auth device login failed with ${res.status}`);
  }
  return data;
}

export async function getCodexAuthDeviceLoginStatus(
  sessionId: string,
): Promise<CodexAuthDeviceLoginSession> {
  const params = new URLSearchParams({ id: sessionId });
  const res = await fetch(`/api/codex-auth-login-status?${params.toString()}`);
  const data = (await res.json()) as CodexAuthDeviceLoginSession & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Codex Auth device login status failed with ${res.status}`);
  }
  return data;
}

export async function fetchCurrentModelUsage(
  config: Pick<LLMConfig, 'provider' | 'model' | 'command'>,
): Promise<CurrentModelUsageStatus> {
  const res = await fetch('/api/llm-usage-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: config.provider,
      model: config.model,
      command: config.command?.trim() || undefined,
    }),
  });
  const data = (await res.json()) as CurrentModelUsageStatus & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `LLM usage status check failed with ${res.status}`);
  }
  return data;
}

async function chatCodexCli(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions,
): Promise<LLMResponse> {
  const runtimeOptions = getExplicitModelRuntimeOptions(config);
  const res = await fetch('/api/codex-cli-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      tools,
      model: config.model,
      command: config.command?.trim() || 'codex',
      reasoningEffort: runtimeOptions.reasoningEffort,
      reasoningSummary: runtimeOptions.reasoningSummary,
      verbosity: runtimeOptions.verbosity,
      serviceTier: runtimeOptions.serviceTier,
    }),
    signal: options.signal,
  });
  const data = (await res.json()) as { content?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Codex CLI error ${res.status}`);
  }
  return buildTextProviderResponse(data.content);
}

async function chatCodexAuth(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions,
): Promise<LLMResponse> {
  const runtimeOptions = getExplicitModelRuntimeOptions(config);
  const res = await fetch('/api/codex-auth-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      tools,
      model: config.model,
      reasoningEffort: runtimeOptions.reasoningEffort,
      reasoningSummary: runtimeOptions.reasoningSummary,
      verbosity: runtimeOptions.verbosity,
      serviceTier: runtimeOptions.serviceTier,
    }),
    signal: options.signal,
  });
  const data = (await res.json()) as { content?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Codex Auth error ${res.status}`);
  }
  return buildTextProviderResponse(data.content);
}

async function chatOpenAI(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions,
): Promise<LLMResponse> {
  const requestMessages = messages.map((message) => {
    if (message.role !== 'assistant') {
      return {
        ...stripLocalMessageFields(message),
        content: buildOpenAiChatContent(message),
      };
    }
    const reasoningContent = getOpenAiAssistantReasoningContent(config, message);
    const requestMessage = stripLocalMessageFields(message);
    return reasoningContent
      ? { ...requestMessage, reasoning_content: reasoningContent }
      : requestMessage;
  });
  const body: Record<string, unknown> = {
    model: normalizeProviderModel(config),
    messages: requestMessages,
    max_tokens: LLM_MAX_OUTPUT_TOKENS,
    stream: false,
  };
  if (shouldDisableOpenAiThinking(config)) {
    body.thinking = { type: 'disabled' };
    body.reasoning = { enabled: false };
  }
  applyDeepSeekChatRuntimeOptions(body, config);
  if (tools.length > 0) {
    body.tools = tools;
  }

  const targetUrl = joinUrl(
    config.baseUrl,
    getOpenAICompletionsPath(config.baseUrl, config.provider),
  );
  const toolNames = Array.isArray(tools) ? tools.map((t) => t.function?.name).filter(Boolean) : [];
  console.info('[LLM] OpenAI-compatible request', {
    targetUrl,
    model: normalizeProviderModel(config),
    messageCount: messages.length,
    toolNames,
  });
  logger.info('ToolLog', 'LLM Request: toolCount=', tools.length, 'toolNames=', toolNames);
  logger.info('LLM', 'Request:', {
    targetUrl,
    model: config.model,
    messageCount: messages.length,
    toolCount: tools.length,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-LLM-Target-URL': targetUrl,
    ...parseCustomHeaders(config.customHeaders),
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  let res: Response;
  try {
    res = await fetch('/api/llm-proxy', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    console.error('[LLM] OpenAI-compatible request failed before response', err);
    throw err;
  }

  console.info('[LLM] OpenAI-compatible response received', {
    status: res.status,
    ok: res.ok,
  });
  logger.info('LLM', 'Response status:', res.status);
  const text = await res.text();
  console.info('[LLM] OpenAI-compatible response body preview', text.slice(0, 500));
  logger.info('LLM', 'Response body:', text.slice(0, 500));

  if (!res.ok) {
    console.error('[LLM] OpenAI-compatible response error', {
      status: res.status,
      bodyPreview: text.slice(0, 500),
    });
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);
  const choice = data.choices?.[0]?.message;
  const parsedInline = extractInlineToolCalls(choice?.content || '');
  const toolCalls = choice?.tool_calls?.length ? choice.tool_calls : parsedInline.toolCalls;
  const calledNames = toolCalls
    .map((tc: { function?: { name?: string } }) => tc.function?.name)
    .filter(Boolean);
  console.info('[LLM] OpenAI-compatible parsed response', {
    contentPreview: (choice?.tool_calls?.length
      ? stripThinkTags(choice?.content || '')
      : parsedInline.content
    ).slice(0, 200),
    toolCallCount: toolCalls.length,
    calledNames,
  });
  logger.info(
    'ToolLog',
    'LLM Response: toolCalls count=',
    toolCalls.length,
    'calledNames=',
    calledNames,
  );
  const usageTokens = extractLlmUsageTotalTokens(data.usage);
  return {
    content: choice?.tool_calls?.length
      ? stripThinkTags(choice?.content || '')
      : parsedInline.content,
    toolCalls,
    reasoningContent: choice?.reasoning_content,
    ...(usageTokens !== undefined ? { usage: { totalTokens: usageTokens } } : {}),
  };
}

async function chatOpenAIResponses(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions,
): Promise<LLMResponse> {
  const input: Array<Record<string, unknown>> = [];
  let instructions = '';

  for (const message of messages) {
    if (message.role === 'system') {
      instructions = instructions ? `${instructions}\n\n${message.content}` : message.content;
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const toolCall of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    input.push({ role: 'user', content: buildOpenAiResponsesContent(message) });
  }

  const body: Record<string, unknown> = {
    model: normalizeProviderModel(config),
    input,
    max_output_tokens: LLM_MAX_OUTPUT_TOKENS,
    stream: false,
  };
  if (instructions) body.instructions = instructions;
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }
  applyOpenAiResponsesRuntimeOptions(body, config, tools.length > 0);

  const targetUrl = joinUrl(config.baseUrl, getOpenAIResponsesPath(config.baseUrl));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-LLM-Target-URL': targetUrl,
    ...parseCustomHeaders(config.customHeaders),
  };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const res = await fetch('/api/llm-proxy', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Responses API error ${res.status}: ${text}`);
  }

  const data = JSON.parse(text) as {
    output_text?: string;
    output?: Array<
      | {
          type?: 'message';
          content?: Array<{ type?: string; text?: string; output_text?: string }>;
        }
      | {
          type?: 'function_call';
          call_id?: string;
          id?: string;
          name?: string;
          arguments?: string;
        }
    >;
  };
  const contentParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        const textPart = part.text ?? part.output_text ?? '';
        if (textPart) contentParts.push(textPart);
      }
    }
    if (item.type === 'function_call' && item.name) {
      toolCalls.push({
        id: item.call_id || item.id || `tool_${toolCalls.length}`,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments || '{}',
        },
      });
    }
  }

  const usageTokens = extractLlmUsageTotalTokens((data as { usage?: unknown }).usage);
  return {
    content: stripThinkTags(data.output_text || contentParts.join('')).trim(),
    toolCalls,
    ...(usageTokens !== undefined ? { usage: { totalTokens: usageTokens } } : {}),
  };
}

type AnthropicRequestMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<Record<string, unknown>>;
};

const ANTHROPIC_SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function mergeAnthropicBeta(existing: string | undefined, value: string): string {
  const entries = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.includes(value)) {
    entries.push(value);
  }
  return entries.join(',');
}

function withoutAnthropicBeta(existing: string | undefined, value: string): string {
  return (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== value)
    .join(',');
}

// Places the trailing operator context at the tail of the conversation, where it
// reads as newer than the recalled history, and returns whatever could not go
// there so the caller can fold it back into the system field.
function placeAnthropicOperatorContext(
  anthropicMessages: AnthropicRequestMessage[],
  operatorContext: string[],
  wireModel: string,
  nativeFeatures: boolean,
): string {
  if (operatorContext.length === 0) {
    return '';
  }
  const joined = operatorContext.join('\n\n');
  const last = anthropicMessages[anthropicMessages.length - 1];
  const hasPendingToolUse =
    last?.role === 'assistant' &&
    Array.isArray(last.content) &&
    last.content.some((block) => (block as { type?: string }).type === 'tool_use');
  if (!last || hasPendingToolUse) {
    // A text turn appended after an unresolved tool_use would break the
    // tool_use/tool_result pairing, so this one goes back into the system field.
    return joined;
  }
  if (nativeFeatures && last.role === 'user' && modelSupportsMidConversationSystem(wireModel)) {
    // The operator channel proper: unspoofable, and it leaves the cached prefix
    // in front of it untouched. Valid only directly after a user turn.
    anthropicMessages.push({ role: 'system', content: joined });
    return '';
  }
  // Consecutive same-role messages are merged into one turn, so this is safe
  // after either a user or an assistant turn.
  anthropicMessages.push({
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${joined}\n</system-reminder>` }],
  });
  return '';
}

function buildAnthropicSystemField(
  systemMsg: string,
  foldedOperatorContext: string,
  nativeFeatures: boolean,
): string | Array<Record<string, unknown>> | undefined {
  if (!systemMsg && !foldedOperatorContext) {
    return undefined;
  }
  if (!nativeFeatures) {
    return [systemMsg, foldedOperatorContext].filter(Boolean).join('\n\n');
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (systemMsg) {
    // The breakpoint sits at the end of the base prompt. Within one user turn
    // the agentic loop re-sends this byte-identical across every tool
    // round-trip, so iteration two onward reads it from cache instead of paying
    // full input price on the persona, the tool policy and every appended block.
    blocks.push({ type: 'text', text: systemMsg, cache_control: { type: 'ephemeral' } });
  }
  if (foldedOperatorContext) {
    blocks.push({ type: 'text', text: foldedOperatorContext });
  }
  return blocks;
}

async function chatAnthropic(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
  options: ChatRequestOptions,
): Promise<LLMResponse> {
  const systemMessages = messages.filter((m) => m.role === 'system');
  // Only the first system message is the base prompt. Every later one is
  // operator context that has to read as newer than the recalled conversation:
  // the final execution guard with the file-task and outcome contracts, a
  // confirmed-proposal instruction, a trend follow-up. find() + filter() used to
  // drop all of them on this route, so on Claude and MiniMax those instructions
  // never reached the model at all -- the OpenAI route maps messages 1:1 and
  // kept them, which is why the two routes behaved differently.
  const systemMsg = systemMessages[0]?.content || '';
  const operatorContext = systemMessages
    .slice(1)
    .map((m) => m.content ?? '')
    .filter((content) => content.trim().length > 0);
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const anthropicMessages: AnthropicRequestMessage[] = nonSystemMessages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: m.tool_call_id,
            content: m.content,
          },
        ],
      };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant' as const,
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.tool_calls.map((tc) => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          })),
        ],
      };
    }
    return {
      role: m.role as 'user' | 'assistant',
      content: buildAnthropicContent(m),
    };
  });

  const anthropicTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const wireModel = normalizeProviderModel(config);
  const nativeFeatures = providerSupportsAnthropicNativeFeatures(config.provider);
  const foldedOperatorContext = placeAnthropicOperatorContext(
    anthropicMessages,
    operatorContext,
    wireModel,
    nativeFeatures,
  );

  const body: Record<string, unknown> = {
    model: wireModel,
    max_tokens: LLM_MAX_OUTPUT_TOKENS,
    messages: anthropicMessages,
  };
  const systemField = buildAnthropicSystemField(systemMsg, foldedOperatorContext, nativeFeatures);
  if (systemField !== undefined) body.system = systemField;
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  // Aoi's subject matter -- anti-cheat, kernel telemetry, memory inspection --
  // sits next to what the cyber classifier is looking for, so a false-positive
  // refusal is a routine risk here rather than an edge case. "default" routes by
  // refusal category instead of pinning a substitute, so there is no model list
  // to migrate when a target is deprecated.
  const serverSideFallback = nativeFeatures && modelSupportsAnthropicServerSideFallback(wireModel);
  if (serverSideFallback) {
    body.fallbacks = 'default';
  }

  const anthropicToolNames = anthropicTools.map((t) => t.name).filter(Boolean);
  console.info('[LLM] Anthropic-compatible request', {
    targetUrl: joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl)),
    model: normalizeProviderModel(config),
    messageCount: anthropicMessages.length,
    toolNames: anthropicToolNames,
  });
  logger.info(
    'ToolLog',
    'Anthropic Request: toolCount=',
    anthropicTools.length,
    'toolNames=',
    anthropicToolNames,
  );
  const targetUrl = joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl));
  logger.info('LLM', 'Anthropic Request:', {
    targetUrl,
    model: config.model,
    messageCount: anthropicMessages.length,
    toolCount: anthropicTools.length,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'X-LLM-Target-URL': targetUrl,
    ...parseCustomHeaders(config.customHeaders),
  };
  if (config.apiKey.trim()) {
    headers['x-api-key'] = config.apiKey;
  }
  // After the custom-header spread, so a caller-supplied anthropic-beta is
  // merged with this one rather than replaced by it.
  if (serverSideFallback) {
    headers['anthropic-beta'] = mergeAnthropicBeta(
      headers['anthropic-beta'],
      ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
    );
  }
  let res: Response;
  try {
    res = await fetch('/api/llm-proxy', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    console.error('[LLM] Anthropic-compatible request failed before response', err);
    throw err;
  }

  console.info('[LLM] Anthropic-compatible response received', {
    status: res.status,
    ok: res.ok,
  });
  logger.info('LLM', 'Anthropic Response status:', res.status);
  if (!res.ok) {
    const text = await res.text();
    // The fallbacks parameter is a beta, so a key without it enabled answers 400.
    // Losing every turn over an optional resilience feature is worse than not
    // having it, so drop it and retry once.
    if (serverSideFallback && res.status === 400 && /fallback/i.test(text)) {
      logger.warn('LLM', 'Anthropic rejected server-side fallback, retrying without it');
      delete body.fallbacks;
      const retryHeaders = { ...headers };
      const remainingBeta = withoutAnthropicBeta(
        retryHeaders['anthropic-beta'],
        ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
      );
      if (remainingBeta) {
        retryHeaders['anthropic-beta'] = remainingBeta;
      } else {
        delete retryHeaders['anthropic-beta'];
      }
      res = await fetch('/api/llm-proxy', {
        method: 'POST',
        headers: retryHeaders,
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!res.ok) {
        const retryText = await res.text();
        logger.error('LLM', 'Anthropic Error body:', retryText.slice(0, 500));
        throw new Error(`Anthropic API error ${res.status}: ${retryText}`);
      }
    } else {
      console.error('[LLM] Anthropic-compatible response error', {
        status: res.status,
        bodyPreview: text.slice(0, 500),
      });
      logger.error('LLM', 'Anthropic Error body:', text.slice(0, 500));
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }
  }

  const data = await res.json();
  console.info(
    '[LLM] Anthropic-compatible response body preview',
    JSON.stringify(data).slice(0, 500),
  );
  logger.info('LLM', 'Anthropic Response data:', JSON.stringify(data).slice(0, 500));

  const usageIterations = (data as { usage?: { iterations?: Array<{ type?: string } | null> } })
    .usage?.iterations;
  if (
    Array.isArray(usageIterations) &&
    usageIterations.some((entry) => entry?.type === 'fallback_message')
  ) {
    // A sticky-routed turn carries no fallback content block, so this is the only
    // signal that a substitute model answered.
    logger.warn('LLM', 'Anthropic served by fallback model:', (data as { model?: string }).model);
  }

  // A declined request is a successful 200 whose content is empty. Without this
  // branch Aoi renders a blank turn with no emotion and no suggested replies, and
  // nothing anywhere says why -- respond_to_user was never called.
  if ((data as { stop_reason?: string }).stop_reason === 'refusal') {
    const details = (
      data as { stop_details?: { category?: string | null; explanation?: string | null } }
    ).stop_details;
    const category = details?.category || 'unspecified';
    logger.error('LLM', 'Anthropic refusal:', { category, explanation: details?.explanation });
    const explanation = details?.explanation ? ` ${details.explanation}` : '';
    throw new Error(
      `Anthropic declined this request (${category}).${explanation} ` +
        'Rephrase it, or route this turn through a provider without that classifier.',
    );
  }

  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const block of data.content || []) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const calledNames = toolCalls.map((tc) => tc.function.name).filter(Boolean);
  console.info('[LLM] Anthropic-compatible parsed response', {
    contentPreview: stripThinkTags(content).slice(0, 200),
    toolCallCount: toolCalls.length,
    calledNames,
  });
  logger.info(
    'ToolLog',
    'Anthropic Response: toolCalls count=',
    toolCalls.length,
    'calledNames=',
    calledNames,
  );
  const usageTokens = extractLlmUsageTotalTokens((data as { usage?: unknown }).usage);
  return {
    content: stripThinkTags(content),
    toolCalls,
    ...(usageTokens !== undefined ? { usage: { totalTokens: usageTokens } } : {}),
  };
}
