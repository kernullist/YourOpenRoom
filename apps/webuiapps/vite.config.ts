import { UserConfigExport, ConfigEnv, loadEnv } from 'vite';
import type { PluginOption, Plugin } from 'vite';
import { spawn } from 'child_process';
import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import autoprefixer from 'autoprefixer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import * as fs from 'fs';
import * as os from 'os';
import { basename, dirname, join } from 'path';
import { cyberNewsProxyPlugin } from './src/lib/cyberNewsProxyPlugin';
import { dewdropCanvasPlugin } from './src/lib/dewdropCanvasPlugin';
import { writtenByMePlugin } from './src/lib/writtenByMePlugin';
import { aoiAutonomyPlugin } from './src/lib/aoiAutonomyPlugin';
import { aoiResearchPlugin } from './src/lib/aoiResearchPlugin';
import { generateLogFileName, createLogMiddleware } from './src/lib/logPlugin';
import { appGeneratorPlugin } from './src/lib/appGeneratorPlugin';
import { gmailPlugin } from './src/lib/gmailPlugin';
import { idaPePlugin } from './src/lib/idaPePlugin';
import {
  getProjectProfilePath,
  loadProjectIntelligenceProfile,
  kiraAutomationPlugin,
  refreshProjectIntelligenceProfile,
  resolveProjectSettings,
  validateKiraOrchestrationContract,
} from './src/lib/kiraAutomationPlugin';
import {
  normalizeReasoningEffort,
  normalizeReasoningSummary,
  normalizeServiceTier,
  normalizeVerbosity,
} from './src/lib/llmModels';
import { searchOpenVscodeWorkspace } from './src/lib/openVscodeSearch';
import {
  applyWorkspaceRename,
  buildRenamePreview,
  findWorkspaceReferences,
  listWorkspaceExports,
  peekWorkspaceDefinition,
} from './src/lib/openVscodeSemantic';
import { searchWorkspaceSymbol } from './src/lib/openVscodeSymbol';
import { validateWorkspaceCommand } from './src/lib/workspaceCommandPolicy';

const LLM_CONFIG_FILE = resolve(os.homedir(), '.openroom', 'config.json');
const SESSIONS_DIR = resolve(os.homedir(), '.openroom', 'sessions');
const CHARACTERS_FILE = resolve(os.homedir(), '.openroom', 'characters.json');
const MODS_FILE = resolve(os.homedir(), '.openroom', 'mods.json');
const OPENROOM_ROOT = resolve(__dirname, '../..');
const CODEX_CLI_FALLBACK_MODEL = 'gpt-5.5';
const DEFAULT_TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const CLI_CHAT_TIMEOUT_MS = 180_000;
const CLI_HEALTH_TIMEOUT_MS = 15_000;
const CLAUDE_CLI_SMOKE_TIMEOUT_MS = 60_000;
const CODEX_AUTH_LOGIN_OUTPUT_LIMIT = 12_000;
const MODEL_USAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const CODEX_AUTH_COMMAND = 'codex';

function readPersistedConfigFile(): Record<string, unknown> {
  try {
    if (!fs.existsSync(LLM_CONFIG_FILE)) return {};
    const raw = fs.readFileSync(LLM_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTavilySearchEndpoint(baseUrl?: string): string {
  const trimmed = baseUrl?.trim() || DEFAULT_TAVILY_SEARCH_ENDPOINT;
  if (/\/search\/?$/i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `${trimmed.replace(/\/+$/, '')}/search`;
}

function getAlbumPhotoDirectory(): string | null {
  const config = readPersistedConfigFile();
  const album = config.album as { photoDirectory?: string } | undefined;
  const dir = album?.photoDirectory?.trim();
  return dir ? dir : null;
}

function getKiraWorkRootDirectory(): string | null {
  const config = readPersistedConfigFile();
  const kira = config.kira as { workRootDirectory?: string } | undefined;
  const dir = kira?.workRootDirectory?.trim();
  return dir ? dir : null;
}

const KIRA_PROJECT_ROOT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'settings.gradle',
  'deno.json',
];
const KIRA_PROJECT_SETTINGS_DIR_NAME = '.kira';
const KIRA_PROJECT_SETTINGS_FILE_NAME = 'project-settings.json';
const MAX_KIRA_PROJECT_REQUIRED_INSTRUCTIONS_CHARS = 12000;

type KiraRunMode = 'quick' | 'standard' | 'deep';

interface KiraRulePackSetting {
  id: string;
  enabled: boolean;
}

const KIRA_RULE_PACK_PRESETS = [
  {
    id: 'strict-typescript',
    label: 'Strict TypeScript',
    description: 'Prefer explicit contracts, typed boundaries, and no avoidable any casts.',
    instructions: [
      'Preserve strict TypeScript safety; do not introduce implicit any, broad any casts, or unchecked optional access.',
      'When changing exported APIs, update related types, normalizers, and tests together.',
    ],
  },
  {
    id: 'small-patch',
    label: 'Small Patch',
    description: 'Keep changes narrow, reversible, and directly tied to the task.',
    instructions: [
      'Keep patches tightly scoped to the work brief and avoid opportunistic refactors.',
      'Explain any out-of-plan file change and treat broad rewrites as review-blocking unless justified by the brief.',
    ],
  },
  {
    id: 'validation-first',
    label: 'Validation First',
    description: 'Require concrete verification evidence before approval.',
    instructions: [
      'Prefer existing test, lint, typecheck, or build commands and record exact validation evidence.',
      'Do not approve unless failed checks are fixed or the validation gap is explicitly justified as non-applicable.',
    ],
  },
  {
    id: 'frontend-runtime',
    label: 'Frontend Runtime',
    description: 'For UI changes, inspect runtime behavior when a dev server already exists.',
    instructions: [
      'For frontend-visible changes, verify rendering or runtime reachability when a dev server is already running.',
      'Do not start a dev server automatically; only use an already-running local server for runtime checks.',
    ],
  },
  {
    id: 'safe-refactor',
    label: 'Safe Refactor',
    description: 'Protect behavior while changing structure.',
    instructions: [
      'For refactors, preserve public behavior and call sites unless the brief explicitly changes them.',
      'Reviewer must compare before/after intent and reject behavior drift without evidence.',
    ],
  },
  {
    id: 'docs-safe',
    label: 'Docs Safe',
    description: 'Keep docs, examples, and code references synchronized.',
    instructions: [
      'When behavior or commands change, update adjacent docs, examples, or comments that would become misleading.',
      'Do not add docs claims that are not backed by the actual implementation.',
    ],
  },
];

interface KiraProjectSettingsFile {
  autoCommit?: boolean;
  requiredInstructions?: string;
  runMode?: KiraRunMode;
  rulePacks?: unknown;
  [key: string]: unknown;
}

function getKiraProjectDefaultSettings(): KiraProjectSettingsFile {
  const config = readPersistedConfigFile();
  const kira = config.kira as { projectDefaults?: KiraProjectSettingsFile } | undefined;
  const defaults = kira?.projectDefaults;
  return typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
    ? defaults
    : {};
}

function isKiraProjectRoot(directory: string): boolean {
  try {
    return KIRA_PROJECT_ROOT_MARKERS.some((marker) => fs.existsSync(join(directory, marker)));
  } catch {
    return false;
  }
}

function listKiraProjects(resolvedRoot: string): Array<{ name: string; path: string }> {
  if (isKiraProjectRoot(resolvedRoot)) {
    return [
      {
        name: basename(resolvedRoot),
        path: resolvedRoot,
      },
    ];
  }

  return fs
    .readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      path: resolve(resolvedRoot, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeKiraRequiredInstructions(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, MAX_KIRA_PROJECT_REQUIRED_INSTRUCTIONS_CHARS);
}

function normalizeKiraRunMode(value: unknown, fallback: KiraRunMode = 'standard'): KiraRunMode {
  return value === 'quick' || value === 'standard' || value === 'deep' ? value : fallback;
}

function normalizeKiraRulePacks(
  value: unknown,
  fallback: KiraRulePackSetting[] = [],
): KiraRulePackSetting[] {
  const fallbackEnabled = new Map(fallback.map((item) => [item.id, item.enabled]));
  const rawEnabled = new Map<string, boolean>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        rawEnabled.set(item, true);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const parsed = item as Partial<KiraRulePackSetting>;
      if (typeof parsed.id === 'string' && parsed.id.trim()) {
        rawEnabled.set(parsed.id.trim(), parsed.enabled !== false);
      }
    }
  }
  return KIRA_RULE_PACK_PRESETS.map((preset) => ({
    id: preset.id,
    enabled: rawEnabled.has(preset.id)
      ? Boolean(rawEnabled.get(preset.id))
      : Boolean(fallbackEnabled.get(preset.id)),
  }));
}

function readKiraProjectSettingsFile(settingsPath: string): KiraProjectSettingsFile {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as KiraProjectSettingsFile)
      : {};
  } catch {
    return {};
  }
}

function getKiraProjectSettingsPath(projectRoot: string): string {
  return join(projectRoot, KIRA_PROJECT_SETTINGS_DIR_NAME, KIRA_PROJECT_SETTINGS_FILE_NAME);
}

function resolveKiraProjectEntry(
  projectName: string,
): { name: string; path: string; workRootDirectory: string } | null {
  const workRootDirectory = getKiraWorkRootDirectory();
  if (!workRootDirectory) return null;

  const resolvedRoot = resolve(workRootDirectory);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) return null;

  const normalizedName = projectName.trim().toLowerCase();
  const project = listKiraProjects(resolvedRoot).find(
    (entry) => entry.name.toLowerCase() === normalizedName,
  );
  return project ? { ...project, workRootDirectory: resolvedRoot } : null;
}

function buildKiraProjectSettingsResponse(project: { name: string; path: string }) {
  const settingsPath = getKiraProjectSettingsPath(project.path);
  const raw = readKiraProjectSettingsFile(settingsPath);
  const defaults = getKiraProjectDefaultSettings();
  const hasLocalRequiredInstructions = Object.prototype.hasOwnProperty.call(
    raw,
    'requiredInstructions',
  );
  const inheritedRequiredInstructions = hasLocalRequiredInstructions
    ? ''
    : normalizeKiraRequiredInstructions(defaults.requiredInstructions);
  const resolvedSettings = resolveProjectSettings(raw, defaults);
  const validation = validateKiraOrchestrationContract(
    {
      executionPolicy: raw.executionPolicy ?? defaults.executionPolicy,
      environment: raw.environment ?? defaults.environment,
      subagents: raw.subagents ?? defaults.subagents,
      workflow: raw.workflow ?? defaults.workflow,
      plugins: raw.plugins ?? defaults.plugins,
    },
    resolvedSettings.runMode,
  );
  const requiredInstructions = resolvedSettings.requiredInstructions;
  return {
    projectName: project.name,
    projectRoot: project.path,
    settingsPath,
    exists: fs.existsSync(settingsPath),
    hasLocalRequiredInstructions,
    inheritedRequiredInstructions,
    rulePackPresets: KIRA_RULE_PACK_PRESETS,
    validation,
    settings: {
      autoCommit: resolvedSettings.autoCommit,
      requiredInstructions,
      effectiveInstructions: resolvedSettings.effectiveInstructions,
      runMode: resolvedSettings.runMode,
      rulePacks: resolvedSettings.rulePacks,
      executionPolicy: resolvedSettings.executionPolicy,
      environment: resolvedSettings.environment,
      subagents: resolvedSettings.subagents,
      workflow: resolvedSettings.workflow,
      plugins: resolvedSettings.plugins,
    },
  };
}

