import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyWorkspaceRename,
  buildRenamePreview,
  findWorkspaceReferences,
  listWorkspaceExports,
  peekWorkspaceDefinition,
} from '../openVscodeSemantic';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-semantic-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('openVscodeSemantic', () => {
  it('lists exports, finds references, and peeks definitions', () => {
    const rootDir = makeTempWorkspace();
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'src', 'chat.tsx'),
      [
        'export function ChatPanel() {',
        '  return "hello";',
        '}',
        '',
        'export const helper = () => ChatPanel();',
      ].join('\n'),
      'utf-8',
    );

    const exportsResult = listWorkspaceExports({ rootDir });
    const referencesResult = findWorkspaceReferences({ rootDir, symbol: 'ChatPanel' });
    const peekResult = peekWorkspaceDefinition({ rootDir, symbol: 'ChatPanel' });

    expect(exportsResult.exports.some((item) => item.name === 'ChatPanel')).toBe(true);
    expect(referencesResult.references.length).toBeGreaterThanOrEqual(2);
    expect(peekResult.definition?.path).toBe('src/chat.tsx');
    expect(peekResult.definition?.context[0]).toContain('export function ChatPanel');
  });

  it('builds a rename preview grouped by file', () => {
    const rootDir = makeTempWorkspace();
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'src', 'a.ts'),
      ['export const oldName = 1;', 'console.log(oldName);'].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'src', 'b.ts'),
      ['import { oldName } from "./a";', 'const copy = oldName;'].join('\n'),
      'utf-8',
    );

    const result = buildRenamePreview({
      rootDir,
      symbol: 'oldName',
      newName: 'newName',
    });

    expect(result.total_references).toBeGreaterThanOrEqual(4);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].previews[0].preview).toContain('newName');
  });

  it('applies a semantic rename when the preview signature matches', () => {
    const rootDir = makeTempWorkspace();
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'src', 'a.ts'),
      ['export const oldName = 1;', 'console.log(oldName);'].join('\n'),
      'utf-8',
    );

    const preview = buildRenamePreview({
      rootDir,
      symbol: 'oldName',
      newName: 'newName',
    });

    const result = applyWorkspaceRename({
      rootDir,
      symbol: 'oldName',
      newName: 'newName',
      expectedSignature: preview.signature,
    });

    expect(result.changed_files).toHaveLength(1);
    expect(fs.readFileSync(path.join(rootDir, 'src', 'a.ts'), 'utf-8')).toContain('newName');
  });
});
