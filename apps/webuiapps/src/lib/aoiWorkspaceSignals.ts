import * as fs from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'path';
import {
  checkAoiEnvironmentSourceOperation,
  getDefaultAoiEnvironmentSourceRegistry,
} from './aoiAutonomyPolicy';
import {
  loadAoiEnvironmentSourceRegistry,
  normalizeAoiAutonomySessionPath,
  updateAoiEnvironmentSource,
} from './aoiAutonomyStore';
import type {
  AoiChangedFileSignal,
  AoiEnvironmentSourceRegistry,
  AoiGitSignal,
  AoiMissionState,
  AoiObservation,
  AoiSignalFreshness,
  AoiValidationSignal,
  AoiValidationSignalResult,
  AoiWorkspaceSnapshot,
} from './aoiAutonomyTypes';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const WORKSPACE_SNAPSHOT_FILE_NAME = 'workspace-snapshot.json';
const MAX_CHANGED_FILES = 24;
const MAX_EVIDENCE_REFS = 16;
const MAX_WARNING_ITEMS = 12;
const MAX_PATH_LABEL_CHARS = 120;
const MAX_SCOPE_ITEMS = 24;
const GIT_TIMEOUT_MS = 2500;
const GIT_MAX_BUFFER = 256 * 1024;

export interface AoiWorkspaceGitCommandRunner {
  (args: string[], cwd: string): string;
}

export interface AoiWorkspaceSnapshotCollectionInput {
  sessionPath: string;
  workspaceRoot: string;
  registry?: AoiEnvironmentSourceRegistry | null;
  previousSnapshot?: AoiWorkspaceSnapshot | null;
  validation?: Partial<AoiValidationSignal>;
  now?: number;
  runGitCommand?: AoiWorkspaceGitCommandRunner;
}

export interface AoiWorkspaceSignalStoreInput extends AoiWorkspaceSnapshotCollectionInput {
  sessionsDir: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeStringList(value: unknown, maxItems = MAX_SCOPE_ITEMS): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = truncateText(item, MAX_PATH_LABEL_CHARS);
    if (normalized) {
      seen.add(normalized);
    }
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function workspaceSignalFilePath(sessionsDir: string, sessionPath: string): string {
  const normalized = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalized) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(
    sessionsRoot,
    normalized,
    AUTONOMY_ROOT_DIR,
    WORKSPACE_SNAPSHOT_FILE_NAME,
  );
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi workspace signal path escaped the sessions directory.');
  }
  return filePath;
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${hashText(filePath).slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function normalizeWorkspaceLabel(workspaceRoot: string): string {
  const name = basename(resolve(workspaceRoot));
  return truncateText(name || 'workspace', 80);
}

export function sanitizeAoiWorkspacePathLabel(pathValue: string, workspaceRoot?: string): string {
  const normalizedInput = pathValue.replace(/\\/g, '/').trim();
  if (!normalizedInput) {
    return 'unknown';
  }
  const root = workspaceRoot ? resolve(workspaceRoot) : '';
  let relativePath = normalizedInput;
  try {
    const maybeAbsolute =
      root && !isAbsolute(pathValue) ? resolve(root, pathValue) : resolve(pathValue);
    if (root && isPathInsideRoot(root, maybeAbsolute)) {
      relativePath = relative(root, maybeAbsolute).replace(/\\/g, '/');
    }
  } catch {
    relativePath = normalizedInput;
  }
  if (/^[A-Za-z]:\//.test(relativePath) || relativePath.startsWith('/')) {
    relativePath = basename(relativePath);
  }
  const safeSegments = relativePath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment !== '.' && segment !== '..');
  const fullLabel = safeSegments.join('/') || basename(relativePath) || 'unknown';
  if (fullLabel.length <= MAX_PATH_LABEL_CHARS) {
    return fullLabel;
  }
  return truncateText(safeSegments.slice(-4).join('/') || fullLabel, MAX_PATH_LABEL_CHARS);
}

