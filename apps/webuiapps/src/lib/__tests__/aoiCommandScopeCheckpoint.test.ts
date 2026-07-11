import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAoiCommandTouchedScopeManifest,
  createAoiCommandScopeCheckpoint,
  verifyAoiCommandTouchedScopeBoundary,
  type AoiCommandTouchedScopeManifest,
} from '../aoiCommandScopeCheckpoint';

const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-cmd-scope-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

function write(root: string, rel: string, content = 'x'): void {
  const abs = join(root, rel);
  fs.mkdirSync(join(abs, '..'), { recursive: true });
  fs.writeFileSync(abs, content);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('buildAoiCommandTouchedScopeManifest (P2.6 command)', () => {
  it('fails closed with no declared scopes', () => {
    const root = makeRoot();
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: [],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toEqual(['no_declared_scopes']);
    expect(manifest.fileLabels).toEqual([]);
  });

  it('fails closed when the workspace root cannot be resolved', () => {
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: join(os.tmpdir(), 'aoi-cmd-scope-does-not-exist-xyz'),
      declaredScopes: ['src'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('workspace_root_unresolved');
  });

  it('rejects a scope that escapes the workspace root', () => {
    const root = makeRoot();
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['../outside'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('scope_escapes_workspace');
  });

  it('rejects the workspace root itself as too broad to bound', () => {
    const root = makeRoot();
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['.'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('scope_is_workspace_root');
  });

  it('rejects a wildcard/glob scope that cannot be enumerated deterministically', () => {
    const root = makeRoot();
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['src/*.ts'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('scope_not_bounded');
  });

  it('enumerates existing files under a directory scope (recursively, sorted)', () => {
    const root = makeRoot();
    write(root, 'src/a.ts');
    write(root, 'src/nested/b.ts');
    write(root, 'other/c.ts'); // outside the declared scope -> must not appear
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['src'],
      now: NOW,
    });
    expect(manifest.ok).toBe(true);
    expect(manifest.fileLabels).toEqual(['src/a.ts', 'src/nested/b.ts']);
    expect(manifest.scopes[0]).toMatchObject({ scopeLabel: 'src', kind: 'directory' });
  });

  it('captures a single file scope', () => {
    const root = makeRoot();
    write(root, 'pkg/version.json');
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['pkg/version.json'],
      now: NOW,
    });
    expect(manifest.ok).toBe(true);
    expect(manifest.fileLabels).toEqual(['pkg/version.json']);
    expect(manifest.scopes[0]).toMatchObject({ kind: 'file', fileLabels: ['pkg/version.json'] });
  });

  it('treats a not-yet-existing declared scope as absent (bounded, still ok)', () => {
    const root = makeRoot();
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['dist'], // does not exist yet; a build command may create it
      now: NOW,
    });
    expect(manifest.ok).toBe(true);
    expect(manifest.scopes[0]).toMatchObject({
      scopeLabel: 'dist',
      kind: 'absent',
      fileLabels: [],
    });
    expect(manifest.fileLabels).toEqual([]);
  });

  it('fails closed when a scope enumerates more files than the cap allows', () => {
    const root = makeRoot();
    write(root, 'big/one.ts');
    write(root, 'big/two.ts');
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['big'],
      now: NOW,
      maxFiles: 1,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('scope_too_large');
  });

  it('fails closed on a file scope once the enumeration budget is exhausted', () => {
    const root = makeRoot();
    write(root, 'big/one.ts'); // dir scope consumes the single-file budget first
    write(root, 'solo.ts'); // then this file scope sees remaining === 0
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['big', 'solo.ts'],
      now: NOW,
      maxFiles: 1,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('scope_too_large');
  });

  it('produces an order-independent, content-addressed boundary hash', () => {
    const root = makeRoot();
    write(root, 'a/x.ts');
    write(root, 'b/y.ts');
    const m1 = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['a', 'b'],
      now: NOW,
    });
    const m2 = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['b', 'a', 'a'], // reordered + duplicate
      now: NOW,
    });
    expect(m1.boundaryHash).toBe(m2.boundaryHash);
    expect(m1.scopeLabels).toEqual(['a', 'b']);
  });

  it('rejects a symlink scope (never followed)', () => {
    const root = makeRoot();
    write(root, 'real/x.ts');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(join(root, 'real'), join(root, 'link'), 'dir');
      symlinkCreated = true;
    } catch {
      // Symlink creation is unprivileged-restricted on some Windows setups; skip.
    }
    if (!symlinkCreated) {
      return;
    }
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['link'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.blockReasons).toContain('scope_is_symlink');
  });
});

