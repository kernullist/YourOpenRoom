import {
  AOI_TURN_EVAL_EXIT_ERROR,
  runAoiTurnUnderstandingEvalCli,
} from './aoiTurnUnderstandingEvalCli';

async function main(): Promise<void> {
  let exitCode = AOI_TURN_EVAL_EXIT_ERROR;
  try {
    exitCode = await runAoiTurnUnderstandingEvalCli({
      argv: process.argv.slice(2),
      env: process.env,
      fetchImpl: fetch,
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-turn-eval] unexpected failure: ${String(error)}\n`);
  }
  process.exit(exitCode);
}

void main();
