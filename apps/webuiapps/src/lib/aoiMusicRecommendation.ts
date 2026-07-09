// Pure, dependency-free music recommendation for Aoi's idle "play a song" feature.
//
// Aoi has no stored music taste yet (the user's memories are security / anti-cheat
// focused), so recommendations start from time-of-day mood and adapt from accept /
// skip feedback. The output is only a YouTube SEARCH QUERY -- the YouTube app
// (appId 3) runs the live search at play time, so there is no seeded catalog to
// maintain. Server- and client-safe: no fs, no network, and deterministic given
// its inputs (the only ambient read is now -> local hour, which callers can
// override via hourOfDay for tests).

export type AoiMusicMood = 'focus' | 'chill' | 'upbeat' | 'ambient';

export const AOI_MUSIC_MOODS: readonly AoiMusicMood[] = ['focus', 'chill', 'upbeat', 'ambient'];

export interface AoiMusicRecommendation {
  mood: AoiMusicMood;
  // A YouTube search query the music app can run directly (OPEN_SEARCH params.query).
  query: string;
  // One human-facing line for the suggestion card.
  why: string;
  // Stable dedupe key for the proposal / cooldown layer.
  cooldownKey: string;
}

export interface AoiMusicRecommendationInput {
  now: number;
  // Queries recently recommended or played (any scope) so the picker avoids repeats.
  recentQueries?: readonly string[];
  // Net accept(+) / skip(-) signal per mood, learned from prior cards. A mood the
  // user keeps accepting outranks the time-of-day default; one they keep skipping
  // is pushed down.
  moodFeedback?: Partial<Record<AoiMusicMood, number>>;
  // Test / caller override for the local hour (0-23). When absent it is derived
  // from `now` so the module stays pure and deterministic under test.
  hourOfDay?: number;
}

// Curated query pools per mood. Ordered by preference; the picker walks them to
// avoid recently-used queries. Kept intentionally small and generic -- learning
// happens at the mood level, and the app resolves each query live on YouTube.
const MOOD_QUERIES: Record<AoiMusicMood, readonly string[]> = {
  focus: [
    'lofi hip hop radio beats to relax study to',
    'deep focus music for coding',
    'instrumental concentration music',
    'programming ambient focus mix',
  ],
  chill: [
    'chill lofi evening mix',
    'relaxing chillhop mix',
    'mellow indie chill playlist',
    'sunset chill beats',
  ],
  upbeat: [
    'upbeat morning playlist',
    'feel good energy mix',
    'motivating work pop playlist',
    'bright morning focus beats',
  ],
  ambient: [
    'ambient music for deep work',
    'calm ambient soundscape',
    'late night ambient mix',
    'spacious ambient drone for focus',
  ],
};

const MOOD_WHY: Record<AoiMusicMood, string> = {
  focus: 'You have been heads-down for a while. Want some focus music while you work?',
  chill: 'Looks like a quieter moment. Want a chill mix in the background?',
  upbeat: 'Starting up for the day. Want something upbeat to get going?',
  ambient: 'Late and quiet. Want some ambient sound to sit under the work?',
};

// Local hour (0-23) from an epoch-ms timestamp. Isolated so the one ambient read
// is easy to see and to override in tests.
function localHourFromNow(now: number): number {
  return new Date(now).getHours();
}

// Time-of-day default mood. Tuned for a developer's day: mornings lean upbeat,
// working hours lean focus, evenings wind down to chill, late night to ambient.
function defaultMoodForHour(hourOfDay: number): AoiMusicMood {
  if (hourOfDay >= 6 && hourOfDay < 10) {
    return 'upbeat';
  }
  if (hourOfDay >= 10 && hourOfDay < 18) {
    return 'focus';
  }
  if (hourOfDay >= 18 && hourOfDay < 23) {
    return 'chill';
  }
  return 'ambient';
}

// Choose the mood: start from the time-of-day default (+1) and add the learned
// per-mood net feedback, then take the strongest. Ties resolve to the time
// default (it holds the +1), so with no feedback the time mood always wins.
export function chooseAoiMusicMood(
  hourOfDay: number,
  moodFeedback?: Partial<Record<AoiMusicMood, number>>,
): AoiMusicMood {
  const timeDefault = defaultMoodForHour(hourOfDay);
  let bestMood = timeDefault;
  let bestScore = -Infinity;
  for (const mood of AOI_MUSIC_MOODS) {
    const base = mood === timeDefault ? 1 : 0;
    const learned = moodFeedback?.[mood] ?? 0;
    const score = base + learned;
    if (score > bestScore) {
      bestScore = score;
      bestMood = mood;
    }
  }
  return bestMood;
}

// Pick a query from the mood pool, skipping anything already in recentQueries.
// When every pooled query is recent, fall back to the least-recently-offered one.
// recentQueries is newest-first and recordIdleMusicOffered moves each offer back
// to its front, so consecutive fallback picks keep cycling through the pool.
// (A count-based rotation would stick: once the pool is exhausted the recent list
// only reorders, its length stops changing, and one entry repeats forever.)
function pickQuery(mood: AoiMusicMood, recentQueries: readonly string[]): string {
  const pool = MOOD_QUERIES[mood];
  const recencyRank = new Map<string, number>();
  recentQueries.forEach((query, index) => {
    const key = query.trim().toLowerCase();
    if (!recencyRank.has(key)) {
      recencyRank.set(key, index);
    }
  });
  let leastRecent = pool[0];
  let leastRecentRank = -1;
  for (const query of pool) {
    const rank = recencyRank.get(query.toLowerCase());
    if (rank === undefined) {
      // Never offered recently: take the first fresh entry in preference order.
      return query;
    }
    if (rank > leastRecentRank) {
      leastRecentRank = rank;
      leastRecent = query;
    }
  }
  return leastRecent;
}

// Build one idle-time music recommendation. Pure: same inputs -> same output
// (given hourOfDay, or a fixed `now`). Never throws.
export function buildAoiMusicRecommendation(
  input: AoiMusicRecommendationInput,
): AoiMusicRecommendation {
  const hourOfDay =
    typeof input.hourOfDay === 'number' && Number.isFinite(input.hourOfDay)
      ? Math.min(23, Math.max(0, Math.trunc(input.hourOfDay)))
      : localHourFromNow(input.now);
  const mood = chooseAoiMusicMood(hourOfDay, input.moodFeedback);
  const query = pickQuery(mood, input.recentQueries ?? []);
  return {
    mood,
    query,
    why: MOOD_WHY[mood],
    cooldownKey: `music:${mood}:${query.replace(/\s+/g, '-')}`,
  };
}
