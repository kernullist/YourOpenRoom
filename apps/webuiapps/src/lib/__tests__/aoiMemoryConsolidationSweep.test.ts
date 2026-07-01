import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveAoiMemoryConsolidationConfigFromEnv,
  runAoiMemoryConsolidationSweepCycle,
} from '../aoiMemoryConsolidationSweep';
import {
  loadServerAoiMemories,
  saveServerAoiMemoryCandidates,
  saveServerAoiMemoryCandidatesWithEmbedding,
} from '../aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from '../aoiMemoryEmbedding';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-consolidation-sweep-'));
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

const fakeProvider = (
  vector: number[] = [1, 0, 0],
  model = 'consolidation-embed-model',
): AoiEmbeddingProvider => ({
  model,
  async embed(texts: string[]) {
    return texts.map(() => vector);
  },
});

async function seedEmbeddedPair(root: string): Promise<void> {
  // Two distinct-content facts that share a vector: not exact-dedup merged, but
  // near-duplicates for the cosine cluster.
  await saveServerAoiMemoryCandidatesWithEmbedding(
    root,
    'aoi/default',
    [{ scope: 'user', type: 'fact', content: 'Aoi tuned telemetry alpha', importance: 0.7 }],
    'ep-a',
    fakeProvider(),
  );
  await saveServerAoiMemoryCandidatesWithEmbedding(
    root,
    'aoi/default',
    [{ scope: 'user', type: 'fact', content: 'Aoi tuned telemetry beta', importance: 0.9 }],
    'ep-b',
    fakeProvider(),
  );
}

describe('resolveAoiMemoryConsolidationConfigFromEnv', () => {
  it('is OFF by default with the guard-rail max', () => {
    expect(resolveAoiMemoryConsolidationConfigFromEnv({})).toEqual({ enabled: false, max: 8 });
  });

  it('parses the opt-in flag and the numeric max override', () => {
    expect(
      resolveAoiMemoryConsolidationConfigFromEnv({
        AOI_AUTONOMY_CONSOLIDATION: '1',
        AOI_AUTONOMY_CONSOLIDATION_MAX: '3',
      }),
    ).toEqual({ enabled: true, max: 3 });
  });

  it('falls back to the default max for non-positive / non-numeric overrides', () => {
    expect(
      resolveAoiMemoryConsolidationConfigFromEnv({
        AOI_AUTONOMY_CONSOLIDATION: 'yes',
        AOI_AUTONOMY_CONSOLIDATION_MAX: '0',
      }),
    ).toEqual({ enabled: true, max: 8 });
    expect(
      resolveAoiMemoryConsolidationConfigFromEnv({
        AOI_AUTONOMY_CONSOLIDATION: 'true',
        AOI_AUTONOMY_CONSOLIDATION_MAX: 'abc',
      }),
    ).toEqual({ enabled: true, max: 8 });
  });
});

describe('runAoiMemoryConsolidationSweepCycle', () => {
  it('collapses near-duplicate embedded memories and reports the counts', async () => {
    const root = makeRoot();
    await seedEmbeddedPair(root);

    const result = runAoiMemoryConsolidationSweepCycle({ sessionsDir: root, now: 9000 });

    expect(result).toEqual({ ran: true, clusterCount: 1, supersededCount: 1 });
    const after = loadServerAoiMemories(root);
    expect(after).toHaveLength(2); // superseded file kept on disk
    expect(after.filter((memory) => memory.status === 'active')).toHaveLength(1);
    expect(after.filter((memory) => memory.status === 'superseded')).toHaveLength(1);
  });

  it('is a no-op (ran, zero clusters) when memories carry no vectors', () => {
    const root = makeRoot();
    saveServerAoiMemoryCandidates(
      root,
      'aoi/default',
      [
        { scope: 'user', type: 'fact', content: 'plain a', importance: 0.7 },
        { scope: 'user', type: 'fact', content: 'plain a restated', importance: 0.9 },
      ],
      'ep-none',
    );

    const result = runAoiMemoryConsolidationSweepCycle({ sessionsDir: root });

    expect(result).toEqual({ ran: true, clusterCount: 0, supersededCount: 0 });
    expect(loadServerAoiMemories(root).every((memory) => memory.status === 'active')).toBe(true);
  });

  it('honors the max clusters bound passed through the cycle', async () => {
    const root = makeRoot();
    await seedEmbeddedPair(root);
    // A second near-duplicate pair in a different bucket (project scope).
    await saveServerAoiMemoryCandidatesWithEmbedding(
      root,
      'aoi/default',
      [{ scope: 'project', type: 'fact', content: 'proj note one', importance: 0.6 }],
      'ep-c',
      fakeProvider(),
    );
    await saveServerAoiMemoryCandidatesWithEmbedding(
      root,
      'aoi/default',
      [{ scope: 'project', type: 'fact', content: 'proj note two', importance: 0.8 }],
      'ep-d',
      fakeProvider(),
    );

    const result = runAoiMemoryConsolidationSweepCycle({ sessionsDir: root, max: 1, now: 9000 });

    expect(result.clusterCount).toBe(1); // capped to one cluster this pass
    expect(result.supersededCount).toBe(1);
  });
});
