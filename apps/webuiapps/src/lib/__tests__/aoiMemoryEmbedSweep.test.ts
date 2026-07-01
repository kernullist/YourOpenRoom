import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveAoiMemoryEmbedSweepConfigFromEnv,
  runAoiMemoryEmbedSweepCycle,
  startAoiMemoryEmbedSweep,
} from '../aoiMemoryEmbedSweep';
import { startAoiMemoryEmbedSweepFromEnv } from '../aoiAutonomyPlugin';
import { acquireAoiAutonomyLoopLock } from '../aoiAutonomyLoopLock';
import { loadServerAoiMemories, saveServerAoiMemoryCandidates } from '../aoiMemoryServerWriter';
import type { AoiEmbeddingProvider } from '../aoiMemoryEmbedding';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-embed-sweep-'));
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
  vector: number[] = [0.2, 0.3, 0.4],
  model = 'sweep-embed-model',
): AoiEmbeddingProvider => ({
  model,
  async embed(texts: string[]) {
    return texts.map(() => vector);
  },
});

function seedMemory(root: string, content = 'Server memory awaiting a vector.'): void {
  saveServerAoiMemoryCandidates(
    root,
    'aoi/default',
    [{ scope: 'user', type: 'fact', content }],
    'ep-sweep',
  );
}

describe('resolveAoiMemoryEmbedSweepConfigFromEnv', () => {
  it('is OFF by default with the guard-rail interval / max', () => {
    expect(resolveAoiMemoryEmbedSweepConfigFromEnv({})).toEqual({
      enabled: false,
      intervalMs: 5 * 60_000,
      max: 16,
    });
  });

  it('parses the opt-in flag and numeric overrides', () => {
    expect(
      resolveAoiMemoryEmbedSweepConfigFromEnv({
        AOI_AUTONOMY_EMBED_SWEEP: '1',
        AOI_AUTONOMY_EMBED_SWEEP_INTERVAL_MS: '90000',
        AOI_AUTONOMY_EMBED_SWEEP_MAX: '4',
      }),
    ).toEqual({ enabled: true, intervalMs: 90_000, max: 4 });
  });

  it('falls back to defaults for non-positive / non-numeric overrides', () => {
    expect(
      resolveAoiMemoryEmbedSweepConfigFromEnv({
        AOI_AUTONOMY_EMBED_SWEEP: 'yes',
        AOI_AUTONOMY_EMBED_SWEEP_INTERVAL_MS: '0',
        AOI_AUTONOMY_EMBED_SWEEP_MAX: 'abc',
      }),
    ).toEqual({ enabled: true, intervalMs: 5 * 60_000, max: 16 });
  });
});

describe('runAoiMemoryEmbedSweepCycle', () => {
  it('embeds pending server memories when a provider is injected', async () => {
    const root = makeRoot();
    seedMemory(root);

    const result = await runAoiMemoryEmbedSweepCycle({
      sessionsDir: root,
      provider: fakeProvider(),
    });

    expect(result).toMatchObject({ ran: true, embeddedCount: 1 });
    expect(loadServerAoiMemories(root)[0].embedding).toEqual([0.2, 0.3, 0.4]);
    expect(loadServerAoiMemories(root)[0].embeddingModel).toBe('sweep-embed-model');
  });

  it('is a no-op when no provider is available (null injected)', async () => {
    const root = makeRoot();
    seedMemory(root);

    const result = await runAoiMemoryEmbedSweepCycle({ sessionsDir: root, provider: null });

    expect(result).toEqual({ ran: false, embeddedCount: 0, pendingCount: 0 });
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
  });

  it('resolves no provider (a no-op) when the env carries no embedding key', async () => {
    const root = makeRoot();
    seedMemory(root);

    const result = await runAoiMemoryEmbedSweepCycle({ sessionsDir: root, env: {} });

    expect(result.ran).toBe(false);
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
  });

  it('never throws and embeds nothing when the provider rejects (best-effort)', async () => {
    const root = makeRoot();
    seedMemory(root);
    const throwingProvider: AoiEmbeddingProvider = {
      model: 'sweep-embed-model',
      async embed() {
        throw new Error('embedding backend down');
      },
    };

    // The underlying backfill swallows the provider failure, so the cycle
    // completes without throwing but embeds nothing and leaves the memory vectorless.
    const result = await runAoiMemoryEmbedSweepCycle({
      sessionsDir: root,
      provider: throwingProvider,
    });

    expect(result.embeddedCount).toBe(0);
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
  });
});

describe('startAoiMemoryEmbedSweep', () => {
  it('runs a cycle immediately with the injected runner and stops cleanly', async () => {
    let calls = 0;
    const handle = startAoiMemoryEmbedSweep({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      intervalMs: 30_000,
      runImmediately: true,
      runCycle: async () => {
        calls += 1;
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
    });
    // runImmediately schedules the first tick; let the microtask / macrotask drain.
    await new Promise((r) => setTimeout(r, 0));
    handle.stop();

    expect(calls).toBe(1);
  });

  it('fires the sweep on its interval and stops firing after stop()', async () => {
    vi.useFakeTimers();
    try {
      let cycles = 0;
      const handle = startAoiMemoryEmbedSweep({
        sessionsDir: '/tmp/aoi-embed-sweep-noop',
        intervalMs: 30_000,
        runCycle: async () => ({ ran: true, embeddedCount: 0, pendingCount: 0 }),
        onCycle: () => {
          cycles += 1;
        },
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(cycles).toBe(1);

      handle.stop();
      await vi.advanceTimersByTimeAsync(90_000);
      // The interval is cleared on stop, so no further cycles run.
      expect(cycles).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes a cycle failure to onError without throwing', async () => {
    const errors: unknown[] = [];
    const handle = startAoiMemoryEmbedSweep({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      intervalMs: 30_000,
      runImmediately: true,
      runCycle: async () => {
        throw new Error('cycle boom');
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    handle.stop();

    expect(errors).toHaveLength(1);
  });
});

describe('startAoiMemoryEmbedSweepFromEnv', () => {
  it('returns null when the sweep is not opted in', () => {
    const root = makeRoot();
    expect(
      startAoiMemoryEmbedSweepFromEnv(
        { sessionsDir: root, configFile: join(root, 'config.json') },
        {},
      ),
    ).toBeNull();
  });

  it('acquires the single-instance lock when enabled and releases it on stop', () => {
    const root = makeRoot();
    const handle = startAoiMemoryEmbedSweepFromEnv(
      { sessionsDir: root, configFile: join(root, 'config.json') },
      { AOI_AUTONOMY_EMBED_SWEEP: '1' },
    );
    expect(handle).not.toBeNull();
    // While the sweep owns the dir, a second acquire refuses (single writer).
    expect(acquireAoiAutonomyLoopLock(root)).toBeNull();

    handle?.stop();
    // After release the dir is free again.
    const reacquired = acquireAoiAutonomyLoopLock(root);
    expect(reacquired).not.toBeNull();
    reacquired?.release();
  });

  it('no-ops (returns null) when the autonomy loop already owns the dir lock', () => {
    const root = makeRoot();
    // Simulate the background loop having taken the lock first.
    const loopLock = acquireAoiAutonomyLoopLock(root);
    expect(loopLock).not.toBeNull();

    const handle = startAoiMemoryEmbedSweepFromEnv(
      { sessionsDir: root, configFile: join(root, 'config.json') },
      { AOI_AUTONOMY_EMBED_SWEEP: '1' },
    );
    expect(handle).toBeNull();

    loopLock?.release();
  });
});
