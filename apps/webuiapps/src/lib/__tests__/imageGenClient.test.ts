/**
 * Unit tests for imageGenClient.ts — config loading/saving
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadImageGenConfig,
  loadImageGenConfigSync,
  saveImageGenConfig,
  getDefaultImageGenConfig,
  type ImageGenConfig,
} from '../imageGenClient';

const CONFIG_KEY = 'webuiapps-imagegen-config';

const MOCK_IG_CONFIG: ImageGenConfig = {
  provider: 'openai',
  apiKey: 'sk-img-test',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-image-1.5',
};

const MOCK_LLM_CONFIG = {
  provider: 'openai',
  apiKey: 'sk-llm',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4',
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getDefaultImageGenConfig()', () => {
  it('returns correct defaults for openai', () => {
    const cfg = getDefaultImageGenConfig('openai');
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-image-1.5');
  });

  it('returns correct defaults for gemini', () => {
    const cfg = getDefaultImageGenConfig('gemini');
    expect(cfg.provider).toBe('gemini');
    expect(cfg.baseUrl).toBe('https://generativelanguage.googleapis.com');
  });
});

describe('loadImageGenConfigSync()', () => {
  it('returns null when localStorage is empty', () => {
    expect(loadImageGenConfigSync()).toBeNull();
  });

  it('returns parsed config from localStorage', () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_IG_CONFIG));
    expect(loadImageGenConfigSync()).toEqual(MOCK_IG_CONFIG);
  });

  it('returns null on invalid JSON', () => {
    localStorage.setItem(CONFIG_KEY, 'bad-json');
    expect(loadImageGenConfigSync()).toBeNull();
  });
});

describe('loadImageGenConfig()', () => {
  it('loads imageGen from file API (new format) and syncs to localStorage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ llm: MOCK_LLM_CONFIG, imageGen: MOCK_IG_CONFIG }),
    } as unknown as Response);

    const result = await loadImageGenConfig();

    expect(result).toEqual(MOCK_IG_CONFIG);
    expect(localStorage.getItem(CONFIG_KEY)).toBe(JSON.stringify(MOCK_IG_CONFIG));
  });

  it('returns null from file API when imageGen is absent (LLM-only config)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ llm: MOCK_LLM_CONFIG }),
    } as unknown as Response);

    const result = await loadImageGenConfig();

    // No imageGen in file → falls through to localStorage
    expect(result).toBeNull();
  });

  it('falls back to localStorage when API is unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_IG_CONFIG));

    const result = await loadImageGenConfig();

    expect(result).toEqual(MOCK_IG_CONFIG);
  });

  it('returns null when both API and localStorage have nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    expect(await loadImageGenConfig()).toBeNull();
  });

  it('handles legacy flat LLMConfig file (no imageGen) gracefully', async () => {
    // Legacy file has flat LLMConfig → no imageGen field
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_LLM_CONFIG),
    } as unknown as Response);

    const result = await loadImageGenConfig();

    // Legacy format has no imageGen → should fall through to localStorage
    expect(result).toBeNull();
  });
});

describe('saveImageGenConfig()', () => {
  it('writes to localStorage', () => {
    saveImageGenConfig(MOCK_IG_CONFIG);
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toEqual(MOCK_IG_CONFIG);
  });
});

describe('saveImageGenConfig(null)', () => {
  it('removes a cleared config so a removed key does not come back', async () => {
    const { saveImageGenConfig, loadImageGenConfigSync } = await import('../imageGenClient');
    saveImageGenConfig({ provider: 'openai', apiKey: 'sk-old', model: 'x', baseUrl: '' } as never);
    expect(loadImageGenConfigSync()).not.toBeNull();
    saveImageGenConfig(null);
    expect(loadImageGenConfigSync()).toBeNull();
  });
});
