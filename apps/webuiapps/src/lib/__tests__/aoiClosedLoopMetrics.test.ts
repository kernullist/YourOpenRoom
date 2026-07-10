import { describe, expect, it } from 'vitest';
import type {
  AoiOutcomeSignalRecord,
  AoiProposalAcceptActionKind,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiProposalFeedbackCategory,
} from '../aoiAutonomyTypes';
import { DEFAULT_CLOSED_LOOP_MIN_SAMPLE, buildAoiClosedLoopMetrics } from '../aoiClosedLoopMetrics';

const NOW = 1_800_000_000_000;
const SESSION = 'aoi/default';

let seq = 0;
function decision(over: {
  action: AoiProposalDecisionAction;
  actionKind?: AoiProposalAcceptActionKind;
  feedbackCategory?: AoiProposalFeedbackCategory;
  memoryIds?: string[];
  proposalId?: string;
  id?: string;
  createdAt?: number;
}): AoiProposalDecision {
  seq += 1;
  return {
    version: 1,
    id: over.id ?? `d${seq}`,
    proposalId: over.proposalId ?? `p${seq}`,
    sessionPath: SESSION,
    cooldownKey: 'c',
    action: over.action,
    actor: 'user',
    createdAt: over.createdAt ?? NOW,
    previousStatus: 'active',
    nextStatus: 'active',
    ...(over.actionKind ? { actionKind: over.actionKind } : {}),
    ...(over.feedbackCategory ? { feedbackCategory: over.feedbackCategory } : {}),
    ...(over.memoryIds ? { memoryIds: over.memoryIds } : {}),
    evidenceRefs: ['e'],
  };
}

// The aggregator only reads outcomeKind/result/source*/createdAt, so cast a
// minimal shape rather than construct the full learning-adjustment tree.
function outcome(over: {
  outcomeKind: AoiOutcomeSignalRecord['outcomeKind'];
  result?: AoiOutcomeSignalRecord['result'];
  sourceDecisionId?: string;
  sourceProposalId?: string;
  createdAt?: number;
  id?: string;
}): AoiOutcomeSignalRecord {
  seq += 1;
  return {
    version: 1,
    id: over.id ?? `o${seq}`,
    sessionPath: SESSION,
    eventId: `ev${seq}`,
    outcomeKind: over.outcomeKind,
    result: over.result ?? 'neutral',
    createdAt: over.createdAt ?? NOW,
    evidenceRefs: [],
    ...(over.sourceDecisionId ? { sourceDecisionId: over.sourceDecisionId } : {}),
    ...(over.sourceProposalId ? { sourceProposalId: over.sourceProposalId } : {}),
  } as unknown as AoiOutcomeSignalRecord;
}

function build(
  decisions: AoiProposalDecision[],
  outcomes: AoiOutcomeSignalRecord[] = [],
  extra: Partial<Parameters<typeof buildAoiClosedLoopMetrics>[0]> = {},
) {
  return buildAoiClosedLoopMetrics({
    sessionPath: SESSION,
    decisions,
    outcomes,
    now: NOW,
    ...extra,
  });
}

describe('buildAoiClosedLoopMetrics — empty / shape', () => {
  it('returns null rates and no capabilities for empty telemetry', () => {
    const report = build([], []);
    expect(report.version).toBe(1);
    expect(report.sessionPath).toBe(SESSION);
    expect(report.capabilities).toEqual([]);
    expect(report.overall.sampleSize).toBe(0);
    expect(report.overall.proposalPrecision).toBeNull();
    expect(report.overall.interruptionPrecision).toBeNull();
    expect(report.overall.actionSuccessRate).toBeNull();
    expect(report.overall.memoryRecallQuality).toBeNull();
  });
});

describe('proposalPrecision', () => {
  it('counts good accepts, correctness-failure feedback, and linked corrections', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'save_memory', id: 'good' }),
      decision({ action: 'accept', actionKind: 'save_memory', feedbackCategory: 'wrong_memory' }),
      decision({ action: 'accept', actionKind: 'save_memory', id: 'corrected', proposalId: 'pc' }),
    ];
    const outcomes = [outcome({ outcomeKind: 'user_correction', sourceDecisionId: 'corrected' })];
    const report = build(decisions, outcomes);
    const save = report.capabilities.find((c) => c.capability === 'save_memory');
    expect(save?.accepted).toBe(3);
    // 1 good of 3 accepts.
    expect(save?.proposalPrecision).toBeCloseTo(0.3333, 3);
    expect(save?.corrections).toBe(1);
  });

  it('links a correction by proposalId as well as decisionId', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'start_research', proposalId: 'pr', id: 'dr' }),
      decision({ action: 'accept', actionKind: 'start_research' }),
      decision({ action: 'accept', actionKind: 'start_research' }),
    ];
    const outcomes = [outcome({ outcomeKind: 'user_correction', sourceProposalId: 'pr' })];
    const report = build(decisions, outcomes);
    const research = report.capabilities.find((c) => c.capability === 'start_research');
    expect(research?.proposalPrecision).toBeCloseTo(0.6667, 3); // 2 good of 3
  });

  it('is null when accepts are below the minimum sample', () => {
    const report = build([
      decision({ action: 'accept', actionKind: 'save_memory' }),
      decision({ action: 'accept', actionKind: 'save_memory' }),
    ]);
    expect(report.capabilities[0].proposalPrecision).toBeNull(); // 2 < minSample(3)
  });
});