function buildKiraProjectProfileResponse(project: { name: string; path: string }) {
  const profile = loadProjectIntelligenceProfile(project.path);
  return {
    projectName: project.name,
    projectRoot: project.path,
    profilePath: getProjectProfilePath(project.path),
    exists: fs.existsSync(getProjectProfilePath(project.path)),
    profile,
  };
}

function getTavilyConfig(): { apiKey: string; baseUrl: string } | null {
  const config = readPersistedConfigFile();
  const tavily = config.tavily as { apiKey?: string; baseUrl?: string } | undefined;
  const apiKey = tavily?.apiKey?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: normalizeTavilySearchEndpoint(tavily?.baseUrl),
  };
}

function getOpenVscodeConfig(): {
  baseUrl: string | null;
  executablePath: string;
  workspacePath: string;
  host: string;
  port: number;
  connectionToken: string | null;
} {
  const config = readPersistedConfigFile();
  const ide = config.openvscode as
    | {
        baseUrl?: string;
        executablePath?: string;
        workspacePath?: string;
        host?: string;
        port?: number;
        connectionToken?: string;
      }
    | undefined;

  const port =
    typeof ide?.port === 'number' && Number.isFinite(ide.port) && ide.port > 0
      ? Math.floor(ide.port)
      : 3001;

  return {
    baseUrl: ide?.baseUrl?.trim() || null,
    executablePath: ide?.executablePath?.trim() || 'openvscode-server',
    workspacePath: ide?.workspacePath?.trim() || OPENROOM_ROOT,
    host: ide?.host?.trim() || '127.0.0.1',
    port,
    connectionToken: ide?.connectionToken?.trim() || null,
  };
}

function albumFolderPlugin(): Plugin {
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
  const MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
  };

  const walkImages = (
    rootDir: string,
    currentDir: string,
  ): Array<{ relativePath: string; absolutePath: string }> => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const files: Array<{ relativePath: string; absolutePath: string }> = [];

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkImages(rootDir, absolutePath));
        continue;
      }

      const ext = absolutePath.slice(absolutePath.lastIndexOf('.')).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      const relativePath = absolutePath
        .slice(rootDir.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/');
      files.push({ relativePath, absolutePath });
    }

    return files;
  };

  return {
    name: 'album-folder',
    configureServer(server) {
      server.middlewares.use('/api/album-files', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const rootDir = getAlbumPhotoDirectory();
          if (!rootDir) {
            res.writeHead(200);
            res.end(JSON.stringify({ configured: false, photoDirectory: null, files: [] }));
            return;
          }

          const resolvedRoot = resolve(rootDir);
          if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                configured: true,
                exists: false,
                photoDirectory: resolvedRoot,
                files: [],
              }),
            );
            return;
          }

          const files = walkImages(resolvedRoot, resolvedRoot)
            .map(({ relativePath, absolutePath }) => {
              const stat = fs.statSync(absolutePath);
              const folder = relativePath.includes('/')
                ? relativePath.slice(0, relativePath.lastIndexOf('/'))
                : '';
              return {
                id: relativePath,
                name: relativePath.split('/').pop() || relativePath,
                relativePath,
                folder,
                src: `/api/album-file?path=${encodeURIComponent(relativePath)}`,
                createdAt: stat.mtimeMs,
                size: stat.size,
              };
            })
            .sort((a, b) => b.createdAt - a.createdAt);

          res.writeHead(200);
          res.end(
            JSON.stringify({
              configured: true,
              exists: true,
              photoDirectory: resolvedRoot,
              files,
            }),
          );
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use('/api/album-file', (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const rootDir = getAlbumPhotoDirectory();
          const url = new URL(req.url || '', 'http://localhost');
          const relPath = url.searchParams.get('path') || '';
          if (!rootDir || !relPath) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
          }

          const resolvedRoot = resolve(rootDir);
          const candidatePath = resolve(resolvedRoot, relPath);
          const rootPrefix =
            resolvedRoot.endsWith('\\') || resolvedRoot.endsWith('/')
              ? resolvedRoot
              : `${resolvedRoot}${os.platform() === 'win32' ? '\\' : '/'}`;
          if (candidatePath !== resolvedRoot && !candidatePath.startsWith(rootPrefix)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden path' }));
            return;
          }

          if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
          }

          const ext = candidatePath.slice(candidatePath.lastIndexOf('.')).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(fs.readFileSync(candidatePath));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

function kiraConfigPlugin(): Plugin {
  return {
    name: 'kira-config',
    configureServer(server) {
      server.middlewares.use('/api/kira-config', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const workRootDirectory = getKiraWorkRootDirectory();
          if (!workRootDirectory) {
            res.writeHead(200);
            res.end(JSON.stringify({ configured: false, projects: [] }));
            return;
          }

          const resolvedRoot = resolve(workRootDirectory);
          const exists = fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory();

          const projects = exists ? listKiraProjects(resolvedRoot) : [];

          res.writeHead(200);
          res.end(
            JSON.stringify({
              configured: true,
              exists,
              workRootDirectory: resolvedRoot,
              projects,
            }),
          );
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });

      server.middlewares.use('/api/kira-project-settings', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          try {
            const url = new URL(req.url || '', 'http://localhost');
            const projectName = url.searchParams.get('projectName')?.trim() || '';
            if (!projectName) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing projectName' }));
              return;
            }

            const project = resolveKiraProjectEntry(projectName);
            if (!project) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: 'Project not found' }));
              return;
            }

            res.writeHead(200);
            res.end(JSON.stringify(buildKiraProjectSettingsResponse(project)));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<
                string,
                unknown
              >;
              const projectName =
                typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!projectName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing projectName' }));
                return;
              }

              const project = resolveKiraProjectEntry(projectName);
              if (!project) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Project not found' }));
                return;
              }

              const settingsPath = getKiraProjectSettingsPath(project.path);
              const nextSettings = readKiraProjectSettingsFile(settingsPath);
              if (typeof body.autoCommit === 'boolean') {
                nextSettings.autoCommit = body.autoCommit;
              }

              if (Object.prototype.hasOwnProperty.call(body, 'requiredInstructions')) {
                nextSettings.requiredInstructions = normalizeKiraRequiredInstructions(
                  body.requiredInstructions,
                );
              }

              if (Object.prototype.hasOwnProperty.call(body, 'runMode')) {
                nextSettings.runMode = normalizeKiraRunMode(body.runMode);
              }

              if (Object.prototype.hasOwnProperty.call(body, 'rulePacks')) {
                nextSettings.rulePacks = normalizeKiraRulePacks(body.rulePacks);
              }

              for (const key of [
                'executionPolicy',
                'environment',
                'subagents',
                'workflow',
                'plugins',
              ]) {
                if (Object.prototype.hasOwnProperty.call(body, key)) {
                  nextSettings[key] = body[key];
                }
              }

              const validation = validateKiraOrchestrationContract(
                {
                  executionPolicy: nextSettings.executionPolicy,
                  environment: nextSettings.environment,
                  subagents: nextSettings.subagents,
                  workflow: nextSettings.workflow,
                  plugins: nextSettings.plugins,
                },
                normalizeKiraRunMode(nextSettings.runMode),
              );
              if (!validation.valid) {
                res.writeHead(400);
                res.end(
                  JSON.stringify({
                    error: 'Invalid Kira orchestration contract',
                    validation,
                  }),
                );
                return;
              }

              fs.mkdirSync(dirname(settingsPath), { recursive: true });
              fs.writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2), 'utf-8');

              res.writeHead(200);
              res.end(JSON.stringify(buildKiraProjectSettingsResponse(project)));
            } catch (err) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          });
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });

      server.middlewares.use('/api/kira-project-profile', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          try {
            const url = new URL(req.url || '', 'http://localhost');
            const projectName = url.searchParams.get('projectName')?.trim() || '';
            if (!projectName) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing projectName' }));
              return;
            }

            const project = resolveKiraProjectEntry(projectName);
            if (!project) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: 'Project not found' }));
              return;
            }

            res.writeHead(200);
            res.end(JSON.stringify(buildKiraProjectProfileResponse(project)));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<
                string,
                unknown
              >;
              const projectName =
                typeof body.projectName === 'string' ? body.projectName.trim() : '';
              if (!projectName) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Missing projectName' }));
                return;
              }

              const project = resolveKiraProjectEntry(projectName);
              if (!project) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Project not found' }));
                return;
              }

              refreshProjectIntelligenceProfile(project.path, project.name);
              res.writeHead(200);
              res.end(JSON.stringify(buildKiraProjectProfileResponse(project)));
            } catch (err) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          });
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });
    },
  };
}

function browserReaderProxyPlugin(): Plugin {
  const FETCH_TIMEOUT_MS = 10000;
  const injectBaseHref = (html: string, finalUrl: string): string => {
    const cleaned = html.replace(
      /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
      '',
    );
    const baseTag = `<base href="${finalUrl}">`;
    if (/<head[^>]*>/i.test(cleaned)) {
      return cleaned.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    }
    return `${baseTag}${cleaned}`;
  };

  return {
    name: 'browser-reader-proxy',
    configureServer(server) {
      server.middlewares.use('/api/browser-reader', async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const targetRaw = url.searchParams.get('url') || '';
          if (!targetRaw) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
          }

          const target = new URL(targetRaw);
          if (!['http:', 'https:'].includes(target.protocol)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Only http and https URLs are supported' }));
            return;
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          const fetchRes = await fetch(target.toString(), {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
              accept: 'text/html,application/xhtml+xml',
            },
          }).finally(() => clearTimeout(timer));

          const contentType = fetchRes.headers.get('content-type') || 'text/html; charset=utf-8';
          if (!contentType.toLowerCase().includes('text/html')) {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `Unsupported content type: ${contentType}`,
                finalUrl: fetchRes.url,
              }),
            );
            return;
          }

          const html = await fetchRes.text();
          const finalUrl = fetchRes.url || target.toString();
          res.writeHead(fetchRes.status, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Final-Url': finalUrl,
          });
          res.end(injectBaseHref(html, finalUrl));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

