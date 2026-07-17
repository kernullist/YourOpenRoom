import {
  AOI_CONTROLLED_REAL_EXIT_RUN_ERROR,
  runAoiControlledRealFileEvidenceCli,
} from './aoiControlledRealFileEvidenceCli';

let exitCode = AOI_CONTROLLED_REAL_EXIT_RUN_ERROR;
try {
  exitCode = runAoiControlledRealFileEvidenceCli({
    argv: process.argv.slice(2),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    logError: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
} catch (error) {
  process.stderr.write(`[aoi-controlled-real] Unexpected failure: ${String(error)}\n`);
}
process.exit(exitCode);
