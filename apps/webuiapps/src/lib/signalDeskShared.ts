/**
 * Signal Desk wire format, shared between the server-side collector
 * (src/lib/signalDeskPlugin.ts) and the app (src/pages/SignalDesk).
 *
 * This module must stay free of node built-ins and of imports that reach them:
 * the app bundles it, and a node-only import here would break `pnpm build`
 * while typecheck and vitest stayed green. Enforced by
 * src/pages/SignalDesk/__tests__/actionSafety.test.ts.
 */

export const SIGNAL_CATEGORIES = [
  'vuln',
  'msrc',
  'research',
  'paper',
  'release',
  'ai',
  'harness',
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

export function isSignalCategory(value: unknown): value is SignalCategory {
  return typeof value === 'string' && (SIGNAL_CATEGORIES as readonly string[]).includes(value);
}

export type SignalSourceKind = 'rss' | 'atom' | 'kev-json';

export interface SignalItem {
  id: string;
  title: string;
  url: string;
  summary: string;
  sourceId: string;
  sourceName: string;
  category: SignalCategory;
  /** ISO timestamp. */
  publishedAt: string;
  score: number;
  /** Human-readable contributions, rendered as chips. */
  scoreReasons: string[];
  cveIds: string[];
  /** Listed in CISA KEV (known exploited). */
  kev: boolean;
  /** Merged duplicates beyond this item. */
  duplicateCount: number;
  /** Names of the other sources that reported the same signal. */
  otherSources: string[];
}

/**
 * Per-source collection outcome.
 *
 * `ok: false` with `error` is structurally different from `ok: true` with
 * `itemCount: 0` — a dead feed must never render like a quiet one.
 */
export interface SignalSourceOutcome {
  sourceId: string;
  name: string;
  kind: SignalSourceKind;
  category: SignalCategory;
  ok: boolean;
  itemCount: number;
  error?: string;
  ms: number;
}

export type InterestSkipReason = 'no-session' | 'no-profile' | 'profile-error';

/**
 * Whether interest weighting was actually applied to this ranking, and if not,
 * why. Not applying it is a stated condition, never a silent default.
 */
export interface InterestMeta {
  applied: boolean;
  keywordCount: number;
  reason?: InterestSkipReason;
  detail?: string;
}

export function describeInterestMeta(meta: InterestMeta): string {
  if (meta.applied) {
    return `관심 프로파일 적용 · 키워드 ${meta.keywordCount}개`;
  }
  if (meta.reason === 'no-session') {
    return '기본 우선순위 · 세션 미지정';
  }
  if (meta.reason === 'no-profile') {
    return '기본 우선순위 · 관심 프로파일 없음';
  }
  if (meta.reason === 'profile-error') {
    return `기본 우선순위 · 프로파일 읽기 실패${meta.detail ? ` (${meta.detail})` : ''}`;
  }
  return '기본 우선순위';
}

export interface SignalsResponse {
  ok: true;
  fetchedAt: number;
  cache: 'fresh' | 'cached';
  sources: SignalSourceOutcome[];
  items: SignalItem[];
  interest: InterestMeta;
}

export interface SignalBriefSection {
  category: SignalCategory;
  title: string;
  items: SignalItem[];
}

export interface SignalBriefDoc {
  version: 1;
  /** YYYY-MM-DD, server-local. */
  date: string;
  generatedAt: number;
  headline: string;
  /** Collection caveats: failed sources, interest not applied, etc. */
  caveats: string[];
  sections: SignalBriefSection[];
  interest: InterestMeta;
}

export interface SignalBriefResponse {
  ok: true;
  cache: 'fresh' | 'cached';
  brief: SignalBriefDoc;
  sources: SignalSourceOutcome[];
}
