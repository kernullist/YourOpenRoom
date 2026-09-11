// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AoiTurnCorpusCase } from '../__fixtures__/aoiTurnUnderstandingCorpus';
import {
  AOI_TURN_EVAL_EXIT_ERROR,
  AOI_TURN_EVAL_EXIT_INPUT,
  AOI_TURN_EVAL_EXIT_OK,
  classifyAoiTurnCaseLive,
  defaultAoiConfigFile,
  parseAoiTurnEvalCliOptions,
  readAoiTurnEvalLiveConfig,
  runAoiTurnUnderstandingEvalCli,
  selectAoiTurnEvalCases,
  summarizeLatency,
  toLivePrediction,
} from '../aoiTurnUnderstandingEvalCli';
import { AOI_TURN_UNDERSTANDING_TOOL_NAME } from '../aoiTurnUnderstanding';

const CORPUS: AoiTurnCorpusCase[] = [
  {
    id: 'chat',
    text: '고마워',
    gold: { kind: 'chitchat', families: ['none'], route: 'dialog' },
    tags: ['chitchat'],
  },
  {
    id: 'ref',
    text: '그거 다시 읽어줘',
    turns: [
      {
        user: 'src/lib/a.ts 읽어줘',
        assistant: '읽었어.',
        tools: [{ name: 'ide_read_file', args: 'path=src/lib/a.ts', outcome: 'ok' }],
      },
    ],
    gold: { kind: 'action_request', families: ['file'], route: 'main', refersToTurn: 1 },
    tags: ['anaphora'],
  },
];

const tempFiles: string[] = [];

