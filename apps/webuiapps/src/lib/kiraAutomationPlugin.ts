import * as fs from 'fs';
import { exec as execCallback, execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { dirname, join, resolve } from 'path';
import type { Plugin } from 'vite';

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);

type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'llama.cpp'
  | 'minimax'
  | 'z.ai'
  | 'kimi'
  | 'openrouter';

type KiraTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders?: string;
}

interface KiraSettings {
  workRootDirectory?: string;
  workerModel?: string;
  reviewerModel?: string;
  workerLlm?: Partial<LLMConfig>;
  reviewerLlm?: Partial<LLMConfig>;
  projectDefaults?: KiraProjectSettings;
}

interface WorkTask {
  id: string;
  type: 'work';
  projectName: string;
  title: string;
  description: string;
  status: KiraTaskStatus;
  assignee: string;
  createdAt: number;
  updatedAt: number;
}

interface TaskComment {
  id: string;
  taskId: string;
  taskType: 'work';
  author: string;
  body: string;
  createdAt: number;
}

interface AutomationLockRecord {
  ownerId: string;
  resource: 'project' | 'work';
  sessionPath: string;
  targetKey: string;
  acquiredAt: number;
  heartbeatAt: number;
}

interface WorkerSummary {
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  remainingRisks: string[];
}

interface ReviewSummary {
  approved: boolean;
  summary: string;
  issues: string[];
  filesChecked: string[];
}

interface ProjectDiscoveryFinding {
  id: string;
  kind: 'feature' | 'bug';
  title: string;
  summary: string;
  evidence: string[];
  files: string[];
  taskDescription: string;
}

interface ProjectDiscoveryAnalysis {
  id: string;
  projectName: string;
  projectRoot: string;
  summary: string;
  findings: ProjectDiscoveryFinding[];
  basedOnPreviousAnalysis: boolean;
  previousAnalysisId?: string;
  createdAt: number;
  updatedAt: number;
}

interface KiraProjectSettings {
  autoCommit?: boolean;
}

interface KiraAutomationEvent {
  id: string;
  workId: string;
  title: string;
  projectName: string;
  message: string;
  createdAt: number;
  type: 'started' | 'resumed' | 'completed' | 'needs_attention';
}

interface KiraAutomationPluginOptions {
  configFile: string;
  sessionsDir: string;
  getWorkRootDirectory: () => string | null;
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

const COMMENTS_DIR_NAME = 'comments';
const WORKS_DIR_NAME = 'works';
const ANALYSIS_DIR_NAME = 'analysis';
const PROJECT_SETTINGS_DIR_NAME = '.kira';
const PROJECT_SETTINGS_FILE_NAME = 'project-settings.json';
const MAX_REVIEW_CYCLES = 5;
const MAX_DISCOVERY_FINDINGS = 10;
const MAX_AGENT_TURNS = 24;
const MAX_FILE_BYTES = 80_000;
const MAX_OVERWRITE_FILE_BYTES = 8_000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const COMMAND_TIMEOUT_MS = 90_000;
const STALLED_WORK_MS = 15_000;
const GLOBAL_SCAN_INTERVAL_MS = 10_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 10 * 60_000;
const WORKER_AUTHOR = 'Kira Worker';
const REVIEWER_AUTHOR = 'Main AI Reviewer';
const activeJobs = new Set<string>();
const activeProjectJobs = new Set<string>();
const jobAbortControllers = new Map<string, AbortController>();
const EVENT_QUEUE_FILE = 'kira-automation-events.json';
const LOCKS_DIR_NAME = 'automation-locks';
const GLOBAL_LOCKS_DIR_NAME = '.kira-automation-locks';
const SERVER_INSTANCE_ID = makeId('kira-server');
const SAFE_COMMAND_PATTERNS = [
  /^python(?:\s|$)/i,
  /^py(?:\s|$)/i,
  /^pytest(?:\s|$)/i,
  /^uv(?:\s|$)/i,
  /^pip(?:\s|$)/i,
  /^npm(?:\s|$)/i,
  /^pnpm(?:\s|$)/i,
  /^node(?:\s|$)/i,
  /^git\s+(status|diff|show|rev-parse|branch|log)\b/i,
  /^rg(?:\s|$)/i,
  /^go(?:\s|$)/i,
  /^cargo(?:\s|$)/i,
  /^dotnet(?:\s|$)/i,
];
const DANGEROUS_COMMAND_PATTERNS = [
  /\b(?:rm|del|rmdir|erase|format|shutdown)\b/i,
  /\b(?:remove-item|move-item|rename-item|copy-item)\b/i,
  /\bgit\s+(?:reset|checkout|clean)\b/i,
  /[|;&><]/,
];

interface GitStatusEntry {
  path: string;
  status: string;
}

function sanitizeSessionPath(sessionPath: string): string {
  return sessionPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || /aborted/i.test(error.message);
  }
  return false;
}

function throwIfCanceled(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  signal?: AbortSignal,
): void {
  const workPath = getWorkFileAbsolutePath(sessionsDir, sessionPath, workId);
  if (signal?.aborted || !fs.existsSync(workPath)) {
    const error = new Error('Work was canceled or deleted.');
    error.name = 'AbortError';
    throw error;
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf-8');
}

function listJsonFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dirPath, entry.name));
}

function getKiraDataDir(sessionsDir: string, sessionPath: string): string {
  return join(sessionsDir, sanitizeSessionPath(sessionPath), 'apps', 'kira', 'data');
}

function getKiraAnalysisDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), ANALYSIS_DIR_NAME);
}

function getProjectSettingsPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_SETTINGS_DIR_NAME, PROJECT_SETTINGS_FILE_NAME);
}

function getWorkFileAbsolutePath(sessionsDir: string, sessionPath: string, workId: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), WORKS_DIR_NAME, `${workId}.json`);
}

function getProjectDiscoveryFilePath(
  sessionsDir: string,
  sessionPath: string,
  projectName: string,
): string {
  return join(
    getKiraAnalysisDir(sessionsDir, sessionPath),
    `project-discovery-${sanitizeLockKey(projectName.toLowerCase())}.json`,
  );
}

export function resolveProjectSettings(
  raw: unknown,
  fallback: { autoCommit?: boolean } = {},
): { autoCommit: boolean } {
  const parsed = typeof raw === 'object' && raw !== null ? (raw as KiraProjectSettings) : {};
  return {
    autoCommit:
      typeof parsed.autoCommit === 'boolean'
        ? parsed.autoCommit
        : typeof fallback.autoCommit === 'boolean'
          ? fallback.autoCommit
          : true,
  };
}

function loadProjectSettings(
  projectRoot: string,
  fallback: { autoCommit?: boolean } = {},
): { autoCommit: boolean } {
  const raw = readJsonFile<KiraProjectSettings>(getProjectSettingsPath(projectRoot));
  return resolveProjectSettings(raw, fallback);
}

function getAutomationEventQueuePath(sessionsDir: string, sessionPath: string): string {
  return join(sessionsDir, sanitizeSessionPath(sessionPath), 'chat', EVENT_QUEUE_FILE);
}

function getSessionAutomationLocksDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), LOCKS_DIR_NAME);
}

function getGlobalAutomationLocksDir(sessionsDir: string): string {
  return join(sessionsDir, GLOBAL_LOCKS_DIR_NAME);
}

function sanitizeLockKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'lock';
}

function getWorkLockPath(sessionsDir: string, sessionPath: string, workId: string): string {
  return join(getSessionAutomationLocksDir(sessionsDir, sessionPath), `work-${sanitizeLockKey(workId)}.json`);
}

function getProjectLockPath(sessionsDir: string, projectKey: string): string {
  return join(getGlobalAutomationLocksDir(sessionsDir), `project-${sanitizeLockKey(projectKey)}.json`);
}

function loadAutomationEvents(sessionsDir: string, sessionPath: string): KiraAutomationEvent[] {
  const queuePath = getAutomationEventQueuePath(sessionsDir, sessionPath);
  return readJsonFile<KiraAutomationEvent[]>(queuePath) ?? [];
}

function enqueueEvent(sessionsDir: string, sessionPath: string, event: KiraAutomationEvent): void {
  const queuePath = getAutomationEventQueuePath(sessionsDir, sessionPath);
  const queue = loadAutomationEvents(sessionsDir, sessionPath);
  queue.push(event);
  writeJsonFile(queuePath, queue);
}

