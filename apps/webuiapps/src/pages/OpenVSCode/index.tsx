import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/language/css/monaco.contribution';
import 'monaco-editor/esm/vs/language/html/monaco.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { useTranslation } from 'react-i18next';
import {
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  FileCode2,
  FilePlus2,
  Files,
  FolderClosed,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  History,
  PanelBottom,
  PanelLeft,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings2,
  SplitSquareHorizontal,
  TerminalSquare,
  Undo2,
  X,
} from 'lucide-react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  createAppFileApi,
  useAgentActionListener,
  reportLifecycle,
  fetchVibeInfo,
  type CharacterAppAction,
} from '@/lib';
import { loadPersistedConfig, savePersistedConfig } from '@/lib/configPersistence';
import { executeDiagnosticsTool } from '@/lib/diagnosticsTools';
import './i18n';
import styles from './index.module.scss';

const monacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === 'json') {
      return new jsonWorker();
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return new cssWorker();
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new htmlWorker();
    }
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

(
  globalThis as typeof globalThis & { MonacoEnvironment?: typeof monacoEnvironment }
).MonacoEnvironment = monacoEnvironment;
loader.config({ monaco });

const APP_ID = 19;
const APP_NAME = 'openvscode';
const DEFAULT_WINDOW_STYLE = { width: 1360, height: 760 };
const DEFAULT_TERMINAL_COMMAND = 'git status --short';
const DEFAULT_DIAGNOSTICS_COMMAND = 'pnpm exec eslint src/pages/OpenVSCode/index.tsx';
const STATE_FILE = '/state.json';
const ACTIVE_FILE_SNAPSHOT_CHAR_LIMIT = 80_000;
const ACTIVE_SELECTION_SNAPSHOT_CHAR_LIMIT = 20_000;
const openvscodeFileApi = createAppFileApi(APP_NAME);

type ActivityView = 'explorer' | 'search' | 'source' | 'settings';
type BottomPanel = 'problems' | 'output' | 'preview' | 'actions' | 'git' | 'terminal';
type SearchMode = 'auto' | 'path' | 'content';
type PatchPreviewSource = 'agent' | 'manual';
type PatchPreviewLineKind = 'context' | 'remove' | 'add';
type ModelActionStatus = 'success' | 'error';
type PaletteItemKind = 'command' | 'file' | 'tab';
type MonacoBeforeMount = Parameters<
  NonNullable<React.ComponentProps<typeof Editor>['beforeMount']>
>[0];

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

interface WorkspaceResponse {
  rootPath: string;
  exists: boolean;
}

interface DirectoryResponse {
  path: string;
  entries: WorkspaceEntry[];
}

interface FileResponse {
  path: string;
  content: string;
}

interface OpenFileTab {
  path: string;
  content: string;
  savedContent: string;
  language: string;
}

interface SearchMatch {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  match_type: 'path' | 'content' | 'path+content';
  snippets?: Array<{ line: number; text: string }>;
}

interface SearchResponse {
  query: string;
  directory: string;
  mode: SearchMode;
  scanned_files: number;
  scanned_directories: number;
  total_matches: number;
  has_more: boolean;
  matches: SearchMatch[];
}

