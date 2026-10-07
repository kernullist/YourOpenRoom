import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real mutation history (localStorage-backed), fake storage writes.
vi.mock('../diskStorage', () => ({
  putTextFilesByJSON: vi.fn(async () => undefined),
  deleteFilesByPaths: vi.fn(async () => undefined),
}));

import * as diskStorage from '../diskStorage';
import {
  clearMutationHistory,
  listRecentMutations,
  recordFileMutation,
} from '../toolMutationHistory';
import { executeUndoTool } from '../undoTools';

describe('undo_last_action over the real history', () => {
  beforeEach(() => {
    clearMutationHistory();
    vi.mocked(diskStorage.putTextFilesByJSON).mockClear();
  });

  it('walks back two changes instead of redoing the first undo', async () => {
    recordFileMutation({
      tool_name: 'file_write',
      file_path: 'apps/notes/data/a.txt',
      before_content: 'a0',
      after_content: 'a1',
    });
    recordFileMutation({
      tool_name: 'file_write',
      file_path: 'apps/notes/data/b.txt',
      before_content: 'b0',
      after_content: 'b1',
    });

    const first = JSON.parse(await executeUndoTool());
    const second = JSON.parse(await executeUndoTool());

    // b restored first, then a -- not b, then b again.
    expect(first.file_path).toBe('apps/notes/data/b.txt');
    expect(second.file_path).toBe('apps/notes/data/a.txt');
    expect(vi.mocked(diskStorage.putTextFilesByJSON).mock.calls.map((call) => call[0])).toEqual([
      { files: [{ path: 'apps/notes/data', name: 'b.txt', content: 'b0' }] },
      { files: [{ path: 'apps/notes/data', name: 'a.txt', content: 'a0' }] },
    ]);
    expect(second.remaining_reversible_actions).toBe(0);
    expect(listRecentMutations()).toHaveLength(0);
    expect(await executeUndoTool()).toContain('error: no reversible mutation');
  });
});
