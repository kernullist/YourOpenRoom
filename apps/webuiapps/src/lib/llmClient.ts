/**
 * Minimal LLM API Client
 * Supports OpenAI-compatible / Anthropic-compatible formats
 */

import type { LLMConfig } from './llmModels';

import { logger } from './logger';
import { loadPersistedConfig, savePersistedConfig } from './configPersistence';

const CONFIG_KEY = 'webuiapps-llm-config';

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
): Promise<void> {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));

  const existing = await loadPersistedConfig();
  const persisted: import('./configPersistence').PersistedConfig = {
    llm: config,
    ...(existing?.album ? { album: existing.album } : {}),
    ...(existing?.kira ? { kira: existing.kira } : {}),
    ...(existing?.app ? { app: existing.app } : {}),
    ...(existing?.tavily ? { tavily: existing.tavily } : {}),
  };
  if (imageGenConfig) {
    persisted.imageGen = imageGenConfig;
  } else if (existing?.imageGen) {
    persisted.imageGen = existing.imageGen;
  }

  await savePersistedConfig(persisted);
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
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

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

function hasVersionSuffix(url: string): boolean {
  return /\/v\d+\/?$/.test(url);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function getOpenAICompletionsPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'chat/completions' : 'v1/chat/completions';
}

function getAnthropicMessagesPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'messages' : 'v1/messages';
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
): Promise<LLMResponse> {
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
  if (config.provider === 'anthropic' || config.provider === 'minimax') {
    return chatAnthropic(messages, tools, config);
  }
  return chatOpenAI(messages, tools, config);
}

async function chatOpenAI(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };
  if (tools.length > 0) {
    body.tools = tools;
  }

  const targetUrl = joinUrl(config.baseUrl, getOpenAICompletionsPath(config.baseUrl));
  const toolNames = Array.isArray(tools) ? tools.map((t) => t.function?.name).filter(Boolean) : [];
  console.info('[LLM] OpenAI-compatible request', {
    targetUrl,
    model: config.model,
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
    contentPreview: (
      choice?.tool_calls?.length ? stripThinkTags(choice?.content || '') : parsedInline.content
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
  return {
    content: choice?.tool_calls?.length
      ? stripThinkTags(choice?.content || '')
      : parsedInline.content,
    toolCalls,
  };
}

async function chatAnthropic(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
): Promise<LLMResponse> {
  const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const anthropicMessages = nonSystemMessages.map((m) => {
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
    return { role: m.role as 'user' | 'assistant', content: m.content };
  });

  const anthropicTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096,
    messages: anthropicMessages,
  };
  if (systemMsg) body.system = systemMsg;
  if (anthropicTools.length > 0) body.tools = anthropicTools;

  const anthropicToolNames = anthropicTools.map((t) => t.name).filter(Boolean);
  console.info('[LLM] Anthropic-compatible request', {
    targetUrl: joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl)),
    model: config.model,
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
  let res: Response;
  try {
    res = await fetch('/api/llm-proxy', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
    console.error('[LLM] Anthropic-compatible response error', {
      status: res.status,
      bodyPreview: text.slice(0, 500),
    });
    logger.error('LLM', 'Anthropic Error body:', text.slice(0, 500));
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.info(
    '[LLM] Anthropic-compatible response body preview',
    JSON.stringify(data).slice(0, 500),
  );
  logger.info('LLM', 'Anthropic Response data:', JSON.stringify(data).slice(0, 500));
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
  return { content: stripThinkTags(content), toolCalls };
}
