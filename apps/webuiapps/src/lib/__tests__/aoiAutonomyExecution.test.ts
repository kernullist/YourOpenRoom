import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { join } from 'path';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maliciousProcedureSourceFixture } from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import {
  executeAoiProposal,
  previewAoiProposal,
  type AoiProposalExecutionDependencies,
} from '../aoiAutonomyExecution';
import { buildAoiFailureRecoveryProposal, classifyAoiFailure } from '../aoiAutonomyRecovery';
import {
  buildAoiKiraHandoffPreparedActionPlan,
  buildAoiResearchStartPreparedActionPlan,
} from '../aoiSafeActionPlan';
import {
  buildAoiBoundedWorkOrderFromProposal,
  createAoiBoundedWorkOrder,
  createAoiBoundedWorkOrderApprovalSnapshot,
  evaluateAoiBoundedWorkOrderPolicy,
} from '../aoiBoundedWorkOrder';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import {
  prepareAoiPlaybook,
  updateAoiPlaybookFromEvidence,
  upsertAoiPlaybook,
  loadAoiActivePlaybooks,
} from '../aoiPlaybookOrchestrator';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';
import {
  applyAoiProposalDecision,
  loadAoiCommandAuditRecords,
  loadAoiActiveProposals,
  loadAoiObservations,
  loadAoiOutcomeSignalRecords,
  loadAoiProposalDecisions,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import { loadAoiWorkspaceSnapshot } from '../aoiWorkspaceSignals';
import {
  AOI_COMMAND_APPROVAL_TTL_MS,
  evaluateAoiApprovedCommandPolicy,
} from '../aoiApprovedCommandPolicy';
import { runAoiApprovedCommand } from '../aoiApprovedCommandRunner';
import { loadServerAoiMemories } from '../aoiMemoryServerWriter';
import type {
  AoiApprovedCommandRequest,
  AoiApprovedCommandResult,
  AoiProposal,
} from '../aoiAutonomyTypes';
import type { AoiResearchManifest } from '../aoiResearchTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-execution-test-'));
  tempRoots.push(root);
  return root;
}

function makeManifest(partial: Partial<AoiResearchManifest> = {}): AoiResearchManifest {
  return {
    version: 1,
    id: 'aoi-research-test-001',
    sessionPath: 'aoi/default',
    request: 'Investigate ETW telemetry',
    mode: 'standard',
    language: 'match-user',
    recency: 'any',
    maxSources: 12,
    createdAt: 1000,
    updatedAt: 1200,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'Completed.',
    sourceCounts: {
      planned: 12,
      candidates: 5,
      accepted: 4,
      failed: 0,
    },
    artifactPaths: {
      manifest: 'aoi-research/runs/aoi-research-test-001/manifest.json',
      report: 'aoi-research/runs/aoi-research-test-001/report.md',
      sources: 'aoi-research/runs/aoi-research-test-001/sources.json',
      evidence: 'aoi-research/runs/aoi-research-test-001/evidence.json',
    },
    artifactAvailability: {
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    },
    reportTitle: 'Investigate ETW telemetry',
    completedAt: 1200,
    ...partial,
  };
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-test-001',
    sessionPath: 'aoi/default',
    status: 'accepted',
    title: 'Open previous research',
    body: 'A previous Aoi research run may answer this.',
    reason: 'The current topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:kernel-memory',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['research:aoi-research-test-001/report'],
    memoryIds: [],
    artifactRefs: ['research:aoi-research-test-001/report'],
    riskSignals: [],
    acceptAction: {
      kind: 'read_research_artifact',
      params: {
        sessionPath: 'aoi/default',
        runId: 'aoi-research-test-001',
        artifact: 'report',
      },
    },
    ...partial,
  };
}

function makeKiraProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeProposal({
    status: 'accepted',
    title: 'Create reviewed Kira handoff',
    body: 'Aoi should create a narrow Kira work item for the accepted task.',
    reason: 'The user accepted a supervised implementation proposal.',
    trigger: 'goal_continuation',
    cooldownKey: 'kira-handoff:aoi-autonomy',
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['create_kira_work'],
    evidenceRefs: ['goal:aoi-goal-001', 'observation:latest-user-message'],
    artifactRefs: ['plan-step:aoi-plan-001-step-003'],
    acceptAction: {
      kind: 'create_kira_work',
      params: {
        projectName: 'YourOpenRoom',
        title: 'Implement supervised Aoi Kira handoff',
        objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
        scope: ['Aoi autonomy execution', 'Aoi autonomy UI'],
        modules: ['aoiAutonomyExecution', 'ChatPanel'],
        validationProfile: 'aoi-autonomy',
      },
    },
    ...partial,
  });
}

function makeCommandProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeProposal({
    status: 'active',
    title: 'Run targeted Aoi validation',
    body: 'Aoi can run one approved targeted validation command.',
    reason: 'The active goal needs fresh validation evidence.',
    trigger: 'workspace_validation_stale',
    cooldownKey: 'approved-command:aoi-validation',
    risk: 'high',
    requiredAutonomyLevel: 'L5',
    requiresUserApproval: true,
    suggestedTools: ['run_command'],
    evidenceRefs: ['workspace:validation:stale', 'goal:aoi-goal-command-001'],
    artifactRefs: ['workspace:snapshot:command-test'],
    riskSignals: ['workspace-validation:stale'],
    acceptAction: {
      kind: 'run_command',
      params: {
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
        cwd: '.',
        purpose: 'Validate Aoi autonomy execution changes.',
        timeoutMs: 15_000,
      },
    },
    ...partial,
  });
}

