import {
  AOI_COMMAND_APPROVAL_TTL_MS,
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from './aoiApprovedCommandPolicy';
import {
  createAoiApprovalSandboxPreview,
  hasAoiApprovalSandboxRecoveryEvidence,
} from './aoiApprovalSandbox';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';
import { buildAoiPreparedActionPlan } from './aoiSafeActionPlan';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type {
  AoiApprovedCommandPolicy,
  AoiAutonomyLevel,
  AoiAutonomyRisk,
  AoiCheckpointPlan,
  AoiGoal,
  AoiPlanStep,
  AoiPlaybook,
  AoiProposal,
  AoiRollbackPlan,
  AoiValidationPlan,
} from './aoiAutonomyTypes';
import type { AoiMissionControlItem, AoiMissionControlState } from './aoiMissionControlRuntime';
import type { AoiShadowDecisionReport } from './aoiShadowModeEvaluation';
import type { AoiApprovalSandboxPreview, AoiApprovalSandboxTargetKind } from './aoiApprovalSandbox';

const DEFAULT_NOW = 1_800_000_000_000;
const MAX_TEXT = 260;
const MAX_REFS = 24;
const MAX_SCOPE_ITEMS = 24;
const BROAD_SCOPE_PATTERN =
  /\b(?:everything|entire|whole|all files|all modules|all code|whole repo|entire repo|repository-wide|rewrite|refactor all|fix everything|any file|all source)\b/i;
const FILE_LIKE_PATTERN =
  /(?:^|\/)(?:[^/\s]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|c|cc|cpp|h|hpp|cs|py|ps1|sql)|src|apps|packages|docs|lib|test|tests|__tests__)(?:\/|$)/i;

export type AoiBoundedWorkOrderOwner = 'aoi' | 'user' | 'shared' | 'kira' | 'operator';

export type AoiBoundedWorkOrderOperation =
  | 'read'
  | 'inspect'
  | 'summarize'
  | 'preview_changes'
  | 'edit_file'
  | 'run_validation_command'
  | 'create_kira_work'
  | 'start_research'
  | 'save_memory'
  | 'ask_operator';

export type AoiBoundedWorkOrderOriginKind =
  | 'mission_control_top_mission'
  | 'playbook_next_step'
  | 'goal_plan_step'
  | 'accepted_proposal'
  | 'proposal_preview'
  | 'shadow_useful_label'
  | 'manual';

export type AoiBoundedWorkOrderPolicyStatus =
  | 'preview_only'
  | 'approval_required'
  | 'kira_review_required'
  | 'blocked';

export type AoiBoundedWorkOrderStatus =
  | 'draft'
  | 'waiting_approval'
  | 'approved'
  | 'blocked'
  | 'archived';

export interface AoiBoundedWorkOrderOrigin {
  version: 1;
  kind: AoiBoundedWorkOrderOriginKind;
  ref: string;
  label: string;
  generated: boolean;
}

export interface AoiBoundedWorkOrderCommandPreview {
  version: 1;
  command: string;
  cwd: string;
  purpose: string;
  policy: AoiApprovedCommandPolicy;
  approvalFingerprint: string;
  cwdHash: string;
  allowed: boolean;
  blockReasons: string[];
}

export interface AoiBoundedWorkOrderScope {
  version: 1;
  affectedSurfaces: string[];
  files: string[];
  modules: string[];
  allowedOperations: AoiBoundedWorkOrderOperation[];
  forbiddenOperations: string[];
  explicitScope: boolean;
  scopeHash: string;
  broadScopeDetected: boolean;
  unsafeScopeDetected: boolean;
}

export interface AoiBoundedWorkOrderRisk {
  version: 1;
  level: AoiAutonomyRisk;
  baseLevel: AoiAutonomyRisk;
  mutationCapable: boolean;
  commandCapable: boolean;
  generated: boolean;
  escalated: boolean;
  reasons: string[];
}

export interface AoiBoundedWorkOrderApproval {
  version: 1;
  required: boolean;
  requiredAutonomyLevel: AoiAutonomyLevel;
  approver: 'operator' | 'kira_reviewer' | 'approved_command_runner' | 'none';
  exactNextApproval: string;
  approvalFingerprint: string;
  satisfied: boolean;
  invalidationReasons: string[];
  approvalRef?: string;
}

export interface AoiBoundedWorkOrderValidation {
  version: 1;
  required: boolean;
  approvalRequiredBeforeRun: boolean;
  summary: string;
  commands: AoiBoundedWorkOrderCommandPreview[];
  expectedEvidenceRefs: string[];
}

export interface AoiBoundedWorkOrderCheckpoint {
  version: 1;
  required: boolean;
  available: boolean;
  kind: AoiCheckpointPlan['kind'];
  summary: string;
  evidenceRefs: string[];
  missingReason?: string;
}

export interface AoiBoundedWorkOrderRollback {
  version: 1;
  available: boolean;
  kind: AoiRollbackPlan['kind'];
  guarantee: AoiRollbackPlan['guarantee'];
  summary: string;
  instructions: string[];
  evidenceRefs: string[];
}

export interface AoiBoundedWorkOrderPolicyResult {
  version: 1;
  status: AoiBoundedWorkOrderPolicyStatus;
  reasons: string[];
  blockedReasons: string[];
  approvalInvalidationReasons: string[];
  exactNextApproval: string;
  executionAllowed: false;
  canAutoRun: false;
}

export interface AoiBoundedWorkOrderExpectedDiffShape {
  version: 1;
  summary: string;
  allowedPatterns: string[];
  forbiddenPatterns: string[];
}

export interface AoiBoundedWorkOrderReviewRequirement {
  version: 1;
  operatorReviewRequired: boolean;
  kiraReviewRequired: boolean;
  commandApprovalRequired: boolean;
  approvalBoundary: string;
}

