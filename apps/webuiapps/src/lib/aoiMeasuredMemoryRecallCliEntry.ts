import {
  AOI_MEASURED_RECALL_EXIT_ERROR,
  measureAoiMemoryRecall,
  runAoiMeasuredMemoryRecallCli,
} from './aoiMeasuredMemoryRecallCli';

async function main(): Promise<void> {
  let exitCode = AOI_MEASURED_RECALL_EXIT_ERROR;
  try {
    exitCode = await runAoiMeasuredMemoryRecallCli({
      argv: process.argv.slice(2),
      env: process.env,
      runMeasurement: measureAoiMemoryRecall,
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-measured-recall] unexpected failure: ${String(error)}\n`);
  }
  process.exit(exitCode);
}

void main();
