import { describe, expect, it } from 'vitest';

import { tokenizeCommand, validateWorkspaceCommand } from '../workspaceCommandPolicy';

describe('tokenizeCommand()', () => {
  it('preserves quoted segments', () => {
    expect(tokenizeCommand('pnpm test -- "src/lib/my test.ts"')).toEqual([
      'pnpm',
      'test',
      '--',
      'src/lib/my test.ts',
    ]);
  });
});

describe('validateWorkspaceCommand()', () => {
  it('accepts safe git commands', () => {
    const result = validateWorkspaceCommand('git status --short');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.program).toBe('git');
      expect(result.spec.args).toEqual(['status', '--short']);
    }
  });

  it('accepts safe package-manager verification commands', () => {
    expect(validateWorkspaceCommand('pnpm test -- src/lib/foo.test.ts').ok).toBe(true);
    expect(validateWorkspaceCommand('pnpm exec vitest run src/lib/foo.test.ts').ok).toBe(true);
    expect(validateWorkspaceCommand('pnpm exec tsc --noEmit').ok).toBe(true);
  });

  it('rejects shell metacharacters and mutating commands', () => {
    expect(validateWorkspaceCommand('git status && git diff')).toEqual({
      ok: false,
      error: 'Shell metacharacters are not allowed in safe mode.',
    });
    expect(validateWorkspaceCommand('pnpm install')).toEqual({
      ok: false,
      error: 'Unsafe pnpm arguments were rejected.',
    });
  });

  it('rejects unsafe git and node commands', () => {
    expect(validateWorkspaceCommand('git commit -m test')).toEqual({
      ok: false,
      error:
        'git commands are limited to status, diff, show, log, branch, and rev-parse in safe mode.',
    });
    expect(validateWorkspaceCommand('node scripts/build.js')).toEqual({
      ok: false,
      error: 'node commands are limited to version checks in safe mode.',
    });
  });

  it('rejects flags that write or read outside the workspace', () => {
    // These ran with no approval: allowWorkspaceCommands defaults to true.
    for (const command of [
      'git diff --output=C:/Users/u/.gitconfig',
      'git log --OUTPUT ../../x',
      'git show HEAD --output=x',
      'git diff --no-index C:/Windows/win.ini README.md',
      'pnpm exec vite build --outDir C:/Users/u/Documents --emptyOutDir',
      'pnpm exec vite build --emptyOutDir=true',
      'pnpm exec eslint . -o ../report.txt',
      'pnpm exec eslint . --output-file=../report.txt',
      'pnpm exec vitest run --outputFile=../x.json',
    ]) {
      expect(validateWorkspaceCommand(command).ok, command).toBe(false);
    }
  });

  it('allows git branch only for listing', () => {
    expect(validateWorkspaceCommand('git branch').ok).toBe(true);
    expect(validateWorkspaceCommand('git branch -a -v').ok).toBe(true);
    expect(validateWorkspaceCommand('git branch --show-current').ok).toBe(true);
    for (const command of [
      'git branch -D main',
      'git branch -m old new',
      'git branch -f main HEAD~1',
      'git branch new-feature',
    ]) {
      expect(validateWorkspaceCommand(command).ok, command).toBe(false);
    }
  });
});
