import * as fs from 'fs';
import { isAbsolute, relative, resolve } from 'path';

import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type {
  AoiControlledRealFileExecutionReport,
  AoiControlledRealFileScenarioId,
  AoiControlledRealFileScenarioResult,
} from './aoiControlledRealFileExecutionHarness';
import { fingerprintAoiControlledRealFileBehavior } from './aoiControlledRealFileExecutionHarness';

export interface AoiControlledRealFileEvidenceRecord {
  version: 1;
  sessionPath: string;
  codeFingerprint: string;
  recordedAt: number;
  report: AoiControlledRealFileExecutionReport;
  writeAuthority: 'operator_invoked_controlled_real';
  evidenceRefs: string[];
}

const EXPECTED_SCENARIOS: AoiControlledRealFileScenarioId[] = [
  'validated_success',
  'target_fingerprint_drift',
  'validation_failure_rollback',
  'rollback_failure_detection',
];

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(resolve(root), resolve(target));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function normalizeStrings(value: unknown, maximum = 32): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 240))
        .filter(Boolean),
    ),
  ].slice(0, maximum);
}

function resolveSessionRoot(sessionsDir: string, sessionPath: string): string {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = fs.realpathSync(resolve(sessionsDir));
  const unresolvedSessionRoot = resolve(sessionsRoot, normalizedSessionPath);
  if (!isPathInsideRoot(sessionsRoot, unresolvedSessionRoot)) {
    throw new Error('Controlled-real evidence session escaped the sessions directory.');
  }
  const sessionRoot = fs.realpathSync(unresolvedSessionRoot);
  if (!isPathInsideRoot(sessionsRoot, sessionRoot)) {
    throw new Error('Controlled-real evidence session escaped through a symbolic link.');
  }
  return sessionRoot;
}

export function resolveAoiControlledRealFileEvidencePath(
  sessionsDir: string,
  sessionPath: string,
): string {
  const sessionRoot = resolveSessionRoot(sessionsDir, sessionPath);
  const evidencePath = resolve(
    sessionRoot,
    'aoi-non-voice-claim',
    'controlled-real-file-execution.json',
  );
  if (!isPathInsideRoot(sessionRoot, evidencePath)) {
    throw new Error('Controlled-real evidence path escaped the session root.');
  }
  if (fs.existsSync(evidencePath)) {
    if (fs.lstatSync(evidencePath).isSymbolicLink()) {
      throw new Error('Controlled-real evidence file may not be a symbolic link.');
    }
    if (!isPathInsideRoot(sessionRoot, fs.realpathSync(evidencePath))) {
      throw new Error('Controlled-real evidence file escaped through a symbolic link.');
    }
  }
  return evidencePath;
}

function normalizeScenario(value: unknown): AoiControlledRealFileScenarioResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id as AoiControlledRealFileScenarioId;
  if (
    raw.version !== 1 ||
    !EXPECTED_SCENARIOS.includes(id) ||
    typeof raw.passed !== 'boolean' ||
    typeof raw.applied !== 'boolean' ||
    (raw.validationStatus !== 'not_run' &&
      raw.validationStatus !== 'passed' &&
      raw.validationStatus !== 'failed') ||
    typeof raw.rollbackAttempted !== 'boolean' ||
    typeof raw.rollbackSucceeded !== 'boolean' ||
    typeof raw.checkpointVerified !== 'boolean' ||
    typeof raw.finalStateVerified !== 'boolean'
  ) {
    return null;
  }
  const blockReasons = normalizeStrings(
    raw.blockReasons,
    16,
  ) as AoiControlledRealFileScenarioResult['blockReasons'];
  const semanticPass = (() => {
    if (id === 'validated_success') {
      return (
        raw.applied &&
        raw.validationStatus === 'passed' &&
        !raw.rollbackAttempted &&
        !raw.rollbackSucceeded &&
        raw.checkpointVerified &&
        raw.finalStateVerified &&
        blockReasons.length === 0
      );
    }
    if (id === 'target_fingerprint_drift') {
      return (
        !raw.applied &&
        raw.validationStatus === 'failed' &&
        !raw.rollbackAttempted &&
        !raw.rollbackSucceeded &&
        raw.checkpointVerified &&
        raw.finalStateVerified &&
        blockReasons.includes('target_fingerprint_mismatch')
      );
    }
    if (id === 'validation_failure_rollback') {
      return (
        !raw.applied &&
        raw.validationStatus === 'failed' &&
        raw.rollbackAttempted &&
        raw.rollbackSucceeded &&
        raw.checkpointVerified &&
        raw.finalStateVerified &&
        blockReasons.includes('verification_failed')
      );
    }
    return (
      !raw.applied &&
      raw.validationStatus === 'failed' &&
      raw.rollbackAttempted &&
      !raw.rollbackSucceeded &&
      raw.checkpointVerified &&
      raw.finalStateVerified &&
      blockReasons.includes('rollback_failed')
    );
  })();
  if (raw.passed !== semanticPass) {
    return null;
  }
  return {
    version: 1,
    id,
    passed: raw.passed,
    applied: raw.applied,
    validationStatus: raw.validationStatus,
    rollbackAttempted: raw.rollbackAttempted,
    rollbackSucceeded: raw.rollbackSucceeded,
    checkpointVerified: raw.checkpointVerified,
    finalStateVerified: raw.finalStateVerified,
    blockReasons,
    evidenceRefs: normalizeStrings(raw.evidenceRefs, 16),
  };
}

