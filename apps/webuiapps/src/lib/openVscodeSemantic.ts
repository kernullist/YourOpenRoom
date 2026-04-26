import * as fs from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import {
  getTsSemanticDefinition,
  getTsSemanticReferences,
  getTsSemanticRenameLocations,
} from './openVscodeTsLanguageService';

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx']);
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

export interface WorkspaceExportItem {
  path: string;
  line: number;
  column: number;
  name: string;
  kind: string;
  preview: string;
}

export interface WorkspaceReferenceItem {
  path: string;
  line: number;
  column: number;
  kind: 'reference' | 'import' | 'declaration';
  preview: string;
}

interface WorkspaceReferenceWithOffsets extends WorkspaceReferenceItem {
  start: number;
  end: number;
}

export interface WorkspacePeekDefinitionResult {
  symbol: string;
  definition: {
    path: string;
    line: number;
    column: number;
    kind: string;
    preview: string;
    context: string[];
  } | null;
}

export interface WorkspaceRenamePreviewResult {
  symbol: string;
  newName: string;
  signature: string;
  total_references: number;
  files: Array<{
    path: string;
    count: number;
    previews: Array<{ line: number; kind: 'reference' | 'import' | 'declaration'; preview: string }>;
  }>;
}

export interface WorkspaceRenameApplyResult {
  symbol: string;
  newName: string;
  signature: string;
  total_references: number;
  changed_files: Array<{
    path: string;
    replacements: number;
    before_preview: string;
    after_preview: string;
  }>;
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
  if (!extension) return false;
  if (BINARY_EXTENSIONS.has(extension)) return false;
  return CODE_EXTENSIONS.has(extension);
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const extension = getExtension(filePath);
  if (extension === 'tsx') return ts.ScriptKind.TSX;
  if (extension === 'jsx') return ts.ScriptKind.JSX;
  if (extension === 'js') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function walkWorkspaceFiles(options: {
  rootDir: string;
  directory?: string;
  ignoredDirs?: Set<string>;
}): Array<{ absolutePath: string; relativePath: string; content: string }> {
  const rootDir = resolve(options.rootDir);
  const directory = (options.directory || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const searchRoot = directory ? resolve(rootDir, directory) : rootDir;
  const ignoredDirs = options.ignoredDirs ?? new Set<string>();
  const pendingDirs = [searchRoot];
  const visited = new Set<string>();
  const files: Array<{ absolutePath: string; relativePath: string; content: string }> = [];

  while (pendingDirs.length > 0) {
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

      try {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        if (!content.includes('\u0000')) {
          files.push({ absolutePath, relativePath, content });
        }
      } catch {
        // ignore unreadable files
      }
    }
  }

  return files;
}

function getLinePreview(content: string, line: number): string {
  return (content.replace(/\r\n/g, '\n').split('\n')[line - 1] || '').trim().slice(0, 220);
}

function getContextLines(content: string, line: number, radius = 2): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((value, index) => `${start + index + 1}: ${value}`);
}

function pushExport(
  exports: WorkspaceExportItem[],
  filePath: string,
  sourceFile: ts.SourceFile,
  content: string,
  node: ts.Node,
  name: string,
  kind: string,
) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  exports.push({
    path: filePath,
    line: start.line + 1,
    column: start.character + 1,
    name,
    kind,
    preview: getLinePreview(content, start.line + 1),
  });
}

