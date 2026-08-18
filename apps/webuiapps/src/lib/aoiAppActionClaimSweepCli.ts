// CLI wrapper for the offline app-action claim sweep. I/O is injected so the
// argument handling and exit codes are testable without touching a disk or a
// model.

import {
  formatAoiClaimSweepReport,
  sweepAoiAppActionClaims,
  type AoiClaimSweepJudge,
  type AoiClaimSweepLedgerRun,
  type AoiClaimSweepReport,
} from './aoiAppActionClaimSweep';

export const AOI_CLAIM_SWEEP_EXIT_CLEAN = 0;
// Gaps found. Non-zero on purpose: this is meant to be usable as a check, and a
// gap is something to go fix.
export const AOI_CLAIM_SWEEP_EXIT_GAPS_FOUND = 1;
export const AOI_CLAIM_SWEEP_EXIT_RUN_ERROR = 2;

export interface AoiClaimSweepCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  loadRuns: (ledgerPath: string) => Promise<readonly AoiClaimSweepLedgerRun[]>;
  judge?: AoiClaimSweepJudge;
  log: (message: string) => void;
  logError: (message: string) => void;
}

function resolveOption(argv: readonly string[], name: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === name && index + 1 < argv.length) {
      return argv[index + 1].trim();
    }
    const prefix = `${name}=`;
    if (argument.startsWith(prefix)) {
      return argument.slice(prefix.length).trim();
    }
  }
  return '';
}

export function resolveAoiClaimSweepLedgerPath(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string {
  const explicit = resolveOption(argv, '--ledger');
  if (explicit) {
    return explicit;
  }
  return (env.AOI_CLAIM_SWEEP_LEDGER ?? '').trim();
}

export async function runAoiClaimSweepCli(deps: AoiClaimSweepCliDeps): Promise<number> {
  const { argv, env, log, logError } = deps;
  if (argv.includes('--help') || argv.includes('-h')) {
    log(
      [
        'aoi-claim-sweep -- find turns where Aoi reported an app action that never ran.',
        '',
        'Usage: aoi-claim-sweep --ledger <path to aoi-run-ledger/runs.json> [--json]',
        '',
        '  --ledger <path>  Run ledger to read. Defaults to $AOI_CLAIM_SWEEP_LEDGER.',
        '  --json           Emit the raw report instead of the readable summary.',
        '',
        'A judge can sort the pattern_gap residue, but only when one is supplied',
        'programmatically (runAoiClaimSweepCli deps.judge). This binary ships none,',
        'so --judge fails here rather than pretending to have judged anything.',
        '',
        'Exit codes: 0 clean, 1 gaps found, 2 run error.',
      ].join('\n'),
    );
    return AOI_CLAIM_SWEEP_EXIT_CLEAN;
  }

  const ledgerPath = resolveAoiClaimSweepLedgerPath(argv, env);
  if (!ledgerPath) {
    logError(
      'aoi-claim-sweep: no ledger given. Pass --ledger <path> or set AOI_CLAIM_SWEEP_LEDGER.',
    );
    return AOI_CLAIM_SWEEP_EXIT_RUN_ERROR;
  }

  let report: AoiClaimSweepReport;
  try {
    const runs = await deps.loadRuns(ledgerPath);
    const wantsJudge = argv.includes('--judge');
    if (wantsJudge && !deps.judge) {
      logError('aoi-claim-sweep: --judge was requested but no judge is configured.');
      return AOI_CLAIM_SWEEP_EXIT_RUN_ERROR;
    }
    report = await sweepAoiAppActionClaims(runs, {
      judge: wantsJudge ? deps.judge : undefined,
    });
  } catch (error) {
    logError(`aoi-claim-sweep: failed to sweep ${ledgerPath}: ${String(error)}`);
    return AOI_CLAIM_SWEEP_EXIT_RUN_ERROR;
  }

  log(
    argv.includes('--json') ? JSON.stringify(report, null, 2) : formatAoiClaimSweepReport(report),
  );
  return report.counts.pattern_gap > 0
    ? AOI_CLAIM_SWEEP_EXIT_GAPS_FOUND
    : AOI_CLAIM_SWEEP_EXIT_CLEAN;
}
