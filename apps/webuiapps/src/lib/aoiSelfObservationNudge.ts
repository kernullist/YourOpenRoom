// Self-observation nudges (R6.3).
//
// The idle-nudge family only ever observed the USER -- "you have been heads-down
// for a while", "a headline caught my eye". Aoi never reported her own activity,
// so everything she did between sessions was invisible unless asked.
//
// THE CONSTRAINT THIS RESPECTS: no new interruption class. This does not add a
// nudge; it decides whether an interruption the user was already going to get
// carries a self-observation instead of its usual content. The trigger, the idle
// threshold and the cooldown all stay the news nudge's own -- only what gets said
// changes, so the number of interruptions is unchanged.
//
// Honesty: substitution requires a real, evidence-backed inquiry to talk about
// (see aoiSelfProfile). With nothing genuinely explored, the nudge stays as it
// was rather than manufacturing an activity report.
//
// Pure and dependency-free.

// Self-observations are spaced further apart than the host nudge: they are a
// flavour, not the default. Without this the news nudge would effectively become
// a self-observation feed once a few research runs existed.
export const DEFAULT_SELF_OBSERVATION_SPACING_MS = 4 * 60 * 60 * 1000;

export interface ShouldSubstituteAoiSelfObservationInput {
  now: number;
  // When a self-observation last went out. 0 means never.
  lastSelfObservationAt: number;
  // Whether aoiSelfProfile actually has an inquiry to report.
  hasSelfInquiry: boolean;
  // Whether the host nudge had its own content ready. Required: with nothing to
  // ride, speaking anyway would ADD an interruption, which is exactly what the
  // no-new-interruption-class constraint forbids.
  hasHostContent: boolean;
  spacingMs?: number;
}

export function shouldSubstituteAoiSelfObservation(
  input: ShouldSubstituteAoiSelfObservationInput,
): boolean {
  if (!input.hasSelfInquiry) {
    return false;
  }
  // No host content means there is no interruption happening to carry this.
  // Speaking here would add one, so it stays silent instead.
  if (!input.hasHostContent) {
    return false;
  }
  if (!Number.isFinite(input.now) || !Number.isFinite(input.lastSelfObservationAt)) {
    return false;
  }
  const spacingMs = input.spacingMs ?? DEFAULT_SELF_OBSERVATION_SPACING_MS;
  return input.lastSelfObservationAt <= 0 || input.now - input.lastSelfObservationAt >= spacingMs;
}

// How many recently voiced topics are remembered. A one-slot memory was the
// repetition bug: excluding only the LAST topic makes a pool of N alternate
// between its two newest entries forever, so the third-newest inquiry was never
// spoken and the user heard the same two lines on repeat. The window has to be
// at least as deep as a realistic inquiry pool for rotation to actually rotate.
export const MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY = 12;

export interface AoiSelfObservationState {
  version: 1;
  lastSelfObservationAt: number;
  // Topic key of the most recently voiced self-inquiry. Kept as the head of
  // recentTopicKeys for older records that predate the history field.
  lastTopicKey?: string;
  // Topic keys already voiced, MOST RECENT FIRST. The selector excludes all of
  // them, so the pool is spoken round-robin rather than ping-ponging.
  recentTopicKeys?: string[];
  // Monotonic count of voiced self-observations. Drives phrasing rotation, so
  // even a repeated topic does not arrive in the identical sentence frame.
  offeredCount?: number;
}

export const DEFAULT_AOI_SELF_OBSERVATION_STATE: AoiSelfObservationState = {
  version: 1,
  lastSelfObservationAt: 0,
  recentTopicKeys: [],
  offeredCount: 0,
};

// Dedup + cap, preserving most-recent-first order.
function normalizeTopicHistory(raw: unknown, fallbackHead: string): string[] {
  const seen = new Set<string>();
  const history: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const key = value.trim();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    history.push(key);
  };
  // Migration: a record written before this field only has lastTopicKey, and it
  // is by definition the most recent entry.
  push(fallbackHead);
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      push(entry);
    }
  }
  return history.slice(0, MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY);
}

export function normalizeAoiSelfObservationState(raw: unknown): AoiSelfObservationState {
  const value = raw as Partial<AoiSelfObservationState> | null;
  if (!value || value.version !== 1) {
    return { ...DEFAULT_AOI_SELF_OBSERVATION_STATE };
  }
  const lastTopicKey = typeof value.lastTopicKey === 'string' ? value.lastTopicKey.trim() : '';
  const recentTopicKeys = normalizeTopicHistory(value.recentTopicKeys, lastTopicKey);
  return {
    version: 1,
    lastSelfObservationAt:
      typeof value.lastSelfObservationAt === 'number' &&
      Number.isFinite(value.lastSelfObservationAt) &&
      value.lastSelfObservationAt >= 0
        ? value.lastSelfObservationAt
        : 0,
    ...(lastTopicKey ? { lastTopicKey } : {}),
    recentTopicKeys,
    // A record that predates the counter starts from its known history depth, so
    // phrasing rotation does not restart at the same variant for every user.
    offeredCount:
      typeof value.offeredCount === 'number' &&
      Number.isFinite(value.offeredCount) &&
      value.offeredCount >= 0
        ? Math.floor(value.offeredCount)
        : recentTopicKeys.length,
  };
}

export function recordAoiSelfObservationOffered(
  state: AoiSelfObservationState | null | undefined,
  now: number,
  options?: { topicKey?: string },
): AoiSelfObservationState {
  const base = normalizeAoiSelfObservationState(state);
  if (!Number.isFinite(now) || now < 0) {
    return base;
  }
  const topicKey = typeof options?.topicKey === 'string' ? options.topicKey.trim() : '';
  const previous = base.recentTopicKeys ?? [];
  // Re-voicing a topic moves it back to the head rather than adding a duplicate,
  // so the window always holds MAX distinct topics worth of rotation.
  const recentTopicKeys = topicKey
    ? [topicKey, ...previous.filter((key) => key !== topicKey)].slice(
        0,
        MAX_AOI_SELF_OBSERVATION_TOPIC_HISTORY,
      )
    : previous;
  return {
    ...base,
    lastSelfObservationAt: now,
    ...(topicKey
      ? { lastTopicKey: topicKey }
      : base.lastTopicKey
        ? { lastTopicKey: base.lastTopicKey }
        : {}),
    recentTopicKeys,
    offeredCount: (base.offeredCount ?? 0) + 1,
  };
}
