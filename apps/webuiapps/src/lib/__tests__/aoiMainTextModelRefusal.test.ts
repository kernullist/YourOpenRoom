import { afterEach, describe, expect, it, vi } from 'vitest';

import { callAoiMainTextModel } from '../dewdropCanvasPlugin';
import type { LLMConfig } from '../llmModels';

// The server-side Anthropic caller behind the autonomy loop's reflection, brief
// and goal synthesis. It is a separate body builder from llmClient's
// chatAnthropic, so the refusal handling has to be asserted separately -- a
// declined request here used to read as '' and degrade to deterministic
// synthesis with no reason recorded anywhere.
const ANTHROPIC_CONFIG: LLMConfig = {
  provider: 'anthropic',
  apiKey: 'ant-test-key',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-opus-5',
};

const SERVER_ORIGIN = 'http://127.0.0.1:3000';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function anthropicResponse(payload: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function mockFetchOnce(payload: Record<string, unknown>): void {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(anthropicResponse(payload)) as unknown as typeof fetch;
}

describe('callAoiMainTextModel (server-side Anthropic caller)', () => {
  it('surfaces a refusal instead of returning empty synthesis text', async () => {
    mockFetchOnce({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' },
    });

    await expect(
      callAoiMainTextModel(ANTHROPIC_CONFIG, SERVER_ORIGIN, 'summarize the week', 500),
    ).rejects.toThrow(/declined this request \(cyber\)/i);
  });

  it('reports an unspecified category when stop_details is absent', async () => {
    mockFetchOnce({ content: [], stop_reason: 'refusal' });

    await expect(
      callAoiMainTextModel(ANTHROPIC_CONFIG, SERVER_ORIGIN, 'summarize the week', 500),
    ).rejects.toThrow(/\(unspecified\)/);
  });

  it('still returns the text blocks on a normal completion', async () => {
    mockFetchOnce({
      content: [
        { type: 'text', text: 'first ' },
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'second' },
      ],
      stop_reason: 'end_turn',
    });

    await expect(
      callAoiMainTextModel(ANTHROPIC_CONFIG, SERVER_ORIGIN, 'summarize the week', 500),
    ).resolves.toBe('first second');
  });
});
