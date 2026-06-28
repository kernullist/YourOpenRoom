import type {
  AoiOperatorReviewAction,
  AoiOperatorReviewCandidateSummary,
  AoiOperatorReviewQueue,
} from './aoiOperatorPromotionReview';

// Pure, browser-safe view model for the operator replay-promotion panel (roadmap
// item 1, step 4). It parses the /review-candidates response, derives the operator
// display state (progress toward the trusted_operator unlock + per-candidate action
// availability), and builds the /review-decision request body. Type-only imports from
// aoiOperatorPromotionReview are erased, so this stays out of the server bundle.

export type { AoiOperatorReviewAction } from './aoiOperatorPromotionReview';

export interface AoiReplayPromotionCandidateViewModel {
  kind: 'trace' | 'adaptive';
  candidateId: string;
  title: string;
  summary: string;
  selectedLabel: string;
  privacyStatus: string;
  reviewStatus: string;
  promotable: boolean;
  isPromoted: boolean;
  // The operator can still promote it (promotable and not already promoted).
  canPromote: boolean;
  statusLabel: string;
}

export interface AoiReplayPromotionViewModel {
  sessionPath: string;
  total: number;
  promotedCount: number;
  promotedReplayPassRate: number;
  // The promoted-replay gate is satisfied (every candidate promoted, at least one
  // candidate present). This is the precondition the scorecard needs for trusted_operator.
  unlockReady: boolean;
  remaining: number;
  progressLabel: string;
  candidates: AoiReplayPromotionCandidateViewModel[];
}

export interface AoiReviewDecisionBody {
  sessionPath: string;
  kind: 'trace' | 'adaptive';
  candidateId: string;
  action: AoiOperatorReviewAction;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseCandidate(value: unknown): AoiOperatorReviewCandidateSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  if (kind !== 'trace' && kind !== 'adaptive') {
    return null;
  }
  const candidateId = asString(value.candidateId);
  if (!candidateId) {
    return null;
  }
  return {
    version: 1,
    kind,
    candidateId,
    title: asString(value.title),
    summary: asString(value.summary),
    selectedLabel: asString(value.selectedLabel),
    acceptanceDimension: asString(value.acceptanceDimension),
    privacyStatus: asString(value.privacyStatus, 'needs_review'),
    reviewStatus: asString(value.reviewStatus, 'needs_review'),
    promotable: value.promotable === true,
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
      : [],
  };
}

// Defensive parse of the GET /review-candidates response ({ ok, sessionPath, queue }).
// Returns null on any shape mismatch so the panel can show an error state.
export function parseReviewQueueResponse(json: unknown): AoiOperatorReviewQueue | null {
  if (!isRecord(json) || json.ok !== true) {
    return null;
  }
  const queue = json.queue;
  if (!isRecord(queue)) {
    return null;
  }
  const candidates = Array.isArray(queue.candidates)
    ? queue.candidates
        .map(parseCandidate)
        .filter((candidate): candidate is AoiOperatorReviewCandidateSummary => candidate !== null)
    : [];
  return {
    version: 1,
    sessionPath: asString(queue.sessionPath),
    generatedAt: asNumber(queue.generatedAt),
    traceCandidateCount: asNumber(queue.traceCandidateCount),
    adaptiveCandidateCount: asNumber(queue.adaptiveCandidateCount),
    promotedCount: asNumber(queue.promotedCount),
    promotedReplayPassRate: asNumber(queue.promotedReplayPassRate),
    candidates,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function isPromotedStatus(reviewStatus: string): boolean {
  // Trace candidates report 'promoted'; adaptive candidates report 'approved'.
  return reviewStatus === 'promoted' || reviewStatus === 'approved';
}

function statusLabelFor(candidate: AoiOperatorReviewCandidateSummary): string {
  if (candidate.privacyStatus === 'blocked') {
    return 'Blocked (private data)';
  }
  if (isPromotedStatus(candidate.reviewStatus)) {
    return 'Promoted';
  }
  if (candidate.reviewStatus === 'deferred') {
    return 'Deferred';
  }
  if (candidate.reviewStatus === 'rejected') {
    return 'Rejected';
  }
  return 'Needs review';
}

function toCandidateViewModel(
  candidate: AoiOperatorReviewCandidateSummary,
): AoiReplayPromotionCandidateViewModel {
  const isPromoted = isPromotedStatus(candidate.reviewStatus);
  return {
    kind: candidate.kind,
    candidateId: candidate.candidateId,
    title: candidate.title,
    summary: candidate.summary,
    selectedLabel: candidate.selectedLabel,
    privacyStatus: candidate.privacyStatus,
    reviewStatus: candidate.reviewStatus,
    promotable: candidate.promotable,
    isPromoted,
    canPromote: candidate.promotable && !isPromoted,
    statusLabel: statusLabelFor(candidate),
  };
}

export function toReplayPromotionViewModel(
  queue: AoiOperatorReviewQueue,
): AoiReplayPromotionViewModel {
  const total = queue.traceCandidateCount + queue.adaptiveCandidateCount;
  const remaining = Math.max(0, total - queue.promotedCount);
  const unlockReady = total > 0 && queue.promotedReplayPassRate >= 1;
  const pct = Math.round(queue.promotedReplayPassRate * 100);
  const progressLabel =
    total <= 0
      ? 'No replay candidates yet. Label useful field decisions and export matching traces first.'
      : unlockReady
        ? `All ${total} candidate(s) promoted (${pct}%). The promoted-replay gate is satisfied.`
        : `${queue.promotedCount}/${total} candidate(s) promoted (${pct}%). Promote the rest to satisfy the gate.`;
  return {
    sessionPath: queue.sessionPath,
    total,
    promotedCount: queue.promotedCount,
    promotedReplayPassRate: queue.promotedReplayPassRate,
    unlockReady,
    remaining,
    progressLabel,
    candidates: queue.candidates.map(toCandidateViewModel),
  };
}

// Build the POST /review-decision body. The server FORCES actor=user; the client can
// only express kind/candidate/action/reason.
export function buildReviewDecisionBody(params: {
  sessionPath: string;
  kind: 'trace' | 'adaptive';
  candidateId: string;
  action: AoiOperatorReviewAction;
  reason?: string;
}): AoiReviewDecisionBody {
  const reason = (params.reason ?? '').replace(/\s+/g, ' ').trim();
  return {
    sessionPath: params.sessionPath,
    kind: params.kind,
    candidateId: params.candidateId,
    action: params.action,
    ...(reason ? { reason } : {}),
  };
}
