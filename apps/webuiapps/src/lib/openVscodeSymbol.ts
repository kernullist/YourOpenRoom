import * as fs from 'fs';
import { resolve } from 'path';

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

export interface SymbolMatch {
  path: string;
  line: number;
  column: number;
  kind: string;
  preview: string;
}

export interface SymbolSearchResult {
  symbol: string;
  directory: string;
  total_matches: number;
  matches: SymbolMatch[];
}

function toRelativePath(rootDir: string, absolutePath: string): string {
  return absolutePath.slice(rootDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

function getExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
}

function canInspectFile(filePath: string, size: number): boolean {
  if (size > 250_000) return false;
  const extension = getExtension(filePath);
  if (!extension) return true;
  return !BINARY_EXTENSIONS.has(extension);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function searchWorkspaceSymbol(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  ignoredDirs?: Set<string>;
  maxResults?: number;
}): SymbolSearchResult {
  const rootDir = resolve(options.rootDir);
  const directory = (options.directory || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const searchRoot = directory ? resolve(rootDir, directory) : rootDir;
  const ignoredDirs = options.ignoredDirs ?? new Set<string>();
  const maxResults = Math.min(12, Math.max(1, Math.floor(options.maxResults ?? 6)));
  const escapedSymbol = escapeRegex(options.symbol.trim());
  const matchPatterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: 'export_function', regex: new RegExp(`\\bexport\\s+function\\s+${escapedSymbol}\\b`) },
    { kind: 'function', regex: new RegExp(`\\bfunction\\s+${escapedSymbol}\\b`) },
    { kind: 'export_class', regex: new RegExp(`\\bexport\\s+class\\s+${escapedSymbol}\\b`) },
    { kind: 'class', regex: new RegExp(`\\bclass\\s+${escapedSymbol}\\b`) },
    { kind: 'export_const', regex: new RegExp(`\\bexport\\s+const\\s+${escapedSymbol}\\b`) },
    { kind: 'const', regex: new RegExp(`\\bconst\\s+${escapedSymbol}\\b`) },
    { kind: 'interface', regex: new RegExp(`\\binterface\\s+${escapedSymbol}\\b`) },
    { kind: 'type', regex: new RegExp(`\\btype\\s+${escapedSymbol}\\b`) },
    { kind: 'enum', regex: new RegExp(`\\benum\\s+${escapedSymbol}\\b`) },
  ];

  const matches: SymbolMatch[] = [];
  const pendingDirs = [searchRoot];
  const visited = new Set<string>();

  while (pendingDirs.length > 0 && matches.length < maxResults) {
    const currentDir = pendingDirs.shift()!;
    if (visited.has(currentDir)) continue;
    visited.add(currentDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const absolutePath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(absolutePath);
        continue;
      }

      const relativePath = toRelativePath(rootDir, absolutePath);
      let statSize = 0;
      try {
        statSize = fs.statSync(absolutePath).size;
      } catch {
        statSize = 0;
      }
      if (!canInspectFile(relativePath, statSize)) continue;

      let content = '';
      try {
        content = fs.readFileSync(absolutePath, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;

      const lines = content.replace(/\r\n/g, '\n').split('\n');
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex++) {
        const line = lines[lineIndex];
        for (const pattern of matchPatterns) {
          const regexMatch = line.match(pattern.regex);
          if (!regexMatch) continue;
          matches.push({
            path: relativePath,
            line: lineIndex + 1,
            column: (regexMatch.index ?? 0) + 1,
            kind: pattern.kind,
            preview: line.trim().slice(0, 220),
          });
          break;
        }
      }
    }
  }

  return {
    symbol: options.symbol,
    directory: directory || '/',
    total_matches: matches.length,
    matches,
  };
}
