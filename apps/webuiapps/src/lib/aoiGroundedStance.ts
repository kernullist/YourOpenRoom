// Grounded stance composition (R5.2).
//
// The trend advisor already picked one of four takes from the signals, but it
// never said WHY, and it could not disagree. An opinion without a reason is a
// label, and an assistant that only ever agrees with what you already care about
// is not offering a view -- it is reflecting one back.
//
// This centralizes the choice (it was inline in the advisor) and returns the
// reasons behind it, so the copy layer can say "worth a look because two
// independent sources line up" instead of just "worth a look". Every reason is
// derived from a signal the caller already computed; nothing is inferred beyond
// them.
//
// Pure and dependency-free. Deterministic: same signals in, same stance out.

export type AoiStanceTakeKind =
  | 'default_watch'
  | 'stale_refresh'
  | 'weak_source'
  | 'review_candidate';

export type AoiStanceReasonKind =
  // Evidence has aged out of the window; currency cannot be claimed.
  | 'stale_evidence'
  // Exactly one source: nothing corroborates it yet.
  | 'single_source'
  // Independent sources agree, which is what makes a signal worth acting on.
  | 'multi_source_corroboration'
  // Aoi researched this topic herself, so she has her own footing on it.
  | 'matches_own_inquiry'
  // The user cares about it, but the evidence does not carry it yet. This is the
  // disagreement case: alignment alone must not turn a thin signal into a
  // recommendation.
  | 'saved_interest_but_thin'
  // Confidence and novelty both clear the bar.
  | 'high_confidence_signal';

export interface ComposeAoiGroundedStanceInput {
  freshness: 'fresh' | 'stale' | 'unknown';
  sourceCount: number;
  sourceStrong: boolean;
  confidence: number;
  score: number;
  // True when the candidate maps to a topic the user actually saved. A boolean
  // rather than the advisor's drift enum because only the aligned case changes
  // the stance -- the other statuses already suppress delivery upstream.
  interestAligned?: boolean;
  // True when Aoi has an evidence-backed inquiry on this topic (aoiSelfProfile).
  matchesOwnInquiry?: boolean;
}

export interface AoiGroundedStance {
  takeKind: AoiStanceTakeKind;
  reasons: AoiStanceReasonKind[];
  // True when the stance argues against the user's saved interest rather than
  // along with it. Surfaced so callers can tell a real view from an echo.
  disagreesWithInterest: boolean;
}

const HIGH_CONFIDENCE_FLOOR = 0.8;
const HIGH_SCORE_FLOOR = 0.75;

// Precedence is load-bearing and unchanged from the advisor: staleness outranks
// source strength, which outranks a high-confidence recommendation.
function selectTakeKind(input: ComposeAoiGroundedStanceInput): AoiStanceTakeKind {
  if (input.freshness === 'stale') {
    return 'stale_refresh';
  }
  if (!input.sourceStrong) {
    return 'weak_source';
  }
  if (input.confidence >= HIGH_CONFIDENCE_FLOOR && input.score >= HIGH_SCORE_FLOOR) {
    return 'review_candidate';
  }
  return 'default_watch';
}

export function composeAoiGroundedStance(input: ComposeAoiGroundedStanceInput): AoiGroundedStance {
  const takeKind = selectTakeKind(input);
  const sourceCount = Number.isFinite(input.sourceCount) ? Math.max(0, input.sourceCount) : 0;
  const reasons: AoiStanceReasonKind[] = [];

  if (input.freshness === 'stale') {
    reasons.push('stale_evidence');
  }
  if (sourceCount <= 1) {
    reasons.push('single_source');
  } else if (input.sourceStrong) {
    reasons.push('multi_source_corroboration');
  }
  if (
    takeKind === 'review_candidate' &&
    input.confidence >= HIGH_CONFIDENCE_FLOOR &&
    input.score >= HIGH_SCORE_FLOOR
  ) {
    reasons.push('high_confidence_signal');
  }
  if (input.matchesOwnInquiry === true) {
    reasons.push('matches_own_inquiry');
  }
  // The disagreement: aligned with a saved interest, yet the evidence is thin.
  // Saying so is the point -- agreeing because it matches would be an echo.
  const disagreesWithInterest =
    input.interestAligned === true && (takeKind === 'weak_source' || takeKind === 'stale_refresh');
  if (disagreesWithInterest) {
    reasons.push('saved_interest_but_thin');
  }

  return { takeKind, reasons, disagreesWithInterest };
}

// The single reason worth voicing. Ordered by what actually decided the stance,
// so the spoken reason is the operative one rather than the first computed.
const REASON_PRIORITY: AoiStanceReasonKind[] = [
  'stale_evidence',
  'saved_interest_but_thin',
  'single_source',
  'multi_source_corroboration',
  'high_confidence_signal',
  'matches_own_inquiry',
];

export function selectAoiStancePrimaryReason(
  stance: AoiGroundedStance | null,
): AoiStanceReasonKind | null {
  if (!stance || stance.reasons.length === 0) {
    return null;
  }
  const present = new Set(stance.reasons);
  return REASON_PRIORITY.find((reason) => present.has(reason)) ?? null;
}
