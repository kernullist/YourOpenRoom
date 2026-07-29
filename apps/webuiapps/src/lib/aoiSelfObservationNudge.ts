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

export interface AoiSelfObservationState {
  version: 1;
  lastSelfObservationAt: number;
}

export const DEFAULT_AOI_SELF_OBSERVATION_STATE: AoiSelfObservationState = {
  version: 1,
  lastSelfObservationAt: 0,
};

export function normalizeAoiSelfObservationState(raw: unknown): AoiSelfObservationState {
  const value = raw as Partial<AoiSelfObservationState> | null;
  if (!value || value.version !== 1) {
    return { ...DEFAULT_AOI_SELF_OBSERVATION_STATE };
  }
  return {
    version: 1,
    lastSelfObservationAt:
      typeof value.lastSelfObservationAt === 'number' &&
      Number.isFinite(value.lastSelfObservationAt) &&
      value.lastSelfObservationAt >= 0
        ? value.lastSelfObservationAt
        : 0,
  };
}

export function recordAoiSelfObservationOffered(
  state: AoiSelfObservationState | null | undefined,
  now: number,
): AoiSelfObservationState {
  const base = normalizeAoiSelfObservationState(state);
  if (!Number.isFinite(now) || now < 0) {
    return base;
  }
  return { ...base, lastSelfObservationAt: now };
}
