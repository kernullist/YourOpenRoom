import type { IncomingMessage, ServerResponse } from 'http';
import type { LLMApiStyle, LLMConfig, LLMProvider } from './llmModels';
import type { Plugin } from 'vite';
import * as fs from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import {
  applyDeepSeekChatRuntimeOptions,
  applyOpenAiResponsesRuntimeOptions,
  normalizeProviderModelId,
} from './llmModels';

const STATIC_PREFIX = '/dewdrop-canvas';
const API_PREFIX = '/api/dewdrop-canvas';
const DEFAULT_SOURCE_ROOT = 'F:/kernullist/dewdrop-canvas';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LLM_REQUEST_TIMEOUT_MS = 90 * 1000;

type NextFunction = () => void;
type MiddlewareStack = {
  use: (
    middleware: (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void,
  ) => void;
};

interface DewdropProject {
  id: string;
  title: string;
  date?: string;
  updatedAt?: string;
  memos?: unknown[];
  history?: unknown[];
  [key: string]: unknown;
}

interface DewdropMemo {
  id: string;
  text: string;
}

interface PluginOptions {
  sourceRoot?: string;
  configFile?: string;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(JSON.stringify(payload));
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  payload: string | Buffer,
): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.gif':
      return 'image/gif';
    case '.mp4':
      return 'video/mp4';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function isPathInsideRoot(root: string, target: string): boolean {
  const rootPath = resolve(root).toLowerCase();
  const targetPath = resolve(target).toLowerCase();
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`);
}

function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function getProjectPath(projectsDir: string, id: unknown): string | null {
  const projectId = normalizeProjectId(id);
  return projectId ? join(projectsDir, `${projectId}.json`) : null;
}

function formatDate(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectBody(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', rejectBody);
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody({});
        return;
      }

      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        resolveBody(typeof parsed === 'object' && parsed !== null ? parsed : {});
      } catch {
        rejectBody(new Error('Invalid JSON body.'));
      }
    });
  });
}

function ensureDewdropDataDirs(sourceRoot: string): {
  dataDir: string;
  projectsDir: string;
} {
  const dataDir = join(sourceRoot, 'data');
  const projectsDir = join(dataDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const legacyDir = join(dataDir, 'canvases');
  if (fs.existsSync(legacyDir)) {
    for (const fileName of fs.readdirSync(legacyDir)) {
      if (fileName === '_active.json' || !fileName.endsWith('.json')) continue;
      const src = join(legacyDir, fileName);
      const dest = join(projectsDir, fileName);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    }
  }

  return { dataDir, projectsDir };
}

function getActiveMetaPath(dataDir: string): string {
  return join(dataDir, 'last_active.json');
}

function getLastActiveId(dataDir: string): string | null {
  const meta = readJsonFile<{ lastActiveId?: unknown }>(getActiveMetaPath(dataDir));
  return normalizeProjectId(meta?.lastActiveId) ?? null;
}

function saveLastActiveId(dataDir: string, id: string): void {
  writeJsonFile(getActiveMetaPath(dataDir), { lastActiveId: id });
}

function createDefaultProject(dataDir: string, projectsDir: string, lang: string): DewdropProject {
  const now = new Date();
  const project: DewdropProject = {
    id: 'proj-default',
    title: lang === 'en' ? 'Default Mind Map' : '기본 생각 지도',
    date: formatDate(now),
    updatedAt: now.toISOString(),
    memos: [],
    history: [],
  };

  writeJsonFile(join(projectsDir, 'proj-default.json'), project);
  saveLastActiveId(dataDir, project.id);
  return project;
}

function loadActiveProject(dataDir: string, projectsDir: string, lang: string): DewdropProject {
  const lastActiveId = getLastActiveId(dataDir);
  if (lastActiveId) {
    const activePath = getProjectPath(projectsDir, lastActiveId);
    if (activePath && fs.existsSync(activePath)) {
      const active = readJsonFile<DewdropProject>(activePath);
      if (active) return active;
    }
  }

  const existing = fs
    .readdirSync(projectsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();
  if (existing.length > 0) {
    const firstId = basename(existing[0], '.json');
    const firstProject = readJsonFile<DewdropProject>(join(projectsDir, existing[0]));
    if (firstProject) {
      saveLastActiveId(dataDir, firstId);
      return firstProject;
    }
  }

  return createDefaultProject(dataDir, projectsDir, lang);
}

function listProjects(projectsDir: string): Array<Record<string, unknown>> {
  return fs
    .readdirSync(projectsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => {
      const parsed = readJsonFile<DewdropProject>(join(projectsDir, fileName));
      if (!parsed) return null;
      return {
        id: parsed.id || basename(fileName, '.json'),
        title: parsed.title || '이름 없는 프로젝트',
        date: parsed.date || '날짜 없음',
        memoCount: Array.isArray(parsed.memos) ? parsed.memos.length : 0,
        updatedAt: parsed.updatedAt || parsed.date || '',
      };
    })
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .sort((a, b) => {
      const left = new Date(String(a.updatedAt || a.date || '')).getTime() || 0;
      const right = new Date(String(b.updatedAt || b.date || '')).getTime() || 0;
      return right - left;
    });
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getHeaderString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function normalizeProvider(value: unknown): 'gemini' | 'deepseek' | 'openrouter' | 'simulator' {
  if (value === 'deepseek' || value === 'openrouter' || value === 'simulator') {
    return value;
  }
  return 'gemini';
}

function normalizeAoiProvider(value: unknown): LLMProvider | null {
  if (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'deepseek' ||
    value === 'llama.cpp' ||
    value === 'minimax' ||
    value === 'z.ai' ||
    value === 'kimi' ||
    value === 'openrouter' ||
    value === 'opencode' ||
    value === 'opencode-go' ||
    value === 'claude-cli' ||
    value === 'codex-cli'
  ) {
    return value;
  }
  return null;
}

function isAoiCliProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'codex-cli' || provider === 'claude-cli';
}

function isAoiOpenCodeProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'opencode' || provider === 'opencode-go';
}

function isAoiAnthropicProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'anthropic' || provider === 'minimax';
}

function normalizeAoiModel(config: Pick<LLMConfig, 'provider' | 'model'>): string {
  return normalizeProviderModelId(config.provider, config.model);
}

function hasVersionSuffix(url: string): boolean {
  return /\/v\d+\/?$/.test(url);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function getOpenAiCompletionsPath(baseUrl: string, provider?: LLMProvider): string {
  if (provider === 'deepseek') {
    return 'chat/completions';
  }
  return hasVersionSuffix(baseUrl) ? 'chat/completions' : 'v1/chat/completions';
}

function getOpenAiResponsesPath(baseUrl: string): string {
  return hasVersionSuffix(baseUrl) ? 'responses' : 'v1/responses';
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
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

function resolveOpenCodeApiStyle(config: LLMConfig): LLMApiStyle {
  if (config.apiStyle) return config.apiStyle;
  const model = normalizeAoiModel(config).toLowerCase();
  if (model.startsWith('gpt-')) return 'openai-responses';
  if (model.startsWith('claude-')) return 'anthropic-messages';
  if (config.provider === 'opencode-go' && /^minimax-m2\./.test(model)) {
    return 'anthropic-messages';
  }
  return 'openai-chat';
}

function shouldUseOpenAiResponses(config: LLMConfig): boolean {
  if (config.apiStyle === 'openai-responses') return true;
  return config.provider === 'openai' && normalizeAoiModel(config).toLowerCase().startsWith('gpt-5');
}

function shouldDisableOpenAiThinking(config: LLMConfig): boolean {
  if (!isAoiOpenCodeProvider(config.provider) && config.provider !== 'kimi') return false;
  return normalizeAoiModel(config).toLowerCase().includes('kimi-k2');
}

function normalizeApiStyle(value: unknown): LLMApiStyle | undefined {
  if (value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages') {
    return value;
  }
  return undefined;
}

function loadAoiMainLlmConfig(configFile: string): LLMConfig | null {
  try {
    if (!fs.existsSync(configFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    const raw =
      typeof parsed.llm === 'object' && parsed.llm !== null
        ? (parsed.llm as Record<string, unknown>)
        : parsed;
    const provider = normalizeAoiProvider(raw.provider);
    const model = getString(raw.model).trim();
    const baseUrl = getString(raw.baseUrl).trim();
    if (!provider || !model) return null;
    if (!isAoiCliProvider(provider) && !baseUrl) return null;

    const apiStyle = normalizeApiStyle(raw.apiStyle);
    const customHeaders = getString(raw.customHeaders).trim();
    const command = getString(raw.command).trim();
    const reasoningEffort = getString(raw.reasoningEffort).trim();
    const reasoningSummary = getString(raw.reasoningSummary).trim();
    const verbosity = getString(raw.verbosity).trim();
    const serviceTier = getString(raw.serviceTier).trim();
    const promptCacheKey = getString(raw.promptCacheKey).trim();
    return {
      provider,
      model,
      baseUrl,
      apiKey: getString(raw.apiKey),
      ...(customHeaders ? { customHeaders } : {}),
      ...(command ? { command } : {}),
      ...(apiStyle ? { apiStyle } : {}),
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as LLMConfig['reasoningEffort'] } : {}),
      ...(reasoningSummary
        ? { reasoningSummary: reasoningSummary as LLMConfig['reasoningSummary'] }
        : {}),
      ...(verbosity ? { verbosity: verbosity as LLMConfig['verbosity'] } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(typeof raw.parallelToolCalls === 'boolean'
        ? { parallelToolCalls: raw.parallelToolCalls }
        : {}),
      ...(promptCacheKey ? { promptCacheKey } : {}),
    };
  } catch {
    return null;
  }
}

function resolveAoiProviderApiKey(config: LLMConfig): string {
  if (config.apiKey.trim()) return config.apiKey;
  if (isAoiOpenCodeProvider(config.provider)) {
    return (
      process.env.OPENCODE_API_KEY ||
      process.env.OPENCODE_ZEN_API_KEY ||
      process.env.OPENCODE_GO_API_KEY ||
      ''
    );
  }
  if (config.provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (config.provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  if (config.provider === 'deepseek') return process.env.DEEPSEEK_API_KEY || '';
  if (config.provider === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
  if (config.provider === 'minimax') return process.env.MINIMAX_API_KEY || '';
  if (config.provider === 'z.ai') return process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY || '';
  if (config.provider === 'kimi') return process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '';
  return '';
}

function getAoiLlmStatus(configFile: string): Record<string, unknown> {
  const config = loadAoiMainLlmConfig(configFile);
  if (!config) {
    return { configured: false };
  }
  return {
    configured: true,
    provider: config.provider,
    model: config.model,
    apiStyle: config.apiStyle || null,
    cli: isAoiCliProvider(config.provider),
    baseUrlConfigured: Boolean(config.baseUrl.trim()),
    apiKeyConfigured: isAoiCliProvider(config.provider) || Boolean(resolveAoiProviderApiKey(config)),
  };
}

function formatFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 500);
}

function getRequestOrigin(req: IncomingMessage): string {
  const forwardedProto = getHeaderString(req.headers['x-forwarded-proto']).trim();
  const host = getHeaderString(req.headers.host).trim() || '127.0.0.1:3000';
  return `${forwardedProto || 'http'}://${host}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LLM_REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`AOI main LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callAoiCliTextModel(
  config: LLMConfig,
  serverOrigin: string,
  prompt: string,
): Promise<string> {
  const endpoint = config.provider === 'codex-cli' ? '/api/codex-cli-chat' : '/api/claude-cli-chat';
  const response = await fetchWithTimeout(joinUrl(serverOrigin, endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      model: config.model,
      command: config.command?.trim() || (config.provider === 'codex-cli' ? 'codex' : 'claude'),
      reasoningEffort: config.reasoningEffort,
      reasoningSummary: config.reasoningSummary,
      verbosity: config.verbosity,
      serviceTier: config.serviceTier,
    }),
  });
  const data = (await response.json()) as { content?: string; error?: string };
  if (!response.ok) {
    throw new Error(data.error || `${config.provider} status ${response.status}`);
  }
  return data.content?.trim() || '';
}

