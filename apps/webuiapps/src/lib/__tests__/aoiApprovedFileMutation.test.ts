import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AOI_FILE_MUTATION_APPROVAL_TTL_MS,
  compareAoiApprovedFileMutationApproval,
  createAoiApprovedFileMutationRequest,
  evaluateAoiApprovedFileMutationPolicy,
  normalizeAoiApprovedFileMutationPolicy,
} from '../aoiApprovedFileMutationPolicy';
import { applyAoiApprovedFileMutation } from '../aoiApprovedFileMutationRunner';
import type { AoiApprovedFileMutationRequest } from '../aoiAutonomyTypes';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-file-mutation-test-'));
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

function writeRequest(
  path: string,
  content: string,
  now = 1000,
  overrides: Partial<AoiApprovedFileMutationRequest> = {},
): AoiApprovedFileMutationRequest {
  return createAoiApprovedFileMutationRequest({
    sessionPath: 'aoi/default',
    proposalId: 'proposal-1',
    decisionId: 'decision-1',
    operation: 'write',
    path,
    content,
    purpose: 'Persist reviewed content',
    risk: 'high',
    requestedAt: now,
    evidenceRefs: ['memory:m1'],
    ...overrides,
  });
}

describe('evaluateAoiApprovedFileMutationPolicy', () => {
  it('allows a safe write and binds a content-addressed fingerprint', () => {
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', '{}'));
    expect(policy.allowed).toBe(true);
    expect(policy.requiredAutonomyLevel).toBe('L5');
    expect(policy.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.approvalFingerprint.length).toBeGreaterThan(0);
    expect(policy.approvalSandbox?.expectedMutationCount).toBe(1);
  });

  it('allows a safe patch and defaults expectedCount to 1', () => {
    const request = createAoiApprovedFileMutationRequest({
      sessionPath: 'aoi/default',
      operation: 'patch',
      path: 'apps/x/data/a.json',
      patchOps: [{ find: 'a', replace: 'b' }],
      requestedAt: 1000,
    });
    const policy = evaluateAoiApprovedFileMutationPolicy(request);
    expect(policy.allowed).toBe(true);
    expect(policy.patchOps?.[0].expectedCount).toBe(1);
  });

  it('blocks an absolute path', () => {
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('/etc/passwd', 'x'));
    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('path_not_relative');
  });

  it('blocks a path that escapes the workspace', () => {
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('../../secret.json', 'x'));
    expect(policy.blockReasons).toContain('path_escapes_workspace');
  });

  it('blocks an unsafe path charset', () => {
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/a b.json', 'x'));
    expect(policy.blockReasons).toContain('unsafe_path');
  });

  it('blocks a protected path', () => {
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('.git/config', 'x'));
    expect(policy.blockReasons).toContain('protected_path');
  });

  it('blocks content over the size cap', () => {
    const big = 'a'.repeat(300 * 1024);
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', big));
    expect(policy.blockReasons).toContain('content_too_large');
  });

  it('blocks a write with no content', () => {
    const request = createAoiApprovedFileMutationRequest({
      sessionPath: 'aoi/default',
      operation: 'write',
      path: 'apps/x/data/a.json',
      requestedAt: 1000,
    });
    // createAoiApprovedFileMutationRequest only sets content when a string is
    // supplied, so a missing content stays absent.
    const policy = evaluateAoiApprovedFileMutationPolicy(request);
    expect(policy.blockReasons).toContain('missing_content');
  });

  it('blocks a patch with no ops', () => {
    const request = createAoiApprovedFileMutationRequest({
      sessionPath: 'aoi/default',
      operation: 'patch',
      path: 'apps/x/data/a.json',
      patchOps: [],
      requestedAt: 1000,
    });
    const policy = evaluateAoiApprovedFileMutationPolicy(request);
    expect(policy.blockReasons).toContain('missing_patch_ops');
  });

  it('produces a different fingerprint when content changes', () => {
    const a = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', 'one'));
    const b = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', 'two'));
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.approvalFingerprint).not.toBe(b.approvalFingerprint);
  });
});

describe('compareAoiApprovedFileMutationApproval', () => {
  it('reports approval_missing when there is no approved policy', () => {
    const current = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', '{}'));
    expect(
      compareAoiApprovedFileMutationApproval({ approved: undefined, current, now: 2000 }),
    ).toContain('approval_missing');
  });

  it('accepts a matching, unexpired approval', () => {
    const approved = evaluateAoiApprovedFileMutationPolicy(
      writeRequest('apps/x/data/a.json', '{}'),
    );
    const current = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', '{}'));
    expect(compareAoiApprovedFileMutationApproval({ approved, current, now: 2000 })).toEqual([]);
  });

  it('detects a content change between approval and execution', () => {
    const approved = evaluateAoiApprovedFileMutationPolicy(
      writeRequest('apps/x/data/a.json', 'old'),
    );
    const current = evaluateAoiApprovedFileMutationPolicy(
      writeRequest('apps/x/data/a.json', 'new'),
    );
    expect(compareAoiApprovedFileMutationApproval({ approved, current, now: 2000 })).toContain(
      'approval_content_changed',
    );
  });

  it('detects an expired approval', () => {
    const approved = evaluateAoiApprovedFileMutationPolicy(
      writeRequest('apps/x/data/a.json', '{}'),
    );
    const current = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', '{}'));
    const reasons = compareAoiApprovedFileMutationApproval({
      approved,
      current,
      now: 1000 + AOI_FILE_MUTATION_APPROVAL_TTL_MS + 1,
    });
    expect(reasons).toContain('approval_expired');
  });
});

