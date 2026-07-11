import * as fs from 'fs';
import { createHash } from 'crypto';
import { isAbsolute, join, relative, resolve } from 'path';

import { createAoiActionCheckpoint, type AoiActionCheckpoint } from './aoiActionCheckpoint';

// P2.6 (command half): give a `run_command` a real fs checkpoint.
//
// A file mutation carries an explicit target path, so aoiActionCheckpoint can
// snapshot exactly the bytes it will change. A `run_command` does not: it only
// declares the SCOPES it may touch (a file, or a directory subtree). This module
// turns those declared scopes into a bounded, concrete file list -- fail-closing
// on anything that cannot be bounded -- and records the scope boundary so a
// post-run verifier can catch a command that wrote OUTSIDE what it declared.
//
// Two halves:
//   1. buildAoiCommandTouchedScopeManifest -- validate + enumerate the declared
//      scopes into a checkpointable file list BEFORE the command runs. Fails
//      closed on: no scopes, a scope that escapes the workspace root, a scope
//      that IS the workspace root (too broad to bound), a wildcard/glob scope
//      (cannot be enumerated deterministically), a symlink scope, or an
//      enumeration that exceeds the file-count cap.
//   2. verifyAoiCommandTouchedScopeBoundary -- AFTER the command, assert every
//      changed path lies inside a declared scope. Any out-of-scope change means
//      the command's effect is not bounded by the checkpoint and must be treated
//      as an escape (do not trust the checkpoint as sufficient recovery).
//
// The checkpoint itself (byte snapshot + restore) is delegated to the existing,
// already-verified aoiActionCheckpoint, so this module only owns the bounding.

export type AoiCommandScopeBlockReason =
  | 'no_declared_scopes'
  | 'workspace_root_unresolved'
  | 'scope_escapes_workspace'
  | 'scope_is_workspace_root'
  | 'scope_not_bounded'
  | 'scope_is_symlink'
  | 'scope_too_large';

export interface AoiCommandScopeManifestScope {
  scopeLabel: string;
  kind: 'file' | 'directory' | 'absent';
  fileLabels: string[];
}

export interface AoiCommandTouchedScopeManifest {
  version: 1;
  ok: boolean;
  createdAt: number;
  workspaceRootHash: string;
  // Content-addressed over the sorted, deduped declared scope labels. Identifies
  // exactly which boundary was authorized; a later verify/checkpoint must be
  // handed the same boundary.
  boundaryHash: string;
  scopeLabels: string[];
  scopes: AoiCommandScopeManifestScope[];
  // Union of existing files under all scopes, sorted + deduped. This is exactly
  // what createAoiActionCheckpoint({ paths }) expects.
  fileLabels: string[];
  blockReasons: AoiCommandScopeBlockReason[];
}

export interface BuildAoiCommandTouchedScopeManifestParams {
  workspaceRoot: string;
  declaredScopes: string[];
  now?: number;
  // Cap the total number of existing files a scope enumeration may capture. An
  // enumeration past this is treated as unbounded and fails closed rather than
  // producing a checkpoint that cannot be cheaply restored.
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 512;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toLabel(realRoot: string, absolutePath: string): string {
  return relative(realRoot, absolutePath).replace(/\\/g, '/');
}

function isLabelInsideRoot(label: string): boolean {
  return label !== '' && !label.startsWith('..') && !isAbsolute(label);
}

function hasGlobChars(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function resolveRealRoot(workspaceRoot: string): string | null {
  try {
    return fs.realpathSync(resolve(workspaceRoot));
  } catch {
    return null;
  }
}

// Enumerate existing regular files under a directory, skipping symlinks (never
// followed -- a symlinked subtree could escape the scope). Returns null if the
// count would exceed the cap, which the caller treats as unbounded.
function enumerateDirFiles(
  absoluteDir: string,
  realRoot: string,
  remaining: { count: number },
): string[] | null {
  const out: string[] = [];
  const stack: string[] = [absoluteDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable subdirectory: skip it rather than snapshot a partial tree.
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        const label = toLabel(realRoot, entryPath);
        if (!isLabelInsideRoot(label)) {
          continue;
        }
        if (remaining.count <= 0) {
          return null;
        }
        remaining.count -= 1;
        out.push(label);
      }
    }
  }
  return out;
}

