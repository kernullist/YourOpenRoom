// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AOI_NON_VOICE_VALIDATION_COMMANDS,
  AOI_NON_VOICE_VALIDATION_EXIT_FAILED,
  AOI_NON_VOICE_VALIDATION_EXIT_PASSED,
  AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR,
  runAoiNonVoiceValidationCli,
  type AoiNonVoiceValidationCommand,
} from '../aoiNonVoiceValidationCli';
import { loadAoiNonVoiceValidationManifest } from '../aoiNonVoiceValidationManifest';

const SESSION_PATH = 'aoi/live';
const CODE_FINGERPRINT = 'b'.repeat(64);
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-validation-cli-')));
  tempRoots.push(root);
  fs.mkdirSync(join(root, 'sessions', 'aoi', 'live'), { recursive: true });
  fs.mkdirSync(join(root, 'workspace'), { recursive: true });
  return root;
}

function makeArgs(root: string): string[] {
  return [
    '--sessions-dir',
    join(root, 'sessions'),
    '--session-path',
    SESSION_PATH,
    '--workspace-root',
    join(root, 'workspace'),
  ];
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi non-voice broad validation CLI', () => {
  it('fails closed before execution when explicit provenance is missing', () => {
    const runCommand = vi.fn((_command: AoiNonVoiceValidationCommand) => ({ passed: true }));
    expect(runAoiNonVoiceValidationCli({ argv: [], runCommand })).toBe(
      AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR,
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs only the fixed command matrix and persists code-bound passing evidence', () => {
    const root = makeRoot();
    let tick = 1_800_000_000_000;
    const runCommand = vi.fn((_command: AoiNonVoiceValidationCommand) => ({ passed: true }));
    const recordWorkspaceValidation = vi.fn(() => ({}) as never);
    const logs: string[] = [];
    const exitCode = runAoiNonVoiceValidationCli({
      argv: makeArgs(root),
      runCommand,
      resolveCodeFingerprint: () => CODE_FINGERPRINT,
      clock: () => tick++,
      log: (message) => logs.push(message),
      recordWorkspaceValidation,
    });

    expect(exitCode).toBe(AOI_NON_VOICE_VALIDATION_EXIT_PASSED);
    expect(runCommand.mock.calls.map(([command]) => command.id)).toEqual(
      AOI_NON_VOICE_VALIDATION_COMMANDS.map((command) => command.id),
    );
    expect(
      AOI_NON_VOICE_VALIDATION_COMMANDS.find((command) => command.id === 'claim_cli_build'),
    ).toEqual({
      id: 'claim_cli_build',
      args: ['--filter', '@openroom/webuiapps', 'nonvoice-claim:build'],
      evidenceRefs: ['command:pnpm --filter @openroom/webuiapps nonvoice-claim:build'],
    });
    const loaded = loadAoiNonVoiceValidationManifest(join(root, 'sessions'), SESSION_PATH);
    expect(loaded.broadValidation).toMatchObject({
      passed: true,
      commandCount: AOI_NON_VOICE_VALIDATION_COMMANDS.length,
      codeFingerprint: CODE_FINGERPRINT,
    });
    expect(loaded.supervisorRecoveryVerified).toBe(true);
    expect(loaded.loopLockRecoveryVerified).toBe(true);
    expect(recordWorkspaceValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsDir: join(root, 'sessions'),
        sessionPath: SESSION_PATH,
        signal: expect.objectContaining({
          result: 'passed',
          command: `nonvoice-validation:${AOI_NON_VOICE_VALIDATION_COMMANDS.length}/${AOI_NON_VOICE_VALIDATION_COMMANDS.length}`,
          touchedFileScopes: [],
          evidenceRefs: expect.arrayContaining([`validation-code:${CODE_FINGERPRINT}`]),
        }),
      }),
    );
    expect(logs.at(-1)).toContain('PASSED');
  });

  it('records a failed broad gate without claiming runtime recovery', () => {
    const root = makeRoot();
    const recordWorkspaceValidation = vi.fn(() => ({}) as never);
    const exitCode = runAoiNonVoiceValidationCli({
      argv: makeArgs(root),
      runCommand: (command) => ({ passed: command.id !== 'runtime_recovery_tests' }),
      resolveCodeFingerprint: () => CODE_FINGERPRINT,
      clock: () => 1_800_000_000_000,
      log: () => undefined,
      logError: () => undefined,
      recordWorkspaceValidation,
    });

    expect(exitCode).toBe(AOI_NON_VOICE_VALIDATION_EXIT_FAILED);
    const loaded = loadAoiNonVoiceValidationManifest(join(root, 'sessions'), SESSION_PATH);
    expect(loaded.broadValidation?.passed).toBe(false);
    expect(loaded.supervisorRecoveryVerified).toBe(false);
    expect(loaded.loopLockRecoveryVerified).toBe(false);
    expect(recordWorkspaceValidation).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.objectContaining({ result: 'failed' }) }),
    );
  });

  it('refuses to write evidence when claim-relevant code drifts during the run', () => {
    const root = makeRoot();
    const fingerprints = [CODE_FINGERPRINT, 'c'.repeat(64)];
    const exitCode = runAoiNonVoiceValidationCli({
      argv: makeArgs(root),
      runCommand: () => ({ passed: true }),
      resolveCodeFingerprint: () => fingerprints.shift() ?? null,
      clock: () => 1_800_000_000_000,
      log: () => undefined,
      logError: () => undefined,
      recordWorkspaceValidation: vi.fn(() => ({}) as never),
    });

    expect(exitCode).toBe(AOI_NON_VOICE_VALIDATION_EXIT_RUN_ERROR);
    expect(
      loadAoiNonVoiceValidationManifest(join(root, 'sessions'), SESSION_PATH).manifest,
    ).toBeNull();
  });
});
