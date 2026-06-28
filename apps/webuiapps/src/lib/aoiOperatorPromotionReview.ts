import {
  createAoiTracePromotionDecision,
  type AoiTracePromotionAcceptanceDimension,
  type AoiTracePromotionCandidate,
  type AoiTracePromotionDecision,
  type AoiTracePromotionReport,
} from './aoiTracePromotion';
import type {
  AoiAdaptiveAcceptanceCandidate,
  AoiAdaptiveAcceptancePack,
  AoiAdaptiveAcceptanceReviewState,
} from './aoiAdaptiveAcceptanceCuration';

// Pure core of the operator-review -> persisted-promotion pipeline (roadmap item 1,
// step 3). It turns the assembled trace / adaptive candidate reports into an operator
// review queue, and validates an operator review request into a trace-promotion
// decision or an adaptive review state. The server glue (aoiOperatorPromotionReviewServer)
// loads the reports, calls these, and persists the result through the actor-gated store.
//
// This module owns no fs/Node, but it value-imports createAoiTracePromotionDecision,
// which transitively loads the server store -- so the client must import only its
// TYPES (type-only imports are erased and pull nothing into the bundle).
//
// SAFETY: every decision / review state produced here is stamped actor === 'user'.
// There is no code path that produces a system actor, and the store rejects non-user
// actors on write -- so an operator review is the ONLY way a promotion is ever
// created. This is the human-in-the-loop barrier against autonomy self-escalation.

const MAX_QUEUE_REFS = 8;
const MAX_REASON_CHARS = 280;

export type AoiOperatorReviewAction = 'promote' | 'defer' | 'reject';

export interface AoiOperatorReviewCandidateSummary {
  version: 1;
  kind: 'trace' | 'adaptive';
  candidateId: string;
  title: string;
  summary: string;
  selectedLabel: string;
  acceptanceDimension: string;
  privacyStatus: string;
  reviewStatus: string;
  // True when the candidate can become a counted promotion (privacy not blocked and,
  // for adaptive, a replay draft exists). A blocked candidate cannot be promoted.
  promotable: boolean;
  evidenceRefs: string[];
}

