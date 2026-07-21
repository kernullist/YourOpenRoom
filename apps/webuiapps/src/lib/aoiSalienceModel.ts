// Aoi salience model (SA3.1): continuous, per-kind decay scoring for "what
// matters RIGHT NOW", replacing week-scale binary freshness cliffs for live
// signals.
//
// Model: score = baseWeight * 2^(-age / halfLife), where the half-life is
// per source kind (live activity decays in minutes, workspace in hours,
// research in a day, durable notes in a week). A FUTURE timestamp (e.g. an
// upcoming calendar event) ramps UP as it approaches by the same curve over
// the time REMAINING -- proximity is salience for scheduled items.
//
// Pure math, display-only consumers; no I/O, no state, fully deterministic.
import type { AoiContextSourceKind } from './aoiAutonomyTypes';

export type AoiSalienceKind = AoiContextSourceKind | 'chat';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Per-kind half-lives. These are the "how fast does NOW stop caring" knobs.
export const AOI_SALIENCE_HALF_LIVES_MS: Record<AoiSalienceKind, number> = {
  app_activity: 30 * MINUTE_MS,
  // Real-PC live signals decay on a minutes scale like in-app activity.
  process_activity: 30 * MINUTE_MS,
  host_browser_read: 30 * MINUTE_MS,
  browser_drive: 30 * MINUTE_MS,
  desktop_activity: 30 * MINUTE_MS,
  // Screen content is the most volatile "now" signal -- it decays fastest.
  screen_vision: 15 * MINUTE_MS,
  chat: 2 * HOUR_MS,
  browser_context: 2 * HOUR_MS,
  workspace_git: 4 * HOUR_MS,
  workspace_build: 4 * HOUR_MS,
  mission_state: 12 * HOUR_MS,
  calendar_metadata: 12 * HOUR_MS,
  gmail_metadata: 12 * HOUR_MS,
  notes_metadata: 12 * HOUR_MS,
  app_state: 24 * HOUR_MS,
  kira_board: 24 * HOUR_MS,
  research_runs: 24 * HOUR_MS,
  manual_note: 7 * DAY_MS,
};

// Pinned items never fade out entirely -- the operator marked them important.
const PINNED_SCORE_FLOOR = 0.3;
const DEFAULT_BASE_WEIGHT = 0.5;
// Beyond ~6 half-lives the contribution is under 2% -- treat as faded.
const FADED_DECAY_FACTOR = 0.02;

export interface AoiSalienceInput {
  kind: AoiSalienceKind;
  // The signal's own timestamp. Past -> decays with age; FUTURE (a scheduled
  // item like a calendar event) -> ramps up as the moment approaches.
  observedAt: number;
  // Producer-supplied importance/relevance in [0, 1]. Defaults to 0.5.
  baseWeight?: number;
  pinned?: boolean;
}

export interface AoiSalienceScore {
  score: number;
  decayFactor: number;
  halfLifeMs: number;
  ageMs: number;
  faded: boolean;
  reasons: string[];
}

export interface AoiRankedSalientItem<T> {
  item: T;
  salience: AoiSalienceScore;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scoreAoiSalience(input: AoiSalienceInput, now: number): AoiSalienceScore {
  const halfLifeMs = AOI_SALIENCE_HALF_LIVES_MS[input.kind];
  const baseWeight = clamp(
    typeof input.baseWeight === 'number' && Number.isFinite(input.baseWeight)
      ? input.baseWeight
      : DEFAULT_BASE_WEIGHT,
    0,
    1,
  );
  const observedAt = Number.isFinite(input.observedAt) ? input.observedAt : now;
  const ageMs = now - observedAt;
  // Past signals decay over their age; future (scheduled) signals ramp up
  // over the time remaining. Both use the same half-life curve.
  const distanceMs = Math.abs(ageMs);
  const decayFactor = Math.pow(2, -distanceMs / halfLifeMs);
  const reasons: string[] = [
    ageMs >= 0
      ? `decays with age ${formatDuration(distanceMs)} (half-life ${formatDuration(halfLifeMs)})`
      : `ramps up toward a scheduled moment in ${formatDuration(distanceMs)}`,
  ];
  let score = baseWeight * decayFactor;
  const faded = decayFactor < FADED_DECAY_FACTOR && input.pinned !== true;
  if (faded) {
    reasons.push('faded: beyond the salience horizon');
  }
  if (input.pinned === true && score < PINNED_SCORE_FLOOR) {
    score = PINNED_SCORE_FLOOR;
    reasons.push('pinned floor applied');
  }
  return {
    score: Number(clamp(score, 0, 1).toFixed(4)),
    decayFactor: Number(decayFactor.toFixed(4)),
    halfLifeMs,
    ageMs,
    faded,
    reasons,
  };
}

export function rankAoiSalientItems<T>(
  items: readonly T[],
  accessor: (item: T) => AoiSalienceInput,
  options: { now: number; limit?: number; includeFaded?: boolean },
): AoiRankedSalientItem<T>[] {
  const limit = Math.max(1, Math.trunc(options.limit ?? items.length));
  return items
    .map((item) => ({ item, salience: scoreAoiSalience(accessor(item), options.now) }))
    .filter((entry) => options.includeFaded === true || !entry.salience.faded)
    .sort(
      (left, right) =>
        right.salience.score - left.salience.score ||
        right.salience.decayFactor - left.salience.decayFactor,
    )
    .slice(0, limit);
}

// The router's freshness scoring is a step function (fresh +0.08 / stale
// -0.18); this maps the continuous decay factor onto the same numeric range
// so live sources fade smoothly instead of cliff-dropping (SA3.2 consumer).
export function salienceFreshnessAdjustment(decayFactor: number): number {
  const bounded = clamp(decayFactor, 0, 1);
  return Number((-0.18 + bounded * 0.26).toFixed(4));
}

function formatDuration(ms: number): string {
  if (ms < HOUR_MS) {
    return `${Math.max(0, Math.round(ms / MINUTE_MS))}m`;
  }
  if (ms < DAY_MS) {
    return `${Math.round((ms / HOUR_MS) * 10) / 10}h`;
  }
  return `${Math.round((ms / DAY_MS) * 10) / 10}d`;
}
