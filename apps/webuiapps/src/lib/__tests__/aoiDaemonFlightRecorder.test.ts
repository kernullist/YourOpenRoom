import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AoiAutonomyBackgroundCycleResult } from '../aoiAutonomyBackgroundRunner';
import {
  buildAoiDaemonCycleFlightRecordInputs,
  recordAoiDaemonCycleFlightRecords,
} from '../aoiDaemonFlightRecorder';
import { loadAoiOperatorFlightRecords } from '../aoiOperatorFlightRecorder';

function cycle(
  partial: Partial<AoiAutonomyBackgroundCycleResult>,
): AoiAutonomyBackgroundCycleResult {
  return {
    startedAt: 1_000,
    durationMs: 5,
    sessionsConsidered: 0,
    sessionsRun: [],
    sessionsSkipped: [],
    errors: [],
    ...partial,
  };
}

describe('aoiDaemonFlightRecorder -- cycle -> flight record inputs (P2.4)', () => {
  it('maps each fired wakeup to a hidden proactive_scheduler record', () => {
    const inputs = buildAoiDaemonCycleFlightRecordInputs(
      cycle({ sessionsRun: ['aoi/default', 'aoi/second'], startedAt: 4_242 }),
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      sessionPath: 'aoi/default',
      createdAt: 4_242,
      signalClass: 'proactive_scheduler',
      decisionLane: 'hidden',
      mutationCount: 0,
    });
    expect(inputs[1].sessionPath).toBe('aoi/second');
    expect((inputs[0].whyQuiet as string[])[0]).toContain('self-initiated wakeup');
  });

  it('maps a real-session cycle error to a blocked record carrying the reason', () => {
    const inputs = buildAoiDaemonCycleFlightRecordInputs(
      cycle({ errors: [{ sessionPath: 'aoi/broken', error: 'boom' }] }),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      sessionPath: 'aoi/broken',
      signalClass: 'proactive_scheduler',
      decisionLane: 'blocked',
    });
    expect((inputs[0].whyQuiet as string[])[0]).toContain('boom');
  });

  it('skips the whole-sweep sentinel error (sessionPath "*") that has no real session', () => {
    const inputs = buildAoiDaemonCycleFlightRecordInputs(
      cycle({
        sessionsRun: ['aoi/default'],
        errors: [{ sessionPath: '*', error: 'listSessions failed' }],
      }),
    );
    // Only the one real fired wakeup -- the '*' sentinel is dropped.
    expect(inputs).toHaveLength(1);
    expect(inputs[0].sessionPath).toBe('aoi/default');
  });

  it('produces nothing for a quiet cooldown cycle (considered but none run, no errors)', () => {
    expect(buildAoiDaemonCycleFlightRecordInputs(cycle({ sessionsConsidered: 3 }))).toEqual([]);
  });
});

describe('aoiDaemonFlightRecorder -- recordAoiDaemonCycleFlightRecords (P2.4)', () => {
  it('writes one record per input through the injected writer and returns the count', () => {
    const record = vi.fn();
    const written = recordAoiDaemonCycleFlightRecords(
      '/sessions',
      cycle({ sessionsRun: ['aoi/a', 'aoi/b'] }),
      7,
      record as never,
    );
    expect(written).toBe(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(
      1,
      '/sessions',
      expect.objectContaining({ sessionPath: 'aoi/a' }),
      7,
    );
  });

  it('is best-effort: a failing writer does not throw and only counts successes', () => {
    let calls = 0;
    const record = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error('disk full');
      }
    });
    const written = recordAoiDaemonCycleFlightRecords(
      '/sessions',
      cycle({ sessionsRun: ['aoi/a', 'aoi/b'] }),
      undefined,
      record as never,
    );
    expect(written).toBe(1);
    expect(record).toHaveBeenCalledTimes(2);
  });
});

describe('aoiDaemonFlightRecorder -- end-to-end persistence (P2.4)', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'aoi-daemon-flight-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('lands real flight records that loadAoiOperatorFlightRecords can read back', () => {
    const written = recordAoiDaemonCycleFlightRecords(
      sessionsDir,
      cycle({
        sessionsRun: ['aoi/default'],
        errors: [{ sessionPath: 'aoi/broken', error: 'timeout' }],
      }),
      9_000,
    );
    expect(written).toBe(2);

    const fired = loadAoiOperatorFlightRecords(sessionsDir, 'aoi/default', 9_000);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      signalClass: 'proactive_scheduler',
      decisionLane: 'hidden',
      actionAuthority: 'display_only',
    });

    const blocked = loadAoiOperatorFlightRecords(sessionsDir, 'aoi/broken', 9_000);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].decisionLane).toBe('blocked');
  });
});
