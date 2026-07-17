import {
  AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR,
  runAoiControlledRealCognitionEvidenceCli,
} from './aoiControlledRealCognitionEvidenceCli';

let exitCode = AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR;
try {
  exitCode = await runAoiControlledRealCognitionEvidenceCli({
    argv: process.argv.slice(2),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    logError: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
} catch (error) {
  process.stderr.write(`[aoi-controlled-cognition] Unexpected failure: ${String(error)}\n`);
}
process.exit(exitCode);
