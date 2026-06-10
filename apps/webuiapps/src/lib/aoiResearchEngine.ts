import * as dns from 'dns/promises';
import * as fs from 'fs';
import { isIP } from 'net';
import { dirname } from 'path';
import { callAoiMainTextModel, loadAoiMainLlmConfig } from './dewdropCanvasPlugin';
import type { LLMConfig } from './llmModels';
import {
  buildAoiResearchArtifactPaths,
  type AoiResearchArtifactName,
  type AoiResearchErrorDetail,
  type AoiResearchEvidenceClaim,
  type AoiResearchLanguage,
  type AoiResearchManifest,
  type AoiResearchMode,
  type AoiResearchPlan,
  type AoiResearchProgressPhase,
  type AoiResearchRecency,
  type AoiResearchSource,
  type AoiResearchSourceBlock,
  type AoiResearchSourceCounts,
  type AoiResearchStartRequest,
} from './aoiResearchTypes';

const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com/search';
const SEARCH_CONCURRENCY = 3;
const READER_CONCURRENCY = 3;
const EVIDENCE_CONCURRENCY = 2;
const MAX_PLAN_QUERIES = 8;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const LLM_PLAN_TOKENS = 1600;
const LLM_EVIDENCE_TOKENS = 1400;

const EMPTY_SOURCE_COUNTS: AoiResearchSourceCounts = {
  planned: 0,
  candidates: 0,
  accepted: 0,
  failed: 0,
};

const ARTIFACT_NAMES: AoiResearchArtifactName[] = ['manifest', 'report', 'sources', 'evidence'];
const CANCELLED_RUN_IDS = new Set<string>();

type ResearchFetch = (input: string, init?: RequestInit) => Promise<Response>;
type HostResolver = (hostname: string) => Promise<string[]>;

export interface AoiResearchRunPaths {
  runDir: string;
  manifest: string;
  report: string;
  sources: string;
  evidence: string;
}

export interface AoiResearchNormalizedRequest {
  sessionPath: string;
  request: string;
  mode: AoiResearchMode;
  language: AoiResearchLanguage;
  recency: AoiResearchRecency;
  maxSources: number;
}

export interface AoiResearchTavilyConfig {
  apiKey: string;
  baseUrl: string;
}

export interface AoiResearchSearchCandidate {
  title: string;
  url: string;
  content: string;
  score?: number;
  searchQuery: string;
}

export interface AoiResearchUrlValidationResult {
  ok: boolean;
  normalizedUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AoiResearchEngineDependencies {
  now?: () => number;
  loadLlmConfig?: (configFile: string) => LLMConfig | null;
  callModel?: (
    config: LLMConfig,
    serverOrigin: string,
    prompt: string,
    maxTokens: number,
    responseJson?: boolean,
  ) => Promise<string>;
  loadTavilyConfig?: (configFile: string) => AoiResearchTavilyConfig | null;
  fetch?: ResearchFetch;
  resolveHost?: HostResolver;
  shouldCancel?: (runId: string, phase: AoiResearchProgressPhase) => boolean | Promise<boolean>;
  onPhase?: (
    phase: AoiResearchProgressPhase,
    manifest: AoiResearchManifest,
  ) => void | Promise<void>;
}

export interface StartAoiResearchRunParams {
  configFile: string;
  serverOrigin: string;
  sessionPath: string;
  runId: string;
  paths: AoiResearchRunPaths;
  request: AoiResearchStartRequest;
  dependencies?: AoiResearchEngineDependencies;
}

interface AoiResearchSourcesArtifact {
  version: 1;
  runId: string;
  savedAt: number;
  sources: AoiResearchSource[];
}

interface AoiResearchEvidenceArtifact {
  version: 1;
  runId: string;
  savedAt: number;
  claims: AoiResearchEvidenceClaim[];
}

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
  error?: string;
}

interface ParsedReadableSource {
  finalUrl: string;
  title: string;
  siteName: string;
  excerpt: string;
  blocks: AoiResearchSourceBlock[];
}

class AoiResearchFailure extends Error {
  readonly code: string;
  readonly phase: AoiResearchProgressPhase;

  constructor(code: string, message: string, phase: AoiResearchProgressPhase) {
    super(message);
    this.code = code;
    this.phase = phase;
  }
}

class AoiResearchCancelled extends Error {
  constructor(message: string) {
    super(message);
  }
}

