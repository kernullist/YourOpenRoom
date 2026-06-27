import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  resolveAoiAutonomyBackgroundConfigFromEnv,
  runAoiAutonomyBackgroundCycle,
  startAoiAutonomyBackgroundRunner,
} from '../aoiAutonomyBackgroundRunner';
import { listAoiAutonomySessionPaths } from '../aoiAutonomyStore';
import type { AoiAutonomyPolicy, AoiAutonomyWakeupResult } from '../aoiAutonomyTypes';

const policy = (enabled: boolean): AoiAutonomyPolicy =>
  ({ enabled }) as unknown as AoiAutonomyPolicy;
const wakeupOk = (): AoiAutonomyWakeupResult => ({}) as unknown as AoiAutonomyWakeupResult;

const baseOpts = { sessionsDir: '/sessions', configFile: '/config.json', now: 1000 };

describe('runAoiAutonomyBackgroundCycle', () => {
  it('runs a wakeup only for enabled sessions and records skips', async () => {
    const runWakeup = vi.fn().mockResolvedValue(wakeupOk());
    const result = await runAoiAutonomyBackgroundCycle({
      ...baseOpts,
      listSessions: () => ['s/a', 's/b', 's/c'],
      loadPolicy: (_dir, sessionPath) => policy(sessionPath !== 's/b'),
      runWakeup,
    });
    expect(result.sessionsRun).toEqual(['s/a', 's/c']);
    expect(result.sessionsSkipped).toContainEqual({
      sessionPath: 's/b',
      reason: 'policy_disabled',
    });
    expect(runWakeup).toHaveBeenCalledTimes(2);
  });

  it('fires the scheduled_background reason with an allowNetwork budget', async () => {
    const runWakeup = vi.fn().mockResolvedValue(wakeupOk());
    await runAoiAutonomyBackgroundCycle({
      ...baseOpts,
      allowNetwork: true,
      listSessions: () => ['s/a'],
      loadPolicy: () => policy(true),
      runWakeup,
    });
    expect(runWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPath: 's/a',
        reason: 'scheduled_background',
        budget: { allowNetwork: true },
      }),
    );
  });

  it('omits the LLM when network is disabled', async () => {
    const runWakeup = vi.fn().mockResolvedValue(wakeupOk());
    await runAoiAutonomyBackgroundCycle({
      ...baseOpts,
      allowNetwork: false,
      llmConfig: { provider: 'openai' } as never,
      listSessions: () => ['s/a'],
      loadPolicy: () => policy(true),
      runWakeup,
    });
    expect(runWakeup).toHaveBeenCalledWith(
      expect.objectContaining({ llmConfig: null, budget: { allowNetwork: false } }),
    );
  });

  it('isolates per-session wakeup failures', async () => {
    const runWakeup = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(wakeupOk());
    const result = await runAoiAutonomyBackgroundCycle({
      ...baseOpts,
      listSessions: () => ['s/a', 's/b'],
      loadPolicy: () => policy(true),
      runWakeup,
    });
    expect(result.errors).toContainEqual({ sessionPath: 's/a', error: 'boom' });
    expect(result.sessionsRun).toEqual(['s/b']);
  });

  it('caps the number of sessions run per cycle', async () => {
    const runWakeup = vi.fn().mockResolvedValue(wakeupOk());
    const result = await runAoiAutonomyBackgroundCycle({
      ...baseOpts,
      maxSessionsPerCycle: 1,
      listSessions: () => ['s/a', 's/b'],
      loadPolicy: () => policy(true),
      runWakeup,
    });
    expect(result.sessionsRun).toEqual(['s/a']);
    expect(result.sessionsSkipped).toContainEqual({
      sessionPath: 's/b',
      reason: 'max_sessions_per_cycle',
    });
    expect(runWakeup).toHaveBeenCalledTimes(1);
  });

  it('survives session discovery failure', async () => {
    const result = await runAoiAutonomyBackgroundCycle({
      ...baseOpts,
      listSessions: () => {
        throw new Error('readdir failed');
      },
      loadPolicy: () => policy(true),
      runWakeup: vi.fn(),
    });
    expect(result.sessionsRun).toEqual([]);
    expect(result.errors[0]?.error).toBe('readdir failed');
  });
});

describe('listAoiAutonomySessionPaths', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    created.length = 0;
  });
  const tmpRoot = (): string => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-bg-'));
    created.push(dir);
    return dir;
  };

  it('discovers sessions with an aoi-autonomy/policy.json, including nested paths', () => {
    const root = tmpRoot();
    for (const sessionPath of ['alpha', 'aoi/space_adventure']) {
      const dir = join(root, sessionPath, 'aoi-autonomy');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'policy.json'), '{"version":1,"enabled":true}');
    }
    // An autonomy dir without policy.json must be ignored.
    fs.mkdirSync(join(root, 'beta', 'aoi-autonomy'), { recursive: true });
    const found = listAoiAutonomySessionPaths(root).sort();
    expect(found).toEqual(['alpha', 'aoi/space_adventure'].sort());
  });

  it('returns empty for a missing directory', () => {
    expect(listAoiAutonomySessionPaths(join(tmpRoot(), 'does-not-exist'))).toEqual([]);
  });
});

describe('resolveAoiAutonomyBackgroundConfigFromEnv', () => {
  it('is disabled by default', () => {
    expect(resolveAoiAutonomyBackgroundConfigFromEnv({})).toMatchObject({
      enabled: false,
      allowNetwork: false,
    });
  });

  it('parses opt-in flags', () => {
    expect(
      resolveAoiAutonomyBackgroundConfigFromEnv({
        AOI_AUTONOMY_BACKGROUND: '1',
        AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: 'true',
        AOI_AUTONOMY_BACKGROUND_INTERVAL_MS: '120000',
        AOI_AUTONOMY_BACKGROUND_MAX_SESSIONS: '3',
      }),
    ).toEqual({ enabled: true, allowNetwork: true, intervalMs: 120000, maxSessionsPerCycle: 3 });
  });
});

describe('startAoiAutonomyBackgroundRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on the interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const runWakeup = vi.fn().mockResolvedValue(wakeupOk());
    const handle = startAoiAutonomyBackgroundRunner({
      sessionsDir: '/sessions',
      configFile: '/config.json',
      intervalMs: 60_000,
      listSessions: () => ['s/a'],
      loadPolicy: () => policy(true),
      runWakeup,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWakeup).toHaveBeenCalledTimes(1);
    handle.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runWakeup).toHaveBeenCalledTimes(1);
  });
});
