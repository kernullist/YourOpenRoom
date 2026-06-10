import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type { Plugin } from 'vite';
import { getAoiLlmStatus } from './dewdropCanvasPlugin';
import {
  buildAoiResearchArtifactPaths,
  isAoiResearchArtifactName,
  type AoiResearchArtifactName,
  type AoiResearchCancelResponse,
  type AoiResearchLanguage,
  type AoiResearchManifest,
  type AoiResearchMode,
  type AoiResearchRecency,
  type AoiResearchSourceCounts,
  type AoiResearchStartRequest,
} from './aoiResearchTypes';

const API_PREFIX = '/api/aoi-research';
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_SOURCE_COUNTS: AoiResearchSourceCounts = {
  planned: 0,
  candidates: 0,
  accepted: 0,
  failed: 0,
};

export interface AoiResearchPluginOptions {
  configFile: string;
  sessionsDir: string;
}

interface ResolvedRunPaths {
  runDir: string;
  manifest: string;
  report: string;
  sources: string;
  evidence: string;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

export function normalizeAoiResearchSessionPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) {
    return null;
  }
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

export function isValidAoiResearchRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,96}$/.test(value);
}

export function getAoiResearchRoute(pathname: string): string | null {
  if (!pathname.startsWith(API_PREFIX)) {
    return null;
  }
  return pathname.slice(API_PREFIX.length) || '/';
}

function normalizeMode(value: unknown): AoiResearchMode {
  return value === 'quick' || value === 'deep' ? value : 'standard';
}

function normalizeLanguage(value: unknown): AoiResearchLanguage {
  return value === 'ko' || value === 'en' ? value : 'match-user';
}

function normalizeRecency(value: unknown): AoiResearchRecency {
  if (value === 'day' || value === 'week' || value === 'month' || value === 'year') {
    return value;
  }
  return 'any';
}

function normalizeMaxSources(value: unknown, mode: AoiResearchMode): number {
  const fallback = mode === 'quick' ? 5 : mode === 'deep' ? 24 : 12;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(40, Math.max(1, Math.trunc(parsed)));
}

function generateRunId(now = Date.now()): string {
  return `aoi-research-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

function resolveRunPaths(
  sessionsDir: string,
  sessionPath: string,
  runId: string,
): ResolvedRunPaths {
  const sessionsRoot = resolve(sessionsDir);
  const runDir = resolve(sessionsRoot, sessionPath, 'aoi-research', 'runs', runId);
  if (!isPathInsideRoot(sessionsRoot, runDir)) {
    throw new Error('Resolved research run path escaped the sessions directory.');
  }
  return {
    runDir,
    manifest: join(runDir, 'manifest.json'),
    report: join(runDir, 'report.md'),
    sources: join(runDir, 'sources.json'),
    evidence: join(runDir, 'evidence.json'),
  };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString() || '{}';
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Request body must be a JSON object.'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeJsonFile(filePath: string, content: unknown): void {
  writeTextFile(filePath, JSON.stringify(content, null, 2));
}

function readManifest(filePath: string): AoiResearchManifest | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<AoiResearchManifest>;
  if (parsed.version !== 1 || typeof parsed.id !== 'string') {
    return null;
  }
  return parsed as AoiResearchManifest;
}

function createNotImplementedManifest(params: {
  body: AoiResearchStartRequest;
  sessionPath: string;
  runId: string;
  now: number;
}): AoiResearchManifest {
  const mode = normalizeMode(params.body.mode);
  const error = {
    code: 'engine_not_implemented',
    message: 'Aoi research engine collection and synthesis are not implemented in this phase.',
    phase: 'engine_not_implemented' as const,
    createdAt: params.now,
  };
  return {
    version: 1,
    id: params.runId,
    sessionPath: params.sessionPath,
    request: params.body.request.trim(),
    mode,
    language: normalizeLanguage(params.body.language),
    recency: normalizeRecency(params.body.recency),
    maxSources: normalizeMaxSources(params.body.maxSources, mode),
    createdAt: params.now,
    updatedAt: params.now,
    status: 'failed',
    phase: 'engine_not_implemented',
    statusMessage: error.message,
    sourceCounts: { ...DEFAULT_SOURCE_COUNTS },
    artifactPaths: buildAoiResearchArtifactPaths(params.runId),
    error,
  };
}

function readArtifactContent(paths: ResolvedRunPaths, artifact: AoiResearchArtifactName): unknown {
  const filePath = paths[artifact];
  if (!fs.existsSync(filePath)) {
    throw new Error(`Research artifact not found: ${artifact}`);
  }
  if (artifact === 'report') {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
}

function persistInitialArtifacts(paths: ResolvedRunPaths, manifest: AoiResearchManifest): void {
  const placeholderReport = [
    `# ${manifest.request}`,
    '',
    'The Aoi research foundation is installed, but the collection and synthesis engine is not implemented in this phase.',
    '',
    `Run id: ${manifest.id}`,
    `Status: ${manifest.status}`,
    `Reason: ${manifest.error?.code ?? 'unknown'}`,
    '',
  ].join('\n');
  writeJsonFile(paths.manifest, manifest);
  writeTextFile(paths.report, placeholderReport);
  writeJsonFile(paths.sources, {
    version: 1,
    runId: manifest.id,
    sources: [],
  });
  writeJsonFile(paths.evidence, {
    version: 1,
    runId: manifest.id,
    claims: [],
  });
}

