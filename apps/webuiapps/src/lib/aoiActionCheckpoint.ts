import * as fs from 'fs';
import { createHash } from 'crypto';
import { dirname, isAbsolute, relative, resolve } from 'path';
import type { AoiApprovalSandboxPreviewInput } from './aoiApprovalSandbox';

// Server-side (Node fs) checkpoint/rollback for Aoi autonomy file mutations.
//
// This is the recovery prerequisite for any real file_write / file_patch /
// file_delete capability: before a mutation runs, snapshot the exact pre-change
// byte state of every target path; on failure or undo, restore it.
//
// Invariant: if createAoiActionCheckpoint returns a checkpoint, that checkpoint
// is fully restorable. Anything that would make rollback unreliable (a path that
// escapes the workspace root, a directory target, a symlink, an unreadable or
// oversized file) fails closed by throwing AoiActionCheckpointError. The caller
// must treat a thrown checkpoint as "do not mutate".
//
// This module is intentionally pure: createAoiActionCheckpoint returns a
// serializable object and rollbackAoiActionCheckpoint consumes one. Persistence
// (for cross-turn undo) and audit wrapping are the responsibility of the
// execution layer, which already owns the sessions store and audit log.

export type AoiActionCheckpointErrorCode =
  | 'no_paths'
  | 'workspace_root_unresolved'
  | 'path_escapes_workspace'
  | 'path_is_workspace_root'
  | 'path_is_directory'
  | 'path_is_symlink'
  | 'symlink_ancestor_escape'
  | 'file_too_large'
  | 'read_failed';

export class AoiActionCheckpointError extends Error {
  readonly code: AoiActionCheckpointErrorCode;
  readonly pathLabel?: string;

  constructor(code: AoiActionCheckpointErrorCode, message: string, pathLabel?: string) {
    super(message);
    this.name = 'AoiActionCheckpointError';
    this.code = code;
    if (pathLabel) {
      this.pathLabel = pathLabel;
    }
  }
}

export interface AoiActionCheckpointEntry {
  version: 1;
  // Workspace-relative, forward-slash path label. Never an absolute path so the
  // checkpoint can be persisted without leaking the host layout.
  pathLabel: string;
  pathHash: string;
  existedBefore: boolean;
  // Directory labels (deepest first) that did not exist at capture time and
  // would be created by a write to this path. Used to clean up after deleting a
  // file that the mutation created.
  createdDirLabels: string[];
  // Snapshot of the original bytes, present only when existedBefore is true.
  encoding?: 'base64';
  content?: string;
  byteLength?: number;
  sha256?: string;
}

export interface AoiActionCheckpoint {
  version: 1;
  id: string;
  createdAt: number;
  // sha256 of the realpath'd workspace root. Rollback must be handed the same
  // root; a mismatch fails closed before any file is touched.
  workspaceRootHash: string;
  entries: AoiActionCheckpointEntry[];
  evidenceRefs: string[];
}

export interface CreateAoiActionCheckpointParams {
  workspaceRoot: string;
  paths: string[];
  now?: number;
  // Per-file cap. A target larger than this fails closed rather than producing a
  // checkpoint that cannot be cheaply restored.
  maxBytesPerFile?: number;
  evidenceRefs?: string[];
}

export type AoiActionCheckpointRollbackOutcome = 'restored' | 'deleted' | 'unchanged' | 'failed';

export interface AoiActionCheckpointRollbackEntryResult {
  pathLabel: string;
  outcome: AoiActionCheckpointRollbackOutcome;
  reason?: string;
}

export interface AoiActionCheckpointRollbackResult {
  version: 1;
  ok: boolean;
  checkpointId: string;
  restoredAt: number;
  restoredCount: number;
  deletedCount: number;
  failedCount: number;
  entries: AoiActionCheckpointRollbackEntryResult[];
  blockedReasons: string[];
  evidenceRefs: string[];
}

export interface RollbackAoiActionCheckpointParams {
  workspaceRoot: string;
  now?: number;
}

const DEFAULT_MAX_BYTES_PER_FILE = 8 * 1024 * 1024;

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