function drainEvents(sessionsDir: string, sessionPath: string): KiraAutomationEvent[] {
  const queuePath = getAutomationEventQueuePath(sessionsDir, sessionPath);
  const events = loadAutomationEvents(sessionsDir, sessionPath);
  if (events.length > 0) {
    writeJsonFile(queuePath, []);
  }
  return events;
}

function discoverSessionPaths(sessionsDir: string): string[] {
  const found = new Set<string>();

  const walk = (currentDir: string) => {
    const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const absolutePath = join(currentDir, dirent.name);
      const relativePath = absolutePath.slice(sessionsDir.length).replace(/^[\\/]+/, '');
      const normalized = relativePath.replace(/\\/g, '/');
      if (normalized.endsWith('/apps/kira/data/works')) {
        const segments = normalized.split('/');
        const appsIndex = segments.indexOf('apps');
        if (appsIndex > 0) {
          found.add(segments.slice(0, appsIndex).join('/'));
        }
        continue;
      }
      walk(absolutePath);
    }
  };

  if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
    walk(sessionsDir);
  }
  return [...found];
}

function loadLlmConfig(configFile: string): LLMConfig | null {
  try {
    if (!fs.existsSync(configFile)) return null;
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { llm?: LLMConfig };
    if (!raw.llm?.baseUrl?.trim() || !raw.llm.model?.trim()) return null;
    return {
      ...raw.llm,
      apiKey: raw.llm.apiKey ?? '',
      customHeaders: raw.llm.customHeaders?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function loadKiraSettings(configFile: string): KiraSettings {
  try {
    if (!fs.existsSync(configFile)) return {};
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as { kira?: KiraSettings };
    return typeof raw.kira === 'object' && raw.kira !== null ? raw.kira : {};
  } catch {
    return {};
  }
}

function buildAgentLabel(base: string, model: string | null | undefined): string {
  const normalized = model?.trim();
  return normalized ? `${base} - ${normalized}` : base;
}

function isWorkerAuthor(author: string): boolean {
  return author === WORKER_AUTHOR || author.startsWith(`${WORKER_AUTHOR} - `);
}

function isReviewerAuthor(author: string): boolean {
  return author === REVIEWER_AUTHOR || author.startsWith(`${REVIEWER_AUTHOR} - `);
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveRoleLlmConfig(
  baseConfig: LLMConfig | null,
  override: Partial<LLMConfig> | null | undefined,
  legacyModel: string | null | undefined,
): LLMConfig | null {
  const provider = getOptionalString(override?.provider) ?? baseConfig?.provider;
  const baseUrl = getOptionalString(override?.baseUrl) ?? baseConfig?.baseUrl;
  const model = getOptionalString(override?.model) ?? getOptionalString(legacyModel) ?? baseConfig?.model;
  const apiKey = override?.apiKey ?? baseConfig?.apiKey ?? '';
  const customHeaders = getOptionalString(override?.customHeaders) ?? baseConfig?.customHeaders;

  if (!provider || !baseUrl || !model) return null;

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    ...(customHeaders ? { customHeaders } : {}),
  };
}

function getKiraRuntimeSettings(configFile: string, fallbackWorkRootDirectory: string | null) {
  const llmConfig = loadLlmConfig(configFile);
  const kiraSettings = loadKiraSettings(configFile);
  const workRootDirectory = kiraSettings.workRootDirectory?.trim() || fallbackWorkRootDirectory;
  const workerConfig = resolveRoleLlmConfig(llmConfig, kiraSettings.workerLlm, kiraSettings.workerModel);
  const reviewerConfig = resolveRoleLlmConfig(
    llmConfig,
    kiraSettings.reviewerLlm,
    kiraSettings.reviewerModel,
  );
  const workerModel = workerConfig?.model ?? null;
  const reviewerModel = reviewerConfig?.model ?? null;

  return {
    workRootDirectory,
    defaultProjectSettings: resolveProjectSettings(kiraSettings.projectDefaults),
    workerModel,
    reviewerModel,
    workerAuthor: buildAgentLabel(WORKER_AUTHOR, workerModel),
    reviewerAuthor: buildAgentLabel(REVIEWER_AUTHOR, reviewerModel),
    workerConfig,
    reviewerConfig,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function hasVersionSuffix(url: string): boolean {
  return /\/v\d+\/?$/.test(url);
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
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

function isAnthropicProvider(provider: LLMProvider): boolean {
  return provider === 'anthropic' || provider === 'minimax';
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // ignore
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = firstBrace; index < trimmed.length; index += 1) {
      const ch = trimmed[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth === 0) return trimmed.slice(firstBrace, index + 1);
    }
  }

  return trimmed;
}

function normalizeToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function splitParameterSchema(parameters: Record<string, unknown>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, rawValue] of Object.entries(parameters)) {
    const value = (rawValue ?? {}) as Record<string, unknown>;
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }

  return { properties, required };
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (() => {
        const schema = splitParameterSchema(tool.parameters);
        return {
          type: 'object',
          properties: schema.properties,
          required: schema.required,
        };
      })(),
    },
  }));
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (() => {
      const schema = splitParameterSchema(tool.parameters);
      return {
        type: 'object',
        properties: schema.properties,
        required: schema.required,
      };
    })(),
  }));
}