describe('normalizeAoiApprovedFileMutationPolicy', () => {
  it('round-trips a valid policy', () => {
    const policy = evaluateAoiApprovedFileMutationPolicy(writeRequest('apps/x/data/a.json', '{}'));
    const restored = normalizeAoiApprovedFileMutationPolicy(JSON.parse(JSON.stringify(policy)));
    expect(restored?.approvalFingerprint).toBe(policy.approvalFingerprint);
    expect(restored?.contentHash).toBe(policy.contentHash);
  });

  it('rejects a non-policy value', () => {
    expect(normalizeAoiApprovedFileMutationPolicy({ version: 2 })).toBeUndefined();
    expect(normalizeAoiApprovedFileMutationPolicy(null)).toBeUndefined();
  });
});

describe('applyAoiApprovedFileMutation', () => {
  it('writes a new file with approved content behind a checkpoint', () => {
    const root = makeTempRoot();
    const request = writeRequest('apps/x/data/a.json', '{"v":1}', 1000);
    const approved = evaluateAoiApprovedFileMutationPolicy(request);
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.bytesBefore).toBeNull();
    expect(result.bytesAfter).toBe('{"v":1}'.length);
    expect(result.checkpointId).toBeTruthy();
    expect(result.checkpoint).toBeTruthy();
    expect(fs.readFileSync(join(root, 'apps/x/data/a.json'), 'utf8')).toBe('{"v":1}');
  });

  it('replaces an existing file and reports the original size', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'apps/x/data'), { recursive: true });
    fs.writeFileSync(join(root, 'apps/x/data/a.json'), 'old');
    const request = writeRequest('apps/x/data/a.json', 'brand-new', 1000);
    const approved = evaluateAoiApprovedFileMutationPolicy(request);
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.bytesBefore).toBe(3);
    expect(fs.readFileSync(join(root, 'apps/x/data/a.json'), 'utf8')).toBe('brand-new');
  });

  it('blocks and leaves the file untouched when the approval is missing', () => {
    const root = makeTempRoot();
    const request = writeRequest('apps/x/data/a.json', '{"v":1}', 1000);
    const result = applyAoiApprovedFileMutation(request, { workspaceRoot: root, now: 2000 });
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.blockReasons).toContain('approval_missing');
    expect(fs.existsSync(join(root, 'apps/x/data/a.json'))).toBe(false);
  });

  it('blocks when the content changed since approval', () => {
    const root = makeTempRoot();
    const approvedRequest = writeRequest('apps/x/data/a.json', 'approved-content', 1000);
    const approved = evaluateAoiApprovedFileMutationPolicy(approvedRequest);
    const tamperedRequest = writeRequest('apps/x/data/a.json', 'tampered-content', 1000);
    const result = applyAoiApprovedFileMutation(tamperedRequest, {
      workspaceRoot: root,
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('approval_content_changed');
    expect(fs.existsSync(join(root, 'apps/x/data/a.json'))).toBe(false);
  });

  it('applies an anchored patch', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'apps/x/data'), { recursive: true });
    fs.writeFileSync(join(root, 'apps/x/data/a.json'), 'hello WORLD hello');
    const request = createAoiApprovedFileMutationRequest({
      sessionPath: 'aoi/default',
      operation: 'patch',
      path: 'apps/x/data/a.json',
      patchOps: [{ find: 'WORLD', replace: 'there', expectedCount: 1 }],
      requestedAt: 1000,
      evidenceRefs: ['memory:m1'],
    });
    const approved = evaluateAoiApprovedFileMutationPolicy(request);
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(join(root, 'apps/x/data/a.json'), 'utf8')).toBe('hello there hello');
  });

  it('rolls back and leaves the file unchanged on an anchor mismatch', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'apps/x/data'), { recursive: true });
    fs.writeFileSync(join(root, 'apps/x/data/a.json'), 'hello hello');
    const request = createAoiApprovedFileMutationRequest({
      sessionPath: 'aoi/default',
      operation: 'patch',
      // 'hello' occurs twice but expectedCount defaults to 1 -> mismatch.
      path: 'apps/x/data/a.json',
      patchOps: [{ find: 'hello', replace: 'hi' }],
      requestedAt: 1000,
      evidenceRefs: ['memory:m1'],
    });
    const approved = evaluateAoiApprovedFileMutationPolicy(request);
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.blockReasons).toContain('patch_anchor_mismatch');
    expect(fs.readFileSync(join(root, 'apps/x/data/a.json'), 'utf8')).toBe('hello hello');
  });

  it('blocks a patch on a missing target file', () => {
    const root = makeTempRoot();
    const request = createAoiApprovedFileMutationRequest({
      sessionPath: 'aoi/default',
      operation: 'patch',
      path: 'apps/x/data/missing.json',
      patchOps: [{ find: 'a', replace: 'b' }],
      requestedAt: 1000,
      evidenceRefs: ['memory:m1'],
    });
    const approved = evaluateAoiApprovedFileMutationPolicy(request);
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: root,
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('patch_target_missing');
    expect(fs.existsSync(join(root, 'apps/x/data/missing.json'))).toBe(false);
  });

  it('blocks when the workspace root does not exist', () => {
    const request = writeRequest('apps/x/data/a.json', '{}', 1000);
    const approved = evaluateAoiApprovedFileMutationPolicy(request);
    const result = applyAoiApprovedFileMutation(request, {
      workspaceRoot: join(os.tmpdir(), 'aoi-nonexistent-root-zzz-12345'),
      approvedPolicy: approved,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockReasons).toContain('workspace_root_missing');
  });
});
