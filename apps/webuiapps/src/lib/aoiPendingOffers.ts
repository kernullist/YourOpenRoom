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

import type { AoiMusicMood } from './aoiMusicRecommendation';
import { AOI_MUSIC_MOODS } from './aoiMusicRecommendation';
import type { AoiNewsCategory } from './aoiNewsNudge';
import { AOI_NEWS_CATEGORIES } from './aoiNewsNudge';

export interface PendingIdleMusicOffer {
  playPrompt: string;
  dismissPrompt: string;
  query: string;
  mood: AoiMusicMood;
}

export interface PendingNewsOffer {
  playPrompt: string;
  dismissPrompt: string;
  articleId: string;
  category: AoiNewsCategory;
  title: string;
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
    isNonEmptyString(parsed.mood) &&
    (AOI_MUSIC_MOODS as readonly string[]).includes(parsed.mood)
  ) {
    return {
      playPrompt: parsed.playPrompt,
      dismissPrompt: parsed.dismissPrompt,
      query: parsed.query,
      mood: parsed.mood as AoiMusicMood,
    };
  }
  return null;
}

export function savePendingIdleMusicOffer(offer: PendingIdleMusicOffer | null): void {
  writeJson(PENDING_MUSIC_OFFER_STORAGE_KEY, offer);
}

export function loadPendingNewsOffer(): PendingNewsOffer | null {
  const parsed = readJson(PENDING_NEWS_OFFER_STORAGE_KEY) as Partial<PendingNewsOffer> | null;
  if (
    parsed &&
    isNonEmptyString(parsed.playPrompt) &&
    isNonEmptyString(parsed.dismissPrompt) &&
    isNonEmptyString(parsed.articleId) &&
    isNonEmptyString(parsed.title) &&
    isNonEmptyString(parsed.category) &&
    (AOI_NEWS_CATEGORIES as readonly string[]).includes(parsed.category)
  ) {
    return {
      playPrompt: parsed.playPrompt,
      dismissPrompt: parsed.dismissPrompt,
      articleId: parsed.articleId,
      category: parsed.category as AoiNewsCategory,
      title: parsed.title,
    };
  }
  return null;
}

export function savePendingNewsOffer(offer: PendingNewsOffer | null): void {
  writeJson(PENDING_NEWS_OFFER_STORAGE_KEY, offer);
}
