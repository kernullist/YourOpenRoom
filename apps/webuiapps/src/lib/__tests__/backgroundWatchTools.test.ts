import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  listFiles: vi.fn(),
}));

vi.mock('../sessionPath', () => ({
  getSessionPath: () => 'char/mod',
}));

import * as diskStorage from '../diskStorage';
import {
  clearBackgroundWatchesForTests,
  createBackgroundWatch,
  executeBackgroundWatchTool,
  listBackgroundWatches,
  removeBackgroundWatch,
} from '../backgroundWatchTools';

const mockedListFiles = vi.mocked(diskStorage.listFiles);

describe('backgroundWatchTools', () => {
  beforeEach(() => {
    mockedListFiles.mockReset();
    mockedListFiles.mockResolvedValue({ files: [], not_exists: false });
    clearBackgroundWatchesForTests();
  });

  it('creates and removes app-storage watches', async () => {
    const watch = await createBackgroundWatch({
      scope: 'app_storage',
      directory: 'apps/notes/data',
      label: 'Notes',
    });

    expect(listBackgroundWatches()).toHaveLength(1);
    expect(watch.scope).toBe('app_storage');
    expect(removeBackgroundWatch(watch.id)).toBe(true);
    expect(listBackgroundWatches()).toHaveLength(0);
  });

  it('lists watches through the tool interface', async () => {
    await createBackgroundWatch({
      scope: 'app_storage',
      directory: 'apps/notes/data',
    });

    const result = await executeBackgroundWatchTool({ mode: 'list' });
    expect(JSON.parse(result).watches).toHaveLength(1);
  });
});
