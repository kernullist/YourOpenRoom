import {
  buildAoiFieldEvidenceManifest,
  formatAoiFieldEvidenceManifest,
} from './aoiFieldEvidenceManifest';
import {
  AOI_REAL_FIELD_EXIT_RUN_ERROR,
  runAoiRealFieldAcceptanceCli,
} from './aoiRealFieldAcceptanceCli';

async function main(): Promise<void> {
  let exitCode: number;
  try {
    exitCode = await runAoiRealFieldAcceptanceCli({
      argv: process.argv.slice(2),
      env: process.env,
      runPack: (options) => buildAoiFieldEvidenceManifest(options),
      formatReport: (report) => formatAoiFieldEvidenceManifest(report),
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-field-evidence] unexpected failure: ${String(error)}\n`);
    exitCode = AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }
  process.exit(exitCode);
}

void main();