export interface AoiBoundedWorkOrder {
  version: 1;
  id: string;
  sessionPath: string;
  status: AoiBoundedWorkOrderStatus;
  objective: string;
  owner: AoiBoundedWorkOrderOwner;
  origin: AoiBoundedWorkOrderOrigin;
  sourceRefs: string[];
  scope: AoiBoundedWorkOrderScope;
  allowedOperations: AoiBoundedWorkOrderOperation[];
  forbiddenOperations: string[];
  expectedDiffShape: AoiBoundedWorkOrderExpectedDiffShape;
  commands: AoiBoundedWorkOrderCommandPreview[];
  risk: AoiBoundedWorkOrderRisk;
  approval: AoiBoundedWorkOrderApproval;
  validation: AoiBoundedWorkOrderValidation;
  checkpoint: AoiBoundedWorkOrderCheckpoint;
  rollback: AoiBoundedWorkOrderRollback;
  approvalSandbox: AoiApprovalSandboxPreview;
  reviewRequirement: AoiBoundedWorkOrderReviewRequirement;
  stopConditions: string[];
  policyResult: AoiBoundedWorkOrderPolicyResult;
  evidenceRefs: string[];
  createdAt: number;
  updatedAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiBoundedWorkOrderApprovalSnapshot {
  version: 1;
  approvalFingerprint: string;
  commandFingerprints: string[];
  cwdHashes: string[];
  scopeHash: string;
  fileScopeHash: string;
  sandboxPreviewHash: string;
  sandboxAuthorityDecisionId: string;
  sandboxRecoveryHash: string;
  sandboxRollbackHash: string;
  sandboxValidationHash: string;
  sandboxEnvHash: string;
  riskLevel: AoiAutonomyRisk;
  approvedAt: number;
  expiresAt: number;
  evidenceRefs: string[];
}

export interface AoiBoundedWorkOrderCommandInput {
  command: string;
  cwd?: string;
  purpose?: string;
  timeoutMs?: number;
}

export interface AoiBoundedWorkOrderDraft {
  sessionPath: string;
  objective: string;
  owner?: AoiBoundedWorkOrderOwner;
  origin?: Partial<AoiBoundedWorkOrderOrigin>;
  affectedSurfaces?: string[];
  files?: string[];
  modules?: string[];
  allowedOperations?: AoiBoundedWorkOrderOperation[];
  forbiddenOperations?: string[];
  commands?: AoiBoundedWorkOrderCommandInput[];
  risk?: Partial<Pick<AoiBoundedWorkOrderRisk, 'level' | 'mutationCapable' | 'commandCapable'>>;
  approval?: Partial<
    Pick<
      AoiBoundedWorkOrderApproval,
      'required' | 'requiredAutonomyLevel' | 'approver' | 'approvalRef'
    >
  >;
  validation?: Partial<
    Pick<AoiValidationPlan, 'required' | 'approvalRequiredBeforeRun' | 'summary'>
  > & {
    expectedEvidenceRefs?: string[];
  };
  checkpoint?: Partial<AoiCheckpointPlan>;
  rollback?: Partial<AoiRollbackPlan>;
  sourceRefs?: string[];
  expectedDiffShape?: Partial<AoiBoundedWorkOrderExpectedDiffShape>;
  stopConditions?: string[];
  reviewRequirement?: Partial<AoiBoundedWorkOrderReviewRequirement>;
  evidenceRefs?: string[];
  now?: number;
}

export interface AoiBoundedWorkOrderPolicyOptions {
  now?: number;
  approvedSnapshot?: AoiBoundedWorkOrderApprovalSnapshot | null;
}

export interface AoiBoundedWorkOrderBuilderOptions extends AoiBoundedWorkOrderPolicyOptions {
  generated?: boolean;
}

export interface AoiBoundedWorkOrdersInput extends AoiBoundedWorkOrderBuilderOptions {
  sessionPath: string;
  missionControl?: AoiMissionControlState | null;
  playbooks?: AoiPlaybook[];
  proposals?: AoiProposal[];
  shadowReport?: AoiShadowDecisionReport | null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeText(value: unknown, fallback = '', maxChars = MAX_TEXT): string {
  const raw = typeof value === 'string' ? value : fallback;
  const normalized = normalizeWhitespace(
    stripAoiSourceInstructions(redactAoiSensitiveContent(raw))
      .replace(/\b[A-Z]:\\[^\s'"`<>|]+/gi, '[local path]')
      .replace(/\\\\[^\s'"`<>|]+/g, '[local path]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[private email]')
      .replace(/https?:\/\/[^\s'"`<>]+/gi, '[external url]'),
  );
  const safe = normalized || fallback;
  if (safe.length <= maxChars) {
    return safe;
  }
  return `${safe.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function hashStable(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 12);
}

function dedupeStrings(values: Array<string | undefined | null>, maxItems = MAX_REFS): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeText(value ?? '', '', 220).replace(/\\/g, '/');
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (seen.size >= maxItems) {
      break;
    }
  }
  return [...seen];
}

function getStringParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  return typeof value === 'string' ? sanitizeText(value, '', 220) : '';
}

function getStringListParam(params: Record<string, unknown> | undefined, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === 'string') {
      values.push(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          values.push(item);
        }
      }
    }
  }
  return dedupeStrings(values, MAX_SCOPE_ITEMS);
}

function riskValue(level: AoiAutonomyRisk): number {
  if (level === 'high') {
    return 3;
  }
  if (level === 'medium') {
    return 2;
  }
  return 1;
}

function maxRisk(left: AoiAutonomyRisk, right: AoiAutonomyRisk): AoiAutonomyRisk {
  return riskValue(left) >= riskValue(right) ? left : right;
}

function operationMutates(operation: AoiBoundedWorkOrderOperation): boolean {
  return (
    operation === 'edit_file' ||
    operation === 'create_kira_work' ||
    operation === 'save_memory' ||
    operation === 'start_research'
  );
}

function operationRunsCommand(operation: AoiBoundedWorkOrderOperation): boolean {
  return operation === 'run_validation_command';
}

function isBroadText(value: string): boolean {
  return BROAD_SCOPE_PATTERN.test(value) || value.trim() === '*';
}

function isAmbiguousObjective(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  return (
    normalized.length < 12 ||
    normalized === 'review bounded aoi work.' ||
    /^(?:fix|update|change|improve|review|continue|do it|handle it|work on it)$/i.test(
      normalized,
    ) ||
    /\b(?:something|stuff|things|misc|whatever)\b/i.test(normalized)
  );
}

function isUnsafeScopeText(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/');
  return (
    normalized.includes('..') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^https?:\/\//i.test(normalized)
  );
}

function looksFileLike(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return FILE_LIKE_PATTERN.test(normalized);
}

function inferFilesFromSurfaces(surfaces: string[]): string[] {
  return dedupeStrings(
    surfaces.filter((item) => looksFileLike(item) && !isBroadText(item)),
    MAX_SCOPE_ITEMS,
  );
}

function buildScopeHash(params: {
  affectedSurfaces: string[];
  files: string[];
  modules: string[];
  allowedOperations: string[];
}): string {
  return hashStable(
    [
      'aoi-work-order-scope-v1',
      ...params.affectedSurfaces.sort(),
      ...params.files.sort(),
      ...params.modules.sort(),
      ...params.allowedOperations.sort(),
    ].join('\n'),
  );
}

function buildFileScopeHash(files: string[], modules: string[]): string {
  return hashStable(['aoi-work-order-files-v1', ...files.sort(), ...modules.sort()].join('\n'));
}

function commandPurpose(objective: string, command: string): string {
  return sanitizeText(objective || `Validate work order command: ${command}`, '', 180);
}

function buildCommandPreviews(params: {
  sessionPath: string;
  objective: string;
  commands: AoiBoundedWorkOrderCommandInput[];
  risk: AoiAutonomyRisk;
  now: number;
  evidenceRefs: string[];
}): AoiBoundedWorkOrderCommandPreview[] {
  return params.commands
    .filter((command) => typeof command.command === 'string' && command.command.trim())
    .slice(0, 6)
    .map((command) => {
      const request = createAoiApprovedCommandRequest({
        sessionPath: params.sessionPath,
        command: command.command,
        cwd: command.cwd ?? '.',
        purpose: command.purpose ?? commandPurpose(params.objective, command.command),
        risk: params.risk,
        timeoutMs: command.timeoutMs,
        requestedAt: params.now,
        evidenceRefs: params.evidenceRefs,
      });
      const policy = evaluateAoiApprovedCommandPolicy(request);
      return {
        version: 1,
        command: policy.command,
        cwd: policy.cwd,
        purpose: policy.purpose,
        policy,
        approvalFingerprint: policy.approvalFingerprint,
        cwdHash: policy.cwdHash,
        allowed: policy.allowed,
        blockReasons: policy.blockReasons,
      };
    });
}

function defaultForbiddenOperations(mutationCapable: boolean): string[] {
  return [
    'Do not run commands automatically.',
    'Do not modify files automatically.',
    'Do not expand file, module, command, or cwd scope silently.',
    ...(mutationCapable
      ? ['Do not bypass operator approval, approved command policy, or Kira review.']
      : ['Do not treat preview preparation as execution approval.']),
  ];
}

function normalizeCheckpoint(
  value: Partial<AoiCheckpointPlan> | undefined,
  mutationCapable: boolean,
): AoiBoundedWorkOrderCheckpoint {
  const required = value?.required ?? mutationCapable;
  const available = value?.available ?? !required;
  const kind =
    value?.kind ??
    (required
      ? available
        ? 'existing_git_state'
        : 'manual_checkpoint_required'
      : 'not_applicable');
  return {
    version: 1,
    required,
    available,
    kind,
    summary: sanitizeText(
      value?.summary,
      required
        ? available
          ? 'Checkpoint evidence is available for review.'
          : 'Checkpoint evidence is required before mutation-capable work can proceed.'
        : 'No checkpoint is required for this read-only preview.',
      220,
    ),
    evidenceRefs: dedupeStrings(value?.evidenceRefs ?? [], 12),
    ...(value?.missingReason || (required && !available)
      ? {
          missingReason: sanitizeText(
            value?.missingReason ?? 'missing_checkpoint_for_mutation_capable_work',
            '',
            140,
          ),
        }
      : {}),
  };
}

function normalizeRollback(
  value: Partial<AoiRollbackPlan> | undefined,
  mutationCapable: boolean,
): AoiBoundedWorkOrderRollback {
  const available = value?.available ?? !mutationCapable;
  const kind = value?.kind ?? (mutationCapable ? 'manual_revert_required' : 'not_applicable');
  return {
    version: 1,
    available,
    kind,
    guarantee: value?.guarantee ?? 'none',
    summary: sanitizeText(
      value?.summary,
      mutationCapable
        ? available
          ? 'Rollback requires the recorded checkpoint and manual review.'
          : 'Rollback is unavailable; risk must be escalated before approval.'
        : 'Read-only preview does not require rollback.',
      220,
    ),
    instructions: dedupeStrings(
      value?.instructions ?? [
        mutationCapable
          ? 'Do not approve mutation-capable work without a reviewed rollback path.'
          : 'No rollback is expected for read-only preview work.',
      ],
      8,
    ),
    evidenceRefs: dedupeStrings(value?.evidenceRefs ?? [], 12),
  };
}

function deriveRisk(params: {
  baseLevel: AoiAutonomyRisk;
  mutationCapable: boolean;
  commandCapable: boolean;
  generated: boolean;
  broadScopeDetected: boolean;
  checkpoint: AoiBoundedWorkOrderCheckpoint;
  rollback: AoiBoundedWorkOrderRollback;
  commandPreviews: AoiBoundedWorkOrderCommandPreview[];
  reasons: string[];
}): AoiBoundedWorkOrderRisk {
  let level = params.baseLevel;
  const reasons = [...params.reasons];
  if (params.commandCapable) {
    level = maxRisk(level, 'medium');
    reasons.push('Command-capable work remains behind the approved command policy.');
  }
  if (params.mutationCapable) {
    level = maxRisk(level, 'medium');
    reasons.push('Mutation-capable work requires explicit approval before execution.');
  }
  if (params.broadScopeDetected) {
    level = 'high';
    reasons.push('Broad scope text was detected and cannot be accepted silently.');
  }
  if (params.mutationCapable && !params.rollback.available) {
    level = 'high';
    reasons.push('Rollback is unavailable for mutation-capable work.');
  }
  if (params.mutationCapable && params.checkpoint.required && !params.checkpoint.available) {
    level = 'high';
    reasons.push('Checkpoint evidence is missing for mutation-capable work.');
  }
  if (params.commandPreviews.some((command) => !command.allowed)) {
    level = 'high';
    reasons.push('At least one validation command is blocked by approved command policy.');
  }
  if (params.generated && riskValue(level) >= riskValue('medium')) {
    reasons.push('Generated medium/high-risk work requires Kira or operator review.');
  }
  return {
    version: 1,
    level,
    baseLevel: params.baseLevel,
    mutationCapable: params.mutationCapable,
    commandCapable: params.commandCapable,
    generated: params.generated,
    escalated: level !== params.baseLevel,
    reasons: dedupeStrings(reasons, 12),
  };
}

function buildApprovalFingerprint(params: {
  objective: string;
  scopeHash: string;
  fileScopeHash: string;
  commands: AoiBoundedWorkOrderCommandPreview[];
  riskLevel: AoiAutonomyRisk;
}): string {
  return hashStable(
    [
      'aoi-bounded-work-order-approval-v1',
      params.objective,
      params.scopeHash,
      params.fileScopeHash,
      params.riskLevel,
      ...params.commands.map((command) => command.approvalFingerprint),
      ...params.commands.map((command) => command.cwdHash),
    ].join('\n'),
  );
}

function sandboxTargetKindForWorkOrder(
  operations: readonly AoiBoundedWorkOrderOperation[],
  commandCapable: boolean,
): AoiApprovalSandboxTargetKind {
  if (operations.includes('create_kira_work')) {
    return 'kira';
  }
  if (operations.includes('start_research')) {
    return 'research';
  }
  if (operations.includes('save_memory')) {
    return 'memory';
  }
  if (commandCapable) {
    return 'command';
  }
  return 'workspace';
}

function expectedSandboxMutationCountForWorkOrder(params: {
  operations: readonly AoiBoundedWorkOrderOperation[];
  mutationCapable: boolean;
}): number {
  if (
    params.mutationCapable ||
    params.operations.includes('create_kira_work') ||
    params.operations.includes('start_research') ||
    params.operations.includes('save_memory')
  ) {
    return 1;
  }
  return 0;
}

function exactNextApproval(params: {
  status?: AoiBoundedWorkOrderPolicyStatus;
  mutationCapable: boolean;
  commandCapable: boolean;
  generated: boolean;
  riskLevel: AoiAutonomyRisk;
}): string {
  if (params.status === 'blocked') {
    return 'Resolve blocked scope, validation, command, checkpoint, or rollback reasons first.';
  }
  if (params.generated && riskValue(params.riskLevel) >= riskValue('medium')) {
    return 'Route this exact generated work order through Kira review or explicit operator review.';
  }
  if (params.commandCapable) {
    return 'Approve the exact validation command preview with unchanged command, cwd, purpose, and risk.';
  }
  if (params.mutationCapable) {
    return 'Approve this exact file/module scope, checkpoint, validation, and rollback boundary.';
  }
  return 'Preview only; no execution approval is required.';
}

function buildExpectedDiffShape(params: {
  draftShape?: Partial<AoiBoundedWorkOrderExpectedDiffShape>;
  mutationCapable: boolean;
  files: string[];
  modules: string[];
  affectedSurfaces: string[];
}): AoiBoundedWorkOrderExpectedDiffShape {
  const scopedTargets = dedupeStrings(
    [...params.files, ...params.modules, ...params.affectedSurfaces],
    12,
  );
  return {
    version: 1,
    summary: sanitizeText(
      params.draftShape?.summary,
      params.mutationCapable
        ? 'Expected diff is limited to the explicit file/module scope and remains un-applied until approval.'
        : 'No repository diff is expected from prepare-only work.',
      240,
    ),
    allowedPatterns: dedupeStrings(params.draftShape?.allowedPatterns ?? scopedTargets, 12),
    forbiddenPatterns: dedupeStrings(
      params.draftShape?.forbiddenPatterns ?? [
        'No out-of-scope files or modules.',
        'No package install, publish, deploy, push, or destructive filesystem operations.',
        'No generated broad rewrite or repository-wide refactor.',
      ],
      12,
    ),
  };
}

function buildReviewRequirement(params: {
  draftRequirement?: Partial<AoiBoundedWorkOrderReviewRequirement>;
  approval: AoiBoundedWorkOrderApproval;
  risk: AoiBoundedWorkOrderRisk;
  policyResult: AoiBoundedWorkOrderPolicyResult;
}): AoiBoundedWorkOrderReviewRequirement {
  const kiraReviewRequired =
    params.draftRequirement?.kiraReviewRequired ?? params.approval.approver === 'kira_reviewer';
  const commandApprovalRequired =
    params.draftRequirement?.commandApprovalRequired ?? params.risk.commandCapable;
  const operatorReviewRequired =
    params.draftRequirement?.operatorReviewRequired ??
    (params.approval.required && params.approval.approver !== 'kira_reviewer');
  return {
    version: 1,
    operatorReviewRequired,
    kiraReviewRequired: kiraReviewRequired || params.policyResult.status === 'kira_review_required',
    commandApprovalRequired,
    approvalBoundary: sanitizeText(
      params.draftRequirement?.approvalBoundary,
      params.policyResult.exactNextApproval,
      260,
    ),
  };
}

function buildStopConditions(params: {
  draftConditions?: string[];
  order: Omit<
    AoiBoundedWorkOrder,
    'status' | 'policyResult' | 'reviewRequirement' | 'stopConditions'
  >;
  policyResult: AoiBoundedWorkOrderPolicyResult;
}): string[] {
  const commandBlockers = params.order.commands.flatMap((command) =>
    command.blockReasons.map(
      (reason) => `Stop if command policy blocks ${command.command}: ${reason}.`,
    ),
  );
  return dedupeStrings(
    [
      ...(params.draftConditions ?? []),
      ...params.policyResult.blockedReasons.map(
        (reason) => `Stop until blocked reason is resolved: ${reason}.`,
      ),
      ...params.policyResult.approvalInvalidationReasons.map(
        (reason) => `Stop if approval no longer matches the exact work order: ${reason}.`,
      ),
      ...commandBlockers,
      params.order.risk.mutationCapable && params.order.commands.length <= 0
        ? 'Stop because mutation-capable work has no validation command preview.'
        : undefined,
      params.order.risk.mutationCapable &&
      params.order.checkpoint.required &&
      !params.order.checkpoint.available
        ? 'Stop because checkpoint evidence is missing.'
        : undefined,
      params.order.risk.mutationCapable && !params.order.rollback.available
        ? 'Stop because rollback is unavailable or unclear.'
        : undefined,
      'Stop if the objective, scope, command, checkpoint, rollback, or validation boundary changes before approval.',
      'Stop if Kira, operator, or approved-command policy approval is missing for the exact next action.',
    ],
    16,
  );
}

function statusFromPolicyResult(params: {
  policyResult: AoiBoundedWorkOrderPolicyResult;
  approval: AoiBoundedWorkOrderApproval;
}): AoiBoundedWorkOrderStatus {
  if (params.policyResult.status === 'blocked') {
    return 'blocked';
  }
  if (params.approval.satisfied) {
    return 'approved';
  }
  if (
    params.policyResult.status === 'approval_required' ||
    params.policyResult.status === 'kira_review_required'
  ) {
    return 'waiting_approval';
  }
  return 'draft';
}

function compareApprovalSnapshot(
  order: Omit<
    AoiBoundedWorkOrder,
    'status' | 'policyResult' | 'reviewRequirement' | 'stopConditions'
  >,
  snapshot: AoiBoundedWorkOrderApprovalSnapshot | null | undefined,
  now: number,
): string[] {
  if (!snapshot) {
    return order.approval.required ? ['approval_missing'] : [];
  }
  const reasons: string[] = [];
  const commandFingerprints = order.commands.map((command) => command.approvalFingerprint);
  const cwdHashes = order.commands.map((command) => command.cwdHash);
  const fileScopeHash = buildFileScopeHash(order.scope.files, order.scope.modules);
  if (snapshot.expiresAt < now) {
    reasons.push('approval_expired');
  }
  if (snapshot.approvalFingerprint !== order.approval.approvalFingerprint) {
    reasons.push('approval_work_order_changed');
  }
  if (snapshot.commandFingerprints.join('|') !== commandFingerprints.join('|')) {
    reasons.push('approval_command_changed');
  }
  if (snapshot.cwdHashes.join('|') !== cwdHashes.join('|')) {
    reasons.push('approval_cwd_changed');
  }
  if (snapshot.scopeHash !== order.scope.scopeHash) {
    reasons.push('approval_scope_changed');
  }
  if (snapshot.fileScopeHash !== fileScopeHash) {
    reasons.push('approval_files_changed');
  }
  if (snapshot.sandboxPreviewHash !== order.approvalSandbox.previewHash) {
    reasons.push('approval_preview_changed');
  }
  if (snapshot.sandboxAuthorityDecisionId !== order.approvalSandbox.requiredAuthorityDecisionId) {
    reasons.push('approval_authority_decision_changed');
  }
  if (snapshot.sandboxRecoveryHash !== order.approvalSandbox.recoveryPlan.recoveryHash) {
    reasons.push('approval_recovery_plan_changed');
  }
  if (snapshot.sandboxRollbackHash !== order.approvalSandbox.rollback.rollbackHash) {
    reasons.push('approval_rollback_plan_changed');
  }
  if (
    snapshot.sandboxValidationHash !== order.approvalSandbox.postActionValidation.validationHash
  ) {
    reasons.push('approval_validation_changed');
  }
  if (snapshot.sandboxEnvHash !== order.approvalSandbox.envHash) {
    reasons.push('approval_env_changed');
  }
  if (snapshot.riskLevel !== order.risk.level) {
    reasons.push('approval_risk_changed');
  }
  return dedupeStrings(reasons, 12);
}

export function evaluateAoiBoundedWorkOrderPolicy(
  order: Omit<
    AoiBoundedWorkOrder,
    'status' | 'policyResult' | 'reviewRequirement' | 'stopConditions'
  >,
  options: AoiBoundedWorkOrderPolicyOptions = {},
): AoiBoundedWorkOrderPolicyResult {
  const now = options.now ?? order.updatedAt ?? DEFAULT_NOW;
  const blockedReasons: string[] = [];
  if (isAmbiguousObjective(order.objective)) {
    blockedReasons.push('objective_ambiguous');
  }
  if (isBroadText(order.objective)) {
    blockedReasons.push('objective_too_broad');
  }
  if (order.scope.broadScopeDetected) {
    blockedReasons.push('scope_too_broad');
  }
  if (order.scope.unsafeScopeDetected) {
    blockedReasons.push('unsafe_file_or_module_scope');
  }
  if (order.risk.mutationCapable && !order.scope.explicitScope) {
    blockedReasons.push('missing_file_or_module_scope');
  }
  if (order.risk.mutationCapable && order.commands.length <= 0) {
    blockedReasons.push('missing_validation_command_preview');
  }
  for (const command of order.commands) {
    for (const reason of command.blockReasons) {
      blockedReasons.push(`command_policy_blocked:${reason}`);
    }
  }
  if (order.risk.mutationCapable && order.checkpoint.required && !order.checkpoint.available) {
    blockedReasons.push('missing_checkpoint_for_mutation_capable_work');
  }
  if (order.risk.mutationCapable && !order.rollback.available) {
    blockedReasons.push('missing_rollback_for_mutation_capable_work');
  }
  if (!hasAoiApprovalSandboxRecoveryEvidence(order.approvalSandbox)) {
    blockedReasons.push('rollback_recovery_evidence_missing');
  }
  const approvalInvalidationReasons = compareApprovalSnapshot(order, options.approvedSnapshot, now);
  const approvalSatisfied =
    order.approval.required &&
    Boolean(options.approvedSnapshot) &&
    approvalInvalidationReasons.length <= 0;
  if (blockedReasons.length > 0) {
    const reasons = dedupeStrings([...blockedReasons, ...approvalInvalidationReasons], 16);
    return {
      version: 1,
      status: 'blocked',
      reasons,
      blockedReasons: dedupeStrings(blockedReasons, 16),
      approvalInvalidationReasons,
      exactNextApproval: exactNextApproval({
        status: 'blocked',
        mutationCapable: order.risk.mutationCapable,
        commandCapable: order.risk.commandCapable,
        generated: order.risk.generated,
        riskLevel: order.risk.level,
      }),
      executionAllowed: false,
      canAutoRun: false,
    };
  }
  if (order.risk.generated && order.risk.mutationCapable && riskValue(order.risk.level) >= 2) {
    return {
      version: 1,
      status: 'kira_review_required',
      reasons: dedupeStrings(['generated_medium_or_high_risk_requires_kira_review'], 16),
      blockedReasons: [],
      approvalInvalidationReasons,
      exactNextApproval: exactNextApproval({
        status: 'kira_review_required',
        mutationCapable: order.risk.mutationCapable,
        commandCapable: order.risk.commandCapable,
        generated: order.risk.generated,
        riskLevel: order.risk.level,
      }),
      executionAllowed: false,
      canAutoRun: false,
    };
  }
  if (order.approval.required && !approvalSatisfied && approvalInvalidationReasons.length > 0) {
    return {
      version: 1,
      status: 'approval_required',
      reasons: approvalInvalidationReasons,
      blockedReasons: [],
      approvalInvalidationReasons,
      exactNextApproval: exactNextApproval({
        status: 'approval_required',
        mutationCapable: order.risk.mutationCapable,
        commandCapable: order.risk.commandCapable,
        generated: order.risk.generated,
        riskLevel: order.risk.level,
      }),
      executionAllowed: false,
      canAutoRun: false,
    };
  }
  if (order.approval.required && !approvalSatisfied) {
    return {
      version: 1,
      status: 'approval_required',
      reasons: ['approval_required_before_execution'],
      blockedReasons: [],
      approvalInvalidationReasons: [],
      exactNextApproval: exactNextApproval({
        status: 'approval_required',
        mutationCapable: order.risk.mutationCapable,
        commandCapable: order.risk.commandCapable,
        generated: order.risk.generated,
        riskLevel: order.risk.level,
      }),
      executionAllowed: false,
      canAutoRun: false,
    };
  }
  return {
    version: 1,
    status: 'preview_only',
    reasons: [
      approvalSatisfied
        ? 'approval_satisfied_but_execution_still_requires_existing_gate'
        : 'preview_only_no_mutation_or_command_execution',
    ],
    blockedReasons: [],
    approvalInvalidationReasons: [],
    exactNextApproval: exactNextApproval({
      status: 'preview_only',
      mutationCapable: order.risk.mutationCapable,
      commandCapable: order.risk.commandCapable,
      generated: order.risk.generated,
      riskLevel: order.risk.level,
    }),
    executionAllowed: false,
    canAutoRun: false,
  };
}

export function createAoiBoundedWorkOrder(
  draft: AoiBoundedWorkOrderDraft,
  options: AoiBoundedWorkOrderPolicyOptions = {},
): AoiBoundedWorkOrder {
  const sessionPath = normalizeAoiAutonomySessionPath(draft.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const now = draft.now ?? options.now ?? DEFAULT_NOW;
  const objective = sanitizeText(draft.objective, 'Review bounded Aoi work.', 240);
  const baseRisk = draft.risk?.level ?? 'low';
  const evidenceRefs = dedupeStrings(draft.evidenceRefs ?? [], MAX_REFS);
  const rawAffectedSurfaces = draft.affectedSurfaces ?? [];
  const rawFiles = draft.files ?? [];
  const rawModules = draft.modules ?? [];
  const affectedSurfaces = dedupeStrings(rawAffectedSurfaces, MAX_SCOPE_ITEMS);
  const files = dedupeStrings(
    [...rawFiles, ...inferFilesFromSurfaces(affectedSurfaces)],
    MAX_SCOPE_ITEMS,
  );
  const modules = dedupeStrings(rawModules, MAX_SCOPE_ITEMS);
  const allowedOperations = [
    ...new Set<AoiBoundedWorkOrderOperation>(draft.allowedOperations ?? ['read', 'inspect']),
  ];
  const inferredMutationCapable =
    draft.risk?.mutationCapable === true || allowedOperations.some(operationMutates);
  const inferredCommandCapable =
    draft.risk?.commandCapable === true ||
    allowedOperations.some(operationRunsCommand) ||
    (draft.commands?.length ?? 0) > 0;
  const generated = draft.origin?.generated ?? false;
  const checkpoint = normalizeCheckpoint(draft.checkpoint, inferredMutationCapable);
  const rollback = normalizeRollback(draft.rollback, inferredMutationCapable);
  const initialCommands = buildCommandPreviews({
    sessionPath,
    objective,
    commands: draft.commands ?? [],
    risk: baseRisk,
    now,
    evidenceRefs,
  });
  const broadScopeDetected =
    isBroadText(objective) || [...affectedSurfaces, ...files, ...modules].some(isBroadText);
  const unsafeScopeDetected = [...rawAffectedSurfaces, ...rawFiles, ...rawModules].some(
    isUnsafeScopeText,
  );
  const scopeHash = buildScopeHash({
    affectedSurfaces,
    files,
    modules,
    allowedOperations,
  });
  const risk = deriveRisk({
    baseLevel: baseRisk,
    mutationCapable: inferredMutationCapable,
    commandCapable: inferredCommandCapable,
    generated,
    broadScopeDetected,
    checkpoint,
    rollback,
    commandPreviews: initialCommands,
    reasons: [],
  });
  const commands =
    risk.level === baseRisk
      ? initialCommands
      : buildCommandPreviews({
          sessionPath,
          objective,
          commands: draft.commands ?? [],
          risk: risk.level,
          now,
          evidenceRefs,
        });
  const fileScopeHash = buildFileScopeHash(files, modules);
  const approvalBaseFingerprint = buildApprovalFingerprint({
    objective,
    scopeHash,
    fileScopeHash,
    commands,
    riskLevel: risk.level,
  });
  const approvalRequired =
    draft.approval?.required ??
    (risk.mutationCapable || risk.commandCapable || riskValue(risk.level) >= riskValue('medium'));
  const approver =
    draft.approval?.approver ??
    (generated && risk.mutationCapable && riskValue(risk.level) >= 2
      ? 'kira_reviewer'
      : risk.commandCapable
        ? 'approved_command_runner'
        : approvalRequired
          ? 'operator'
          : 'none');
  const scope: AoiBoundedWorkOrderScope = {
    version: 1,
    affectedSurfaces,
    files,
    modules,
    allowedOperations,
    forbiddenOperations: dedupeStrings(
      draft.forbiddenOperations ?? defaultForbiddenOperations(risk.mutationCapable),
      12,
    ),
    explicitScope: files.length > 0 || modules.length > 0,
    scopeHash,
    broadScopeDetected,
    unsafeScopeDetected,
  };
  const expectedDiffShape = buildExpectedDiffShape({
    draftShape: draft.expectedDiffShape,
    mutationCapable: risk.mutationCapable,
    files,
    modules,
    affectedSurfaces,
  });
  const validationRequired =
    risk.mutationCapable || draft.validation?.required === true || commands.length > 0;
  const validationSummary = sanitizeText(
    draft.validation?.summary,
    commands.length > 0
      ? 'Validation commands are previewed but not run by the work order.'
      : risk.mutationCapable
        ? 'A validation command preview is required before mutation-capable work can proceed.'
        : 'No validation command is required for this read-only preview.',
    220,
  );
  const validationExpectedEvidenceRefs = dedupeStrings(
    draft.validation?.expectedEvidenceRefs ?? [],
    12,
  );
  const firstCommand = commands[0];
  const expectedSandboxMutationCount = expectedSandboxMutationCountForWorkOrder({
    operations: allowedOperations,
    mutationCapable: risk.mutationCapable,
  });
  const approvalSandbox = createAoiApprovalSandboxPreview({
    targetKind: sandboxTargetKindForWorkOrder(allowedOperations, risk.commandCapable),
    targetId: `${sessionPath}:${scopeHash}:${fileScopeHash}`,
    intendedMutation: risk.mutationCapable
      ? expectedDiffShape.summary
      : risk.commandCapable
        ? `Run validation command preview: ${firstCommand?.command ?? 'no command'}`
        : objective,
    dryRunSummary: `${objective}; scope=${scopeHash}; files=${fileScopeHash}; expected=${expectedDiffShape.summary}`,
    requiredAuthorityDecisionId: `bounded-work-order:${approvalBaseFingerprint}`,
    expectedMutationCount: expectedSandboxMutationCount,
    beforeSnapshotRef: checkpoint.evidenceRefs[0],
    recoveryPlan: {
      kind: checkpoint.required
        ? checkpoint.available
          ? 'before_snapshot'
          : 'manual_recovery'
        : 'not_applicable',
      available: checkpoint.available,
      summary: checkpoint.summary,
      evidenceRefs: checkpoint.evidenceRefs,
    },
    rollback: {
      required: expectedSandboxMutationCount > 0,
      note: [rollback.summary, ...rollback.instructions].join(' '),
      evidenceRefs: rollback.evidenceRefs,
    },
    postActionValidation: {
      kind: firstCommand ? 'command' : validationRequired ? 'check' : 'not_applicable',
      label: validationSummary,
      ...(firstCommand ? { command: firstCommand.command } : { check: validationSummary }),
      evidenceRefs: validationExpectedEvidenceRefs,
    },
    command: firstCommand?.command,
    cwd: firstCommand?.cwd,
    evidenceRefs: [
      ...evidenceRefs,
      ...commands.map((command) => `approved-command:${command.approvalFingerprint}`),
    ],
  });
  const approvalFingerprint = approvalSandbox.approvalFingerprint;
  const approval: AoiBoundedWorkOrderApproval = {
    version: 1,
    required: approvalRequired,
    requiredAutonomyLevel:
      draft.approval?.requiredAutonomyLevel ??
      (risk.commandCapable
        ? 'L5'
        : risk.level === 'high'
          ? 'L5'
          : risk.level === 'medium'
            ? 'L4'
            : 'L3'),
    approver,
    exactNextApproval: exactNextApproval({
      mutationCapable: risk.mutationCapable,
      commandCapable: risk.commandCapable,
      generated,
      riskLevel: risk.level,
    }),
    approvalFingerprint,
    satisfied: false,
    invalidationReasons: [],
    ...(draft.approval?.approvalRef ? { approvalRef: draft.approval.approvalRef } : {}),
  };
  const validation: AoiBoundedWorkOrderValidation = {
    version: 1,
    required: validationRequired,
    approvalRequiredBeforeRun: draft.validation?.approvalRequiredBeforeRun ?? commands.length > 0,
    summary: validationSummary,
    commands,
    expectedEvidenceRefs: validationExpectedEvidenceRefs,
  };
  const sourceRefs = dedupeStrings(
    [
      ...(draft.sourceRefs ?? []),
      draft.origin?.ref,
      ...evidenceRefs,
      ...commands.map((command) => `approved-command:${command.approvalFingerprint}`),
    ],
    MAX_REFS,
  );
  const baseOrder: Omit<
    AoiBoundedWorkOrder,
    'status' | 'policyResult' | 'reviewRequirement' | 'stopConditions'
  > = {
    version: 1,
    id: `aoi-work-order-${hashStable(`${sessionPath}:${objective}:${scopeHash}:${now}`)}`,
    sessionPath,
    objective,
    owner: draft.owner ?? 'aoi',
    origin: {
      version: 1,
      kind: draft.origin?.kind ?? 'manual',
      ref: sanitizeText(draft.origin?.ref, 'manual', 160),
      label: sanitizeText(draft.origin?.label, 'Manual bounded work order', 180),
      generated,
    },
    sourceRefs,
    scope,
    allowedOperations,
    forbiddenOperations: scope.forbiddenOperations,
    expectedDiffShape,
    commands,
    risk,
    approval,
    validation,
    checkpoint,
    rollback,
    approvalSandbox,
    evidenceRefs,
    createdAt: now,
    updatedAt: now,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
  const policyResult = evaluateAoiBoundedWorkOrderPolicy(baseOrder, options);
  const approvalWithResult = {
    ...baseOrder.approval,
    exactNextApproval: policyResult.exactNextApproval,
    satisfied:
      baseOrder.approval.required &&
      policyResult.status === 'preview_only' &&
      policyResult.approvalInvalidationReasons.length <= 0 &&
      Boolean(options.approvedSnapshot),
    invalidationReasons: policyResult.approvalInvalidationReasons,
  };
  const reviewRequirement = buildReviewRequirement({
    draftRequirement: draft.reviewRequirement,
    approval: approvalWithResult,
    risk,
    policyResult,
  });
  const stopConditions = buildStopConditions({
    draftConditions: draft.stopConditions,
    order: baseOrder,
    policyResult,
  });
  return {
    ...baseOrder,
    status: statusFromPolicyResult({
      policyResult,
      approval: approvalWithResult,
    }),
    approval: approvalWithResult,
    reviewRequirement,
    stopConditions,
    policyResult,
  };
}

function operationForProposalKind(kind: string | undefined): AoiBoundedWorkOrderOperation[] {
  if (kind === 'run_command') {
    return ['run_validation_command'];
  }
  if (kind === 'create_kira_work') {
    return ['create_kira_work', 'preview_changes'];
  }
  if (kind === 'start_research') {
    return ['start_research'];
  }
  if (kind === 'save_memory') {
    return ['save_memory'];
  }
  if (kind === 'open_research_artifact' || kind === 'read_research_artifact') {
    return ['read', 'summarize'];
  }
  if (kind === 'get_research_status' || kind === 'open_app' || kind === 'activate_goal') {
    return ['inspect'];
  }
  return ['inspect'];
}

function commandsFromPreparedPlan(
  proposal: AoiProposal,
  commands: string[],
): AoiBoundedWorkOrderCommandInput[] {
  const params = proposal.acceptAction?.params ?? {};
  return commands.map((command) => ({
    command,
    cwd: getStringParam(params, 'cwd') || getStringParam(params, 'directory') || '.',
    purpose: getStringParam(params, 'purpose') || proposal.title,
  }));
}

export function buildAoiBoundedWorkOrderFromProposal(
  proposal: AoiProposal,
  options: AoiBoundedWorkOrderBuilderOptions = {},
): AoiBoundedWorkOrder {
  const plan = buildAoiPreparedActionPlan(proposal, { now: options.now });
  const params = proposal.acceptAction?.params ?? {};
  const kind =
    typeof proposal.acceptAction?.kind === 'string'
      ? (proposal.acceptAction.kind as string)
      : undefined;
  const files = getStringListParam(params, [
    'file',
    'files',
    'filePaths',
    'file_paths',
    'affectedFiles',
    'affected_files',
    'likelyFilesOrModules',
  ]);
  const modules = getStringListParam(params, ['module', 'modules', 'scope', 'surfaces']);
  const generated = options.generated ?? proposal.trigger !== 'manual';
  return createAoiBoundedWorkOrder(
    {
      sessionPath: proposal.sessionPath,
      objective: plan.objective || proposal.title,
      owner: 'aoi',
      origin: {
        kind:
          proposal.status === 'accepted' || proposal.status === 'executed'
            ? 'accepted_proposal'
            : 'proposal_preview',
        ref: `proposal:${proposal.id}`,
        label: proposal.title,
        generated,
      },
      affectedSurfaces: dedupeStrings([...plan.affectedSurfaces, ...files, ...modules], 24),
      files,
      modules,
      allowedOperations: operationForProposalKind(kind),
      commands: commandsFromPreparedPlan(proposal, plan.validation.commands),
      risk: {
        level: plan.risk.level,
        mutationCapable: plan.risk.mutationCapable,
        commandCapable: plan.risk.commandCapable,
      },
      approval: {
        required: plan.approval.required,
        requiredAutonomyLevel: plan.approval.requiredLevel,
        approver: plan.approval.approver === 'kira_reviewer' ? 'kira_reviewer' : undefined,
        approvalRef: `proposal:${proposal.id}`,
      },
      validation: {
        required: plan.validation.required,
        approvalRequiredBeforeRun: plan.validation.approvalRequiredBeforeRun,
        summary: plan.validation.summary,
        expectedEvidenceRefs: plan.validation.expectedEvidenceRefs,
      },
      checkpoint: plan.checkpoint,
      rollback: plan.rollback,
      evidenceRefs: dedupeStrings(
        [`proposal:${proposal.id}`, ...proposal.evidenceRefs, ...proposal.artifactRefs],
        MAX_REFS,
      ),
      now: options.now,
    },
    options,
  );
}

function operationForPlaybookStep(stepKind: string): AoiBoundedWorkOrderOperation[] {
  if (stepKind === 'run_approved_command') {
    return ['run_validation_command'];
  }
  if (stepKind === 'create_kira_work') {
    return ['create_kira_work', 'preview_changes'];
  }
  if (stepKind === 'start_research') {
    return ['start_research'];
  }
  if (stepKind === 'preview_command') {
    return ['inspect'];
  }
  if (stepKind === 'read_research_artifact') {
    return ['read', 'summarize'];
  }
  if (stepKind === 'ask_user') {
    return ['ask_operator'];
  }
  return ['inspect'];
}

export function buildAoiBoundedWorkOrderFromPlaybook(
  playbook: AoiPlaybook,
  options: AoiBoundedWorkOrderBuilderOptions = {},
): AoiBoundedWorkOrder | null {
  const nextStep = playbook.steps.find((step) => step.id === playbook.nextStepId);
  if (!nextStep) {
    return null;
  }
  const commands = nextStep.validationNotes
    .filter((note) => /\b(?:pnpm|git)\b/i.test(note))
    .map((command) => ({
      command,
      cwd: '.',
      purpose: nextStep.title,
    }));
  return createAoiBoundedWorkOrder(
    {
      sessionPath: playbook.sessionPath,
      objective: playbook.nextRequiredDecision || nextStep.summary,
      owner: 'aoi',
      origin: {
        kind: 'playbook_next_step',
        ref: `playbook:${playbook.id}:${nextStep.id}`,
        label: `${playbook.title}: ${nextStep.title}`,
        generated: options.generated ?? true,
      },
      affectedSurfaces: dedupeStrings(
        [playbook.title, nextStep.title, ...nextStep.sourceRefs, ...nextStep.validationNotes],
        18,
      ),
      modules: dedupeStrings(nextStep.sourceRefs, 12),
      allowedOperations: operationForPlaybookStep(nextStep.kind),
      commands,
      risk: {
        level:
          nextStep.executionBoundary.requiredAutonomyLevel === 'L5'
            ? 'high'
            : nextStep.executionBoundary.requiredAutonomyLevel === 'L4'
              ? 'medium'
              : 'low',
        mutationCapable: nextStep.executionBoundary.mutationCapable,
        commandCapable: nextStep.executionBoundary.commandCapable || commands.length > 0,
      },
      approval: {
        required: nextStep.executionBoundary.requiresApproval,
        requiredAutonomyLevel: nextStep.executionBoundary.requiredAutonomyLevel,
        approvalRef: nextStep.executionBoundary.approvalRef,
      },
      checkpoint: {
        kind: nextStep.checkpointNotes.length > 0 ? 'existing_git_state' : 'not_applicable',
        required: nextStep.executionBoundary.mutationCapable,
        available:
          !nextStep.executionBoundary.mutationCapable || nextStep.checkpointNotes.length > 0,
        summary: nextStep.checkpointNotes[0],
        evidenceRefs: nextStep.evidenceRefs,
      },
      rollback: {
        kind: nextStep.rollbackNotes.length > 0 ? 'manual_revert_required' : 'not_applicable',
        available: !nextStep.executionBoundary.mutationCapable || nextStep.rollbackNotes.length > 0,
        guarantee: 'none',
        summary: nextStep.rollbackNotes[0],
        instructions: nextStep.rollbackNotes,
        evidenceRefs: nextStep.evidenceRefs,
      },
      validation: {
        required: commands.length > 0 || nextStep.executionBoundary.mutationCapable,
        approvalRequiredBeforeRun: commands.length > 0,
        summary: nextStep.validationNotes[0],
        expectedEvidenceRefs: nextStep.evidenceRefs,
      },
      evidenceRefs: dedupeStrings([`playbook:${playbook.id}`, ...playbook.evidenceRefs], MAX_REFS),
      now: options.now,
    },
    options,
  );
}

// P1a c5 (plan decomposition): turn an active goal's open plan step into a
// display-only bounded work-order preview. createAoiBoundedWorkOrder always
// stamps actionAuthority:'display_only' + mutationCount:0, so this is a preview
// of the next bounded unit of work for the goal -- never an execution.
export function buildAoiBoundedWorkOrderFromGoalStep(
  goal: AoiGoal,
  step: AoiPlanStep,
  options: AoiBoundedWorkOrderBuilderOptions = {},
): AoiBoundedWorkOrder {
  const actionKind = step.allowedActionKind === 'none' ? undefined : step.allowedActionKind;
  const allowedOperations = operationForProposalKind(actionKind);
  const mutationCapable = allowedOperations.some(operationMutates);
  const commandCapable = allowedOperations.some(operationRunsCommand);
  const requiresApproval =
    step.risk === 'high' ||
    mutationCapable ||
    commandCapable ||
    step.requiredAutonomyLevel === 'L4' ||
    step.requiredAutonomyLevel === 'L5';
  return createAoiBoundedWorkOrder(
    {
      sessionPath: goal.sessionPath,
      objective: step.title,
      owner: 'aoi',
      origin: {
        kind: 'goal_plan_step',
        ref: `goal:${goal.id}/step:${step.id}`,
        label: `${goal.title}: ${step.title}`,
        generated: options.generated ?? true,
      },
      affectedSurfaces: dedupeStrings([goal.title, step.title, ...step.expectedEvidence], 18),
      modules: dedupeStrings(goal.sourceRefs, 12),
      allowedOperations,
      risk: {
        level: step.risk,
        mutationCapable,
        commandCapable,
      },
      approval: {
        required: requiresApproval,
        requiredAutonomyLevel: step.requiredAutonomyLevel,
        approvalRef: `goal:${goal.id}/step:${step.id}`,
      },
      validation: {
        required: mutationCapable || commandCapable,
        approvalRequiredBeforeRun: commandCapable,
        summary: step.doneCriteria[0],
        expectedEvidenceRefs: step.evidenceRefs,
      },
      stopConditions: step.doneCriteria,
      evidenceRefs: dedupeStrings(
        [
          `goal:${goal.id}`,
          `goal:${goal.id}/step:${step.id}`,
          ...step.evidenceRefs,
          ...goal.sourceRefs,
        ],
        MAX_REFS,
      ),
      now: options.now,
    },
    options,
  );
}

export function buildAoiBoundedWorkOrderFromMissionControlTopMission(
  input: {
    missionControl?: AoiMissionControlState | null;
    topMission?: AoiMissionControlItem | null;
  },
  options: AoiBoundedWorkOrderBuilderOptions = {},
): AoiBoundedWorkOrder | null {
  const mission = input.topMission ?? input.missionControl?.topMission;
  if (!mission) {
    return null;
  }
  return createAoiBoundedWorkOrder(
    {
      sessionPath: mission.sessionPath,
      objective: mission.nextSafeAction.label || mission.lastKnownState,
      owner: mission.owner === 'aoi' ? 'aoi' : mission.owner === 'user' ? 'user' : 'shared',
      origin: {
        kind: 'mission_control_top_mission',
        ref: `mission-control:${mission.missionId}`,
        label: mission.lastKnownState,
        generated: options.generated ?? true,
      },
      affectedSurfaces: dedupeStrings(
        [
          mission.lastKnownWorkspaceState,
          ...mission.sourceFreshnessRefs,
          ...mission.validationRefs,
          ...mission.playbookRefs,
        ],
        18,
      ),
      modules: dedupeStrings([...mission.validationRefs, ...mission.playbookRefs], 12),
      allowedOperations:
        mission.nextSafeAction.kind === 'prepare_preview'
          ? ['inspect']
          : mission.nextSafeAction.kind === 'ask'
            ? ['ask_operator']
            : ['inspect', 'summarize'],
      risk: {
        level: mission.priority === 'critical' || mission.priority === 'high' ? 'medium' : 'low',
        mutationCapable: false,
        commandCapable: false,
      },
      approval: {
        required: mission.nextSafeAction.requiresApproval,
        requiredAutonomyLevel: mission.nextSafeAction.requiresApproval ? 'L3' : 'L1',
        approvalRef: mission.nextSafeAction.ref,
      },
      validation: {
        required: false,
        approvalRequiredBeforeRun: false,
        summary: 'Mission control can prepare a preview only; it cannot execute.',
        expectedEvidenceRefs: mission.evidenceRefs,
      },
      checkpoint: {
        kind: 'not_applicable',
        required: false,
        available: true,
        summary: 'No checkpoint is created by mission control preview.',
        evidenceRefs: [],
      },
      rollback: {
        kind: 'not_applicable',
        available: true,
        guarantee: 'none',
        summary: 'Mission control preview does not mutate state.',
        instructions: ['No rollback is expected for display-only mission work orders.'],
        evidenceRefs: [],
      },
      evidenceRefs: dedupeStrings(
        [`mission-control:${mission.missionId}`, ...mission.evidenceRefs],
        MAX_REFS,
      ),
      now: options.now,
    },
    options,
  );
}

export function buildAoiBoundedWorkOrderFromShadowUsefulLabel(
  report: AoiShadowDecisionReport,
  options: AoiBoundedWorkOrderBuilderOptions = {},
): AoiBoundedWorkOrder | null {
  const label = [...report.labels]
    .filter((item) => item.label === 'useful')
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (!label) {
    return null;
  }
  const decision = report.decisions.find((item) => item.id === label.decisionId);
  if (!decision) {
    return null;
  }
  return createAoiBoundedWorkOrder(
    {
      sessionPath: report.sessionPath,
      objective:
        decision.suggestedAction || decision.operatorMessagePreview || decision.sourceSummary,
      owner: 'aoi',
      origin: {
        kind: 'shadow_useful_label',
        ref: `shadow-decision:${decision.id}`,
        label: `Useful shadow label: ${decision.kind}`,
        generated: options.generated ?? true,
      },
      affectedSurfaces: dedupeStrings([...decision.sourceRefs, decision.sourceSummary], 16),
      modules: dedupeStrings(decision.sourceRefs, 12),
      allowedOperations: ['inspect', 'summarize'],
      risk: {
        level: decision.risk,
        mutationCapable: false,
        commandCapable: false,
      },
      approval: {
        required: false,
        requiredAutonomyLevel: 'L1',
        approvalRef: `operator-feedback:${label.id}`,
      },
      validation: {
        required: false,
        approvalRequiredBeforeRun: false,
        summary: 'Useful shadow labels may prepare a reviewable summary only.',
        expectedEvidenceRefs: decision.evidenceRefs,
      },
      checkpoint: {
        kind: 'not_applicable',
        required: false,
        available: true,
        summary: 'No checkpoint is required for a shadow-label summary.',
        evidenceRefs: [],
      },
      rollback: {
        kind: 'not_applicable',
        available: true,
        guarantee: 'none',
        summary: 'Shadow-label work orders do not mutate state.',
        instructions: [
          'Keep this as review evidence until the operator approves a separate action.',
        ],
        evidenceRefs: [],
      },
      evidenceRefs: dedupeStrings(
        [`shadow-decision:${decision.id}`, `shadow-label:${label.id}`, ...decision.evidenceRefs],
        MAX_REFS,
      ),
      now: options.now,
    },
    options,
  );
}

export function buildAoiBoundedWorkOrders(input: AoiBoundedWorkOrdersInput): AoiBoundedWorkOrder[] {
  const orders: AoiBoundedWorkOrder[] = [];
  const missionOrder = buildAoiBoundedWorkOrderFromMissionControlTopMission(
    {
      missionControl: input.missionControl,
    },
    input,
  );
  if (missionOrder) {
    orders.push(missionOrder);
  }
  for (const playbook of input.playbooks ?? []) {
    const order = buildAoiBoundedWorkOrderFromPlaybook(playbook, input);
    if (order) {
      orders.push(order);
    }
  }
  for (const proposal of input.proposals ?? []) {
    if (proposal.status !== 'accepted' && proposal.status !== 'active') {
      continue;
    }
    orders.push(buildAoiBoundedWorkOrderFromProposal(proposal, input));
  }
  if (input.shadowReport) {
    const order = buildAoiBoundedWorkOrderFromShadowUsefulLabel(input.shadowReport, input);
    if (order) {
      orders.push(order);
    }
  }
  const seen = new Set<string>();
  return orders.filter((order) => {
    if (seen.has(order.id)) {
      return false;
    }
    seen.add(order.id);
    return true;
  });
}

export function createAoiBoundedWorkOrderApprovalSnapshot(
  order: AoiBoundedWorkOrder,
  params: {
    approvedAt?: number;
    expiresAt?: number;
    evidenceRefs?: string[];
  } = {},
): AoiBoundedWorkOrderApprovalSnapshot {
  const approvedAt = params.approvedAt ?? order.updatedAt;
  return {
    version: 1,
    approvalFingerprint: order.approval.approvalFingerprint,
    commandFingerprints: order.commands.map((command) => command.approvalFingerprint),
    cwdHashes: order.commands.map((command) => command.cwdHash),
    scopeHash: order.scope.scopeHash,
    fileScopeHash: buildFileScopeHash(order.scope.files, order.scope.modules),
    sandboxPreviewHash: order.approvalSandbox.previewHash,
    sandboxAuthorityDecisionId: order.approvalSandbox.requiredAuthorityDecisionId,
    sandboxRecoveryHash: order.approvalSandbox.recoveryPlan.recoveryHash,
    sandboxRollbackHash: order.approvalSandbox.rollback.rollbackHash,
    sandboxValidationHash: order.approvalSandbox.postActionValidation.validationHash,
    sandboxEnvHash: order.approvalSandbox.envHash,
    riskLevel: order.risk.level,
    approvedAt,
    expiresAt: params.expiresAt ?? approvedAt + AOI_COMMAND_APPROVAL_TTL_MS,
    evidenceRefs: dedupeStrings(params.evidenceRefs ?? order.evidenceRefs, 12),
  };
}
