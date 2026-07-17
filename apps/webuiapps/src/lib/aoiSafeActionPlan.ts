import { buildAoiKiraHandoffPreview } from './aoiKiraHandoff';
import {
  createAoiApprovalSandboxPreview,
  hasAoiApprovalSandboxRecoveryEvidence,
} from './aoiApprovalSandbox';
import type {
  AoiActionRisk,
  AoiApprovedFileMutationPolicy,
  AoiApprovalRequirement,
  AoiAutonomyLevel,
  AoiAutonomyRisk,
  AoiCheckpointPlan,
  AoiPreparedActionPlan,
  AoiProposal,
  AoiRollbackPlan,
  AoiValidationPlan,
} from './aoiAutonomyTypes';
import {
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import type { AoiApprovalSandboxTargetKind } from './aoiApprovalSandbox';

const DEFAULT_VALIDATION_COMMANDS = [
  'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts src/lib/__tests__/aoiAutonomyPolicy.test.ts src/lib/__tests__/aoiAutonomyUi.test.ts',
];

export interface AoiPreparedActionPlanOptions {
  now?: number;
  existingGitStateAvailable?: boolean;
  checkpointEvidenceRefs?: string[];
}

export interface AoiValidationCommandPlanInput {
  objective: string;
  command: string;
  evidenceRefs?: string[];
  affectedSurfaces?: string[];
  requiredAutonomyLevel?: AoiAutonomyLevel;
  risk?: AoiAutonomyRisk;
}

export interface AoiPreviewOnlyFileWorkPlanInput {
  objective: string;
  expectedChanges?: string[];
  affectedSurfaces?: string[];
  evidenceRefs?: string[];
  requiredAutonomyLevel?: AoiAutonomyLevel;
  risk?: AoiAutonomyRisk;
  existingGitStateAvailable?: boolean;
  checkpointEvidenceRefs?: string[];
  validationCommands?: string[];
}

function normalizeText(value: unknown, fallback: string, maxChars = 220): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  return normalized || fallback;
}

function getStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getStringListParam(
  params: Record<string, unknown>,
  keys: string[],
  fallback: string[] = [],
): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          values.push(normalizeText(item, item, 180));
        }
      }
    }
    if (typeof value === 'string' && value.trim()) {
      values.push(normalizeText(value, value, 180));
    }
  }
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique.slice(0, 12) : fallback;
}

function dedupeStrings(
  values: Array<string | undefined | null>,
  fallback: string[] = [],
): string[] {
  const result = values
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizeText(item, item, 220));
  const unique = [...new Set(result)];
  return unique.length > 0 ? unique : fallback;
}

function actionParams(proposal: AoiProposal): Record<string, unknown> {
  return proposal.acceptAction?.params ?? {};
}

function makeRisk(params: {
  level: AoiAutonomyRisk;
  mutationCapable: boolean;
  commandCapable?: boolean;
  reasons: string[];
}): AoiActionRisk {
  return {
    level: params.level,
    mutationCapable: params.mutationCapable,
    commandCapable: params.commandCapable === true,
    reasons: dedupeStrings(params.reasons),
  };
}

function makeApproval(params: {
  required: boolean;
  requiredLevel: AoiAutonomyLevel;
  freshAcceptanceRequired: boolean;
  approver?: AoiApprovalRequirement['approver'];
  reason: string;
}): AoiApprovalRequirement {
  return {
    required: params.required,
    requiredLevel: params.requiredLevel,
    freshAcceptanceRequired: params.freshAcceptanceRequired,
    approver: params.approver ?? (params.required ? 'user' : 'none'),
    reason: normalizeText(params.reason, 'Approval boundary is unspecified.'),
  };
}

function notApplicableCheckpoint(summary: string): AoiCheckpointPlan {
  return {
    kind: 'not_applicable',
    required: false,
    available: true,
    summary,
    instructions: ['No checkpoint is created by this preparation plan.'],
    evidenceRefs: [],
  };
}