function normalizeReport(value: unknown): AoiControlledRealFileExecutionReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    raw.evidenceClass !== 'controlled_real' ||
    !Number.isFinite(raw.generatedAt) ||
    typeof raw.passed !== 'boolean' ||
    typeof raw.behaviorFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.behaviorFingerprint) ||
    typeof raw.cleanupVerified !== 'boolean' ||
    raw.actionAuthority !== 'disposable_workspace_only' ||
    !Array.isArray(raw.scenarios)
  ) {
    return null;
  }
  const scenarios = raw.scenarios.map(normalizeScenario);
  if (scenarios.some((scenario) => scenario === null)) {
    return null;
  }
  const normalizedScenarios = scenarios as AoiControlledRealFileScenarioResult[];
  const ids = normalizedScenarios.map((scenario) => scenario.id);
  if (
    ids.length !== EXPECTED_SCENARIOS.length ||
    new Set(ids).size !== EXPECTED_SCENARIOS.length ||
    EXPECTED_SCENARIOS.some((id) => !ids.includes(id))
  ) {
    return null;
  }
  const passedScenarioCount = normalizedScenarios.filter((scenario) => scenario.passed).length;
  const behaviorFingerprint = fingerprintAoiControlledRealFileBehavior(normalizedScenarios);
  if (
    raw.scenarioCount !== normalizedScenarios.length ||
    raw.passedScenarioCount !== passedScenarioCount ||
    raw.passed !== (passedScenarioCount === normalizedScenarios.length && raw.cleanupVerified) ||
    raw.behaviorFingerprint !== behaviorFingerprint
  ) {
    return null;
  }
  return {
    version: 1,
    id: raw.id.trim().slice(0, 160),
    evidenceClass: 'controlled_real',
    generatedAt: Math.round(Number(raw.generatedAt)),
    passed: raw.passed,
    scenarioCount: normalizedScenarios.length,
    passedScenarioCount,
    behaviorFingerprint,
    cleanupVerified: raw.cleanupVerified,
    scenarios: normalizedScenarios,
    evidenceRefs: normalizeStrings(raw.evidenceRefs),
    actionAuthority: 'disposable_workspace_only',
  };
}

export function normalizeAoiControlledRealFileEvidence(
  value: unknown,
  expectedSessionPath: string,
): AoiControlledRealFileEvidenceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const sessionPath = normalizeAoiAutonomySessionPath(raw.sessionPath);
  const expected = normalizeAoiAutonomySessionPath(expectedSessionPath);
  const report = normalizeReport(raw.report);
  if (
    raw.version !== 1 ||
    !sessionPath ||
    sessionPath !== expected ||
    typeof raw.codeFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.codeFingerprint) ||
    !Number.isFinite(raw.recordedAt) ||
    Number(raw.recordedAt) <= 0 ||
    !report ||
    raw.writeAuthority !== 'operator_invoked_controlled_real'
  ) {
    return null;
  }
  return {
    version: 1,
    sessionPath,
    codeFingerprint: raw.codeFingerprint,
    recordedAt: Math.round(Number(raw.recordedAt)),
    report,
    writeAuthority: 'operator_invoked_controlled_real',
    evidenceRefs: normalizeStrings(raw.evidenceRefs),
  };
}

export function loadAoiControlledRealFileEvidence(
  sessionsDir: string,
  sessionPath: string,
): AoiControlledRealFileEvidenceRecord | null {
  try {
    const evidencePath = resolveAoiControlledRealFileEvidencePath(sessionsDir, sessionPath);
    if (!fs.existsSync(evidencePath) || fs.lstatSync(evidencePath).isSymbolicLink()) {
      return null;
    }
    return normalizeAoiControlledRealFileEvidence(
      JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown,
      sessionPath,
    );
  } catch {
    return null;
  }
}

export function saveAoiControlledRealFileEvidence(params: {
  sessionsDir: string;
  sessionPath: string;
  codeFingerprint: string;
  report: AoiControlledRealFileExecutionReport;
  now?: number;
}): AoiControlledRealFileEvidenceRecord {
  const sessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!sessionPath || !/^[a-f0-9]{64}$/.test(params.codeFingerprint)) {
    throw new Error('Invalid controlled-real evidence session or code fingerprint.');
  }
  const report = normalizeReport(params.report);
  if (!report || !report.passed) {
    throw new Error('Controlled-real file execution report did not pass validation.');
  }
  const evidencePath = resolveAoiControlledRealFileEvidencePath(params.sessionsDir, sessionPath);
  const evidenceDir = resolve(evidencePath, '..');
  if (fs.existsSync(evidenceDir) && fs.lstatSync(evidenceDir).isSymbolicLink()) {
    throw new Error('Controlled-real evidence directory may not be a symbolic link.');
  }
  fs.mkdirSync(evidenceDir, { recursive: true });
  const sessionRoot = resolveSessionRoot(params.sessionsDir, sessionPath);
  const realEvidenceDir = fs.realpathSync(evidenceDir);
  if (!isPathInsideRoot(sessionRoot, realEvidenceDir)) {
    throw new Error('Controlled-real evidence directory escaped the session root.');
  }
  const now = params.now ?? Date.now();
  const record: AoiControlledRealFileEvidenceRecord = {
    version: 1,
    sessionPath,
    codeFingerprint: params.codeFingerprint,
    recordedAt: now,
    report,
    writeAuthority: 'operator_invoked_controlled_real',
    evidenceRefs: [
      `controlled-real-file:${report.behaviorFingerprint}`,
      ...report.evidenceRefs,
    ].slice(0, 32),
  };
  const temporaryPath = `${evidencePath}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  fs.renameSync(temporaryPath, evidencePath);
  return record;
}
