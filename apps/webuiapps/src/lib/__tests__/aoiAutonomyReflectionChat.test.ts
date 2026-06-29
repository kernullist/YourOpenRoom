import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAoiAutonomyReflectionChat,
  DEFAULT_AOI_REFLECTION_SERVER_ORIGIN,
} from '../aoiAutonomyReflectionChat';
import { runAoiAutonomyTick } from '../aoiAutonomyEngine';
import { saveAoiAutonomyPolicy } from '../aoiAutonomyStore';
import type { LLMConfig } from '../llmModels';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const roots: string[] = [];
let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-reflchat-'));
  roots.push(root);
  return root;
}

// A local OpenAI-compatible chat endpoint so the server-side path can be
// exercised over REAL HTTP (no '/api/llm-proxy' browser relative URL).
async function startFakeProvider(
  content: string,
): Promise<{ baseUrl: string; calls: () => number }> {
  let calls = 0;
  server = http.createServer((req, res) => {
    calls += 1;
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, calls: () => calls };
}

describe('createAoiAutonomyReflectionChat (server-capable reflection chat)', () => {
  it('exposes a sane default server origin', () => {
    expect(DEFAULT_AOI_REFLECTION_SERVER_ORIGIN).toMatch(/^http:\/\//);
  });

  it('routes through the server-side caller and returns model content over real HTTP', async () => {
    const fake = await startFakeProvider('{"focusSummary":"server-routed line"}');
    const config: LLMConfig = {
      provider: 'openai',
      apiKey: 'test',
      baseUrl: fake.baseUrl,
      model: 'test-model',
    };
    const chat = createAoiAutonomyReflectionChat();
    const response = await chat(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: '{"q":1}' },
      ],
      [],
      config,
    );
    // The adapter reached the provider directly (no /api/llm-proxy) and returned
    // its content -- exactly what the browser client could not do server-side.
    expect(response.content).toBe('{"focusSummary":"server-routed line"}');
    expect(response.toolCalls).toEqual([]);
    expect(fake.calls()).toBeGreaterThan(0);
  });

  it('lets the autonomy tick synthesize the brief through the real adapter (synthesizedBy=llm)', async () => {
    const fake = await startFakeProvider('{"focusSummary":"continue the kernel telemetry work"}');
    const root = tempRoot();
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      { enabled: true, previewMode: true, level: 'L4', maxProposalsPerTick: 4 },
      NOW,
    );
    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'kernel telemetry status?',
      llmConfig: {
        provider: 'openai',
        apiKey: 'test',
        baseUrl: fake.baseUrl,
        model: 'test-model',
      },
      // The REAL server adapter (not an injected canned stub) -> callAoiMainTextModel
      // -> real HTTP -> the fake provider. Proves the server-side LLM path works.
      reflectionChat: createAoiAutonomyReflectionChat(),
      now: NOW,
    });
    expect(result.strategicBrief?.synthesizedBy).toBe('llm');
    expect(result.strategicBrief?.focusSummary).toBe('continue the kernel telemetry work');
  });
});
