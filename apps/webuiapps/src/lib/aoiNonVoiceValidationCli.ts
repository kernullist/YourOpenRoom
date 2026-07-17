import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS,
  saveAoiNonVoiceValidationManifest,
  type AoiNonVoiceValidationCommandResult,
  type AoiNonVoiceValidationManifest,
} from './aoiNonVoiceValidationManifest';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import { resolveAoiWorkspaceCodeFingerprint } from './aoiWorkspaceCodeFingerprint';
import { recordAoiValidationSignal } from './aoiWorkspaceSignals';

export const AOI_NON_VOICE_VALIDATION_EXIT_PASSED = 0;
export const AOI_NON_VOICE_VALIDATION_EXIT_FAILED = 1;
export const AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR = 2;

export interface AoiNonVoiceValidationCommand {
  id: (typeof AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS)[number];
  args: readonly string[];
  evidenceRefs: readonly string[];
}

export interface AoiNonVoiceValidationCommandRunResult {
  passed: boolean;
  detail?: string;
}

export const AOI_NON_VOICE_VALIDATION_COMMANDS: readonly AoiNonVoiceValidationCommand[] = [
  {
    id: 'full_test_suite',
    args: ['--filter', '@openroom/webuiapps', 'test'],
    evidenceRefs: [
      'command:pnpm --filter @openroom/webuiapps test',
      'test:aoiDaemonSupervisor:crash-restart',
      'test:aoiDaemonServer:stale-loop-lock-recovery',
    ],
  },
  {
    id: 'runtime_recovery_tests',
    args: [
      '--filter',
      '@openroom/webuiapps',
      'exec',
      'vitest',
      'run',
      'src/lib/__tests__/aoiDaemonSupervisor.test.ts',
      'src/lib/__tests__/aoiAutonomyLoopLock.test.ts',
      'src/lib/__tests__/aoiDaemonServer.test.ts',
    ],
    evidenceRefs: [
      'command:pnpm --filter @openroom/webuiapps exec vitest run runtime-recovery-suites',
      'test:aoiDaemonSupervisor:crash-restart',
      'test:aoiDaemonServer:stale-loop-lock-recovery',
    ],
  },
  {
    id: 'typecheck',
    args: ['--filter', '@openroom/webuiapps', 'typecheck'],
    evidenceRefs: ['command:pnpm --filter @openroom/webuiapps typecheck'],
  },
  {
    id: 'daemon_build',
    args: ['--filter', '@openroom/webuiapps', 'daemon:build'],
    evidenceRefs: ['command:pnpm --filter @openroom/webuiapps daemon:build'],
  },
  {
    id: 'claim_cli_build',
    args: ['--filter', '@openroom/webuiapps', 'nonvoice-claim:build'],
    evidenceRefs: ['command:pnpm --filter @openroom/webuiapps nonvoice-claim:build'],
  },
  {
    id: 'client_build',
    args: ['--filter', '@openroom/webuiapps', 'build:test'],
    evidenceRefs: ['command:pnpm --filter @openroom/webuiapps build:test'],
  },
  {
    id: 'field_ci_gate',
    args: ['--filter', '@openroom/webuiapps', 'field-ci:gate'],
    evidenceRefs: ['command:pnpm --filter @openroom/webuiapps field-ci:gate'],
  },
  {
    id: 'operator_scorecard_playwright',
    args: [
      'exec',
      'playwright',
      'test',
      'e2e/aoi-non-voice-scorecard.spec.ts',
      '--project=chromium',
      '--reporter=line',
    ],
    evidenceRefs: [
      'command:pnpm exec playwright test e2e/aoi-non-voice-scorecard.spec.ts --project=chromium',
    ],
  },
];

export interface AoiNonVoiceValidationCliDeps {
  argv: readonly string[];
  log?: (message: string) => void;
  logError?: (message: string) => void;
  clock?: () => number;
  runCommand?: (
    command: AoiNonVoiceValidationCommand,
    workspaceRoot: string,
  ) => AoiNonVoiceValidationCommandRunResult;
  resolveCodeFingerprint?: (workspaceRoot: string) => string | null;
  saveManifest?: (params: {
    sessionsDir: string;
    manifest: AoiNonVoiceValidationManifest;
  }) => AoiNonVoiceValidationManifest;
  recordWorkspaceValidation?: typeof recordAoiValidationSignal;
}

function option(argv: readonly string[], name: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === name && index + 1 < argv.length) {
      return argv[index + 1]?.trim() ?? '';
    }
    const prefix = `${name}=`;
    if (argument.startsWith(prefix)) {
      return argument.slice(prefix.length).trim();
    }
  }
  return '';
}