function makeChangedFileSignal(
  rawPath: string,
  params: {
    workspaceRoot?: string;
    status: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    changedAt?: number;
  },
): AoiChangedFileSignal {
  const pathLabel = sanitizeAoiWorkspacePathLabel(rawPath, params.workspaceRoot);
  const directoryLabel = pathLabel.includes('/')
    ? truncateText(pathLabel.split('/').slice(0, -1).join('/'), 80)
    : undefined;
  const extension = extname(pathLabel).replace(/^\./, '').slice(0, 24) || undefined;
  return {
    version: 1,
    pathLabel,
    pathHash: hashText(pathLabel.toLowerCase()),
    status: truncateText(params.status || 'changed', 40),
    staged: params.staged,
    unstaged: params.unstaged,
    untracked: params.untracked,
    ...(typeof params.changedAt === 'number' ? { changedAt: params.changedAt } : {}),
    ...(directoryLabel ? { directoryLabel } : {}),
    ...(extension ? { extension } : {}),
  };
}

function normalizeChangedFileSignal(
  value: unknown,
  now: number,
  workspaceRoot?: string,
): AoiChangedFileSignal | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Partial<AoiChangedFileSignal>;
  const pathLabel = sanitizeAoiWorkspacePathLabel(String(raw.pathLabel || ''), workspaceRoot);
  if (!pathLabel || pathLabel === 'unknown') {
    return null;
  }
  return makeChangedFileSignal(pathLabel, {
    workspaceRoot,
    status: typeof raw.status === 'string' ? raw.status : 'changed',
    staged: raw.staged === true,
    unstaged: raw.unstaged === true,
    untracked: raw.untracked === true,
    changedAt: typeof raw.changedAt === 'number' ? raw.changedAt : now,
  });
}

function decodeGitStatusPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown;
      if (typeof decoded === 'string' && decoded.trim()) {
        return decoded;
      }
    } catch {
      // Fall through to the raw path when Git's quoting is not JSON-compatible.
    }
  }
  return trimmed;
}

function resolveChangedFileTimestamp(params: {
  rawPath: string;
  workspaceRoot: string;
  now: number;
  previous?: AoiChangedFileSignal;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}): number {
  try {
    const candidate = isAbsolute(params.rawPath)
      ? resolve(params.rawPath)
      : resolve(params.workspaceRoot, params.rawPath);
    if (isPathInsideRoot(params.workspaceRoot, candidate) && fs.existsSync(candidate)) {
      const mtimeMs = fs.statSync(candidate).mtimeMs;
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        return Math.min(params.now, Math.trunc(mtimeMs));
      }
    }
  } catch {
    // Deleted or transient paths fall back to the stable previous observation.
  }
  const previous = params.previous;
  if (
    previous &&
    previous.status === params.status &&
    previous.staged === params.staged &&
    previous.unstaged === params.unstaged &&
    previous.untracked === params.untracked &&
    typeof previous.changedAt === 'number'
  ) {
    return previous.changedAt;
  }
  return params.now;
}

function parsePorcelainStatusLine(
  line: string,
  workspaceRoot: string,
  now: number,
  previousFilesByPath: ReadonlyMap<string, AoiChangedFileSignal>,
): AoiChangedFileSignal | null {
  if (line.length < 4) {
    return null;
  }
  const indexStatus = line[0] || ' ';
  const worktreeStatus = line[1] || ' ';
  const rawPath = line.slice(3).trim();
  const displayPath = decodeGitStatusPath(
    rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() || rawPath : rawPath,
  );
  const untracked = indexStatus === '?' || worktreeStatus === '?';
  const staged = !untracked && indexStatus !== ' ';
  const unstaged = untracked || worktreeStatus !== ' ';
  const status = `${indexStatus}${worktreeStatus}`.trim() || 'changed';
  const pathLabel = sanitizeAoiWorkspacePathLabel(displayPath, workspaceRoot);
  return makeChangedFileSignal(displayPath, {
    workspaceRoot,
    status,
    staged,
    unstaged,
    untracked,
    changedAt: resolveChangedFileTimestamp({
      rawPath: displayPath,
      workspaceRoot,
      now,
      previous: previousFilesByPath.get(pathLabel),
      status,
      staged,
      unstaged,
      untracked,
    }),
  });
}