async function callOpenAiCompatible(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const targetUrl = joinUrl(config.baseUrl, getOpenAICompletionsPath(config.baseUrl));
  const messages = history.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              })),
            }
          : {}),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    }
    return { role: 'user', content: message.content };
  });

  const body: Record<string, unknown> = {
    model: config.model,
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
    stream: false,
  };
  if (tools.length > 0) body.tools = toOpenAITools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey}`;

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = data.choices?.[0]?.message;
  const toolCalls =
    message?.tool_calls?.map((toolCall, index) => ({
      id: toolCall.id || `tool_${index}`,
      name: toolCall.function?.name || '',
      args: normalizeToolArguments(toolCall.function?.arguments || '{}'),
    })) ?? [];
  return {
    content: message?.content?.trim() || '',
    toolCalls: toolCalls.filter((tool) => tool.name),
  };
}

async function callAnthropicCompatible(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const targetUrl = joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl));
  const messages = history.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.args,
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096,
    messages,
  };
  if (systemPrompt) body.system = systemPrompt;
  if (tools.length > 0) body.tools = toAnthropicTools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (config.apiKey.trim()) headers['x-api-key'] = config.apiKey;

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
    >;
  };
  const content = (data.content ?? [])
    .filter((block): block is { type: 'text'; text?: string } => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
    .trim();
  const toolCalls = (data.content ?? [])
    .filter(
      (block): block is { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> } =>
        block.type === 'tool_use',
    )
    .map((block, index) => ({
      id: block.id || `tool_${index}`,
      name: block.name || '',
      args: block.input ?? {},
    }))
    .filter((tool) => tool.name);
  return { content, toolCalls };
}

async function callLlm(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  return isAnthropicProvider(config.provider)
    ? callAnthropicCompatible(config, systemPrompt, history, tools, signal)
    : callOpenAiCompatible(config, systemPrompt, history, tools, signal);
}

function ensureInsideRoot(root: string, candidatePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidatePath);
  const prefix =
    resolvedRoot.endsWith('\\') || resolvedRoot.endsWith('/')
      ? resolvedRoot
      : `${resolvedRoot}${process.platform === 'win32' ? '\\' : '/'}`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(prefix)) {
    throw new Error('Path escapes the project root.');
  }
  return resolvedCandidate;
}

function containsCorruptionMarker(content: string): boolean {
  return /rest of file unchanged/i.test(content);
}

function collectFiles(root: string, currentDir: string, depth: number, entries: string[]): void {
  if (entries.length >= MAX_LIST_ENTRIES) return;
  const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    if (dirent.name === '.git' || dirent.name === 'node_modules' || dirent.name === '.venv') continue;
    const absolutePath = join(currentDir, dirent.name);
    const relativePath = absolutePath.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    if (dirent.isDirectory()) {
      entries.push(`[dir] ${relativePath}`);
      if (depth > 0) collectFiles(root, absolutePath, depth - 1, entries);
    } else {
      entries.push(`[file] ${relativePath}`);
    }
  }
}

function searchProjectFiles(root: string, query: string): string[] {
  const results: string[] = [];
  const needle = query.toLowerCase();
  const walk = (currentDir: string) => {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      if (dirent.name === '.git' || dirent.name === 'node_modules' || dirent.name === '.venv') continue;
      const absolutePath = join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const relativePath = absolutePath.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      if (relativePath.toLowerCase().includes(needle)) {
        results.push(`${relativePath}: filename match`);
        continue;
      }
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = fs.readFileSync(absolutePath, 'utf-8');
        const lower = content.toLowerCase();
        const index = lower.indexOf(needle);
        if (index >= 0) {
          const snippet = content.slice(Math.max(0, index - 80), Math.min(content.length, index + 120));
          results.push(`${relativePath}: ${snippet.replace(/\s+/g, ' ').trim()}`);
        }
      } catch {
        // ignore unreadable files
      }
    }
  };
  walk(root);
  return results;
}

async function executeTool(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  writable: boolean,
): Promise<string> {
  switch (toolName) {
    case 'list_files': {
      const directory = typeof args.directory === 'string' ? args.directory : '.';
      const depth = typeof args.depth === 'number' ? Math.max(0, Math.min(4, args.depth)) : 2;
      const targetDir = ensureInsideRoot(projectRoot, directory);
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        return 'error: directory not found';
      }
      const entries: string[] = [];
      collectFiles(targetDir, targetDir, depth, entries);
      return entries.length > 0 ? entries.join('\n') : 'empty directory';
    }
    case 'read_file': {
      const filePath = typeof args.path === 'string' ? args.path : '';
      if (!filePath) return 'error: path is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        return 'error: file not found';
      }
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_FILE_BYTES) return 'error: file too large';
      return fs.readFileSync(absolutePath, 'utf-8');
    }
    case 'write_file': {
      if (!writable) return 'error: write_file is disabled for this agent';
      const filePath = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) return 'error: path is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      if (containsCorruptionMarker(content)) {
        return 'error: refusing to write placeholder or corruption marker text';
      }
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        const stat = fs.statSync(absolutePath);
        if (stat.size > MAX_OVERWRITE_FILE_BYTES) {
          return 'error: existing file is too large for write_file; use edit_file instead';
        }
      }
      fs.mkdirSync(dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, 'utf-8');
      return 'success';
    }
    case 'edit_file': {
      if (!writable) return 'error: edit_file is disabled for this agent';
      const filePath = typeof args.path === 'string' ? args.path : '';
      const find = typeof args.find === 'string' ? args.find : '';
      const replace = typeof args.replace === 'string' ? args.replace : '';
      const replaceAll = args.replace_all === true;
      if (!filePath) return 'error: path is required';
      if (!find) return 'error: find is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        return 'error: file not found';
      }
      const current = fs.readFileSync(absolutePath, 'utf-8');
      const occurrences = current.split(find).length - 1;
      if (occurrences === 0) return 'error: target text not found';
      if (!replaceAll && occurrences > 1) {
        return `error: target text matched ${occurrences} times; refine the find text or set replace_all=true`;
      }
      const next = replaceAll ? current.split(find).join(replace) : current.replace(find, replace);
      if (containsCorruptionMarker(next)) {
        return 'error: refusing to write placeholder or corruption marker text';
      }
      fs.writeFileSync(absolutePath, next, 'utf-8');
      return `success: replaced ${replaceAll ? occurrences : 1} occurrence(s)`;
    }
    case 'search_files': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'error: query is required';
      const results = searchProjectFiles(projectRoot, query);
      return results.length > 0 ? results.join('\n') : 'no matches';
    }
    case 'run_command': {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) return 'error: command is required';
      if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
        return 'error: command rejected by safety policy';
      }
      if (!SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
        return 'error: command prefix is not allowed';
      }
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const { stdout, stderr } = await execAsync(command, {
        cwd: projectRoot,
        shell,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return [`stdout:\n${stdout.trim() || '(empty)'}`, `stderr:\n${stderr.trim() || '(empty)'}`].join('\n\n');
    }
    default:
      return `error: unknown tool ${toolName}`;
  }
}

function buildToolDefinitions(writable: boolean): ToolDefinition[] {
  return [
    {
      name: 'list_files',
      description: 'List files and directories relative to the project root.',
      parameters: {
        directory: { type: 'string', description: 'Relative directory path', required: false },
        depth: { type: 'number', description: 'Recursion depth up to 4', required: false },
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file relative to the project root.',
      parameters: {
        path: { type: 'string', description: 'Relative file path', required: true },
      },
    },
    ...(writable
      ? [
          {
            name: 'edit_file',
            description:
              'Patch an existing UTF-8 file by replacing exact text. Prefer this over write_file for existing files, especially large ones.',
            parameters: {
              path: { type: 'string', description: 'Relative file path', required: true },
              find: { type: 'string', description: 'Exact existing text to replace', required: true },
              replace: { type: 'string', description: 'Replacement text', required: true },
              replace_all: {
                type: 'boolean',
                description: 'When true, replace every occurrence instead of only one',
                required: false,
              },
            },
          } satisfies ToolDefinition,
          {
            name: 'write_file',
            description:
              'Create a new UTF-8 file or overwrite a small existing file relative to the project root.',
            parameters: {
              path: { type: 'string', description: 'Relative file path', required: true },
              content: { type: 'string', description: 'Full file content', required: true },
            },
          } satisfies ToolDefinition,
        ]
      : []),
    {
      name: 'search_files',
      description: 'Search filenames and text content inside the project.',
      parameters: {
        query: { type: 'string', description: 'Case-insensitive search query', required: true },
      },
    },
    {
      name: 'run_command',
      description:
        'Run a safe project command such as tests or diagnostics. Allowed prefixes include python, py, pytest, uv, npm, pnpm, node, git status/diff/show, rg, go, cargo, dotnet.',
      parameters: {
        command: { type: 'string', description: 'Exact command to run', required: true },
      },
    },
  ];
}

async function runToolAgent(
  config: LLMConfig,
  projectRoot: string,
  prompt: string,
  systemPrompt: string,
  writable: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const history: AgentMessage[] = [{ role: 'user', content: prompt }];
  const tools = buildToolDefinitions(writable);

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    if (signal?.aborted) {
      const error = new Error('Agent run aborted.');
      error.name = 'AbortError';
      throw error;
    }
    const response = await callLlm(config, systemPrompt, history, tools, signal);
    if (response.toolCalls.length === 0) {
      return response.content;
    }

    history.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const toolCall of response.toolCalls) {
      if (signal?.aborted) {
        const error = new Error('Agent run aborted.');
        error.name = 'AbortError';
        throw error;
      }
      const toolResult = await executeTool(projectRoot, toolCall.name, toolCall.args, writable);
      history.push({
        role: 'tool',
        content: toolResult,
        toolCallId: toolCall.id,
      });
    }
  }

  throw new Error('Agent exceeded the maximum number of tool turns.');
}

function parseWorkerSummary(raw: string): WorkerSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkerSummary>;
    return {
      summary: parsed.summary?.trim() || 'No worker summary provided.',
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged.map(String) : [],
      testsRun: Array.isArray(parsed.testsRun) ? parsed.testsRun.map(String) : [],
      remainingRisks: Array.isArray(parsed.remainingRisks)
        ? parsed.remainingRisks.map(String)
        : [],
    };
  } catch {
    return {
      summary: raw.trim() || 'No worker summary provided.',
      filesChanged: [],
      testsRun: [],
      remainingRisks: [],
    };
  }
}

function parseReviewSummary(raw: string): ReviewSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<ReviewSummary>;
    return {
      approved: Boolean(parsed.approved),
      summary: parsed.summary?.trim() || 'No review summary provided.',
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      filesChecked: Array.isArray(parsed.filesChecked) ? parsed.filesChecked.map(String) : [],
    };
  } catch {
    return {
      approved: false,
      summary: raw.trim() || 'Review parsing failed.',
      issues: ['Review result could not be parsed into structured JSON.'],
      filesChecked: [],
    };
  }
}

function normalizeFindingKind(value: unknown, title: string, summary: string): 'feature' | 'bug' {
  if (value === 'bug' || value === 'feature') return value;
  const haystack = `${title} ${summary}`.toLowerCase();
  return /bug|fix|error|issue|broken|regression|버그|수정|오류/.test(haystack) ? 'bug' : 'feature';
}

function buildFallbackTaskDescription(finding: ProjectDiscoveryFinding): string {
  return [
    `# Brief`,
    '',
    finding.summary,
    '',
    `## Type`,
    '',
    `- ${finding.kind}`,
    '',
    `## Evidence`,
    '',
    ...finding.evidence.map((item) => `- ${item}`),
    '',
    `## Candidate Files`,
    '',
    ...(finding.files.length > 0 ? finding.files.map((item) => `- ${item}`) : ['- Inspect the current project and choose the most relevant files.']),
    '',
    `## Acceptance Criteria`,
    '',
    `- Implement the change described above.`,
    `- Keep the behavior aligned with the current project style.`,
    `- Run the most relevant validation or checks when practical.`,
  ].join('\n');
}

