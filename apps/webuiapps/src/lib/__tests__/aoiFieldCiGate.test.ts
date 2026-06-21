import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyAoiFieldCiChangedFile,
  formatAoiFieldCiGateReport,
  runAoiFieldCiGate,
} from '../aoiFieldCiGate';
import { runAoiFieldGroundedJarvisAcceptancePack } from '../aoiFieldGroundedJarvisAcceptancePack';

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Aoi Field CI Gate', () => {
  it('skips the heavy autonomy gate for docs local and AGENTS-only changes', () => {
    const report = runAoiFieldCiGate({
      changedFiles: [
        'docs/aoi-jarvis-real-field-operations-goal-21-field-ci-gate.local.md',
        'AGENTS.md',
      ],
      now: NOW,
    });

    expect(report.status).toBe('skipped');
    expect(report.passed).toBe(true);
    expect(report.gateRequired).toBe(false);
    expect(report.requiredTargetedTests).toEqual([]);
    expect(report.requiredTestCommands).toEqual([]);
    expect(report.skippedReason).toContain('docs/*.local.md');
    expect(report.fieldGroundedAcceptance.status).toBe('skipped');
    expect(report.privateLeakCount).toBe(0);
    expect(report.unauthorizedMutationCount).toBe(0);
    expect(report.staleCurrentClaimCount).toBe(0);
  });

  it('classifies changed autonomy files and computes the targeted test matrix', () => {
    const changedFiles = [
      'apps/webuiapps/src/lib/aoiOutcomeLearning.ts',
      'apps/webuiapps/src/lib/aoiAutonomyPlugin.ts',
      'apps/webuiapps/src/lib/aoiJarvisReadinessScorecard.ts',
      'apps/webuiapps/src/lib/aoiFieldGroundedJarvisAcceptancePack.ts',
      'apps/webuiapps/src/lib/aoiOperatorFlightRecorder.ts',
    ];
    const report = runAoiFieldCiGate({
      changedFiles,
      now: NOW,
      runAcceptancePack: false,
    });
    const classes = report.changedFileClasses.map((item) => item.className);

    expect(classes).toEqual(
      expect.arrayContaining([
        'autonomy_core',
        'client_api',
        'field_feedback_learning',
        'field_grounded_acceptance',
        'operator_trace',
        'readiness_gate',
      ]),
    );
    expect(report.gateRequired).toBe(true);
    expect(report.requiredTargetedTests).toEqual(
      expect.arrayContaining([
        'src/lib/__tests__/aoiFieldCiGate.test.ts',
        'src/lib/__tests__/aoiFieldGroundedJarvisAcceptancePack.test.ts',
        'src/lib/__tests__/aoiOutcomeLearning.test.ts',
        'src/lib/__tests__/aoiAutonomyClient.test.ts',
        'src/lib/__tests__/aoiAutonomyPlugin.test.ts',
        'src/lib/__tests__/aoiJarvisReadinessScorecard.test.ts',
        'src/lib/__tests__/aoiOperatorFlightRecorder.test.ts',
      ]),
    );
    expect(report.requiredTestCommands.map((command) => command.id)).toEqual([
      'field-ci.targeted-vitest',
      'field-ci.touched-eslint',
      'field-ci.build-test',
    ]);
    expect(report.fieldGroundedAcceptance.status).toBe('skipped');
    expect(report.status).toBe('fail');
  });

  it('fails the regression gate when field-grounded hard-fail counts increase', () => {
    const acceptance = runAoiFieldGroundedJarvisAcceptancePack({ now: NOW });
    const report = runAoiFieldCiGate({
      changedFiles: ['apps/webuiapps/src/lib/aoiAutonomyEvaluation.ts'],
      now: NOW,
      acceptanceReport: {
        ...acceptance,
        passed: false,
        privateLeakCount: 1,
        failedScenarioCount: 1,
        passedScenarioCount: acceptance.passedScenarioCount - 1,
      },
    });

    expect(report.status).toBe('fail');
    expect(report.passed).toBe(false);
    expect(report.privateLeakCount).toBe(1);
    expect(report.fieldGroundedAcceptance.hardFailCounts.observedHardFailCount).toBeGreaterThan(0);
    expect(formatAoiFieldCiGateReport(report)).toContain('hard_fail_counts private=1');
  });

  it('proves the gate itself does not perform live connector, network, or mutation work', () => {
    const fetchMock = vi.fn(() => {
      throw new Error('Field CI gate must not call fetch.');
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = runAoiFieldCiGate({
      changedFiles: ['apps/webuiapps/src/lib/aoiAutonomyPolicy.ts'],
      now: NOW,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.status).toBe('pass');
    expect(report.gateMutationCount).toBe(0);
    expect(report.gateLiveOperationCounts).toEqual({
      shell: 0,
      network: 0,
      gmail: 0,
      calendar: 0,
      kiraMutation: 0,
    });
    expect(report.liveOperationCounts).toEqual({
      shell: 0,
      network: 0,
      gmail: 0,
      calendar: 0,
      kiraMutation: 0,
    });
    expect(report.fieldGroundedAcceptance.syntheticBoundary).toContain(
      'Local deterministic replay only',
    );
  });

  it('keeps command generation shell-injection-safe by using fixed args arrays', () => {
    const maliciousPath = 'apps/webuiapps/src/lib/aoiAutonomyPolicy.ts; echo pwned';
    const report = runAoiFieldCiGate({
      changedFiles: [maliciousPath],
      now: NOW,
      runAcceptancePack: false,
    });
    const serializedCommands = JSON.stringify(report.requiredTestCommands);

    expect(classifyAoiFieldCiChangedFile(maliciousPath).gateRelevant).toBe(true);
    expect(serializedCommands).not.toContain('echo pwned');
    expect(serializedCommands).not.toContain(';');
    expect(report.requiredTestCommands[0]?.args).toContain(
      'src/lib/__tests__/aoiFieldCiGate.test.ts',
    );
  });

  it('reports skipped command reasons when a local verifier command is unavailable', () => {
    const report = runAoiFieldCiGate({
      changedFiles: ['apps/webuiapps/src/lib/aoiFieldFeedbackLearning.ts'],
      now: NOW,
      runAcceptancePack: false,
      commandAvailability: {
        vitest: false,
      },
    });

    const vitest = report.requiredTestCommands.find(
      (command) => command.id === 'field-ci.targeted-vitest',
    );

    expect(vitest?.status).toBe('skipped');
    expect(vitest?.skippedReason).toContain('Vitest');
    expect(formatAoiFieldCiGateReport(report)).toContain('skipped: Vitest');
  });
});
