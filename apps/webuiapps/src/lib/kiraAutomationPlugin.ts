import * as fs from 'fs';
import { exec as execCallback, execFile as execFileCallback, spawn } from 'child_process';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { basename, dirname, join, resolve } from 'path';
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
  | 'openrouter'
  | 'opencode'
  | 'opencode-go'
  | 'codex-cli';

type LLMApiStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

type KiraTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
type WorkClarificationStatus = 'pending' | 'answered' | 'cleared';

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders?: string;
  command?: string;
  apiStyle?: LLMApiStyle;
  name?: string;
}

interface KiraSettings {
  workRootDirectory?: string;
  workerModel?: string;
  reviewerModel?: string;
  workers?: Array<Partial<LLMConfig>>;
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
  clarification?: WorkClarificationState;
  createdAt: number;
  updatedAt: number;
}

interface WorkClarificationQuestion {
  id: string;
  question: string;
  options: string[];
  allowCustomAnswer: boolean;
}

interface WorkClarificationAnswer {
  questionId: string;
  question: string;
  answer: string;
}

interface WorkClarificationState {
  status: WorkClarificationStatus;
  briefHash: string;
  summary: string;
  questions: WorkClarificationQuestion[];
  answers?: WorkClarificationAnswer[];
  createdAt: number;
  answeredAt?: number;
}

interface WorkClarificationAnalysis {
  needsClarification: boolean;
  confidence: number;
  summary: string;
  questions: WorkClarificationQuestion[];
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

interface WorkerExecutionPlan {
  valid: boolean;
  parseIssues: string[];
  understanding: string;
  repoFindings: string[];
  summary: string;
  intendedFiles: string[];
  protectedFiles: string[];
  validationCommands: string[];
  riskNotes: string[];
  stopConditions: string[];
}

interface ProjectContextScan {
  projectRoot: string;
  packageManager: string | null;
  workspaceFiles: string[];
  packageScripts: string[];
  existingChanges: string[];
  searchTerms: string[];
  likelyFiles: string[];
  relatedDocs: string[];
  testFiles: string[];
  candidateChecks: string[];
  notes: string[];
}

interface ReviewSummary {
  approved: boolean;
  summary: string;
  issues: string[];
  filesChecked: string[];
  findings: ReviewFinding[];
  missingValidation: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
}

interface ReviewFinding {
  file: string;
  line: number | null;
  severity: 'low' | 'medium' | 'high';
  message: string;
}

interface KiraAttemptRecord {
  id: string;
  workId: string;
  attemptNo: number;
  status:
    | 'planned'
    | 'needs_context'
    | 'validation_failed'
    | 'review_requested_changes'
    | 'blocked'
    | 'approved';
  startedAt: number;
  finishedAt: number;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  preflightExploration: string[];
  readFiles: string[];
  patchedFiles: string[];
  changedFiles: string[];
  commandsRun: string[];
  validationReruns: ValidationRerunSummary;
  outOfPlanFiles: string[];
  validationGaps: string[];
  risks: string[];
  diffExcerpts?: string[];
  rawWorkerOutput?: string;
  blockedReason?: string;
  rollbackFiles?: string[];
}

interface KiraReviewRecord {
  id: string;
  workId: string;
  attemptNo: number;
  approved: boolean;
  createdAt: number;
  summary: string;
  findings: ReviewFinding[];
  missingValidation: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
  filesChecked: string[];
}

interface ValidationRerunSummary {
  passed: string[];
  failed: string[];
  failureDetails: string[];
}

interface ResolvedValidationPlan {
  plannerCommands: string[];
  autoAddedCommands: string[];
  effectiveCommands: string[];
  notes: string[];
}

interface AutomationFailureResolution {
  summary: string;
  guidance: string;
  userMessage: string;
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

interface KiraWorkspaceSession {
  primaryRoot: string;
  projectRoot: string;
  isolated: boolean;
  worktreePath?: string;
  branchName?: string;
}

interface KiraWorkerLane {
  id: string;
  label: string;
  config: LLMConfig;
}

interface KiraWorkerAttemptResult {
  lane: KiraWorkerLane;
  workspace: KiraWorkspaceSession;
  attemptNo: number;
  cycle: number;
  startedAt: number;
  projectOverview: string;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  planningState: WorkerAttemptState;
  attemptState: WorkerAttemptState | null;
  workerSummary: WorkerSummary;
  validationPlan: ResolvedValidationPlan;
  validationReruns: ValidationRerunSummary;
  outOfPlanFiles: string[];
  missingValidationCommands: string[];
  highRiskIssues: string[];
  diffExcerpts: string[];
  rawWorkerOutput?: string;
  status: 'needs_context' | 'validation_failed' | 'blocked' | 'reviewable' | 'failed';
  feedback: string[];
  blockedReason?: string;
}

interface AttemptSelectionSummary {
  approved: boolean;
  selectedAttemptNo: number | null;
  summary: string;
  issues: string[];
  nextWorkerInstructions: string[];
  residualRisk: string[];
  filesChecked: string[];
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

interface AttemptFileSnapshot {
  existed: boolean;
  content: string | null;
}

interface WorkerAttemptState {
  plan: WorkerExecutionPlan | null;
  fileSnapshots: Map<string, AttemptFileSnapshot>;
  commandsRun: string[];
  readFiles: Set<string>;
  explorationActions: string[];
  patchedFiles: Set<string>;
  dirtyFiles: Set<string>;
}

type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoningContent?: string }
  | { role: 'tool'; content: string; toolCallId: string };
type ToolAgentFinalValidator = (content: string) => string[];

const KIMI_TOOL_CALL_REASONING_FALLBACK =
  'Kira is continuing a tool-call turn where the provider did not return reasoning_content.';
const AGENT_TURN_BUDGET_EXHAUSTED_PROMPT = [
  'The Kira tool-turn budget for this step is exhausted.',
  'Do not call any more tools.',
  'Return the final answer now in exactly the structured JSON shape requested by the original Kira prompt.',
  'Base the answer only on the tool results already available in this conversation.',
].join(' ');
const COMMENTS_DIR_NAME = 'comments';
const WORKS_DIR_NAME = 'works';
const ANALYSIS_DIR_NAME = 'analysis';
const ATTEMPTS_DIR_NAME = 'attempts';
const REVIEWS_DIR_NAME = 'reviews';
const WORKTREES_DIR_NAME = 'worktrees';
const PROJECT_SETTINGS_DIR_NAME = '.kira';
const PROJECT_SETTINGS_FILE_NAME = 'project-settings.json';
const MAX_REVIEW_CYCLES = 5;
const MAX_DISCOVERY_FINDINGS = 10;
const MAX_CLARIFICATION_QUESTIONS = 3;
const MAX_CLARIFICATION_OPTIONS = 4;
const MAX_AGENT_TURNS = 24;
const MAX_AGENT_REPAIR_TURNS = 2;
const MAX_AGENT_TIMEOUT_RETRIES = 1;
const MAX_FILE_BYTES = 80_000;
const MAX_OVERWRITE_FILE_BYTES = 8_000;
const MAX_FULL_REWRITE_FILE_BYTES = MAX_FILE_BYTES;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const MAX_PLANNED_FILES = 12;
const MAX_PLANNER_VALIDATION_COMMANDS = 4;
const MAX_DEFAULT_VALIDATION_COMMANDS = 2;
const MAX_EFFECTIVE_VALIDATION_COMMANDS = 6;
const MAX_REVIEW_DIFF_CHARS = 2_400;
const COMMAND_TIMEOUT_MS = 90_000;
const LLM_REQUEST_TIMEOUT_MS = 240_000;
const EXTERNAL_AGENT_TIMEOUT_MS = 10 * 60_000;
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
const CODEX_CLI_FALLBACK_MODEL = 'gpt-5.3-codex';
const KIRA_PROJECT_ROOT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'settings.gradle',
  'deno.json',
];
const SAFE_COMMAND_PATTERNS = [
  /^python\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b/i,
  /^py\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b/i,
  /^pytest(?:\s|$)/i,
  /^uv\s+run\s+(?:pytest(?:\s|$)|python\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b|py\s+-m\s+(?:pytest|unittest|compileall|py_compile|ruff|mypy)\b|ruff\b|mypy\b)/i,
  /^npm\s+(?:test(?:\s|$)|run\s+(?:test|lint|build|check|typecheck)\b)/i,
  /^pnpm\s+(?:(?:run\s+)?(?:test|lint|build|check|typecheck)\b|exec\s+(?:vitest|jest|eslint|tsc|tsx|vite)\b)/i,
  /^node\s+--test\b/i,
  /^git\s+(status|diff|show|rev-parse|branch|log)\b/i,
  /^rg(?:\s|$)/i,
  /^go\s+(?:test|vet)\b/i,
  /^cargo\s+(?:test|check|clippy|fmt)\b/i,
  /^dotnet\s+(?:test|build)\b/i,
];
const DANGEROUS_COMMAND_PATTERNS = [
  /\b(?:rm|del|rmdir|erase|format|shutdown)\b/i,
  /\b(?:remove-item|move-item|rename-item|copy-item)\b/i,
  /\b(?:invoke-expression|iex|start-process|curl|wget|invoke-webrequest)\b/i,
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

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeCommandForComparison(command: string): string {
  return normalizeWhitespace(command).toLowerCase();
}

function normalizePathList(values: unknown[], limit: number): string[] {
  return uniqueStrings(
    values.map((value) => normalizeRelativePath(String(value))).filter((value) => value !== ''),
  ).slice(0, limit);
}

function formatShellPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return /^[a-zA-Z0-9_./:@+-]+$/.test(normalized)
    ? normalized
    : `'${normalized.replace(/'/g, "''")}'`;
}

function formatIgnoredIntegrationPaths(ignoredFiles: string[]): string {
  return ignoredFiles.length > 0
    ? ` Ignored non-stageable reported paths: ${ignoredFiles.join(', ')}.`
    : '';
}

function createWorkerAttemptState(
  plan: WorkerExecutionPlan | null,
  dirtyFiles: string[] = [],
): WorkerAttemptState {
  return {
    plan,
    fileSnapshots: new Map(),
    commandsRun: [],
    readFiles: new Set(),
    explorationActions: [],
    patchedFiles: new Set(),
    dirtyFiles: new Set(dirtyFiles.map((file) => normalizeRelativePath(file)).filter(Boolean)),
  };
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

function getKiraAttemptsDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), ATTEMPTS_DIR_NAME);
}

function getKiraReviewsDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), REVIEWS_DIR_NAME);
}

function getKiraWorktreesDir(sessionsDir: string, sessionPath: string): string {
  return join(getKiraDataDir(sessionsDir, sessionPath), WORKTREES_DIR_NAME);
}

function isKiraProjectRoot(directory: string): boolean {
  try {
    return KIRA_PROJECT_ROOT_MARKERS.some((marker) => fs.existsSync(join(directory, marker)));
  } catch {
    return false;
  }
}

export function resolveKiraProjectRoot(
  workRootDirectory: string | null | undefined,
  projectName: string | null | undefined,
): string {
  const root = workRootDirectory?.trim();
  const project = projectName?.trim();
  if (!root || !project) return '';

  const resolvedRoot = resolve(root);
  if (
    isKiraProjectRoot(resolvedRoot) &&
    basename(resolvedRoot).toLowerCase() === project.toLowerCase()
  ) {
    return resolvedRoot;
  }

  return resolve(join(resolvedRoot, project));
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
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 180) || 'lock'
  );
}

function getWorkLockPath(sessionsDir: string, sessionPath: string, workId: string): string {
  return join(
    getSessionAutomationLocksDir(sessionsDir, sessionPath),
    `work-${sanitizeLockKey(workId)}.json`,
  );
}

function getProjectLockPath(sessionsDir: string, projectKey: string): string {
  return join(
    getGlobalAutomationLocksDir(sessionsDir),
    `project-${sanitizeLockKey(projectKey)}.json`,
  );
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
    if (!raw.llm?.model?.trim()) return null;
    if (raw.llm.provider !== 'codex-cli' && !raw.llm.baseUrl?.trim()) return null;
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

function getOptionalApiStyle(value: unknown): LLMApiStyle | undefined {
  return value === 'openai-chat' || value === 'openai-responses' || value === 'anthropic-messages'
    ? value
    : undefined;
}

function defaultBaseUrlForProvider(provider: LLMProvider | undefined): string | undefined {
  if (provider === 'opencode') return 'https://opencode.ai/zen';
  if (provider === 'opencode-go') return 'https://opencode.ai/zen/go';
  return undefined;
}

function isCodexCliProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'codex-cli';
}

function isOpenCodeProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'opencode' || provider === 'opencode-go';
}

function normalizeProviderModel(config: Pick<LLMConfig, 'provider' | 'model'>): string {
  const model = config.model.trim();
  if (config.provider === 'opencode' && model.startsWith('opencode/')) {
    return model.slice('opencode/'.length);
  }
  if (config.provider === 'opencode-go' && model.startsWith('opencode-go/')) {
    return model.slice('opencode-go/'.length);
  }
  return model;
}

function resolveOpenCodeApiKey(config: LLMConfig): string {
  if (!isOpenCodeProvider(config.provider) || config.apiKey.trim()) return config.apiKey;
  return (
    process.env.OPENCODE_API_KEY ??
    process.env.OPENCODE_ZEN_API_KEY ??
    process.env.OPENCODE_GO_API_KEY ??
    ''
  );
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

function isKimiToolReasoningSensitiveModel(config: Pick<LLMConfig, 'provider' | 'model'>): boolean {
  const model = normalizeProviderModel(config).toLowerCase();
  return model.includes('kimi-k2');
}

function shouldDisableOpenAiThinking(config: LLMConfig): boolean {
  if (!isOpenCodeProvider(config.provider) && config.provider !== 'kimi') return false;
  return isKimiToolReasoningSensitiveModel(config);
}

export function getOpenAiAssistantReasoningContent(
  config: Pick<LLMConfig, 'provider' | 'model'>,
  message: Pick<Extract<AgentMessage, { role: 'assistant' }>, 'reasoningContent' | 'toolCalls'>,
): string | undefined {
  const existing = message.reasoningContent?.trim();
  if (existing) return existing;
  if (message.toolCalls?.length && isKimiToolReasoningSensitiveModel(config)) {
    return KIMI_TOOL_CALL_REASONING_FALLBACK;
  }
  return undefined;
}

function isCodexCliModelUpgradeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /requires a newer version of Codex/i.test(message);
}

export function resolveRoleLlmConfig(
  baseConfig: LLMConfig | null,
  override: Partial<LLMConfig> | null | undefined,
  legacyModel: string | null | undefined,
): LLMConfig | null {
  const overrideProvider = getOptionalString(override?.provider) as LLMProvider | undefined;
  const provider = overrideProvider ?? baseConfig?.provider;
  const canInheritBaseProviderSettings =
    !overrideProvider || overrideProvider === baseConfig?.provider;
  const baseUrl =
    getOptionalString(override?.baseUrl) ??
    (canInheritBaseProviderSettings ? baseConfig?.baseUrl : undefined) ??
    defaultBaseUrlForProvider(provider as LLMProvider | undefined);
  const model =
    getOptionalString(override?.model) ??
    getOptionalString(legacyModel) ??
    (canInheritBaseProviderSettings ? baseConfig?.model : undefined);
  const apiKey =
    override?.apiKey ?? (canInheritBaseProviderSettings ? baseConfig?.apiKey : undefined) ?? '';
  const customHeaders =
    getOptionalString(override?.customHeaders) ??
    (canInheritBaseProviderSettings ? baseConfig?.customHeaders : undefined);
  const command =
    getOptionalString(override?.command) ??
    (canInheritBaseProviderSettings ? baseConfig?.command : undefined);
  const apiStyle =
    getOptionalApiStyle(override?.apiStyle) ??
    (canInheritBaseProviderSettings ? baseConfig?.apiStyle : undefined);
  const name =
    getOptionalString(override?.name) ??
    (canInheritBaseProviderSettings ? baseConfig?.name : undefined);

  if (!provider) return null;
  if (isCodexCliProvider(provider as LLMProvider)) {
    return {
      provider: provider as LLMProvider,
      apiKey: '',
      baseUrl: '',
      model: model ?? '',
      ...(command ? { command } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (!baseUrl || !model) return null;

  return {
    provider: provider as LLMProvider,
    apiKey,
    baseUrl,
    model,
    ...(customHeaders ? { customHeaders } : {}),
    ...(command ? { command } : {}),
    ...(apiStyle ? { apiStyle } : {}),
    ...(name ? { name } : {}),
  };
}

export function resolveWorkerLlmConfigs(
  baseConfig: LLMConfig | null,
  kiraSettings: KiraSettings,
): LLMConfig[] {
  const rawWorkers = Array.isArray(kiraSettings.workers) ? kiraSettings.workers.slice(0, 3) : [];
  const workerConfigs =
    rawWorkers.length > 0
      ? rawWorkers
          .map((worker, index) =>
            resolveRoleLlmConfig(
              baseConfig,
              {
                ...worker,
                name: worker.name ?? `Worker ${index + 1}`,
              },
              null,
            ),
          )
          .filter((config): config is LLMConfig => config !== null)
      : [resolveRoleLlmConfig(baseConfig, kiraSettings.workerLlm, kiraSettings.workerModel)].filter(
          (config): config is LLMConfig => config !== null,
        );

  return workerConfigs.slice(0, 3);
}

function getKiraRuntimeSettings(configFile: string, fallbackWorkRootDirectory: string | null) {
  const llmConfig = loadLlmConfig(configFile);
  const kiraSettings = loadKiraSettings(configFile);
  const workRootDirectory = kiraSettings.workRootDirectory?.trim() || fallbackWorkRootDirectory;
  const workerConfigs = resolveWorkerLlmConfigs(llmConfig, kiraSettings);
  const workerConfig = workerConfigs[0] ?? null;
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
    workerConfigs,
    reviewerConfig,
  };
}

function buildWorkerLanes(workerConfigs: LLMConfig[]): KiraWorkerLane[] {
  return workerConfigs.slice(0, 3).map((config, index) => {
    const configuredName = config.name?.trim();
    const baseLabel = configuredName || `Worker ${String.fromCharCode(65 + index)}`;
    return {
      id: `worker-${index + 1}`,
      label: buildAgentLabel(baseLabel, config.model),
      config,
    };
  });
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

function toResponsesTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function',
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
  }));
}

async function fetchLlmWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LLM_REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  const abortHandler = () => controller.abort();
  signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortHandler);
  }
}

async function callOpenAiCompatible(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const targetUrl = joinUrl(config.baseUrl, getOpenAICompletionsPath(config.baseUrl));
  const apiKey = resolveOpenCodeApiKey(config);
  const messages = history.map((message) => {
    if (message.role === 'assistant') {
      const reasoningContent = getOpenAiAssistantReasoningContent(config, message);
      return {
        role: 'assistant',
        content: message.content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
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
    model: normalizeProviderModel(config),
    messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages,
    stream: false,
  };
  if (shouldDisableOpenAiThinking(config)) {
    body.thinking = { type: 'disabled' };
    body.reasoning = { enabled: false };
  }
  if (tools.length > 0) body.tools = toOpenAITools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchLlmWithTimeout(
    targetUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    signal,
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }
  const data = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
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
    reasoningContent: message?.reasoning_content,
  };
}

async function callOpenAiResponses(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const targetUrl = joinUrl(
    config.baseUrl,
    hasVersionSuffix(config.baseUrl) ? 'responses' : 'v1/responses',
  );
  const apiKey = resolveOpenCodeApiKey(config);
  const input: Array<Record<string, unknown>> = [];

  for (const message of history) {
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.args),
        });
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    input.push({ role: 'user', content: message.content });
  }

  const body: Record<string, unknown> = {
    model: normalizeProviderModel(config),
    input,
    stream: false,
  };
  if (systemPrompt) body.instructions = systemPrompt;
  if (tools.length > 0) body.tools = toResponsesTools(tools);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchLlmWithTimeout(
    targetUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    signal,
  );
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
        name: item.name,
        args: normalizeToolArguments(item.arguments || '{}'),
      });
    }
  }

  return {
    content: (data.output_text || contentParts.join('')).trim(),
    toolCalls,
  };
}