function manualCheckpoint(params: {
  available: boolean;
  evidenceRefs?: string[];
  summary?: string;
}): AoiCheckpointPlan {
  return {
    kind: params.available ? 'existing_git_state' : 'manual_checkpoint_required',
    required: true,
    available: params.available,
    summary:
      params.summary ??
      (params.available
        ? 'Use the existing git state as the review baseline. No new checkpoint is created here.'
        : 'A manual checkpoint is required before this risky file work can be approved.'),
    instructions: params.available
      ? [
          'Inspect the current git status before approving any mutation-capable follow-up.',
          'Use the existing git diff as the rollback baseline; this plan does not create a snapshot.',
        ]
      : [
          'Create or identify a checkpoint through an approved workspace mechanism before mutation.',
          'Do not approve direct file mutation from this prepared plan.',
        ],
    evidenceRefs: dedupeStrings(params.evidenceRefs ?? []),
    ...(params.available
      ? {}
      : {
          missingReason: 'missing_checkpoint_for_risky_mutation',
        }),
  };
}

function kiraCheckpoint(evidenceRefs: string[]): AoiCheckpointPlan {
  return {
    kind: 'kira_isolated_worktree',
    required: true,
    available: true,
    summary:
      'Kira performs mutation work in a supervised isolated work item before any reviewed integration.',
    instructions: [
      'Create a Kira work item only after explicit user approval.',
      'Require Kira review and validation evidence before any integration decision.',
    ],
    evidenceRefs,
  };
}

function makeValidation(params: {
  required: boolean;
  approvalRequiredBeforeRun: boolean;
  summary: string;
  commands?: string[];
  expectedEvidenceRefs?: string[];
}): AoiValidationPlan {
  return {
    required: params.required,
    approvalRequiredBeforeRun: params.approvalRequiredBeforeRun,
    summary: normalizeText(params.summary, 'Validation requirements are unspecified.'),
    commands: dedupeStrings(params.commands ?? [], []),
    expectedEvidenceRefs: dedupeStrings(params.expectedEvidenceRefs ?? [], []),
  };
}

function makeRollback(params: {
  kind: AoiRollbackPlan['kind'];
  available: boolean;
  guarantee: AoiRollbackPlan['guarantee'];
  summary: string;
  instructions: string[];
  evidenceRefs?: string[];
}): AoiRollbackPlan {
  return {
    kind: params.kind,
    available: params.available,
    guarantee: params.guarantee,
    summary: normalizeText(params.summary, 'Rollback is not specified.'),
    instructions: dedupeStrings(params.instructions),
    evidenceRefs: dedupeStrings(params.evidenceRefs ?? []),
  };
}

function sandboxTargetKind(actionKind: string): AoiApprovalSandboxTargetKind {
  if (actionKind === 'create_kira_work') {
    return 'kira';
  }
  if (actionKind === 'start_research') {
    return 'research';
  }
  if (actionKind === 'run_validation_command') {
    return 'command';
  }
  if (actionKind === 'preview_only_file_work') {
    return 'workspace';
  }
  if (actionKind === 'save_memory') {
    return 'memory';
  }
  return 'unknown';
}

function expectedMutationCountForPlan(
  plan: Pick<AoiPreparedActionPlan, 'actionKind' | 'risk'>,
): 0 | 1 {
  if (
    plan.actionKind === 'run_validation_command' ||
    plan.actionKind === 'preview_only_file_work'
  ) {
    return 0;
  }
  return plan.risk.mutationCapable ||
    plan.actionKind === 'create_kira_work' ||
    plan.actionKind === 'start_research' ||
    plan.actionKind === 'save_memory'
    ? 1
    : 0;
}

