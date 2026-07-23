import { createHash } from 'crypto';
import { isIP } from 'net';
import type { AoiResearchTavilyConfig } from './aoiResearchEngine';
import type {
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
  AoiProactiveBriefDeliveryMode,
  AoiProactiveBriefSource,
} from './aoiAutonomyTypes';
import { createAoiAutonomyId } from './aoiAutonomyStore';
import {
  classifyAoiProactiveBriefMediaKind,
  deriveAoiProactiveBriefMediaBucket,
} from './aoiProactiveMediaKind';

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MIN_SOURCES = 2;
const DEFAULT_SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CANDIDATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_TAVILY_TIMEOUT_MS = 12_000;

export interface AoiProactiveBriefSearchRequest {
  query: string;
  topicId: string;
  maxResults: number;
  now: number;
  recency?: 'day' | 'week' | 'month' | 'year' | 'any';
}

export interface AoiProactiveBriefRawSearchResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  score?: number;
  publishedAt?: string;
  published_date?: string;
}

export interface AoiProactiveBriefSearchResponse {
  query: string;
  retrievedAt: number;
  results: AoiProactiveBriefRawSearchResult[];
  warning?: string;
}

export type AoiProactiveBriefSearchAdapter = (
  request: AoiProactiveBriefSearchRequest,
) => Promise<AoiProactiveBriefSearchResponse>;

export interface AoiProactiveBriefSourceFreshness {
  topicId: string;
  query: string;
  searchedAt: number;
  sourceCount: number;
  newestSourceAt?: string;
  cannotKnow: string[];
}

export interface AoiProactiveBriefEvidence {
  topic: AoiInterestTopic;
  query: string;
  searchedAt: number;
  sources: AoiProactiveBriefSource[];
  newestSourceAt?: string;
  cannotKnow: string[];
  warnings: string[];
  freshness: AoiProactiveBriefSourceFreshness;
}

export interface AoiProactiveBriefCandidateBuildInput {
  topic: AoiInterestTopic;
  evidence: AoiProactiveBriefEvidence;
  now: number;
  delivery?: {
    allowedModes?: AoiProactiveBriefDeliveryMode[];
    selectedMode?: AoiProactiveBriefDeliveryMode;
    quietModeSuppressed?: boolean;
  };
  candidateTtlMs?: number;
}

export interface AoiProactiveBriefTopicScoutInput {
  topic: AoiInterestTopic;
  search: AoiProactiveBriefSearchAdapter;
  now: number;
  maxResults?: number;
  minSources?: number;
  sourceStaleAfterMs?: number;
  delivery?: AoiProactiveBriefCandidateBuildInput['delivery'];
}

export interface AoiProactiveBriefTopicScoutResult {
  topicId: string;
  query: string;
  evidence: AoiProactiveBriefEvidence;
  candidate?: AoiProactiveBriefCandidate;
  rejectedReason?: 'low_evidence';
  warnings: string[];
}

interface TavilyApiResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
    publishedAt?: string;
  }>;
  error?: string;
}

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
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
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    (normalized.startsWith('::ffff:') && isPrivateIPv4(normalized.slice('::ffff:'.length)))
  );
}

function isPublicSearchHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return false;
  }
  const ipKind = isIP(host);
  if (ipKind === 4) {
    return !isPrivateIPv4(host);
  }
  if (ipKind === 6) {
    return !isPrivateIPv6(host);
  }
  return true;
}

function normalizeSourceUrl(value: unknown): { url: string; host: string } | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password || !isPublicSearchHost(parsed.hostname)) {
    return null;
  }
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  const host = normalizeHost(parsed.hostname);
  return {
    url: parsed.toString(),
    host,
  };
}

function normalizedTitleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3)
      .slice(0, 18),
  );
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = normalizedTitleTokens(left);
  const rightTokens = normalizedTitleTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function getPublishedAt(result: AoiProactiveBriefRawSearchResult): string | undefined {
  const raw = clampText(result.publishedAt ?? result.published_date, 64);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function newestPublishedAt(sources: AoiProactiveBriefSource[]): string | undefined {
  let newest = 0;
  for (const source of sources) {
    if (!source.publishedAt) {
      continue;
    }
    const parsed = Date.parse(source.publishedAt);
    if (Number.isFinite(parsed) && parsed > newest) {
      newest = parsed;
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : undefined;
}

function buildCannotKnowStatements(params: {
  sources: AoiProactiveBriefSource[];
  now: number;
  staleAfterMs: number;
}): string[] {
  const cannotKnow: string[] = [];
  const missingPublishedAtCount = params.sources.filter((source) => !source.publishedAt).length;
  if (missingPublishedAtCount > 0) {
    cannotKnow.push(
      'Aoi cannot know whether every surfaced source is the newest item because some search results did not include publication dates.',
    );
  }
  if (params.sources.length < 3) {
    cannotKnow.push(
      `Aoi found only ${params.sources.length} independent public sources, so coverage may be incomplete.`,
    );
  }
  const newest = newestPublishedAt(params.sources);
  if (newest) {
    const newestMs = Date.parse(newest);
    if (Number.isFinite(newestMs) && params.now - newestMs > params.staleAfterMs) {
      cannotKnow.push(
        'Aoi cannot treat this as fresh current information because the newest dated source is outside the freshness window.',
      );
    }
  }
  return cannotKnow;
}

function buildEvidenceRef(source: AoiProactiveBriefSource): string {
  return `source:${source.host}:${hashText(source.url)}`;
}

export function buildAoiProactiveBriefSearchQuery(topic: AoiInterestTopic): string {
  const terms = [topic.label, ...topic.aliases]
    .map((item) => clampText(item, 80))
    .filter(Boolean)
    .filter(
      (item, index, array) =>
        array.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index,
    )
    .slice(0, 3);
  const base = terms.length > 0 ? terms.join(' OR ') : topic.normalizedLabel || topic.id;
  return clampText(`${base} security research recent developments`, 220);
}

export function normalizeAoiProactiveBriefSearchResults(params: {
  results: AoiProactiveBriefRawSearchResult[];
  retrievedAt: number;
  maxSources?: number;
}): AoiProactiveBriefSource[] {
  const maxSources =
    typeof params.maxSources === 'number' && Number.isFinite(params.maxSources)
      ? Math.min(10, Math.max(1, Math.trunc(params.maxSources)))
      : DEFAULT_MAX_RESULTS;
  const sources: AoiProactiveBriefSource[] = [];
  const seenUrls = new Set<string>();

  for (const result of params.results) {
    const normalizedUrl = normalizeSourceUrl(result.url);
    if (!normalizedUrl || seenUrls.has(normalizedUrl.url)) {
      continue;
    }
    const title = clampText(result.title, 180) || normalizedUrl.host;
    const duplicateByHostAndTitle = sources.some(
      (source) =>
        source.host === normalizedUrl.host && titleSimilarity(source.title, title) >= 0.82,
    );
    if (duplicateByHostAndTitle) {
      continue;
    }
    const snippet =
      clampText(result.content, 420) || clampText(result.snippet, 420) || 'Public search result.';
    sources.push({
      title,
      url: normalizedUrl.url,
      host: normalizedUrl.host,
      ...(getPublishedAt(result) ? { publishedAt: getPublishedAt(result) } : {}),
      retrievedAt: params.retrievedAt,
      snippet,
      mediaKind: classifyAoiProactiveBriefMediaKind({
        url: normalizedUrl.url,
        host: normalizedUrl.host,
        title,
        snippet,
      }),
    });
    seenUrls.add(normalizedUrl.url);
    if (sources.length >= maxSources) {
      break;
    }
  }

  return sources;
}

export function buildAoiProactiveBriefCandidateFromEvidence(
  input: AoiProactiveBriefCandidateBuildInput,
): AoiProactiveBriefCandidate {
  const sources = input.evidence.sources;
  const primary = sources[0];
  const otherHosts = sources
    .slice(1, 3)
    .map((source) => source.host)
    .join(', ');
  const sourceSummary = sources
    .slice(0, 3)
    .map((source) => `${source.title} (${source.host})`)
    .join('; ');
  const currentInfoBlockedByFreshness = input.evidence.cannotKnow.some((item) =>
    /fresh current information|freshness window|publication dates|newest item/i.test(item),
  );
  const currentInfoLabel = currentInfoBlockedByFreshness
    ? 'source-backed scout candidate'
    : 'source-backed current-info candidate';
  const allowedModes: AoiProactiveBriefDeliveryMode[] = input.delivery?.allowedModes?.length
    ? input.delivery.allowedModes
    : ['dashboard'];

  return {
    version: 1,
    id: createAoiAutonomyId('aoi-brief', input.now),
    sessionPath: input.topic.sessionPath,
    topicId: input.topic.id,
    topicLabel: input.topic.label,
    status: 'candidate',
    title: `Source-backed scout for ${input.topic.label}`,
    hook: `I found ${sources.length} public sources that may be worth a quick look for ${input.topic.label}.`,
    summary: `A quick public search surfaced ${sourceSummary}. This is a ${currentInfoLabel}, not a memory-only claim.`,
    whyForOperator: `This matches a saved interest topic with confidence ${input.topic.confidence.toFixed(2)} and current-info preference ${input.topic.currentInfoPreference.toFixed(2)}.`,
    noveltyReason: otherHosts
      ? `${primary?.host ?? 'A public source'} is corroborated by ${otherHosts}.`
      : `${primary?.host ?? 'A public source'} is the primary source surfaced by the scout.`,
    sources,
    mediaBucket: deriveAoiProactiveBriefMediaBucket(sources),
    evidenceRefs: [...sources.map(buildEvidenceRef), ...input.topic.evidenceRefs.slice(0, 6)].slice(
      0,
      16,
    ),
    memoryIds: input.topic.memoryIds.slice(0, 16),
    score: Math.min(
      0.95,
      Math.max(
        0.5,
        input.topic.importance * 0.35 +
          input.topic.confidence * 0.25 +
          input.topic.currentInfoPreference * 0.25 +
          sources.length * 0.05,
      ),
    ),
    confidence: Math.min(
      0.9,
      Math.max(0.55, input.topic.confidence * 0.75 + Math.min(sources.length, 4) * 0.04),
    ),
    risk: 'low',
    freshness: {
      searchedAt: input.evidence.searchedAt,
      ...(input.evidence.newestSourceAt ? { newestSourceAt: input.evidence.newestSourceAt } : {}),
      cannotKnow: input.evidence.cannotKnow,
    },
    delivery: {
      allowedModes,
      ...(input.delivery?.selectedMode && allowedModes.includes(input.delivery.selectedMode)
        ? { selectedMode: input.delivery.selectedMode }
        : {}),
      ...(input.delivery?.quietModeSuppressed === true ? { quietModeSuppressed: true } : {}),
    },
    cooldownKey: input.topic.cooldownKey,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.now + (input.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS),
  };
}

export async function scoutAoiProactiveBriefTopic(
  input: AoiProactiveBriefTopicScoutInput,
): Promise<AoiProactiveBriefTopicScoutResult> {
  const maxResults =
    typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
      ? Math.min(10, Math.max(1, Math.trunc(input.maxResults)))
      : DEFAULT_MAX_RESULTS;
  const minSources =
    typeof input.minSources === 'number' && Number.isFinite(input.minSources)
      ? Math.min(5, Math.max(1, Math.trunc(input.minSources)))
      : DEFAULT_MIN_SOURCES;
  const query = buildAoiProactiveBriefSearchQuery(input.topic);
  const response = await input.search({
    query,
    topicId: input.topic.id,
    maxResults,
    now: input.now,
    recency: 'month',
  });
  const searchedAt = response.retrievedAt || input.now;
  const sources = normalizeAoiProactiveBriefSearchResults({
    results: response.results,
    retrievedAt: searchedAt,
    maxSources: maxResults,
  });
  const newestSourceAt = newestPublishedAt(sources);
  const cannotKnow = buildCannotKnowStatements({
    sources,
    now: input.now,
    staleAfterMs: input.sourceStaleAfterMs ?? DEFAULT_SOURCE_STALE_AFTER_MS,
  });
  const warnings = response.warning ? [response.warning] : [];
  const evidence: AoiProactiveBriefEvidence = {
    topic: input.topic,
    query: response.query || query,
    searchedAt,
    sources,
    ...(newestSourceAt ? { newestSourceAt } : {}),
    cannotKnow,
    warnings,
    freshness: {
      topicId: input.topic.id,
      query: response.query || query,
      searchedAt,
      sourceCount: sources.length,
      ...(newestSourceAt ? { newestSourceAt } : {}),
      cannotKnow,
    },
  };

  if (sources.length < minSources) {
    return {
      topicId: input.topic.id,
      query: response.query || query,
      evidence,
      rejectedReason: 'low_evidence',
      warnings: [...warnings, `low_evidence:${sources.length}/${minSources}`],
    };
  }

  return {
    topicId: input.topic.id,
    query: response.query || query,
    evidence,
    candidate: buildAoiProactiveBriefCandidateFromEvidence({
      topic: input.topic,
      evidence,
      now: input.now,
      delivery: input.delivery,
    }),
    warnings,
  };
}

export function createAoiProactiveBriefTavilySearchAdapter(params: {
  config: AoiResearchTavilyConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): AoiProactiveBriefSearchAdapter {
  return async (request) => {
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('Fetch is unavailable for Tavily proactive brief scouting.');
    }
    const payload: Record<string, unknown> = {
      query: request.query,
      topic: 'general',
      search_depth: 'advanced',
      max_results: Math.min(10, Math.max(1, request.maxResults)),
      include_answer: 'basic',
      include_favicon: true,
    };
    if (request.recency && request.recency !== 'any') {
      payload.time_range = request.recency;
    }

    const timeoutMs =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? Math.min(60_000, Math.max(1_000, Math.trunc(params.timeoutMs)))
        : DEFAULT_TAVILY_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(params.config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${params.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Tavily proactive brief scout timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed: TavilyApiResponse = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text) as TavilyApiResponse;
      } catch {
        parsed = { error: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      throw new Error(parsed.error || `Tavily API error ${response.status}`);
    }
    return {
      query: request.query,
      retrievedAt: request.now,
      results: (parsed.results ?? []).map((item) => ({
        title: item.title,
        url: item.url,
        content: item.content,
        score: item.score,
        publishedAt: item.publishedAt,
        published_date: item.published_date,
      })),
    };
  };
}
