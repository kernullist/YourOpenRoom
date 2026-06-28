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
import { buildAoiOperatorFeedbackInbox } from './aoiOperatorFeedbackInbox';
import {
  buildAoiJarvisReadinessScorecard,
  type AoiJarvisReadinessScorecard,
} from './aoiJarvisReadinessScorecard';
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

// Assemble a readiness scorecard from the per-session inputs that are cheaply
// loadable on the server (field-shadow records, operator feedback labels, outcome
// learning, direct-chat opt-in). This is a faithful but CONSERVATIVE scorecard:
// reaching trusted_operator (the promote trigger) additionally requires
// trace-promotion / adaptive-acceptance candidate evidence, which is not assembled
// here yet -- so auto-promotion holds until that pipeline is wired in, while the
// rollback + sustained-window + audit machinery is fully live. Fail-safe by design
// (instant to revoke, conservative to grant).
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
  return buildAoiJarvisReadinessScorecard({
    sessionPath,
    now,
    fieldShadowReport,
    feedbackInbox,
    outcomeLearning,
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
