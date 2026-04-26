import type { ToolDef } from './llmClient';

import * as idb from './diskStorage';
import { getSessionPath } from './sessionPath';

const TOOL_NAME = 'workspace_search';
const DEFAULT_DIRECTORY = 'apps';
const MAX_RESULTS = 12;
const MAX_CONTENT_BYTES = 120_000;
const MAX_SNIPPETS_PER_MATCH = 3;
const MAX_SNIPPET_CHARS = 180;

const BINARY_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'mp3',
  'mp4',
  'ogg',
  'pdf',
  'png',
  'svg',
  'tar',
  'wav',
  'webm',
  'webp',
  'zip',
]);

type SearchMode = 'auto' | 'path' | 'content';

interface WorkspaceNode {
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

interface WorkspaceSearchMatch {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  match_type: 'path' | 'content' | 'path+content';
  snippets?: Array<{ line: number; text: string }>;
}

function normalizeDirectory(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

function normalizeMode(input: unknown): SearchMode {
  if (input === 'path' || input === 'content') return input;
  return 'auto';
}

function clampMaxResults(input: unknown): number {
  const parsed =
    typeof input === 'number' ? Math.floor(input) : Number.parseInt(String(input || ''), 10);
  if (!Number.isFinite(parsed)) return 8;
  return Math.min(MAX_RESULTS, Math.max(1, parsed));
}

function stripSessionPrefix(path: string): string {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const sessionPath = getSessionPath()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (sessionPath && normalizedPath.startsWith(`${sessionPath}/`)) {
    return normalizedPath.slice(sessionPath.length + 1);
  }
  return normalizedPath;
}

function shouldSearchPath(mode: SearchMode): boolean {
  return mode === 'auto' || mode === 'path';
}

function shouldSearchContent(mode: SearchMode): boolean {
  return mode === 'auto' || mode === 'content';
}

function getExtension(path: string): string {
  const fileName = path.split('/').pop() || path;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function shouldInspectFileContent(path: string, size?: number): boolean {
  if (typeof size === 'number' && size > MAX_CONTENT_BYTES) return false;
  const extension = getExtension(path);
  if (!extension) return true;
  return !BINARY_EXTENSIONS.has(extension);
}

function toSearchableText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content, null, 2) ?? '';
  } catch {
    return String(content ?? '');
  }
}

function truncateSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  return `${text.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…`;
}

function collectSnippets(content: string, query: string): Array<{ line: number; text: string }> {
  const lowerQuery = query.toLowerCase();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const snippets: Array<{ line: number; text: string }> = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.toLowerCase().includes(lowerQuery)) continue;
    snippets.push({
      line: index + 1,
      text: truncateSnippet(line.trim() || line),
    });
    if (snippets.length >= MAX_SNIPPETS_PER_MATCH) break;
  }

  return snippets;
}

function compareMatches(a: WorkspaceSearchMatch, b: WorkspaceSearchMatch): number {
  const rank = (matchType: WorkspaceSearchMatch['match_type']): number => {
    if (matchType === 'path+content') return 0;
    if (matchType === 'path') return 1;
    return 2;
  };

  const rankDiff = rank(a.match_type) - rank(b.match_type);
  if (rankDiff !== 0) return rankDiff;
  if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
  return a.path.localeCompare(b.path);
}

async function listWorkspaceNodes(directory: string): Promise<{
  nodes: WorkspaceNode[];
  scannedDirectories: number;
}> {
  const root = normalizeDirectory(directory);
  const pendingDirs = [root];
  const visitedDirs = new Set<string>();
  const nodes: WorkspaceNode[] = [];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.shift() ?? '';
    if (visitedDirs.has(currentDir)) continue;
    visitedDirs.add(currentDir);

    const result = await idb.listFiles(currentDir || '/');
    if (result.not_exists) continue;

    for (const entry of result.files) {
      const normalizedPath = stripSessionPrefix(entry.path);
      const node: WorkspaceNode = {
        path: normalizedPath,
        type: entry.type === 1 ? 'directory' : 'file',
        size: entry.size,
      };
      nodes.push(node);
      if (node.type === 'directory') {
        pendingDirs.push(normalizedPath);
      }
    }
  }

  return {
    nodes,
    scannedDirectories: visitedDirs.size,
  };
}

export function getWorkspaceToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Recursively search workspace files by path and optional file content. ' +
          'Use this before file_read when you do not know the exact path yet.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search text to match against file paths or content',
            },
            directory: {
              type: 'string',
              description:
                'Optional directory relative to workspace root. Defaults to "apps" for app data.',
            },
            mode: {
              type: 'string',
              description: 'Search mode: auto (path + content), path only, or content only',
              enum: ['auto', 'path', 'content'],
            },
            max_results: {
              type: 'number',
              description: `Maximum number of matches to return, between 1 and ${MAX_RESULTS}`,
            },
          },
          required: ['query'],
        },
      },
    },
  ];
}

export function isWorkspaceTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeWorkspaceTool(params: Record<string, unknown>): Promise<string> {
  const query = String(params.query || '').trim();
  if (!query) return 'error: missing query';

  const directory = normalizeDirectory(String(params.directory || DEFAULT_DIRECTORY));
  const mode = normalizeMode(params.mode);
  const maxResults = clampMaxResults(params.max_results);
  const lowerQuery = query.toLowerCase();

  const { nodes, scannedDirectories } = await listWorkspaceNodes(directory);
  const matches: WorkspaceSearchMatch[] = [];
  let scannedFiles = 0;

  for (const node of nodes) {
    const pathMatched = shouldSearchPath(mode) && node.path.toLowerCase().includes(lowerQuery);

    if (node.type === 'directory') {
      if (pathMatched) {
        matches.push({
          path: node.path,
          type: node.type,
          match_type: 'path',
        });
      }
      continue;
    }

    scannedFiles++;

    let contentMatched = false;
    let snippets: Array<{ line: number; text: string }> = [];

    if (shouldSearchContent(mode) && shouldInspectFileContent(node.path, node.size)) {
      const content = toSearchableText(await idb.getFile(node.path));
      if (content && content.toLowerCase().includes(lowerQuery)) {
        contentMatched = true;
        snippets = collectSnippets(content, query);
      }
    }

    if (!pathMatched && !contentMatched) continue;

    matches.push({
      path: node.path,
      type: node.type,
      size: node.size,
      match_type: pathMatched && contentMatched ? 'path+content' : pathMatched ? 'path' : 'content',
      ...(snippets.length > 0 ? { snippets } : {}),
    });
  }

  const sortedMatches = matches.sort(compareMatches);

  return JSON.stringify({
    query,
    directory: directory || '/',
    mode,
    scanned_files: scannedFiles,
    scanned_directories: scannedDirectories,
    total_matches: sortedMatches.length,
    has_more: sortedMatches.length > maxResults,
    matches: sortedMatches.slice(0, maxResults),
  });
}