function defaultRunGitCommand(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  }).trimEnd();
}

function parseRecentCommit(raw: string): { hash?: string; message?: string } {
  const [hash = '', message = ''] = raw.split('\u0000');
  return {
    ...(hash ? { hash: hash.slice(0, 40) } : {}),
    ...(message ? { message: truncateText(message, 120) } : {}),
  };
}

function buildGitStatusSummary(
  signal: Pick<AoiGitSignal, 'changedFileCount' | 'stagedFileCount'>,
): string {
  if (signal.changedFileCount <= 0) {
    return 'clean';
  }
  return `dirty: ${signal.changedFileCount} changed, ${signal.stagedFileCount} staged`;
}

function collectGitSignal(params: {
  workspaceRoot: string;
  previousSnapshot?: AoiWorkspaceSnapshot | null;
  now: number;
  runGitCommand: AoiWorkspaceGitCommandRunner;
}): AoiGitSignal {
  const branchName =
    params.runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], params.workspaceRoot) || 'unknown';
  const statusRaw = params.runGitCommand(['status', '--porcelain=v1'], params.workspaceRoot);
  const recentCommit = parseRecentCommit(
    params.runGitCommand(['log', '-1', '--pretty=%H%x00%s'], params.workspaceRoot),
  );
  const previousFilesByPath = new Map(
    (params.previousSnapshot?.git?.changedFiles ?? []).map((file) => [file.pathLabel, file]),
  );
  const changedFiles = statusRaw
    .split(/\r?\n/)
    .map((line) =>
      parsePorcelainStatusLine(line, params.workspaceRoot, params.now, previousFilesByPath),
    )
    .filter((file): file is AoiChangedFileSignal => file !== null)
    .slice(0, MAX_CHANGED_FILES);
  const stagedFileCount = changedFiles.filter((file) => file.staged).length;
  const unstagedFileCount = changedFiles.filter((file) => file.unstaged).length;
  const untrackedFileCount = changedFiles.filter((file) => file.untracked).length;
  const previousBranchName = params.previousSnapshot?.git?.branchName;
  const branchChanged = Boolean(previousBranchName && previousBranchName !== branchName);
  const summary = buildGitStatusSummary({
    changedFileCount: changedFiles.length,
    stagedFileCount,
  });

  return {
    version: 1,
    branchName: truncateText(branchName, 80),
    ...(previousBranchName ? { previousBranchName: truncateText(previousBranchName, 80) } : {}),
    branchChanged,
    isDirty: changedFiles.length > 0,
    changedFileCount: changedFiles.length,
    stagedFileCount,
    unstagedFileCount,
    untrackedFileCount,
    statusSummary: summary,
    changedFiles,
    ...(recentCommit.hash ? { recentCommitHash: recentCommit.hash } : {}),
    ...(recentCommit.message ? { recentCommitMessage: recentCommit.message } : {}),
  };
}

function normalizeValidationResult(value: unknown): AoiValidationSignalResult {
  return value === 'passed' || value === 'failed' ? value : 'unknown';
}

function scopeMatchesFile(scope: string, file: AoiChangedFileSignal): boolean {
  const normalizedScope = scope.replace(/\\/g, '/').toLowerCase().trim();
  const pathLabel = file.pathLabel.toLowerCase();
  if (!normalizedScope) {
    return false;
  }
  if (normalizedScope === '*' || normalizedScope === 'all') {
    return true;
  }
  if (normalizedScope.startsWith('*.')) {
    return file.extension?.toLowerCase() === normalizedScope.slice(2);
  }
  const compactScope = normalizedScope.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^\/+/, '');
  return pathLabel === compactScope || pathLabel.startsWith(`${compactScope.replace(/\/+$/, '')}/`);
}

