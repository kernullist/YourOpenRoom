import { describe, expect, it } from 'vitest';
import {
  superviseAoiDaemon,
  type AoiDaemonSupervisorEvent,
  type AoiDaemonSupervisorOptions,
  type SupervisedChild,
} from '../aoiDaemonSupervisor';

interface FakeChild extends SupervisedChild {
  fireExit: (code: number | null) => void;
  killed: boolean;
}

function makeHarness(overrides: Partial<AoiDaemonSupervisorOptions> = {}) {
  const spawned: FakeChild[] = [];
  const spawnChild = (): SupervisedChild => {
    let listener: ((code: number | null) => void) | null = null;
    const child: FakeChild = {
      onExit: (fn) => {
        listener = fn;
      },
      kill: () => {
        child.killed = true;
      },
      fireExit: (code) => listener?.(code),
      killed: false,
    };
    spawned.push(child);
    return child;
  };

  const pending: Array<() => void> = [];
  const schedule = (fn: () => void): (() => void) => {
    pending.push(fn);
    return () => {
      const index = pending.indexOf(fn);
      if (index >= 0) {
        pending.splice(index, 1);
      }
    };
  };

  let clock = 0;
  const events: AoiDaemonSupervisorEvent[] = [];
  const handle = superviseAoiDaemon({
    spawnChild,
    schedule,
    now: () => clock,
    baseRestartDelayMs: 1000,
    maxRestartDelayMs: 8000,
    crashWindowMs: 60_000,
    maxCrashesInWindow: 3,
    onEvent: (event) => events.push(event),
    ...overrides,
  });

  return {
    spawned,
    events,
    handle,
    runPendingRestarts: () => {
      const fns = pending.splice(0);
      fns.forEach((fn) => fn());
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('superviseAoiDaemon()', () => {
  it('spawns the daemon immediately', () => {
    const h = makeHarness();
    expect(h.spawned).toHaveLength(1);
    expect(h.events).toEqual([{ type: 'started', attempt: 1 }]);
  });

  it('restarts after a crash with exponential backoff', () => {
    const h = makeHarness();

    h.spawned[0].fireExit(1);
    expect(h.events).toContainEqual({
      type: 'crashed',
      code: 1,
      recentCrashes: 1,
      restartInMs: 1000,
    });
    h.runPendingRestarts();
    expect(h.spawned).toHaveLength(2); // restarted

    h.spawned[1].fireExit(1);
    // Second crash in the window -> doubled backoff.
    expect(h.events).toContainEqual({
      type: 'crashed',
      code: 1,
      recentCrashes: 2,
      restartInMs: 2000,
    });
    h.runPendingRestarts();
    expect(h.spawned).toHaveLength(3);
  });

  it('caps the backoff at maxRestartDelayMs', () => {
    const h = makeHarness({
      baseRestartDelayMs: 1000,
      maxRestartDelayMs: 3000,
      maxCrashesInWindow: 10,
    });
    for (let i = 0; i < 4; i++) {
      h.spawned[i].fireExit(1);
      h.runPendingRestarts();
    }
    const crashes = h.events.filter((e) => e.type === 'crashed') as Array<{ restartInMs: number }>;
    // 1000, 2000, 3000 (cap), 3000 (cap)
    expect(crashes.map((c) => c.restartInMs)).toEqual([1000, 2000, 3000, 3000]);
  });

  it('gives up on a crash loop (too many crashes in the window)', () => {
    const h = makeHarness({ maxCrashesInWindow: 3 });
    // 3 crashes restart; the 4th exceeds the window budget -> give up.
    for (let i = 0; i < 3; i++) {
      h.spawned[i].fireExit(1);
      h.runPendingRestarts();
    }
    h.spawned[3].fireExit(1);

    expect(h.events).toContainEqual({ type: 'gave_up', recentCrashes: 4 });
    // No restart scheduled after giving up.
    h.runPendingRestarts();
    expect(h.spawned).toHaveLength(4);
  });

  it('resets the crash streak after a crash outside the window', () => {
    const h = makeHarness({ crashWindowMs: 60_000 });
    h.spawned[0].fireExit(1); // recentCrashes 1 -> 1000
    h.runPendingRestarts();
    h.tick(120_000); // well past the window
    h.spawned[1].fireExit(1); // the earlier crash is aged out -> recentCrashes 1 again

    const crashes = h.events.filter((e) => e.type === 'crashed') as Array<{
      recentCrashes: number;
    }>;
    expect(crashes.map((c) => c.recentCrashes)).toEqual([1, 1]);
  });

  it('stop() kills the live child, cancels a pending restart, and prevents further restarts', () => {
    const h = makeHarness();
    const first = h.spawned[0] as FakeChild;

    h.handle.stop();
    expect(first.killed).toBe(true);
    expect(h.events).toContainEqual({ type: 'stopped' });

    // A late exit after stop must not respawn; stop is idempotent.
    first.fireExit(0);
    h.runPendingRestarts();
    expect(h.spawned).toHaveLength(1);
    expect(() => h.handle.stop()).not.toThrow();
  });

  it('does not restart while a pending restart is cancelled by stop', () => {
    const h = makeHarness();
    h.spawned[0].fireExit(1); // schedules a restart
    h.handle.stop(); // cancels it
    h.runPendingRestarts();
    expect(h.spawned).toHaveLength(1);
  });
});