function youtubeSearchPlugin(): Plugin {
  const FETCH_TIMEOUT_MS = 10000;
  const extractInitialData = (html: string): Record<string, unknown> | null => {
    const patterns = [
      /var ytInitialData\s*=\s*(\{[\s\S]*?\});<\/script>/,
      /window\[['"]ytInitialData['"]\]\s*=\s*(\{[\s\S]*?\});<\/script>/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match?.[1]) continue;
      try {
        return JSON.parse(match[1]) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  };

  const asText = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) {
      const obj = value as { simpleText?: string; runs?: Array<{ text?: string }> };
      if (typeof obj.simpleText === 'string') return obj.simpleText;
      if (Array.isArray(obj.runs)) {
        return obj.runs.map((run) => run.text || '').join('');
      }
    }
    return '';
  };

  type SearchResult = {
    id: string;
    title: string;
    channel: string;
    duration: string;
    views: string;
    published: string;
    thumbnail: string;
    url: string;
  };

  const collectVideoRenderers = (node: unknown, acc: Array<Record<string, unknown>>) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) collectVideoRenderers(item, acc);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.videoRenderer && typeof obj.videoRenderer === 'object') {
      acc.push(obj.videoRenderer as Record<string, unknown>);
    }
    for (const value of Object.values(obj)) {
      collectVideoRenderers(value, acc);
    }
  };

  const normalizeResults = (items: Array<Record<string, unknown>>): SearchResult[] =>
    items
      .map((item) => {
        const videoId = typeof item.videoId === 'string' ? item.videoId : '';
        if (!videoId) return null;
        const thumbList =
          (item.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails ??
          [];
        return {
          id: videoId,
          title: asText(item.title),
          channel: asText(
            (item.ownerText as Record<string, unknown> | undefined) ??
              (item.longBylineText as Record<string, unknown> | undefined),
          ),
          duration: asText(item.lengthText),
          views: asText(item.viewCountText),
          published: asText(item.publishedTimeText),
          thumbnail: thumbList[thumbList.length - 1]?.url || '',
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      })
      .filter((item): item is SearchResult => item !== null && !!item.title)
      .slice(0, 24);

  return {
    name: 'youtube-search',
    configureServer(server) {
      server.middlewares.use('/api/youtube-search', async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const query = (url.searchParams.get('query') || '').trim();
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing query parameter' }));
            return;
          }

          const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          const fetchRes = await fetch(targetUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'en-US,en;q=0.9',
            },
          }).finally(() => clearTimeout(timer));

          if (!fetchRes.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `YouTube search request failed (${fetchRes.status})`,
              }),
            );
            return;
          }

          const html = await fetchRes.text();
          const initialData = extractInitialData(html);
          if (!initialData) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to parse YouTube results' }));
            return;
          }

          const renderers: Array<Record<string, unknown>> = [];
          collectVideoRenderers(initialData, renderers);
          const results = normalizeResults(renderers);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ query, results }));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