async function callAnthropicCompatible(
  config: LLMConfig,
  systemPrompt: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const targetUrl = joinUrl(config.baseUrl, getAnthropicMessagesPath(config.baseUrl));
  const apiKey = resolveOpenCodeApiKey(config);
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
    model: normalizeProviderModel(config),
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
  if (apiKey.trim()) headers['x-api-key'] = apiKey;

  const res = await fetchLlmWithTimeout(
    targetUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    signal,
  );
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
      (
        block,
      ): block is {
        type: 'tool_use';
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      } => block.type === 'tool_use',
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
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  if (isOpenCodeProvider(config.provider)) {
    const apiStyle = resolveOpenCodeApiStyle(config);
    if (apiStyle === 'openai-responses') {
      return callOpenAiResponses(config, systemPrompt, history, tools, signal);
    }
    if (apiStyle === 'anthropic-messages') {
      return callAnthropicCompatible(config, systemPrompt, history, tools, signal);
    }
    return callOpenAiCompatible(config, systemPrompt, history, tools, signal);
  }
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

export function hasMergeConflictMarkers(content: string): boolean {
  return /^(<{7}|={7}|>{7})(?: .*)?$/m.test(content);
}

export function isSafeCommandAllowed(command: string): boolean {
  const normalized = normalizeWhitespace(command);
  if (!normalized) return false;
  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

function captureAttemptFileSnapshot(
  state: WorkerAttemptState | null | undefined,
  projectRoot: string,
  relativePath: string,
): void {
  if (!state) return;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || state.fileSnapshots.has(normalizedPath)) return;

  const absolutePath = ensureInsideRoot(projectRoot, normalizedPath);
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
    state.fileSnapshots.set(normalizedPath, {
      existed: true,
      content: fs.readFileSync(absolutePath, 'utf-8'),
    });
    return;
  }

  state.fileSnapshots.set(normalizedPath, {
    existed: false,
    content: null,
  });
}

function isPlannedFile(plan: WorkerExecutionPlan | null, relativePath: string): boolean {
  if (!plan) return false;
  const normalizedPath = normalizeRelativePath(relativePath);
  return plan.intendedFiles.some(
    (plannedFile) =>
      plannedFile === normalizedPath ||
      (plannedFile.endsWith('/') && normalizedPath.startsWith(plannedFile)),
  );
}

function isProtectedFile(plan: WorkerExecutionPlan | null, relativePath: string): boolean {
  if (!plan) return false;
  const normalizedPath = normalizeRelativePath(relativePath);
  return plan.protectedFiles.some(
    (protectedFile) =>
      protectedFile === normalizedPath ||
      (protectedFile.endsWith('/') && normalizedPath.startsWith(protectedFile)),
  );
}

function pathMatchesScope(scopes: string[], relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  return scopes.some((scope) => {
    const normalizedScope = normalizeRelativePath(scope);
    return (
      normalizedScope === normalizedPath ||
      (normalizedScope.endsWith('/') && normalizedPath.startsWith(normalizedScope))
    );
  });
}

export function canUseFullFileRewrite(params: {
  existingFileSize: number;
  relativePath: string;
  intendedFiles: string[];
  protectedFiles?: string[];
  readFiles: string[];
  maxFileBytes?: number;
}): boolean {
  const normalizedPath = normalizeRelativePath(params.relativePath);
  if (!normalizedPath) return false;
  if (params.existingFileSize > (params.maxFileBytes ?? MAX_FULL_REWRITE_FILE_BYTES)) {
    return false;
  }
  if (!pathMatchesScope(params.readFiles, normalizedPath)) return false;
  if (!pathMatchesScope(params.intendedFiles, normalizedPath)) return false;
  if (pathMatchesScope(params.protectedFiles ?? [], normalizedPath)) return false;
  return true;
}

function validateWriteTarget(
  state: WorkerAttemptState | null | undefined,
  relativePath: string,
): string | null {
  if (!state) return null;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath) return null;
  if (isProtectedFile(state.plan, normalizedPath)) {
    return `error: ${normalizedPath} is listed in protectedFiles and cannot be edited by this attempt`;
  }
  if (state.dirtyFiles.has(normalizedPath) && !isPlannedFile(state.plan, normalizedPath)) {
    return `error: ${normalizedPath} has pre-existing worktree changes and is not listed in intendedFiles`;
  }
  return null;
}

function recordAttemptPatch(
  state: WorkerAttemptState | null | undefined,
  relativePath: string,
): void {
  if (!state) return;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (normalizedPath) {
    state.patchedFiles.add(normalizedPath);
  }
}

function restoreAttemptFiles(
  projectRoot: string,
  state: WorkerAttemptState | null | undefined,
): string[] {
  if (!state || state.fileSnapshots.size === 0) return [];

  const restored: string[] = [];
  for (const [relativePath, snapshot] of [...state.fileSnapshots.entries()].reverse()) {
    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    if (snapshot.existed) {
      fs.mkdirSync(dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, snapshot.content ?? '', 'utf-8');
      restored.push(relativePath);
      continue;
    }

    if (fs.existsSync(absolutePath)) {
      fs.rmSync(absolutePath, { force: true });
      restored.push(relativePath);
    }
  }

  return restored.sort();
}

function tryRestoreAttemptFiles(
  projectRoot: string,
  state: WorkerAttemptState | null | undefined,
): { restoredFiles: string[]; error: string | null } {
  try {
    return { restoredFiles: restoreAttemptFiles(projectRoot, state), error: null };
  } catch (error) {
    return {
      restoredFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function recordAttemptCommand(state: WorkerAttemptState | null | undefined, command: string): void {
  if (!state) return;
  const normalized = normalizeWhitespace(command);
  if (normalized) {
    state.commandsRun.push(normalized);
  }
}

function recordAttemptExploration(
  state: WorkerAttemptState | null | undefined,
  action: string,
): void {
  if (!state) return;
  const normalized = normalizeWhitespace(action);
  if (normalized) {
    state.explorationActions.push(normalized);
  }
}

function recordAttemptRead(
  state: WorkerAttemptState | null | undefined,
  relativePath: string,
): void {
  if (!state) return;
  const normalizedPath = normalizeRelativePath(relativePath);
  if (normalizedPath) {
    state.readFiles.add(normalizedPath);
    recordAttemptExploration(state, `read_file ${normalizedPath}`);
  }
}

function truncateForComment(value: string, maxChars: number, suffix: string): string {
  if (value.length <= maxChars) return value;
  const suffixWithBreak = `\n${suffix}`;
  return `${value.slice(0, Math.max(0, maxChars - suffixWithBreak.length)).trimEnd()}${suffixWithBreak}`;
}

function truncateForReview(value: string, maxChars: number): string {
  return truncateForComment(value, maxChars, '...diff truncated for review');
}

export function formatWorkerSubmission(
  rawWorkerOutput: string | undefined,
  maxChars = 8_000,
): string {
  const normalized = rawWorkerOutput?.trim();
  if (!normalized) return 'No raw worker submission captured.';
  return truncateForComment(normalized, maxChars, '...worker submission truncated for comment');
}

function isLlmTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /LLM request timed out/i.test(message);
}

function buildAgentTimeoutRetryPrompt(writable: boolean): string {
  return [
    'The previous Kira LLM request timed out before returning a response.',
    writable
      ? 'Continue with a narrower implementation step, use only necessary tools, and keep the final JSON concise.'
      : 'Continue with a narrower read-only planning step, inspect only the most relevant files, and keep the final JSON concise.',
    'Do not restart broad repository exploration unless no relevant files have been inspected yet.',
  ].join(' ');
}

function buildAgentFinalRepairPrompt(issues: string[], content: string): string {
  return [
    'Your previous final response did not satisfy Kira structured output requirements.',
    `Issues:\n${formatList(issues, 'No detailed issues provided')}`,
    content.trim()
      ? `Previous final response:\n${truncateForReview(content, 2_000)}`
      : 'Previous final response was empty.',
    'If repository context is missing, call list_files, search_files, or read_file before finalizing.',
    'Then return only the requested JSON object. Do not use markdown fences or prose.',
  ].join('\n\n');
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return [`stdout:\n${stdout.trim() || '(empty)'}`, `stderr:\n${stderr.trim() || '(empty)'}`].join(
    '\n\n',
  );
}

function formatCommandFailureDetail(command: string, error: unknown): string {
  const stdout =
    error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return [
    `Command: ${command}`,
    `Error: ${message}`,
    truncateForReview(formatCommandOutput(stdout, stderr), 1_200),
  ].join('\n\n');
}

function isHighRiskFile(projectRoot: string, relativePath: string): boolean {
  const absolutePath = ensureInsideRoot(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return false;

  const ext = absolutePath.slice(absolutePath.lastIndexOf('.')).toLowerCase();
  const basename = absolutePath.slice(absolutePath.lastIndexOf('\\') + 1).toLowerCase();
  const sourceLike = ['.py', '.js', '.jsx', '.ts', '.tsx', '.go', '.rs', '.java', '.cs'].includes(
    ext,
  );
  if (!sourceLike) return false;

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lineCount = content.split(/\r?\n/).length;
  return (
    lineCount >= 220 ||
    ['main.py', 'app.py', 'server.py', 'index.ts', 'index.tsx'].includes(basename)
  );
}

function requiresExplicitReadBeforeWrite(
  projectRoot: string,
  relativePath: string,
  state: WorkerAttemptState | null | undefined,
): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || !state) return false;
  if (state.readFiles.has(normalizedPath)) return false;
  return isHighRiskFile(projectRoot, normalizedPath);
}

function collectFiles(root: string, currentDir: string, depth: number, entries: string[]): void {
  if (entries.length >= MAX_LIST_ENTRIES) return;
  const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    if (dirent.name === '.git' || dirent.name === 'node_modules' || dirent.name === '.venv')
      continue;
    const absolutePath = join(currentDir, dirent.name);
    const relativePath = absolutePath
      .slice(root.length)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');
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
      if (dirent.name === '.git' || dirent.name === 'node_modules' || dirent.name === '.venv')
        continue;
      const absolutePath = join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const relativePath = absolutePath
        .slice(root.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/');
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
          const snippet = content.slice(
            Math.max(0, index - 80),
            Math.min(content.length, index + 120),
          );
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
  attemptState?: WorkerAttemptState | null,
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
      recordAttemptExploration(
        attemptState,
        `list_files ${normalizeRelativePath(directory) || '.'}`,
      );
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
      recordAttemptRead(attemptState, filePath);
      return fs.readFileSync(absolutePath, 'utf-8');
    }
    case 'write_file': {
      if (!writable) return 'error: write_file is disabled for this agent';
      const filePath = typeof args.path === 'string' ? args.path : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) return 'error: path is required';
      const absolutePath = ensureInsideRoot(projectRoot, filePath);
      const targetError = validateWriteTarget(attemptState, filePath);
      if (targetError) return targetError;
      if (containsCorruptionMarker(content)) {
        return 'error: refusing to write placeholder or corruption marker text';
      }
      if (hasMergeConflictMarkers(content)) {
        return 'error: refusing to write merge conflict markers';
      }
      if (Buffer.byteLength(content, 'utf-8') > MAX_FULL_REWRITE_FILE_BYTES) {
        return `error: write_file content is too large; maximum is ${MAX_FULL_REWRITE_FILE_BYTES} bytes`;
      }
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        if (requiresExplicitReadBeforeWrite(projectRoot, filePath, attemptState)) {
          return 'error: high-risk existing files must be read with read_file before overwriting';
        }
        const stat = fs.statSync(absolutePath);
        const canFullRewrite = canUseFullFileRewrite({
          existingFileSize: stat.size,
          relativePath: filePath,
          intendedFiles: attemptState?.plan?.intendedFiles ?? [],
          protectedFiles: attemptState?.plan?.protectedFiles ?? [],
          readFiles: Array.from(attemptState?.readFiles ?? []),
        });
        if (stat.size > MAX_OVERWRITE_FILE_BYTES && !canFullRewrite) {
          return 'error: existing file is too large for write_file unless it is listed in intendedFiles and was read with read_file in this attempt';
        }
      }
      captureAttemptFileSnapshot(attemptState, projectRoot, filePath);
      fs.mkdirSync(dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, 'utf-8');
      recordAttemptPatch(attemptState, filePath);
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
      const targetError = validateWriteTarget(attemptState, filePath);
      if (targetError) return targetError;
      if (requiresExplicitReadBeforeWrite(projectRoot, filePath, attemptState)) {
        return 'error: high-risk files must be read with read_file before editing';
      }
      captureAttemptFileSnapshot(attemptState, projectRoot, filePath);
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
      recordAttemptPatch(attemptState, filePath);
      return `success: replaced ${replaceAll ? occurrences : 1} occurrence(s)`;
    }
    case 'search_files': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return 'error: query is required';
      const results = searchProjectFiles(projectRoot, query);
      recordAttemptExploration(attemptState, `search_files ${query}`);
      return results.length > 0 ? results.join('\n') : 'no matches';
    }
    case 'run_command': {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) return 'error: command is required';
      if (
        DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalizeWhitespace(command)))
      ) {
        return 'error: command rejected by safety policy';
      }
      if (!isSafeCommandAllowed(command)) {
        return 'error: command prefix is not allowed';
      }
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const { stdout, stderr } = await execAsync(command, {
        cwd: projectRoot,
        shell,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      recordAttemptCommand(attemptState, command);
      return formatCommandOutput(stdout, stderr);
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
              find: {
                type: 'string',
                description: 'Exact existing text to replace',
                required: true,
              },
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
              'Create a UTF-8 file or write complete final content for an existing file. Existing large files are allowed only when the file is in intendedFiles, was read with read_file in this attempt, and is not protected.',
            parameters: {
              path: { type: 'string', description: 'Relative file path', required: true },
              content: {
                type: 'string',
                description: 'Complete final file content, not a patch or excerpt',
                required: true,
              },
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
        'Run a safe diagnostic or validation command such as pytest, npm/pnpm test or lint, git status/diff/show, rg, go test, cargo test/check, or dotnet test/build.',
      parameters: {
        command: { type: 'string', description: 'Exact command to run', required: true },
      },
    },
  ];
}

function buildExternalAgentPrompt(systemPrompt: string, prompt: string): string {
  return [
    systemPrompt ? `Kira role instructions:\n${systemPrompt}` : '',
    'You are running inside Kira automation. Follow the Kira role instructions over your default habits when they are more specific.',
    'Return the final answer in exactly the structured JSON shape requested by the Kira task prompt.',
    prompt,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildCodexCliArgs(
  config: LLMConfig,
  projectRoot: string,
  writable: boolean,
  outputFile: string,
): string[] {
  const args = [
    'exec',
    '--cd',
    projectRoot,
    '--skip-git-repo-check',
    '--sandbox',
    writable ? 'workspace-write' : 'read-only',
    '--output-last-message',
    outputFile,
    '--color',
    'never',
  ];
  if (config.model.trim()) {
    args.push('--model', config.model.trim());
  }
  args.push('-');
  return args;
}

function runProcessWithInput(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }
    }, timeoutMs);
    timeout.unref?.();

    const abortHandler = () => {
      child.kill();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const error = new Error('Agent run aborted.');
        error.name = 'AbortError';
        reject(error);
      }
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
      if (code === 0) {
        resolveProcess({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `Command failed with exit code ${code}: ${command}`,
            truncateForReview(formatCommandOutput(stdout, stderr), 1_200),
          ].join('\n\n'),
        ),
      );
    });
    child.stdin?.end(input);
  });
}

async function runCodexCliAgent(
  config: LLMConfig,
  projectRoot: string,
  prompt: string,
  systemPrompt: string,
  writable: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const tempDir = fs.mkdtempSync(join(tmpdir(), 'kira-codex-'));
  const outputFile = join(tempDir, 'last-message.txt');
  try {
    const command = config.command?.trim() || 'codex';
    const input = buildExternalAgentPrompt(systemPrompt, prompt);
    try {
      await runProcessWithInput(
        command,
        buildCodexCliArgs(config, projectRoot, writable, outputFile),
        projectRoot,
        input,
        signal,
        EXTERNAL_AGENT_TIMEOUT_MS,
      );
    } catch (error) {
      if (
        config.model.trim() &&
        config.model.trim() !== CODEX_CLI_FALLBACK_MODEL &&
        isCodexCliModelUpgradeError(error)
      ) {
        await runProcessWithInput(
          command,
          buildCodexCliArgs(
            { ...config, model: CODEX_CLI_FALLBACK_MODEL },
            projectRoot,
            writable,
            outputFile,
          ),
          projectRoot,
          input,
          signal,
          EXTERNAL_AGENT_TIMEOUT_MS,
        );
      } else {
        throw error;
      }
    }
    if (fs.existsSync(outputFile)) {
      return fs.readFileSync(outputFile, 'utf-8').trim();
    }
    return '';
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runToolAgent(
  config: LLMConfig,
  projectRoot: string,
  prompt: string,
  systemPrompt: string,
  writable: boolean,
  signal?: AbortSignal,
  attemptState?: WorkerAttemptState | null,
  finalValidator?: ToolAgentFinalValidator,
): Promise<string> {
  if (isCodexCliProvider(config.provider)) {
    recordAttemptCommand(
      attemptState,
      `codex exec --sandbox ${writable ? 'workspace-write' : 'read-only'}${
        config.model ? ` --model ${config.model}` : ''
      }`,
    );
    recordAttemptExploration(attemptState, `external_agent ${config.provider}`);
    return runCodexCliAgent(config, projectRoot, prompt, systemPrompt, writable, signal);
  }

  const history: AgentMessage[] = [{ role: 'user', content: prompt }];
  const tools = buildToolDefinitions(writable);
  let repairTurns = 0;
  let timeoutRetries = 0;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    if (signal?.aborted) {
      const error = new Error('Agent run aborted.');
      error.name = 'AbortError';
      throw error;
    }
    let response: Awaited<ReturnType<typeof callLlm>>;
    try {
      response = await callLlm(config, systemPrompt, history, tools, signal);
    } catch (error) {
      if (isLlmTimeoutError(error) && timeoutRetries < MAX_AGENT_TIMEOUT_RETRIES) {
        timeoutRetries += 1;
        history.push({ role: 'user', content: buildAgentTimeoutRetryPrompt(writable) });
        continue;
      }
      throw error;
    }
    if (response.toolCalls.length === 0) {
      const validationIssues = finalValidator?.(response.content) ?? [];
      if (validationIssues.length > 0 && repairTurns < MAX_AGENT_REPAIR_TURNS) {
        repairTurns += 1;
        history.push({
          role: 'assistant',
          content: response.content || '(empty final response)',
        });
        history.push({
          role: 'user',
          content: buildAgentFinalRepairPrompt(validationIssues, response.content),
        });
        continue;
      }
      return response.content;
    }

    history.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      reasoningContent: response.reasoningContent,
    });

    for (const toolCall of response.toolCalls) {
      if (signal?.aborted) {
        const error = new Error('Agent run aborted.');
        error.name = 'AbortError';
        throw error;
      }
      const toolResult = await executeTool(
        projectRoot,
        toolCall.name,
        toolCall.args,
        writable,
        attemptState,
      );
      history.push({
        role: 'tool',
        content: toolResult,
        toolCallId: toolCall.id,
      });
    }
  }

  const finalResponse = await callLlm(
    config,
    systemPrompt,
    [...history, { role: 'user', content: AGENT_TURN_BUDGET_EXHAUSTED_PROMPT }],
    [],
    signal,
  );
  const finalIssues = finalValidator?.(finalResponse.content) ?? [];
  if (
    finalResponse.toolCalls.length === 0 &&
    finalResponse.content.trim() &&
    finalIssues.length === 0
  ) {
    return finalResponse.content;
  }

  throw new Error(
    finalIssues.length > 0
      ? `Agent final response failed structured validation: ${finalIssues.join(' ')}`
      : 'Agent exceeded the maximum number of tool turns.',
  );
}