function changedFileMatchesScopes(file: AoiChangedFileSignal, scopes: string[]): boolean {
  if (scopes.length <= 0) {
    return true;
  }
  return scopes.some((scope) => scopeMatchesFile(scope, file));
}

export function deriveAoiValidationFreshness(params: {
  validation?: Partial<AoiValidationSignal> | null;
  changedFiles?: AoiChangedFileSignal[];
  now?: number;
}): AoiSignalFreshness {
  const validation = params.validation;
  if (!validation) {
    return 'unknown';
  }
  const result = normalizeValidationResult(validation.result);
  if (result === 'failed') {
    return 'failed';
  }
  if (result !== 'passed' || typeof validation.completedAt !== 'number') {
    return 'unknown';
  }
  const scopes = normalizeStringList(validation.touchedFileScopes);
  const changedAfterValidation = (params.changedFiles ?? []).some((file) => {
    const changedAt = typeof file.changedAt === 'number' ? file.changedAt : params.now;
    return (
      typeof changedAt === 'number' &&
      changedAt > validation.completedAt! &&
      changedFileMatchesScopes(file, scopes)
    );
  });
  return changedAfterValidation ? 'stale' : 'fresh';
}

function normalizeValidationSignal(
  value: unknown,
  changedFiles: AoiChangedFileSignal[],
  now: number,
): AoiValidationSignal {
  const raw = value && typeof value === 'object' ? (value as Partial<AoiValidationSignal>) : {};
  const result = normalizeValidationResult(raw.result);
  const completedAt =
    typeof raw.completedAt === 'number' && raw.completedAt > 0 ? raw.completedAt : undefined;
  const touchedFileScopes = normalizeStringList(raw.touchedFileScopes);
  const freshness = deriveAoiValidationFreshness({
    validation: {
      result,
      completedAt,
      touchedFileScopes,
    },
    changedFiles,
    now,
  });
  const staleReason =
    freshness === 'stale'
      ? 'Relevant files changed after the last passed validation.'
      : freshness === 'failed'
        ? 'The last recorded validation failed.'
        : undefined;
  return {
    version: 1,
    ...(typeof raw.command === 'string' && raw.command.trim()
      ? { command: truncateText(raw.command, 160) }
      : {}),
    result,
    ...(completedAt ? { completedAt } : {}),
    touchedFileScopes,
    freshness,
    ...(staleReason ? { staleReason } : {}),
    evidenceRefs: normalizeStringList(raw.evidenceRefs, MAX_EVIDENCE_REFS),
  };
}

function combineFreshness(
  git: AoiGitSignal | undefined,
  validation: AoiValidationSignal,
): AoiSignalFreshness {
  if (validation.freshness === 'failed' || validation.freshness === 'stale') {
    return validation.freshness;
  }
  if (validation.freshness === 'fresh') {
    return 'fresh';
  }
  if (git?.isDirty) {
    return 'unknown';
  }
  return 'unknown';
}

