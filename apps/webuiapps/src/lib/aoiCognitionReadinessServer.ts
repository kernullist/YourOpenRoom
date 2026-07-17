// SA5.2 (server): assemble the cognition-readiness scorecard from the real
// on-disk stores -- the same read-only assembly pattern as
// buildAoiServerJarvisReadinessScorecard. Strictly display-only: it loads
// existing stores and returns the pure scorecard; it never writes or acts.
import {
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiEnvironmentSourceRegistry,
} from './aoiAutonomyStore';
import {
  buildAoiCognitionReadinessScorecard,
  type AoiCognitionReadinessScorecard,
} from './aoiCognitionReadiness';
import {
  countAoiCurrentSituationHistory,
  loadAoiCurrentSituation,
} from './aoiCurrentSituationModel';
import { loadAoiIntentState } from './aoiIntentInference';
import { checkAoiEnvironmentSourceOperation } from './aoiAutonomyPolicy';

export function buildAoiServerCognitionReadinessScorecard(params: {
  sessionsDir: string;
  sessionPath: string;
  now: number;
}): AoiCognitionReadinessScorecard {
  const { sessionsDir, sessionPath, now } = params;
  const registry = loadAoiEnvironmentSourceRegistry(sessionsDir, sessionPath, now);
  return buildAoiCognitionReadinessScorecard({
    sessionPath,
    now,
    situation: loadAoiCurrentSituation(sessionsDir, sessionPath),
    situationSampleCount: countAoiCurrentSituationHistory(sessionsDir, sessionPath),
    intentState: loadAoiIntentState(sessionsDir, sessionPath),
    proposals: [
      ...loadAoiActiveProposals(sessionsDir, sessionPath),
      ...loadAoiArchivedProposals(sessionsDir, sessionPath),
    ],
    sourceCoverage: registry.sources.map((source) => {
      const policyCheck = checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: source.id,
        operation: 'read_metadata',
      });
      return {
        sourceId: source.id,
        label: source.label,
        enabled: source.enabled,
        consented: policyCheck.allowed,
        policyReasons: policyCheck.reasons,
      };
    }),
  });
}
