import {
  compareAoiApprovalSandboxPreviews,
  createAoiApprovalSandboxPreview,
  normalizeAoiApprovalSandboxPreview,
} from './aoiApprovalSandbox';
import type {
  AoiApprovedFileMutationPolicy,
  AoiApprovedFileMutationRequest,
  AoiAutonomyRisk,
  AoiFileMutationBlockReason,
  AoiFileMutationOperation,
  AoiFileMutationPatchOp,
  AoiFileMutationValidationPlan,
} from './aoiAutonomyTypes';

// Policy + content-addressed approval fingerprint for approved Aoi file
// mutations (file_write / file_patch). This is the file analog of
// aoiApprovedCommandPolicy.ts. The fingerprint is derived only from the
// operation, normalized relative path, and content/patch bytes -- never from a
// specific checkpoint -- so it is stable between accept and execute. The
// pre-change checkpoint is captured by the runner at apply time.

export const AOI_FILE_MUTATION_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const AOI_MAX_FILE_MUTATION_CONTENT_BYTES = 256 * 1024;
export const AOI_MAX_FILE_MUTATION_PATCH_OPS = 32;
export const AOI_MAX_FILE_MUTATION_PATCH_BYTES = 256 * 1024;

const MAX_PURPOSE_CHARS = 180;
const SAFE_RELATIVE_FILE_PATH = /^[A-Za-z0-9._/-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', '.ssh', '.aws']);

// Browser-safe hashing. This module is reachable from the client bundle via
// aoiAutonomyPolicy, so it must not import Node 'crypto' (the approved-command
// policy and approval sandbox use the same FNV approach for the same reason).
function hashStable(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Browser-safe UTF-8 byte length. Do NOT use Node Buffer here: this policy is
// evaluated in the Settings / ChatPanel client bundle (Buffer is undefined).
const utf8TextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function utf8ByteLength(value: string): number {
  if (utf8TextEncoder) {
    return utf8TextEncoder.encode(value).byteLength;
  }

  // Manual UTF-8 size for environments without TextEncoder (should be rare).
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair -> 4 UTF-8 bytes.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// Wider (64-bit) content hash from two independent FNV-1a passes, so the
// content-addressed approval binding has a low collision rate without 'crypto'.
// Exported so the runner verifies a write against the exact same digest.
export function hashAoiFileMutationContent(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x5bd1e995) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePurpose(value: unknown): string {
  const purpose =
    typeof value === 'string' ? normalizeWhitespace(value).slice(0, MAX_PURPOSE_CHARS) : '';
  return purpose || 'Apply an approved Aoi file mutation.';
}

export function normalizeAoiFileMutationPath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const replaced = value.trim().replace(/\\/g, '/');
  // Strip a leading "./" and trailing slashes, but never strip a leading "/":
  // an absolute path must stay detectable so it can be rejected.
  return replaced.replace(/^\.\/+/, '').replace(/\/+$/g, '');
}

function normalizeOperation(value: unknown): AoiFileMutationOperation | '' {
  return value === 'write' || value === 'patch' || value === 'delete' ? value : '';
}

function normalizePatchOps(value: unknown): AoiFileMutationPatchOp[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ops: AoiFileMutationPatchOp[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Partial<AoiFileMutationPatchOp>;
    if (typeof candidate.find !== 'string' || typeof candidate.replace !== 'string') {
      continue;
    }
    const expectedCount =
      typeof candidate.expectedCount === 'number' &&
      Number.isInteger(candidate.expectedCount) &&
      candidate.expectedCount >= 1
        ? candidate.expectedCount
        : 1;
    ops.push({ find: candidate.find, replace: candidate.replace, expectedCount });
  }
  return ops;
}

export function normalizeAoiFileMutationValidationPlan(
  value: unknown,
): AoiFileMutationValidationPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiFileMutationValidationPlan> & {
    expected_before_sha256?: unknown;
    expected_after_sha256?: unknown;
  };
  const expectedBeforeRaw = raw.expectedBeforeSha256 ?? raw.expected_before_sha256;
  const expectedAfterRaw = raw.expectedAfterSha256 ?? raw.expected_after_sha256;
  const expectedBeforeSha256 =
    expectedBeforeRaw === 'absent'
      ? 'absent'
      : typeof expectedBeforeRaw === 'string'
        ? expectedBeforeRaw.trim().toLowerCase()
        : '';
  const expectedAfterSha256 =
    typeof expectedAfterRaw === 'string' ? expectedAfterRaw.trim().toLowerCase() : '';
  if (
    (expectedBeforeSha256 !== 'absent' && !SHA256_HEX.test(expectedBeforeSha256)) ||
    !SHA256_HEX.test(expectedAfterSha256)
  ) {
    return undefined;
  }
  return {
    version: 1,
    expectedBeforeSha256,
    expectedAfterSha256,
  };
}

function collectPathBlockReasons(pathLabel: string): AoiFileMutationBlockReason[] {
  const reasons: AoiFileMutationBlockReason[] = [];
  if (!pathLabel) {
    reasons.push('missing_path');
    return reasons;
  }
  if (pathLabel.startsWith('/') || /^[A-Za-z]:\//.test(pathLabel)) {
    reasons.push('path_not_relative');
  }
  const segments = pathLabel.split('/');
  if (segments.some((segment) => segment === '..')) {
    reasons.push('path_escapes_workspace');
  }
  if (!SAFE_RELATIVE_FILE_PATH.test(pathLabel)) {
    reasons.push('unsafe_path');
  }
  if (
    segments.some(
      (segment) => PROTECTED_SEGMENTS.has(segment) || segment.toLowerCase().startsWith('.env'),
    )
  ) {
    reasons.push('protected_path');
  }
  return reasons;
}

function collectContentBlockReasons(request: AoiApprovedFileMutationRequest): {
  reasons: AoiFileMutationBlockReason[];
  contentHash: string;
  byteLength: number;
  patchOps?: AoiFileMutationPatchOp[];
} {
  if (request.operation === 'write') {
    if (typeof request.content !== 'string') {
      return {
        reasons: ['missing_content'],
        contentHash: hashAoiFileMutationContent(''),
        byteLength: 0,
      };
    }
    const byteLength = utf8ByteLength(request.content);
    const reasons: AoiFileMutationBlockReason[] = [];
    if (byteLength > AOI_MAX_FILE_MUTATION_CONTENT_BYTES) {
      reasons.push('content_too_large');
    }
    return { reasons, contentHash: hashAoiFileMutationContent(request.content), byteLength };
  }

  if (request.operation === 'patch') {
    const ops = normalizePatchOps(request.patchOps);
    if (!Array.isArray(request.patchOps) || request.patchOps.length === 0) {
      return {
        reasons: ['missing_patch_ops'],
        contentHash: hashAoiFileMutationContent('[]'),
        byteLength: 0,
      };
    }
    const reasons: AoiFileMutationBlockReason[] = [];
    if (ops.length !== request.patchOps.length || ops.some((op) => op.find.length === 0)) {
      reasons.push('invalid_patch_op');
    }
    if (request.patchOps.length > AOI_MAX_FILE_MUTATION_PATCH_OPS) {
      reasons.push('too_many_patch_ops');
    }
    const byteLength = ops.reduce(
      (total, op) => total + utf8ByteLength(op.find) + utf8ByteLength(op.replace),
      0,
    );
    if (byteLength > AOI_MAX_FILE_MUTATION_PATCH_BYTES) {
      reasons.push('patch_op_too_large');
    }
    return {
      reasons,
      contentHash: hashAoiFileMutationContent(JSON.stringify(ops)),
      byteLength,
      patchOps: ops,
    };
  }

  if (request.operation === 'delete') {
    // A delete is fully specified by its path; there is no content to bind.
    return { reasons: [], contentHash: hashAoiFileMutationContent(''), byteLength: 0 };
  }

  return {
    reasons: ['unsupported_operation'],
    contentHash: hashAoiFileMutationContent(''),
    byteLength: 0,
  };
}

export function createAoiApprovedFileMutationRequest(params: {
  sessionPath: string;
  proposalId?: string;
  decisionId?: string;
  operation: unknown;
  path: unknown;
  content?: unknown;
  patchOps?: unknown;
  validationPlan?: unknown;
  purpose?: unknown;
  risk?: AoiAutonomyRisk;
  requestedAt?: number;
  evidenceRefs?: string[];
}): AoiApprovedFileMutationRequest {
  const operation = normalizeOperation(params.operation) || 'write';
  const validationPlan = normalizeAoiFileMutationValidationPlan(params.validationPlan);
  return {
    version: 1,
    sessionPath: params.sessionPath,
    ...(params.proposalId ? { proposalId: params.proposalId } : {}),
    ...(params.decisionId ? { decisionId: params.decisionId } : {}),
    operation,
    path: normalizeAoiFileMutationPath(params.path),
    ...(typeof params.content === 'string' ? { content: params.content } : {}),
    ...(Array.isArray(params.patchOps) ? { patchOps: normalizePatchOps(params.patchOps) } : {}),
    ...(validationPlan ? { validationPlan } : {}),
    purpose: normalizePurpose(params.purpose),
    risk: params.risk ?? 'high',
    requestedAt: params.requestedAt ?? Date.now(),
    evidenceRefs: [...new Set(params.evidenceRefs ?? [])].slice(0, 16),
  };
}

export function evaluateAoiApprovedFileMutationPolicy(
  request: AoiApprovedFileMutationRequest,
): AoiApprovedFileMutationPolicy {
  const operation = normalizeOperation(request.operation);
  const pathLabel = normalizeAoiFileMutationPath(request.path);
  const purpose = normalizePurpose(request.purpose);
  const purposeHash = hashStable(purpose);
  const pathHash = hashStable(pathLabel || 'missing-path');
  const resolvedOperation: AoiFileMutationOperation = operation || 'write';

  const reasons: AoiFileMutationBlockReason[] = [];
  if (!operation) {
    reasons.push('unsupported_operation');
  }
  reasons.push(...collectPathBlockReasons(pathLabel));
  const contentResult = collectContentBlockReasons(request);
  reasons.push(...contentResult.reasons);
  const validationPlan = normalizeAoiFileMutationValidationPlan(request.validationPlan);
  if (request.validationPlan && !validationPlan) {
    reasons.push('validation_plan_invalid');
  }
  if (
    validationPlan &&
    resolvedOperation === 'patch' &&
    validationPlan.expectedBeforeSha256 === 'absent'
  ) {
    reasons.push('validation_plan_invalid');
  }

  const blockReasons = [...new Set(reasons)];
  const contentHash = contentResult.contentHash;
  const byteLength = contentResult.byteLength;
  const safePathLabel = pathLabel || 'missing-path';
  const operationLabel =
    resolvedOperation === 'write' ? 'Write' : resolvedOperation === 'patch' ? 'Patch' : 'Delete';
  const dryRunSummary =
    resolvedOperation === 'write'
      ? `Would create or replace ${safePathLabel} with ${byteLength} bytes of approved content.`
      : resolvedOperation === 'patch'
        ? `Would apply ${contentResult.patchOps?.length ?? 0} anchored text patch op(s) to ${safePathLabel}.`
        : `Would delete ${safePathLabel}; a pre-change checkpoint is captured for rollback.`;
  const validationSummary = validationPlan
    ? `Require target SHA-256 ${validationPlan.expectedBeforeSha256} before mutation and ${validationPlan.expectedAfterSha256} after mutation.`
    : 'Re-read the target and verify the exact mutation bytes before reporting success.';

  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: 'workspace',
    targetId: `${resolvedOperation}:${safePathLabel}:${validationPlan?.expectedBeforeSha256 ?? 'unbound-before'}`,
    intendedMutation: `${operationLabel} ${safePathLabel} (${byteLength} bytes, content hash ${contentHash}).`,
    dryRunSummary,
    requiredAuthorityDecisionId: `approved-file-mutation:${hashStable(
      [
        resolvedOperation,
        pathHash,
        contentHash,
        validationPlan?.expectedBeforeSha256 ?? 'unbound-before',
        validationPlan?.expectedAfterSha256 ?? 'unbound-after',
        request.risk,
      ].join('|'),
    )}`,
    expectedMutationCount: 1,
    recoveryPlan: {
      kind: 'before_snapshot',
      available: true,
      summary:
        'A pre-change checkpoint of the target file is captured before applying and restored automatically if the mutation fails verification.',
      evidenceRefs: request.evidenceRefs,
    },
    rollback: {
      required: true,
      note: 'The pre-change checkpoint is restored if the mutation fails or is later undone.',
      evidenceRefs: request.evidenceRefs,
    },
    postActionValidation: {
      kind: 'check',
      label: validationSummary,
      check: validationSummary,
      evidenceRefs: request.evidenceRefs,
    },
    evidenceRefs: request.evidenceRefs,
  });

  return {
    version: 1,
    allowed: blockReasons.length === 0,
    blockReasons,
    operation: resolvedOperation,
    path: pathLabel,
    pathLabel,
    pathHash,
    contentHash,
    byteLength,
    ...(contentResult.patchOps ? { patchOps: contentResult.patchOps } : {}),
    ...(validationPlan ? { validationPlan } : {}),
    purpose,
    purposeHash,
    risk: request.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: approvalSandbox.approvalFingerprint,
    approvalSandbox,
    expiresAt: request.requestedAt + AOI_FILE_MUTATION_APPROVAL_TTL_MS,
    rationale: blockReasons.length
      ? ['File mutation is blocked until it matches the approved file-mutation policy.']
      : [
          `Approved ${resolvedOperation} of ${pathLabel} (${byteLength} bytes) under L5 with a pre-change checkpoint.`,
        ],
  };
}