export function parseWorkerExecutionPlan(raw: string): WorkerExecutionPlan {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkerExecutionPlan>;
    const allPlannedCommands = uniqueStrings(
      (Array.isArray(parsed.validationCommands) ? parsed.validationCommands : [])
        .map((value) => normalizeWhitespace(String(value)))
        .filter(Boolean),
    );
    const safeCommands = allPlannedCommands.filter((command) => isSafeCommandAllowed(command));
    const rejectedCommands = allPlannedCommands.filter((command) => !isSafeCommandAllowed(command));
    const acceptedCommands = safeCommands.slice(0, MAX_PLANNER_VALIDATION_COMMANDS);
    const droppedCommands = safeCommands.slice(MAX_PLANNER_VALIDATION_COMMANDS);

    const parseIssues: string[] = [];
    if (!parsed.understanding?.trim()) parseIssues.push('Missing required field: understanding');
    if (!parsed.summary?.trim()) parseIssues.push('Missing required field: summary');
    if (!Array.isArray(parsed.repoFindings) || parsed.repoFindings.length === 0) {
      parseIssues.push('Missing required field: repoFindings');
    }
    if (!Array.isArray(parsed.intendedFiles) || parsed.intendedFiles.length === 0) {
      parseIssues.push('Missing required field: intendedFiles');
    }
    if (!Array.isArray(parsed.stopConditions) || parsed.stopConditions.length === 0) {
      parseIssues.push('Missing required field: stopConditions');
    }

    return {
      valid: parseIssues.length === 0,
      parseIssues,
      understanding: parsed.understanding?.trim() || 'No requirement understanding provided.',
      repoFindings: uniqueStrings(
        Array.isArray(parsed.repoFindings) ? parsed.repoFindings.map(String) : [],
      ),
      summary: parsed.summary?.trim() || 'No execution plan provided.',
      intendedFiles: normalizePathList(
        Array.isArray(parsed.intendedFiles) ? parsed.intendedFiles : [],
        MAX_PLANNED_FILES,
      ),
      protectedFiles: normalizePathList(
        Array.isArray(parsed.protectedFiles) ? parsed.protectedFiles : [],
        MAX_PLANNED_FILES,
      ),
      validationCommands: acceptedCommands,
      riskNotes: uniqueStrings([
        ...(Array.isArray(parsed.riskNotes) ? parsed.riskNotes.map(String) : []),
        ...rejectedCommands.map(
          (command) =>
            `Planner suggested an unsafe validation command that was removed: ${command}`,
        ),
        ...(droppedCommands.length > 0
          ? [
              `Planner suggested ${safeCommands.length} safe validation commands, so Kira kept only the first ${MAX_PLANNER_VALIDATION_COMMANDS}.`,
            ]
          : []),
      ]),
      stopConditions: uniqueStrings(
        Array.isArray(parsed.stopConditions) ? parsed.stopConditions.map(String) : [],
      ),
    };
  } catch {
    return {
      valid: false,
      parseIssues: ['Plan result could not be parsed into structured JSON.'],
      understanding: 'Plan result could not be parsed.',
      repoFindings: [],
      summary: raw.trim() || 'No execution plan provided.',
      intendedFiles: [],
      protectedFiles: [],
      validationCommands: [],
      riskNotes: [],
      stopConditions: [],
    };
  }
}

function parseWorkerSummary(raw: string): WorkerSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkerSummary>;
    return {
      summary: parsed.summary?.trim() || 'No worker summary provided.',
      filesChanged: normalizePathList(
        Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        100,
      ),
      testsRun: uniqueStrings(
        (Array.isArray(parsed.testsRun) ? parsed.testsRun : []).map((value) =>
          normalizeWhitespace(String(value)),
        ),
      ),
      remainingRisks: uniqueStrings(
        Array.isArray(parsed.remainingRisks) ? parsed.remainingRisks.map(String) : [],
      ),
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
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((finding) => normalizeReviewFinding(finding))
      : [];
    const missingValidation = uniqueStrings(
      Array.isArray(parsed.missingValidation) ? parsed.missingValidation.map(String) : [],
    );
    const nextWorkerInstructions = uniqueStrings(
      Array.isArray(parsed.nextWorkerInstructions) ? parsed.nextWorkerInstructions.map(String) : [],
    );
    const residualRisk = uniqueStrings(
      Array.isArray(parsed.residualRisk) ? parsed.residualRisk.map(String) : [],
    );
    return {
      approved: Boolean(parsed.approved),
      summary: parsed.summary?.trim() || 'No review summary provided.',
      issues: uniqueStrings([
        ...(Array.isArray(parsed.issues) ? parsed.issues.map(String) : []),
        ...findings.map((finding) =>
          [finding.file, finding.line ? `line ${finding.line}` : '', finding.message]
            .filter(Boolean)
            .join(': '),
        ),
        ...missingValidation.map((command) => `Missing validation: ${command}`),
      ]),
      filesChecked: Array.isArray(parsed.filesChecked) ? parsed.filesChecked.map(String) : [],
      findings,
      missingValidation,
      nextWorkerInstructions,
      residualRisk,
    };
  } catch {
    return {
      approved: false,
      summary: raw.trim() || 'Review parsing failed.',
      issues: ['Review result could not be parsed into structured JSON.'],
      filesChecked: [],
      findings: [],
      missingValidation: [],
      nextWorkerInstructions: ['Return the review result as structured JSON.'],
      residualRisk: [],
    };
  }
}

function normalizeReviewFinding(raw: unknown): ReviewFinding {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<ReviewFinding>) : {};
  const severity =
    value.severity === 'high' || value.severity === 'medium' || value.severity === 'low'
      ? value.severity
      : 'medium';
  return {
    file: typeof value.file === 'string' ? normalizeRelativePath(value.file) : '',
    line: typeof value.line === 'number' && Number.isFinite(value.line) ? value.line : null,
    severity,
    message: typeof value.message === 'string' ? value.message.trim() : String(raw),
  };
}

function projectHasFile(projectRoot: string, relativePath: string): boolean {
  const absolutePath = join(projectRoot, relativePath);
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
}

function projectHasDirectory(projectRoot: string, relativePath: string): boolean {
  const absolutePath = join(projectRoot, relativePath);
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();
}

function projectHasFileWithSuffix(projectRoot: string, suffixes: string[], maxDepth = 2): boolean {
  const walk = (currentDir: string, depth: number): boolean => {
    if (depth < 0 || !fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory())
      return false;
    const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name === '.git' || dirent.name === 'node_modules' || dirent.name === '.venv') {
        continue;
      }
      const absolutePath = join(currentDir, dirent.name);
      if (dirent.isFile() && suffixes.some((suffix) => dirent.name.endsWith(suffix))) {
        return true;
      }
      if (dirent.isDirectory() && walk(absolutePath, depth - 1)) {
        return true;
      }
    }
    return false;
  };

  return walk(projectRoot, maxDepth);
}

function loadPackageScripts(projectRoot: string): Record<string, string> {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) return {};

  try {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(raw.scripts ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function detectNodePackageManager(projectRoot: string): 'pnpm' | 'npm' | null {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      packageManager?: unknown;
    };
    if (typeof raw.packageManager === 'string') {
      if (raw.packageManager.startsWith('pnpm@')) return 'pnpm';
      if (raw.packageManager.startsWith('npm@')) return 'npm';
    }
  } catch {
    // Ignore invalid package.json metadata and fall back to lockfiles.
  }

  if (projectHasFile(projectRoot, 'pnpm-lock.yaml')) return 'pnpm';
  return 'npm';
}

function detectWorkspaceFiles(projectRoot: string): string[] {
  return [
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'vite.config.ts',
    'vitest.config.ts',
    'jest.config.js',
    'tsconfig.json',
    'pyproject.toml',
    'pytest.ini',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
  ].filter((filePath) => projectHasFile(projectRoot, filePath));
}

function formatPackageScripts(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([name]) => ['test', 'lint', 'build', 'typecheck', 'check'].includes(name))
    .map(([name, command]) => `${name}: ${command}`);
}

function extractWorkSearchTerms(work: WorkTask): string[] {
  const source = `${work.title}\n${work.description}`;
  const pathLike = source.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [];
  const words = source
    .replace(/[`*_#[\](){}:;,.!?]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && /[A-Za-z]/.test(word))
    .filter(
      (word) =>
        ![
          'this',
          'that',
          'with',
          'from',
          'into',
          'work',
          'task',
          'should',
          'would',
          'could',
          'when',
          'where',
          'there',
          'about',
          'using',
          'make',
          'update',
          'create',
          'delete',
          'remove',
          'fix',
          'add',
        ].includes(word.toLowerCase()),
    );

  return uniqueStrings([...pathLike, ...words]).slice(0, 8);
}

function collectLikelyFilesForWork(projectRoot: string, work: WorkTask): string[] {
  const results: string[] = [];
  for (const term of extractWorkSearchTerms(work)) {
    results.push(...searchProjectFiles(projectRoot, term).slice(0, 4));
    if (results.length >= 16) break;
  }
  return uniqueStrings(results).slice(0, 16);
}

function collectProjectPaths(
  root: string,
  predicate: (relativePath: string, dirent: fs.Dirent) => boolean,
  limit = MAX_SEARCH_RESULTS,
): string[] {
  const results: string[] = [];
  const walk = (currentDir: string) => {
    if (results.length >= limit) return;
    const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (results.length >= limit) return;
      if (dirent.name === '.git' || dirent.name === 'node_modules' || dirent.name === '.venv') {
        continue;
      }
      const absolutePath = join(currentDir, dirent.name);
      const relativePath = absolutePath
        .slice(root.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/');
      if (predicate(relativePath, dirent)) {
        results.push(relativePath);
      }
      if (dirent.isDirectory()) {
        walk(absolutePath);
      }
    }
  };

  walk(root);
  return uniqueStrings(results).slice(0, limit);
}

function collectRelatedDocs(projectRoot: string, work: WorkTask): string[] {
  const terms = extractWorkSearchTerms(work).map((term) => term.toLowerCase());
  const docs = collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      const lowerPath = relativePath.toLowerCase();
      if (!/\.(md|mdx|txt|rst)$/.test(lowerPath)) return false;
      return terms.length === 0 || terms.some((term) => lowerPath.includes(term));
    },
    20,
  );

  return docs.length > 0
    ? docs
    : collectProjectPaths(
        projectRoot,
        (relativePath, dirent) =>
          dirent.isFile() &&
          /(^|\/)(readme|contributing|architecture|guide).*\.md$/i.test(relativePath),
        10,
      );
}

function collectRelatedTests(projectRoot: string, work: WorkTask): string[] {
  const terms = extractWorkSearchTerms(work).map((term) => term.toLowerCase());
  return collectProjectPaths(
    projectRoot,
    (relativePath, dirent) => {
      if (!dirent.isFile()) return false;
      const lowerPath = relativePath.toLowerCase();
      const isTestPath =
        lowerPath.includes('/__tests__/') ||
        lowerPath.includes('/tests/') ||
        /\.(test|spec)\.[a-z0-9]+$/.test(lowerPath) ||
        /^tests?\//.test(lowerPath);
      if (!isTestPath) return false;
      return terms.length === 0 || terms.some((term) => lowerPath.includes(term));
    },
    20,
  );
}

function formatGitStatusEntries(entries: GitStatusEntry[] | null): string[] {
  if (!entries) return ['Git status unavailable'];
  return entries.map((entry) => `${entry.status.trim() || 'modified'} ${entry.path}`).slice(0, 40);
}

export async function buildProjectContextScan(
  projectRoot: string,
  work: WorkTask,
): Promise<ProjectContextScan> {
  const packageManager = detectNodePackageManager(projectRoot);
  const scripts = loadPackageScripts(projectRoot);
  const existingChanges = formatGitStatusEntries(await getGitWorktreeEntries(projectRoot));
  const searchTerms = extractWorkSearchTerms(work);
  const likelyFiles = collectLikelyFilesForWork(projectRoot, work);
  const relatedDocs = collectRelatedDocs(projectRoot, work);
  const testFiles = collectRelatedTests(projectRoot, work);
  const candidateChecks = uniqueStrings([
    ...buildDefaultValidationCommands(projectRoot, []),
    ...(['test', 'lint', 'typecheck', 'build'] as const)
      .filter((scriptName) => scripts[scriptName])
      .map((scriptName) =>
        packageManager === 'pnpm' ? `pnpm run ${scriptName}` : `npm run ${scriptName}`,
      ),
  ])
    .filter((command) => isSafeCommandAllowed(command))
    .slice(0, MAX_EFFECTIVE_VALIDATION_COMMANDS);

  const notes: string[] = [];
  if (existingChanges.length > 0 && existingChanges[0] !== 'Git status unavailable') {
    notes.push('Existing git changes may include user work; preserve unrelated changes.');
  }
  if (candidateChecks.length === 0) {
    notes.push(
      'No obvious validation command was detected; planner must explain validation choice.',
    );
  }
  if (likelyFiles.length === 0) {
    notes.push(
      'No likely implementation files were found from the brief; planner must search before planning edits.',
    );
  }
  if (testFiles.length === 0) {
    notes.push(
      'No related test files were detected from the brief; planner should identify the nearest validation path.',
    );
  }

  return {
    projectRoot,
    packageManager,
    workspaceFiles: detectWorkspaceFiles(projectRoot),
    packageScripts: formatPackageScripts(scripts),
    existingChanges,
    searchTerms,
    likelyFiles,
    relatedDocs,
    testFiles,
    candidateChecks,
    notes,
  };
}

export function buildDefaultValidationCommands(
  projectRoot: string,
  filesChanged: string[],
): string[] {
  const changedFiles = normalizePathList(filesChanged, 200);
  const changedExtensions = new Set(
    changedFiles
      .map((file) => file.slice(file.lastIndexOf('.')).toLowerCase())
      .filter((ext) => ext.startsWith('.')),
  );
  const commands: string[] = [];

  const changedHtmlFile = changedFiles.find((file) => /\.html?$/i.test(file));
  if (changedHtmlFile) {
    if (fs.existsSync(join(projectRoot, '.git'))) {
      commands.push(`git diff --check -- ${formatShellPath(changedHtmlFile)}`);
    }
    try {
      const absolutePath = ensureInsideRoot(projectRoot, changedHtmlFile);
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        if (/data-theme/i.test(content)) {
          commands.push(`rg -n "data-theme" ${formatShellPath(changedHtmlFile)}`);
        }
      }
    } catch {
      // If the file cannot be read, let the later validation plan continue with other checks.
    }
  }

  const packageManager = detectNodePackageManager(projectRoot);
  if (packageManager) {
    const scripts = loadPackageScripts(projectRoot);
    const changedTestFile = changedFiles.find((file) =>
      /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.toLowerCase()),
    );
    if (changedTestFile) {
      commands.push(
        packageManager === 'pnpm'
          ? `pnpm exec vitest ${changedTestFile}`
          : `npm test -- ${changedTestFile}`,
      );
    }
    const hasNodeSignals =
      changedExtensions.has('.ts') ||
      changedExtensions.has('.tsx') ||
      changedExtensions.has('.js') ||
      changedExtensions.has('.jsx') ||
      changedExtensions.has('.mts') ||
      changedExtensions.has('.cts') ||
      changedExtensions.has('.mjs') ||
      changedExtensions.has('.cjs') ||
      changedFiles.length === 0;
    if (hasNodeSignals) {
      if (scripts.typecheck) {
        commands.push(packageManager === 'pnpm' ? 'pnpm run typecheck' : 'npm run typecheck');
      } else if (scripts.test) {
        commands.push(packageManager === 'pnpm' ? 'pnpm test' : 'npm test');
      } else if (scripts.lint) {
        commands.push(packageManager === 'pnpm' ? 'pnpm run lint' : 'npm run lint');
      }
    }
  }

  const hasPythonSignals =
    changedExtensions.has('.py') ||
    projectHasFile(projectRoot, 'pytest.ini') ||
    projectHasFile(projectRoot, 'pyproject.toml') ||
    projectHasDirectory(projectRoot, 'tests');
  if (
    hasPythonSignals &&
    (projectHasFile(projectRoot, 'pytest.ini') || projectHasDirectory(projectRoot, 'tests'))
  ) {
    commands.push('python -m pytest');
  }

  const hasGoSignals = changedExtensions.has('.go') || projectHasFile(projectRoot, 'go.mod');
  if (hasGoSignals) {
    commands.push('go test ./...');
  }

  const hasRustSignals = changedExtensions.has('.rs') || projectHasFile(projectRoot, 'Cargo.toml');
  if (hasRustSignals) {
    commands.push('cargo check');
  }

  const hasDotnetSignals =
    changedExtensions.has('.cs') || projectHasFileWithSuffix(projectRoot, ['.sln', '.csproj']);
  if (hasDotnetSignals) {
    commands.push('dotnet build');
  }

  return uniqueStrings(commands)
    .filter((command) => isSafeCommandAllowed(command))
    .slice(0, MAX_DEFAULT_VALIDATION_COMMANDS);
}

export function resolveValidationPlan(
  projectRoot: string,
  plannerCommands: string[],
  filesChanged: string[],
): ResolvedValidationPlan {
  const normalizedPlannerCommands = uniqueStrings(
    plannerCommands.map((command) => normalizeWhitespace(command)),
  ).filter(Boolean);
  const autoAddedCommands = buildDefaultValidationCommands(projectRoot, filesChanged).filter(
    (command) => !normalizedPlannerCommands.includes(command),
  );
  const effectiveCommands = uniqueStrings([
    ...normalizedPlannerCommands,
    ...autoAddedCommands,
  ]).slice(0, MAX_EFFECTIVE_VALIDATION_COMMANDS);
  const notes: string[] = [];
  const normalizedFiles = normalizePathList(filesChanged, 200);
  const docOnly =
    normalizedFiles.length > 0 &&
    normalizedFiles.every((file) => /\.(md|mdx|txt|rst)$/i.test(file));

  if (
    normalizedPlannerCommands.length + autoAddedCommands.length >
    MAX_EFFECTIVE_VALIDATION_COMMANDS
  ) {
    notes.push(
      `Kira limited the combined validation plan to ${MAX_EFFECTIVE_VALIDATION_COMMANDS} commands.`,
    );
  }
  if (docOnly && autoAddedCommands.length === 0) {
    notes.push('Only documentation files changed; no automatic code validation command was added.');
  }
  if (normalizedFiles.length > 0 && effectiveCommands.length === 0) {
    notes.push('No safe validation command could be inferred from the changed files.');
  }

  return {
    plannerCommands: normalizedPlannerCommands,
    autoAddedCommands: autoAddedCommands.slice(
      0,
      Math.max(0, MAX_EFFECTIVE_VALIDATION_COMMANDS - normalizedPlannerCommands.length),
    ),
    effectiveCommands,
    notes,
  };
}

export function findOutOfPlanTouchedFiles(plannedFiles: string[], actualFiles: string[]): string[] {
  const planned = normalizePathList(plannedFiles, 200);
  if (planned.length === 0) return [];

  return normalizePathList(actualFiles, 200).filter(
    (actualFile) =>
      !planned.some(
        (plannedFile) =>
          plannedFile === actualFile ||
          (plannedFile.endsWith('/') && actualFile.startsWith(plannedFile)),
      ),
  );
}

export function findMissingValidationCommands(
  plannedCommands: string[],
  actualCommands: string[],
): string[] {
  const actual = new Set(actualCommands.map((command) => normalizeCommandForComparison(command)));
  return uniqueStrings(plannedCommands.map((command) => normalizeWhitespace(command))).filter(
    (command) => !actual.has(normalizeCommandForComparison(command)),
  );
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
    ...(finding.files.length > 0
      ? finding.files.map((item) => `- ${item}`)
      : ['- Inspect the current project and choose the most relevant files.']),
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
      ? parsed.findings.slice(0, MAX_DISCOVERY_FINDINGS).map((finding, index) => {
          const title = finding.title?.trim() || `Discovery item ${index + 1}`;
          const summary = finding.summary?.trim() || 'No summary provided.';
          const files = Array.isArray(finding.files)
            ? finding.files.map(String).filter(Boolean)
            : [];
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

function hashWorkBrief(work: Pick<WorkTask, 'title' | 'description' | 'projectName'>): string {
  return createHash('sha256')
    .update(JSON.stringify([work.projectName, work.title.trim(), work.description.trim()]))
    .digest('hex')
    .slice(0, 20);
}

function normalizeClarificationQuestionId(
  rawId: unknown,
  index: number,
  usedIds: Set<string>,
): string {
  const fallbackId = `q-${index + 1}`;
  let nextId = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : fallbackId;
  if (usedIds.has(nextId)) nextId = fallbackId;
  let suffix = 2;
  while (usedIds.has(nextId)) {
    nextId = `${fallbackId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(nextId);
  return nextId;
}

function normalizeClarificationSummary(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? normalizeWhitespace(value) : fallback;
}

function buildFallbackClarificationQuestion(
  question: string,
  index = 0,
): WorkClarificationQuestion {
  return {
    id: `q-${index + 1}`,
    question,
    options: [],
    allowCustomAnswer: true,
  };
}

function normalizeClarificationQuestion(
  raw: Partial<WorkClarificationQuestion> | null | undefined,
  index: number,
  usedIds: Set<string>,
): WorkClarificationQuestion | null {
  const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
  if (!question) return null;
  const options = uniqueStrings(
    (Array.isArray(raw?.options) ? raw.options : [])
      .map((option) => normalizeWhitespace(String(option)))
      .filter(Boolean),
  ).slice(0, MAX_CLARIFICATION_OPTIONS);

  return {
    id: normalizeClarificationQuestionId(raw?.id, index, usedIds),
    question,
    options,
    allowCustomAnswer: options.length === 0 || raw?.allowCustomAnswer !== false,
  };
}

export function parseWorkClarificationAnalysis(raw: string): WorkClarificationAnalysis {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<WorkClarificationAnalysis> & {
      questions?: Array<Partial<WorkClarificationQuestion>>;
    };
    const usedIds = new Set<string>();
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .slice(0, MAX_CLARIFICATION_QUESTIONS)
      .map((question, index) => normalizeClarificationQuestion(question, index, usedIds))
      .filter((question): question is WorkClarificationQuestion => question !== null);
    const needsClarification = parsed.needsClarification === true;
    const summary = normalizeClarificationSummary(
      parsed.summary,
      needsClarification
        ? 'The brief needs clarification before worker assignment.'
        : 'The brief is ready for worker assignment.',
    );

    return {
      needsClarification,
      confidence:
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      summary,
      questions:
        needsClarification && questions.length === 0
          ? [
              buildFallbackClarificationQuestion(
                'The main model said this work needs clarification but did not return usable questions. What detail should be added before a worker starts?',
              ),
            ]
          : questions,
    };
  } catch {
    return {
      needsClarification: true,
      confidence: 0,
      summary:
        'Clarification analysis could not be parsed, so Kira is blocking worker assignment instead of proceeding with an unchecked brief.',
      questions: [
        buildFallbackClarificationQuestion(
          'Kira could not read the main model clarification result. What should be clarified or changed in the brief before a worker starts?',
        ),
      ],
    };
  }
}

function validateWorkClarificationAnalysisFinal(content: string): string[] {
  const issues: string[] = [];
  let parsed: Partial<WorkClarificationAnalysis> & {
    questions?: Array<Partial<WorkClarificationQuestion>>;
  };

  try {
    parsed = JSON.parse(extractJson(content)) as Partial<WorkClarificationAnalysis> & {
      questions?: Array<Partial<WorkClarificationQuestion>>;
    };
  } catch {
    return [
      'Return a valid JSON object with needsClarification, confidence, summary, and questions.',
    ];
  }

  if (typeof parsed.needsClarification !== 'boolean') {
    issues.push('needsClarification must be a boolean.');
  }
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)) {
    issues.push('confidence must be a finite number between 0 and 1.');
  }
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
    issues.push('summary must be a non-empty string.');
  }
  if (!Array.isArray(parsed.questions)) {
    issues.push('questions must be an array.');
  }

  if (parsed.needsClarification === true) {
    const usableQuestions = (Array.isArray(parsed.questions) ? parsed.questions : []).filter(
      (question) => typeof question?.question === 'string' && question.question.trim(),
    );
    if (usableQuestions.length === 0) {
      issues.push('When needsClarification is true, include at least one usable question.');
    }
  }

  return issues;
}

