import { describe, expect, it } from 'vitest';
import {
  describeAoiAutonomyRuntime,
  formatAoiRuntimeUptime,
  isAoiAutonomyRuntimeLive,
  parseAoiAutonomyRuntimeResponse,
} from '../aoiAutonomyRuntimePanelModel';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    uptimeMs: 3_600_000,
    loopRunning: true,
    cognitionActive: true,
    cyclesCompleted: 42,
    lastCycle: {
      startedAt: 1_700_000_000_000,
      durationMs: 900,
      sessionsConsidered: 2,
      sessionsRun: 1,
      sessionsSkipped: 1,
      errorCount: 0,
    },
    errorsTotal: 0,
    lastError: null,
    ...overrides,
  };
}

describe('parseAoiAutonomyRuntimeResponse', () => {
  it('reports running with a valid snapshot', () => {
    const view = parseAoiAutonomyRuntimeResponse({
      ok: true,
      status: 'running',
      port: 7333,
      snapshot: snapshot(),
    });
    expect(view.status).toBe('running');
    expect(view.port).toBe(7333);
    expect(view.snapshot?.cyclesCompleted).toBe(42);
    expect(isAoiAutonomyRuntimeLive(view)).toBe(true);
  });

  it('NEVER claims running when the snapshot cannot be validated', () => {
    // A daemon that answers with something unparseable is not proof the loop is
    // up; rendering it as healthy is the exact lie this card exists to fix.
    const view = parseAoiAutonomyRuntimeResponse({
      ok: true,
      status: 'running',
      port: 7333,
      snapshot: { status: 'ok', loopRunning: 'yes-ish' },
    });
    expect(view.status).toBe('unreachable');
    expect(isAoiAutonomyRuntimeLive(view)).toBe(false);
  });

  it('keeps "not running" distinct from "could not tell"', () => {
    expect(
      parseAoiAutonomyRuntimeResponse({ ok: true, status: 'not_running', port: 7333 }).status,
    ).toBe('not_running');
    expect(
      parseAoiAutonomyRuntimeResponse({ ok: true, status: 'unreachable', port: 7333 }).status,
    ).toBe('unreachable');
  });

  it('falls back to probe_failed on a malformed or missing body', () => {
    for (const raw of [null, undefined, 'nope', {}, { status: 'weird' }]) {
      expect(parseAoiAutonomyRuntimeResponse(raw).status).toBe('probe_failed');
    }
  });

  it('treats a loop that is not running as not live even when the daemon answers', () => {
    const view = parseAoiAutonomyRuntimeResponse({
      ok: true,
      status: 'running',
      port: 7333,
      snapshot: snapshot({ loopRunning: false, cognitionActive: false }),
    });
    expect(view.status).toBe('running');
    expect(isAoiAutonomyRuntimeLive(view)).toBe(false);
  });
});

describe('describeAoiAutonomyRuntime', () => {
  it('tells the operator plainly that nothing takes effect when the daemon is down', () => {
    const text = describeAoiAutonomyRuntime({
      status: 'not_running',
      port: 7333,
      snapshot: null,
    });
    expect(text).toContain('not running');
    expect(text).toContain('NOTHING below takes effect');
  });

  it('separates a running-but-idle loop from a thinking one', () => {
    const idle = describeAoiAutonomyRuntime(
      parseAoiAutonomyRuntimeResponse({
        ok: true,
        status: 'running',
        snapshot: snapshot({ cognitionActive: false }),
      }),
    );
    // "Idle" must not read as broken -- it usually means every session has
    // autonomy switched off, which is a policy answer, not a bug.
    expect(idle).toContain('idle');
    expect(idle).toContain('no session has autonomy enabled');

    const thinking = describeAoiAutonomyRuntime(
      parseAoiAutonomyRuntimeResponse({ ok: true, status: 'running', snapshot: snapshot() }),
    );
    expect(thinking).toContain('Thinking');
  });

  it('calls out a daemon whose loop is stopped', () => {
    const text = describeAoiAutonomyRuntime(
      parseAoiAutonomyRuntimeResponse({
        ok: true,
        status: 'running',
        snapshot: snapshot({ loopRunning: false }),
      }),
    );
    expect(text).toContain('background loop is NOT running');
  });

  it('does not assert anything when the status is unknown', () => {
    expect(
      describeAoiAutonomyRuntime({ status: 'unreachable', port: 7333, snapshot: null }),
    ).toContain('status unknown');
    expect(
      describeAoiAutonomyRuntime({ status: 'probe_failed', port: null, snapshot: null }),
    ).toContain('unavailable');
  });
});

describe('formatAoiRuntimeUptime', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatAoiRuntimeUptime(90_000)).toBe('1m');
    expect(formatAoiRuntimeUptime(3_600_000)).toBe('1h 0m');
    expect(formatAoiRuntimeUptime(3 * 86_400_000 + 7_200_000)).toBe('3d 2h');
  });
});