function toLabel(realRoot: string, absolutePath: string): string {
  return relative(realRoot, absolutePath).replace(/\\/g, '/');
}

function isLabelInsideRoot(label: string): boolean {
  return label !== '' && !label.startsWith('..') && !isAbsolute(label);
}

function resolveRealRoot(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot);
  try {
    return fs.realpathSync(resolved);
  } catch {
    throw new AoiActionCheckpointError(
      'workspace_root_unresolved',
      'Workspace root could not be resolved on disk.',
    );
  }
}

function nearestExistingAncestor(target: string): string {
  let current = dirname(target);
  // Guard against an unbounded climb on a malformed path.
  for (let guard = 0; guard < 4096; guard += 1) {
    if (fs.existsSync(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

// Reject any target whose nearest existing ancestor escapes the workspace root
// once symlinks are resolved. path.resolve does not follow symlinks, so a
// symlinked parent directory could otherwise point outside the root.
function assertAncestorInsideRoot(realRoot: string, target: string, label: string): void {
  const ancestor = nearestExistingAncestor(target);
  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch {
    throw new AoiActionCheckpointError(
      'read_failed',
      `Failed to resolve ancestor for ${label}.`,
      label,
    );
  }
  const ancestorLabel = relative(realRoot, realAncestor).replace(/\\/g, '/');
  if (ancestorLabel !== '' && (ancestorLabel.startsWith('..') || isAbsolute(ancestorLabel))) {
    throw new AoiActionCheckpointError(
      'symlink_ancestor_escape',
      `Resolved ancestor of ${label} escapes the workspace root.`,
      label,
    );
  }
}

function ancestorsToCreate(realRoot: string, target: string): string[] {
  const labels: string[] = [];
  let current = dirname(target);
  for (let guard = 0; guard < 4096; guard += 1) {
    if (fs.existsSync(current)) {
      break;
    }
    const label = relative(realRoot, current).replace(/\\/g, '/');
    if (!isLabelInsideRoot(label)) {
      break;
    }
    labels.push(label);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  // Deepest first so rollback removes child directories before their parents.
  return labels;
}

function resolveTargetOrThrow(
  realRoot: string,
  inputPath: string,
): { absolutePath: string; label: string } {
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(realRoot, inputPath);
  const label = toLabel(realRoot, absolutePath);
  if (label === '') {
    throw new AoiActionCheckpointError(
      'path_is_workspace_root',
      'Checkpoint targets must be files, not the workspace root.',
    );
  }
  if (!isLabelInsideRoot(label)) {
    throw new AoiActionCheckpointError(
      'path_escapes_workspace',
      `Checkpoint target escapes the workspace root: ${inputPath}`,
      label,
    );
  }
  return { absolutePath, label };
}

function captureEntry(
  realRoot: string,
  absolutePath: string,
  label: string,
  maxBytes: number,
): AoiActionCheckpointEntry {
  const pathHash = shortHash(label);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      stat = null;
    } else {
      throw new AoiActionCheckpointError('read_failed', `Failed to stat ${label}.`, label);
    }
  }

  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new AoiActionCheckpointError(
        'path_is_symlink',
        `Refusing to snapshot a symlink: ${label}`,
        label,
      );
    }
    if (stat.isDirectory()) {
      throw new AoiActionCheckpointError(
        'path_is_directory',
        `Checkpoint targets must be files, not directories: ${label}`,
        label,
      );
    }
    if (stat.size > maxBytes) {
      throw new AoiActionCheckpointError(
        'file_too_large',
        `File ${label} (${stat.size} bytes) exceeds the checkpoint cap of ${maxBytes} bytes.`,
        label,
      );
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolutePath);
    } catch {
      throw new AoiActionCheckpointError('read_failed', `Failed to read ${label}.`, label);
    }
    return {
      version: 1,
      pathLabel: label,
      pathHash,
      existedBefore: true,
      createdDirLabels: [],
      encoding: 'base64',
      content: buffer.toString('base64'),
      byteLength: buffer.byteLength,
      sha256: sha256Hex(buffer),
    };
  }

  return {
    version: 1,
    pathLabel: label,
    pathHash,
    existedBefore: false,
    createdDirLabels: ancestorsToCreate(realRoot, absolutePath),
  };
}

