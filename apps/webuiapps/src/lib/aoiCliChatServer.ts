// Server-only: in-process CLI chat for the autonomy loop (B1, "B-self").
//
// The autonomy reflection's CLI / managed-auth providers (codex-auth, codex-cli,
// claude-cli) reach the model in dev by POSTing to the Vite-only
// `/api/codex-auth-chat` (etc.) middleware. Under the standalone daemon those
// endpoints do not exist, so the reflection silently fell back to deterministic.
// The daemon is itself a Node process, so it can spawn the CLI DIRECTLY -- the
// HTTP endpoints are fundamentally a browser bridge. This module reproduces the
// dev endpoints' CLI invocation in-process so the autonomy loop reaches the model
// headless. It is SELF-CONTAINED on purpose: it does NOT touch vite.config.ts, so
// the browser chat path is unchanged (runCliProcess there is shared by ~9 dev
// endpoints; extracting it would refactor an untested config).
//
// SERVER-ONLY: imports child_process / fs / os. Never import this from
// client-reachable code -- it must not enter the browser bundle.
import { spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  normalizeReasoningEffort,
  normalizeReasoningSummary,
  normalizeServiceTier,
  normalizeVerbosity,
  type LLMConfig,
  type LLMProvider,
} from './llmModels';

const AOI_CLI_CHAT_TIMEOUT_MS = 180_000;
const AOI_CODEX_CLI_FALLBACK_MODEL = 'gpt-5.5';
// The autonomy reflection never exposes tools (the reflection chat ignores its
// tools arg), so the tool-bridge line is always the toolless variant the dev
// endpoint emits for an empty tool list.
const AOI_CLI_TOOLLESS_BRIDGE =
  'No OpenRoom tools are exposed for this turn. Reply directly in plain text.';

export type AoiCliSpawn = typeof nodeSpawn;

// codex-auth (managed-auth) + codex-cli / claude-cli (CLI). baseUrl providers
// (OpenAI / OpenRouter / Anthropic) reach their absolute endpoint directly and so
// already work under the daemon -- they are NOT handled here.
export function isAoiServerCliProvider(provider: LLMProvider | undefined): boolean {
  return provider === 'codex-auth' || provider === 'codex-cli' || provider === 'claude-cli';
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function terminateCliProcessTree(child: ReturnType<AoiCliSpawn>, spawnImpl: AoiCliSpawn): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
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

interface AoiCliRunOptions {
  cwd: string;
  signal?: AbortSignal;
  spawnImpl?: AoiCliSpawn;
}

function runCliProcess(
  command: string,
  args: string[],
  input: string,
  label: string,
  options: AoiCliRunOptions,
): Promise<string> {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: (() => void) | null = null;
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
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
    const clearAbortListener = () => {
      if (removeAbortListener) {
        removeAbortListener();
        removeAbortListener = null;
      }
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProcessTimeout();
      clearAbortListener();
      rejectPromise(error);
    };
    const succeed = (output: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProcessTimeout();
      clearAbortListener();
      resolvePromise(output.trim());
    };
    const abortProcess = () => {
      terminateCliProcessTree(child, spawnImpl);
      fail(createAbortError(`${label} cancelled.`));
    };

    if (options.signal?.aborted) {
      abortProcess();
      return;
    }
    if (options.signal) {
      options.signal.addEventListener('abort', abortProcess, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener('abort', abortProcess);
    }

    timeout = setTimeout(() => {
      terminateCliProcessTree(child, spawnImpl);
      fail(new Error(`${label} timed out.`));
    }, AOI_CLI_CHAT_TIMEOUT_MS);

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
      succeed(stdout);
    });
    child.stdin?.end(input);
  });
}

export function isAoiCodexModelUpgradeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /requires a newer version of Codex|model .* is not supported|not supported when using Codex with a ChatGPT account/i.test(
    message,
  );
}

