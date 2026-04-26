import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  listFiles: vi.fn(),
  getFile: vi.fn(),
}));

vi.mock('../sessionPath', () => ({
  getSessionPath: () => 'char-1/mod-2',
}));

import * as diskStorage from '../diskStorage';
import { executeWorkspaceTool } from '../workspaceTools';

const mockedListFiles = vi.mocked(diskStorage.listFiles);
const mockedGetFile = vi.mocked(diskStorage.getFile);

describe('executeWorkspaceTool()', () => {
  beforeEach(() => {
    mockedListFiles.mockReset();
    mockedGetFile.mockReset();
  });

  it('finds recursive path matches and strips the session prefix', async () => {
    mockedListFiles.mockImplementation(async (dirPath: string) => {
      switch (dirPath) {
        case 'apps':
          return {
            files: [
              { path: 'char-1/mod-2/apps/notes', type: 1 },
              { path: 'char-1/mod-2/apps/calendar', type: 1 },
            ],
            not_exists: false,
          };
        case 'apps/notes':
          return {
            files: [{ path: 'char-1/mod-2/apps/notes/data', type: 1 }],
            not_exists: false,
          };
        case 'apps/notes/data':
          return {
            files: [{ path: 'char-1/mod-2/apps/notes/data/meeting-note.json', type: 0, size: 120 }],
            not_exists: false,
          };
        case 'apps/calendar':
          return {
            files: [{ path: 'char-1/mod-2/apps/calendar/data', type: 1 }],
            not_exists: false,
          };
        case 'apps/calendar/data':
          return {
            files: [{ path: 'char-1/mod-2/apps/calendar/data/state.json', type: 0, size: 40 }],
            not_exists: false,
          };
        default:
          return { files: [], not_exists: false };
      }
    });

    const result = await executeWorkspaceTool({
      query: 'meeting',
      mode: 'path',
    });
    const parsed = JSON.parse(result) as {
      directory: string;
      total_matches: number;
      matches: Array<{ path: string; match_type: string }>;
    };

    expect(parsed.directory).toBe('apps');
    expect(parsed.total_matches).toBe(1);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]).toMatchObject({
      path: 'apps/notes/data/meeting-note.json',
      type: 'file',
      match_type: 'path',
    });
    expect(mockedGetFile).not.toHaveBeenCalled();
  });

  it('searches file content, returns snippets, and skips binary files', async () => {
    mockedListFiles.mockImplementation(async (dirPath: string) => {
      switch (dirPath) {
        case 'apps':
          return {
            files: [{ path: 'char-1/mod-2/apps/notes', type: 1 }],
            not_exists: false,
          };
        case 'apps/notes':
          return {
            files: [{ path: 'char-1/mod-2/apps/notes/data', type: 1 }],
            not_exists: false,
          };
        case 'apps/notes/data':
          return {
            files: [
              { path: 'char-1/mod-2/apps/notes/data/retro-plan.md', type: 0, size: 120 },
              { path: 'char-1/mod-2/apps/notes/data/todo.json', type: 0, size: 120 },
              { path: 'char-1/mod-2/apps/notes/data/screenshot.png', type: 0, size: 64 },
            ],
            not_exists: false,
          };
        default:
          return { files: [], not_exists: false };
      }
    });

    mockedGetFile.mockImplementation(async (path: string) => {
      if (path === 'apps/notes/data/retro-plan.md') {
        return ['Sprint retro', 'retro follow-ups', 'owners and dates'].join('\n');
      }
      if (path === 'apps/notes/data/todo.json') {
        return { title: 'Planning', body: 'Nothing to match here' };
      }
      return null;
    });

    const result = await executeWorkspaceTool({
      query: 'retro',
      mode: 'content',
      max_results: 5,
    });
    const parsed = JSON.parse(result) as {
      total_matches: number;
      matches: Array<{
        path: string;
        match_type: string;
        snippets: Array<{ line: number; text: string }>;
      }>;
    };

    expect(parsed.total_matches).toBe(1);
    expect(parsed.matches[0].path).toBe('apps/notes/data/retro-plan.md');
    expect(parsed.matches[0].match_type).toBe('content');
    expect(parsed.matches[0].snippets[0]).toEqual({
      line: 1,
      text: 'Sprint retro',
    });
    expect(mockedGetFile).toHaveBeenCalledTimes(2);
    expect(mockedGetFile).not.toHaveBeenCalledWith('apps/notes/data/screenshot.png');
  });

  it('returns an error when query is missing', async () => {
    await expect(executeWorkspaceTool({ mode: 'auto' })).resolves.toBe('error: missing query');
  });
});