function buildPreparedActionSandbox(
  plan: Omit<AoiPreparedActionPlan, 'status' | 'blockers' | 'approvalSandbox'>,
) {
  const firstCommand = plan.validation.commands[0];
  return createAoiApprovalSandboxPreview({
    targetKind: sandboxTargetKind(plan.actionKind),
    targetId: `${plan.actionKind}:${plan.affectedSurfaces.join('|') || plan.objective}`,
    intendedMutation: plan.expectedChanges.join(' / ') || plan.objective,
    dryRunSummary: plan.objective,
    requiredAuthorityDecisionId: plan.approval.required
      ? `prepared-action:${plan.actionKind}:${plan.approval.requiredLevel}`
      : `prepared-action:${plan.actionKind}:no-approval-required`,
    expectedMutationCount: expectedMutationCountForPlan(plan),
    beforeSnapshotRef: plan.checkpoint.evidenceRefs[0],
    recoveryPlan: {
      kind: plan.checkpoint.required
        ? plan.checkpoint.available
          ? 'before_snapshot'
          : 'manual_recovery'
        : 'not_applicable',
      available: plan.checkpoint.available,
      summary: plan.checkpoint.summary,
      evidenceRefs: plan.checkpoint.evidenceRefs,
    },
    rollback: {
      required: expectedMutationCountForPlan(plan) > 0,
      note: [plan.rollback.summary, ...plan.rollback.instructions].join(' '),
      evidenceRefs: plan.rollback.evidenceRefs,
    },
    postActionValidation: {
      kind: firstCommand ? 'command' : plan.validation.required ? 'check' : 'not_applicable',
      label: plan.validation.summary,
      ...(firstCommand ? { command: firstCommand } : { check: plan.validation.summary }),
      evidenceRefs: plan.validation.expectedEvidenceRefs,
    },
    command: firstCommand,
    cwd: '.',
    evidenceRefs: plan.evidenceRefs,
  });
}

function finalizePlan(
  plan: Omit<AoiPreparedActionPlan, 'status' | 'blockers'> & {
    blockers?: string[];
  },
  options: { approvedMutationRunner?: boolean } = {},
): AoiPreparedActionPlan {
  const blockers = [...(plan.blockers ?? [])];
  const approvalSandbox = buildPreparedActionSandbox(plan);
  if (!hasAoiApprovalSandboxRecoveryEvidence(approvalSandbox)) {
    blockers.push('rollback_recovery_evidence_missing');
  }
  if (plan.risk.level === 'high' && plan.checkpoint.required && !plan.checkpoint.available) {
    blockers.push('missing_checkpoint_for_risky_mutation');
  }
  if (
    plan.risk.mutationCapable &&
    plan.actionKind !== 'create_kira_work' &&
    options.approvedMutationRunner !== true
  ) {
    blockers.push('mutation_requires_kira_or_approved_runner');
  }
  const uniqueBlockers = [...new Set(blockers)];
  return {
    ...plan,
    status: uniqueBlockers.length > 0 ? 'blocked' : 'ready',
    approvalSandbox,
    blockers: uniqueBlockers,
  };
}

