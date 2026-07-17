// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hashAoiWorkspaceCodeFiles } from '../aoiWorkspaceCodeFingerprint';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-code-fingerprint-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, value: string): void {
  const filePath = join(root, relativePath);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi workspace code fingerprint', () => {
  it('is deterministic and changes when claim-relevant code changes', () => {
    const root = makeTempRoot();
    const sourcePath = 'apps/webuiapps/src/lib/example.ts';
    writeFile(root, sourcePath, 'export const value = 1;\n');
    writeFile(root, 'README.md', 'unrelated\n');
    const first = hashAoiWorkspaceCodeFiles(root, [sourcePath, 'README.md']);
    const second = hashAoiWorkspaceCodeFiles(root, [sourcePath, 'README.md']);
    writeFile(root, sourcePath, 'export const value = 2;\n');
    const changed = hashAoiWorkspaceCodeFiles(root, [sourcePath, 'README.md']);

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('ignores non-claim files and rejects an empty relevant file set', () => {
    const root = makeTempRoot();
    writeFile(root, 'README.md', 'docs only\n');
    expect(() => hashAoiWorkspaceCodeFiles(root, ['README.md'])).toThrow(
      'No bounded claim-relevant code file set',
    );
  });
});
