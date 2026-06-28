import {
  loadAoiAutonomyLevelPromotionGateState,
  loadAoiAutonomyPolicy,
  loadAoiFieldShadowRecordReport,
  loadAoiOperatorAdaptiveReviewStates,
  loadAoiOperatorFeedbackLabelActions,
  loadAoiOperatorTracePromotionDecisions,
  loadAoiOutcomeLearningSummary,
  saveAoiAutonomyLevelPromotionGateState,
  saveAoiAutonomyPolicy,
} from './aoiAutonomyStore';
import {
  evaluateAoiAutonomyLevelPromotion,
  resolveAoiAutonomyLevelPromotionConfig,
  type AoiAutonomyLevelPromotionConfig,
  type AoiAutonomyLevelPromotionDecision,
} from './aoiAutonomyLevelPromotion';
import {
  buildAoiOperatorFeedbackInbox,
  buildAoiOperatorFeedbackPromotionLabels,
} from './aoiOperatorFeedbackInbox';
import {
  buildAoiJarvisReadinessScorecard,
  type AoiJarvisReadinessScorecard,
} from './aoiJarvisReadinessScorecard';
import { loadAoiOperatorTraceExports } from './aoiOperatorTimeline';
import { buildAoiTracePromotionReport } from './aoiTracePromotion';
import { buildAoiAdaptiveAcceptancePack } from './aoiAdaptiveAcceptanceCuration';
import { recordServerAoiRunLedgerEvent } from './aoiRunLedgerServer';
import type { AoiRunLedgerEventType, AoiRunStatus } from './aoiRunLedger';

// Server-side runner for gated autonomy-level auto-promotion (roadmap 5b).
// Server-only (it imports the fs-backed store + ledger and reads process.env), so
// it must never be pulled into the client bundle. The pure decision lives in
// aoiAutonomyLevelPromotion; this module ties it to persistence + audit.

type RecordLedgerEvent = (params: {
  sessionsDir: string;
  sessionPath: string;
  type: AoiRunLedgerEventType;
  message: string;
  goalSummary: string;
  toolNames?: string[];
  status?: AoiRunStatus;
  now?: number;
}) => unknown;

export interface AoiAutonomyLevelPromotionRunOptions {
  scorecard: AoiJarvisReadinessScorecard;
  config: AoiAutonomyLevelPromotionConfig;
  now?: number;
  // Injectable so tests never touch the real ledger file.
  recordLedger?: RecordLedgerEvent;
}

// Evaluate + persist one promotion decision: advance the sustained-window gate
// state, and on a real change apply the new level (saveAoiAutonomyPolicy) and audit
// it. Gate-state is persisted only when enabled; policy + audit only when changed.
export function runAoiAutonomyLevelPromotion(
  sessionsDir: string,
  sessionPath: string,
  options: AoiAutonomyLevelPromotionRunOptions,
): AoiAutonomyLevelPromotionDecision {
  const now = options.now ?? Date.now();
  const policy = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
  const gateState = loadAoiAutonomyLevelPromotionGateState(sessionsDir, sessionPath);
  const decision = evaluateAoiAutonomyLevelPromotion({
    policy,
    scorecard: options.scorecard,
    gateState,
    config: options.config,
    now,
  });

  if (options.config.enabled) {
    saveAoiAutonomyLevelPromotionGateState(sessionsDir, sessionPath, decision.nextGateState);
  }

  if (decision.changed) {
    saveAoiAutonomyPolicy(sessionsDir, sessionPath, { ...policy, level: decision.nextLevel }, now);
    const recordLedger = options.recordLedger ?? recordServerAoiRunLedgerEvent;
    recordLedger({
      sessionsDir,
      sessionPath,
      type:
        decision.action === 'promote' ? 'autonomy_level_promoted' : 'autonomy_level_rolled_back',
      message: `Autonomy level ${decision.action === 'promote' ? 'promoted' : 'rolled back'} ${decision.previousLevel} -> ${decision.nextLevel}: ${decision.reason}`,
      goalSummary: `Aoi autonomy level ${decision.action}`,
      toolNames: ['autonomy_level'],
      status: 'completed',
      now,
    });
  }

  return decision;
}