describe('interruptionPrecision', () => {
  it('penalizes too_much / too_frequent / wrong_timing across all surfaced decisions', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'open_app' }),
      decision({ action: 'dismiss', actionKind: 'open_app', feedbackCategory: 'too_much' }),
      decision({ action: 'dismiss', actionKind: 'open_app', feedbackCategory: 'too_frequent' }),
      decision({ action: 'accept', actionKind: 'open_app', feedbackCategory: 'wrong_timing' }),
      decision({ action: 'accept', actionKind: 'open_app' }),
    ];
    const report = build(decisions);
    const openApp = report.capabilities.find((c) => c.capability === 'open_app');
    expect(openApp?.sampleSize).toBe(5);
    expect(openApp?.interruptionPrecision).toBeCloseTo(0.4, 3); // (5-3)/5
  });
});

describe('actionSuccessRate', () => {
  it('tallies execution outcomes and attributes them to the deciding capability', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'run_command', id: 'rc1', proposalId: 'prc1' }),
      decision({ action: 'accept', actionKind: 'run_command', id: 'rc2', proposalId: 'prc2' }),
      decision({ action: 'accept', actionKind: 'run_command', id: 'rc3', proposalId: 'prc3' }),
    ];
    const outcomes = [
      outcome({ outcomeKind: 'validation_run', result: 'positive', sourceDecisionId: 'rc1' }),
      outcome({ outcomeKind: 'commit_created', result: 'neutral', sourceProposalId: 'prc2' }),
      outcome({ outcomeKind: 'work_order_rejected', result: 'failed', sourceDecisionId: 'rc3' }),
    ];
    const report = build(decisions, outcomes);
    const runCommand = report.capabilities.find((c) => c.capability === 'run_command');
    expect(runCommand?.executions).toBe(3);
    // validation positive + commit_created(non-failed) = 2 success of 3.
    expect(runCommand?.actionSuccessRate).toBeCloseTo(0.6667, 3);
  });

  it('attributes unlinked execution outcomes to the general bucket', () => {
    const outcomes = [
      outcome({ outcomeKind: 'validation_run', result: 'positive' }),
      outcome({ outcomeKind: 'validation_run', result: 'failed' }),
      outcome({ outcomeKind: 'validation_run', result: 'positive' }),
    ];
    const report = build([], outcomes);
    const general = report.capabilities.find((c) => c.capability === 'general');
    expect(general?.executions).toBe(3);
    expect(general?.actionSuccessRate).toBeCloseTo(0.6667, 3);
  });
});

describe('memoryRecallQuality', () => {
  it('scores memory-citing decisions by wrong_memory / stale feedback', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'save_memory', memoryIds: ['m1'] }),
      decision({
        action: 'accept',
        actionKind: 'save_memory',
        memoryIds: ['m2'],
        feedbackCategory: 'stale',
      }),
      decision({ action: 'dismiss', actionKind: 'save_memory', memoryIds: ['m3'] }),
      decision({ action: 'accept', actionKind: 'save_memory' }), // no memory cited
    ];
    const report = build(decisions);
    const save = report.capabilities.find((c) => c.capability === 'save_memory');
    // 3 memory-citing, 1 bad -> (3-1)/3
    expect(save?.memoryRecallQuality).toBeCloseTo(0.6667, 3);
  });
});

describe('terminal-per-proposal + window', () => {
  it('keeps only the latest decision per proposal', () => {
    const decisions = [
      decision({
        action: 'snooze',
        actionKind: 'create_kira_work',
        proposalId: 'pk',
        id: 'early',
        createdAt: NOW - 1000,
      }),
      decision({
        action: 'accept',
        actionKind: 'create_kira_work',
        proposalId: 'pk',
        id: 'late',
        createdAt: NOW,
      }),
    ];
    const report = build(decisions);
    const kira = report.capabilities.find((c) => c.capability === 'create_kira_work');
    expect(kira?.sampleSize).toBe(1);
    expect(kira?.accepted).toBe(1);
  });

  it('excludes records older than the window', () => {
    const decisions = [
      decision({
        action: 'accept',
        actionKind: 'save_memory',
        createdAt: NOW - 40 * 24 * 60 * 60 * 1000,
      }),
      decision({ action: 'accept', actionKind: 'save_memory', createdAt: NOW }),
    ];
    const report = build(decisions, [], { windowMs: 30 * 24 * 60 * 60 * 1000 });
    expect(report.overall.sampleSize).toBe(1);
  });
});