export function parseProjectDiscoveryAnalysis(
  raw: string,
  projectName: string,
  projectRoot: string,
  previousAnalysis: ProjectDiscoveryAnalysis | null,
): ProjectDiscoveryAnalysis {
  const now = Date.now();

  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<ProjectDiscoveryAnalysis> & {
      findings?: Array<Partial<ProjectDiscoveryFinding>>;
    };
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
          .slice(0, MAX_DISCOVERY_FINDINGS)
          .map((finding, index) => {
            const title = finding.title?.trim() || `Discovery item ${index + 1}`;
            const summary = finding.summary?.trim() || 'No summary provided.';
            const files = Array.isArray(finding.files) ? finding.files.map(String).filter(Boolean) : [];
            const evidence = Array.isArray(finding.evidence)
              ? finding.evidence.map(String).filter(Boolean)
              : files;
            const normalized: ProjectDiscoveryFinding = {
              id: finding.id?.trim() || `finding-${index + 1}`,
              kind: normalizeFindingKind(finding.kind, title, summary),
              title,
              summary,
              evidence,
              files,
              taskDescription: finding.taskDescription?.trim() || '',
            };
            return {
              ...normalized,
              taskDescription: normalized.taskDescription || buildFallbackTaskDescription(normalized),
            };
          })
      : [];

    return {
      id: parsed.id?.trim() || makeId('project-discovery'),
      projectName,
      projectRoot,
      summary: parsed.summary?.trim() || 'No discovery summary provided.',
      findings,
      basedOnPreviousAnalysis: Boolean(previousAnalysis),
      previousAnalysisId: previousAnalysis?.id,
      createdAt:
        typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
          ? parsed.createdAt
          : now,
      updatedAt: now,
    };
  } catch {
    return {
      id: makeId('project-discovery'),
      projectName,
      projectRoot,
      summary: raw.trim() || 'Project discovery parsing failed.',
      findings: [],
      basedOnPreviousAnalysis: Boolean(previousAnalysis),
      previousAnalysisId: previousAnalysis?.id,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function formatList(items: string[], emptyLabel: string): string {
  if (items.length === 0) return `- ${emptyLabel}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function parseStoredList(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== '' && !/^No .* reported$/i.test(line) && line.toLowerCase() !== 'none reported');
}

function extractSection(body: string, label: string, nextLabels: string[]): string {
  const startToken = `${label}:\n`;
  const startIndex = body.indexOf(startToken);
  if (startIndex < 0) return '';

  const contentStart = startIndex + startToken.length;
  let contentEnd = body.length;
  for (const nextLabel of nextLabels) {
    const nextIndex = body.indexOf(`\n\n${nextLabel}:\n`, contentStart);
    if (nextIndex >= 0 && nextIndex < contentEnd) {
      contentEnd = nextIndex;
    }
  }

  return body.slice(contentStart, contentEnd).trim();
}

export function parseStoredWorkerAttemptComment(body: string): WorkerSummary | null {
  if (!body.startsWith('Attempt ')) return null;

  const summary = extractSection(body, 'Summary', ['Files changed', 'Checks', 'Remaining risks']);
  return {
    summary: summary || 'No worker summary provided.',
    filesChanged: parseStoredList(extractSection(body, 'Files changed', ['Checks', 'Remaining risks'])),
    testsRun: parseStoredList(extractSection(body, 'Checks', ['Remaining risks'])),
    remainingRisks: parseStoredList(extractSection(body, 'Remaining risks', [])),
  };
}

export function findSuggestedCommitBackfillSummary(comments: TaskComment[]): WorkerSummary | null {
  const approvalIndex = [...comments]
    .map((comment, index) => ({ comment, index }))
    .reverse()
    .find(({ comment }) => isReviewerAuthor(comment.author) && comment.body.startsWith('Approved.'))?.index;

  if (approvalIndex === undefined) return null;

  const hasCommitSuggestionAfterApproval = comments
    .slice(approvalIndex + 1)
    .some(
      (comment) =>
        isReviewerAuthor(comment.author) && comment.body.startsWith('Suggested commit message:'),
    );
  if (hasCommitSuggestionAfterApproval) return null;

  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!isWorkerAuthor(comment.author)) continue;
    const summary = parseStoredWorkerAttemptComment(comment.body);
    if (summary) return summary;
  }

  return null;
}

function toKebabCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function buildSuggestedCommitMessage(work: WorkTask, workerSummary: WorkerSummary): string {
  const fileList = workerSummary.filesChanged.join(' ').toLowerCase();
  const type = /fix|bug|error|repair|patch|hotfix|버그|수정/.test(work.title.toLowerCase())
    || /fix|bug|error|repair|patch|hotfix/.test(fileList)
    ? 'fix'
    : 'feat';
  const scope = toKebabCase(work.projectName);
  const prefix = scope ? `${type}(${scope})` : type;
  return `${prefix}: ${work.title}`;
}

async function runGitCommand(projectRoot: string, args: string[]): Promise<string> {
  const safeDirectory = projectRoot.replace(/\\/g, '/');
  const result = await execFileAsync(
    'git',
    ['-c', `safe.directory=${safeDirectory}`, '-C', projectRoot, ...args],
    {
      cwd: projectRoot,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  return `${result.stdout ?? ''}`.trim();
}

export function parseGitStatusPorcelain(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim().replace(/\\/g, '/'),
    }))
    .filter((entry) => entry.path !== '');
}

async function getGitWorktreeEntries(projectRoot: string): Promise<GitStatusEntry[] | null> {
  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    const output = await runGitCommand(projectRoot, ['status', '--porcelain=v1', '-uall']);
    return parseGitStatusPorcelain(output);
  } catch {
    return null;
  }
}

export function detectTouchedFilesFromGitStatus(
  before: GitStatusEntry[] | null,
  after: GitStatusEntry[] | null,
): string[] {
  if (!after) return [];

  const beforeMap = new Map((before ?? []).map((entry) => [entry.path, entry.status]));
  const touched = new Set<string>();

  for (const entry of after) {
    const previousStatus = beforeMap.get(entry.path);
    if (previousStatus !== entry.status) {
      touched.add(entry.path);
    }
  }

  return [...touched].sort();
}

function isHighRiskFile(projectRoot: string, relativePath: string): boolean {
  const absolutePath = ensureInsideRoot(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return false;

  const ext = absolutePath.slice(absolutePath.lastIndexOf('.')).toLowerCase();
  const basename = absolutePath.slice(absolutePath.lastIndexOf('\\') + 1).toLowerCase();
  const sourceLike = ['.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java', '.cs'].includes(ext);
  if (!sourceLike) return false;

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lineCount = content.split(/\r?\n/).length;
  return lineCount >= 220 || ['main.py', 'app.py', 'server.py', 'index.ts', 'index.tsx'].includes(basename);
}

async function getTrackedHeadFile(projectRoot: string, relativePath: string): Promise<string | null> {
  try {
    const content = await runGitCommand(projectRoot, ['show', `HEAD:${relativePath.replace(/\\/g, '/')}`]);
    return content || '';
  } catch {
    return null;
  }
}

async function collectHighRiskAttemptIssues(
  projectRoot: string,
  filesChanged: string[],
): Promise<string[]> {
  const issues: string[] = [];

  for (const relativePath of filesChanged) {
    if (!isHighRiskFile(projectRoot, relativePath)) continue;

    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (containsCorruptionMarker(content)) {
      issues.push(`High-risk file ${relativePath} still contains a placeholder or corruption marker.`);
      continue;
    }

    if (relativePath.toLowerCase().endsWith('.py')) {
      try {
        await execFileAsync(
          'python',
          [
            '-c',
            [
              'import ast',
              'from pathlib import Path',
              `path = Path(r"""${absolutePath}""")`,
              "ast.parse(path.read_text(encoding='utf-8'))",
            ].join('; '),
          ],
          {
            cwd: projectRoot,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
        );
      } catch (error) {
        const stderr =
          error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
        const detail = stderr || (error instanceof Error ? error.message : String(error));
        issues.push(`High-risk Python file ${relativePath} failed syntax validation: ${detail}`);
      }
    }

    const headVersion = await getTrackedHeadFile(projectRoot, relativePath);
    if (headVersion !== null && headVersion !== '') {
      const currentLines = content.split(/\r?\n/).length;
      const headLines = headVersion.split(/\r?\n/).length;
      if (headLines >= 220 && currentLines <= Math.floor(headLines * 0.55)) {
        issues.push(
          `High-risk file ${relativePath} shrank from about ${headLines} lines to ${currentLines} lines, which looks like an accidental truncation.`,
        );
      }
    }
  }

  return issues;
}

export function buildIssueSignature(issues: string[], summary: string): string {
  const normalized = (issues.length > 0 ? issues : [summary])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return normalized.join(' | ');
}

async function autoCommitApprovedWork(
  projectRoot: string,
  filesChanged: string[],
  commitMessage: string,
  defaultProjectSettings: { autoCommit?: boolean } = {},
): Promise<{ status: 'committed' | 'skipped' | 'failed'; message: string; commitHash?: string }> {
  const projectSettings = loadProjectSettings(projectRoot, defaultProjectSettings);
  if (!projectSettings.autoCommit) {
    return { status: 'skipped', message: 'Project settings disabled auto-commit.' };
  }

  const normalizedFiles = [...new Set(filesChanged.map((filePath) => filePath.trim()).filter(Boolean))];
  if (normalizedFiles.length === 0) {
    return { status: 'skipped', message: 'No changed files were reported for this work.' };
  }

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { status: 'skipped', message: 'Project root is not a git repository.' };
  }

  let targetFiles: string[] = [];
  try {
    targetFiles = normalizedFiles
      .map((filePath) => ensureInsideRoot(projectRoot, filePath))
      .map((absolutePath) => absolutePath.slice(resolve(projectRoot).length).replace(/^[\\/]+/, '').replace(/\\/g, '/'))
      .filter(Boolean);
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (targetFiles.length === 0) {
    return { status: 'skipped', message: 'No project-local files were eligible for auto-commit.' };
  }

  const preStaged = await runGitCommand(projectRoot, ['diff', '--cached', '--name-only']);
  if (preStaged.trim()) {
    return {
      status: 'skipped',
      message: 'Auto-commit was skipped because unrelated staged changes were already present.',
    };
  }

  try {
    await runGitCommand(projectRoot, ['add', '--', ...targetFiles]);
    const staged = await runGitCommand(projectRoot, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      return { status: 'skipped', message: 'There were no stageable changes for the reported files.' };
    }

    await runGitCommand(projectRoot, ['commit', '-m', commitMessage]);
    const commitHash = await runGitCommand(projectRoot, ['rev-parse', '--short', 'HEAD']);
    return {
      status: 'committed',
      message: `Committed the approved changes as ${commitHash}.`,
      commitHash: commitHash || undefined,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function readLockRecord(lockPath: string): AutomationLockRecord | null {
  return readJsonFile<AutomationLockRecord>(lockPath);
}

function isLockStale(lock: AutomationLockRecord): boolean {
  return Date.now() - lock.heartbeatAt >= LOCK_STALE_MS;
}

function writeLockRecord(lockPath: string, record: AutomationLockRecord): void {
  writeJsonFile(lockPath, record);
}

function tryAcquireLock(lockPath: string, record: Omit<AutomationLockRecord, 'acquiredAt' | 'heartbeatAt'>): boolean {
  const now = Date.now();
  const nextRecord: AutomationLockRecord = {
    ...record,
    acquiredAt: now,
    heartbeatAt: now,
  };

  fs.mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(nextRecord), 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code !== 'EEXIST') throw error;

      const existing = readLockRecord(lockPath);
      if (!existing || isLockStale(existing)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          return false;
        }
        continue;
      }
      return false;
    }
  }

  return false;
}

function refreshLock(lockPath: string, ownerId: string): void {
  const existing = readLockRecord(lockPath);
  if (!existing || existing.ownerId !== ownerId) return;
  writeLockRecord(lockPath, {
    ...existing,
    heartbeatAt: Date.now(),
  });
}

function releaseLock(lockPath: string, ownerId: string): void {
  const existing = readLockRecord(lockPath);
  if (!existing || existing.ownerId !== ownerId) return;
  fs.rmSync(lockPath, { force: true });
}

function getProjectKey(workRootDirectory: string | null, work: WorkTask, sessionPath: string): string {
  if (workRootDirectory?.trim() && work.projectName.trim()) {
    return resolve(join(workRootDirectory, work.projectName)).toLowerCase();
  }

  return `${sanitizeSessionPath(sessionPath)}::${work.projectName.toLowerCase()}`;
}

function buildProjectOverview(projectRoot: string): string {
  const topLevelEntries: string[] = [];
  collectFiles(projectRoot, projectRoot, 1, topLevelEntries);

  const snippets: string[] = [];
  for (const candidate of ['README.md', 'README.ko.md', 'package.json', 'requirements.txt', 'main.py']) {
    const absolutePath = join(projectRoot, candidate);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const content = fs.readFileSync(absolutePath, 'utf-8').slice(0, 2400);
    snippets.push(`File: ${candidate}\n${content}`);
  }

  return [
    `Project root: ${projectRoot}`,
    `Top-level tree:\n${topLevelEntries.join('\n') || '(empty)'}`,
    ...snippets,
  ].join('\n\n');
}

async function collectProjectSafetyIssues(projectRoot: string): Promise<string[]> {
  const issues: string[] = [];

  const placeholderHits = searchProjectFiles(projectRoot, 'rest of file unchanged')
    .slice(0, 3)
    .map((hit) => `Corruption marker detected: ${hit}`);
  issues.push(...placeholderHits);

  const pythonEntrypoints = ['main.py', 'app.py', 'server.py']
    .map((fileName) => ({ fileName, absolutePath: join(projectRoot, fileName) }))
    .filter((entry) => fs.existsSync(entry.absolutePath) && fs.statSync(entry.absolutePath).isFile());

  for (const entry of pythonEntrypoints) {
    try {
      await execFileAsync(
        'python',
        [
          '-c',
          [
            'import ast',
            'from pathlib import Path',
            `path = Path(r"""${entry.absolutePath}""")`,
            "ast.parse(path.read_text(encoding='utf-8'))",
          ].join('; '),
        ],
        {
          cwd: projectRoot,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      issues.push(`Python AST syntax check failed for ${entry.fileName}: ${detail}`);
      break;
    }
  }

  return issues;
}

function loadProjectDiscoveryAnalysis(
  sessionsDir: string,
  sessionPath: string,
  projectName: string,
): ProjectDiscoveryAnalysis | null {
  return readJsonFile<ProjectDiscoveryAnalysis>(
    getProjectDiscoveryFilePath(sessionsDir, sessionPath, projectName),
  );
}

function saveProjectDiscoveryAnalysis(
  sessionsDir: string,
  sessionPath: string,
  analysis: ProjectDiscoveryAnalysis,
): void {
  writeJsonFile(
    getProjectDiscoveryFilePath(sessionsDir, sessionPath, analysis.projectName),
    analysis,
  );
}

function buildProjectDiscoveryPrompt(
  projectName: string,
  projectOverview: string,
  previousAnalysis: ProjectDiscoveryAnalysis | null,
): string {
  return [
    `Project: ${projectName}`,
    `Project overview:\n${projectOverview}`,
    previousAnalysis
      ? [
          `Previous discovery summary:\n${previousAnalysis.summary}`,
          `Previous findings:\n${previousAnalysis.findings
            .map((finding) => `- [${finding.kind}] ${finding.title}: ${finding.summary}`)
            .join('\n')}`,
        ].join('\n\n')
      : '',
    `Inspect the current source code and identify up to ${MAX_DISCOVERY_FINDINGS} valuable next tasks.`,
    `Tasks may be either new feature opportunities or bug fixes.`,
    `Prefer concrete, implementation-sized work items that a coding agent can pick up directly.`,
    `Avoid duplicate findings. If a previous finding still matters, refresh it instead of duplicating it with a new title.`,
    `Return only JSON with this shape:`,
    `{"summary":"string","findings":[{"id":"string","kind":"feature|bug","title":"string","summary":"string","evidence":["..."],"files":["..."],"taskDescription":"markdown brief"}]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildProjectDiscoverySystemPrompt(): string {
  return [
    'You are Aoi, the main Kira project analyst.',
    'Inspect the project in read-only mode and decide what should be built or fixed next.',
    'Favor concrete, high-signal findings over generic product advice.',
    'Base every finding on the current source code.',
    'Do not modify files.',
    'Do not wrap the final JSON in markdown fences.',
  ].join('\n');
}

function buildWorkerPrompt(work: WorkTask, projectOverview: string, feedback: string[]): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description}`,
    `Project overview:\n${projectOverview}`,
    feedback.length > 0
      ? `Review feedback to address:\n${feedback.map((item) => `- ${item}`).join('\n')}`
      : '',
    'Modify the project directly using the available tools.',
    'Any file under the project root may be edited when it helps complete the task.',
    'For existing files, prefer edit_file with exact replacements.',
    'Use write_file only for new files or for small files that genuinely need a full rewrite.',
    'Do not treat other existing modified or untracked files in the project as something you must clean up unless the task explicitly asks for cleanup.',
    'When you report filesChanged, list the files you intentionally touched for this attempt, not unrelated pre-existing worktree noise.',
    'Run relevant tests or checks when practical.',
    'When finished, return only JSON with this shape:',
    '{"summary":"string","filesChanged":["..."],"testsRun":["..."],"remainingRisks":["..."]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildWorkerSystemPrompt(): string {
  return [
    'You are a background Kira implementation agent.',
    'Stay focused on the requested work item.',
    'Prefer small targeted edits over broad refactors.',
    'You may edit any project-local file that is useful for the requested outcome.',
    'Prefer edit_file for modifying existing files, especially large or critical ones.',
    'Do not try to clean unrelated dirty-worktree files unless the work item explicitly requires it.',
    'Use write_file only when creating a new file or replacing a genuinely small file.',
    'Use run_command for safe checks only.',
    'Do not mention markdown fences in your final answer.',
  ].join('\n');
}

function buildReviewPrompt(
  work: WorkTask,
  projectOverview: string,
  workerSummary: WorkerSummary,
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Acceptance target:\n${work.description}`,
    `Project overview:\n${projectOverview}`,
    `Latest worker summary:\n${workerSummary.summary}`,
    `Files reported changed:\n${formatList(workerSummary.filesChanged, 'No files reported')}`,
    `Checks reported:\n${formatList(workerSummary.testsRun, 'No checks reported')}`,
    'Review the current project state. Do not modify files.',
    'Any file under the project root is allowed to change if it supports the requested outcome.',
    'Do NOT reject only because multiple project-local files changed, because the worker touched a file you did not expect, or because the git working tree already contains unrelated modified/untracked files.',
    'Do NOT enforce minimal-diff purity as a standalone requirement.',
    'Approve when the requested outcome is achieved and there is no clear regression or harmful side effect.',
    'Only request changes when the acceptance target is not met, the implementation is clearly risky, or there is a concrete user-facing/code-level regression.',
    'Return only JSON with this shape:',
    '{"approved":true,"summary":"string","issues":["..."],"filesChecked":["..."]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildReviewSystemPrompt(): string {
  return [
    'You are the Kira main reviewer.',
    'Review the implementation carefully against the requested result and real regressions.',
    'Do not fail a review only for scope broadness, extra project-local file edits, or unrelated pre-existing dirty-worktree files.',
    'Never edit files.',
    'Use read-only tools and safe commands only.',
  ].join('\n');
}

function updateWork(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  updater: (current: WorkTask) => WorkTask,
): WorkTask | null {
  const workPath = join(getKiraDataDir(sessionsDir, sessionPath), WORKS_DIR_NAME, `${workId}.json`);
  const current = readJsonFile<WorkTask>(workPath);
  if (!current) return null;
  const next = updater(current);
  writeJsonFile(workPath, { ...next, updatedAt: Date.now() });
  return { ...next, updatedAt: Date.now() };
}

function addComment(
  sessionsDir: string,
  sessionPath: string,
  payload: Omit<TaskComment, 'id' | 'createdAt'> & { body: string },
): TaskComment {
  const comment: TaskComment = {
    id: makeId('comment'),
    createdAt: Date.now(),
    ...payload,
  };
  const commentsDir = join(getKiraDataDir(sessionsDir, sessionPath), COMMENTS_DIR_NAME);
  fs.mkdirSync(commentsDir, { recursive: true });
  writeJsonFile(join(commentsDir, `${comment.id}.json`), comment);
  return comment;
}

function loadTaskComments(
  sessionsDir: string,
  sessionPath: string,
  taskId: string,
): TaskComment[] {
  const commentsDir = join(getKiraDataDir(sessionsDir, sessionPath), COMMENTS_DIR_NAME);
  return listJsonFiles(commentsDir)
    .map((filePath) => readJsonFile<TaskComment>(filePath))
    .filter((comment): comment is TaskComment => comment !== null && comment.taskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function ensureSuggestedCommitMessageComment(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  work: WorkTask,
): void {
  if (work.status !== 'done') return;

  const lockPath = getWorkLockPath(options.sessionsDir, sessionPath, work.id);
  const lockAcquired = tryAcquireLock(lockPath, {
    ownerId: SERVER_INSTANCE_ID,
    resource: 'work',
    sessionPath,
    targetKey: work.id,
  });
  if (!lockAcquired) return;

  try {
    const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
    const refreshedWork = readJsonFile<WorkTask>(
      join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME, `${work.id}.json`),
    );
    if (!refreshedWork || refreshedWork.status !== 'done') return;

    const comments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
    const workerSummary = findSuggestedCommitBackfillSummary(comments);
    if (!workerSummary) return;

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: `Suggested commit message:\n${buildSuggestedCommitMessage(refreshedWork, workerSummary)}`,
    });
  } finally {
    releaseLock(lockPath, SERVER_INSTANCE_ID);
  }
}

function extractLatestReviewerFeedback(comments: TaskComment[]): string[] {
  const latestReviewComment = [...comments]
    .reverse()
    .find((comment) => isReviewerAuthor(comment.author) && comment.body.includes('Issues:'));

  if (!latestReviewComment) return [];
  const issuesSection = latestReviewComment.body.split('Issues:\n')[1] ?? '';
  return issuesSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function sendSseEvent(
  res: { write: (chunk: string) => unknown },
  data: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function loadProjectWorks(
  sessionsDir: string,
  sessionPath: string,
  projectName: string,
): WorkTask[] {
  const worksDir = join(getKiraDataDir(sessionsDir, sessionPath), WORKS_DIR_NAME);
  return listJsonFiles(worksDir)
    .map((filePath) => readJsonFile<WorkTask>(filePath))
    .filter((work): work is WorkTask => work !== null && work.projectName === projectName);
}

async function analyzeProjectForDiscovery(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  projectName: string,
  res: { write: (chunk: string) => unknown },
): Promise<ProjectDiscoveryAnalysis> {
  sendSseEvent(res, { type: 'log', message: `Preparing discovery run for ${projectName}...` });

  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  if (!runtime.reviewerConfig) {
    throw new Error('No usable LLM config was found in config.json.');
  }

  const projectRoot = runtime.workRootDirectory ? join(runtime.workRootDirectory, projectName) : '';
  if (!runtime.workRootDirectory || !projectName || !fs.existsSync(projectRoot)) {
    throw new Error(`Project root was not found for ${projectName}.`);
  }

  const previousAnalysis = loadProjectDiscoveryAnalysis(options.sessionsDir, sessionPath, projectName);
  if (previousAnalysis) {
    sendSseEvent(res, {
      type: 'log',
      message: `Loaded previous analysis from ${new Date(previousAnalysis.updatedAt).toLocaleString()}.`,
    });
  } else {
    sendSseEvent(res, { type: 'log', message: 'No previous saved analysis found for this project.' });
  }

  sendSseEvent(res, { type: 'log', message: 'Scanning the project overview and source map...' });
  const projectOverview = buildProjectOverview(projectRoot);

  sendSseEvent(res, { type: 'log', message: 'Aoi is reviewing the codebase and collecting candidate tasks...' });
  const raw = await runToolAgent(
    runtime.reviewerConfig,
    projectRoot,
    buildProjectDiscoveryPrompt(projectName, projectOverview, previousAnalysis),
    buildProjectDiscoverySystemPrompt(),
    false,
  );

  sendSseEvent(res, { type: 'log', message: 'Normalizing the findings and saving them for later reuse...' });
  const analysis = parseProjectDiscoveryAnalysis(raw, projectName, projectRoot, previousAnalysis);
  saveProjectDiscoveryAnalysis(options.sessionsDir, sessionPath, analysis);

  sendSseEvent(res, {
    type: 'log',
    message:
      analysis.findings.length > 0
        ? `Discovery complete. Found ${analysis.findings.length} candidate tasks.`
        : 'Discovery complete, but no actionable tasks were identified.',
  });

  return analysis;
}

function createWorksFromDiscovery(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  analysis: ProjectDiscoveryAnalysis,
): { created: WorkTask[]; skippedTitles: string[] } {
  const worksDir = join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME);
  fs.mkdirSync(worksDir, { recursive: true });

  const existingTitles = new Set(
    loadProjectWorks(options.sessionsDir, sessionPath, analysis.projectName).map((work) =>
      work.title.trim().toLowerCase(),
    ),
  );

  const created: WorkTask[] = [];
  const skippedTitles: string[] = [];

  for (const finding of analysis.findings.slice(0, MAX_DISCOVERY_FINDINGS)) {
    const normalizedTitle = finding.title.trim().toLowerCase();
    if (!normalizedTitle || existingTitles.has(normalizedTitle)) {
      skippedTitles.push(finding.title);
      continue;
    }

    const now = Date.now();
    const work: WorkTask = {
      id: makeId('work'),
      type: 'work',
      projectName: analysis.projectName,
      title: finding.title.trim(),
      description: finding.taskDescription.trim() || buildFallbackTaskDescription(finding),
      status: 'todo',
      assignee: '',
      createdAt: now,
      updatedAt: now,
    };
    writeJsonFile(join(worksDir, `${work.id}.json`), work);
    created.push(work);
    existingTitles.add(normalizedTitle);
  }

  return { created, skippedTitles };
}

async function processWork(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  workId: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  const dataDir = getKiraDataDir(options.sessionsDir, sessionPath);
  const work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
  if (!work || (work.status !== 'todo' && work.status !== 'in_progress')) return;

  if (!runtime.workerConfig || !runtime.reviewerConfig) {
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: 'Automation could not start because no usable LLM config was found in config.json.',
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 자동화 보류: "${work.title}" 작업을 처리할 LLM 설정이 없어요.`,
    });
    return;
  }

  const projectRoot = runtime.workRootDirectory ? join(runtime.workRootDirectory, work.projectName) : '';
  if (!runtime.workRootDirectory || !work.projectName || !fs.existsSync(projectRoot)) {
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: 'Automation could not start because the project root directory for this work was not found.',
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 자동화 보류: "${work.title}" 작업의 프로젝트 루트를 찾지 못했어요.`,
    });
    return;
  }

  const safetyIssues = await collectProjectSafetyIssues(projectRoot);
  if (safetyIssues.length > 0) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
      assignee: current.assignee || runtime.workerAuthor,
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked before start due to project safety checks.',
        '',
        `Issues:\n${formatList(safetyIssues, 'No details provided')}`,
        '',
        'Please restore the project to a healthy state before retrying this work.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업을 시작하기 전에 프로젝트 손상 징후가 발견됐어요.`,
    });
    return;
  }

  const projectOverview = buildProjectOverview(projectRoot);
  const existingComments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
  const resumeFeedback = work.status === 'in_progress' ? extractLatestReviewerFeedback(existingComments) : [];

  throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);

  updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
    ...current,
    status: 'in_progress',
    assignee: current.assignee || runtime.workerAuthor,
  }));
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: work.status === 'in_progress' ? 'resumed' : 'started',
    createdAt: Date.now(),
    message:
      work.status === 'in_progress'
        ? `Kira 재개: "${work.title}" 작업을 다시 이어서 진행할게요.`
        : `Kira 시작: "${work.title}" 작업을 자동으로 시작할게요.`,
  });
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.workerAuthor,
    body:
      work.status === 'in_progress'
        ? `Detected a stalled task and resumed implementation in ${work.projectName}.`
        : `Picked up the task and started implementation in ${work.projectName}.`,
  });

  let feedback: string[] = resumeFeedback;
  let previousIssueSignature: string | null = null;
  let repeatedIssueCount = 0;
  for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
    const worktreeBefore = await getGitWorktreeEntries(projectRoot);
    const workerRaw = await runToolAgent(
      runtime.workerConfig,
      projectRoot,
      buildWorkerPrompt(work, projectOverview, feedback),
      buildWorkerSystemPrompt(),
      true,
      signal,
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const parsedWorkerSummary = parseWorkerSummary(workerRaw);
    const worktreeAfter = await getGitWorktreeEntries(projectRoot);
    const touchedFiles = detectTouchedFilesFromGitStatus(worktreeBefore, worktreeAfter);
    const resolvedFilesChanged = touchedFiles.length > 0 ? touchedFiles : parsedWorkerSummary.filesChanged;
    const workerSummary: WorkerSummary = {
      ...parsedWorkerSummary,
      filesChanged: resolvedFilesChanged,
    };

    const highRiskIssues = await collectHighRiskAttemptIssues(projectRoot, workerSummary.filesChanged);

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.workerAuthor,
      body: [
        `Attempt ${cycle} finished.`,
        '',
        `Summary:\n${workerSummary.summary}`,
        '',
        `Files changed:\n${formatList(workerSummary.filesChanged, 'No files reported')}`,
        '',
        `Checks:\n${formatList(workerSummary.testsRun, 'No checks reported')}`,
        '',
        `Remaining risks:\n${formatList(
          [...workerSummary.remainingRisks, ...highRiskIssues],
          'None reported',
        )}`,
      ].join('\n'),
    });

    if (highRiskIssues.length > 0) {
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'blocked',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Blocked after automated safety validation failed on attempt ${cycle}.`,
          '',
          `Issues:\n${formatList(highRiskIssues, 'No detailed issues provided')}`,
          '',
          'A high-risk file changed in a way that looks unsafe, so Kira stopped instead of retrying.',
        ].join('\n'),
      });
      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'needs_attention',
        createdAt: Date.now(),
        message: `Kira blocked: "${work.title}" 작업이 고위험 파일 안전 검증에 걸려 중단됐어요.`,
      });
      return;
    }

    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'in_review',
    }));

    const reviewRaw = await runToolAgent(
      runtime.reviewerConfig,
      projectRoot,
      buildReviewPrompt(work, projectOverview, workerSummary),
      buildReviewSystemPrompt(),
      false,
      signal,
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const reviewSummary = parseReviewSummary(reviewRaw);

    if (reviewSummary.approved) {
      const suggestedCommitMessage = buildSuggestedCommitMessage(work, workerSummary);
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'done',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Approved.\n\n${reviewSummary.summary}`,
      });
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Suggested commit message:\n${suggestedCommitMessage}`,
      });

      const autoCommitResult = await autoCommitApprovedWork(
        projectRoot,
        workerSummary.filesChanged,
        suggestedCommitMessage,
        runtime.defaultProjectSettings,
      );
      if (autoCommitResult.status === 'committed') {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Committed changes.\n\n${autoCommitResult.message}\n\nCommit message:\n${suggestedCommitMessage}`,
        });
      } else if (autoCommitResult.status === 'failed') {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Auto-commit failed.\n\n${autoCommitResult.message}`,
        });
      } else if (autoCommitResult.message) {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Auto-commit skipped.\n\n${autoCommitResult.message}`,
        });
      }

      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'completed',
        createdAt: Date.now(),
        message: `Kira 완료: "${work.title}" 작업이 끝났어요.`,
      });
      return;
    }

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Review requested changes after attempt ${cycle}.`,
        '',
        `Summary:\n${reviewSummary.summary}`,
        '',
        `Issues:\n${formatList(reviewSummary.issues, 'No detailed issues provided')}`,
      ].join('\n'),
    });

    feedback = reviewSummary.issues.length > 0 ? reviewSummary.issues : [reviewSummary.summary];
    const issueSignature = buildIssueSignature(reviewSummary.issues, reviewSummary.summary);
    if (issueSignature === previousIssueSignature) {
      repeatedIssueCount += 1;
    } else {
      repeatedIssueCount = 1;
      previousIssueSignature = issueSignature;
    }

    if (repeatedIssueCount >= 2) {
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'blocked',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Blocked early because the same review issues repeated without progress after attempt ${cycle}.`,
          '',
          `Issues:\n${formatList(reviewSummary.issues, reviewSummary.summary)}`,
          '',
          'Kira stopped retrying because the worker was not making progress against the same review feedback.',
        ].join('\n'),
      });
      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'needs_attention',
        createdAt: Date.now(),
        message: `Kira blocked: "${work.title}" 작업이 같은 반려 사유를 반복해서 더 이상 자동 재시도하지 않을게요.`,
      });
      return;
    }

    if (cycle < MAX_REVIEW_CYCLES) {
      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'in_progress',
      }));
    }
  }

  updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
    ...current,
    status: 'blocked',
  }));
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.reviewerAuthor,
    body: [
      `Blocked after ${MAX_REVIEW_CYCLES} review attempts.`,
      '',
      `Summary:\n${feedback[0] ?? 'The work could not satisfy the review requirements within the allowed retries.'}`,
      '',
      'Please revise the work brief or resolve the review issues before restarting this task.',
    ].join('\n'),
  });
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: 'needs_attention',
    createdAt: Date.now(),
    message: `Kira blocked: "${work.title}" 작업이 ${MAX_REVIEW_CYCLES}회 리뷰 후에도 통과하지 못해 Blocked 상태로 전환됐어요.`,
  });
}