interface CommandRunResponse {
  command: string;
  program: string;
  args: string[];
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface TerminalEntry {
  id: string;
  command: string;
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface GitStatusEntry {
  raw: string;
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface ProblemItem {
  severity: 'error' | 'warning' | 'info';
  source: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
  code?: string;
  testName?: string;
}

interface DiagnosticToolItem {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  code?: string;
  message: string;
  test_name?: string;
}

interface DiagnosticRunState {
  id: string;
  command: string;
  cwd: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  diagnosticCount: number;
  stdout: string;
  stderr: string;
  ranAt: number;
}

interface PatchPreview {
  id: string;
  path: string;
  beforeContent: string;
  afterContent: string;
  summary: string;
  source: PatchPreviewSource;
  createdAt: number;
  saveOnApply: boolean;
  occurrences?: number;
  replaced?: number;
}

interface PatchPreviewLine {
  id: string;
  kind: PatchPreviewLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface ModelActionUndoSnapshot {
  path: string;
  beforeContent: string;
  saveOnUndo: boolean;
}

interface ModelActionLogEntry {
  id: string;
  actionType: string;
  status: ModelActionStatus;
  path?: string;
  summary: string;
  resultPreview: string;
  createdAt: number;
  durationMs: number;
  reversible: boolean;
  undone: boolean;
  undoSnapshot?: ModelActionUndoSnapshot;
  undoError?: string;
}

interface CommandPaletteItem {
  id: string;
  kind: PaletteItemKind;
  label: string;
  group: string;
  shortcut?: string;
  description?: string;
  path?: string;
}

interface RuntimeSelectionState {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  lineCount: number;
  charCount: number;
  textTruncated: boolean;
  text?: string;
}

interface RuntimeFileState {
  path: string;
  name: string;
  language: string;
  dirty: boolean;
  lineCount: number;
  charCount: number;
  savedCharCount: number;
  contentTruncated: boolean;
  content?: string;
  cursor?: { line: number; column: number };
  selection?: RuntimeSelectionState | null;
}

interface OpenVscodeRuntimeState {
  version: 1;
  workspaceRoot: string;
  workspaceExists: boolean;
  activePath: string | null;
  activeFile: RuntimeFileState | null;
  openTabs: RuntimeFileState[];
  ui: {
    activityView: ActivityView;
    sidebarOpen: boolean;
    bottomPanelOpen: boolean;
    bottomPanel: BottomPanel;
    splitView: boolean;
  };
  pendingPatchPreview: {
    path: string;
    source: PatchPreviewSource;
    beforeCharCount: number;
    afterCharCount: number;
    saveOnApply: boolean;
  } | null;
  modelActions: Array<{
    id: string;
    actionType: string;
    status: ModelActionStatus;
    path?: string;
    summary: string;
    resultPreview: string;
    reversible: boolean;
    undone: boolean;
    createdAt: number;
    durationMs: number;
  }>;
  updatedAt: number;
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

function buildSelectionSnapshot(
  editor: monaco.editor.IStandaloneCodeEditor,
): RuntimeSelectionState | null {
  const selection = editor.getSelection();
  const model = editor.getModel();
  if (!selection || !model || selection.isEmpty()) {
    return null;
  }

  const start = selection.getStartPosition();
  const end = selection.getEndPosition();
  const selectedText = normalizeEditorContent(model.getValueInRange(selection));
  const textTruncated = selectedText.length > ACTIVE_SELECTION_SNAPSHOT_CHAR_LIMIT;

  return {
    startLine: start.lineNumber,
    startColumn: start.column,
    endLine: end.lineNumber,
    endColumn: end.column,
    lineCount: countLines(selectedText),
    charCount: selectedText.length,
    textTruncated,
    text: textTruncated
      ? selectedText.slice(0, ACTIVE_SELECTION_SNAPSHOT_CHAR_LIMIT)
      : selectedText,
  };
}

function getPositionOffset(content: string, lineNumber: number, column: number): number {
  const normalizedContent = normalizeEditorContent(content);
  const lines = normalizedContent.split('\n');
  const safeLine = Math.max(1, Math.min(lines.length, Math.floor(lineNumber)));
  const lineStart = lines
    .slice(0, safeLine - 1)
    .reduce((offset, line) => offset + line.length + 1, 0);
  const safeColumn = Math.max(
    1,
    Math.min((lines[safeLine - 1] ?? '').length + 1, Math.floor(column)),
  );
  return lineStart + safeColumn - 1;
}

function replaceSelectionRange(
  content: string,
  selection: RuntimeSelectionState,
  replacement: string,
): string {
  const normalizedContent = normalizeEditorContent(content);
  const startOffset = getPositionOffset(
    normalizedContent,
    selection.startLine,
    selection.startColumn,
  );
  const endOffset = getPositionOffset(normalizedContent, selection.endLine, selection.endColumn);
  const rangeStart = Math.min(startOffset, endOffset);
  const rangeEnd = Math.max(startOffset, endOffset);
  if (rangeStart === rangeEnd) {
    return normalizedContent;
  }
  return `${normalizedContent.slice(0, rangeStart)}${normalizeEditorContent(replacement)}${normalizedContent.slice(rangeEnd)}`;
}

function replaceOnce(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  if (index < 0) return content;
  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function createPatchPreviewId(): string {
  return `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildPatchSummary(beforeContent: string, afterContent: string): string {
  const beforeLines = countLines(beforeContent);
  const afterLines = countLines(afterContent);
  const lineDelta = afterLines - beforeLines;
  const charDelta = afterContent.length - beforeContent.length;
  const linePart = lineDelta === 0 ? '0 lines' : `${lineDelta > 0 ? '+' : ''}${lineDelta} lines`;
  const charPart = charDelta === 0 ? '0 chars' : `${charDelta > 0 ? '+' : ''}${charDelta} chars`;
  return `${linePart}, ${charPart}`;
}

function buildPatchPreviewLines(beforeContent: string, afterContent: string): PatchPreviewLine[] {
  const beforeLines = normalizeEditorContent(beforeContent).split('\n');
  const afterLines = normalizeEditorContent(afterContent).split('\n');
  const maxContextLines = 4;
  const maxChangedLines = 80;

  if (beforeContent === afterContent) {
    return beforeLines.slice(0, maxContextLines).map((text, index) => ({
      id: `same-${index}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text,
    }));
  }

  let prefixCount = 0;
  const minLineCount = Math.min(beforeLines.length, afterLines.length);
  while (prefixCount < minLineCount && beforeLines[prefixCount] === afterLines[prefixCount]) {
    prefixCount += 1;
  }

  let suffixCount = 0;
  while (
    suffixCount < beforeLines.length - prefixCount &&
    suffixCount < afterLines.length - prefixCount &&
    beforeLines[beforeLines.length - 1 - suffixCount] ===
      afterLines[afterLines.length - 1 - suffixCount]
  ) {
    suffixCount += 1;
  }

  const lines: PatchPreviewLine[] = [];
  const beforeChangedEnd = beforeLines.length - suffixCount;
  const afterChangedEnd = afterLines.length - suffixCount;
  const contextStart = Math.max(0, prefixCount - maxContextLines);
  const contextEnd = Math.min(beforeLines.length, beforeChangedEnd + maxContextLines);

  for (let index = contextStart; index < prefixCount; index += 1) {
    lines.push({
      id: `context-before-${index}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: beforeLines[index] ?? '',
    });
  }

  for (let index = prefixCount; index < beforeChangedEnd; index += 1) {
    if (lines.length >= maxChangedLines) break;
    lines.push({
      id: `remove-${index}`,
      kind: 'remove',
      oldLine: index + 1,
      text: beforeLines[index] ?? '',
    });
  }

  for (let index = prefixCount; index < afterChangedEnd; index += 1) {
    if (lines.length >= maxChangedLines) break;
    lines.push({
      id: `add-${index}`,
      kind: 'add',
      newLine: index + 1,
      text: afterLines[index] ?? '',
    });
  }

  for (let index = beforeChangedEnd; index < contextEnd; index += 1) {
    lines.push({
      id: `context-after-${index}`,
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1 + (afterLines.length - beforeLines.length),
      text: beforeLines[index] ?? '',
    });
  }

  return lines;
}

function parseActionBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}

function parseOptionalPositiveInteger(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function normalizeWorkspacePathInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function isRelativeWorkspaceFilePath(filePath: string): boolean {
  if (!filePath || filePath === '.' || filePath.endsWith('/')) return false;
  if (/^(?:[a-zA-Z]:|\/)/.test(filePath)) return false;
  if (/(^|\/)\.\.(?:\/|$)/.test(filePath)) return false;
  if (filePath.split('/').some((segment) => !segment || segment === '.')) return false;
  return true;
}

function getParentPath(filePath: string): string {
  return filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
}

function getAncestorDirectoryPaths(filePath: string): string[] {
  const parentPath = getParentPath(filePath);
  if (!parentPath) return [''];
  const paths = [''];
  let current = '';
  parentPath
    .split('/')
    .filter(Boolean)
    .forEach((segment) => {
      current = current ? `${current}/${segment}` : segment;
      paths.push(current);
    });
  return paths;
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function getFileExtensionLabel(filePath: string | null): string {
  if (!filePath) return 'TXT';
  const fileName = getFileName(filePath);
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return 'TXT';
  return fileName.slice(dotIndex + 1).toUpperCase();
}

function buildRuntimeFileState(
  tab: OpenFileTab,
  options: {
    includeContent: boolean;
    cursor?: { line: number; column: number };
    selection?: RuntimeSelectionState | null;
  },
): RuntimeFileState {
  const normalizedContent = normalizeEditorContent(tab.content);
  const normalizedSavedContent = normalizeEditorContent(tab.savedContent);
  const contentTruncated = normalizedContent.length > ACTIVE_FILE_SNAPSHOT_CHAR_LIMIT;

  return {
    path: tab.path,
    name: getFileName(tab.path),
    language: tab.language,
    dirty: normalizedContent !== normalizedSavedContent,
    lineCount: countLines(normalizedContent),
    charCount: normalizedContent.length,
    savedCharCount: normalizedSavedContent.length,
    contentTruncated,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.selection !== undefined ? { selection: options.selection } : {}),
    ...(options.includeContent
      ? {
          content: contentTruncated
            ? normalizedContent.slice(0, ACTIVE_FILE_SNAPSHOT_CHAR_LIMIT)
            : normalizedContent,
        }
      : {}),
  };
}

function buildOpenVscodeRuntimeState(args: {
  workspaceRoot: string;
  workspaceExists: boolean;
  activePath: string | null;
  activeTab: OpenFileTab | null;
  openTabs: OpenFileTab[];
  cursorPosition: { line: number; column: number };
  editorSelection: RuntimeSelectionState | null;
  activityView: ActivityView;
  isSidebarOpen: boolean;
  isBottomPanelOpen: boolean;
  bottomPanel: BottomPanel;
  isSplitView: boolean;
  patchPreview: PatchPreview | null;
  modelActionLog: ModelActionLogEntry[];
}): OpenVscodeRuntimeState {
  return {
    version: 1,
    workspaceRoot: args.workspaceRoot,
    workspaceExists: args.workspaceExists,
    activePath: args.activePath,
    activeFile: args.activeTab
      ? buildRuntimeFileState(args.activeTab, {
          includeContent: true,
          cursor: args.cursorPosition,
          selection: args.editorSelection,
        })
      : null,
    openTabs: args.openTabs.map((tab) =>
      buildRuntimeFileState(tab, {
        includeContent: false,
        cursor: tab.path === args.activePath ? args.cursorPosition : undefined,
      }),
    ),
    ui: {
      activityView: args.activityView,
      sidebarOpen: args.isSidebarOpen,
      bottomPanelOpen: args.isBottomPanelOpen,
      bottomPanel: args.bottomPanel,
      splitView: args.isSplitView,
    },
    pendingPatchPreview: args.patchPreview
      ? {
          path: args.patchPreview.path,
          source: args.patchPreview.source,
          beforeCharCount: args.patchPreview.beforeContent.length,
          afterCharCount: args.patchPreview.afterContent.length,
          saveOnApply: args.patchPreview.saveOnApply,
        }
      : null,
    modelActions: args.modelActionLog.slice(0, 20).map((entry) => ({
      id: entry.id,
      actionType: entry.actionType,
      status: entry.status,
      path: entry.path,
      summary: entry.summary,
      resultPreview: entry.resultPreview,
      reversible: entry.reversible,
      undone: entry.undone,
      createdAt: entry.createdAt,
      durationMs: entry.durationMs,
    })),
    updatedAt: Date.now(),
  };
}

function detectMonacoLanguage(filePath: string | null | undefined): string {
  if (!filePath) return 'plaintext';
  const normalized = filePath.toLowerCase();

  if (normalized.endsWith('.tsx')) return 'typescript';
  if (normalized.endsWith('.ts')) return 'typescript';
  if (normalized.endsWith('.jsx')) return 'javascript';
  if (normalized.endsWith('.js') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs'))
    return 'javascript';
  if (normalized.endsWith('.json')) return 'json';
  if (/\.(md|markdown)$/.test(normalized)) return 'markdown';
  if (normalized.endsWith('.py')) return 'python';
  if (/\.(html|htm)$/.test(normalized)) return 'html';
  if (normalized.endsWith('.xml') || normalized.endsWith('.svg')) return 'xml';
  if (normalized.endsWith('.css')) return 'css';
  if (normalized.endsWith('.scss')) return 'scss';
  if (normalized.endsWith('.less')) return 'less';
  if (/\.(ya?ml)$/.test(normalized)) return 'yaml';
  if (/\.(sh|bash|zsh)$/.test(normalized)) return 'shell';
  if (normalized.endsWith('.ps1')) return 'powershell';
  if (normalized.endsWith('.sql')) return 'sql';
  if (normalized.endsWith('.go')) return 'go';
  if (normalized.endsWith('.rs')) return 'rust';
  if (/\.(cpp|cc|cxx|c|h|hpp|hh)$/.test(normalized)) return 'cpp';
  return 'plaintext';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function createTerminalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createModelActionId(): string {
  return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildActionResultPreview(result: string): string {
  return result.length > 240 ? `${result.slice(0, 240)}...` : result;
}

function getActionPathFromResult(result: string): string | undefined {
  if (!result.trim().startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result) as { path?: unknown };
    return typeof parsed.path === 'string' ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDiagnosticFilePath(
  filePath: string | undefined,
  workspaceRoot: string,
): string | undefined {
  if (!filePath) return undefined;
  const normalizedPath = filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
  if (!normalizedPath) return undefined;

  const normalizedWorkspace = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    normalizedWorkspace &&
    normalizedPath.toLowerCase().startsWith(`${normalizedWorkspace.toLowerCase()}/`)
  ) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }

  return normalizedPath.replace(/^\/+/, '');
}

function quoteWorkspaceCommandArg(value: string): string {
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function parseGitStatus(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawStatus = line.slice(0, 2).padEnd(2, ' ');
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(' -> ');
      const path = renameParts[1] || rawPath;
      return {
        raw: line,
        path,
        originalPath: renameParts[1] ? renameParts[0] : undefined,
        indexStatus: rawStatus[0] || ' ',
        worktreeStatus: rawStatus[1] || ' ',
      };
    });
}

function getGitStatusLabel(entry: GitStatusEntry): string {
  const status = `${entry.indexStatus}${entry.worktreeStatus}`.trim();
  return status || 'M';
}

function paletteMatches(item: CommandPaletteItem, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = `${item.group} ${item.label} ${item.description ?? ''} ${item.path ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ');
  if (haystack.includes(normalizedQuery)) {
    return true;
  }

  let offset = 0;
  for (const char of normalizedQuery.replace(/\s+/g, '')) {
    const nextOffset = haystack.indexOf(char, offset);
    if (nextOffset < 0) {
      return false;
    }
    offset = nextOffset + 1;
  }
  return true;
}

function createProblemId(): string {
  return `problem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const OpenVSCodePage: React.FC = () => {
  const { t } = useTranslation('openvscode');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [workspaceExists, setWorkspaceExists] = useState(true);
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [activityView, setActivityView] = useState<ActivityView>('explorer');
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [createFileError, setCreateFileError] = useState<string | null>(null);
  const [tree, setTree] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<string[]>(['']);
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [editorSelection, setEditorSelection] = useState<RuntimeSelectionState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('auto');
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>('terminal');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(true);
  const [terminalCommand, setTerminalCommand] = useState(DEFAULT_TERMINAL_COMMAND);
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [isRunningCommand, setIsRunningCommand] = useState(false);
  const [diagnosticCommand, setDiagnosticCommand] = useState(DEFAULT_DIAGNOSTICS_COMMAND);
  const [diagnosticItems, setDiagnosticItems] = useState<ProblemItem[]>([]);
  const [lastDiagnosticRun, setLastDiagnosticRun] = useState<DiagnosticRunState | null>(null);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const [gitStatusEntries, setGitStatusEntries] = useState<GitStatusEntry[]>([]);
  const [selectedGitPath, setSelectedGitPath] = useState<string | null>(null);
  const [gitDiffText, setGitDiffText] = useState('');
  const [gitErrorText, setGitErrorText] = useState<string | null>(null);
  const [isGitLoading, setIsGitLoading] = useState(false);
  const [gitBranch, setGitBranch] = useState('main');
  const [isSplitView, setIsSplitView] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(0);
  const [patchPreview, setPatchPreview] = useState<PatchPreview | null>(null);
  const [modelActionLog, setModelActionLog] = useState<ModelActionLogEntry[]>([]);
  const activePathRef = useRef<string | null>(null);
  const openTabsRef = useRef<OpenFileTab[]>([]);
  const editorSelectionRef = useRef<RuntimeSelectionState | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const pendingRevealLineRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const terminalInputRef = useRef<HTMLInputElement | null>(null);
  const diagnosticsInputRef = useRef<HTMLInputElement | null>(null);
  const lastPublishedStateRef = useRef('');
  const pendingRuntimeStateRef = useRef<{
    serialized: string;
    state: OpenVscodeRuntimeState;
  } | null>(null);
  const isPublishingRuntimeStateRef = useRef(false);

  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.path === activePath) ?? null,
    [activePath, openTabs],
  );
  const isDirty = activeTab
    ? normalizeEditorContent(activeTab.content) !== normalizeEditorContent(activeTab.savedContent)
    : false;
  const dirtyTabs = useMemo(
    () =>
      openTabs.filter(
        (tab) => normalizeEditorContent(tab.content) !== normalizeEditorContent(tab.savedContent),
      ),
    [openTabs],
  );
  const lineCount = useMemo(() => countLines(activeTab?.content ?? ''), [activeTab?.content]);
  const fileExtensionLabel = useMemo(() => getFileExtensionLabel(activePath), [activePath]);
  const patchPreviewLines = useMemo(
    () =>
      patchPreview
        ? buildPatchPreviewLines(patchPreview.beforeContent, patchPreview.afterContent)
        : [],
    [patchPreview],
  );

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const syncEditorSelection = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor | null = editorRef.current) => {
      const nextSelection = editor ? buildSelectionSnapshot(editor) : null;
      editorSelectionRef.current = nextSelection;
      setEditorSelection(nextSelection);
    },
    [],
  );

  const clearEditorSelection = useCallback(() => {
    editorSelectionRef.current = null;
    setEditorSelection(null);
  }, []);

  const flushRuntimeState = useCallback(async () => {
    if (isPublishingRuntimeStateRef.current) return;
    isPublishingRuntimeStateRef.current = true;

    try {
      while (pendingRuntimeStateRef.current) {
        const next = pendingRuntimeStateRef.current;
        pendingRuntimeStateRef.current = null;
        try {
          await openvscodeFileApi.writeFile(STATE_FILE, next.state);
          lastPublishedStateRef.current = next.serialized;
        } catch (error) {
          console.warn('[OpenVSCode] failed to publish runtime state', error);
        }
      }
    } finally {
      isPublishingRuntimeStateRef.current = false;
      if (pendingRuntimeStateRef.current) {
        void flushRuntimeState();
      }
    }
  }, []);

  useEffect(() => {
    if (isLoading) return;

    const runtimeState = buildOpenVscodeRuntimeState({
      workspaceRoot,
      workspaceExists,
      activePath,
      activeTab,
      openTabs,
      cursorPosition,
      editorSelection,
      activityView,
      isSidebarOpen,
      isBottomPanelOpen,
      bottomPanel,
      isSplitView,
      patchPreview,
      modelActionLog,
    });
    const serialized = JSON.stringify(runtimeState);
    if (serialized === lastPublishedStateRef.current) return;

    const timer = window.setTimeout(() => {
      pendingRuntimeStateRef.current = { serialized, state: runtimeState };
      void flushRuntimeState();
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    activePath,
    activeTab,
    activityView,
    bottomPanel,
    cursorPosition,
    editorSelection,
    isBottomPanelOpen,
    isLoading,
    isSidebarOpen,
    isSplitView,
    modelActionLog,
    openTabs,
    patchPreview,
    flushRuntimeState,
    workspaceExists,
    workspaceRoot,
  ]);

  const fetchWorkspaceInfo = useCallback(async (): Promise<WorkspaceResponse> => {
    const res = await fetch('/api/openvscode/workspace');
    const data = (await res.json()) as WorkspaceResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Workspace API error ${res.status}`);
    }
    return data;
  }, []);

  const loadDirectory = useCallback(async (path = ''): Promise<WorkspaceEntry[]> => {
    const res = await fetch(`/api/openvscode/list?path=${encodeURIComponent(path)}`);
    const data = (await res.json()) as DirectoryResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Directory API error ${res.status}`);
    }
    setTree((prev) => ({ ...prev, [path]: data.entries }));
    return data.entries;
  }, []);

  const revealLine = useCallback((line: number) => {
    if (!editorRef.current) {
      pendingRevealLineRef.current = line;
      return;
    }
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column: 1 });
    editorRef.current.focus();
  }, []);

  const loadFile = useCallback(
    async (path: string, revealToLine?: number) => {
      const alreadyOpen = openTabsRef.current.find((tab) => tab.path === path);
      if (alreadyOpen) {
        clearEditorSelection();
        setActivePath(path);
        if (revealToLine) {
          pendingRevealLineRef.current = revealToLine;
        }
        return;
      }

      setIsFileLoading(true);
      try {
        const res = await fetch(`/api/openvscode/file?path=${encodeURIComponent(path)}`);
        const data = (await res.json()) as FileResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error || `File API error ${res.status}`);
        }
        const normalizedContent = normalizeEditorContent(data.content);
        const tab: OpenFileTab = {
          path: data.path,
          content: normalizedContent,
          savedContent: normalizedContent,
          language: detectMonacoLanguage(data.path),
        };
        setOpenTabs((prev) => {
          const withoutExisting = prev.filter((item) => item.path !== data.path);
          return [...withoutExisting, tab];
        });
        setActivePath(data.path);
        setCursorPosition({ line: revealToLine ?? 1, column: 1 });
        clearEditorSelection();
        if (revealToLine) {
          pendingRevealLineRef.current = revealToLine;
        }
        setErrorText(null);
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setIsFileLoading(false);
      }
    },
    [clearEditorSelection],
  );

  const refreshWorkspace = useCallback(async () => {
    setIsTreeLoading(true);
    try {
      const info = await fetchWorkspaceInfo();
      setWorkspaceRoot(info.rootPath);
      setWorkspaceExists(info.exists);
      setWorkspaceDraft((prev) => prev || info.rootPath);
      if (!info.exists) {
        setTree({});
        setOpenTabs([]);
        setActivePath(null);
        setCursorPosition({ line: 1, column: 1 });
        clearEditorSelection();
        return;
      }
      const rootEntries = await loadDirectory('');
      if (!activePathRef.current) {
        const preferred = rootEntries.find(
          (entry) => entry.type === 'file' && /^(README|package)\./i.test(entry.name),
        );
        if (preferred) {
          await loadFile(preferred.path);
        }
      }
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTreeLoading(false);
    }
  }, [clearEditorSelection, fetchWorkspaceInfo, loadDirectory, loadFile]);

  const loadGitBranch = useCallback(async () => {
    try {
      const res = await fetch('/api/openvscode/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'git branch --show-current', timeout_ms: 5000 }),
      });
      const data = (await res.json()) as Partial<CommandRunResponse> & { error?: string };
      if (res.ok && typeof data.stdout === 'string') {
        const branch = data.stdout.trim();
        if (branch) {
          setGitBranch(branch);
        }
      }
    } catch {
      setGitBranch('main');
    }
  }, []);

  const toggleDirectory = useCallback(
    async (path: string) => {
      const isExpanded = expandedDirs.includes(path);
      if (isExpanded) {
        setExpandedDirs((prev) => prev.filter((item) => item !== path));
        return;
      }
      if (!tree[path]) {
        try {
          await loadDirectory(path);
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      setExpandedDirs((prev) => [...prev, path]);
    },
    [expandedDirs, loadDirectory, tree],
  );

  const saveFileContent = useCallback(async (path: string, content: string) => {
    const res = await fetch('/api/openvscode/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: normalizeEditorContent(content) }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Save API error ${res.status}`);
    }
  }, []);

