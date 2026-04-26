import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { searchOpenVscodeWorkspace } from '../openVscodeSearch';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-ide-search-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('searchOpenVscodeWorkspace()', () => {
  it('finds path and content matches while ignoring blocked folders', () => {
    const rootDir = makeTempWorkspace();
    fs.mkdirSync(path.join(rootDir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'src', 'components', 'ChatPanel.tsx'),
      'export function ChatPanel() { return <div>Tool batching</div>; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'src', 'components', 'Other.tsx'),
      'const value = "tool batching";\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(rootDir, 'node_modules', 'ignored', 'skip.ts'), 'ChatPanel', 'utf-8');

    const result = searchOpenVscodeWorkspace({
      rootDir,
      query: 'ChatPanel',
      ignoredDirs: new Set(['node_modules']),
    });

    expect(result.total_matches).toBe(1);
    expect(result.matches[0]).toMatchObject({
      path: 'src/components/ChatPanel.tsx',
      match_type: 'path+content',
    });
  });
});