function normalizeGitSignal(
  value: unknown,
  now: number,
  workspaceRoot?: string,
): AoiGitSignal | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Partial<AoiGitSignal>;
  const changedFiles = Array.isArray(raw.changedFiles)
    ? raw.changedFiles
        .map((file) => normalizeChangedFileSignal(file, now, workspaceRoot))
        .filter((file): file is AoiChangedFileSignal => file !== null)
        .slice(0, MAX_CHANGED_FILES)
    : [];
  const stagedFileCount =
    typeof raw.stagedFileCount === 'number'
      ? Math.max(0, raw.stagedFileCount)
      : changedFiles.filter((file) => file.staged).length;
  const unstagedFileCount =
    typeof raw.unstagedFileCount === 'number'
      ? Math.max(0, raw.unstagedFileCount)
      : changedFiles.filter((file) => file.unstaged).length;
  const untrackedFileCount =
    typeof raw.untrackedFileCount === 'number'
      ? Math.max(0, raw.untrackedFileCount)
      : changedFiles.filter((file) => file.untracked).length;
  const branchName = truncateText(String(raw.branchName || 'unknown'), 80);
  const previousBranchName =
    typeof raw.previousBranchName === 'string'
      ? truncateText(raw.previousBranchName, 80)
      : undefined;
  return {
    version: 1,
    branchName,
    ...(previousBranchName ? { previousBranchName } : {}),
    branchChanged: raw.branchChanged === true,
    isDirty: raw.isDirty === true || changedFiles.length > 0,
    changedFileCount:
      typeof raw.changedFileCount === 'number'
        ? Math.max(0, raw.changedFileCount)
        : changedFiles.length,
    stagedFileCount,
    unstagedFileCount,
    untrackedFileCount,
    statusSummary:
      typeof raw.statusSummary === 'string'
        ? truncateText(raw.statusSummary, 120)
        : buildGitStatusSummary({
            changedFileCount: changedFiles.length,
            stagedFileCount,
          }),
    changedFiles,
    ...(typeof raw.recentCommitHash === 'string'
      ? { recentCommitHash: raw.recentCommitHash.slice(0, 40) }
      : {}),
    ...(typeof raw.recentCommitMessage === 'string'
      ? { recentCommitMessage: truncateText(raw.recentCommitMessage, 120) }
      : {}),
    ...(typeof raw.error === 'string' ? { error: truncateText(raw.error, 160) } : {}),
  };
}

export function normalizeAoiWorkspaceSnapshot(
  value: unknown,
  sessionPath: string,
  now = Date.now(),
  workspaceRoot?: string,
): AoiWorkspaceSnapshot | null {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    return {
      version: 1,
      sessionPath: normalizedSessionPath,
      collectedAt: now,
      workspaceLabel: normalizeWorkspaceLabel(workspaceRoot || 'workspace'),
      sourceIds: [],
      validation: normalizeValidationSignal(null, [], now),
      freshness: 'unknown',
      evidenceRefs: [],
      warnings: [],
    };
  }
  const raw = value as Partial<AoiWorkspaceSnapshot>;
  const git = normalizeGitSignal(raw.git, now, workspaceRoot);
  const validation = normalizeValidationSignal(raw.validation, git?.changedFiles ?? [], now);
  const freshness = combineFreshness(git, validation);
  return {
    version: 1,
    sessionPath: normalizedSessionPath,
    collectedAt: typeof raw.collectedAt === 'number' ? raw.collectedAt : now,
    workspaceLabel:
      typeof raw.workspaceLabel === 'string'
        ? truncateText(raw.workspaceLabel, 80)
        : normalizeWorkspaceLabel(workspaceRoot || 'workspace'),
    sourceIds: normalizeStringList(raw.sourceIds, 8),
    ...(git ? { git } : {}),
    validation,
    freshness,
    evidenceRefs: normalizeStringList(raw.evidenceRefs, MAX_EVIDENCE_REFS),
    warnings: normalizeStringList(raw.warnings, MAX_WARNING_ITEMS),
  };
}

