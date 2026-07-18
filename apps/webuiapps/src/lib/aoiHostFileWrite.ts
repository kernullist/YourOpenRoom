// Aoi host-bridge filesystem write (HP3b): let Aoi create/overwrite a file, but
// ONLY inside operator-registered WRITE roots and only with a content-addressed
// approval (docs/aoi-host-access-design.md). Delete is NOT here -- it is
// deferred to the final roadmap step (irreversible last).
//
// Safety posture (load-bearing):
//   - SEPARATE WRITE ROOTS: writing is more dangerous than reading, so it has
//     its own consent list (host-bridge/write-roots.json), independent of the
//     read roots. An unregistered path is never writable.
//   - PARENT-BASED REALPATH GUARD (T4): a write target may not exist yet, so the
//     PARENT directory is realpathed and checked inside a realpathed root; and
//     if the target already exists, IT is realpathed and re-checked -- this
//     rejects both a symlinked parent and an overwrite-through-symlink escape.
//     The basename is rejected if it contains a separator or "..".
//   - CONTENT-ADDRESSED APPROVAL: the exact { path, contentHash } is
//     fingerprinted via the approval sandbox; the runner re-verifies it, so an
//     approval for one write can never apply different bytes or a different path.
//   - ATOMIC: a temp file in the same directory is renamed into place, so a
//     crash never leaves a half-written file.
//   - The HP0 gate (auth + kill switch capability `os_file_write` + approval) is
//     enforced by the caller; this re-checks the approval as defense in depth
//     and audits every attempt.
//
// Server-only (fs / crypto). The path guard + policy are unit-tested with an
// injectable realpath; the runner is exercised over a real temp root.
import * as fs from 'fs';
import { basename, dirname, isAbsolute, resolve } from 'path';
import { createHash, randomUUID } from 'crypto';
import { isAoiPathInsideRoot, type AoiHostRealpathImpl } from './aoiHostFileRead';
import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
  type AoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';

export const AOI_HOST_FILE_WRITE_CAPABILITY = 'os_file_write';
export const AOI_HOST_FILE_WRITE_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const AOI_HOST_FILE_WRITE_IRREVERSIBLE = true;

const HOST_BRIDGE_DIR = 'host-bridge';
const WRITE_ROOTS_FILE = 'write-roots.json';
const MAX_ROOTS = 32;
const MAX_PATH_CHARS = 4096;
const MAX_WRITE_BYTES = 1024 * 1024;
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type AoiHostFileWriteDenyReason =
  | 'missing_path'
  | 'path_not_absolute'
  | 'path_too_long'
  | 'unsafe_basename'
  | 'no_consent_roots'
  | 'parent_not_found'
  | 'outside_consent_roots'
  | 'target_is_directory'
  | 'content_too_large'
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_fingerprint_changed'
  | 'approval_preview_changed'
  | 'write_failed';

export interface AoiHostWriteRoot {
  id: string;
  label: string;
  path: string;
}

export interface AoiHostWriteRootsConfig {
  version: 1;
  roots: AoiHostWriteRoot[];
  updatedAt: number;
}

export const DEFAULT_AOI_HOST_WRITE_ROOTS: AoiHostWriteRootsConfig = {
  version: 1,
  roots: [],
  updatedAt: 0,
};

export interface AoiHostFileWriteRequest {
  requestedPath: string;
  content: string;
  purpose?: string;
  requestedAt: number;
  evidenceRefs?: string[];
}

export interface AoiHostFileWritePolicy {
  version: 1;
  allowed: boolean;
  blockReasons: AoiHostFileWriteDenyReason[];
  resolvedPath: string;
  rootId: string;
  willOverwrite: boolean;
  byteLength: number;
  contentHash: string;
  purpose: string;
  requiredAutonomyLevel: 'L5';
  approvalFingerprint: string;
  approvalSandbox: AoiApprovalSandboxPreview;
  expiresAt: number;
}

export interface AoiHostFileWriteAuditRecord {
  version: 1;
  id: string;
  resolvedPath: string;
  rootId: string;
  willOverwrite: boolean;
  byteLength: number;
  contentHash: string;
  purpose: string;
  allowed: boolean;
  blockReasons: AoiHostFileWriteDenyReason[];
  startedAt: number;
  wrote: boolean;
  approvalFingerprint: string;
  evidenceRefs: string[];
}

export interface AoiHostFileWriteResult {
  version: 1;
  ok: boolean;
  resolvedPath: string;
  wrote: boolean;
  blockReasons: AoiHostFileWriteDenyReason[];
  auditRecord: AoiHostFileWriteAuditRecord;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isSafeAbsolutePath(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    isAbsolute(value)
  );
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 32);
}

