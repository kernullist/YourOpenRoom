import {
  loadAoiEnvironmentSourceRegistry,
  loadAoiFollowThroughLearningSummary,
  loadAoiOutcomeSignalRecords,
  loadAoiProposalDecisions,
} from './aoiAutonomyStore';
import { loadAoiMissionState } from './aoiAutonomyMission';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import { loadAoiInterestProfile } from './aoiProactiveBriefStore';
import { buildAoiClosedLoopMetrics } from './aoiClosedLoopMetrics';
import { buildAoiJarvisReadinessScorecard } from './aoiJarvisReadinessScorecard';
import {
  buildAoiUnifiedOperatorSnapshot,
  summarizeAoiUnifiedOperatorSnapshot,
  type AoiUnifiedOperatorSnapshot,
  type AoiUnifiedOperatorSnapshotSummary,
} from './aoiUnifiedOperatorModel';

// P5.3: build the (previously dark) unified operator model from REAL server stores so it
// can actually be surfaced to the operator.
//
// aoiUnifiedOperatorModel is a pure, browser-safe builder (it takes pre-loaded inputs and
// never touches disk); this server-only companion assembles those inputs from the real
// on-disk stores and hands them to it. Strictly read-only: it loads existing stores and
// produces a snapshot -- it never writes, mutates, or gains authority. The snapshot and
// its operator summary are display_only by construction.
//
// Inputs are assembled from the stores with clean (sessionsDir, sessionPath, now) loaders:
// memories, interest profile, follow-through learning, mission, the environment source
// registry, and a readiness scorecard backed by the real closed-loop metrics (decisions +
// outcomes). The only inputs left undefined are those needing extra live context (the
// context router needs a user message; capability-broker decisions are a distinct decision
// type) -- the builder treats every input as optional, so the snapshot is built from the
// sections that have real backing data.

export interface AoiUnifiedOperatorSnapshotFromStoresParams {
  sessionPath: string;
  now: number;
  currentUserMessage?: string;
}

export function loadAoiUnifiedOperatorSnapshotFromStores(
  sessionsDir: string,
  params: AoiUnifiedOperatorSnapshotFromStoresParams,
): AoiUnifiedOperatorSnapshot {
  const { sessionPath, now } = params;
  // Readiness is backed by the REAL closed-loop metrics: measured per-capability
  // precision / action-success / interruption / recall over the actual decision +
  // outcome logs (the outcome log is now populated by real executed outcomes -- P5.2).
  // buildAoiJarvisReadinessScorecard treats every other input as optional, so a scorecard
  // built from closedLoopMetrics alone is a real (if partial) readiness signal.
  const closedLoopMetrics = buildAoiClosedLoopMetrics({
    sessionPath,
    decisions: loadAoiProposalDecisions(sessionsDir, sessionPath),
    outcomes: loadAoiOutcomeSignalRecords(sessionsDir, sessionPath),
    now,
  });
  const readinessScorecard = buildAoiJarvisReadinessScorecard({
    sessionPath,
    now,
    closedLoopMetrics,
  });
  return buildAoiUnifiedOperatorSnapshot({
    sessionPath,
    now,
    ...(params.currentUserMessage ? { currentUserMessage: params.currentUserMessage } : {}),
    memories: loadServerAoiMemories(sessionsDir).filter(
      (memory) => memory.sessionPath === sessionPath,
    ),
    interestProfile: loadAoiInterestProfile(sessionsDir, sessionPath, now),
    followThroughLearning: loadAoiFollowThroughLearningSummary(sessionsDir, sessionPath, now),
    mission: loadAoiMissionState(sessionsDir, sessionPath),
    sourceRegistry: loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath, now),
    readinessScorecard,
  });
}

// The operator-facing summary is display_only and already condensed for display -- the
// safe thing to serve over a route.
export function loadAoiUnifiedOperatorSummaryFromStores(
  sessionsDir: string,
  params: AoiUnifiedOperatorSnapshotFromStoresParams,
): AoiUnifiedOperatorSnapshotSummary {
  return summarizeAoiUnifiedOperatorSnapshot(
    loadAoiUnifiedOperatorSnapshotFromStores(sessionsDir, params),
  );
}