async function callAoiOpenAiChatModel(
  config: LLMConfig,
  prompt: string,
  maxTokens: number,
  responseJson = false,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: normalizeAoiModel(config),
    messages: [{ role: 'user', content: prompt }],
    temperature: responseJson ? 0.2 : 0.7,
    max_tokens: maxTokens,
    stream: false,
    ...(responseJson ? { response_format: { type: 'json_object' } } : {}),
  };
  if (shouldDisableOpenAiThinking(config)) {
    body.thinking = { type: 'disabled' };
    body.reasoning = { enabled: false };
  }
  applyDeepSeekChatRuntimeOptions(body, config);

  const apiKey = resolveAoiProviderApiKey(config);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;
  if (config.provider === 'openrouter') {
    headers['HTTP-Referer'] ||= 'http://localhost:3000';
    headers['X-Title'] ||= 'Dewdrop Canvas';
  }

  const response = await fetchWithTimeout(
    joinUrl(config.baseUrl, getOpenAiCompletionsPath(config.baseUrl, config.provider)),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) throw new Error(`${config.provider} status ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || '';
}

async function callAoiOpenAiResponsesModel(
  config: LLMConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: normalizeAoiModel(config),
    input: [{ role: 'user', content: prompt }],
    max_output_tokens: maxTokens,
    stream: false,
  };
  applyOpenAiResponsesRuntimeOptions(body, config, false);

  const apiKey = resolveAoiProviderApiKey(config);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetchWithTimeout(joinUrl(config.baseUrl, getOpenAiResponsesPath(config.baseUrl)), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${config.provider} responses status ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ text?: string; output_text?: string }>;
    }>;
  };
  const contentParts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        const text = part.text ?? part.output_text ?? '';
        if (text) contentParts.push(text);
      }
    }
  }
  return (data.output_text || contentParts.join('')).trim();
}

async function callAoiAnthropicModel(
  config: LLMConfig,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const apiKey = resolveAoiProviderApiKey(config);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers['x-api-key'] = apiKey;

  const response = await fetchWithTimeout(joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl)), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: normalizeAoiModel(config),
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`${config.provider} status ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
    .trim();
}