export function buildAoiApprovedFileMutationPreparedActionPlan(
  proposal: AoiProposal,
  policy?: AoiApprovedFileMutationPolicy,
): AoiPreparedActionPlan {
  const params = actionParams(proposal);
  const actionKind = proposal.acceptAction?.kind;
  const operation =
    actionKind === 'file_patch' ? 'patch' : actionKind === 'file_delete' ? 'delete' : 'write';
  const resolvedPolicy =
    policy ??
    evaluateAoiApprovedFileMutationPolicy(
      createAoiApprovedFileMutationRequest({
        sessionPath: proposal.sessionPath,
        proposalId: proposal.id,
        operation,
        path: params.path,
        content: params.content,
        patchOps: params.patchOps ?? params.patch_ops,
        validationPlan: params.validationPlan ?? params.validation_plan,
        purpose: params.purpose ?? proposal.title,
        risk: proposal.risk,
        requestedAt: proposal.updatedAt,
        evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      }),
    );
  const evidenceRefs = dedupeStrings(
    [...proposal.evidenceRefs, ...proposal.artifactRefs],
    [`proposal:${proposal.id}`],
  );
  const validationSummary = resolvedPolicy.validationPlan
    ? `Require target SHA-256 ${resolvedPolicy.validationPlan.expectedBeforeSha256} before mutation and ${resolvedPolicy.validationPlan.expectedAfterSha256} after mutation.`
    : 'Re-read the target and verify the exact approved bytes before reporting success.';
  const plan = finalizePlan(
    {
      version: 1,
      actionKind: actionKind ?? 'file_write',
      objective: normalizeText(proposal.title, 'Apply an approved file mutation.'),
      expectedChanges: [
        resolvedPolicy.approvalSandbox?.dryRunSummary ?? resolvedPolicy.rationale[0],
      ],
      affectedSurfaces: [resolvedPolicy.pathLabel],
      evidenceRefs,
      risk: makeRisk({
        level: proposal.risk,
        mutationCapable: true,
        reasons: [
          'The exact path and mutation bytes are bound to a content-addressed L5 approval.',
          'The approved runner captures a target checkpoint before applying the mutation.',
        ],
      }),
      approval: makeApproval({
        required: true,
        requiredLevel: 'L5',
        freshAcceptanceRequired: true,
        reason: 'The exact file mutation requires a fresh operator acceptance at L5.',
      }),
      checkpoint: {
        kind: 'approved_runner_checkpoint',
        required: true,
        available: resolvedPolicy.allowed,
        summary:
          'The approved runner will capture the target pre-state immediately before mutation.',
        instructions: [
          'Re-evaluate the content-addressed approval before checkpoint creation.',
          'Persist the checkpoint id and fingerprint with the execution audit.',
        ],
        evidenceRefs,
        ...(resolvedPolicy.allowed ? {} : { missingReason: resolvedPolicy.blockReasons.join(',') }),
      },
      rollback: makeRollback({
        kind: 'approved_runner_checkpoint_restore',
        available: resolvedPolicy.allowed,
        guarantee: 'mechanism_backed',
        summary: 'Restore the captured pre-state automatically if exact validation fails.',
        instructions: [
          'Verify the target after mutation before reporting success.',
          'Restore the captured checkpoint when mutation or validation fails.',
        ],
        evidenceRefs,
      }),
      validation: makeValidation({
        required: true,
        approvalRequiredBeforeRun: true,
        summary: validationSummary,
        commands: [],
        expectedEvidenceRefs: ['aoi-file-validation:passed', ...evidenceRefs.slice(0, 4)],
      }),
      blockers: resolvedPolicy.allowed
        ? []
        : resolvedPolicy.blockReasons.map((reason) => `approved_file_mutation_blocked:${reason}`),
      nonGoals: [
        'Do not mutate any path other than the content-addressed approved target.',
        'Do not report success without checkpoint and post-write validation evidence.',
      ],
    },
    { approvedMutationRunner: true },
  );
  return {
    ...plan,
    ...(resolvedPolicy.approvalSandbox ? { approvalSandbox: resolvedPolicy.approvalSandbox } : {}),
  };
}

function buildAoiGoalActivationPreparedActionPlan(proposal: AoiProposal): AoiPreparedActionPlan {
  return finalizePlan({
    version: 1,
    actionKind: 'activate_goal',
    objective: normalizeText(proposal.title, 'Activate the approved Aoi goal.'),
    expectedChanges: ['Create one active goal and its bounded plan after operator acceptance.'],
    affectedSurfaces: ['Aoi goal store'],
    evidenceRefs: dedupeStrings(
      [...proposal.evidenceRefs, ...proposal.artifactRefs],
      [`proposal:${proposal.id}`],
    ),
    risk: makeRisk({
      level: proposal.risk,
      mutationCapable: false,
      reasons: ['Goal activation changes Aoi planning state but does not mutate workspace files.'],
    }),
    approval: makeApproval({
      required: true,
      requiredLevel: proposal.requiredAutonomyLevel,
      freshAcceptanceRequired: true,
      reason: 'Only the operator acceptance route may activate this goal.',
    }),
    checkpoint: notApplicableCheckpoint('Workspace checkpoint is not applicable to goal state.'),
    rollback: makeRollback({
      kind: 'not_applicable',
      available: true,
      guarantee: 'none',
      summary: 'The operator may pause, abandon, or complete the goal through goal governance.',
      instructions: ['Use the explicit goal decision route to change the activated goal state.'],
      evidenceRefs: proposal.evidenceRefs,
    }),
    validation: makeValidation({
      required: true,
      approvalRequiredBeforeRun: true,
      summary: 'Verify one active goal is linked to this accepted proposal.',
      commands: [],
      expectedEvidenceRefs: [`proposal:${proposal.id}`, ...proposal.evidenceRefs],
    }),
    nonGoals: ['Do not execute workspace actions while activating the goal.'],
  });
}

