import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  getFile: vi.fn(),
  putTextFilesByJSON: vi.fn(),
  listFiles: vi.fn(),
  deleteFilesByPaths: vi.fn(),
}));

import * as diskStorage from '../diskStorage';
import { executeFileTool } from '../fileTools';

const mockedGetFile = vi.mocked(diskStorage.getFile);
const mockedPutTextFilesByJSON = vi.mocked(diskStorage.putTextFilesByJSON);

describe('executeFileTool(file_patch)', () => {
  beforeEach(() => {
    mockedGetFile.mockReset();
    mockedPutTextFilesByJSON.mockReset();
  });

  it('patches a single exact match and writes the updated file', async () => {
    mockedGetFile.mockResolvedValue('alpha\nbeta\ngamma');

    const result = await executeFileTool('file_patch', {
      file_path: 'apps/notes/data/state.txt',
      old_text: 'beta',
      new_text: 'delta',
    });

    expect(result).toBe('success: patched apps/notes/data/state.txt; replacements=1');
    expect(mockedPutTextFilesByJSON).toHaveBeenCalledWith({
      files: [
        {
          path: 'apps/notes/data',
          name: 'state.txt',
          content: 'alpha\ndelta\ngamma',
        },
      ],
    });
  });

  it('requires disambiguation when multiple matches exist', async () => {
    mockedGetFile.mockResolvedValue('repeat\nrepeat\nrepeat');

    const result = await executeFileTool('file_patch', {
      file_path: 'apps/notes/data/repeats.txt',
      old_text: 'repeat',
      new_text: 'done',
    });

    expect(result).toBe(
      'error: old_text matched 3 times. Use expected_occurrences or replace_all to disambiguate.',
    );
    expect(mockedPutTextFilesByJSON).not.toHaveBeenCalled();
  });

  it('rejects JSON patches that produce invalid JSON', async () => {
    mockedGetFile.mockResolvedValue({ title: 'hello', done: false });

    const result = await executeFileTool('file_patch', {
      file_path: 'apps/notes/data/item.json',
      old_text: '"hello"',
      new_text: '"broken',
    });

    expect(result).toContain('error: patched JSON became invalid');
    expect(mockedPutTextFilesByJSON).not.toHaveBeenCalled();
  });
});