// --- Write-roots config (pure + fs) ------------------------------------------

export function normalizeAoiHostWriteRoots(raw: unknown): AoiHostWriteRootsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_HOST_WRITE_ROOTS, roots: [] };
  }
  const value = raw as Partial<AoiHostWriteRootsConfig>;
  if (value.version !== 1 || !Array.isArray(value.roots)) {
    return { ...DEFAULT_AOI_HOST_WRITE_ROOTS, roots: [] };
  }
  const roots: AoiHostWriteRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of value.roots) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    const root = candidate as Partial<AoiHostWriteRoot>;
    const id = typeof root.id === 'string' ? root.id : '';
    const path = typeof root.path === 'string' ? root.path : '';
    if (!ROOT_ID_PATTERN.test(id) || seen.has(id) || !isSafeAbsolutePath(path)) {
      continue;
    }
    roots.push({
      id,
      label:
        normalizeWhitespace(typeof root.label === 'string' ? root.label : id).slice(0, 120) || id,
      path,
    });
    seen.add(id);
    if (roots.length >= MAX_ROOTS) {
      break;
    }
  }
  return {
    version: 1,
    roots,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

export function addAoiHostWriteRoot(
  config: AoiHostWriteRootsConfig | null | undefined,
  root: { id: string; label?: string; path: string },
  now: number,
): { config: AoiHostWriteRootsConfig; added: boolean; reason?: string } {
  const base = normalizeAoiHostWriteRoots(config);
  if (!ROOT_ID_PATTERN.test(root.id)) {
    return { config: base, added: false, reason: 'invalid_id' };
  }
  if (!isSafeAbsolutePath(root.path)) {
    return { config: base, added: false, reason: 'invalid_path' };
  }
  if (base.roots.every((existing) => existing.id !== root.id) && base.roots.length >= MAX_ROOTS) {
    return { config: base, added: false, reason: 'roots_full' };
  }
  const nextRoot: AoiHostWriteRoot = {
    id: root.id,
    label: normalizeWhitespace(root.label ?? root.id).slice(0, 120) || root.id,
    path: root.path,
  };
  const roots = [...base.roots.filter((existing) => existing.id !== root.id), nextRoot];
  return { config: { version: 1, roots, updatedAt: now }, added: true };
}

export function removeAoiHostWriteRoot(
  config: AoiHostWriteRootsConfig | null | undefined,
  id: string,
  now: number,
): AoiHostWriteRootsConfig {
  const base = normalizeAoiHostWriteRoots(config);
  const roots = base.roots.filter((root) => root.id !== id);
  return {
    version: 1,
    roots,
    updatedAt: roots.length === base.roots.length ? base.updatedAt : now,
  };
}

export function resolveAoiHostWriteRootsPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, WRITE_ROOTS_FILE);
}

export function loadAoiHostWriteRoots(openroomHome: string): AoiHostWriteRootsConfig {
  try {
    const filePath = resolveAoiHostWriteRootsPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_HOST_WRITE_ROOTS, roots: [] };
    }
    return normalizeAoiHostWriteRoots(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_HOST_WRITE_ROOTS, roots: [] };
  }
}

export function saveAoiHostWriteRoots(
  openroomHome: string,
  config: AoiHostWriteRootsConfig,
): AoiHostWriteRootsConfig {
  const normalized = normalizeAoiHostWriteRoots(config);
  const filePath = resolveAoiHostWriteRootsPath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}

// --- Parent-based realpath resolution (the security core) --------------------

export interface AoiHostWriteTargetResolution {
  ok: boolean;
  resolvedPath?: string;
  rootId?: string;
  exists?: boolean;
  reason?: AoiHostFileWriteDenyReason;
}