export function collectAoiWorkspaceSnapshot(
  input: AoiWorkspaceSnapshotCollectionInput,
): AoiWorkspaceSnapshot | null {
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = input.now ?? Date.now();
  const workspaceRoot = resolve(input.workspaceRoot);
  const registry = input.registry ?? getDefaultAoiEnvironmentSourceRegistry(sessionPath, now);
  const gitPolicy = checkAoiEnvironmentSourceOperation({
    registry,
    sourceId: 'workspace-git',
    operation: 'status',
  });
  const buildPolicy = checkAoiEnvironmentSourceOperation({
    registry,
    sourceId: 'workspace-build',
    operation: 'read_metadata',
  });
  const sourceIds: string[] = [];
  const warnings: string[] = [];
  let git: AoiGitSignal | undefined;
  const runGitCommand = input.runGitCommand ?? defaultRunGitCommand;

  if (gitPolicy.allowed) {
    sourceIds.push('workspace-git');
    try {
      git = collectGitSignal({
        workspaceRoot,
        previousSnapshot: input.previousSnapshot,
        now,
        runGitCommand,
      });
    } catch (error) {
      warnings.push('workspace_git_snapshot_failed');
      git = {
        version: 1,
        branchName: input.previousSnapshot?.git?.branchName ?? 'unknown',
        branchChanged: false,
        isDirty: false,
        changedFileCount: 0,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        statusSummary: 'unavailable',
        changedFiles: [],
        error: error instanceof Error ? truncateText(error.message, 160) : 'git status failed',
      };
    }
  } else {
    warnings.push(`workspace_git_suppressed:${gitPolicy.reasons.join(',')}`);
  }

  const previousValidation = input.previousSnapshot?.validation;
  const validationInput = input.validation ?? previousValidation;
  const validation = buildPolicy.allowed
    ? normalizeValidationSignal(validationInput, git?.changedFiles ?? [], now)
    : normalizeValidationSignal(null, [], now);
  if (buildPolicy.allowed) {
    sourceIds.push('workspace-build');
  } else {
    warnings.push(`workspace_build_suppressed:${buildPolicy.reasons.join(',')}`);
  }

  if (sourceIds.length <= 0) {
    return null;
  }

  const freshness = combineFreshness(git, validation);
  const evidenceRefs = [
    `workspace:snapshot:${hashText(`${sessionPath}:${now}:${git?.branchName ?? 'no-git'}`)}`,
    git ? `workspace:git:${git.branchName}` : undefined,
    validation.freshness !== 'unknown' ? `workspace:validation:${validation.freshness}` : undefined,
  ].filter((ref): ref is string => Boolean(ref));

  return normalizeAoiWorkspaceSnapshot(
    {
      version: 1,
      sessionPath,
      collectedAt: now,
      workspaceLabel: normalizeWorkspaceLabel(workspaceRoot),
      sourceIds,
      git,
      validation,
      freshness,
      evidenceRefs,
      warnings,
    },
    sessionPath,
    now,
    workspaceRoot,
  );
}

export function loadAoiWorkspaceSnapshot(
  sessionsDir: string,
  sessionPath: string,
  now = Date.now(),
): AoiWorkspaceSnapshot | null {
  return normalizeAoiWorkspaceSnapshot(
    readJson<unknown>(workspaceSignalFilePath(sessionsDir, sessionPath)),
    sessionPath,
    now,
  );
}

export function saveAoiWorkspaceSnapshot(
  sessionsDir: string,
  sessionPath: string,
  snapshot: AoiWorkspaceSnapshot,
): AoiWorkspaceSnapshot {
  const normalized = normalizeAoiWorkspaceSnapshot(snapshot, sessionPath, snapshot.collectedAt);
  if (!normalized) {
    throw new Error('Invalid Aoi workspace snapshot.');
  }
  writeJsonAtomic(workspaceSignalFilePath(sessionsDir, sessionPath), normalized);
  return normalized;
}

export function recordAoiValidationSignal(params: {
  sessionsDir: string;
  sessionPath: string;
  signal: Partial<AoiValidationSignal>;
  now?: number;
}): AoiWorkspaceSnapshot {
  const now = params.now ?? Date.now();
  const previous = loadAoiWorkspaceSnapshot(params.sessionsDir, params.sessionPath, now);
  const next = normalizeAoiWorkspaceSnapshot(
    {
      ...(previous ?? {}),
      version: 1,
      sessionPath: params.sessionPath,
      collectedAt: now,
      validation: params.signal,
      sourceIds: [...new Set([...(previous?.sourceIds ?? []), 'workspace-build'])],
    },
    params.sessionPath,
    now,
  );
  if (!next) {
    throw new Error('Invalid Aoi validation signal.');
  }
  return saveAoiWorkspaceSnapshot(params.sessionsDir, params.sessionPath, next);
}

