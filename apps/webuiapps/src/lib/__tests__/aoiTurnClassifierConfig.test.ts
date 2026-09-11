import { describe, expect, it } from 'vitest';
import type { LLMConfig } from '../llmModels';
import {
  isUsableTurnClassifierOverride,
  resolveTurnClassifierConfig,
} from '../aoiTurnClassifierConfig';

const MAIN: LLMConfig = {
  provider: 'deepseek',
  apiKey: 'sk-deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
};

const CLI_MAIN: LLMConfig = {
  provider: 'claude-cli',
  apiKey: '',
  baseUrl: '',
  model: 'claude-sonnet',
  command: 'claude',
};

describe('resolveTurnClassifierConfig', () => {
  it('follows the main model when nothing else is configured', () => {
    expect(resolveTurnClassifierConfig(MAIN, null, null)).toBe(MAIN);
    expect(resolveTurnClassifierConfig(MAIN, null, {})).toBe(MAIN);
    expect(resolveTurnClassifierConfig(MAIN, undefined, undefined)).toBe(MAIN);
  });

  it('runs on the explicit override when it is a complete API config', () => {
    const resolved = resolveTurnClassifierConfig(MAIN, null, {
      provider: 'openrouter',
      apiKey: 'sk-or-classifier',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3.7-flash',
    });
    expect(resolved).toMatchObject({
      provider: 'openrouter',
      apiKey: 'sk-or-classifier',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3.7-flash',
    });
    // Nothing of the main model's reasoning setting leaks across providers.
    expect(resolved?.reasoningEffort).toBeUndefined();
  });

  it('lets a same-provider override inherit the key and endpoint it left blank', () => {
    expect(resolveTurnClassifierConfig(MAIN, null, { model: 'deepseek-v4-pro' })).toMatchObject({
      provider: 'deepseek',
      apiKey: 'sk-deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    });
  });

  it('ignores an override that could not be called and falls back to the main model', () => {
    // A different provider with no key would 401 on every turn.
    expect(
      resolveTurnClassifierConfig(MAIN, null, {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen/qwen3.7-flash',
      }),
    ).toBe(MAIN);
    // No model, no endpoint.
    expect(resolveTurnClassifierConfig(MAIN, null, { provider: 'openrouter', apiKey: 'k' })).toBe(
      MAIN,
    );
    // A process provider cannot read within the budget.
    expect(
      resolveTurnClassifierConfig(MAIN, null, { provider: 'codex-cli', model: 'gpt-5-codex' }),
    ).toBe(MAIN);
  });

  it('allows a local server override without a key', () => {
    expect(
      resolveTurnClassifierConfig(MAIN, null, {
        provider: 'llama.cpp',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'qwen3-8b',
      }),
    ).toMatchObject({ provider: 'llama.cpp', model: 'qwen3-8b' });
  });

  it('keeps the dialog-model fallback for a CLI main model, and skips the call when none fits', () => {
    const dialog = {
      provider: 'openrouter' as const,
      apiKey: 'sk-or',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen3.7-flash',
    };
    expect(resolveTurnClassifierConfig(CLI_MAIN, dialog, null)).toMatchObject({
      provider: 'openrouter',
      model: 'qwen/qwen3.7-flash',
    });
    // The dialog fallback keeps its old contract: endpoint and model, key optional.
    expect(
      resolveTurnClassifierConfig(CLI_MAIN, { ...dialog, apiKey: undefined }, null),
    ).toMatchObject({ provider: 'openrouter' });
    expect(resolveTurnClassifierConfig(CLI_MAIN, null, null)).toBeNull();
    expect(
      resolveTurnClassifierConfig(CLI_MAIN, { provider: 'codex-cli', model: 'x' }, null),
    ).toBeNull();
    // An explicit override wins over the dialog fallback for a CLI main model too.
    expect(
      resolveTurnClassifierConfig(CLI_MAIN, dialog, {
        provider: 'deepseek',
        apiKey: 'sk-d',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      }),
    ).toMatchObject({ provider: 'deepseek' });
  });
});

describe('isUsableTurnClassifierOverride', () => {
  it('requires endpoint, model, an API provider, and a key unless local', () => {
    expect(isUsableTurnClassifierOverride(null)).toBe(false);
    expect(isUsableTurnClassifierOverride({ ...MAIN, baseUrl: ' ' })).toBe(false);
    expect(isUsableTurnClassifierOverride({ ...MAIN, model: '' })).toBe(false);
    expect(isUsableTurnClassifierOverride({ ...MAIN, apiKey: '  ' })).toBe(false);
    expect(isUsableTurnClassifierOverride({ ...MAIN, provider: 'codex-auth' })).toBe(false);
    expect(isUsableTurnClassifierOverride(MAIN)).toBe(true);
    expect(
      isUsableTurnClassifierOverride({
        provider: 'llama.cpp',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'local',
      }),
    ).toBe(true);
  });
});