export function buildAoiCommandTouchedScopeManifest(
  params: BuildAoiCommandTouchedScopeManifestParams,
): AoiCommandTouchedScopeManifest {
  const now = params.now ?? Date.now();
  const maxFiles = params.maxFiles ?? DEFAULT_MAX_FILES;
  const realRoot = resolveRealRoot(params.workspaceRoot);
  const cleaned = Array.from(
    new Set(
      (params.declaredScopes ?? [])
        .map((scope) => (typeof scope === 'string' ? scope.trim() : ''))
        .filter((scope) => scope.length > 0),
    ),
  ).sort();

  const boundaryHash = sha256Hex(cleaned.join('\n'));
  const failed = (reasons: AoiCommandScopeBlockReason[]): AoiCommandTouchedScopeManifest => ({
    version: 1,
    ok: false,
    createdAt: now,
    workspaceRootHash: realRoot ? sha256Hex(realRoot) : '',
    boundaryHash,
    scopeLabels: cleaned,
    scopes: [],
    fileLabels: [],
    blockReasons: Array.from(new Set(reasons)),
  });

  if (!realRoot) {
    return failed(['workspace_root_unresolved']);
  }
  if (cleaned.length === 0) {
    return failed(['no_declared_scopes']);
  }

  const blockReasons: AoiCommandScopeBlockReason[] = [];
  const scopes: AoiCommandScopeManifestScope[] = [];
  const fileLabelSet = new Set<string>();
  const remaining = { count: maxFiles };

  for (const scope of cleaned) {
    if (hasGlobChars(scope)) {
      blockReasons.push('scope_not_bounded');
      continue;
    }
    const absolutePath = isAbsolute(scope) ? resolve(scope) : resolve(realRoot, scope);
    const label = toLabel(realRoot, absolutePath);
    if (label === '') {
      blockReasons.push('scope_is_workspace_root');
      continue;
    }
    if (!isLabelInsideRoot(label)) {
      blockReasons.push('scope_escapes_workspace');
      continue;
    }

    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      // The declared scope does not exist yet. A command may create it; the
      // boundary still holds (anything created under it is in-scope and can be
      // removed on rollback), so record it as an absent scope, not a failure.
      scopes.push({ scopeLabel: label, kind: 'absent', fileLabels: [] });
      continue;
    }
    if (stat.isSymbolicLink()) {
      blockReasons.push('scope_is_symlink');
      continue;
    }
    if (stat.isDirectory()) {
      const files = enumerateDirFiles(absolutePath, realRoot, remaining);
      if (files === null) {
        blockReasons.push('scope_too_large');
        continue;
      }
      files.forEach((file) => fileLabelSet.add(file));
      scopes.push({ scopeLabel: label, kind: 'directory', fileLabels: files.slice().sort() });
      continue;
    }
    // Regular file scope.
    if (remaining.count <= 0) {
      blockReasons.push('scope_too_large');
      continue;
    }
    remaining.count -= 1;
    fileLabelSet.add(label);
    scopes.push({ scopeLabel: label, kind: 'file', fileLabels: [label] });
  }

  if (blockReasons.length > 0) {
    return failed(blockReasons);
  }

  return {
    version: 1,
    ok: true,
    createdAt: now,
    workspaceRootHash: sha256Hex(realRoot),
    boundaryHash,
    scopeLabels: cleaned,
    scopes,
    fileLabels: Array.from(fileLabelSet).sort(),
    blockReasons: [],
  };
}

// Compose the bounded manifest with the byte-level checkpoint: enumerate the
// declared scopes, then snapshot every existing file so the command is
// restorable. Returns null (no checkpoint) when the scopes cannot be bounded.
export function createAoiCommandScopeCheckpoint(params: {
  workspaceRoot: string;
  declaredScopes: string[];
  now?: number;
  maxFiles?: number;
  maxBytesPerFile?: number;
  evidenceRefs?: string[];
}): { manifest: AoiCommandTouchedScopeManifest; checkpoint: AoiActionCheckpoint | null } {
  const manifest = buildAoiCommandTouchedScopeManifest(params);
  if (!manifest.ok) {
    return { manifest, checkpoint: null };
  }
  // No existing files to snapshot (all scopes absent): the boundary is still
  // authorized, and rollback of a pure create is a delete handled by the
  // boundary verifier + caller. Return an empty-but-ok checkpoint marker of null
  // so the caller knows there was nothing to snapshot.
  if (manifest.fileLabels.length === 0) {
    return { manifest, checkpoint: null };
  }
  const checkpoint = createAoiActionCheckpoint({
    workspaceRoot: params.workspaceRoot,
    paths: manifest.fileLabels,
    now: params.now,
    maxBytesPerFile: params.maxBytesPerFile,
    evidenceRefs: [
      `aoi-command-boundary:${manifest.boundaryHash.slice(0, 16)}`,
      ...(params.evidenceRefs ?? []),
    ],
  });
  return { manifest, checkpoint };
}

export interface AoiCommandScopeBoundaryResult {
  version: 1;
  ok: boolean;
  inScope: string[];
  outOfScope: string[];
}

function normalizeChangedLabel(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function isLabelUnderScope(changedLabel: string, scope: AoiCommandScopeManifestScope): boolean {
  if (scope.kind === 'file') {
    return changedLabel === scope.scopeLabel;
  }
  // directory or absent: the label must be the scope itself or nested under it.
  return changedLabel === scope.scopeLabel || changedLabel.startsWith(`${scope.scopeLabel}/`);
}

// AFTER the command runs, assert every changed path lies within a declared
// scope. Any out-of-scope change is an escape: the checkpoint does not cover it,
// so the caller must fail closed (broader recovery / do not mark the command as
// safely reverted).
export function verifyAoiCommandTouchedScopeBoundary(params: {
  manifest: AoiCommandTouchedScopeManifest;
  changedLabels: string[];
}): AoiCommandScopeBoundaryResult {
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  const scopes = params.manifest.scopes;
  for (const raw of params.changedLabels ?? []) {
    const label = normalizeChangedLabel(raw);
    if (label === '') {
      continue;
    }
    // A manifest that never bounded (ok === false) treats every change as escape.
    const covered = params.manifest.ok && scopes.some((scope) => isLabelUnderScope(label, scope));
    if (covered) {
      inScope.push(label);
    } else {
      outOfScope.push(label);
    }
  }
  return {
    version: 1,
    ok: outOfScope.length === 0,
    inScope: Array.from(new Set(inScope)).sort(),
    outOfScope: Array.from(new Set(outOfScope)).sort(),
  };
}
