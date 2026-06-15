import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import type { AoiCalibrationDimension, AoiTrustCalibrationReset } from './aoiAutonomyTypes';

const TRUST_CALIBRATION_FILE = 'trust-calibration.json';

interface TrustCalibrationState {
  version: 1;
  resets: AoiTrustCalibrationReset[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isAoiCalibrationDimension(value: unknown): value is AoiCalibrationDimension {
  return (
    value === 'source_kind' ||
    value === 'trigger_kind' ||
    value === 'action_kind' ||
    value === 'risk_level' ||
    value === 'notification_lane' ||
    value === 'voice_category' ||
    value === 'interruption_gap' ||
    value === 'feedback_category'
  );
}

function normalizeReset(value: unknown): AoiTrustCalibrationReset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Partial<AoiTrustCalibrationReset>;
  if (
    raw.version !== 1 ||
    !isAoiCalibrationDimension(raw.dimension) ||
    typeof raw.key !== 'string' ||
    typeof raw.resetAt !== 'number' ||
    !Number.isFinite(raw.resetAt)
  ) {
    return null;
  }
  const key = normalizeWhitespace(raw.key).slice(0, 120);
  if (!key) {
    return null;
  }
  return {
    version: 1,
    dimension: raw.dimension,
    key,
    resetAt: raw.resetAt,
  };
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function trustCalibrationFile(sessionsDir: string, sessionPath: string): string {
  const paths = resolveAoiAutonomyPaths(sessionsDir, sessionPath);
  const filePath = resolve(paths.root, TRUST_CALIBRATION_FILE);
  if (!isPathInsideRoot(paths.root, filePath)) {
    throw new Error('Resolved Aoi trust calibration path escaped the autonomy directory.');
  }
  return filePath;
}

function readTrustCalibrationState(
  sessionsDir: string,
  sessionPath: string,
): TrustCalibrationState {
  try {
    const filePath = trustCalibrationFile(sessionsDir, sessionPath);
    if (!fs.existsSync(filePath)) {
      return { version: 1, resets: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1, resets: [] };
    }
    const raw = parsed as Partial<TrustCalibrationState>;
    return {
      version: 1,
      resets: Array.isArray(raw.resets)
        ? raw.resets
            .map(normalizeReset)
            .filter((item): item is AoiTrustCalibrationReset => Boolean(item))
        : [],
    };
  } catch {
    return { version: 1, resets: [] };
  }
}

function writeTrustCalibrationState(
  sessionsDir: string,
  sessionPath: string,
  state: TrustCalibrationState,
): void {
  const filePath = trustCalibrationFile(sessionsDir, sessionPath);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export function loadAoiTrustCalibrationResets(
  sessionsDir: string,
  sessionPath: string,
): AoiTrustCalibrationReset[] {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  return readTrustCalibrationState(sessionsDir, normalizedSessionPath).resets;
}

export function resetAoiTrustCalibrationCategory(params: {
  sessionsDir: string;
  sessionPath: string;
  dimension: AoiCalibrationDimension;
  key: string;
  now?: number;
}): AoiTrustCalibrationReset {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(params.sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  if (!isAoiCalibrationDimension(params.dimension)) {
    throw new Error('Invalid calibration dimension.');
  }
  const key = normalizeWhitespace(params.key).slice(0, 120);
  if (!key) {
    throw new Error('Calibration key is required.');
  }
  const reset: AoiTrustCalibrationReset = {
    version: 1,
    dimension: params.dimension,
    key,
    resetAt: params.now ?? Date.now(),
  };
  const state = readTrustCalibrationState(params.sessionsDir, normalizedSessionPath);
  const resets = [
    reset,
    ...state.resets.filter(
      (item) => !(item.dimension === reset.dimension && item.key === reset.key),
    ),
  ].slice(0, 80);
  writeTrustCalibrationState(params.sessionsDir, normalizedSessionPath, {
    version: 1,
    resets,
  });
  return reset;
}
