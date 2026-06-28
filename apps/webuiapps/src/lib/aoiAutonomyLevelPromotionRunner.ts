import {
  loadAoiAutonomyLevelPromotionGateState,
  loadAoiAutonomyPolicy,
  loadAoiFieldShadowRecordReport,
  loadAoiOperatorFeedbackLabelActions,
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
// direct-chat opt-in, AND the trace-promotion / adaptive-acceptance CANDIDATE
// evidence assembled from real operator trace exports + promotion-eligible operator
// labels + field-shadow records.
//
// SAFETY (deliberate, do not "fix" by synthesizing promotions): the promoted
// counts that gate trusted_operator (promotedDraftCount / promotedCandidateCount ->
// promotedReplayPassRate) derive ONLY from explicit operator promotion decisions /
// review states, and this assembler passes NONE (there is no runtime store that
// persists operator-reviewed promotions yet). So promotedReplayPassRate stays < 1
// and trusted_operator remains UNREACHABLE by auto-promotion. Candidates are now
// visible to the scorecard, but escalation still waits for a genuine operator-review
// promotion pipeline -- synthesizing promotions here would be a self-reinforcing
// autonomy-escalation loop. Fail-safe by design (instant to revoke, conservative to
// grant); rollback + sustained-window + audit remain fully live.
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

  // Candidate evidence from real session data. No promotion decisions / review
  // states are passed, so the reports carry candidates but zero promotions (see
  // the SAFETY note above).
  const traceExports = loadAoiOperatorTraceExports(sessionsDir, sessionPath);
  const promotionLabels = buildAoiOperatorFeedbackPromotionLabels({
    sessionPath,
    labelActions,
    ...(fieldShadowReport?.records ? { records: fieldShadowReport.records } : {}),
  });
  const tracePromotionReport = buildAoiTracePromotionReport({
    sessionPath,
    traceExports,
    shadowLabels: promotionLabels,
    now,
  });
  const adaptiveAcceptancePack = buildAoiAdaptiveAcceptancePack({
    sessionPath,
    labelActions,
    traceExports,
    fieldShadowReport,
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
