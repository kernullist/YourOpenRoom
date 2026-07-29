import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import * as fs from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import { Readable } from 'stream';
import { callAoiMainTextModel, getAoiLlmStatus, loadAoiMainLlmConfig } from './dewdropCanvasPlugin';
import type { LLMConfig } from './llmModels';

const STATIC_PREFIX = '/written-by-me';
const API_PREFIX = '/api/written-by-me';
// Vendored in-repo copy of the Written By Me app; vite.config passes an
// absolute sourceRoot, so this relative fallback is only used if unset.
const DEFAULT_SOURCE_ROOT = resolve(process.cwd(), 'written-by-me');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_STORED_CONTENT = 50_000;
const MAX_TOTAL_CHARS = 100_000;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_LOG_ENTRIES = 200;

const STYLE_ANALYST_SYSTEM_PROMPT =
  'You are a writing style analyst. Your task is to analyze texts written by the same person and produce a comprehensive writing style profile in the exact Markdown format specified. Do not add commentary outside the requested format. Be precise and evidence-based in your analysis.';

const ALLOWED_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.log',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.cs',
  '.java',
  '.py',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.rs',
  '.go',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.html',
  '.css',
  '.scss',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.docx',
  '.pdf',
];

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'deepseek-v4-pro': 64_000,
  'deepseek-v4-flash': 64_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16_385,
  'gpt-5': 400_000,
  'gpt-5.3': 400_000,
  'gpt-5.4': 400_000,
  'gpt-5.5': 400_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-opus': 200_000,
  'claude-3-sonnet': 200_000,
  'claude-3-haiku': 200_000,
  'claude-3.5-sonnet': 200_000,
  o1: 200_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
};

type NextFunction = () => void;

type MiddlewareStack = {
  use: (
    middleware: (req: IncomingMessage, res: ServerResponse, next: NextFunction) => void,
  ) => void;
};

interface PluginOptions {
  sourceRoot?: string;
  configFile?: string;
}

interface TextSource {
  source: string;
  content: string;
}

interface StoredText {
  name: string;
  content: string;
}

interface StoredUrl {
  url: string;
  name: string;
  content: string;
}

interface UploadedFileInfo {
  id: string;
  name: string;
  size: number;
  type: string;
}

interface LogEntry {
  ts: number;
  type: 'info' | 'warn' | 'error';
  message: string;
}

