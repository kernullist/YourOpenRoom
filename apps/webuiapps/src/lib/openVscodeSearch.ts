import * as fs from 'fs';
import { resolve } from 'path';

export type OpenVscodeSearchMode = 'auto' | 'path' | 'content';

export interface OpenVscodeSearchMatch {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  match_type: 'path' | 'content' | 'path+content';
  snippets?: Array<{ line: number; text: string }>;
}

export interface OpenVscodeSearchResult {
  query: string;
  directory: string;
  mode: OpenVscodeSearchMode;
  scanned_files: number;
  scanned_directories: number;
  total_matches: number;
  has_more: boolean;
  matches: OpenVscodeSearchMatch[];
}

const BINARY_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'dll',
  'exe',
  'gif',
  'gz',
  'ico',
  'jpeg',
  'jpg',
  'lockb',
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

const MAX_FILE_BYTES = 250_000;
const MAX_SNIPPETS_PER_MATCH = 3;
const MAX_SNIPPET_CHARS = 180;

function normalizeDirectory(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function clampMaxResults(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.min(20, Math.max(1, Math.floor(value)));
}

function shouldSearchPath(mode: OpenVscodeSearchMode): boolean {
  return mode === 'auto' || mode === 'path';
}

function shouldSearchContent(mode: OpenVscodeSearchMode): boolean {
  return mode === 'auto' || mode === 'content';
}

function truncateSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  return `${text.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…`;
}

function toRelativePath(rootDir: string, absolutePath: string): string {
  return absolutePath.slice(rootDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function getExtension(filePath: string): string {
  const fileName = filePath.split('/').pop() || filePath;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function canReadContent(filePath: string, size: number): boolean {
  if (size > MAX_FILE_BYTES) return false;
  const extension = getExtension(filePath);
  if (!extension) return true;
  return !BINARY_EXTENSIONS.has(extension);
}

function collectSnippets(content: string, query: string): Array<{ line: number; text: string }> {
  const lowerQuery = query.toLowerCase();
  const snippets: Array<{ line: number; text: string }> = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.toLowerCase().includes(lowerQuery)) continue;
    snippets.push({ line: index + 1, text: truncateSnippet(line.trim() || line) });
    if (snippets.length >= MAX_SNIPPETS_PER_MATCH) break;
  }

  return snippets;
}

function compareMatches(a: OpenVscodeSearchMatch, b: OpenVscodeSearchMatch): number {
  const rank = (matchType: OpenVscodeSearchMatch['match_type']): number => {
    if (matchType === 'path+content') return 0;
    if (matchType === 'path') return 1;
    return 2;
  };

  const rankDiff = rank(a.match_type) - rank(b.match_type);
  if (rankDiff !== 0) return rankDiff;
  if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
  return a.path.localeCompare(b.path);
}

export function searchOpenVscodeWorkspace(options: {
  rootDir: string;
  directory?: string;
  query: string;
  mode?: OpenVscodeSearchMode;
  maxResults?: number;
  ignoredDirs?: Set<string>;
}): OpenVscodeSearchResult {
  const query = options.query.trim();
  const mode = options.mode ?? 'auto';
  const maxResults = clampMaxResults(options.maxResults ?? 8);
  const directory = normalizeDirectory(options.directory || '');
  const rootDir = resolve(options.rootDir);
  const searchRoot = directory ? resolve(rootDir, directory) : rootDir;
  const ignoredDirs = options.ignoredDirs ?? new Set<string>();
  const lowerQuery = query.toLowerCase();

  const pendingDirs = [searchRoot];
  const visitedDirs = new Set<string>();
  const matches: OpenVscodeSearchMatch[] = [];
  let scannedFiles = 0;

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.shift()!;
    if (visitedDirs.has(currentDir)) continue;
    visitedDirs.add(currentDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;

      const absolutePath = resolve(currentDir, entry.name);
      const relativePath = toRelativePath(rootDir, absolutePath);
      const pathMatched = shouldSearchPath(mode) && relativePath.toLowerCase().includes(lowerQuery);

      if (entry.isDirectory()) {
        if (pathMatched) {
          matches.push({
            path: relativePath,
            type: 'directory',
            match_type: 'path',
          });
        }
        pendingDirs.push(absolutePath);
        continue;
      }

      scannedFiles++;
      let contentMatched = false;
      let snippets: Array<{ line: number; text: string }> = [];
      let size = 0;

      try {
        size = fs.statSync(absolutePath).size;
      } catch {
        size = 0;
      }

      if (shouldSearchContent(mode) && canReadContent(relativePath, size)) {
        try {
          const content = fs.readFileSync(absolutePath, 'utf-8');
          if (!content.includes('\u0000') && content.toLowerCase().includes(lowerQuery)) {
            contentMatched = true;
            snippets = collectSnippets(content, query);
          }
        } catch {
          // ignore unreadable files
        }
      }

      if (!pathMatched && !contentMatched) continue;

      matches.push({
        path: relativePath,
        type: 'file',
        size,
        match_type: pathMatched && contentMatched ? 'path+content' : pathMatched ? 'path' : 'content',
        ...(snippets.length > 0 ? { snippets } : {}),
      });
    }
  }

  const sortedMatches = matches.sort(compareMatches);
  return {
    query,
    directory: directory || '/',
    mode,
    scanned_files: scannedFiles,
    scanned_directories: visitedDirs.size,
    total_matches: sortedMatches.length,
    has_more: sortedMatches.length > maxResults,
    matches: sortedMatches.slice(0, maxResults),
  };
}
