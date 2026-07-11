// P2.3 / P5.5 shared prerequisite: compute the Jarvis autonomy governor SERVER-SIDE.
//
// buildAoiJarvisAutonomyGovernor is a pure, browser-safe builder, but until now it was only
// ever assembled in the client (ChatPanel). That left two server paths unable to consult the
// real governor: the trend-card delivery gate (P5.5) and the bounded autonomous-execute
// readiness check (P2.3), both of which fail closed on `trusted_operator` readiness without it.
// This assembles the governor's inputs from the real on-disk stores -- the SAME readiness
// pattern the P5.3 unified-operator snapshot already uses (a scorecard backed by the real
// closed-loop metrics) plus operator health + source-freshness contracts.
//
// Strictly READ-ONLY + deterministic: it loads existing stores and returns a display_only
// governor decision. It never writes, mutates, executes, or gains authority -- it only makes
// the same graded decision the client already makes, on the server.
import { loadAoiAutonomyPolicy, loadAoiEnvironmentSourceRegistry } from './aoiAutonomyStore';
import { loadAoiOutcomeSignalRecords, loadAoiProposalDecisions } from './aoiAutonomyStore';
import { buildAoiClosedLoopMetrics } from './aoiClosedLoopMetrics';
import {
  buildAoiJarvisAutonomyGovernor,
  type AoiJarvisAutonomyGovernorDecision,
} from './aoiJarvisAutonomyGovernor';
import {
  buildAoiJarvisReadinessScorecard,
  type AoiJarvisReadinessScorecard,
} from './aoiJarvisReadinessScorecard';
import { buildAoiOperatorHealthState } from './aoiOperatorHealthServer';
import { buildAoiSourceFreshnessContracts } from './aoiSourceFreshnessContract';

// The readiness half, exposed on its own so the P2.3 autonomous-execute loop can source the
// trusted_operator gate WITHOUT assembling the whole governor. Readiness is backed by the REAL
// closed-loop metrics (decisions + executed outcomes), exactly as the P5.3 server snapshot does.
export function buildAoiServerJarvisReadinessScorecard(params: {
  sessionsDir: string;
  sessionPath: string;
  now: number;
}): AoiJarvisReadinessScorecard {
  const { sessionsDir, sessionPath, now } = params;
  const policy = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
  const closedLoopMetrics = buildAoiClosedLoopMetrics({
    sessionPath,
    decisions: loadAoiProposalDecisions(sessionsDir, sessionPath),
    outcomes: loadAoiOutcomeSignalRecords(sessionsDir, sessionPath),
    now,
  });
  return buildAoiJarvisReadinessScorecard({
    sessionPath,
    now,
    closedLoopMetrics,
    directChatOptInEnabled: policy.proactiveBriefing.directChatHookOptIn ?? null,
  });
}

export function buildAoiServerJarvisAutonomyGovernor(params: {
  sessionsDir: string;
  sessionPath: string;
  configFile: string;
  now: number;
}): AoiJarvisAutonomyGovernorDecision {
  const { sessionsDir, sessionPath, configFile, now } = params;
  const policy = loadAoiAutonomyPolicy(sessionsDir, sessionPath);
  const jarvisReadinessScorecard = buildAoiServerJarvisReadinessScorecard({
    sessionsDir,
    sessionPath,
    now,
  });
  const operatorHealth = buildAoiOperatorHealthState({ sessionsDir, sessionPath, configFile, now });
  const sourceFreshnessContracts = buildAoiSourceFreshnessContracts({
    sourceRegistry: loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath, now),
    now,
  });
  return buildAoiJarvisAutonomyGovernor({
    sessionPath,
    now,
    policy,
    operatorHealth,
    jarvisReadinessScorecard,
    sourceFreshnessContracts,
    activeProposals: [],
    blockedProposals: [],
  });
}
