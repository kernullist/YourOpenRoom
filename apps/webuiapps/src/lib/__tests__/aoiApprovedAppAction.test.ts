import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AOI_APP_ACTION_APPROVAL_TTL_MS,
  compareAoiApprovedAppActionApproval,
  createAoiApprovedAppActionRequest,
  evaluateAoiApprovedAppActionPolicy,
  normalizeAoiApprovedAppActionPolicy,
} from '../aoiApprovedAppActionPolicy';
import { applyAoiApprovedAppAction } from '../aoiApprovedAppActionRunner';
import type { AoiApprovedAppActionRequest } from '../aoiAutonomyTypes';
import type { AppDef } from '../appRegistry';

// 'twitter' has a static 'post' schema in appSchemaRegistry, so the broker
// classifies twitter:schema:create_post as a file_backed (schema_file_write)
// capability whose dataRoot is apps/twitter/data.
const TWITTER_APP: AppDef = {
  appId: 2,
  appName: 'twitter',
  displayName: 'Twitter',
  route: '/twitter',
  aliases: [],
  actions: [{ name: 'OPEN_APP_WINDOW', description: 'Open Twitter', params: [] }],
};

const APPS = [TWITTER_APP];

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-app-action-test-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function fileBackedRequest(
  overrides: Partial<Parameters<typeof createAoiApprovedAppActionRequest>[0]> = {},
): AoiApprovedAppActionRequest {
  return createAoiApprovedAppActionRequest({
    sessionPath: 'aoi/default',
    proposalId: 'proposal-1',
    decisionId: 'decision-1',
    appReference: 'twitter',
    intentReference: 'create_post',
    path: 'apps/twitter/data/posts/p1.json',
    content: '{"id":"p1","text":"hello"}',
    purpose: 'Create an approved twitter post',
    risk: 'high',
    requestedAt: 1000,
    evidenceRefs: ['memory:m1'],
    ...overrides,
  });
}

describe('evaluateAoiApprovedAppActionPolicy', () => {
  it('allows a file_backed schema write inside the app dataRoot and binds a fingerprint', () => {
    const policy = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    expect(policy.allowed).toBe(true);
    expect(policy.routing).toBe('file_backed');
    expect(policy.executionKind).toBe('schema_file_write');
    expect(policy.appName).toBe('twitter');
    expect(policy.capabilityId).toBe('twitter:schema:create_post');
    expect(policy.requiredAutonomyLevel).toBe('L5');
    expect(policy.dataRoot).toBe('apps/twitter/data');
    expect(policy.fileMutation?.allowed).toBe(true);
    expect(policy.operationHash).toMatch(/^[0-9a-f]{16}$/);
    expect(policy.approvalFingerprint.length).toBeGreaterThan(0);
    expect(policy.approvalSandbox?.expectedMutationCount).toBe(1);
  });

  it('blocks a file_backed write whose path escapes the app dataRoot', () => {
    const policy = evaluateAoiApprovedAppActionPolicy(
      fileBackedRequest({ path: 'apps/diary/data/posts/p1.json' }),
      { apps: APPS },
    );
    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('path_outside_data_root');
  });

  it('allows a pure app/window operation and routes it to a review handoff', () => {
    const policy = evaluateAoiApprovedAppActionPolicy(
      createAoiApprovedAppActionRequest({
        sessionPath: 'aoi/default',
        appReference: 'twitter',
        actionType: 'OPEN_APP_WINDOW',
        purpose: 'Open the Twitter window',
        risk: 'low',
        requestedAt: 1000,
        evidenceRefs: ['memory:m1'],
      }),
      { apps: APPS },
    );
    expect(policy.routing).toBe('app_operation');
    expect(policy.executionKind).toBe('window_action');
    expect(policy.allowed).toBe(true);
    expect(policy.blockReasons).toEqual([]);
    // The server makes no direct app mutation; the live op is reviewed via Kira.
    expect(policy.approvalSandbox?.expectedMutationCount).toBe(0);
    expect(policy.fileMutation).toBeUndefined();
  });

  it('blocks an unknown app or capability', () => {
    const policy = evaluateAoiApprovedAppActionPolicy(
      createAoiApprovedAppActionRequest({
        sessionPath: 'aoi/default',
        appReference: 'twitter',
        actionType: 'NOT_A_REAL_ACTION',
        purpose: 'Do something unknown',
        risk: 'high',
        requestedAt: 1000,
        evidenceRefs: ['memory:m1'],
      }),
      { apps: APPS },
    );
    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('unknown_app_or_capability');
  });

  it('blocks a missing app reference', () => {
    const policy = evaluateAoiApprovedAppActionPolicy(
      createAoiApprovedAppActionRequest({
        sessionPath: 'aoi/default',
        appReference: '',
        intentReference: 'create_post',
        purpose: 'No app',
        risk: 'high',
        requestedAt: 1000,
        evidenceRefs: ['memory:m1'],
      }),
      { apps: APPS },
    );
    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('missing_app_reference');
  });

  it('produces a different operation hash and fingerprint when content changes', () => {
    const a = evaluateAoiApprovedAppActionPolicy(fileBackedRequest({ content: 'one' }), {
      apps: APPS,
    });
    const b = evaluateAoiApprovedAppActionPolicy(fileBackedRequest({ content: 'two' }), {
      apps: APPS,
    });
    expect(a.operationHash).not.toBe(b.operationHash);
    expect(a.approvalFingerprint).not.toBe(b.approvalFingerprint);
  });
});

