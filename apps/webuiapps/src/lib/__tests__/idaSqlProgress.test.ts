// @vitest-environment node
//
// What can honestly be shown while an analysis runs.
//
// Measured against a real install first: idasql prints `Opening: <path>...` and
// then emits nothing at all until it finishes, and `--help` has no verbosity
// flag. So there is no percentage to report, and the tests below exist partly
// to stop one being invented later.
import { describe, expect, it } from 'vitest';

import { IdaSqlSessionManager } from '../idaSqlSession';
import { normalizeIdaSqlConfig } from '../idaSqlConfig';
import { describeProgress, formatElapsed } from '../../pages/IdaLab/labView';
import type { IdaSqlSessionView } from '../idaSqlTypes';

const CONFIG = normalizeIdaSqlConfig({
  idasqlExePath: 'F:\\Aoi\\idasql\\idasql.exe',
  idaExePath: 'C:\\Program Files\\IDA Professional 9.4\\ida.exe',
  binaryRoots: [{ id: 'aoi', path: 'F:\\Aoi', label: 'Aoi' }],
});

describe('sampling the analysis from disk', () => {
  it('records growth across readiness polls while the engine stays silent', async () => {
    // The .id0 file really does grow like this: 108.5MB -> 119.9MB over 40s on
    // a live ntoskrnl analysis. Nothing arrives on stdout in that window.
    const sizes = [0, 10_000_000, 24_000_000, 41_000_000];
    let reading = 0;
    let clock = 1_000_000;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 7, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => {
        throw new Error('not up yet');
      },
      now: () => clock,
      sleep: async () => {
        clock += 2000;
      },
      isPortFree: async () => true,
      databaseBytes: () => sizes[Math.min(reading++, sizes.length - 1)],
    });

    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\Aoi\\samples\\ntoskrnl.exe',
      write: false,
    });
    const id = started.session?.id ?? '';
    // Let a few poll iterations run without ever answering /status.
    await new Promise((done) => setTimeout(done, 50));

    const progress = manager.get(id)?.progress;
    expect(progress).toBeTruthy();
    expect(progress?.sampleCount).toBeGreaterThan(0);
    expect(progress?.databaseBytes).toBeGreaterThan(0);
    await manager.stop(id);
  });

  it('survives a probe that throws, rather than failing the session', async () => {
    let clock = 1_000_000;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 7, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => clock,
      sleep: async () => {
        clock += 2000;
      },
      isPortFree: async () => true,
      databaseBytes: () => {
        throw new Error('EPERM');
      },
    });
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\Aoi\\samples\\x.exe',
      write: false,
    });
    expect(started.ok, started.reason).toBe(true);
    await new Promise((done) => setTimeout(done, 50));
    expect(manager.get(started.session?.id ?? '')?.progress).toBeNull();
    await manager.stop(started.session?.id ?? '');
  });
});

function view(overrides: Partial<IdaSqlSessionView> = {}): IdaSqlSessionView {
  return {
    id: 'ida-1',
    binaryPath: 'F:\\Aoi\\samples\\ntoskrnl.exe',
    binaryName: 'ntoskrnl.exe',
    mode: 'headless',
    write: false,
    state: 'starting',
    port: 8300,
    pid: 100,
    startedAt: 1_000_000,
    readyAt: null,
    lastUsedAt: 1_000_000,
    queryCount: 0,
    failureReason: '',
    unreviewedFunctions: [],
    progress: null,
    ...overrides,
  };
}