// Assemble a readiness scorecard from the per-session inputs that are loadable on
// the server: field-shadow records, operator feedback labels, outcome learning,
// direct-chat opt-in, the trace-promotion / adaptive-acceptance CANDIDATE evidence
// assembled from real operator trace exports + promotion-eligible operator labels +
// field-shadow records, AND the operator-reviewed promotion decisions / review states
// persisted by the operator review pipeline (roadmap item 1).
//
// SAFETY (the promotion source must stay human-only): the promoted counts that gate
// trusted_operator (promotedDraftCount / promotedCandidateCount -> promotedReplayPassRate)
// derive ONLY from operator-authored promotion decisions / review states, loaded here
// from the actor-gated operator-promotion store and re-filtered to actor === 'user'.
// The autonomy loop has no path that authors a user-actor promotion (the store's append
// functions reject any non-user actor), so it CANNOT raise promotedReplayPassRate -- the
// structural barrier against a self-reinforcing autonomy-escalation loop. With no
// operator promotions the rate stays < 1 and trusted_operator remains unreachable; once
// the operator promotes the full candidate set, escalation is unlocked, still behind the
// 5b auto-promote env gate (OFF default, L4 cap, instant rollback, sustained window).
export function buildAoiAutonomyLevelPromotionScorecard(
  sessionsDir: string,
  sessionPath: string,
  now: number,
): AoiJarvisReadinessScorecard {
  const fieldShadowReport = loadAoiFieldShadowRecordReport(sessionsDir, sessionPath, now);
  const labelActions = loadAoiOperatorFeedbackLabelActions(sessionsDir, sessionPath);
  const feedbackInbox = buildAoiOperatorFeedbackInbox({
    sessionPath,
    fieldShadowReport,
    labelActions,
    now,
  });
  const outcomeLearning = loadAoiOutcomeLearningSummary(sessionsDir, sessionPath, now);
  const policy = loadAoiAutonomyPolicy(sessionsDir, sessionPath);

  // Candidate evidence from real session data, plus the operator-reviewed promotion
  // decisions / review states. Both are loaded from the actor-gated operator store
  // and re-filtered to actor === 'user' at this trust boundary (defense in depth on
  // top of the store's write-time enforcement), so only deliberate human promotions
  // can raise promotedReplayPassRate.
  const traceExports = loadAoiOperatorTraceExports(sessionsDir, sessionPath);
  const promotionLabels = buildAoiOperatorFeedbackPromotionLabels({
    sessionPath,
    labelActions,
    ...(fieldShadowReport?.records ? { records: fieldShadowReport.records } : {}),
  });
  const operatorTracePromotionDecisions = loadAoiOperatorTracePromotionDecisions(
    sessionsDir,
    sessionPath,
  ).filter((decision) => decision.actor === 'user');
  const operatorAdaptiveReviewStates = loadAoiOperatorAdaptiveReviewStates(
    sessionsDir,
    sessionPath,
  ).filter((state) => state.actor === 'user');
  const tracePromotionReport = buildAoiTracePromotionReport({
    sessionPath,
    traceExports,
    shadowLabels: promotionLabels,
    promotionDecisions: operatorTracePromotionDecisions,
    now,
  });
  const adaptiveAcceptancePack = buildAoiAdaptiveAcceptancePack({
    sessionPath,
    labelActions,
    traceExports,
    fieldShadowReport,
    reviewStates: operatorAdaptiveReviewStates,
    now,
  });

  return buildAoiJarvisReadinessScorecard({
    sessionPath,
    now,
    fieldShadowReport,
    feedbackInbox,
    outcomeLearning,
    tracePromotionReport,
    adaptiveAcceptancePack,
    directChatOptInEnabled: policy.proactiveBriefing.directChatHookOptIn ?? null,
  });
}

// Wakeup entry point: run gated promotion only when opted in via env. Returns null
// (no I/O beyond the disabled check) when auto-promotion is off, which is the
// default. Best-effort: never throws into the wakeup.
export function maybeRunAoiAutonomyLevelPromotion(params: {
  sessionsDir: string;
  sessionPath: string;
  env?: Record<string, string | undefined>;
  now?: number;
}): AoiAutonomyLevelPromotionDecision | null {
  const env = params.env ?? process.env;
  const config = resolveAoiAutonomyLevelPromotionConfig(env);
  if (!config.enabled) {
    return null;
  }
  const now = params.now ?? Date.now();
  try {
    const scorecard = buildAoiAutonomyLevelPromotionScorecard(
      params.sessionsDir,
      params.sessionPath,
      now,
    );
    return runAoiAutonomyLevelPromotion(params.sessionsDir, params.sessionPath, {
      scorecard,
      config,
      now,
    });
  } catch {
    return null;
  }
}
