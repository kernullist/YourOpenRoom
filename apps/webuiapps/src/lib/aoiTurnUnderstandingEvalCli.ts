// Offline / live evaluation of turn understanding against the labelled corpus.
//
//   --regex-only            score the regex router (no network)
//   --config-file <path>    LLM config JSON (default ~/.openroom/config.json); its
//                           `llm` section is used for the live classifier
//   --tag <tag>             only cases carrying this tag
//   --limit <n>             first n cases after filtering
//   --concurrency <n>       live calls in flight (default 2; OpenRouter 429s above)
//   --timeout-ms <n>        per-call timeout for the live classifier (default 20000)
//   --reasoning-effort <v>  reasoning for the live classifier: none (the runtime's
//                           setting, and the default here) | low | medium | high |
//                           default (send nothing and take the provider's default)
//   --json                  print the report as JSON instead of text
//
// The live mode speaks the OpenAI chat-completions wire format directly, because
// the browser client's chat() posts to a relative proxy URL that does not exist
// under Node. Providers with an OpenAI-compatible endpoint (OpenRouter, OpenAI,
// DeepSeek, local servers) work; Anthropic-style and CLI providers are refused
// with an explanation rather than silently scoring zero.

import * as fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { LLMConfig, LLMProvider } from './llmModels';
import { applyDeepSeekChatRuntimeOptions, isDeepSeekProvider } from './llmModels';
import { shouldUseDialogModel } from './chatTokenControl';
import {
  AOI_TURN_UNDERSTANDING_CORPUS,
  type AoiTurnCorpusCase,
} from './__fixtures__/aoiTurnUnderstandingCorpus';
import { buildAoiRecentTurnsPromptBlock } from './aoiTurnRecord';
import { resolveAoiTurnRoute } from './aoiTurnContext';
import {
  AOI_TURN_UNDERSTANDING_TOOL_NAME,
  DEFAULT_AOI_TURN_CLASSIFIER_TIMEOUT_MS,
  buildAoiTurnUnderstandingMessages,
  getAoiTurnUnderstandingToolDefinition,
  parseAoiTurnUnderstandingToolCall,
  type AoiTurnUnderstanding,
} from './aoiTurnUnderstanding';
import {
  corpusTurnsToHistory,
  corpusTurnsToRecords,
  evaluateAoiTurnUnderstanding,
  formatAoiTurnEvalReport,
  predictAoiTurnWithRegex,
  type AoiTurnEvalPrediction,
  type AoiTurnEvalReport,
} from './aoiTurnUnderstandingEval';

export const AOI_TURN_EVAL_EXIT_OK = 0;
export const AOI_TURN_EVAL_EXIT_ERROR = 1;
export const AOI_TURN_EVAL_EXIT_INPUT = 2;

export type AoiTurnEvalReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'default';

export interface AoiTurnEvalCliOptions {
  regexOnly: boolean;
  configFile: string;
  tag: string | null;
  limit: number | null;
  concurrency: number;
  timeoutMs: number;
  json: boolean;
  reasoningEffort: AoiTurnEvalReasoningEffort;
}

export interface AoiTurnEvalLiveConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
}

export interface AoiTurnEvalCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  log: (message: string) => void;
  logError: (message: string) => void;
  // Test seam: the corpus to score (defaults to the shipped one).
  corpus?: readonly AoiTurnCorpusCase[];
}

export interface AoiTurnEvalLiveCase {
  id: string;
  confidence: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface AoiTurnEvalLatency {
  count: number;
  p50: number;
  p90: number;
  max: number;
  // Readings slower than the runtime's classifier timeout: in a real turn these
  // would have fallen back to the regex reading, however correct they were.
  budgetMs: number;
  overBudget: number;
}

export interface AoiTurnEvalCliReport {
  version: 1;
  mode: 'regex' | 'live';
  model: string | null;
  reasoningEffort: string | null;
  // Whether the provider's wire format carried the reasoning setting at all;
  // false means the label above names a request that went out unqualified.
  reasoningSent: boolean | null;
  regex: AoiTurnEvalReport;
  live: AoiTurnEvalReport | null;
  liveErrors: number;
  liveErrorReasons: Record<string, number>;
  liveLatency: AoiTurnEvalLatency | null;
  liveConfidence: Record<string, number>;
  liveCases: AoiTurnEvalLiveCase[];
}

const RETRYABLE_STATUS = new Set([429, 502, 503]);
const RETRY_DELAYS_MS = [2000, 4000];

const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'openai',
  'openrouter',
  'deepseek',
  'kimi',
  'groq',
  'together',
  'ollama',
  'lmstudio',
  'custom',
  'opencode',
]);

function readOption(argv: readonly string[], optionName: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === optionName && index + 1 < argv.length) {
      return argv[index + 1].trim();
    }
    const prefix = `${optionName}=`;
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return '';
}

