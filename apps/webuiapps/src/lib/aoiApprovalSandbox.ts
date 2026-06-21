export type AoiApprovalSandboxTargetKind =
  | 'workspace'
  | 'app'
  | 'command'
  | 'kira'
  | 'research'
  | 'memory'
  | 'unknown';

export type AoiApprovalSandboxState =
  | 'prepared'
  | 'approved'
  | 'executed'
  | 'blocked'
  | 'rolled_back'
  | 'recovery_needed';

export type AoiApprovalSandboxConnectorAuthorityState =
  | 'available'
  | 'disconnected'
  | 'revoked'
  | 'disabled'
  | 'stale'
  | 'unknown';

export interface AoiApprovalSandboxRecoveryPlan {
  version: 1;
  kind: 'before_snapshot' | 'manual_recovery' | 'not_applicable';
  available: boolean;
  summary: string;
  evidenceRefs: string[];
  recoveryHash: string;
}

export interface AoiApprovalSandboxRollbackNote {
  version: 1;
  required: boolean;
  note: string;
  evidenceRefs: string[];
  rollbackHash: string;
}

export interface AoiApprovalSandboxValidationCheck {
  version: 1;
  kind: 'command' | 'check' | 'not_applicable';
  label: string;
  command?: string;
  check?: string;
  evidenceRefs: string[];
  validationHash: string;
}

