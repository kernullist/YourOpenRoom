// P5.1 (real-ledger grounding): the runnable entry for the REAL field-operations
// acceptance pack.
//
// The CI gate (aoiFieldCiGateCli) runs the SYNTHETIC field-grounded pack, which is
// correct for CI -- a fresh checkout has no accumulated session data. Grounding
// acceptance in the REAL ledger is a different job: an operator runs it against their
// actual sessionsDir (~/.openroom/sessions) so the readiness verdict reflects real
// run-ledger entries, real executed outcomes (populated by P5.2), and real field events
// -- not fixtures. runAoiRealFieldOperationsAcceptancePack already reads that on-disk
// data; what was missing is a way to invoke it.
//
// This module is the injectable orchestrator (no process.exit, no disk of its own -- the
// pack run and formatting are injected), so its decision logic is unit-testable. The thin
// real-process entry (aoiRealFieldAcceptanceCliEntry.ts) wires the real pack + formatter +
// process.exit and is bundled to a standalone Node ESM file:
//   pnpm real-field:build  ->  dist-real-field-acceptance/aoiRealFieldAcceptance.js
//   pnpm real-field -- --sessions-dir /path/to/.openroom/sessions

export const AOI_REAL_FIELD_EXIT_READY = 0;
export const AOI_REAL_FIELD_EXIT_NOT_READY = 1;
export const AOI_REAL_FIELD_EXIT_RUN_ERROR = 2;

// The pack report shape the CLI actually reads. Kept minimal so the core does not couple
// to the full report type; the entry passes the real report (which satisfies this).
export interface AoiRealFieldAcceptanceCliReport {
  passed: boolean;
}

export interface AoiRealFieldAcceptanceCliDeps<TReport extends AoiRealFieldAcceptanceCliReport> {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  // Run the real acceptance pack against a sessionsDir (injected so tests never touch disk).
  runPack: (sessionsDir: string) => Promise<TReport>;
  formatReport: (report: TReport) => string;
  log: (message: string) => void;
  logError: (message: string) => void;
}

// Resolve the sessionsDir from argv (--sessions-dir=DIR or --sessions-dir DIR) or the
// environment (AOI_SESSIONS_DIR, then AOI_DAEMON_SESSIONS_DIR). Empty string when none was
// given -- there is no safe default for a real-ledger location, so the caller must be
// explicit.
export function resolveAoiRealFieldSessionsDir(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sessions-dir' && index + 1 < argv.length) {
      return argv[index + 1].trim();
    }
    if (arg.startsWith('--sessions-dir=')) {
      return arg.slice('--sessions-dir='.length).trim();
    }
  }
  return (env.AOI_SESSIONS_DIR ?? env.AOI_DAEMON_SESSIONS_DIR ?? '').trim();
}

// Orchestrate one real-field acceptance run and RETURN the exit code (never calls
// process.exit). 0 = real-field ready, 1 = ran but not ready, 2 = could not run.
export async function runAoiRealFieldAcceptanceCli<TReport extends AoiRealFieldAcceptanceCliReport>(
  deps: AoiRealFieldAcceptanceCliDeps<TReport>,
): Promise<number> {
  const sessionsDir = resolveAoiRealFieldSessionsDir(deps.argv, deps.env);
  if (!sessionsDir) {
    deps.logError(
      '[aoi-real-field] no sessions dir given -- pass --sessions-dir <dir> or set AOI_SESSIONS_DIR.',
    );
    return AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }

  let report: TReport;
  try {
    report = await deps.runPack(sessionsDir);
  } catch (error) {
    deps.logError(`[aoi-real-field] acceptance run failed for '${sessionsDir}': ${String(error)}`);
    return AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }

  deps.log(deps.formatReport(report));
  if (report.passed) {
    deps.log('[aoi-real-field] real-field operations acceptance READY.');
    return AOI_REAL_FIELD_EXIT_READY;
  }
  deps.logError('[aoi-real-field] real-field operations acceptance NOT READY -- see report above.');
  return AOI_REAL_FIELD_EXIT_NOT_READY;
}
