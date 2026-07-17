import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  getFile: vi.fn(),
}));

import * as diskStorage from '../diskStorage';
import { executeIdeTool, getIdeToolDefinitions, isIdeMutationTool, isIdeTool } from '../ideTools';

const mockedGetFile = vi.mocked(diskStorage.getFile);

describe('executeIdeTool()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedGetFile.mockReset();
  });

  it('returns an error when query is missing', async () => {
    await expect(executeIdeTool({})).resolves.toBe('error: missing query');
  });

  it('exposes read and mutation IDE tools', () => {
    const names = getIdeToolDefinitions().map((tool) => tool.function.name);
    expect(names).toContain('ide_search');
    expect(names).toContain('ide_current_file');
    expect(names).toContain('ide_read_file');
    expect(names).toContain('ide_patch_file');
    expect(names).toContain('ide_write_file');
    expect(isIdeTool('ide_current_file')).toBe(true);
    expect(isIdeMutationTool('ide_patch_file')).toBe(true);
    expect(isIdeMutationTool('ide_current_file')).toBe(false);
  });

  it('requests the IDE search endpoint and returns the JSON payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          query: 'ChatPanel',
          total_matches: 1,
          matches: [{ path: 'src/components/ChatPanel/index.tsx', match_type: 'path' }],
        }),
    } as unknown as Response);

    const result = await executeIdeTool({
      query: 'ChatPanel',
      directory: 'apps/webuiapps/src',
      mode: 'path',
      max_results: 3,
    });

    const parsed = JSON.parse(result) as { query: string; total_matches: number };
    expect(parsed.query).toBe('ChatPanel');
    expect(parsed.total_matches).toBe(1);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain('/api/openvscode/search?');
  });

  it('reads the current active editor buffer from OpenVSCode state', async () => {
    mockedGetFile.mockResolvedValue({
      workspaceRoot: 'F:/kernullist/YourOpenRoom',
      workspaceExists: true,
      activePath: 'README.md',
      activeFile: {
        path: 'README.md',
        name: 'README.md',
        language: 'markdown',
        dirty: true,
        content: '# Draft\nUnsaved text',
        contentTruncated: false,
        lineCount: 2,
        charCount: 20,
        selection: {
          startLine: 2,
          startColumn: 1,
          endLine: 2,
          endColumn: 13,
          lineCount: 1,
          charCount: 12,
          textTruncated: false,
          text: 'Unsaved text',
        },
      },
      openTabs: [{ path: 'README.md', dirty: true }],
    });

    const result = await executeIdeTool('ide_current_file', {});
    const parsed = JSON.parse(result) as {
      active_path: string;
      active_file: {
        content: string;
        dirty: boolean;
        source: string;
        selection: { text: string; char_count: number };
      };
    };

    expect(parsed.active_path).toBe('README.md');
    expect(parsed.active_file.content).toBe('# Draft\nUnsaved text');
    expect(parsed.active_file.dirty).toBe(true);
    expect(parsed.active_file.source).toBe('editor_state');
    expect(parsed.active_file.selection).toEqual({
      start_line: 2,
      start_column: 1,
      end_line: 2,
      end_column: 13,
      line_count: 1,
      char_count: 12,
      text_truncated: false,
      text: 'Unsaved text',
    });
  });

  it('can omit selected text while preserving the active selection range', async () => {
    mockedGetFile.mockResolvedValue({
      activePath: 'README.md',
      activeFile: {
        path: 'README.md',
        name: 'README.md',
        language: 'markdown',
        dirty: false,
        content: '# Title\nSelected paragraph',
        contentTruncated: false,
        selection: {
          startLine: 2,
          startColumn: 1,
          endLine: 2,
          endColumn: 19,
          lineCount: 1,
          charCount: 18,
          textTruncated: false,
          text: 'Selected paragraph',
        },
      },
    });

    const result = await executeIdeTool('ide_current_file', { include_selection: false });
    const parsed = JSON.parse(result) as {
      active_file: { selection: { text?: string; char_count: number } };
    };

    expect(parsed.active_file.selection.char_count).toBe(18);
    expect(parsed.active_file.selection.text).toBeUndefined();
  });

  it('returns truncated active editor snapshots instead of failing review reads', async () => {
    mockedGetFile.mockResolvedValue({
      activePath: 'large.txt',
      activeFile: {
        path: 'large.txt',
        name: 'large.txt',
        language: 'plaintext',
        dirty: true,
        content: 'x'.repeat(1500),
        contentTruncated: true,
        lineCount: 10_000,
        charCount: 120_000,
      },
      openTabs: [{ path: 'large.txt', dirty: true }],
    });

    const result = await executeIdeTool('ide_current_file', { max_chars: 1000 });
    const parsed = JSON.parse(result) as {
      active_file: { content: string; content_truncated: boolean; char_count: number };
    };

    expect(parsed.active_file.content).toHaveLength(1000);
    expect(parsed.active_file.content_truncated).toBe(true);
    expect(parsed.active_file.char_count).toBe(120_000);
  });

  it('reads a workspace file from the IDE file endpoint', async () => {
    mockedGetFile.mockResolvedValue(null);
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          path: 'src/index.ts',
          content: 'const answer = 42;\n',
          size: 19,
          modifiedAt: 1234,
          sha256: 'a'.repeat(64),
        }),
    } as unknown as Response);

    const result = await executeIdeTool('ide_read_file', { path: 'src/index.ts' });
    const parsed = JSON.parse(result) as {
      path: string;
      content: string;
      source: string;
      byte_count: number;
      modified_at: number;
      sha256: string;
      hash_scope: string;
    };

    expect(parsed.path).toBe('src/index.ts');
    expect(parsed.content).toBe('const answer = 42;\n');
    expect(parsed.source).toBe('disk');
    expect(parsed.byte_count).toBe(19);
    expect(parsed.modified_at).toBe(1234);
    expect(parsed.sha256).toBe('a'.repeat(64));
    expect(parsed.hash_scope).toBe('full_disk_file_bytes');
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain('/api/openvscode/file?');
  });

  it('patches a workspace file through exact text replacement', async () => {
    mockedGetFile.mockResolvedValue(null);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            path: 'src/index.ts',
            content: 'const answer = 41;\n',
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ ok: true }),
      } as unknown as Response);

    const result = await executeIdeTool('ide_patch_file', {
      path: 'src/index.ts',
      old_text: '41',
      new_text: '42',
      expected_occurrences: 1,
    });
    const parsed = JSON.parse(result) as { ok: boolean; replaced: number };
    const postCall = vi.mocked(globalThis.fetch).mock.calls[1];

    expect(parsed.ok).toBe(true);
    expect(parsed.replaced).toBe(1);
    expect(postCall[0]).toBe('/api/openvscode/file');
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toEqual({
      path: 'src/index.ts',
      content: 'const answer = 42;\n',
      overwrite: true,
    });
  });

  it('rejects disk patching the active editor file so the UI buffer stays authoritative', async () => {
    mockedGetFile.mockResolvedValue({
      activePath: 'src/index.ts',
      activeFile: {
        path: 'src/index.ts',
        content: 'const answer = 41;\n',
        contentTruncated: false,
      },
    });
    globalThis.fetch = vi.fn();

    const result = await executeIdeTool('ide_patch_file', {
      path: 'src/index.ts',
      old_text: '41',
      new_text: '42',
    });

    expect(result).toContain('PATCH_ACTIVE_FILE');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('requires an explicit non-active path for disk write mutations', async () => {
    mockedGetFile.mockResolvedValue(null);

    await expect(executeIdeTool('ide_write_file', { content: 'next' })).resolves.toContain(
      'path is required',
    );
  });
});
