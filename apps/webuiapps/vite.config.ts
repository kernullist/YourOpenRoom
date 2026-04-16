import { UserConfigExport, ConfigEnv, loadEnv } from 'vite';
import type { PluginOption, Plugin } from 'vite';
import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import autoprefixer from 'autoprefixer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { generateLogFileName, createLogMiddleware } from './src/lib/logPlugin';
import { appGeneratorPlugin } from './src/lib/appGeneratorPlugin';
import { kiraAutomationPlugin } from './src/lib/kiraAutomationPlugin';

const LLM_CONFIG_FILE = resolve(os.homedir(), '.openroom', 'config.json');
const SESSIONS_DIR = resolve(os.homedir(), '.openroom', 'sessions');
const CHARACTERS_FILE = resolve(os.homedir(), '.openroom', 'characters.json');
const MODS_FILE = resolve(os.homedir(), '.openroom', 'mods.json');

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

function getTavilyConfig(): { apiKey: string; baseUrl: string } | null {
  const config = readPersistedConfigFile();
  const tavily = config.tavily as { apiKey?: string; baseUrl?: string } | undefined;
  const apiKey = tavily?.apiKey?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: tavily?.baseUrl?.trim() || 'https://api.tavily.com/search',
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

  const walkImages = (rootDir: string, currentDir: string): Array<{ relativePath: string; absolutePath: string }> => {
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
      const relativePath = absolutePath.slice(rootDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
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
            res.end(JSON.stringify({ configured: false, files: [] }));
            return;
          }

          const resolvedRoot = resolve(rootDir);
          if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
            res.writeHead(200);
            res.end(JSON.stringify({ configured: true, exists: false, files: [] }));
            return;
          }

          const files = walkImages(resolvedRoot, resolvedRoot)
            .map(({ relativePath, absolutePath }) => {
              const stat = fs.statSync(absolutePath);
              return {
                id: relativePath,
                name: relativePath.split('/').pop() || relativePath,
                src: `/api/album-file?path=${encodeURIComponent(relativePath)}`,
                createdAt: stat.mtimeMs,
              };
            })
            .sort((a, b) => b.createdAt - a.createdAt);

          res.writeHead(200);
          res.end(JSON.stringify({ configured: true, exists: true, files }));
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
          const rootPrefix = resolvedRoot.endsWith('\\') || resolvedRoot.endsWith('/')
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

          const projects = exists
            ? fs
                .readdirSync(resolvedRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => ({
                  name: entry.name,
                  path: resolve(resolvedRoot, entry.name),
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [];

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
          ((item.thumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails ?? []);
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
          const fetchRes = await fetch(targetUrl, {
            headers: {
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
              accept: 'text/html,application/xhtml+xml',
              'accept-language': 'en-US,en;q=0.9',
            },
          });

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
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing tavily.apiKey in config.json' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString() || '{}';
            const parsed = JSON.parse(body) as Record<string, unknown>;
            const response = await fetch(tavily.baseUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tavily.apiKey}`,
              },
              body: JSON.stringify({
                ...parsed,
                include_answer: 'basic',
                include_favicon: true,
              }),
            });

            const text = await response.text();
            res.writeHead(response.status);
            res.end(text);
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
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
              messageCount: Array.isArray(parsedBody?.messages) ? parsedBody?.messages.length : null,
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
  const isProd = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test';
  const isAnalyze = env.ANALYZE === 'analyze';
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
  const skipLegacy = env.VITE_SKIP_LEGACY === 'true';
  const plugins: PluginOption[] = [
    llmConfigPlugin(),
    sessionDataPlugin(),
    albumFolderPlugin(),
    kiraConfigPlugin(),
    kiraAutomationPlugin({
      configFile: LLM_CONFIG_FILE,
      sessionsDir: SESSIONS_DIR,
      getWorkRootDirectory: getKiraWorkRootDirectory,
    }),
    browserReaderProxyPlugin(),
    youtubeSearchPlugin(),
    tavilyProxyPlugin(),
    openroomResetPlugin(),
    logServerPlugin(),
    llmProxyPlugin(),
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
      __ENV__: JSON.stringify(env.NODE_ENV),
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