export interface AoiOperatorReviewQueue {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  traceCandidateCount: number;
  adaptiveCandidateCount: number;
  promotedCount: number;
  // The gate-relevant figure (mirrors the scorecard's promotedReplayPassRate): the
  // operator must reach 1 across the full candidate set to unlock trusted_operator.
  promotedReplayPassRate: number;
  candidates: AoiOperatorReviewCandidateSummary[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiOperatorReviewRequest {
  kind: 'trace' | 'adaptive';
  candidateId: string;
  action: AoiOperatorReviewAction;
  reason?: string;
  acceptanceDimension?: AoiTracePromotionAcceptanceDimension;
}

export type AoiOperatorReviewResult =
  | { ok: true; kind: 'trace'; decision: AoiTracePromotionDecision }
  | { ok: true; kind: 'adaptive'; reviewState: AoiAdaptiveAcceptanceReviewState }
  | { ok: false; code: string; error: string };

function clampReason(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
}

function isTracePromotable(candidate: AoiTracePromotionCandidate): boolean {
  return candidate.privacyStatus !== 'blocked';
}

function isAdaptivePromotable(candidate: AoiAdaptiveAcceptanceCandidate): boolean {
  return candidate.privacyStatus !== 'blocked' && candidate.replayDraftStatus !== 'blocked';
}

function summarizeTraceCandidate(
  candidate: AoiTracePromotionCandidate,
): AoiOperatorReviewCandidateSummary {
  return {
    version: 1,
    kind: 'trace',
    candidateId: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    selectedLabel: candidate.selectedLabel,
    acceptanceDimension: candidate.acceptanceDimension,
    privacyStatus: candidate.privacyStatus,
    reviewStatus: candidate.reviewStatus,
    promotable: isTracePromotable(candidate),
    evidenceRefs: candidate.evidenceRefs.slice(0, MAX_QUEUE_REFS),
  };
}

function summarizeAdaptiveCandidate(
  candidate: AoiAdaptiveAcceptanceCandidate,
): AoiOperatorReviewCandidateSummary {
  return {
    version: 1,
    kind: 'adaptive',
    candidateId: candidate.id,
    title: `${candidate.labelCategory.replace(/_/g, ' ')} adaptive candidate`,
    summary: candidate.sourceSummary || candidate.failureOrSuccessReason,
    selectedLabel: candidate.labelCategory,
    acceptanceDimension: candidate.acceptanceDimension,
    privacyStatus: candidate.privacyStatus,
    reviewStatus: candidate.reviewStatus,
    promotable: isAdaptivePromotable(candidate),
    evidenceRefs: candidate.evidenceRefs.slice(0, MAX_QUEUE_REFS),
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

// Build the operator-facing review queue from the assembled reports. promotedCount /
// promotedReplayPassRate mirror the scorecard's promoted-replay gate so the operator
// can see progress toward unlocking trusted_operator.
export function buildAoiOperatorReviewQueue(params: {
  sessionPath: string;
  traceReport: AoiTracePromotionReport;
  adaptivePack: AoiAdaptiveAcceptancePack;
  now: number;
}): AoiOperatorReviewQueue {
  const { traceReport, adaptivePack } = params;
  const candidateCount = traceReport.candidateCount + adaptivePack.candidateCount;
  const promotedCount = traceReport.promotedDraftCount + adaptivePack.promotedCandidateCount;
  const candidates = [
    ...traceReport.candidates.map(summarizeTraceCandidate),
    ...adaptivePack.candidates.map(summarizeAdaptiveCandidate),
  ];
  return {
    version: 1,
    sessionPath: params.sessionPath,
    generatedAt: params.now,
    traceCandidateCount: traceReport.candidateCount,
    adaptiveCandidateCount: adaptivePack.candidateCount,
    promotedCount,
    promotedReplayPassRate: ratio(promotedCount, candidateCount),
    candidates,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function adaptiveStatusForAction(
  action: AoiOperatorReviewAction,
): AoiAdaptiveAcceptanceReviewState['status'] {
  if (action === 'promote') {
    return 'approved';
  }
  if (action === 'defer') {
    return 'deferred';
  }
  return 'rejected';
}

// Validate an operator review request against the live candidate set and produce the
// actor=user decision / review state to persist. Returns a structured error (never
// throws) for an unknown candidate, a missing reason, or a privacy-blocked promotion.
export function buildAoiOperatorPromotionReviewResult(params: {
  traceReport: AoiTracePromotionReport;
  adaptivePack: AoiAdaptiveAcceptancePack;
  request: AoiOperatorReviewRequest;
  now: number;
}): AoiOperatorReviewResult {
  const { traceReport, adaptivePack, request, now } = params;
  const { action } = request;
  if (action !== 'promote' && action !== 'defer' && action !== 'reject') {
    return {
      ok: false,
      code: 'invalid_action',
      error: 'action must be promote, defer, or reject.',
    };
  }
  const reason = clampReason(request.reason);
  // promote and reject must be justified (mirrors createAoiTracePromotionDecision).
  if ((action === 'promote' || action === 'reject') && !reason) {
    return {
      ok: false,
      code: 'reason_required',
      error: `A short reason is required to ${action} a candidate.`,
    };
  }

  if (request.kind === 'trace') {
    const candidate = traceReport.candidates.find((item) => item.id === request.candidateId);
    if (!candidate) {
      return { ok: false, code: 'candidate_not_found', error: 'Trace candidate not found.' };
    }
    if (action === 'promote' && !isTracePromotable(candidate)) {
      return {
        ok: false,
        code: 'privacy_blocked',
        error: 'Trace candidate is blocked by unresolved private data and cannot be promoted.',
      };
    }
    const decision = createAoiTracePromotionDecision({
      candidate,
      action,
      ...(action === 'promote'
        ? { acceptanceDimension: request.acceptanceDimension ?? candidate.acceptanceDimension }
        : {}),
      ...(reason ? { reason } : {}),
      actor: 'user',
      now,
    });
    return { ok: true, kind: 'trace', decision };
  }

  if (request.kind === 'adaptive') {
    const candidate = adaptivePack.candidates.find((item) => item.id === request.candidateId);
    if (!candidate) {
      return { ok: false, code: 'candidate_not_found', error: 'Adaptive candidate not found.' };
    }
    if (action === 'promote' && !isAdaptivePromotable(candidate)) {
      // A blocked candidate also covers the "no evidence refs" case: a candidate
      // with no evidence has a blocked replay draft, so it is never promotable.
      return {
        ok: false,
        code: 'privacy_blocked',
        error: 'Adaptive candidate is blocked (private data or missing replay draft).',
      };
    }
    const reviewState: AoiAdaptiveAcceptanceReviewState = {
      version: 1,
      candidateId: candidate.id,
      status: adaptiveStatusForAction(action),
      reviewedAt: now,
      evidenceRefs: candidate.evidenceRefs.slice(0, 12),
      ...(reason ? { reason } : {}),
      actor: 'user',
    };
    return { ok: true, kind: 'adaptive', reviewState };
  }

  return { ok: false, code: 'invalid_kind', error: 'kind must be trace or adaptive.' };
}
