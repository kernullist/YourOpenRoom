// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS,
  loadAoiNonVoiceValidationManifest,
  normalizeAoiNonVoiceValidationManifest,
  resolveAoiNonVoiceValidationManifestPath,
  saveAoiNonVoiceValidationManifest,
  type AoiNonVoiceValidationManifest,
} from '../aoiNonVoiceValidationManifest';

const SESSION_PATH = 'aoi/live';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-non-voice-validation-'));
  tempRoots.push(root);
  return root;
}

function makeManifest(): AoiNonVoiceValidationManifest {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    generatedAt: NOW + 100,
    codeFingerprint: 'a'.repeat(64),
    commands: AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS.map((id, index) => ({
      id,
      passed: true,
      completedAt: NOW + index,
      evidenceRefs: [`command:${index + 1}`],
    })),
    supervisorRecoveryVerified: true,
    loopLockRecoveryVerified: true,
    evidenceRefs: ['validation:complete'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi non-voice validation manifest', () => {
  it('loads a session-correct complete validation matrix and recovery proof', () => {
    const root = makeTempRoot();
    const filePath = resolveAoiNonVoiceValidationManifestPath(root, SESSION_PATH);
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(makeManifest()), 'utf8');

    const result = loadAoiNonVoiceValidationManifest(root, SESSION_PATH);
    expect(result.manifest?.sessionPath).toBe(SESSION_PATH);
    expect(result.broadValidation).toMatchObject({
      passed: true,
      commandCount: AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS.length,
      codeFingerprint: 'a'.repeat(64),
    });
    expect(result.supervisorRecoveryVerified).toBe(true);
    expect(result.loopLockRecoveryVerified).toBe(true);
    expect(result.manifest?.commands.map((command) => command.id)).toContain('claim_cli_build');
  });

  it('returns an empty fail-closed result for missing or corrupt data', () => {
    const root = makeTempRoot();
    expect(loadAoiNonVoiceValidationManifest(root, SESSION_PATH)).toEqual({
      manifest: null,
      broadValidation: null,
      supervisorRecoveryVerified: false,
      loopLockRecoveryVerified: false,
    });
    const filePath = resolveAoiNonVoiceValidationManifestPath(root, SESSION_PATH);
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{broken', 'utf8');
    expect(loadAoiNonVoiceValidationManifest(root, SESSION_PATH).manifest).toBeNull();
  });

  it('rejects cross-session, duplicate-command, and mutation-capable manifests', () => {
    expect(
      normalizeAoiNonVoiceValidationManifest(
        { ...makeManifest(), sessionPath: 'aoi/other' },
        SESSION_PATH,
      ),
    ).toBeNull();
    const duplicate = makeManifest();
    duplicate.commands[1].id = duplicate.commands[0].id;
    expect(normalizeAoiNonVoiceValidationManifest(duplicate, SESSION_PATH)).toBeNull();
    expect(
      normalizeAoiNonVoiceValidationManifest({ ...makeManifest(), mutationCount: 1 }, SESSION_PATH),
    ).toBeNull();
    expect(
      normalizeAoiNonVoiceValidationManifest(
        {
          ...makeManifest(),
          commands: makeManifest().commands.map((command, index) => ({
            ...command,
            id: `arbitrary-${index}`,
          })),
        },
        SESSION_PATH,
      ),
    ).toBeNull();
  });

  it('loads failed commands but does not mark broad validation as passed', () => {
    const root = makeTempRoot();
    const manifest = makeManifest();
    manifest.commands[2].passed = false;
    const filePath = resolveAoiNonVoiceValidationManifestPath(root, SESSION_PATH);
    fs.mkdirSync(dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(manifest), 'utf8');

    const result = loadAoiNonVoiceValidationManifest(root, SESSION_PATH);
    expect(result.manifest).not.toBeNull();
    expect(result.broadValidation?.passed).toBe(false);
  });

  it('rejects traversal before resolving a validation path', () => {
    const root = makeTempRoot();
    expect(() => resolveAoiNonVoiceValidationManifestPath(root, '../outside')).toThrow();
  });

  it('atomically saves a normalized manifest inside an existing trusted session', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'aoi', 'live'), { recursive: true });
    const manifest = makeManifest();

    expect(saveAoiNonVoiceValidationManifest({ sessionsDir: root, manifest })).toEqual(manifest);
    expect(loadAoiNonVoiceValidationManifest(root, SESSION_PATH).manifest).toEqual(manifest);

    const replacement = makeManifest();
    replacement.generatedAt += 1_000;
    replacement.evidenceRefs = ['validation:replacement'];
    expect(saveAoiNonVoiceValidationManifest({ sessionsDir: root, manifest: replacement })).toEqual(
      replacement,
    );
    expect(loadAoiNonVoiceValidationManifest(root, SESSION_PATH).manifest).toEqual(replacement);
    expect(
      fs
        .readdirSync(dirname(resolveAoiNonVoiceValidationManifestPath(root, SESSION_PATH)))
        .filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});
