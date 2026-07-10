import { execFileSync } from 'node:child_process';
import {
  parseAoiFieldCiChangedFiles,
  runAoiFieldCiGateCli,
  AOI_FIELD_CI_EXIT_RUN_ERROR,
} from './aoiFieldCiGateCli';

// P5.1: thin real-process entry for the Aoi field CI gate. It only wires the real
// dependencies (git, stdout/stderr, the clock) into the injectable, unit-tested
// orchestrator and translates the returned code into process.exit -- there is no
// decision logic here, so it stays outside the coverage-critical path.
//
// Bundled to a standalone Node ESM file (see vite.field-ci-gate.config.ts):
//   pnpm field-ci:build  ->  dist-field-ci-gate/aoiFieldCiGate.js
//   pnpm field-ci -- --base origin/main

function main(): void {
  let exitCode: number;
  try {
    exitCode = runAoiFieldCiGateCli({
      argv: process.argv.slice(2),
      env: process.env,
      getChangedFiles: (baseRef) => {
        const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
          encoding: 'utf8',
        });
        return parseAoiFieldCiChangedFiles(output);
      },
      log: (message) => {
        // ASCII-only stdout for CI logs.
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
      now: Date.now(),
    });
  } catch (error) {
    process.stderr.write(`[aoi-field-ci] unexpected failure: ${String(error)}\n`);
    exitCode = AOI_FIELD_CI_EXIT_RUN_ERROR;
  }
  process.exit(exitCode);
}

main();
