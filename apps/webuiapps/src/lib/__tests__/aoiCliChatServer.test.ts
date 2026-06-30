// @vitest-environment node
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAoiClaudeChatArgs,
  buildAoiCodexChatArgs,
  isAoiCodexModelUpgradeError,
  isAoiServerCliProvider,
  runAoiServerCliChat,
  type AoiCliSpawn,
} from '../aoiCliChatServer';
import type { LLMConfig } from '../llmModels';

// A fake `spawn` that drives runCliProcess without a real CLI. Each spawn call
// consumes the next behavior (last one repeats); for codex it can write the
// `--output-last-message` file so the output-file read path is exercised.
interface FakeCall {
  command: string;
  args: string[];
  input?: string;
}
interface FakeBehavior {
  outputFile?: string;
  stdout?: string;
  stderr?: string;
  closeCode?: number;
  error?: string;
  hang?: boolean;
}

function makeFakeSpawn(captured: { calls: FakeCall[] }, behaviors: FakeBehavior[]): AoiCliSpawn {
  const fn = (command: string, args: string[]) => {
    const callIndex = captured.calls.length;
    const record: FakeCall = { command, args };
    captured.calls.push(record);
    const behavior = behaviors[callIndex] ?? behaviors[behaviors.length - 1] ?? {};
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: (input: string) => void };
      kill: () => void;
    };
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (input: string) => {
        record.input = input;
      },
    };
    child.kill = () => {};
    queueMicrotask(() => {
      if (behavior.hang) {
        return;
      }
      if (behavior.error) {
        child.emit('error', new Error(behavior.error));
        return;
      }
      const outIndex = args.indexOf('--output-last-message');
      if (outIndex >= 0 && behavior.outputFile !== undefined) {
        fs.writeFileSync(args[outIndex + 1], behavior.outputFile);
      }
      if (behavior.stderr) {
        child.stderr.emit('data', Buffer.from(behavior.stderr));
      }
      if (behavior.stdout) {
        child.stdout.emit('data', Buffer.from(behavior.stdout));
      }
      child.emit('close', behavior.closeCode ?? 0);
    });
    return child;
  };
  return fn as unknown as AoiCliSpawn;
}

function makeConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return { provider: 'codex-auth', model: 'gpt-5.5', ...overrides } as LLMConfig;
}

describe('isAoiServerCliProvider()', () => {
  it('matches only CLI / managed-auth providers', () => {
    expect(isAoiServerCliProvider('codex-auth')).toBe(true);
    expect(isAoiServerCliProvider('codex-cli')).toBe(true);
    expect(isAoiServerCliProvider('claude-cli')).toBe(true);
    expect(isAoiServerCliProvider('openai')).toBe(false);
    expect(isAoiServerCliProvider('anthropic')).toBe(false);
    expect(isAoiServerCliProvider('openrouter')).toBe(false);
    expect(isAoiServerCliProvider(undefined)).toBe(false);
  });
});

describe('isAoiCodexModelUpgradeError()', () => {
  it('detects codex model-upgrade errors only', () => {
    expect(
      isAoiCodexModelUpgradeError(
        new Error('model gpt-6 is not supported when using Codex with a ChatGPT account'),
      ),
    ).toBe(true);
    expect(isAoiCodexModelUpgradeError(new Error('requires a newer version of Codex'))).toBe(true);
    expect(isAoiCodexModelUpgradeError(new Error('network timeout'))).toBe(false);
    expect(isAoiCodexModelUpgradeError('plain string')).toBe(false);
  });
});

describe('buildAoiClaudeChatArgs()', () => {
  it('builds the print/safe args, adds model and effort when set', () => {
    const args = buildAoiClaudeChatArgs('claude-x', makeConfig({ reasoningEffort: 'high' }));
    expect(args).toEqual(
      expect.arrayContaining(['--print', '--safe-mode', '--no-session-persistence']),
    );
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-x']));
    expect(args).toEqual(expect.arrayContaining(['--effort', 'high']));
  });

  it('omits the model flag when no model is given', () => {
    const args = buildAoiClaudeChatArgs('', makeConfig());
    expect(args).not.toContain('--model');
  });

  it('maps a minimal reasoning effort to the claude low effort', () => {
    const args = buildAoiClaudeChatArgs('claude-x', makeConfig({ reasoningEffort: 'minimal' }));
    expect(args).toEqual(expect.arrayContaining(['--effort', 'low']));
  });
});

