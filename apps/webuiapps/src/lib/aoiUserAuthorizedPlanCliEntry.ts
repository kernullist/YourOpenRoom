import { authorAoiUserAuthorizedPlan } from './aoiUserAuthorizedPlan';
import {
  AOI_USER_AUTHORIZED_PLAN_EXIT_ERROR,
  runAoiUserAuthorizedPlanCli,
} from './aoiUserAuthorizedPlanCli';

async function main(): Promise<void> {
  let exitCode = AOI_USER_AUTHORIZED_PLAN_EXIT_ERROR;
  try {
    exitCode = await runAoiUserAuthorizedPlanCli({
      argv: process.argv.slice(2),
      env: process.env,
      authorPlan: authorAoiUserAuthorizedPlan,
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-user-authorized-plan] unexpected failure: ${String(error)}\n`);
  }
  process.exit(exitCode);
}

void main();