async function callAoiMainTextModel(
  config: LLMConfig,
  serverOrigin: string,
  prompt: string,
  maxTokens: number,
  responseJson = false,
): Promise<string> {
  if (isAoiCliProvider(config.provider)) {
    return callAoiCliTextModel(config, serverOrigin, prompt);
  }
  if (isAoiOpenCodeProvider(config.provider)) {
    const apiStyle = resolveOpenCodeApiStyle(config);
    if (apiStyle === 'openai-responses') {
      return callAoiOpenAiResponsesModel(config, prompt, maxTokens);
    }
    if (apiStyle === 'anthropic-messages') {
      return callAoiAnthropicModel(config, prompt, maxTokens);
    }
    return callAoiOpenAiChatModel(config, prompt, maxTokens, responseJson);
  }
  if (isAoiAnthropicProvider(config.provider)) {
    return callAoiAnthropicModel(config, prompt, maxTokens);
  }
  if (shouldUseOpenAiResponses(config)) {
    return callAoiOpenAiResponsesModel(config, prompt, maxTokens);
  }
  return callAoiOpenAiChatModel(config, prompt, maxTokens, responseJson);
}

function buildRecommendPrompt(memos: DewdropMemo[], lang: string): string {
  const memoLines = memos.map((memo, index) => `[ID: ${memo.id}] (${index + 1}): ${memo.text}`).join('\n');
  if (lang === 'en') {
    return `You are a thought synergy analyzer.
Analyze these thought dewdrops:
${memoLines}

Choose the two dewdrops that would create the most useful or creative synergy if merged.
Return only raw JSON:
{"idA":"first id","idB":"second id","reason":"one short English sentence"}`;
  }

  return `당신은 생각의 연관성과 시너지를 분석하는 생각 지능 분석가입니다.
현재 캔버스 보드의 생각 물방울 목록은 다음과 같습니다:
${memoLines}

함께 합쳤을 때 가장 창의적이고 유용한 시너지를 낼 수 있는 생각 물방울 2개를 선정하세요.
반드시 순수 JSON만 반환하세요:
{"idA":"첫 번째 ID","idB":"두 번째 ID","reason":"한글 한 문장 설명"}`;
}

