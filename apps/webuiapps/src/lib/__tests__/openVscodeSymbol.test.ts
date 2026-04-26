import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { searchWorkspaceSymbol } from '../openVscodeSymbol';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-symbol-search-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('searchWorkspaceSymbol()', () => {
  it('finds likely symbol declarations in workspace files', () => {
    const rootDir = makeTempWorkspace();
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'src', 'chat.ts'),
      [
        'export function ChatPanel() {',
        '  return "hello";',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const result = searchWorkspaceSymbol({
      rootDir,
      symbol: 'ChatPanel',
    });

    expect(result.total_matches).toBe(1);
    expect(result.matches[0]).toMatchObject({
      path: 'src/chat.ts',
      line: 1,
      kind: 'export_function',
    });
  });
});