export function buildAoiKiraHandoffPreparedActionPlan(
  proposal: AoiProposal,
  options: AoiPreparedActionPlanOptions = {},
): AoiPreparedActionPlan {
  const preview = buildAoiKiraHandoffPreview(proposal, { now: options.now });
  const evidenceRefs = dedupeStrings(
    [...proposal.evidenceRefs, ...proposal.artifactRefs, ...preview.evidenceRefs],
    [`proposal:${proposal.id}`],
  );
  const validationCommands = dedupeStrings(
    preview.validationCommands.length > 0
      ? preview.validationCommands
      : DEFAULT_VALIDATION_COMMANDS,
  );

  return finalizePlan({
    version: 1,
    actionKind: 'create_kira_work',
    objective: normalizeText(preview.objective, proposal.title),
    expectedChanges: [
      'Create one supervised Kira work item.',
      'Do not edit repository files from Aoi during preparation.',
      'Require Kira review and validation evidence before integration.',
    ],
    affectedSurfaces: dedupeStrings(
      [...preview.scope, ...preview.likelyFilesOrModules],
      ['Kira work board'],
    ),
    evidenceRefs,
    risk: makeRisk({
      level: proposal.risk,
      mutationCapable: true,
      reasons: [
        'Kira may mutate files only inside the supervised work item after approval.',
        'Aoi preparation itself does not edit files.',
      ],
    }),
    approval: makeApproval({
      required: true,
      requiredLevel: proposal.requiredAutonomyLevel,
      freshAcceptanceRequired: true,
      reason: 'Creating Kira work requires explicit approval for this exact proposal.',
    }),
    checkpoint: kiraCheckpoint(evidenceRefs),
    rollback: makeRollback({
      kind: 'kira_review_reject_or_revert',
      available: true,
      guarantee: 'best_effort',
      summary:
        'Rollback depends on Kira review state; reject or revise the work item before integration.',
      instructions: [
        'If the Kira result is wrong before integration, reject the work item or request revision.',
        'If changes were integrated later, use the reviewed integration diff and project rollback process.',
        'Do not present rollback as certain from this plan.',
      ],
      evidenceRefs,
    }),
    validation: makeValidation({
      required: true,
      approvalRequiredBeforeRun: true,
      summary: 'Kira must provide validation evidence before review approval.',
      commands: validationCommands,
      expectedEvidenceRefs: ['kira:validation', ...evidenceRefs.slice(0, 4)],
    }),
    nonGoals: [
      'Do not execute file writes, patches, deletes, or commands from this plan.',
      'Do not bypass Kira review for mutation-capable work.',
    ],
  });
}

