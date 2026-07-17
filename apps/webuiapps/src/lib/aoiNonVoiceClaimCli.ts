import type { AoiFieldEvidenceClass } from './aoiFieldEvidenceManifest';

export const AOI_NON_VOICE_CLAIM_EXIT_READY = 0;
export const AOI_NON_VOICE_CLAIM_EXIT_NOT_READY = 1;
export const AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR = 2;

export interface AoiNonVoiceClaimCliReport {
  claimEligible: boolean;
  score: number;
}

export interface AoiNonVoiceClaimCliRunOptions {
  sessionsDir: string;
  sessionPath: string;
  evidenceClass: AoiFieldEvidenceClass;
  configFile: string;
  workspaceRoot: string;
  daemonHealthUrl: string;
}

export interface AoiNonVoiceClaimCliDeps<TReport extends AoiNonVoiceClaimCliReport> {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  runScorecard: (options: AoiNonVoiceClaimCliRunOptions) => Promise<TReport> | TReport;
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
    const argument = argv[index];
    if (argument === optionName && index + 1 < argv.length) {
      return argv[index + 1].trim();
    }
    const prefix = `${optionName}=`;
    if (argument.startsWith(prefix)) {
      return argument.slice(prefix.length).trim();
    }
  }
  return environmentValues.map((value) => value?.trim() ?? '').find(Boolean) ?? '';
}

export function resolveAoiNonVoiceClaimCliOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AoiNonVoiceClaimCliRunOptions | null {
  const sessionsDir = resolveStringOption(argv, '--sessions-dir', [
    env.AOI_SESSIONS_DIR,
    env.AOI_DAEMON_SESSIONS_DIR,
  ]);
  const sessionPath = resolveStringOption(argv, '--session-path', [
    env.AOI_NON_VOICE_SESSION_PATH,
    env.AOI_SESSION_PATH,
  ]);
  const evidenceClassValue = resolveStringOption(argv, '--evidence-class', [
    env.AOI_FIELD_EVIDENCE_CLASS,
  ]);
  const evidenceClass: AoiFieldEvidenceClass | '' =
    evidenceClassValue === 'synthetic' ||
    evidenceClassValue === 'controlled_real' ||
    evidenceClassValue === 'live_field'
      ? evidenceClassValue
      : '';
  const configFile = resolveStringOption(argv, '--config-file', [
    env.AOI_CONFIG_FILE,
    env.AOI_DAEMON_CONFIG_FILE,
  ]);
  const workspaceRoot = resolveStringOption(argv, '--workspace-root', [env.AOI_WORKSPACE_ROOT]);
  const daemonHealthUrl = resolveStringOption(argv, '--daemon-health-url', [
    env.AOI_DAEMON_HEALTH_URL,
  ]);
  if (!sessionsDir || !sessionPath || !evidenceClass || !configFile || !workspaceRoot) {
    return null;
  }
  return {
    sessionsDir,
    sessionPath,
    evidenceClass,
    configFile,
    workspaceRoot,
    daemonHealthUrl,
  };
}

export async function runAoiNonVoiceClaimCli<TReport extends AoiNonVoiceClaimCliReport>(
  deps: AoiNonVoiceClaimCliDeps<TReport>,
): Promise<number> {
  const options = resolveAoiNonVoiceClaimCliOptions(deps.argv, deps.env);
  if (!options) {
    deps.logError(
      '[aoi-non-voice-claim] sessions dir, session path, evidence class, config file, and workspace root are required.',
    );
    return AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR;
  }
  let report: TReport;
  try {
    report = await deps.runScorecard(options);
  } catch (error) {
    deps.logError(
      `[aoi-non-voice-claim] scorecard failed for session '${options.sessionPath}': ${String(error)}`,
    );
    return AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR;
  }
  deps.log(deps.formatReport(report));
  if (report.claimEligible && report.score > 90) {
    deps.log('[aoi-non-voice-claim] score above 90 and every hard gate passed.');
    return AOI_NON_VOICE_CLAIM_EXIT_READY;
  }
  deps.logError('[aoi-non-voice-claim] NOT READY; score or hard-gate evidence is insufficient.');
  return AOI_NON_VOICE_CLAIM_EXIT_NOT_READY;
}
