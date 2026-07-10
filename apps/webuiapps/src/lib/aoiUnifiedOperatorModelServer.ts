import {
  loadAoiEnvironmentSourceRegistry,
  loadAoiFollowThroughLearningSummary,
} from './aoiAutonomyStore';
import { loadAoiMissionState } from './aoiAutonomyMission';
import { loadServerAoiMemories } from './aoiMemoryServerWriter';
import { loadAoiInterestProfile } from './aoiProactiveBriefStore';
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
// memories, interest profile, follow-through learning, mission, and the environment source
// registry. Inputs that need extra live context (the context router needs a user message;
// the readiness scorecard needs its own multi-loader assembly; capability-broker decisions
// are a distinct decision type) are left undefined -- the builder treats every input as
// optional, so the snapshot is simply built from the sections that have real backing data.

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
  return buildAoiUnifiedOperatorSnapshot({
    sessionPath,
    now,
    ...(params.currentUserMessage ? { currentUserMessage: params.currentUserMessage } : {}),
    memories: loadServerAoiMemories(sessionsDir),
    interestProfile: loadAoiInterestProfile(sessionsDir, sessionPath, now),
    followThroughLearning: loadAoiFollowThroughLearningSummary(sessionsDir, sessionPath, now),
    mission: loadAoiMissionState(sessionsDir, sessionPath),
    sourceRegistry: loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath, now),
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