function startWorkJob(options: KiraAutomationPluginOptions, sessionPath: string, workId: string): void {
  const jobKey = `${sessionPath}::${workId}`;
  if (activeJobs.has(jobKey)) return;

  const dataDir = getKiraDataDir(options.sessionsDir, sessionPath);
  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  const work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
  if (!work?.projectName) return;
  const workLockPath = getWorkLockPath(options.sessionsDir, sessionPath, workId);
  const workLockAcquired = tryAcquireLock(workLockPath, {
    ownerId: SERVER_INSTANCE_ID,
    resource: 'work',
    sessionPath,
    targetKey: workId,
  });
  if (!workLockAcquired) return;

  const projectKey = getProjectKey(options.getWorkRootDirectory(), work, sessionPath);
  const projectLockPath = getProjectLockPath(options.sessionsDir, projectKey);
  if (activeProjectJobs.has(projectKey) || !tryAcquireLock(projectLockPath, {
    ownerId: SERVER_INSTANCE_ID,
    resource: 'project',
    sessionPath,
    targetKey: projectKey,
  })) {
    const comments = loadTaskComments(options.sessionsDir, sessionPath, workId);
    const alreadyQueued = comments.some(
      (comment) =>
        isReviewerAuthor(comment.author) &&
        comment.body.startsWith('Queued: waiting for another work in the same project to finish.'),
    );
    if (!alreadyQueued) {
      addComment(options.sessionsDir, sessionPath, {
        taskId: workId,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: 'Queued: waiting for another work in the same project to finish.',
      });
    }
    releaseLock(workLockPath, SERVER_INSTANCE_ID);
    return;
  }

  activeJobs.add(jobKey);
  activeProjectJobs.add(projectKey);
  const controller = new AbortController();
  jobAbortControllers.set(jobKey, controller);
  const heartbeat = setInterval(() => {
    refreshLock(workLockPath, SERVER_INSTANCE_ID);
    refreshLock(projectLockPath, SERVER_INSTANCE_ID);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  void processWork(options, sessionPath, workId, controller.signal)
    .catch((error) => {
      if (isAbortError(error)) return;
      const work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
      if (work) {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Automation failed unexpectedly.\n\n${error instanceof Error ? error.message : String(error)}`,
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira 자동화 오류: "${work.title}" 작업 처리 중 문제가 생겼어요.`,
        });
      }
    })
    .finally(() => {
      clearInterval(heartbeat);
      activeJobs.delete(jobKey);
      activeProjectJobs.delete(projectKey);
      jobAbortControllers.delete(jobKey);
      releaseLock(workLockPath, SERVER_INSTANCE_ID);
      releaseLock(projectLockPath, SERVER_INSTANCE_ID);
    });
}

