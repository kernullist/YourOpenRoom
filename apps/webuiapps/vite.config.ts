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
import { join } from 'path';
import { generateLogFileName, createLogMiddleware } from './src/lib/logPlugin';

const LLM_CONFIG_FILE = resolve(os.homedir(), '.openroom', 'config.json');
const SESSIONS_DIR = resolve(os.homedir(), '.openroom', 'sessions');
const CHARACTERS_FILE = resolve(os.homedir(), '.openroom', 'characters.json');
const MODS_FILE = resolve(os.homedir(), '.openroom', 'mods.json');

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
              const dir = filePath.substring(0, filePath.lastIndexOf('/'));
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

            const fetchRes = await fetch(targetUrl, {
              method: req.method || 'POST',
              headers,
              body,
            });

            res.writeHead(fetchRes.status, {
              'Content-Type': fetchRes.headers.get('Content-Type') || 'application/json',
              'Transfer-Encoding': 'chunked',
            });

            if (fetchRes.body) {
              const reader = (fetchRes.body as ReadableStream<Uint8Array>).getReader();
              const pump = async () => {
                let done = false;
                while (!done) {
                  const result = await reader.read();
                  done = result.done;
                  if (!done) res.write(result.value);
                }
                res.end();
              };
              pump().catch(() => res.end());
            } else {
              const text = await fetchRes.text();
              res.end(text);
            }
          } catch (err: unknown) {
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

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });
    },
  };
}

/**
 * App code generator plugin — uses Claude Agent SDK to concurrently generate
 * VibeApp code for each app in a parsed character card manifest.
 *
 * POST /api/generate-apps  { apps: AppEntry[], concurrency?: number }
 * Response: SSE stream with per-app progress events
 */
function appGeneratorPlugin(): Plugin {
  let viteServer: import('vite').ViteDevServer | null = null;

  return {
    name: 'app-generator',
    configureServer(server) {
      viteServer = server;
      server.middlewares.use('/api/generate-apps', async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          let body: {
            apps: Array<{
              id: string;
              name: string;
              keywords?: string[];
              format?: string;
              tags: unknown[];
              example: string;
              resources: Record<string, string[]>;
              scripts?: Array<{
                name: string;
                type: string;
                findRegex: string;
                replaceString: string;
              }>;
              imageTagPairs?: Array<{ tag: string; imgStyle: string }>;
            }>;
            concurrency?: number;
          };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          const { apps, concurrency = 3 } = body;
          console.log(
            `[appGenerator] Received request: ${apps?.length ?? 0} apps, concurrency=${concurrency}`,
          );
          if (!Array.isArray(apps) || apps.length === 0) {
            console.error('[appGenerator] Empty or invalid apps array');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'apps array is required' }));
            return;
          }
          console.log(
            '[appGenerator] Apps to generate:',
            apps.map((a) => `${a.id}(${a.name})`).join(', '),
          );

          // SSE headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const sendEvent = (data: Record<string, unknown>) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          // Lazy-import the Agent SDK (ESM)
          console.log('[appGenerator] Loading Agent SDK...');
          let queryFn: (typeof import('@anthropic-ai/claude-agent-sdk'))['query'];
          try {
            const sdk = await import('@anthropic-ai/claude-agent-sdk');
            queryFn = sdk.query;
            console.log('[appGenerator] Agent SDK loaded successfully');
          } catch (err) {
            console.error('[appGenerator] Failed to load Agent SDK:', err);
            sendEvent({ type: 'error', message: `Failed to load Agent SDK: ${err}` });
            res.end();
            return;
          }

          const projectRoot = resolve(__dirname, '../..');

          // ── Step 1: LLM pre-processing — summarize app raw data ──
          // Read LLM config for API credentials
          let llmConfig: {
            apiKey?: string;
            baseUrl?: string;
            model?: string;
            customHeaders?: string;
          } = {};
          try {
            if (fs.existsSync(LLM_CONFIG_FILE)) {
              const cfg = JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf-8'));
              llmConfig = cfg.llm || {};
              console.log(
                `[appGenerator] LLM config loaded: baseUrl=${llmConfig.baseUrl}, model=${llmConfig.model}, apiKey=${llmConfig.apiKey ? '***' + llmConfig.apiKey.slice(-4) : 'MISSING'}`,
              );
            } else {
              console.warn(`[appGenerator] LLM config file not found: ${LLM_CONFIG_FILE}`);
            }
          } catch (err) {
            console.error('[appGenerator] Failed to read LLM config:', err);
          }

          const summarizeApp = async (
            app: (typeof apps)[number],
          ): Promise<{ scenario: string; pageStructure: string; englishName: string }> => {
            const apiKey = llmConfig.apiKey;
            const baseUrl = llmConfig.baseUrl || 'https://api.anthropic.com';
            const model = llmConfig.model || 'claude-sonnet-4-6';

            if (!apiKey) {
              console.warn(
                `[appGenerator] No API key for summarize, skipping LLM call for ${app.id}`,
              );
              return {
                scenario: app.name,
                pageStructure: 'No LLM config available',
                englishName: toPascalCase(app.id),
              };
            }
            console.log(
              `[appGenerator] Summarizing ${app.id}: POST ${baseUrl}/v1/messages (model=${model})`,
            );

            const summaryPrompt = `You are a UI/UX analysis expert. Analyze the following app's raw data and produce a structured description.

## Constraints
1. **No container dimensions**: Do not specify the app's overall width/height (e.g. 80vw, 70vh). The layout system handles this automatically.
2. **No image references**: Do not mention any image files, image resources, or external URLs. Focus purely on the functional UI structure and interactions.
3. **Inline tag semantics**: Do not list tag definitions separately. Instead, naturally describe what each data field means within the page structure description.

## Input Data

App Name: ${app.name}
App ID: ${app.id}
Trigger Keywords: ${JSON.stringify(app.keywords || [])}

### Data Tags
${(app.tags || []).map((t: { name: string; type?: string; description?: string }) => `<${t.name}>: ${t.description || t.type || ''}`).join(', ')}

### Layout Scripts (HTML template reference)
${
  (app.scripts || [])
    .filter((s: { type: string }) => s.type === 'layout')
    .map(
      (s: { name: string; replaceString: string }) =>
        `#### ${s.name}\n\`\`\`html\n${s.replaceString.slice(0, 1200)}\n\`\`\``,
    )
    .join('\n\n') || 'No layout scripts'
}

