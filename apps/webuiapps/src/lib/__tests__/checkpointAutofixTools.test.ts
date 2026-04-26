import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  listFiles: vi.fn(),
  getFile: vi.fn(),
  putTextFilesByJSON: vi.fn(),
  deleteFilesByPaths: vi.fn(),
}));

vi.mock('../diagnosticsTools', () => ({
  executeDiagnosticsTool: vi.fn(),
}));

import * as diskStorage from '../diskStorage';
import { executeDiagnosticsTool } from '../diagnosticsTools';
import { executeAutofixMacroTool } from '../autofixMacroTools';
import { executeCheckpointTool } from '../checkpointTools';

const mockedListFiles = vi.mocked(diskStorage.listFiles);
const mockedGetFile = vi.mocked(diskStorage.getFile);
const mockedPutTextFilesByJSON = vi.mocked(diskStorage.putTextFilesByJSON);
const mockedExecuteDiagnosticsTool = vi.mocked(executeDiagnosticsTool);

describe('checkpoint/autofix tools', () => {
  beforeEach(() => {
    mockedListFiles.mockReset();
    mockedGetFile.mockReset();
    mockedPutTextFilesByJSON.mockReset();
    mockedExecuteDiagnosticsTool.mockReset();
    mockedListFiles.mockResolvedValue({ files: [], not_exists: false });
    mockedGetFile.mockResolvedValue(null);
  });

  it('creates a simple app-storage checkpoint', async () => {
    const result = await executeCheckpointTool({
      mode: 'create',
      scope: 'app_storage',
      roots: ['apps/notes/data/notes'],
      name: 'Notes snapshot',
    });
    const parsed = JSON.parse(result) as { id: string; scope: string; roots: string[] };

    expect(parsed.id).toContain('checkpoint_');
    expect(parsed.scope).toBe('app_storage');
    expect(parsed.roots).toEqual(['apps/notes/data/notes']);
    expect(mockedPutTextFilesByJSON).toHaveBeenCalled();
  });

  it('creates an autofix checkpoint and returns diagnostics together', async () => {
    mockedExecuteDiagnosticsTool.mockResolvedValue(
      JSON.stringify({
        command: 'pnpm exec tsc --noEmit',
        diagnostic_count: 1,
        diagnostics: [{ message: 'type error' }],
      }),
    );

    const result = await executeAutofixMacroTool({
      command: 'pnpm exec tsc --noEmit',
      directory: 'apps/webuiapps/src',
    });
    const parsed = JSON.parse(result) as {
      checkpoint_id: string;
      diagnostics: { diagnostic_count: number };
    };

    expect(parsed.checkpoint_id).toContain('checkpoint_');
    expect(parsed.diagnostics.diagnostic_count).toBe(1);
  });
});