export function buildAoiResearchStartPreparedActionPlan(
  proposal: AoiProposal,
): AoiPreparedActionPlan {
  const params = actionParams(proposal);
  const request = getStringParam(params, 'request') || proposal.title;
  const mode = getStringParam(params, 'mode') || 'standard';
  const evidenceRefs = dedupeStrings(
    [...proposal.evidenceRefs, ...proposal.artifactRefs],
    [`proposal:${proposal.id}`],
  );

  return finalizePlan({
    version: 1,
    actionKind: 'start_research',
    objective: `Start Aoi research: ${normalizeText(request, proposal.title)}`,
    expectedChanges: [
      `Create a ${mode} Aoi research run and its run metadata.`,
      'Collect sources and write research artifacts through the research subsystem.',
    ],
    affectedSurfaces: ['Aoi research runs', 'Research artifact store'],
    evidenceRefs,
    risk: makeRisk({
      level: proposal.risk === 'low' ? 'medium' : proposal.risk,
      mutationCapable: false,
      reasons: ['Research creates run artifacts but does not edit workspace source files.'],
    }),
    approval: makeApproval({
      required: true,
      requiredLevel: proposal.requiredAutonomyLevel,
      freshAcceptanceRequired: true,
      reason: 'Starting research creates a new run and must be explicitly approved.',
    }),
    checkpoint: notApplicableCheckpoint(
      'Workspace checkpoint is not applicable because this action only creates research-run artifacts.',
    ),
    rollback: makeRollback({
      kind: 'research_cancel_or_ignore',
      available: true,
      guarantee: 'best_effort',
      summary:
        'Research rollback is best-effort: cancel if running, otherwise ignore or supersede artifacts.',
      instructions: [
        'If the run is still active, cancel it through the approved research controls.',
        'If artifacts already exist, leave them as evidence or supersede them with a corrected run.',
        'Do not claim automatic deletion or full rollback of gathered web evidence.',
      ],
      evidenceRefs,
    }),
    validation: makeValidation({
      required: true,
      approvalRequiredBeforeRun: true,
      summary:
        'Validate accepted source count, citations, warnings, and final report availability.',
      commands: [],
      expectedEvidenceRefs: ['research:manifest', 'research:report'],
    }),
    nonGoals: [
      'Do not edit workspace files.',
      'Do not start the research run while only preparing this plan.',
    ],
  });
}

export function buildAoiValidationCommandPreparedActionPlan(
  input: AoiValidationCommandPlanInput,
): AoiPreparedActionPlan {
  const evidenceRefs = dedupeStrings(input.evidenceRefs ?? [], []);
  return finalizePlan({
    version: 1,
    actionKind: 'run_validation_command',
    objective: normalizeText(input.objective, 'Run validation command.'),
    expectedChanges: [
      'Run one validation command after explicit approval.',
      'Capture the command result as validation evidence.',
    ],
    affectedSurfaces: dedupeStrings(input.affectedSurfaces ?? [], ['Workspace validation state']),
    evidenceRefs,
    risk: makeRisk({
      level: input.risk ?? 'medium',
      mutationCapable: false,
      commandCapable: true,
      reasons: ['Validation command execution is command-capable even when intended read-only.'],
    }),
    approval: makeApproval({
      required: true,
      requiredLevel: input.requiredAutonomyLevel ?? 'L4',
      freshAcceptanceRequired: true,
      reason: 'Validation command execution requires explicit approval before the command runs.',
    }),
    checkpoint: notApplicableCheckpoint(
      'Checkpoint is not applicable for validation-only preparation unless the command is changed to mutate files.',
    ),
    rollback: makeRollback({
      kind: 'validation_only_no_mutation',
      available: true,
      guarantee: 'none',
      summary:
        'Validation-only actions should not mutate files; rollback is not promised by this plan.',
      instructions: [
        'If validation unexpectedly mutates files, stop and route recovery through Kira or an approved runner.',
        'Use workspace evidence to decide whether a separate rollback is needed.',
      ],
      evidenceRefs,
    }),
    validation: makeValidation({
      required: true,
      approvalRequiredBeforeRun: true,
      summary: 'Run the validation command only after approval and record its result.',
      commands: [input.command],
      expectedEvidenceRefs: ['workspace:validation', ...evidenceRefs.slice(0, 4)],
    }),
    nonGoals: [
      'Do not run the command during plan preparation.',
      'Do not treat validation-only as permission for file mutation.',
    ],
  });
}