function buildSynthesizePrompt(textA: string, textB: string, lang: string): string {
  if (lang === 'en') {
    return `Two thought dewdrops have fused.

[Memo A]: ${textA}
[Memo B]: ${textB}

Synthesize them into one natural, high-quality thought. Use a direct professional tone for technical topics and a warm prose tone for creative or wellness topics.

Return markdown exactly:
### Synthesized Thought
[synthesized thought]

### AI Creative Synergy
[1-2 sentence next step]`;
  }

  return `두 가지 서로 다른 생각 메모가 융합되었습니다.

[메모 A]: ${textA}
[메모 B]: ${textB}

두 생각의 주제와 톤앤매너를 파악해 하나의 자연스럽고 완성도 높은 생각으로 융합하세요. 기술/실무 주제는 명료한 엔지니어링 톤으로, 창작/웰니스 주제는 따뜻한 산문 톤으로 작성하세요.

다음 마크다운 형식을 지키세요:
### 융합된 생각
[융합된 생각]

### AI의 창의적 시너지
[1-2문장 발전 방향]`;
}

function buildEnhancePrompt(text: string, lang: string): string {
  if (lang === 'en') {
    return `Enhance this unfinished inspiration memo without changing its core topic:

[Original Memo]: ${text}

Use a direct professional tone for technical topics and a warm prose tone for creative or wellness topics.

Return markdown exactly:
### Enhanced Thought
[enhanced thought]

### AI Creative Synergy
[one specific next step]`;
  }

  return `입력된 미완성 영감 메모를 핵심 주제는 유지한 채 자연스럽게 보강하세요.

[원본 메모]: ${text}

기술/실무 주제는 명료한 엔지니어링 톤으로, 창작/웰니스 주제는 따뜻한 산문 톤으로 작성하세요.

다음 마크다운 형식을 지키세요:
### 보강된 생각
[보강된 생각]

### AI의 창의적 시너지
[구체적인 다음 단계 한 문장]`;
}

function extractNouns(text: string): string[] {
  const cleanText = text.toLowerCase();
  const keywords = [
    '장작',
    '비',
    '바람',
    '나뭇잎',
    '숲',
    '모닥불',
    '소리',
    '아이디어',
    '생각',
    '도구',
    '웰니스',
    '집중',
    '휴식',
    '음악',
    '메모',
    'rain',
    'fire',
    'wind',
    'forest',
    'wood',
    'sound',
    'idea',
    'wellness',
    'focus',
    'rest',
    'music',
    'memo',
  ];
  return keywords.filter((word) => cleanText.includes(word));
}

function runPoeticSingleEnhance(text: string, lang = 'ko'): string {
  if (lang === 'en') {
    const cleanText = text.toLowerCase();
    let topic = 'idea';
    if (cleanText.includes('rain') || cleanText.includes('water')) {
      topic = 'cozy soundscapes and wellness resonance';
    } else if (cleanText.includes('fire') || cleanText.includes('wood')) {
      topic = 'visual warmth and crackling fire textures';
    } else if (cleanText.includes('wind') || cleanText.includes('forest')) {
      topic = 'whispering leaves and high-frequency relaxation wind cues';
    }

    return `### Enhanced Thought
${text.trim()} And the subtle acoustic depth nurtured in this space does not merely stimulate hearing; it gently awakens senses dulled by daily routine, naturally weaving a bridge to organic inner restoration.

### AI Creative Synergy
I suggest immediate application of this ${topic} to a pomodoro focus timer or personal meditation layout to manifest it as a tactile tool.`;
  }

  const cleanText = text.toLowerCase();
  let topic = '아이디어';
  if (cleanText.includes('비') || cleanText.includes('빗소리')) {
    topic = '빗소리와 비 오는 날의 웰니스 감성';
  } else if (cleanText.includes('장작') || cleanText.includes('모닥불')) {
    topic = '모닥불과 타오르는 따스한 시각 질감';
  } else if (cleanText.includes('바람') || cleanText.includes('숲')) {
    topic = '나뭇잎 서걱이는 바람의 고주파 이완 효과';
  }

  return `### 보강된 생각
${text.trim()} 그리고 이 공간이 품고 있는 은밀한 청각적 깊이는, 단순히 귀로 듣는 자극을 넘어 바쁜 일상에서 무뎌진 마음의 감각을 깨우고 내면을 차분하게 정돈해 주는 오가닉 치유의 통로로 자연스럽게 스며듭니다.

### AI의 창의적 시너지
해당 ${topic}를 뽀모도로 작업 타이머 또는 1인 숲속 명상 앱 디자인에 바로 투영하여 감성적 실천 도구로 구체화해 보기를 제안합니다.`;
}