function runFixedPnpmCommand(
  command: AoiNonVoiceValidationCommand,
  workspaceRoot: string,
): AoiNonVoiceValidationCommandRunResult {
  const windows = process.platform === 'win32';
  let executable = 'pnpm';
  let args = [...command.args];
  if (windows) {
    const pnpmLauncher = resolve(
      dirname(process.execPath),
      'node_modules',
      'corepack',
      'dist',
      'pnpm.js',
    );
    if (!existsSync(pnpmLauncher)) {
      return { passed: false, detail: 'The Node Corepack pnpm launcher is unavailable.' };
    }
    executable = process.execPath;
    args = [pnpmLauncher, ...command.args];
  }
  const result = spawnSync(executable, args, {
    cwd: workspaceRoot,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  return {
    passed: !result.error && result.status === 0,
    detail: result.error?.message,
  };
}

export function runAoiNonVoiceValidationCli(deps: AoiNonVoiceValidationCliDeps): number {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const clock = deps.clock ?? Date.now;
  const runCommand = deps.runCommand ?? runFixedPnpmCommand;
  const resolveCodeFingerprint = deps.resolveCodeFingerprint ?? resolveAoiWorkspaceCodeFingerprint;
  const saveManifest = deps.saveManifest ?? saveAoiNonVoiceValidationManifest;
  const recordWorkspaceValidation = deps.recordWorkspaceValidation ?? recordAoiValidationSignal;
  const sessionsDir = option(deps.argv, '--sessions-dir');
  const sessionPath = normalizeAoiAutonomySessionPath(option(deps.argv, '--session-path'));
  const workspaceRoot = option(deps.argv, '--workspace-root');
  if (!sessionsDir || !sessionPath || !workspaceRoot) {
    logError(
      '[aoi-non-voice-validation] Required: --sessions-dir <path> --session-path <path> --workspace-root <path>',
    );
    return AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR;
  }
  const initialCodeFingerprint = resolveCodeFingerprint(workspaceRoot);
  if (!initialCodeFingerprint || !/^[a-f0-9]{64}$/u.test(initialCodeFingerprint)) {
    logError('[aoi-non-voice-validation] Could not resolve the current code fingerprint.');
    return AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR;
  }

  const commands: AoiNonVoiceValidationCommandResult[] = [];
  for (const command of AOI_NON_VOICE_VALIDATION_COMMANDS) {
    log(`[aoi-non-voice-validation] RUN ${command.id}`);
    let result: AoiNonVoiceValidationCommandRunResult;
    try {
      result = runCommand(command, workspaceRoot);
    } catch (error) {
      result = { passed: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const completedAt = clock();
    commands.push({
      id: command.id,
      passed: result.passed,
      completedAt,
      evidenceRefs: [...command.evidenceRefs],
    });
    if (result.passed) {
      log(`[aoi-non-voice-validation] PASS ${command.id}`);
    } else {
      const detail = result.detail ? ` (${result.detail.replace(/\s+/gu, ' ').slice(0, 240)})` : '';
      logError(`[aoi-non-voice-validation] FAIL ${command.id}${detail}`);
    }
  }

  const finalCodeFingerprint = resolveCodeFingerprint(workspaceRoot);
  if (!finalCodeFingerprint || finalCodeFingerprint !== initialCodeFingerprint) {
    logError(
      '[aoi-non-voice-validation] Code fingerprint changed during validation; no manifest was written.',
    );
    return AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR;
  }
  const runtimeRecoveryPassed =
    commands.find((command) => command.id === 'runtime_recovery_tests')?.passed === true;
  const generatedAt = Math.max(clock(), ...commands.map((command) => command.completedAt));
  const manifest: AoiNonVoiceValidationManifest = {
    version: 1,
    sessionPath,
    generatedAt,
    codeFingerprint: finalCodeFingerprint,
    commands,
    supervisorRecoveryVerified: runtimeRecoveryPassed,
    loopLockRecoveryVerified: runtimeRecoveryPassed,
    evidenceRefs: [
      `validation-code:${finalCodeFingerprint}`,
      'validation:voice-excluded',
      'validation:session-correct',
    ],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  const passedCommandCount = commands.filter((command) => command.passed).length;
  const passed = passedCommandCount === commands.length;
  try {
    recordWorkspaceValidation({
      sessionsDir,
      sessionPath,
      signal: {
        result: passed ? 'passed' : 'failed',
        command: `nonvoice-validation:${passedCommandCount}/${commands.length}`,
        completedAt: generatedAt,
        touchedFileScopes: [],
        evidenceRefs: [
          `validation-code:${finalCodeFingerprint}`,
          ...commands.flatMap((command) => command.evidenceRefs),
        ],
      },
      now: generatedAt,
    });
    saveManifest({ sessionsDir, manifest });
  } catch (error) {
    logError(
      `[aoi-non-voice-validation] Could not persist validation evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
    return AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR;
  }
  log(
    `[aoi-non-voice-validation] ${passed ? 'PASSED' : 'FAILED'} session=${sessionPath} commands=${passedCommandCount}/${commands.length} code=${finalCodeFingerprint}`,
  );
  return passed ? AOI_NON_VOICE_VALIDATION_EXIT_PASSED : AOI_NON_VOICE_VALIDATION_EXIT_FAILED;
}
