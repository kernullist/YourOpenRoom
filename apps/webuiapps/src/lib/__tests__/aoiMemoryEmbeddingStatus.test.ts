import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAoiMemoryEmbeddingStatus,
  summarizeAoiMemoryEmbeddingStatus,
} from '../aoiMemoryEmbeddingStatus';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

function memory(partial: Partial<AoiMemoryEntry>): AoiMemoryEntry {
  return {
    version: 2,
    id: 'mem',
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: 'content',
    normalizedContent: 'content',
    importance: 0.7,
    confidence: 0.8,
    hits: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceEpisodeIds: ['ep-1'],
    tags: [],
    entities: [],
    ...partial,
  } as AoiMemoryEntry;
}

describe('summarizeAoiMemoryEmbeddingStatus (P4.4)', () => {
  it('counts active embedded vs pending and reports the provider', () => {
    const status = summarizeAoiMemoryEmbeddingStatus(
      [
        memory({ id: 'a', embedding: [0.1, 0.2] }),
        memory({ id: 'b' }), // active, no vector -> pending
        memory({ id: 'c', embedding: [] }), // empty vector -> pending
        memory({ id: 'd', status: 'archived', embedding: [0.3] }), // archived -> ignored
      ],
      { model: 'text-embedding-3-small' },
    );
    expect(status).toEqual({
      providerConfigured: true,
      providerModel: 'text-embedding-3-small',
      activeCount: 3,
      embeddedCount: 1,
      pendingCount: 2,
    });
  });

  it('reports a keyless store as fully pending with no provider', () => {
    const status = summarizeAoiMemoryEmbeddingStatus(
      [memory({ id: 'a' }), memory({ id: 'b' })],
      null,
    );
    expect(status).toEqual({
      providerConfigured: false,
      providerModel: null,
      activeCount: 2,
      embeddedCount: 0,
      pendingCount: 2,
    });
  });

  it('handles an empty store', () => {
    expect(summarizeAoiMemoryEmbeddingStatus([], null)).toEqual({
      providerConfigured: false,
      providerModel: null,
      activeCount: 0,
      embeddedCount: 0,
      pendingCount: 0,
    });
  });
});

describe('loadAoiMemoryEmbeddingStatus (P4.4)', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'aoi-embed-status-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function seed(memories: AoiMemoryEntry[]): void {
    const dir = join(sessionsDir, 'aoi', 'memory-v2', 'memories');
    mkdirSync(dir, { recursive: true });
    for (const entry of memories) {
      writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry), 'utf8');
    }
  }

  it('loads the real store and honors an injected provider', () => {
    seed([memory({ id: 'a', embedding: [0.1] }), memory({ id: 'b' })]);
    const status = loadAoiMemoryEmbeddingStatus(sessionsDir, {
      provider: { model: 'local-test', embed: async () => [] },
    });
    expect(status.providerConfigured).toBe(true);
    expect(status.providerModel).toBe('local-test');
    expect(status.activeCount).toBe(2);
    expect(status.embeddedCount).toBe(1);
    expect(status.pendingCount).toBe(1);
  });

  it('reports no provider when null is injected (keyless)', () => {
    seed([memory({ id: 'a' })]);
    const status = loadAoiMemoryEmbeddingStatus(sessionsDir, { provider: null });
    expect(status.providerConfigured).toBe(false);
    expect(status.pendingCount).toBe(1);
  });

  it('resolves the provider from env when none is injected (keyless env -> no provider)', () => {
    seed([memory({ id: 'a', embedding: [0.1] })]);
    // No provider injected + an env with no embedding key -> createServerAoiEmbeddingProvider
    // returns null, so the store is reported keyless. Exercises the env option branch.
    const status = loadAoiMemoryEmbeddingStatus(sessionsDir, { env: { HOME: sessionsDir } });
    expect(status.providerConfigured).toBe(false);
    expect(status.activeCount).toBe(1);
    expect(status.embeddedCount).toBe(1);
  });

  it('resolves the provider from a (missing) configFile when none is injected', () => {
    seed([memory({ id: 'a' })]);
    // A configFile that does not exist -> no key -> null provider (graceful). Exercises
    // the configFile option branch without an injected provider.
    const status = loadAoiMemoryEmbeddingStatus(sessionsDir, {
      configFile: join(sessionsDir, 'no-such-config.json'),
    });
    expect(status.providerConfigured).toBe(false);
    expect(status.pendingCount).toBe(1);
  });
});