function makeApprovedCommandResult(
  request: AoiApprovedCommandRequest,
  partial: Partial<AoiApprovedCommandResult> = {},
): AoiApprovedCommandResult {
  const completedAt = request.requestedAt + 120;
  const auditRecord = {
    version: 1 as const,
    id: 'aoi-command-audit-test-001',
    sessionPath: request.sessionPath,
    ...(request.proposalId ? { proposalId: request.proposalId } : {}),
    ...(request.decisionId ? { decisionId: request.decisionId } : {}),
    command: request.command,
    cwdLabel: 'workspace root',
    cwdHash: 'cwdhash',
    purpose: request.purpose,
    risk: request.risk,
    allowed: true,
    blockReasons: [],
    startedAt: request.requestedAt,
    completedAt,
    durationMs: 120,
    exitCode: 0,
    timedOut: false,
    stdoutExcerpt: '3 tests passed',
    stderrExcerpt: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    evidenceRefs: ['aoi-command-audit:aoi-command-audit-test-001'],
    approvalFingerprint: 'approval-fingerprint-test',
  };
  return {
    version: 1,
    ok: true,
    command: request.command,
    cwdLabel: 'workspace root',
    exitCode: 0,
    timedOut: false,
    durationMs: 120,
    stdoutExcerpt: '3 tests passed',
    stderrExcerpt: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    auditRecord,
    evidenceRefs: auditRecord.evidenceRefs,
    ...partial,
  };
}

function loadKiraWorkFiles(
  root: string,
  sessionPath = 'aoi/default',
): Array<Record<string, unknown>> {
  const worksDir = join(root, sessionPath, 'apps', 'kira', 'data', 'works');
  if (!fs.existsSync(worksDir)) {
    return [];
  }
  return fs
    .readdirSync(worksDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => JSON.parse(fs.readFileSync(join(worksDir, fileName), 'utf-8')));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi failure recovery classification', () => {
  it('classifies policy, research, Kira, and execution failures deterministically', () => {
    expect(
      classifyAoiFailure({
        source: 'policy',
        sessionPath: 'aoi/default',
        sourceRef: 'proposal:policy-001',
        reasons: ['tool_blocked:run_command'],
        suggestedTools: ['run_command'],
      }).kind,
    ).toBe('policy_blocked');

    expect(
      classifyAoiFailure({
        source: 'research',
        sessionPath: 'aoi/default',
        sourceRef: 'research:failed-001',
        reasons: ['accepted_sources:0'],
        researchRun: makeManifest({
          id: 'failed-001',
          status: 'failed',
          sourceCounts: {
            planned: 12,
            candidates: 5,
            accepted: 0,
            failed: 5,
          },
        }),
      }).kind,
    ).toBe('research_insufficient_sources');

    expect(
      classifyAoiFailure({
        source: 'kira',
        sessionPath: 'aoi/default',
        sourceRef: 'memory:kira-001',
        riskSignals: ['validation-failed'],
        summary: 'Kira validation failed for the scoped work.',
      }).kind,
    ).toBe('kira_validation_failed');

    expect(
      classifyAoiFailure({
        source: 'execution',
        sessionPath: 'aoi/default',
        sourceRef: 'proposal:exec-001',
        reasons: ['unexpected runtime exception'],
      }).kind,
    ).toBe('execution_exception');
  });

  it('does not create direct mutation recovery actions', () => {
    const failure = classifyAoiFailure({
      source: 'policy',
      sessionPath: 'aoi/default',
      sourceRef: 'proposal:mutation-001',
      reasons: ['tool_blocked:file_patch'],
      suggestedTools: ['file_patch'],
      acceptActionKind: 'file_patch',
    });

    const result = buildAoiFailureRecoveryProposal({
      failure,
      context: {
        activeProposals: [],
        recentDecisions: [],
        now: 3000,
      },
    });

    expect(result.proposal).toBeNull();
    expect(result.suppression?.reason).toBe('mutation_action_not_retriable');
    expect(result.suppression?.preview.nonGoals).toEqual(
      expect.arrayContaining(['Do not execute file writes, patches, deletes, or shell commands.']),
    );
  });
});