describe('createAoiCommandScopeCheckpoint (P2.6 command)', () => {
  it('snapshots every existing file under a bounded scope', () => {
    const root = makeRoot();
    write(root, 'src/a.ts', 'original-a');
    write(root, 'src/b.ts', 'original-b');
    const { manifest, checkpoint } = createAoiCommandScopeCheckpoint({
      workspaceRoot: root,
      declaredScopes: ['src'],
      now: NOW,
    });
    expect(manifest.ok).toBe(true);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.entries.map((e) => e.pathLabel).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns a null checkpoint (no snapshot) when scopes cannot be bounded', () => {
    const root = makeRoot();
    const { manifest, checkpoint } = createAoiCommandScopeCheckpoint({
      workspaceRoot: root,
      declaredScopes: ['../escape'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    expect(checkpoint).toBeNull();
  });

  it('returns a null checkpoint when all scopes are absent (nothing to snapshot yet)', () => {
    const root = makeRoot();
    const { manifest, checkpoint } = createAoiCommandScopeCheckpoint({
      workspaceRoot: root,
      declaredScopes: ['dist'],
      now: NOW,
    });
    expect(manifest.ok).toBe(true);
    expect(checkpoint).toBeNull();
  });
});

describe('verifyAoiCommandTouchedScopeBoundary (P2.6 command)', () => {
  function bounded(root: string): AoiCommandTouchedScopeManifest {
    write(root, 'src/a.ts');
    return buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['src', 'pkg/version.json', 'dist'],
      now: NOW,
    });
  }

  it('passes when every changed path is inside a declared scope', () => {
    const root = makeRoot();
    const manifest = bounded(root);
    const result = verifyAoiCommandTouchedScopeBoundary({
      manifest,
      changedLabels: ['src/a.ts', 'src/new.ts', 'pkg/version.json', 'dist/out.js'],
    });
    expect(result.ok).toBe(true);
    expect(result.outOfScope).toEqual([]);
    expect(result.inScope).toContain('dist/out.js');
  });

  it('flags a change outside every declared scope as an escape', () => {
    const root = makeRoot();
    const manifest = bounded(root);
    const result = verifyAoiCommandTouchedScopeBoundary({
      manifest,
      changedLabels: ['src/a.ts', 'secrets/.env'],
    });
    expect(result.ok).toBe(false);
    expect(result.outOfScope).toEqual(['secrets/.env']);
  });

  it('treats a file scope as an exact match, not a prefix', () => {
    const root = makeRoot();
    const manifest = bounded(root);
    // pkg/version.json is a FILE scope: pkg/version.json.bak is NOT covered.
    const result = verifyAoiCommandTouchedScopeBoundary({
      manifest,
      changedLabels: ['pkg/version.json.bak'],
    });
    expect(result.ok).toBe(false);
    expect(result.outOfScope).toEqual(['pkg/version.json.bak']);
  });

  it('normalizes backslash and ./ prefixes on changed labels', () => {
    const root = makeRoot();
    const manifest = bounded(root);
    const result = verifyAoiCommandTouchedScopeBoundary({
      manifest,
      // include a non-string entry -> normalized away, never counted
      changedLabels: ['.\\src\\a.ts', './src/new.ts', '', 42 as unknown as string],
    });
    expect(result.ok).toBe(true);
    expect(result.inScope).toEqual(['src/a.ts', 'src/new.ts']);
  });

  it('treats every change as an escape when the manifest never bounded', () => {
    const root = makeRoot();
    const manifest = buildAoiCommandTouchedScopeManifest({
      workspaceRoot: root,
      declaredScopes: ['../escape'],
      now: NOW,
    });
    expect(manifest.ok).toBe(false);
    const result = verifyAoiCommandTouchedScopeBoundary({
      manifest,
      changedLabels: ['src/a.ts'],
    });
    expect(result.ok).toBe(false);
    expect(result.outOfScope).toEqual(['src/a.ts']);
  });
});
