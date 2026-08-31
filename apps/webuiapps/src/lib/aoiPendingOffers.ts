// Persistence for Aoi's pending nudge offers (idle music / cyber news).
//
// The nudge cards and their reply chips are restored from chat history after a
// reload, so the pending offer behind the chips must survive too. With an
// in-memory-only ref, tapping a restored play chip skipped the accept path and
// fell through to the generic music-intent parser, which searched YouTube for
// the chip symbol ("|>") instead of the recommended query. Offers are stored
// best-effort in localStorage: written when a card is emitted, cleared when any
// user message consumes the offer (accept, dismiss, or implicit skip), and
// hydrated once on mount.
//
// localStorage only covers a reload of the SAME browser profile and origin. The
// cards come back from the server-side transcript, so a tap from a second
// browser, a different dev-server origin, or after cleared site data still
// arrives bare. aoiPendingOfferRecovery rebuilds the offer from the transcript
// itself for exactly that case; this module is the fast path, not the only one.

import type { AoiMusicMood } from './aoiMusicRecommendation';
import { AOI_MUSIC_MOODS } from './aoiMusicRecommendation';
import type { AoiNewsCategory } from './aoiNewsNudge';
import { AOI_NEWS_CATEGORIES } from './aoiNewsNudge';

export interface PendingIdleMusicOffer {
  playPrompt: string;
  dismissPrompt: string;
  query: string;
  // Null when the offer was rebuilt from a card that does not print its mood
  // (the taste re-roll card). The chip still works; only the per-mood
  // accept/skip learning is skipped, because inventing a mood would teach the
  // recommender a preference the user never expressed.
  mood: AoiMusicMood | null;
}

export interface PendingNewsOffer {
  playPrompt: string;
  dismissPrompt: string;
  articleId: string;
  category: AoiNewsCategory;
  title: string;
  // When the card was emitted. The article behind a news chip lives in a
  // rotating ten-item live feed that CyberNews prunes on every sync, so an
  // offer can outlive the file it points at. Without an age the chip stayed
  // armed forever: a tap four days later dispatched VIEW_ARTICLE for an
  // article that had been deleted and answered with a generic open failure.
  offeredAt: number;
}

// How long a news chip stays tappable. The live feed refreshes every 30 min and
// keeps only ten items, so six hours is about the outer edge of "the article is
// probably still on disk" while still covering an ordinary away-from-desk gap.
export const NEWS_OFFER_TTL_MS = 6 * 60 * 60 * 1000;

export function isNewsOfferExpired(offer: PendingNewsOffer, now: number = Date.now()): boolean {
  return now - offer.offeredAt > NEWS_OFFER_TTL_MS;
}

const PENDING_MUSIC_OFFER_STORAGE_KEY = 'aoi-pending-idle-music-offer-v1';
const PENDING_NEWS_OFFER_STORAGE_KEY = 'aoi-pending-news-offer-v1';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    // Malformed storage or privacy mode; treat as no pending offer.
    return null;
  }
}