function runPoeticSimulator(textA: string, textB: string, lang = 'ko'): string {
  const cleanA = textA.toLowerCase();
  const cleanB = textB.toLowerCase();
  const isRain =
    cleanA.includes('rain') ||
    cleanB.includes('rain') ||
    cleanA.includes('water') ||
    cleanB.includes('water') ||
    cleanA.includes('비') ||
    cleanB.includes('비');
  const isFire =
    cleanA.includes('fire') ||
    cleanB.includes('fire') ||
    cleanA.includes('wood') ||
    cleanB.includes('wood') ||
    cleanA.includes('장작') ||
    cleanB.includes('장작') ||
    cleanA.includes('모닥불') ||
    cleanB.includes('모닥불');
  const isWind =
    cleanA.includes('wind') ||
    cleanB.includes('wind') ||
    cleanA.includes('forest') ||
    cleanB.includes('forest') ||
    cleanA.includes('바람') ||
    cleanB.includes('바람') ||
    cleanA.includes('숲') ||
    cleanB.includes('숲');

  if (lang === 'en') {
    let merged = '';
    let enhanced = '';
    if (isRain && isFire) {
      merged =
        'The absolute spatial coziness arising from the dry crackling sound of firewood inside a cabin fireplace balanced against cold raindrops tapping on the window glass.';
      enhanced =
        'The dry sound profile of fireplace embers and the wet liquid textures of rain create an acoustic symmetry. Blending this with a 2.5Hz non-linear candle flickering light can decrease stress.';
    } else if (isRain && isWind) {
      merged =
        'A dynamic synchronization between the steady rhythm of rain tapping the cabin roof and the distant whispering sway of wind through forest leaves.';
      enhanced =
        'Applying a real-time LFO signal to dynamically modulate rain density based on wind speed can maximize immersion.';
    } else if (isFire && isWind) {
      merged =
        'An organic harmony between forest trees creaking in the wind and the randomized flicker of hearth fire flames.';
      enhanced =
        'Adding a deep fireplace bass rumble and subtle cabin creaks can create a secure mental sanctuary.';
    } else {
      const combinedNouns = Array.from(new Set([...extractNouns(textA), ...extractNouns(textB)]))
        .slice(0, 4)
        .join(', ');
      merged = `A comprehensive thought structure mapping '${textA.substring(
        0,
        16,
      )}...' and '${textB.substring(0, 16)}...' under themes of ${
        combinedNouns || 'creative ideas'
      }.`;
      enhanced =
        'Projecting the connection into a focus layout or customized wellness soundscape can turn it into immediate utility.';
    }
    return `### Synthesized Thought\n${merged}\n\n### AI Creative Synergy\n${enhanced}`;
  }

  let merged = '';
  let enhanced = '';
  if (isRain && isFire) {
    merged =
      '참나무 장작이 타닥타닥 타오르며 건조하게 터지는 오두막 벽난로의 아늑함과, 외부 창문을 두드리며 차갑게 흘러내리는 빗줄기 소리를 입체적으로 결합한 공간적 아늑함.';
    enhanced =
      '실내 장작의 건조한 고열 질감과 외부 빗방울의 촉촉한 액체 음향을 2.5Hz 비선형 플리커 촛불 광원과 결합하면 정서적 테라피 효과로 발전할 수 있습니다.';
  } else if (isRain && isWind) {
    merged =
      '오두막 처마 밑으로 떨어지는 차분한 빗소리와 숲길을 따라 멀리 나뭇잎들이 흔들리는 바람 소리를 동기화한 역동적 감성 구조.';
    enhanced =
      '바람의 크기에 따라 빗방울 밀도를 실시간 LFO 신호로 변조하면 음향적 몰입 효율을 더 높일 수 있습니다.';
  } else if (isFire && isWind) {
    merged =
      '바람에 흔들리는 숲속 고목의 웅장함과 방 안에서 흔들리는 불꽃의 무작위 리듬이 만드는 오가닉 힐링.';
    enhanced =
      '바람소리의 공허함을 모닥불의 깊은 저역대로 채우고 무작위 나무 기둥 비빔음을 더하면 보호받는 심리적 안전 영역을 구축할 수 있습니다.';
  } else {
    const combinedNouns = Array.from(new Set([...extractNouns(textA), ...extractNouns(textB)]))
      .slice(0, 4)
      .join(', ');
    merged = `[${combinedNouns || '아이디어'}]를 모티프로 하여 '${textA.substring(
      0,
      16,
    )}...'의 직관적 영감과 '${textB.substring(
      0,
      16,
    )}...'의 세부 묘사를 결합한 하나의 완성된 생각 가치 체계.`;
    enhanced =
      '두 생각의 접점을 실생활 뽀모도로 몰입 타이머 또는 맞춤형 앰비언트 웰니스 기능에 투영해 구체적인 작업 생산성 도구로 확장할 가치가 있습니다.';
  }

  return `### 융합된 생각\n${merged}\n\n### AI의 창의적 시너지\n${enhanced}`;
}

