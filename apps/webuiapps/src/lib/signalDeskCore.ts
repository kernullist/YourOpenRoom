import {
  SIGNAL_CATEGORIES,
  describeInterestMeta,
  type InterestMeta,
  type SignalBriefDoc,
  type SignalBriefSection,
  type SignalCategory,
  type SignalItem,
  type SignalSourceKind,
  type SignalSourceOutcome,
} from './signalDeskShared';

/**
 * Pure collection core for Signal Desk: feed parsing, normalization, dedup,
 * scoring, and brief composition.
 *
 * No node built-ins and no I/O here. The plugin owns fetch and the interest
 * profile read; tests feed fixture strings straight into these functions.
 */

export interface SignalSourceDef {
  id: string;
  name: string;
  url: string;
  kind: SignalSourceKind;
  category: SignalCategory;
  /** Base score contribution; also the dedup tiebreaker. */
  weight: number;
}

export interface RawFeedEntry {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
  kev?: boolean;
}

export interface SourceFetchResult {
  source: SignalSourceDef;
  ok: boolean;
  entries: RawFeedEntry[];
  error?: string;
  ms: number;
}

export interface InterestKeyword {
  term: string;
  /** 0..1, from topic importance * confidence. */
  weight: number;
}

// ---------------------------------------------------------------------------
// Text helpers (same approach as cyberNewsProxyPlugin: regex over feed XML,
// no DOM parser, so the module stays runtime-agnostic).
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtml(input = ''): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => HTML_ENTITIES[entity] || entity)
    .trim();
}

/**
 * Decode first, then strip: feeds wrap markup in CDATA or entity-encode it
 * (&lt;b&gt;...), so removing tags before decoding leaves either the literal
 * tags or an orphaned "]]>" in the text.
 */
function stripHtml(input = ''): string {
  return decodeHtml(input)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() || '';
}

function safeIsoDate(value: string, fallbackMs: number): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return new Date(fallbackMs).toISOString();
  }
  return new Date(parsed).toISOString();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface ParseOptions {
  max: number;
  /** Used when an entry has no parseable date. */
  fallbackNowMs: number;
}

export function parseRssItems(xml: string, options: ParseOptions): RawFeedEntry[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return blocks
    .slice(0, options.max)
    .map((block) => ({
      title: stripHtml(readTag(block, 'title')),
      url: decodeHtml(readTag(block, 'link')),
      summary: stripHtml(readTag(block, 'description')).slice(0, 400),
      publishedAt: safeIsoDate(readTag(block, 'pubDate'), options.fallbackNowMs),
    }))
    .filter((entry) => entry.title.length > 0 && entry.url.length > 0);
}

function readAtomLink(block: string): string {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = '';
  for (const tag of links) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || '';
    if (!href) {
      continue;
    }
    const rel = tag.match(/rel=["']([^"']+)["']/i)?.[1] || '';
    if (rel === 'alternate' || rel === '') {
      return decodeHtml(href);
    }
    if (!fallback) {
      fallback = decodeHtml(href);
    }
  }
  return fallback;
}

export function parseAtomEntries(xml: string, options: ParseOptions): RawFeedEntry[] {
  const blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks
    .slice(0, options.max)
    .map((block) => ({
      title: stripHtml(readTag(block, 'title')),
      url: readAtomLink(block),
      summary: stripHtml(readTag(block, 'summary') || readTag(block, 'content')).slice(0, 400),
      publishedAt: safeIsoDate(
        readTag(block, 'published') || readTag(block, 'updated'),
        options.fallbackNowMs,
      ),
    }))
    .filter((entry) => entry.title.length > 0 && entry.url.length > 0);
}

/**
 * Feeds lie about their format: Jekyll blogs serve Atom from a "feed.xml" that
 * looks like RSS (found live — secret.club and connormcgarr parsed to an
 * honest but wrong 0 items). Try RSS first, fall back to Atom; a genuinely
 * empty feed yields 0 either way.
 */
export function parseFeedEntries(xml: string, options: ParseOptions): RawFeedEntry[] {
  const rssEntries = parseRssItems(xml, options);
  if (rssEntries.length > 0) {
    return rssEntries;
  }
  return parseAtomEntries(xml, options);
}

interface KevVulnerability {
  cveID?: string;
  vulnerabilityName?: string;
  shortDescription?: string;
  requiredAction?: string;
  dateAdded?: string;
}

/** Throws on malformed JSON; the plugin converts that into a failed outcome. */
export function parseKevEntries(jsonText: string, options: ParseOptions): RawFeedEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('KEV JSON parse failed');
  }
  const list = (parsed as { vulnerabilities?: KevVulnerability[] })?.vulnerabilities;
  if (!Array.isArray(list)) {
    throw new Error('KEV JSON has no vulnerabilities array');
  }
  return list
    .filter((vuln) => typeof vuln?.cveID === 'string' && vuln.cveID.length > 0)
    .sort((a, b) => Date.parse(b.dateAdded || '') - Date.parse(a.dateAdded || ''))
    .slice(0, options.max)
    .map((vuln) => {
      const cve = String(vuln.cveID);
      const action = vuln.requiredAction ? ` | 조치: ${vuln.requiredAction}` : '';
      return {
        title: `${cve}: ${vuln.vulnerabilityName || 'Known exploited vulnerability'}`,
        url: `https://nvd.nist.gov/vuln/detail/${cve}`,
        summary: `${vuln.shortDescription || ''}${action}`.trim().slice(0, 400),
        publishedAt: safeIsoDate(vuln.dateAdded || '', options.fallbackNowMs),
        kev: true,
      };
    });
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const TRACKING_PARAM_PATTERN = /^(utm_|ref$|ref_|fbclid$|gclid$)/i;

