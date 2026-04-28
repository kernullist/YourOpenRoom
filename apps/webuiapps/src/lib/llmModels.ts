export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'llama.cpp'
  | 'minimax'
  | 'z.ai'
  | 'kimi'
  | 'openrouter'
  | 'opencode'
  | 'opencode-go'
  | 'codex-cli';

export type LLMApiStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export type ModelCategory = 'flagship' | 'general' | 'coding' | 'lightweight' | 'thinking';

export interface ModelInfo {
  id: string;
  name: string;
  category?: ModelCategory;
}

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders?: string;
  command?: string;
  apiStyle?: LLMApiStyle;
}

export interface ProviderModelConfig {
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  models: ModelInfo[];
}

export const LLM_PROVIDER_CONFIGS: Record<LLMProvider, ProviderModelConfig> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', category: 'flagship' },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', category: 'flagship' },
      { id: 'gpt-5.4-thinking', name: 'GPT-5.4 Thinking', category: 'thinking' },
      { id: 'gpt-5.3', name: 'GPT-5.3', category: 'general' },
      { id: 'gpt-5.3-instant', name: 'GPT-5.3 Instant', category: 'general' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', category: 'coding' },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', category: 'coding' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', category: 'lightweight' },
      { id: 'gpt-5-nano', name: 'GPT-5 nano', category: 'lightweight' },
      { id: 'gpt-4.1', name: 'GPT-4.1', category: 'general' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', category: 'lightweight' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', category: 'lightweight' },
      { id: 'gpt-4o', name: 'GPT-4o', category: 'general' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', category: 'lightweight' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', category: 'general' },
    ],
  },

  anthropic: {
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', category: 'flagship' },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', category: 'flagship' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', category: 'general' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', category: 'general' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', category: 'lightweight' },
    ],
  },

  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', category: 'general' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', category: 'thinking' },
    ],
  },

  'llama.cpp': {
    displayName: 'llama.cpp',
    baseUrl: 'http://localhost:8080',
    defaultModel: 'local-model',
    models: [],
  },

  minimax: {
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    defaultModel: 'MiniMax-M2.5',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', category: 'flagship' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', category: 'general' },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', category: 'coding' },
      { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed', category: 'coding' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', category: 'flagship' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', category: 'general' },
      { id: 'MiniMax-M2', name: 'MiniMax M2', category: 'general' },
    ],
  },

  'z.ai': {
    displayName: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    defaultModel: 'glm-5',
    models: [
      { id: 'glm-5', name: 'GLM-5', category: 'flagship' },
      { id: 'glm-5-code', name: 'GLM-5 Code', category: 'coding' },
      { id: 'glm-4.7', name: 'GLM-4.7', category: 'general' },
      { id: 'glm-4.6', name: 'GLM-4.6', category: 'general' },
      { id: 'glm-4.5', name: 'GLM-4.5', category: 'general' },
      { id: 'glm-4.5-x', name: 'GLM-4.5-X', category: 'general' },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air', category: 'lightweight' },
      { id: 'glm-4.5-airx', name: 'GLM-4.5 AirX', category: 'lightweight' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', category: 'lightweight' },
      { id: 'glm-4.7-flashx', name: 'GLM-4.7 FlashX', category: 'lightweight' },
      { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash', category: 'lightweight' },
      { id: 'glm-4-32b-0414-128k', name: 'GLM-4 32B (128K)', category: 'general' },
    ],
  },

  kimi: {
    displayName: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-5',
    models: [
      { id: 'kimi-k2-5', name: 'Kimi K2.5', category: 'flagship' },
      { id: 'kimi-k2', name: 'Kimi K2', category: 'flagship' },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', category: 'thinking' },
      { id: 'kimi-k2-turbo', name: 'Kimi K2 Turbo', category: 'general' },
    ],
  },

  openrouter: {
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'minimax/MiniMax-M2.5',
    models: [
      { id: 'minimax/MiniMax-M2.5', name: 'MiniMax M2.5', category: 'flagship' },
      { id: 'minimax/MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', category: 'general' },
      { id: 'minimax/MiniMax-M2.7', name: 'MiniMax M2.7', category: 'flagship' },
      { id: 'minimax/MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', category: 'general' },
      { id: 'minimax/MiniMax-M2.1', name: 'MiniMax M2.1', category: 'coding' },
      { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', category: 'general' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', category: 'flagship' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', category: 'general' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', category: 'flagship' },
    ],
  },

  opencode: {
    displayName: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen',
    defaultModel: 'opencode/claude-sonnet-4-6',
    models: [
      { id: 'opencode/gpt-5.5', name: 'GPT-5.5', category: 'flagship' },
      { id: 'opencode/gpt-5.5-pro', name: 'GPT-5.5 Pro', category: 'flagship' },
      { id: 'opencode/gpt-5.4', name: 'GPT-5.4', category: 'flagship' },
      { id: 'opencode/gpt-5.4-pro', name: 'GPT-5.4 Pro', category: 'flagship' },
      { id: 'opencode/gpt-5.4-mini', name: 'GPT-5.4 Mini', category: 'lightweight' },
      { id: 'opencode/gpt-5.4-nano', name: 'GPT-5.4 Nano', category: 'lightweight' },
      { id: 'opencode/gpt-5.3-codex', name: 'GPT-5.3 Codex', category: 'coding' },
      { id: 'opencode/gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', category: 'coding' },
      { id: 'opencode/gpt-5.2', name: 'GPT-5.2', category: 'flagship' },
      { id: 'opencode/gpt-5.2-codex', name: 'GPT-5.2 Codex', category: 'coding' },
      { id: 'opencode/gpt-5.1', name: 'GPT-5.1', category: 'general' },
      { id: 'opencode/gpt-5.1-codex', name: 'GPT-5.1 Codex', category: 'coding' },
      { id: 'opencode/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', category: 'coding' },
      { id: 'opencode/gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', category: 'coding' },
      { id: 'opencode/gpt-5', name: 'GPT-5', category: 'general' },
      { id: 'opencode/gpt-5-codex', name: 'GPT-5 Codex', category: 'coding' },
      { id: 'opencode/gpt-5-nano', name: 'GPT-5 Nano', category: 'lightweight' },
      { id: 'opencode/claude-opus-4-7', name: 'Claude Opus 4.7', category: 'flagship' },
      { id: 'opencode/claude-opus-4-6', name: 'Claude Opus 4.6', category: 'flagship' },
      { id: 'opencode/claude-opus-4-5', name: 'Claude Opus 4.5', category: 'flagship' },
      { id: 'opencode/claude-opus-4-1', name: 'Claude Opus 4.1', category: 'flagship' },
      { id: 'opencode/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', category: 'general' },
      { id: 'opencode/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', category: 'general' },
      { id: 'opencode/claude-sonnet-4', name: 'Claude Sonnet 4', category: 'general' },
      { id: 'opencode/claude-haiku-4-5', name: 'Claude Haiku 4.5', category: 'lightweight' },
      { id: 'opencode/claude-3-5-haiku', name: 'Claude Haiku 3.5', category: 'lightweight' },
      { id: 'opencode/qwen3.6-plus', name: 'Qwen3.6 Plus', category: 'flagship' },
      { id: 'opencode/qwen3.5-plus', name: 'Qwen3.5 Plus', category: 'general' },
      { id: 'opencode/minimax-m2.7', name: 'MiniMax M2.7', category: 'flagship' },
      { id: 'opencode/minimax-m2.5', name: 'MiniMax M2.5', category: 'flagship' },
      { id: 'opencode/minimax-m2.5-free', name: 'MiniMax M2.5 Free', category: 'general' },
      { id: 'opencode/glm-5.1', name: 'GLM 5.1', category: 'flagship' },
      { id: 'opencode/glm-5', name: 'GLM 5', category: 'flagship' },
      { id: 'opencode/kimi-k2.5', name: 'Kimi K2.5', category: 'flagship' },
      { id: 'opencode/kimi-k2.6', name: 'Kimi K2.6', category: 'flagship' },
      { id: 'opencode/big-pickle', name: 'Big Pickle', category: 'general' },
      { id: 'opencode/ling-2.6-flash', name: 'Ling 2.6 Flash', category: 'lightweight' },
      { id: 'opencode/hy3-preview-free', name: 'Hy3 Preview Free', category: 'general' },
      { id: 'opencode/nemotron-3-super-free', name: 'Nemotron 3 Super Free', category: 'general' },
    ],
  },

  'opencode-go': {
    displayName: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go',
    defaultModel: 'opencode-go/kimi-k2.5',
    models: [
      { id: 'opencode-go/glm-5.1', name: 'GLM-5.1', category: 'flagship' },
      { id: 'opencode-go/glm-5', name: 'GLM-5', category: 'flagship' },
      { id: 'opencode-go/kimi-k2.5', name: 'Kimi K2.5', category: 'flagship' },
      { id: 'opencode-go/kimi-k2.6', name: 'Kimi K2.6', category: 'flagship' },
      { id: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro', category: 'flagship' },
      { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash', category: 'general' },
      { id: 'opencode-go/mimo-v2-pro', name: 'MiMo-V2-Pro', category: 'general' },
      { id: 'opencode-go/mimo-v2-omni', name: 'MiMo-V2-Omni', category: 'general' },
      { id: 'opencode-go/mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', category: 'general' },
      { id: 'opencode-go/mimo-v2.5', name: 'MiMo-V2.5', category: 'general' },
      { id: 'opencode-go/minimax-m2.7', name: 'MiniMax M2.7', category: 'flagship' },
      { id: 'opencode-go/minimax-m2.5', name: 'MiniMax M2.5', category: 'flagship' },
      { id: 'opencode-go/qwen3.6-plus', name: 'Qwen3.6 Plus', category: 'flagship' },
      { id: 'opencode-go/qwen3.5-plus', name: 'Qwen3.5 Plus', category: 'general' },
    ],
  },

  'codex-cli': {
    displayName: 'Codex CLI',
    baseUrl: '',
    defaultModel: 'gpt-5.3-codex',
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', category: 'flagship' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', category: 'coding' },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', category: 'coding' },
      { id: 'gpt-5.4', name: 'GPT-5.4', category: 'flagship' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', category: 'lightweight' },
    ],
  },
};

export const PROVIDER_MODELS: Record<LLMProvider, string[]> = Object.fromEntries(
  Object.entries(LLM_PROVIDER_CONFIGS).map(([provider, config]) => [
    provider,
    config.models.map((m) => m.id),
  ]),
) as Record<LLMProvider, string[]>;

export function getDefaultProviderConfig(provider: LLMProvider): Omit<LLMConfig, 'apiKey'> {
  const config = LLM_PROVIDER_CONFIGS[provider];
  return {
    provider,
    baseUrl: config.baseUrl,
    model: config.defaultModel,
    ...(provider === 'codex-cli' ? { command: 'codex' } : {}),
  };
}

export function getModelInfo(provider: LLMProvider, modelId: string): ModelInfo | undefined {
  return LLM_PROVIDER_CONFIGS[provider]?.models.find((m) => m.id === modelId);
}

export function getModelsByCategory(provider: LLMProvider, category: ModelCategory): ModelInfo[] {
  return LLM_PROVIDER_CONFIGS[provider]?.models.filter((m) => m.category === category) ?? [];
}

export function isPresetModel(provider: LLMProvider, modelId: string): boolean {
  return LLM_PROVIDER_CONFIGS[provider]?.models.some((m) => m.id === modelId) ?? false;
}

export function getProviderDisplayName(provider: LLMProvider): string {
  return LLM_PROVIDER_CONFIGS[provider]?.displayName ?? provider;
}
