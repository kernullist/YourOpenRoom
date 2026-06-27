import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AoiActionCheckpointError,
  buildAoiApprovalSandboxRecoveryFromCheckpoint,
  createAoiActionCheckpoint,
  rollbackAoiActionCheckpoint,
} from '../aoiActionCheckpoint';
import {
  createAoiApprovalSandboxPreview,
  hasAoiApprovalSandboxRecoveryEvidence,
} from '../aoiApprovalSandbox';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-action-checkpoint-test-'));
  // Resolve symlinks (macOS /var -> /private/var, Windows short names) so the
  // root the test sees matches the realpath the module hashes against.
  tempRoots.push(root);
  return fs.realpathSync(root);
}

function symlinkSupported(): boolean {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-symlink-probe-'));
  try {
    fs.writeFileSync(join(dir, 'target.txt'), 'x');
    fs.symlinkSync(join(dir, 'target.txt'), join(dir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINK_SUPPORTED = symlinkSupported();

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('createAoiActionCheckpoint', () => {
  it('captures the byte content of an existing file', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'data.json'), '{"value":1}');
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['data.json'],
      now: 1000,
    });
    expect(checkpoint.entries).toHaveLength(1);
    const entry = checkpoint.entries[0];
    expect(entry.existedBefore).toBe(true);
    expect(entry.encoding).toBe('base64');
    expect(Buffer.from(entry.content ?? '', 'base64').toString('utf8')).toBe('{"value":1}');
    expect(entry.byteLength).toBe('{"value":1}'.length);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.pathLabel).toBe('data.json');
    expect(checkpoint.evidenceRefs).toContain(`aoi-action-checkpoint:${checkpoint.id}`);
  });

  it('records an absent file with the directory chain it would create', () => {
    const root = makeTempRoot();
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['nested/deep/dir/new.json'],
      now: 1000,
    });
    const entry = checkpoint.entries[0];
    expect(entry.existedBefore).toBe(false);
    expect(entry.content).toBeUndefined();
    // Deepest first.
    expect(entry.createdDirLabels).toEqual(['nested/deep/dir', 'nested/deep', 'nested']);
  });

  it('treats relative and absolute paths to the same file as one entry', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'data.json'), 'x');
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['data.json', join(root, 'data.json')],
      now: 1000,
    });
    expect(checkpoint.entries).toHaveLength(1);
  });

  it('produces a stable id for identical inputs and a different id when now changes', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'data.json'), 'x');
    const a = createAoiActionCheckpoint({ workspaceRoot: root, paths: ['data.json'], now: 1000 });
    const b = createAoiActionCheckpoint({ workspaceRoot: root, paths: ['data.json'], now: 1000 });
    const c = createAoiActionCheckpoint({ workspaceRoot: root, paths: ['data.json'], now: 2000 });
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it('throws when given no paths', () => {
    const root = makeTempRoot();
    expect(() => createAoiActionCheckpoint({ workspaceRoot: root, paths: [], now: 1000 })).toThrow(
      AoiActionCheckpointError,
    );
  });

  it('fails closed on a path that escapes the workspace root', () => {
    const root = makeTempRoot();
    let code = '';
    try {
      createAoiActionCheckpoint({ workspaceRoot: root, paths: ['../escape.json'], now: 1000 });
    } catch (error) {
      code = error instanceof AoiActionCheckpointError ? error.code : 'other';
    }
    expect(code).toBe('path_escapes_workspace');
  });

  it('fails closed on a directory target', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, 'a-dir'));
    let code = '';
    try {
      createAoiActionCheckpoint({ workspaceRoot: root, paths: ['a-dir'], now: 1000 });
    } catch (error) {
      code = error instanceof AoiActionCheckpointError ? error.code : 'other';
    }
    expect(code).toBe('path_is_directory');
  });

  it('fails closed on a file larger than the per-file cap', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'big.bin'), Buffer.alloc(2048, 1));
    let code = '';
    try {
      createAoiActionCheckpoint({
        workspaceRoot: root,
        paths: ['big.bin'],
        now: 1000,
        maxBytesPerFile: 1024,
      });
    } catch (error) {
      code = error instanceof AoiActionCheckpointError ? error.code : 'other';
    }
    expect(code).toBe('file_too_large');
  });

  it.skipIf(!SYMLINK_SUPPORTED)('fails closed on a symlink target', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'real.txt'), 'x');
    fs.symlinkSync(join(root, 'real.txt'), join(root, 'link.txt'));
    let code = '';
    try {
      createAoiActionCheckpoint({ workspaceRoot: root, paths: ['link.txt'], now: 1000 });
    } catch (error) {
      code = error instanceof AoiActionCheckpointError ? error.code : 'other';
    }
    expect(code).toBe('path_is_symlink');
  });
});