export function normalizeAoiApprovedFileMutationPolicy(
  value: unknown,
): AoiApprovedFileMutationPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiApprovedFileMutationPolicy>;
  if (
    raw.version !== 1 ||
    typeof raw.allowed !== 'boolean' ||
    !Array.isArray(raw.blockReasons) ||
    (raw.operation !== 'write' && raw.operation !== 'patch' && raw.operation !== 'delete') ||
    typeof raw.path !== 'string' ||
    typeof raw.pathLabel !== 'string' ||
    typeof raw.pathHash !== 'string' ||
    typeof raw.contentHash !== 'string' ||
    typeof raw.byteLength !== 'number' ||
    typeof raw.purpose !== 'string' ||
    typeof raw.purposeHash !== 'string' ||
    (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high') ||
    raw.requiredAutonomyLevel !== 'L5' ||
    typeof raw.approvalFingerprint !== 'string' ||
    typeof raw.expiresAt !== 'number' ||
    !Array.isArray(raw.rationale)
  ) {
    return undefined;
  }
  const approvalSandbox = normalizeAoiApprovalSandboxPreview(raw.approvalSandbox);
  const validationPlan = normalizeAoiFileMutationValidationPlan(raw.validationPlan);
  if (raw.validationPlan && !validationPlan) {
    return undefined;
  }
  return {
    version: 1,
    allowed: raw.allowed,
    blockReasons: raw.blockReasons.filter(
      (item): item is AoiFileMutationBlockReason => typeof item === 'string',
    ),
    operation: raw.operation,
    path: raw.path,
    pathLabel: raw.pathLabel,
    pathHash: raw.pathHash,
    contentHash: raw.contentHash,
    byteLength: raw.byteLength,
    ...(Array.isArray(raw.patchOps) ? { patchOps: normalizePatchOps(raw.patchOps) } : {}),
    ...(validationPlan ? { validationPlan } : {}),
    purpose: raw.purpose,
    purposeHash: raw.purposeHash,
    risk: raw.risk,
    requiredAutonomyLevel: 'L5',
    approvalFingerprint: raw.approvalFingerprint,
    ...(approvalSandbox ? { approvalSandbox } : {}),
    expiresAt: raw.expiresAt,
    rationale: raw.rationale.filter((item): item is string => typeof item === 'string'),
  };
}