function normalizeMemos(value: unknown): DewdropMemo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const id = getString(record.id).trim();
      const text = getString(record.text).trim();
      return id && text ? { id, text } : null;
    })
    .filter((item): item is DewdropMemo => Boolean(item));
}

function runRecommendMergeSimulator(memos: DewdropMemo[], lang = 'ko'): Record<string, string> {
  if (memos.length < 2) return { idA: '', idB: '', reason: '' };

  let idxA = 0;
  let idxB = 1;
  let found = false;

  for (let i = 0; i < memos.length; i += 1) {
    for (let j = i + 1; j < memos.length; j += 1) {
      const txtA = memos[i].text.toLowerCase();
      const txtB = memos[j].text.toLowerCase();
      const hasRainA = txtA.includes('비') || txtA.includes('rain') || txtA.includes('water');
      const hasRainB = txtB.includes('비') || txtB.includes('rain') || txtB.includes('water');
      const hasFireA = txtA.includes('장작') || txtA.includes('fire') || txtA.includes('wood');
      const hasFireB = txtB.includes('장작') || txtB.includes('fire') || txtB.includes('wood');

      if ((hasRainA && hasFireB) || (hasFireA && hasRainB)) {
        idxA = i;
        idxB = j;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  const mA = memos[idxA];
  const mB = memos[idxB];
  const reason =
    lang === 'en'
      ? `Offline simulator matched '${mA.text.substring(0, 15)}...' and '${mB.text.substring(
          0,
          15,
        )}...' for a stronger synergy.`
      : `오프라인 시뮬레이터가 '${mA.text.substring(0, 15)}...'과 '${mB.text.substring(
          0,
          15,
        )}...'을 결합 대상으로 선정했습니다.`;

  return { idA: mA.id, idB: mB.id, reason };
}

function rewriteDewdropScript(script: string): string {
  return script
    .replace(/fetch\(\s*(['"`])\/api\//g, `fetch($1${API_PREFIX}/`)
    .replace(/Gemini 1\.5 Flash \(기본\)/g, 'AOI Main LLM (기본)')
    .replace(/Gemini 1\.5 Flash \(Default\)/g, 'AOI Main LLM (Default)')
    .replace(/Gemini API Key \(공란 시 서버 설정 사용\)/g, 'AOI Main LLM uses Settings > Models')
    .replace(/Gemini API Key \(Leave blank to use server setting\)/g, 'AOI Main LLM uses Settings > Models')
    .replace(/서버 \{providerName\} 키 자동 연동 완료/g, 'AOI 메인 모델 자동 연동 완료')
    .replace(/Server \{providerName\} Key Auto-linked/g, 'AOI Main LLM auto-linked')
    .replace(/서버에 \{providerName\} 키가 없습니다 \(개별 입력 가능\)/g, 'AOI 메인 모델 설정이 없습니다')
    .replace(/No \{providerName\} key on server \(Enter custom key\)/g, 'AOI Main LLM is not configured')
    .replace(/Gemini가 두 메모를 유기적으로 융합했습니다\./g, 'AOI 메인 모델이 두 메모를 유기적으로 융합했습니다.')
    .replace(/Gemini organically fused both memos\./g, 'AOI Main LLM organically fused both memos.');
}

function sourceIsReady(sourceRoot: string): boolean {
  return fs.existsSync(join(sourceRoot, 'index.html')) && fs.existsSync(join(sourceRoot, 'app.js'));
}

function resolveStaticFile(sourceRoot: string, pathname: string): string | null {
  const rawRelativePath =
    pathname === `${STATIC_PREFIX}/` ? 'index.html' : pathname.slice(STATIC_PREFIX.length + 1);
  const relativePath = rawRelativePath || 'index.html';
  const target = resolve(sourceRoot, relativePath);
  return isPathInsideRoot(sourceRoot, target) ? target : null;
}

async function handleDewdropApi(
  sourceRoot: string,
  configFile: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith(API_PREFIX)) return false;

  if (url.pathname === `${API_PREFIX}/status`) {
    writeJson(res, 200, {
      ok: sourceIsReady(sourceRoot),
      sourceRoot,
      staticBase: STATIC_PREFIX,
      apiBase: API_PREFIX,
      dataDirectory: join(sourceRoot, 'data'),
      aoiMainLlm: getAoiLlmStatus(configFile),
    });
    return true;
  }

  if (!sourceIsReady(sourceRoot)) {
    writeJson(res, 503, { error: `Dewdrop Canvas source not found: ${sourceRoot}` });
    return true;
  }

  const route = url.pathname.slice(API_PREFIX.length) || '/';
  const { dataDir, projectsDir } = ensureDewdropDataDirs(sourceRoot);

  try {
    if (req.method === 'GET' && route === '/keys/status') {
      const aoiMainLlm = getAoiLlmStatus(configFile);
      const hasAoiMainLlm = aoiMainLlm.configured === true;
      writeJson(res, 200, {
        gemini: hasAoiMainLlm || Boolean(process.env.GEMINI_API_KEY),
        deepseek: hasAoiMainLlm || Boolean(process.env.DEEPSEEK_API_KEY),
        openrouter: hasAoiMainLlm || Boolean(process.env.OPENROUTER_API_KEY),
        aoiMainLlm,
      });
      return true;
    }

    if (req.method === 'GET' && route === '/projects/active') {
      writeJson(res, 200, loadActiveProject(dataDir, projectsDir, url.searchParams.get('lang') || 'ko'));
      return true;
    }

    if (req.method === 'GET' && route === '/projects') {
      writeJson(res, 200, listProjects(projectsDir));
      return true;
    }

    const projectRoute = route.match(/^\/projects\/([^/]+)$/);
    if (req.method === 'GET' && projectRoute) {
      const projectPath = getProjectPath(projectsDir, decodeURIComponent(projectRoute[1]));
      if (!projectPath || !fs.existsSync(projectPath)) {
        writeJson(res, 404, { error: 'Project workspace not found' });
        return true;
      }
      const project = readJsonFile<DewdropProject>(projectPath);
      if (!project) {
        writeJson(res, 500, { error: 'Failed to load project state.' });
        return true;
      }
      saveLastActiveId(dataDir, basename(projectPath, '.json'));
      writeJson(res, 200, project);
      return true;
    }

    if (req.method === 'POST' && route === '/projects') {
      const body = await readRequestBody(req);
      const id = normalizeProjectId(body.id);
      const title = getString(body.title).trim();
      if (!id || !title) {
        writeJson(res, 400, { error: 'ID and Title are required.' });
        return true;
      }

      const now = new Date();
      const saveData: DewdropProject = {
        id,
        title,
        date: formatDate(now),
        updatedAt: now.toISOString(),
        memos: Array.isArray(body.memos) ? body.memos : [],
        history: Array.isArray(body.history) ? body.history : [],
      };
      writeJsonFile(join(projectsDir, `${id}.json`), saveData);
      saveLastActiveId(dataDir, id);
      writeJson(res, 200, { success: true, project: saveData });
      return true;
    }

    const renameRoute = route.match(/^\/projects\/([^/]+)\/rename$/);
    if (req.method === 'POST' && renameRoute) {
      const id = normalizeProjectId(decodeURIComponent(renameRoute[1]));
      const projectPath = getProjectPath(projectsDir, id);
      if (!id || !projectPath || !fs.existsSync(projectPath)) {
        writeJson(res, 404, { error: 'Project workspace not found' });
        return true;
      }
      const body = await readRequestBody(req);
      const title = getString(body.title).trim();
      if (!title) {
        writeJson(res, 400, { error: 'Title is required.' });
        return true;
      }
      const project = readJsonFile<DewdropProject>(projectPath);
      if (!project) {
        writeJson(res, 500, { error: 'Failed to rename project.' });
        return true;
      }
      const nextProject = { ...project, title, updatedAt: new Date().toISOString() };
      writeJsonFile(projectPath, nextProject);
      writeJson(res, 200, { success: true, title });
      return true;
    }

    if (req.method === 'DELETE' && projectRoute) {
      const id = normalizeProjectId(decodeURIComponent(projectRoute[1]));
      const projectPath = getProjectPath(projectsDir, id);
      if (!id || !projectPath || !fs.existsSync(projectPath)) {
        writeJson(res, 404, { error: 'Project workspace not found' });
        return true;
      }
      fs.unlinkSync(projectPath);
      if (getLastActiveId(dataDir) === id) {
        const activePath = getActiveMetaPath(dataDir);
        if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
      }
      writeJson(res, 200, { success: true });
      return true;
    }

    if (req.method === 'POST' && route === '/recommend-merge') {
      const body = await readRequestBody(req);
      const memos = normalizeMemos(body.memos);
      if (memos.length < 2) {
        writeJson(res, 400, { error: 'At least 2 memos are required for recommendation.' });
        return true;
      }

      const provider = normalizeProvider(body.provider);
      const lang = getString(body.language) || 'ko';
      const aoiConfig = loadAoiMainLlmConfig(configFile);
      if (provider === 'simulator' || !aoiConfig) {
        writeJson(res, 200, { success: true, ...runRecommendMergeSimulator(memos, lang) });
        return true;
      }

      try {
        const resultText = await callAoiMainTextModel(
          aoiConfig,
          getRequestOrigin(req),
          buildRecommendPrompt(memos, lang),
          300,
          true,
        );
        const parsed = JSON.parse(resultText.replace(/```json/g, '').replace(/```/g, '').trim()) as {
          idA?: string;
          idB?: string;
          reason?: string;
        };
        const existsA = memos.some((memo) => memo.id === parsed.idA);
        const existsB = memos.some((memo) => memo.id === parsed.idB);
        if (!existsA || !existsB || parsed.idA === parsed.idB) {
          throw new Error('Model returned invalid IDs.');
        }
        writeJson(res, 200, {
          success: true,
          source: 'aoi-main',
          modelProvider: aoiConfig.provider,
          model: aoiConfig.model,
          idA: parsed.idA,
          idB: parsed.idB,
          reason: parsed.reason || '',
        });
      } catch (error) {
        writeJson(res, 200, {
          success: true,
          source: 'simulation_fallback',
          modelProvider: aoiConfig.provider,
          model: aoiConfig.model,
          fallbackReason: formatFallbackReason(error),
          ...runRecommendMergeSimulator(memos, lang),
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/synthesize') {
      const body = await readRequestBody(req);
      const textA = getString(body.textA).trim();
      const textB = getString(body.textB).trim();
      if (!textA || !textB) {
        writeJson(res, 400, { error: 'Both textA and textB are required.' });
        return true;
      }

      const provider = normalizeProvider(body.provider);
      const lang = getString(body.language) || 'ko';
      const aoiConfig = loadAoiMainLlmConfig(configFile);
      if (provider === 'simulator' || !aoiConfig) {
        writeJson(res, 200, { success: true, mode: 'simulation', text: runPoeticSimulator(textA, textB, lang) });
        return true;
      }

      try {
        const text = await callAoiMainTextModel(
          aoiConfig,
          getRequestOrigin(req),
          buildSynthesizePrompt(textA, textB, lang),
          600,
        );
        writeJson(res, 200, {
          success: true,
          mode: provider,
          source: 'aoi-main',
          modelProvider: aoiConfig.provider,
          model: aoiConfig.model,
          text,
        });
      } catch (error) {
        writeJson(res, 200, {
          success: true,
          mode: 'simulation_fallback',
          source: 'simulation_fallback',
          modelProvider: aoiConfig.provider,
          model: aoiConfig.model,
          fallbackReason: formatFallbackReason(error),
          text: runPoeticSimulator(textA, textB, lang),
        });
      }
      return true;
    }

    if (req.method === 'POST' && route === '/enhance') {
      const body = await readRequestBody(req);
      const text = getString(body.text).trim();
      if (!text) {
        writeJson(res, 400, { error: 'Text is required for enhancement.' });
        return true;
      }

      const provider = normalizeProvider(body.provider);
      const lang = getString(body.language) || 'ko';
      const aoiConfig = loadAoiMainLlmConfig(configFile);
      if (provider === 'simulator' || !aoiConfig) {
        writeJson(res, 200, { success: true, mode: 'simulation', text: runPoeticSingleEnhance(text, lang) });
        return true;
      }

      try {
        const enhanced = await callAoiMainTextModel(
          aoiConfig,
          getRequestOrigin(req),
          buildEnhancePrompt(text, lang),
          600,
        );
        writeJson(res, 200, {
          success: true,
          mode: provider,
          source: 'aoi-main',
          modelProvider: aoiConfig.provider,
          model: aoiConfig.model,
          text: enhanced,
        });
      } catch (error) {
        writeJson(res, 200, {
          success: true,
          mode: 'simulation_fallback',
          source: 'simulation_fallback',
          modelProvider: aoiConfig.provider,
          model: aoiConfig.model,
          fallbackReason: formatFallbackReason(error),
          text: runPoeticSingleEnhance(text, lang),
        });
      }
      return true;
    }

    writeJson(res, 404, { error: 'Dewdrop Canvas API route not found.' });
    return true;
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

function handleDewdropStatic(sourceRoot: string, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (url.pathname === STATIC_PREFIX) {
    res.writeHead(302, { Location: `${STATIC_PREFIX}/` });
    res.end();
    return true;
  }

  if (!url.pathname.startsWith(`${STATIC_PREFIX}/`)) return false;

  if (!sourceIsReady(sourceRoot)) {
    writeText(
      res,
      503,
      'text/html; charset=utf-8',
      `<!doctype html><title>Dewdrop Canvas unavailable</title><body>Dewdrop Canvas source not found: ${sourceRoot}</body>`,
    );
    return true;
  }

  const filePath = resolveStaticFile(sourceRoot, url.pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    writeText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return true;
  }

  if (basename(filePath) === 'app.js') {
    writeText(res, 200, getContentType(filePath), rewriteDewdropScript(fs.readFileSync(filePath, 'utf-8')));
    return true;
  }

  const payload = extname(filePath).toLowerCase() === '.html' ? fs.readFileSync(filePath, 'utf-8') : fs.readFileSync(filePath);
  writeText(res, 200, getContentType(filePath), payload);
  return true;
}

export function dewdropCanvasPlugin(options: PluginOptions = {}): Plugin {
  const sourceRoot = resolve(
    options.sourceRoot || process.env.DEWDROP_CANVAS_ROOT || DEFAULT_SOURCE_ROOT,
  );
  const configFile = options.configFile ? resolve(options.configFile) : '';

  const mount = (middlewares: MiddlewareStack) => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');

      void handleDewdropApi(sourceRoot, configFile, req, res, url)
        .then((handled) => {
          if (handled) return;
          if (handleDewdropStatic(sourceRoot, req, res, url)) return;
          next();
        })
        .catch((error) => {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
    });
  };

  return {
    name: 'dewdrop-canvas',
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
