import { describe, expect, it, vi } from 'vitest';
import {
  AOI_REAL_FIELD_EXIT_NOT_READY,
  AOI_REAL_FIELD_EXIT_READY,
  AOI_REAL_FIELD_EXIT_RUN_ERROR,
  resolveAoiRealFieldEvidenceClass,
  resolveAoiRealFieldSessionPath,
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
      argv: [
        '--sessions-dir',
        '/tmp/sessions',
        '--session-path',
        'aoi/work',
        '--evidence-class',
        'live_field',
      ],
      env: {},
      runPack: async () => ({ passed: true }),
      formatReport: (report) => `report(passed=${report.passed})`,
      log: (message) => logs.push(message),
      logError: (message) => errors.push(message),
      ...over,
    },
  };
}

describe('Aoi field-evidence CLI option resolution', () => {
  it('reads equals-form command-line options', () => {
    const argv = [
      '--sessions-dir=/a/b',
      '--session-path=aoi/demo',
      '--evidence-class=controlled_real',
    ];
    expect(resolveAoiRealFieldSessionsDir(argv, {})).toBe('/a/b');
    expect(resolveAoiRealFieldSessionPath(argv, {})).toBe('aoi/demo');
    expect(resolveAoiRealFieldEvidenceClass(argv, {})).toBe('controlled_real');
  });

  it('reads separate command-line options and trims values', () => {
    const argv = [
      '--sessions-dir',
      '  /c/d ',
      '--session-path',
      ' aoi/work ',
      '--evidence-class',
      ' live_field ',
    ];
    expect(resolveAoiRealFieldSessionsDir(argv, {})).toBe('/c/d');
    expect(resolveAoiRealFieldSessionPath(argv, {})).toBe('aoi/work');
    expect(resolveAoiRealFieldEvidenceClass(argv, {})).toBe('live_field');
  });

  it('uses explicit environment fallbacks', () => {
    const env = {
      AOI_DAEMON_SESSIONS_DIR: '/sessions',
      AOI_REAL_FIELD_SESSION_PATH: 'aoi/live',
      AOI_FIELD_EVIDENCE_CLASS: 'live_field',
    };
    expect(resolveAoiRealFieldSessionsDir([], env)).toBe('/sessions');
    expect(resolveAoiRealFieldSessionPath([], env)).toBe('aoi/live');
    expect(resolveAoiRealFieldEvidenceClass([], env)).toBe('live_field');
  });

  it('rejects a missing or unknown evidence class', () => {
    expect(resolveAoiRealFieldEvidenceClass([], {})).toBe('');
    expect(resolveAoiRealFieldEvidenceClass(['--evidence-class', 'field-ish'], {})).toBe('');
  });
});

describe('runAoiRealFieldAcceptanceCli', () => {
  it('returns ready and passes all provenance options to the read-only scan', async () => {
    const runPack = vi.fn(async () => ({ passed: true }));
    const { deps, logs } = makeDeps({ runPack });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_READY);
    expect(runPack).toHaveBeenCalledWith({
      sessionsDir: '/tmp/sessions',
      sessionPath: 'aoi/work',
      evidenceClass: 'live_field',
    });
    expect(logs.some((line) => line.includes('report(passed=true)'))).toBe(true);
    expect(logs.some((line) => line.includes('READY'))).toBe(true);
  });

  it('returns not-ready and prints the report when evidence does not pass', async () => {
    const { deps, logs, errors } = makeDeps({ runPack: async () => ({ passed: false }) });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_NOT_READY);
    expect(logs.some((line) => line.includes('report(passed=false)'))).toBe(true);
    expect(errors.some((line) => line.includes('NOT READY'))).toBe(true);
  });

  it('fails before scanning when sessions dir, session path, or class is absent', async () => {
    for (const argv of [
      ['--session-path', 'aoi/work', '--evidence-class', 'live_field'],
      ['--sessions-dir', '/tmp/sessions', '--evidence-class', 'live_field'],
      ['--sessions-dir', '/tmp/sessions', '--session-path', 'aoi/work'],
    ]) {
      const runPack = vi.fn(async () => ({ passed: true }));
      const { deps, errors } = makeDeps({ argv, env: {}, runPack });
      const code = await runAoiRealFieldAcceptanceCli(deps);
      expect(code).toBe(AOI_REAL_FIELD_EXIT_RUN_ERROR);
      expect(runPack).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
    }
  });

  it('returns run-error when the read-only scan throws', async () => {
    const { deps, errors } = makeDeps({
      runPack: async () => {
        throw new Error('scan exploded');
      },
    });
    const code = await runAoiRealFieldAcceptanceCli(deps);
    expect(code).toBe(AOI_REAL_FIELD_EXIT_RUN_ERROR);
    expect(errors.some((line) => line.includes('read-only scan failed'))).toBe(true);
  });
});
