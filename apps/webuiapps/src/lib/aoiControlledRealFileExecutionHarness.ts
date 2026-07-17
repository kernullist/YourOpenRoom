import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { basename, dirname, isAbsolute, join, relative } from 'path';

import {
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
} from './aoiApprovedFileMutationPolicy';
import { applyAoiApprovedFileMutation } from './aoiApprovedFileMutationRunner';
import type { AoiFileMutationBlockReason } from './aoiAutonomyTypes';

export type AoiControlledRealFileScenarioId =
  | 'validated_success'
  | 'target_fingerprint_drift'
  | 'validation_failure_rollback'
  | 'rollback_failure_detection';

export interface AoiControlledRealFileScenarioResult {
  version: 1;
  id: AoiControlledRealFileScenarioId;
  passed: boolean;
  applied: boolean;
  validationStatus: 'not_run' | 'passed' | 'failed';
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  checkpointVerified: boolean;
  finalStateVerified: boolean;
  blockReasons: AoiFileMutationBlockReason[];
  evidenceRefs: string[];
}

export interface AoiControlledRealFileExecutionReport {
  version: 1;
  id: string;
  evidenceClass: 'controlled_real';
  generatedAt: number;
  passed: boolean;
  scenarioCount: number;
  passedScenarioCount: number;
  behaviorFingerprint: string;
  cleanupVerified: boolean;
  scenarios: AoiControlledRealFileScenarioResult[];
  evidenceRefs: string[];
  actionAuthority: 'disposable_workspace_only';
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprintAoiControlledRealFileBehavior(
  scenarios: readonly AoiControlledRealFileScenarioResult[],
): string {
  return sha256(
    JSON.stringify(
      scenarios.map((scenario) => ({
        id: scenario.id,
        passed: scenario.passed,
        applied: scenario.applied,
        validationStatus: scenario.validationStatus,
        rollbackAttempted: scenario.rollbackAttempted,
        rollbackSucceeded: scenario.rollbackSucceeded,
        checkpointVerified: scenario.checkpointVerified,
        finalStateVerified: scenario.finalStateVerified,
        blockReasons: scenario.blockReasons,
      })),
    ),
  );
}

function createApprovedWrite(params: {
  id: string;
  path: string;
  content: string;
  expectedBeforeSha256: string | 'absent';
  now: number;
}) {
  const request = createAoiApprovedFileMutationRequest({
    sessionPath: 'aoi/controlled-real',
    proposalId: `proposal-${params.id}`,
    decisionId: `decision-${params.id}`,
    operation: 'write',
    path: params.path,
    content: params.content,
    purpose: `Controlled-real ${params.id} file mutation trial`,
    risk: 'high',
    requestedAt: params.now,
    evidenceRefs: [`controlled-real:${params.id}`],
    validationPlan: {
      version: 1,
      expectedBeforeSha256: params.expectedBeforeSha256,
      expectedAfterSha256: sha256(params.content),
    },
  });
  return {
    request,
    approvedPolicy: evaluateAoiApprovedFileMutationPolicy(request),
  };
}

function scenarioEvidence(
  id: AoiControlledRealFileScenarioId,
  checkpointFingerprint?: string,
): string[] {
  return [
    `controlled-real:${id}`,
    ...(checkpointFingerprint
      ? [`aoi-action-checkpoint-fingerprint:${checkpointFingerprint}`]
      : []),
  ];
}

function runValidatedSuccess(root: string, now: number): AoiControlledRealFileScenarioResult {
  const id = 'validated_success' as const;
  const path = 'validated-success/target.txt';
  const target = join(root, path);
  const approval = createApprovedWrite({
    id,
    path,
    content: 'approved-success',
    expectedBeforeSha256: 'absent',
    now,
  });
  const result = applyAoiApprovedFileMutation(approval.request, {
    workspaceRoot: root,
    approvedPolicy: approval.approvedPolicy,
    now: now + 1,
  });
  const finalStateVerified =
    fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'approved-success';
  return {
    version: 1,
    id,
    passed:
      result.ok &&
      result.validationStatus === 'passed' &&
      Boolean(result.checkpointFingerprint) &&
      finalStateVerified,
    applied: result.applied,
    validationStatus: result.validationStatus,
    rollbackAttempted: result.rollbackAttempted,
    rollbackSucceeded: result.rollbackSucceeded,
    checkpointVerified: Boolean(result.checkpointFingerprint),
    finalStateVerified,
    blockReasons: result.blockReasons,
    evidenceRefs: scenarioEvidence(id, result.checkpointFingerprint),
  };
}

function runTargetDrift(root: string, now: number): AoiControlledRealFileScenarioResult {
  const id = 'target_fingerprint_drift' as const;
  const path = 'target-drift/target.txt';
  const target = join(root, path);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, 'reviewed');
  const approval = createApprovedWrite({
    id,
    path,
    content: 'approved-after-review',
    expectedBeforeSha256: sha256('reviewed'),
    now,
  });
  fs.writeFileSync(target, 'drifted-after-approval');
  const result = applyAoiApprovedFileMutation(approval.request, {
    workspaceRoot: root,
    approvedPolicy: approval.approvedPolicy,
    now: now + 1,
  });
  const finalStateVerified = fs.readFileSync(target, 'utf8') === 'drifted-after-approval';
  return {
    version: 1,
    id,
    passed:
      !result.ok &&
      result.blockReasons.includes('target_fingerprint_mismatch') &&
      !result.rollbackAttempted &&
      finalStateVerified,
    applied: result.applied,
    validationStatus: result.validationStatus,
    rollbackAttempted: result.rollbackAttempted,
    rollbackSucceeded: result.rollbackSucceeded,
    checkpointVerified: Boolean(result.checkpointFingerprint),
    finalStateVerified,
    blockReasons: result.blockReasons,
    evidenceRefs: scenarioEvidence(id, result.checkpointFingerprint),
  };
}