describe('compareAoiApprovedAppActionApproval', () => {
  it('reports approval_missing when there is no approved policy', () => {
    const current = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    expect(
      compareAoiApprovedAppActionApproval({ approved: undefined, current, now: 2000 }),
    ).toContain('approval_missing');
  });

  it('accepts a matching, unexpired approval', () => {
    const approved = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    const current = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    expect(compareAoiApprovedAppActionApproval({ approved, current, now: 2000 })).toEqual([]);
  });

  it('detects an operation change between approval and execution', () => {
    const approved = evaluateAoiApprovedAppActionPolicy(fileBackedRequest({ content: 'old' }), {
      apps: APPS,
    });
    const current = evaluateAoiApprovedAppActionPolicy(fileBackedRequest({ content: 'new' }), {
      apps: APPS,
    });
    expect(compareAoiApprovedAppActionApproval({ approved, current, now: 2000 })).toContain(
      'approval_operation_changed',
    );
  });

  it('detects an expired approval', () => {
    const approved = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    const current = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    const reasons = compareAoiApprovedAppActionApproval({
      approved,
      current,
      now: 1000 + AOI_APP_ACTION_APPROVAL_TTL_MS + 1,
    });
    expect(reasons).toContain('approval_expired');
  });
});

describe('normalizeAoiApprovedAppActionPolicy', () => {
  it('round-trips a valid policy', () => {
    const policy = evaluateAoiApprovedAppActionPolicy(fileBackedRequest(), { apps: APPS });
    const restored = normalizeAoiApprovedAppActionPolicy(JSON.parse(JSON.stringify(policy)));
    expect(restored?.approvalFingerprint).toBe(policy.approvalFingerprint);
    expect(restored?.operationHash).toBe(policy.operationHash);
    expect(restored?.routing).toBe('file_backed');
    expect(restored?.fileMutation?.contentHash).toBe(policy.fileMutation?.contentHash);
  });

  it('rejects a non-policy value', () => {
    expect(normalizeAoiApprovedAppActionPolicy({ version: 2 })).toBeUndefined();
    expect(normalizeAoiApprovedAppActionPolicy(null)).toBeUndefined();
  });
});

describe('applyAoiApprovedAppAction', () => {
  it('applies a file_backed schema write to the app dataRoot behind a checkpoint', () => {
    const root = makeTempRoot();
    const request = fileBackedRequest();
    const approved = evaluateAoiApprovedAppActionPolicy(request, { apps: APPS });
    const result = applyAoiApprovedAppAction(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      apps: APPS,
      now: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.routing).toBe('file_backed');
    expect(result.executionKind).toBe('schema_file_write');
    expect(result.checkpointId).toBeTruthy();
    expect(result.fileMutationResult?.ok).toBe(true);
    expect(result.auditRecord.applied).toBe(true);
    expect(fs.readFileSync(join(root, 'apps/twitter/data/posts/p1.json'), 'utf8')).toBe(
      '{"id":"p1","text":"hello"}',
    );
  });

  it('blocks and leaves the file untouched when the approval is missing', () => {
    const root = makeTempRoot();
    const request = fileBackedRequest();
    const result = applyAoiApprovedAppAction(request, {
      workspaceRoot: root,
      apps: APPS,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
    expect(fs.existsSync(join(root, 'apps/twitter/data/posts/p1.json'))).toBe(false);
  });

  it('blocks when the operation changed since approval (content-addressed)', () => {
    const root = makeTempRoot();
    const approved = evaluateAoiApprovedAppActionPolicy(
      fileBackedRequest({ content: 'approved-content' }),
      { apps: APPS },
    );
    const tampered = fileBackedRequest({ content: 'tampered-content' });
    const result = applyAoiApprovedAppAction(tampered, {
      workspaceRoot: root,
      approvedPolicy: approved,
      apps: APPS,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('approval_operation_changed');
    expect(fs.existsSync(join(root, 'apps/twitter/data/posts/p1.json'))).toBe(false);
  });

  it('hands a pure app/window operation to a review handoff without touching disk', () => {
    const root = makeTempRoot();
    const request = createAoiApprovedAppActionRequest({
      sessionPath: 'aoi/default',
      appReference: 'twitter',
      actionType: 'OPEN_APP_WINDOW',
      purpose: 'Open the Twitter window',
      risk: 'low',
      requestedAt: 1000,
      evidenceRefs: ['memory:m1'],
    });
    const approved = evaluateAoiApprovedAppActionPolicy(request, { apps: APPS });
    const result = applyAoiApprovedAppAction(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      apps: APPS,
      now: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.reviewHandoff).toBe(true);
    expect(result.routing).toBe('app_operation');
    expect(result.auditRecord.reviewHandoff).toBe(true);
    expect(result.blockReasons).toEqual([]);
  });

  it('blocks a pure app/window operation when its approval is missing', () => {
    const root = makeTempRoot();
    const request = createAoiApprovedAppActionRequest({
      sessionPath: 'aoi/default',
      appReference: 'twitter',
      actionType: 'OPEN_APP_WINDOW',
      purpose: 'Open the Twitter window',
      risk: 'low',
      requestedAt: 1000,
      evidenceRefs: ['memory:m1'],
    });
    const result = applyAoiApprovedAppAction(request, {
      workspaceRoot: root,
      apps: APPS,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.reviewHandoff).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
  });
});
