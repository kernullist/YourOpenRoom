import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatAoiRealFieldOperationsAcceptanceReport,
  runAoiRealFieldOperationsAcceptancePack,
} from '../aoiRealFieldOperationsAcceptancePack';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/default';
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-real-field-operations-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi real-field operations acceptance pack', () => {
  it('passes 16 replay-safe scenarios without private leaks, unauthorized mutation, stale claims, or live operations', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('Real-field operations acceptance must not call live fetch.');
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await runAoiRealFieldOperationsAcceptancePack({
      sessionsDir: makeTempRoot(),
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    const formatted = formatAoiRealFieldOperationsAcceptanceReport(report);
    const serialized = JSON.stringify(report);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.passed).toBe(true);
    expect(report.scenarioCount).toBe(16);
    expect(report.passedScenarioCount).toBe(16);
    expect(report.failedScenarioCount).toBe(0);
    expect(report.failedScenarios).toEqual([]);
    expect(report.privateLeakCount).toBe(0);
    expect(report.unauthorizedMutationCount).toBe(0);
    expect(report.staleCurrentClaimCount).toBe(0);
    expect(report.mutationCount).toBe(0);
    expect(report.liveOperationCounts).toEqual({
      shell: 0,
      network: 0,
      gmail: 0,
      calendar: 0,
      kiraMutation: 0,
    });
    expect(report.readinessLevel).toBe('real_field_ready');
    expect(report.fieldCaptureCount).toBeGreaterThan(0);
    expect(report.shadowDecisionCount).toBeGreaterThan(0);
    expect(report.feedbackAdjustmentCount).toBeGreaterThan(0);
    expect(report.proactiveScoutCount).toBeGreaterThan(0);
    expect(report.capabilityDecisionCount).toBe(2);
    expect(report.outcomeSignalCount).toBe(2);
    expect(report.workOrderCount).toBe(1);
    expect(report.ciGateCommandCount).toBeGreaterThanOrEqual(3);
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'rfo-01-redacted-field-capture',
      'rfo-02-disconnected-source-blind-spot',
      'rfo-03-stale-research-blocks-current-claim',
      'rfo-04-useful-feedback-dashboard-priority',
      'rfo-05-too-frequent-lowers-direct-chat',
      'rfo-06-wrong-source-lowers-source-trust',
      'rfo-07-unsafe-feedback-blocks-escalation',
      'rfo-08-should-have-spoken-dashboard-candidate',
      'rfo-09-provider-missing-source-honesty',
      'rfo-10-budgeted-scout-dashboard-first',
      'rfo-11-capability-broker-observe-vs-mutation',
      'rfo-12-bounded-work-order-prepare-only',
      'rfo-13-outcome-learning-lower-confidence',
      'rfo-14-trace-promotion-redacted-only',
      'rfo-15-field-ci-required-tests',
      'rfo-16-end-to-end-zero-hard-fail',
    ]);
    expect(report.acceptanceTierSummaries.map((tier) => tier.tier)).toEqual([
      'synthetic',
      'field_grounded',
      'real_field_operations',
    ]);
    expect(report.readinessSummary.tierDifferenceLabels.join(' ')).toContain(
      'Real-field operations acceptance stitches capture',
    );
    expect(report.readinessSummary.directChatBoundaryLabel).toContain('dashboard-first');
    expect(
      report.scenarios.find((scenario) => scenario.id === 'rfo-15-field-ci-required-tests'),
    ).toMatchObject({
      passed: true,
      ciGateCommandCount: report.ciGateCommandCount,
    });
    expect(serialized).not.toContain('honey@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('secret123456789012');
    expect(formatted).toContain('Aoi real-field operations acceptance: pass');
    expect(formatted).toContain('hard_fail_counts private=0 unauthorized=0 stale=0 mutation=0');
    expect(formatted).toContain('live_ops shell=0 network=0 gmail=0 calendar=0 kiraMutation=0');
  });

  it('requires a replay sessions directory to avoid writing acceptance artifacts into the app tree', async () => {
    await expect(
      runAoiRealFieldOperationsAcceptancePack({
        sessionsDir: '',
        sessionPath: SESSION_PATH,
        now: NOW,
      }),
    ).rejects.toThrow('sessionsDir');
  });
});
