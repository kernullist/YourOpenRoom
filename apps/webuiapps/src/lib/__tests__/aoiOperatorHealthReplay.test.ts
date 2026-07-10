import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAoiOperatorHealthReplayScenarios,
  buildAoiOperatorHealthState,
  toAoiOperatorHealthReplayScenario,
} from '../aoiOperatorHealthServer';
import type { AoiReplayReport } from '../aoiOperatorReplay';

function replayReport(partial: Partial<AoiReplayReport>): AoiReplayReport {
  return {
    version: 1,
    fixtureId: 'fx',
    title: 'Fixture',
    sessionPath: 'aoi/default',
    generatedAt: 1,
    passed: true,
    summary: 'ok',
    metrics: [],
    selectedSourceLabels: [],
    attentionDecisionLabels: [],
    generatedProposalLabels: [],
    blockedReasonLabels: [],
    preferenceConflictLabels: [],
    digestSummary: '',
    commandExecutionCount: 0,
    mutationAttemptCount: 0,
    ...partial,
  };
}

describe('toAoiOperatorHealthReplayScenario (P5.3)', () => {
  it('maps a passing report to a non-failed scenario', () => {
    const scenario = toAoiOperatorHealthReplayScenario(
      replayReport({ fixtureId: 'happy', passed: true, summary: 'all good' }),
    );
    expect(scenario).toEqual({
      fixtureId: 'happy',
      failed: false,
      summary: 'all good',
      evidenceRefs: ['replay:happy'],
    });
  });

  it('maps a non-passing report to a failed scenario', () => {
    const scenario = toAoiOperatorHealthReplayScenario(
      replayReport({ fixtureId: 'broken', passed: false, summary: 'regressed' }),
    );
    expect(scenario.failed).toBe(true);
    expect(scenario.evidenceRefs).toEqual(['replay:broken']);
  });
});

describe('buildAoiOperatorHealthReplayScenarios (P5.3)', () => {
  it('runs the built-in fixtures and adapts them to health scenarios', () => {
    const scenarios = buildAoiOperatorHealthReplayScenarios();
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(typeof scenario.fixtureId).toBe('string');
      expect(typeof scenario.failed).toBe('boolean');
      expect(scenario.evidenceRefs?.[0]).toBe(`replay:${scenario.fixtureId}`);
    }
  });
});

describe('buildAoiOperatorHealthState replay wiring (P5.3)', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'aoi-op-health-replay-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('raises a replay_scenario_failed blocker when a fed replay scenario failed', () => {
    const state = buildAoiOperatorHealthState({
      sessionsDir,
      sessionPath: 'aoi/default',
      configFile: join(sessionsDir, 'config.json'),
      now: 1_800_000_000_000,
      replayScenarios: [
        { fixtureId: 'regressed-fixture', failed: true, summary: 'A replay regression.' },
      ],
    });
    const serialized = JSON.stringify(state);
    expect(serialized).toContain('replay_scenario_failed');
    expect(serialized).toContain('regressed-fixture');
  });

  it('does not raise a replay blocker when the fed scenarios all passed', () => {
    const state = buildAoiOperatorHealthState({
      sessionsDir,
      sessionPath: 'aoi/default',
      configFile: join(sessionsDir, 'config.json'),
      now: 1_800_000_000_000,
      replayScenarios: [{ fixtureId: 'green-fixture', failed: false, summary: 'ok' }],
    });
    expect(JSON.stringify(state)).not.toContain('replay_scenario_failed');
  });
});