describe('rollbackAoiActionCheckpoint', () => {
  it('restores the original content of a modified file', () => {
    const root = makeTempRoot();
    const file = join(root, 'data.json');
    fs.writeFileSync(file, 'original');
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['data.json'],
      now: 1000,
    });
    fs.writeFileSync(file, 'mutated');
    const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
    expect(result.ok).toBe(true);
    expect(result.restoredCount).toBe(1);
    expect(result.entries[0].outcome).toBe('restored');
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });

  it('deletes a file that was created after the checkpoint and cleans created dirs', () => {
    const root = makeTempRoot();
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['nested/new.json'],
      now: 1000,
    });
    fs.mkdirSync(join(root, 'nested'), { recursive: true });
    fs.writeFileSync(join(root, 'nested/new.json'), 'created');
    const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
    expect(result.ok).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(result.entries[0].outcome).toBe('deleted');
    expect(fs.existsSync(join(root, 'nested/new.json'))).toBe(false);
    // The directory the write created is removed too.
    expect(fs.existsSync(join(root, 'nested'))).toBe(false);
  });

  it('recreates a file that existed before but was deleted', () => {
    const root = makeTempRoot();
    const file = join(root, 'data.json');
    fs.writeFileSync(file, 'keepme');
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['data.json'],
      now: 1000,
    });
    fs.unlinkSync(file);
    const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
    expect(result.ok).toBe(true);
    expect(result.restoredCount).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('keepme');
  });

  it('reports unchanged when an absent-before file is still absent', () => {
    const root = makeTempRoot();
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['ghost.json'],
      now: 1000,
    });
    const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
    expect(result.ok).toBe(true);
    expect(result.entries[0].outcome).toBe('unchanged');
  });

  it('round-trips binary content losslessly', () => {
    const root = makeTempRoot();
    const file = join(root, 'blob.bin');
    const original = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80]);
    fs.writeFileSync(file, original);
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['blob.bin'],
      now: 1000,
    });
    fs.writeFileSync(file, Buffer.from([0x42]));
    const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  });

  it('fails closed and touches nothing on a workspace root mismatch', () => {
    const root = makeTempRoot();
    const otherRoot = makeTempRoot();
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['nested/new.json'],
      now: 1000,
    });
    fs.mkdirSync(join(root, 'nested'), { recursive: true });
    fs.writeFileSync(join(root, 'nested/new.json'), 'created');
    const result = rollbackAoiActionCheckpoint(checkpoint, {
      workspaceRoot: otherRoot,
      now: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReasons).toContain('workspace_root_mismatch');
    expect(result.entries).toHaveLength(0);
    // The created file must remain untouched after a mismatched rollback.
    expect(fs.existsSync(join(root, 'nested/new.json'))).toBe(true);
  });

  it('leaves a non-empty created directory in place during cleanup', () => {
    const root = makeTempRoot();
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['shared/new.json'],
      now: 1000,
    });
    fs.mkdirSync(join(root, 'shared'), { recursive: true });
    fs.writeFileSync(join(root, 'shared/new.json'), 'created');
    // A sibling file appears in the same directory the mutation created.
    fs.writeFileSync(join(root, 'shared/other.json'), 'sibling');
    const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
    expect(result.entries[0].outcome).toBe('deleted');
    expect(fs.existsSync(join(root, 'shared/new.json'))).toBe(false);
    // Directory stays because it is no longer empty.
    expect(fs.existsSync(join(root, 'shared/other.json'))).toBe(true);
  });

  it.skipIf(!SYMLINK_SUPPORTED)(
    'refuses to write through a symlink that appeared after capture',
    () => {
      const root = makeTempRoot();
      const file = join(root, 'data.json');
      fs.writeFileSync(file, 'original');
      const checkpoint = createAoiActionCheckpoint({
        workspaceRoot: root,
        paths: ['data.json'],
        now: 1000,
      });
      fs.unlinkSync(file);
      fs.writeFileSync(join(root, 'outside-target.txt'), 'attacker');
      fs.symlinkSync(join(root, 'outside-target.txt'), file);
      const result = rollbackAoiActionCheckpoint(checkpoint, { workspaceRoot: root, now: 2000 });
      expect(result.ok).toBe(false);
      expect(result.entries[0].outcome).toBe('failed');
      expect(result.entries[0].reason).toBe('unexpected_symlink');
    },
  );
});

describe('buildAoiApprovalSandboxRecoveryFromCheckpoint', () => {
  it('maps a checkpoint into approval-sandbox recovery fields', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'data.json'), 'x');
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['data.json', 'created.json'],
      now: 1000,
    });
    const recovery = buildAoiApprovalSandboxRecoveryFromCheckpoint(checkpoint);
    expect(recovery.beforeSnapshotRef).toBe(`aoi-action-checkpoint:${checkpoint.id}`);
    expect(recovery.recoveryPlan?.kind).toBe('before_snapshot');
    expect(recovery.recoveryPlan?.available).toBe(true);
    expect(recovery.rollback?.required).toBe(true);
  });

  it('drives a real approval sandbox preview to a satisfied recovery state', () => {
    const root = makeTempRoot();
    fs.writeFileSync(join(root, 'data.json'), 'x');
    const checkpoint = createAoiActionCheckpoint({
      workspaceRoot: root,
      paths: ['data.json'],
      now: 1000,
    });
    const recovery = buildAoiApprovalSandboxRecoveryFromCheckpoint(checkpoint);
    const preview = createAoiApprovalSandboxPreview({
      targetKind: 'workspace',
      targetId: 'data.json',
      intendedMutation: 'Overwrite data.json with reviewed content.',
      dryRunSummary: 'Write new JSON to data.json.',
      requiredAuthorityDecisionId: 'authority-decision:test',
      expectedMutationCount: 1,
      ...recovery,
    });
    expect(preview.recoveryPlan.kind).toBe('before_snapshot');
    expect(preview.recoveryPlan.available).toBe(true);
    expect(preview.rollback.required).toBe(true);
    expect(hasAoiApprovalSandboxRecoveryEvidence(preview)).toBe(true);
  });
});
