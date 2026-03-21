/**
 * App code generator plugin — uses Claude Agent SDK to concurrently generate
 * VibeApp code for each app in a parsed character card manifest.
 *
 * POST /api/generate-apps  { apps: AppEntry[], concurrency?: number }
 * Response: SSE stream with per-app progress events
 */

import type { Plugin } from 'vite';
import { resolve } from 'path';
import * as fs from 'fs';

const LOG_PREFIX = '[appGenerator]';

interface AppInput {
  id: string;
  name: string;
  keywords?: string[];
  format?: string;
  tags: Array<{ name: string; type?: string; description?: string }>;
  example: string;
  resources: Record<string, string[]>;
  scripts?: Array<{
    name: string;
    type: string;
    findRegex: string;
    replaceString: string;
  }>;
  imageTagPairs?: Array<{ tag: string; imgStyle: string }>;
}

interface LlmConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  customHeaders?: string;
}

interface AppSummary {
  scenario: string;
  pageStructure: string;
  englishName: string;
}

function toPascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function loadLlmConfig(configFile: string): LlmConfig {
  try {
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const config = cfg.llm || {};
      console.log(
        `${LOG_PREFIX} LLM config loaded: baseUrl=${config.baseUrl}, model=${config.model}, apiKey=${config.apiKey ? '***' + config.apiKey.slice(-4) : 'MISSING'}`,
      );
      return config;
    } else {
      console.warn(`${LOG_PREFIX} LLM config file not found: ${configFile}`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to read LLM config:`, err);
  }
  return {};
}

function buildLlmHeaders(llmConfig: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': llmConfig.apiKey || '',
    'anthropic-version': '2023-06-01',
  };
  if (llmConfig.customHeaders) {
    for (const pair of llmConfig.customHeaders.split(',')) {
      const [hk, ...hv] = pair.split(':');
      if (hk && hv.length) headers[hk.trim()] = hv.join(':').trim();
    }
  }
  return headers;
}

async function summarizeApp(app: AppInput, llmConfig: LlmConfig): Promise<AppSummary> {
  const apiKey = llmConfig.apiKey;
  const baseUrl = llmConfig.baseUrl || 'https://api.anthropic.com';
  const model = llmConfig.model || 'claude-sonnet-4-6';

  if (!apiKey) {
    console.warn(`${LOG_PREFIX} No API key for summarize, skipping LLM call for ${app.id}`);
    return {
      scenario: app.name,
      pageStructure: 'No LLM config available',
      englishName: toPascalCase(app.id),
    };
  }
  console.log(`${LOG_PREFIX} Summarizing ${app.id}: POST ${baseUrl}/v1/messages (model=${model})`);

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
${(app.tags || []).map((t) => `<${t.name}>: ${t.description || t.type || ''}`).join(', ')}

### Layout Scripts (HTML template reference)
${
  (app.scripts || [])
    .filter((s) => s.type === 'layout')
    .map((s) => `#### ${s.name}\n\`\`\`html\n${s.replaceString.slice(0, 1200)}\n\`\`\``)
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

  try {
    const llmRes = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: buildLlmHeaders(llmConfig),
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: summaryPrompt }],
      }),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      console.error(
        `${LOG_PREFIX} LLM summary failed for ${app.id}: status=${llmRes.status}`,
        errText,
      );
      return { scenario: app.name, pageStructure: '', englishName: toPascalCase(app.id) };
    }

    const llmData = (await llmRes.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = llmData.content?.find((b) => b.type === 'text')?.text || '';
    console.log(`${LOG_PREFIX} Summarize ${app.id} done, response length=${text.length}`);

    const nameMatch = text.match(/【英文名称】\s*([\s\S]*?)(?=【应用场景】|$)/);
    const scenarioMatch = text.match(/【应用场景】\s*([\s\S]*?)(?=【页面结构】|$)/);
    const structureMatch = text.match(/【页面结构】\s*([\s\S]*?)$/);

    const englishName = nameMatch?.[1]?.trim().replace(/[^a-zA-Z]/g, '') || toPascalCase(app.id);
    return {
      scenario: scenarioMatch?.[1]?.trim() || app.name,
      pageStructure: structureMatch?.[1]?.trim() || '',
      englishName,
    };
  } catch (err) {
    console.error(`${LOG_PREFIX} LLM summary error for ${app.id}:`, err);
    return { scenario: app.name, pageStructure: '', englishName: toPascalCase(app.id) };
  }
}

function buildAgentPrompt(app: AppInput, summary: AppSummary): string {
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
}

