import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type { AoiNonVoiceBroadValidationEvidence } from './aoiNonVoiceJarvisScorecard';

export interface AoiNonVoiceValidationCommandResult {
  id: string;
  passed: boolean;
  completedAt: number;
  evidenceRefs: string[];
}

export interface AoiNonVoiceValidationManifest {
  version: 1;
  sessionPath: string;
  generatedAt: number;
  codeFingerprint: string;
  commands: AoiNonVoiceValidationCommandResult[];
  supervisorRecoveryVerified: boolean;
  loopLockRecoveryVerified: boolean;
  evidenceRefs: string[];
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiNonVoiceValidationManifestLoadResult {
  manifest: AoiNonVoiceValidationManifest | null;
  broadValidation: AoiNonVoiceBroadValidationEvidence | null;
  supervisorRecoveryVerified: boolean;
  loopLockRecoveryVerified: boolean;
}

export const AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS = [
  'full_test_suite',
  'runtime_recovery_tests',
  'typecheck',
  'daemon_build',
  'claim_cli_build',
  'client_build',
  'field_ci_gate',
  'operator_scorecard_playwright',
] as const;

const CODE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(resolve(root), resolve(target));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function normalizeStringArray(value: unknown, maximum = 32): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter(Boolean);
  return [...new Set(values)].slice(0, maximum);
}

export function resolveAoiNonVoiceValidationManifestPath(
  sessionsDir: string,
  sessionPath: string,
): string {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  if (fs.existsSync(sessionsRoot) && fs.lstatSync(sessionsRoot).isSymbolicLink()) {
    throw new Error('The sessions directory may not be a symbolic link.');
  }
  const sessionRoot = resolve(sessionsRoot, normalizedSessionPath);
  if (fs.existsSync(sessionRoot) && fs.lstatSync(sessionRoot).isSymbolicLink()) {
    throw new Error('The validation session directory may not be a symbolic link.');
  }
  const filePath = resolve(sessionRoot, 'aoi-non-voice-claim', 'validation.json');
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved non-voice validation path escaped the sessions directory.');
  }
  if (fs.existsSync(sessionsRoot) && fs.existsSync(filePath)) {
    const realSessionsRoot = fs.realpathSync(sessionsRoot);
    const realFilePath = fs.realpathSync(filePath);
    if (!isPathInsideRoot(realSessionsRoot, realFilePath)) {
      throw new Error('Resolved non-voice validation path escaped through a symbolic link.');
    }
  }
  return filePath;
}