function hasFlag(argv: readonly string[], optionName: string): boolean {
  return argv.includes(optionName);
}

export function defaultAoiConfigFile(env: Record<string, string | undefined>): string {
  const home = env.OPENROOM_HOME?.trim() || join(homedir(), '.openroom');
  return join(home, 'config.json');
}

export function parseAoiTurnEvalCliOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AoiTurnEvalCliOptions {
  const limitText = readOption(argv, '--limit');
  const limit = limitText ? Number.parseInt(limitText, 10) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  const concurrencyText = readOption(argv, '--concurrency') || '2';
  const concurrency = Number.parseInt(concurrencyText, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8.');
  }
  const timeoutText = readOption(argv, '--timeout-ms') || '20000';
  const timeoutMs = Number.parseInt(timeoutText, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 120000.');
  }
  // The runtime classifies with thinking off, so that is what an unqualified
  // run measures; 'default' asks for the provider default the way a config
  // without any reasoning setting used to be sent.
  const reasoningText = readOption(argv, '--reasoning-effort') || 'none';
  if (!['none', 'low', 'medium', 'high', 'default'].includes(reasoningText)) {
    throw new Error('--reasoning-effort must be one of none, low, medium, high, default.');
  }
  return {
    regexOnly: hasFlag(argv, '--regex-only'),
    configFile:
      readOption(argv, '--config-file') ||
      env.AOI_DAEMON_CONFIG_FILE?.trim() ||
      defaultAoiConfigFile(env),
    tag: readOption(argv, '--tag') || null,
    limit,
    concurrency,
    timeoutMs,
    json: hasFlag(argv, '--json'),
    reasoningEffort: reasoningText as AoiTurnEvalReasoningEffort,
  };
}