describe('runAoiApprovedCommand()', () => {
  it('redacts sensitive output and preserves truncation flags in audit records', async () => {
    const root = makeTempRoot();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn(() => true);
    const spawnImpl = vi.fn(() => child) as unknown as NonNullable<
      Parameters<typeof runAoiApprovedCommand>[1]['spawnImpl']
    >;

    const request: AoiApprovedCommandRequest = {
      version: 1,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-command-output-001',
      decisionId: 'decision-command-output-001',
      command: 'git diff --check',
      cwd: '.',
      purpose: 'Validate current diff whitespace.',
      risk: 'high',
      timeoutMs: 15_000,
      requestedAt: 3000,
      evidenceRefs: ['goal:aoi-command-output'],
    };
    const resultPromise = runAoiApprovedCommand(request, {
      workspaceRoot: root,
      now: 3000,
      spawnImpl,
      approvedPolicy: evaluateAoiApprovedCommandPolicy(request),
    });

    stdout.emit('data', `api_key=super-secret-value\n${'a'.repeat(6100)}`);
    stderr.emit('data', 'password=another-secret-value\n');
    child.emit('close', 0);

    const result = await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      'git',
      ['diff', '--check'],
      expect.objectContaining({
        cwd: root,
        shell: false,
        windowsHide: true,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(result.stdoutExcerpt.length).toBeLessThanOrEqual(6000);
    expect(result.stdoutExcerpt).toContain('api_key=[redacted_secret]');
    expect(result.stdoutExcerpt).not.toContain('super-secret-value');
    expect(result.stderrExcerpt).toContain('password=[redacted_secret]');
    expect(result.stderrExcerpt).not.toContain('another-secret-value');
    expect(result.auditRecord.stdoutTruncated).toBe(true);
  });

  it('blocks runner execution without an approved sandbox policy snapshot', async () => {
    const root = makeTempRoot();
    const spawnImpl = vi.fn() as unknown as NonNullable<
      Parameters<typeof runAoiApprovedCommand>[1]['spawnImpl']
    >;
    const request: AoiApprovedCommandRequest = {
      version: 1,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-command-output-002',
      decisionId: 'decision-command-output-002',
      command: 'git diff --check',
      cwd: '.',
      purpose: 'Validate current diff whitespace.',
      risk: 'high',
      timeoutMs: 15_000,
      requestedAt: 3000,
      evidenceRefs: ['goal:aoi-command-output'],
    };

    const result = await runAoiApprovedCommand(request, {
      workspaceRoot: root,
      now: 3000,
      spawnImpl,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.auditRecord.blockReasons).toContain('approval_sandbox_missing');
    expect(result.auditRecord.approvalSandboxValidationStatus).toBe('blocked');
  });
});

describe('Aoi bounded autonomous work orders', () => {
  it('keeps a narrow read-only work order previewable', () => {
    const order = buildAoiBoundedWorkOrderFromProposal(makeProposal({ status: 'accepted' }), {
      now: 3000,
      generated: false,
    });

    expect(order.policyResult).toMatchObject({
      status: 'preview_only',
      executionAllowed: false,
      canAutoRun: false,
    });
    expect(order.status).toBe('draft');
    expect(order.risk).toMatchObject({
      mutationCapable: false,
      commandCapable: false,
    });
    expect(order.actionAuthority).toBe('display_only');
    expect(order.mutationCount).toBe(0);
    expect(order.expectedDiffShape.summary).toContain('No repository diff');
    expect(order.sourceRefs).toContain(order.origin.ref);
  });

  it('requires approval for mutation-capable work with explicit file scope', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Format one Aoi autonomy helper file.',
      affectedSurfaces: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      files: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [
        {
          command:
            'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
          cwd: '.',
          purpose: 'Validate bounded work-order policy tests.',
        },
      ],
      risk: {
        level: 'low',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is the checkpoint baseline.',
        instructions: [],
        evidenceRefs: ['git:status'],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Use the git diff baseline for manual revert.',
        instructions: ['Revert the exact file diff if review rejects it.'],
        evidenceRefs: ['git:status'],
      },
      now: 3000,
    });

    expect(order.policyResult.status).toBe('approval_required');
    expect(order.status).toBe('waiting_approval');
    expect(order.policyResult.reasons).toContain('approval_missing');
    expect(order.approval.required).toBe(true);
    expect(order.reviewRequirement.operatorReviewRequired).toBe(true);
    expect(order.reviewRequirement.commandApprovalRequired).toBe(true);
    expect(order.stopConditions.join(' ')).toContain('approval');
    expect(order.policyResult.executionAllowed).toBe(false);
  });

  it('blocks mutation-capable work when file and module scope is missing', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Patch Aoi autonomy implementation.',
      affectedSurfaces: ['Workspace files'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [
        {
          command:
            'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
        },
      ],
      risk: {
        level: 'medium',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is available.',
        instructions: [],
        evidenceRefs: [],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Manual revert is available.',
        instructions: ['Use git diff review before reverting.'],
        evidenceRefs: [],
      },
      now: 3000,
    });

    expect(order.policyResult.status).toBe('blocked');
    expect(order.policyResult.blockedReasons).toContain('missing_file_or_module_scope');
  });

  it('blocks unsafe absolute file scope before approval can be reused', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Patch one local helper file.',
      affectedSurfaces: ['F:\\secret\\outside-workspace.ts'],
      files: ['F:\\secret\\outside-workspace.ts'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [{ command: 'git diff --check' }],
      risk: {
        level: 'medium',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is available.',
        instructions: [],
        evidenceRefs: [],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Manual revert is available.',
        instructions: ['Use git diff review before reverting.'],
        evidenceRefs: [],
      },
      now: 3000,
    });

    expect(order.policyResult.status).toBe('blocked');
    expect(order.policyResult.blockedReasons).toContain('unsafe_file_or_module_scope');
  });

  it('rejects ambiguous work orders before approval review', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Fix stuff',
      affectedSurfaces: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      files: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [{ command: 'git diff --check' }],
      risk: {
        level: 'medium',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is available.',
        instructions: [],
        evidenceRefs: [],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Manual revert is available.',
        instructions: ['Use git diff review before reverting.'],
        evidenceRefs: [],
      },
      now: 3000,
    });

    expect(order.policyResult.status).toBe('blocked');
    expect(order.policyResult.blockedReasons).toContain('objective_ambiguous');
  });

  it('requires validation command preview even when a mutation draft disables validation', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Patch one scoped Aoi helper.',
      affectedSurfaces: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      files: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      allowedOperations: ['edit_file'],
      risk: {
        level: 'low',
        mutationCapable: true,
      },
      validation: {
        required: false,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is available.',
        instructions: [],
        evidenceRefs: [],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Manual revert is available.',
        instructions: ['Use git diff review before reverting.'],
        evidenceRefs: [],
      },
      now: 3000,
    });

    expect(order.validation.required).toBe(true);
    expect(order.policyResult.status).toBe('blocked');
    expect(order.policyResult.blockedReasons).toContain('missing_validation_command_preview');
  });

  it('blocks mutation-capable work when checkpoint evidence is missing', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Patch one scoped Aoi helper with checkpoint review.',
      affectedSurfaces: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      files: ['apps/webuiapps/src/lib/aoiBoundedWorkOrder.ts'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [
        {
          command:
            'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
        },
      ],
      risk: {
        level: 'low',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: false,
        summary: 'Checkpoint has not been captured yet.',
        instructions: ['Capture git status before approval.'],
        evidenceRefs: [],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: true,
        guarantee: 'none',
        summary: 'Manual rollback is available.',
        instructions: ['Use the reviewed diff for rollback.'],
        evidenceRefs: [],
      },
      now: 3000,
    });

    expect(order.status).toBe('blocked');
    expect(order.policyResult.blockedReasons).toContain(
      'missing_checkpoint_for_mutation_capable_work',
    );
    expect(order.stopConditions.join(' ')).toContain('checkpoint');
    expect(order.policyResult.executionAllowed).toBe(false);
  });

  it('invalidates prior approval when the validation command changes', () => {
    const base = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Run one exact validation command.',
      affectedSurfaces: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
      files: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
      allowedOperations: ['run_validation_command'],
      commands: [{ command: 'git diff --check', cwd: '.' }],
      risk: {
        level: 'low',
        commandCapable: true,
      },
      now: 3000,
    });
    const approved = createAoiBoundedWorkOrderApprovalSnapshot(base, {
      approvedAt: 3100,
      expiresAt: 10_000,
      evidenceRefs: ['approval:base-command'],
    });
    const unchanged = createAoiBoundedWorkOrder(
      {
        sessionPath: 'aoi/default',
        objective: 'Run one exact validation command.',
        affectedSurfaces: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
        files: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
        allowedOperations: ['run_validation_command'],
        commands: [{ command: 'git diff --check', cwd: '.' }],
        risk: {
          level: 'low',
          commandCapable: true,
        },
        now: 3200,
      },
      {
        approvedSnapshot: approved,
        now: 3200,
      },
    );
    const changed = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Run one exact validation command.',
      affectedSurfaces: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
      files: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
      allowedOperations: ['run_validation_command'],
      commands: [{ command: 'git status --short', cwd: '.' }],
      risk: {
        level: 'low',
        commandCapable: true,
      },
      now: 3200,
    });
    const result = evaluateAoiBoundedWorkOrderPolicy(changed, {
      approvedSnapshot: approved,
      now: 3200,
    });

    expect(unchanged.policyResult.status).toBe('preview_only');
    expect(unchanged.status).toBe('approved');
    expect(unchanged.approval.satisfied).toBe(true);
    expect(result.status).toBe('approval_required');
    expect(result.approvalInvalidationReasons).toContain('approval_command_changed');
    expect(result.approvalInvalidationReasons).toContain('approval_work_order_changed');
  });

  it('raises risk when rollback is unavailable for mutation-capable work', () => {
    const order = createAoiBoundedWorkOrder({
      sessionPath: 'aoi/default',
      objective: 'Adjust one bounded work-order test fixture.',
      affectedSurfaces: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
      files: ['apps/webuiapps/src/lib/__tests__/aoiAutonomyExecution.test.ts'],
      allowedOperations: ['edit_file', 'run_validation_command'],
      commands: [
        {
          command:
            'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
        },
      ],
      risk: {
        level: 'low',
        mutationCapable: true,
      },
      checkpoint: {
        kind: 'existing_git_state',
        required: true,
        available: true,
        summary: 'Existing git state is available.',
        instructions: [],
        evidenceRefs: [],
      },
      rollback: {
        kind: 'manual_revert_required',
        available: false,
        guarantee: 'none',
        summary: 'No rollback path is available yet.',
        instructions: ['Require rollback before approval.'],
        evidenceRefs: [],
      },
      now: 3000,
    });

    expect(order.risk.level).toBe('high');
    expect(order.risk.escalated).toBe(true);
    expect(order.risk.reasons.join(' ')).toContain('Rollback is unavailable');
    expect(order.status).toBe('blocked');
    expect(order.policyResult.blockedReasons).toContain(
      'missing_rollback_for_mutation_capable_work',
    );
    expect(order.stopConditions.join(' ')).toContain('rollback');
  });

  it('requires Kira review for generated medium-risk mutation work', () => {
    const order = buildAoiBoundedWorkOrderFromProposal(makeKiraProposal(), {
      now: 3000,
      generated: true,
    });

    expect(order.policyResult.status).toBe('kira_review_required');
    expect(order.status).toBe('waiting_approval');
    expect(order.policyResult.reasons).toContain(
      'generated_medium_or_high_risk_requires_kira_review',
    );
    expect(order.risk.commandCapable).toBe(true);
    expect(order.approval.approver).toBe('kira_reviewer');
    expect(order.reviewRequirement.kiraReviewRequired).toBe(true);
    expect(order.policyResult.executionAllowed).toBe(false);
  });
});

