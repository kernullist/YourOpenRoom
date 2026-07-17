import {
  AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR,
  runAoiNonVoiceValidationCli,
} from './aoiNonVoiceValidationCli';

let exitCode = AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR;
try {
  exitCode = runAoiNonVoiceValidationCli({
    argv: process.argv.slice(2),
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
    logError: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
} catch (error) {
  process.stderr.write(`[aoi-non-voice-validation] Unexpected failure: ${String(error)}\n`);
}
process.exit(exitCode);