describe('buildAoiCodexChatArgs()', () => {
  it('builds exec args with the cd root, output file, and model', () => {
    const args = buildAoiCodexChatArgs('gpt-5.5', makeConfig(), '/work/root', '/tmp/out.txt');
    expect(args.slice(0, 2)).toEqual(['exec', '--cd']);
    expect(args).toEqual(expect.arrayContaining(['--cd', '/work/root']));
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(args).toEqual(expect.arrayContaining(['--output-last-message', '/tmp/out.txt']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.5']));
    expect(args[args.length - 1]).toBe('-');
  });

  it('appends reasoning, verbosity, and service-tier as -c overrides', () => {
    const args = buildAoiCodexChatArgs(
      'gpt-5.5',
      makeConfig({
        reasoningEffort: 'high',
        reasoningSummary: 'detailed',
        verbosity: 'high',
        serviceTier: 'priority',
      }),
      '/r',
      '/o',
    ).join(' ');
    expect(args).toContain('model_reasoning_effort=');
    expect(args).toContain('model_reasoning_summary=');
    expect(args).toContain('model_verbosity=');
    expect(args).toContain('service_tier=');
  });
});

describe('runAoiServerCliChat()', () => {
  it('runs codex-auth via the codex command and returns the output-file content', async () => {
    const captured = { calls: [] as FakeCall[] };
    const spawnImpl = makeFakeSpawn(captured, [{ outputFile: 'CODEX REPLY' }]);
    const content = await runAoiServerCliChat(makeConfig(), 'PROMPT TEXT', {
      root: '/work/root',
      spawnImpl,
    });
    expect(content).toBe('CODEX REPLY');
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].command).toBe('codex');
    expect(captured.calls[0].args).toEqual(expect.arrayContaining(['--cd', '/work/root']));
    expect(captured.calls[0].input).toContain('USER:\nPROMPT TEXT');
    expect(captured.calls[0].input).toContain('Codex CLI model');
  });

  it('runs codex-cli via a configured command', async () => {
    const captured = { calls: [] as FakeCall[] };
    const spawnImpl = makeFakeSpawn(captured, [{ outputFile: 'OK' }]);
    await runAoiServerCliChat(makeConfig({ provider: 'codex-cli', command: 'my-codex' }), 'P', {
      root: '/r',
      spawnImpl,
    });
    expect(captured.calls[0].command).toBe('my-codex');
  });

  it('defaults codex-cli to the codex command when none is configured', async () => {
    const captured = { calls: [] as FakeCall[] };
    await runAoiServerCliChat(makeConfig({ provider: 'codex-cli' }), 'P', {
      root: '/r',
      spawnImpl: makeFakeSpawn(captured, [{ outputFile: 'OK' }]),
    });
    expect(captured.calls[0].command).toBe('codex');
  });

  it('runs claude-cli via the claude command and returns stdout', async () => {
    const captured = { calls: [] as FakeCall[] };
    const spawnImpl = makeFakeSpawn(captured, [{ stdout: 'CLAUDE REPLY' }]);
    const content = await runAoiServerCliChat(
      makeConfig({ provider: 'claude-cli', model: 'claude-x' }),
      'P',
      {
        root: '/r',
        spawnImpl,
      },
    );
    expect(content).toBe('CLAUDE REPLY');
    expect(captured.calls[0].command).toBe('claude');
    expect(captured.calls[0].args).toContain('--print');
    expect(captured.calls[0].input).toContain('Claude CLI model');
  });

  it('retries codex with the fallback model on a model-upgrade error', async () => {
    const captured = { calls: [] as FakeCall[] };
    const spawnImpl = makeFakeSpawn(captured, [
      {
        closeCode: 1,
        stderr: 'model gpt-6 is not supported when using Codex with a ChatGPT account',
      },
      { outputFile: 'FALLBACK REPLY' },
    ]);
    const content = await runAoiServerCliChat(makeConfig({ model: 'gpt-6' }), 'P', {
      root: '/r',
      spawnImpl,
    });
    expect(content).toBe('FALLBACK REPLY');
    expect(captured.calls).toHaveLength(2);
    // First attempt used the requested model; the retry swapped in the fallback.
    expect(captured.calls[0].args).toEqual(expect.arrayContaining(['--model', 'gpt-6']));
    expect(captured.calls[1].args).toEqual(expect.arrayContaining(['--model', 'gpt-5.5']));
    expect(captured.calls[1].args).not.toContain('gpt-6');
  });

  it('throws a non-upgrade error without retrying', async () => {
    const captured = { calls: [] as FakeCall[] };
    const spawnImpl = makeFakeSpawn(captured, [{ closeCode: 1, stderr: 'disk full' }]);
    await expect(
      runAoiServerCliChat(makeConfig({ model: 'gpt-6' }), 'P', { root: '/r', spawnImpl }),
    ).rejects.toThrow('disk full');
    expect(captured.calls).toHaveLength(1);
  });

  it('rejects with an abort error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const captured = { calls: [] as FakeCall[] };
    await expect(
      runAoiServerCliChat(makeConfig({ provider: 'claude-cli' }), 'P', {
        root: '/r',
        signal: controller.signal,
        spawnImpl: makeFakeSpawn(captured, [{ stdout: 'unused' }]),
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('rejects when the child process emits an error', async () => {
    const captured = { calls: [] as FakeCall[] };
    const spawnImpl = makeFakeSpawn(captured, [{ error: 'spawn ENOENT' }]);
    await expect(
      runAoiServerCliChat(makeConfig({ provider: 'claude-cli' }), 'P', { root: '/r', spawnImpl }),
    ).rejects.toThrow('spawn ENOENT');
  });

  it('clears the abort listener when a process with a signal succeeds', async () => {
    const controller = new AbortController();
    const captured = { calls: [] as FakeCall[] };
    const content = await runAoiServerCliChat(makeConfig({ provider: 'claude-cli' }), 'P', {
      root: '/r',
      signal: controller.signal,
      spawnImpl: makeFakeSpawn(captured, [{ stdout: 'DONE' }]),
    });
    expect(content).toBe('DONE');
  });

  it('times out a hung process', async () => {
    vi.useFakeTimers();
    try {
      const captured = { calls: [] as FakeCall[] };
      const promise = runAoiServerCliChat(makeConfig({ provider: 'claude-cli' }), 'P', {
        root: '/r',
        spawnImpl: makeFakeSpawn(captured, [{ hang: true }]),
      });
      const assertion = expect(promise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(180_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