interface ExternalModules {
  buildPrompt: (texts: TextSource[], preferredLanguage: string) => string;
  estimateTokens: (text: string) => number;
  buildMergePrompt: (analyses: string[], totalDocs: number, preferredLanguage: string) => string;
  extractText: (filePath: string, originalName: string) => Promise<string>;
  fetchUrlContent: (url: string) => Promise<{ title: string; text: string }>;
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function getErrorStatusCode(error: unknown): number {
  return error instanceof HttpError ? error.statusCode : 500;
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

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getHeaderString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function getRequestOrigin(req: IncomingMessage): string {
  const forwardedProto = getHeaderString(req.headers['x-forwarded-proto']).trim();
  const host = getHeaderString(req.headers.host).trim() || '127.0.0.1:3000';
  return `${forwardedProto || 'http'}://${host}`;
}

function getStaticRoot(sourceRoot: string): string {
  return join(sourceRoot, 'public');
}

function getUploadsDir(sourceRoot: string): string {
  return join(sourceRoot, 'uploads');
}

function getOutputDir(sourceRoot: string): string {
  return join(sourceRoot, 'output');
}

function getProfilesDir(sourceRoot: string): string {
  return join(sourceRoot, 'profiles');
}

function ensureWrittenByMeDirs(sourceRoot: string): void {
  fs.mkdirSync(getUploadsDir(sourceRoot), { recursive: true });
  fs.mkdirSync(getOutputDir(sourceRoot), { recursive: true });
  fs.mkdirSync(getProfilesDir(sourceRoot), { recursive: true });
}

function sourceIsReady(sourceRoot: string): boolean {
  const staticRoot = getStaticRoot(sourceRoot);
  return (
    fs.existsSync(join(staticRoot, 'index.html')) && fs.existsSync(join(staticRoot, 'script.js'))
  );
}

function resolveStaticFile(sourceRoot: string, pathname: string): string | null {
  const staticRoot = getStaticRoot(sourceRoot);
  let rawRelativePath = pathname === `${STATIC_PREFIX}/` ? 'index.html' : '';
  if (!rawRelativePath) {
    try {
      rawRelativePath = decodeURIComponent(pathname.slice(STATIC_PREFIX.length + 1));
    } catch {
      return null;
    }
  }
  const relativePath = rawRelativePath || 'index.html';
  const target = resolve(staticRoot, relativePath);
  return isPathInsideRoot(staticRoot, target) ? target : null;
}

function rewriteWrittenByMeScript(script: string): string {
  return script
    .replace(/fetch\(\s*(['"`])\/api\//g, `fetch($1${API_PREFIX}/`)
    .replace(/new EventSource\(\s*(['"`])\/api\//g, `new EventSource($1${API_PREFIX}/`)
    .replace(
      'footerConfig.textContent = "Provider: " + (cfg.provider === "claude_cli" ? "Claude CLI" : "API") + " | Model: " + (cfg.model || "deepseek-chat");',
      'footerConfig.textContent = "Provider: AOI Main LLM | Model: " + (cfg.model || "not configured");',
    )
    .replace(
      'footerConfig.textContent = "Model: deepseek-chat";',
      'footerConfig.textContent = "AOI Main LLM is not configured";',
    )
    .replace(
      'modelSelect.innerHTML = \'<option value="deepseek-chat">deepseek-chat</option>\';',
      'modelSelect.innerHTML = \'<option value="">AOI main model not configured</option>\';',
    )
    .replace('selectedModel = "deepseek-chat";', 'selectedModel = "";');
}

function makeHeaders(headers: IncomingHttpHeaders): Headers {
  const nextHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      nextHeaders.set(key, value);
    } else if (Array.isArray(value)) {
      nextHeaders.set(key, value.join(', '));
    }
  }
  return nextHeaders;
}

function isFormDataFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === 'object' &&
    value !== null &&
    'arrayBuffer' in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    'name' in value
  );
}

async function readJsonRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectBody(new HttpError(413, 'Request body is too large.'));
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
        rejectBody(new HttpError(400, 'Invalid JSON body.'));
      }
    });
  });
}

