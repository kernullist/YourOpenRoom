import { describe, expect, it, vi } from 'vitest';
import {
  createAoiDaemonHealthHooks,
  createAoiDaemonHealthTracker,
  formatAoiDaemonCycleLogLine,
} from '../aoiDaemonHealth';
import type { AoiAutonomyBackgroundCycleResult } from '../aoiAutonomyBackgroundRunner';

function makeCycle(
  partial: Partial<AoiAutonomyBackgroundCycleResult> = {},
): AoiAutonomyBackgroundCycleResult {
  return {
    startedAt: partial.startedAt ?? 1_000,
    durationMs: partial.durationMs ?? 12,
    sessionsConsidered: partial.sessionsConsidered ?? 0,
    sessionsRun: partial.sessionsRun ?? [],
    sessionsSkipped: partial.sessionsSkipped ?? [],
    errors: partial.errors ?? [],
  };
}

describe('createAoiDaemonHealthTracker()', () => {
  it('reports a healthy idle snapshot before any cycle', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 100, loopRunning: () => true });
    const snap = tracker.snapshot(1_100);
    expect(snap.status).toBe('ok');
    expect(snap.uptimeMs).toBe(1_000);
    expect(snap.loopRunning).toBe(true);
    // A running loop that has processed no session yet is NOT active cognition.
    expect(snap.cognitionActive).toBe(false);
    expect(snap.cyclesCompleted).toBe(0);
    expect(snap.lastCycle).toBeNull();
    expect(snap.errorsTotal).toBe(0);
    expect(snap.lastError).toBeNull();
  });

  it('clamps uptime to 0 when now precedes startedAt', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 5_000, loopRunning: () => true });
    expect(tracker.snapshot(4_000).uptimeMs).toBe(0);
  });

  it('marks cognition active only when a cycle actually ran a session', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });

    tracker.recordCycle(
      makeCycle({
        startedAt: 200,
        durationMs: 30,
        sessionsConsidered: 3,
        sessionsRun: ['aoi/a'],
        sessionsSkipped: [{ sessionPath: 'aoi/b', reason: 'policy_disabled' }],
      }),
    );

    const snap = tracker.snapshot(1_000);
    expect(snap.cyclesCompleted).toBe(1);
    expect(snap.cognitionActive).toBe(true);
    expect(snap.lastCycle).toEqual({
      startedAt: 200,
      durationMs: 30,
      sessionsConsidered: 3,
      sessionsRun: 1,
      sessionsSkipped: 1,
      errorCount: 0,
    });
  });

  it('stays idle-cognition when a cycle ran but every session was skipped', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    tracker.recordCycle(
      makeCycle({
        sessionsConsidered: 2,
        sessionsRun: [],
        sessionsSkipped: [
          { sessionPath: 'aoi/a', reason: 'policy_disabled' },
          { sessionPath: 'aoi/b', reason: 'policy_disabled' },
        ],
      }),
    );
    expect(tracker.snapshot(10).cognitionActive).toBe(false);
  });

  it('never reports cognition active when the loop is not running', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => false });
    tracker.recordCycle(makeCycle({ sessionsRun: ['aoi/a'] }));
    const snap = tracker.snapshot(10);
    expect(snap.loopRunning).toBe(false);
    expect(snap.cognitionActive).toBe(false);
  });

  it('accumulates per-session cycle errors into the total and last error', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    tracker.recordCycle(
      makeCycle({
        startedAt: 500,
        sessionsRun: ['aoi/a'],
        errors: [
          { sessionPath: 'aoi/a', error: 'boom-1' },
          { sessionPath: 'aoi/b', error: 'boom-2' },
        ],
      }),
    );
    const snap = tracker.snapshot(600);
    expect(snap.errorsTotal).toBe(2);
    expect(snap.lastError).toEqual({ at: 500, message: 'aoi/b: boom-2' });
    expect(snap.lastCycle?.errorCount).toBe(2);
  });

  it('records a whole-cycle throw via recordError (Error and non-Error)', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    tracker.recordError(new Error('fatal cycle'), 700);
    expect(tracker.snapshot(800).lastError).toEqual({ at: 700, message: 'fatal cycle' });

    tracker.recordError('string failure', 900);
    const snap = tracker.snapshot(1_000);
    expect(snap.errorsTotal).toBe(2);
    expect(snap.lastError).toEqual({ at: 900, message: 'string failure' });
  });

  it('counts every completed cycle', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    tracker.recordCycle(makeCycle());
    tracker.recordCycle(makeCycle());
    tracker.recordCycle(makeCycle());
    expect(tracker.snapshot(1).cyclesCompleted).toBe(3);
  });
});

describe('formatAoiDaemonCycleLogLine()', () => {
  it('renders a concise ASCII telemetry line', () => {
    const line = formatAoiDaemonCycleLogLine(
      makeCycle({
        durationMs: 42,
        sessionsConsidered: 5,
        sessionsRun: ['a', 'b'],
        sessionsSkipped: [{ sessionPath: 'c', reason: 'policy_disabled' }],
        errors: [{ sessionPath: 'd', error: 'x' }],
      }),
    );
    expect(line).toBe('cycle: considered=5 run=2 skipped=1 errors=1 dur=42ms');
  });
});

describe('createAoiDaemonHealthHooks()', () => {
  it('onCycle records the cycle in the tracker and logs the telemetry line', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    const logCycle = vi.fn();
    const hooks = createAoiDaemonHealthHooks({ tracker, now: () => 999, logCycle });

    hooks.onCycle(makeCycle({ sessionsConsidered: 2, sessionsRun: ['a'] }));

    expect(tracker.snapshot(1).cyclesCompleted).toBe(1);
    expect(tracker.snapshot(1).cognitionActive).toBe(true);
    expect(logCycle).toHaveBeenCalledWith('cycle: considered=2 run=1 skipped=0 errors=0 dur=12ms');
  });

  it('onError records a whole-cycle throw with the injected clock and logs it', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    const logError = vi.fn();
    const hooks = createAoiDaemonHealthHooks({ tracker, now: () => 777, logError });

    hooks.onError(new Error('cycle exploded'));

    const snap = tracker.snapshot(1);
    expect(snap.errorsTotal).toBe(1);
    expect(snap.lastError).toEqual({ at: 777, message: 'cycle exploded' });
    expect(logError).toHaveBeenCalledWith(new Error('cycle exploded'));
  });

  it('works without optional loggers (records only, no throw)', () => {
    const tracker = createAoiDaemonHealthTracker({ startedAt: 0, loopRunning: () => true });
    const hooks = createAoiDaemonHealthHooks({ tracker, now: () => 5 });

    expect(() => hooks.onCycle(makeCycle({ sessionsRun: ['a'] }))).not.toThrow();
    expect(() => hooks.onError('boom')).not.toThrow();

    const snap = tracker.snapshot(10);
    expect(snap.cyclesCompleted).toBe(1);
    expect(snap.errorsTotal).toBe(1);
    expect(snap.lastError).toEqual({ at: 5, message: 'boom' });
  });
});