export function normalizeSignalUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    const keys = Array.from(parsed.searchParams.keys());
    for (const key of keys) {
      if (TRACKING_PARAM_PATTERN.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

const CVE_PATTERN = /CVE-\d{4}-\d{4,7}/gi;

export function extractCveIds(text: string): string[] {
  const matches = text.match(CVE_PATTERN) || [];
  return Array.from(new Set(matches.map((cve) => cve.toUpperCase()))).sort();
}

/** djb2 — stable ids without node crypto (this module is bundled client-side via types only, but stays runtime-agnostic). */
export function hashSignalId(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return `sig-${hash.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface SignalScoreInput {
  title: string;
  summary: string;
  publishedAt: string;
  kev: boolean;
  duplicateCount: number;
  sourceWeight: number;
}

export interface SignalScoreOptions {
  now: number;
  interestKeywords: InterestKeyword[];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Short terms ("RE", "TPM") only count as standalone tokens; longer terms use
 * substring match. Prevents "re" matching inside "research".
 */
function matchesTerm(haystackLower: string, termLower: string): boolean {
  if (termLower.length <= 3) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(termLower)}([^a-z0-9]|$)`, 'i');
    return pattern.test(haystackLower);
  }
  return haystackLower.includes(termLower);
}

export function computeSignalScore(
  input: SignalScoreInput,
  options: SignalScoreOptions,
): { score: number; reasons: string[] } {
  let score = input.sourceWeight;
  const reasons: string[] = [];

  const published = Date.parse(input.publishedAt);
  if (Number.isFinite(published)) {
    const ageHours = Math.max(0, (options.now - published) / 3_600_000);
    if (ageHours <= 48) {
      score += Math.round(((48 - ageHours) / 48) * 30);
      reasons.push(`${Math.max(1, Math.round(ageHours))}시간 내 신규`);
    }
  }

  if (input.kev) {
    score += 25;
    reasons.push('KEV 등재(실제 악용)');
  }

  const haystack = `${input.title} ${input.summary}`.toLowerCase();
  let matched = 0;
  for (const keyword of options.interestKeywords) {
    if (matched >= 3) {
      break;
    }
    const term = keyword.term.trim();
    if (term.length < 2) {
      continue;
    }
    if (!matchesTerm(haystack, term.toLowerCase())) {
      continue;
    }
    score += Math.round(6 + 6 * clamp01(keyword.weight));
    reasons.push(`관심사 일치: ${keyword.term}`);
    matched += 1;
  }

  if (input.duplicateCount > 0) {
    score += Math.min(10, input.duplicateCount * 5);
    reasons.push(`${input.duplicateCount + 1}개 소스 중복 보도`);
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Build: normalize -> dedup -> score -> sort
// ---------------------------------------------------------------------------

export interface BuildSignalsOptions {
  now: number;
  interestKeywords: InterestKeyword[];
  maxItems?: number;
}

interface WorkingSignal {
  item: SignalItem;
  sourceWeight: number;
  normalizedUrl: string;
}

function mergeDuplicate(keeper: WorkingSignal, other: WorkingSignal): void {
  keeper.item.duplicateCount += other.item.duplicateCount + 1;
  if (
    other.item.sourceName !== keeper.item.sourceName &&
    !keeper.item.otherSources.includes(other.item.sourceName)
  ) {
    keeper.item.otherSources.push(other.item.sourceName);
  }
  for (const name of other.item.otherSources) {
    if (name !== keeper.item.sourceName && !keeper.item.otherSources.includes(name)) {
      keeper.item.otherSources.push(name);
    }
  }
  keeper.item.kev = keeper.item.kev || other.item.kev;
  keeper.item.cveIds = Array.from(new Set([...keeper.item.cveIds, ...other.item.cveIds])).sort();
  if (!keeper.item.summary && other.item.summary) {
    keeper.item.summary = other.item.summary;
  }
}

/** Higher source weight wins; then the newer publication. */
function pickKeeper(a: WorkingSignal, b: WorkingSignal): [WorkingSignal, WorkingSignal] {
  if (b.sourceWeight > a.sourceWeight) {
    return [b, a];
  }
  if (
    b.sourceWeight === a.sourceWeight &&
    Date.parse(b.item.publishedAt) > Date.parse(a.item.publishedAt)
  ) {
    return [b, a];
  }
  return [a, b];
}

function dedupeBy(
  signals: WorkingSignal[],
  keyOf: (signal: WorkingSignal) => string | null,
): WorkingSignal[] {
  const byKey = new Map<string, WorkingSignal>();
  const keyless: WorkingSignal[] = [];
  for (const signal of signals) {
    const key = keyOf(signal);
    if (key === null) {
      keyless.push(signal);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, signal);
      continue;
    }
    const [keeper, merged] = pickKeeper(existing, signal);
    mergeDuplicate(keeper, merged);
    byKey.set(key, keeper);
  }
  return [...byKey.values(), ...keyless];
}

export function buildSignals(
  results: SourceFetchResult[],
  options: BuildSignalsOptions,
): { items: SignalItem[]; outcomes: SignalSourceOutcome[] } {
  const outcomes: SignalSourceOutcome[] = results.map((result) => ({
    sourceId: result.source.id,
    name: result.source.name,
    kind: result.source.kind,
    category: result.source.category,
    ok: result.ok,
    itemCount: result.ok ? result.entries.length : 0,
    ...(result.error ? { error: result.error } : {}),
    ms: result.ms,
  }));

  const working: WorkingSignal[] = [];
  for (const result of results) {
    if (!result.ok) {
      continue;
    }
    for (const entry of result.entries) {
      if (!entry.title || !entry.url) {
        continue;
      }
      const normalizedUrl = normalizeSignalUrl(entry.url);
      working.push({
        normalizedUrl,
        sourceWeight: result.source.weight,
        item: {
          id: hashSignalId(`${result.source.id}|${normalizedUrl}`),
          title: entry.title,
          url: entry.url,
          summary: entry.summary,
          sourceId: result.source.id,
          sourceName: result.source.name,
          category: result.source.category,
          publishedAt: entry.publishedAt,
          score: 0,
          scoreReasons: [],
          cveIds: extractCveIds(`${entry.title} ${entry.summary}`),
          kev: entry.kev === true,
          duplicateCount: 0,
          otherSources: [],
        },
      });
    }
  }

  const byUrl = dedupeBy(working, (signal) => signal.normalizedUrl || null);
  const byCve = dedupeBy(byUrl, (signal) =>
    signal.item.cveIds.length > 0 ? signal.item.cveIds[0] : null,
  );

  const items = byCve.map((signal) => {
    const { score, reasons } = computeSignalScore(
      {
        title: signal.item.title,
        summary: signal.item.summary,
        publishedAt: signal.item.publishedAt,
        kev: signal.item.kev,
        duplicateCount: signal.item.duplicateCount,
        sourceWeight: signal.sourceWeight,
      },
      { now: options.now, interestKeywords: options.interestKeywords },
    );
    return { ...signal.item, score, scoreReasons: reasons };
  });

  items.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const byDate = Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    if (byDate !== 0 && Number.isFinite(byDate)) {
      return byDate;
    }
    return a.id.localeCompare(b.id);
  });

  return { items: items.slice(0, options.maxItems ?? 80), outcomes };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export const BRIEF_SECTION_TITLES: Record<SignalCategory, string> = {
  vuln: '취약점 / KEV',
  msrc: 'MSRC 업데이트',
  research: '커널·안티치트 리서치',
  paper: '논문 (arXiv cs.CR)',
  release: '도구 릴리스',
  ai: 'AI 모델·랩 소식',
  harness: '하네스/에이전트 도구',
};