function runValidationRollback(root: string, now: number): AoiControlledRealFileScenarioResult {
  const id = 'validation_failure_rollback' as const;
  const path = 'validation-rollback/target.txt';
  const target = join(root, path);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, 'before');
  const approval = createApprovedWrite({
    id,
    path,
    content: 'approved-after-validation',
    expectedBeforeSha256: sha256('before'),
    now,
  });
  const result = applyAoiApprovedFileMutation(approval.request, {
    workspaceRoot: root,
    approvedPolicy: approval.approvedPolicy,
    now: now + 1,
    afterMutationBeforeValidation: (targetPath) => {
      fs.writeFileSync(targetPath, 'tampered-before-validation');
    },
  });
  const finalStateVerified = fs.readFileSync(target, 'utf8') === 'before';
  return {
    version: 1,
    id,
    passed:
      !result.ok &&
      result.validationStatus === 'failed' &&
      result.rollbackAttempted &&
      result.rollbackSucceeded &&
      finalStateVerified,
    applied: result.applied,
    validationStatus: result.validationStatus,
    rollbackAttempted: result.rollbackAttempted,
    rollbackSucceeded: result.rollbackSucceeded,
    checkpointVerified: Boolean(result.checkpointFingerprint),
    finalStateVerified,
    blockReasons: result.blockReasons,
    evidenceRefs: scenarioEvidence(id, result.checkpointFingerprint),
  };
}

function runRollbackFailureDetection(
  root: string,
  now: number,
): AoiControlledRealFileScenarioResult {
  const id = 'rollback_failure_detection' as const;
  const path = 'rollback-failure/target.txt';
  const target = join(root, path);
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, 'before');
  const approval = createApprovedWrite({
    id,
    path,
    content: 'approved-before-injected-failure',
    expectedBeforeSha256: sha256('before'),
    now,
  });
  const result = applyAoiApprovedFileMutation(approval.request, {
    workspaceRoot: root,
    approvedPolicy: approval.approvedPolicy,
    now: now + 1,
    afterMutationBeforeValidation: (targetPath) => {
      fs.writeFileSync(targetPath, 'tampered-before-validation');
    },
    rollbackCheckpoint: (checkpoint) => ({
      version: 1,
      ok: false,
      checkpointId: checkpoint.id,
      restoredAt: now + 1,
      restoredCount: 0,
      deletedCount: 0,
      failedCount: 1,
      entries: [{ pathLabel: path, outcome: 'failed', reason: 'controlled-real injection' }],
      blockedReasons: ['controlled_real_rollback_failure'],
      evidenceRefs: [`aoi-action-checkpoint:${checkpoint.id}`],
    }),
  });
  const finalStateVerified = fs.readFileSync(target, 'utf8') === 'tampered-before-validation';
  return {
    version: 1,
    id,
    passed:
      !result.ok &&
      result.rollbackAttempted &&
      !result.rollbackSucceeded &&
      result.blockReasons.includes('rollback_failed') &&
      finalStateVerified,
    applied: result.applied,
    validationStatus: result.validationStatus,
    rollbackAttempted: result.rollbackAttempted,
    rollbackSucceeded: result.rollbackSucceeded,
    checkpointVerified: Boolean(result.checkpointFingerprint),
    finalStateVerified,
    blockReasons: result.blockReasons,
    evidenceRefs: scenarioEvidence(id, result.checkpointFingerprint),
  };
}

export function runAoiControlledRealFileExecutionHarness(
  now = Date.now(),
): AoiControlledRealFileExecutionReport {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(join(tempParent, 'aoi-controlled-real-file-')));
  let scenarios: AoiControlledRealFileScenarioResult[] = [];
  let cleanupVerified = false;
  try {
    scenarios = [
      runValidatedSuccess(root, now),
      runTargetDrift(root, now + 10),
      runValidationRollback(root, now + 20),
      runRollbackFailureDetection(root, now + 30),
    ];
  } finally {
    const relativeRoot = relative(tempParent, root);
    if (
      relativeRoot &&
      !relativeRoot.startsWith('..') &&
      !isAbsolute(relativeRoot) &&
      basename(root).startsWith('aoi-controlled-real-file-')
    ) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    cleanupVerified = !fs.existsSync(root);
  }
  const behaviorFingerprint = fingerprintAoiControlledRealFileBehavior(scenarios);
  const passedScenarioCount = scenarios.filter((scenario) => scenario.passed).length;
  return {
    version: 1,
    id: `aoi-controlled-real-file-${behaviorFingerprint.slice(0, 16)}`,
    evidenceClass: 'controlled_real',
    generatedAt: now,
    passed: passedScenarioCount === scenarios.length && cleanupVerified,
    scenarioCount: scenarios.length,
    passedScenarioCount,
    behaviorFingerprint,
    cleanupVerified,
    scenarios,
    evidenceRefs: scenarios.flatMap((scenario) => scenario.evidenceRefs).slice(0, 32),
    actionAuthority: 'disposable_workspace_only',
  };
}
