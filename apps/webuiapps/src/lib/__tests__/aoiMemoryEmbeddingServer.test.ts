import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createServerAoiEmbeddingProvider } from '../aoiMemoryEmbeddingServer';
import {
  embedAndPersistServerAoiMemories,
  loadServerAoiMemories,
  saveServerAoiMemoryCandidates,
} from '../aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from '../aoiMemoryEmbedding';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-mem-embed-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('createServerAoiEmbeddingProvider', () => {
  it('returns null when no config file and no env key are present', () => {
    expect(createServerAoiEmbeddingProvider({ env: {} })).toBeNull();
  });

  it('resolves a provider from an env key (Gemini / OpenRouter / OpenAI)', () => {
    expect(createServerAoiEmbeddingProvider({ env: { GEMINI_API_KEY: 'k' } })).not.toBeNull();
    expect(createServerAoiEmbeddingProvider({ env: { OPENROUTER_API_KEY: 'k' } })).not.toBeNull();
    expect(createServerAoiEmbeddingProvider({ env: { OPENAI_API_KEY: 'k' } })).not.toBeNull();
  });

  it('prefers the config file aoiEmbedding block over env', () => {
    const root = makeRoot();
    const configFile = join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ aoiEmbedding: { apiKey: 'file-key' } }), 'utf-8');
    expect(createServerAoiEmbeddingProvider({ configFile, env: {} })).not.toBeNull();
  });

  it('returns null for a config file without an embedding key', () => {
    const root = makeRoot();
    const configFile = join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ llm: { provider: 'openrouter' } }), 'utf-8');
    expect(createServerAoiEmbeddingProvider({ configFile, env: {} })).toBeNull();
  });
});

describe('embedAndPersistServerAoiMemories', () => {
  const fakeProvider = (
    vector: number[] = [0.1, 0.2, 0.3],
    model = 'test-embed-model',
  ): AoiEmbeddingProvider => ({
    model,
    async embed(texts: string[]) {
      return texts.map(() => vector);
    },
  });

  function seedMemory(root: string): void {
    saveServerAoiMemoryCandidates(
      root,
      'aoi/default',
      [{ scope: 'user', type: 'fact', content: 'The user prefers Korean responses.' }],
      'episode-1',
    );
  }

  it('embeds active memories that lack a vector and rewrites them', async () => {
    const root = makeRoot();
    seedMemory(root);

    const result = await embedAndPersistServerAoiMemories(root, fakeProvider());
    expect(result.embeddedCount).toBe(1);
    expect(loadServerAoiMemories(root)[0].embedding).toEqual([0.1, 0.2, 0.3]);
    // The provider's model id is stamped alongside the vector for recall guarding.
    expect(loadServerAoiMemories(root)[0].embeddingModel).toBe('test-embed-model');
  });

  it('is idempotent -- an already-embedded memory is skipped on the next pass', async () => {
    const root = makeRoot();
    seedMemory(root);
    await embedAndPersistServerAoiMemories(root, fakeProvider());

    const second = await embedAndPersistServerAoiMemories(root, fakeProvider([9, 9, 9]));
    expect(second.embeddedCount).toBe(0);
    // The original vector is preserved (not re-embedded).
    expect(loadServerAoiMemories(root)[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('skips a memory when the provider returns an empty vector (best-effort)', async () => {
    const root = makeRoot();
    seedMemory(root);

    const result = await embedAndPersistServerAoiMemories(root, fakeProvider([]));
    expect(result.embeddedCount).toBe(0);
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
  });

  it('does not throw when the provider rejects', async () => {
    const root = makeRoot();
    seedMemory(root);
    const throwingProvider: AoiEmbeddingProvider = {
      model: 'test-embed-model',
      async embed() {
        throw new Error('embedding backend down');
      },
    };

    const result = await embedAndPersistServerAoiMemories(root, throwingProvider);
    expect(result.embeddedCount).toBe(0);
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
  });
});