export function listWorkspaceExports(options: {
  rootDir: string;
  directory?: string;
  ignoredDirs?: Set<string>;
  maxResults?: number;
}) {
  const files = walkWorkspaceFiles(options);
  const exports: WorkspaceExportItem[] = [];
  const maxResults = Math.min(20, Math.max(1, Math.floor(options.maxResults ?? 10)));

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.relativePath,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(file.relativePath),
    );

    const visit = (node: ts.Node) => {
      if (exports.length >= maxResults) return;

      const modifiers = 'modifiers' in node ? ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined : undefined;
      const isExported = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

      if (isExported) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          pushExport(exports, file.relativePath, sourceFile, file.content, node.name, node.name.text, 'function');
        } else if (ts.isClassDeclaration(node) && node.name) {
          pushExport(exports, file.relativePath, sourceFile, file.content, node.name, node.name.text, 'class');
        } else if (ts.isInterfaceDeclaration(node)) {
          pushExport(exports, file.relativePath, sourceFile, file.content, node.name, node.name.text, 'interface');
        } else if (ts.isTypeAliasDeclaration(node)) {
          pushExport(exports, file.relativePath, sourceFile, file.content, node.name, node.name.text, 'type');
        } else if (ts.isEnumDeclaration(node)) {
          pushExport(exports, file.relativePath, sourceFile, file.content, node.name, node.name.text, 'enum');
        } else if (ts.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              pushExport(exports, file.relativePath, sourceFile, file.content, declaration.name, declaration.name.text, 'const');
            }
          }
        }
      }

      if (ts.isExportAssignment(node)) {
        pushExport(exports, file.relativePath, sourceFile, file.content, node, 'default', 'default');
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (exports.length >= maxResults) break;
  }

  return {
    directory: (options.directory || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') || '/',
    total_matches: exports.length,
    exports,
  };
}

function classifyIdentifier(node: ts.Identifier): 'reference' | 'import' | 'declaration' {
  const parent = node.parent;
  if (
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node)
  ) {
    return 'import';
  }

  if (
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node)
  ) {
    return 'declaration';
  }

  return 'reference';
}

function collectWorkspaceReferencesForFile(
  file: { relativePath: string; content: string },
  symbol: string,
  maxResults: number,
): WorkspaceReferenceWithOffsets[] {
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(file.relativePath),
  );
  const references: WorkspaceReferenceWithOffsets[] = [];

  const visit = (node: ts.Node) => {
    if (references.length >= maxResults) return;
    if (ts.isIdentifier(node) && node.text === symbol) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      references.push({
        path: file.relativePath,
        line: start.line + 1,
        column: start.character + 1,
        kind: classifyIdentifier(node),
        preview: getLinePreview(file.content, start.line + 1),
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

function buildReferenceSignature(
  symbol: string,
  newName: string,
  references: WorkspaceReferenceItem[],
): string {
  const seed = `${symbol}->${newName}|${references
    .map((reference) => `${reference.path}:${reference.line}:${reference.column}:${reference.kind}`)
    .sort()
    .join('|')}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rename_${Math.abs(hash >>> 0).toString(36)}`;
}

export function findWorkspaceReferences(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  ignoredDirs?: Set<string>;
  maxResults?: number;
}) {
  const semanticReferences = getTsSemanticReferences(options);
  if (semanticReferences && semanticReferences.length > 0) {
    return {
      symbol: options.symbol,
      directory:
        (options.directory || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') || '/',
      total_matches: semanticReferences.length,
      references: semanticReferences.map((reference) => ({
        path: toRelativePath(resolve(options.rootDir), reference.fileName),
        line: reference.line,
        column: reference.column,
        kind: reference.kind,
        preview: reference.preview,
      })),
    };
  }

  const files = walkWorkspaceFiles(options);
  const references: WorkspaceReferenceItem[] = [];
  const maxResults = Math.min(20, Math.max(1, Math.floor(options.maxResults ?? 10)));

  for (const file of files) {
    references.push(...collectWorkspaceReferencesForFile(file, options.symbol, maxResults - references.length));
    if (references.length >= maxResults) break;
  }

  return {
    symbol: options.symbol,
    directory: (options.directory || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') || '/',
    total_matches: references.length,
    references,
  };
}

export function peekWorkspaceDefinition(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  ignoredDirs?: Set<string>;
}): WorkspacePeekDefinitionResult {
  const semanticDefinition = getTsSemanticDefinition(options);
  if (semanticDefinition) {
    return {
      symbol: options.symbol,
      definition: {
        path: toRelativePath(resolve(options.rootDir), semanticDefinition.fileName),
        line: semanticDefinition.line,
        column: semanticDefinition.column,
        kind: semanticDefinition.kind,
        preview: semanticDefinition.preview,
        context: semanticDefinition.context,
      },
    };
  }

  const files = walkWorkspaceFiles(options);

  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.relativePath,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(file.relativePath),
    );

    let found:
      | {
          path: string;
          line: number;
          column: number;
          kind: string;
          preview: string;
          context: string[];
        }
      | null = null;

    const visit = (node: ts.Node) => {
      if (found) return;

      const makeFound = (target: ts.Node, kind: string) => {
        const start = sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile));
        found = {
          path: file.relativePath,
          line: start.line + 1,
          column: start.character + 1,
          kind,
          preview: getLinePreview(file.content, start.line + 1),
          context: getContextLines(file.content, start.line + 1),
        };
      };

      if (ts.isFunctionDeclaration(node) && node.name?.text === options.symbol) makeFound(node.name, 'function');
      else if (ts.isClassDeclaration(node) && node.name?.text === options.symbol) makeFound(node.name, 'class');
      else if (ts.isInterfaceDeclaration(node) && node.name.text === options.symbol) makeFound(node.name, 'interface');
      else if (ts.isTypeAliasDeclaration(node) && node.name.text === options.symbol) makeFound(node.name, 'type');
      else if (ts.isEnumDeclaration(node) && node.name.text === options.symbol) makeFound(node.name, 'enum');
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === options.symbol) {
        makeFound(node.name, 'const');
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    if (found) {
      return {
        symbol: options.symbol,
        definition: found,
      };
    }
  }

  return {
    symbol: options.symbol,
    definition: null,
  };
}