const BRIEF_SECTION_LIMITS: Record<SignalCategory, number> = {
  vuln: 4,
  msrc: 3,
  research: 3,
  paper: 3,
  release: 3,
  ai: 3,
  harness: 3,
};

export interface BuildBriefOptions {
  now: number;
  interest: InterestMeta;
}

function toLocalDateString(now: number): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildBrief(
  items: SignalItem[],
  outcomes: SignalSourceOutcome[],
  options: BuildBriefOptions,
): SignalBriefDoc {
  const okCount = outcomes.filter((outcome) => outcome.ok).length;
  const kevCount = items.filter((item) => item.kev).length;

  const caveats: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      caveats.push(`${outcome.name} 수집 실패: ${outcome.error || '원인 불명'}`);
    }
  }
  if (!options.interest.applied) {
    caveats.push(`관심 가중치 미적용 — ${describeInterestMeta(options.interest)}`);
  }
  if (items.length === 0 && okCount === outcomes.length && outcomes.length > 0) {
    caveats.push('모든 소스가 정상 응답했으나 수집된 신호가 없습니다.');
  }

  const sections: SignalBriefSection[] = [];
  for (const category of SIGNAL_CATEGORIES) {
    const top = items
      .filter((item) => item.category === category)
      .slice(0, BRIEF_SECTION_LIMITS[category]);
    if (top.length > 0) {
      sections.push({ category, title: BRIEF_SECTION_TITLES[category], items: top });
    }
  }

  return {
    version: 1,
    date: toLocalDateString(options.now),
    generatedAt: options.now,
    headline: `신호 ${items.length}건 · KEV ${kevCount}건 · 소스 ${okCount}/${outcomes.length} 정상`,
    caveats,
    sections,
    interest: options.interest,
  };
}