export function createAoiActionCheckpoint(
  params: CreateAoiActionCheckpointParams,
): AoiActionCheckpoint {
  const now = params.now ?? Date.now();
  const maxBytes = params.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const realRoot = resolveRealRoot(params.workspaceRoot);

  const cleaned = params.paths
    .map((path) => (typeof path === 'string' ? path.trim() : ''))
    .filter((path) => path.length > 0);
  if (cleaned.length === 0) {
    throw new AoiActionCheckpointError('no_paths', 'Checkpoint requires at least one target path.');
  }

  const entries: AoiActionCheckpointEntry[] = [];
  const seenLabels = new Set<string>();
  for (const inputPath of cleaned) {
    const { absolutePath, label } = resolveTargetOrThrow(realRoot, inputPath);
    if (seenLabels.has(label)) {
      continue;
    }
    seenLabels.add(label);
    assertAncestorInsideRoot(realRoot, absolutePath, label);
    entries.push(captureEntry(realRoot, absolutePath, label, maxBytes));
  }

  const workspaceRootHash = sha256Hex(realRoot);
  const id = `aoi-action-checkpoint-${now.toString(36)}-${shortHash(
    `${workspaceRootHash}:${entries.map((entry) => `${entry.pathHash}:${entry.sha256 ?? 'absent'}`).join('|')}:${now}`,
  )}`;
  const evidenceRefs = [
    ...new Set([`aoi-action-checkpoint:${id}`, ...(params.evidenceRefs ?? [])]),
  ].slice(0, 24);

  return {
    version: 1,
    id,
    createdAt: now,
    workspaceRootHash,
    entries,
    evidenceRefs,
  };
}

function rollbackEntry(
  realRoot: string,
  entry: AoiActionCheckpointEntry,
): AoiActionCheckpointRollbackEntryResult {
  const absolutePath = resolve(realRoot, entry.pathLabel);
  const label = toLabel(realRoot, absolutePath);
  if (!isLabelInsideRoot(label)) {
    return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'path_escapes_workspace' };
  }

  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'stat_failed' };
    }
  }
  // Never write through a symlink that appeared after capture; it could escape.
  if (stat && stat.isSymbolicLink()) {
    return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'unexpected_symlink' };
  }
  // Re-validate ANCESTORS too (capture-time check at assertAncestorInsideRoot): a
  // parent directory that became a symlink AFTER capture would be silently
  // followed by mkdirSync/writeFileSync below, redirecting the restore write
  // outside the workspace root. Rollback must re-check the same TOCTOU window.
  try {
    assertAncestorInsideRoot(realRoot, absolutePath, entry.pathLabel);
  } catch {
    return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'path_escapes_workspace' };
  }

  if (entry.existedBefore) {
    if (typeof entry.content !== 'string') {
      return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'snapshot_content_missing' };
    }
    if (stat && stat.isDirectory()) {
      return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'unexpected_directory' };
    }
    const buffer = Buffer.from(entry.content, entry.encoding ?? 'base64');
    try {
      fs.mkdirSync(dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, buffer);
    } catch {
      return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'write_failed' };
    }
    if (entry.sha256) {
      try {
        const after = fs.readFileSync(absolutePath);
        if (sha256Hex(after) !== entry.sha256) {
          return {
            pathLabel: entry.pathLabel,
            outcome: 'failed',
            reason: 'restore_verification_failed',
          };
        }
      } catch {
        return {
          pathLabel: entry.pathLabel,
          outcome: 'failed',
          reason: 'restore_verification_failed',
        };
      }
    }
    return { pathLabel: entry.pathLabel, outcome: 'restored' };
  }

  // The file did not exist at capture time. Undo a create by removing it, then
  // clean up any directories the mutation created.
  if (!stat) {
    return { pathLabel: entry.pathLabel, outcome: 'unchanged' };
  }
  if (stat.isDirectory()) {
    return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'unexpected_directory' };
  }
  try {
    fs.unlinkSync(absolutePath);
  } catch {
    return { pathLabel: entry.pathLabel, outcome: 'failed', reason: 'delete_failed' };
  }
  for (const dirLabel of entry.createdDirLabels) {
    if (!isLabelInsideRoot(dirLabel)) {
      continue;
    }
    const dirPath = resolve(realRoot, dirLabel);
    try {
      // rmdir fails if the directory is not empty; that is the desired guard.
      fs.rmdirSync(dirPath);
    } catch {
      // Directory is non-empty or already gone. Leave it; this is best effort.
    }
  }
  return { pathLabel: entry.pathLabel, outcome: 'deleted' };
}