function buildWorkClarificationPrompt(work: WorkTask, projectOverview: string): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description || '(empty)'}`,
    `Project overview:\n${projectOverview}`,
    'Decide whether this work item is ready to hand to implementation workers.',
    'Ask clarification questions only when ambiguity would likely cause a worker to implement the wrong behavior, miss a key constraint, or choose between materially different product outcomes.',
    'Do not ask about details that a worker can safely infer from existing project code, tests, style, or common implementation practice.',
    `If clarification is needed, ask at most ${MAX_CLARIFICATION_QUESTIONS} high-signal questions.`,
    `Prefer multiple-choice questions with 2-${MAX_CLARIFICATION_OPTIONS} concise options whenever possible.`,
    'Use allowCustomAnswer=true when none of the options can safely cover the decision.',
    'Match the language of the work brief when writing questions and options.',
    'Return only JSON with this shape:',
    '{"needsClarification":true,"confidence":0.82,"summary":"string","questions":[{"id":"q1","question":"string","options":["..."],"allowCustomAnswer":true}]}',
    'If no clarification is needed, return:',
    '{"needsClarification":false,"confidence":0.9,"summary":"The brief is ready for worker assignment.","questions":[]}',
  ].join('\n\n');
}

function buildWorkClarificationSystemPrompt(): string {
  return [
    'You are Aoi, the main Kira orchestration model.',
    'Your job is to prevent bad worker assignments caused by underspecified or ambiguous work briefs.',
    'Be decisive: only interrupt the user for information that meaningfully changes implementation.',
    'Prefer objective multiple-choice questions over open-ended questions.',
    'Do not modify files.',
    'Do not wrap the final JSON in markdown fences.',
  ].join('\n');
}

function buildClarificationRequestComment(analysis: WorkClarificationAnalysis): string {
  return [
    'Clarification requested before worker assignment.',
    '',
    `Summary:\n${analysis.summary}`,
    '',
    `Questions:\n${analysis.questions
      .map((question, index) => {
        const options =
          question.options.length > 0
            ? question.options.map((option) => `  - ${option}`).join('\n')
            : '  - Free-form answer needed';
        return `${index + 1}. ${question.question}\n${options}`;
      })
      .join('\n\n')}`,
    '',
    'Answer in the Kira clarification panel, or update the work brief and save it again.',
  ].join('\n');
}

async function ensureWorkClarification(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  work: WorkTask,
  runtime: ReturnType<typeof getKiraRuntimeSettings>,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<WorkTask | null> {
  if (work.status !== 'todo') return work;

  const briefHash = hashWorkBrief(work);
  const current = work.clarification;
  if (current?.briefHash === briefHash && current.status !== 'pending') {
    return work;
  }
  if (current?.briefHash === briefHash && current.status === 'pending') {
    updateWork(options.sessionsDir, sessionPath, work.id, (existing) => ({
      ...existing,
      status: 'blocked',
    }));
    return null;
  }

  const projectOverview = buildProjectOverview(projectRoot);
  const raw = await runToolAgent(
    runtime.reviewerConfig!,
    projectRoot,
    buildWorkClarificationPrompt(work, projectOverview),
    buildWorkClarificationSystemPrompt(),
    false,
    signal,
    undefined,
    validateWorkClarificationAnalysisFinal,
  );
  const analysis = parseWorkClarificationAnalysis(raw);

  if (!analysis.needsClarification) {
    return (
      updateWork(options.sessionsDir, sessionPath, work.id, (existing) => ({
        ...existing,
        clarification: {
          status: 'cleared',
          briefHash,
          summary: analysis.summary,
          questions: [],
          createdAt: Date.now(),
        },
      })) ?? {
        ...work,
        clarification: {
          status: 'cleared',
          briefHash,
          summary: analysis.summary,
          questions: [],
          createdAt: Date.now(),
        },
      }
    );
  }

  const clarification: WorkClarificationState = {
    status: 'pending',
    briefHash,
    summary: analysis.summary,
    questions: analysis.questions,
    createdAt: Date.now(),
  };

  const updated = updateWork(options.sessionsDir, sessionPath, work.id, (existing) => ({
    ...existing,
    status: 'blocked',
    clarification,
  }));
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.reviewerAuthor,
    body: buildClarificationRequestComment(analysis),
  });
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: 'needs_attention',
    createdAt: Date.now(),
    message: `Kira 질문 필요: "${work.title}" 작업을 worker에게 넘기기 전에 확인할 내용이 있어요.`,
  });

  return updated?.status === 'todo' ? updated : null;
}

function formatList(items: string[], emptyLabel: string): string {
  if (items.length === 0) return `- ${emptyLabel}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function formatProjectContextScan(scan: ProjectContextScan): string {
  return [
    `Project context:\n- Root: ${scan.projectRoot}\n- Package manager: ${
      scan.packageManager ?? 'not detected'
    }`,
    `Workspace/config files:\n${formatList(scan.workspaceFiles, 'No common workspace files detected')}`,
    `Important package scripts:\n${formatList(scan.packageScripts, 'No test/lint/build/typecheck scripts detected')}`,
    `Existing changes:\n${formatList(scan.existingChanges, 'Clean worktree or no git changes detected')}`,
    `Search terms from brief:\n${formatList(scan.searchTerms, 'No search terms extracted')}`,
    `Likely files:\n${formatList(scan.likelyFiles, 'No likely file matches detected yet')}`,
    `Related docs:\n${formatList(scan.relatedDocs, 'No related docs detected')}`,
    `Related tests:\n${formatList(scan.testFiles, 'No related tests detected')}`,
    `Candidate checks:\n${formatList(scan.candidateChecks, 'No candidate checks detected')}`,
    `Context notes:\n${formatList(scan.notes, 'No context notes')}`,
  ].join('\n\n');
}

function collectPreflightPlanningIssues(
  contextScan: ProjectContextScan,
  plan: WorkerExecutionPlan,
  explorationActions: string[],
): string[] {
  const issues: string[] = [];

  issues.push(...plan.parseIssues);

  if (explorationActions.length === 0) {
    issues.push(
      'The preflight planner did not inspect the repository with list_files, search_files, or read_file before returning a plan.',
    );
  }

  if (contextScan.likelyFiles.length === 0 && explorationActions.length === 0) {
    issues.push(
      'No likely files were found from the initial context scan, so the planner must search or list the repository before choosing files.',
    );
  }

  if (plan.intendedFiles.length === 0) {
    issues.push('The preflight plan did not identify any intended files to inspect or edit.');
  }

  const protectedAndPlanned = plan.intendedFiles.filter((plannedFile) =>
    isProtectedFile(plan, plannedFile),
  );
  if (protectedAndPlanned.length > 0) {
    issues.push(
      `The preflight plan lists files as both intendedFiles and protectedFiles: ${protectedAndPlanned.join(', ')}`,
    );
  }

  return issues;
}

function parseStoredList(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(
      (line) =>
        line !== '' && !/^No .* reported$/i.test(line) && line.toLowerCase() !== 'none reported',
    );
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

  const trailingLabels = [
    'Files changed',
    'Checks',
    'Remaining risks',
    'Validation gaps',
    'Out-of-plan files',
  ];
  const summary = extractSection(body, 'Summary', trailingLabels);
  return {
    summary: summary || 'No worker summary provided.',
    filesChanged: parseStoredList(
      extractSection(body, 'Files changed', [
        'Checks',
        'Remaining risks',
        'Validation gaps',
        'Out-of-plan files',
      ]),
    ),
    testsRun: parseStoredList(
      extractSection(body, 'Checks', ['Remaining risks', 'Validation gaps', 'Out-of-plan files']),
    ),
    remainingRisks: parseStoredList(
      extractSection(body, 'Remaining risks', ['Validation gaps', 'Out-of-plan files']),
    ),
  };
}