describe('capability keying, recallMiss, overall rollup', () => {
  it('buckets decisions without an action kind under general', () => {
    const report = build([
      decision({ action: 'accept' }),
      decision({ action: 'dismiss', feedbackCategory: 'not_useful' }),
    ]);
    expect(report.capabilities.every((c) => c.capability === 'general')).toBe(true);
  });

  it('injects recallMiss per capability and sums it into overall', () => {
    const report = build([decision({ action: 'accept', actionKind: 'save_memory' })], [], {
      recallMissByCapability: { save_memory: 2, start_research: 1 },
    });
    expect(report.capabilities.find((c) => c.capability === 'save_memory')?.recallMiss).toBe(2);
    expect(report.overall.recallMiss).toBe(3);
  });

  it('rolls all decisions and executions into overall and sorts capabilities by volume', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'save_memory' }),
      decision({ action: 'accept', actionKind: 'save_memory' }),
      decision({ action: 'accept', actionKind: 'save_memory' }),
      decision({ action: 'accept', actionKind: 'open_app' }),
    ];
    const report = build(decisions);
    expect(report.overall.sampleSize).toBe(4);
    expect(report.overall.accepted).toBe(4);
    // save_memory (3) sorts before open_app (1).
    expect(report.capabilities[0].capability).toBe('save_memory');
    expect(report.capabilities[1].capability).toBe('open_app');
  });

  it('honors a custom minSample and default constant', () => {
    const decisions = Array.from({ length: DEFAULT_CLOSED_LOOP_MIN_SAMPLE }, () =>
      decision({ action: 'accept', actionKind: 'save_memory' }),
    );
    const report = build(decisions, [], { minSample: 1 });
    expect(report.minSample).toBe(1);
    expect(report.capabilities[0].proposalPrecision).toBeCloseTo(1, 5);
  });
});

describe('edge branches', () => {
  it('treats a block action as a dismissal', () => {
    const report = build([decision({ action: 'block', actionKind: 'run_command' })]);
    expect(report.capabilities[0].dismissed).toBe(1);
    expect(report.capabilities[0].accepted).toBe(0);
  });

  it('counts a terminal snooze as neither accept nor dismiss', () => {
    const report = build([decision({ action: 'snooze', actionKind: 'open_app' })]);
    expect(report.capabilities[0].sampleSize).toBe(1);
    expect(report.capabilities[0].accepted).toBe(0);
    expect(report.capabilities[0].dismissed).toBe(0);
  });

  it('ignores out-of-window and non-execution / neutral outcomes', () => {
    const decisions = [
      decision({ action: 'accept', actionKind: 'run_command', id: 'rc', proposalId: 'prc' }),
    ];
    const outcomes = [
      outcome({
        outcomeKind: 'validation_run',
        result: 'positive',
        sourceDecisionId: 'rc',
        createdAt: NOW - 40 * 24 * 60 * 60 * 1000,
      }), // old -> excluded
      outcome({ outcomeKind: 'proposal_opened', result: 'positive', sourceDecisionId: 'rc' }), // non-execution -> ignored
      outcome({ outcomeKind: 'validation_run', result: 'neutral', sourceDecisionId: 'rc' }), // neither success nor failure
    ];
    const report = build(decisions, outcomes, { windowMs: 30 * 24 * 60 * 60 * 1000 });
    const runCommand = report.capabilities.find((c) => c.capability === 'run_command');
    expect(runCommand?.executions).toBe(0); // old excluded, opened ignored, neutral is neither
  });

  it('caps evidence refs at the per-capability maximum', () => {
    const decisions = Array.from({ length: 15 }, () =>
      decision({ action: 'accept', actionKind: 'save_memory' }),
    );
    const report = build(decisions);
    expect(report.capabilities[0].evidenceRefs.length).toBe(12);
  });

  it('keeps the latest of three decisions for one proposal', () => {
    const decisions = [
      decision({
        action: 'snooze',
        actionKind: 'save_memory',
        proposalId: 'p',
        createdAt: NOW - 2000,
      }),
      decision({ action: 'accept', actionKind: 'save_memory', proposalId: 'p', createdAt: NOW }),
      decision({
        action: 'dismiss',
        actionKind: 'save_memory',
        proposalId: 'p',
        createdAt: NOW - 1000,
      }),
    ];
    const report = build(decisions);
    expect(report.overall.sampleSize).toBe(1);
    expect(report.overall.accepted).toBe(1); // the NOW accept wins
  });

  it('defaults now to wall clock when omitted', () => {
    const report = buildAoiClosedLoopMetrics({ sessionPath: SESSION, decisions: [], outcomes: [] });
    expect(report.generatedAt).toBeGreaterThan(0);
  });

  it('breaks capability sort ties by name', () => {
    const report = build([
      decision({ action: 'accept', actionKind: 'save_memory' }),
      decision({ action: 'accept', actionKind: 'open_app' }),
    ]);
    // equal sampleSize (1) and executions (0) -> alphabetical: open_app before save_memory
    expect(report.capabilities.map((c) => c.capability)).toEqual(['open_app', 'save_memory']);
  });

  it('tolerates an undefined recallMiss value', () => {
    const report = build([decision({ action: 'accept', actionKind: 'save_memory' })], [], {
      recallMissByCapability: { save_memory: undefined },
    });
    expect(report.overall.recallMiss).toBe(0);
  });
});
