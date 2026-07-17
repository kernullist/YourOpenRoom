import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_FILE_COUNT = 30_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function isPathInsideRoot(root: string, target: string): boolean {
  const diff = relative(resolve(root), resolve(target));
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isClaimRelevantPath(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  return (
    normalized.startsWith('apps/webuiapps/src/') ||
    normalized === 'apps/webuiapps/package.json' ||
    /^apps\/webuiapps\/vite[^/]*\.ts$/u.test(normalized) ||
    normalized === 'package.json' ||
    normalized === 'pnpm-lock.yaml' ||
    normalized === 'pnpm-workspace.yaml'
  );
}

export function hashAoiWorkspaceCodeFiles(
  workspaceRoot: string,
  relativePaths: readonly string[],
): string {
  const root = resolve(workspaceRoot);
  const paths = [
    ...new Set(relativePaths.map(normalizeRelativePath).filter(isClaimRelevantPath)),
  ].sort((left, right) => left.localeCompare(right));
  if (paths.length === 0 || paths.length > MAX_FILE_COUNT) {
    throw new Error('No bounded claim-relevant code file set was found.');
  }
  const hasher = createHash('sha256');
  hasher.update('aoi-workspace-code-fingerprint:v1\n');
  let totalBytes = 0;
  for (const relativePath of paths) {
    const filePath = resolve(root, relativePath);
    if (!isPathInsideRoot(root, filePath)) {
      throw new Error('A claim-relevant code path escaped the workspace root.');
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      hasher.update(`symlink:${relativePath}:${fs.readlinkSync(filePath)}\n`);
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error('A claim-relevant code file is invalid or too large.');
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Claim-relevant code files exceed the fingerprint budget.');
    }
    hasher.update(`file:${relativePath}:${stat.size}\n`);
    hasher.update(fs.readFileSync(filePath));
    hasher.update('\n');
  }
  return hasher.digest('hex');
}

export function resolveAoiWorkspaceCodeFingerprint(workspaceRoot: string): string | null {
  try {
    const root = resolve(workspaceRoot);
    const gitRoot = String(
      execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    if (!gitRoot) {
      return null;
    }
    const output = execFileSync(
      'git',
      ['-C', gitRoot, 'ls-files', '-co', '--exclude-standard', '-z'],
      {
        encoding: 'buffer',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const relativePaths = output
      .toString('utf8')
      .split('\0')
      .map((item) => item.trim())
      .filter(Boolean);
    return hashAoiWorkspaceCodeFiles(gitRoot, relativePaths);
  } catch {
    return null;
  }
}