export function findSuggestedCommitBackfillSummary(comments: TaskComment[]): WorkerSummary | null {
  const approvalIndex = [...comments]
    .map((comment, index) => ({ comment, index }))
    .reverse()
    .find(
      ({ comment }) => isReviewerAuthor(comment.author) && comment.body.startsWith('Approved.'),
    )?.index;

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
  const type =
    /fix|bug|error|repair|patch|hotfix|버그|수정/.test(work.title.toLowerCase()) ||
    /fix|bug|error|repair|patch|hotfix/.test(fileList)
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
    .map((line): GitStatusEntry | null => {
      let status = line.slice(0, 2);
      let rawPath = '';

      if (line.length >= 4 && line[2] === ' ') {
        rawPath = line.slice(3);
      } else {
        const compactMatch = line.match(/^(\S{1,2})\s+(.+)$/);
        if (!compactMatch) return null;
        status = compactMatch[1].padEnd(2, ' ');
        rawPath = compactMatch[2];
      }

      const normalizedPath = rawPath.trim().replace(/\\/g, '/');
      return {
        status,
        path: normalizedPath.includes(' -> ')
          ? (normalizedPath.split(' -> ').pop() ?? normalizedPath)
          : normalizedPath,
      };
    })
    .filter((entry): entry is GitStatusEntry => Boolean(entry?.path));
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

async function isGitWorktree(projectRoot: string): Promise<boolean> {
  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export function shouldUseKiraIsolatedWorktree(
  projectRoot: string,
  projectSettings: { autoCommit?: boolean },
): boolean {
  return (
    Boolean(projectRoot) &&
    projectSettings.autoCommit === true &&
    fs.existsSync(join(projectRoot, '.git'))
  );
}

export function shouldUseKiraAttemptWorktrees(
  projectRoot: string,
  projectSettings: { autoCommit?: boolean },
  workerCount: number,
): boolean {
  return (
    Boolean(projectRoot) &&
    fs.existsSync(join(projectRoot, '.git')) &&
    (projectSettings.autoCommit === true || workerCount > 1)
  );
}

function buildKiraWorktreeBranchName(work: WorkTask, label?: string): string {
  const titleSlug = toKebabCase(work.title) || 'work';
  const workSlug = sanitizeLockKey(work.id).slice(0, 32);
  const labelSlug = label ? `-${sanitizeLockKey(label).slice(0, 24)}` : '';
  return `codex/kira-${titleSlug}-${workSlug}${labelSlug}-${Date.now().toString(36)}`;
}

async function createKiraWorktreeSession(
  primaryRoot: string,
  sessionsDir: string,
  sessionPath: string,
  work: WorkTask,
  projectSettings: { autoCommit: boolean },
  options: { force?: boolean; label?: string } = {},
): Promise<KiraWorkspaceSession> {
  if (!(options.force || projectSettings.autoCommit) || !(await isGitWorktree(primaryRoot))) {
    return { primaryRoot, projectRoot: primaryRoot, isolated: false };
  }

  const worktreesDir = getKiraWorktreesDir(sessionsDir, sessionPath);
  fs.mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = join(
    worktreesDir,
    [
      sanitizeLockKey(work.projectName),
      sanitizeLockKey(work.id),
      options.label ? sanitizeLockKey(options.label) : '',
      Date.now().toString(36),
    ]
      .filter(Boolean)
      .join('-'),
  );
  const branchName = buildKiraWorktreeBranchName(work, options.label);

  try {
    await runGitCommand(primaryRoot, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    return {
      primaryRoot,
      projectRoot: worktreePath,
      isolated: true,
      worktreePath,
      branchName,
    };
  } catch {
    return { primaryRoot, projectRoot: primaryRoot, isolated: false };
  }
}

async function cleanupKiraWorktreeSession(session: KiraWorkspaceSession): Promise<void> {
  if (!session.isolated || !session.worktreePath) return;
  try {
    await runGitCommand(session.primaryRoot, [
      'worktree',
      'remove',
      '--force',
      session.worktreePath,
    ]);
  } catch {
    // Keep going so a stale branch does not block the automation loop cleanup.
  }
  if (session.branchName) {
    try {
      await runGitCommand(session.primaryRoot, ['branch', '-D', session.branchName]);
    } catch {
      // The branch may already be gone or still useful for manual recovery.
    }
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
    if (isGeneratedArtifactPath(entry.path)) continue;
    const previousStatus = beforeMap.get(entry.path);
    if (previousStatus !== entry.status) {
      touched.add(entry.path);
    }
  }

  return [...touched].sort();
}

export function isGeneratedArtifactPath(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  return (
    normalized === '.ds_store' ||
    normalized.endsWith('/.ds_store') ||
    normalized.startsWith('__pycache__/') ||
    normalized.includes('/__pycache__/') ||
    normalized.endsWith('.pyc') ||
    normalized.startsWith('.pytest_cache/') ||
    normalized.startsWith('.mypy_cache/')
  );
}

export function resolveAttemptChangedFiles(
  touchedFiles: string[],
  reportedFiles: string[],
  patchedFiles: string[],
): string[] {
  const observedFiles = normalizePathList([...touchedFiles, ...patchedFiles], 200).filter(
    (filePath) => !isGeneratedArtifactPath(filePath),
  );
  return observedFiles.length > 0
    ? observedFiles
    : normalizePathList(reportedFiles, 200).filter(
        (filePath) => !isGeneratedArtifactPath(filePath),
      );
}

export function filterStageableChangedFiles(
  filesChanged: string[],
  statusEntries: GitStatusEntry[] | null,
): { targetFiles: string[]; ignoredFiles: string[] } {
  const normalizedFiles = normalizePathList(filesChanged, 200).filter(
    (filePath) => !isGeneratedArtifactPath(filePath),
  );
  if (!statusEntries) {
    return { targetFiles: normalizedFiles, ignoredFiles: [] };
  }

  const dirtyFiles = new Set(
    statusEntries
      .map((entry) => normalizeRelativePath(entry.path))
      .filter((filePath) => filePath && !isGeneratedArtifactPath(filePath)),
  );
  return {
    targetFiles: normalizedFiles.filter((filePath) => dirtyFiles.has(filePath)),
    ignoredFiles: normalizedFiles.filter((filePath) => !dirtyFiles.has(filePath)),
  };
}

async function getTrackedHeadFile(
  projectRoot: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const content = await runGitCommand(projectRoot, [
      'show',
      `HEAD:${relativePath.replace(/\\/g, '/')}`,
    ]);
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
      issues.push(
        `High-risk file ${relativePath} still contains a placeholder or corruption marker.`,
      );
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
          error && typeof error === 'object' && 'stderr' in error
            ? String(error.stderr).trim()
            : '';
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

async function collectPatchValidationIssues(
  projectRoot: string,
  filesChanged: string[],
): Promise<string[]> {
  const issues: string[] = [];
  const normalizedFiles = uniqueStrings(filesChanged.map((file) => normalizeRelativePath(file)));

  for (const relativePath of normalizedFiles) {
    if (!relativePath) continue;
    const absolutePath = ensureInsideRoot(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (hasMergeConflictMarkers(content)) {
      issues.push(`Merge conflict markers detected in ${relativePath}.`);
    }
  }

  if (normalizedFiles.length === 0) return issues;

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
    const diffCheck = await runGitCommand(projectRoot, [
      'diff',
      '--check',
      '--',
      ...normalizedFiles,
    ]);
    if (diffCheck.trim()) {
      issues.push(
        `git diff --check reported patch problems:\n${truncateForReview(diffCheck, 500)}`,
      );
    }
  } catch {
    // Non-git projects or unavailable git diff checks are ignored here.
  }

  return issues;
}

async function rerunValidationCommands(
  projectRoot: string,
  commands: string[],
): Promise<ValidationRerunSummary> {
  const plannedCommands = uniqueStrings(
    commands.map((command) => normalizeWhitespace(command)),
  ).filter(Boolean);
  const passed: string[] = [];
  const failed: string[] = [];
  const failureDetails: string[] = [];

  for (const command of plannedCommands) {
    if (!isSafeCommandAllowed(command)) {
      failed.push(command);
      failureDetails.push(`Command: ${command}\n\nError: Rejected by Kira safety policy.`);
      continue;
    }

    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    try {
      await execAsync(command, {
        cwd: projectRoot,
        shell,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      passed.push(command);
    } catch (error) {
      failed.push(command);
      failureDetails.push(formatCommandFailureDetail(command, error));
    }
  }

  return { passed, failed, failureDetails };
}

async function collectReviewerDiffExcerpts(
  projectRoot: string,
  filesChanged: string[],
): Promise<string[]> {
  const normalizedFiles = uniqueStrings(
    filesChanged.map((file) => normalizeRelativePath(file)),
  ).filter(Boolean);
  if (normalizedFiles.length === 0) return [];

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return [];
  }

  const excerpts: string[] = [];
  for (const relativePath of normalizedFiles) {
    try {
      const diff = await runGitCommand(projectRoot, ['diff', '--unified=1', '--', relativePath]);
      if (!diff.trim()) continue;
      excerpts.push(`File: ${relativePath}\n${truncateForReview(diff, MAX_REVIEW_DIFF_CHARS)}`);
    } catch {
      // Ignore per-file diff failures and continue collecting what is available.
    }
  }

  return excerpts;
}

export function collectAttemptReviewabilityIssues(params: {
  rawWorkerOutput?: string;
  workerSummary: Pick<WorkerSummary, 'summary' | 'filesChanged'>;
  workerPlan?: Pick<WorkerExecutionPlan, 'intendedFiles'> | null;
  diffExcerpts: string[];
  gitDiffAvailable: boolean;
}): string[] {
  const issues: string[] = [];
  const raw = params.rawWorkerOutput?.trim() ?? '';
  const filesChanged = normalizePathList(params.workerSummary.filesChanged ?? [], 200);
  const intendedFiles = normalizePathList(params.workerPlan?.intendedFiles ?? [], 200);
  const summary = params.workerSummary.summary.trim();

  if (!raw) {
    issues.push(
      'Worker returned an empty final submission, so Kira cannot verify the attempt summary or validation evidence.',
    );
  } else if (!summary || summary === 'No worker summary provided.') {
    issues.push('Worker final submission did not include a usable summary.');
  }

  if (intendedFiles.length > 0 && filesChanged.length === 0) {
    issues.push(
      `Worker planned edits to ${intendedFiles.join(', ')} but produced no changed files.`,
    );
  }

  if (params.gitDiffAvailable && filesChanged.length > 0 && params.diffExcerpts.length === 0) {
    issues.push(
      `Kira detected changed files (${filesChanged.join(', ')}) but could not collect a git diff; the attempt cannot be reviewed safely.`,
    );
  }

  return uniqueStrings(issues);
}

function collectPlanGuardrailIssues(
  projectRoot: string,
  plan: WorkerExecutionPlan | null,
  filesChanged: string[],
  commandsRun: string[],
): string[] {
  if (!plan) return [];

  const issues: string[] = [];
  const outOfPlanFiles = findOutOfPlanTouchedFiles(plan.intendedFiles, filesChanged);
  const highRiskOutOfPlan = outOfPlanFiles.filter((file) => isHighRiskFile(projectRoot, file));
  if (highRiskOutOfPlan.length > 0) {
    issues.push(
      `High-risk files were modified outside the approved plan: ${highRiskOutOfPlan.join(', ')}`,
    );
  } else if (outOfPlanFiles.length >= 4) {
    issues.push(
      `Too many files were modified outside the approved plan: ${outOfPlanFiles.join(', ')}`,
    );
  }

  const highRiskTouched = uniqueStrings(
    filesChanged.filter((file) => isHighRiskFile(projectRoot, file)),
  );
  const missingValidationCommands = findMissingValidationCommands(
    plan.validationCommands,
    commandsRun,
  );
  if (
    highRiskTouched.length > 0 &&
    plan.validationCommands.length > 0 &&
    missingValidationCommands.length === plan.validationCommands.length
  ) {
    issues.push(
      `Worker skipped all planned validation commands after changing high-risk files: ${highRiskTouched.join(', ')}`,
    );
  }

  return issues;
}

function getDirtyWorktreePaths(entries: GitStatusEntry[] | null): string[] {
  if (!entries) return [];
  return uniqueStrings(
    entries
      .map((entry) => normalizeRelativePath(entry.path))
      .filter(Boolean)
      .filter((filePath) => !isGeneratedArtifactPath(filePath)),
  );
}

function collectDirtyFileGuardrailIssues(
  plan: WorkerExecutionPlan | null,
  dirtyFiles: string[],
  filesChanged: string[],
): string[] {
  if (!plan) return [];
  const changedDirtyFiles = normalizePathList(filesChanged, 200).filter((file) =>
    dirtyFiles.includes(file),
  );
  const unplannedDirtyFiles = changedDirtyFiles.filter((file) => !isPlannedFile(plan, file));
  const protectedDirtyFiles = changedDirtyFiles.filter((file) => isProtectedFile(plan, file));
  return [
    ...protectedDirtyFiles.map((file) => `Protected dirty file was modified: ${file}`),
    ...unplannedDirtyFiles.map(
      (file) => `Pre-existing dirty file was modified outside intendedFiles: ${file}`,
    ),
  ];
}

function buildReviewRecord(
  workId: string,
  attemptNo: number,
  reviewSummary: ReviewSummary,
): KiraReviewRecord {
  return {
    id: `${workId}-${attemptNo}`,
    workId,
    attemptNo,
    approved: reviewSummary.approved,
    createdAt: Date.now(),
    summary: reviewSummary.summary,
    findings: reviewSummary.findings,
    missingValidation: reviewSummary.missingValidation,
    nextWorkerInstructions: reviewSummary.nextWorkerInstructions,
    residualRisk: reviewSummary.residualRisk,
    filesChecked: reviewSummary.filesChecked,
  };
}

function enforceReviewDecision(summary: ReviewSummary): ReviewSummary {
  const blockingIssues = [
    ...summary.findings.map((finding) =>
      [finding.file, finding.line ? `line ${finding.line}` : '', finding.message]
        .filter(Boolean)
        .join(': '),
    ),
    ...summary.missingValidation.map((command) => `Missing validation: ${command}`),
  ];
  if (summary.approved && blockingIssues.length > 0) {
    return {
      ...summary,
      approved: false,
      issues: uniqueStrings([...summary.issues, ...blockingIssues]),
      summary: `${summary.summary}\n\nKira changed this review to request changes because the structured review included blocking findings or missing validation.`,
    };
  }
  return summary;
}

function buildAttemptRecord(params: {
  workId: string;
  attemptNo: number;
  status: KiraAttemptRecord['status'];
  startedAt: number;
  contextScan: ProjectContextScan;
  workerPlan: WorkerExecutionPlan;
  planningState: WorkerAttemptState;
  attemptState?: WorkerAttemptState | null;
  workerSummary?: WorkerSummary;
  validationReruns?: ValidationRerunSummary;
  outOfPlanFiles?: string[];
  validationGaps?: string[];
  risks?: string[];
  diffExcerpts?: string[];
  rawWorkerOutput?: string;
  blockedReason?: string;
  rollbackFiles?: string[];
}): KiraAttemptRecord {
  const attemptState = params.attemptState ?? null;
  return {
    id: `${params.workId}-${params.attemptNo}`,
    workId: params.workId,
    attemptNo: params.attemptNo,
    status: params.status,
    startedAt: params.startedAt,
    finishedAt: Date.now(),
    contextScan: params.contextScan,
    workerPlan: params.workerPlan,
    preflightExploration: uniqueStrings(params.planningState.explorationActions),
    readFiles: attemptState ? [...attemptState.readFiles].sort() : [],
    patchedFiles: attemptState ? [...attemptState.patchedFiles].sort() : [],
    changedFiles: params.workerSummary?.filesChanged ?? [],
    commandsRun: attemptState
      ? [...attemptState.commandsRun]
      : uniqueStrings(params.planningState.commandsRun),
    validationReruns: params.validationReruns ?? { passed: [], failed: [], failureDetails: [] },
    outOfPlanFiles: params.outOfPlanFiles ?? [],
    validationGaps: params.validationGaps ?? [],
    risks: params.risks ?? [],
    ...(params.diffExcerpts ? { diffExcerpts: params.diffExcerpts } : {}),
    ...(params.rawWorkerOutput !== undefined ? { rawWorkerOutput: params.rawWorkerOutput } : {}),
    ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    ...(params.rollbackFiles ? { rollbackFiles: params.rollbackFiles } : {}),
  };
}

function saveAttemptRecord(
  sessionsDir: string,
  sessionPath: string,
  record: KiraAttemptRecord,
): void {
  writeJsonFile(
    join(getKiraAttemptsDir(sessionsDir, sessionPath), `${record.workId}-${record.attemptNo}.json`),
    record,
  );
}

function saveReviewRecord(
  sessionsDir: string,
  sessionPath: string,
  record: KiraReviewRecord,
): void {
  writeJsonFile(
    join(getKiraReviewsDir(sessionsDir, sessionPath), `${record.workId}-${record.attemptNo}.json`),
    record,
  );
}

export function buildIssueSignature(issues: string[], summary: string): string {
  const normalized = (issues.length > 0 ? issues : [summary])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return normalized.join(' | ');
}

export function resolveUnexpectedAutomationFailure(
  workTitle: string,
  errorMessage: string,
): AutomationFailureResolution {
  const normalizedMessage = errorMessage.trim() || 'Unknown automation error.';
  const missingCredentialFailure =
    /\bapi key\b/i.test(normalizedMessage) ||
    /\brequired api keys?\b/i.test(normalizedMessage) ||
    /\bcredentials?\b/i.test(normalizedMessage) ||
    /\btoken\b/i.test(normalizedMessage);

  if (missingCredentialFailure) {
    return {
      summary:
        'Automation blocked because the task depends on missing API keys or external credentials.',
      guidance:
        'Add the required API keys or credentials in the target project, or revise the work so that startup generation and other credential-gated steps are not required before retrying.',
      userMessage: `Kira blocked: "${workTitle}" 작업은 필요한 API 키 또는 외부 인증 정보가 없어 자동으로 멈췄어요.`,
    };
  }

  return {
    summary:
      'Automation failed unexpectedly, and Kira blocked the task to avoid repeating the same failure.',
    guidance:
      'Inspect the underlying error, fix the project or task brief, and then manually move the work out of Blocked before retrying.',
    userMessage: `Kira blocked: "${workTitle}" 작업이 예기치 않은 오류로 중단되어 같은 실패를 반복하지 않도록 멈췄어요.`,
  };
}

async function autoCommitApprovedWork(
  workspace: KiraWorkspaceSession,
  filesChanged: string[],
  commitMessage: string,
  defaultProjectSettings: { autoCommit?: boolean } = {},
  integrationLockPath?: string,
): Promise<{ status: 'committed' | 'skipped' | 'failed'; message: string; commitHash?: string }> {
  const projectRoot = workspace.projectRoot;
  const projectSettings = loadProjectSettings(workspace.primaryRoot, defaultProjectSettings);
  if (!projectSettings.autoCommit) {
    return { status: 'skipped', message: 'Project settings disabled auto-commit.' };
  }

  const normalizedFiles = normalizePathList(filesChanged, 200);
  if (normalizedFiles.length === 0) {
    return { status: 'skipped', message: 'No changed files were reported for this work.' };
  }

  try {
    await runGitCommand(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { status: 'skipped', message: 'Project root is not a git repository.' };
  }

  let projectLocalFiles: string[] = [];
  try {
    projectLocalFiles = normalizedFiles
      .map((filePath) => ensureInsideRoot(projectRoot, filePath))
      .map((absolutePath) =>
        absolutePath
          .slice(resolve(projectRoot).length)
          .replace(/^[\\/]+/, '')
          .replace(/\\/g, '/'),
      )
      .filter(Boolean);
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const { targetFiles, ignoredFiles } = filterStageableChangedFiles(
    projectLocalFiles,
    await getGitWorktreeEntries(projectRoot),
  );
  if (targetFiles.length === 0) {
    return {
      status: 'skipped',
      message: `No stageable project-local files were eligible for auto-commit.${formatIgnoredIntegrationPaths(
        ignoredFiles,
      )}`,
    };
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
      return {
        status: 'skipped',
        message: 'There were no stageable changes for the reported files.',
      };
    }

    await runGitCommand(projectRoot, ['commit', '-m', commitMessage]);
    const commitHash = await runGitCommand(projectRoot, ['rev-parse', '--short', 'HEAD']);

    if (workspace.isolated) {
      const integrationOwner = `${SERVER_INSTANCE_ID}:${commitHash}:${Date.now()}`;
      if (
        integrationLockPath &&
        !tryAcquireLock(integrationLockPath, {
          ownerId: integrationOwner,
          resource: 'project',
          sessionPath: 'git-integration',
          targetKey: workspace.primaryRoot,
        })
      ) {
        return {
          status: 'failed',
          message:
            'Auto-commit created an isolated worktree commit, but could not acquire the project integration lock. The Kira worktree was kept for manual recovery.',
          commitHash: commitHash || undefined,
        };
      }

      try {
        const primaryStaged = await runGitCommand(workspace.primaryRoot, [
          'diff',
          '--cached',
          '--name-only',
        ]);
        if (primaryStaged.trim()) {
          return {
            status: 'failed',
            message:
              'Auto-commit created an isolated worktree commit, but integration was stopped because the primary worktree already has staged changes.',
            commitHash: commitHash || undefined,
          };
        }

        const primaryDirtyEntries = await getGitWorktreeEntries(workspace.primaryRoot);
        const primaryDirtyFiles = getDirtyWorktreePaths(primaryDirtyEntries);
        const conflictingDirtyFiles = targetFiles.filter((filePath) =>
          primaryDirtyFiles.includes(filePath),
        );
        if (conflictingDirtyFiles.length > 0) {
          return {
            status: 'failed',
            message: [
              'Auto-commit created an isolated worktree commit, but integration was stopped because the primary worktree has overlapping dirty files.',
              `Conflicting files: ${conflictingDirtyFiles.join(', ')}`,
              'The Kira worktree was kept for manual recovery.',
            ].join(' '),
            commitHash: commitHash || undefined,
          };
        }

        try {
          await runGitCommand(workspace.primaryRoot, ['cherry-pick', commitHash]);
        } catch (error) {
          try {
            await runGitCommand(workspace.primaryRoot, ['cherry-pick', '--abort']);
          } catch {
            // If abort fails, report the original cherry-pick failure below.
          }
          return {
            status: 'failed',
            message: [
              'Auto-commit created an isolated worktree commit, but cherry-pick integration failed.',
              error instanceof Error ? error.message : String(error),
              'The Kira worktree was kept for manual conflict recovery.',
            ].join('\n\n'),
            commitHash: commitHash || undefined,
          };
        }
      } finally {
        if (integrationLockPath) {
          releaseLock(integrationLockPath, integrationOwner);
        }
      }
    }

    return {
      status: 'committed',
      message: workspace.isolated
        ? `Committed in an isolated Kira worktree and integrated into the primary worktree as ${commitHash}.${formatIgnoredIntegrationPaths(
            ignoredFiles,
          )}`
        : `Committed the approved changes as ${commitHash}.${formatIgnoredIntegrationPaths(
            ignoredFiles,
          )}`,
      commitHash: commitHash || undefined,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensurePrimaryWorktreeCanIntegrate(
  workspace: KiraWorkspaceSession,
  targetFiles: string[],
): Promise<string | null> {
  const primaryStaged = await runGitCommand(workspace.primaryRoot, [
    'diff',
    '--cached',
    '--name-only',
  ]);
  if (primaryStaged.trim()) {
    return 'Integration stopped because the primary worktree already has staged changes.';
  }

  const primaryDirtyEntries = await getGitWorktreeEntries(workspace.primaryRoot);
  const primaryDirtyFiles = getDirtyWorktreePaths(primaryDirtyEntries);
  const conflictingDirtyFiles = targetFiles.filter((filePath) =>
    primaryDirtyFiles.includes(filePath),
  );
  if (conflictingDirtyFiles.length > 0) {
    return [
      'Integration stopped because the primary worktree has overlapping dirty files.',
      `Conflicting files: ${conflictingDirtyFiles.join(', ')}`,
    ].join(' ');
  }

  return null;
}

async function integrateApprovedWorktreeChanges(
  workspace: KiraWorkspaceSession,
  filesChanged: string[],
  commitMessage: string,
  integrationLockPath?: string,
): Promise<{ status: 'integrated' | 'skipped' | 'failed'; message: string; commitHash?: string }> {
  if (!workspace.isolated) {
    return {
      status: 'skipped',
      message: 'The approved attempt already ran in the primary worktree.',
    };
  }

  const projectLocalFiles = normalizePathList(filesChanged, 200);
  if (projectLocalFiles.length === 0) {
    return { status: 'skipped', message: 'No changed files were reported for integration.' };
  }

  const { targetFiles, ignoredFiles } = filterStageableChangedFiles(
    projectLocalFiles,
    await getGitWorktreeEntries(workspace.projectRoot),
  );
  if (targetFiles.length === 0) {
    return {
      status: 'skipped',
      message: `No stageable changed files were available to integrate.${formatIgnoredIntegrationPaths(
        ignoredFiles,
      )}`,
    };
  }

  const integrationOwner = `${SERVER_INSTANCE_ID}:no-commit:${Date.now()}`;
  if (
    integrationLockPath &&
    !tryAcquireLock(integrationLockPath, {
      ownerId: integrationOwner,
      resource: 'project',
      sessionPath: 'git-integration',
      targetKey: workspace.primaryRoot,
    })
  ) {
    return {
      status: 'failed',
      message:
        'Could not acquire the project integration lock. The winning Kira worktree was kept for manual recovery.',
    };
  }

  try {
    const blocker = await ensurePrimaryWorktreeCanIntegrate(workspace, targetFiles);
    if (blocker) {
      return {
        status: 'failed',
        message: `${blocker} The winning Kira worktree was kept for manual recovery.`,
      };
    }

    await runGitCommand(workspace.projectRoot, ['add', '--', ...targetFiles]);
    const staged = await runGitCommand(workspace.projectRoot, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      return { status: 'skipped', message: 'No staged changes were available to integrate.' };
    }
    await runGitCommand(workspace.projectRoot, ['commit', '-m', commitMessage]);
    const commitHash = await runGitCommand(workspace.projectRoot, ['rev-parse', '--short', 'HEAD']);

    try {
      await runGitCommand(workspace.primaryRoot, ['cherry-pick', '--no-commit', commitHash]);
    } catch (error) {
      try {
        await runGitCommand(workspace.primaryRoot, ['cherry-pick', '--abort']);
      } catch {
        // Preserve the original cherry-pick error below.
      }
      return {
        status: 'failed',
        message: [
          'Cherry-pick integration failed.',
          error instanceof Error ? error.message : String(error),
          'The winning Kira worktree was kept for manual conflict recovery.',
        ].join('\n\n'),
        commitHash: commitHash || undefined,
      };
    }

    return {
      status: 'integrated',
      message: `Integrated the winning isolated attempt into the primary worktree without creating a final commit. Temporary attempt commit: ${commitHash}.${formatIgnoredIntegrationPaths(
        ignoredFiles,
      )}`,
      commitHash: commitHash || undefined,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (integrationLockPath) {
      releaseLock(integrationLockPath, integrationOwner);
    }
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

function tryAcquireLock(
  lockPath: string,
  record: Omit<AutomationLockRecord, 'acquiredAt' | 'heartbeatAt'>,
): boolean {
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

function getProjectKey(
  workRootDirectory: string | null,
  work: WorkTask,
  sessionPath: string,
): string {
  if (workRootDirectory?.trim() && work.projectName.trim()) {
    return resolveKiraProjectRoot(workRootDirectory, work.projectName).toLowerCase();
  }

  return `${sanitizeSessionPath(sessionPath)}::${work.projectName.toLowerCase()}`;
}

function buildProjectOverview(projectRoot: string): string {
  const topLevelEntries: string[] = [];
  collectFiles(projectRoot, projectRoot, 1, topLevelEntries);

  const snippets: string[] = [];
  for (const candidate of [
    'README.md',
    'README.ko.md',
    'package.json',
    'requirements.txt',
    'main.py',
  ]) {
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
    .filter(
      (entry) => fs.existsSync(entry.absolutePath) && fs.statSync(entry.absolutePath).isFile(),
    );

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

export function buildWorkerPlanningPrompt(
  work: WorkTask,
  projectOverview: string,
  contextScan: ProjectContextScan,
  feedback: string[],
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description}`,
    `Project overview:\n${projectOverview}`,
    `Project context scan:\n${formatProjectContextScan(contextScan)}`,
    feedback.length > 0
      ? `Review feedback to address:\n${feedback.map((item) => `- ${item}`).join('\n')}`
      : '',
    'Inspect the project in read-only mode and create a focused implementation plan before any edits happen.',
    'Use the context scan as a starting point, but verify relevant files yourself before planning edits.',
    'Call at least one read-only tool such as list_files, search_files, or read_file before returning the final plan.',
    'If likely relevant files are empty or weak, search/read the repository before returning a plan.',
    'Treat existing git changes as user or prior automation work unless inspection proves they are part of this task.',
    'List only the files you currently expect to edit; keep the list small and concrete.',
    'Use protectedFiles for existing dirty files or user-owned files that must not be touched by this attempt.',
    'List validationCommands using only task-specific safe diagnostics or test commands that the worker can run later.',
    `Keep validationCommands short: no more than ${MAX_PLANNER_VALIDATION_COMMANDS} commands.`,
    'Kira will automatically add a small project-default validation set, so do not spend slots on generic repo-wide checks unless they are directly needed for this task.',
    'Use riskNotes for tricky areas, compatibility concerns, or reasons the reviewer should pay extra attention.',
    'Use stopConditions for situations where the worker must stop rather than continue making edits.',
    'Return only JSON with this shape:',
    '{"understanding":"string","repoFindings":["..."],"summary":"string","intendedFiles":["..."],"protectedFiles":["..."],"validationCommands":["..."],"riskNotes":["..."],"stopConditions":["..."]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildWorkerPlanningSystemPrompt(): string {
  return [
    'You are Kira Preflight Planner, a careful read-only planning agent.',
    'Before planning, inspect repository structure and relevant files with read-only tools.',
    'Never return the final plan before using list_files, search_files, or read_file, unless you are an external CLI agent that has already inspected the filesystem directly.',
    'Identify existing user changes and mark files that must not be overwritten as protectedFiles.',
    'Produce a structured plan with intended files, validation commands, risks, and stop conditions.',
    'Do not modify files.',
    'Prefer existing project patterns over new abstractions.',
    'Prefer a narrow file list over a broad one.',
    'Return concrete repoFindings based on files or searches you actually inspected.',
    'Do not invent inspected files, checks, or repository facts.',
    `Return at most ${MAX_PLANNER_VALIDATION_COMMANDS} validation commands.`,
    'Only suggest validation commands that are safe and diagnostic in nature, such as pytest, python -m pytest/unittest/compileall, npm or pnpm test/lint/build/typecheck, node --test, git status/diff/show, rg, go test/vet, cargo test/check/clippy/fmt, or dotnet test/build.',
    'Define stopConditions for blocked protected files, unclear requirements, unsafe required commands, or missing context that cannot be resolved with read-only inspection.',
    'Do not wrap the final JSON in markdown fences.',
  ].join('\n');
}

export function buildWorkerPrompt(
  work: WorkTask,
  projectOverview: string,
  contextScan: ProjectContextScan,
  plan: WorkerExecutionPlan | null,
  feedback: string[],
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Work brief:\n${work.description}`,
    `Project overview:\n${projectOverview}`,
    `Project context scan:\n${formatProjectContextScan(contextScan)}`,
    plan ? `Plan understanding:\n${plan.understanding}` : '',
    plan ? `Plan repo findings:\n${formatList(plan.repoFindings, 'No repo findings')}` : '',
    plan ? `Execution plan summary:\n${plan.summary}` : '',
    plan ? `Planned files:\n${formatList(plan.intendedFiles, 'No planned files')}` : '',
    plan ? `Protected files:\n${formatList(plan.protectedFiles, 'No protected files')}` : '',
    plan
      ? `Planned validation commands:\n${formatList(
          plan.validationCommands,
          'No planned validation commands',
        )}`
      : '',
    plan ? `Planner risk notes:\n${formatList(plan.riskNotes, 'No planner risks reported')}` : '',
    plan ? `Stop conditions:\n${formatList(plan.stopConditions, 'No stop conditions')}` : '',
    feedback.length > 0
      ? `Review feedback to address:\n${feedback.map((item) => `- ${item}`).join('\n')}`
      : '',
    'Modify the project directly using the available tools.',
    'Before editing, inspect the files that matter for this task, especially files from the context scan and planned file list.',
    'Use existing project patterns and local helpers before introducing new abstractions.',
    'Stay within the planned files whenever practical. If you must expand scope, inspect the extra file first and keep the change justified and minimal.',
    'Never edit protectedFiles. Stop and report the blocker if a protected file must change.',
    'Do not touch out-of-plan files unless necessary and explained by the final summary.',
    'Read high-risk existing files with read_file before editing or overwriting them.',
    'For existing files, prefer edit_file with exact replacements.',
    'If edit_file cannot match a planned file after you already read it, use write_file with the complete final file content; Kira only permits this full rewrite for read, planned, unprotected files within the file-size limit.',
    'Use write_file only for new files, small existing files, or a read planned file that genuinely needs a full rewrite.',
    'Do not treat other existing modified or untracked files in the project as something you must clean up unless the task explicitly asks for cleanup.',
    'When you report filesChanged, list the files you intentionally touched for this attempt, not unrelated pre-existing worktree noise.',
    'Run the planned validation commands when practical, plus focused checks needed by the actual changes.',
    'Never claim a check passed unless you ran it in this attempt or Kira provided the rerun result.',
    'If validation cannot be run, put the reason and residual risk in remainingRisks.',
    'When finished, return only JSON with this shape:',
    '{"summary":"string","filesChanged":["..."],"testsRun":["..."],"remainingRisks":["..."]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildWorkerSystemPrompt(): string {
  return [
    'You are Kira Worker, a careful implementation agent.',
    'Stay focused on the requested work item.',
    'Before editing, inspect repository structure and relevant files.',
    'Identify existing user changes and avoid overwriting them.',
    'Assume other Kira agents may be working in sibling git worktrees; only rely on the files and tool results in your current project root.',
    'Prefer small targeted edits over broad refactors.',
    'Prefer existing project patterns over new abstractions.',
    'Respect the preflight plan unless inspection shows a clearly necessary small expansion.',
    'Do not touch out-of-plan files unless necessary and explained.',
    'Never edit protectedFiles; stop and report the blocker instead.',
    'Read high-risk existing files before editing them.',
    'Prefer edit_file for modifying existing files, especially large or critical ones.',
    'When edit_file cannot safely match text in a file listed in intendedFiles, read the file and then use write_file with the complete final content instead of getting stuck on repeated failed replacements.',
    'Do not try to clean unrelated dirty-worktree files unless the work item explicitly requires it.',
    'Use write_file only when creating a new file, replacing a genuinely small file, or rewriting a read planned file with complete final content.',
    'Use run_command for safe checks only, and run planned validation commands when practical.',
    'Summarize changed files, checks run, failures, and remaining risks.',
    'Never claim a check passed unless you ran it or Kira provided the result.',
    'Do not mention markdown fences in your final answer.',
  ].join('\n');
}

export function buildReviewPrompt(
  work: WorkTask,
  projectOverview: string,
  contextScan: ProjectContextScan,
  plan: WorkerExecutionPlan | null,
  workerSummary: WorkerSummary,
  outOfPlanFiles: string[],
  missingValidationCommands: string[],
  validationPlan: ResolvedValidationPlan,
  validationReruns: ValidationRerunSummary,
  diffExcerpts: string[],
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Acceptance target:\n${work.description}`,
    `Project overview:\n${projectOverview}`,
    `Project context scan:\n${formatProjectContextScan(contextScan)}`,
    plan ? `Preflight understanding:\n${plan.understanding}` : '',
    plan ? `Repo findings:\n${formatList(plan.repoFindings, 'No repo findings')}` : '',
    plan ? `Preflight plan summary:\n${plan.summary}` : '',
    plan ? `Planned files:\n${formatList(plan.intendedFiles, 'No planned files')}` : '',
    plan ? `Protected files:\n${formatList(plan.protectedFiles, 'No protected files')}` : '',
    plan ? `Planned checks:\n${formatList(plan.validationCommands, 'No planned checks')}` : '',
    plan ? `Planner risk notes:\n${formatList(plan.riskNotes, 'No planner risks reported')}` : '',
    plan ? `Stop conditions:\n${formatList(plan.stopConditions, 'No stop conditions')}` : '',
    `Latest worker summary:\n${workerSummary.summary}`,
    `Files reported changed:\n${formatList(workerSummary.filesChanged, 'No files reported')}`,
    `Worker-reported checks:\n${formatList(workerSummary.testsRun, 'No checks reported')}`,
    `Kira auto-added validation checks:\n${formatList(
      validationPlan.autoAddedCommands,
      'No auto-added validation checks',
    )}`,
    `Kira effective validation plan:\n${formatList(
      validationPlan.effectiveCommands,
      'No effective validation commands',
    )}`,
    validationPlan.notes.length > 0
      ? `Validation plan notes:\n${formatList(validationPlan.notes, 'No validation plan notes')}`
      : '',
    `Kira-passed validation reruns:\n${formatList(
      validationReruns.passed,
      'No validation reruns passed',
    )}`,
    validationReruns.failed.length > 0
      ? `Kira validation reruns that failed:\n${formatList(
          validationReruns.failed,
          'No validation reruns failed',
        )}`
      : '',
    outOfPlanFiles.length > 0
      ? `Files changed outside the plan:\n${formatList(outOfPlanFiles, 'No out-of-plan files')}`
      : '',
    missingValidationCommands.length > 0
      ? `Planned checks the worker did not run:\n${formatList(
          missingValidationCommands,
          'No missing planned checks',
        )}`
      : '',
    diffExcerpts.length > 0
      ? `Git diff excerpts for this attempt:\n${diffExcerpts.join('\n\n')}`
      : '',
    'Review the current project state. Do not modify files.',
    'Review priorities: correctness and requirement coverage first, then regressions, data loss, security, concurrency, missing validation, and maintainability risks that affect real outcomes.',
    'Only the Kira-passed validation reruns count as verification evidence.',
    'Do not treat worker-reported checks as proof unless they also appear in the Kira-passed rerun list.',
    'Do not approve if Kira validation reruns failed or if missingValidation is required for confidence.',
    'Do not approve if the worker summary conflicts with the diff excerpts.',
    'Do not approve unexplained out-of-plan edits when they create concrete risk or obscure the requested outcome.',
    'Do NOT reject only because multiple project-local files changed, because the worker touched a file you did not expect, or because the git working tree already contains unrelated modified/untracked files.',
    'Treat out-of-plan edits or missing planned checks as risk signals to scrutinize, not automatic rejection reasons on their own.',
    'Do NOT enforce minimal-diff purity as a standalone requirement.',
    'Approve when the requested outcome is achieved and there is no clear regression or harmful side effect.',
    'Only request changes when the acceptance target is not met, the implementation is clearly risky, or there is a concrete user-facing/code-level regression.',
    'When requesting changes, provide concrete nextWorkerInstructions that the worker can execute immediately.',
    'Return only JSON with this shape:',
    '{"approved":true,"summary":"string","findings":[{"file":"path","line":1,"severity":"low|medium|high","message":"string"}],"missingValidation":["..."],"nextWorkerInstructions":["..."],"residualRisk":["..."],"issues":["..."],"filesChecked":["..."]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildReviewSystemPrompt(): string {
  return [
    'You are Kira Reviewer, an independent code reviewer.',
    'Review the implementation carefully against the requested result and real regressions.',
    'Prioritize correctness and requirement coverage.',
    'Then check regressions, data loss, security, concurrency, missing validation, and maintainability risks that affect real outcomes.',
    'Treat concurrent-agent integration risks, stale assumptions, and overlapping file edits as review risks when they affect correctness.',
    'Do not approve if validation failed.',
    'Do not approve if the worker summary conflicts with the diff or provided project state.',
    'Do not approve unexplained out-of-plan edits when they create concrete risk or obscure the requested outcome.',
    'Provide concrete nextWorkerInstructions when requesting changes.',
    'Do not fail a review only for scope broadness, extra project-local file edits, or unrelated pre-existing dirty-worktree files.',
    'Never edit files.',
    'Use read-only tools and safe commands only.',
    'Return only the requested structured JSON.',
  ].join('\n');
}

function buildAttemptComparisonReviewPrompt(
  work: WorkTask,
  attempts: KiraWorkerAttemptResult[],
): string {
  return [
    `Project: ${work.projectName}`,
    `Work title: ${work.title}`,
    `Acceptance target:\n${work.description}`,
    'Multiple isolated Kira workers produced independent attempts for the same work item.',
    'Compare the attempts against the acceptance target and choose the single best attempt only if it should be integrated.',
    'If every attempt has correctness, validation, or integration risks that should block integration, set approved to false and selectedAttemptNo to null.',
    ...attempts.map((attempt) =>
      [
        `Attempt ${attempt.attemptNo} (${attempt.lane.label})`,
        `Isolated worktree: ${attempt.workspace.projectRoot}`,
        `Plan:\n${attempt.workerPlan.summary}`,
        `Plan understanding:\n${attempt.workerPlan.understanding}`,
        `Files changed:\n${formatList(attempt.workerSummary.filesChanged, 'No files reported')}`,
        `Worker summary:\n${attempt.workerSummary.summary}`,
        `Validation passed:\n${formatList(attempt.validationReruns.passed, 'No validation reruns passed')}`,
        `Validation failed:\n${formatList(attempt.validationReruns.failed, 'No validation reruns failed')}`,
        `Out-of-plan files:\n${formatList(attempt.outOfPlanFiles, 'No out-of-plan files')}`,
        `Validation gaps:\n${formatList(attempt.missingValidationCommands, 'No missing planned checks')}`,
        `Risks:\n${formatList(
          [...attempt.workerSummary.remainingRisks, ...attempt.highRiskIssues],
          'No risks reported',
        )}`,
        attempt.diffExcerpts.length > 0
          ? `Git diff excerpts:\n${attempt.diffExcerpts.join('\n\n')}`
          : 'Git diff excerpts:\n- No diff excerpts available',
      ].join('\n\n'),
    ),
    'Selection rules:',
    '- approved=true requires selecting exactly one attemptNo from the listed attempts.',
    '- Prefer the attempt that best satisfies the work brief with the least concrete regression risk.',
    '- Do not approve an attempt only because it is smaller; approve it because it is correct and adequately validated.',
    '- Do not approve if validation failed, if the summary conflicts with the diff, or if integration risk is concrete.',
    '- If requesting another worker round, give nextWorkerInstructions that all workers can act on.',
    'Return only JSON with this shape:',
    '{"approved":true,"selectedAttemptNo":1,"summary":"string","issues":["..."],"nextWorkerInstructions":["..."],"residualRisk":["..."],"filesChecked":["..."]}',
  ].join('\n\n');
}

export function buildAttemptComparisonReviewSystemPrompt(): string {
  return [
    'You are Kira Reviewer, an independent code reviewer and attempt judge.',
    'Compare multiple isolated worker attempts for one task.',
    'Select one winning attempt only when it satisfies the requested outcome and has no blocking regression, validation, or integration risk.',
    'If no attempt is good enough, request another worker round with concrete shared instructions.',
    'Never edit files.',
    'Return only the requested structured JSON.',
  ].join('\n');
}

export function parseAttemptSelectionSummary(
  raw: string,
  validAttemptNos: number[],
): AttemptSelectionSummary {
  try {
    const parsed = JSON.parse(extractJson(raw)) as Partial<AttemptSelectionSummary>;
    const selectedAttemptNo =
      typeof parsed.selectedAttemptNo === 'number' &&
      validAttemptNos.includes(parsed.selectedAttemptNo)
        ? parsed.selectedAttemptNo
        : null;
    const issues = uniqueStrings(Array.isArray(parsed.issues) ? parsed.issues.map(String) : []);
    return {
      approved: Boolean(parsed.approved) && selectedAttemptNo !== null,
      selectedAttemptNo,
      summary: parsed.summary?.trim() || 'No attempt comparison summary provided.',
      issues,
      nextWorkerInstructions: uniqueStrings(
        Array.isArray(parsed.nextWorkerInstructions)
          ? parsed.nextWorkerInstructions.map(String)
          : [],
      ),
      residualRisk: uniqueStrings(
        Array.isArray(parsed.residualRisk) ? parsed.residualRisk.map(String) : [],
      ),
      filesChecked: normalizePathList(
        Array.isArray(parsed.filesChecked) ? parsed.filesChecked : [],
        100,
      ),
    };
  } catch {
    return {
      approved: false,
      selectedAttemptNo: null,
      summary: raw.trim() || 'Attempt comparison parsing failed.',
      issues: ['Attempt comparison result could not be parsed into structured JSON.'],
      nextWorkerInstructions: ['Return the attempt comparison result as structured JSON.'],
      residualRisk: [],
      filesChecked: [],
    };
  }
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
  const updatedAt = Date.now();
  const persisted = { ...next, updatedAt };
  writeJsonFile(workPath, persisted);
  return persisted;
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

function loadTaskComments(sessionsDir: string, sessionPath: string, taskId: string): TaskComment[] {
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

function buildWorkerAttemptFailureResult(params: {
  lane: KiraWorkerLane;
  workspace: KiraWorkspaceSession;
  attemptNo: number;
  cycle: number;
  startedAt: number;
  projectOverview: string;
  contextScan: ProjectContextScan;
  message: string;
}): KiraWorkerAttemptResult {
  const workerPlan = parseWorkerExecutionPlan(
    JSON.stringify({
      understanding: 'Attempt failed before a complete plan was produced.',
      repoFindings: [],
      summary: params.message,
      intendedFiles: [],
      protectedFiles: [],
      validationCommands: [],
      riskNotes: [params.message],
      stopConditions: [params.message],
    }),
  );
  return {
    lane: params.lane,
    workspace: params.workspace,
    attemptNo: params.attemptNo,
    cycle: params.cycle,
    startedAt: params.startedAt,
    projectOverview: params.projectOverview,
    contextScan: params.contextScan,
    workerPlan,
    planningState: createWorkerAttemptState(null),
    attemptState: null,
    workerSummary: {
      summary: params.message,
      filesChanged: [],
      testsRun: [],
      remainingRisks: [params.message],
    },
    validationPlan: {
      plannerCommands: [],
      autoAddedCommands: [],
      effectiveCommands: [],
      notes: [],
    },
    validationReruns: { passed: [], failed: [], failureDetails: [] },
    outOfPlanFiles: [],
    missingValidationCommands: [],
    highRiskIssues: [params.message],
    diffExcerpts: [],
    status: 'failed',
    feedback: [params.message],
    blockedReason: params.message,
  };
}

async function runIsolatedWorkerAttempt(params: {
  options: KiraAutomationPluginOptions;
  sessionPath: string;
  work: WorkTask;
  lane: KiraWorkerLane;
  workerCount: number;
  cycle: number;
  attemptNo: number;
  primaryProjectRoot: string;
  projectSettings: { autoCommit: boolean };
  feedback: string[];
  signal?: AbortSignal;
}): Promise<KiraWorkerAttemptResult> {
  const attemptStartedAt = Date.now();
  const laneFeedback = [
    ...params.feedback,
    `${params.lane.label}: produce an independent solution in this isolated worktree. Do not coordinate through files outside this worktree.`,
  ];
  const fallbackContextScan = await buildProjectContextScan(params.primaryProjectRoot, params.work);
  const fallbackOverview = buildProjectOverview(params.primaryProjectRoot);
  const workspace = await createKiraWorktreeSession(
    params.primaryProjectRoot,
    params.options.sessionsDir,
    params.sessionPath,
    params.work,
    params.projectSettings,
    { force: true, label: `${params.lane.id}-attempt-${params.attemptNo}` },
  );

  if (!workspace.isolated) {
    return buildWorkerAttemptFailureResult({
      lane: params.lane,
      workspace,
      attemptNo: params.attemptNo,
      cycle: params.cycle,
      startedAt: attemptStartedAt,
      projectOverview: fallbackOverview,
      contextScan: fallbackContextScan,
      message: 'Kira could not create an isolated worktree for this worker attempt.',
    });
  }

  try {
    const projectRoot = workspace.projectRoot;
    const projectOverview = buildProjectOverview(projectRoot);
    const contextScan = await buildProjectContextScan(projectRoot, params.work);
    const planningState = createWorkerAttemptState(null);
    const workerPlanRaw = await runToolAgent(
      params.lane.config,
      projectRoot,
      buildWorkerPlanningPrompt(params.work, projectOverview, contextScan, laneFeedback),
      buildWorkerPlanningSystemPrompt(),
      false,
      params.signal,
      planningState,
      (content) =>
        collectPreflightPlanningIssues(
          contextScan,
          parseWorkerExecutionPlan(content),
          uniqueStrings(planningState.explorationActions),
        ),
    );
    throwIfCanceled(params.options.sessionsDir, params.sessionPath, params.work.id, params.signal);
    const workerPlan = parseWorkerExecutionPlan(workerPlanRaw);
    const preflightIssues = collectPreflightPlanningIssues(
      contextScan,
      workerPlan,
      uniqueStrings(planningState.explorationActions),
    );
    if (preflightIssues.length > 0) {
      return {
        lane: params.lane,
        workspace,
        attemptNo: params.attemptNo,
        cycle: params.cycle,
        startedAt: attemptStartedAt,
        projectOverview,
        contextScan,
        workerPlan,
        planningState,
        attemptState: null,
        workerSummary: {
          summary: 'Preflight planning needs more repository context.',
          filesChanged: [],
          testsRun: [],
          remainingRisks: preflightIssues,
        },
        validationPlan: {
          plannerCommands: [],
          autoAddedCommands: [],
          effectiveCommands: [],
          notes: [],
        },
        validationReruns: { passed: [], failed: [], failureDetails: [] },
        outOfPlanFiles: [],
        missingValidationCommands: [],
        highRiskIssues: [],
        diffExcerpts: [],
        status: 'needs_context',
        feedback: preflightIssues,
        blockedReason: 'Preflight planning needs more repository context.',
      };
    }

    const worktreeBefore = await getGitWorktreeEntries(projectRoot);
    const dirtyFilesBefore = getDirtyWorktreePaths(worktreeBefore);
    const attemptState = createWorkerAttemptState(workerPlan, dirtyFilesBefore);
    const workerRaw = await runToolAgent(
      params.lane.config,
      projectRoot,
      buildWorkerPrompt(params.work, projectOverview, contextScan, workerPlan, laneFeedback),
      buildWorkerSystemPrompt(),
      true,
      params.signal,
      attemptState,
    );
    throwIfCanceled(params.options.sessionsDir, params.sessionPath, params.work.id, params.signal);

    const parsedWorkerSummary = parseWorkerSummary(workerRaw);
    const worktreeAfter = await getGitWorktreeEntries(projectRoot);
    const touchedFiles = detectTouchedFilesFromGitStatus(worktreeBefore, worktreeAfter);
    const resolvedFilesChanged = resolveAttemptChangedFiles(
      touchedFiles,
      parsedWorkerSummary.filesChanged,
      [...attemptState.patchedFiles],
    );
    const actualCommandsRun = uniqueStrings(
      attemptState.commandsRun.map((command) => normalizeWhitespace(command)),
    );
    const workerSummary: WorkerSummary = {
      ...parsedWorkerSummary,
      filesChanged: resolvedFilesChanged,
      testsRun: actualCommandsRun.length > 0 ? actualCommandsRun : parsedWorkerSummary.testsRun,
    };
    const outOfPlanFiles = findOutOfPlanTouchedFiles(
      workerPlan.intendedFiles,
      workerSummary.filesChanged,
    );
    const missingValidationCommands = findMissingValidationCommands(
      workerPlan.validationCommands,
      workerSummary.testsRun,
    );
    const validationPlan = resolveValidationPlan(
      projectRoot,
      workerPlan.validationCommands,
      workerSummary.filesChanged,
    );
    const patchValidationIssues = await collectPatchValidationIssues(
      projectRoot,
      workerSummary.filesChanged,
    );
    const validationReruns = await rerunValidationCommands(
      projectRoot,
      validationPlan.effectiveCommands,
    );
    const diffExcerpts = await collectReviewerDiffExcerpts(projectRoot, workerSummary.filesChanged);
    const reviewabilityIssues = collectAttemptReviewabilityIssues({
      rawWorkerOutput: workerRaw,
      workerSummary,
      workerPlan,
      diffExcerpts,
      gitDiffAvailable: worktreeAfter !== null,
    });
    const highRiskIssues = [
      ...(await collectHighRiskAttemptIssues(projectRoot, workerSummary.filesChanged)),
      ...patchValidationIssues,
      ...reviewabilityIssues,
      ...collectDirtyFileGuardrailIssues(workerPlan, dirtyFilesBefore, workerSummary.filesChanged),
      ...collectPlanGuardrailIssues(
        projectRoot,
        workerPlan,
        workerSummary.filesChanged,
        workerSummary.testsRun,
      ),
    ];

    return {
      lane: params.lane,
      workspace,
      attemptNo: params.attemptNo,
      cycle: params.cycle,
      startedAt: attemptStartedAt,
      projectOverview,
      contextScan,
      workerPlan,
      planningState,
      attemptState,
      workerSummary,
      validationPlan,
      validationReruns,
      outOfPlanFiles,
      missingValidationCommands,
      highRiskIssues,
      diffExcerpts,
      rawWorkerOutput: workerRaw,
      status:
        highRiskIssues.length > 0
          ? 'blocked'
          : validationReruns.failed.length > 0
            ? 'validation_failed'
            : 'reviewable',
      feedback:
        highRiskIssues.length > 0
          ? highRiskIssues
          : validationReruns.failed.length > 0
            ? validationReruns.failed.map(
                (command) => `Planned validation failed when Kira reran it: ${command}`,
              )
            : [],
      blockedReason:
        highRiskIssues.length > 0
          ? 'Automated safety validation failed.'
          : validationReruns.failed.length > 0
            ? 'Validation reruns failed.'
            : undefined,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return buildWorkerAttemptFailureResult({
      lane: params.lane,
      workspace,
      attemptNo: params.attemptNo,
      cycle: params.cycle,
      startedAt: attemptStartedAt,
      projectOverview: fallbackOverview,
      contextScan: fallbackContextScan,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function saveWorkerAttemptResult(
  sessionsDir: string,
  sessionPath: string,
  workId: string,
  result: KiraWorkerAttemptResult,
  status: KiraAttemptRecord['status'],
  extraRisks: string[] = [],
): void {
  saveAttemptRecord(
    sessionsDir,
    sessionPath,
    buildAttemptRecord({
      workId,
      attemptNo: result.attemptNo,
      status,
      startedAt: result.startedAt,
      contextScan: result.contextScan,
      workerPlan: result.workerPlan,
      planningState: result.planningState,
      attemptState: result.attemptState,
      workerSummary: result.workerSummary,
      validationReruns: result.validationReruns,
      outOfPlanFiles: result.outOfPlanFiles,
      validationGaps: result.missingValidationCommands,
      risks: uniqueStrings([
        ...result.workerSummary.remainingRisks,
        ...result.highRiskIssues,
        ...extraRisks,
      ]),
      diffExcerpts: result.diffExcerpts,
      rawWorkerOutput: result.rawWorkerOutput,
      blockedReason: result.blockedReason,
    }),
  );
}

function addWorkerAttemptComment(
  sessionsDir: string,
  sessionPath: string,
  work: WorkTask,
  result: KiraWorkerAttemptResult,
): void {
  addComment(sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: buildAgentLabel(WORKER_AUTHOR, result.lane.label),
    body: [
      `Attempt ${result.attemptNo} finished from ${result.lane.label}.`,
      '',
      `Isolated worktree:\n${result.workspace.projectRoot}`,
      '',
      `Status:\n${result.status}`,
      '',
      `Plan:\n${result.workerPlan.summary}`,
      '',
      `Summary:\n${result.workerSummary.summary}`,
      '',
      `Files changed:\n${formatList(result.workerSummary.filesChanged, 'No files reported')}`,
      '',
      `Checks:\n${formatList(result.workerSummary.testsRun, 'No checks reported')}`,
      '',
      `Kira-passed validation reruns:\n${formatList(
        result.validationReruns.passed,
        'No validation reruns passed',
      )}`,
      '',
      `Kira validation failures:\n${formatList(
        result.validationReruns.failed,
        'No validation reruns failed',
      )}`,
      '',
      `Remaining risks:\n${formatList(
        [...result.workerSummary.remainingRisks, ...result.highRiskIssues],
        'None reported',
      )}`,
      '',
      `Validation gaps:\n${formatList(
        result.missingValidationCommands,
        'No missing planned checks',
      )}`,
      '',
      `Out-of-plan files:\n${formatList(result.outOfPlanFiles, 'No out-of-plan files')}`,
      '',
      `Worker submission:\n${formatWorkerSubmission(result.rawWorkerOutput)}`,
    ].join('\n'),
  });
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

  const projectRoot = resolveKiraProjectRoot(runtime.workRootDirectory, projectName);
  if (!runtime.workRootDirectory || !projectName || !fs.existsSync(projectRoot)) {
    throw new Error(`Project root was not found for ${projectName}.`);
  }

  const previousAnalysis = loadProjectDiscoveryAnalysis(
    options.sessionsDir,
    sessionPath,
    projectName,
  );
  if (previousAnalysis) {
    sendSseEvent(res, {
      type: 'log',
      message: `Loaded previous analysis from ${new Date(previousAnalysis.updatedAt).toLocaleString()}.`,
    });
  } else {
    sendSseEvent(res, {
      type: 'log',
      message: 'No previous saved analysis found for this project.',
    });
  }

  sendSseEvent(res, { type: 'log', message: 'Scanning the project overview and source map...' });
  const projectOverview = buildProjectOverview(projectRoot);

  sendSseEvent(res, {
    type: 'log',
    message: 'Aoi is reviewing the codebase and collecting candidate tasks...',
  });
  const raw = await runToolAgent(
    runtime.reviewerConfig,
    projectRoot,
    buildProjectDiscoveryPrompt(projectName, projectOverview, previousAnalysis),
    buildProjectDiscoverySystemPrompt(),
    false,
  );

  sendSseEvent(res, {
    type: 'log',
    message: 'Normalizing the findings and saving them for later reuse...',
  });
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

async function processWorkWithMultipleWorkers(params: {
  options: KiraAutomationPluginOptions;
  sessionPath: string;
  work: WorkTask;
  runtime: ReturnType<typeof getKiraRuntimeSettings>;
  primaryProjectRoot: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { options, sessionPath, work, runtime, primaryProjectRoot, signal } = params;
  if (!runtime.reviewerConfig) {
    throw new Error('No usable reviewer LLM config was found in config.json.');
  }
  const lanes = buildWorkerLanes(runtime.workerConfigs);
  const projectSettings = loadProjectSettings(primaryProjectRoot, runtime.defaultProjectSettings);
  if (!(await isGitWorktree(primaryProjectRoot))) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked because multiple workers require git worktree isolation.',
        '',
        'Configure one worker for non-git projects, or initialize the project as a git repository before retrying.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업은 여러 worker 격리를 위해 git worktree가 필요해요.`,
    });
    return;
  }

  const safetyIssues = await collectProjectSafetyIssues(primaryProjectRoot);
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
      ].join('\n'),
    });
    return;
  }

  const existingComments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
  let feedback =
    work.status === 'in_progress' ? extractLatestReviewerFeedback(existingComments) : [];
  let previousIssueSignature: string | null = null;
  let repeatedIssueCount = 0;

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
        ? `Kira 재개: "${work.title}" 작업을 ${lanes.length}개 worker로 다시 진행할게요.`
        : `Kira 시작: "${work.title}" 작업을 ${lanes.length}개 worker로 자동 시작할게요.`,
  });
  addComment(options.sessionsDir, sessionPath, {
    taskId: work.id,
    taskType: 'work',
    author: runtime.workerAuthor,
    body: [
      `Picked up the task with ${lanes.length} isolated workers in ${work.projectName}.`,
      '',
      `Workers:\n${formatList(
        lanes.map((lane) => lane.label),
        'No workers configured',
      )}`,
      '',
      'Each worker will produce an independent attempt in its own git worktree. The reviewer will compare passing attempts and select one winner.',
    ].join('\n'),
  });

  for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const results = await Promise.all(
      lanes.map((lane, index) =>
        runIsolatedWorkerAttempt({
          options,
          sessionPath,
          work,
          lane,
          workerCount: lanes.length,
          cycle,
          attemptNo: (cycle - 1) * lanes.length + index + 1,
          primaryProjectRoot,
          projectSettings,
          feedback,
          signal,
        }),
      ),
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);

    for (const result of results) {
      addWorkerAttemptComment(options.sessionsDir, sessionPath, work, result);
      const attemptStatus: KiraAttemptRecord['status'] =
        result.status === 'needs_context'
          ? 'needs_context'
          : result.status === 'validation_failed'
            ? 'validation_failed'
            : result.status === 'reviewable'
              ? 'reviewable'
              : 'blocked';
      saveWorkerAttemptResult(options.sessionsDir, sessionPath, work.id, result, attemptStatus);
    }

    const reviewableAttempts = results.filter((result) => result.status === 'reviewable');
    if (reviewableAttempts.length === 0) {
      feedback = uniqueStrings(results.flatMap((result) => result.feedback)).slice(0, 12);
      const issueSignature = buildIssueSignature(feedback, 'No worker attempts passed validation.');
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `No worker attempts were ready for review after cycle ${cycle}.`,
          '',
          `Issues:\n${formatList(feedback, 'No detailed issues provided')}`,
        ].join('\n'),
      });
      await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));
      if (issueSignature === previousIssueSignature) {
        repeatedIssueCount += 1;
      } else {
        repeatedIssueCount = 1;
        previousIssueSignature = issueSignature;
      }
      if (repeatedIssueCount >= 2) break;
      continue;
    }

    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'in_review',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Started review for cycle ${cycle}.`,
        '',
        `Reviewable attempts:\n${formatList(
          reviewableAttempts.map(
            (attempt) => `Attempt ${attempt.attemptNo} from ${attempt.lane.label}`,
          ),
          'No reviewable attempts',
        )}`,
        '',
        `Files changed:\n${formatList(
          uniqueStrings(
            reviewableAttempts.flatMap((attempt) => attempt.workerSummary.filesChanged),
          ),
          'No changed files recorded',
        )}`,
      ].join('\n'),
    });
    const selectionRaw = await runToolAgent(
      runtime.reviewerConfig,
      primaryProjectRoot,
      buildAttemptComparisonReviewPrompt(work, reviewableAttempts),
      buildAttemptComparisonReviewSystemPrompt(),
      false,
      signal,
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const selection = parseAttemptSelectionSummary(
      selectionRaw,
      reviewableAttempts.map((attempt) => attempt.attemptNo),
    );
    const selectedAttempt = selection.selectedAttemptNo
      ? reviewableAttempts.find((attempt) => attempt.attemptNo === selection.selectedAttemptNo)
      : null;

    if (selection.approved && selectedAttempt) {
      const reviewRecord = buildReviewRecord(work.id, selectedAttempt.attemptNo, {
        approved: true,
        summary: selection.summary,
        issues: [],
        filesChecked: selection.filesChecked,
        findings: [],
        missingValidation: [],
        nextWorkerInstructions: [],
        residualRisk: selection.residualRisk,
      });
      saveReviewRecord(options.sessionsDir, sessionPath, reviewRecord);
      for (const result of reviewableAttempts) {
        saveWorkerAttemptResult(
          options.sessionsDir,
          sessionPath,
          work.id,
          result,
          result.attemptNo === selectedAttempt.attemptNo ? 'approved' : 'review_requested_changes',
          result.attemptNo === selectedAttempt.attemptNo
            ? selection.residualRisk
            : [`Not selected by reviewer. Winning attempt: ${selectedAttempt.attemptNo}`],
        );
      }
      const suggestedCommitMessage = buildSuggestedCommitMessage(
        work,
        selectedAttempt.workerSummary,
      );
      const projectLockPath = getProjectLockPath(
        options.sessionsDir,
        getProjectKey(runtime.workRootDirectory, work, sessionPath),
      );
      const integrationResult = projectSettings.autoCommit
        ? await autoCommitApprovedWork(
            selectedAttempt.workspace,
            selectedAttempt.workerSummary.filesChanged,
            suggestedCommitMessage,
            runtime.defaultProjectSettings,
            projectLockPath,
          )
        : await integrateApprovedWorktreeChanges(
            selectedAttempt.workspace,
            selectedAttempt.workerSummary.filesChanged,
            suggestedCommitMessage,
            projectLockPath,
          );

      if (integrationResult.status === 'failed') {
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            `Approved attempt ${selectedAttempt.attemptNo}, but integration failed.`,
            '',
            integrationResult.message,
          ].join('\n'),
        });
        await Promise.all(
          results
            .filter((result) => result.attemptNo !== selectedAttempt.attemptNo)
            .map((result) => cleanupKiraWorktreeSession(result.workspace)),
        );
        return;
      }

      updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
        ...current,
        status: 'done',
      }));
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Approved attempt ${selectedAttempt.attemptNo}.`,
          '',
          selection.summary,
          '',
          `Selected worker: ${selectedAttempt.lane.label}`,
        ].join('\n'),
      });
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Suggested commit message:\n${suggestedCommitMessage}`,
      });
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: `Integrated winning attempt.\n\n${integrationResult.message}`,
      });
      await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));
      enqueueEvent(options.sessionsDir, sessionPath, {
        id: makeId('event'),
        workId: work.id,
        title: work.title,
        projectName: work.projectName,
        type: 'completed',
        createdAt: Date.now(),
        message: `Kira 완료: "${work.title}" 작업에서 attempt ${selectedAttempt.attemptNo}를 선택해 통합했어요.`,
      });
      return;
    }

    feedback =
      selection.nextWorkerInstructions.length > 0
        ? selection.nextWorkerInstructions
        : selection.issues.length > 0
          ? selection.issues
          : [selection.summary];
    for (const result of reviewableAttempts) {
      saveWorkerAttemptResult(
        options.sessionsDir,
        sessionPath,
        work.id,
        result,
        'review_requested_changes',
        feedback,
      );
    }
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Reviewer did not approve any attempts after cycle ${cycle}.`,
        '',
        `Summary:\n${selection.summary}`,
        '',
        `Issues:\n${formatList(selection.issues, 'No detailed issues provided')}`,
        '',
        `Next worker instructions:\n${formatList(
          selection.nextWorkerInstructions,
          'No next instructions provided',
        )}`,
      ].join('\n'),
    });
    await Promise.all(results.map((result) => cleanupKiraWorktreeSession(result.workspace)));

    const issueSignature = buildIssueSignature(selection.issues, selection.summary);
    if (issueSignature === previousIssueSignature) {
      repeatedIssueCount += 1;
    } else {
      repeatedIssueCount = 1;
      previousIssueSignature = issueSignature;
    }
    if (repeatedIssueCount >= 2) break;
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
      `Blocked after ${MAX_REVIEW_CYCLES} multi-worker review cycles.`,
      '',
      `Summary:\n${feedback[0] ?? 'No worker attempt satisfied the review requirements.'}`,
      '',
      `Issues:\n${formatList(feedback, 'No detailed issues provided')}`,
    ].join('\n'),
  });
  enqueueEvent(options.sessionsDir, sessionPath, {
    id: makeId('event'),
    workId: work.id,
    title: work.title,
    projectName: work.projectName,
    type: 'needs_attention',
    createdAt: Date.now(),
    message: `Kira blocked: "${work.title}" 작업이 여러 worker 재시도 후에도 리뷰를 통과하지 못했어요.`,
  });
}