export function buildRenamePreview(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  newName: string;
  ignoredDirs?: Set<string>;
  maxResults?: number;
}): WorkspaceRenamePreviewResult {
  const semanticRenameLocations = getTsSemanticRenameLocations(options);
  if (semanticRenameLocations && semanticRenameLocations.length > 0) {
    const normalizedReferences = semanticRenameLocations.map((reference) => ({
      path: toRelativePath(resolve(options.rootDir), reference.fileName),
      line: reference.line,
      column: reference.column,
      kind: reference.kind,
      preview: reference.preview,
    }));

    const grouped = new Map<
      string,
      { path: string; count: number; previews: Array<{ line: number; kind: 'reference' | 'import' | 'declaration'; preview: string }> }
    >();

    for (const reference of normalizedReferences) {
      if (!grouped.has(reference.path)) {
        grouped.set(reference.path, { path: reference.path, count: 0, previews: [] });
      }
      const item = grouped.get(reference.path)!;
      item.count += 1;
      if (item.previews.length < 4) {
        item.previews.push({
          line: reference.line,
          kind: reference.kind,
          preview: reference.preview.replaceAll(options.symbol, options.newName),
        });
      }
    }

    return {
      symbol: options.symbol,
      newName: options.newName,
      signature: buildReferenceSignature(options.symbol, options.newName, normalizedReferences),
      total_references: normalizedReferences.length,
      files: [...grouped.values()]
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
        .slice(0, Math.min(12, Math.max(1, Math.floor(options.maxResults ?? 8)))),
    };
  }

  const references = findWorkspaceReferences({
    rootDir: options.rootDir,
    directory: options.directory,
    symbol: options.symbol,
    ignoredDirs: options.ignoredDirs,
    maxResults: Math.max(20, Math.floor(options.maxResults ?? 12) * 20),
  }).references;

  const grouped = new Map<
    string,
    { path: string; count: number; previews: Array<{ line: number; kind: 'reference' | 'import' | 'declaration'; preview: string }> }
  >();

  for (const reference of references) {
    if (!grouped.has(reference.path)) {
      grouped.set(reference.path, { path: reference.path, count: 0, previews: [] });
    }
    const item = grouped.get(reference.path)!;
    item.count += 1;
    if (item.previews.length < 4) {
      item.previews.push({
        line: reference.line,
        kind: reference.kind,
        preview: reference.preview.replaceAll(options.symbol, options.newName),
      });
    }
  }

  const files = [...grouped.values()]
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, Math.min(12, Math.max(1, Math.floor(options.maxResults ?? 8))));

  return {
    symbol: options.symbol,
    newName: options.newName,
    signature: buildReferenceSignature(options.symbol, options.newName, references),
    total_references: references.length,
    files,
  };
}