export function compareAoiApprovedFileMutationApproval(params: {
  approved: AoiApprovedFileMutationPolicy | undefined;
  current: AoiApprovedFileMutationPolicy;
  now: number;
}): AoiFileMutationBlockReason[] {
  const approved = params.approved;
  if (!approved) {
    return ['approval_missing', 'approval_sandbox_missing'];
  }
  const reasons: AoiFileMutationBlockReason[] = [];
  if (approved.expiresAt < params.now) {
    reasons.push('approval_expired');
  }
  if (approved.operation !== params.current.operation) {
    reasons.push('approval_operation_changed');
  }
  if (approved.pathHash !== params.current.pathHash) {
    reasons.push('approval_path_changed');
  }
  if (approved.contentHash !== params.current.contentHash) {
    reasons.push('approval_content_changed');
  }
  if (approved.risk !== params.current.risk) {
    reasons.push('approval_risk_changed');
  }
  if (approved.purposeHash !== params.current.purposeHash) {
    reasons.push('approval_purpose_changed');
  }
  if (JSON.stringify(approved.validationPlan) !== JSON.stringify(params.current.validationPlan)) {
    reasons.push('approval_validation_changed');
  }
  for (const reason of compareAoiApprovalSandboxPreviews({
    approved: approved.approvalSandbox,
    current: params.current.approvalSandbox,
  })) {
    reasons.push(reason as AoiFileMutationBlockReason);
  }
  if (
    approved.approvalFingerprint !== params.current.approvalFingerprint &&
    !reasons.includes('approval_content_changed') &&
    !reasons.includes('approval_path_changed')
  ) {
    reasons.push('approval_fingerprint_changed');
  }
  return [...new Set(reasons)];
}