function scanTodoWorks(options: KiraAutomationPluginOptions, sessionPath: string): void {
  const worksDir = join(getKiraDataDir(options.sessionsDir, sessionPath), WORKS_DIR_NAME);
  for (const filePath of listJsonFiles(worksDir)) {
    const work = readJsonFile<WorkTask>(filePath);
    if (!work) continue;
    if (work.status === 'done') {
      ensureSuggestedCommitMessageComment(options, sessionPath, work);
      continue;
    }
    if (work.status === 'todo') {
      startWorkJob(options, sessionPath, work.id);
      continue;
    }
    if (work.status === 'in_progress' && Date.now() - work.updatedAt >= STALLED_WORK_MS) {
      startWorkJob(options, sessionPath, work.id);
    }
  }
}

function scanActionableWorks(options: KiraAutomationPluginOptions, sessionPath: string): void {
  try {
    scanTodoWorks(options, sessionPath);
  } catch (error) {
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: '',
      title: 'Kira automation scan',
      projectName: '',
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira 자동 스캔 오류: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function scanAllSessions(options: KiraAutomationPluginOptions): void {
  for (const sessionPath of discoverSessionPaths(options.sessionsDir)) {
    scanActionableWorks(options, sessionPath);
  }
}

export function kiraAutomationPlugin(options: KiraAutomationPluginOptions): Plugin {
  return {
    name: 'kira-automation',
    configureServer(server) {
      queueMicrotask(() => {
        scanAllSessions(options);
      });
      const timer = setInterval(() => {
        scanAllSessions(options);
      }, GLOBAL_SCAN_INTERVAL_MS);
      timer.unref?.();

      const readRequestBody = (
        req: NodeJS.ReadableStream & { on: (event: string, listener: (chunk?: Buffer) => void) => void },
        onParsed: (body: Record<string, unknown>) => void | Promise<void>,
        onError: (error: unknown) => void,
      ) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
            void onParsed(body);
          } catch (error) {
            onError(error);
          }
        });
      };

      server.middlewares.use('/api/kira-discovery/analyze', (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        readRequestBody(
          req,
          async (body) => {
            try {
              const sessionPath = typeof body.sessionPath === 'string' ? body.sessionPath.trim() : '';
              const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!sessionPath || !projectName) {
                throw new Error('Missing sessionPath or projectName.');
              }

              const analysis = await analyzeProjectForDiscovery(options, sessionPath, projectName, res);
              sendSseEvent(res, {
                type: 'analysis_complete',
                analysis,
                message: `Aoi found ${analysis.findings.length} candidate tasks for ${projectName}.`,
              });
              sendSseEvent(res, { type: 'done' });
              res.end();
            } catch (error) {
              sendSseEvent(res, {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
              });
              sendSseEvent(res, { type: 'done' });
              res.end();
            }
          },
          (error) => {
            sendSseEvent(res, {
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
            sendSseEvent(res, { type: 'done' });
            res.end();
          },
        );
      });

      server.middlewares.use('/api/kira-discovery/existing', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const sessionPath = url.searchParams.get('sessionPath')?.trim();
          const projectName = url.searchParams.get('projectName')?.trim();
          if (!sessionPath || !projectName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing sessionPath or projectName' }));
            return;
          }

          const analysis = loadProjectDiscoveryAnalysis(options.sessionsDir, sessionPath, projectName);
          res.writeHead(200);
          res.end(JSON.stringify({ analysis: analysis ?? null }));
        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });

      server.middlewares.use('/api/kira-discovery/create-tasks', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        readRequestBody(
          req,
          async (body) => {
            try {
              const sessionPath = typeof body.sessionPath === 'string' ? body.sessionPath.trim() : '';
              const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!sessionPath || !projectName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing sessionPath or projectName' }));
                return;
              }

              const analysis = loadProjectDiscoveryAnalysis(options.sessionsDir, sessionPath, projectName);
              if (!analysis) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'No saved discovery analysis found for this project' }));
                return;
              }

              const { created, skippedTitles } = createWorksFromDiscovery(options, sessionPath, analysis);
              scanActionableWorks(options, sessionPath);
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  createdCount: created.length,
                  skippedCount: skippedTitles.length,
                  createdWorks: created,
                  skippedTitles,
                }),
              );
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
          },
          (error) => {
            res.writeHead(400);
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          },
        );
      });

      server.middlewares.use('/api/kira-automation/scan', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
              sessionPath?: string;
            };
            const sessionPath = body.sessionPath?.trim();
            if (!sessionPath) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing sessionPath' }));
              return;
            }
            scanActionableWorks(options, sessionPath);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });

      server.middlewares.use('/api/kira-automation/cancel', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
              sessionPath?: string;
              workId?: string;
            };
            const sessionPath = body.sessionPath?.trim();
            const workId = body.workId?.trim();
            if (!sessionPath || !workId) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing sessionPath or workId' }));
              return;
            }

            const jobKey = `${sessionPath}::${workId}`;
            const controller = jobAbortControllers.get(jobKey);
            controller?.abort();
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, wasRunning: Boolean(controller) }));
          } catch (error) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      });

      server.middlewares.use('/api/kira-automation/events', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const sessionPath = url.searchParams.get('sessionPath')?.trim();
          if (!sessionPath) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing sessionPath' }));
            return;
          }
          const events = drainEvents(options.sessionsDir, sessionPath);
          res.writeHead(200);
          res.end(JSON.stringify({ events }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
