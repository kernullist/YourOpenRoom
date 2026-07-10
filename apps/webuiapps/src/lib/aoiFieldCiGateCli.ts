import {
  formatAoiFieldCiGateReport,
  runAoiFieldCiGate,
  type AoiFieldCiGateReport,
} from './aoiFieldCiGate';

// P5.1: the runnable CI entry for the Aoi field acceptance gate.
//
// The gate LOGIC (runAoiFieldCiGate) is pure and unit-tested; what was missing is the
// glue a CI pipeline actually invokes -- discover the changed files, run the gate, print
// the report, and exit non-zero when a REQUIRED gate fails so the pipeline blocks. This
// module is that orchestrator, with every side effect (git, stdout/stderr, the clock)
// injected so the decision logic is fully testable without a real process or repo.
//
// The thin real-process entry (aoiFieldCiGateCliEntry.ts) wires the real dependencies and
// calls process.exit; it is bundled to a standalone Node ESM file (no tsx in the tree):
//   pnpm field-ci:build  ->  dist-field-ci-gate/aoiFieldCiGate.js
//   pnpm field-ci -- --base origin/main

// Exit codes: 0 = pass or skipped (docs-only), 1 = a required gate failed, 2 = the run
// itself could not be performed (e.g. the git diff failed).
export const AOI_FIELD_CI_EXIT_OK = 0;
export const AOI_FIELD_CI_EXIT_GATE_FAILED = 1;
export const AOI_FIELD_CI_EXIT_RUN_ERROR = 2;

export interface AoiFieldCiGateCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  // Resolve the changed files for a base ref (injected so tests never touch git).
  getChangedFiles: (baseRef: string) => readonly string[];
  log: (message: string) => void;
  logError: (message: string) => void;
  now?: number;
}

// Parse `git diff --name-only` output into a clean, de-blanked file list.
export function parseAoiFieldCiChangedFiles(gitOutput: string): string[] {
  return gitOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// The gate blocks the pipeline only when it is REQUIRED and did not pass; a skipped
// (docs-only) or passing gate is a clean exit.
export function resolveAoiFieldCiGateExitCode(report: AoiFieldCiGateReport): number {
  return report.gateRequired && !report.passed
    ? AOI_FIELD_CI_EXIT_GATE_FAILED
    : AOI_FIELD_CI_EXIT_OK;
}

// Resolve the diff base ref from argv (--base=REF or --base REF) or the environment,
// defaulting to the previous commit so a bare invocation still does something sane.
export function resolveAoiFieldCiBaseRef(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base' && index + 1 < argv.length) {
      return argv[index + 1];
    }
    if (arg.startsWith('--base=')) {
      return arg.slice('--base='.length);
    }
  }
  return env.AOI_FIELD_CI_BASE ?? 'HEAD~1';
}

// Orchestrate one CI-gate run and RETURN the exit code (never calls process.exit). All
// I/O is injected, so this is the unit-testable heart of the CLI.
export function runAoiFieldCiGateCli(deps: AoiFieldCiGateCliDeps): number {
  const baseRef = resolveAoiFieldCiBaseRef(deps.argv, deps.env);
  let changedFiles: readonly string[];
  try {
    changedFiles = deps.getChangedFiles(baseRef);
  } catch (error) {
    deps.logError(
      `[aoi-field-ci] failed to resolve changed files from base '${baseRef}': ${String(error)}`,
    );
    return AOI_FIELD_CI_EXIT_RUN_ERROR;
  }

  const report = runAoiFieldCiGate({
    changedFiles,
    runAcceptancePack: true,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  deps.log(formatAoiFieldCiGateReport(report));

  const exitCode = resolveAoiFieldCiGateExitCode(report);
  if (exitCode !== AOI_FIELD_CI_EXIT_OK) {
    deps.logError(
      `[aoi-field-ci] field acceptance gate FAILED (${report.fieldGroundedAcceptance.failedScenarioCount} scenario(s)) -- see report above.`,
    );
  } else if (report.gateRequired) {
    deps.log('[aoi-field-ci] field acceptance gate passed.');
  } else {
    deps.log('[aoi-field-ci] field gate not required for these changes.');
  }
  return exitCode;
}