export function readAoiTurnEvalLiveConfig(configFile: string): AoiTurnEvalLiveConfig {
  if (!fs.existsSync(configFile)) {
    throw new Error(`LLM config file not found: ${configFile}`);
  }
  const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
  const raw =
    typeof parsed.llm === 'object' && parsed.llm !== null
      ? (parsed.llm as Record<string, unknown>)
      : parsed;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  const reasoningEffort =
    typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()
      ? raw.reasoningEffort.trim()
      : undefined;
  if (!provider || !model) {
    throw new Error('LLM config needs provider and model.');
  }
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    throw new Error(
      `Provider ${provider} is not OpenAI-compatible; the live eval supports ${[...OPENAI_COMPATIBLE_PROVIDERS].join(', ')}.`,
    );
  }
  if (!baseUrl) {
    throw new Error('LLM config needs baseUrl for the live eval.');
  }
  return { provider, baseUrl, apiKey, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

interface OpenAiToolCallShape {
  function?: { name?: string; arguments?: string };
}

/**
 * One live classifier call over the OpenAI chat-completions wire. Returns the
 * validated reading or null (no tool call, parse failure, HTTP error).
 */
export async function classifyAoiTurnCaseLive(
  testCase: AoiTurnCorpusCase,
  config: AoiTurnEvalLiveConfig,
  deps: { fetchImpl: typeof fetch; timeoutMs: number; now?: () => number },
): Promise<{ understanding: AoiTurnUnderstanding | null; error: string | null }> {
  const records = corpusTurnsToRecords(testCase.turns);
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: buildAoiTurnUnderstandingMessages({
        text: testCase.text,
        recentTurnsBlock: buildAoiRecentTurnsPromptBlock(records, { now: startedAt }),
        records,
      }),
      tools: [getAoiTurnUnderstandingToolDefinition()],
      tool_choice: 'auto',
      max_tokens: 2048,
    };
    // Mirror the runtime's wire mapping so the report measures what a real turn
    // sends: OpenRouter takes `reasoning` (enabled:false for 'none', effort
    // otherwise), DeepSeek takes its `thinking` block, and every other
    // OpenAI-compatible endpoint receives no reasoning field at all -- unknown
    // fields are a 400 there, which would score as fallback.
    if (config.provider === 'openrouter') {
      if (config.reasoningEffort === 'none') {
        body.reasoning = { enabled: false };
      } else if (config.reasoningEffort) {
        body.reasoning = { effort: config.reasoningEffort };
      }
    } else if (isDeepSeekProvider(config.provider as LLMProvider)) {
      applyDeepSeekChatRuntimeOptions(body, {
        provider: 'deepseek',
        reasoningEffort: config.reasoningEffort as LLMConfig['reasoningEffort'],
      });
    }
    if (!config.reasoningEffort || config.reasoningEffort === 'none') {
      body.temperature = 0;
    }
    let response: Response | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      response = await deps.fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Rate limits and upstream hiccups are retried with a short backoff so the
      // report measures the classifier, not the provider's mood that minute.
      if (!RETRYABLE_STATUS.has(response.status) || attempt === RETRY_DELAYS_MS.length) {
        break;
      }
      // The backoff must not outlive the call's own deadline: an abort during the
      // wait ends it at once instead of sleeping on and then failing the fetch.
      await new Promise<void>((resolveDelay) => {
        const delayTimer = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort);
          resolveDelay();
        }, RETRY_DELAYS_MS[attempt]);
        function onAbort(): void {
          clearTimeout(delayTimer);
          resolveDelay();
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      if (controller.signal.aborted) {
        return { understanding: null, error: 'timeout' };
      }
    }
    if (!response) {
      return { understanding: null, error: 'no response' };
    }
    if (!response.ok) {
      return { understanding: null, error: `HTTP ${response.status}` };
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { tool_calls?: OpenAiToolCallShape[] } }>;
    };
    const call = (json.choices?.[0]?.message?.tool_calls ?? []).find(
      (entry) => entry.function?.name === AOI_TURN_UNDERSTANDING_TOOL_NAME,
    );
    if (!call?.function?.arguments) {
      return { understanding: null, error: 'no tool call' };
    }
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return { understanding: null, error: 'unparseable arguments' };
    }
    const understanding = parseAoiTurnUnderstandingToolCall(args, {
      text: testCase.text,
      records,
    });
    if (!understanding) {
      return { understanding: null, error: 'failed validation' };
    }
    return {
      understanding: { ...understanding, latencyMs: Math.max(0, now() - startedAt) },
      error: null,
    };
  } catch (error) {
    return {
      understanding: null,
      error: controller.signal.aborted ? 'timeout' : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The reading the live turn would act on: the classifier's kind and families,
 * and the route the runtime would take with the regex floor applied. A null
 * reading falls back to the regex prediction, exactly as the live path does.
 */
export function toLivePrediction(
  testCase: AoiTurnCorpusCase,
  understanding: AoiTurnUnderstanding | null,
): AoiTurnEvalPrediction {
  const regex = predictAoiTurnWithRegex(testCase);
  if (!understanding) {
    return { ...regex, source: 'none' };
  }
  const history = corpusTurnsToHistory(testCase.turns);
  const records = corpusTurnsToRecords(testCase.turns);
  const decision = resolveAoiTurnRoute({
    hasAttachments: false,
    outcomeFeedbackContract: false,
    dialogAvailable: true,
    regexDialog: shouldUseDialogModel(testCase.text, history),
    understanding,
    escalation: null,
  });
  let refersToTurn: number | null = null;
  if (understanding.refersToTurn !== null) {
    const index = records.findIndex((record) => record.turnIndex === understanding.refersToTurn);
    refersToTurn = index >= 0 ? records.length - index : null;
  }
  return {
    kind: understanding.kind,
    families: understanding.families,
    route: decision.route,
    refersToTurn,
    ...(typeof understanding.latencyMs === 'number' ? { latencyMs: understanding.latencyMs } : {}),
    source: 'classifier',
    musicReference: understanding.musicReference,
    musicTarget: understanding.musicTarget,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function selectAoiTurnEvalCases(
  corpus: readonly AoiTurnCorpusCase[],
  options: { tag: string | null; limit: number | null },
): AoiTurnCorpusCase[] {
  let cases = options.tag
    ? corpus.filter((entry) => entry.tags.includes(options.tag as string))
    : [...corpus];
  if (options.limit !== null) {
    cases = cases.slice(0, options.limit);
  }
  return cases;
}

export async function runAoiTurnUnderstandingEval(
  options: AoiTurnEvalCliOptions,
  deps: Pick<AoiTurnEvalCliDeps, 'fetchImpl' | 'corpus'>,
): Promise<AoiTurnEvalCliReport> {
  const cases = selectAoiTurnEvalCases(deps.corpus ?? AOI_TURN_UNDERSTANDING_CORPUS, options);
  if (cases.length === 0) {
    throw new Error('No corpus cases matched the filter.');
  }
  const regex = await evaluateAoiTurnUnderstanding(cases, predictAoiTurnWithRegex);
  if (options.regexOnly) {
    return {
      version: 1,
      mode: 'regex',
      model: null,
      reasoningEffort: null,
      reasoningSent: null,
      regex,
      live: null,
      liveErrors: 0,
      liveErrorReasons: {},
      liveLatency: null,
      liveConfidence: {},
      liveCases: [],
    };
  }
  const fileConfig = readAoiTurnEvalLiveConfig(options.configFile);
  const config: AoiTurnEvalLiveConfig =
    options.reasoningEffort === 'default'
      ? fileConfig
      : { ...fileConfig, reasoningEffort: options.reasoningEffort };
  const results = await mapWithConcurrency(cases, options.concurrency, (testCase) =>
    classifyAoiTurnCaseLive(testCase, config, {
      fetchImpl: deps.fetchImpl,
      timeoutMs: options.timeoutMs,
    }),
  );
  const liveErrorReasons: Record<string, number> = {};
  const liveConfidence: Record<string, number> = {};
  const liveCases: AoiTurnEvalLiveCase[] = [];
  const latencies: number[] = [];
  results.forEach((result, index) => {
    if (result.error) {
      liveErrorReasons[result.error] = (liveErrorReasons[result.error] ?? 0) + 1;
    }
    const confidence = result.understanding?.confidence ?? null;
    if (confidence) {
      liveConfidence[confidence] = (liveConfidence[confidence] ?? 0) + 1;
    }
    const latencyMs =
      typeof result.understanding?.latencyMs === 'number' ? result.understanding.latencyMs : null;
    if (latencyMs !== null) {
      latencies.push(latencyMs);
    }
    liveCases.push({ id: cases[index].id, confidence, latencyMs, error: result.error });
  });
  const byId = new Map(cases.map((testCase, index) => [testCase.id, results[index].understanding]));
  const live = await evaluateAoiTurnUnderstanding(cases, (testCase) =>
    toLivePrediction(testCase, byId.get(testCase.id) ?? null),
  );
  return {
    version: 1,
    mode: 'live',
    model: config.model,
    reasoningEffort: config.reasoningEffort ?? null,
    reasoningSent: config.reasoningEffort
      ? config.provider === 'openrouter' || isDeepSeekProvider(config.provider as LLMProvider)
      : null,
    regex,
    live,
    liveErrors: Object.values(liveErrorReasons).reduce((sum, count) => sum + count, 0),
    liveErrorReasons,
    liveLatency: summarizeLatency(latencies, DEFAULT_AOI_TURN_CLASSIFIER_TIMEOUT_MS),
    liveConfidence,
    liveCases,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function summarizeLatency(
  latencies: readonly number[],
  budgetMs: number,
): AoiTurnEvalLatency | null {
  if (latencies.length === 0) {
    return null;
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
    budgetMs,
    overBudget: sorted.filter((value) => value > budgetMs).length,
  };
}

export function formatAoiTurnEvalLiveDetails(report: AoiTurnEvalCliReport): string {
  const lines: string[] = [];
  lines.push(
    `  reasoning effort: ${report.reasoningEffort ?? 'provider default'}${
      report.reasoningSent === false
        ? ` (not sent: ${report.model ?? 'this'} provider has no reasoning field)`
        : ''
    }`,
  );
  const reasons = Object.entries(report.liveErrorReasons)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${reason} x${count}`)
    .join(', ');
  lines.push(`  fell back: ${report.liveErrors}${reasons ? ` (${reasons})` : ''}`);
  const confidence = Object.entries(report.liveConfidence)
    .sort((left, right) => right[1] - left[1])
    .map(([level, count]) => `${level} ${count}`)
    .join(', ');
  if (confidence) {
    lines.push(`  confidence: ${confidence}`);
  }
  if (report.liveLatency) {
    const latency = report.liveLatency;
    lines.push(
      `  latency: p50 ${latency.p50} ms, p90 ${latency.p90} ms, max ${latency.max} ms; ${latency.overBudget}/${latency.count} over the ${latency.budgetMs} ms runtime budget`,
    );
  }
  return lines.join('\n');
}

export async function runAoiTurnUnderstandingEvalCli(deps: AoiTurnEvalCliDeps): Promise<number> {
  let options: AoiTurnEvalCliOptions;
  try {
    options = parseAoiTurnEvalCliOptions(deps.argv, deps.env);
  } catch (error) {
    deps.logError(`[aoi-turn-eval] ${error instanceof Error ? error.message : String(error)}`);
    return AOI_TURN_EVAL_EXIT_INPUT;
  }
  try {
    const report = await runAoiTurnUnderstandingEval(options, deps);
    if (options.json) {
      deps.log(JSON.stringify(report, null, 2));
    } else {
      deps.log(formatAoiTurnEvalReport(report.regex, 'regex baseline'));
      if (report.live) {
        deps.log('');
        deps.log(
          formatAoiTurnEvalReport(
            report.live,
            `live classifier ${report.model ?? ''} (regex floor applied; ${report.liveErrors} calls fell back)`,
          ),
        );
        deps.log(formatAoiTurnEvalLiveDetails(report));
      }
    }
    return AOI_TURN_EVAL_EXIT_OK;
  } catch (error) {
    deps.logError(`[aoi-turn-eval] ${error instanceof Error ? error.message : String(error)}`);
    return AOI_TURN_EVAL_EXIT_ERROR;
  }
}