describe('executeAoiProposal()', () => {
  it('prepares Kira handoff plans with review, validation, checkpoint, and rollback boundaries', () => {
    const plan = buildAoiKiraHandoffPreparedActionPlan(makeKiraProposal(), {
      now: 3000,
    });

    expect(plan).toMatchObject({
      status: 'ready',
      actionKind: 'create_kira_work',
      approval: {
        required: true,
        freshAcceptanceRequired: true,
      },
      checkpoint: {
        kind: 'kira_isolated_worktree',
        available: true,
      },
      validation: {
        required: true,
        approvalRequiredBeforeRun: true,
      },
      rollback: {
        kind: 'kira_review_reject_or_revert',
        guarantee: 'best_effort',
      },
    });
    expect(plan.validation.commands.length).toBeGreaterThan(0);
    expect(plan.rollback.instructions.join(' ')).toMatch(/review|reject/i);
    expect(plan.rollback.instructions.join(' ')).not.toMatch(/\bguaranteed\b/i);
  });

  it('treats approved research starts as artifact mutations in the approval sandbox', () => {
    const plan = buildAoiResearchStartPreparedActionPlan(
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            request: 'Investigate ETW telemetry changes.',
            mode: 'standard',
          },
        },
      }),
    );

    expect(plan.approvalSandbox).toMatchObject({
      targetKind: 'research',
      expectedMutationCount: 1,
    });
    expect(plan.blockers).toEqual([]);
  });

  it('executes accepted read-only artifact proposals at L3 with capped output', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L3' });
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
      dependencies: {
        readResearchArtifact: () => ({
          runId: 'aoi-research-test-001',
          run: makeManifest(),
          artifact: 'report',
          contentType: 'text/markdown',
          content: '# Report\n'.repeat(1000),
        }),
      },
    });

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      reasons: [],
    });
    expect(result.result?.contentPreview).toEqual(expect.stringContaining('# Report'));
    expect(String(result.result?.contentPreview).length).toBeLessThanOrEqual(4000);
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('executed');
    expect(loadAoiProposalDecisions(root, 'aoi/default')[0]).toMatchObject({
      action: 'execute',
      nextStatus: 'executed',
    });
  });

  it('blocks start_research without explicit acceptance', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW telemetry',
            mode: 'standard',
          },
        },
      }),
    ]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons.join(',')).toContain('missing_fresh_acceptance');
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('blocked');
  });

  it('executes start_research after fresh acceptance at L4', async () => {
    const root = makeTempRoot();
    const startResearch = vi.fn().mockResolvedValue({
      ok: true,
      run: makeManifest({ status: 'queued', phase: 'queued', completedAt: undefined }),
      background: true,
      maxConcurrentRuns: 2,
    });
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW telemetry',
            mode: 'standard',
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
      dependencies: {
        startResearch,
      },
    });

    expect(result.executed).toBe(true);
    expect(result.result).toMatchObject({
      kind: 'start_research',
      background: true,
    });
    expect(startResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          sessionPath: 'aoi/default',
          request: 'Investigate current ETW telemetry',
          mode: 'standard',
        }),
      }),
    );
  });

  it('blocks procedure promotion without explicit acceptance', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['save_memory'],
        acceptAction: {
          kind: 'save_memory',
          params: {
            type: 'procedure',
            content: 'Always compare source dates before promoting research findings.',
          },
        },
      }),
    ]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result.executed).toBe(false);
    expect(result.outcome).toBe('blocked');
    expect(result.reasons.join(',')).toContain('missing_fresh_acceptance');
    expect(loadServerAoiMemories(root)).toEqual([]);
  });

  it('promotes approved procedure memory with sanitized content and relation edges', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['save_memory'],
        evidenceRefs: ['observation:latest-user-message'],
        acceptAction: {
          kind: 'save_memory',
          params: {
            type: 'procedure',
            content: maliciousProcedureSourceFixture,
            triggerTerms: ['research workflow'],
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    const memories = loadServerAoiMemories(root);
    const observations = loadAoiObservations(root, 'aoi/default');
    const relationIndex = loadAoiRelationIndex(root, 'aoi/default');
    const promotionObservation = observations.find((observation) =>
      observation.dedupeKey.startsWith('proposal:procedure-promotion:'),
    );
    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'save_memory',
        target: 'memory',
      },
    });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      type: 'procedure',
      status: 'active',
    });
    expect(memories[0].content).not.toMatch(/ignore previous instructions/i);
    expect(memories[0].content).toContain('compare source dates');
    expect(promotionObservation).toMatchObject({
      source: 'proposal',
      proposalIds: ['proposal-test-001'],
      memoryIds: [memories[0].id],
    });
    expect(promotionObservation?.summary).not.toMatch(/ignore previous instructions/i);
    expect(promotionObservation?.artifactRefs).toContain('procedure:proposal-test-001');
    expect(
      relationIndex.edges.some(
        (edge) =>
          edge.kind === 'belongs_to' &&
          edge.evidenceRefs.includes(`decision:${result.decision.id}`),
      ),
    ).toBe(true);
    expect(
      relationIndex.nodes.some((node) => node.ref === `observation:${promotionObservation?.id}`),
    ).toBe(true);
  });

  it('returns untrusted skill drafts for approved procedure skill promotion', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['save_memory'],
        evidenceRefs: ['observation:latest-user-message'],
        acceptAction: {
          kind: 'save_memory',
          params: {
            type: 'procedure',
            target: 'skill',
            name: 'Research Date Check',
            content: 'Before answering current research questions, compare source dates.',
          },
        },
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    expect(result.result).toMatchObject({
      kind: 'save_memory',
      target: 'skill',
      skillDraft: {
        name: 'Research Date Check',
        enabled: true,
        trusted: false,
      },
    });
    expect(loadServerAoiMemories(root)).toEqual([]);
  });

  it('previews Kira handoff without creating work or transitioning the proposal', () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeKiraProposal()]);

    const result = previewAoiProposal({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result).toMatchObject({
      previewed: true,
      outcome: 'previewed',
      reasons: [],
    });
    expect(result.result?.preview).toMatchObject({
      kind: 'create_kira_work',
      objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
      requiresReview: true,
      noSideEffects: true,
    });
    expect(loadKiraWorkFiles(root)).toEqual([]);
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('accepted');
    expect(
      loadServerAoiRunLedger(root, 'aoi/default').some((entry) =>
        entry.events.some((event) => event.type === 'kira_handoff_preview_created'),
      ),
    ).toBe(true);
  });

  it('previews research start plans without creating a research run', () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({
        status: 'accepted',
        requiredAutonomyLevel: 'L4',
        risk: 'medium',
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW telemetry changes',
            mode: 'standard',
          },
        },
      }),
    ]);

    const result = previewAoiProposal({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });

    expect(result).toMatchObject({
      previewed: true,
      outcome: 'previewed',
      preparedActionPlan: {
        actionKind: 'start_research',
        status: 'ready',
      },
    });
    expect(result.result?.preparedActionPlan).toMatchObject({
      validation: {
        approvalRequiredBeforeRun: true,
      },
    });
    expect(fs.existsSync(join(root, 'aoi/default', 'aoi-research', 'runs'))).toBe(false);
    expect(loadAoiActiveProposals(root, 'aoi/default')[0].status).toBe('accepted');
  });

  it('previews a multistep playbook without bypassing per-step approvals', () => {
    const proposal = makeKiraProposal({
      status: 'active',
      id: 'proposal-playbook-kira-001',
    });
    const playbook = prepareAoiPlaybook({
      sessionPath: 'aoi/default',
      proposal,
      now: 4000,
      playbookId: 'aoi-playbook-preview-test',
    });

    expect(playbook.steps.map((step) => step.kind)).toEqual([
      'inspect_context',
      'create_kira_work',
      'wait_for_external_event',
      'preview_command',
      'run_approved_command',
      'summarize_result',
      'ask_user',
    ]);
    const kiraStep = playbook.steps.find((step) => step.kind === 'create_kira_work');
    const commandStep = playbook.steps.find((step) => step.kind === 'run_approved_command');
    expect(kiraStep).toMatchObject({
      status: 'pending',
      executionBoundary: {
        requiresApproval: true,
        freshAcceptanceRequired: true,
        existingGate: 'kira_handoff',
        canAutoRun: false,
      },
    });
    expect(commandStep).toMatchObject({
      status: 'pending',
      executionBoundary: {
        requiresApproval: true,
        requiredAutonomyLevel: 'L5',
        existingGate: 'approved_command',
        canAutoRun: false,
      },
    });

    const afterContext = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'inspect_context_completed',
      evidenceRefs: ['timeline:context-reviewed'],
      now: 5000,
    });

    expect(afterContext.steps.find((step) => step.kind === 'create_kira_work')?.status).toBe(
      'waiting_for_approval',
    );
    expect(afterContext.steps.find((step) => step.kind === 'run_approved_command')?.status).toBe(
      'pending',
    );
  });

  it('updates waiting playbook steps from Kira and command evidence only', () => {
    const proposal = makeKiraProposal({
      status: 'accepted',
      id: 'proposal-playbook-update-001',
    });
    let playbook = prepareAoiPlaybook({
      sessionPath: 'aoi/default',
      proposal,
      now: 4000,
      playbookId: 'aoi-playbook-update-test',
    });

    playbook = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'inspect_context_completed',
      evidenceRefs: ['timeline:context-reviewed'],
      now: 4100,
    });
    playbook = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'kira_work_created',
      evidenceRefs: ['kira-work:kira-playbook-001'],
      refs: { kiraWorkRef: 'kira-work:kira-playbook-001' },
      now: 4200,
    });
    expect(playbook.steps.find((step) => step.kind === 'wait_for_external_event')?.status).toBe(
      'waiting_for_external_event',
    );

    playbook = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'kira_work_completed',
      evidenceRefs: ['kira-review:kira-review-playbook-001'],
      refs: { kiraWorkRef: 'kira-work:kira-playbook-001' },
      now: 4300,
    });
    expect(playbook.steps.find((step) => step.kind === 'preview_command')?.status).toBe('ready');

    playbook = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'approved_command_recorded',
      evidenceRefs: ['aoi-command-audit:aoi-command-playbook-001'],
      refs: { commandAuditRef: 'aoi-command-audit:aoi-command-playbook-001' },
      now: 4400,
    });
    expect(playbook.steps.find((step) => step.kind === 'run_approved_command')?.status).toBe(
      'completed',
    );
    expect(playbook.evidenceRefs).toContain('aoi-command-audit:aoi-command-playbook-001');
  });

  it('updates a research waiting playbook step from completed research evidence', () => {
    const proposal = makeProposal({
      status: 'accepted',
      id: 'proposal-playbook-research-001',
      requiredAutonomyLevel: 'L4',
      risk: 'medium',
      suggestedTools: ['start_research'],
      acceptAction: {
        kind: 'start_research',
        params: {
          sessionPath: 'aoi/default',
          request: 'Investigate current ETW telemetry changes',
          mode: 'standard',
        },
      },
    });
    let playbook = prepareAoiPlaybook({
      sessionPath: 'aoi/default',
      proposal,
      now: 4000,
      playbookId: 'aoi-playbook-research-test',
    });

    playbook = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'inspect_context_completed',
      evidenceRefs: ['timeline:context-reviewed'],
      now: 4100,
    });
    playbook = updateAoiPlaybookFromEvidence({
      playbook,
      kind: 'research_completed',
      evidenceRefs: ['research:aoi-research-playbook-001/report'],
      refs: {
        researchRunRef: 'research:aoi-research-playbook-001',
        researchArtifactRef: 'research:aoi-research-playbook-001/report',
      },
      now: 4200,
    });

    expect(playbook.steps.find((step) => step.kind === 'wait_for_external_event')?.status).toBe(
      'completed',
    );
    expect(playbook.steps.find((step) => step.kind === 'start_research')?.status).toBe('completed');
    expect(playbook.steps.find((step) => step.kind === 'read_research_artifact')?.status).toBe(
      'ready',
    );
    expect(playbook.evidenceRefs).toContain('research:aoi-research-playbook-001/report');
  });

  it('persists a failed-prerequisite playbook without deleting it', () => {
    const root = makeTempRoot();
    const proposal = makeCommandProposal({
      id: 'proposal-playbook-command-001',
      status: 'accepted',
    });
    const playbook = prepareAoiPlaybook({
      sessionPath: 'aoi/default',
      proposal,
      health: {
        version: 1,
        sessionPath: 'aoi/default',
        generatedAt: 4000,
        overallStatus: 'blocked',
        summary: 'Approved command runner is unavailable.',
        userBlockingIssueCount: 1,
        capabilities: [],
        issues: [
          {
            version: 1,
            id: 'health-command-blocker',
            capability: 'approved_commands',
            severity: 'blocker',
            code: 'approved_command_runner_unavailable',
            title: 'Approved command runner unavailable',
            summary: 'Aoi cannot run approved commands.',
            cannotKnow: 'Aoi cannot know validation output until the runner is available.',
            observedAt: 4000,
            evidenceRefs: ['health:approved-command-runner'],
            recommendation: {
              version: 1,
              action: 'review_approved_command_policy',
              label: 'Repair approved command runner.',
            },
          },
        ],
        evidenceRefs: ['health:approved-command-runner'],
      },
      now: 4000,
      playbookId: 'aoi-playbook-blocked-test',
    });

    expect(playbook.status).toBe('blocked');
    expect(playbook.blockedReasons).toContain(
      'approved_commands:approved_command_runner_unavailable',
    );
    upsertAoiPlaybook(root, 'aoi/default', playbook);
    expect(loadAoiActivePlaybooks(root, 'aoi/default')).toHaveLength(1);
    expect(loadAoiActivePlaybooks(root, 'aoi/default')[0].status).toBe('blocked');
  });

  it('executes one exactly approved command and records audit, relations, and validation freshness', async () => {
    const root = makeTempRoot();
    const runApprovedCommand = vi.fn(
      async (
        params: Parameters<NonNullable<AoiProposalExecutionDependencies['runApprovedCommand']>>[0],
      ) => makeApprovedCommandResult(params.request),
    );
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeCommandProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
      dependencies: {
        runApprovedCommand,
      },
    });

    const audits = loadAoiCommandAuditRecords(root, 'aoi/default');
    const snapshot = loadAoiWorkspaceSnapshot(root, 'aoi/default', 4000);
    const observations = loadAoiObservations(root, 'aoi/default');
    const relations = loadAoiRelationIndex(root, 'aoi/default');

    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'run_command',
        commandResult: {
          ok: true,
          exitCode: 0,
        },
      },
    });
    expect(runApprovedCommand).toHaveBeenCalledTimes(1);
    expect(runApprovedCommand.mock.calls[0][0]).toMatchObject({
      workspaceRoot: root,
      request: {
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
        cwd: '.',
        purpose: 'Validate Aoi autonomy execution changes.',
      },
    });
    expect(runApprovedCommand.mock.calls[0]?.[0].approvedPolicy?.approvalSandbox).toMatchObject({
      targetKind: 'command',
      expectedMutationCount: 0,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].evidenceRefs.some((ref) => ref.startsWith('decision:'))).toBe(true);
    expect(snapshot?.validation).toMatchObject({
      command:
        'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyExecution.test.ts',
      result: 'passed',
      freshness: 'fresh',
    });
    expect(snapshot?.validation.evidenceRefs).toContain(
      'aoi-command-audit:aoi-command-audit-test-001',
    );
    expect(
      observations.some((observation) =>
        observation.riskSignals.includes('workspace-validation:passed'),
      ),
    ).toBe(true);
    expect(
      relations.nodes.some((node) => node.ref === 'aoi-command-audit:aoi-command-audit-test-001'),
    ).toBe(true);
    // P5.2: the real executed command left an outcome signal in the unified ledger,
    // attributed to its proposal (and the execution decision), so the closed-loop
    // promotion metric sees the actual executed result -- not just the counterfactual
    // shadow.
    const executedOutcome = loadAoiOutcomeSignalRecords(root, 'aoi/default').find(
      (signal) => signal.sourceProposalId === 'proposal-test-001',
    );
    expect(executedOutcome?.outcomeKind).toBe('validation_run');
    expect(executedOutcome?.result).toBe('positive');
    expect(executedOutcome?.sourceDecisionId).toBeTruthy();
    expect(executedOutcome?.sourceValidationRef).toBe(
      'aoi-command-audit:aoi-command-audit-test-001',
    );
  });

  it('blocks expired approved command acceptance before runner execution', async () => {
    const root = makeTempRoot();
    const runApprovedCommand = vi.fn();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeCommandProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 1000,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 1000 + AOI_COMMAND_APPROVAL_TTL_MS + 1,
      dependencies: {
        runApprovedCommand,
      },
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('approved_command_approval_expired');
    expect(runApprovedCommand).not.toHaveBeenCalled();
    expect(loadAoiCommandAuditRecords(root, 'aoi/default')).toEqual([]);
  });

  it('invalidates approved command acceptance when the command changes', async () => {
    const root = makeTempRoot();
    const runApprovedCommand = vi.fn();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L5' });
    saveAoiActiveProposals(root, 'aoi/default', [makeCommandProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });
    const stored = loadAoiActiveProposals(root, 'aoi/default');
    saveAoiActiveProposals(root, 'aoi/default', [
      {
        ...stored[0],
        acceptAction: {
          kind: 'run_command',
          params: {
            ...stored[0].acceptAction?.params,
            command: 'git diff --check',
          },
        },
      },
    ]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      workspaceRoot: root,
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
      dependencies: {
        runApprovedCommand,
      },
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('approved_command_approval_command_changed');
    expect(runApprovedCommand).not.toHaveBeenCalled();
  });

  it('blocks Kira handoff without acceptance, evidence, safe params, or narrow scope', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });

    saveAoiActiveProposals(root, 'aoi/default', [makeKiraProposal({ status: 'active' })]);
    const withoutAcceptance = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
    });
    expect(withoutAcceptance.executed).toBe(false);
    expect(withoutAcceptance.reasons.join(',')).toContain(
      'kira_handoff_requires_accepted_proposal',
    );

    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'accepted',
        evidenceRefs: [],
      }),
    ]);
    const missingEvidence = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 4000,
    });
    expect(missingEvidence.reasons.join(',')).toContain('missing_evidence_refs');

    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'F:\\secret\\repo',
            objective: 'Implement one reviewed Aoi-to-Kira handoff task.',
            scope: ['Aoi autonomy execution'],
          },
        },
      }),
    ]);
    const pathParam = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 5000,
    });
    expect(pathParam.reasons.join(',')).toContain('action_params_include_filesystem_path');

    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'YourOpenRoom',
            objective: 'Rewrite the entire repository.',
            scope: ['entire repo'],
          },
        },
      }),
    ]);
    const broadScope = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 6000,
    });
    expect(broadScope.reasons.join(',')).toContain('kira_handoff_scope_too_broad');
    expect(broadScope.result?.safeAlternative).toEqual(expect.stringContaining('Narrow'));
    expect(loadKiraWorkFiles(root)).toEqual([]);
    expect(
      loadServerAoiRunLedger(root, 'aoi/default').some((entry) =>
        entry.events.some((event) => event.type === 'kira_handoff_policy_blocked'),
      ),
    ).toBe(true);
  });

  it('creates reviewed Kira work after fresh approval and records relations plus ledger events', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [makeKiraProposal({ status: 'active' })]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
    });

    const workFiles = loadKiraWorkFiles(root);
    const relationIndex = loadAoiRelationIndex(root, 'aoi/default');
    const ledger = loadServerAoiRunLedger(root, 'aoi/default');
    expect(result).toMatchObject({
      executed: true,
      outcome: 'executed',
      result: {
        kind: 'create_kira_work',
        reviewRequired: true,
      },
    });
    expect(workFiles).toHaveLength(1);
    expect(workFiles[0]).toMatchObject({
      type: 'work',
      projectName: 'YourOpenRoom',
      status: 'todo',
    });
    expect(String(workFiles[0].description)).toContain('Requires Kira reviewer approval');
    expect(relationIndex.nodes.some((node) => node.kind === 'kira_work')).toBe(true);
    expect(
      relationIndex.edges.some(
        (edge) => edge.kind === 'supports' && edge.evidenceRefs.includes('goal:aoi-goal-001'),
      ),
    ).toBe(true);
    expect(
      ledger.some((entry) =>
        entry.events.some((event) => event.type === 'kira_handoff_execution_approved'),
      ),
    ).toBe(true);
    expect(
      ledger.some((entry) => entry.events.some((event) => event.type === 'kira_work_item_created')),
    ).toBe(true);
  });

  it('does not route Kira handoff through direct file or command tools', async () => {
    const root = makeTempRoot();
    const createKiraWork = vi.fn();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L4' });
    saveAoiActiveProposals(root, 'aoi/default', [
      makeKiraProposal({
        status: 'active',
        suggestedTools: ['create_kira_work', 'file_write', 'run_command'],
      }),
    ]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2500,
    });

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      decisionId: accepted.decision.id,
      now: 3000,
      dependencies: {
        createKiraWork,
      },
    });

    expect(result.executed).toBe(false);
    expect(result.reasons.join(',')).toContain('tool_blocked:file_write');
    expect(result.reasons.join(',')).toContain('tool_blocked:run_command');
    expect(createKiraWork).not.toHaveBeenCalled();
    expect(loadKiraWorkFiles(root)).toEqual([]);
  });

  it('blocks execution failures without losing the proposal', async () => {
    const root = makeTempRoot();
    saveAoiAutonomyPolicy(root, 'aoi/default', { enabled: true, previewMode: true, level: 'L3' });
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = await executeAoiProposal({
      sessionsDir: root,
      configFile: join(root, 'config.json'),
      serverOrigin: 'http://127.0.0.1:3000',
      sessionPath: 'aoi/default',
      proposalId: 'proposal-test-001',
      now: 3000,
      dependencies: {
        readResearchArtifact: () => {
          throw new Error('artifact missing');
        },
      },
    });

    const stored = loadAoiActiveProposals(root, 'aoi/default');
    const decisions = loadAoiProposalDecisions(root, 'aoi/default');
    expect(result).toMatchObject({
      executed: false,
      outcome: 'failed',
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'proposal-test-001',
      status: 'blocked',
    });
    expect(decisions[0]).toMatchObject({
      action: 'block',
      nextStatus: 'blocked',
    });
  });
});