function tavilyProxyPlugin(): Plugin {
  return {
    name: 'tavily-proxy',
    configureServer(server) {
      server.middlewares.use('/api/tavily-search', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const tavily = getTavilyConfig();
        if (!tavily) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'Missing tavily.apiKey in config.json' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString() || '{}';
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
            if (!query) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing Tavily search query' }));
              return;
            }

            const maxResults = Number(parsed.max_results ?? 5);
            const payload: Record<string, unknown> = {
              query,
              topic:
                parsed.topic === 'news' || parsed.topic === 'finance' ? parsed.topic : 'general',
              search_depth:
                parsed.search_depth === 'advanced' ||
                parsed.search_depth === 'fast' ||
                parsed.search_depth === 'ultra-fast'
                  ? parsed.search_depth
                  : 'basic',
              max_results: Number.isFinite(maxResults)
                ? Math.min(10, Math.max(1, Math.trunc(maxResults)))
                : 5,
              include_answer: 'basic',
              include_favicon: true,
            };
            if (
              parsed.time_range === 'day' ||
              parsed.time_range === 'week' ||
              parsed.time_range === 'month' ||
              parsed.time_range === 'year' ||
              parsed.time_range === 'd' ||
              parsed.time_range === 'w' ||
              parsed.time_range === 'm' ||
              parsed.time_range === 'y'
            ) {
              payload.time_range = parsed.time_range;
            }

            const response = await fetch(tavily.baseUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tavily.apiKey}`,
              },
              body: JSON.stringify(payload),
            });

            const text = await response.text();
            if (response.ok) {
              res.writeHead(response.status);
              res.end(text);
              return;
            }

            try {
              JSON.parse(text);
              res.writeHead(response.status);
              res.end(text);
            } catch {
              res.writeHead(response.status);
              res.end(
                JSON.stringify({
                  error: text.trim() || `Tavily API error ${response.status}`,
                }),
              );
            }
          } catch (err) {
            res.writeHead(err instanceof SyntaxError ? 400 : 502);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      });
    },
  };
}

function openVscodeManagerPlugin(): Plugin {
  const IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    '.turbo',
    'dist',
    'build',
    'coverage',
    '.next',
  ]);
  const MAX_FILE_BYTES = 400_000;
  const MAX_COMMAND_OUTPUT_CHARS = 12_000;

  const getWorkspaceRoot = (): string => {
    const config = getOpenVscodeConfig();
    const candidate = config.workspacePath?.trim() || OPENROOM_ROOT;
    return resolve(candidate);
  };

  const ensureInsideWorkspace = (relativePath: string): string => {
    const workspaceRoot = getWorkspaceRoot();
    const candidate = resolve(workspaceRoot, relativePath);
    const prefix =
      workspaceRoot.endsWith('\\') || workspaceRoot.endsWith('/')
        ? workspaceRoot
        : `${workspaceRoot}${os.platform() === 'win32' ? '\\' : '/'}`;
    if (candidate !== workspaceRoot && !candidate.startsWith(prefix)) {
      throw new Error('Path escapes the IDE workspace root.');
    }
    return candidate;
  };

  const toRelativePath = (workspaceRoot: string, absolutePath: string): string =>
    absolutePath
      .slice(workspaceRoot.length)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');

  const normalizeRelativeWorkspaceDirectoryPath = (value: string): string =>
    value
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '');

  const isSafeRelativeWorkspaceDirectoryPath = (relativePath: string): boolean => {
    if (!relativePath || relativePath === '.') return false;
    if (/^(?:[a-zA-Z]:|\/)/.test(relativePath)) return false;
    if (/(^|\/)\.\.(?:\/|$)/.test(relativePath)) return false;
    if (relativePath.split('/').some((segment) => !segment || segment === '.')) return false;
    return true;
  };

  const truncateOutput = (value: string): string => {
    if (value.length <= MAX_COMMAND_OUTPUT_CHARS) return value;
    return `${value.slice(0, MAX_COMMAND_OUTPUT_CHARS).trimEnd()}\n...[truncated]`;
  };

  const resolveExecutable = (program: string): string => {
    if (os.platform() === 'win32' && (program === 'npm' || program === 'pnpm')) {
      return `${program}.cmd`;
    }
    return program;
  };

  const readRequestBody = (
    req: NodeJS.ReadableStream & {
      on: (event: string, listener: (chunk?: Buffer) => void) => void;
    },
    onParsed: (body: Record<string, unknown>) => void | Promise<void>,
    onError: (error: unknown) => void,
  ) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<
          string,
          unknown
        >;
        void onParsed(body);
      } catch (error) {
        onError(error);
      }
    });
  };

  return {
    name: 'simple-ide-workspace',
    configureServer(server) {
      server.middlewares.use('/api/openvscode/workspace', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const workspaceRoot = getWorkspaceRoot();
          const exists = fs.existsSync(workspaceRoot) && fs.statSync(workspaceRoot).isDirectory();
          res.writeHead(200);
          res.end(JSON.stringify({ rootPath: workspaceRoot, exists }));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/list', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const relativePath = (url.searchParams.get('path') || '').trim();
          const workspaceRoot = getWorkspaceRoot();
          const targetDir = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Directory not found' }));
            return;
          }

          const entries = fs
            .readdirSync(targetDir, { withFileTypes: true })
            .filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)))
            .map((entry) => {
              const absolutePath = join(targetDir, entry.name);
              const stat = fs.statSync(absolutePath);
              return {
                name: entry.name,
                path: toRelativePath(workspaceRoot, absolutePath),
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isDirectory() ? 0 : stat.size,
                modifiedAt: stat.mtimeMs,
              };
            })
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          res.writeHead(200);
          res.end(JSON.stringify({ path: relativePath, entries }));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/search', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const query = (url.searchParams.get('query') || '').trim();
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const mode = (url.searchParams.get('mode') || 'auto').trim();
          const maxResultsRaw = Number.parseInt(url.searchParams.get('max_results') || '', 10);
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!query) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing query parameter' }));
            return;
          }

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Search directory not found' }));
            return;
          }

          const result = searchOpenVscodeWorkspace({
            rootDir: workspaceRoot,
            directory: relativePath,
            query,
            mode: mode === 'path' || mode === 'content' ? mode : 'auto',
            maxResults: Number.isFinite(maxResultsRaw) ? maxResultsRaw : 8,
            ignoredDirs: IGNORED_DIRS,
          });

          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/symbol', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!symbol) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
            return;
          }

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Symbol search directory not found' }));
            return;
          }

          const result = searchWorkspaceSymbol({
            rootDir: workspaceRoot,
            directory: relativePath,
            symbol,
            ignoredDirs: IGNORED_DIRS,
          });

          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/references', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const maxResultsRaw = Number.parseInt(url.searchParams.get('max_results') || '', 10);
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!symbol) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
            return;
          }

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Reference search directory not found' }));
            return;
          }

          const result = findWorkspaceReferences({
            rootDir: workspaceRoot,
            directory: relativePath,
            symbol,
            ignoredDirs: IGNORED_DIRS,
            maxResults: Number.isFinite(maxResultsRaw) ? maxResultsRaw : 10,
          });
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/exports', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const maxResultsRaw = Number.parseInt(url.searchParams.get('max_results') || '', 10);
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Export listing directory not found' }));
            return;
          }

          const result = listWorkspaceExports({
            rootDir: workspaceRoot,
            directory: relativePath,
            ignoredDirs: IGNORED_DIRS,
            maxResults: Number.isFinite(maxResultsRaw) ? maxResultsRaw : 10,
          });
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/peek-definition', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!symbol) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing symbol parameter' }));
            return;
          }

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Definition search directory not found' }));
            return;
          }

          const result = peekWorkspaceDefinition({
            rootDir: workspaceRoot,
            directory: relativePath,
            symbol,
            ignoredDirs: IGNORED_DIRS,
          });
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/rename-preview', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const newName = (url.searchParams.get('new_name') || '').trim();
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const maxResultsRaw = Number.parseInt(url.searchParams.get('max_results') || '', 10);
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!symbol || !newName) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing symbol or new_name parameter' }));
            return;
          }

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Rename preview directory not found' }));
            return;
          }

          const result = buildRenamePreview({
            rootDir: workspaceRoot,
            directory: relativePath,
            symbol,
            newName,
            ignoredDirs: IGNORED_DIRS,
            maxResults: Number.isFinite(maxResultsRaw) ? maxResultsRaw : 8,
          });
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/apply-rename', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url || '', 'http://localhost');
          const symbol = (url.searchParams.get('symbol') || '').trim();
          const newName = (url.searchParams.get('new_name') || '').trim();
          const previewSignature = (url.searchParams.get('preview_signature') || '').trim();
          const relativePath = (url.searchParams.get('directory') || '').trim();
          const workspaceRoot = getWorkspaceRoot();
          const targetRoot = relativePath ? ensureInsideWorkspace(relativePath) : workspaceRoot;

          if (!symbol || !newName || !previewSignature) {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: 'Missing symbol, new_name, or preview_signature parameter' }),
            );
            return;
          }

          if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Rename target directory not found' }));
            return;
          }

          const result = applyWorkspaceRename({
            rootDir: workspaceRoot,
            directory: relativePath,
            symbol,
            newName,
            expectedSignature: previewSignature,
            ignoredDirs: IGNORED_DIRS,
          });
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
      });

      server.middlewares.use('/api/openvscode/directory', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        readRequestBody(
          req,
          async (body) => {
            try {
              const relativePath =
                typeof body.path === 'string'
                  ? normalizeRelativeWorkspaceDirectoryPath(body.path)
                  : '';
              if (!isSafeRelativeWorkspaceDirectoryPath(relativePath)) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid directory path' }));
                return;
              }

              const workspaceRoot = getWorkspaceRoot();
              const absolutePath = ensureInsideWorkspace(relativePath);
              if (fs.existsSync(absolutePath)) {
                res.writeHead(409);
                res.end(
                  JSON.stringify({
                    error: fs.statSync(absolutePath).isDirectory()
                      ? 'Directory already exists'
                      : 'A file already exists at that path',
                  }),
                );
                return;
              }

              const parentPath = dirname(absolutePath);
              if (fs.existsSync(parentPath) && !fs.statSync(parentPath).isDirectory()) {
                res.writeHead(409);
                res.end(JSON.stringify({ error: 'Parent path is not a directory' }));
                return;
              }

              fs.mkdirSync(absolutePath, { recursive: true });
              res.writeHead(200);
              res.end(
                JSON.stringify({
                  ok: true,
                  path: toRelativePath(workspaceRoot, absolutePath),
                }),
              );
            } catch (error) {
              res.writeHead(500);
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          },
          (error) => {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
          },
        );
      });

      server.middlewares.use('/api/openvscode/file', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          try {
            const url = new URL(req.url || '', 'http://localhost');
            const relativePath = (url.searchParams.get('path') || '').trim();
            if (!relativePath) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing path parameter' }));
              return;
            }

            const absolutePath = ensureInsideWorkspace(relativePath);
            if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: 'File not found' }));
              return;
            }

            const stat = fs.statSync(absolutePath);
            if (stat.size > MAX_FILE_BYTES) {
              res.writeHead(413);
              res.end(
                JSON.stringify({
                  error: `File is too large to open in the simple IDE (${stat.size} bytes).`,
                }),
              );
              return;
            }

            const content = fs.readFileSync(absolutePath, 'utf-8');
            if (content.includes('\u0000')) {
              res.writeHead(415);
              res.end(
                JSON.stringify({ error: 'Binary files are not supported in the simple IDE.' }),
              );
              return;
            }

            res.writeHead(200);
            res.end(JSON.stringify({ path: relativePath, content }));
          } catch (error) {
            res.writeHead(500);
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
          }
          return;
        }

        if (req.method === 'POST') {
          readRequestBody(
            req,
            async (body) => {
              try {
                const relativePath = typeof body.path === 'string' ? body.path.trim() : '';
                const content = typeof body.content === 'string' ? body.content : '';
                const overwrite = body.overwrite !== false;
                if (!relativePath) {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Missing path field' }));
                  return;
                }

                const absolutePath = ensureInsideWorkspace(relativePath);
                if (!overwrite && fs.existsSync(absolutePath)) {
                  res.writeHead(409);
                  res.end(JSON.stringify({ error: 'File already exists' }));
                  return;
                }
                if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
                  res.writeHead(409);
                  res.end(JSON.stringify({ error: 'Path is a directory' }));
                  return;
                }
                fs.mkdirSync(dirname(absolutePath), { recursive: true });
                fs.writeFileSync(absolutePath, content, 'utf-8');
                const stat = fs.statSync(absolutePath);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, path: relativePath, modifiedAt: stat.mtimeMs }));
              } catch (error) {
                res.writeHead(500);
                res.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            },
            (error) => {
              res.writeHead(400);
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            },
          );
          return;
        }

        if (req.method === 'DELETE') {
          readRequestBody(
            req,
            async (body) => {
              try {
                const relativePath = typeof body.path === 'string' ? body.path.trim() : '';
                if (!relativePath) {
                  res.writeHead(400);
                  res.end(JSON.stringify({ error: 'Missing path field' }));
                  return;
                }

                const absolutePath = ensureInsideWorkspace(relativePath);
                if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
                  fs.unlinkSync(absolutePath);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, path: relativePath }));
              } catch (error) {
                res.writeHead(500);
                res.end(
                  JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                );
              }
            },
            (error) => {
              res.writeHead(400);
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            },
          );
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });

      server.middlewares.use('/api/openvscode/run', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        readRequestBody(
          req,
          async (body) => {
            try {
              const command = typeof body.command === 'string' ? body.command.trim() : '';
              const directory = typeof body.directory === 'string' ? body.directory.trim() : '';
              const timeoutMsRaw =
                typeof body.timeout_ms === 'number'
                  ? Math.floor(body.timeout_ms)
                  : Number.parseInt(String(body.timeout_ms || ''), 10);
              const timeoutMs =
                Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
                  ? Math.min(30_000, Math.max(1_000, timeoutMsRaw))
                  : 15_000;

              const validated = validateWorkspaceCommand(command);
              if (!validated.ok) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: validated.error }));
                return;
              }

              const workspaceRoot = getWorkspaceRoot();
              const cwd = directory ? ensureInsideWorkspace(directory) : workspaceRoot;
              if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Command working directory not found' }));
                return;
              }

              const startedAt = Date.now();
              let stdout = '';
              let stderr = '';
              let timedOut = false;
              let finished = false;

              const child = spawn(resolveExecutable(validated.spec.program), validated.spec.args, {
                cwd,
                env: { ...process.env, FORCE_COLOR: '0' },
                shell: false,
                windowsHide: true,
              });

              child.stdout.on('data', (chunk: Buffer | string) => {
                stdout = truncateOutput(`${stdout}${chunk.toString()}`);
              });
              child.stderr.on('data', (chunk: Buffer | string) => {
                stderr = truncateOutput(`${stderr}${chunk.toString()}`);
              });

              const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
              }, timeoutMs);

              child.on('error', (error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                res.writeHead(500);
                res.end(
                  JSON.stringify({
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
              });

              child.on('close', (code) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                res.writeHead(200);
                res.end(
                  JSON.stringify({
                    command: validated.spec.displayCommand,
                    program: validated.spec.program,
                    args: validated.spec.args,
                    cwd: cwd === workspaceRoot ? '.' : toRelativePath(workspaceRoot, cwd),
                    exitCode: code ?? -1,
                    timedOut,
                    durationMs: Date.now() - startedAt,
                    stdout,
                    stderr,
                  }),
                );
              });
            } catch (error) {
              res.writeHead(500);
              res.end(
                JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              );
            }
          },
          (error) => {
            res.writeHead(400);
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
          },
        );
      });
    },
  };
}

/** LLM config persistence plugin — reads/writes config to ~/.openroom/config.json */
function llmConfigPlugin(): Plugin {
  return {
    name: 'llm-config',
    configureServer(server) {
      server.middlewares.use('/api/llm-config', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          try {
            if (fs.existsSync(LLM_CONFIG_FILE)) {
              const content = fs.readFileSync(LLM_CONFIG_FILE, 'utf-8');
              res.writeHead(200);
              res.end(content);
            } else {
              res.writeHead(200);
              res.end('{}');
            }
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString();
              // Validate JSON before writing
              JSON.parse(body);
              fs.mkdirSync(resolve(os.homedir(), '.openroom'), { recursive: true });
              fs.writeFileSync(LLM_CONFIG_FILE, body, 'utf-8');
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });
    },
  };
}

/**
 * Session data plugin — reads/writes files under ~/.openroom/sessions/
 * API: /api/session-data?path={charId}/{modId}/chat/history.json
 * Supports GET, POST, DELETE.
 */
function sessionDataPlugin(): Plugin {
  return {
    name: 'session-data',
    configureServer(server) {
      server.middlewares.use('/api/session-data', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        const url = new URL(req.url || '', 'http://localhost');
        const relPath = url.searchParams.get('path') || '';
        const action = url.searchParams.get('action') || '';
        console.info('[SessionData] Request received', {
          method: req.method,
          relPath,
          action,
        });

        if (!relPath) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing path parameter' }));
          return;
        }

        // Sanitize: only allow alphanumeric, underscore, hyphen, dot, forward slash
        const safePath = relPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
        const filePath = join(SESSIONS_DIR, safePath);

        // Directory listing: ?action=list&path=...
        if (action === 'list' && req.method === 'GET') {
          try {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
              res.writeHead(200);
              res.end(JSON.stringify({ files: [], not_exists: !fs.existsSync(filePath) }));
              return;
            }
            const entries = fs.readdirSync(filePath, { withFileTypes: true });
            const files = entries.map((e) => ({
              path: safePath === '' || safePath === '/' ? e.name : `${safePath}/${e.name}`,
              type: e.isDirectory() ? 1 : 0,
              size: e.isDirectory() ? 0 : fs.statSync(join(filePath, e.name)).size,
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ files, not_exists: false }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        if (req.method === 'GET') {
          try {
            if (fs.existsSync(filePath)) {
              const ext = filePath.split('.').pop()?.toLowerCase() || '';
              const binaryMimes: Record<string, string> = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                gif: 'image/gif',
                webp: 'image/webp',
                svg: 'image/svg+xml',
                mp4: 'video/mp4',
                webm: 'video/webm',
              };
              const mime = binaryMimes[ext];
              if (mime) {
                res.setHeader('Content-Type', mime);
                res.writeHead(200);
                res.end(fs.readFileSync(filePath));
              } else {
                res.writeHead(200);
                res.end(fs.readFileSync(filePath, 'utf-8'));
              }
            } else {
              res.writeHead(200);
              res.end('{}');
            }
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              const dir = dirname(filePath);
              fs.mkdirSync(dir, { recursive: true });
              const ct = (req.headers['content-type'] || '').toLowerCase();
              if (
                ct.startsWith('image/') ||
                ct.startsWith('video/') ||
                ct === 'application/octet-stream'
              ) {
                fs.writeFileSync(filePath, buf);
              } else {
                fs.writeFileSync(filePath, buf.toString(), 'utf-8');
              }
              if (safePath.includes('/memory/') || safePath.endsWith('/chat/chat.json')) {
                console.info('[SessionData] Wrote file', {
                  path: safePath,
                  contentType: ct || 'text/plain',
                  bytes: buf.length,
                  preview: buf.toString('utf-8').slice(0, 200),
                });
              }
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              console.error('[SessionData] Failed to write file', {
                path: safePath,
                filePath,
                error: String(err),
              });
              res.writeHead(500);
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });

      // Session reset: DELETE /api/session-data?action=reset&path={charId}/{modId}
      // Recursively removes the entire session directory
      server.middlewares.use('/api/session-reset', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'DELETE') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const url = new URL(req.url || '', 'http://localhost');
        const relPath = url.searchParams.get('path') || '';
        if (!relPath) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing path parameter' }));
          return;
        }

        const safePath = relPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
        const targetDir = join(SESSIONS_DIR, safePath);

        try {
          if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

/** Debug log plugin — writes browser logs to logs/debug-*.log */
function logServerPlugin(): Plugin {
  return {
    name: 'log-server',
    configureServer(server) {
      const logDir = join(__dirname, 'logs');
      const logFile = join(logDir, generateLogFileName());
      const middleware = createLogMiddleware(logFile, fs);

      server.middlewares.use('/api/log', middleware);

      server.httpServer?.once('listening', () => {
        console.log(`\n  [DebugLog] Writing to: ${logFile}\n`);
      });
    },
  };
}

function buildCodexCliChatPrompt(payload: Record<string, unknown>): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const renderedMessages = messages
    .map((message, index) => {
      if (typeof message !== 'object' || message === null) return null;
      const record = message as Record<string, unknown>;
      const role = typeof record.role === 'string' ? record.role : `message-${index + 1}`;
      const content = typeof record.content === 'string' ? record.content : '';
      return `${role.toUpperCase()}:\n${content}`;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');

  return [
    'You are running as the configured Codex CLI model for OpenRoom.',
    'Reply directly to the latest user request. Tool calls are not available through this provider in the chat UI.',
    'Preserve the active character/system instructions from the conversation when they are present.',
    '',
    renderedMessages,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildClaudeCliChatPrompt(payload: Record<string, unknown>): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const renderedMessages = messages
    .map((message, index) => {
      if (typeof message !== 'object' || message === null) return null;
      const record = message as Record<string, unknown>;
      const role = typeof record.role === 'string' ? record.role : `message-${index + 1}`;
      const content = typeof record.content === 'string' ? record.content : '';
      return `${role.toUpperCase()}:\n${content}`;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join('\n\n');

  return [
    'You are running as the configured Claude CLI model for OpenRoom.',
    'Reply directly to the latest user request. Tool calls are not available through this provider in the chat UI.',
    'Preserve the active character/system instructions from the conversation when they are present.',
    '',
    renderedMessages,
  ]
    .filter(Boolean)
    .join('\n');
}

function terminateCliProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      child.kill();
    });
    killer.on('exit', (code) => {
      if (code !== 0) {
        child.kill();
      }
    });
    return;
  }
  child.kill();
}

function runCliProcess(
  command: string,
  args: string[],
  input: string,
  label: string,
  timeoutMs = CLI_CHAT_TIMEOUT_MS,
  options: { useStderrWhenStdoutEmpty?: boolean } = {},
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(command, args, {
      cwd: OPENROOM_ROOT,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const clearProcessTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProcessTimeout();
      rejectPromise(error);
    };
    const succeed = (output: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProcessTimeout();
      resolvePromise(output.trim());
    };

    timeout = setTimeout(() => {
      terminateCliProcessTree(child);
      fail(new Error(`${label} timed out.`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      fail(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(stderr.trim() || `${label} exited with code ${code}`));
        return;
      }
      succeed(options.useStderrWhenStdoutEmpty && !stdout.trim() ? stderr : stdout);
    });
    child.stdin?.end(input);
  });
}

async function runCodexCliChatProcess(
  command: string,
  args: string[],
  input: string,
  outputFile: string,
): Promise<string> {
  const stdout = await runCliProcess(command, args, input, 'Codex CLI');
  if (fs.existsSync(outputFile)) {
    return fs.readFileSync(outputFile, 'utf-8').trim();
  }
  return stdout;
}

function runClaudeCliChatProcess(command: string, args: string[], input: string): Promise<string> {
  return runCliProcess(command, args, input, 'Claude CLI');
}

function isCodexCliModelUpgradeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /requires a newer version of Codex|model .* is not supported|not supported when using Codex with a ChatGPT account/i.test(
    message,
  );
}

function buildCodexCliConfigOverrideArg(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function appendCodexCliRuntimeArgs(args: string[], payload: Record<string, unknown>): void {
  const reasoningEffort = normalizeReasoningEffort(payload.reasoningEffort);
  const reasoningSummary = normalizeReasoningSummary(payload.reasoningSummary);
  const verbosity = normalizeVerbosity(payload.verbosity);
  const serviceTier = normalizeServiceTier(payload.serviceTier);
  if (reasoningEffort) {
    args.push('-c', buildCodexCliConfigOverrideArg('model_reasoning_effort', reasoningEffort));
  }
  if (reasoningSummary) {
    args.push('-c', buildCodexCliConfigOverrideArg('model_reasoning_summary', reasoningSummary));
  }
  if (verbosity) {
    args.push('-c', buildCodexCliConfigOverrideArg('model_verbosity', verbosity));
  }
  if (serviceTier) {
    args.push('-c', buildCodexCliConfigOverrideArg('service_tier', serviceTier));
  }
}

function normalizeClaudeCliEffort(value: unknown): string | undefined {
  const reasoningEffort = normalizeReasoningEffort(value);
  if (!reasoningEffort || reasoningEffort === 'none') {
    return undefined;
  }
  if (reasoningEffort === 'minimal') {
    return 'low';
  }
  return reasoningEffort;
}

function appendClaudeCliRuntimeArgs(args: string[], payload: Record<string, unknown>): void {
  const effort = normalizeClaudeCliEffort(payload.reasoningEffort);
  if (effort) {
    args.push('--effort', effort);
  }
}

function buildClaudeCliChatArgs(model: string, payload: Record<string, unknown>): string[] {
  const args = [
    '--print',
    '--safe-mode',
    '--input-format',
    'text',
    '--output-format',
    'text',
    '--no-session-persistence',
    '--permission-mode',
    'plan',
    '--tools',
    '',
  ];
  if (model) {
    args.push('--model', model);
  }
  appendClaudeCliRuntimeArgs(args, payload);
  return args;
}

interface ClaudeCliAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  summary: string;
}

function parseClaudeCliAuthStatus(output: string): ClaudeCliAuthStatus {
  const entries = new Map<string, string>();
  const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const cleanOutput = output.replace(ansiEscapePattern, '');
  try {
    const parsed = JSON.parse(cleanOutput) as Record<string, unknown>;
    const loggedIn = typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
    const apiProvider = typeof parsed.apiProvider === 'string' ? parsed.apiProvider : undefined;
    const subscriptionType =
      typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined;
    const summaryParts = [
      loggedIn === undefined ? null : `loggedIn=${loggedIn ? 'true' : 'false'}`,
      authMethod ? `auth=${authMethod}` : null,
      apiProvider ? `provider=${apiProvider}` : null,
      subscriptionType ? `plan=${subscriptionType}` : null,
    ].filter((part): part is string => Boolean(part));
    return {
      ...(loggedIn === undefined ? {} : { loggedIn }),
      ...(authMethod ? { authMethod } : {}),
      ...(apiProvider ? { apiProvider } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      summary: summaryParts.join(', ') || 'Claude auth status returned no structured fields.',
    };
  } catch {
    // Older Claude CLI builds used line-oriented output.
  }

  for (const line of cleanOutput.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) {
      entries.set(match[1], match[2].trim());
    }
  }

  const loggedInText = entries.get('loggedIn');
  const loggedIn = loggedInText === undefined ? undefined : loggedInText.toLowerCase() === 'true';
  const authMethod = entries.get('authMethod');
  const apiProvider = entries.get('apiProvider');
  const subscriptionType = entries.get('subscriptionType');
  const summaryParts = [
    loggedIn === undefined ? null : `loggedIn=${loggedIn ? 'true' : 'false'}`,
    authMethod ? `auth=${authMethod}` : null,
    apiProvider ? `provider=${apiProvider}` : null,
    subscriptionType ? `plan=${subscriptionType}` : null,
  ].filter((part): part is string => Boolean(part));

  return {
    ...(loggedIn === undefined ? {} : { loggedIn }),
    ...(authMethod ? { authMethod } : {}),
    ...(apiProvider ? { apiProvider } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    summary: summaryParts.join(', ') || 'Claude auth status returned no structured fields.',
  };
}

function claudeCliConnectionCheckPlugin(): Plugin {
  return {
    name: 'claude-cli-connection-check',
    configureServer(server) {
      server.middlewares.use('/api/claude-cli-check', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        const startedAt = Date.now();
        try {
          const payload = await readJsonBody(req);
          const command =
            typeof payload.command === 'string' && payload.command.trim()
              ? payload.command.trim()
              : 'claude';
          const model = typeof payload.model === 'string' ? payload.model.trim() : '';

          const version = await runCliProcess(
            command,
            ['--version'],
            '',
            'Claude CLI version check',
            CLI_HEALTH_TIMEOUT_MS,
          );
          const authOutput = await runCliProcess(
            command,
            ['auth', 'status'],
            '',
            'Claude CLI auth check',
            CLI_HEALTH_TIMEOUT_MS,
            { useStderrWhenStdoutEmpty: true },
          );
          const auth = parseClaudeCliAuthStatus(authOutput);
          if (auth.loggedIn === false) {
            throw new Error('Claude CLI is installed but not logged in. Run `claude auth` first.');
          }

          const smokePrompt = 'Reply exactly: OPENROOM_CLAUDE_OK';
          const smokeOutput = await runCliProcess(
            command,
            buildClaudeCliChatArgs(model, payload),
            smokePrompt,
            'Claude CLI smoke test',
            CLAUDE_CLI_SMOKE_TIMEOUT_MS,
          );
          if (smokeOutput.trim() !== 'OPENROOM_CLAUDE_OK') {
            throw new Error(
              `Claude CLI smoke test returned unexpected output: ${smokeOutput.slice(0, 160)}`,
            );
          }

          writeJsonResponse(res, 200, {
            ok: true,
            provider: 'claude-cli',
            command,
            model,
            safeMode: true,
            version,
            auth,
            smokeTest: smokeOutput.trim(),
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          writeJsonResponse(res, 500, {
            ok: false,
            provider: 'claude-cli',
            safeMode: true,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          });
        }
      });
    },
  };
}

interface CodexAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  summary: string;
}

type ModelUsageStatusKind = 'available' | 'unavailable' | 'error';

interface ModelUsageStatusResponse {
  ok: boolean;
  provider: string;
  model: string;
  period: 'week';
  status: ModelUsageStatusKind;
  source: string;
  refreshedAt: number;
  nextRefreshAt: number;
  account?: {
    label?: string;
    authMethod?: string;
  };
  usage?: {
    used?: number;
    limit?: number;
    remaining?: number;
    percent?: number;
    unit?: string;
    resetAt?: string;
  };
  message?: string;
  error?: string;
}

const modelUsageStatusCache = new Map<
  string,
  {
    expiresAt: number;
    result: ModelUsageStatusResponse;
  }
>();

interface CodexAuthDeviceLoginSession {
  id: string;
  provider: 'codex-auth';
  state: 'running' | 'completed' | 'error';
  startedAt: number;
  updatedAt: number;
  output: string;
  authorizationUrl?: string;
  userCode?: string;
  browserOpened?: boolean;
  error?: string;
  exitCode?: number | null;
}

let codexAuthLoginSession:
  | (CodexAuthDeviceLoginSession & { child?: ReturnType<typeof spawn> })
  | null = null;

function stripAnsi(output: string): string {
  return output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function limitCodexLoginOutput(output: string): string {
  if (output.length <= CODEX_AUTH_LOGIN_OUTPUT_LIMIT) {
    return output;
  }
  return output.slice(output.length - CODEX_AUTH_LOGIN_OUTPUT_LIMIT);
}

function snapshotCodexAuthLoginSession(
  session: CodexAuthDeviceLoginSession & { child?: ReturnType<typeof spawn> },
): CodexAuthDeviceLoginSession {
  return {
    id: session.id,
    provider: session.provider,
    state: session.state,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    output: stripAnsi(session.output).trim(),
    ...(session.authorizationUrl ? { authorizationUrl: session.authorizationUrl } : {}),
    ...(session.userCode ? { userCode: session.userCode } : {}),
    ...(session.browserOpened !== undefined ? { browserOpened: session.browserOpened } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
  };
}

function parseCodexAuthStatus(output: string): CodexAuthStatus {
  const cleanOutput = stripAnsi(output).trim();
  try {
    const parsed = JSON.parse(cleanOutput) as Record<string, unknown>;
    const loggedIn = typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
    const authMethod =
      typeof parsed.authMethod === 'string'
        ? parsed.authMethod
        : typeof parsed.method === 'string'
          ? parsed.method
          : undefined;
    const summaryParts = [
      loggedIn === undefined ? null : `loggedIn=${loggedIn ? 'true' : 'false'}`,
      authMethod ? `auth=${authMethod}` : null,
    ].filter((part): part is string => Boolean(part));
    return {
      ...(loggedIn === undefined ? {} : { loggedIn }),
      ...(authMethod ? { authMethod } : {}),
      summary: summaryParts.join(', ') || cleanOutput || 'Codex auth status returned no output.',
    };
  } catch {
    // Current Codex CLI uses short human-readable status output.
  }

  const loggedInMatch = cleanOutput.match(/^Logged in(?:\s+using\s+(.+))?$/i);
  if (loggedInMatch) {
    const authMethod = loggedInMatch[1]?.trim();
    return {
      loggedIn: true,
      ...(authMethod ? { authMethod } : {}),
      summary: cleanOutput,
    };
  }
  if (/not\s+(?:logged|authenticated)|login\s+required|no\s+auth/i.test(cleanOutput)) {
    return {
      loggedIn: false,
      summary: cleanOutput || 'Codex Auth is not logged in.',
    };
  }
  return {
    summary: cleanOutput || 'Codex auth status returned no output.',
  };
}

function buildModelUsageStatus(
  input: {
    provider: string;
    model: string;
    status: ModelUsageStatusKind;
    source: string;
    ok?: boolean;
    account?: ModelUsageStatusResponse['account'];
    usage?: ModelUsageStatusResponse['usage'];
    message?: string;
    error?: string;
  },
  now = Date.now(),
): ModelUsageStatusResponse {
  return {
    ok: input.ok ?? input.status !== 'error',
    provider: input.provider,
    model: input.model,
    period: 'week',
    status: input.status,
    source: input.source,
    refreshedAt: now,
    nextRefreshAt: now + MODEL_USAGE_CACHE_TTL_MS,
    ...(input.account ? { account: input.account } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function normalizeUsageProvider(payload: Record<string, unknown>): string {
  return typeof payload.provider === 'string' ? payload.provider.trim() : '';
}

function normalizeUsageModel(payload: Record<string, unknown>): string {
  return typeof payload.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : 'unknown-model';
}

function normalizeUsageCommand(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.command === 'string' && payload.command.trim()
    ? payload.command.trim()
    : fallback;
}

function getModelUsageCacheKey(provider: string, model: string, command?: string): string {
  return [provider, model, command ?? ''].join('\u0000');
}

async function resolveCodexModelUsageStatus(
  provider: string,
  model: string,
  command: string,
): Promise<ModelUsageStatusResponse> {
  try {
    let auth: CodexAuthStatus;
    try {
      const authOutput = await runCliProcess(
        command,
        ['login', 'status'],
        '',
        `${provider} auth status`,
        CLI_HEALTH_TIMEOUT_MS,
        { useStderrWhenStdoutEmpty: true },
      );
      auth = parseCodexAuthStatus(authOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      auth = parseCodexAuthStatus(message);
      if (auth.loggedIn !== false) {
        throw error;
      }
    }

    if (auth.loggedIn === false) {
      return buildModelUsageStatus({
        provider,
        model,
        status: 'unavailable',
        source: 'codex-cli-login-status',
        ok: false,
        account: {
          ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
          label: auth.summary,
        },
        message: 'Codex account auth is not logged in.',
      });
    }

    return buildModelUsageStatus({
      provider,
      model,
      status: 'unavailable',
      source: 'codex-cli-login-status',
      account: {
        ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
        label: auth.summary,
      },
      message: 'Weekly account usage is not exposed by Codex CLI for this auth session.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildModelUsageStatus({
      provider,
      model,
      status: 'error',
      source: 'codex-cli-login-status',
      ok: false,
      error: message,
      message: 'Unable to check weekly model usage.',
    });
  }
}

async function resolveClaudeCliModelUsageStatus(
  provider: string,
  model: string,
  command: string,
): Promise<ModelUsageStatusResponse> {
  try {
    const authOutput = await runCliProcess(
      command,
      ['auth', 'status'],
      '',
      'Claude CLI auth status',
      CLI_HEALTH_TIMEOUT_MS,
      { useStderrWhenStdoutEmpty: true },
    );
    const auth = parseClaudeCliAuthStatus(authOutput);
    return buildModelUsageStatus({
      provider,
      model,
      status: 'unavailable',
      source: 'claude-cli-auth-status',
      ok: auth.loggedIn !== false,
      account: {
        ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
        label: auth.summary,
      },
      message:
        auth.loggedIn === false
          ? 'Claude CLI is not logged in.'
          : 'Weekly account usage is not exposed by Claude CLI for this auth session.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildModelUsageStatus({
      provider,
      model,
      status: 'error',
      source: 'claude-cli-auth-status',
      ok: false,
      error: message,
      message: 'Unable to check weekly model usage.',
    });
  }
}

async function resolveModelUsageStatus(
  payload: Record<string, unknown>,
): Promise<ModelUsageStatusResponse> {
  const provider = normalizeUsageProvider(payload);
  const model = normalizeUsageModel(payload);
  if (!provider) {
    throw new Error('Missing provider.');
  }

  const command =
    provider === 'claude-cli'
      ? normalizeUsageCommand(payload, 'claude')
      : provider === 'codex-cli'
        ? normalizeUsageCommand(payload, 'codex')
        : provider === 'codex-auth'
          ? CODEX_AUTH_COMMAND
          : undefined;
  const cacheKey = getModelUsageCacheKey(provider, model, command);
  const cached = modelUsageStatusCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  let result: ModelUsageStatusResponse;
  if (provider === 'codex-auth' || provider === 'codex-cli') {
    result = await resolveCodexModelUsageStatus(provider, model, command ?? CODEX_AUTH_COMMAND);
  } else if (provider === 'claude-cli') {
    result = await resolveClaudeCliModelUsageStatus(provider, model, command ?? 'claude');
  } else {
    result = buildModelUsageStatus({
      provider,
      model,
      status: 'unavailable',
      source: 'provider-configuration',
      message: 'Weekly account usage is not exposed by this provider configuration.',
    });
  }

  modelUsageStatusCache.set(cacheKey, {
    expiresAt: result.nextRefreshAt,
    result,
  });
  return result;
}

function modelUsageStatusPlugin(): Plugin {
  return {
    name: 'llm-usage-status',
    configureServer(server) {
      server.middlewares.use('/api/llm-usage-status', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const payload = await readJsonBody(req);
          const result = await resolveModelUsageStatus(payload);
          writeJsonResponse(res, 200, result);
        } catch (error) {
          writeJsonResponse(res, 400, {
            ok: false,
            provider: 'unknown',
            model: 'unknown-model',
            period: 'week',
            status: 'error',
            source: 'provider-configuration',
            refreshedAt: Date.now(),
            nextRefreshAt: Date.now() + MODEL_USAGE_CACHE_TTL_MS,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

function extractCodexAuthAuthorizationUrl(output: string): string | undefined {
  const match = stripAnsi(output).match(/https:\/\/[^\s"'<>]+/i);
  return match?.[0]?.replace(/[),.;]+$/g, '');
}

function isCodexAuthDeviceCode(value: string): boolean {
  const token = value.trim().replace(/[.,:;]+$/g, '');
  if (!/^[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+$/.test(token)) {
    return false;
  }
  const compact = token.replace(/-/g, '');
  return compact.length >= 8 && /[A-Z]/.test(compact);
}

function extractCodexAuthUserCode(output: string): string | undefined {
  const cleanOutput = stripAnsi(output);

  const explicit = cleanOutput.match(
    /(?:enter\s+this\s+one-time\s+code|one-time\s+code|device\s+code)[^\n\r]*[\n\r]+\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/i,
  );
  if (explicit?.[1] && isCodexAuthDeviceCode(explicit[1])) {
    return explicit[1].trim().replace(/[.,:;]+$/g, '');
  }

  const standaloneMatches = cleanOutput.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/g) ?? [];
  for (const candidate of standaloneMatches) {
    if (isCodexAuthDeviceCode(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function openCodexAuthUrlInBrowser(url: string): boolean {
  try {
    if (process.platform === 'win32') {
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function startCodexAuthDeviceLoginSession(): CodexAuthDeviceLoginSession {
  if (codexAuthLoginSession?.state === 'running') {
    return snapshotCodexAuthLoginSession(codexAuthLoginSession);
  }

  const now = Date.now();
  const session: CodexAuthDeviceLoginSession & { child?: ReturnType<typeof spawn> } = {
    id: `codex-login-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    provider: 'codex-auth',
    state: 'running',
    startedAt: now,
    updatedAt: now,
    output: '',
  };
  const child = spawn(CODEX_AUTH_COMMAND, ['login', '--device-auth'], {
    cwd: OPENROOM_ROOT,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  session.child = child;
  codexAuthLoginSession = session;

  const appendOutput = (chunk: Buffer) => {
    session.output = limitCodexLoginOutput(stripAnsi(session.output + chunk.toString()));
    session.authorizationUrl =
      session.authorizationUrl ?? extractCodexAuthAuthorizationUrl(session.output);
    session.userCode = session.userCode ?? extractCodexAuthUserCode(session.output);
    if (session.authorizationUrl && session.browserOpened !== true) {
      session.browserOpened = openCodexAuthUrlInBrowser(session.authorizationUrl);
    }
    session.updatedAt = Date.now();
  };

  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.on('error', (error) => {
    session.state = 'error';
    session.error = error.message;
    session.updatedAt = Date.now();
    delete session.child;
  });
  child.on('close', (code) => {
    session.state = code === 0 ? 'completed' : 'error';
    session.exitCode = code;
    if (code !== 0 && !session.error) {
      session.error =
        stripAnsi(session.output).trim() || `Codex device login exited with code ${code}.`;
    }
    session.updatedAt = Date.now();
    delete session.child;
  });

  return snapshotCodexAuthLoginSession(session);
}

function codexAuthPlugin(): Plugin {
  return {
    name: 'codex-auth',
    configureServer(server) {
      server.middlewares.use('/api/codex-auth-status', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        const startedAt = Date.now();
        try {
          const version = await runCliProcess(
            CODEX_AUTH_COMMAND,
            ['--version'],
            '',
            'Codex Auth version check',
            CLI_HEALTH_TIMEOUT_MS,
          );
          let auth: CodexAuthStatus;
          try {
            const authOutput = await runCliProcess(
              CODEX_AUTH_COMMAND,
              ['login', 'status'],
              '',
              'Codex Auth status',
              CLI_HEALTH_TIMEOUT_MS,
              { useStderrWhenStdoutEmpty: true },
            );
            auth = parseCodexAuthStatus(authOutput);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            auth = parseCodexAuthStatus(message);
            if (auth.loggedIn !== false) {
              throw error;
            }
          }

          writeJsonResponse(res, 200, {
            ok: auth.loggedIn !== false,
            provider: 'codex-auth',
            version,
            auth,
            ...(auth.loggedIn === false ? { error: 'Codex Auth is not logged in.' } : {}),
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          writeJsonResponse(res, 500, {
            ok: false,
            provider: 'codex-auth',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          });
        }
      });

      server.middlewares.use('/api/codex-auth-login', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          await readJsonBody(req);
          writeJsonResponse(res, 200, startCodexAuthDeviceLoginSession());
        } catch (error) {
          writeJsonResponse(res, 500, {
            provider: 'codex-auth',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use('/api/codex-auth-login-status', (req, res) => {
        if (req.method !== 'GET') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        const url = new URL(req.url || '', 'http://localhost');
        const sessionId = url.searchParams.get('id') || '';
        if (!codexAuthLoginSession || codexAuthLoginSession.id !== sessionId) {
          writeJsonResponse(res, 404, {
            provider: 'codex-auth',
            error: 'Codex Auth device login session was not found.',
          });
          return;
        }

        writeJsonResponse(res, 200, snapshotCodexAuthLoginSession(codexAuthLoginSession));
      });

      server.middlewares.use('/api/codex-auth-chat', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'openroom-codex-auth-chat-'));
        const outputFile = join(tempDir, 'last-message.txt');
        try {
          const payload = await readJsonBody(req);
          const model = typeof payload.model === 'string' ? payload.model.trim() : '';
          const args = [
            'exec',
            '--cd',
            OPENROOM_ROOT,
            '--skip-git-repo-check',
            '--sandbox',
            'read-only',
            '--output-last-message',
            outputFile,
            '--color',
            'never',
          ];
          if (model) args.push('--model', model);
          appendCodexCliRuntimeArgs(args, payload);
          args.push('-');
          const prompt = buildCodexCliChatPrompt(payload);
          let content: string;
          try {
            content = await runCodexCliChatProcess(CODEX_AUTH_COMMAND, args, prompt, outputFile);
          } catch (error) {
            if (model && model !== CODEX_CLI_FALLBACK_MODEL && isCodexCliModelUpgradeError(error)) {
              const fallbackArgs = args.filter((arg, index) => {
                if (arg === '--model') return false;
                return args[index - 1] !== '--model';
              });
              fallbackArgs.splice(fallbackArgs.length - 1, 0, '--model', CODEX_CLI_FALLBACK_MODEL);
              content = await runCodexCliChatProcess(
                CODEX_AUTH_COMMAND,
                fallbackArgs,
                prompt,
                outputFile,
              );
            } else {
              throw error;
            }
          }
          writeJsonResponse(res, 200, { content });
        } catch (error) {
          writeJsonResponse(res, 500, {
            provider: 'codex-auth',
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    },
  };
}

function claudeCliChatPlugin(): Plugin {
  return {
    name: 'claude-cli-chat',
    configureServer(server) {
      server.middlewares.use('/api/claude-cli-chat', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const payload = await readJsonBody(req);
          const command =
            typeof payload.command === 'string' && payload.command.trim()
              ? payload.command.trim()
              : 'claude';
          const model = typeof payload.model === 'string' ? payload.model.trim() : '';
          const args = buildClaudeCliChatArgs(model, payload);

          const prompt = buildClaudeCliChatPrompt(payload);
          const content = await runClaudeCliChatProcess(command, args, prompt);
          writeJsonResponse(res, 200, { content });
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

function codexCliChatPlugin(): Plugin {
  return {
    name: 'codex-cli-chat',
    configureServer(server) {
      server.middlewares.use('/api/codex-cli-chat', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'openroom-codex-chat-'));
        const outputFile = join(tempDir, 'last-message.txt');
        try {
          const payload = await readJsonBody(req);
          const command =
            typeof payload.command === 'string' && payload.command.trim()
              ? payload.command.trim()
              : 'codex';
          const model = typeof payload.model === 'string' ? payload.model.trim() : '';
          const args = [
            'exec',
            '--cd',
            OPENROOM_ROOT,
            '--skip-git-repo-check',
            '--sandbox',
            'read-only',
            '--output-last-message',
            outputFile,
            '--color',
            'never',
          ];
          if (model) args.push('--model', model);
          appendCodexCliRuntimeArgs(args, payload);
          args.push('-');

          const prompt = buildCodexCliChatPrompt(payload);
          let content: string;
          try {
            content = await runCodexCliChatProcess(command, args, prompt, outputFile);
          } catch (error) {
            if (model && model !== CODEX_CLI_FALLBACK_MODEL && isCodexCliModelUpgradeError(error)) {
              const fallbackArgs = args.filter((arg, index) => {
                if (arg === '--model') return false;
                return args[index - 1] !== '--model';
              });
              fallbackArgs.splice(fallbackArgs.length - 1, 0, '--model', CODEX_CLI_FALLBACK_MODEL);
              content = await runCodexCliChatProcess(command, fallbackArgs, prompt, outputFile);
            } else {
              throw error;
            }
          }
          writeJsonResponse(res, 200, { content });
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    },
  };
}

function openRouterModelsPlugin(): Plugin {
  let cache: { expiresAt: number; body: string } | null = null;

  return {
    name: 'openrouter-models',
    configureServer(server) {
      server.middlewares.use('/api/openrouter-models', async (req, res) => {
        if (req.method !== 'GET') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }

        const now = Date.now();
        if (cache && cache.expiresAt > now) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          });
          res.end(cache.body);
          return;
        }

        try {
          const upstream = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { Accept: 'application/json' },
          });
          const body = await upstream.text();
          if (!upstream.ok) {
            writeJsonResponse(res, upstream.status, {
              error: `OpenRouter models API error ${upstream.status}: ${body.slice(0, 500)}`,
            });
            return;
          }
          cache = {
            expiresAt: now + 10 * 60 * 1000,
            body,
          };
          res.writeHead(200, {
            'Content-Type': upstream.headers.get('content-type') || 'application/json',
            'Cache-Control': 'public, max-age=300',
          });
          res.end(body);
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

/** LLM API proxy plugin — resolves browser CORS restrictions */
function llmProxyPlugin(): Plugin {
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use('/api/llm-proxy', async (req, res) => {
        const targetUrl = req.headers['x-llm-target-url'] as string;
        if (!targetUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing X-LLM-Target-URL header' }));
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString();
            let parsedBody: Record<string, unknown> | null = null;
            try {
              parsedBody = JSON.parse(body) as Record<string, unknown>;
            } catch {
              // ignore non-JSON bodies
            }
            const headers: Record<string, string> = {};
            // Forward all headers except host/connection/internal ones
            const skipKeys = new Set(['host', 'connection', 'content-length', 'x-llm-target-url']);
            for (const [key, val] of Object.entries(req.headers)) {
              if (typeof val !== 'string') continue;
              if (skipKeys.has(key)) continue;
              if (key.startsWith('x-custom-')) {
                headers[key.replace('x-custom-', '')] = val;
              } else {
                headers[key] = val;
              }
            }

            console.info('[LLM Proxy] Request', {
              method: req.method || 'POST',
              targetUrl,
              model: parsedBody?.model,
              messageCount: Array.isArray(parsedBody?.messages)
                ? parsedBody?.messages.length
                : null,
              toolCount: Array.isArray(parsedBody?.tools) ? parsedBody?.tools.length : null,
            });

            const fetchRes = await fetch(targetUrl, {
              method: req.method || 'POST',
              headers,
              body,
            });

            console.info('[LLM Proxy] Response status', {
              targetUrl,
              status: fetchRes.status,
              ok: fetchRes.ok,
              contentType: fetchRes.headers.get('content-type'),
              contentLength: fetchRes.headers.get('content-length'),
              contentEncoding: fetchRes.headers.get('content-encoding'),
            });
            const bytes = Buffer.from(await fetchRes.arrayBuffer());
            const text = bytes.toString('utf8');
            console.info('[LLM Proxy] Response byte length', bytes.length);
            console.info(
              '[LLM Proxy] Response body preview (json)',
              JSON.stringify(text.slice(0, 500)),
            );
            res.writeHead(fetchRes.status, {
              'Content-Type': fetchRes.headers.get('Content-Type') || 'application/json',
            });
            res.end(bytes);
          } catch (err: unknown) {
            console.error('[LLM Proxy] Request failed', {
              targetUrl,
              error: err instanceof Error ? err.message : String(err),
            });
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      });
    },
  };
}

function readRequestBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const raw = (await readRequestBody(req)).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJsonResponse(
  res: {
    writeHead: (statusCode: number, headers?: Record<string, string>) => void;
    end: (chunk?: string | Buffer) => void;
  },
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function buildWavFromPcm(
  pcmData: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

function buildGeminiTtsPrompt(stylePrompt: string, transcript: string): string {
  const cleanedStylePrompt = stylePrompt.trim();
  const cleanedTranscript = transcript.trim();
  return [
    cleanedStylePrompt || 'Speak in natural Japanese with elegant, cool confidence.',
    'Speak the transcript exactly once in Japanese.',
    'Do not add extra narration, labels, or explanations.',
    'Transcript:',
    cleanedTranscript,
  ].join('\n\n');
}

function simplifyElevenVoice(voice: Record<string, unknown>): Record<string, unknown> {
  return {
    voiceId: voice.voice_id,
    name: voice.name,
    category: voice.category,
    description: voice.description,
    previewUrl: voice.preview_url,
    labels: voice.labels,
    verifiedLanguages: voice.verified_languages,
    settings: voice.settings,
    sharing: voice.sharing,
  };
}

function ttsLabPlugin(options: { geminiApiKey?: string; elevenLabsApiKey?: string }): Plugin {
  return {
    name: 'tts-lab',
    configureServer(server) {
      server.middlewares.use('/api/tts-lab/status', (_req, res) => {
        writeJsonResponse(res, 200, {
          geminiAvailable: Boolean(options.geminiApiKey?.trim()),
          elevenLabsAvailable: Boolean(options.elevenLabsApiKey?.trim()),
          defaultGoogleModel: 'gemini-3.1-flash-tts-preview',
          defaultElevenModel: 'eleven_multilingual_v2',
        });
      });

      server.middlewares.use('/api/tts-lab/google/synthesize', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }
        if (!options.geminiApiKey?.trim()) {
          writeJsonResponse(res, 400, { error: 'Missing GEMINI_API_KEY' });
          return;
        }

        try {
          const body = await readJsonBody(req);
          const transcript = String(body.text ?? '').trim();
          const stylePrompt = String(body.stylePrompt ?? '').trim();
          const voiceName = String(body.voiceName ?? 'Despina').trim();
          const model = String(body.model ?? 'gemini-3.1-flash-tts-preview').trim();

          if (!transcript) {
            writeJsonResponse(res, 400, { error: 'Missing text' });
            return;
          }

          const geminiPrompt = buildGeminiTtsPrompt(stylePrompt, transcript);
          const fetchRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
              model,
            )}:generateContent`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': options.geminiApiKey,
              },
              body: JSON.stringify({
                contents: [{ parts: [{ text: geminiPrompt }] }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName,
                      },
                    },
                  },
                },
              }),
            },
          );

          const responseText = await fetchRes.text();
          if (!fetchRes.ok) {
            writeJsonResponse(res, fetchRes.status, {
              error: `Gemini TTS request failed: ${responseText}`,
            });
            return;
          }

          const parsed = JSON.parse(responseText) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{
                  inlineData?: {
                    data?: string;
                  };
                }>;
              };
            }>;
          };
          const pcmBase64 =
            parsed.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data?.trim() ?? '';

          if (!pcmBase64) {
            writeJsonResponse(res, 502, { error: 'Gemini TTS response did not contain audio.' });
            return;
          }

          const wavBuffer = buildWavFromPcm(Buffer.from(pcmBase64, 'base64'));
          writeJsonResponse(res, 200, {
            provider: 'google',
            model,
            voiceName,
            mimeType: 'audio/wav',
            audioBase64: wavBuffer.toString('base64'),
            promptPreview: geminiPrompt.slice(0, 240),
          });
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use('/api/tts-lab/elevenlabs/account-voices', async (req, res) => {
        if (req.method !== 'GET') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }
        if (!options.elevenLabsApiKey?.trim()) {
          writeJsonResponse(res, 400, { error: 'Missing ELEVENLABS_API_KEY' });
          return;
        }

        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const upstream = new URL('https://api.elevenlabs.io/v2/voices');
          const search = requestUrl.searchParams.get('search')?.trim();
          const pageSize = requestUrl.searchParams.get('pageSize')?.trim() || '50';
          if (search) upstream.searchParams.set('search', search);
          upstream.searchParams.set('page_size', pageSize);

          const fetchRes = await fetch(upstream, {
            headers: {
              'xi-api-key': options.elevenLabsApiKey,
            },
          });
          const responseText = await fetchRes.text();
          if (!fetchRes.ok) {
            writeJsonResponse(res, fetchRes.status, {
              error: `ElevenLabs voice list failed: ${responseText}`,
            });
            return;
          }

          const parsed = JSON.parse(responseText) as {
            voices?: Array<Record<string, unknown>>;
            has_more?: boolean;
            next_page_token?: string | null;
            total_count?: number;
          };

          writeJsonResponse(res, 200, {
            voices: Array.isArray(parsed.voices) ? parsed.voices.map(simplifyElevenVoice) : [],
            hasMore: Boolean(parsed.has_more),
            nextPageToken: parsed.next_page_token ?? null,
            totalCount: parsed.total_count ?? 0,
          });
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use('/api/tts-lab/elevenlabs/shared-voices', async (req, res) => {
        if (req.method !== 'GET') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }
        if (!options.elevenLabsApiKey?.trim()) {
          writeJsonResponse(res, 400, { error: 'Missing ELEVENLABS_API_KEY' });
          return;
        }

        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const upstream = new URL('https://api.elevenlabs.io/v1/shared-voices');
          const queryKeys = [
            'page_size',
            'page',
            'category',
            'gender',
            'age',
            'accent',
            'language',
            'locale',
            'search',
            'featured',
            'min_notice_period_days',
            'include_custom_rates',
            'include_live_moderated',
            'reader_app_enabled',
            'owner_id',
            'sort',
          ];

          for (const key of queryKeys) {
            const value = requestUrl.searchParams.get(key);
            if (value) upstream.searchParams.set(key, value);
          }

          if (!upstream.searchParams.has('page_size')) upstream.searchParams.set('page_size', '24');

          const fetchRes = await fetch(upstream, {
            headers: {
              'xi-api-key': options.elevenLabsApiKey,
            },
          });
          const responseText = await fetchRes.text();
          if (!fetchRes.ok) {
            writeJsonResponse(res, fetchRes.status, {
              error: `ElevenLabs shared voice list failed: ${responseText}`,
            });
            return;
          }

          const parsed = JSON.parse(responseText) as {
            voices?: Array<Record<string, unknown>>;
            has_more?: boolean;
            total_count?: number;
            last_sort_id?: string | null;
          };

          writeJsonResponse(res, 200, {
            voices: Array.isArray(parsed.voices) ? parsed.voices : [],
            hasMore: Boolean(parsed.has_more),
            totalCount: parsed.total_count ?? 0,
            lastSortId: parsed.last_sort_id ?? null,
          });
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      server.middlewares.use('/api/tts-lab/elevenlabs/synthesize', async (req, res) => {
        if (req.method !== 'POST') {
          writeJsonResponse(res, 405, { error: 'Method not allowed' });
          return;
        }
        if (!options.elevenLabsApiKey?.trim()) {
          writeJsonResponse(res, 400, { error: 'Missing ELEVENLABS_API_KEY' });
          return;
        }

        try {
          const body = await readJsonBody(req);
          const text = String(body.text ?? '').trim();
          const voiceId = String(body.voiceId ?? '').trim();
          const modelId = String(body.modelId ?? 'eleven_multilingual_v2').trim();
          const outputFormat = String(body.outputFormat ?? 'mp3_44100_128').trim();
          const voiceSettings =
            typeof body.voiceSettings === 'object' && body.voiceSettings !== null
              ? body.voiceSettings
              : {
                  stability: 0.45,
                  similarity_boost: 0.8,
                  style: 0.35,
                  speed: 0.94,
                  use_speaker_boost: true,
                };

          if (!text) {
            writeJsonResponse(res, 400, { error: 'Missing text' });
            return;
          }
          if (!voiceId) {
            writeJsonResponse(res, 400, { error: 'Missing voiceId' });
            return;
          }

          const fetchRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
              voiceId,
            )}?output_format=${encodeURIComponent(outputFormat)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'xi-api-key': options.elevenLabsApiKey,
              },
              body: JSON.stringify({
                text,
                model_id: modelId,
                voice_settings: voiceSettings,
              }),
            },
          );

          if (!fetchRes.ok) {
            const responseText = await fetchRes.text();
            writeJsonResponse(res, fetchRes.status, {
              error: `ElevenLabs synthesis failed: ${responseText}`,
            });
            return;
          }

          const audioBuffer = Buffer.from(await fetchRes.arrayBuffer());
          writeJsonResponse(res, 200, {
            provider: 'elevenlabs',
            voiceId,
            modelId,
            mimeType: outputFormat.startsWith('pcm') ? 'audio/wav' : 'audio/mpeg',
            audioBase64: audioBuffer.toString('base64'),
          });
        } catch (error) {
          writeJsonResponse(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

/** Generic JSON file persistence plugin factory */
function jsonFilePlugin(name: string, apiPath: string, filePath: string): Plugin {
  return {
    name,
    configureServer(server) {
      server.middlewares.use(apiPath, (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          try {
            if (fs.existsSync(filePath)) {
              res.writeHead(200);
              res.end(fs.readFileSync(filePath, 'utf-8'));
            } else {
              res.writeHead(200);
              res.end('{}');
            }
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString();
              JSON.parse(body);
              fs.mkdirSync(resolve(os.homedir(), '.openroom'), { recursive: true });
              fs.writeFileSync(filePath, body, 'utf-8');
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });
    },
  };
}

function openroomResetPlugin(): Plugin {
  return {
    name: 'openroom-reset',
    configureServer(server) {
      server.middlewares.use('/api/openroom-reset', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'DELETE') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const targets = [LLM_CONFIG_FILE, CHARACTERS_FILE, MODS_FILE];
          for (const filePath of targets) {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          }

          if (fs.existsSync(SESSIONS_DIR)) {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
          }

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

const config = ({ mode }: ConfigEnv): UserConfigExport => {
  const env = loadEnv(mode, process.cwd(), '');
  const normalizedMode = mode.toLowerCase();
  const resolvedNodeEnv =
    env.NODE_ENV ||
    (normalizedMode === 'production'
      ? 'production'
      : normalizedMode === 'test'
        ? 'test'
        : 'development');
  const isAnalyze = normalizedMode === 'analyze' || env.ANALYZE === 'analyze';
  const isProd = normalizedMode === 'production' || isAnalyze || resolvedNodeEnv === 'production';
  const isTest = normalizedMode === 'test' || resolvedNodeEnv === 'test';
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN;
  const bizProjectName = env.BIZ_PROJECT_NAME || '';

  // Calculate asset base path
  // - Production: CDN address
  // - Test: sub-path /webuiapps/
  // - Development: /
  const getBase = () => {
    if (isProd && env.CDN_PREFIX) {
      return env.CDN_PREFIX + '/' + bizProjectName;
    }
    if ((isTest || isProd) && bizProjectName) {
      return '/' + bizProjectName + '/';
    }
    return '/';
  };
  const skipLegacy = env.VITE_SKIP_LEGACY !== 'false';
  const plugins: PluginOption[] = [
    llmConfigPlugin(),
    sessionDataPlugin(),
    gmailPlugin({
      configFile: LLM_CONFIG_FILE,
      sessionsDir: SESSIONS_DIR,
    }),
    idaPePlugin({
      configFile: LLM_CONFIG_FILE,
      cacheRoot: resolve(os.homedir(), '.openroom', 'cache'),
    }),
    albumFolderPlugin(),
    kiraConfigPlugin(),
    kiraAutomationPlugin({
      configFile: LLM_CONFIG_FILE,
      sessionsDir: SESSIONS_DIR,
      getWorkRootDirectory: getKiraWorkRootDirectory,
    }),
    browserReaderProxyPlugin(),
    cyberNewsProxyPlugin(),
    dewdropCanvasPlugin({
      configFile: LLM_CONFIG_FILE,
    }),
    writtenByMePlugin({
      configFile: LLM_CONFIG_FILE,
    }),
    aoiResearchPlugin({
      configFile: LLM_CONFIG_FILE,
      sessionsDir: SESSIONS_DIR,
    }),
    aoiAutonomyPlugin({
      configFile: LLM_CONFIG_FILE,
      sessionsDir: SESSIONS_DIR,
      workspaceRoot: OPENROOM_ROOT,
    }),
    youtubeSearchPlugin(),
    tavilyProxyPlugin(),
    openVscodeManagerPlugin(),
    openroomResetPlugin(),
    logServerPlugin(),
    modelUsageStatusPlugin(),
    claudeCliConnectionCheckPlugin(),
    claudeCliChatPlugin(),
    codexAuthPlugin(),
    codexCliChatPlugin(),
    openRouterModelsPlugin(),
    llmProxyPlugin(),
    ttsLabPlugin({
      geminiApiKey: env.GEMINI_API_KEY,
      elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    }),
    jsonFilePlugin('characters', '/api/characters', CHARACTERS_FILE),
    jsonFilePlugin('mods', '/api/mods', MODS_FILE),
    appGeneratorPlugin({
      llmConfigFile: LLM_CONFIG_FILE,
      projectRoot: resolve(__dirname, '../..'),
      srcDir: resolve(__dirname, 'src'),
    }),
    react(),
    ...(skipLegacy
      ? []
      : [
          legacy({
            targets: ['defaults', 'not ie <= 11', 'chrome 80'],
            additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
            renderLegacyChunks: true,
            modernPolyfills: true,
          }),
        ]),
  ];

  /** Only import when running in analyze mode */
  if (isAnalyze) {
    plugins.push(
      visualizer({
        gzipSize: true,
        open: true,
        filename: `${env.APP_NAME}-chunk.html`,
      }),
    );
  }

  if (isProd && sentryAuthToken) {
    plugins.push(
      sentryVitePlugin({
        authToken: sentryAuthToken,
        org: env.SENTRY_ORG || '',
        project: env.SENTRY_PROJECT || '',
        url: env.SENTRY_URL || undefined,
        sourcemaps: {
          filesToDeleteAfterUpload: ['dist/**/*.js.map'],
        },
      }),
    );
  }

  return {
    plugins,
    css: {
      postcss: {
        plugins: [autoprefixer({})],
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
        '@gui/vibe-container': resolve(__dirname, './src/lib/vibeContainerMock.ts'),
      },
    },
    base: getBase(),
    server: {
      host: true,
      port: 3000,
    },
    define: {
      __APP__: JSON.stringify(env.APP_ENVIRONMENT),
      __ROUTER_BASE__: JSON.stringify(bizProjectName ? '/' + bizProjectName : ''),
      __ENV__: JSON.stringify(resolvedNodeEnv),
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.css')) {
              return 'assets/styles/[name]-[hash][extname]'; // Output to /dist/assets/styles directory
            }
            if (/\.(png|jpe?g|gif|svg)$/.test(assetInfo.name || '')) {
              return 'assets/images/[name]-[hash][extname]'; // Output to /dist/assets/images directory
            }

            if (/\.(ttf)$/.test(assetInfo.name || '')) {
              return 'assets/fonts/[name]-[hash][extname]'; // Output to /dist/assets/fonts directory
            }

            return '[name]-[hash][extname]'; // Default output for other assets
          },
        },
      },
      minify: true,
      chunkSizeWarningLimit: 1500,
      cssTarget: 'chrome61',
      sourcemap: isProd, // Source map generation must be turned on
      manifest: true,
    },
  };
};

export default config;