describe('describeProgress', () => {
  it('says nothing for a session that is not starting', () => {
    expect(describeProgress(view({ state: 'ready' }), 1_000_000)).toBeNull();
    expect(describeProgress(view({ state: 'failed' }), 1_000_000)).toBeNull();
  });

  it('is honest before the first sample: timed, not measured', () => {
    const shown = describeProgress(view(), 1_000_000 + 8_000);
    expect(shown?.elapsed).toBe('8s');
    expect(shown?.size).toBe('');
    expect(shown?.detail).toContain('reports nothing');
  });

  it('reports the database growing, and says there is no percentage', () => {
    const shown = describeProgress(
      view({
        progress: {
          databaseBytes: 125_000_000,
          deltaBytes: 4_400_000,
          // Three minutes into the analysis the latest reading is a moment old,
          // not three minutes old. The earlier fixture had it stamped at the
          // session start, which is a state the sampler never produces.
          sampledAt: 1_000_000 + 184_000,
          sampleCount: 6,
        },
      }),
      1_000_000 + 185_000,
    );
    expect(shown?.elapsed).toBe('3m 05s');
    expect(shown?.size).toBe('119 MB');
    expect(shown?.delta).toBe('+4.2 MB');
    expect(shown?.working).toBe(true);
    expect(shown?.detail).toContain('no percentage');
  });

  it('says flat is flat instead of repeating the last number as progress', () => {
    const shown = describeProgress(
      view({
        progress: {
          databaseBytes: 125_000_000,
          deltaBytes: 0,
          sampledAt: 1_000_000,
          sampleCount: 7,
        },
      }),
      1_000_000,
    );
    expect(shown?.working).toBe(false);
    expect(shown?.delta).toBe('');
    expect(shown?.detail).toContain('has not grown');
  });

  it('never claims a percentage anywhere in what it shows', () => {
    // The point of the whole design. If someone adds a bar, this fails.
    const shown = describeProgress(
      view({
        progress: {
          databaseBytes: 1_000,
          deltaBytes: 100,
          sampledAt: 1,
          sampleCount: 2,
        },
      }),
      1_000_000,
    );
    const everything = `${shown?.elapsed} ${shown?.size} ${shown?.delta} ${shown?.detail}`;
    expect(everything).not.toMatch(/\d\s*%/);
  });

  it('treats a zero-byte reading as no reading, not as a size', () => {
    // Seen on a real run: for the first couple of seconds IDA has not written
    // the database yet, so the sample is 0. Rendering that as a size produced a
    // bare "-" in the size slot, which reads as broken rather than as early.
    const shown = describeProgress(
      view({
        progress: { databaseBytes: 0, deltaBytes: 0, sampledAt: 1_000_000, sampleCount: 2 },
      }),
      1_000_000,
    );
    expect(shown?.size).toBe('');
    expect(shown?.detail).toContain('reports nothing');
  });

  it('will not re-report an old reading as growth', () => {
    // The server samples inside its readiness poll (backing off to 2s) and the
    // UI asks more often, so the same sample is read twice. Measured on a real
    // analysis: size stuck at 5.6 MB while the panel kept claiming "+2.8 MB,
    // growing" -- a stopped sampler rendered as visible progress.
    const shown = describeProgress(
      view({
        progress: {
          databaseBytes: 5_872_025,
          deltaBytes: 2_936_012,
          sampledAt: 1_000_000,
          sampleCount: 4,
        },
      }),
      1_000_000 + 20_000,
    );
    expect(shown?.working).toBe(false);
    expect(shown?.delta).toBe('');
    expect(shown?.size).toBe('5.6 MB');
    expect(shown?.detail).toContain('20s ago');
  });

  it('still reports growth from a reading that is actually current', () => {
    const shown = describeProgress(
      view({
        progress: {
          databaseBytes: 5_872_025,
          deltaBytes: 2_936_012,
          sampledAt: 1_000_000,
          sampleCount: 4,
        },
      }),
      1_000_000 + 1_200,
    );
    expect(shown?.working).toBe(true);
    expect(shown?.delta).toBe('+2.8 MB');
  });

  it('has nothing to say about a GUI session, because one is never starting', () => {
    // attachGui returns a session already 'ready' or no session at all, so a
    // starting GUI session is not a state this system can be in. The previous
    // version of this test asserted on tailored text for exactly that
    // impossible state -- green, and evidence of nothing.
    const guiStates = ['ready', 'stopped', 'failed'] as const;
    for (const state of guiStates) {
      expect(describeProgress(view({ mode: 'gui', state }), 1_000_000)).toBeNull();
    }
  });
});

describe('a progress block that is not a real measurement', () => {
  // The client casts the /sessions body straight to its view type with no
  // validation, so garbage from the wire reaches these functions unchecked. A
  // bare `<= 0` test passes NaN, which rendered as "-" and "NaNs ago".
  const GARBAGE = [
    { databaseBytes: Number.NaN, deltaBytes: 0, sampledAt: 1_000_000, sampleCount: 3 },
    { databaseBytes: 5_000_000, deltaBytes: 0, sampledAt: Number.NaN, sampleCount: 3 },
    { databaseBytes: Number.POSITIVE_INFINITY, deltaBytes: 0, sampledAt: 1, sampleCount: 3 },
  ];

  for (const [index, progress] of GARBAGE.entries()) {
    it(`falls back to the timed wording rather than rendering NaN (case ${index})`, () => {
      const shown = describeProgress(view({ progress }), 1_000_000);
      expect(shown?.size).toBe('');
      expect(shown?.delta).toBe('');
      expect(`${shown?.elapsed} ${shown?.detail}`).not.toContain('NaN');
    });
  }

  it('renders no NaN out of formatElapsed either', () => {
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

describe('formatElapsed', () => {
  it('reads naturally on both sides of a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(3_725_000)).toBe('62m 05s');
  });

  it('does not render a negative clock skew as a huge number', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});
