import * as fs from 'fs';
import { dirname, resolve } from 'path';
import ts from 'typescript';

interface DeclarationCandidate {
  fileName: string;
  position: number;
}

interface TsProjectContext {
  languageService: ts.LanguageService;
  fileNames: string[];
  projectRoot: string;
}

function findTsConfig(startDir: string): string | null {
  return ts.findConfigFile(startDir, ts.sys.fileExists, 'tsconfig.json');
}

function createProjectContext(rootDir: string, directory = ''): TsProjectContext | null {
  const searchRoot = directory ? resolve(rootDir, directory) : resolve(rootDir);
  const configPath = findTsConfig(searchRoot) || findTsConfig(rootDir);
  if (!configPath) return null;

  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) return null;

  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, dirname(configPath));
  const fileVersions = new Map(parsed.fileNames.map((fileName) => [fileName, '0']));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (fileName) => fileVersions.get(fileName) || '0',
    getScriptSnapshot: (fileName) => {
      if (!fs.existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf-8'));
    },
    getCurrentDirectory: () => dirname(configPath),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  return {
    languageService: ts.createLanguageService(host, ts.createDocumentRegistry()),
    fileNames: parsed.fileNames,
    projectRoot: dirname(configPath),
  };
}

function findDeclarationCandidates(context: TsProjectContext, symbol: string): DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];

  for (const fileName of context.fileNames) {
    if (!fs.existsSync(fileName)) continue;
    const content = fs.readFileSync(fileName, 'utf-8');
    const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name?.text === symbol
      ) {
        candidates.push({ fileName, position: node.name.getStart(sourceFile) });
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbol) {
        candidates.push({ fileName, position: node.name.getStart(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return candidates;
}

function linePreview(fileName: string, line: number): string {
  if (!fs.existsSync(fileName)) return '';
  const lines = fs.readFileSync(fileName, 'utf-8').replace(/\r\n/g, '\n').split('\n');
  return (lines[line - 1] || '').trim().slice(0, 220);
}

function contextLines(fileName: string, line: number, radius = 2): string[] {
  if (!fs.existsSync(fileName)) return [];
  const lines = fs.readFileSync(fileName, 'utf-8').replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((value, index) => `${start + index + 1}: ${value}`);
}

function classifyReference(fileName: string, position: number): 'reference' | 'import' | 'declaration' {
  const content = fs.readFileSync(fileName, 'utf-8');
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  let kind: 'reference' | 'import' | 'declaration' = 'reference';

  const visit = (node: ts.Node) => {
    if (position < node.getStart(sourceFile) || position > node.getEnd()) {
      ts.forEachChild(node, visit);
      return;
    }
    if (ts.isIdentifier(node) && node.getStart(sourceFile) === position) {
      const parent = node.parent;
      if (
        (ts.isImportSpecifier(parent) && parent.name === node) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node)
      ) {
        kind = 'import';
      } else if (
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
        (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
        (ts.isEnumDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node)
      ) {
        kind = 'declaration';
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return kind;
}

export function getTsSemanticDefinition(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
}) {
  const context = createProjectContext(options.rootDir, options.directory);
  if (!context) return null;
  const candidate = findDeclarationCandidates(context, options.symbol)[0];
  if (!candidate) return null;

  const sourceFile = ts.createSourceFile(
    candidate.fileName,
    fs.readFileSync(candidate.fileName, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const start = sourceFile.getLineAndCharacterOfPosition(candidate.position);
  return {
    fileName: candidate.fileName,
    line: start.line + 1,
    column: start.character + 1,
    kind: 'semantic',
    preview: linePreview(candidate.fileName, start.line + 1),
    context: contextLines(candidate.fileName, start.line + 1),
  };
}

export function getTsSemanticReferences(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  maxResults?: number;
}) {
  const context = createProjectContext(options.rootDir, options.directory);
  if (!context) return null;
  const candidate = findDeclarationCandidates(context, options.symbol)[0];
  if (!candidate) return null;

  const maxResults = Math.min(50, Math.max(1, Math.floor(options.maxResults ?? 20)));
  const references = context.languageService.findReferences(candidate.fileName, candidate.position) || [];
  const flattened: Array<{
    fileName: string;
    line: number;
    column: number;
    kind: 'reference' | 'import' | 'declaration';
    preview: string;
    position: number;
  }> = [];

  for (const referencedSymbol of references) {
    for (const ref of referencedSymbol.references) {
      const sourceFile = ts.createSourceFile(
        ref.fileName,
        fs.readFileSync(ref.fileName, 'utf-8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const start = sourceFile.getLineAndCharacterOfPosition(ref.textSpan.start);
      flattened.push({
        fileName: ref.fileName,
        line: start.line + 1,
        column: start.character + 1,
        kind: ref.isDefinition ? 'declaration' : classifyReference(ref.fileName, ref.textSpan.start),
        preview: linePreview(ref.fileName, start.line + 1),
        position: ref.textSpan.start,
      });
    }
  }

  return flattened.slice(0, maxResults);
}

export function getTsSemanticRenameLocations(options: {
  rootDir: string;
  directory?: string;
  symbol: string;
  maxResults?: number;
}) {
  const context = createProjectContext(options.rootDir, options.directory);
  if (!context) return null;
  const candidate = findDeclarationCandidates(context, options.symbol)[0];
  if (!candidate) return null;

  const maxResults = Math.min(200, Math.max(1, Math.floor(options.maxResults ?? 100)));
  const locations =
    context.languageService.findRenameLocations(candidate.fileName, candidate.position, false, false, true) || [];

  return locations.slice(0, maxResults).map((location) => {
    const sourceFile = ts.createSourceFile(
      location.fileName,
      fs.readFileSync(location.fileName, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const start = sourceFile.getLineAndCharacterOfPosition(location.textSpan.start);
    return {
      fileName: location.fileName,
      line: start.line + 1,
      column: start.character + 1,
      start: location.textSpan.start,
      end: location.textSpan.start + location.textSpan.length,
      kind: classifyReference(location.fileName, location.textSpan.start),
      preview: linePreview(location.fileName, start.line + 1),
    };
  });
}