async function readUploadedFiles(
  req: IncomingMessage,
  uploadDir: string,
): Promise<UploadedFileInfo[]> {
  const webRequest = new Request('http://localhost/upload', {
    method: req.method || 'POST',
    headers: makeHeaders(req.headers),
    body: Readable.toWeb(req as Readable) as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const formData = await webRequest.formData();
  const files = formData.getAll('files').filter(isFormDataFile);

  if (files.length === 0) {
    throw new HttpError(400, 'No files provided.');
  }
  if (files.length > 10) {
    throw new HttpError(400, 'Maximum 10 files allowed.');
  }

  const uploaded: UploadedFileInfo[] = [];
  for (const file of files) {
    const originalName = file.name || 'uploaded-file';
    const ext = extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new HttpError(400, `Unsupported file type: ${ext}.`);
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new HttpError(413, `File too large. Max ${MAX_FILE_SIZE_MB}MB.`);
    }

    const id = randomUUID();
    const filePath = join(uploadDir, `${id}${ext}`);
    const content = Buffer.from(await file.arrayBuffer());
    await fs.promises.writeFile(filePath, content);
    uploaded.push({
      id,
      name: originalName,
      size: file.size,
      type: ext,
    });
  }

  return uploaded;
}

function clearDirectoryFiles(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const root = resolve(directory);
  for (const entry of fs.readdirSync(root)) {
    const target = resolve(root, entry);
    if (!isPathInsideRoot(root, target)) continue;
    try {
      if (fs.statSync(target).isFile()) {
        fs.unlinkSync(target);
      }
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }
}

function getAoiConfigOrThrow(configFile: string): LLMConfig {
  const config = loadAoiMainLlmConfig(configFile);
  if (!config) {
    throw new HttpError(503, 'AOI main LLM is not configured. Open Settings > Models first.');
  }
  return config;
}

function normalizeModelKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^deepseek\//, '')
    .replace(/^opencode\//, '');
}

function getContextWindow(config: LLMConfig): number {
  const model = normalizeModelKey(config.model);
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  if (model.startsWith('gpt-5')) return 400_000;
  if (model.startsWith('gpt-4.1') || model.startsWith('gpt-4o')) return 128_000;
  if (model.includes('claude')) return 200_000;
  if (model.includes('deepseek')) return 64_000;
  if (model.includes('kimi')) return 128_000;
  if (config.provider === 'claude-cli') return 200_000;
  return 64_000;
}

async function analyzeStyleWithAoi(
  config: LLMConfig,
  serverOrigin: string,
  prompt: string,
): Promise<string> {
  const fullPrompt = `${STYLE_ANALYST_SYSTEM_PROMPT}\n\n${prompt}`;
  const result = await callAoiMainTextModel(config, serverOrigin, fullPrompt, MAX_OUTPUT_TOKENS);
  if (!result.trim()) {
    throw new Error('AOI main LLM returned empty output.');
  }
  return result;
}

async function analyzeWithBatching(
  modules: ExternalModules,
  config: LLMConfig,
  serverOrigin: string,
  allTexts: TextSource[],
  preferredLanguage: string,
  logEvent: (type: LogEntry['type'], message: string) => void,
): Promise<{ skillMd: string; strategy: string; batches: number }> {
  if (allTexts.length === 0) {
    throw new HttpError(400, 'No texts to analyze.');
  }

  const contextWindow = getContextWindow(config);
  const safetyMargin = Math.ceil(contextWindow * 0.15);
  const availableForInput = contextWindow - MAX_OUTPUT_TOKENS - safetyMargin;
  const fullPrompt = modules.buildPrompt(allTexts, preferredLanguage);
  const totalTokens = modules.estimateTokens(fullPrompt);

  if (totalTokens <= availableForInput) {
    logEvent(
      'info',
      `Strategy: single_pass (${allTexts.length} sources, approx ${totalTokens} tokens)`,
    );
    const skillMd = await analyzeStyleWithAoi(config, serverOrigin, fullPrompt);
    return { skillMd, strategy: 'single_pass', batches: 1 };
  }

  logEvent('info', `Strategy: batched (${totalTokens} tokens exceeds ${availableForInput})`);
  const batches: TextSource[][] = [];
  let currentBatch: TextSource[] = [];
  let currentTokens = 0;

  for (const text of allTexts) {
    const truncated = text.content.length > 15_000 ? text.content.slice(0, 15_000) : text.content;
    const entryTokens = modules.estimateTokens(truncated) + 20;
    if (
      currentBatch.length > 0 &&
      (currentTokens + entryTokens > availableForInput || currentBatch.length >= 5)
    ) {
      batches.push([...currentBatch]);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(text);
    currentTokens += entryTokens;
  }

  if (currentBatch.length > 0) {
    batches.push([...currentBatch]);
  }

  if (batches.length === 1) {
    const skillMd = await analyzeStyleWithAoi(config, serverOrigin, fullPrompt);
    return { skillMd, strategy: 'single_pass', batches: 1 };
  }

  const analyses: string[] = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    logEvent('info', `Batch ${index + 1}/${batches.length}: analyzing ${batch.length} sources`);
    const batchPrompt = modules.buildPrompt(batch, preferredLanguage);
    analyses.push(await analyzeStyleWithAoi(config, serverOrigin, batchPrompt));
  }

  logEvent('info', `Merging ${analyses.length} batch analyses`);
  const mergePrompt = modules.buildMergePrompt(analyses, allTexts.length, preferredLanguage);
  const skillMd = await analyzeStyleWithAoi(config, serverOrigin, mergePrompt);
  return { skillMd, strategy: 'batched', batches: batches.length };
}

function normalizeTextSources(value: unknown): TextSource[] {
  if (!Array.isArray(value)) return [];
  const texts: TextSource[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const source = getString((item as Record<string, unknown>).source).trim() || 'pasted-text';
    const content = getString((item as Record<string, unknown>).content).trim();
    if (content) {
      texts.push({ source, content });
    }
  }
  return texts;
}

function normalizeIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => getString(item).trim()).filter(Boolean);
}

function saveAnalysisOutput(sourceRoot: string, skillMd: string): Promise<string> {
  const analysisId = randomUUID();
  const outputPath = join(getOutputDir(sourceRoot), `${analysisId}.md`);
  return fs.promises.writeFile(outputPath, skillMd, 'utf-8').then(() => analysisId);
}

