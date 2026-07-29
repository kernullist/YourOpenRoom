/**
 * Unit tests for llmClient.ts
 *
 * Environment: happy-dom (provides localStorage, fetch globals)
 * Mock strategy:
 *   - fetch: vi.fn() via globalThis.fetch per test
 *   - localStorage: happy-dom provides real implementation, cleared in beforeEach
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  loadConfigSync,
  saveConfig,
  chat,
  extractLlmUsageTotalTokens,
  checkCodexAuthStatus,
  checkClaudeCliConnection,
  fetchCurrentModelUsage,
  getCodexAuthDeviceLoginStatus,
  startCodexAuthDeviceLogin,
  type ChatImageAttachment,
  type ChatMessage,
  type ToolDef,
} from '../llmClient';
import {
  applyDeepSeekChatRuntimeOptions,
  applyOpenAiResponsesOutputSchema,
  getDefaultProviderConfig,
  PROVIDER_MODELS,
  type LLMConfig,
} from '../llmModels';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'webuiapps-llm-config';
const TAVILY_CONFIG_KEY = 'webuiapps-tavily-config';

const MOCK_OPENAI_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4',
};

const MOCK_ANTHROPIC_CONFIG: LLMConfig = {
  provider: 'anthropic',
  apiKey: 'ant-test-key',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-6',
};

const MOCK_LLAMACPP_CONFIG: LLMConfig = {
  provider: 'llama.cpp',
  apiKey: '',
  baseUrl: 'http://athena:8081',
  model: 'Qwen_Qwen3.5-35B-A3B',
};

const MOCK_MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

const MOCK_IMAGE_ATTACHMENT: ChatImageAttachment = {
  id: 'img-1',
  type: 'image',
  name: 'screen.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,aGVsbG8=',
  size: 5,
  width: 2,
  height: 2,
};

const MOCK_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];
const MOCK_INLINE_RESPOND_TOOL_CONTENT = `<tool_call>
respond_to_user
<arg_key>character_expression</arg_key>
<arg_value>{"content":"Done.","emotion":"peaceful"}</arg_value>
<arg_key>user_interaction</arg_key>
<arg_value>{"suggested_replies":["Thanks","Show me","Undo"]}</arg_value>
</tool_call>`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOpenAIResponse(
  content: string,
  toolCalls: unknown[] = [],
  messageExtras: Record<string, unknown> = {},
) {
  const body = JSON.stringify({
    choices: [{ message: { content, tool_calls: toolCalls, ...messageExtras } }],
  });
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as unknown as Response;
}

function makeResponsesApiResponse(content: string, toolCalls: unknown[] = []) {
  const body = JSON.stringify({
    output_text: content,
    output: toolCalls,
  });
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as unknown as Response;
}

function makeAnthropicResponse(textContent: string) {
  const body = { content: [{ type: 'text', text: textContent }] };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, bodyText: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(bodyText),
    json: () => Promise.resolve({ error: bodyText }),
  } as unknown as Response;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractLlmUsageTotalTokens() (P3.4)', () => {
  it('reads OpenAI-style total_tokens', () => {
    expect(extractLlmUsageTotalTokens({ total_tokens: 1234 })).toBe(1234);
  });

  it('sums Anthropic-style input + output tokens when there is no total', () => {
    expect(extractLlmUsageTotalTokens({ input_tokens: 300, output_tokens: 120 })).toBe(420);
  });

  it('falls back to prompt + completion tokens', () => {
    expect(extractLlmUsageTotalTokens({ prompt_tokens: 50, completion_tokens: 25 })).toBe(75);
  });

  it('returns undefined for missing / zero / malformed usage', () => {
    expect(extractLlmUsageTotalTokens(undefined)).toBeUndefined();
    expect(extractLlmUsageTotalTokens(null)).toBeUndefined();
    expect(extractLlmUsageTotalTokens('nope')).toBeUndefined();
    expect(extractLlmUsageTotalTokens({})).toBeUndefined();
    expect(extractLlmUsageTotalTokens({ total_tokens: 0 })).toBeUndefined();
    expect(extractLlmUsageTotalTokens({ total_tokens: -5 })).toBeUndefined();
  });

  it('truncates a fractional total to an integer', () => {
    expect(extractLlmUsageTotalTokens({ total_tokens: 12.9 })).toBe(12);
  });
});

describe('getDefaultProviderConfig()', () => {
  it('returns correct defaults for openai', () => {
    const cfg = getDefaultProviderConfig('openai');
    expect(cfg.provider).toBe('openai');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.model).toBe('gpt-5.4');
    expect('apiKey' in cfg).toBe(false);
  });

  it('returns correct defaults for anthropic', () => {
    const cfg = getDefaultProviderConfig('anthropic');
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(cfg.model).toBe('claude-opus-5');
  });

  it('returns correct defaults for deepseek', () => {
    const cfg = getDefaultProviderConfig('deepseek');
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.baseUrl).toBe('https://api.deepseek.com');
    expect(cfg.model).toBe('deepseek-v4-pro');
  });

  it('returns correct defaults for llama.cpp', () => {
    const cfg = getDefaultProviderConfig('llama.cpp');
    expect(cfg.provider).toBe('llama.cpp');
    expect(cfg.baseUrl).toBe('http://localhost:8080');
    expect(cfg.model).toBe('local-model');
  });

  it('returns correct defaults for minimax', () => {
    const cfg = getDefaultProviderConfig('minimax');
    expect(cfg.provider).toBe('minimax');
    expect(cfg.baseUrl).toBe('https://api.minimax.io/anthropic/v1');
    expect(cfg.model).toBe('MiniMax-M2.5');
  });

  it('returns correct defaults for z.ai', () => {
    const cfg = getDefaultProviderConfig('z.ai');
    expect(cfg.provider).toBe('z.ai');
    expect(cfg.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(cfg.model).toBe('glm-5');
  });

  it('returns correct defaults for kimi', () => {
    const cfg = getDefaultProviderConfig('kimi');
    expect(cfg.provider).toBe('kimi');
    expect(cfg.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(cfg.model).toBe('kimi-k2-5');
  });

  it('returns correct defaults for openrouter', () => {
    const cfg = getDefaultProviderConfig('openrouter');
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.model).toBe('minimax/MiniMax-M2.5');
  });

  it('returns correct defaults for codex-cli', () => {
    const cfg = getDefaultProviderConfig('codex-cli');
    expect(cfg.provider).toBe('codex-cli');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.model).toBe('gpt-5.5');
    expect(cfg.command).toBe('codex');
  });

  it('returns correct defaults for codex-auth', () => {
    const cfg = getDefaultProviderConfig('codex-auth');
    expect(cfg.provider).toBe('codex-auth');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.model).toBe('gpt-5.5');
    expect(cfg.command).toBeUndefined();
  });

  it('returns correct defaults for claude-cli', () => {
    const cfg = getDefaultProviderConfig('claude-cli');
    expect(cfg.provider).toBe('claude-cli');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.model).toBe('claude-opus-5');
    expect(cfg.command).toBe('claude');
  });

  it('exposes the current Anthropic Claude generation', () => {
    expect(PROVIDER_MODELS.anthropic).toEqual(
      expect.arrayContaining(['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']),
    );
  });

  it('includes ChatGPT Pro models available through Codex CLI', () => {
    expect(PROVIDER_MODELS['codex-cli']).toEqual(expect.arrayContaining(['gpt-5.5']));
  });

  it('includes ChatGPT Pro models available through Codex Auth', () => {
    expect(PROVIDER_MODELS['codex-auth']).toEqual(expect.arrayContaining(['gpt-5.5']));
  });

  it('includes Claude CLI model aliases', () => {
    expect(PROVIDER_MODELS['claude-cli']).toEqual(expect.arrayContaining(['sonnet', 'opus']));
  });

  it('includes current DeepSeek V4 API models and legacy aliases', () => {
    expect(PROVIDER_MODELS.deepseek).toEqual(
      expect.arrayContaining([
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-chat',
        'deepseek-reasoner',
      ]),
    );
  });

  it('returns correct defaults for opencode', () => {
    const cfg = getDefaultProviderConfig('opencode');
    expect(cfg.provider).toBe('opencode');
    expect(cfg.baseUrl).toBe('https://opencode.ai/zen');
    expect(cfg.model).toBe('opencode/claude-sonnet-4-6');
  });

  it('returns correct defaults for opencode-go', () => {
    const cfg = getDefaultProviderConfig('opencode-go');
    expect(cfg.provider).toBe('opencode-go');
    expect(cfg.baseUrl).toBe('https://opencode.ai/zen/go');
    expect(cfg.model).toBe('opencode-go/kimi-k2.5');
  });

  it('includes the current OpenCode Go subscription model IDs', () => {
    expect(PROVIDER_MODELS['opencode-go']).toEqual(
      expect.arrayContaining([
        'opencode-go/glm-5.1',
        'opencode-go/kimi-k2.6',
        'opencode-go/deepseek-v4-pro',
        'opencode-go/mimo-v2.5',
      ]),
    );
  });

  it('returns consistent values for the same provider', () => {
    const a = getDefaultProviderConfig('openai');
    const b = getDefaultProviderConfig('openai');
    expect(a).toStrictEqual(b);
  });
});

// ─── loadConfigSync() ─────────────────────────────────────────────────────────

describe('loadConfigSync()', () => {
  it('returns null when localStorage is empty', () => {
    expect(loadConfigSync()).toBeNull();
  });

  it('returns parsed config when localStorage has valid JSON', () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_OPENAI_CONFIG));
    expect(loadConfigSync()).toEqual(MOCK_OPENAI_CONFIG);
  });

  it('returns null when localStorage contains invalid JSON', () => {
    localStorage.setItem(CONFIG_KEY, 'not-valid-json{{{');
    expect(loadConfigSync()).toBeNull();
  });

  it('returns null when value is empty string', () => {
    localStorage.setItem(CONFIG_KEY, '');
    expect(loadConfigSync()).toBeNull();
  });

  it('preserves optional customHeaders field', () => {
    const cfg: LLMConfig = { ...MOCK_OPENAI_CONFIG, customHeaders: 'X-Foo: bar\nX-Baz: qux' };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    expect(loadConfigSync()?.customHeaders).toBe('X-Foo: bar\nX-Baz: qux');
  });
});

// ─── loadConfig() ─────────────────────────────────────────────────────────────

describe('loadConfig()', () => {
  describe('Scenario A: API returns 200 with new format', () => {
    it('returns LLM config from { llm, imageGen } format and syncs to localStorage', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_OPENAI_CONFIG,
            imageGen: { provider: 'openai', apiKey: 'k', baseUrl: 'u', model: 'm' },
          }),
      } as unknown as Response);

      const result = await loadConfig();

      expect(result).toEqual(MOCK_OPENAI_CONFIG);
      expect(localStorage.getItem(CONFIG_KEY)).toBe(JSON.stringify(MOCK_OPENAI_CONFIG));
    });
  });

  describe('Scenario A2: API returns 200 with legacy flat format', () => {
    it('returns config from legacy flat LLMConfig format', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_OPENAI_CONFIG),
      } as unknown as Response);

      const result = await loadConfig();

      expect(result).toEqual(MOCK_OPENAI_CONFIG);
      expect(localStorage.getItem(CONFIG_KEY)).toBe(JSON.stringify(MOCK_OPENAI_CONFIG));
    });
  });

  describe('Scenario B: API returns 404 (no file)', () => {
    it('falls back to localStorage when API returns 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 } as Response);
      localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_OPENAI_CONFIG));

      expect(await loadConfig()).toEqual(MOCK_OPENAI_CONFIG);
    });

    it('returns null when API returns 404 and localStorage is empty', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 } as Response);

      expect(await loadConfig()).toBeNull();
    });
  });

  describe('Scenario C: fetch throws (network error / production)', () => {
    it('falls back to localStorage on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
      localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_ANTHROPIC_CONFIG));

      expect(await loadConfig()).toEqual(MOCK_ANTHROPIC_CONFIG);
    });

    it('returns null when fetch throws and localStorage is empty', async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('fetch is not defined'));

      expect(await loadConfig()).toBeNull();
    });

    it('resolves null when both API and localStorage fail (does not throw)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
      localStorage.setItem(CONFIG_KEY, 'corrupted-json');

      await expect(loadConfig()).resolves.toBeNull();
    });
  });
});

// ─── saveConfig() ─────────────────────────────────────────────────────────────

describe('saveConfig()', () => {
  it('always writes to localStorage even if fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('API unavailable'));

    await saveConfig(MOCK_OPENAI_CONFIG);

    expect(localStorage.getItem(CONFIG_KEY)).toBe(JSON.stringify(MOCK_OPENAI_CONFIG));
  });

  it('POSTs new { llm } format to /api/llm-config', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    expect(mockFetch).toHaveBeenCalledWith('/api/llm-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: MOCK_OPENAI_CONFIG }),
    });
  });

  it('includes imageGen when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ llm: MOCK_ANTHROPIC_CONFIG }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    const igConfig = { provider: 'openai' as const, apiKey: 'k', baseUrl: 'u', model: 'm' };
    await saveConfig(MOCK_OPENAI_CONFIG, igConfig);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.llm).toEqual(MOCK_OPENAI_CONFIG);
    expect(body.imageGen).toEqual(igConfig);
  });

  it('preserves kira config when saving LLM settings', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            kira: { workRootDirectory: 'F:/workspace/agent-root' },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.llm).toEqual(MOCK_OPENAI_CONFIG);
    expect(body.kira).toEqual({ workRootDirectory: 'F:/workspace/agent-root' });
  });

  it('preserves dialogLlm config when saving the main LLM settings', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            dialogLlm: {
              model: 'openai/gpt-5-mini',
              baseUrl: 'https://openrouter.ai/api/v1',
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.llm).toEqual(MOCK_OPENAI_CONFIG);
    expect(body.dialogLlm).toEqual({
      model: 'openai/gpt-5-mini',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
  });

  it('preserves Tavily config when saving the main LLM settings', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            tavily: {
              apiKey: 'tvly-existing',
              baseUrl: 'https://api.tavily.com/search',
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.llm).toEqual(MOCK_OPENAI_CONFIG);
    expect(body.tavily).toEqual({
      apiKey: 'tvly-existing',
      baseUrl: 'https://api.tavily.com/search',
    });
  });

  it('saves Tavily config and syncs localStorage when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ llm: MOCK_ANTHROPIC_CONFIG }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(
      MOCK_OPENAI_CONFIG,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        apiKey: '  tvly-new  ',
        baseUrl: 'https://api.tavily.com',
      },
    );

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.tavily).toEqual({
      apiKey: 'tvly-new',
      baseUrl: 'https://api.tavily.com/search',
    });
    expect(JSON.parse(localStorage.getItem(TAVILY_CONFIG_KEY) || '{}')).toEqual(body.tavily);
  });

  it('clears Tavily config when explicitly disabled', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            tavily: {
              apiKey: 'tvly-existing',
              baseUrl: 'https://api.tavily.com/search',
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;
    localStorage.setItem(
      TAVILY_CONFIG_KEY,
      JSON.stringify({ apiKey: 'tvly-existing', baseUrl: 'https://api.tavily.com/search' }),
    );

    await saveConfig(
      MOCK_OPENAI_CONFIG,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
    );

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.tavily).toBeUndefined();
    expect(localStorage.getItem(TAVILY_CONFIG_KEY)).toBeNull();
  });

  it('includes userProfile when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ llm: MOCK_ANTHROPIC_CONFIG }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG, undefined, undefined, undefined, {
      displayName: 'Minji',
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.userProfile).toEqual({ displayName: 'Minji' });
  });

  it('preserves userProfile when saving the main LLM settings', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            userProfile: {
              displayName: 'Minji',
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.userProfile).toEqual({ displayName: 'Minji' });
  });

  it('can explicitly clear dialogLlm config', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            dialogLlm: {
              model: 'openai/gpt-5-mini',
              baseUrl: 'https://openrouter.ai/api/v1',
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG, undefined, null);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.dialogLlm).toBeUndefined();
  });

  it('can explicitly clear userProfile config', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            userProfile: {
              displayName: 'Minji',
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG, undefined, undefined, undefined, null);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.userProfile).toBeUndefined();
  });

  it('includes conversationPreferences when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ llm: MOCK_ANTHROPIC_CONFIG }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG, undefined, undefined, undefined, undefined, {
      responseLanguageMode: 'english',
      ttsEnabled: true,
      ttsPreloadCommonPhrases: false,
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.conversationPreferences).toEqual({
      responseLanguageMode: 'english',
      ttsEnabled: true,
      ttsPreloadCommonPhrases: false,
    });
  });

  it('preserves conversationPreferences when saving the main LLM settings', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            conversationPreferences: {
              responseLanguageMode: 'english',
              ttsEnabled: true,
              ttsPreloadCommonPhrases: false,
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.conversationPreferences).toEqual({
      responseLanguageMode: 'english',
      ttsEnabled: true,
      ttsPreloadCommonPhrases: false,
    });
  });

  it('can explicitly clear conversationPreferences config', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            conversationPreferences: {
              responseLanguageMode: 'english',
              ttsEnabled: true,
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG, undefined, undefined, undefined, undefined, null);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.conversationPreferences).toBeUndefined();
  });

  it('preserves kira worker and reviewer model settings when saving LLM settings', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            kira: {
              workRootDirectory: 'F:/workspace/agent-root',
              projectDefaults: {
                autoCommit: true,
              },
              workerLlm: {
                model: 'openai/gpt-5.4',
              },
              workers: [
                {
                  provider: 'codex-cli',
                  model: 'gpt-5.3-codex',
                },
              ],
              reviewerLlm: {
                provider: 'anthropic',
                model: 'claude-sonnet-4.6',
              },
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.llm).toEqual(MOCK_OPENAI_CONFIG);
    expect(body.kira).toEqual({
      workRootDirectory: 'F:/workspace/agent-root',
      projectDefaults: {
        autoCommit: true,
      },
      workerLlm: {
        model: 'openai/gpt-5.4',
      },
      workers: [
        {
          provider: 'codex-cli',
          model: 'gpt-5.3-codex',
        },
      ],
      reviewerLlm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4.6',
      },
    });
  });

  it('saves updated kira worker and reviewer settings when provided', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            llm: MOCK_ANTHROPIC_CONFIG,
            kira: {
              workers: [{ provider: 'openrouter', model: 'old-model' }],
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    globalThis.fetch = mockFetch;

    await saveConfig(MOCK_OPENAI_CONFIG, undefined, undefined, undefined, undefined, undefined, {
      workRootDirectory: 'F:/workspace/agent-root',
      workers: [
        { provider: 'codex-cli', model: 'gpt-5.3-codex' },
        {
          provider: 'opencode-go',
          apiKey: 'oc-test',
          baseUrl: 'https://opencode.ai/zen/go',
          model: 'opencode-go/kimi-k2.5',
        },
      ],
      reviewerLlm: {
        provider: 'opencode',
        apiKey: 'oc-review',
        baseUrl: 'https://opencode.ai/zen',
        model: 'opencode/claude-sonnet-4-6',
      },
      projectDefaults: { autoCommit: false },
    });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.kira).toEqual({
      workRootDirectory: 'F:/workspace/agent-root',
      workers: [
        { provider: 'codex-cli', model: 'gpt-5.3-codex' },
        {
          provider: 'opencode-go',
          apiKey: 'oc-test',
          baseUrl: 'https://opencode.ai/zen/go',
          model: 'opencode-go/kimi-k2.5',
        },
      ],
      reviewerLlm: {
        provider: 'opencode',
        apiKey: 'oc-review',
        baseUrl: 'https://opencode.ai/zen',
        model: 'opencode/claude-sonnet-4-6',
      },
      projectDefaults: { autoCommit: false },
    });
  });

  it('does not throw when POST request fails silently', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('API unavailable'));

    await expect(saveConfig(MOCK_OPENAI_CONFIG)).resolves.toBeUndefined();
  });

  it('overwrites previous config — latest value wins', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    await saveConfig(MOCK_OPENAI_CONFIG);
    await saveConfig(MOCK_ANTHROPIC_CONFIG);

    const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null');
    expect(stored?.provider).toBe('anthropic');
  });

  it('writes localStorage before awaiting fetch', async () => {
    let localStorageWrittenBeforeFetch = false;
    const originalSetItem = localStorage.setItem.bind(localStorage);

    globalThis.fetch = vi.fn().mockImplementationOnce(() => {
      // By the time fetch is called, localStorage should already be written
      localStorageWrittenBeforeFetch = localStorage.getItem(CONFIG_KEY) !== null;
      return Promise.resolve({ ok: true } as Response);
    });

    vi.spyOn(localStorage, 'setItem').mockImplementation(originalSetItem);

    await saveConfig(MOCK_OPENAI_CONFIG);

    expect(localStorageWrittenBeforeFetch).toBe(true);
  });
});

// ─── chat() — routing & response parsing ──────────────────────────────────────

describe('chat()', () => {
  it('rejects image attachments before calling providers that do not support vision input', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(
      chat(
        [
          {
            role: 'user',
            content: 'Analyze this image.',
            attachments: [MOCK_IMAGE_ATTACHMENT],
          },
        ],
        [],
        {
          provider: 'codex-cli',
          apiKey: '',
          baseUrl: '',
          model: 'gpt-5.3-codex',
        },
      ),
    ).rejects.toThrow('Image input is not supported');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported image attachment MIME types before provider calls', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(
      chat(
        [
          {
            role: 'user',
            content: 'Analyze this image.',
            attachments: [
              {
                ...MOCK_IMAGE_ATTACHMENT,
                name: 'vector.svg',
                mimeType: 'image/svg+xml',
                dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
              },
            ],
          },
        ],
        [],
        { ...MOCK_OPENAI_CONFIG, model: 'gpt-4o' },
      ),
    ).rejects.toThrow('Invalid image attachment');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('OpenAI provider', () => {
    it('calls /api/llm-proxy and returns content', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('Hello!'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], MOCK_OPENAI_CONFIG);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/llm-proxy',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result.content).toBe('Hello!');
      expect(result.toolCalls).toEqual([]);
    });

    it('sets Authorization Bearer token header', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], MOCK_OPENAI_CONFIG);

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-test-key');
    });

    it('uses v1/chat/completions when baseUrl has no version suffix', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], MOCK_OPENAI_CONFIG);

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['X-LLM-Target-URL']).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('includes tools in body when tools array is non-empty', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, MOCK_TOOLS, MOCK_OPENAI_CONFIG);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.tools).toHaveLength(1);
    });

    it('omits tools from body when tools array is empty', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], MOCK_OPENAI_CONFIG);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.tools).toBeUndefined();
    });

    it('sets the per-response token cap to 8192', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], MOCK_OPENAI_CONFIG);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.max_tokens).toBe(8192);
    });

    it('sends image attachments as OpenAI-compatible image_url content blocks', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(
        [
          {
            role: 'user',
            content: 'Describe this screenshot.',
            attachments: [MOCK_IMAGE_ATTACHMENT],
          },
        ],
        [],
        { ...MOCK_OPENAI_CONFIG, model: 'gpt-4o' },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: 'Describe this screenshot.' },
        {
          type: 'image_url',
          image_url: {
            url: MOCK_IMAGE_ATTACHMENT.dataUrl,
            detail: 'auto',
          },
        },
      ]);
      expect(body.messages[0].attachments).toBeUndefined();
    });

    it('sends image attachments as Responses API input_image blocks', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeResponsesApiResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(
        [
          {
            role: 'user',
            content: 'Read the text in this image.',
            attachments: [MOCK_IMAGE_ATTACHMENT],
          },
        ],
        [],
        { ...MOCK_OPENAI_CONFIG, model: 'gpt-5-mini' },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.input[0]).toEqual({
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read the text in this image.' },
          {
            type: 'input_image',
            image_url: MOCK_IMAGE_ATTACHMENT.dataUrl,
            detail: 'auto',
          },
        ],
      });
    });

    it('throws with status code when API returns error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(makeErrorResponse(429, 'Rate limit exceeded'));

      await expect(chat(MOCK_MESSAGES, [], MOCK_OPENAI_CONFIG)).rejects.toThrow(
        'LLM API error 429',
      );
    });

    it('returns toolCalls when response includes tool_calls', async () => {
      const mockToolCall = {
        id: 'call_123',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      };
      globalThis.fetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('', [mockToolCall]));

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, MOCK_OPENAI_CONFIG);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('get_weather');
    });

    it('preserves reasoning_content for Kimi-style multi-step tool calls', async () => {
      const mockToolCall = {
        id: 'call_123',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          makeOpenAIResponse('', [mockToolCall], { reasoning_content: 'Plan the tool call.' }),
        );
      globalThis.fetch = mockFetch;

      const result = await chat(
        [
          ...MOCK_MESSAGES,
          {
            role: 'assistant',
            content: '',
            reasoning_content: 'Earlier tool reasoning.',
            tool_calls: [mockToolCall],
          },
          { role: 'tool', content: 'Sunny', tool_call_id: 'call_123' },
        ],
        MOCK_TOOLS,
        MOCK_OPENAI_CONFIG,
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.messages[1].reasoning_content).toBe('Earlier tool reasoning.');
      expect(result.reasoningContent).toBe('Plan the tool call.');
    });

    it('adds fallback reasoning_content for Kimi tool-call history when the provider omitted it', async () => {
      const mockToolCall = {
        id: 'call_123',
        type: 'function' as const,
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(
        [
          ...MOCK_MESSAGES,
          {
            role: 'assistant',
            content: '',
            tool_calls: [mockToolCall],
          },
          { role: 'tool', content: 'Sunny', tool_call_id: 'call_123' },
        ],
        MOCK_TOOLS,
        {
          provider: 'opencode-go',
          apiKey: 'oc-go-key',
          baseUrl: 'https://opencode.ai/zen/go',
          model: 'opencode-go/kimi-k2.6',
        },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.messages[1].reasoning_content).toContain('reasoning_content');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.reasoning).toEqual({ enabled: false });
    });
  });

  describe('DeepSeek provider (OpenAI-compatible)', () => {
    it('routes to OpenAI path with deepseek target URL', async () => {
      const deepseekConfig: LLMConfig = {
        ...MOCK_OPENAI_CONFIG,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('DeepSeek response'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], deepseekConfig);

      expect(result.content).toBe('DeepSeek response');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['X-LLM-Target-URL']).toBe('https://api.deepseek.com/chat/completions');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('deepseek-v4-pro');
    });

    it('maps DeepSeek reasoning effort and preserves tool-call reasoning_content', async () => {
      const deepseekConfig: LLMConfig = {
        ...MOCK_OPENAI_CONFIG,
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'xhigh',
      };
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Use a tool.' },
        {
          role: 'assistant',
          content: 'Calling tool',
          reasoning_content: 'tool reasoning must be sent back',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Seoul"}' },
            },
          ],
        },
        { role: 'tool', content: 'Sunny', tool_call_id: 'call_1' },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('DeepSeek response'));
      globalThis.fetch = mockFetch;

      await chat(messages, [], deepseekConfig);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('max');
      expect(body.messages[1].reasoning_content).toBe('tool reasoning must be sent back');
    });

    it('can disable DeepSeek thinking with reasoning effort none', () => {
      const body: Record<string, unknown> = {};

      applyDeepSeekChatRuntimeOptions(body, {
        provider: 'deepseek',
        reasoningEffort: 'none',
      });

      expect(body).toEqual({ thinking: { type: 'disabled' } });
    });
  });

  describe('llama.cpp provider (OpenAI-compatible)', () => {
    it('routes to OpenAI path without requiring an API key', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('Local response'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], MOCK_LLAMACPP_CONFIG);

      expect(result.content).toBe('Local response');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['X-LLM-Target-URL']).toBe('http://athena:8081/v1/chat/completions');
    });

    it('strips Qwen-style think tags from assistant content', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeOpenAIResponse('<think>hidden reasoning</think>Hello there'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], MOCK_LLAMACPP_CONFIG);

      expect(result.content).toBe('Hello there');
    });

    it('converts inline XML-style tool call content into structured tool calls', async () => {
      const inlineToolContent = `<tool_call>
respond_to_user
<arg_key>character_expression</arg_key>
<arg_value>{"content":"What? Did I catch you off guard?","emotion":"happy"}</arg_value>
<arg_key>user_interaction</arg_key>
<arg_value>{"suggested_replies":["Just hanging around","What reunion?","Tell me more"]}</arg_value>
</tool_call>`;
      globalThis.fetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse(inlineToolContent));

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, MOCK_LLAMACPP_CONFIG);

      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('respond_to_user');
      expect(result.toolCalls[0].function.arguments).toBe(
        '{"character_expression":{"content":"What? Did I catch you off guard?","emotion":"happy"},"user_interaction":{"suggested_replies":["Just hanging around","What reunion?","Tell me more"]}}',
      );
    });
  });

  describe('Anthropic provider', () => {
    it('uses x-api-key and anthropic-version headers', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeAnthropicResponse('Anthropic response'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], MOCK_ANTHROPIC_CONFIG);

      expect(result.content).toBe('Anthropic response');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['x-api-key']).toBe('ant-test-key');
    });

    it('uses /messages when baseUrl already includes /v1', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeAnthropicResponse('Anthropic response'));
      globalThis.fetch = mockFetch;

      const configWithVersion: LLMConfig = {
        ...MOCK_ANTHROPIC_CONFIG,
        baseUrl: 'https://api.anthropic.com/v1',
      };
      await chat(MOCK_MESSAGES, [], configWithVersion);

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['X-LLM-Target-URL']).toBe('https://api.anthropic.com/v1/messages');
    });

    it('extracts system message to top-level system field', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(makeAnthropicResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(messages, [], MOCK_ANTHROPIC_CONFIG);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.system).toBe('You are helpful.');
      expect(body.messages.some((m: { role: string }) => m.role === 'system')).toBe(false);
      expect(body.max_tokens).toBe(8192);
    });

    it('sends image attachments as Anthropic image source blocks', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeAnthropicResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(
        [
          {
            role: 'user',
            content: 'What is visible here?',
            attachments: [MOCK_IMAGE_ATTACHMENT],
          },
        ],
        [],
        MOCK_ANTHROPIC_CONFIG,
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.messages[0].content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aGVsbG8=',
          },
        },
        { type: 'text', text: 'What is visible here?' },
      ]);
    });

    it('converts tool_use blocks in response to toolCalls', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            content: [
              { type: 'text', text: 'Using tool' },
              { type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { city: 'SF' } },
            ],
          }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, MOCK_ANTHROPIC_CONFIG);

      expect(result.content).toBe('Using tool');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe('toolu_123');
      expect(result.toolCalls[0].function.name).toBe('get_weather');
      expect(result.toolCalls[0].function.arguments).toBe('{"city":"SF"}');
    });

    it('throws with status code when Anthropic API returns error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(makeErrorResponse(401, 'Unauthorized'));

      await expect(chat(MOCK_MESSAGES, [], MOCK_ANTHROPIC_CONFIG)).rejects.toThrow(
        'Anthropic API error 401',
      );
    });
  });

  describe('MiniMax provider (Anthropic-compatible)', () => {
    it('routes to Anthropic path', async () => {
      const minimaxConfig: LLMConfig = {
        provider: 'minimax',
        apiKey: 'minimax-key',
        baseUrl: 'https://api.minimax.io/anthropic',
        model: 'MiniMax-M2.5',
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(makeAnthropicResponse('MiniMax response'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], minimaxConfig);

      expect(result.content).toBe('MiniMax response');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });
  });

  describe('Codex CLI provider', () => {
    it('routes chat through the local codex cli endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: 'Codex answer' }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'codex-cli',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.3-codex',
      });

      expect(result.content).toBe('Codex answer');
      expect(result.toolCalls).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/codex-cli-chat',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('gpt-5.3-codex');
      expect(body.command).toBe('codex');
      expect(body.tools).toHaveLength(1);
    });

    it('converts inline tool call content from Codex CLI into structured tool calls', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: MOCK_INLINE_RESPOND_TOOL_CONTENT }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'codex-cli',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.3-codex',
      });

      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('respond_to_user');
      expect(result.toolCalls[0].function.arguments).toContain('"content":"Done."');
    });

    it('passes Codex runtime options to the local codex cli endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: 'Codex answer' }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], {
        provider: 'codex-cli',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        reasoningSummary: 'detailed',
        verbosity: 'high',
        serviceTier: 'fast',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.reasoningEffort).toBe('xhigh');
      expect(body.reasoningSummary).toBe('detailed');
      expect(body.verbosity).toBe('high');
      expect(body.serviceTier).toBe('priority');
    });

    it('does not freeze Codex CLI model defaults as config overrides', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: 'Codex answer' }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], {
        provider: 'codex-cli',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.5',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.reasoningEffort).toBeUndefined();
      expect(body.reasoningSummary).toBeUndefined();
      expect(body.verbosity).toBeUndefined();
      expect(body.serviceTier).toBeUndefined();
    });
  });

  describe('Codex Auth provider', () => {
    it('routes chat through the local Codex Auth endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: 'Codex Auth answer' }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'codex-auth',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.5',
      });

      expect(result.content).toBe('Codex Auth answer');
      expect(result.toolCalls).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/codex-auth-chat',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('gpt-5.5');
      expect(body.command).toBeUndefined();
      expect(body.tools).toHaveLength(1);
    });

    it('converts inline tool call content from Codex Auth into structured tool calls', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: MOCK_INLINE_RESPOND_TOOL_CONTENT }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'codex-auth',
        apiKey: '',
        baseUrl: '',
        model: 'gpt-5.5',
      });

      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('respond_to_user');
    });

    it('checks Codex account OAuth status through the local endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            provider: 'codex-auth',
            version: 'codex-cli 0.140.0',
            auth: { loggedIn: true, authMethod: 'ChatGPT', summary: 'Logged in using ChatGPT' },
          }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await checkCodexAuthStatus({
        provider: 'codex-auth',
      });

      expect(result.ok).toBe(true);
      expect(result.auth?.loggedIn).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/codex-auth-status',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({});
    });

    it('starts and polls Codex account OAuth browser device login sessions', async () => {
      const runningSession = {
        id: 'codex-login-test',
        provider: 'codex-auth',
        state: 'running',
        startedAt: 1,
        updatedAt: 2,
        output: 'Open the browser device URL.',
        authorizationUrl: 'https://auth.openai.com/device',
        userCode: 'ABCD-EFGH',
        browserOpened: true,
      };
      const completedSession = {
        ...runningSession,
        state: 'completed',
        updatedAt: 3,
        output: 'Logged in using ChatGPT',
        exitCode: 0,
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(runningSession),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(completedSession),
        } as unknown as Response);
      globalThis.fetch = mockFetch;

      const session = await startCodexAuthDeviceLogin({
        provider: 'codex-auth',
      });
      const status = await getCodexAuthDeviceLoginStatus(session.id);

      expect(session.state).toBe('running');
      expect(session.authorizationUrl).toBe('https://auth.openai.com/device');
      expect(status.state).toBe('completed');
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        '/api/codex-auth-login',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        '/api/codex-auth-login-status?id=codex-login-test',
      );
    });
  });

  describe('current model usage status', () => {
    it('checks weekly usage for the current model without sending secrets', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            provider: 'codex-auth',
            model: 'gpt-5.5',
            period: 'week',
            status: 'unavailable',
            source: 'codex-cli-login-status',
            refreshedAt: 1000,
            nextRefreshAt: 601000,
            account: { authMethod: 'ChatGPT', label: 'Logged in using ChatGPT' },
            message: 'Weekly account usage is not exposed by Codex CLI for this auth session.',
          }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const configWithSecrets: LLMConfig = {
        provider: 'codex-auth',
        apiKey: 'must-not-be-sent',
        baseUrl: '',
        model: 'gpt-5.5',
      };
      const result = await fetchCurrentModelUsage(configWithSecrets);

      expect(result.status).toBe('unavailable');
      expect(result.account?.authMethod).toBe('ChatGPT');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/llm-usage-status',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({
        provider: 'codex-auth',
        model: 'gpt-5.5',
      });
    });
  });

  describe('Claude CLI provider', () => {
    it('routes chat through the local claude cli endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: 'Claude answer' }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'claude-cli',
        apiKey: '',
        baseUrl: '',
        model: 'claude-sonnet-4-6',
      });

      expect(result.content).toBe('Claude answer');
      expect(result.toolCalls).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/claude-cli-chat',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.command).toBe('claude');
      expect(body.tools).toHaveLength(1);
    });

    it('converts inline tool call content from Claude CLI into structured tool calls', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: MOCK_INLINE_RESPOND_TOOL_CONTENT }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'claude-cli',
        apiKey: '',
        baseUrl: '',
        model: 'claude-sonnet-4-6',
      });

      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('respond_to_user');
    });

    it('passes Claude CLI reasoning effort when explicitly configured', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: 'Claude answer' }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], {
        provider: 'claude-cli',
        apiKey: '',
        baseUrl: '',
        model: 'claude-sonnet-4-6',
        reasoningEffort: 'xhigh',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.reasoningEffort).toBe('xhigh');
    });

    it('checks the local Claude CLI connection through the health endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: true,
            provider: 'claude-cli',
            version: '2.1.173 (Claude Code)',
            safeMode: true,
            smokeTest: 'OPENROOM_CLAUDE_OK',
          }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      const result = await checkClaudeCliConnection({
        provider: 'claude-cli',
        model: 'claude-sonnet-4-6',
        command: 'claude',
        reasoningEffort: 'high',
      });

      expect(result.ok).toBe(true);
      expect(result.safeMode).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/claude-cli-check',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.command).toBe('claude');
      expect(body.reasoningEffort).toBe('high');
    });

    it('surfaces Claude CLI connection check errors', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve({
            ok: false,
            provider: 'claude-cli',
            error: 'Claude CLI smoke test timed out.',
          }),
      } as unknown as Response);
      globalThis.fetch = mockFetch;

      await expect(
        checkClaudeCliConnection({
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
          command: 'claude',
        }),
      ).rejects.toThrow('Claude CLI smoke test timed out.');
    });
  });

  describe('OpenCode providers', () => {
    it('routes Claude models through the Anthropic-compatible path and strips provider prefix', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeAnthropicResponse('OpenCode Claude'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], {
        provider: 'opencode',
        apiKey: 'oc-key',
        baseUrl: 'https://opencode.ai/zen',
        model: 'opencode/claude-sonnet-4-6',
      });

      expect(result.content).toBe('OpenCode Claude');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(headers['X-LLM-Target-URL']).toBe('https://opencode.ai/zen/v1/messages');
      expect(headers['x-api-key']).toBe('oc-key');
      expect(body.model).toBe('claude-sonnet-4-6');
      expect(body.max_tokens).toBe(8192);
    });

    it('routes GPT models through the Responses API and strips provider prefix', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeResponsesApiResponse('OpenCode GPT'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'opencode',
        apiKey: 'oc-key',
        baseUrl: 'https://opencode.ai/zen',
        model: 'opencode/gpt-5.4',
      });

      expect(result.content).toBe('OpenCode GPT');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(headers['X-LLM-Target-URL']).toBe('https://opencode.ai/zen/v1/responses');
      expect(headers.Authorization).toBe('Bearer oc-key');
      expect(body.model).toBe('gpt-5.4');
      expect(body.max_output_tokens).toBe(8192);
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toBe('auto');
      expect(body.parallel_tool_calls).toBe(true);
      expect(body.reasoning).toEqual({ effort: 'medium' });
      expect(body.include).toEqual(['reasoning.encrypted_content']);
      expect(body.text).toEqual({ verbosity: 'low' });
    });

    it('sends Codex-style runtime options to Responses API model calls', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeResponsesApiResponse('OpenCode GPT'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'opencode',
        apiKey: 'oc-key',
        baseUrl: 'https://opencode.ai/zen',
        model: 'opencode/gpt-5.4',
        reasoningEffort: 'high',
        reasoningSummary: 'concise',
        verbosity: 'low',
        serviceTier: 'fast',
        parallelToolCalls: false,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.reasoning).toEqual({ effort: 'high', summary: 'concise' });
      expect(body.include).toEqual(['reasoning.encrypted_content']);
      expect(body.text).toEqual({ verbosity: 'low' });
      expect(body.service_tier).toBe('priority');
      expect(body.parallel_tool_calls).toBe(false);
    });

    it('merges Responses JSON schema output format with existing text controls', () => {
      const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      };
      const body: Record<string, unknown> = {
        text: { verbosity: 'low' },
      };

      applyOpenAiResponsesOutputSchema(body, schema, true, 'kira_worker_summary');

      expect(body.text).toEqual({
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'kira_worker_summary',
          strict: true,
          schema,
        },
      });
    });

    it('sends a stable Responses prompt cache key when configured', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeResponsesApiResponse('OpenCode GPT'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, MOCK_TOOLS, {
        provider: 'opencode',
        apiKey: 'oc-key',
        baseUrl: 'https://opencode.ai/zen',
        model: 'opencode/gpt-5.4',
        promptCacheKey: '  kira:abc123  ',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.prompt_cache_key).toBe('kira:abc123');
    });

    it('routes OpenCode Go Kimi models through the OpenAI-compatible path', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('OpenCode Go'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], {
        provider: 'opencode-go',
        apiKey: 'oc-go-key',
        baseUrl: 'https://opencode.ai/zen/go',
        model: 'opencode-go/kimi-k2.5',
      });

      expect(result.content).toBe('OpenCode Go');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(headers['X-LLM-Target-URL']).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      expect(headers.Authorization).toBe('Bearer oc-go-key');
      expect(body.model).toBe('kimi-k2.5');
      expect(body.max_tokens).toBe(8192);
      expect(body.thinking).toEqual({ type: 'disabled' });
    });
  });

  describe('parseCustomHeaders (tested indirectly via chat())', () => {
    it('parses valid headers and adds x-custom- prefix', async () => {
      const cfg: LLMConfig = {
        ...MOCK_OPENAI_CONFIG,
        customHeaders: 'X-Org-Id: org-123\nX-Trace: abc',
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      await chat(MOCK_MESSAGES, [], cfg);

      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['x-custom-x-org-id']).toBe('org-123');
      expect(headers['x-custom-x-trace']).toBe('abc');
    });

    it('handles empty customHeaders without throwing', async () => {
      const cfg: LLMConfig = { ...MOCK_OPENAI_CONFIG, customHeaders: '' };
      globalThis.fetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));

      await expect(chat(MOCK_MESSAGES, [], cfg)).resolves.toBeDefined();
    });

    it('skips blank lines and entries without colon', async () => {
      const cfg: LLMConfig = {
        ...MOCK_OPENAI_CONFIG,
        customHeaders: '\n  \nValid: value\nnocolon\n',
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(makeOpenAIResponse('ok'));
      globalThis.fetch = mockFetch;

      const result = await chat(MOCK_MESSAGES, [], cfg);

      expect(result.content).toBe('ok');
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['x-custom-valid']).toBe('value');
      expect(headers['x-custom-nocolon']).toBeUndefined();
    });
  });
});
