import { AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR, runAoiNonVoiceClaimCli } from './aoiNonVoiceClaimCli';
import { formatAoiNonVoiceJarvisScorecard } from './aoiNonVoiceJarvisScorecard';
import { loadAoiNonVoiceJarvisScorecardFromStores } from './aoiNonVoiceJarvisScorecardServer';
import { resolveAoiWorkspaceCodeFingerprint } from './aoiWorkspaceCodeFingerprint';
import { loadAoiDaemonHealthSnapshot } from './aoiDaemonHealthClient';

async function main(): Promise<void> {
  let exitCode = AOI_NON_VOICE_CLAIM_EXIT_RUN_ERROR;
  const argv = process.argv.slice(2);
  const formatIndex = argv.indexOf('--format');
  const outputFormat =
    formatIndex >= 0 && formatIndex + 1 < argv.length ? argv[formatIndex + 1] : 'text';
  try {
    exitCode = await runAoiNonVoiceClaimCli({
      argv,
      env: process.env,
      runScorecard: async (options) =>
        loadAoiNonVoiceJarvisScorecardFromStores({
          sessionsDir: options.sessionsDir,
          sessionPath: options.sessionPath,
          evidenceClass: options.evidenceClass,
          configFile: options.configFile,
          daemonHealth: await loadAoiDaemonHealthSnapshot(options.daemonHealthUrl),
          currentCodeFingerprint: resolveAoiWorkspaceCodeFingerprint(options.workspaceRoot),
        }),
      formatReport: (report) =>
        outputFormat === 'json'
          ? JSON.stringify(report, null, 2)
          : formatAoiNonVoiceJarvisScorecard(report),
      log: (message) => {
        process.stdout.write(`${message}\n`);
      },
      logError: (message) => {
        process.stderr.write(`${message}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(`[aoi-non-voice-claim] unexpected failure: ${String(error)}\n`);
  }
  process.exit(exitCode);
}

void main();
