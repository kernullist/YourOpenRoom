import { loadAoiAutonomyPolicy } from './aoiAutonomyStore';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCalibrationTuning,
  loadAoiProactiveBriefFeedback,
  loadAoiProactiveBriefFieldMetrics,
} from './aoiProactiveBriefStore';
import { buildAoiProactiveTrendAdvisorReadiness } from './aoiProactiveTrendAdvisor';
import type { AoiProactiveTrendAdvisorReadiness } from './aoiAutonomyTypes';

// P5.4: assemble the trend-advisor readiness accrual (sample count -> directChatReady +
// blockers) from the real server stores so the trust on-ramp is observable.
//
// The trust ladder that unlocks direct-chat can't accrue if readiness is invisible; this
// makes it visible. Strictly READ-ONLY: it loads existing stores and computes the pure
// readiness -- it never writes, mutates, or changes any gate. Each loader is best-effort
// (a missing store -> the readiness's own defaults) so a fresh session still returns a
// well-formed "measuring" readiness rather than throwing.

function tryLoad<T>(loader: () => T, fallback: T): T {
  try {
    return loader();
  } catch {
    return fallback;
  }
}

export function loadAoiProactiveTrendReadinessFromStores(
  sessionsDir: string,
  params: { sessionPath: string; now: number },
): AoiProactiveTrendAdvisorReadiness {
  const { sessionPath, now } = params;
  return buildAoiProactiveTrendAdvisorReadiness({
    sessionPath,
    now,
    policy: tryLoad(() => loadAoiAutonomyPolicy(sessionsDir, sessionPath), null),
    profile: tryLoad(() => loadAoiInterestProfile(sessionsDir, sessionPath, now), null),
    feedback: tryLoad(() => loadAoiProactiveBriefFeedback(sessionsDir, sessionPath), []),
    fieldMetrics: tryLoad(
      () => loadAoiProactiveBriefFieldMetrics(sessionsDir, sessionPath, now),
      null,
    ),
    calibrationTuning: tryLoad(
      () => loadAoiProactiveBriefCalibrationTuning(sessionsDir, sessionPath, now),
      null,
    ),
  });
}