function getNow(dependencies?: AoiResearchEngineDependencies): number {
  return dependencies?.now?.() ?? Date.now();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMode(value: unknown): AoiResearchMode {
  return value === 'quick' || value === 'deep' ? value : 'standard';
}

function normalizeLanguage(value: unknown): AoiResearchLanguage {
  return value === 'ko' || value === 'en' ? value : 'match-user';
}

function normalizeRecency(value: unknown): AoiResearchRecency {
  if (value === 'day' || value === 'week' || value === 'month' || value === 'year') {
    return value;
  }
  return 'any';
}

function normalizeMaxSources(value: unknown, mode: AoiResearchMode): number {
  const fallback = mode === 'quick' ? 5 : mode === 'deep' ? 24 : 12;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(40, Math.max(1, Math.trunc(parsed)));
}

export function normalizeAoiResearchRequest(
  request: AoiResearchStartRequest,
): AoiResearchNormalizedRequest {
  const mode = normalizeMode(request.mode);
  return {
    sessionPath: request.sessionPath,
    request: truncateText(request.request, 3000),
    mode,
    language: normalizeLanguage(request.language),
    recency: normalizeRecency(request.recency),
    maxSources: normalizeMaxSources(request.maxSources, mode),
  };
}

function normalizeTavilySearchEndpoint(baseUrl?: string): string {
  const trimmed = baseUrl?.trim() || DEFAULT_TAVILY_BASE_URL;
  if (/\/search\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return `${trimmed.replace(/\/+$/, '')}/search`;
}

export function loadAoiResearchTavilyConfig(configFile: string): AoiResearchTavilyConfig | null {
  try {
    if (!configFile || !fs.existsSync(configFile)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    const raw =
      typeof parsed.tavily === 'object' && parsed.tavily !== null
        ? (parsed.tavily as Record<string, unknown>)
        : null;
    const apiKey = getString(raw?.apiKey);
    if (!apiKey) {
      return null;
    }
    return {
      apiKey,
      baseUrl: normalizeTavilySearchEndpoint(getString(raw?.baseUrl)),
    };
  } catch {
    return null;
  }
}

function createErrorDetail(
  code: string,
  message: string,
  phase: AoiResearchProgressPhase,
  now: number,
  detail?: string,
): AoiResearchErrorDetail {
  return {
    code,
    message: truncateText(message, 500),
    phase,
    ...(detail ? { detail: truncateText(detail, 1000) } : {}),
    createdAt: now,
  };
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeJsonFile(filePath: string, content: unknown): void {
  writeTextFile(filePath, JSON.stringify(content, null, 2));
}

function getArtifactAvailability(
  paths: AoiResearchRunPaths,
): Record<AoiResearchArtifactName, boolean> {
  const availability = {} as Record<AoiResearchArtifactName, boolean>;
  for (const artifact of ARTIFACT_NAMES) {
    availability[artifact] = fs.existsSync(paths[artifact]);
  }
  return availability;
}

function countSources(
  planned: number,
  candidates: number,
  sources: AoiResearchSource[],
): AoiResearchSourceCounts {
  return {
    planned,
    candidates,
    accepted: sources.filter((source) => source.status === 'accepted').length,
    failed: sources.filter((source) => source.status === 'failed').length,
  };
}

function createInitialManifest(params: {
  normalized: AoiResearchNormalizedRequest;
  runId: string;
  now: number;
  paths: AoiResearchRunPaths;
}): AoiResearchManifest {
  return {
    version: 1,
    id: params.runId,
    sessionPath: params.normalized.sessionPath,
    request: params.normalized.request,
    mode: params.normalized.mode,
    language: params.normalized.language,
    recency: params.normalized.recency,
    maxSources: params.normalized.maxSources,
    createdAt: params.now,
    updatedAt: params.now,
    status: 'queued',
    phase: 'queued',
    statusMessage: 'Research run queued.',
    sourceCounts: { ...EMPTY_SOURCE_COUNTS, planned: params.normalized.maxSources },
    artifactPaths: buildAoiResearchArtifactPaths(params.runId),
    artifactAvailability: getArtifactAvailability(params.paths),
  };
}

function persistSources(
  paths: AoiResearchRunPaths,
  runId: string,
  sources: AoiResearchSource[],
  now: number,
): void {
  const artifact: AoiResearchSourcesArtifact = {
    version: 1,
    runId,
    savedAt: now,
    sources,
  };
  writeJsonFile(paths.sources, artifact);
}

function persistEvidence(
  paths: AoiResearchRunPaths,
  runId: string,
  claims: AoiResearchEvidenceClaim[],
  now: number,
): void {
  const artifact: AoiResearchEvidenceArtifact = {
    version: 1,
    runId,
    savedAt: now,
    claims,
  };
  writeJsonFile(paths.evidence, artifact);
}

function persistPlaceholderReport(params: {
  paths: AoiResearchRunPaths;
  manifest: AoiResearchManifest;
  sources: AoiResearchSource[];
  claims: AoiResearchEvidenceClaim[];
  reason?: string;
}): void {
  const accepted = params.sources.filter((source) => source.status === 'accepted');
  const failed = params.sources.filter((source) => source.status === 'failed');
  const plan = params.manifest.plan;
  const title = plan?.title || params.manifest.request;
  const lines = [
    `# ${title}`,
    '',
    'This is a collection and evidence placeholder. Final synthesis is handled by the next phase.',
    '',
    `Run id: ${params.manifest.id}`,
    `Status: ${params.manifest.status}`,
    `Phase: ${params.manifest.phase}`,
    `Request: ${params.manifest.request}`,
    `Accepted sources: ${accepted.length}`,
    `Failed sources: ${failed.length}`,
    `Evidence claims: ${params.claims.length}`,
    ...(params.reason ? [`Reason: ${params.reason}`] : []),
    '',
    '## Search Queries',
    ...(plan?.searchQueries.length ? plan.searchQueries.map((query) => `- ${query}`) : ['- none']),
    '',
    '## Accepted Sources',
    ...(accepted.length
      ? accepted.map((source) => `- [${source.title}](${source.finalUrl || source.url})`)
      : ['- none']),
    '',
    '## Source Errors',
    ...(failed.length
      ? failed.map((source) => `- ${source.url}: ${source.error?.message || 'unknown error'}`)
      : ['- none']),
    '',
  ];
  writeTextFile(params.paths.report, lines.join('\n'));
}

async function persistManifest(
  paths: AoiResearchRunPaths,
  manifest: AoiResearchManifest,
  dependencies?: AoiResearchEngineDependencies,
): Promise<AoiResearchManifest> {
  const nextManifest: AoiResearchManifest = {
    ...manifest,
    artifactAvailability: {
      ...getArtifactAvailability(paths),
      manifest: true,
    },
  };
  writeJsonFile(paths.manifest, nextManifest);
  await dependencies?.onPhase?.(nextManifest.phase, nextManifest);
  return nextManifest;
}

function extractStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => getString(item))
    .filter(Boolean)
    .map((item) => truncateText(item, 240))
    .slice(0, maxItems);
}

export function extractAoiResearchJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue with brace scanning.
  }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = firstBrace; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(trimmed.slice(firstBrace, index + 1)) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function buildFallbackResearchPlan(
  normalized: AoiResearchNormalizedRequest,
  createdAt: number,
): AoiResearchPlan {
  const request = truncateText(normalized.request, 240);
  const recencyQuery =
    normalized.recency === 'any' ? request : `${request} ${normalized.recency} recent sources`;
  const queries = Array.from(
    new Set([
      recencyQuery,
      `${request} research`,
      `${request} evidence`,
      `${request} official documentation`,
    ]),
  ).slice(0, normalized.mode === 'quick' ? 3 : normalized.mode === 'deep' ? 6 : 4);

  return {
    version: 1,
    title: request,
    createdAt,
    researchQuestions: [
      `What are the most relevant facts about ${request}?`,
      `Which sources provide concrete evidence about ${request}?`,
    ],
    searchQueries: queries,
    sourcePriorityRules: ['Prefer primary, official, and clearly dated sources.'],
    exclusionRules: ['Exclude SEO spam, unclear authorship, and inaccessible pages.'],
  };
}

function normalizeResearchPlan(
  rawPlan: Record<string, unknown> | null,
  normalized: AoiResearchNormalizedRequest,
  createdAt: number,
): AoiResearchPlan {
  const fallback = buildFallbackResearchPlan(normalized, createdAt);
  if (!rawPlan) {
    return fallback;
  }

  const title = truncateText(getString(rawPlan.title) || fallback.title, 160);
  const researchQuestions =
    extractStringList(rawPlan.researchQuestions ?? rawPlan.research_questions, 8) ||
    fallback.researchQuestions;
  const searchQueries = extractStringList(
    rawPlan.searchQueries ?? rawPlan.search_queries,
    MAX_PLAN_QUERIES,
  );
  const sourcePriorityRules = extractStringList(
    rawPlan.sourcePriorityRules ?? rawPlan.source_priority_rules,
    8,
  );
  const exclusionRules = extractStringList(rawPlan.exclusionRules ?? rawPlan.exclusion_rules, 8);

  return {
    version: 1,
    title,
    createdAt,
    researchQuestions: researchQuestions.length ? researchQuestions : fallback.researchQuestions,
    searchQueries: searchQueries.length ? searchQueries : fallback.searchQueries,
    sourcePriorityRules: sourcePriorityRules.length
      ? sourcePriorityRules
      : fallback.sourcePriorityRules,
    exclusionRules: exclusionRules.length ? exclusionRules : fallback.exclusionRules,
  };
}

function buildResearchPlanPrompt(normalized: AoiResearchNormalizedRequest, now: number): string {
  return [
    'You are Aoi research planner.',
    'Return only raw JSON. No markdown.',
    'Schema:',
    '{"title":"short title","researchQuestions":["..."],"searchQueries":["..."],"sourcePriorityRules":["..."],"exclusionRules":["..."]}',
    '',
    `Current time ISO: ${new Date(now).toISOString()}`,
    `Mode: ${normalized.mode}`,
    `Language: ${normalized.language}`,
    `Recency: ${normalized.recency}`,
    `Max sources: ${normalized.maxSources}`,
    '',
    'Create practical web research queries. Prefer specific, source-oriented queries.',
    'Keep searchQueries between 2 and 8 items.',
    '',
    `User request: ${normalized.request}`,
  ].join('\n');
}

async function buildResearchPlan(params: {
  normalized: AoiResearchNormalizedRequest;
  llmConfig: LLMConfig;
  serverOrigin: string;
  dependencies?: AoiResearchEngineDependencies;
  now: number;
}): Promise<AoiResearchPlan> {
  const callModel = params.dependencies?.callModel ?? callAoiMainTextModel;
  try {
    const raw = await callModel(
      params.llmConfig,
      params.serverOrigin,
      buildResearchPlanPrompt(params.normalized, params.now),
      LLM_PLAN_TOKENS,
      true,
    );
    return normalizeResearchPlan(extractAoiResearchJsonObject(raw), params.normalized, params.now);
  } catch {
    return buildFallbackResearchPlan(params.normalized, params.now);
  }
}

function normalizeTitleForDedupe(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\W_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAoiResearchUrlForDedupe(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

export function dedupeAoiResearchSearchCandidates(
  candidates: AoiResearchSearchCandidate[],
): AoiResearchSearchCandidate[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const deduped: AoiResearchSearchCandidate[] = [];

  for (const candidate of candidates) {
    const urlKey = normalizeAoiResearchUrlForDedupe(candidate.url);
    const titleKey = normalizeTitleForDedupe(candidate.title);
    if (!urlKey || seenUrls.has(urlKey)) {
      continue;
    }
    if (titleKey.length >= 18 && seenTitles.has(titleKey)) {
      continue;
    }
    seenUrls.add(urlKey);
    if (titleKey.length >= 18) {
      seenTitles.add(titleKey);
    }
    deduped.push(candidate);
  }

  return deduped;
}

async function fetchWithTimeout(
  fetchImpl: ResearchFetch,
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchTavily(params: {
  query: string;
  config: AoiResearchTavilyConfig;
  recency: AoiResearchRecency;
  maxResults: number;
  fetchImpl: ResearchFetch;
}): Promise<AoiResearchSearchCandidate[]> {
  const payload: Record<string, unknown> = {
    query: params.query,
    topic: 'general',
    search_depth: 'advanced',
    max_results: Math.min(10, Math.max(1, params.maxResults)),
    include_answer: 'basic',
    include_favicon: true,
  };
  if (params.recency !== 'any') {
    payload.time_range = params.recency;
  }

  const response = await fetchWithTimeout(params.fetchImpl, params.config.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data: TavilySearchResponse = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text) as TavilySearchResponse;
    } catch {
      data = { error: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `Tavily API error ${response.status}`);
  }

  return (data.results || [])
    .map((item) => ({
      title: truncateText(getString(item.title), 240),
      url: getString(item.url),
      content: truncateText(getString(item.content), 700),
      score: typeof item.score === 'number' ? item.score : undefined,
      searchQuery: params.query,
    }))
    .filter((item) => item.url);
}

async function runBounded<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0' ||
    host === '0.0.0.0'
  );
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

function ipv4InRange(ip: string, base: string, prefixBits: number): boolean {
  const value = ipv4ToNumber(ip);
  const baseValue = ipv4ToNumber(base);
  if (value === null || baseValue === null) {
    return false;
  }
  const size = 2 ** (32 - prefixBits);
  return value >= baseValue && value < baseValue + size;
}

function isPrivateIPv4(ip: string): boolean {
  return (
    ipv4InRange(ip, '0.0.0.0', 8) ||
    ipv4InRange(ip, '10.0.0.0', 8) ||
    ipv4InRange(ip, '100.64.0.0', 10) ||
    ipv4InRange(ip, '127.0.0.0', 8) ||
    ipv4InRange(ip, '169.254.0.0', 16) ||
    ipv4InRange(ip, '172.16.0.0', 12) ||
    ipv4InRange(ip, '192.0.0.0', 24) ||
    ipv4InRange(ip, '192.168.0.0', 16) ||
    ipv4InRange(ip, '198.18.0.0', 15) ||
    ipv4InRange(ip, '224.0.0.0', 4) ||
    ipv4InRange(ip, '240.0.0.0', 4)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') {
    return true;
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (/^fe[89ab]/.test(normalized)) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length);
    return isPrivateIPv4(embedded);
  }
  return false;
}

export function isPrivateOrLocalIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    return isPrivateIPv4(address);
  }
  if (kind === 6) {
    return isPrivateIPv6(address);
  }
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function validateAoiResearchSourceUrl(
  rawUrl: string,
  resolver: HostResolver = defaultResolveHost,
): Promise<AoiResearchUrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      ok: false,
      errorCode: 'invalid_url',
      errorMessage: 'Source URL is malformed.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      errorCode: 'unsupported_protocol',
      errorMessage: 'Only http and https source URLs are allowed.',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      errorCode: 'url_credentials_rejected',
      errorMessage: 'Source URLs with embedded credentials are not allowed.',
    };
  }

  const host = normalizeHostname(parsed.hostname);
  if (isBlockedHostname(host)) {
    return {
      ok: false,
      errorCode: 'blocked_host',
      errorMessage: 'Local or link-local hostnames are not allowed.',
    };
  }

  let addresses: string[] = [];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      return {
        ok: false,
        errorCode: 'dns_resolution_failed',
        errorMessage: 'Source hostname could not be resolved.',
      };
    }
  }

  if (!addresses.length || addresses.some((address) => isPrivateOrLocalIp(address))) {
    return {
      ok: false,
      errorCode: 'private_network_rejected',
      errorMessage: 'Source URL resolved to a private, local, or reserved network address.',
    };
  }

  parsed.hash = '';
  return {
    ok: true,
    normalizedUrl: parsed.toString(),
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : '';
    });
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMetaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])(?=[^>]*content=["']([^"']*)["'])[^>]*>`,
    'i',
  );
  const match = html.match(pattern);
  return match ? decodeHtmlEntities(match[1]).trim() : '';
}

export function parseAoiResearchReadableHtml(html: string, finalUrl: string): ParsedReadableSource {
  const withoutNoise = html.replace(
    /<(script|style|noscript|iframe|svg|canvas)\b[\s\S]*?<\/\1>/gi,
    ' ',
  );
  const title =
    extractMetaContent(withoutNoise, 'og:title') ||
    stripTags(withoutNoise.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') ||
    finalUrl;
  const siteName =
    extractMetaContent(withoutNoise, 'og:site_name') ||
    new URL(finalUrl).hostname.replace(/^www\./, '');
  const excerpt =
    extractMetaContent(withoutNoise, 'description') ||
    extractMetaContent(withoutNoise, 'og:description');

  const blocks: AoiResearchSourceBlock[] = [];
  const blockPattern = /<(h[1-3]|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(withoutNoise)) !== null) {
    const tag = match[1].toLowerCase();
    const text = truncateText(stripTags(match[2]), 360);
    if (text.length < 30) {
      continue;
    }
    const type =
      tag === 'blockquote'
        ? 'quote'
        : tag === 'li'
          ? 'list'
          : tag.startsWith('h')
            ? 'heading'
            : 'paragraph';
    blocks.push({ type, text });
    if (blocks.length >= 30) {
      break;
    }
  }

  if (!blocks.length) {
    const text = truncateText(stripTags(withoutNoise), 1200);
    if (text.length >= 30) {
      blocks.push({ type: 'paragraph', text });
    }
  }

  return {
    finalUrl,
    title: truncateText(title, 240),
    siteName: truncateText(siteName, 120),
    excerpt: truncateText(
      excerpt || blocks.find((block) => block.type === 'paragraph')?.text || title,
      320,
    ),
    blocks,
  };
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Response exceeds ${maxBytes} bytes.`);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes.`);
    }
    return buffer.toString('utf-8');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(result.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

async function fetchReadableSource(params: {
  candidate: AoiResearchSearchCandidate;
  id: string;
  fetchImpl: ResearchFetch;
  resolver: HostResolver;
  now: number;
}): Promise<AoiResearchSource> {
  let currentUrl = params.candidate.url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validation = await validateAoiResearchSourceUrl(currentUrl, params.resolver);
    if (!validation.ok || !validation.normalizedUrl) {
      throw new AoiResearchFailure(
        validation.errorCode || 'url_rejected',
        validation.errorMessage || 'Source URL was rejected.',
        'reading_sources',
      );
    }

    const response = await fetchWithTimeout(params.fetchImpl, validation.normalizedUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'User-Agent': 'AoiResearchBot/1.0',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new AoiResearchFailure(
          'redirect_without_location',
          'Source redirected without a Location header.',
          'reading_sources',
        );
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new AoiResearchFailure(
          'too_many_redirects',
          'Source exceeded the redirect limit.',
          'reading_sources',
        );
      }
      currentUrl = new URL(location, validation.normalizedUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw new AoiResearchFailure(
        'source_http_error',
        `Source returned HTTP ${response.status}.`,
        'reading_sources',
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw new AoiResearchFailure(
        'unsupported_content_type',
        `Source content type is not readable text: ${contentType}.`,
        'reading_sources',
      );
    }

    const body = await readResponseTextLimited(response, MAX_FETCH_BYTES);
    const readable = parseAoiResearchReadableHtml(body, validation.normalizedUrl);
    return {
      version: 1,
      id: params.id,
      url: params.candidate.url,
      finalUrl: readable.finalUrl,
      title: readable.title || params.candidate.title || params.candidate.url,
      siteName: readable.siteName,
      excerpt: readable.excerpt || params.candidate.content,
      searchQuery: params.candidate.searchQuery,
      searchScore: params.candidate.score,
      blocks: readable.blocks,
      retrievedAt: params.now,
      status: 'accepted',
    };
  }

  throw new AoiResearchFailure(
    'too_many_redirects',
    'Source exceeded the redirect limit.',
    'reading_sources',
  );
}

function createFailedSource(params: {
  candidate: AoiResearchSearchCandidate;
  id: string;
  error: unknown;
  now: number;
}): AoiResearchSource {
  const detail =
    params.error instanceof AoiResearchFailure
      ? createErrorDetail(params.error.code, params.error.message, params.error.phase, params.now)
      : createErrorDetail(
          'source_fetch_failed',
          params.error instanceof Error ? params.error.message : String(params.error),
          'reading_sources',
          params.now,
        );
  return {
    version: 1,
    id: params.id,
    url: params.candidate.url,
    title: truncateText(params.candidate.title || params.candidate.url, 240),
    excerpt: truncateText(params.candidate.content, 320),
    searchQuery: params.candidate.searchQuery,
    searchScore: params.candidate.score,
    blocks: [],
    retrievedAt: params.now,
    status: 'failed',
    error: detail,
  };
}

function buildEvidencePrompt(
  source: AoiResearchSource,
  normalized: AoiResearchNormalizedRequest,
): string {
  const blocks = source.blocks
    .slice(0, 14)
    .map((block, index) => `${index + 1}. [${block.type}] ${block.text}`)
    .join('\n');
  return [
    'You are Aoi evidence extractor.',
    'Extract concrete evidence claims supported by the source text.',
    'Return only raw JSON. No markdown.',
    'Schema:',
    '{"claims":[{"sourceId":"source id","claim":"short factual claim","supportText":"short exact support summary","tags":["tag"],"confidence":0.0,"caveats":["optional caveat"]}]}',
    '',
    `Research request: ${normalized.request}`,
    `Language preference: ${normalized.language}`,
    '',
    `Source id: ${source.id}`,
    `Title: ${source.title}`,
    `URL: ${source.finalUrl || source.url}`,
    `Excerpt: ${source.excerpt || ''}`,
    '',
    'Readable blocks:',
    blocks || '(no readable blocks)',
  ].join('\n');
}

function clampConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, parsed));
}

function normalizeEvidenceClaims(params: {
  raw: string;
  source: AoiResearchSource;
  now: number;
}): AoiResearchEvidenceClaim[] {
  const parsed = extractAoiResearchJsonObject(params.raw);
  const rawClaims = Array.isArray(parsed?.claims) ? parsed.claims : [];
  return rawClaims
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const claim = truncateText(getString(record.claim), 360);
      const supportText = truncateText(getString(record.supportText ?? record.support_text), 520);
      if (!claim || !supportText) {
        return null;
      }
      const tags = extractStringList(record.tags ?? record.topicTags ?? record.topic_tags, 8);
      const caveats = extractStringList(record.caveats, 6);
      return {
        version: 1 as const,
        id: `${params.source.id}-claim-${index + 1}`,
        sourceId: params.source.id,
        claim,
        supportText,
        topicTags: tags,
        confidence: clampConfidence(record.confidence),
        caveats,
        createdAt: params.now,
      };
    })
    .filter((claim): claim is AoiResearchEvidenceClaim => Boolean(claim))
    .slice(0, 8);
}

async function extractEvidenceForSource(params: {
  source: AoiResearchSource;
  normalized: AoiResearchNormalizedRequest;
  llmConfig: LLMConfig;
  serverOrigin: string;
  dependencies?: AoiResearchEngineDependencies;
  now: number;
}): Promise<{ claims: AoiResearchEvidenceClaim[]; error?: AoiResearchErrorDetail }> {
  const callModel = params.dependencies?.callModel ?? callAoiMainTextModel;
  try {
    const raw = await callModel(
      params.llmConfig,
      params.serverOrigin,
      buildEvidencePrompt(params.source, params.normalized),
      LLM_EVIDENCE_TOKENS,
      true,
    );
    const claims = normalizeEvidenceClaims({
      raw,
      source: params.source,
      now: params.now,
    });
    if (!claims.length) {
      return {
        claims: [],
        error: createErrorDetail(
          'evidence_extraction_empty',
          'Evidence extraction returned no usable claims.',
          'extracting_evidence',
          params.now,
        ),
      };
    }
    return { claims };
  } catch (error) {
    return {
      claims: [],
      error: createErrorDetail(
        'evidence_extraction_failed',
        error instanceof Error ? error.message : String(error),
        'extracting_evidence',
        params.now,
      ),
    };
  }
}

async function ensureNotCancelled(params: {
  runId: string;
  phase: AoiResearchProgressPhase;
  dependencies?: AoiResearchEngineDependencies;
}): Promise<void> {
  const requested =
    CANCELLED_RUN_IDS.has(params.runId) ||
    Boolean(await params.dependencies?.shouldCancel?.(params.runId, params.phase));
  if (requested) {
    throw new AoiResearchCancelled('Research run cancelled.');
  }
}

function readManifest(filePath: string): AoiResearchManifest | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<AoiResearchManifest>;
    if (parsed.version !== 1 || typeof parsed.id !== 'string') {
      return null;
    }
    return parsed as AoiResearchManifest;
  } catch {
    return null;
  }
}

export function requestAoiResearchCancellation(runId: string): void {
  CANCELLED_RUN_IDS.add(runId);
}

export function cancelAoiResearchRun(
  paths: AoiResearchRunPaths,
  reason: string,
  now = Date.now(),
): AoiResearchManifest | null {
  const manifest = readManifest(paths.manifest);
  if (!manifest) {
    return null;
  }
  if (manifest.status !== 'queued' && manifest.status !== 'running') {
    return manifest;
  }
  requestAoiResearchCancellation(manifest.id);
  const nextManifest: AoiResearchManifest = {
    ...manifest,
    updatedAt: now,
    completedAt: manifest.completedAt ?? now,
    status: 'cancelled',
    phase: 'cancelled',
    statusMessage: truncateText(reason || 'Cancelled by user.', 240),
    artifactAvailability: {
      ...getArtifactAvailability(paths),
      manifest: true,
    },
  };
  writeJsonFile(paths.manifest, nextManifest);
  return nextManifest;
}

export async function startAoiResearchRun(
  params: StartAoiResearchRunParams,
): Promise<AoiResearchManifest> {
  const dependencies = params.dependencies;
  const normalized = normalizeAoiResearchRequest(params.request);
  const fetchImpl = dependencies?.fetch ?? fetch;
  const resolver = dependencies?.resolveHost ?? defaultResolveHost;
  let sources: AoiResearchSource[] = [];
  let claims: AoiResearchEvidenceClaim[] = [];
  let candidates: AoiResearchSearchCandidate[] = [];
  const warnings: AoiResearchErrorDetail[] = [];
  let manifest = createInitialManifest({
    normalized,
    runId: params.runId,
    now: getNow(dependencies),
    paths: params.paths,
  });

  persistSources(params.paths, params.runId, sources, manifest.createdAt);
  persistEvidence(params.paths, params.runId, claims, manifest.createdAt);
  persistPlaceholderReport({
    paths: params.paths,
    manifest,
    sources,
    claims,
  });
  manifest = await persistManifest(params.paths, manifest, dependencies);

  const updateManifest = async (patch: Partial<AoiResearchManifest>): Promise<void> => {
    manifest = {
      ...manifest,
      ...patch,
      updatedAt: getNow(dependencies),
      sourceCounts:
        patch.sourceCounts ?? countSources(normalized.maxSources, candidates.length, sources),
      warnings: patch.warnings ?? [
        ...warnings,
        ...sources
          .filter((source) => source.error)
          .map((source) => source.error as AoiResearchErrorDetail),
      ],
    };
    manifest = await persistManifest(params.paths, manifest, dependencies);
  };

  try {
    await ensureNotCancelled({
      runId: params.runId,
      phase: 'queued',
      dependencies,
    });

    await updateManifest({
      status: 'running',
      phase: 'planning',
      statusMessage: 'Planning research queries.',
    });

    const llmConfig = (dependencies?.loadLlmConfig ?? loadAoiMainLlmConfig)(params.configFile);
    if (!llmConfig) {
      throw new AoiResearchFailure(
        'aoi_main_llm_not_configured',
        'AOI main LLM is not configured.',
        'planning',
      );
    }

    const tavilyConfig = (dependencies?.loadTavilyConfig ?? loadAoiResearchTavilyConfig)(
      params.configFile,
    );
    if (!tavilyConfig) {
      throw new AoiResearchFailure(
        'tavily_not_configured',
        'Tavily is not configured. Add tavily.apiKey to the server config file.',
        'searching',
      );
    }

    const plan = await buildResearchPlan({
      normalized,
      llmConfig,
      serverOrigin: params.serverOrigin,
      dependencies,
      now: getNow(dependencies),
    });
    await updateManifest({
      plan,
      sourceCounts: { ...manifest.sourceCounts, planned: normalized.maxSources },
    });

    await ensureNotCancelled({
      runId: params.runId,
      phase: 'searching',
      dependencies,
    });
    await updateManifest({
      phase: 'searching',
      statusMessage: 'Searching the web with Tavily.',
    });

    const perQueryResults = Math.max(
      3,
      Math.ceil((normalized.maxSources * 2) / plan.searchQueries.length),
    );
    const searchGroups = await runBounded(plan.searchQueries, SEARCH_CONCURRENCY, async (query) => {
      try {
        return await searchTavily({
          query,
          config: tavilyConfig,
          recency: normalized.recency,
          maxResults: perQueryResults,
          fetchImpl,
        });
      } catch (error) {
        warnings.push(
          createErrorDetail(
            'tavily_search_failed',
            error instanceof Error ? error.message : String(error),
            'searching',
            getNow(dependencies),
            query,
          ),
        );
        return [];
      }
    });
    candidates = dedupeAoiResearchSearchCandidates(searchGroups.flat()).slice(
      0,
      Math.min(40, normalized.maxSources * 2),
    );
    if (!candidates.length) {
      throw new AoiResearchFailure(
        'no_search_candidates',
        'Tavily did not return any usable search candidates.',
        'searching',
      );
    }
    await updateManifest({
      sourceCounts: countSources(normalized.maxSources, candidates.length, sources),
    });

    await ensureNotCancelled({
      runId: params.runId,
      phase: 'reading_sources',
      dependencies,
    });
    await updateManifest({
      phase: 'reading_sources',
      statusMessage: 'Reading candidate sources with network safety checks.',
    });

    const attemptedCandidates = candidates.slice(
      0,
      Math.min(candidates.length, normalized.maxSources * 2),
    );
    const readResults = await runBounded(
      attemptedCandidates,
      READER_CONCURRENCY,
      async (candidate, index) => {
        const id = `src-${String(index + 1).padStart(3, '0')}`;
        try {
          return await fetchReadableSource({
            candidate,
            id,
            fetchImpl,
            resolver,
            now: getNow(dependencies),
          });
        } catch (error) {
          return createFailedSource({
            candidate,
            id,
            error,
            now: getNow(dependencies),
          });
        }
      },
    );

    let acceptedCount = 0;
    sources = [];
    for (const source of readResults) {
      if (source.status === 'accepted') {
        if (acceptedCount >= normalized.maxSources) {
          continue;
        }
        acceptedCount += 1;
      }
      sources.push(source);
    }
    persistSources(params.paths, params.runId, sources, getNow(dependencies));
    await updateManifest({
      sourceCounts: countSources(normalized.maxSources, candidates.length, sources),
    });

    if (!sources.some((source) => source.status === 'accepted')) {
      throw new AoiResearchFailure(
        'no_sources_collected',
        'No readable external sources were collected.',
        'reading_sources',
      );
    }

    await ensureNotCancelled({
      runId: params.runId,
      phase: 'extracting_evidence',
      dependencies,
    });
    await updateManifest({
      phase: 'extracting_evidence',
      statusMessage: 'Extracting evidence claims from accepted sources.',
    });

    const acceptedSources = sources.filter((source) => source.status === 'accepted');
    const evidenceGroups = await runBounded(acceptedSources, EVIDENCE_CONCURRENCY, async (source) =>
      extractEvidenceForSource({
        source,
        normalized,
        llmConfig,
        serverOrigin: params.serverOrigin,
        dependencies,
        now: getNow(dependencies),
      }),
    );

    const sourceById = new Map(sources.map((source) => [source.id, source]));
    claims = [];
    for (let index = 0; index < acceptedSources.length; index += 1) {
      const result = evidenceGroups[index];
      claims.push(...result.claims);
      if (result.error) {
        const source = sourceById.get(acceptedSources[index].id);
        if (source) {
          source.error = result.error;
        }
      }
    }
    persistSources(params.paths, params.runId, sources, getNow(dependencies));
    persistEvidence(params.paths, params.runId, claims, getNow(dependencies));

    await ensureNotCancelled({
      runId: params.runId,
      phase: 'drafting_report',
      dependencies,
    });
    await updateManifest({
      phase: 'drafting_report',
      statusMessage: 'Writing collection placeholder report.',
    });

    persistPlaceholderReport({
      paths: params.paths,
      manifest,
      sources,
      claims,
    });

    await updateManifest({
      status: 'completed',
      phase: 'completed',
      statusMessage: 'Research sources and evidence collected.',
      completedAt: getNow(dependencies),
      sourceCounts: countSources(normalized.maxSources, candidates.length, sources),
    });
  } catch (error) {
    const now = getNow(dependencies);
    if (error instanceof AoiResearchCancelled) {
      manifest = {
        ...manifest,
        updatedAt: now,
        completedAt: manifest.completedAt ?? now,
        status: 'cancelled',
        phase: 'cancelled',
        statusMessage: error.message,
        sourceCounts: countSources(normalized.maxSources, candidates.length, sources),
      };
      persistPlaceholderReport({
        paths: params.paths,
        manifest,
        sources,
        claims,
        reason: error.message,
      });
      manifest = await persistManifest(params.paths, manifest, dependencies);
      return manifest;
    }

    const failure =
      error instanceof AoiResearchFailure
        ? error
        : new AoiResearchFailure(
            'research_run_failed',
            error instanceof Error ? error.message : String(error),
            manifest.phase === 'queued' ? 'failed' : manifest.phase,
          );
    const detail = createErrorDetail(failure.code, failure.message, failure.phase, now);
    manifest = {
      ...manifest,
      updatedAt: now,
      completedAt: manifest.completedAt ?? now,
      status: 'failed',
      phase: 'failed',
      statusMessage: failure.message,
      sourceCounts: countSources(normalized.maxSources, candidates.length, sources),
      error: detail,
      warnings: [
        ...warnings,
        ...sources
          .filter((source) => source.error)
          .map((source) => source.error as AoiResearchErrorDetail),
      ],
    };
    persistSources(params.paths, params.runId, sources, now);
    persistEvidence(params.paths, params.runId, claims, now);
    persistPlaceholderReport({
      paths: params.paths,
      manifest,
      sources,
      claims,
      reason: failure.message,
    });
    manifest = await persistManifest(params.paths, manifest, dependencies);
  } finally {
    if (manifest.status !== 'running' && manifest.status !== 'queued') {
      CANCELLED_RUN_IDS.delete(params.runId);
    }
  }

  return manifest;
}
