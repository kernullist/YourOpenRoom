import type { ToolDef } from './llmClient';

import * as idb from './diskStorage';

const SEARCH_TOOL_NAME = 'ide_search';
const CURRENT_FILE_TOOL_NAME = 'ide_current_file';
const READ_FILE_TOOL_NAME = 'ide_read_file';
const PATCH_FILE_TOOL_NAME = 'ide_patch_file';
const WRITE_FILE_TOOL_NAME = 'ide_write_file';
const OPENVSCODE_STATE_FILE = 'apps/openvscode/data/state.json';
const DEFAULT_MAX_CONTENT_CHARS = 80_000;
const DEFAULT_MAX_SELECTION_CHARS = 20_000;

const IDE_TOOL_NAMES = new Set([
  SEARCH_TOOL_NAME,
  CURRENT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  PATCH_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
]);

const IDE_MUTATION_TOOL_NAMES = new Set([PATCH_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME]);

interface OpenVscodeActiveFileState {
  path?: unknown;
  name?: unknown;
  language?: unknown;
  dirty?: unknown;
  cursor?: unknown;
  lineCount?: unknown;
  charCount?: unknown;
  content?: unknown;
  contentTruncated?: unknown;
  selection?: unknown;
}

interface OpenVscodeRuntimeState {
  workspaceRoot?: unknown;
  workspaceExists?: unknown;
  activePath?: unknown;
  activeFile?: OpenVscodeActiveFileState | null;
  openTabs?: unknown;
  ui?: unknown;
  updatedAt?: unknown;
}