function buildCodexConfigOverrideArg(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function appendCodexRuntimeArgs(args: string[], config: LLMConfig): void {
  const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
  const reasoningSummary = normalizeReasoningSummary(config.reasoningSummary);
  const verbosity = normalizeVerbosity(config.verbosity);
  const serviceTier = normalizeServiceTier(config.serviceTier);
  if (reasoningEffort) {
    args.push('-c', buildCodexConfigOverrideArg('model_reasoning_effort', reasoningEffort));
  }
  if (reasoningSummary) {
    args.push('-c', buildCodexConfigOverrideArg('model_reasoning_summary', reasoningSummary));
  }
  if (verbosity) {
    args.push('-c', buildCodexConfigOverrideArg('model_verbosity', verbosity));
  }
  if (serviceTier) {
    args.push('-c', buildCodexConfigOverrideArg('service_tier', serviceTier));
  }
}

function normalizeClaudeEffort(value: unknown): string | undefined {
  const reasoningEffort = normalizeReasoningEffort(value);
  if (!reasoningEffort || reasoningEffort === 'none') {
    return undefined;
  }
  if (reasoningEffort === 'minimal') {
    return 'low';
  }
  return reasoningEffort;
}

export function buildAoiClaudeChatArgs(model: string, config: LLMConfig): string[] {
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
  const effort = normalizeClaudeEffort(config.reasoningEffort);
  if (effort) {
    args.push('--effort', effort);
  }
  return args;
}

export function buildAoiCodexChatArgs(
  model: string,
  config: LLMConfig,
  root: string,
  outputFile: string,
): string[] {
  const args = [
    'exec',
    '--cd',
    root,
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--output-last-message',
    outputFile,
    '--color',
    'never',
  ];
  if (model) {
    args.push('--model', model);
  }
  appendCodexRuntimeArgs(args, config);
  args.push('-');
  return args;
}

// Wrap the flat reflection prompt as the dev endpoints render a single user
// message, so the in-process input is faithful to the browser path.
function buildCliChatInput(modelLabel: string, prompt: string): string {
  return [
    `You are running as the configured ${modelLabel} model for OpenRoom.`,
    AOI_CLI_TOOLLESS_BRIDGE,
    'Preserve the active character/system instructions from the conversation when they are present.',
    '',
    `USER:\n${prompt}`,
  ].join('\n');
}

export interface AoiServerCliChatOptions {
  // The CLI working directory + codex `--cd` root (the daemon's workspace root).
  root: string;
  signal?: AbortSignal;
  spawnImpl?: AoiCliSpawn;
}

async function runCodexChat(
  command: string,
  model: string,
  config: LLMConfig,
  prompt: string,
  options: AoiServerCliChatOptions,
): Promise<string> {
  const tempDir = fs.mkdtempSync(join(os.tmpdir(), 'openroom-aoi-codex-chat-'));
  const outputFile = join(tempDir, 'last-message.txt');
  const input = buildCliChatInput('Codex CLI', prompt);
  const runWith = async (args: string[]): Promise<string> => {
    const stdout = await runCliProcess(command, args, input, 'Codex CLI', {
      cwd: options.root,
      signal: options.signal,
      spawnImpl: options.spawnImpl,
    });
    if (fs.existsSync(outputFile)) {
      return fs.readFileSync(outputFile, 'utf-8').trim();
    }
    return stdout;
  };
  try {
    const args = buildAoiCodexChatArgs(model, config, options.root, outputFile);
    try {
      return await runWith(args);
    } catch (error) {
      if (model && model !== AOI_CODEX_CLI_FALLBACK_MODEL && isAoiCodexModelUpgradeError(error)) {
        const fallbackArgs = args.filter((arg, index) => {
          if (arg === '--model') {
            return false;
          }
          return args[index - 1] !== '--model';
        });
        fallbackArgs.splice(fallbackArgs.length - 1, 0, '--model', AOI_CODEX_CLI_FALLBACK_MODEL);
        return await runWith(fallbackArgs);
      }
      throw error;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runClaudeChat(
  command: string,
  model: string,
  config: LLMConfig,
  prompt: string,
  options: AoiServerCliChatOptions,
): Promise<string> {
  const args = buildAoiClaudeChatArgs(model, config);
  const input = buildCliChatInput('Claude CLI', prompt);
  return runCliProcess(command, args, input, 'Claude CLI', {
    cwd: options.root,
    signal: options.signal,
    spawnImpl: options.spawnImpl,
  });
}

// Run an in-process CLI chat for a CLI / managed-auth provider and return the
// model's text. Mirrors the dev endpoints' command selection, args, prompt
// wrapping, and the codex model-upgrade fallback. Callers MUST gate on
// isAoiServerCliProvider() first (baseUrl providers are not handled here).
export async function runAoiServerCliChat(
  config: LLMConfig,
  prompt: string,
  options: AoiServerCliChatOptions,
): Promise<string> {
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  if (config.provider === 'claude-cli') {
    const command = config.command?.trim() || 'claude';
    return runClaudeChat(command, model, config, prompt, options);
  }
  // codex-auth uses the fixed 'codex' command; codex-cli honors a configured one.
  const command = config.provider === 'codex-auth' ? 'codex' : config.command?.trim() || 'codex';
  return runCodexChat(command, model, config, prompt, options);
}
