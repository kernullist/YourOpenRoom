// Pure decision + learning layer for Aoi's idle "want some music?" nudge.
//
// This holds the gating (should Aoi offer a music nudge right now?) and the
// learning state (which moods the user accepts, which queries were offered
// recently) so the ChatPanel wiring stays thin: it reads state, asks
// shouldOfferIdleMusic, renders the card via the recommendation core, and folds
// the accept/skip outcome back with recordIdleMusicOutcome. No fs, no network,
// deterministic given inputs -- fully unit-testable.

import type { AoiMusicMood } from './aoiMusicRecommendation';

// Persisted learning state (the ChatPanel keeps this in localStorage).
export interface AoiIdleMusicLearningState {
  version: 1;
  // Net accept(+)/skip(-) per mood, fed to the recommendation core.
  moodFeedback: Partial<Record<AoiMusicMood, number>>;
  // Recently offered queries (newest first), so the picker avoids repeats.
  recentQueries: string[];
  // When Aoi last OFFERED a nudge, for the cooldown.
  lastOfferedAt: number;
}

export const AOI_IDLE_MUSIC_STATE_VERSION = 1 as const;

export const DEFAULT_AOI_IDLE_MUSIC_STATE: AoiIdleMusicLearningState = {
  version: AOI_IDLE_MUSIC_STATE_VERSION,
  moodFeedback: {},
  recentQueries: [],
  lastOfferedAt: 0,
};

// How long the user must be idle before a nudge, and how long to wait between
// nudges. Conservative so Aoi is a quiet companion, not a nag.
export const DEFAULT_IDLE_MUSIC_MIN_IDLE_MS = 3 * 60 * 1000; // 3 min idle
export const DEFAULT_IDLE_MUSIC_COOLDOWN_MS = 45 * 60 * 1000; // 45 min between offers
export const AOI_IDLE_MUSIC_MAX_RECENT_QUERIES = 12;
const MAX_RECENT_QUERIES = AOI_IDLE_MUSIC_MAX_RECENT_QUERIES;
// Feedback is bounded so a long streak cannot permanently pin one mood.
const MOOD_FEEDBACK_MIN = -3;
const MOOD_FEEDBACK_MAX = 3;

export interface ShouldOfferIdleMusicInput {
  now: number;
  // Milliseconds since the user was last active; undefined when unknown.
  userIdleMs: number | undefined;
  // Aoi autonomy must be enabled and not in quiet mode.
  autonomyEnabled: boolean;
  quietMode: boolean;
  // Skip when music is already playing / the YouTube app is the focus.
  musicActive: boolean;
  lastOfferedAt: number;
  minIdleMs?: number;
  cooldownMs?: number;
}

// Should Aoi offer a music nudge right now? Pure predicate over the gates:
// autonomy on, not quiet, no music already going, the user has been idle long
// enough, and the per-offer cooldown has elapsed.
export function shouldOfferIdleMusic(input: ShouldOfferIdleMusicInput): boolean {
  if (!input.autonomyEnabled || input.quietMode || input.musicActive) {
    return false;
  }
  if (typeof input.userIdleMs !== 'number' || !Number.isFinite(input.userIdleMs)) {
    return false;
  }
  const minIdleMs = input.minIdleMs ?? DEFAULT_IDLE_MUSIC_MIN_IDLE_MS;
  if (input.userIdleMs < minIdleMs) {
    return false;
  }
  const cooldownMs = input.cooldownMs ?? DEFAULT_IDLE_MUSIC_COOLDOWN_MS;
  if (input.lastOfferedAt > 0 && input.now - input.lastOfferedAt < cooldownMs) {
    return false;
  }
  return true;
}

function clampFeedback(value: number): number {
  return Math.min(MOOD_FEEDBACK_MAX, Math.max(MOOD_FEEDBACK_MIN, value));
}

function normalizeState(
  state: AoiIdleMusicLearningState | null | undefined,
): AoiIdleMusicLearningState {
  if (!state || state.version !== AOI_IDLE_MUSIC_STATE_VERSION) {
    return { ...DEFAULT_AOI_IDLE_MUSIC_STATE, moodFeedback: {}, recentQueries: [] };
  }
  return state;
}

// Record that a nudge was OFFERED: remember the query (newest first, capped) and
// stamp the cooldown. Returns a new state (never mutates the input).
export function recordIdleMusicOffered(
  state: AoiIdleMusicLearningState | null | undefined,
  params: { query: string; now: number },
): AoiIdleMusicLearningState {
  const base = normalizeState(state);
  const query = params.query.trim();
  const recentQueries = query
    ? [
        query,
        ...base.recentQueries.filter((item) => item.toLowerCase() !== query.toLowerCase()),
      ].slice(0, MAX_RECENT_QUERIES)
    : base.recentQueries;
  return {
    version: AOI_IDLE_MUSIC_STATE_VERSION,
    moodFeedback: { ...base.moodFeedback },
    recentQueries,
    lastOfferedAt: params.now,
  };
}

// Fold an accept(+1)/skip(-1) outcome for a mood into the learning state. Bounded
// so no mood is permanently pinned. Returns a new state (never mutates the input).
export function recordIdleMusicOutcome(
  state: AoiIdleMusicLearningState | null | undefined,
  params: { mood: AoiMusicMood; accepted: boolean },
): AoiIdleMusicLearningState {
  const base = normalizeState(state);
  const delta = params.accepted ? 1 : -1;
  const current = base.moodFeedback[params.mood] ?? 0;
  return {
    version: AOI_IDLE_MUSIC_STATE_VERSION,
    moodFeedback: {
      ...base.moodFeedback,
      [params.mood]: clampFeedback(current + delta),
    },
    recentQueries: [...base.recentQueries],
    lastOfferedAt: base.lastOfferedAt,
  };
}
