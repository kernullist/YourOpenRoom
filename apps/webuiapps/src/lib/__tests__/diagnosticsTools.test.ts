import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../commandTools', () => ({
  executeCommandTool: vi.fn(),
}));

import { executeCommandTool } from '../commandTools';
import { executeDiagnosticsTool } from '../diagnosticsTools';

const mockedExecuteCommandTool = vi.mocked(executeCommandTool);

describe('executeDiagnosticsTool()', () => {
  beforeEach(() => {
    mockedExecuteCommandTool.mockReset();
  });

  it('passes through command errors', async () => {
    mockedExecuteCommandTool.mockResolvedValue('error: unsafe command');
    await expect(executeDiagnosticsTool({ command: 'pnpm install' })).resolves.toBe(
      'error: unsafe command',
    );
  });

  it('parses TypeScript diagnostics into structured entries', async () => {
    mockedExecuteCommandTool.mockResolvedValue(
      JSON.stringify({
        command: 'pnpm exec tsc --noEmit',
        cwd: '.',
        exitCode: 2,
        stdout: '',
        stderr:
          'src/foo.ts(12,8): error TS2322: Type "number" is not assignable to type "string".',
      }),
    );

    const result = await executeDiagnosticsTool({ command: 'pnpm exec tsc --noEmit' });
    const parsed = JSON.parse(result) as {
      diagnostic_count: number;
      diagnostics: Array<{ file: string; line: number; code: string; severity: string }>;
    };

    expect(parsed.diagnostic_count).toBe(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      file: 'src/foo.ts',
      line: 12,
      code: 'TS2322',
      severity: 'error',
    });
  });
});
