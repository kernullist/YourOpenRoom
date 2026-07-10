import { describe, expect, it, vi } from 'vitest';
import {
  AOI_FIELD_CI_EXIT_GATE_FAILED,
  AOI_FIELD_CI_EXIT_OK,
  AOI_FIELD_CI_EXIT_RUN_ERROR,
  parseAoiFieldCiChangedFiles,
  resolveAoiFieldCiBaseRef,
  resolveAoiFieldCiGateExitCode,
  runAoiFieldCiGateCli,
  type AoiFieldCiGateCliDeps,
} from '../aoiFieldCiGateCli';
import type { AoiFieldCiGateReport } from '../aoiFieldCiGate';

function report(over: Partial<AoiFieldCiGateReport>): AoiFieldCiGateReport {
  return { gateRequired: true, passed: true, ...over } as AoiFieldCiGateReport;
}

describe('parseAoiFieldCiChangedFiles (P5.1)', () => {
  it('trims, drops blank lines, and tolerates CRLF', () => {
    expect(parseAoiFieldCiChangedFiles('a.ts\r\n\n  b.ts \n   \nc.ts')).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseAoiFieldCiChangedFiles('   \n\n')).toEqual([]);
  });
});

describe('resolveAoiFieldCiBaseRef (P5.1)', () => {
  it('reads --base=REF', () => {
    expect(resolveAoiFieldCiBaseRef(['--base=origin/main'], {})).toBe('origin/main');
  });

  it('reads --base REF (separate arg)', () => {
    expect(resolveAoiFieldCiBaseRef(['--base', 'develop'], {})).toBe('develop');
  });

  it('falls back to the env base then the default HEAD~1', () => {
    expect(resolveAoiFieldCiBaseRef([], { AOI_FIELD_CI_BASE: 'main' })).toBe('main');
    expect(resolveAoiFieldCiBaseRef([], {})).toBe('HEAD~1');
  });
});

describe('resolveAoiFieldCiGateExitCode (P5.1)', () => {
  it('fails only when the gate is required and did not pass', () => {
    expect(resolveAoiFieldCiGateExitCode(report({ gateRequired: true, passed: false }))).toBe(
      AOI_FIELD_CI_EXIT_GATE_FAILED,
    );
    expect(resolveAoiFieldCiGateExitCode(report({ gateRequired: true, passed: true }))).toBe(
      AOI_FIELD_CI_EXIT_OK,
    );
    // A skipped (docs-only) gate never blocks, even if passed is false.
    expect(resolveAoiFieldCiGateExitCode(report({ gateRequired: false, passed: false }))).toBe(
      AOI_FIELD_CI_EXIT_OK,
    );
  });
});

function makeDeps(over: Partial<AoiFieldCiGateCliDeps>): {
  deps: AoiFieldCiGateCliDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    deps: {
      argv: [],
      env: {},
      getChangedFiles: () => [],
      log: (m) => logs.push(m),
      logError: (m) => errors.push(m),
      now: 1_800_000_000_000,
      ...over,
    },
  };
}

describe('runAoiFieldCiGateCli (P5.1)', () => {
  it('exits 0 and reports "not required" for a docs-only change', () => {
    const { deps, logs } = makeDeps({ getChangedFiles: () => ['README.md'] });
    const code = runAoiFieldCiGateCli(deps);
    expect(code).toBe(AOI_FIELD_CI_EXIT_OK);
    expect(logs.some((line) => line.includes('not required'))).toBe(true);
  });

  it('runs the gate for an autonomy-core change and prints the report', () => {
    const getChangedFiles = vi.fn(() => ['src/lib/aoiAutonomyEvaluation.ts']);
    const { deps, logs } = makeDeps({ getChangedFiles });
    const code = runAoiFieldCiGateCli(deps);
    expect(getChangedFiles).toHaveBeenCalledOnce();
    // A required change either passes (0) or fails the gate (1) -- never the run-error 2.
    expect([AOI_FIELD_CI_EXIT_OK, AOI_FIELD_CI_EXIT_GATE_FAILED]).toContain(code);
    // The formatted report was emitted to stdout.
    expect(logs.join('\n')).toMatch(/field/i);
  });

  it('exits with the run-error code when changed-file discovery throws', () => {
    const { deps, errors } = makeDeps({
      getChangedFiles: () => {
        throw new Error('git exploded');
      },
    });
    const code = runAoiFieldCiGateCli(deps);
    expect(code).toBe(AOI_FIELD_CI_EXIT_RUN_ERROR);
    expect(errors.some((line) => line.includes('failed to resolve changed files'))).toBe(true);
  });

  it('honors the injected base ref when resolving changed files', () => {
    const getChangedFiles = vi.fn(() => ['README.md']);
    const { deps } = makeDeps({ argv: ['--base=origin/main'], getChangedFiles });
    runAoiFieldCiGateCli(deps);
    expect(getChangedFiles).toHaveBeenCalledWith('origin/main');
  });

  it('runs without an injected clock (omits now, gate uses its default)', () => {
    const { deps } = makeDeps({ getChangedFiles: () => ['README.md'], now: undefined });
    expect(runAoiFieldCiGateCli(deps)).toBe(AOI_FIELD_CI_EXIT_OK);
  });
});
