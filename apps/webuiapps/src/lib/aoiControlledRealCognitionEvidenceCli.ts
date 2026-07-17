import { runAoiControlledRealCognitionHarness } from './aoiControlledRealCognitionHarness';
import { saveAoiControlledRealCognitionEvidence } from './aoiControlledRealCognitionEvidence';
import { resolveAoiWorkspaceCodeFingerprint } from './aoiWorkspaceCodeFingerprint';

export const AOI_CONTROLLED_COGNITION_EXIT_PASSED = 0;
export const AOI_CONTROLLED_COGNITION_EXIT_FAILED = 1;
export const AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR = 2;

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) {
    return '';
  }
  return argv[index + 1]?.trim() ?? '';
}

export async function runAoiControlledRealCognitionEvidenceCli(params: {
  argv: readonly string[];
  log?: (message: string) => void;
  logError?: (message: string) => void;
  now?: number;
}): Promise<number> {
  const log = params.log ?? console.log;
  const logError = params.logError ?? console.error;
  const sessionsDir = option(params.argv, '--sessions-dir');
  const sessionPath = option(params.argv, '--session-path');
  const workspaceRoot = option(params.argv, '--workspace-root');
  if (!sessionsDir || !sessionPath || !workspaceRoot) {
    logError(
      '[aoi-controlled-cognition] Required: --sessions-dir <path> --session-path <path> --workspace-root <path>',
    );
    return AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR;
  }
  const codeFingerprint = resolveAoiWorkspaceCodeFingerprint(workspaceRoot);
  if (!codeFingerprint) {
    logError('[aoi-controlled-cognition] Could not resolve the current code fingerprint.');
    return AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR;
  }
  try {
    const now = params.now ?? Date.now();
    const report = await runAoiControlledRealCognitionHarness(now);
    if (!report.passed) {
      logError(
        `[aoi-controlled-cognition] FAILED ${report.passedScenarioCount}/${report.scenarioCount} scenarios.`,
      );
      return AOI_CONTROLLED_COGNITION_EXIT_FAILED;
    }
    const record = saveAoiControlledRealCognitionEvidence({
      sessionsDir,
      sessionPath,
      codeFingerprint,
      report,
      now,
    });
    log(
      `[aoi-controlled-cognition] PASSED session=${record.sessionPath} scenarios=${report.passedScenarioCount}/${report.scenarioCount} cognition=${report.scenarios.find((scenario) => scenario.id === 'consented_grounded_situation')?.cognitionScore ?? 0} behavior=${report.behaviorFingerprint} code=${record.codeFingerprint}`,
    );
    return AOI_CONTROLLED_COGNITION_EXIT_PASSED;
  } catch (error) {
    logError(
      `[aoi-controlled-cognition] Run failed: ${error instanceof Error ? error.message : error}`,
    );
    return AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR;
  }
}
