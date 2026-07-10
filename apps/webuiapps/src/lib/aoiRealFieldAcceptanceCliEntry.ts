import {
  formatAoiRealFieldOperationsAcceptanceReport,
  runAoiRealFieldOperationsAcceptancePack,
} from './aoiRealFieldOperationsAcceptancePack';
import {
  AOI_REAL_FIELD_EXIT_RUN_ERROR,
  runAoiRealFieldAcceptanceCli,
} from './aoiRealFieldAcceptanceCli';

// P5.1: thin real-process entry for the real-ledger field acceptance run. It wires the
// real pack + formatter + process.exit into the injectable, unit-tested orchestrator --
// no decision logic here.
//
// Bundled to a standalone Node ESM file (see vite.real-field-acceptance.config.ts):
//   pnpm real-field:build  ->  dist-real-field-acceptance/aoiRealFieldAcceptance.js
//   pnpm real-field -- --sessions-dir /path/to/.openroom/sessions

async function main(): Promise<void> {
  let exitCode: number;
  try {
    exitCode = await runAoiRealFieldAcceptanceCli({
      argv: process.argv.slice(2),
      env: process.env,
      runPack: (sessionsDir) => runAoiRealFieldOperationsAcceptancePack({ sessionsDir }),
      formatReport: (report) => formatAoiRealFieldOperationsAcceptanceReport(report),
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-real-field] unexpected failure: ${String(error)}\n`);
    exitCode = AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }
  process.exit(exitCode);
}

void main();