export function rollbackAoiActionCheckpoint(
  checkpoint: AoiActionCheckpoint,
  params: RollbackAoiActionCheckpointParams,
): AoiActionCheckpointRollbackResult {
  const restoredAt = params.now ?? Date.now();
  const baseResult = {
    version: 1 as const,
    checkpointId: checkpoint.id,
    restoredAt,
    evidenceRefs: [
      ...new Set([`aoi-action-checkpoint:${checkpoint.id}`, ...checkpoint.evidenceRefs]),
    ].slice(0, 24),
  };

  let realRoot: string;
  try {
    realRoot = resolveRealRoot(params.workspaceRoot);
  } catch {
    return {
      ...baseResult,
      ok: false,
      restoredCount: 0,
      deletedCount: 0,
      failedCount: 0,
      entries: [],
      blockedReasons: ['workspace_root_unresolved'],
    };
  }

  // Fail closed before touching any file if the root does not match the one the
  // checkpoint was captured against.
  if (sha256Hex(realRoot) !== checkpoint.workspaceRootHash) {
    return {
      ...baseResult,
      ok: false,
      restoredCount: 0,
      deletedCount: 0,
      failedCount: 0,
      entries: [],
      blockedReasons: ['workspace_root_mismatch'],
    };
  }

  const entries = checkpoint.entries.map((entry) => rollbackEntry(realRoot, entry));
  const restoredCount = entries.filter((entry) => entry.outcome === 'restored').length;
  const deletedCount = entries.filter((entry) => entry.outcome === 'deleted').length;
  const failedCount = entries.filter((entry) => entry.outcome === 'failed').length;

  return {
    ...baseResult,
    ok: failedCount === 0,
    restoredCount,
    deletedCount,
    failedCount,
    entries,
    blockedReasons: [],
  };
}

// Tie a captured checkpoint into the approval-sandbox recovery/rollback fields.
// Spreading the result into an AoiApprovalSandboxPreviewInput drives the preview
// recovery plan to kind 'before_snapshot' (available) and marks rollback as
// required with real evidence, so hasAoiApprovalSandboxRecoveryEvidence passes.
export function buildAoiApprovalSandboxRecoveryFromCheckpoint(
  checkpoint: AoiActionCheckpoint,
): Pick<AoiApprovalSandboxPreviewInput, 'beforeSnapshotRef' | 'recoveryPlan' | 'rollback'> {
  const beforeSnapshotRef = `aoi-action-checkpoint:${checkpoint.id}`;
  const fileCount = checkpoint.entries.length;
  const restoreCount = checkpoint.entries.filter((entry) => entry.existedBefore).length;
  const createCount = fileCount - restoreCount;
  return {
    beforeSnapshotRef,
    recoveryPlan: {
      kind: 'before_snapshot',
      available: true,
      summary: `Pre-change snapshot of ${fileCount} file(s): ${restoreCount} restorable, ${createCount} to be removed on rollback.`,
      evidenceRefs: checkpoint.evidenceRefs,
    },
    rollback: {
      required: true,
      note: `Rollback restores ${restoreCount} file(s) and deletes ${createCount} newly created file(s) from checkpoint ${checkpoint.id}.`,
      evidenceRefs: checkpoint.evidenceRefs,
    },
  };
}