function writeConfig(content: unknown): string {
  const file = join(
    os.tmpdir(),
    `aoi-turn-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(content));
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  }
});

function toolCallBody(args: unknown, name = AOI_TURN_UNDERSTANDING_TOOL_NAME) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('parseAoiTurnEvalCliOptions', () => {
  it('applies defaults and reads each option', () => {
    const env = { OPENROOM_HOME: 'C:/home' };
    const defaults = parseAoiTurnEvalCliOptions([], env);
    expect(defaults).toEqual({
      regexOnly: false,
      configFile: defaultAoiConfigFile(env),
      tag: null,
      limit: null,
      concurrency: 2,
      timeoutMs: 20_000,
      json: false,
      reasoningEffort: 'none',
    });
    expect(defaultAoiConfigFile(env).replace(/\\/g, '/')).toBe('C:/home/config.json');
    expect(defaultAoiConfigFile({})).toContain('.openroom');
    const parsed = parseAoiTurnEvalCliOptions(
      [
        '--regex-only',
        '--config-file=c.json',
        '--tag',
        'ko',
        '--limit',
        '5',
        '--concurrency=3',
        '--timeout-ms',
        '5000',
        '--json',
      ],
      {},
    );
    expect(parsed).toEqual({
      regexOnly: true,
      configFile: 'c.json',
      tag: 'ko',
      limit: 5,
      concurrency: 3,
      timeoutMs: 5000,
      json: true,
      reasoningEffort: 'none',
    });
    expect(parseAoiTurnEvalCliOptions(['--reasoning-effort', 'default'], {}).reasoningEffort).toBe(
      'default',
    );
    expect(parseAoiTurnEvalCliOptions(['--reasoning-effort', 'high'], {}).reasoningEffort).toBe(
      'high',
    );
    expect(parseAoiTurnEvalCliOptions([], { AOI_DAEMON_CONFIG_FILE: 'd.json' }).configFile).toBe(
      'd.json',
    );
  });

  it('rejects invalid numbers', () => {
    expect(() => parseAoiTurnEvalCliOptions(['--limit', '0'], {})).toThrow('--limit');
    expect(() => parseAoiTurnEvalCliOptions(['--concurrency', '9'], {})).toThrow('--concurrency');
    expect(() => parseAoiTurnEvalCliOptions(['--timeout-ms', '10'], {})).toThrow('--timeout-ms');
    expect(() => parseAoiTurnEvalCliOptions(['--reasoning-effort', 'max'], {})).toThrow(
      '--reasoning-effort',
    );
  });
});

describe('readAoiTurnEvalLiveConfig', () => {
  it('reads the llm section and normalizes the base url', () => {
    const file = writeConfig({
      llm: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1/',
        apiKey: 'k',
        model: 'm',
        reasoningEffort: 'medium',
      },
    });
    expect(readAoiTurnEvalLiveConfig(file)).toEqual({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      model: 'm',
      reasoningEffort: 'medium',
    });
    const flat = writeConfig({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt',
    });
    expect(readAoiTurnEvalLiveConfig(flat).apiKey).toBe('');
  });

  it('refuses missing files, incomplete configs, and non-OpenAI providers', () => {
    expect(() => readAoiTurnEvalLiveConfig(join(os.tmpdir(), 'missing-aoi.json'))).toThrow(
      'not found',
    );
    expect(() => readAoiTurnEvalLiveConfig(writeConfig({ llm: { provider: 'openai' } }))).toThrow(
      'provider and model',
    );
    expect(() =>
      readAoiTurnEvalLiveConfig(
        writeConfig({ llm: { provider: 'anthropic', model: 'x', baseUrl: 'u' } }),
      ),
    ).toThrow('not OpenAI-compatible');
    expect(() =>
      readAoiTurnEvalLiveConfig(writeConfig({ llm: { provider: 'openai', model: 'x' } })),
    ).toThrow('baseUrl');
  });
});

describe('selectAoiTurnEvalCases', () => {
  it('filters by tag and limits', () => {
    expect(
      selectAoiTurnEvalCases(CORPUS, { tag: 'anaphora', limit: null }).map((c) => c.id),
    ).toEqual(['ref']);
    expect(selectAoiTurnEvalCases(CORPUS, { tag: null, limit: 1 }).map((c) => c.id)).toEqual([
      'chat',
    ]);
    expect(selectAoiTurnEvalCases(CORPUS, { tag: 'none', limit: null })).toEqual([]);
  });
});

describe('classifyAoiTurnCaseLive', () => {
  const config = { provider: 'openrouter', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm' };

  it('posts the OpenAI wire format with the tool and returns the validated reading', async () => {
    const fetchImpl = fetchReturning(
      toolCallBody({
        kind: 'action_request',
        families: ['file'],
        refers_to_turn: 1,
        referent: 'src/lib/a.ts',
        confidence: 'high',
      }),
    );
    let tick = 0;
    const result = await classifyAoiTurnCaseLive(CORPUS[1], config, {
      fetchImpl,
      timeoutMs: 5000,
      now: () => {
        tick += 100;
        return tick;
      },
    });
    expect(result.error).toBeNull();
    expect(result.understanding).toMatchObject({
      kind: 'action_request',
      referent: 'src/lib/a.ts',
      refersToTurn: 1,
      latencyMs: 100,
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://x.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string) as {
      model: string;
      tools: unknown[];
      temperature?: number;
      reasoning?: unknown;
    };
    expect(body.model).toBe('m');
    expect(body.tools).toHaveLength(1);
    expect(body.temperature).toBe(0);
    expect(body.reasoning).toBeUndefined();
  });

  it('sends the reasoning effort when configured and omits the auth header without a key', async () => {
    const fetchImpl = fetchReturning(
      toolCallBody({ kind: 'chitchat', families: ['none'], confidence: 'high' }),
    );
    await classifyAoiTurnCaseLive(
      CORPUS[0],
      { ...config, apiKey: '', reasoningEffort: 'high' },
      { fetchImpl, timeoutMs: 5000 },
    );
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as {
      temperature?: number;
      reasoning?: { effort: string };
    };
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.temperature).toBeUndefined();
    const none = fetchReturning(
      toolCallBody({ kind: 'chitchat', families: ['none'], confidence: 'high' }),
    );
    await classifyAoiTurnCaseLive(
      CORPUS[0],
      { ...config, reasoningEffort: 'none' },
      { fetchImpl: none, timeoutMs: 5000 },
    );
    const noneBody = JSON.parse(
      ((none as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    ) as {
      temperature?: number;
      reasoning?: unknown;
    };
    // On OpenRouter, none disables thinking explicitly and pins temperature.
    expect(noneBody.reasoning).toEqual({ enabled: false });
    expect(noneBody.temperature).toBe(0);
    // reasoning.effort is an OpenRouter field; another provider gets neither it nor temperature.
    const openai = fetchReturning(
      toolCallBody({ kind: 'chitchat', families: ['none'], confidence: 'high' }),
    );
    await classifyAoiTurnCaseLive(
      CORPUS[0],
      { ...config, provider: 'openai', reasoningEffort: 'high' },
      { fetchImpl: openai, timeoutMs: 5000 },
    );
    const openaiBody = JSON.parse(
      ((openai as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    ) as { temperature?: number; reasoning?: unknown };
    expect(openaiBody.reasoning).toBeUndefined();
    expect(openaiBody.temperature).toBeUndefined();
    // DeepSeek takes its own thinking block, as the runtime sends it.
    const deepseek = fetchReturning(
      toolCallBody({ kind: 'chitchat', families: ['none'], confidence: 'high' }),
    );
    await classifyAoiTurnCaseLive(
      CORPUS[0],
      { ...config, provider: 'deepseek', reasoningEffort: 'none' },
      { fetchImpl: deepseek, timeoutMs: 5000 },
    );
    const deepseekBody = JSON.parse(
      ((deepseek as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    ) as { thinking?: unknown; reasoning?: unknown; temperature?: number };
    expect(deepseekBody.thinking).toEqual({ type: 'disabled' });
    expect(deepseekBody.reasoning).toBeUndefined();
    expect(deepseekBody.temperature).toBe(0);
    // 'none' disables thinking explicitly on OpenRouter and pins temperature.
    const disabled = fetchReturning(
      toolCallBody({ kind: 'chitchat', families: ['none'], confidence: 'high' }),
    );
    await classifyAoiTurnCaseLive(
      CORPUS[0],
      { ...config, reasoningEffort: 'none' },
      { fetchImpl: disabled, timeoutMs: 5000 },
    );
    const disabledBody = JSON.parse(
      ((disabled as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    ) as { temperature?: number; reasoning?: unknown };
    expect(disabledBody.reasoning).toEqual({ enabled: false });
    expect(disabledBody.temperature).toBe(0);
  });

  it('retries a rate-limited call with backoff and gives up after the last delay', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = vi.fn(async () => {
        calls += 1;
        if (calls < 3) {
          return { ok: false, status: 429, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () =>
            toolCallBody({ kind: 'chitchat', families: ['none'], confidence: 'high' }),
        };
      }) as unknown as typeof fetch;
      const pending = classifyAoiTurnCaseLive(CORPUS[0], config, {
        fetchImpl: flaky,
        timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      const result = await pending;
      expect(result.error).toBeNull();
      expect(calls).toBe(3);

      const always = vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })) as unknown as typeof fetch;
      const failing = classifyAoiTurnCaseLive(CORPUS[0], config, {
        fetchImpl: always,
        timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      expect((await failing).error).toBe('HTTP 503');
      expect(always).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports http errors, missing tool calls, bad arguments, invalid readings, timeouts, and throws', async () => {
    expect(
      (
        await classifyAoiTurnCaseLive(CORPUS[0], config, {
          fetchImpl: fetchReturning({}, 500),
          timeoutMs: 5000,
        })
      ).error,
    ).toBe('HTTP 500');
    expect(
      (
        await classifyAoiTurnCaseLive(CORPUS[0], config, {
          fetchImpl: fetchReturning({ choices: [{ message: { content: 'prose' } }] }),
          timeoutMs: 5000,
        })
      ).error,
    ).toBe('no tool call');
    const badArgs = fetchReturning({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: AOI_TURN_UNDERSTANDING_TOOL_NAME, arguments: '{nope' } },
            ],
          },
        },
      ],
    });
    expect(
      (await classifyAoiTurnCaseLive(CORPUS[0], config, { fetchImpl: badArgs, timeoutMs: 5000 }))
        .error,
    ).toBe('unparseable arguments');
    expect(
      (
        await classifyAoiTurnCaseLive(CORPUS[0], config, {
          fetchImpl: fetchReturning(toolCallBody({ kind: 'weird', families: ['app'] })),
          timeoutMs: 5000,
        })
      ).error,
    ).toBe('failed validation');
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;
    expect(
      (await classifyAoiTurnCaseLive(CORPUS[0], config, { fetchImpl: hanging, timeoutMs: 1 }))
        .error,
    ).toBe('timeout');
    const throwing = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    expect(
      (await classifyAoiTurnCaseLive(CORPUS[0], config, { fetchImpl: throwing, timeoutMs: 5000 }))
        .error,
    ).toContain('boom');
  });
});

describe('toLivePrediction', () => {
  it('falls back to regex with source none when the reading is null', () => {
    expect(toLivePrediction(CORPUS[0], null)).toMatchObject({ route: 'dialog', source: 'none' });
  });

  it('applies the regex floor and converts the referenced turn to a relative position', () => {
    const prediction = toLivePrediction(CORPUS[1], {
      kind: 'action_request',
      families: ['file'],
      refersToTurn: 1,
      referent: 'src/lib/a.ts',
      confidence: 'high',
      needsClarification: null,
      clarificationOptions: [],
      source: 'classifier',
      musicTarget: null,
      musicReference: null,
      latencyMs: 12,
    });
    expect(prediction).toEqual({
      kind: 'action_request',
      families: ['file'],
      route: 'main',
      refersToTurn: 1,
      latencyMs: 12,
      source: 'classifier',
      musicReference: null,
      musicTarget: null,
    });
    const unknownTurn = toLivePrediction(CORPUS[1], {
      kind: 'action_request',
      families: ['file'],
      refersToTurn: 42,
      referent: null,
      confidence: 'medium',
      needsClarification: null,
      clarificationOptions: [],
      source: 'classifier',
      musicTarget: null,
      musicReference: null,
    });
    expect(unknownTurn.refersToTurn).toBeNull();
    expect(unknownTurn.latencyMs).toBeUndefined();
  });
});

describe('runAoiTurnUnderstandingEvalCli', () => {
  function deps(argv: string[], fetchImpl: typeof fetch = fetchReturning({})) {
    const logs: string[] = [];
    const errors: string[] = [];
    return {
      logs,
      errors,
      deps: {
        argv,
        env: {},
        fetchImpl,
        corpus: CORPUS,
        log: (message: string) => {
          logs.push(message);
        },
        logError: (message: string) => {
          errors.push(message);
        },
      },
    };
  }

  it('scores the regex baseline offline in text and json', async () => {
    const text = deps(['--regex-only']);
    expect(await runAoiTurnUnderstandingEvalCli(text.deps)).toBe(AOI_TURN_EVAL_EXIT_OK);
    expect(text.logs.join('\n')).toContain('[regex baseline] 2 cases');
    const json = deps(['--regex-only', '--json']);
    expect(await runAoiTurnUnderstandingEvalCli(json.deps)).toBe(AOI_TURN_EVAL_EXIT_OK);
    const report = JSON.parse(json.logs[0]) as {
      mode: string;
      live: unknown;
      regex: { total: number };
      liveLatency: unknown;
      liveCases: unknown[];
    };
    expect(report.mode).toBe('regex');
    expect(report.live).toBeNull();
    expect(report.regex.total).toBe(2);
    expect(report.liveLatency).toBeNull();
    expect(report.liveCases).toEqual([]);
  });

  it('runs the live classifier and reports both baselines', async () => {
    const file = writeConfig({
      llm: { provider: 'openrouter', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'live-m' },
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
      const isRef = body.messages[1].content.includes('그거 다시');
      return {
        ok: true,
        status: 200,
        json: async () =>
          toolCallBody(
            isRef
              ? {
                  kind: 'action_request',
                  families: ['file'],
                  refers_to_turn: 1,
                  referent: 'src/lib/a.ts',
                  confidence: 'high',
                }
              : { kind: 'chitchat', families: ['none'], confidence: 'high' },
          ),
      };
    }) as unknown as typeof fetch;
    const live = deps(['--config-file', file, '--concurrency', '1'], fetchImpl);
    expect(await runAoiTurnUnderstandingEvalCli(live.deps)).toBe(AOI_TURN_EVAL_EXIT_OK);
    const output = live.logs.join('\n');
    expect(output).toContain('[regex baseline] 2 cases');
    expect(output).toContain('live classifier live-m');
    expect(output).toContain('0 calls fell back');
    expect(output).toContain('references 1/1');
    expect(output).toContain('reasoning effort: none');
    expect(output).not.toContain('not sent');
    expect(output).toContain('fell back: 0');
    expect(output).toContain('confidence: high 2');
    expect(output).toMatch(
      /latency: p50 \d+ ms, p90 \d+ ms, max \d+ ms; 0\/2 over the 8000 ms runtime budget/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const overridden = deps(
      ['--config-file', file, '--reasoning-effort', 'low', '--json'],
      fetchImpl,
    );
    expect(await runAoiTurnUnderstandingEvalCli(overridden.deps)).toBe(AOI_TURN_EVAL_EXIT_OK);
    const overriddenReport = JSON.parse(overridden.logs[0]) as {
      reasoningEffort: string;
      liveCases: Array<{ id: string; confidence: string | null; error: string | null }>;
    };
    expect(overriddenReport.reasoningEffort).toBe('low');

    // 'default' sends whatever the config file says, which here is nothing.
    const providerDefault = deps(
      ['--config-file', file, '--reasoning-effort', 'default', '--json'],
      fetchImpl,
    );
    expect(await runAoiTurnUnderstandingEvalCli(providerDefault.deps)).toBe(AOI_TURN_EVAL_EXIT_OK);
    expect(
      (JSON.parse(providerDefault.logs[0]) as { reasoningEffort: string | null }).reasoningEffort,
    ).toBeNull();
    expect(overriddenReport.liveCases.map((entry) => entry.id)).toEqual(['chat', 'ref']);
    expect(overriddenReport.liveCases[0]).toMatchObject({ confidence: 'high', error: null });
  });

  it('summarizes latency with percentiles and the over-budget count', () => {
    expect(summarizeLatency([], 8000)).toBeNull();
    expect(summarizeLatency([100], 8000)).toEqual({
      count: 1,
      p50: 100,
      p90: 100,
      max: 100,
      budgetMs: 8000,
      overBudget: 0,
    });
    expect(summarizeLatency([9000, 100, 500, 200, 12_000, 300, 400, 600, 700, 800], 8000)).toEqual({
      count: 10,
      p50: 500,
      p90: 9000,
      max: 12_000,
      budgetMs: 8000,
      overBudget: 2,
    });
  });

  it('counts calls that fell back and returns error codes for bad input and failures', async () => {
    const file = writeConfig({
      llm: { provider: 'openrouter', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'm' },
    });
    const failing = deps(['--config-file', file, '--json'], fetchReturning({}, 500));
    expect(await runAoiTurnUnderstandingEvalCli(failing.deps)).toBe(AOI_TURN_EVAL_EXIT_OK);
    const report = JSON.parse(failing.logs[0]) as {
      liveErrors: number;
      liveErrorReasons: Record<string, number>;
      live: { routeAccuracy: number };
    };
    expect(report.liveErrors).toBe(2);
    expect(report.liveErrorReasons).toEqual({ 'HTTP 500': 2 });
    expect(report.live.routeAccuracy).toBeGreaterThanOrEqual(0);

    const badInput = deps(['--limit', 'x']);
    expect(await runAoiTurnUnderstandingEvalCli(badInput.deps)).toBe(AOI_TURN_EVAL_EXIT_INPUT);
    expect(badInput.errors[0]).toContain('--limit');

    const noMatch = deps(['--regex-only', '--tag', 'nothing']);
    expect(await runAoiTurnUnderstandingEvalCli(noMatch.deps)).toBe(AOI_TURN_EVAL_EXIT_ERROR);
    expect(noMatch.errors[0]).toContain('No corpus cases');

    const noConfig = deps(['--config-file', join(os.tmpdir(), 'nope-aoi.json')]);
    expect(await runAoiTurnUnderstandingEvalCli(noConfig.deps)).toBe(AOI_TURN_EVAL_EXIT_ERROR);
  });
});