export function buildAoiPreviewOnlyFileWorkPreparedActionPlan(
  input: AoiPreviewOnlyFileWorkPlanInput,
): AoiPreparedActionPlan {
  const evidenceRefs = dedupeStrings(input.evidenceRefs ?? [], []);
  const checkpoint = manualCheckpoint({
    available: input.existingGitStateAvailable === true,
    evidenceRefs: input.checkpointEvidenceRefs,
  });
  return finalizePlan({
    version: 1,
    actionKind: 'preview_only_file_work',
    objective: normalizeText(input.objective, 'Preview file work before mutation.'),
    expectedChanges: dedupeStrings(input.expectedChanges ?? [], [
      'Prepare a preview of file changes only.',
      'Do not apply file changes from this plan.',
    ]),
    affectedSurfaces: dedupeStrings(input.affectedSurfaces ?? [], ['Workspace files']),
    evidenceRefs,
    risk: makeRisk({
      level: input.risk ?? 'high',
      mutationCapable: false,
      reasons: ['File work can become mutation-capable if approved through a later path.'],
    }),
    approval: makeApproval({
      required: true,
      requiredLevel: input.requiredAutonomyLevel ?? 'L4',
      freshAcceptanceRequired: true,
      reason: 'File work preview requires explicit approval before any later mutation path.',
    }),
    checkpoint,
    rollback: makeRollback({
      kind: checkpoint.available ? 'manual_revert_required' : 'not_applicable',
      available: checkpoint.available,
      guarantee: 'none',
      summary:
        'Rollback is not guaranteed; use a real checkpoint or Kira isolated work before applying changes.',
      instructions: checkpoint.available
        ? [
            'Compare against the existing git baseline before approving later mutation.',
            'Revert manually through approved tooling if the later applied change is wrong.',
          ]
        : [
            'No rollback mechanism is available yet.',
            'Route mutation-capable follow-up through Kira or an approved runner with a checkpoint.',
          ],
      evidenceRefs,
    }),
    validation: makeValidation({
      required: true,
      approvalRequiredBeforeRun: true,
      summary: 'Validation commands are planned but not run during preview preparation.',
      commands: dedupeStrings(input.validationCommands ?? [], DEFAULT_VALIDATION_COMMANDS),
      expectedEvidenceRefs: ['workspace:validation', ...evidenceRefs.slice(0, 4)],
    }),
    nonGoals: [
      'Do not apply patches or write files from this plan.',
      'Do not present rollback as certain.',
    ],
  });
}

export function buildAoiUnsupportedActionPreparedActionPlan(
  proposal: AoiProposal,
  reason = 'unsupported_action_kind',
): AoiPreparedActionPlan {
  const kind = proposal.acceptAction?.kind ?? 'none';
  const evidenceRefs = dedupeStrings(
    [...proposal.evidenceRefs, ...proposal.artifactRefs],
    [`proposal:${proposal.id}`],
  );
  return finalizePlan({
    version: 1,
    actionKind: kind,
    objective: normalizeText(proposal.title, 'Review unsupported Aoi action.'),
    expectedChanges: ['No approved mutation path is available for this action.'],
    affectedSurfaces: ['Aoi proposal queue'],
    evidenceRefs,
    risk: makeRisk({
      level: proposal.risk,
      mutationCapable: kind.includes('file') || kind.includes('write') || kind.includes('patch'),
      commandCapable: kind.includes('command') || kind.includes('shell'),
      reasons: ['Unsupported actions are blocked until a specific safe builder exists.'],
    }),
    approval: makeApproval({
      required: true,
      requiredLevel: proposal.requiredAutonomyLevel,
      freshAcceptanceRequired: true,
      reason: 'Unsupported actions require a narrower approved path before execution.',
    }),
    checkpoint: manualCheckpoint({
      available: false,
    }),
    rollback: makeRollback({
      kind: 'not_applicable',
      available: false,
      guarantee: 'none',
      summary: 'No rollback mechanism is available for this unsupported action.',
      instructions: [
        'Do not execute this action.',
        'Route mutation-capable work through Kira or an approved runner with checkpoint evidence.',
      ],
      evidenceRefs,
    }),
    validation: makeValidation({
      required: false,
      approvalRequiredBeforeRun: true,
      summary: 'No validation command is approved for this unsupported action.',
      commands: [],
      expectedEvidenceRefs: [],
    }),
    blockers: [reason],
    nonGoals: [
      'Do not create a general executor.',
      'Do not bypass Kira for mutation-capable work.',
    ],
  });
}

