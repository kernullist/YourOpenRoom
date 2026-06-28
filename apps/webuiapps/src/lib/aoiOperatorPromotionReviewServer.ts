import {
  appendAoiOperatorAdaptiveReviewState,
  appendAoiOperatorTracePromotionDecision,
  loadAoiFieldShadowRecordReport,
  loadAoiOperatorAdaptiveReviewStates,
  loadAoiOperatorFeedbackLabelActions,
  loadAoiOperatorTracePromotionDecisions,
  normalizeAoiAutonomySessionPath,
} from './aoiAutonomyStore';
import { loadAoiOperatorTraceExports } from './aoiOperatorTimeline';
import { buildAoiOperatorFeedbackPromotionLabels } from './aoiOperatorFeedbackInbox';
import { buildAoiTracePromotionReport, type AoiTracePromotionReport } from './aoiTracePromotion';
import {
  buildAoiAdaptiveAcceptancePack,
  type AoiAdaptiveAcceptancePack,
} from './aoiAdaptiveAcceptanceCuration';
import {
  buildAoiOperatorPromotionReviewResult,
  buildAoiOperatorReviewQueue,
  type AoiOperatorReviewQueue,
  type AoiOperatorReviewRequest,
  type AoiOperatorReviewResult,
} from './aoiOperatorPromotionReview';

// Server-only glue for the operator-review -> persisted-promotion pipeline (roadmap
// item 1, step 3). It loads the live candidate evidence + the operator-authored
// decisions, mirrors the level-promotion scorecard assembler's report build EXACTLY
// (so candidate ids line up), then persists an operator review through the actor-gated
// store. Server-only: it imports the fs-backed store + timeline loaders, so it must
// never reach the client bundle.

// Mirror buildAoiAutonomyLevelPromotionScorecard's report assembly so the candidate
// ids the operator reviews are identical to the ids the scorecard scores.
function loadAoiOperatorReviewReports(
  sessionsDir: string,
  sessionPath: string,
  now: number,
): { traceReport: AoiTracePromotionReport; adaptivePack: AoiAdaptiveAcceptancePack } {
  const fieldShadowReport = loadAoiFieldShadowRecordReport(sessionsDir, sessionPath, now);
  const labelActions = loadAoiOperatorFeedbackLabelActions(sessionsDir, sessionPath);
  const traceExports = loadAoiOperatorTraceExports(sessionsDir, sessionPath);
  const promotionLabels = buildAoiOperatorFeedbackPromotionLabels({
    sessionPath,
    labelActions,
    ...(fieldShadowReport?.records ? { records: fieldShadowReport.records } : {}),
  });
  const promotionDecisions = loadAoiOperatorTracePromotionDecisions(
    sessionsDir,
    sessionPath,
  ).filter((decision) => decision.actor === 'user');
  const reviewStates = loadAoiOperatorAdaptiveReviewStates(sessionsDir, sessionPath).filter(
    (state) => state.actor === 'user',
  );
  const traceReport = buildAoiTracePromotionReport({
    sessionPath,
    traceExports,
    shadowLabels: promotionLabels,
    promotionDecisions,
    now,
  });
  const adaptivePack = buildAoiAdaptiveAcceptancePack({
    sessionPath,
    labelActions,
    traceExports,
    fieldShadowReport,
    reviewStates,
    now,
  });
  return { traceReport, adaptivePack };
}

export function loadAoiOperatorReviewQueue(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiOperatorReviewQueue {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const { traceReport, adaptivePack } = loadAoiOperatorReviewReports(
    sessionsDir,
    normalizedSessionPath,
    now,
  );
  return buildAoiOperatorReviewQueue({
    sessionPath: normalizedSessionPath,
    traceReport,
    adaptivePack,
    now,
  });
}

export interface AoiOperatorPromotionReviewOutcome {
  result: AoiOperatorReviewResult;
  queue: AoiOperatorReviewQueue;
}

// Apply one operator review: validate against the live candidate set, and on success
// persist the actor=user decision / review state through the actor-gated store, then
// return the reloaded queue. The store rejects any non-user actor, so this human
// review is the only thing that can ever create a promotion.
export function applyAoiOperatorPromotionReview(
  sessionsDir: string,
  sessionPath: string,
  request: AoiOperatorReviewRequest,
  now = Date.now(),
): AoiOperatorPromotionReviewOutcome {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const { traceReport, adaptivePack } = loadAoiOperatorReviewReports(
    sessionsDir,
    normalizedSessionPath,
    now,
  );
  const result = buildAoiOperatorPromotionReviewResult({
    traceReport,
    adaptivePack,
    request,
    now,
  });
  if (result.ok) {
    if (result.kind === 'trace') {
      appendAoiOperatorTracePromotionDecision(sessionsDir, normalizedSessionPath, result.decision);
    } else {
      appendAoiOperatorAdaptiveReviewState(sessionsDir, normalizedSessionPath, result.reviewState);
    }
  }
  const queue = loadAoiOperatorReviewQueue(sessionsDir, normalizedSessionPath, now);
  return { result, queue };
}