interface IdeFileContent {
  path: string;
  content: string;
  source: 'editor_state' | 'disk';
  sourceContentTruncated?: boolean;
  lineCount?: number;
  charCount?: number;
  byteCount?: number;
  modifiedAt?: number;
  sha256?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return defaultValue;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampMaxChars(value: unknown): number {
  const parsed = asOptionalNumber(value);
  if (!parsed) return DEFAULT_MAX_CONTENT_CHARS;
  return Math.max(1000, Math.min(DEFAULT_MAX_CONTENT_CHARS, Math.floor(parsed)));
}

function clampMaxSelectionChars(value: unknown): number {
  const parsed = asOptionalNumber(value);
  if (!parsed) return DEFAULT_MAX_SELECTION_CHARS;
  return Math.max(500, Math.min(DEFAULT_MAX_SELECTION_CHARS, Math.floor(parsed)));
}

function normalizeEditorContent(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function countLines(content: string): number {
  return content === '' ? 1 : content.split(/\r?\n/).length;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function truncateContent(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  return { content: content.slice(0, maxChars), truncated: true };
}

function normalizeActiveSelection(
  value: unknown,
  options: { includeText: boolean; maxChars: number },
): Record<string, unknown> | null {
  const selection = asRecord(value);
  if (!selection) return null;

  const startLine = asOptionalNumber(selection.startLine);
  const startColumn = asOptionalNumber(selection.startColumn);
  const endLine = asOptionalNumber(selection.endLine);
  const endColumn = asOptionalNumber(selection.endColumn);
  const charCount = asOptionalNumber(selection.charCount);
  const lineCount = asOptionalNumber(selection.lineCount);
  if (!startLine || !startColumn || !endLine || !endColumn || charCount === null) {
    return null;
  }

  const selectedText =
    typeof selection.text === 'string' ? normalizeEditorContent(selection.text) : '';
  const truncatedText = truncateContent(selectedText, options.maxChars);

  return {
    start_line: startLine,
    start_column: startColumn,
    end_line: endLine,
    end_column: endColumn,
    line_count: lineCount ?? countLines(selectedText),
    char_count: charCount,
    text_truncated: selection.textTruncated === true || truncatedText.truncated,
    ...(options.includeText ? { text: truncatedText.content } : {}),
  };
}

function normalizePathInput(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

async function getOpenVscodeState(): Promise<OpenVscodeRuntimeState | null> {
  const state = await idb.getFile(OPENVSCODE_STATE_FILE);
  return asRecord(state) as OpenVscodeRuntimeState | null;
}

function getActivePathFromState(state: OpenVscodeRuntimeState | null): string {
  const activePath = typeof state?.activePath === 'string' ? state.activePath.trim() : '';
  if (activePath) return activePath;
  const activeFile = asRecord(state?.activeFile);
  return typeof activeFile?.path === 'string' ? activeFile.path.trim() : '';
}

function resolveTargetPath(
  params: Record<string, unknown>,
  state: OpenVscodeRuntimeState | null,
): string {
  return normalizePathInput(params.path) || getActivePathFromState(state);
}

function readActiveFileFromState(
  state: OpenVscodeRuntimeState | null,
  targetPath: string,
  options: { allowTruncated: boolean } = { allowTruncated: false },
): IdeFileContent | null {
  const activeFile = asRecord(state?.activeFile);
  if (!activeFile) return null;
  const activePath =
    typeof activeFile.path === 'string' ? activeFile.path : getActivePathFromState(state);
  if (!activePath || activePath !== targetPath) return null;
  if (typeof activeFile.content !== 'string') return null;
  if (activeFile.contentTruncated === true && !options.allowTruncated) return null;
  return {
    path: activePath,
    content: normalizeEditorContent(activeFile.content),
    source: 'editor_state',
    sourceContentTruncated: activeFile.contentTruncated === true,
    lineCount: asOptionalNumber(activeFile.lineCount) ?? undefined,
    charCount: asOptionalNumber(activeFile.charCount) ?? undefined,
  };
}

async function readIdeFileFromDisk(path: string): Promise<IdeFileContent | string> {
  const url = new URL('/api/openvscode/file', window.location.origin);
  url.searchParams.set('path', path);
  const res = await fetch(url.toString());
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `IDE file API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }

  const data = (await res.json()) as {
    path?: string;
    content?: string;
    size?: number;
    modifiedAt?: number;
    sha256?: string;
  };
  return {
    path: data.path || path,
    content: normalizeEditorContent(typeof data.content === 'string' ? data.content : ''),
    source: 'disk',
    byteCount: typeof data.size === 'number' ? data.size : undefined,
    modifiedAt: typeof data.modifiedAt === 'number' ? data.modifiedAt : undefined,
    sha256:
      typeof data.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(data.sha256)
        ? data.sha256.toLowerCase()
        : undefined,
  };
}

async function writeIdeFileToDisk(path: string, content: string): Promise<string | null> {
  const res = await fetch('/api/openvscode/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: normalizeEditorContent(content), overwrite: true }),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `IDE file API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }
  return null;
}

async function readIdeFile(
  params: Record<string, unknown>,
  options: { allowTruncatedActive?: boolean } = {},
): Promise<IdeFileContent | string> {
  const state = await getOpenVscodeState();
  const path = resolveTargetPath(params, state);
  if (!path) return 'error: missing path and no active IDE file';

  const activeFile = readActiveFileFromState(state, path, {
    allowTruncated: options.allowTruncatedActive === true,
  });
  if (activeFile) return activeFile;

  const activePath = getActivePathFromState(state);
  const activeState = asRecord(state?.activeFile);
  if (activePath === path && activeState?.dirty === true && activeState.contentTruncated === true) {
    return 'error: active file buffer is truncated; use the IDE active-file app action or save the file before disk edits';
  }

  return readIdeFileFromDisk(path);
}

async function resolveNonActiveMutationPath(params: Record<string, unknown>): Promise<string> {
  const path = normalizePathInput(params.path);
  if (!path) return '';

  const state = await getOpenVscodeState();
  const activePath = getActivePathFromState(state);
  if (activePath && activePath === path) return '';

  return path;
}

function applyLineRange(content: string, params: Record<string, unknown>) {
  const startLineRaw = asOptionalNumber(params.start_line);
  const endLineRaw = asOptionalNumber(params.end_line);
  if (!startLineRaw && !endLineRaw) {
    return {
      content,
      range: null,
    };
  }

  const lines = content.split(/\n/);
  const startLine = Math.max(1, Math.floor(startLineRaw ?? 1));
  const endLine = Math.max(startLine, Math.floor(endLineRaw ?? lines.length));
  return {
    content: lines.slice(startLine - 1, endLine).join('\n'),
    range: { start_line: startLine, end_line: Math.min(endLine, lines.length) },
  };
}

async function executeSearchTool(params: Record<string, unknown>): Promise<string> {
  const query = String(params.query || '').trim();
  if (!query) return 'error: missing query';

  const url = new URL('/api/openvscode/search', window.location.origin);
  url.searchParams.set('query', query);
  if (typeof params.directory === 'string' && params.directory.trim()) {
    url.searchParams.set('directory', params.directory.trim());
  }
  if (params.mode === 'path' || params.mode === 'content') {
    url.searchParams.set('mode', params.mode);
  }
  if (params.max_results !== undefined) {
    url.searchParams.set('max_results', String(params.max_results));
  }

  const res = await fetch(url.toString());
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `IDE search API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }

  return JSON.stringify(await res.json());
}

async function executeCurrentFileTool(params: Record<string, unknown>): Promise<string> {
  const includeContent = params.include_content !== false;
  const includeSelection = params.include_selection !== false;
  const maxChars = clampMaxChars(params.max_chars);
  const maxSelectionChars = clampMaxSelectionChars(params.max_selection_chars);
  const state = await getOpenVscodeState();
  const activePath = getActivePathFromState(state);
  if (!activePath) {
    return JSON.stringify({
      active_path: null,
      active_file: null,
      open_tabs: Array.isArray(state?.openTabs) ? state?.openTabs : [],
      workspace_root: state?.workspaceRoot ?? null,
      workspace_exists: state?.workspaceExists ?? null,
      ui: state?.ui ?? null,
      updated_at: state?.updatedAt ?? null,
    });
  }

  const file = await readIdeFile({ path: activePath }, { allowTruncatedActive: true });
  if (typeof file === 'string') return file;
  const truncated = truncateContent(file.content, maxChars);
  const activeFile = asRecord(state?.activeFile);
  const selection = normalizeActiveSelection(activeFile?.selection, {
    includeText: includeSelection,
    maxChars: maxSelectionChars,
  });
  const lineCount = file.lineCount ?? countLines(file.content);
  const charCount = file.charCount ?? file.content.length;

  return JSON.stringify({
    active_path: activePath,
    active_file: {
      path: activePath,
      name: activeFile?.name ?? activePath.split('/').pop() ?? activePath,
      language: activeFile?.language ?? null,
      dirty: activeFile?.dirty ?? null,
      cursor: activeFile?.cursor ?? null,
      line_count: lineCount,
      char_count: charCount,
      content_truncated:
        truncated.truncated ||
        activeFile?.contentTruncated === true ||
        file.sourceContentTruncated === true,
      source: file.source,
      ...(selection ? { selection } : {}),
      ...(includeContent ? { content: truncated.content } : {}),
    },
    open_tabs: Array.isArray(state?.openTabs) ? state?.openTabs : [],
    workspace_root: state?.workspaceRoot ?? null,
    workspace_exists: state?.workspaceExists ?? null,
    ui: state?.ui ?? null,
    updated_at: state?.updatedAt ?? null,
  });
}

async function executeReadFileTool(params: Record<string, unknown>): Promise<string> {
  const file = await readIdeFile(params, { allowTruncatedActive: true });
  if (typeof file === 'string') return file;
  const ranged = applyLineRange(file.content, params);
  const maxChars = clampMaxChars(params.max_chars);
  const truncated = truncateContent(ranged.content, maxChars);
  const lineCount = file.lineCount ?? countLines(file.content);
  const charCount = file.charCount ?? file.content.length;
  return JSON.stringify({
    path: file.path,
    source: file.source,
    line_count: lineCount,
    char_count: charCount,
    byte_count: file.byteCount ?? null,
    modified_at: file.modifiedAt ?? null,
    sha256: file.sha256 ?? null,
    hash_scope: file.sha256 ? 'full_disk_file_bytes' : null,
    range: ranged.range,
    content_truncated: truncated.truncated || file.sourceContentTruncated === true,
    content: truncated.content,
  });
}

async function executePatchFileTool(params: Record<string, unknown>): Promise<string> {
  const oldText = typeof params.old_text === 'string' ? params.old_text : '';
  const newText = typeof params.new_text === 'string' ? params.new_text : '';
  if (!oldText) return 'error: missing old_text';

  const path = await resolveNonActiveMutationPath(params);
  if (!path) {
    return 'error: path is required and must not be the active IDE editor file; use PATCH_ACTIVE_FILE app_action for active editor edits';
  }

  const file = await readIdeFileFromDisk(path);
  if (typeof file === 'string') return file;

  const occurrences = countOccurrences(file.content, oldText);
  if (occurrences === 0) return 'error: old_text not found';

  const expectedOccurrences = asOptionalNumber(params.expected_occurrences);
  if (expectedOccurrences !== null && occurrences !== Math.floor(expectedOccurrences)) {
    return `error: expected ${Math.floor(expectedOccurrences)} occurrence(s), found ${occurrences}`;
  }

  const replaceAll = asBoolean(params.replace_all, false);
  const nextContent = replaceAll
    ? file.content.split(oldText).join(newText)
    : file.content.replace(oldText, newText);
  const writeError = await writeIdeFileToDisk(file.path, nextContent);
  if (writeError) return writeError;

  return JSON.stringify({
    ok: true,
    path: file.path,
    source: file.source,
    occurrences,
    replaced: replaceAll ? occurrences : 1,
    line_count: countLines(nextContent),
    char_count: nextContent.length,
  });
}

async function executeWriteFileTool(params: Record<string, unknown>): Promise<string> {
  const path = await resolveNonActiveMutationPath(params);
  if (!path) {
    return 'error: path is required and must not be the active IDE editor file; use REPLACE_ACTIVE_FILE app_action for active editor edits';
  }
  if (typeof params.content !== 'string') return 'error: missing content';

  const content = normalizeEditorContent(params.content);
  const writeError = await writeIdeFileToDisk(path, content);
  if (writeError) return writeError;

  return JSON.stringify({
    ok: true,
    path,
    line_count: countLines(content),
    char_count: content.length,
  });
}

export function getIdeToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: SEARCH_TOOL_NAME,
        description:
          "Search Aoi's IDE workspace files by path and optional file content. " +
          'Use this when the user asks about code, files, symbols, or repository contents.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search text to match against workspace file paths or file content',
            },
            directory: {
              type: 'string',
              description:
                'Optional directory relative to the IDE workspace root. Defaults to the workspace root.',
            },
            mode: {
              type: 'string',
              description: 'Search mode: auto (path + content), path only, or content only',
              enum: ['auto', 'path', 'content'],
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of matches to return, between 1 and 20.',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: CURRENT_FILE_TOOL_NAME,
        description:
          "Read Aoi's IDE currently active editor file, including unsaved editor buffer content when available. " +
          'Also returns the current selected editor text when a selection is active. ' +
          'Use this first when the user says current file, active file, opened file, selected text, selection, or currently visible file.',
        parameters: {
          type: 'object',
          properties: {
            include_content: {
              type: 'boolean',
              description: 'Include the active file content. Defaults to true.',
            },
            max_chars: {
              type: 'number',
              description: 'Maximum content characters to return, capped at 80000.',
            },
            include_selection: {
              type: 'boolean',
              description:
                'Include selected editor text when a selection is active. Defaults to true.',
            },
            max_selection_chars: {
              type: 'number',
              description: 'Maximum selected-text characters to return, capped at 20000.',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: READ_FILE_TOOL_NAME,
        description:
          "Read a file from Aoi's IDE workspace. If path is omitted, reads the current active IDE file. " +
          'For disk files, returns the exact full-file byte size, modified time, and SHA-256. ' +
          'For the active file, unsaved editor buffer content is used when available and no disk hash is claimed.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Optional file path relative to the IDE workspace root.',
            },
            start_line: {
              type: 'number',
              description: 'Optional 1-based start line for a focused excerpt.',
            },
            end_line: {
              type: 'number',
              description: 'Optional 1-based end line for a focused excerpt.',
            },
            max_chars: {
              type: 'number',
              description: 'Maximum content characters to return, capped at 80000.',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: PATCH_FILE_TOOL_NAME,
        description:
          "Patch a disk file in Aoi's IDE workspace by exact text replacement. " +
          'Requires a non-active workspace file path. Use app_action PATCH_ACTIVE_FILE instead when editing the current active editor buffer.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'File path relative to the IDE workspace root. Must not be the active editor tab.',
            },
            old_text: {
              type: 'string',
              description: 'Exact text to replace.',
            },
            new_text: {
              type: 'string',
              description: 'Replacement text.',
            },
            expected_occurrences: {
              type: 'number',
              description: 'Optional exact number of expected old_text occurrences.',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences instead of the first occurrence.',
            },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: WRITE_FILE_TOOL_NAME,
        description:
          "Overwrite a non-active disk file in Aoi's IDE workspace. Use only when replacing the full file content is intended.",
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'File path relative to the IDE workspace root. Must not be the active editor tab.',
            },
            content: {
              type: 'string',
              description: 'Full file content to write.',
            },
          },
          required: ['path', 'content'],
        },
      },
    },
  ];
}

export function isIdeTool(toolName: string): boolean {
  return IDE_TOOL_NAMES.has(toolName);
}

export function isIdeMutationTool(toolName: string): boolean {
  return IDE_MUTATION_TOOL_NAMES.has(toolName);
}

export function getIdeToolPendingSummary(
  toolName: string,
  params: Record<string, unknown>,
): string {
  if (toolName === SEARCH_TOOL_NAME) {
    return `ide_search(${String(params.query || '').slice(0, 48)})`;
  }
  if (toolName === CURRENT_FILE_TOOL_NAME) {
    return 'ide_current_file';
  }
  if (toolName === READ_FILE_TOOL_NAME) {
    return `ide_read_file(${String(params.path || 'current').slice(0, 48)})`;
  }
  if (toolName === PATCH_FILE_TOOL_NAME) {
    return `ide_patch_file(${String(params.path || 'current').slice(0, 48)})`;
  }
  if (toolName === WRITE_FILE_TOOL_NAME) {
    return `ide_write_file(${String(params.path || 'current').slice(0, 48)})`;
  }
  return `${toolName}(${JSON.stringify(params).slice(0, 48)})`;
}

export async function executeIdeTool(
  toolNameOrParams: string | Record<string, unknown>,
  maybeParams?: Record<string, unknown>,
): Promise<string> {
  const toolName = typeof toolNameOrParams === 'string' ? toolNameOrParams : SEARCH_TOOL_NAME;
  const params = typeof toolNameOrParams === 'string' ? (maybeParams ?? {}) : toolNameOrParams;

  switch (toolName) {
    case SEARCH_TOOL_NAME:
      return executeSearchTool(params);
    case CURRENT_FILE_TOOL_NAME:
      return executeCurrentFileTool(params);
    case READ_FILE_TOOL_NAME:
      return executeReadFileTool(params);
    case PATCH_FILE_TOOL_NAME:
      return executePatchFileTool(params);
    case WRITE_FILE_TOOL_NAME:
      return executeWriteFileTool(params);
    default:
      return `error: unknown IDE tool ${toolName}`;
  }
}
