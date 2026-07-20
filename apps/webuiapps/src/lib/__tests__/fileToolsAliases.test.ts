import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  getFile: vi.fn(),
  putTextFilesByJSON: vi.fn(),
  listFiles: vi.fn(),
  deleteFilesByPaths: vi.fn(),
}));

import * as diskStorage from '../diskStorage';
import { executeFileTool, normalizeFileToolParams } from '../fileTools';

const mockedGetFile = vi.mocked(diskStorage.getFile);
const mockedListFiles = vi.mocked(diskStorage.listFiles);

describe('normalizeFileToolParams', () => {
  it('maps path/dir aliases onto directory for file_list', () => {
    expect(normalizeFileToolParams('file_list', { path: 'apps/youtube/data' })).toEqual({
      path: 'apps/youtube/data',
      directory: 'apps/youtube/data',
    });

    expect(normalizeFileToolParams('file_list', { dir: 'apps/youtube' }).directory).toBe(
      'apps/youtube',
    );
  });

  it('maps path/file aliases onto file_path for file_read', () => {
    expect(normalizeFileToolParams('file_read', { path: 'apps/youtube/guide.md' }).file_path).toBe(
      'apps/youtube/guide.md',
    );
  });
});

describe('executeFileTool aliases', () => {
  beforeEach(() => {
    mockedGetFile.mockReset();
    mockedListFiles.mockReset();
  });

  it('accepts file_list({ path }) instead of directory', async () => {
    mockedListFiles.mockResolvedValue({
      files: [
        { path: 'apps/youtube/data/state.json', type: 0 },
        { path: 'apps/youtube/data/playlists', type: 1 },
      ],
    } as never);

    const result = await executeFileTool('file_list', {
      path: 'apps/youtube/data',
    });

    expect(mockedListFiles).toHaveBeenCalledWith('apps/youtube/data');
    expect(result).toContain('[file] state.json');
    expect(result).toContain('[dir]  playlists');
  });

  it('returns actionable empty-directory guidance', async () => {
    mockedListFiles.mockResolvedValue({ files: [] } as never);

    const result = await executeFileTool('file_list', {
      path: 'apps/youtube/data/youtube',
    });

    expect(result).toContain('empty session app-storage directory: apps/youtube/data/youtube');
    expect(result).toContain('parameter "directory"');
    expect(result).toContain('apps/youtube/data');
  });

  it('accepts file_read({ path }) and suggests parent list on miss', async () => {
    mockedGetFile.mockResolvedValue(null);

    const result = await executeFileTool('file_read', {
      path: 'apps/youtube/guide.md',
    });

    expect(result).toContain('session app-storage file not found: apps/youtube/guide.md');
    expect(result).toContain('file_list(directory="apps/youtube")');
  });

  it('prefers directory over path when both are provided', () => {
    expect(
      normalizeFileToolParams('file_list', {
        directory: 'apps/youtube',
        path: 'apps/wrong',
      }).directory,
    ).toBe('apps/youtube');
  });

  it('maps text alias onto content for file_write', () => {
    expect(
      normalizeFileToolParams('file_write', {
        path: 'apps/notes/data/a.txt',
        text: 'hello',
      }),
    ).toMatchObject({
      file_path: 'apps/notes/data/a.txt',
      content: 'hello',
    });
  });
});