export function resolveAoiHostWriteTarget(params: {
  roots: readonly AoiHostWriteRoot[];
  requestedPath: string;
  realpathImpl?: AoiHostRealpathImpl;
  existsImpl?: (path: string) => boolean;
}): AoiHostWriteTargetResolution {
  const requested = params.requestedPath;
  if (typeof requested !== 'string' || requested.length === 0) {
    return { ok: false, reason: 'missing_path' };
  }
  if (requested.length > MAX_PATH_CHARS) {
    return { ok: false, reason: 'path_too_long' };
  }
  if (!isAbsolute(requested)) {
    return { ok: false, reason: 'path_not_absolute' };
  }
  const absolute = resolve(requested);
  const name = basename(absolute);
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return { ok: false, reason: 'unsafe_basename' };
  }
  if (params.roots.length === 0) {
    return { ok: false, reason: 'no_consent_roots' };
  }
  const realpathImpl = params.realpathImpl ?? ((target: string) => fs.realpathSync.native(target));
  const existsImpl = params.existsImpl ?? ((path: string) => fs.existsSync(path));

  // The PARENT must exist and resolve inside a root -- we never auto-create
  // arbitrary directory trees, and the parent's realpath is the real anchor.
  let resolvedParent: string;
  try {
    resolvedParent = realpathImpl(dirname(absolute));
  } catch {
    return { ok: false, reason: 'parent_not_found' };
  }
  const resolvedTarget = resolve(resolvedParent, name);
  const exists = existsImpl(absolute);

  // If the target already exists, re-check ITS realpath too, so an
  // overwrite-through-symlink cannot escape the root.
  let effectiveTarget = resolvedTarget;
  if (exists) {
    try {
      effectiveTarget = realpathImpl(absolute);
    } catch {
      effectiveTarget = resolvedTarget;
    }
  }

  for (const root of params.roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = realpathImpl(resolve(root.path));
    } catch {
      continue;
    }
    if (
      isAoiPathInsideRoot(resolvedRoot, resolvedTarget) &&
      isAoiPathInsideRoot(resolvedRoot, effectiveTarget)
    ) {
      return { ok: true, resolvedPath: resolvedTarget, rootId: root.id, exists };
    }
  }
  return { ok: false, reason: 'outside_consent_roots' };
}

// --- Policy (pure) -----------------------------------------------------------

export function evaluateAoiHostFileWritePolicy(params: {
  request: AoiHostFileWriteRequest;
  roots: readonly AoiHostWriteRoot[];
  realpathImpl?: AoiHostRealpathImpl;
  existsImpl?: (path: string) => boolean;
}): AoiHostFileWritePolicy {
  const request = params.request;
  const purpose =
    normalizeWhitespace(request.purpose ?? '').slice(0, 180) || 'Write a file in a consent root.';
  const evidenceRefs = [...new Set(request.evidenceRefs ?? [])].slice(0, 16);
  const content = typeof request.content === 'string' ? request.content : '';
  const byteLength = Buffer.byteLength(content, 'utf-8');
  const contentHash = hashContent(content);
  const reasons: AoiHostFileWriteDenyReason[] = [];

  const resolution = resolveAoiHostWriteTarget({
    roots: params.roots,
    requestedPath: request.requestedPath,
    ...(params.realpathImpl ? { realpathImpl: params.realpathImpl } : {}),
    ...(params.existsImpl ? { existsImpl: params.existsImpl } : {}),
  });
  if (!resolution.ok && resolution.reason) {
    reasons.push(resolution.reason);
  }
  if (byteLength > MAX_WRITE_BYTES) {
    reasons.push('content_too_large');
  }
  const resolvedPath = resolution.resolvedPath ?? '';
  const rootId = resolution.rootId ?? '';
  const willOverwrite = resolution.exists === true;

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'workspace',
    targetId: `host-write:${resolvedPath || request.requestedPath}`,
    intendedMutation: willOverwrite
      ? `Overwrite file "${resolvedPath}" (${byteLength} bytes).`
      : `Create file "${resolvedPath}" (${byteLength} bytes).`,
    dryRunSummary: `Would write ${byteLength} bytes to "${resolvedPath}" (overwrite=${willOverwrite}, sha=${contentHash}).`,
    requiredAuthorityDecisionId: `host-write:${rootId}:${contentHash}`,
    expectedMutationCount: 1,
    recoveryPlan: {
      kind: 'manual_recovery',
      available: true,
      summary: willOverwrite
        ? 'Overwrite replaces existing content; restore from a prior copy if the change is wrong.'
        : 'A newly created file can be removed to reverse this write.',
      evidenceRefs,
    },
    rollback: {
      required: true,
      note: 'No automatic rollback: a wrong write is undone by restoring or removing the file.',
      evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: 'Record the written path, byte length, and content hash in the write audit.',
      check: 'Write audit receipt is recorded after execution.',
      evidenceRefs,
    },
    command: `write ${resolvedPath} sha=${contentHash} overwrite=${willOverwrite}`,
    evidenceRefs,
  });
  const blockReasons = [...new Set(reasons)];
  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    resolvedPath,
    rootId,
    willOverwrite,
    byteLength,
    contentHash,
    purpose,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_HOST_FILE_WRITE_APPROVAL_TTL_MS,
  };
}