export function normalizeAoiNonVoiceValidationManifest(
  value: unknown,
  expectedSessionPath: string,
): AoiNonVoiceValidationManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionPath = normalizeAoiAutonomySessionPath(record.sessionPath);
  const normalizedExpectedSessionPath = normalizeAoiAutonomySessionPath(expectedSessionPath);
  const generatedAt = Number(record.generatedAt);
  const codeFingerprint =
    typeof record.codeFingerprint === 'string' ? record.codeFingerprint.trim().slice(0, 160) : '';
  if (
    record.version !== 1 ||
    !sessionPath ||
    sessionPath !== normalizedExpectedSessionPath ||
    !Number.isFinite(generatedAt) ||
    generatedAt <= 0 ||
    !CODE_FINGERPRINT_PATTERN.test(codeFingerprint) ||
    record.actionAuthority !== 'display_only' ||
    record.mutationCount !== 0 ||
    !Array.isArray(record.commands)
  ) {
    return null;
  }
  const commands: AoiNonVoiceValidationCommandResult[] = [];
  const ids = new Set<string>();
  for (const item of record.commands) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const command = item as Record<string, unknown>;
    const id = typeof command.id === 'string' ? command.id.trim().slice(0, 120) : '';
    const completedAt = Number(command.completedAt);
    if (
      !id ||
      ids.has(id) ||
      typeof command.passed !== 'boolean' ||
      !Number.isFinite(completedAt) ||
      completedAt <= 0
    ) {
      return null;
    }
    ids.add(id);
    commands.push({
      id,
      passed: command.passed,
      completedAt,
      evidenceRefs: normalizeStringArray(command.evidenceRefs, 12),
    });
  }
  const requiredIds = AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS as readonly string[];
  if (
    commands.length !== requiredIds.length ||
    requiredIds.some((id) => !ids.has(id)) ||
    commands.some((command) => !requiredIds.includes(command.id)) ||
    generatedAt < Math.max(...commands.map((command) => command.completedAt))
  ) {
    return null;
  }
  const runtimeRecoveryPassed = commands.find(
    (command) => command.id === 'runtime_recovery_tests',
  )?.passed;
  if (
    record.supervisorRecoveryVerified !== runtimeRecoveryPassed ||
    record.loopLockRecoveryVerified !== runtimeRecoveryPassed
  ) {
    return null;
  }
  return {
    version: 1,
    sessionPath,
    generatedAt: Math.round(generatedAt),
    codeFingerprint,
    commands,
    supervisorRecoveryVerified: record.supervisorRecoveryVerified === true,
    loopLockRecoveryVerified: record.loopLockRecoveryVerified === true,
    evidenceRefs: normalizeStringArray(record.evidenceRefs),
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function resolveTrustedSessionRoot(sessionsDir: string, sessionPath: string): string {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const unresolvedSessionsRoot = resolve(sessionsDir);
  if (
    !fs.existsSync(unresolvedSessionsRoot) ||
    fs.lstatSync(unresolvedSessionsRoot).isSymbolicLink()
  ) {
    throw new Error('The sessions directory must exist and may not be a symbolic link.');
  }
  const sessionsRoot = fs.realpathSync(unresolvedSessionsRoot);
  const unresolvedSessionRoot = resolve(sessionsRoot, normalizedSessionPath);
  if (
    !isPathInsideRoot(sessionsRoot, unresolvedSessionRoot) ||
    !fs.existsSync(unresolvedSessionRoot) ||
    fs.lstatSync(unresolvedSessionRoot).isSymbolicLink()
  ) {
    throw new Error('The validation session must be an existing trusted directory.');
  }
  const sessionRoot = fs.realpathSync(unresolvedSessionRoot);
  if (!isPathInsideRoot(sessionsRoot, sessionRoot)) {
    throw new Error('The validation session escaped the sessions directory.');
  }
  return sessionRoot;
}

export function saveAoiNonVoiceValidationManifest(params: {
  sessionsDir: string;
  manifest: AoiNonVoiceValidationManifest;
}): AoiNonVoiceValidationManifest {
  const manifest = normalizeAoiNonVoiceValidationManifest(
    params.manifest,
    params.manifest.sessionPath,
  );
  if (!manifest) {
    throw new Error('The non-voice validation manifest is invalid.');
  }
  const sessionRoot = resolveTrustedSessionRoot(params.sessionsDir, manifest.sessionPath);
  const filePath = resolveAoiNonVoiceValidationManifestPath(
    params.sessionsDir,
    manifest.sessionPath,
  );
  const evidenceDir = dirname(filePath);
  if (fs.existsSync(evidenceDir) && fs.lstatSync(evidenceDir).isSymbolicLink()) {
    throw new Error('The non-voice validation evidence directory may not be a symbolic link.');
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (!isPathInsideRoot(sessionRoot, fs.realpathSync(evidenceDir))) {
    throw new Error('The non-voice validation evidence directory escaped the session root.');
  }
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error('The non-voice validation manifest may not be a symbolic link.');
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
  return manifest;
}

export function loadAoiNonVoiceValidationManifest(
  sessionsDir: string,
  sessionPath: string,
): AoiNonVoiceValidationManifestLoadResult {
  const filePath = resolveAoiNonVoiceValidationManifestPath(sessionsDir, sessionPath);
  let parsed: unknown;
  try {
    if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error('missing');
    }
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return {
      manifest: null,
      broadValidation: null,
      supervisorRecoveryVerified: false,
      loopLockRecoveryVerified: false,
    };
  }
  const manifest = normalizeAoiNonVoiceValidationManifest(parsed, sessionPath);
  if (!manifest) {
    return {
      manifest: null,
      broadValidation: null,
      supervisorRecoveryVerified: false,
      loopLockRecoveryVerified: false,
    };
  }
  const completedAt = Math.max(
    manifest.generatedAt,
    ...manifest.commands.map((command) => command.completedAt),
  );
  return {
    manifest,
    broadValidation: {
      passed: manifest.commands.every((command) => command.passed),
      commandCount: manifest.commands.length,
      completedAt,
      codeFingerprint: manifest.codeFingerprint,
      evidenceRefs: [
        `non-voice-validation:${manifest.codeFingerprint}`,
        ...manifest.evidenceRefs,
        ...manifest.commands.flatMap((command) => command.evidenceRefs),
      ],
    },
    supervisorRecoveryVerified: manifest.supervisorRecoveryVerified,
    loopLockRecoveryVerified: manifest.loopLockRecoveryVerified,
  };
}