function writeJson(key: string, value: unknown | null): void {
  try {
    if (value) {
      localStorage.setItem(key, JSON.stringify(value));
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}

export function loadPendingIdleMusicOffer(): PendingIdleMusicOffer | null {
  const parsed = readJson(PENDING_MUSIC_OFFER_STORAGE_KEY) as Partial<PendingIdleMusicOffer> | null;
  if (
    parsed &&
    isNonEmptyString(parsed.playPrompt) &&
    isNonEmptyString(parsed.dismissPrompt) &&
    isNonEmptyString(parsed.query) &&
    (parsed.mood === null ||
      (isNonEmptyString(parsed.mood) &&
        (AOI_MUSIC_MOODS as readonly string[]).includes(parsed.mood)))
  ) {
    return {
      playPrompt: parsed.playPrompt,
      dismissPrompt: parsed.dismissPrompt,
      query: parsed.query,
      mood: (parsed.mood as AoiMusicMood | null) ?? null,
    };
  }
  return null;
}

export function savePendingIdleMusicOffer(offer: PendingIdleMusicOffer | null): void {
  writeJson(PENDING_MUSIC_OFFER_STORAGE_KEY, offer);
}

export function loadPendingNewsOffer(now: number = Date.now()): PendingNewsOffer | null {
  const parsed = readJson(PENDING_NEWS_OFFER_STORAGE_KEY) as Partial<PendingNewsOffer> | null;
  if (
    parsed &&
    isNonEmptyString(parsed.playPrompt) &&
    isNonEmptyString(parsed.dismissPrompt) &&
    isNonEmptyString(parsed.articleId) &&
    isNonEmptyString(parsed.title) &&
    isNonEmptyString(parsed.category) &&
    (AOI_NEWS_CATEGORIES as readonly string[]).includes(parsed.category) &&
    // An entry written before offers carried an age cannot be dated, and an
    // offer that cannot be dated must not be re-armed: it is at least as old as
    // the deploy that added the field.
    typeof parsed.offeredAt === 'number' &&
    Number.isFinite(parsed.offeredAt) &&
    parsed.offeredAt > 0
  ) {
    const offer: PendingNewsOffer = {
      playPrompt: parsed.playPrompt,
      dismissPrompt: parsed.dismissPrompt,
      articleId: parsed.articleId,
      category: parsed.category as AoiNewsCategory,
      title: parsed.title,
      offeredAt: parsed.offeredAt,
    };
    return isNewsOfferExpired(offer, now) ? null : offer;
  }
  return null;
}

export function savePendingNewsOffer(offer: PendingNewsOffer | null): void {
  writeJson(PENDING_NEWS_OFFER_STORAGE_KEY, offer);
}

// --- Taste poll ---------------------------------------------------------------

export interface PendingTastePollOption {
  id: string;
  // The exact chip label shown to the user; answers are matched against it.
  label: string;
}

export interface PendingTastePoll {
  questionId: string;
  options: PendingTastePollOption[];
}

const PENDING_TASTE_POLL_STORAGE_KEY = 'aoi-pending-taste-poll-v1';
const MAX_TASTE_POLL_OPTIONS = 8;

export function loadPendingTastePoll(): PendingTastePoll | null {
  const parsed = readJson(PENDING_TASTE_POLL_STORAGE_KEY) as Partial<PendingTastePoll> | null;
  if (
    parsed &&
    isNonEmptyString(parsed.questionId) &&
    Array.isArray(parsed.options) &&
    parsed.options.length > 0 &&
    parsed.options.length <= MAX_TASTE_POLL_OPTIONS &&
    parsed.options.every(
      (option) =>
        option &&
        typeof option === 'object' &&
        isNonEmptyString((option as PendingTastePollOption).id) &&
        isNonEmptyString((option as PendingTastePollOption).label),
    )
  ) {
    return {
      questionId: parsed.questionId,
      options: parsed.options.map((option) => ({ id: option.id, label: option.label })),
    };
  }
  return null;
}

export function savePendingTastePoll(poll: PendingTastePoll | null): void {
  writeJson(PENDING_TASTE_POLL_STORAGE_KEY, poll);
}

// --- Preference poll ----------------------------------------------------------

// The general preference poll (aoiPreferencePoll) reuses the same restore
// contract as the music taste poll: its card + option chips are restored from
// chat history after a reload, so the pending poll behind the chips must survive
// too. It carries the questionId plus each option's exact chip label (answers
// are matched against the label) and the optionId used to persist the answer.

export interface PendingPreferencePollOption {
  id: string;
  // The exact chip label shown to the user; answers are matched against it.
  label: string;
}

export interface PendingPreferencePoll {
  questionId: string;
  options: PendingPreferencePollOption[];
}

const PENDING_PREFERENCE_POLL_STORAGE_KEY = 'aoi-pending-preference-poll-v1';
const MAX_PREFERENCE_POLL_OPTIONS = 8;

export function loadPendingPreferencePoll(): PendingPreferencePoll | null {
  const parsed = readJson(
    PENDING_PREFERENCE_POLL_STORAGE_KEY,
  ) as Partial<PendingPreferencePoll> | null;
  if (
    parsed &&
    isNonEmptyString(parsed.questionId) &&
    Array.isArray(parsed.options) &&
    parsed.options.length > 0 &&
    parsed.options.length <= MAX_PREFERENCE_POLL_OPTIONS &&
    parsed.options.every(
      (option) =>
        option &&
        typeof option === 'object' &&
        isNonEmptyString((option as PendingPreferencePollOption).id) &&
        isNonEmptyString((option as PendingPreferencePollOption).label),
    )
  ) {
    return {
      questionId: parsed.questionId,
      options: parsed.options.map((option) => ({ id: option.id, label: option.label })),
    };
  }
  return null;
}

export function savePendingPreferencePoll(poll: PendingPreferencePoll | null): void {
  writeJson(PENDING_PREFERENCE_POLL_STORAGE_KEY, poll);
}