async function processWork(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  workId: string,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = getKiraRuntimeSettings(options.configFile, options.getWorkRootDirectory());
  const dataDir = getKiraDataDir(options.sessionsDir, sessionPath);
  let work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
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

  const primaryProjectRoot = resolveKiraProjectRoot(runtime.workRootDirectory, work.projectName);
  if (!runtime.workRootDirectory || !work.projectName || !fs.existsSync(primaryProjectRoot)) {
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

  const clarifiedWork = await ensureWorkClarification(
    options,
    sessionPath,
    work,
    runtime,
    primaryProjectRoot,
    signal,
  );
  if (!clarifiedWork) return;
  work = clarifiedWork;

  if (runtime.workerConfigs.length > 1) {
    await processWorkWithMultipleWorkers({
      options,
      sessionPath,
      work,
      runtime,
      primaryProjectRoot,
      signal,
    });
    return;
  }

  const workspace = await createKiraWorktreeSession(
    primaryProjectRoot,
    options.sessionsDir,
    sessionPath,
    work,
    loadProjectSettings(primaryProjectRoot, runtime.defaultProjectSettings),
  );
  if (
    !workspace.isolated &&
    shouldUseKiraIsolatedWorktree(
      primaryProjectRoot,
      loadProjectSettings(primaryProjectRoot, runtime.defaultProjectSettings),
    )
  ) {
    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'blocked',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        'Automation blocked because Kira could not create an isolated git worktree.',
        '',
        'The task was not run in the primary worktree because auto-commit is enabled and concurrent work requires isolation.',
      ].join('\n'),
    });
    enqueueEvent(options.sessionsDir, sessionPath, {
      id: makeId('event'),
      workId: work.id,
      title: work.title,
      projectName: work.projectName,
      type: 'needs_attention',
      createdAt: Date.now(),
      message: `Kira blocked: "${work.title}" 작업용 격리 worktree를 만들 수 없어 기본 워크트리를 보호했어요.`,
    });
    return;
  }
  const projectRoot = workspace.projectRoot;

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
  const contextScan = await buildProjectContextScan(projectRoot, work);
  const existingComments = loadTaskComments(options.sessionsDir, sessionPath, work.id);
  const resumeFeedback =
    work.status === 'in_progress' ? extractLatestReviewerFeedback(existingComments) : [];

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
        : [
            `Picked up the task and started implementation in ${work.projectName}.`,
            workspace.isolated
              ? `Using isolated git worktree: ${workspace.projectRoot}`
              : 'Using the primary project worktree.',
          ].join('\n\n'),
  });

  let feedback: string[] = resumeFeedback;
  let previousIssueSignature: string | null = null;
  let repeatedIssueCount = 0;
  for (let cycle = 1; cycle <= MAX_REVIEW_CYCLES; cycle += 1) {
    const attemptStartedAt = Date.now();
    const planningState = createWorkerAttemptState(null);
    const workerPlanRaw = await runToolAgent(
      runtime.workerConfig,
      projectRoot,
      buildWorkerPlanningPrompt(work, projectOverview, contextScan, feedback),
      buildWorkerPlanningSystemPrompt(),
      false,
      signal,
      planningState,
      (content) =>
        collectPreflightPlanningIssues(
          contextScan,
          parseWorkerExecutionPlan(content),
          uniqueStrings(planningState.explorationActions),
        ),
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const workerPlan = parseWorkerExecutionPlan(workerPlanRaw);
    const preflightIssues = collectPreflightPlanningIssues(
      contextScan,
      workerPlan,
      uniqueStrings(planningState.explorationActions),
    );
    if (preflightIssues.length > 0) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'needs_context',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          risks: preflightIssues,
          blockedReason: 'Preflight planning needs more repository context.',
        }),
      );
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Preflight planning requested more context before attempt ${cycle}.`,
          '',
          `Issues:\n${formatList(preflightIssues, 'No detailed issues provided')}`,
          '',
          `Context scan search terms:\n${formatList(
            contextScan.searchTerms,
            'No search terms extracted',
          )}`,
          '',
          `Likely files:\n${formatList(contextScan.likelyFiles, 'No likely files detected')}`,
        ].join('\n'),
      });
      feedback = preflightIssues;
      continue;
    }
    const worktreeBefore = await getGitWorktreeEntries(projectRoot);
    const dirtyFilesBefore = getDirtyWorktreePaths(worktreeBefore);
    const attemptState = createWorkerAttemptState(workerPlan, dirtyFilesBefore);
    let workerRaw: string;
    try {
      workerRaw = await runToolAgent(
        runtime.workerConfig,
        projectRoot,
        buildWorkerPrompt(work, projectOverview, contextScan, workerPlan, feedback),
        buildWorkerSystemPrompt(),
        true,
        signal,
        attemptState,
      );
    } catch (error) {
      if (!isAbortError(error)) {
        const { restoredFiles, error: restoreError } = tryRestoreAttemptFiles(
          projectRoot,
          attemptState,
        );
        if (restoredFiles.length > 0) {
          addComment(options.sessionsDir, sessionPath, {
            taskId: work.id,
            taskType: 'work',
            author: runtime.reviewerAuthor,
            body: [
              `Restored files after worker attempt ${cycle} failed unexpectedly.`,
              '',
              `Files restored:\n${formatList(restoredFiles, 'No files restored')}`,
            ].join('\n'),
          });
        }
        if (restoreError) {
          enqueueEvent(options.sessionsDir, sessionPath, {
            id: makeId('event'),
            workId: work.id,
            title: work.title,
            projectName: work.projectName,
            type: 'needs_attention',
            createdAt: Date.now(),
            message: `Kira rollback failed: "${work.title}" 작업의 실패한 시도 파일 복구 중 오류가 발생했어요.`,
          });
        }
      }
      throw error;
    }
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const parsedWorkerSummary = parseWorkerSummary(workerRaw);
    const worktreeAfter = await getGitWorktreeEntries(projectRoot);
    const touchedFiles = detectTouchedFilesFromGitStatus(worktreeBefore, worktreeAfter);
    const resolvedFilesChanged = resolveAttemptChangedFiles(
      touchedFiles,
      parsedWorkerSummary.filesChanged,
      [...attemptState.patchedFiles],
    );
    const actualCommandsRun = uniqueStrings(
      attemptState.commandsRun.map((command) => normalizeWhitespace(command)),
    );
    const workerSummary: WorkerSummary = {
      ...parsedWorkerSummary,
      filesChanged: resolvedFilesChanged,
      testsRun: actualCommandsRun.length > 0 ? actualCommandsRun : parsedWorkerSummary.testsRun,
    };
    const outOfPlanFiles = findOutOfPlanTouchedFiles(
      workerPlan.intendedFiles,
      workerSummary.filesChanged,
    );
    const missingValidationCommands = findMissingValidationCommands(
      workerPlan.validationCommands,
      workerSummary.testsRun,
    );
    const validationPlan = resolveValidationPlan(
      projectRoot,
      workerPlan.validationCommands,
      workerSummary.filesChanged,
    );
    const patchValidationIssues = await collectPatchValidationIssues(
      projectRoot,
      workerSummary.filesChanged,
    );
    const validationReruns = await rerunValidationCommands(
      projectRoot,
      validationPlan.effectiveCommands,
    );
    const diffExcerpts = await collectReviewerDiffExcerpts(projectRoot, workerSummary.filesChanged);
    const reviewabilityIssues = collectAttemptReviewabilityIssues({
      rawWorkerOutput: workerRaw,
      workerSummary,
      workerPlan,
      diffExcerpts,
      gitDiffAvailable: worktreeAfter !== null,
    });
    const highRiskIssues = [
      ...(await collectHighRiskAttemptIssues(projectRoot, workerSummary.filesChanged)),
      ...patchValidationIssues,
      ...reviewabilityIssues,
      ...collectDirtyFileGuardrailIssues(workerPlan, dirtyFilesBefore, workerSummary.filesChanged),
      ...collectPlanGuardrailIssues(
        projectRoot,
        workerPlan,
        workerSummary.filesChanged,
        workerSummary.testsRun,
      ),
    ];

    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.workerAuthor,
      body: [
        `Attempt ${cycle} finished.`,
        '',
        `Project context:\n- Root: ${contextScan.projectRoot}\n- Package manager: ${
          contextScan.packageManager ?? 'not detected'
        }`,
        '',
        `Existing changes:\n${formatList(
          contextScan.existingChanges,
          'Clean worktree or no git changes detected',
        )}`,
        '',
        `Likely files:\n${formatList(contextScan.likelyFiles, 'No likely files detected')}`,
        '',
        `Candidate checks:\n${formatList(contextScan.candidateChecks, 'No candidate checks detected')}`,
        '',
        `Preflight exploration:\n${formatList(
          uniqueStrings(planningState.explorationActions),
          'No preflight exploration recorded',
        )}`,
        '',
        `Read files:\n${formatList([...attemptState.readFiles].sort(), 'No files read during implementation')}`,
        '',
        `Patched files:\n${formatList([...attemptState.patchedFiles].sort(), 'No files patched during implementation')}`,
        '',
        `Plan:\n${workerPlan.summary}`,
        '',
        `Plan understanding:\n${workerPlan.understanding}`,
        '',
        `Repo findings:\n${formatList(workerPlan.repoFindings, 'No repo findings')}`,
        '',
        `Planned files:\n${formatList(workerPlan.intendedFiles, 'No planned files')}`,
        '',
        `Protected files:\n${formatList(workerPlan.protectedFiles, 'No protected files')}`,
        '',
        `Planned checks:\n${formatList(workerPlan.validationCommands, 'No planned checks')}`,
        '',
        `Kira auto-added validation checks:\n${formatList(
          validationPlan.autoAddedCommands,
          'No auto-added validation checks',
        )}`,
        '',
        `Kira effective validation plan:\n${formatList(
          validationPlan.effectiveCommands,
          'No effective validation commands',
        )}`,
        '',
        `Validation plan notes:\n${formatList(validationPlan.notes, 'No validation plan notes')}`,
        '',
        `Plan risks:\n${formatList(workerPlan.riskNotes, 'No planner risks reported')}`,
        '',
        `Stop conditions:\n${formatList(workerPlan.stopConditions, 'No stop conditions')}`,
        '',
        `Summary:\n${workerSummary.summary}`,
        '',
        `Files changed:\n${formatList(workerSummary.filesChanged, 'No files reported')}`,
        '',
        `Checks:\n${formatList(workerSummary.testsRun, 'No checks reported')}`,
        '',
        `Kira-passed validation reruns:\n${formatList(
          validationReruns.passed,
          'No validation reruns passed',
        )}`,
        '',
        `Kira validation failures:\n${formatList(
          validationReruns.failed,
          'No validation reruns failed',
        )}`,
        '',
        `Remaining risks:\n${formatList(
          [...workerSummary.remainingRisks, ...highRiskIssues],
          'None reported',
        )}`,
        '',
        `Validation gaps:\n${formatList(missingValidationCommands, 'No missing planned checks')}`,
        '',
        `Out-of-plan files:\n${formatList(outOfPlanFiles, 'No out-of-plan files')}`,
        '',
        `Worker submission:\n${formatWorkerSubmission(workerRaw)}`,
      ].join('\n'),
    });

    if (highRiskIssues.length > 0) {
      const { restoredFiles, error: restoreError } = tryRestoreAttemptFiles(
        projectRoot,
        attemptState,
      );
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'blocked',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationReruns,
          outOfPlanFiles,
          validationGaps: missingValidationCommands,
          risks: [...workerSummary.remainingRisks, ...highRiskIssues],
          diffExcerpts,
          rawWorkerOutput: workerRaw,
          blockedReason: 'Automated safety validation failed.',
          rollbackFiles: restoredFiles,
        }),
      );
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
          `Rolled back files:\n${formatList(restoredFiles, 'No files rolled back')}`,
          '',
          restoreError ? `Rollback error:\n${restoreError}` : 'Rollback completed without errors.',
          '',
          'Kira rolled back the latest attempt instead of leaving unsafe or unverified edits in the worktree.',
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
      if (restoreError) {
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira rollback failed: "${work.title}" 작업의 안전 차단 후 파일 복구 중 오류가 발생했어요.`,
        });
      }
      return;
    }

    if (validationReruns.failed.length > 0) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'validation_failed',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationReruns,
          outOfPlanFiles,
          validationGaps: missingValidationCommands,
          risks: workerSummary.remainingRisks,
          diffExcerpts,
          rawWorkerOutput: workerRaw,
        }),
      );
      addComment(options.sessionsDir, sessionPath, {
        taskId: work.id,
        taskType: 'work',
        author: runtime.reviewerAuthor,
        body: [
          `Validation requested changes after attempt ${cycle}.`,
          '',
          `Passed reruns:\n${formatList(validationReruns.passed, 'No validation reruns passed')}`,
          '',
          `Failed reruns:\n${formatList(validationReruns.failed, 'No validation reruns failed')}`,
          '',
          `Failure details:\n${formatList(
            validationReruns.failureDetails,
            'No validation failure details provided',
          )}`,
          '',
          'Kira reran the planned validation commands itself and will not send this attempt to final review until they pass.',
        ].join('\n'),
      });

      feedback = validationReruns.failed.map(
        (command) => `Planned validation failed when Kira reran it: ${command}`,
      );
      const validationSummary =
        validationReruns.failed.length > 0
          ? `Validation reruns failed: ${validationReruns.failed.join(', ')}`
          : 'Validation reruns failed.';
      const issueSignature = buildIssueSignature(feedback, validationSummary);
      if (issueSignature === previousIssueSignature) {
        repeatedIssueCount += 1;
      } else {
        repeatedIssueCount = 1;
        previousIssueSignature = issueSignature;
      }

      if (repeatedIssueCount >= 2) {
        saveAttemptRecord(
          options.sessionsDir,
          sessionPath,
          buildAttemptRecord({
            workId: work.id,
            attemptNo: cycle,
            status: 'blocked',
            startedAt: attemptStartedAt,
            contextScan,
            workerPlan,
            planningState,
            attemptState,
            workerSummary,
            validationReruns,
            outOfPlanFiles,
            validationGaps: missingValidationCommands,
            risks: feedback,
            diffExcerpts,
            rawWorkerOutput: workerRaw,
            blockedReason: 'Validation failures repeated without progress.',
          }),
        );
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            `Blocked early because the same validation failures repeated without progress after attempt ${cycle}.`,
            '',
            `Issues:\n${formatList(feedback, validationSummary)}`,
            '',
            'Kira stopped retrying because the worker was not making progress against the same rerun validation failures.',
          ].join('\n'),
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira blocked: "${work.title}" 작업이 같은 검증 실패를 반복해서 더 이상 자동 재시도하지 않을게요.`,
        });
        return;
      }

      if (cycle < MAX_REVIEW_CYCLES) {
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'in_progress',
        }));
      }
      continue;
    }

    updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
      ...current,
      status: 'in_review',
    }));
    addComment(options.sessionsDir, sessionPath, {
      taskId: work.id,
      taskType: 'work',
      author: runtime.reviewerAuthor,
      body: [
        `Started review for attempt ${cycle}.`,
        '',
        `Files changed:\n${formatList(workerSummary.filesChanged, 'No changed files recorded')}`,
        '',
        `Kira-passed validation reruns:\n${formatList(
          validationReruns.passed,
          'No validation reruns passed',
        )}`,
      ].join('\n'),
    });

    const reviewRaw = await runToolAgent(
      runtime.reviewerConfig,
      projectRoot,
      buildReviewPrompt(
        work,
        projectOverview,
        contextScan,
        workerPlan,
        workerSummary,
        outOfPlanFiles,
        missingValidationCommands,
        validationPlan,
        validationReruns,
        diffExcerpts,
      ),
      buildReviewSystemPrompt(),
      false,
      signal,
    );
    throwIfCanceled(options.sessionsDir, sessionPath, work.id, signal);
    const reviewSummary = enforceReviewDecision(parseReviewSummary(reviewRaw));
    const reviewRecord = buildReviewRecord(work.id, cycle, reviewSummary);
    saveReviewRecord(options.sessionsDir, sessionPath, reviewRecord);

    if (reviewSummary.approved) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'approved',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationReruns,
          outOfPlanFiles,
          validationGaps: missingValidationCommands,
          risks: [...workerSummary.remainingRisks, ...reviewSummary.residualRisk],
          diffExcerpts,
          rawWorkerOutput: workerRaw,
        }),
      );
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
        workspace,
        workerSummary.filesChanged,
        suggestedCommitMessage,
        runtime.defaultProjectSettings,
        getProjectLockPath(
          options.sessionsDir,
          getProjectKey(runtime.workRootDirectory, work, sessionPath),
        ),
      );
      if (autoCommitResult.status === 'committed') {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Committed changes.\n\n${autoCommitResult.message}\n\nCommit message:\n${suggestedCommitMessage}`,
        });
      } else if (autoCommitResult.status === 'failed') {
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            'Auto-commit failed and Kira blocked the task before marking integration complete.',
            '',
            autoCommitResult.message,
          ].join('\n'),
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: `Kira blocked: "${work.title}" 작업의 승인된 변경을 통합하는 중 충돌 또는 git 상태 문제가 발생했어요.`,
        });
        return;
      } else if (autoCommitResult.message) {
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: `Auto-commit skipped.\n\n${autoCommitResult.message}`,
        });
      }

      await cleanupKiraWorktreeSession(workspace);

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
        `Findings:\n${formatList(
          reviewSummary.findings.map((finding) =>
            [
              finding.severity,
              finding.file,
              finding.line ? `line ${finding.line}` : '',
              finding.message,
            ]
              .filter(Boolean)
              .join(': '),
          ),
          'No structured findings',
        )}`,
        '',
        `Missing validation:\n${formatList(
          reviewSummary.missingValidation,
          'No missing validation reported',
        )}`,
        '',
        `Next worker instructions:\n${formatList(
          reviewSummary.nextWorkerInstructions,
          'No next instructions provided',
        )}`,
        '',
        `Issues:\n${formatList(reviewSummary.issues, 'No detailed issues provided')}`,
      ].join('\n'),
    });

    saveAttemptRecord(
      options.sessionsDir,
      sessionPath,
      buildAttemptRecord({
        workId: work.id,
        attemptNo: cycle,
        status: 'review_requested_changes',
        startedAt: attemptStartedAt,
        contextScan,
        workerPlan,
        planningState,
        attemptState,
        workerSummary,
        validationReruns,
        outOfPlanFiles,
        validationGaps: [...missingValidationCommands, ...reviewSummary.missingValidation],
        risks: [...workerSummary.remainingRisks, ...reviewSummary.issues],
        diffExcerpts,
        rawWorkerOutput: workerRaw,
      }),
    );

    feedback =
      reviewSummary.nextWorkerInstructions.length > 0
        ? reviewSummary.nextWorkerInstructions
        : reviewSummary.issues.length > 0
          ? reviewSummary.issues
          : [reviewSummary.summary];
    const issueSignature = buildIssueSignature(reviewSummary.issues, reviewSummary.summary);
    if (issueSignature === previousIssueSignature) {
      repeatedIssueCount += 1;
    } else {
      repeatedIssueCount = 1;
      previousIssueSignature = issueSignature;
    }

    if (repeatedIssueCount >= 2) {
      saveAttemptRecord(
        options.sessionsDir,
        sessionPath,
        buildAttemptRecord({
          workId: work.id,
          attemptNo: cycle,
          status: 'blocked',
          startedAt: attemptStartedAt,
          contextScan,
          workerPlan,
          planningState,
          attemptState,
          workerSummary,
          validationReruns,
          outOfPlanFiles,
          validationGaps: [...missingValidationCommands, ...reviewSummary.missingValidation],
          risks: reviewSummary.issues,
          diffExcerpts,
          rawWorkerOutput: workerRaw,
          blockedReason: 'Review issues repeated without progress.',
        }),
      );
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
      `Blocked after ${MAX_REVIEW_CYCLES} review or validation attempts.`,
      '',
      `Summary:\n${feedback[0] ?? 'The work could not satisfy the review requirements within the allowed retries.'}`,
      '',
      `Issues:\n${formatList(feedback, 'No detailed issues provided')}`,
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

function startWorkJob(
  options: KiraAutomationPluginOptions,
  sessionPath: string,
  workId: string,
): void {
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
  const projectRoot = resolveKiraProjectRoot(runtime.workRootDirectory, work.projectName);
  const projectSettings = projectRoot
    ? loadProjectSettings(projectRoot, runtime.defaultProjectSettings)
    : runtime.defaultProjectSettings;
  const shouldUseIsolatedWorktree = shouldUseKiraAttemptWorktrees(
    projectRoot,
    projectSettings,
    runtime.workerConfigs.length,
  );
  let projectLockAcquired = false;
  if (
    !shouldUseIsolatedWorktree &&
    (activeProjectJobs.has(projectKey) ||
      !tryAcquireLock(projectLockPath, {
        ownerId: SERVER_INSTANCE_ID,
        resource: 'project',
        sessionPath,
        targetKey: projectKey,
      }))
  ) {
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
  projectLockAcquired = !shouldUseIsolatedWorktree;

  activeJobs.add(jobKey);
  if (projectLockAcquired) {
    activeProjectJobs.add(projectKey);
  }
  const controller = new AbortController();
  jobAbortControllers.set(jobKey, controller);
  const heartbeat = setInterval(() => {
    refreshLock(workLockPath, SERVER_INSTANCE_ID);
    if (projectLockAcquired) {
      refreshLock(projectLockPath, SERVER_INSTANCE_ID);
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  void processWork(options, sessionPath, workId, controller.signal)
    .catch((error) => {
      if (isAbortError(error)) return;
      const work = readJsonFile<WorkTask>(join(dataDir, WORKS_DIR_NAME, `${workId}.json`));
      if (work) {
        const resolvedFailure = resolveUnexpectedAutomationFailure(
          work.title,
          error instanceof Error ? error.message : String(error),
        );
        updateWork(options.sessionsDir, sessionPath, work.id, (current) => ({
          ...current,
          status: 'blocked',
        }));
        addComment(options.sessionsDir, sessionPath, {
          taskId: work.id,
          taskType: 'work',
          author: runtime.reviewerAuthor,
          body: [
            'Automation failed unexpectedly and Kira blocked this task to avoid retry loops.',
            '',
            `Summary:\n${resolvedFailure.summary}`,
            '',
            `Error:\n${error instanceof Error ? error.message : String(error)}`,
            '',
            `Guidance:\n${resolvedFailure.guidance}`,
          ].join('\n'),
        });
        enqueueEvent(options.sessionsDir, sessionPath, {
          id: makeId('event'),
          workId: work.id,
          title: work.title,
          projectName: work.projectName,
          type: 'needs_attention',
          createdAt: Date.now(),
          message: resolvedFailure.userMessage,
        });
      }
    })
    .finally(() => {
      clearInterval(heartbeat);
      activeJobs.delete(jobKey);
      if (projectLockAcquired) {
        activeProjectJobs.delete(projectKey);
      }
      jobAbortControllers.delete(jobKey);
      releaseLock(workLockPath, SERVER_INSTANCE_ID);
      if (projectLockAcquired) {
        releaseLock(projectLockPath, SERVER_INSTANCE_ID);
      }
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
        req: NodeJS.ReadableStream & {
          on: (event: string, listener: (chunk?: Buffer) => void) => void;
        },
        onParsed: (body: Record<string, unknown>) => void | Promise<void>,
        onError: (error: unknown) => void,
      ) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<
              string,
              unknown
            >;
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
              const sessionPath =
                typeof body.sessionPath === 'string' ? body.sessionPath.trim() : '';
              const projectName =
                typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!sessionPath || !projectName) {
                throw new Error('Missing sessionPath or projectName.');
              }

              const analysis = await analyzeProjectForDiscovery(
                options,
                sessionPath,
                projectName,
                res,
              );
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

          const analysis = loadProjectDiscoveryAnalysis(
            options.sessionsDir,
            sessionPath,
            projectName,
          );
          res.writeHead(200);
          res.end(JSON.stringify({ analysis: analysis ?? null }));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
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
              const sessionPath =
                typeof body.sessionPath === 'string' ? body.sessionPath.trim() : '';
              const projectName =
                typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!sessionPath || !projectName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing sessionPath or projectName' }));
                return;
              }

              const analysis = loadProjectDiscoveryAnalysis(
                options.sessionsDir,
                sessionPath,
                projectName,
              );
              if (!analysis) {
                res.writeHead(404);
                res.end(
                  JSON.stringify({ error: 'No saved discovery analysis found for this project' }),
                );
                return;
              }

              const { created, skippedTitles } = createWorksFromDiscovery(
                options,
                sessionPath,
                analysis,
              );
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
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          },
          (error) => {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
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
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
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
