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
});