export function collectAndPersistAoiWorkspaceSnapshot(
  input: AoiWorkspaceSignalStoreInput,
): AoiWorkspaceSnapshot | null {
  const now = input.now ?? Date.now();
  const registry =
    input.registry ?? loadAoiEnvironmentSourceRegistry(input.sessionsDir, input.sessionPath, now);
  const previousSnapshot =
    input.previousSnapshot ?? loadAoiWorkspaceSnapshot(input.sessionsDir, input.sessionPath, now);
  const snapshot = collectAoiWorkspaceSnapshot({
    ...input,
    registry,
    previousSnapshot,
    now,
  });
  if (!snapshot) {
    return null;
  }
  const saved = saveAoiWorkspaceSnapshot(input.sessionsDir, input.sessionPath, snapshot);
  for (const sourceId of saved.sourceIds) {
    try {
      updateAoiEnvironmentSource(input.sessionsDir, input.sessionPath, {
        sourceId,
        patch: {
          lastObservedAt: saved.collectedAt,
        },
        now: saved.collectedAt,
      });
    } catch {
      // Source observation timestamps are diagnostic only.
    }
  }
  return saved;
}

export function createAoiWorkspaceObservations(params: {
  snapshot: AoiWorkspaceSnapshot;
  mission?: AoiMissionState | null;
}): AoiObservation[] {
  const snapshot = params.snapshot;
  const observations: AoiObservation[] = [];
  const missionGoalRef = params.mission?.activeGoalId
    ? `goal:${params.mission.activeGoalId}`
    : undefined;
  const evidenceRefs = [
    ...snapshot.evidenceRefs,
    ...(missionGoalRef ? [missionGoalRef] : []),
  ].slice(0, MAX_EVIDENCE_REFS);
  const branchDrift = snapshot.git?.branchChanged
    ? ` Branch changed from ${snapshot.git.previousBranchName} to ${snapshot.git.branchName}.`
    : '';
  const dirtySummary = snapshot.git?.isDirty
    ? ` ${snapshot.git.changedFileCount} changed files; ${snapshot.git.stagedFileCount} staged.`
    : ' Working tree is clean.';

  if (snapshot.git?.branchChanged || snapshot.git?.isDirty) {
    observations.push({
      version: 1,
      id: `aoi-obs-workspace-git-${hashText(`${snapshot.sessionPath}:${snapshot.git.branchName}:${snapshot.git.statusSummary}`)}`,
      source: 'workspace',
      sessionPath: snapshot.sessionPath,
      createdAt: snapshot.collectedAt,
      summary: truncateText(`Workspace git signal.${branchDrift}${dirtySummary}`, 260),
      payloadRef: snapshot.evidenceRefs[0],
      memoryIds: [],
      artifactRefs: evidenceRefs,
      proposalIds: [],
      riskSignals: [
        'workspace-signal',
        ...(snapshot.git.branchChanged ? ['workspace-branch-drift'] : []),
        ...(snapshot.git.isDirty ? ['workspace-dirty-tree'] : []),
      ],
      dedupeKey: `workspace:git:${snapshot.git.branchName}:${snapshot.git.statusSummary}`,
    });
  }

  if (snapshot.validation.freshness === 'stale' || snapshot.validation.freshness === 'failed') {
    observations.push({
      version: 1,
      id: `aoi-obs-workspace-validation-${hashText(`${snapshot.sessionPath}:${snapshot.validation.freshness}:${snapshot.validation.completedAt ?? 0}`)}`,
      source: 'workspace',
      sessionPath: snapshot.sessionPath,
      createdAt: snapshot.collectedAt,
      summary: truncateText(
        `Workspace validation ${snapshot.validation.freshness}: ${
          snapshot.validation.staleReason ??
          'previous validation is no longer usable as fresh evidence'
        }.`,
        260,
      ),
      payloadRef: snapshot.evidenceRefs[0],
      memoryIds: [],
      artifactRefs: evidenceRefs,
      proposalIds: [],
      riskSignals: [
        'workspace-signal',
        `workspace-validation:${snapshot.validation.freshness}`,
        ...(snapshot.git?.isDirty ? ['workspace-dirty-tree'] : []),
      ],
      dedupeKey: `workspace:validation:${snapshot.validation.freshness}:${snapshot.validation.completedAt ?? 0}`,
    });
  }

  return observations;
}