export function compareAoiHostWriteApproval(params: {
  approved: AoiApprovalSandboxPreview | null | undefined;
  current: AoiHostFileWritePolicy;
  approvedExpiresAt: number | null | undefined;
  now: number;
}): AoiHostFileWriteDenyReason[] {
  if (!params.approved) {
    return ['approval_missing'];
  }
  if (typeof params.approvedExpiresAt === 'number' && params.approvedExpiresAt < params.now) {
    return ['approval_expired'];
  }
  const sandboxReasons = compareAoiApprovalSandboxPreviews({
    approved: params.approved,
    current: params.current.approvalSandbox,
  });
  if (sandboxReasons.length === 0) {
    return [];
  }
  return sandboxReasons.includes('approval_fingerprint_changed')
    ? ['approval_fingerprint_changed']
    : ['approval_preview_changed'];
}

// --- Runner (effectful) ------------------------------------------------------

function makeWriteAuditId(rootId: string, startedAt: number): string {
  return `aoi-host-write-${startedAt.toString(36)}-${randomUUID().slice(0, 8)}-${rootId || 'x'}`;
}

function blockedWriteResult(
  policy: AoiHostFileWritePolicy,
  blockReasons: AoiHostFileWriteDenyReason[],
  startedAt: number,
): AoiHostFileWriteResult {
  const auditRecord: AoiHostFileWriteAuditRecord = {
    version: 1,
    id: makeWriteAuditId(policy.rootId, startedAt),
    resolvedPath: policy.resolvedPath,
    rootId: policy.rootId,
    willOverwrite: policy.willOverwrite,
    byteLength: policy.byteLength,
    contentHash: policy.contentHash,
    purpose: policy.purpose,
    allowed: false,
    blockReasons: [...new Set(blockReasons)],
    startedAt,
    wrote: false,
    approvalFingerprint: policy.approvalFingerprint,
    evidenceRefs: policy.approvalSandbox.evidenceRefs,
  };
  return {
    version: 1,
    ok: false,
    resolvedPath: policy.resolvedPath,
    wrote: false,
    blockReasons: auditRecord.blockReasons,
    auditRecord,
  };
}

export interface RunAoiHostFileWriteOptions {
  request: AoiHostFileWriteRequest;
  roots: readonly AoiHostWriteRoot[];
  approvedSandbox: AoiApprovalSandboxPreview | null | undefined;
  approvedExpiresAt?: number | null;
  now?: number;
  realpathImpl?: AoiHostRealpathImpl;
}

// Atomically write the approved content to the resolved path (temp + rename in
// the target directory). Re-verifies the approval fingerprint first. The caller
// must already have passed the HP0 gate.
export function runAoiHostFileWrite(options: RunAoiHostFileWriteOptions): AoiHostFileWriteResult {
  const startedAt = options.now ?? Date.now();
  const policy = evaluateAoiHostFileWritePolicy({
    request: options.request,
    roots: options.roots,
    ...(options.realpathImpl ? { realpathImpl: options.realpathImpl } : {}),
  });
  const approvalReasons = compareAoiHostWriteApproval({
    approved: normalizeAoiApprovalSandboxPreview(options.approvedSandbox),
    current: policy,
    approvedExpiresAt: options.approvedExpiresAt,
    now: startedAt,
  });
  const blockReasons = [...policy.blockReasons, ...approvalReasons];
  if (blockReasons.length > 0 || !policy.resolvedPath) {
    return blockedWriteResult(policy, blockReasons, startedAt);
  }

  try {
    const targetDir = dirname(policy.resolvedPath);
    const tmpPath = `${policy.resolvedPath}.${process.pid}.${randomUUID().slice(0, 8)}.aoitmp`;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tmpPath, options.request.content, { encoding: 'utf-8' });
    fs.renameSync(tmpPath, policy.resolvedPath);
    const auditRecord: AoiHostFileWriteAuditRecord = {
      version: 1,
      id: makeWriteAuditId(policy.rootId, startedAt),
      resolvedPath: policy.resolvedPath,
      rootId: policy.rootId,
      willOverwrite: policy.willOverwrite,
      byteLength: policy.byteLength,
      contentHash: policy.contentHash,
      purpose: policy.purpose,
      allowed: true,
      blockReasons: [],
      startedAt,
      wrote: true,
      approvalFingerprint: policy.approvalFingerprint,
      evidenceRefs: policy.approvalSandbox.evidenceRefs,
    };
    return {
      version: 1,
      ok: true,
      resolvedPath: policy.resolvedPath,
      wrote: true,
      blockReasons: [],
      auditRecord,
    };
  } catch {
    return blockedWriteResult(policy, ['write_failed'], startedAt);
  }
}