function getRunPathsFromRequest(
  sessionsDir: string,
  sessionPathRaw: unknown,
  runIdRaw: unknown,
): { sessionPath: string; runId: string; paths: ResolvedRunPaths } | string {
  const sessionPath = normalizeAoiResearchSessionPath(sessionPathRaw);
  if (!sessionPath) {
    return 'Invalid or missing sessionPath.';
  }
  if (!isValidAoiResearchRunId(runIdRaw)) {
    return 'Invalid or missing runId.';
  }
  try {
    return {
      sessionPath,
      runId: runIdRaw,
      paths: resolveRunPaths(sessionsDir, sessionPath, runIdRaw),
    };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function handleAoiResearchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
  configFile: string,
): Promise<boolean> {
  const route = getAoiResearchRoute(url.pathname);
  if (route === null) {
    return false;
  }

  try {
    if (req.method === 'POST' && route === '/start') {
      const body = await readJsonBody(req);
      const request = typeof body.request === 'string' ? body.request.trim() : '';
      const sessionPath = normalizeAoiResearchSessionPath(body.sessionPath);
      if (!sessionPath) {
        writeJson(res, 400, { error: 'Invalid or missing sessionPath.' });
        return true;
      }
      if (!request) {
        writeJson(res, 400, { error: 'Missing research request.' });
        return true;
      }

      const now = Date.now();
      const runId = generateRunId(now);
      const paths = resolveRunPaths(sessionsDir, sessionPath, runId);
      const manifest = createNotImplementedManifest({
        body: {
          sessionPath,
          request,
          mode: normalizeMode(body.mode),
          language: normalizeLanguage(body.language),
          recency: normalizeRecency(body.recency),
          maxSources: normalizeMaxSources(body.maxSources, normalizeMode(body.mode)),
        },
        sessionPath,
        runId,
        now,
      });
      persistInitialArtifacts(paths, manifest);
      writeJson(res, 200, {
        ok: true,
        run: manifest,
        artifactPaths: manifest.artifactPaths,
        aoiMainLlm: getAoiLlmStatus(configFile),
      });
      return true;
    }

    if (req.method === 'GET' && route === '/status') {
      const resolved = getRunPathsFromRequest(
        sessionsDir,
        url.searchParams.get('sessionPath'),
        url.searchParams.get('runId'),
      );
      if (typeof resolved === 'string') {
        writeJson(res, 400, { error: resolved });
        return true;
      }
      const manifest = readManifest(resolved.paths.manifest);
      if (!manifest) {
        writeJson(res, 404, { error: 'Research run not found.' });
        return true;
      }
      writeJson(res, 200, { ok: true, run: manifest });
      return true;
    }

    if (req.method === 'GET' && route === '/artifact') {
      const resolved = getRunPathsFromRequest(
        sessionsDir,
        url.searchParams.get('sessionPath'),
        url.searchParams.get('runId'),
      );
      if (typeof resolved === 'string') {
        writeJson(res, 400, { error: resolved });
        return true;
      }
      const artifactRaw = url.searchParams.get('artifact') || '';
      if (!isAoiResearchArtifactName(artifactRaw)) {
        writeJson(res, 400, {
          error: 'artifact must be one of manifest, report, sources, evidence',
        });
        return true;
      }
      const content = readArtifactContent(resolved.paths, artifactRaw);
      writeJson(res, 200, {
        ok: true,
        runId: resolved.runId,
        artifact: artifactRaw,
        contentType: artifactRaw === 'report' ? 'text/markdown' : 'application/json',
        content,
      });
      return true;
    }

    if (req.method === 'POST' && route === '/cancel') {
      const body = await readJsonBody(req);
      const resolved = getRunPathsFromRequest(sessionsDir, body.sessionPath, body.runId);
      if (typeof resolved === 'string') {
        writeJson(res, 400, { error: resolved });
        return true;
      }
      const manifest = readManifest(resolved.paths.manifest);
      if (!manifest) {
        writeJson(res, 404, { error: 'Research run not found.' });
        return true;
      }
      const now = Date.now();
      const reason =
        typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim().slice(0, 240)
          : 'Cancelled by user.';
      const nextManifest: AoiResearchManifest = {
        ...manifest,
        updatedAt: now,
        completedAt: manifest.completedAt ?? now,
        status: manifest.status === 'completed' ? manifest.status : 'cancelled',
        phase: manifest.status === 'completed' ? manifest.phase : 'cancelled',
        statusMessage: manifest.status === 'completed' ? manifest.statusMessage : reason,
      };
      writeJsonFile(resolved.paths.manifest, nextManifest);
      const response: AoiResearchCancelResponse = { ok: true, run: nextManifest };
      writeJson(res, 200, response);
      return true;
    }

    writeJson(res, 404, { error: 'Unknown Aoi research route.' });
    return true;
  } catch (error) {
    writeJson(res, error instanceof SyntaxError ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

export function aoiResearchPlugin(options: AoiResearchPluginOptions): Plugin {
  const sessionsDir = resolve(options.sessionsDir);
  const configFile = resolve(options.configFile);

  const mount = (middlewares: {
    use: (
      middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
    ) => void;
  }): void => {
    middlewares.use((req, res, next) => {
      const url = new URL(req.url || '/', 'http://localhost');
      void handleAoiResearchRequest(req, res, url, sessionsDir, configFile)
        .then((handled) => {
          if (!handled) {
            next();
          }
        })
        .catch((error) => {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
    });
  };

  return {
    name: 'aoi-research',
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
