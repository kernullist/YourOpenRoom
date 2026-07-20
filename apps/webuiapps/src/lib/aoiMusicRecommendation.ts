// Pure, dependency-free music recommendation for Aoi (idle cards + chat).
//
// Learns from taste signals (searches, plays, polls, accept/skip) when provided.
// Output is only a YouTube SEARCH QUERY -- the YouTube app runs the live search
// at play time. Server- and client-safe: no fs, no network, deterministic given
// inputs (hourOfDay can override the ambient local hour for tests).

export type AoiMusicMood = 'focus' | 'chill' | 'upbeat' | 'ambient';

export const AOI_MUSIC_MOODS: readonly AoiMusicMood[] = ['focus', 'chill', 'upbeat', 'ambient'];

export type AoiMusicQuerySource = 'personal' | 'pool';

export interface AoiMusicRecommendation {
  mood: AoiMusicMood;
  // A YouTube search query the music app can run directly (OPEN_SEARCH params.query).
  query: string;
  // One human-facing line for the suggestion card.
  why: string;
  // Stable dedupe key for the proposal / cooldown layer.
  cooldownKey: string;
  // Where the query came from: the user's own taste signals or the curated pool.
  source: AoiMusicQuerySource;
}

export interface AoiMusicRecommendationInput {
  now: number;
  // Queries recently recommended or played (any scope) so the picker avoids repeats.
  recentQueries?: readonly string[];
  // Net accept(+) / skip(-) signal per mood, learned from prior cards. A mood the
  // user keeps accepting outranks the time-of-day default; one they keep skipping
  // is pushed down.
  moodFeedback?: Partial<Record<AoiMusicMood, number>>;
  // Additive per-mood bias from explicit taste-poll answers (aoiMusicTaste).
  // Sits between the time-of-day default (+1) and learned feedback (max +-3):
  // strong enough to steer, weak enough for repeated skips to override.
  tasteMoodBias?: Partial<Record<AoiMusicMood, number>>;
  // Personal query candidates (user searches / plays / taste seeds, strongest first).
  // Preferred over the curated pool whenever a fresh personal query remains.
  personalQueries?: readonly string[];
  // When true (default if personalQueries is non-empty), never force a pool pick
  // just to "mix things up" -- only fall back to the pool when personal is exhausted.
  preferPersonal?: boolean;
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

// Choose the mood: start from the time-of-day default (+1), add the learned
// per-mood net feedback and the explicit taste bias, then take the strongest.
// Ties resolve to the first mood reaching the top score in AOI_MUSIC_MOODS
// order (with no signals the time default holds the +1 and always wins).
export function chooseAoiMusicMood(
  hourOfDay: number,
  moodFeedback?: Partial<Record<AoiMusicMood, number>>,
  tasteMoodBias?: Partial<Record<AoiMusicMood, number>>,
): AoiMusicMood {
  const timeDefault = defaultMoodForHour(hourOfDay);
  let bestMood = timeDefault;
  let bestScore = -Infinity;
  for (const mood of AOI_MUSIC_MOODS) {
    const base = mood === timeDefault ? 1 : 0;
    const learned = moodFeedback?.[mood] ?? 0;
    const taste = tasteMoodBias?.[mood] ?? 0;
    const score = base + learned + taste;
    if (score > bestScore) {
      bestScore = score;
      bestMood = mood;
    }
  }
  return bestMood;
}

// Cap how many personal candidates compete per pick so a long search history
// cannot fully crowd out the curated pool when we must fall back.
const MAX_PERSONAL_CANDIDATES = 8;

// Pick a query, skipping anything already in recentQueries.
// When preferPersonal is true (default whenever personal candidates exist),
// always try personal first and only use the curated pool as a fallback.
// When preferPersonal is false, alternate after a personal pick so cards can
// explore the pool deliberately (legacy idle mixing).
function pickQuery(
  mood: AoiMusicMood,
  recentQueries: readonly string[],
  personalQueries: readonly string[] = [],
  preferPersonal = true,
): { query: string; source: AoiMusicQuerySource } {
  const pool = MOOD_QUERIES[mood];
  const personal = personalQueries
    .map((query) => query.trim())
    .filter((query) => query.length > 0)
    .slice(0, MAX_PERSONAL_CANDIDATES);

  const recencyRank = new Map<string, number>();
  recentQueries.forEach((query, index) => {
    const key = query.trim().toLowerCase();
    if (!recencyRank.has(key)) {
      recencyRank.set(key, index);
    }
  });

  const personalKeys = new Set(personal.map((query) => query.toLowerCase()));
  const lastOffered = recentQueries[0]?.trim().toLowerCase();
  const lastWasPersonal = lastOffered !== undefined && personalKeys.has(lastOffered);

  const candidateLists: Array<{ list: readonly string[]; source: AoiMusicQuerySource }> =
    preferPersonal || personal.length === 0
      ? [
          { list: personal, source: 'personal' },
          { list: pool, source: 'pool' },
        ]
      : lastWasPersonal
        ? [
            { list: pool, source: 'pool' },
            { list: personal, source: 'personal' },
          ]
        : [
            { list: personal, source: 'personal' },
            { list: pool, source: 'pool' },
          ];

  for (const { list, source } of candidateLists) {
    const fresh = list.find((query) => !recencyRank.has(query.toLowerCase()));
    if (fresh) {
      return { query: fresh, source };
    }
  }

  // Everything on offer was recommended recently: cycle from the least recent.
  let leastRecent = pool[0];
  let leastRecentSource: AoiMusicQuerySource = 'pool';
  let leastRecentRank = -1;
  for (const { list, source } of candidateLists) {
    for (const query of list) {
      const rank = recencyRank.get(query.toLowerCase());
      if (rank !== undefined && rank > leastRecentRank) {
        leastRecentRank = rank;
        leastRecent = query;
        leastRecentSource = source;
      }
    }
  }
  return { query: leastRecent, source: leastRecentSource };
}

// Build one music recommendation. Pure: same inputs -> same output
// (given hourOfDay, or a fixed `now`). Never throws.
export function buildAoiMusicRecommendation(
  input: AoiMusicRecommendationInput,
): AoiMusicRecommendation {
  const hourOfDay =
    typeof input.hourOfDay === 'number' && Number.isFinite(input.hourOfDay)
      ? Math.min(23, Math.max(0, Math.trunc(input.hourOfDay)))
      : localHourFromNow(input.now);
  const mood = chooseAoiMusicMood(hourOfDay, input.moodFeedback, input.tasteMoodBias);
  const personalQueries = input.personalQueries ?? [];
  const preferPersonal =
    typeof input.preferPersonal === 'boolean'
      ? input.preferPersonal
      : personalQueries.some((query) => query.trim().length > 0);
  const picked = pickQuery(mood, input.recentQueries ?? [], personalQueries, preferPersonal);
  return {
    mood,
    query: picked.query,
    why: MOOD_WHY[mood],
    cooldownKey: `music:${mood}:${picked.query.replace(/\s+/g, '-')}`,
    source: picked.source,
  };
}