## Output Format
Output strictly in the following format with no extra content:

【英文名称】
(A single PascalCase English name for the code directory, e.g. LiveStream, BattleArena, PhotoAlbum)

【应用场景】
(2-3 sentences describing what this app does, the user scenario, and core interactions)

【页面结构】
(Describe the page layout by region. Naturally integrate tag semantics into the description — e.g. "The chat area displays real-time danmaku messages, with paid messages highlighted" instead of separately defining <danmaku> and <paid>. Describe each region's components, data sources, and interactions. Do not specify container dimensions.)`;

            console.log(
              `[appGenerator] [${app.id}] ═══ SUMMARIZE PROMPT ═══\n${summaryPrompt}\n═══ END SUMMARIZE PROMPT ═══`,
            );

            try {
              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              };
              // Apply custom headers if configured
              if (llmConfig.customHeaders) {
                for (const pair of llmConfig.customHeaders.split(',')) {
                  const [hk, ...hv] = pair.split(':');
                  if (hk && hv.length) headers[hk.trim()] = hv.join(':').trim();
                }
              }

              const llmRes = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  model,
                  max_tokens: 2048,
                  messages: [{ role: 'user', content: summaryPrompt }],
                }),
              });

              if (!llmRes.ok) {
                const errText = await llmRes.text();
                console.error(
                  `[appGenerator] LLM summary failed for ${app.id}: status=${llmRes.status}`,
                  errText,
                );
                return { scenario: app.name, pageStructure: '', englishName: toPascalCase(app.id) };
              }

              const llmData = (await llmRes.json()) as {
                content: Array<{ type: string; text?: string }>;
              };
              const text =
                llmData.content?.find((b: { type: string }) => b.type === 'text')?.text || '';
              console.log(
                `[appGenerator] Summarize ${app.id} done, response length=${text.length}`,
              );
              console.log(
                `[appGenerator] [${app.id}] ═══ SUMMARIZE RESPONSE ═══\n${text}\n═══ END SUMMARIZE RESPONSE ═══`,
              );

              const nameMatch = text.match(/【英文名称】\s*([\s\S]*?)(?=【应用场景】|$)/);
              const scenarioMatch = text.match(/【应用场景】\s*([\s\S]*?)(?=【页面结构】|$)/);
              const structureMatch = text.match(/【页面结构】\s*([\s\S]*?)$/);

              const englishName =
                nameMatch?.[1]?.trim().replace(/[^a-zA-Z]/g, '') || toPascalCase(app.id);
              const result = {
                scenario: scenarioMatch?.[1]?.trim() || app.name,
                pageStructure: structureMatch?.[1]?.trim() || '',
                englishName,
              };
              console.log(
                `[appGenerator] Summarize ${app.id} parsed: englishName=${result.englishName}, scenario=${result.scenario.slice(0, 80)}...`,
              );
              return result;
            } catch (err) {
              console.error(`[appGenerator] LLM summary error for ${app.id}:`, err);
              return { scenario: app.name, pageStructure: '', englishName: toPascalCase(app.id) };
            }
          };

          // ── Step 2: Build CC prompt from summarized data ──
          const buildPrompt = (
            app: (typeof apps)[number],
            summary: { scenario: string; pageStructure: string; englishName: string },
          ) => {
            return [
              `Build a VibeApp named "${summary.englishName}" (original name: ${app.name}).`,
              '',
              `## Scenario`,
              summary.scenario,
              '',
              `## Page Structure & Interactions`,
              summary.pageStructure,
              '',
              `## Data Integration`,
              `- Trigger keywords: ${(app.keywords || []).join(', ')}`,
              `- Data format: json`,
              '',
              `## Important`,
              `- Use responsive layout, do not hardcode container dimensions`,
              `- Follow the VibeApp workflow and project conventions defined in CLAUDE.md`,
            ].join('\n');
          };

          // Concurrency-limited execution
          // Pause Vite file watcher on entire src/ to prevent HMR during code generation
          // (agents edit src/pages/*, src/routers/*, src/lib/* etc.)
          const srcGlob = resolve(__dirname, 'src/**');
          const watcher = viteServer?.watcher;
          if (watcher) {
            console.log('[appGenerator] Unwatching src/** to prevent HMR during generation');
            watcher.unwatch(srcGlob);
          }

          const queue = [...apps];
          const running = new Set<Promise<void>>();
          const state = { closed: false };

          req.on('close', () => {
            state.closed = true;
          });

          const runOne = async (app: (typeof apps)[number]) => {
            if (state.closed) return;
            const appId = app.id;
            console.log(`[appGenerator] ── Starting app: ${appId} ──`);
            sendEvent({ type: 'summarizing', appId, name: app.name });

            try {
              // Pre-process: summarize app data via LLM
              console.log(`[appGenerator] [${appId}] Step 1: Summarizing...`);
              const summary = await summarizeApp(app);
              if (state.closed) {
                console.log(
                  `[appGenerator] [${appId}] Aborted (client disconnected after summarize)`,
                );
                return;
              }
              console.log(
                `[appGenerator] [${appId}] Step 1 done. Scenario: ${summary.scenario.slice(0, 60)}...`,
              );
              sendEvent({ type: 'summarized', appId, summary });

              const appPascalName = summary.englishName;
              const prompt = buildPrompt(app, summary);
              const sysPrompt = [
                `You are building App ID: ${appPascalName}`,
                `You may ONLY create and modify files under src/pages/${appPascalName}/.`,
                `Do NOT read or modify any other App directories under src/pages/.`,
                `Concurrent builds are in progress — other Apps are being generated simultaneously. Strictly limit your operations to your own scope.`,
              ].join('\n');
              console.log(
                `[appGenerator] [${appId}] Step 2: Agent SDK query (englishName=${appPascalName}, prompt length=${prompt.length}, cwd=${projectRoot})`,
              );
              console.log(
                `[appGenerator] [${appId}] ═══ FULL PROMPT ═══\n${prompt}\n═══ END PROMPT ═══`,
              );
              console.log(
                `[appGenerator] [${appId}] ═══ SYSTEM PROMPT ═══\n${sysPrompt}\n═══ END SYSTEM PROMPT ═══`,
              );

              sendEvent({ type: 'started', appId });
              let result = '';
              let messageCount = 0;
              for await (const message of queryFn({
                prompt,
                options: {
                  cwd: projectRoot,
                  allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill'],
                  settingSources: ['user', 'project', 'local'],
                  permissionMode: 'bypassPermissions',
                  allowDangerouslySkipPermissions: true,
                  maxTurns: 100,
                  systemPrompt: sysPrompt,
                },
              })) {
                messageCount++;
                if (state.closed) {
                  console.log(
                    `[appGenerator] [${appId}] Aborted (client disconnected during query, after ${messageCount} messages)`,
                  );
                  return;
                }
                if ('result' in message) {
                  result = message.result;
                  console.log(
                    `[appGenerator] [${appId}] ── Result (#${messageCount}): ${String(result).slice(0, 200)}`,
                  );
                } else {
                  // Log tool calls and assistant text
                  const msg = message as Record<string, unknown>;
                  if (msg.type === 'assistant') {
                    const content = msg.message && (msg.message as Record<string, unknown>).content;
                    if (Array.isArray(content)) {
                      for (const block of content) {
                        if (block.type === 'tool_use') {
                          const input = block.input as Record<string, unknown>;
                          const preview =
                            block.name === 'Write' || block.name === 'Edit'
                              ? `file=${input.file_path || input.path || ''}`
                              : block.name === 'Read'
                                ? `file=${input.file_path || ''}`
                                : block.name === 'Bash'
                                  ? `cmd=${String(input.command || '').slice(0, 80)}`
                                  : block.name === 'Glob'
                                    ? `pattern=${input.pattern || ''}`
                                    : block.name === 'Grep'
                                      ? `pattern=${input.pattern || ''}`
                                      : JSON.stringify(input).slice(0, 80);
                          console.log(`[appGenerator] [${appId}] 🔧 ${block.name}(${preview})`);
                        } else if (block.type === 'text' && block.text) {
                          console.log(
                            `[appGenerator] [${appId}] 💬 ${String(block.text).slice(0, 150)}`,
                          );
                        }
                      }
                    }
                  } else {
                    if (messageCount <= 3) {
                      console.log(
                        `[appGenerator] [${appId}] Message #${messageCount} type=${msg.type || Object.keys(msg).join(',')}`,
                      );
                    }
                  }
                }
              }
              console.log(`[appGenerator] [${appId}] ✅ Completed after ${messageCount} messages`);
              sendEvent({ type: 'completed', appId, result });
            } catch (err) {
              console.error(`[appGenerator] [${appId}] ❌ Error:`, err);
              sendEvent({ type: 'error', appId, message: String(err) });
            }
          };

          while (queue.length > 0 && !state.closed) {
            while (running.size < concurrency && queue.length > 0) {
              const app = queue.shift()!;
              const p = runOne(app).then(() => {
                running.delete(p);
              });
              running.add(p);
            }
            if (running.size > 0) {
              await Promise.race(running);
            }
          }

          // Wait for remaining
          await Promise.allSettled(Array.from(running));

          // Resume Vite file watcher on src/pages (reload deferred to UI on modal close)
          if (watcher) {
            console.log('[appGenerator] Re-watching src/pages/**');
            watcher.add(srcGlob);
          }

          if (!state.closed) {
            console.log('[appGenerator] ── All apps finished, sending done event ──');
            sendEvent({ type: 'done' });
            res.end();
          } else {
            console.log('[appGenerator] ── Stream closed by client before completion ──');
          }
        });
      });
    },
  };
}

function toPascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
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
    logServerPlugin(),
    llmProxyPlugin(),
    jsonFilePlugin('characters', '/api/characters', CHARACTERS_FILE),
    jsonFilePlugin('mods', '/api/mods', MODS_FILE),
    appGeneratorPlugin(),
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
