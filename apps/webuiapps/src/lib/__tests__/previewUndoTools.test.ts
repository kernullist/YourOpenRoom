import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  getFile: vi.fn(),
  putTextFilesByJSON: vi.fn(),
  deleteFilesByPaths: vi.fn(),
}));

vi.mock('../toolMutationHistory', () => ({
  listRecentMutations: vi.fn(() => []),
  popLastMutation: vi.fn(),
  recordFileMutation: vi.fn(),
}));

import * as diskStorage from '../diskStorage';
import * as mutationHistory from '../toolMutationHistory';
import { executePreviewTool } from '../previewTools';
import { executeUndoTool } from '../undoTools';

const mockedGetFile = vi.mocked(diskStorage.getFile);
const mockedPutTextFilesByJSON = vi.mocked(diskStorage.putTextFilesByJSON);
const mockedDeleteFilesByPaths = vi.mocked(diskStorage.deleteFilesByPaths);
const mockedPopLastMutation = vi.mocked(mutationHistory.popLastMutation);

describe('preview / undo tools', () => {
  beforeEach(() => {
    mockedGetFile.mockReset();
    mockedPutTextFilesByJSON.mockReset();
    mockedDeleteFilesByPaths.mockReset();
    mockedPopLastMutation.mockReset();
  });

  it('previews a patch with diff-like lines', async () => {
    mockedGetFile.mockResolvedValue('alpha\nbeta\ngamma');

    const result = await executePreviewTool({
      operation: 'patch',
      file_path: 'apps/notes/data/a.txt',
      old_text: 'beta',
      new_text: 'delta',
    });
    const parsed = JSON.parse(result) as { would_change: boolean; preview_lines: string[] };

    expect(parsed.would_change).toBe(true);
    expect(parsed.preview_lines).toContain('- beta');
    expect(parsed.preview_lines).toContain('+ delta');
  });

  it('undoes the last file mutation by restoring the previous content', async () => {
    mockedPopLastMutation.mockReturnValue({
      id: 'm1',
      kind: 'file',
      tool_name: 'file_write',
      file_path: 'apps/notes/data/a.txt',
      before_content: 'before',
      after_content: 'after',
      created_at: Date.now(),
    });

    const result = await executeUndoTool();
    expect(JSON.parse(result).restored_to_previous_state).toBe(true);
    expect(mockedPutTextFilesByJSON).toHaveBeenCalledWith({
      files: [{ path: 'apps/notes/data', name: 'a.txt', content: 'before' }],
    });
  });
});
