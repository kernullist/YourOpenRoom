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
    vi.unstubAllGlobals();
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

  it('captures a single IDE file root with content', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/api/openvscode/list') {
        return {
          ok: false,
          json: async () => ({ error: 'Directory not found' }),
        } as Response;
      }
      if (parsedUrl.pathname === '/api/openvscode/file') {
        return {
          ok: true,
          json: async () => ({ content: 'export const answer = 42;\n' }),
        } as Response;
      }
      return {
        ok: false,
        json: async () => ({ error: 'unexpected endpoint' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeCheckpointTool({
      mode: 'create',
      scope: 'ide',
      roots: ['src/file.ts'],
      name: 'File snapshot',
    });
    const parsed = JSON.parse(result) as { fileCount: number };
    const saved = mockedPutTextFilesByJSON.mock.calls[0][0] as {
      files: Array<{ content: string }>;
    };
    const checkpoint = JSON.parse(saved.files[0].content) as {
      files: Array<{ path: string; content: string | null }>;
    };

    expect(parsed.fileCount).toBe(1);
    expect(checkpoint.files[0]).toEqual({
      scope: 'ide',
      path: 'src/file.ts',
      content: 'export const answer = 42;\n',
    });
  });

  it('creates an autofix checkpoint and returns diagnostics together', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const parsedUrl = new URL(url);
        if (parsedUrl.pathname === '/api/openvscode/list') {
          return {
            ok: false,
            json: async () => ({ error: 'Directory not found' }),
          } as Response;
        }
        if (parsedUrl.pathname === '/api/openvscode/file') {
          return {
            ok: true,
            json: async () => ({ content: 'checkpoint fixture\n' }),
          } as Response;
        }
        return {
          ok: false,
          json: async () => ({ error: 'unexpected endpoint' }),
        } as Response;
      }),
    );
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
  }, 15_000);
});