// --- Saved style profiles + style conversion ---------------------------------
// A profile persists an analyzed writing style (the Skill.md) under a name so it
// can be reused across sessions to convert new text into that voice. Stored as
// one JSON file per profile in <sourceRoot>/profiles, mirroring how output/ and
// uploads/ live on the external app's filesystem.

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROFILE_NAME = 120;
const MAX_PROFILES = 50;

export type WrittenByMeConvertLanguage = 'same' | 'ko' | 'en';

export interface WrittenByMeProfile {
  version: 1;
  id: string;
  name: string;
  skillMd: string;
  createdAt: number;
  updatedAt: number;
}

export type WrittenByMeProfileSummary = Pick<
  WrittenByMeProfile,
  'id' | 'name' | 'createdAt' | 'updatedAt'
>;

export function normalizeWrittenByMeProfileName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PROFILE_NAME);
}

export function readWrittenByMeProfile(profilesDir: string, id: string): WrittenByMeProfile | null {
  if (!PROFILE_ID_PATTERN.test(id)) {
    return null;
  }
  const filePath = join(profilesDir, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<WrittenByMeProfile>;
    if (!parsed || typeof parsed.skillMd !== 'string' || !parsed.skillMd.trim()) {
      return null;
    }
    return {
      version: 1,
      id,
      name: normalizeWrittenByMeProfileName(parsed.name) || 'Untitled style',
      skillMd: parsed.skillMd,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function listWrittenByMeProfiles(profilesDir: string): WrittenByMeProfileSummary[] {
  if (!fs.existsSync(profilesDir)) {
    return [];
  }
  const summaries: WrittenByMeProfileSummary[] = [];
  for (const file of fs.readdirSync(profilesDir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const profile = readWrittenByMeProfile(profilesDir, file.slice(0, -5));
    if (profile) {
      summaries.push({
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      });
    }
  }
  summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  return summaries;
}

export function saveWrittenByMeProfile(
  profilesDir: string,
  input: { name: unknown; skillMd: unknown; id?: string; now?: number },
): WrittenByMeProfile {
  const skillMd = typeof input.skillMd === 'string' ? input.skillMd : '';
  if (!skillMd.trim()) {
    throw new HttpError(400, 'A style (skillMd) is required to save a profile.');
  }
  fs.mkdirSync(profilesDir, { recursive: true });
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const existing =
    input.id && PROFILE_ID_PATTERN.test(input.id)
      ? readWrittenByMeProfile(profilesDir, input.id)
      : null;
  const profile: WrittenByMeProfile = {
    version: 1,
    id: existing?.id ?? randomUUID(),
    name: normalizeWrittenByMeProfileName(input.name) || 'Untitled style',
    skillMd,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  fs.writeFileSync(
    join(profilesDir, `${profile.id}.json`),
    JSON.stringify(profile, null, 2),
    'utf-8',
  );
  return profile;
}

export function deleteWrittenByMeProfile(profilesDir: string, id: string): boolean {
  if (!PROFILE_ID_PATTERN.test(id)) {
    return false;
  }
  const filePath = join(profilesDir, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

export function normalizeWrittenByMeConvertLanguage(value: unknown): WrittenByMeConvertLanguage {
  return value === 'ko' || value === 'en' ? value : 'same';
}

// Prompt that rewrites arbitrary text into the profiled author's voice. Same
// language by default; when a target language is given it also translates while
// keeping the style. Meaning is preserved -- this restyles, it does not summarize.
export function buildWrittenByMeConvertPrompt(
  text: string,
  skillMd: string,
  targetLanguage: WrittenByMeConvertLanguage,
): string {
  const languageDirective =
    targetLanguage === 'ko'
      ? 'Write the output in Korean, translating from the source language if needed.'
      : targetLanguage === 'en'
        ? 'Write the output in English, translating from the source language if needed.'
        : 'Write the output in the same language as the source text.';
  return `Rewrite the text below so it reads as if the profiled author wrote it, matching this writing style profile exactly:

${skillMd}

Rules:
- Preserve the original meaning, facts, and intent. Do not add, drop, or summarize information.
- Apply the profile's tone, vocabulary, sentence rhythm, and punctuation habits.
- ${languageDirective}
- Return ONLY the rewritten text, with no preamble, notes, or explanation.

TEXT TO REWRITE:
${text}`;
}

function loadExternalModules(sourceRoot: string): ExternalModules {
  const requireFromSource = createRequire(join(sourceRoot, 'package.json'));
  const skillGenerator = requireFromSource('./services/skillGenerator.js') as {
    buildPrompt: ExternalModules['buildPrompt'];
    estimateTokens: ExternalModules['estimateTokens'];
    buildMergePrompt: ExternalModules['buildMergePrompt'];
  };
  const textExtractor = requireFromSource('./services/textExtractor.js') as {
    extractText: ExternalModules['extractText'];
  };
  const urlFetcher = requireFromSource('./services/urlFetcher.js') as {
    fetchUrlContent: ExternalModules['fetchUrlContent'];
  };

  return {
    buildPrompt: skillGenerator.buildPrompt,
    estimateTokens: skillGenerator.estimateTokens,
    buildMergePrompt: skillGenerator.buildMergePrompt,
    extractText: textExtractor.extractText,
    fetchUrlContent: urlFetcher.fetchUrlContent,
  };
}

function handleWrittenByMeStatic(
  sourceRoot: string,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
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
      `<!doctype html><title>Written By Me unavailable</title><body>Written By Me source not found: ${sourceRoot}</body>`,
    );
    return true;
  }

  const filePath = resolveStaticFile(sourceRoot, url.pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    writeText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return true;
  }

  if (basename(filePath) === 'script.js') {
    writeText(
      res,
      200,
      getContentType(filePath),
      rewriteWrittenByMeScript(fs.readFileSync(filePath, 'utf-8')),
    );
    return true;
  }

  const payload =
    extname(filePath).toLowerCase() === '.html'
      ? fs.readFileSync(filePath, 'utf-8')
      : fs.readFileSync(filePath);
  writeText(res, 200, getContentType(filePath), payload);
  return true;
}

export function writtenByMePlugin(options: PluginOptions = {}): Plugin {
  const sourceRoot = resolve(
    options.sourceRoot || process.env.WRITTEN_BY_ME_ROOT || DEFAULT_SOURCE_ROOT,
  );
  const configFile = options.configFile ? resolve(options.configFile) : '';
  const textStore = new Map<string, StoredText>();
  const urlStore = new Map<string, StoredUrl>();
  const logBuffer: LogEntry[] = [];
  const logListeners = new Set<(entry: LogEntry) => void>();
  let modules: ExternalModules | null = null;

  const logEvent = (type: LogEntry['type'], message: string): void => {
    const entry = { ts: Date.now(), type, message };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer.shift();
    }
    for (const listener of logListeners) {
      listener(entry);
    }
    const prefix = type === 'error' ? '[ERROR]' : type === 'warn' ? '[WARN]' : '[INFO]';
    console.log(`[WrittenByMe] ${prefix} ${message}`);
  };

  const getModules = (): ExternalModules => {
    if (!modules) {
      modules = loadExternalModules(sourceRoot);
    }
    return modules;
  };

  const handleLogStream = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const listener = (entry: LogEntry): void => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    logListeners.add(listener);
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);
    keepAlive.unref?.();

    req.on('close', () => {
      logListeners.delete(listener);
      clearInterval(keepAlive);
    });
  };

  const handleUpload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const uploaded = await readUploadedFiles(req, getUploadsDir(sourceRoot));
    const extracted: UploadedFileInfo[] = [];
    const currentModules = getModules();

    for (const file of uploaded) {
      const filePath = join(getUploadsDir(sourceRoot), `${file.id}${file.type}`);
      const text = await currentModules.extractText(filePath, file.name);
      const capped = text.length > MAX_STORED_CONTENT ? text.slice(0, MAX_STORED_CONTENT) : text;
      textStore.set(file.id, { name: file.name, content: capped });
      logEvent('info', `Uploaded: ${file.name} (${text.length} chars)`);
      extracted.push(file);
    }

    writeJson(res, 200, { ok: true, files: extracted });
  };

  const runAnalysis = async (
    req: IncomingMessage,
    body: Record<string, unknown>,
    texts: TextSource[],
  ): Promise<{ analysisId: string; skillMd: string; strategy: string; batches: number }> => {
    const totalChars = texts.reduce((sum, text) => sum + text.content.length, 0);
    if (texts.length === 0 || totalChars === 0) {
      throw new HttpError(
        400,
        'No content available. Upload files, paste text, or add URLs first.',
      );
    }
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new HttpError(
        413,
        `Combined text too large (${totalChars} chars). Maximum is ${MAX_TOTAL_CHARS} characters.`,
      );
    }

    const config = getAoiConfigOrThrow(configFile);
    logEvent('info', `Analysis started: ${texts.length} sources, ${totalChars} total chars`);
    const { skillMd, strategy, batches } = await analyzeWithBatching(
      getModules(),
      config,
      getRequestOrigin(req),
      texts,
      getString(body.preferredLanguage).trim() || 'auto',
      logEvent,
    );
    const analysisId = await saveAnalysisOutput(sourceRoot, skillMd);
    logEvent('info', `Analysis complete: ${skillMd.length} chars Skill.md generated`);
    return { analysisId, skillMd, strategy, batches };
  };

  const handleAnalyzeWithPaste = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const texts = normalizeTextSources(body.pasteTexts);
    const pastedText = getString(body.pastedText).trim();
    if (pastedText) {
      texts.push({ source: 'pasted-text', content: pastedText });
    }

    const missingFileIds: string[] = [];
    for (const fileId of normalizeIdArray(body.fileIds)) {
      const stored = textStore.get(fileId);
      if (stored) {
        texts.push({ source: stored.name, content: stored.content });
      } else {
        missingFileIds.push(fileId);
      }
    }

    const missingUrlIds: string[] = [];
    for (const urlId of normalizeIdArray(body.urlIds)) {
      const stored = urlStore.get(urlId);
      if (stored) {
        texts.push({ source: `[URL] ${stored.name}`, content: stored.content });
      } else {
        missingUrlIds.push(urlId);
      }
    }

    const { analysisId, skillMd, strategy, batches } = await runAnalysis(req, body, texts);
    const response: Record<string, unknown> = {
      ok: true,
      analysisId,
      strategy,
      batches,
      analysis: { skillMd },
    };
    if (missingFileIds.length > 0) {
      response.warning = `${missingFileIds.length} uploaded file(s) could not be found. Please re-upload those files.`;
      response.missingFileIds = missingFileIds;
    }
    if (missingUrlIds.length > 0) {
      response.warning = `${response.warning ? `${response.warning} ` : ''}${missingUrlIds.length} URL(s) could not be found. Please re-fetch them.`;
      response.missingUrlIds = missingUrlIds;
    }
    writeJson(res, 200, response);
  };

  const handleWrittenByMeApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (!url.pathname.startsWith(API_PREFIX)) return false;

    if (url.pathname === `${API_PREFIX}/logs/stream`) {
      handleLogStream(req, res);
      return true;
    }

    if (url.pathname === `${API_PREFIX}/status`) {
      writeJson(res, 200, {
        ok: sourceIsReady(sourceRoot),
        sourceRoot,
        staticBase: STATIC_PREFIX,
        apiBase: API_PREFIX,
        uploadDirectory: getUploadsDir(sourceRoot),
        outputDirectory: getOutputDir(sourceRoot),
        aoiMainLlm: getAoiLlmStatus(configFile),
      });
      return true;
    }

    if (url.pathname === `${API_PREFIX}/config`) {
      const aoiConfig = loadAoiMainLlmConfig(configFile);
      const model = aoiConfig?.model || '';
      writeJson(res, 200, {
        provider: 'aoi_main',
        model,
        groups: model ? [{ label: 'AOI Main LLM', models: [model] }] : [],
        maxFileSizeMb: MAX_FILE_SIZE_MB,
        aoiMainLlm: getAoiLlmStatus(configFile),
      });
      return true;
    }

    if (!sourceIsReady(sourceRoot)) {
      writeJson(res, 503, { error: `Written By Me source not found: ${sourceRoot}` });
      return true;
    }

    ensureWrittenByMeDirs(sourceRoot);
    const route = url.pathname.slice(API_PREFIX.length) || '/';

    try {
      if (req.method === 'POST' && route === '/upload') {
        await handleUpload(req, res);
        return true;
      }

      if (req.method === 'POST' && route === '/fetch-url') {
        const body = await readJsonRequestBody(req);
        const rawUrl = getString(body.url).trim();
        if (!rawUrl) {
          writeJson(res, 400, { error: 'URL is required.' });
          return true;
        }
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          writeJson(res, 400, { error: 'Invalid URL.' });
          return true;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          writeJson(res, 400, { error: 'Only http/https URLs are supported.' });
          return true;
        }

        logEvent('info', `Fetching URL: ${rawUrl}`);
        const { title, text } = await getModules().fetchUrlContent(rawUrl);
        const id = randomUUID();
        const source = title.length > 80 ? `${title.slice(0, 80)}...` : title;
        const capped = text.length > MAX_STORED_CONTENT ? text.slice(0, MAX_STORED_CONTENT) : text;
        urlStore.set(id, { url: rawUrl, name: source, content: capped });
        logEvent('info', `URL fetched: ${source} (${text.length} chars)`);
        writeJson(res, 200, { ok: true, id, title: source, charCount: text.length });
        return true;
      }

      if (req.method === 'POST' && route === '/analyze-with-paste') {
        const body = await readJsonRequestBody(req);
        await handleAnalyzeWithPaste(req, res, body);
        return true;
      }

      if (req.method === 'POST' && route === '/analyze') {
        const body = await readJsonRequestBody(req);
        const texts = normalizeTextSources(body.texts);
        const { analysisId, skillMd, strategy, batches } = await runAnalysis(req, body, texts);
        writeJson(res, 200, {
          ok: true,
          analysisId,
          strategy,
          batches,
          analysis: { skillMd },
        });
        return true;
      }

      if (req.method === 'POST' && route === '/translate') {
        const body = await readJsonRequestBody(req);
        const text = getString(body.text).trim();
        const skillMd = getString(body.skillMd).trim();
        if (!text) {
          writeJson(res, 400, { error: 'No text to translate.' });
          return true;
        }
        if (!skillMd) {
          writeJson(res, 400, { error: 'No style reference. Run an analysis first.' });
          return true;
        }

        const direction = getString(body.direction) === 'kr2en' ? 'kr2en' : 'en2kr';
        const targetLang = direction === 'kr2en' ? 'English' : 'Korean';
        const prompt = `Translate the following text to ${targetLang}. The translation MUST be written in exactly this writing style:

${skillMd}

TEXT TO TRANSLATE:
${text}

Return ONLY the translated text with no additional commentary.`;
        const config = getAoiConfigOrThrow(configFile);
        logEvent('info', `Translation started (${text.length} chars)`);
        const translated = await callAoiMainTextModel(
          config,
          getRequestOrigin(req),
          prompt,
          Math.min(MAX_OUTPUT_TOKENS, 4096),
        );
        logEvent('info', `Translation complete: ${translated.length} chars`);
        writeJson(res, 200, { ok: true, translated });
        return true;
      }

      if (req.method === 'POST' && route === '/clear') {
        const cleared = textStore.size + urlStore.size;
        textStore.clear();
        urlStore.clear();
        clearDirectoryFiles(getUploadsDir(sourceRoot));
        writeJson(res, 200, { ok: true, cleared });
        return true;
      }

      if (req.method === 'POST' && route === '/profiles') {
        const body = await readJsonRequestBody(req);
        const skillMd = getString(body.skillMd).trim();
        if (!skillMd) {
          writeJson(res, 400, { error: 'No style to save. Run an analysis first.' });
          return true;
        }
        const requestedId = getString(body.id).trim();
        const profilesDir = getProfilesDir(sourceRoot);
        if (!requestedId && listWrittenByMeProfiles(profilesDir).length >= MAX_PROFILES) {
          writeJson(res, 400, {
            error: `Profile limit reached (${MAX_PROFILES}). Delete one before saving a new profile.`,
          });
          return true;
        }
        const saved = saveWrittenByMeProfile(profilesDir, {
          name: body.name,
          skillMd,
          ...(requestedId ? { id: requestedId } : {}),
        });
        logEvent('info', `Saved style profile "${saved.name}" (${saved.id})`);
        writeJson(res, 200, {
          ok: true,
          profile: {
            id: saved.id,
            name: saved.name,
            createdAt: saved.createdAt,
            updatedAt: saved.updatedAt,
          },
        });
        return true;
      }

      if (req.method === 'GET' && route === '/profiles') {
        writeJson(res, 200, {
          ok: true,
          profiles: listWrittenByMeProfiles(getProfilesDir(sourceRoot)),
        });
        return true;
      }

      const profileMatch = route.match(/^\/profiles\/([0-9a-f-]+)$/i);
      if (profileMatch) {
        const profileId = profileMatch[1];
        if (req.method === 'GET') {
          const profile = readWrittenByMeProfile(getProfilesDir(sourceRoot), profileId);
          if (!profile) {
            writeJson(res, 404, { error: 'Style profile not found.' });
            return true;
          }
          writeJson(res, 200, { ok: true, profile });
          return true;
        }
        if (req.method === 'DELETE') {
          const deleted = deleteWrittenByMeProfile(getProfilesDir(sourceRoot), profileId);
          if (!deleted) {
            writeJson(res, 404, { error: 'Style profile not found.' });
            return true;
          }
          logEvent('info', `Deleted style profile ${profileId}`);
          writeJson(res, 200, { ok: true, deleted: true });
          return true;
        }
      }

      if (req.method === 'POST' && route === '/convert') {
        const body = await readJsonRequestBody(req);
        let skillMd = getString(body.skillMd).trim();
        const profileId = getString(body.profileId).trim();
        if (profileId) {
          const profile = readWrittenByMeProfile(getProfilesDir(sourceRoot), profileId);
          if (!profile) {
            writeJson(res, 404, { error: 'Style profile not found.' });
            return true;
          }
          skillMd = profile.skillMd;
        }
        if (!skillMd) {
          writeJson(res, 400, { error: 'No style reference. Select or save a profile first.' });
          return true;
        }

        const parts: string[] = [];
        const pastedText = getString(body.text).trim();
        if (pastedText) {
          parts.push(pastedText);
        }
        const missingFileIds: string[] = [];
        for (const fileId of normalizeIdArray(body.fileIds)) {
          const stored = textStore.get(fileId);
          if (stored) {
            parts.push(stored.content);
          } else {
            missingFileIds.push(fileId);
          }
        }
        const combined = parts.join('\n\n').trim();
        if (!combined) {
          writeJson(res, 400, { error: 'No text to convert. Paste text or upload a file first.' });
          return true;
        }
        if (combined.length > MAX_TOTAL_CHARS) {
          writeJson(res, 413, {
            error: `Text too large (${combined.length} chars). Maximum is ${MAX_TOTAL_CHARS} characters.`,
          });
          return true;
        }

        const targetLanguage = normalizeWrittenByMeConvertLanguage(body.targetLanguage);
        const prompt = buildWrittenByMeConvertPrompt(combined, skillMd, targetLanguage);
        const config = getAoiConfigOrThrow(configFile);
        logEvent('info', `Convert started (${combined.length} chars, target=${targetLanguage})`);
        const converted = await callAoiMainTextModel(
          config,
          getRequestOrigin(req),
          prompt,
          Math.min(MAX_OUTPUT_TOKENS, 4096),
        );
        logEvent('info', `Convert complete: ${converted.length} chars`);
        const response: Record<string, unknown> = { ok: true, converted };
        if (missingFileIds.length > 0) {
          response.warning = `${missingFileIds.length} uploaded file(s) could not be found. Please re-upload those files.`;
          response.missingFileIds = missingFileIds;
        }
        writeJson(res, 200, response);
        return true;
      }

      const downloadMatch = route.match(/^\/download\/([0-9a-f-]+)$/i);
      if (req.method === 'GET' && downloadMatch) {
        const analysisId = downloadMatch[1];
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(analysisId)) {
          writeJson(res, 400, { error: 'Invalid analysis ID.' });
          return true;
        }
        const outputPath = join(getOutputDir(sourceRoot), `${analysisId}.md`);
        if (!fs.existsSync(outputPath)) {
          writeJson(res, 404, { error: 'Analysis not found. It may have expired.' });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="Skill.md"',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(outputPath).pipe(res);
        return true;
      }

      writeJson(res, 404, { error: 'Written By Me API route not found.' });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = getErrorStatusCode(error);
      logEvent(statusCode >= 500 ? 'error' : 'warn', message);
      writeJson(res, statusCode, { error: message });
      return true;
    }
  };

  const mount = (middlewares: MiddlewareStack) => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');

      void handleWrittenByMeApi(req, res, url)
        .then((handled) => {
          if (handled) return;
          if (handleWrittenByMeStatic(sourceRoot, req, res, url)) return;
          next();
        })
        .catch((error) => {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
    });
  };

  return {
    name: 'written-by-me',
    configureServer(server) {
      ensureWrittenByMeDirs(sourceRoot);
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      ensureWrittenByMeDirs(sourceRoot);
      mount(server.middlewares);
    },
  };
}