export interface AoiApprovalSandboxPreview {
  version: 1;
  id: string;
  targetKind: AoiApprovalSandboxTargetKind;
  targetId: string;
  targetHash: string;
  intendedMutation: string;
  dryRunSummary: string;
  previewHash: string;
  approvalFingerprint: string;
  requiredAuthorityDecisionId: string;
  expectedMutationCount: number;
  recoveryPlan: AoiApprovalSandboxRecoveryPlan;
  rollback: AoiApprovalSandboxRollbackNote;
  postActionValidation: AoiApprovalSandboxValidationCheck;
  commandHash?: string;
  cwdHash?: string;
  envHash: string;
  evidenceRefs: string[];
  state: 'prepared';
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiApprovalSandboxApprovalReceipt {
  version: 1;
  id: string;
  previewId: string;
  targetKind: AoiApprovalSandboxTargetKind;
  targetId: string;
  targetHash: string;
  previewHash: string;
  approvalFingerprint: string;
  requiredAuthorityDecisionId: string;
  recoveryHash: string;
  rollbackHash: string;
  validationHash: string;
  commandHash?: string;
  cwdHash?: string;
  envHash: string;
  approvedAt: number;
  expiresAt: number;
  evidenceRefs: string[];
  connectorAuthorityState: AoiApprovalSandboxConnectorAuthorityState;
}

export interface AoiApprovalSandboxValidationResult {
  version: 1;
  state: AoiApprovalSandboxState;
  approved: boolean;
  blockedReasons: string[];
  mutationCount: 0;
  expectedMutationCount: number;
  validationResult: 'not_run' | 'passed' | 'failed' | 'unknown';
  evidenceRefs: string[];
  actionAuthority: 'display_only';
}

export interface AoiApprovalSandboxPreviewInput {
  targetKind: AoiApprovalSandboxTargetKind;
  targetId: string;
  intendedMutation: string;
  dryRunSummary: string;
  requiredAuthorityDecisionId: string;
  expectedMutationCount: number;
  beforeSnapshotRef?: string;
  recoveryPlan?: {
    kind?: AoiApprovalSandboxRecoveryPlan['kind'];
    available?: boolean;
    summary?: string;
    evidenceRefs?: string[];
  };
  rollback?: {
    required?: boolean;
    note?: string;
    evidenceRefs?: string[];
  };
  postActionValidation?: {
    kind?: AoiApprovalSandboxValidationCheck['kind'];
    label?: string;
    command?: string;
    check?: string;
    evidenceRefs?: string[];
  };
  command?: string;
  cwd?: string;
  env?: Record<string, string | number | boolean | null | undefined>;
  evidenceRefs?: string[];
}

const MAX_TEXT = 320;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, fallback = '', maxChars = MAX_TEXT): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = normalizeWhitespace(raw);
  const safe = normalized || fallback;
  if (safe.length <= maxChars) {
    return safe;
  }
  return `${safe.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function uniqueStrings(values: Array<string | undefined | null>, limit = 24): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = sanitizeText(value, '', 240);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function hashParts(label: string, parts: Array<string | number | boolean | undefined>): string {
  return stableHash([label, ...parts.map((part) => String(part ?? ''))].join('\n'));
}

function normalizeEnv(
  env: Record<string, string | number | boolean | null | undefined> | undefined,
): string[] {
  return Object.entries(env ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
}

function recoveryPlanFromInput(
  input: AoiApprovalSandboxPreviewInput,
): AoiApprovalSandboxRecoveryPlan {
  const expectedMutation = input.expectedMutationCount > 0;
  const beforeSnapshotRef = sanitizeText(input.beforeSnapshotRef, '', 220);
  const kind =
    input.recoveryPlan?.kind ??
    (beforeSnapshotRef
      ? 'before_snapshot'
      : expectedMutation
        ? 'manual_recovery'
        : 'not_applicable');
  const available =
    input.recoveryPlan?.available ?? (!expectedMutation || Boolean(beforeSnapshotRef));
  const summary = sanitizeText(
    input.recoveryPlan?.summary,
    beforeSnapshotRef
      ? `Before snapshot: ${beforeSnapshotRef}.`
      : expectedMutation
        ? 'Manual recovery plan is required before execution.'
        : 'No recovery plan is required for this non-mutating preview.',
    260,
  );
  const evidenceRefs = uniqueStrings(
    [...(input.recoveryPlan?.evidenceRefs ?? []), beforeSnapshotRef],
    16,
  );
  return {
    version: 1,
    kind,
    available,
    summary,
    evidenceRefs,
    recoveryHash: hashParts('aoi-sandbox-recovery-v1', [
      kind,
      available,
      summary,
      evidenceRefs.join('|'),
    ]),
  };
}

function rollbackFromInput(input: AoiApprovalSandboxPreviewInput): AoiApprovalSandboxRollbackNote {
  const required = input.rollback?.required ?? input.expectedMutationCount > 0;
  const note = sanitizeText(
    input.rollback?.note,
    required
      ? 'Manual rollback or recovery note is required before execution.'
      : 'Rollback is not required for this non-mutating preview.',
    260,
  );
  const evidenceRefs = uniqueStrings(input.rollback?.evidenceRefs ?? [], 16);
  return {
    version: 1,
    required,
    note,
    evidenceRefs,
    rollbackHash: hashParts('aoi-sandbox-rollback-v1', [required, note, evidenceRefs.join('|')]),
  };
}

function validationFromInput(
  input: AoiApprovalSandboxPreviewInput,
): AoiApprovalSandboxValidationCheck {
  const command = sanitizeText(input.postActionValidation?.command, '', 260);
  const check = sanitizeText(input.postActionValidation?.check, '', 260);
  const kind =
    input.postActionValidation?.kind ??
    (command ? 'command' : input.expectedMutationCount > 0 ? 'check' : 'not_applicable');
  const label = sanitizeText(
    input.postActionValidation?.label,
    command || check || 'Record the action audit receipt after execution.',
    240,
  );
  const evidenceRefs = uniqueStrings(input.postActionValidation?.evidenceRefs ?? [], 16);
  return {
    version: 1,
    kind,
    label,
    ...(command ? { command } : {}),
    ...(check ? { check } : {}),
    evidenceRefs,
    validationHash: hashParts('aoi-sandbox-validation-v1', [
      kind,
      label,
      command,
      check,
      evidenceRefs.join('|'),
    ]),
  };
}

function placeholderLike(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return (
    !normalized ||
    /^(?:n\/a|na|none|null|todo|tbd|placeholder|later|unknown|not sure)$/u.test(normalized) ||
    /\b(?:todo|tbd|placeholder|fill later|not specified|unspecified)\b/u.test(normalized)
  );
}

export function hasAoiApprovalSandboxRecoveryEvidence(
  preview: AoiApprovalSandboxPreview | null | undefined,
): boolean {
  if (!preview || preview.expectedMutationCount <= 0 || !preview.rollback.required) {
    return true;
  }
  const recoveryText = `${preview.recoveryPlan.summary} ${preview.rollback.note}`;
  if (placeholderLike(preview.recoveryPlan.summary) || placeholderLike(preview.rollback.note)) {
    return false;
  }
  return (
    preview.recoveryPlan.available ||
    preview.recoveryPlan.evidenceRefs.length > 0 ||
    preview.rollback.evidenceRefs.length > 0 ||
    recoveryText.length >= 24
  );
}

export function createAoiApprovalSandboxPreview(
  input: AoiApprovalSandboxPreviewInput,
): AoiApprovalSandboxPreview {
  const targetKind = input.targetKind;
  const targetId = sanitizeText(input.targetId, 'unknown', 220);
  const intendedMutation = sanitizeText(input.intendedMutation, 'Review prepared action.', 260);
  const dryRunSummary = sanitizeText(input.dryRunSummary, 'Prepared action preview.', 320);
  const requiredAuthorityDecisionId = sanitizeText(
    input.requiredAuthorityDecisionId,
    'authority:unknown',
    220,
  );
  const expectedMutationCount = Math.max(0, Math.trunc(input.expectedMutationCount || 0));
  const recoveryPlan = recoveryPlanFromInput({ ...input, expectedMutationCount });
  const rollback = rollbackFromInput({ ...input, expectedMutationCount });
  const postActionValidation = validationFromInput({ ...input, expectedMutationCount });
  const command = sanitizeText(input.command, '', 320);
  const cwd = sanitizeText(input.cwd, '', 220);
  const envEntries = normalizeEnv(input.env);
  const evidenceRefs = uniqueStrings(input.evidenceRefs ?? [], 24);
  const targetHash = hashParts('aoi-sandbox-target-v1', [targetKind, targetId]);
  const commandHash = command ? hashParts('aoi-sandbox-command-v1', [command]) : undefined;
  const cwdHash = cwd ? hashParts('aoi-sandbox-cwd-v1', [cwd]) : undefined;
  const envHash = hashParts('aoi-sandbox-env-v1', envEntries);
  const previewHash = hashParts('aoi-sandbox-preview-v1', [
    targetKind,
    targetId,
    intendedMutation,
    dryRunSummary,
    requiredAuthorityDecisionId,
    expectedMutationCount,
    recoveryPlan.recoveryHash,
    rollback.rollbackHash,
    postActionValidation.validationHash,
    commandHash,
    cwdHash,
    envHash,
    evidenceRefs.join('|'),
  ]);
  const approvalFingerprint = hashParts('aoi-sandbox-approval-v1', [
    targetHash,
    previewHash,
    requiredAuthorityDecisionId,
    recoveryPlan.recoveryHash,
    rollback.rollbackHash,
    postActionValidation.validationHash,
    commandHash,
    cwdHash,
    envHash,
  ]);

  return {
    version: 1,
    id: `aoi-sandbox-preview:${stableHash(`${targetKind}:${targetId}:${previewHash}`)}`,
    targetKind,
    targetId,
    targetHash,
    intendedMutation,
    dryRunSummary,
    previewHash,
    approvalFingerprint,
    requiredAuthorityDecisionId,
    expectedMutationCount,
    recoveryPlan,
    rollback,
    postActionValidation,
    ...(commandHash ? { commandHash } : {}),
    ...(cwdHash ? { cwdHash } : {}),
    envHash,
    evidenceRefs,
    state: 'prepared',
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

export function createAoiApprovalSandboxApprovalReceipt(
  preview: AoiApprovalSandboxPreview,
  params: {
    approvedAt?: number;
    expiresAt?: number;
    ttlMs?: number;
    evidenceRefs?: string[];
    connectorAuthorityState?: AoiApprovalSandboxConnectorAuthorityState;
  } = {},
): AoiApprovalSandboxApprovalReceipt {
  const approvedAt = params.approvedAt ?? 0;
  return {
    version: 1,
    id: `aoi-sandbox-approval:${stableHash(`${preview.id}:${preview.approvalFingerprint}:${approvedAt}`)}`,
    previewId: preview.id,
    targetKind: preview.targetKind,
    targetId: preview.targetId,
    targetHash: preview.targetHash,
    previewHash: preview.previewHash,
    approvalFingerprint: preview.approvalFingerprint,
    requiredAuthorityDecisionId: preview.requiredAuthorityDecisionId,
    recoveryHash: preview.recoveryPlan.recoveryHash,
    rollbackHash: preview.rollback.rollbackHash,
    validationHash: preview.postActionValidation.validationHash,
    ...(preview.commandHash ? { commandHash: preview.commandHash } : {}),
    ...(preview.cwdHash ? { cwdHash: preview.cwdHash } : {}),
    envHash: preview.envHash,
    approvedAt,
    expiresAt: params.expiresAt ?? approvedAt + (params.ttlMs ?? DEFAULT_TTL_MS),
    evidenceRefs: uniqueStrings(params.evidenceRefs ?? preview.evidenceRefs, 24),
    connectorAuthorityState: params.connectorAuthorityState ?? 'available',
  };
}

export function normalizeAoiApprovalSandboxPreview(
  value: unknown,
): AoiApprovalSandboxPreview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<AoiApprovalSandboxPreview>;
  if (
    raw.version !== 1 ||
    typeof raw.id !== 'string' ||
    typeof raw.targetKind !== 'string' ||
    typeof raw.targetId !== 'string' ||
    typeof raw.targetHash !== 'string' ||
    typeof raw.intendedMutation !== 'string' ||
    typeof raw.dryRunSummary !== 'string' ||
    typeof raw.previewHash !== 'string' ||
    typeof raw.approvalFingerprint !== 'string' ||
    typeof raw.requiredAuthorityDecisionId !== 'string' ||
    typeof raw.expectedMutationCount !== 'number' ||
    !raw.recoveryPlan ||
    !raw.rollback ||
    !raw.postActionValidation ||
    typeof raw.envHash !== 'string' ||
    !Array.isArray(raw.evidenceRefs)
  ) {
    return undefined;
  }
  return raw as AoiApprovalSandboxPreview;
}

function addCompareReason(reasons: string[], condition: boolean, reason: string): void {
  if (condition && !reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function compareAoiApprovalSandboxPreviews(params: {
  approved: AoiApprovalSandboxPreview | null | undefined;
  current: AoiApprovalSandboxPreview | null | undefined;
}): string[] {
  const approved = params.approved;
  const current = params.current;
  if (!approved || !current) {
    return ['approval_sandbox_missing'];
  }
  const reasons: string[] = [];
  addCompareReason(reasons, approved.targetKind !== current.targetKind, 'approval_target_changed');
  addCompareReason(reasons, approved.targetHash !== current.targetHash, 'approval_target_changed');
  addCompareReason(
    reasons,
    approved.previewHash !== current.previewHash,
    'approval_preview_changed',
  );
  addCompareReason(
    reasons,
    approved.requiredAuthorityDecisionId !== current.requiredAuthorityDecisionId,
    'approval_authority_decision_changed',
  );
  addCompareReason(
    reasons,
    approved.recoveryPlan.recoveryHash !== current.recoveryPlan.recoveryHash,
    'approval_recovery_plan_changed',
  );
  addCompareReason(
    reasons,
    approved.rollback.rollbackHash !== current.rollback.rollbackHash,
    'approval_rollback_plan_changed',
  );
  addCompareReason(
    reasons,
    approved.postActionValidation.validationHash !== current.postActionValidation.validationHash,
    'approval_validation_changed',
  );
  addCompareReason(
    reasons,
    approved.commandHash !== current.commandHash,
    'approval_command_changed',
  );
  addCompareReason(reasons, approved.cwdHash !== current.cwdHash, 'approval_cwd_changed');
  addCompareReason(reasons, approved.envHash !== current.envHash, 'approval_env_changed');
  addCompareReason(
    reasons,
    approved.approvalFingerprint !== current.approvalFingerprint,
    'approval_fingerprint_changed',
  );
  return reasons;
}

export function validateAoiApprovalSandboxApproval(params: {
  preview: AoiApprovalSandboxPreview;
  approval?: AoiApprovalSandboxApprovalReceipt | null;
  now: number;
  connectorAuthorityState?: AoiApprovalSandboxConnectorAuthorityState;
  validationResult?: AoiApprovalSandboxValidationResult['validationResult'];
  approvalRequired?: boolean;
}): AoiApprovalSandboxValidationResult {
  const reasons: string[] = [];
  const preview = params.preview;
  const approval = params.approval;
  const approvalRequired = params.approvalRequired ?? true;
  if (!approval && approvalRequired) {
    reasons.push('approval_missing');
  } else if (approval) {
    addCompareReason(reasons, approval.expiresAt < params.now, 'approval_expired');
    addCompareReason(
      reasons,
      approval.targetKind !== preview.targetKind,
      'approval_target_changed',
    );
    addCompareReason(
      reasons,
      approval.targetHash !== preview.targetHash,
      'approval_target_changed',
    );
    addCompareReason(
      reasons,
      approval.previewHash !== preview.previewHash,
      'approval_preview_changed',
    );
    addCompareReason(
      reasons,
      approval.approvalFingerprint !== preview.approvalFingerprint,
      'approval_fingerprint_changed',
    );
    addCompareReason(
      reasons,
      approval.requiredAuthorityDecisionId !== preview.requiredAuthorityDecisionId,
      'approval_authority_decision_changed',
    );
    addCompareReason(
      reasons,
      approval.recoveryHash !== preview.recoveryPlan.recoveryHash,
      'approval_recovery_plan_changed',
    );
    addCompareReason(
      reasons,
      approval.rollbackHash !== preview.rollback.rollbackHash,
      'approval_rollback_plan_changed',
    );
    addCompareReason(
      reasons,
      approval.validationHash !== preview.postActionValidation.validationHash,
      'approval_validation_changed',
    );
    addCompareReason(
      reasons,
      approval.commandHash !== preview.commandHash,
      'approval_command_changed',
    );
    addCompareReason(reasons, approval.cwdHash !== preview.cwdHash, 'approval_cwd_changed');
    addCompareReason(reasons, approval.envHash !== preview.envHash, 'approval_env_changed');
    if (approval.connectorAuthorityState === 'revoked') {
      reasons.push('connector_authority_revoked');
    }
  }
  const connectorState = params.connectorAuthorityState;
  if (connectorState === 'revoked') {
    reasons.push('connector_authority_revoked');
  }
  if (connectorState === 'disabled') {
    reasons.push('connector_authority_disabled');
  }
  if (connectorState === 'disconnected') {
    reasons.push('connector_authority_disconnected');
  }
  if (!hasAoiApprovalSandboxRecoveryEvidence(preview)) {
    reasons.push('rollback_recovery_evidence_missing');
  }
  const blockedReasons = uniqueStrings(reasons, 16);
  const approved = blockedReasons.length <= 0;
  return {
    version: 1,
    state: approved ? 'approved' : 'blocked',
    approved,
    blockedReasons,
    mutationCount: 0,
    expectedMutationCount: preview.expectedMutationCount,
    validationResult: params.validationResult ?? 'not_run',
    evidenceRefs: uniqueStrings(
      [
        `approval-sandbox-preview:${preview.previewHash}`,
        approval ? `approval-sandbox-receipt:${approval.id}` : undefined,
        ...preview.evidenceRefs,
        ...(approval?.evidenceRefs ?? []),
      ],
      24,
    ),
    actionAuthority: 'display_only',
  };
}

export function formatAoiApprovalSandboxSummary(
  preview: AoiApprovalSandboxPreview,
  validation?: AoiApprovalSandboxValidationResult | null,
): string {
  const state = validation?.state ?? preview.state;
  const blocked =
    validation && validation.blockedReasons.length > 0
      ? ` blocked=${validation.blockedReasons.join(',')}`
      : ' blocked=none';
  const validationLabel = validation?.validationResult ?? 'not_run';
  return `${state}: ${preview.targetKind}/${preview.targetId}; mutation=${preview.expectedMutationCount}; preview=${preview.previewHash}; fingerprint=${preview.approvalFingerprint}; validation=${validationLabel};${blocked}`;
}