export function buildAoiPreparedActionPlan(
  proposal: AoiProposal,
  options: AoiPreparedActionPlanOptions = {},
): AoiPreparedActionPlan {
  const kind =
    typeof proposal.acceptAction?.kind === 'string'
      ? (proposal.acceptAction.kind as string)
      : undefined;
  const params = actionParams(proposal);
  if (kind === 'create_kira_work') {
    return buildAoiKiraHandoffPreparedActionPlan(proposal, options);
  }
  if (kind === 'start_research') {
    return buildAoiResearchStartPreparedActionPlan(proposal);
  }
  if (kind === 'activate_goal') {
    return buildAoiGoalActivationPreparedActionPlan(proposal);
  }
  if (
    kind === 'get_research_status' ||
    kind === 'open_research_artifact' ||
    kind === 'read_research_artifact'
  ) {
    return finalizePlan({
      version: 1,
      actionKind: kind,
      objective: normalizeText(proposal.title, 'Read existing research context.'),
      expectedChanges: ['Read existing research metadata or artifact only.'],
      affectedSurfaces: ['Aoi research artifacts'],
      evidenceRefs: dedupeStrings(
        [...proposal.evidenceRefs, ...proposal.artifactRefs],
        [`proposal:${proposal.id}`],
      ),
      risk: makeRisk({
        level: 'low',
        mutationCapable: false,
        reasons: ['Read-only research action.'],
      }),
      approval: makeApproval({
        required: proposal.requiresUserApproval,
        requiredLevel: proposal.requiredAutonomyLevel,
        freshAcceptanceRequired: false,
        reason: 'Read-only research actions do not mutate workspace state.',
      }),
      checkpoint: notApplicableCheckpoint('Checkpoint is not applicable for read-only research.'),
      rollback: makeRollback({
        kind: 'not_applicable',
        available: true,
        guarantee: 'none',
        summary: 'Read-only research actions do not require rollback.',
        instructions: ['No state-changing rollback is expected for this read-only action.'],
        evidenceRefs: proposal.evidenceRefs,
      }),
      validation: makeValidation({
        required: false,
        approvalRequiredBeforeRun: false,
        summary: 'No validation command is required for read-only research.',
        commands: [],
        expectedEvidenceRefs: proposal.evidenceRefs,
      }),
      nonGoals: ['Do not mutate files or start new research from this read-only plan.'],
    });
  }
  if (kind === 'save_memory') {
    return buildAoiPreviewOnlyFileWorkPreparedActionPlan({
      objective: `Prepare memory promotion: ${proposal.title}`,
      expectedChanges: [
        'Promote an approved memory candidate or create an untrusted skill draft.',
        'Do not write workspace files from this plan.',
      ],
      affectedSurfaces: ['Aoi memory store', 'Untrusted skill draft queue'],
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      requiredAutonomyLevel: proposal.requiredAutonomyLevel,
      risk: proposal.risk === 'low' ? 'medium' : proposal.risk,
      existingGitStateAvailable: true,
      checkpointEvidenceRefs: proposal.evidenceRefs,
      validationCommands: [],
    });
  }
  if (kind === 'run_command' && getStringParam(params, 'command')) {
    return buildAoiValidationCommandPreparedActionPlan({
      objective: proposal.title,
      command: getStringParam(params, 'command'),
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      affectedSurfaces: getStringListParam(
        params,
        ['affectedSurfaces', 'surfaces'],
        ['Workspace validation state'],
      ),
      requiredAutonomyLevel: 'L5',
      risk: proposal.risk,
    });
  }
  if (kind === 'file_patch' || kind === 'file_write' || kind === 'file_delete') {
    return buildAoiApprovedFileMutationPreparedActionPlan(proposal);
  }
  if (kind === 'preview_changes') {
    return buildAoiPreviewOnlyFileWorkPreparedActionPlan({
      objective: proposal.title,
      evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      affectedSurfaces: getStringListParam(
        params,
        ['affectedSurfaces', 'surfaces', 'files'],
        ['Workspace files'],
      ),
      requiredAutonomyLevel: proposal.requiredAutonomyLevel,
      risk: proposal.risk === 'low' ? 'high' : proposal.risk,
      existingGitStateAvailable: options.existingGitStateAvailable,
      checkpointEvidenceRefs: options.checkpointEvidenceRefs,
    });
  }
  return buildAoiUnsupportedActionPreparedActionPlan(proposal);
}