export function applyWorkspaceRename(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  newName: string;
  expectedSignature?: string;
  ignoredDirs?: Set<string>;
  maxResults?: number;
}): WorkspaceRenameApplyResult {
  const semanticRenameLocations = getTsSemanticRenameLocations(options);
  if (semanticRenameLocations && semanticRenameLocations.length > 0) {
    const normalizedReferences = semanticRenameLocations.map((reference) => ({
      path: toRelativePath(resolve(options.rootDir), reference.fileName),
      line: reference.line,
      column: reference.column,
      kind: reference.kind,
      preview: reference.preview,
    }));
    const signature = buildReferenceSignature(options.symbol, options.newName, normalizedReferences);
    if (options.expectedSignature && options.expectedSignature !== signature) {
      throw new Error(
        `Rename preview signature mismatch. Expected ${options.expectedSignature}, found ${signature}. Re-run rename_preview first.`,
      );
    }

    const rootDir = resolve(options.rootDir);
    const grouped = new Map<string, typeof semanticRenameLocations>();
    for (const location of semanticRenameLocations) {
      const key = location.fileName;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(location);
    }

    const changedFiles: WorkspaceRenameApplyResult['changed_files'] = [];
    for (const [fileName, refs] of grouped.entries()) {
      const original = fs.readFileSync(fileName, 'utf-8');
      let nextContent = original;
      for (const reference of [...refs].sort((a, b) => b.start - a.start)) {
        nextContent =
          nextContent.slice(0, reference.start) +
          options.newName +
          nextContent.slice(reference.end);
      }
      if (nextContent === original) continue;
      fs.writeFileSync(fileName, nextContent, 'utf-8');
      changedFiles.push({
        path: toRelativePath(rootDir, fileName),
        replacements: refs.length,
        before_preview: refs[0]?.preview ?? '',
        after_preview: refs[0]?.preview.replaceAll(options.symbol, options.newName) ?? '',
      });
    }

    return {
      symbol: options.symbol,
      newName: options.newName,
      signature,
      total_references: normalizedReferences.length,
      changed_files: changedFiles,
    };
  }

  const files = walkWorkspaceFiles(options);
  const maxResults = Math.max(20, Math.floor(options.maxResults ?? 12) * 20);
  const allReferences: WorkspaceReferenceWithOffsets[] = [];
  const referencesByFile = new Map<string, WorkspaceReferenceWithOffsets[]>();

  for (const file of files) {
    const refs = collectWorkspaceReferencesForFile(file, options.symbol, maxResults - allReferences.length);
    if (refs.length === 0) continue;
    allReferences.push(...refs);
    referencesByFile.set(file.relativePath, refs);
    if (allReferences.length >= maxResults) break;
  }

  const signature = buildReferenceSignature(options.symbol, options.newName, allReferences);
  if (options.expectedSignature && options.expectedSignature !== signature) {
    throw new Error(
      `Rename preview signature mismatch. Expected ${options.expectedSignature}, found ${signature}. Re-run rename_preview first.`,
    );
  }

  const changedFiles: WorkspaceRenameApplyResult['changed_files'] = [];
  const rootDir = resolve(options.rootDir);

  for (const file of files) {
    const refs = referencesByFile.get(file.relativePath);
    if (!refs || refs.length === 0) continue;

    let nextContent = file.content;
    for (const reference of [...refs].sort((a, b) => b.start - a.start)) {
      nextContent =
        nextContent.slice(0, reference.start) +
        options.newName +
        nextContent.slice(reference.end);
    }

    if (nextContent === file.content) continue;

    fs.writeFileSync(resolve(rootDir, file.relativePath), nextContent, 'utf-8');
    changedFiles.push({
      path: file.relativePath,
      replacements: refs.length,
      before_preview: refs[0]?.preview ?? '',
      after_preview: refs[0]?.preview.replaceAll(options.symbol, options.newName) ?? '',
    });
  }

  return {
    symbol: options.symbol,
    newName: options.newName,
    signature,
    total_references: allReferences.length,
    changed_files: changedFiles,
  };
}
