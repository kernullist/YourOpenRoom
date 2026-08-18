import { readFile } from 'node:fs/promises';

import { AOI_CLAIM_SWEEP_EXIT_RUN_ERROR, runAoiClaimSweepCli } from './aoiAppActionClaimSweepCli';
import type { AoiClaimSweepLedgerRun } from './aoiAppActionClaimSweep';

async function loadRuns(ledgerPath: string): Promise<readonly AoiClaimSweepLedgerRun[]> {
  const raw = await readFile(ledgerPath, 'utf-8');
  const parsed = JSON.parse(raw) as { runs?: unknown } | unknown[];
  // Accept the ledger file as written, or a bare array of runs.
  const runs = Array.isArray(parsed) ? parsed : ((parsed as { runs?: unknown }).runs ?? []);
  if (!Array.isArray(runs)) {
    throw new Error('ledger contained no runs array');
  }
  return runs as AoiClaimSweepLedgerRun[];
}

async function main(): Promise<void> {
  let exitCode = AOI_CLAIM_SWEEP_EXIT_RUN_ERROR;
  try {
    exitCode = await runAoiClaimSweepCli({
      argv: process.argv.slice(2),
      env: process.env,
      loadRuns,
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-claim-sweep] unexpected failure: ${String(error)}\n`);
  }
  process.exit(exitCode);
}

void main();