  const runWorkspaceCommand = useCallback(
    async (command: string, timeoutMs = 10000): Promise<CommandRunResponse> => {
      const res = await fetch('/api/openvscode/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, timeout_ms: timeoutMs }),
      });
      const data = (await res.json()) as CommandRunResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Command API error ${res.status}`);
      }
      return data;
    },
    [],
  );

  const saveCurrentFile = useCallback(async () => {
    if (!activeTab) return;
    setIsSaving(true);
    try {
      await saveFileContent(activeTab.path, activeTab.content);
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === activeTab.path
            ? { ...tab, savedContent: normalizeEditorContent(activeTab.content) }
            : tab,
        ),
      );
      const parentPath = getParentPath(activeTab.path);
      if (tree[parentPath]) {
        await loadDirectory(parentPath);
      }
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [activeTab, loadDirectory, saveFileContent, tree]);

  const saveAllFiles = useCallback(async () => {
    const changedTabs = openTabsRef.current.filter(
      (tab) => normalizeEditorContent(tab.content) !== normalizeEditorContent(tab.savedContent),
    );
    if (changedTabs.length === 0) return;

    setIsSaving(true);
    try {
      for (const tab of changedTabs) {
        await saveFileContent(tab.path, tab.content);
      }
      setOpenTabs((prev) =>
        prev.map((tab) => ({
          ...tab,
          savedContent: normalizeEditorContent(tab.content),
        })),
      );
      await refreshWorkspace();
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [refreshWorkspace, saveFileContent]);

  const createNewFile = useCallback(
    async (requestedPath: string): Promise<{ ok: boolean; error?: string }> => {
      const normalizedPath = normalizeWorkspacePathInput(requestedPath);
      if (!isRelativeWorkspaceFilePath(normalizedPath)) {
        const message = t('errors.invalidFilePath');
        setCreateFileError(message);
        return { ok: false, error: message };
      }

      setIsCreatingFile(true);
      setCreateFileError(null);
      try {
        const res = await fetch('/api/openvscode/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: normalizedPath, content: '', overwrite: false }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error || `Create file API error ${res.status}`);
        }

        const ancestorDirectories = getAncestorDirectoryPaths(normalizedPath);
        setExpandedDirs((prev) => Array.from(new Set([...prev, ...ancestorDirectories])));
        for (const directoryPath of ancestorDirectories) {
          await loadDirectory(directoryPath);
        }

        setShowCreateFile(false);
        setNewFilePath('');
        await loadFile(normalizedPath);
        editorRef.current?.focus();
        setErrorText(null);
        setCreateFileError(null);
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCreateFileError(message);
        return { ok: false, error: message };
      } finally {
        setIsCreatingFile(false);
      }
    },
    [loadDirectory, loadFile, t],
  );

  const submitCreateFile = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void createNewFile(newFilePath);
    },
    [createNewFile, newFilePath],
  );

  const saveWorkspacePath = useCallback(async () => {
    setErrorText(null);
    try {
      const nextWorkspace = workspaceDraft.trim();
      const existing = await loadPersistedConfig();
      await savePersistedConfig({
        ...(existing ?? {}),
        openvscode: {
          ...(existing?.openvscode ?? {}),
          workspacePath: nextWorkspace || undefined,
        },
      });
      setWorkspaceRoot(nextWorkspace);
      setWorkspaceDraft(nextWorkspace);
      setTree({});
      setExpandedDirs(['']);
      setOpenTabs([]);
      setActivePath(null);
      setCursorPosition({ line: 1, column: 1 });
      clearEditorSelection();
      await refreshWorkspace();
      setActivityView('explorer');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [clearEditorSelection, refreshWorkspace, workspaceDraft]);

  const runSearch = useCallback(
    async (queryOverride?: string): Promise<SearchResponse | null> => {
      const query = (queryOverride ?? searchQuery).trim();
      if (!query) {
        setSearchResult(null);
        return null;
      }
      setIsSearching(true);
      try {
        const url = new URL('/api/openvscode/search', window.location.origin);
        url.searchParams.set('query', query);
        url.searchParams.set('mode', searchMode);
        url.searchParams.set('max_results', '20');
        const res = await fetch(url.toString());
        const data = (await res.json()) as SearchResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error || `Search API error ${res.status}`);
        }
        setSearchResult(data);
        setErrorText(null);
        return data;
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setIsSearching(false);
      }
    },
    [searchMode, searchQuery],
  );

  const runTerminalCommand = useCallback(
    async (commandOverride?: string): Promise<TerminalEntry | null> => {
      const command = (commandOverride ?? terminalCommand).trim();
      if (!command) return null;

      setIsBottomPanelOpen(true);
      setBottomPanel('terminal');
      setIsRunningCommand(true);
      try {
        const res = await fetch('/api/openvscode/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, timeout_ms: 30000 }),
        });
        const data = (await res.json()) as CommandRunResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error || `Command API error ${res.status}`);
        }
        const entry: TerminalEntry = {
          id: createTerminalId(),
          command: data.command,
          cwd: data.cwd,
          exitCode: data.exitCode,
          timedOut: data.timedOut,
          durationMs: data.durationMs,
          stdout: data.stdout,
          stderr: data.stderr,
        };
        setTerminalHistory((prev) => [entry, ...prev].slice(0, 20));
        setTerminalCommand(command);
        setErrorText(null);
        return entry;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const entry: TerminalEntry = {
          id: createTerminalId(),
          command,
          cwd: '.',
          exitCode: -1,
          timedOut: false,
          durationMs: 0,
          stdout: '',
          stderr: message,
        };
        setTerminalHistory((prev) => [entry, ...prev].slice(0, 20));
        setErrorText(message);
        return entry;
      } finally {
        setIsRunningCommand(false);
      }
    },
    [terminalCommand],
  );

  const loadGitDiff = useCallback(
    async (path: string): Promise<string> => {
      const quotedPath = quoteWorkspaceCommandArg(path);
      const unstaged = await runWorkspaceCommand(`git diff -- ${quotedPath}`, 15000);
      let diffText = unstaged.stdout.trimEnd();

      if (!diffText) {
        const staged = await runWorkspaceCommand(`git diff --cached -- ${quotedPath}`, 15000);
        diffText = staged.stdout.trimEnd();
      }

      setSelectedGitPath(path);
      setGitDiffText(diffText);
      setGitErrorText(null);
      setIsBottomPanelOpen(true);
      setBottomPanel('git');
      return diffText;
    },
    [runWorkspaceCommand],
  );

  const loadGitStatus = useCallback(async (): Promise<GitStatusEntry[]> => {
    setIsGitLoading(true);
    try {
      const status = await runWorkspaceCommand('git status --short', 10000);
      const entries = parseGitStatus(status.stdout);
      setGitStatusEntries(entries);
      setGitErrorText(status.exitCode === 0 ? null : status.stderr || status.stdout);
      if (entries.length === 0) {
        setSelectedGitPath(null);
        setGitDiffText('');
      } else if (!selectedGitPath || !entries.some((entry) => entry.path === selectedGitPath)) {
        setSelectedGitPath(entries[0].path);
        await loadGitDiff(entries[0].path);
      }
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGitStatusEntries([]);
      setGitErrorText(message);
      return [];
    } finally {
      setIsGitLoading(false);
    }
  }, [loadGitDiff, runWorkspaceCommand, selectedGitPath]);

  const openGitStatusEntry = useCallback(
    async (entry: GitStatusEntry) => {
      setSelectedGitPath(entry.path);
      setIsBottomPanelOpen(true);
      setBottomPanel('git');
      await loadGitDiff(entry.path);
      if (entry.worktreeStatus !== 'D' && entry.indexStatus !== 'D') {
        await loadFile(entry.path);
      }
    },
    [loadFile, loadGitDiff],
  );

  const runDiagnostics = useCallback(
    async (commandOverride?: string): Promise<DiagnosticRunState | null> => {
      const command = (commandOverride ?? diagnosticCommand).trim();
      if (!command) return null;

      setIsBottomPanelOpen(true);
      setBottomPanel('problems');
      setIsRunningDiagnostics(true);
      try {
        const raw = await executeDiagnosticsTool({ command, timeout_ms: 30000 });
        if (/^error:/i.test(raw)) {
          throw new Error(raw.replace(/^error:\s*/i, ''));
        }

        const parsed = JSON.parse(raw) as {
          command?: string;
          cwd?: string;
          exitCode?: number;
          timedOut?: boolean;
          durationMs?: number;
          diagnostic_count?: number;
          diagnostics?: DiagnosticToolItem[];
          stdout?: string;
          stderr?: string;
        };

        const nextItems = (parsed.diagnostics ?? []).map<ProblemItem>((item) => ({
          severity: item.severity,
          source: 'Diagnostics',
          message: item.message,
          path: normalizeDiagnosticFilePath(item.file, workspaceRoot),
          line: item.line,
          column: item.column,
          code: item.code,
          testName: item.test_name,
        }));
        const runState: DiagnosticRunState = {
          id: createProblemId(),
          command: parsed.command || command,
          cwd: parsed.cwd || workspaceRoot || '.',
          exitCode: parsed.exitCode ?? -1,
          timedOut: !!parsed.timedOut,
          durationMs: parsed.durationMs ?? 0,
          diagnosticCount: parsed.diagnostic_count ?? nextItems.length,
          stdout: parsed.stdout || '',
          stderr: parsed.stderr || '',
          ranAt: Date.now(),
        };

        setDiagnosticItems(nextItems);
        setLastDiagnosticRun(runState);
        setDiagnosticCommand(command);
        setErrorText(null);
        return runState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const runState: DiagnosticRunState = {
          id: createProblemId(),
          command,
          cwd: workspaceRoot || '.',
          exitCode: -1,
          timedOut: false,
          durationMs: 0,
          diagnosticCount: 1,
          stdout: '',
          stderr: message,
          ranAt: Date.now(),
        };
        setDiagnosticItems([
          {
            severity: 'error',
            source: 'Diagnostics',
            message,
          },
        ]);
        setLastDiagnosticRun(runState);
        setErrorText(null);
        return runState;
      } finally {
        setIsRunningDiagnostics(false);
      }
    },
    [diagnosticCommand, workspaceRoot],
  );

  const closeTab = useCallback(
    (path: string) => {
      const tab = openTabsRef.current.find((item) => item.path === path);
      const tabIsDirty =
        tab && normalizeEditorContent(tab.content) !== normalizeEditorContent(tab.savedContent);
      if (tabIsDirty) {
        // eslint-disable-next-line no-alert
        const shouldClose = window.confirm(t('editor.discardConfirm'));
        if (!shouldClose) return;
      }

      setOpenTabs((prev) => {
        const next = prev.filter((item) => item.path !== path);
        if (activePathRef.current === path) {
          const closedIndex = prev.findIndex((item) => item.path === path);
          const fallback = next[Math.max(0, closedIndex - 1)] ?? next[0] ?? null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
    },
    [t],
  );

  const updateActiveTabContent = useCallback((value: string) => {
    setOpenTabs((prev) =>
      prev.map((tab) => (tab.path === activePathRef.current ? { ...tab, content: value } : tab)),
    );
  }, []);

  const setActiveFileContentFromAgent = useCallback(
    async (
      nextContent: string,
      options: { save: boolean },
    ): Promise<{
      ok: boolean;
      path?: string;
      saved?: boolean;
      lineCount?: number;
      charCount?: number;
      error?: string;
    }> => {
      const path = activePathRef.current;
      if (!path) {
        return { ok: false, error: 'no active file' };
      }

      const normalizedContent = normalizeEditorContent(nextContent);
      setOpenTabs((prev) =>
        prev.map((tab) => (tab.path === path ? { ...tab, content: normalizedContent } : tab)),
      );

      if (!options.save) {
        setErrorText(null);
        return {
          ok: true,
          path,
          saved: false,
          lineCount: countLines(normalizedContent),
          charCount: normalizedContent.length,
        };
      }

      setIsSaving(true);
      try {
        await saveFileContent(path, normalizedContent);
        setOpenTabs((prev) =>
          prev.map((tab) =>
            tab.path === path ? { ...tab, savedContent: normalizedContent } : tab,
          ),
        );
        const parentPath = getParentPath(path);
        if (tree[parentPath]) {
          await loadDirectory(parentPath);
        }
        setErrorText(null);
        return {
          ok: true,
          path,
          saved: true,
          lineCount: countLines(normalizedContent),
          charCount: normalizedContent.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorText(message);
        return { ok: false, path, saved: false, error: message };
      } finally {
        setIsSaving(false);
      }
    },
    [loadDirectory, saveFileContent, tree],
  );

  const createPatchPreview = useCallback((preview: Omit<PatchPreview, 'id' | 'createdAt'>) => {
    const nextPreview: PatchPreview = {
      ...preview,
      id: createPatchPreviewId(),
      createdAt: Date.now(),
    };
    setPatchPreview(nextPreview);
    setIsBottomPanelOpen(true);
    setBottomPanel('preview');
    setErrorText(null);
    return nextPreview;
  }, []);

  const previewUnsavedActiveFile = useCallback((): PatchPreview | null => {
    const path = activePathRef.current;
    const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
    if (!path || !tab) {
      setErrorText(t('preview.noActiveFile'));
      return null;
    }

    const beforeContent = normalizeEditorContent(tab.savedContent);
    const afterContent = normalizeEditorContent(tab.content);
    if (beforeContent === afterContent) {
      setErrorText(t('preview.noChanges'));
      return null;
    }

    return createPatchPreview({
      path,
      beforeContent,
      afterContent,
      summary: buildPatchSummary(beforeContent, afterContent),
      source: 'manual',
      saveOnApply: true,
    });
  }, [createPatchPreview, t]);

  const previewActiveFileReplacement = useCallback(
    (
      afterContent: string,
      options: { source: PatchPreviewSource; save: boolean },
    ): PatchPreview | null => {
      const path = activePathRef.current;
      const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
      if (!path || !tab) {
        setErrorText(t('preview.noActiveFile'));
        return null;
      }

      const beforeContent = normalizeEditorContent(tab.content);
      const normalizedAfterContent = normalizeEditorContent(afterContent);
      if (beforeContent === normalizedAfterContent) {
        setErrorText(t('preview.noChanges'));
        return null;
      }

      return createPatchPreview({
        path,
        beforeContent,
        afterContent: normalizedAfterContent,
        summary: buildPatchSummary(beforeContent, normalizedAfterContent),
        source: options.source,
        saveOnApply: options.save,
      });
    },
    [createPatchPreview, t],
  );

  const previewActiveFilePatch = useCallback(
    (args: {
      oldText: string;
      newText: string;
      expectedOccurrences: number | null;
      replaceAll: boolean;
      save: boolean;
      source: PatchPreviewSource;
    }): PatchPreview | string => {
      const path = activePathRef.current;
      const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
      if (!path || !tab) return 'error: no active file';
      if (!args.oldText) return 'error: missing old_text';

      const beforeContent = normalizeEditorContent(tab.content);
      const occurrences = countOccurrences(beforeContent, args.oldText);
      if (occurrences === 0) return 'error: old_text not found';
      if (args.expectedOccurrences !== null && occurrences !== args.expectedOccurrences) {
        return `error: expected ${args.expectedOccurrences} occurrence(s), found ${occurrences}`;
      }

      const afterContent = args.replaceAll
        ? beforeContent.split(args.oldText).join(args.newText)
        : replaceOnce(beforeContent, args.oldText, args.newText);
      if (beforeContent === afterContent) return 'error: preview would not change the file';

      return createPatchPreview({
        path,
        beforeContent,
        afterContent,
        summary: buildPatchSummary(beforeContent, afterContent),
        source: args.source,
        saveOnApply: args.save,
        occurrences,
        replaced: args.replaceAll ? occurrences : 1,
      });
    },
    [createPatchPreview],
  );

  const previewActiveSelectionReplacement = useCallback(
    (
      replacement: string,
      options: { source: PatchPreviewSource; save: boolean },
    ): PatchPreview | string => {
      const path = activePathRef.current;
      const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
      const selection = editorSelectionRef.current;
      if (!path || !tab) {
        return 'error: no active file';
      }
      if (!selection) {
        return 'error: no active selection';
      }

      const beforeContent = normalizeEditorContent(tab.content);
      const afterContent = replaceSelectionRange(beforeContent, selection, replacement);
      if (beforeContent === afterContent) {
        return 'error: selection replacement would not change the file';
      }

      return createPatchPreview({
        path,
        beforeContent,
        afterContent,
        summary: `selection ${buildPatchSummary(beforeContent, afterContent)}`,
        source: options.source,
        saveOnApply: options.save,
      });
    },
    [createPatchPreview],
  );

  const replaceActiveSelectionFromAgent = useCallback(
    async (
      replacement: string,
      options: { save: boolean },
    ): Promise<{
      ok: boolean;
      path?: string;
      saved?: boolean;
      lineCount?: number;
      charCount?: number;
      selectionCharCount?: number;
      error?: string;
    }> => {
      const path = activePathRef.current;
      const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
      const selection = editorSelectionRef.current;
      if (!path || !tab) {
        return { ok: false, error: 'no active file' };
      }
      if (!selection) {
        return { ok: false, error: 'no active selection' };
      }

      const beforeContent = normalizeEditorContent(tab.content);
      const afterContent = replaceSelectionRange(beforeContent, selection, replacement);
      if (beforeContent === afterContent) {
        return { ok: false, path, error: 'selection replacement would not change the file' };
      }

      const result = await setActiveFileContentFromAgent(afterContent, options);
      clearEditorSelection();
      return result.ok
        ? { ...result, selectionCharCount: selection.charCount }
        : { ...result, selectionCharCount: selection.charCount };
    },
    [clearEditorSelection, setActiveFileContentFromAgent],
  );

  const applyPatchPreview = useCallback(async (): Promise<PatchPreview | null> => {
    const preview = patchPreview;
    if (!preview) return null;

    setOpenTabs((prev) =>
      prev.some((tab) => tab.path === preview.path)
        ? prev.map((tab) =>
            tab.path === preview.path ? { ...tab, content: preview.afterContent } : tab,
          )
        : [
            ...prev,
            {
              path: preview.path,
              content: preview.afterContent,
              savedContent: preview.beforeContent,
              language: detectMonacoLanguage(preview.path),
            },
          ],
    );
    setActivePath(preview.path);
    clearEditorSelection();

    if (!preview.saveOnApply) {
      setPatchPreview(null);
      setErrorText(null);
      return preview;
    }

    setIsSaving(true);
    try {
      await saveFileContent(preview.path, preview.afterContent);
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.path === preview.path
            ? { ...tab, content: preview.afterContent, savedContent: preview.afterContent }
            : tab,
        ),
      );
      const parentPath = getParentPath(preview.path);
      if (tree[parentPath]) {
        await loadDirectory(parentPath);
      }
      setPatchPreview(null);
      setErrorText(null);
      return preview;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      return null;
    } finally {
      setIsSaving(false);
    }
  }, [clearEditorSelection, loadDirectory, patchPreview, saveFileContent, tree]);

  const discardPatchPreview = useCallback(() => {
    setPatchPreview(null);
    setErrorText(null);
  }, []);

  const configureMonaco = useCallback((monacoInstance: MonacoBeforeMount) => {
    monacoInstance.editor.defineTheme('openroom-vscode', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: 'd7dde8' },
        { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
        { token: 'keyword', foreground: '7dd3fc' },
        { token: 'string', foreground: '86efac' },
        { token: 'number', foreground: 'fdba74' },
        { token: 'type', foreground: 'c4b5fd' },
        { token: 'function', foreground: 'fcd34d' },
      ],
      colors: {
        'editor.background': '#0f1117',
        'editor.foreground': '#d7dde8',
        'editorLineNumber.foreground': '#515969',
        'editorLineNumber.activeForeground': '#c9d1d9',
        'editorCursor.foreground': '#f8fafc',
        'editor.selectionBackground': '#264f78',
        'editor.inactiveSelectionBackground': '#1f3548',
        'editor.lineHighlightBackground': '#1b2230',
        'editorLineNumber.dimmedForeground': '#343a46',
        'editorIndentGuide.background1': '#252b36',
        'editorIndentGuide.activeBackground1': '#465063',
        'minimap.background': '#0f1117',
      },
    });
  }, []);

  const handleEditorMount: OnMount = useCallback(
    (editor, monacoInstance) => {
      editorRef.current = editor;
      editor.onDidChangeCursorPosition((event) => {
        setCursorPosition({ line: event.position.lineNumber, column: event.position.column });
      });
      editor.onDidChangeCursorSelection(() => {
        syncEditorSelection(editor);
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        void saveCurrentFile();
      });
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyP, () => {
        setShowCommandPalette(true);
      });
      const pendingLine = pendingRevealLineRef.current;
      if (pendingLine) {
        pendingRevealLineRef.current = null;
        revealLine(pendingLine);
      }
      syncEditorSelection(editor);
    },
    [revealLine, saveCurrentFile, syncEditorSelection],
  );

  const openSearchResult = useCallback(
    async (match: SearchMatch, line?: number) => {
      if (match.type !== 'file') return;
      setActivityView('search');
      setIsSidebarOpen(true);
      await loadFile(match.path, line);
    },
    [loadFile],
  );

  const focusSearch = useCallback(() => {
    setActivityView('search');
    setIsSidebarOpen(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const executePaletteCommand = useCallback(
    async (id: string) => {
      setShowCommandPalette(false);
      setCommandQuery('');
      if (id === 'save') {
        await saveCurrentFile();
      } else if (id === 'saveAll') {
        await saveAllFiles();
      } else if (id === 'refresh') {
        await refreshWorkspace();
      } else if (id === 'search') {
        focusSearch();
      } else if (id === 'source') {
        setActivityView('source');
        setIsSidebarOpen(true);
        await loadGitStatus();
      } else if (id === 'refreshGit') {
        setActivityView('source');
        setIsSidebarOpen(true);
        await loadGitStatus();
      } else if (id === 'settings') {
        setActivityView('settings');
        setIsSidebarOpen(true);
      } else if (id === 'newFile') {
        setActivityView('explorer');
        setIsSidebarOpen(true);
        setShowCreateFile(true);
      } else if (id === 'terminal') {
        setIsBottomPanelOpen(true);
        setBottomPanel('terminal');
        window.requestAnimationFrame(() => terminalInputRef.current?.focus());
      } else if (id === 'diagnostics') {
        setIsBottomPanelOpen(true);
        setBottomPanel('problems');
        window.requestAnimationFrame(() => diagnosticsInputRef.current?.focus());
      } else if (id === 'actions') {
        setIsBottomPanelOpen(true);
        setBottomPanel('actions');
      } else if (id === 'previewPanel') {
        setIsBottomPanelOpen(true);
        setBottomPanel('preview');
      } else if (id === 'gitPanel') {
        setIsBottomPanelOpen(true);
        setBottomPanel('git');
      } else if (id === 'split') {
        setIsSplitView((prev) => !prev);
      } else if (id === 'toggleSidebar') {
        setIsSidebarOpen((prev) => !prev);
      } else if (id === 'toggleBottomPanel') {
        setIsBottomPanelOpen((prev) => !prev);
      } else if (id === 'previewUnsaved') {
        previewUnsavedActiveFile();
      } else if (id === 'build') {
        await runTerminalCommand('pnpm build');
      }
    },
    [
      focusSearch,
      loadGitStatus,
      previewUnsavedActiveFile,
      refreshWorkspace,
      runTerminalCommand,
      saveAllFiles,
      saveCurrentFile,
    ],
  );

  const commandItems = useMemo<CommandPaletteItem[]>(
    () => [
      {
        id: 'save',
        kind: 'command',
        label: t('commandPalette.commands.save'),
        group: t('commandPalette.groups.file'),
        shortcut: 'Ctrl+S',
      },
      {
        id: 'saveAll',
        kind: 'command',
        label: t('commandPalette.commands.saveAll'),
        group: t('commandPalette.groups.file'),
      },
      {
        id: 'refresh',
        kind: 'command',
        label: t('commandPalette.commands.refresh'),
        group: t('commandPalette.groups.workspace'),
      },
      {
        id: 'search',
        kind: 'command',
        label: t('commandPalette.commands.search'),
        group: t('commandPalette.groups.workspace'),
        shortcut: 'Ctrl+F',
      },
      {
        id: 'source',
        kind: 'command',
        label: t('commandPalette.commands.source'),
        group: t('commandPalette.groups.source'),
      },
      {
        id: 'refreshGit',
        kind: 'command',
        label: t('commandPalette.commands.refreshGit'),
        group: t('commandPalette.groups.source'),
      },
      {
        id: 'terminal',
        kind: 'command',
        label: t('commandPalette.commands.terminal'),
        group: t('commandPalette.groups.panel'),
        shortcut: 'Ctrl+`',
      },
      {
        id: 'diagnostics',
        kind: 'command',
        label: t('commandPalette.commands.diagnostics'),
        group: t('commandPalette.groups.panel'),
      },
      {
        id: 'actions',
        kind: 'command',
        label: t('commandPalette.commands.actions'),
        group: t('commandPalette.groups.panel'),
      },
      {
        id: 'previewPanel',
        kind: 'command',
        label: t('commandPalette.commands.previewPanel'),
        group: t('commandPalette.groups.panel'),
      },
      {
        id: 'gitPanel',
        kind: 'command',
        label: t('commandPalette.commands.gitPanel'),
        group: t('commandPalette.groups.panel'),
      },
      {
        id: 'newFile',
        kind: 'command',
        label: t('commandPalette.commands.newFile'),
        group: t('commandPalette.groups.file'),
      },
      {
        id: 'split',
        kind: 'command',
        label: t('commandPalette.commands.split'),
        group: t('commandPalette.groups.view'),
      },
      {
        id: 'toggleSidebar',
        kind: 'command',
        label: t('commandPalette.commands.toggleSidebar'),
        group: t('commandPalette.groups.view'),
        shortcut: 'Ctrl+B',
      },
      {
        id: 'toggleBottomPanel',
        kind: 'command',
        label: t('commandPalette.commands.toggleBottomPanel'),
        group: t('commandPalette.groups.view'),
        shortcut: 'Ctrl+J',
      },
      {
        id: 'previewUnsaved',
        kind: 'command',
        label: t('commandPalette.commands.previewUnsaved'),
        group: t('commandPalette.groups.file'),
      },
      {
        id: 'settings',
        kind: 'command',
        label: t('commandPalette.commands.settings'),
        group: t('commandPalette.groups.workspace'),
      },
      {
        id: 'build',
        kind: 'command',
        label: t('commandPalette.commands.build'),
        group: t('commandPalette.groups.tasks'),
      },
    ],
    [t],
  );

  const openTabPaletteItems = useMemo<CommandPaletteItem[]>(
    () =>
      openTabs.map((tab) => ({
        id: `tab:${tab.path}`,
        kind: 'tab',
        label: getFileName(tab.path),
        group: t('commandPalette.groups.openEditors'),
        description: tab.path,
        path: tab.path,
      })),
    [openTabs, t],
  );

  const loadedFilePaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const filesByPath = new Map<string, WorkspaceEntry>();
    Object.values(tree).forEach((entries) => {
      entries.forEach((entry) => {
        if (entry.type === 'file') {
          filesByPath.set(entry.path, entry);
        }
      });
    });

    return Array.from(filesByPath.values())
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 80)
      .map((entry) => ({
        id: `file:${entry.path}`,
        kind: 'file',
        label: entry.name,
        group: t('commandPalette.groups.files'),
        description: entry.path,
        path: entry.path,
      }));
  }, [t, tree]);

  const paletteItems = useMemo(
    () => [...commandItems, ...openTabPaletteItems, ...loadedFilePaletteItems],
    [commandItems, loadedFilePaletteItems, openTabPaletteItems],
  );

  const filteredPaletteItems = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    return paletteItems.filter((item) => paletteMatches(item, query)).slice(0, 40);
  }, [commandQuery, paletteItems]);

  const executePaletteItem = useCallback(
    async (item: CommandPaletteItem) => {
      setShowCommandPalette(false);
      setCommandQuery('');
      setSelectedPaletteIndex(0);

      if (item.kind === 'command') {
        await executePaletteCommand(item.id);
        return;
      }

      if (!item.path) {
        return;
      }

      if (item.kind === 'tab') {
        setActivePath(item.path);
        editorRef.current?.focus();
        return;
      }

      await loadFile(item.path);
    },
    [executePaletteCommand, loadFile],
  );

  const problemItems = useMemo<ProblemItem[]>(() => {
    const items: ProblemItem[] = [...diagnosticItems];
    if (errorText) {
      items.push({ severity: 'error', source: 'OpenRoom IDE', message: errorText });
    }
    dirtyTabs.forEach((tab) => {
      items.push({
        severity: 'warning',
        source: 'Workspace',
        message: t('problems.unsavedFile'),
        path: tab.path,
      });
    });
    const lastFailedCommand = terminalHistory.find((entry) => entry.exitCode !== 0);
    if (lastFailedCommand) {
      items.push({
        severity: 'error',
        source: 'Terminal',
        message: t('problems.commandFailed', { command: lastFailedCommand.command }),
      });
    }
    return items;
  }, [diagnosticItems, dirtyTabs, errorText, t, terminalHistory]);

  const outputLines = useMemo(
    () => [
      `${t('output.workspace')}: ${workspaceRoot || t('output.notReady')}`,
      `${t('output.openTabs')}: ${openTabs.length}`,
      `${t('output.dirtyTabs')}: ${dirtyTabs.length}`,
      `${t('output.searchMatches')}: ${searchResult?.total_matches ?? 0}`,
      `${t('output.branch')}: ${gitBranch}`,
      `${t('output.gitChanges')}: ${gitStatusEntries.length}`,
      `${t('output.modelActions')}: ${modelActionLog.length}`,
      `${t('output.diagnostics')}: ${
        lastDiagnosticRun
          ? t('diagnostics.summary', {
              count: lastDiagnosticRun.diagnosticCount,
              code: lastDiagnosticRun.exitCode,
              ms: lastDiagnosticRun.durationMs,
            })
          : t('diagnostics.notRun')
      }`,
    ],
    [
      dirtyTabs.length,
      gitBranch,
      gitStatusEntries.length,
      lastDiagnosticRun,
      modelActionLog.length,
      openTabs.length,
      searchResult?.total_matches,
      t,
      workspaceRoot,
    ],
  );

  const captureUndoSnapshotForAction = useCallback(
    (action: CharacterAppAction): ModelActionUndoSnapshot | null => {
      if (action.action_type === 'APPLY_ACTIVE_FILE_PREVIEW') {
        return patchPreview
          ? {
              path: patchPreview.path,
              beforeContent: normalizeEditorContent(patchPreview.beforeContent),
              saveOnUndo: patchPreview.saveOnApply,
            }
          : null;
      }

      const reversibleActiveActions = new Set([
        'APPEND_ACTIVE_FILE',
        'PATCH_ACTIVE_FILE',
        'REPLACE_ACTIVE_FILE',
        'REPLACE_ACTIVE_SELECTION',
      ]);
      if (!reversibleActiveActions.has(action.action_type)) {
        return null;
      }

      const path = activePathRef.current;
      const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
      if (!path || !tab) {
        return null;
      }

      return {
        path,
        beforeContent: normalizeEditorContent(tab.content),
        saveOnUndo: parseActionBoolean(action.params?.save, true),
      };
    },
    [patchPreview],
  );

  const recordModelAction = useCallback(
    (
      action: CharacterAppAction,
      result: string,
      startedAt: number,
      undoSnapshot: ModelActionUndoSnapshot | null,
    ) => {
      const status: ModelActionStatus = /^error:/i.test(result) ? 'error' : 'success';
      const path = undoSnapshot?.path ?? getActionPathFromResult(result);
      const entry: ModelActionLogEntry = {
        id: createModelActionId(),
        actionType: action.action_type,
        status,
        path,
        summary: status === 'success' ? action.action_type : result.replace(/^error:\s*/i, ''),
        resultPreview: buildActionResultPreview(result),
        createdAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        reversible: status === 'success' && !!undoSnapshot,
        undone: false,
        ...(status === 'success' && undoSnapshot ? { undoSnapshot } : {}),
      };
      setModelActionLog((prev) => [entry, ...prev].slice(0, 60));
    },
    [],
  );

  const undoModelAction = useCallback(
    async (actionId?: string): Promise<string> => {
      const entry = modelActionLog.find(
        (item) =>
          item.reversible &&
          !item.undone &&
          !!item.undoSnapshot &&
          (!actionId || item.id === actionId),
      );
      if (!entry?.undoSnapshot) {
        return 'error: no reversible model action';
      }

      const snapshot = entry.undoSnapshot;
      if (snapshot.saveOnUndo) {
        setIsSaving(true);
        try {
          await saveFileContent(snapshot.path, snapshot.beforeContent);
          const parentPath = getParentPath(snapshot.path);
          if (tree[parentPath]) {
            await loadDirectory(parentPath);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setModelActionLog((prev) =>
            prev.map((item) => (item.id === entry.id ? { ...item, undoError: message } : item)),
          );
          setErrorText(message);
          return `error: ${message}`;
        } finally {
          setIsSaving(false);
        }
      }

      setOpenTabs((prev) => {
        const existing = prev.find((tab) => tab.path === snapshot.path);
        if (existing) {
          return prev.map((tab) =>
            tab.path === snapshot.path
              ? {
                  ...tab,
                  content: snapshot.beforeContent,
                  savedContent: snapshot.saveOnUndo ? snapshot.beforeContent : tab.savedContent,
                }
              : tab,
          );
        }

        return [
          ...prev,
          {
            path: snapshot.path,
            content: snapshot.beforeContent,
            savedContent: snapshot.beforeContent,
            language: detectMonacoLanguage(snapshot.path),
          },
        ];
      });
      setActivePath(snapshot.path);
      clearEditorSelection();
      setPatchPreview(null);
      setModelActionLog((prev) =>
        prev.map((item) => (item.id === entry.id ? { ...item, undone: true } : item)),
      );
      setIsBottomPanelOpen(true);
      setBottomPanel('actions');
      setErrorText(null);

      return JSON.stringify({
        undone_action_id: entry.id,
        action_type: entry.actionType,
        path: snapshot.path,
        saved: snapshot.saveOnUndo,
      });
    },
    [clearEditorSelection, loadDirectory, modelActionLog, saveFileContent, tree],
  );

  const executeOpenVscodeAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'OPEN_FILE': {
          const path = action.params?.path?.trim();
          if (!path) return 'error: missing path';
          await loadFile(path);
          return 'success';
        }
        case 'REFRESH_WORKSPACE': {
          await refreshWorkspace();
          return 'success';
        }
        case 'CREATE_FILE': {
          const path = action.params?.path?.trim();
          if (!path) return 'error: missing path';
          const result = await createNewFile(path);
          return result.ok ? 'success' : `error: ${result.error || 'create failed'}`;
        }
        case 'PREVIEW_APPEND_ACTIVE_FILE': {
          const content = action.params?.content;
          if (content === undefined) return 'error: missing content';
          const path = activePathRef.current;
          const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
          if (!path || !tab) return 'error: no active file';
          const position = action.params?.position === 'start' ? 'start' : 'end';
          const separator = action.params?.separator ?? '\n';
          const save = parseActionBoolean(action.params?.save, true);
          const currentContent = normalizeEditorContent(tab.content);
          const nextContent =
            position === 'start'
              ? `${content}${currentContent ? separator : ''}${currentContent}`
              : `${currentContent}${currentContent ? separator : ''}${content}`;
          const preview = previewActiveFileReplacement(nextContent, { source: 'agent', save });
          return preview
            ? JSON.stringify({
                preview_id: preview.id,
                path: preview.path,
                summary: preview.summary,
                save_on_apply: preview.saveOnApply,
              })
            : 'error: preview failed';
        }
        case 'PREVIEW_PATCH_ACTIVE_FILE': {
          const oldText = action.params?.old_text ?? action.params?.oldText ?? '';
          const newText = action.params?.new_text ?? action.params?.newText ?? '';
          const expectedOccurrences = parseOptionalPositiveInteger(
            action.params?.expected_occurrences ?? action.params?.expectedOccurrences,
          );
          const replaceAll = parseActionBoolean(
            action.params?.replace_all ?? action.params?.replaceAll,
            false,
          );
          const save = parseActionBoolean(action.params?.save, true);
          const preview = previewActiveFilePatch({
            oldText,
            newText,
            expectedOccurrences,
            replaceAll,
            save,
            source: 'agent',
          });
          return typeof preview === 'string'
            ? preview
            : JSON.stringify({
                preview_id: preview.id,
                path: preview.path,
                summary: preview.summary,
                occurrences: preview.occurrences,
                replaced: preview.replaced,
                save_on_apply: preview.saveOnApply,
              });
        }
        case 'PREVIEW_REPLACE_ACTIVE_FILE': {
          if (!action.params || !Object.prototype.hasOwnProperty.call(action.params, 'content')) {
            return 'error: missing content';
          }
          const save = parseActionBoolean(action.params.save, true);
          const preview = previewActiveFileReplacement(action.params.content ?? '', {
            source: 'agent',
            save,
          });
          return preview
            ? JSON.stringify({
                preview_id: preview.id,
                path: preview.path,
                summary: preview.summary,
                save_on_apply: preview.saveOnApply,
              })
            : 'error: preview failed';
        }
        case 'PREVIEW_REPLACE_ACTIVE_SELECTION': {
          if (!action.params || !Object.prototype.hasOwnProperty.call(action.params, 'content')) {
            return 'error: missing content';
          }
          const save = parseActionBoolean(action.params.save, true);
          const preview = previewActiveSelectionReplacement(action.params.content ?? '', {
            source: 'agent',
            save,
          });
          return typeof preview === 'string'
            ? preview
            : JSON.stringify({
                preview_id: preview.id,
                path: preview.path,
                summary: preview.summary,
                save_on_apply: preview.saveOnApply,
              });
        }
        case 'APPLY_ACTIVE_FILE_PREVIEW': {
          const applied = await applyPatchPreview();
          return applied
            ? JSON.stringify({
                preview_id: applied.id,
                path: applied.path,
                saved: applied.saveOnApply,
                summary: applied.summary,
              })
            : 'error: no preview to apply';
        }
        case 'DISCARD_ACTIVE_FILE_PREVIEW': {
          if (!patchPreview) return 'error: no preview to discard';
          discardPatchPreview();
          return 'success';
        }
        case 'APPEND_ACTIVE_FILE': {
          const content = action.params?.content;
          if (content === undefined) return 'error: missing content';
          const path = activePathRef.current;
          const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
          if (!path || !tab) return 'error: no active file';
          const position = action.params?.position === 'start' ? 'start' : 'end';
          const separator = action.params?.separator ?? '\n';
          const save = parseActionBoolean(action.params?.save, true);
          const currentContent = normalizeEditorContent(tab.content);
          const nextContent =
            position === 'start'
              ? `${content}${currentContent ? separator : ''}${currentContent}`
              : `${currentContent}${currentContent ? separator : ''}${content}`;
          const result = await setActiveFileContentFromAgent(nextContent, { save });
          return result.ok ? JSON.stringify(result) : `error: ${result.error || 'append failed'}`;
        }
        case 'PATCH_ACTIVE_FILE': {
          const oldText = action.params?.old_text ?? action.params?.oldText ?? '';
          const newText = action.params?.new_text ?? action.params?.newText ?? '';
          if (!oldText) return 'error: missing old_text';
          const path = activePathRef.current;
          const tab = path ? openTabsRef.current.find((item) => item.path === path) : null;
          if (!path || !tab) return 'error: no active file';
          const currentContent = normalizeEditorContent(tab.content);
          const occurrences = countOccurrences(currentContent, oldText);
          if (occurrences === 0) return 'error: old_text not found';
          const expectedOccurrences = parseOptionalPositiveInteger(
            action.params?.expected_occurrences ?? action.params?.expectedOccurrences,
          );
          if (expectedOccurrences !== null && occurrences !== expectedOccurrences) {
            return `error: expected ${expectedOccurrences} occurrence(s), found ${occurrences}`;
          }
          const replaceAll = parseActionBoolean(
            action.params?.replace_all ?? action.params?.replaceAll,
            false,
          );
          const save = parseActionBoolean(action.params?.save, true);
          const nextContent = replaceAll
            ? currentContent.split(oldText).join(newText)
            : currentContent.replace(oldText, newText);
          const result = await setActiveFileContentFromAgent(nextContent, { save });
          return result.ok
            ? JSON.stringify({ ...result, occurrences, replaced: replaceAll ? occurrences : 1 })
            : `error: ${result.error || 'patch failed'}`;
        }
        case 'REPLACE_ACTIVE_FILE': {
          if (!action.params || !Object.prototype.hasOwnProperty.call(action.params, 'content')) {
            return 'error: missing content';
          }
          const save = parseActionBoolean(action.params.save, true);
          const result = await setActiveFileContentFromAgent(action.params.content ?? '', {
            save,
          });
          return result.ok ? JSON.stringify(result) : `error: ${result.error || 'replace failed'}`;
        }
        case 'REPLACE_ACTIVE_SELECTION': {
          if (!action.params || !Object.prototype.hasOwnProperty.call(action.params, 'content')) {
            return 'error: missing content';
          }
          const save = parseActionBoolean(action.params.save, true);
          const result = await replaceActiveSelectionFromAgent(action.params.content ?? '', {
            save,
          });
          return result.ok
            ? JSON.stringify(result)
            : `error: ${result.error || 'selection replace failed'}`;
        }
        case 'SAVE_FILE': {
          await saveCurrentFile();
          return 'success';
        }
        case 'SEARCH_WORKSPACE': {
          const query = action.params?.query?.trim();
          if (!query) return 'error: missing query';
          setActivityView('search');
          setIsSidebarOpen(true);
          setSearchQuery(query);
          await runSearch(query);
          return 'success';
        }
        case 'REFRESH_GIT_STATUS': {
          setActivityView('source');
          setIsSidebarOpen(true);
          const entries = await loadGitStatus();
          return JSON.stringify({ changed_files: entries.length });
        }
        case 'RUN_COMMAND': {
          const command = action.params?.command?.trim();
          if (!command) return 'error: missing command';
          setIsBottomPanelOpen(true);
          setBottomPanel('terminal');
          const result = await runTerminalCommand(command);
          return result && result.exitCode === 0 ? 'success' : 'error: command failed';
        }
        case 'RUN_DIAGNOSTICS': {
          const command = action.params?.command?.trim() || diagnosticCommand;
          if (!command.trim()) return 'error: missing command';
          const result = await runDiagnostics(command);
          return result
            ? JSON.stringify({
                command: result.command,
                exitCode: result.exitCode,
                diagnostic_count: result.diagnosticCount,
                timedOut: result.timedOut,
              })
            : 'error: diagnostics failed';
        }
        case 'UNDO_MODEL_ACTION': {
          return undoModelAction(action.params?.id?.trim());
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [
      applyPatchPreview,
      createNewFile,
      diagnosticCommand,
      discardPatchPreview,
      loadFile,
      loadGitStatus,
      patchPreview,
      previewActiveFilePatch,
      previewActiveFileReplacement,
      previewActiveSelectionReplacement,
      refreshWorkspace,
      replaceActiveSelectionFromAgent,
      runDiagnostics,
      runSearch,
      runTerminalCommand,
      saveCurrentFile,
      setActiveFileContentFromAgent,
      undoModelAction,
    ],
  );

  useAgentActionListener(
    APP_ID,
    useCallback(
      async (action: CharacterAppAction): Promise<string> => {
        const startedAt = Date.now();
        const undoSnapshot = captureUndoSnapshotForAction(action);
        const result = await executeOpenVscodeAction(action);
        recordModelAction(action, result, startedAt, undoSnapshot);
        return result;
      },
      [captureUndoSnapshotForAction, executeOpenVscodeAction, recordModelAction],
    ),
  );

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: "Aoi's IDE",
          windowStyle: DEFAULT_WINDOW_STYLE,
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: "Aoi's IDE",
          windowStyle: DEFAULT_WINDOW_STYLE,
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch(() => undefined);

        const persisted = await loadPersistedConfig();
        const configuredWorkspace = persisted?.openvscode?.workspacePath?.trim() || '';
        setWorkspaceDraft(configuredWorkspace);

        await refreshWorkspace();
        await loadGitBranch();
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        setIsLoading(false);
        setErrorText(error instanceof Error ? error.message : String(error));
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [loadGitBranch, refreshWorkspace]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isCommandKey = event.metaKey || event.ctrlKey;
      if (isCommandKey && key === 's') {
        event.preventDefault();
        void saveCurrentFile();
        return;
      }
      if (isCommandKey && key === 'p') {
        event.preventDefault();
        setShowCommandPalette(true);
        return;
      }
      if (isCommandKey && key === 'f') {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (isCommandKey && key === 'b') {
        event.preventDefault();
        setIsSidebarOpen((prev) => !prev);
        return;
      }
      if (isCommandKey && key === 'j') {
        event.preventDefault();
        setIsBottomPanelOpen((prev) => !prev);
        return;
      }
      if (isCommandKey && event.key === '`') {
        event.preventDefault();
        setIsBottomPanelOpen(true);
        setBottomPanel('terminal');
        window.requestAnimationFrame(() => terminalInputRef.current?.focus());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusSearch, saveCurrentFile]);

  useEffect(() => {
    if (!activeTab || !pendingRevealLineRef.current) return;
    const line = pendingRevealLineRef.current;
    pendingRevealLineRef.current = null;
    window.requestAnimationFrame(() => revealLine(line));
  }, [activeTab?.path, revealLine]);

  useEffect(() => {
    clearEditorSelection();
    if (!activeTab) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      syncEditorSelection();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab?.path, clearEditorSelection, syncEditorSelection]);

  useEffect(() => {
    if (!showCommandPalette) return;
    window.requestAnimationFrame(() => commandInputRef.current?.focus());
  }, [showCommandPalette]);

  useEffect(() => {
    setSelectedPaletteIndex(0);
  }, [commandQuery]);

  useEffect(() => {
    setSelectedPaletteIndex((prev) => {
      if (filteredPaletteItems.length === 0) {
        return 0;
      }
      return Math.min(prev, filteredPaletteItems.length - 1);
    });
  }, [filteredPaletteItems.length]);

  useEffect(() => {
    if (activityView !== 'search') return;
    const query = searchQuery.trim();
    if (query.length < 2) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runSearch(query);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activityView, runSearch, searchQuery]);

  const renderEntries = useCallback(
    (path: string, depth = 0): React.ReactNode => {
      const entries = tree[path] ?? [];
      return entries.map((entry) => {
        const isDir = entry.type === 'directory';
        const isExpanded = expandedDirs.includes(entry.path);
        const isActive = !isDir && activePath === entry.path;
        return (
          <div key={entry.path}>
            <button
              className={`${styles.treeItem} ${isActive ? styles.treeItemActive : ''}`}
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              onClick={() => {
                if (isDir) {
                  void toggleDirectory(entry.path);
                } else {
                  void loadFile(entry.path);
                }
              }}
              title={entry.path}
            >
              <span className={styles.treeIcon}>
                {isDir ? (
                  isExpanded ? (
                    <>
                      <ChevronDown size={13} />
                      <FolderOpen size={14} />
                    </>
                  ) : (
                    <>
                      <ChevronRight size={13} />
                      <FolderClosed size={14} />
                    </>
                  )
                ) : (
                  <FileCode2 size={14} />
                )}
              </span>
              <span className={styles.treeLabel}>{entry.name}</span>
              {!isDir && entry.size > 0 ? (
                <span className={styles.treeMeta}>{formatBytes(entry.size)}</span>
              ) : null}
            </button>
            {isDir && isExpanded ? renderEntries(entry.path, depth + 1) : null}
          </div>
        );
      });
    },
    [activePath, expandedDirs, loadFile, toggleDirectory, tree],
  );

  if (isLoading) {
    return <div className={styles.loading}>{t('loading')}</div>;
  }

  return (
    <div className={styles.page} data-testid="openvscode-page">
      <header className={styles.commandBar}>
        <div className={styles.windowBrand}>
          <span className={styles.brandMark}>
            <Box size={16} />
          </span>
          <strong>{t('title')}</strong>
        </div>
        <button className={styles.commandInputButton} onClick={() => setShowCommandPalette(true)}>
          <Search size={15} />
          <span>{t('commandPalette.placeholder')}</span>
          <kbd>Ctrl P</kbd>
        </button>
        <div className={styles.commandActions}>
          <button
            className={`${styles.iconAction} ${isSidebarOpen ? styles.iconActionActive : ''}`}
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            title={t('actions.toggleSidebar')}
            aria-pressed={isSidebarOpen}
            data-testid="openvscode-toggle-sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <button className={styles.iconAction} onClick={() => setIsSplitView((prev) => !prev)}>
            <SplitSquareHorizontal size={16} />
          </button>
          <button
            className={`${styles.iconAction} ${isBottomPanelOpen ? styles.iconActionActive : ''}`}
            onClick={() => setIsBottomPanelOpen((prev) => !prev)}
            title={t('actions.toggleBottomPanel')}
            aria-pressed={isBottomPanelOpen}
            data-testid="openvscode-toggle-bottom-panel"
          >
            <PanelBottom size={16} />
          </button>
          <button className={styles.iconAction} onClick={() => setActivityView('settings')}>
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      <div
        className={`${styles.workspaceShell} ${
          isSidebarOpen ? '' : styles.workspaceShellSidebarHidden
        }`}
      >
        <nav className={styles.activityBar} aria-label={t('activity.label')}>
          <button
            className={`${styles.activityButton} ${
              activityView === 'explorer' ? styles.activityButtonActive : ''
            }`}
            onClick={() => {
              setActivityView('explorer');
              setIsSidebarOpen(true);
            }}
            title={t('activity.explorer')}
          >
            <Files size={22} />
          </button>
          <button
            className={`${styles.activityButton} ${
              activityView === 'search' ? styles.activityButtonActive : ''
            }`}
            onClick={focusSearch}
            title={t('activity.search')}
          >
            <Search size={22} />
          </button>
          <button
            className={`${styles.activityButton} ${
              activityView === 'source' ? styles.activityButtonActive : ''
            }`}
            onClick={() => {
              setActivityView('source');
              setIsSidebarOpen(true);
              void loadGitStatus();
            }}
            title={t('activity.source')}
          >
            <GitBranch size={22} />
          </button>
          <button
            className={styles.activityButton}
            onClick={() => {
              setIsBottomPanelOpen(true);
              setBottomPanel('terminal');
            }}
            title={t('bottom.terminal')}
          >
            <TerminalSquare size={22} />
          </button>
          <button
            className={`${styles.activityButton} ${
              activityView === 'settings' ? styles.activityButtonActive : ''
            }`}
            onClick={() => {
              setActivityView('settings');
              setIsSidebarOpen(true);
            }}
            title={t('activity.settings')}
          >
            <Settings2 size={22} />
          </button>
        </nav>

        {isSidebarOpen ? (
          <aside className={styles.sidebar} data-testid="openvscode-sidebar">
            {activityView === 'explorer' ? (
              <>
                <div className={styles.sidebarHeader}>
                  <div className={styles.sidebarTitle}>
                    <span>{t('sidebar.explorer')}</span>
                    <small>
                      {isTreeLoading
                        ? t('actions.refreshing')
                        : workspaceExists
                          ? t('sidebar.ready')
                          : t('sidebar.notReady')}
                    </small>
                  </div>
                  <div className={styles.sidebarActions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => {
                        setShowCreateFile((prev) => !prev);
                        setCreateFileError(null);
                      }}
                      disabled={!workspaceExists}
                      title={t('actions.newFile')}
                    >
                      <FilePlus2 size={15} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => void refreshWorkspace()}
                      title={t('actions.refresh')}
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </div>
                <div className={styles.workspaceName} title={workspaceRoot}>
                  {workspaceRoot || t('title')}
                </div>
                {showCreateFile ? (
                  <form className={styles.createFileForm} onSubmit={submitCreateFile}>
                    <label className={styles.fieldLabel}>
                      <span>{t('createFile.label')}</span>
                      <input
                        className={styles.textInput}
                        value={newFilePath}
                        onChange={(event) => {
                          setNewFilePath(event.target.value);
                          setCreateFileError(null);
                        }}
                        placeholder={t('createFile.placeholder')}
                        disabled={isCreatingFile}
                        autoFocus
                      />
                    </label>
                    {createFileError ? (
                      <p className={styles.inlineError}>{createFileError}</p>
                    ) : null}
                    <div className={styles.formActions}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => {
                          setShowCreateFile(false);
                          setNewFilePath('');
                          setCreateFileError(null);
                        }}
                      >
                        {t('actions.cancel')}
                      </button>
                      <button
                        type="submit"
                        className={styles.primaryButton}
                        disabled={isCreatingFile || !newFilePath.trim()}
                      >
                        {isCreatingFile ? t('actions.creating') : t('actions.createFile')}
                      </button>
                    </div>
                  </form>
                ) : null}
                <div className={styles.tree}>{renderEntries('')}</div>
                <div className={styles.explorerSearchDock}>
                  <div className={styles.dockHeader}>
                    <span>{t('search.title')}</span>
                    <button type="button" onClick={focusSearch}>
                      {t('search.openFull')}
                    </button>
                  </div>
                  <input
                    className={styles.searchInput}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void runSearch();
                      }
                    }}
                    placeholder={t('search.placeholder')}
                  />
                  <div className={styles.dockResults}>
                    {searchResult ? (
                      <>
                        <span>
                          {t('search.summary', {
                            count: searchResult.total_matches,
                            files: searchResult.scanned_files,
                          })}
                        </span>
                        {searchResult.matches.slice(0, 3).map((match) => (
                          <button
                            key={`dock-${match.path}`}
                            onClick={() => void openSearchResult(match, match.snippets?.[0]?.line)}
                            disabled={match.type !== 'file'}
                            title={match.path}
                          >
                            {match.path}
                          </button>
                        ))}
                      </>
                    ) : (
                      <span>{t('search.dockHint')}</span>
                    )}
                  </div>
                </div>
              </>
            ) : null}

            {activityView === 'search' ? (
              <>
                <div className={styles.sidebarHeader}>
                  <div className={styles.sidebarTitle}>
                    <span>{t('search.title')}</span>
                    <small>{isSearching ? t('search.searching') : t('search.ready')}</small>
                  </div>
                </div>
                <div className={styles.searchPanel}>
                  <input
                    ref={searchInputRef}
                    className={styles.searchInput}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void runSearch();
                      }
                    }}
                    placeholder={t('search.placeholder')}
                  />
                  <div className={styles.segmented}>
                    {(['auto', 'path', 'content'] as const).map((mode) => (
                      <button
                        key={mode}
                        className={searchMode === mode ? styles.segmentedActive : ''}
                        onClick={() => setSearchMode(mode)}
                      >
                        {t(`search.modes.${mode}`)}
                      </button>
                    ))}
                  </div>
                  <button
                    className={styles.primaryButton}
                    onClick={() => void runSearch()}
                    disabled={!searchQuery.trim() || isSearching}
                  >
                    <Search size={15} />
                    <span>{isSearching ? t('search.searching') : t('search.run')}</span>
                  </button>
                </div>
                <div className={styles.searchResults}>
                  {searchResult ? (
                    <div className={styles.resultSummary}>
                      {t('search.summary', {
                        count: searchResult.total_matches,
                        files: searchResult.scanned_files,
                      })}
                    </div>
                  ) : null}
                  {searchResult?.matches.map((match) => (
                    <div className={styles.searchMatch} key={`${match.type}-${match.path}`}>
                      <button
                        className={styles.searchPath}
                        onClick={() => void openSearchResult(match, match.snippets?.[0]?.line)}
                        disabled={match.type !== 'file'}
                      >
                        <FileCode2 size={14} />
                        <span>{match.path}</span>
                      </button>
                      {match.snippets?.map((snippet) => (
                        <button
                          key={`${match.path}-${snippet.line}-${snippet.text}`}
                          className={styles.snippet}
                          onClick={() => void openSearchResult(match, snippet.line)}
                        >
                          <span>{snippet.line}</span>
                          <code>{snippet.text}</code>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {activityView === 'source' ? (
              <>
                <div className={styles.sidebarHeader}>
                  <div className={styles.sidebarTitle}>
                    <span>{t('source.title')}</span>
                    <small>
                      {isGitLoading
                        ? t('actions.refreshing')
                        : t('source.changeCount', { count: gitStatusEntries.length })}
                    </small>
                  </div>
                  <div className={styles.sidebarActions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => void loadGitStatus()}
                      title={t('actions.refresh')}
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </div>
                <div className={styles.sourcePanel}>
                  {gitErrorText ? <p className={styles.inlineError}>{gitErrorText}</p> : null}
                  {gitStatusEntries.length === 0 && !gitErrorText ? (
                    <div className={styles.panelEmpty}>{t('source.clean')}</div>
                  ) : null}
                  {gitStatusEntries.map((entry) => (
                    <button
                      key={`${entry.raw}-${entry.path}`}
                      className={`${styles.sourceItem} ${
                        selectedGitPath === entry.path ? styles.sourceItemActive : ''
                      }`}
                      onClick={() => void openGitStatusEntry(entry)}
                      title={
                        entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path
                      }
                    >
                      <span>{getGitStatusLabel(entry)}</span>
                      <strong>{getFileName(entry.path)}</strong>
                      <small>{entry.path}</small>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {activityView === 'settings' ? (
              <div className={styles.settingsPanel}>
                <div className={styles.sidebarHeader}>
                  <div className={styles.sidebarTitle}>
                    <span>{t('settings.title')}</span>
                    <small>{t('activity.settings')}</small>
                  </div>
                </div>
                <p className={styles.settingsDescription}>{t('settings.description')}</p>
                <label className={styles.fieldLabel}>
                  <span>{t('settings.workspacePath')}</span>
                  <input
                    className={styles.textInput}
                    value={workspaceDraft}
                    onChange={(event) => setWorkspaceDraft(event.target.value)}
                    placeholder={t('settings.workspacePlaceholder')}
                  />
                </label>
                <button className={styles.primaryButton} onClick={() => void saveWorkspacePath()}>
                  <Save size={15} />
                  <span>{t('actions.saveWorkspace')}</span>
                </button>
                {!workspaceExists ? (
                  <p className={styles.inlineError}>{t('errors.workspaceMissing')}</p>
                ) : null}
                {errorText ? <p className={styles.inlineError}>{errorText}</p> : null}
              </div>
            ) : null}
          </aside>
        ) : null}

        <main className={styles.editorArea}>
          <div className={styles.tabStrip}>
            {openTabs.length === 0 ? (
              <span className={styles.noTabs}>{t('editor.noOpenEditors')}</span>
            ) : (
              openTabs.map((tab) => {
                const tabDirty =
                  normalizeEditorContent(tab.content) !== normalizeEditorContent(tab.savedContent);
                return (
                  <button
                    key={tab.path}
                    className={`${styles.tab} ${activePath === tab.path ? styles.tabActive : ''}`}
                    onClick={() => setActivePath(tab.path)}
                    title={tab.path}
                  >
                    <span className={styles.tabLang}>{getFileExtensionLabel(tab.path)}</span>
                    <span className={styles.tabName}>{getFileName(tab.path)}</span>
                    {tabDirty ? <span className={styles.dirtyDot} /> : null}
                    <span
                      className={styles.tabClose}
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.path);
                      }}
                    >
                      <X size={13} />
                    </span>
                  </button>
                );
              })
            )}
            <div className={styles.tabActions}>
              <button
                className={styles.toolbarButton}
                onClick={previewUnsavedActiveFile}
                disabled={!activeTab || !isDirty}
                title={t('actions.previewChanges')}
              >
                <GitCompareArrows size={15} />
              </button>
              <button
                className={styles.toolbarButton}
                onClick={() => void saveCurrentFile()}
                disabled={!activeTab || !isDirty || isSaving}
                title={t('actions.save')}
              >
                <Save size={15} />
              </button>
              <button
                className={styles.toolbarButton}
                onClick={() => void saveAllFiles()}
                disabled={dirtyTabs.length === 0 || isSaving}
                title={t('actions.saveAll')}
              >
                <CheckCircle2 size={15} />
              </button>
            </div>
          </div>

          <div className={styles.breadcrumbs}>
            {activePath ? (
              activePath.split('/').map((part, index, parts) => (
                <React.Fragment key={`${part}-${index}`}>
                  <span>{part}</span>
                  {index < parts.length - 1 ? <ChevronRight size={13} /> : null}
                </React.Fragment>
              ))
            ) : (
              <span>{t('empty.title')}</span>
            )}
          </div>

          <section
            className={`${styles.editorStage} ${
              isBottomPanelOpen ? styles.editorStageWithPanel : ''
            }`}
            data-testid="openvscode-editor"
          >
            {activeTab ? (
              <>
                <div
                  className={`${styles.editorGrid} ${isSplitView ? styles.editorGridSplit : ''}`}
                >
                  <div className={styles.monacoPane}>
                    {isFileLoading ? (
                      <div className={styles.emptyState}>{t('editor.loading')}</div>
                    ) : (
                      <Editor
                        beforeMount={configureMonaco}
                        onMount={handleEditorMount}
                        path={activeTab.path}
                        value={activeTab.content}
                        language={activeTab.language}
                        theme="openroom-vscode"
                        onChange={(value) => {
                          updateActiveTabContent(value ?? '');
                          window.requestAnimationFrame(() => syncEditorSelection());
                        }}
                        options={{
                          automaticLayout: true,
                          fontFamily:
                            "'Cascadia Code', 'JetBrains Mono', 'IBM Plex Mono', Consolas, monospace",
                          fontSize: 13.5,
                          lineHeight: 22,
                          fontLigatures: true,
                          minimap: { enabled: true, side: 'right', size: 'proportional' },
                          scrollBeyondLastLine: false,
                          smoothScrolling: true,
                          cursorBlinking: 'phase',
                          renderLineHighlight: 'all',
                          roundedSelection: false,
                          tabSize: 2,
                          padding: { top: 14, bottom: 18 },
                          overviewRulerBorder: false,
                          bracketPairColorization: { enabled: true },
                          guides: { bracketPairs: true, indentation: true },
                        }}
                      />
                    )}
                  </div>
                  {isSplitView ? (
                    <div className={styles.monacoPane}>
                      <Editor
                        beforeMount={configureMonaco}
                        path={`${activeTab.path}:preview`}
                        value={activeTab.content}
                        language={activeTab.language}
                        theme="openroom-vscode"
                        options={{
                          readOnly: true,
                          automaticLayout: true,
                          fontFamily:
                            "'Cascadia Code', 'JetBrains Mono', 'IBM Plex Mono', Consolas, monospace",
                          fontSize: 13.5,
                          lineHeight: 22,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          renderLineHighlight: 'all',
                          padding: { top: 14, bottom: 18 },
                        }}
                      />
                    </div>
                  ) : null}
                </div>

                {isBottomPanelOpen ? (
                  <div className={styles.bottomPanel} data-testid="openvscode-bottom-panel">
                    <div className={styles.bottomTabs}>
                      {(
                        ['problems', 'output', 'preview', 'actions', 'git', 'terminal'] as const
                      ).map((panel) => (
                        <button
                          key={panel}
                          className={bottomPanel === panel ? styles.bottomTabActive : ''}
                          onClick={() => setBottomPanel(panel)}
                        >
                          {t(`bottom.${panel}`)}
                          {panel === 'problems' && problemItems.length > 0 ? (
                            <span>{problemItems.length}</span>
                          ) : null}
                          {panel === 'preview' && patchPreview ? <span>1</span> : null}
                          {panel === 'actions' && modelActionLog.length > 0 ? (
                            <span>{modelActionLog.length}</span>
                          ) : null}
                          {panel === 'git' && gitStatusEntries.length > 0 ? (
                            <span>{gitStatusEntries.length}</span>
                          ) : null}
                        </button>
                      ))}
                      <button
                        className={styles.panelClose}
                        onClick={() => setIsBottomPanelOpen(false)}
                        title={t('actions.closePanel')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div className={styles.bottomContent}>
                      {bottomPanel === 'problems' ? (
                        <div className={styles.problemList}>
                          <form
                            className={styles.diagnosticsToolbar}
                            onSubmit={(event) => {
                              event.preventDefault();
                              void runDiagnostics();
                            }}
                          >
                            <div className={styles.diagnosticsInputRow}>
                              <span>{t('diagnostics.label')}</span>
                              <input
                                ref={diagnosticsInputRef}
                                value={diagnosticCommand}
                                onChange={(event) => setDiagnosticCommand(event.target.value)}
                                placeholder={t('diagnostics.placeholder')}
                                disabled={isRunningDiagnostics}
                              />
                              <button
                                type="submit"
                                className={styles.runButton}
                                disabled={!diagnosticCommand.trim() || isRunningDiagnostics}
                              >
                                <Play size={14} />
                                <span>
                                  {isRunningDiagnostics ? t('actions.running') : t('actions.run')}
                                </span>
                              </button>
                            </div>
                            <div className={styles.diagnosticsSummary}>
                              {lastDiagnosticRun
                                ? t('diagnostics.summary', {
                                    count: lastDiagnosticRun.diagnosticCount,
                                    code: lastDiagnosticRun.exitCode,
                                    ms: lastDiagnosticRun.durationMs,
                                  })
                                : t('diagnostics.notRun')}
                            </div>
                          </form>
                          {problemItems.length === 0 ? (
                            <div className={styles.panelEmpty}>{t('problems.none')}</div>
                          ) : (
                            problemItems.map((item, index) => (
                              <button
                                key={`${item.source}-${item.message}-${index}`}
                                className={styles.problemItem}
                                onClick={async () => {
                                  if (item.path) {
                                    await loadFile(item.path, item.line);
                                  }
                                }}
                              >
                                <CircleAlert
                                  size={15}
                                  className={
                                    item.severity === 'error'
                                      ? styles.problemError
                                      : styles.problemWarning
                                  }
                                />
                                <span>
                                  {item.code ? `${item.code}: ` : ''}
                                  {item.message}
                                </span>
                                <small>
                                  {item.path
                                    ? `${item.path}${item.line ? `:${item.line}` : ''}${
                                        item.column ? `:${item.column}` : ''
                                      }`
                                    : item.testName || item.source}
                                </small>
                              </button>
                            ))
                          )}
                        </div>
                      ) : null}
                      {bottomPanel === 'output' ? (
                        <pre className={styles.outputPane}>{outputLines.join('\n')}</pre>
                      ) : null}
                      {bottomPanel === 'preview' ? (
                        <div className={styles.previewPane}>
                          {patchPreview ? (
                            <>
                              <div className={styles.previewHeader}>
                                <div className={styles.previewTitle}>
                                  <GitCompareArrows size={16} />
                                  <div>
                                    <strong>{patchPreview.path}</strong>
                                    <span>
                                      {patchPreview.summary} -{' '}
                                      {patchPreview.source === 'agent'
                                        ? t('preview.sourceAgent')
                                        : t('preview.sourceManual')}
                                    </span>
                                  </div>
                                </div>
                                <div className={styles.previewActions}>
                                  <span>
                                    {patchPreview.saveOnApply
                                      ? t('preview.willSave')
                                      : t('preview.willDraft')}
                                  </span>
                                  <button
                                    className={styles.secondaryButton}
                                    onClick={discardPatchPreview}
                                    disabled={isSaving}
                                  >
                                    {t('preview.discard')}
                                  </button>
                                  <button
                                    className={styles.primaryButton}
                                    onClick={() => void applyPatchPreview()}
                                    disabled={isSaving}
                                  >
                                    {isSaving ? t('actions.saving') : t('preview.apply')}
                                  </button>
                                </div>
                              </div>
                              <div className={styles.diffViewer}>
                                {patchPreviewLines.map((line) => (
                                  <div
                                    key={line.id}
                                    className={`${styles.diffLine} ${
                                      line.kind === 'add'
                                        ? styles.diffAdd
                                        : line.kind === 'remove'
                                          ? styles.diffRemove
                                          : styles.diffContext
                                    }`}
                                  >
                                    <span>{line.oldLine ?? ''}</span>
                                    <span>{line.newLine ?? ''}</span>
                                    <code>
                                      {line.kind === 'add'
                                        ? '+'
                                        : line.kind === 'remove'
                                          ? '-'
                                          : ' '}
                                      {line.text}
                                    </code>
                                  </div>
                                ))}
                              </div>
                            </>
                          ) : (
                            <div className={styles.panelEmpty}>{t('preview.empty')}</div>
                          )}
                        </div>
                      ) : null}
                      {bottomPanel === 'actions' ? (
                        <div className={styles.modelActionsPane}>
                          <div className={styles.modelActionsHeader}>
                            <div>
                              <strong>{t('modelActions.title')}</strong>
                              <span>{t('modelActions.description')}</span>
                            </div>
                            <button
                              className={styles.secondaryButton}
                              onClick={() => void undoModelAction()}
                              disabled={
                                !modelActionLog.some(
                                  (entry) => entry.reversible && !entry.undone,
                                ) || isSaving
                              }
                            >
                              <Undo2 size={14} />
                              <span>{t('modelActions.undoLatest')}</span>
                            </button>
                          </div>
                          {modelActionLog.length === 0 ? (
                            <div className={styles.panelEmpty}>{t('modelActions.empty')}</div>
                          ) : (
                            <div className={styles.modelActionList}>
                              {modelActionLog.map((entry) => (
                                <div className={styles.modelActionItem} key={entry.id}>
                                  <History size={15} />
                                  <div>
                                    <strong>{entry.actionType}</strong>
                                    <span>
                                      {entry.path || t('modelActions.noPath')} -{' '}
                                      {entry.status === 'success'
                                        ? t('modelActions.success')
                                        : t('modelActions.error')}
                                      {entry.undone ? ` - ${t('modelActions.undone')}` : ''}
                                    </span>
                                    <code>{entry.resultPreview}</code>
                                    {entry.undoError ? <small>{entry.undoError}</small> : null}
                                  </div>
                                  <button
                                    className={styles.secondaryButton}
                                    onClick={() => void undoModelAction(entry.id)}
                                    disabled={!entry.reversible || entry.undone || isSaving}
                                  >
                                    <Undo2 size={14} />
                                    <span>
                                      {entry.undone
                                        ? t('modelActions.undone')
                                        : entry.reversible
                                          ? t('modelActions.undo')
                                          : t('modelActions.notReversible')}
                                    </span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                      {bottomPanel === 'git' ? (
                        <div className={styles.gitDiffPane}>
                          <div className={styles.gitDiffHeader}>
                            <div>
                              <strong>{selectedGitPath || t('source.noSelection')}</strong>
                              <span>{t('source.diffHint')}</span>
                            </div>
                            <button
                              className={styles.secondaryButton}
                              onClick={() => void loadGitStatus()}
                              disabled={isGitLoading}
                            >
                              <RefreshCw size={14} />
                              <span>
                                {isGitLoading ? t('actions.refreshing') : t('actions.refresh')}
                              </span>
                            </button>
                          </div>
                          {gitDiffText.trim() ? (
                            <pre>{gitDiffText}</pre>
                          ) : (
                            <div className={styles.panelEmpty}>
                              {selectedGitPath ? t('source.noDiff') : t('source.noSelection')}
                            </div>
                          )}
                        </div>
                      ) : null}
                      {bottomPanel === 'terminal' ? (
                        <div className={styles.terminalPane}>
                          <form
                            className={styles.terminalInputRow}
                            onSubmit={(event) => {
                              event.preventDefault();
                              void runTerminalCommand();
                            }}
                          >
                            <span>
                              {workspaceRoot ? getFileName(workspaceRoot) : 'workspace'} $
                            </span>
                            <input
                              ref={terminalInputRef}
                              value={terminalCommand}
                              onChange={(event) => setTerminalCommand(event.target.value)}
                              placeholder={t('terminal.placeholder')}
                              disabled={isRunningCommand}
                            />
                            <button
                              type="submit"
                              className={styles.runButton}
                              disabled={!terminalCommand.trim() || isRunningCommand}
                            >
                              <Play size={14} />
                              <span>
                                {isRunningCommand ? t('actions.running') : t('actions.run')}
                              </span>
                            </button>
                          </form>
                          <div className={styles.terminalHistory}>
                            {terminalHistory.length === 0 ? (
                              <div className={styles.panelEmpty}>{t('terminal.empty')}</div>
                            ) : (
                              terminalHistory.map((entry) => (
                                <div className={styles.terminalEntry} key={entry.id}>
                                  <div className={styles.terminalCommand}>
                                    <span>{entry.cwd} $</span>
                                    <strong>{entry.command}</strong>
                                    <small>
                                      {entry.exitCode === 0
                                        ? t('terminal.exitOk', { ms: entry.durationMs })
                                        : t('terminal.exitFailed', { code: entry.exitCode })}
                                    </small>
                                  </div>
                                  {entry.stdout ? <pre>{entry.stdout}</pre> : null}
                                  {entry.stderr ? (
                                    <pre className={styles.stderr}>{entry.stderr}</pre>
                                  ) : null}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className={styles.emptyState}>
                <h2>{t('empty.title')}</h2>
                <p>{t('empty.description')}</p>
              </div>
            )}
          </section>
        </main>
      </div>

      <footer className={styles.statusBar}>
        <span>
          <GitBranch size={13} />
          {gitBranch}
        </span>
        <span>
          {dirtyTabs.length > 0
            ? t('editor.unsavedCount', { count: dirtyTabs.length })
            : t('editor.saved')}
        </span>
        <span>{activePath ? fileExtensionLabel : 'TXT'}</span>
        <span>UTF-8</span>
        <span>LF</span>
        <span>
          {t('editor.cursor', { line: cursorPosition.line, column: cursorPosition.column })}
        </span>
        {editorSelection ? (
          <span>{t('editor.selection', { chars: editorSelection.charCount })}</span>
        ) : null}
        <span>
          {t('editor.stats', { lines: lineCount, chars: activeTab?.content.length ?? 0 })}
        </span>
      </footer>

      {showCommandPalette ? (
        <div className={styles.paletteOverlay} onMouseDown={() => setShowCommandPalette(false)}>
          <div className={styles.palette} onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.paletteInputRow}>
              <Command size={17} />
              <input
                ref={commandInputRef}
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setShowCommandPalette(false);
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelectedPaletteIndex((prev) =>
                      filteredPaletteItems.length === 0
                        ? 0
                        : Math.min(prev + 1, filteredPaletteItems.length - 1),
                    );
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelectedPaletteIndex((prev) => Math.max(prev - 1, 0));
                  }
                  if (event.key === 'Enter' && filteredPaletteItems[selectedPaletteIndex]) {
                    event.preventDefault();
                    void executePaletteItem(filteredPaletteItems[selectedPaletteIndex]);
                  }
                }}
                placeholder={t('commandPalette.placeholder')}
              />
            </div>
            <div className={styles.paletteResults}>
              {filteredPaletteItems.length === 0 ? (
                <div className={styles.panelEmpty}>{t('commandPalette.noResults')}</div>
              ) : (
                filteredPaletteItems.map((item, index) => (
                  <button
                    key={item.id}
                    className={index === selectedPaletteIndex ? styles.paletteItemActive : ''}
                    onMouseEnter={() => setSelectedPaletteIndex(index)}
                    onClick={() => void executePaletteItem(item)}
                  >
                    <span>
                      <strong>{item.label}</strong>
                      <small>
                        {item.group}
                        {item.description ? ` - ${item.description}` : ''}
                      </small>
                    </span>
                    {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default OpenVSCodePage;
