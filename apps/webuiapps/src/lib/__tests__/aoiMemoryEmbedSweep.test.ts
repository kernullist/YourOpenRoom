import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveAoiMemoryEmbedSweepConfigFromEnv,
  runAoiMemoryEmbedSweepCycle,
  runAoiMemoryMaintenanceCycle,
  startAoiMemoryEmbedSweep,
} from '../aoiMemoryEmbedSweep';
import {
  startAoiAutonomyBackgroundFromEnv,
  startAoiMemoryEmbedSweepFromEnv,
} from '../aoiAutonomyPlugin';
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

  it('runs the consolidation cycle AFTER the embed cycle when consolidation is enabled', async () => {
    const order: string[] = [];
    const handle = startAoiMemoryEmbedSweep({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      intervalMs: 30_000,
      runImmediately: true,
      runCycle: async () => {
        order.push('embed');
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
      consolidation: { enabled: true, max: 4 },
      runConsolidationCycle: (opts) => {
        order.push(`consolidate:${opts.max}`);
        return { ran: true, clusterCount: 0, supersededCount: 0 };
      },
      onConsolidation: () => order.push('onConsolidation'),
    });

    await new Promise((r) => setTimeout(r, 0));
    handle.stop();

    expect(order).toEqual(['embed', 'consolidate:4', 'onConsolidation']);
  });

  it('yields the whole cycle -- reading nothing, writing nothing -- when ownsLock is false', async () => {
    let embeds = 0;
    let consolidations = 0;
    let settingsReads = 0;
    const handle = startAoiMemoryEmbedSweep({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      intervalMs: 30_000,
      runImmediately: true,
      ownsLock: () => false,
      runCycle: async () => {
        embeds += 1;
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
      consolidation: { enabled: true, max: 4 },
      runConsolidationCycle: () => {
        consolidations += 1;
        return { ran: true, clusterCount: 0, supersededCount: 0 };
      },
      resolveCycleSettings: () => {
        settingsReads += 1;
        return {
          embedSweep: { enabled: true, max: 8 },
          consolidation: { enabled: true, max: 4 },
        };
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    handle.stop();

    expect(embeds).toBe(0);
    expect(consolidations).toBe(0);
    // The ownership check comes before everything, including the settings read.
    expect(settingsReads).toBe(0);
  });

  it('resumes cycles once ownsLock reports the lock back', async () => {
    vi.useFakeTimers();
    try {
      let owned = false;
      let embeds = 0;
      const handle = startAoiMemoryEmbedSweep({
        sessionsDir: '/tmp/aoi-embed-sweep-noop',
        intervalMs: 30_000,
        ownsLock: () => owned,
        runCycle: async () => {
          embeds += 1;
          return { ran: true, embeddedCount: 0, pendingCount: 0 };
        },
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(embeds).toBe(0);

      owned = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(embeds).toBe(1);

      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run the consolidation cycle when consolidation is not enabled', async () => {
    let consolidations = 0;
    const handle = startAoiMemoryEmbedSweep({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      intervalMs: 30_000,
      runImmediately: true,
      runCycle: async () => ({ ran: true, embeddedCount: 0, pendingCount: 0 }),
      runConsolidationCycle: () => {
        consolidations += 1;
        return { ran: true, clusterCount: 0, supersededCount: 0 };
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    handle.stop();

    expect(consolidations).toBe(0);
  });
});

describe('runAoiMemoryMaintenanceCycle', () => {
  it('embeds first, then consolidates', async () => {
    const order: string[] = [];
    await runAoiMemoryMaintenanceCycle({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      embedSweep: { enabled: true, max: 8 },
      consolidation: { enabled: true, max: 4 },
      runCycle: async (opts) => {
        order.push(`embed:${opts.max}`);
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
      runConsolidationCycle: (opts) => {
        order.push(`consolidate:${opts.max}`);
        return { ran: true, clusterCount: 0, supersededCount: 0 };
      },
    });

    expect(order).toEqual(['embed:8', 'consolidate:4']);
  });

  it('serializes concurrent passes over the same store instead of interleaving', async () => {
    // Three paths in one process mutate the same memory files -- the sweep timer,
    // the loop's post-cycle pass, and the run-now route -- and each has its own
    // in-flight guard that says nothing about the others. Overlapping at an await
    // is a lost update.
    const order: string[] = [];
    const makePass = (tag: string) =>
      runAoiMemoryMaintenanceCycle({
        sessionsDir: '/tmp/aoi-embed-sweep-serialized',
        embedSweep: { enabled: true, max: 8 },
        consolidation: { enabled: true, max: 4 },
        runCycle: async () => {
          order.push(`${tag}:embed-start`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`${tag}:embed-end`);
          return { ran: true, embeddedCount: 0, pendingCount: 0 };
        },
        runConsolidationCycle: () => {
          order.push(`${tag}:consolidate`);
          return { ran: true, clusterCount: 0, supersededCount: 0 };
        },
      });

    await Promise.all([makePass('a'), makePass('b')]);

    expect(order).toEqual([
      'a:embed-start',
      'a:embed-end',
      'a:consolidate',
      'b:embed-start',
      'b:embed-end',
      'b:consolidate',
    ]);
  });

  it('serializes two spellings of the same store', async () => {
    // An unnormalized key would put these on separate chains and silently stop
    // serializing them against each other.
    const order: string[] = [];
    const pass = (dir: string, tag: string) =>
      runAoiMemoryMaintenanceCycle({
        sessionsDir: dir,
        embedSweep: { enabled: true, max: 8 },
        consolidation: { enabled: false, max: 4 },
        runCycle: async () => {
          order.push(`${tag}:start`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`${tag}:end`);
          return { ran: true, embeddedCount: 0, pendingCount: 0 };
        },
      });

    await Promise.all([
      pass('/tmp/aoi-embed-sweep-spelling', 'a'),
      pass('/tmp/aoi-embed-sweep-spelling/nested/..', 'b'),
    ]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('keeps serializing after a pass throws', async () => {
    const order: string[] = [];
    const failing = runAoiMemoryMaintenanceCycle({
      sessionsDir: '/tmp/aoi-embed-sweep-serialized-throw',
      embedSweep: { enabled: true, max: 8 },
      consolidation: { enabled: false, max: 4 },
      runCycle: async () => {
        order.push('boom');
        throw new Error('pass failed');
      },
    });
    const following = runAoiMemoryMaintenanceCycle({
      sessionsDir: '/tmp/aoi-embed-sweep-serialized-throw',
      embedSweep: { enabled: true, max: 8 },
      consolidation: { enabled: false, max: 4 },
      runCycle: async () => {
        order.push('after');
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
    });

    await expect(failing).rejects.toThrow('pass failed');
    await following;
    // One bad pass must not poison the queue behind it.
    expect(order).toEqual(['boom', 'after']);
  });

  it('stops before consolidating when the lock is taken over mid-cycle', async () => {
    const order: string[] = [];
    let owned = true;
    await runAoiMemoryMaintenanceCycle({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      embedSweep: { enabled: true, max: 8 },
      consolidation: { enabled: true, max: 4 },
      ownsLock: () => owned,
      runCycle: async () => {
        order.push('embed');
        // The authoritative loop takes the dir over while embedding awaits.
        owned = false;
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
      runConsolidationCycle: () => {
        order.push('consolidate');
        return { ran: true, clusterCount: 0, supersededCount: 0 };
      },
    });

    expect(order).toEqual(['embed']);
  });

  it('skips each half independently when it is disabled', async () => {
    const order: string[] = [];
    await runAoiMemoryMaintenanceCycle({
      sessionsDir: '/tmp/aoi-embed-sweep-noop',
      embedSweep: { enabled: false, max: 8 },
      consolidation: { enabled: true, max: 4 },
      runCycle: async () => {
        order.push('embed');
        return { ran: true, embeddedCount: 0, pendingCount: 0 };
      },
      runConsolidationCycle: () => {
        order.push('consolidate');
        return { ran: true, clusterCount: 0, supersededCount: 0 };
      },
    });

    expect(order).toEqual(['consolidate']);
  });
});

describe('startAoiAutonomyBackgroundFromEnv maintenance', () => {
  function writeMaintenanceConfig(configFile: string): void {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        aoiMemoryMaintenance: {
          version: 1,
          embedSweepEnabled: true,
          embedSweepIntervalMinutes: 1,
          embedSweepMax: 16,
          consolidationEnabled: false,
          // Offline hash embedder: real vectors, no egress, no key.
          localEmbedderEnabled: true,
        },
      }),
    );
  }

  it('maintains the store from its own cycle even when NO session is enabled', async () => {
    const root = makeRoot();
    const configFile = join(root, 'config.json');
    writeMaintenanceConfig(configFile);
    seedMemory(root);
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();

    vi.useFakeTimers();
    let handle: { stop: () => void } | null = null;
    try {
      handle = startAoiAutonomyBackgroundFromEnv(
        { sessionsDir: root, configFile },
        { AOI_AUTONOMY_BACKGROUND: '1', AOI_AUTONOMY_BACKGROUND_INTERVAL_MS: '30000' },
        { runImmediately: true },
      );
      expect(handle).not.toBeNull();
      // The loop holds the single-instance lock, so every other process yields to
      // it. There is no session to wake, yet the store must still be maintained --
      // otherwise taking the lock would silently stop maintenance altogether.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    } finally {
      handle?.stop();
      vi.useRealTimers();
    }

    expect(loadServerAoiMemories(root)[0].embedding).toBeDefined();
  });

  it('does not embed through a cloud provider when the network ceiling is hard-off', async () => {
    const root = makeRoot();
    const configFile = join(root, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        // A real cloud embedder: embedding it would be outbound egress.
        aoiEmbedding: { apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', model: 'm' },
        aoiMemoryMaintenance: {
          version: 1,
          embedSweepEnabled: true,
          embedSweepIntervalMinutes: 1,
          embedSweepMax: 16,
          consolidationEnabled: false,
          localEmbedderEnabled: false,
        },
      }),
    );
    seedMemory(root);

    vi.useFakeTimers();
    let handle: { stop: () => Promise<void> } | null = null;
    try {
      handle = startAoiAutonomyBackgroundFromEnv(
        { sessionsDir: root, configFile },
        {
          AOI_AUTONOMY_BACKGROUND: '1',
          AOI_AUTONOMY_BACKGROUND_INTERVAL_MS: '30000',
          // The documented hard-off ceiling: no autonomy egress from this host.
          AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: '0',
        },
        { runImmediately: true },
      );
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    } finally {
      await handle?.stop();
      vi.useRealTimers();
    }

    // No vector: the pass ran but refused to post memory text to the cloud.
    expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
  });

  it('still embeds under a hard-off ceiling when the embedder is the offline one', async () => {
    const root = makeRoot();
    const configFile = join(root, 'config.json');
    // Offline local embedder: no egress, so the network ceiling does not apply.
    writeMaintenanceConfig(configFile);
    seedMemory(root);

    vi.useFakeTimers();
    let handle: { stop: () => Promise<void> } | null = null;
    try {
      handle = startAoiAutonomyBackgroundFromEnv(
        { sessionsDir: root, configFile },
        {
          AOI_AUTONOMY_BACKGROUND: '1',
          AOI_AUTONOMY_BACKGROUND_INTERVAL_MS: '30000',
          AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: '0',
        },
        { runImmediately: true },
      );
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    } finally {
      await handle?.stop();
      vi.useRealTimers();
    }

    expect(loadServerAoiMemories(root)[0].embedding).toBeDefined();
  });

  it('waits one configured interval before its first pass', async () => {
    const root = makeRoot();
    const configFile = join(root, 'config.json');
    writeMaintenanceConfig(configFile);
    seedMemory(root);

    vi.useFakeTimers();
    let handle: { stop: () => void } | null = null;
    try {
      handle = startAoiAutonomyBackgroundFromEnv(
        { sessionsDir: root, configFile },
        { AOI_AUTONOMY_BACKGROUND: '1', AOI_AUTONOMY_BACKGROUND_INTERVAL_MS: '30000' },
        { runImmediately: true },
      );
      // One loop tick, but less than the maintenance interval: a sweep this loop
      // just displaced may still be finishing its cycle, so nothing runs yet.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(loadServerAoiMemories(root)[0].embedding).toBeUndefined();
    } finally {
      handle?.stop();
      vi.useRealTimers();
    }
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

  it('takes the single-instance lock as maintenance and releases it on stop', async () => {
    const root = makeRoot();
    const handle = startAoiMemoryEmbedSweepFromEnv(
      { sessionsDir: root, configFile: join(root, 'config.json') },
      { AOI_AUTONOMY_EMBED_SWEEP: '1' },
    );
    expect(handle).not.toBeNull();
    // A second maintenance holder refuses: among equals the dir has one writer.
    expect(acquireAoiAutonomyLoopLock(root, { role: 'maintenance' })).toBeNull();

    // stop() resolves only after the in-flight cycle drains AND the lock is
    // released; a synchronous stop would free the dir mid-write.
    await handle?.stop();
    const reacquired = acquireAoiAutonomyLoopLock(root, { role: 'maintenance' });
    expect(reacquired).not.toBeNull();
    reacquired?.release();
  });

  it('yields to an autonomy loop that starts later instead of blocking it', () => {
    const root = makeRoot();
    const handle = startAoiMemoryEmbedSweepFromEnv(
      { sessionsDir: root, configFile: join(root, 'config.json') },
      { AOI_AUTONOMY_EMBED_SWEEP: '1' },
    );
    expect(handle).not.toBeNull();

    // The always-on loop must be able to start even though the sweep got there
    // first -- this is the regression the role split exists for.
    // The real pid, so the liveness probe sees a genuinely live holder.
    const loopLock = acquireAoiAutonomyLoopLock(root, { role: 'loop', pid: process.pid });
    expect(loopLock).not.toBeNull();
    expect(loopLock?.isOwner()).toBe(true);

    // Stopping the displaced sweep must not remove the loop's lock.
    handle?.stop();
    expect(loopLock?.isOwner()).toBe(true);
    loopLock?.release();
  });

  it('starts (in a yielded state) when the autonomy loop already owns the dir lock', () => {
    const root = makeRoot();
    // Simulate the background loop having taken the lock first.
    // The real pid, so the liveness probe sees a genuinely live holder.
    const loopLock = acquireAoiAutonomyLoopLock(root, { role: 'loop', pid: process.pid });
    expect(loopLock).not.toBeNull();

    // The sweep still starts: it re-checks ownership every cycle, so it resumes
    // by itself if that loop ever stops. It just never mutates meanwhile.
    const handle = startAoiMemoryEmbedSweepFromEnv(
      { sessionsDir: root, configFile: join(root, 'config.json') },
      { AOI_AUTONOMY_EMBED_SWEEP: '1' },
    );
    expect(handle).not.toBeNull();
    // Maintenance never displaces a loop.
    expect(loopLock?.isOwner()).toBe(true);

    handle?.stop();
    expect(loopLock?.isOwner()).toBe(true);
    loopLock?.release();
  });

  it('starts the maintenance sweep when ONLY consolidation is opted in', async () => {
    const root = makeRoot();
    const handle = startAoiMemoryEmbedSweepFromEnv(
      { sessionsDir: root, configFile: join(root, 'config.json') },
      { AOI_AUTONOMY_CONSOLIDATION: '1' },
    );
    expect(handle).not.toBeNull();
    // The combined sweep still takes the single-instance lock.
    expect(acquireAoiAutonomyLoopLock(root, { role: 'maintenance' })).toBeNull();

    await handle?.stop();
    const reacquired = acquireAoiAutonomyLoopLock(root, { role: 'maintenance' });
    expect(reacquired).not.toBeNull();
    reacquired?.release();
  });
});
