import type { AoiFieldEvidenceClass } from './aoiFieldEvidenceManifest';

export const AOI_REAL_FIELD_EXIT_READY = 0;
export const AOI_REAL_FIELD_EXIT_NOT_READY = 1;
export const AOI_REAL_FIELD_EXIT_RUN_ERROR = 2;

export interface AoiRealFieldAcceptanceCliReport {
  passed: boolean;
}

export interface AoiRealFieldAcceptanceCliRunOptions {
  sessionsDir: string;
  sessionPath: string;
  evidenceClass: AoiFieldEvidenceClass;
}

export interface AoiRealFieldAcceptanceCliDeps<TReport extends AoiRealFieldAcceptanceCliReport> {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  runPack: (options: AoiRealFieldAcceptanceCliRunOptions) => Promise<TReport> | TReport;
  formatReport: (report: TReport) => string;
  log: (message: string) => void;
  logError: (message: string) => void;
}

function resolveStringOption(
  argv: readonly string[],
  optionName: string,
  environmentValues: readonly (string | undefined)[],
): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === optionName && index + 1 < argv.length) {
      return argv[index + 1].trim();
    }
    const prefix = `${optionName}=`;
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return environmentValues.map((value) => value?.trim() ?? '').find(Boolean) ?? '';
}

export function resolveAoiRealFieldSessionsDir(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string {
  return resolveStringOption(argv, '--sessions-dir', [
    env.AOI_SESSIONS_DIR,
    env.AOI_DAEMON_SESSIONS_DIR,
  ]);
}

export function resolveAoiRealFieldSessionPath(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): string {
  return resolveStringOption(argv, '--session-path', [
    env.AOI_REAL_FIELD_SESSION_PATH,
    env.AOI_SESSION_PATH,
  ]);
}

export function resolveAoiRealFieldEvidenceClass(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AoiFieldEvidenceClass | '' {
  const value = resolveStringOption(argv, '--evidence-class', [env.AOI_FIELD_EVIDENCE_CLASS]);
  if (value === 'synthetic' || value === 'controlled_real' || value === 'live_field') {
    return value;
  }
  return '';
}

export async function runAoiRealFieldAcceptanceCli<TReport extends AoiRealFieldAcceptanceCliReport>(
  deps: AoiRealFieldAcceptanceCliDeps<TReport>,
): Promise<number> {
  const sessionsDir = resolveAoiRealFieldSessionsDir(deps.argv, deps.env);
  const sessionPath = resolveAoiRealFieldSessionPath(deps.argv, deps.env);
  const evidenceClass = resolveAoiRealFieldEvidenceClass(deps.argv, deps.env);
  if (!sessionsDir) {
    deps.logError(
      '[aoi-field-evidence] no sessions dir given; pass --sessions-dir <dir> or set AOI_SESSIONS_DIR.',
    );
    return AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }
  if (!sessionPath) {
    deps.logError(
      '[aoi-field-evidence] no session path given; pass --session-path <path> or set AOI_REAL_FIELD_SESSION_PATH.',
    );
    return AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }
  if (!evidenceClass) {
    deps.logError(
      '[aoi-field-evidence] invalid evidence class; pass --evidence-class synthetic, controlled_real, or live_field.',
    );
    return AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }

  let report: TReport;
  try {
    report = await deps.runPack({ sessionsDir, sessionPath, evidenceClass });
  } catch (error) {
    deps.logError(
      `[aoi-field-evidence] read-only scan failed for session '${sessionPath}': ${String(error)}`,
    );
    return AOI_REAL_FIELD_EXIT_RUN_ERROR;
  }

  deps.log(deps.formatReport(report));
  if (report.passed) {
    deps.log('[aoi-field-evidence] field evidence READY.');
    return AOI_REAL_FIELD_EXIT_READY;
  }
  deps.logError('[aoi-field-evidence] field evidence NOT READY; see report above.');
  return AOI_REAL_FIELD_EXIT_NOT_READY;
}