function getToolPreview(block: { name: string; input: Record<string, unknown> }): string {
  const input = block.input;
  switch (block.name) {
    case 'Write':
    case 'Edit':
      return `file=${input.file_path || input.path || ''}`;
    case 'Read':
      return `file=${input.file_path || ''}`;
    case 'Bash':
      return `cmd=${String(input.command || '').slice(0, 80)}`;
    case 'Glob':
    case 'Grep':
      return `pattern=${input.pattern || ''}`;
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

interface AppGeneratorOptions {
  llmConfigFile: string;
  /** Absolute path to the monorepo root (cwd for Agent SDK). */
  projectRoot: string;
  /** Absolute path to the app's src directory (for watcher pause/resume). */
  srcDir: string;
}

export function appGeneratorPlugin(options: AppGeneratorOptions): Plugin {
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
          let body: { apps: AppInput[]; concurrency?: number };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          const { apps, concurrency = 3 } = body;
          console.log(
            `${LOG_PREFIX} Received request: ${apps?.length ?? 0} apps, concurrency=${concurrency}`,
          );
          if (!Array.isArray(apps) || apps.length === 0) {
            console.error(`${LOG_PREFIX} Empty or invalid apps array`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'apps array is required' }));
            return;
          }
          console.log(
            `${LOG_PREFIX} Apps to generate:`,
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
          console.log(`${LOG_PREFIX} Loading Agent SDK...`);
          let queryFn: (typeof import('@anthropic-ai/claude-agent-sdk'))['query'];
          try {
            const sdk = await import('@anthropic-ai/claude-agent-sdk');
            queryFn = sdk.query;
            console.log(`${LOG_PREFIX} Agent SDK loaded successfully`);
          } catch (err) {
            console.error(`${LOG_PREFIX} Failed to load Agent SDK:`, err);
            sendEvent({ type: 'error', message: `Failed to load Agent SDK: ${err}` });
            res.end();
            return;
          }

          const projectRoot = options.projectRoot;
          const llmConfig = loadLlmConfig(options.llmConfigFile);

          // Pause Vite file watcher to prevent HMR during code generation
          const srcGlob = resolve(options.srcDir, '**');
          const watcher = viteServer?.watcher;
          if (watcher) {
            console.log(`${LOG_PREFIX} Unwatching src/** to prevent HMR during generation`);
            watcher.unwatch(srcGlob);
          }

          const queue = [...apps];
          const running = new Set<Promise<void>>();
          const state = { closed: false };

          req.on('close', () => {
            state.closed = true;
          });

          const runOne = async (app: AppInput) => {
            if (state.closed) return;
            const appId = app.id;
            console.log(`${LOG_PREFIX} -- Starting app: ${appId} --`);
            sendEvent({ type: 'summarizing', appId, name: app.name });

            try {
              console.log(`${LOG_PREFIX} [${appId}] Step 1: Summarizing...`);
              const summary = await summarizeApp(app, llmConfig);
              if (state.closed) {
                console.log(
                  `${LOG_PREFIX} [${appId}] Aborted (client disconnected after summarize)`,
                );
                return;
              }
              console.log(
                `${LOG_PREFIX} [${appId}] Step 1 done. Scenario: ${summary.scenario.slice(0, 60)}...`,
              );
              sendEvent({ type: 'summarized', appId, summary });

              const appPascalName = summary.englishName;
              const prompt = buildAgentPrompt(app, summary);
              const sysPrompt = [
                `You are building App ID: ${appPascalName}`,
                `You may ONLY create and modify files under src/pages/${appPascalName}/.`,
                `Do NOT read or modify any other App directories under src/pages/.`,
                `Concurrent builds are in progress — other Apps are being generated simultaneously. Strictly limit your operations to your own scope.`,
              ].join('\n');
              console.log(
                `${LOG_PREFIX} [${appId}] Step 2: Agent SDK query (englishName=${appPascalName}, prompt length=${prompt.length})`,
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
                    `${LOG_PREFIX} [${appId}] Aborted (client disconnected, after ${messageCount} messages)`,
                  );
                  return;
                }
                if ('result' in message) {
                  result = message.result;
                  console.log(
                    `${LOG_PREFIX} [${appId}] -- Result (#${messageCount}): ${String(result).slice(0, 200)}`,
                  );
                } else {
                  const msg = message as Record<string, unknown>;
                  if (msg.type === 'assistant') {
                    const content = msg.message && (msg.message as Record<string, unknown>).content;
                    if (Array.isArray(content)) {
                      for (const block of content) {
                        if (block.type === 'tool_use') {
                          const preview = getToolPreview(block);
                          console.log(`${LOG_PREFIX} [${appId}] TOOL ${block.name}(${preview})`);
                        } else if (block.type === 'text' && block.text) {
                          console.log(
                            `${LOG_PREFIX} [${appId}] TEXT ${String(block.text).slice(0, 150)}`,
                          );
                        }
                      }
                    }
                  } else if (messageCount <= 3) {
                    console.log(
                      `${LOG_PREFIX} [${appId}] Message #${messageCount} type=${msg.type || Object.keys(msg).join(',')}`,
                    );
                  }
                }
              }
              console.log(`${LOG_PREFIX} [${appId}] Completed after ${messageCount} messages`);
              sendEvent({ type: 'completed', appId, result });
            } catch (err) {
              console.error(`${LOG_PREFIX} [${appId}] Error:`, err);
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

          await Promise.allSettled(Array.from(running));

          if (watcher) {
            console.log(`${LOG_PREFIX} Re-watching src/**`);
            watcher.add(srcGlob);
          }

          if (!state.closed) {
            console.log(`${LOG_PREFIX} -- All apps finished --`);
            sendEvent({ type: 'done' });
            res.end();
          } else {
            console.log(`${LOG_PREFIX} -- Stream closed by client before completion --`);
          }
        });
      });
    },
  };
}
