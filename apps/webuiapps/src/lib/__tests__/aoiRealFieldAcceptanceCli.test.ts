import { describe, expect, it, vi } from 'vitest';
import {
  AOI_REAL_FIELD_EXIT_NOT_READY,
  AOI_REAL_FIELD_EXIT_READY,
  AOI_REAL_FIELD_EXIT_RUN_ERROR,
  resolveAoiRealFieldSessionsDir,
  runAoiRealFieldAcceptanceCli,
  type AoiRealFieldAcceptanceCliDeps,
} from '../aoiRealFieldAcceptanceCli';

interface FakeReport {
  passed: boolean;
}

function makeDeps(over: Partial<AoiRealFieldAcceptanceCliDeps<FakeReport>>): {
  deps: AoiRealFieldAcceptanceCliDeps<FakeReport>;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    deps: {
      argv: ['--sessions-dir', '/tmp/sessions'],
      env: {},
      runPack: async () => ({ passed: true }),
      formatReport: (report) => `report(passed=${report.passed})`,
      log: (m) => logs.push(m),
      logError: (m) => errors.push(m),
      ...over,
    },
  };
}

describe('resolveAoiRealFieldSessionsDir (P5.1)', () => {
  it('reads --sessions-dir=DIR', () => {
    expect(resolveAoiRealFieldSessionsDir(['--sessions-dir=/a/b'], {})).toBe('/a/b');
  });

  it('reads --sessions-dir DIR (separate arg) and trims', () => {
    expect(resolveAoiRealFieldSessionsDir(['--sessions-dir', '  /c/d '], {})).toBe('/c/d');
  });

  it('falls back to AOI_SESSIONS_DIR then AOI_DAEMON_SESSIONS_DIR', () => {
    expect(resolveAoiRealFieldSessionsDir([], { AOI_SESSIONS_DIR: '/e' })).toBe('/e');
    expect(resolveAoiRealFieldSessionsDir([], { AOI_DAEMON_SESSIONS_DIR: '/f' })).toBe('/f');
  });

  it('is empty when nothing is provided', () => {
    expect(resolveAoiRealFieldSessionsDir([], {})).toBe('');
  });
});

describe('runAoiRealFieldAcceptanceCli (P5.1)', () => {
  it('exits ready (0) and prints the report when the pack passes', async () => {
    const runPack = vi.fn(async () => ({ passed: true }));
    const { deps, logs } = makeDeps({ runPack });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_READY);
    expect(runPack).toHaveBeenCalledWith('/tmp/sessions');
    expect(logs.some((line) => line.includes('report(passed=true)'))).toBe(true);
    expect(logs.some((line) => line.includes('READY'))).toBe(true);
  });

  it('exits not-ready (1) and prints the report when the pack does not pass', async () => {
    const { deps, logs, errors } = makeDeps({ runPack: async () => ({ passed: false }) });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_NOT_READY);
    expect(logs.some((line) => line.includes('report(passed=false)'))).toBe(true);
    expect(errors.some((line) => line.includes('NOT READY'))).toBe(true);
  });

  it('exits run-error (2) with a clear message when no sessions dir is given', async () => {
    const runPack = vi.fn(async () => ({ passed: true }));
    const { deps, errors } = makeDeps({ argv: [], env: {}, runPack });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_RUN_ERROR);
    expect(runPack).not.toHaveBeenCalled();
    expect(errors.some((line) => line.includes('no sessions dir given'))).toBe(true);
  });

  it('exits run-error (2) when the pack run throws', async () => {
    const { deps, errors } = makeDeps({
      runPack: async () => {
        throw new Error('replay exploded');
      },
    });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_RUN_ERROR);
    expect(errors.some((line) => line.includes('acceptance run failed'))).toBe(true);
  });
});
