// Pure decision + selection + learning layer for Aoi's proactive "interesting
// cybersecurity news" nudge.
//
// Mirrors aoiIdleMusicNudge: the ChatPanel wiring stays thin -- it asks
// shouldOfferNewsNudge for timing, hands the fetched article list to
// pickInterestingArticle, renders a card, and folds the accept/skip outcome
// back with recordNewsOutcome. No fs, no network, deterministic given inputs.
//
// Selection is security-relevance weighted (the primary user is a security
// engineer): tech / breaking (active incidents) outrank corporate, and street
// (tabloid) is lowest, with learned per-category feedback layered on top.

// Article categories, mirroring CyberNews types.ts ArticleCategory.
export type AoiNewsCategory = 'breaking' | 'corporate' | 'street' | 'tech';

export const AOI_NEWS_CATEGORIES: readonly AoiNewsCategory[] = [
  'breaking',
  'corporate',
  'street',
  'tech',
];

// Base security-relevance weight per category. tech and breaking (active
// incidents) matter most to a security engineer; street (tabloid) is noise.
const CATEGORY_BASE_WEIGHT: Record<AoiNewsCategory, number> = {
  tech: 2,
  breaking: 2,
  corporate: 1,
  street: 0,
};

// Minimal article shape the picker needs, decoupled from CyberNews's Article so
// this module stays dependency-free. The ChatPanel maps Article -> candidate.
export interface AoiNewsCandidate {
  id: string;
  title: string;
  category: AoiNewsCategory;
  summary: string;
  publishedAt: string; // ISO timestamp
  isLive: boolean;
}

// Persisted learning state (the ChatPanel keeps this in localStorage).
export interface AoiNewsLearningState {
  version: 1;
  // Net accept(+)/skip(-) per category, layered onto the base weights.
  categoryFeedback: Partial<Record<AoiNewsCategory, number>>;
  // Recently offered article ids (newest first), so the picker avoids repeats.
  recentArticleIds: string[];
  // When Aoi last OFFERED a news nudge, for the cooldown.
  lastOfferedAt: number;
}

export const AOI_NEWS_STATE_VERSION = 1 as const;

export const DEFAULT_AOI_NEWS_STATE: AoiNewsLearningState = {
  version: AOI_NEWS_STATE_VERSION,
  categoryFeedback: {},
  recentArticleIds: [],
  lastOfferedAt: 0,
};

// News is less frequent than music: longer idle threshold is unnecessary, but a
// longer cooldown keeps Aoi from surfacing headlines too often.
export const DEFAULT_NEWS_MIN_IDLE_MS = 3 * 60 * 1000; // 3 min idle
export const DEFAULT_NEWS_COOLDOWN_MS = 60 * 60 * 1000; // 60 min between offers
const MAX_RECENT_ARTICLE_IDS = 40;
const CATEGORY_FEEDBACK_MIN = -3;
const CATEGORY_FEEDBACK_MAX = 3;

export interface ShouldOfferNewsNudgeInput {
  now: number;
  userIdleMs: number | undefined;
  autonomyEnabled: boolean;
  quietMode: boolean;
  // Skip when the CyberNews app is already open / focused.
  newsAppActive: boolean;
  lastOfferedAt: number;
  minIdleMs?: number;
  cooldownMs?: number;
}

// Should Aoi offer a news nudge right now? Timing gate only; the caller still
// confirms a fresh candidate exists (pickInterestingArticle returning non-null).
export function shouldOfferNewsNudge(input: ShouldOfferNewsNudgeInput): boolean {
  if (!input.autonomyEnabled || input.quietMode || input.newsAppActive) {
    return false;
  }
  if (typeof input.userIdleMs !== 'number' || !Number.isFinite(input.userIdleMs)) {
    return false;
  }
  const minIdleMs = input.minIdleMs ?? DEFAULT_NEWS_MIN_IDLE_MS;
  if (input.userIdleMs < minIdleMs) {
    return false;
  }
  const cooldownMs = input.cooldownMs ?? DEFAULT_NEWS_COOLDOWN_MS;
  if (input.lastOfferedAt > 0 && input.now - input.lastOfferedAt < cooldownMs) {
    return false;
  }
  return true;
}

// Pick the most interesting unseen live article. Score = category base weight +
// learned per-category feedback; ties break to the more recent article. Only
// live (real) articles are eligible -- seed/fiction articles are ignored.
// Returns null when nothing eligible remains.
export function pickInterestingArticle(
  candidates: readonly AoiNewsCandidate[],
  opts: {
    recentArticleIds?: readonly string[];
    categoryFeedback?: Partial<Record<AoiNewsCategory, number>>;
  } = {},
): AoiNewsCandidate | null {
  const recent = new Set(opts.recentArticleIds ?? []);
  let best: AoiNewsCandidate | null = null;
  let bestScore = -Infinity;
  let bestTs = -Infinity;
  for (const candidate of candidates) {
    if (!candidate.isLive || recent.has(candidate.id)) {
      continue;
    }
    const base = CATEGORY_BASE_WEIGHT[candidate.category] ?? 0;
    const learned = opts.categoryFeedback?.[candidate.category] ?? 0;
    const score = base + learned;
    const ts = Date.parse(candidate.publishedAt);
    const publishedTs = Number.isNaN(ts) ? 0 : ts;
    if (score > bestScore || (score === bestScore && publishedTs > bestTs)) {
      best = candidate;
      bestScore = score;
      bestTs = publishedTs;
    }
  }
  return best;
}

function clampFeedback(value: number): number {
  return Math.min(CATEGORY_FEEDBACK_MAX, Math.max(CATEGORY_FEEDBACK_MIN, value));
}

function normalizeState(state: AoiNewsLearningState | null | undefined): AoiNewsLearningState {
  if (!state || state.version !== AOI_NEWS_STATE_VERSION) {
    return { ...DEFAULT_AOI_NEWS_STATE, categoryFeedback: {}, recentArticleIds: [] };
  }
  return state;
}

// Record that a nudge was OFFERED: remember the article id (newest first,
// capped) and stamp the cooldown. Returns a new state (never mutates input).
export function recordNewsOffered(
  state: AoiNewsLearningState | null | undefined,
  params: { articleId: string; now: number },
): AoiNewsLearningState {
  const base = normalizeState(state);
  const articleId = params.articleId.trim();
  const recentArticleIds = articleId
    ? [articleId, ...base.recentArticleIds.filter((id) => id !== articleId)].slice(
        0,
        MAX_RECENT_ARTICLE_IDS,
      )
    : base.recentArticleIds;
  return {
    version: AOI_NEWS_STATE_VERSION,
    categoryFeedback: { ...base.categoryFeedback },
    recentArticleIds,
    lastOfferedAt: params.now,
  };
}

// Fold an accept(+1)/skip(-1) outcome for a category into the learning state.
// Bounded so no category is permanently pinned. Returns a new state.
export function recordNewsOutcome(
  state: AoiNewsLearningState | null | undefined,
  params: { category: AoiNewsCategory; accepted: boolean },
): AoiNewsLearningState {
  const base = normalizeState(state);
  const delta = params.accepted ? 1 : -1;
  const current = base.categoryFeedback[params.category] ?? 0;
  return {
    version: AOI_NEWS_STATE_VERSION,
    categoryFeedback: {
      ...base.categoryFeedback,
      [params.category]: clampFeedback(current + delta),
    },
    recentArticleIds: [...base.recentArticleIds],
    lastOfferedAt: base.lastOfferedAt,
  };
}
