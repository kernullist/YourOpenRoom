import { describe, expect, it } from 'vitest';
import {
  buildAoiJarvisReadinessScorecard,
  type AoiJarvisReadinessScorecard,
} from '../aoiJarvisReadinessScorecard';
import type {
  AoiClosedLoopCapabilityMetric,
  AoiClosedLoopMetricsReport,
} from '../aoiClosedLoopMetrics';

const NOW = 1_800_000_000_000;
const SESSION = 'aoi/default';

function overall(part: Partial<AoiClosedLoopCapabilityMetric>): AoiClosedLoopCapabilityMetric {
  return {
    capability: 'general',
    sampleSize: 20,
    accepted: 16,
    dismissed: 4,
    corrections: 0,
    executions: 12,
    proposalPrecision: null,
    interruptionPrecision: null,
    actionSuccessRate: null,
    memoryRecallQuality: null,
    recallMiss: 0,
    evidenceRefs: ['decision:d1'],
    ...part,
  };
}

function report(part: Partial<AoiClosedLoopCapabilityMetric>): AoiClosedLoopMetricsReport {
  return {
    version: 1,
    sessionPath: SESSION,
    generatedAt: NOW,
    windowMs: 30 * 24 * 60 * 60 * 1000,
    minSample: 3,
    overall: overall(part),
    capabilities: [],
    evidenceRefs: ['decision:d1'],
  };
}

function build(closedLoopMetrics?: AoiClosedLoopMetricsReport | null): AoiJarvisReadinessScorecard {
  return buildAoiJarvisReadinessScorecard({ sessionPath: SESSION, now: NOW, closedLoopMetrics });
}

function gateStatus(card: AoiJarvisReadinessScorecard, id: string): string | undefined {
  return card.gates.find((g) => g.id === id)?.status;
}

describe('scorecard closed-loop wiring — backward compatibility', () => {
  it('adds no capability group or gates when no closed-loop metrics are supplied', () => {
    const card = build(undefined);
    expect(card.metricGroups.some((g) => g.group === 'capability_precision')).toBe(false);
    expect(card.gates.some((g) => g.id.startsWith('gate.capability_'))).toBe(false);
    expect(card.metrics.some((m) => m.group === 'capability_precision')).toBe(false);
  });

  it('treats a null report the same as absent', () => {
    const card = build(null);
    expect(card.metricGroups.some((g) => g.group === 'capability_precision')).toBe(false);
  });
});

describe('scorecard closed-loop wiring — good metrics', () => {
  it('surfaces a passing capability group and passing gates', () => {
    const card = build(
      report({
        proposalPrecision: 0.95,
        actionSuccessRate: 0.9,
        interruptionPrecision: 0.92,
        memoryRecallQuality: 0.95,
      }),
    );
    expect(card.metricGroups.some((g) => g.group === 'capability_precision')).toBe(true);
    expect(card.metrics.filter((m) => m.group === 'capability_precision')).toHaveLength(4);
    expect(
      card.metrics.filter((m) => m.group === 'capability_precision').every((m) => m.passed),
    ).toBe(true);
    expect(gateStatus(card, 'gate.capability_proposal_precision')).toBe('pass');
    expect(gateStatus(card, 'gate.capability_action_success')).toBe('pass');
    expect(gateStatus(card, 'gate.capability_interruption_precision')).toBe('pass');
    expect(gateStatus(card, 'gate.capability_memory_recall')).toBe('pass');
    expect(card.modeRecommendation).not.toBe('tighten_or_rollback');
  });
});

describe('scorecard closed-loop wiring — below floor blocks trust', () => {
  it('blocks the gate, forces gateStatus blocked, and prevents trust increase', () => {
    const card = build(
      report({
        proposalPrecision: 0.4, // below floor 0.6
        actionSuccessRate: 0.95,
        interruptionPrecision: 0.95,
        memoryRecallQuality: 0.95,
      }),
    );
    expect(gateStatus(card, 'gate.capability_proposal_precision')).toBe('block');
    expect(card.gateStatus).toBe('blocked');
    expect(card.canIncreaseTrust).toBe(false);
    // The capability block gate is in the hard-safety set, so mode recommends rollback.
    expect(card.modeRecommendation).toBe('tighten_or_rollback');
    // The blocking gate contributes a blocker ref.
    expect(card.blockerRefs).toContain('gate.capability_proposal_precision');
  });

  it('blocks on each rate dimension independently', () => {
    expect(
      gateStatus(build(report({ actionSuccessRate: 0.3 })), 'gate.capability_action_success'),
    ).toBe('block');
    expect(
      gateStatus(
        build(report({ interruptionPrecision: 0.3 })),
        'gate.capability_interruption_precision',
      ),
    ).toBe('block');
    expect(
      gateStatus(build(report({ memoryRecallQuality: 0.4 })), 'gate.capability_memory_recall'),
    ).toBe('block');
  });
});

describe('scorecard closed-loop wiring — warning band and samples', () => {
  it('warns (not blocks) between floor and target', () => {
    const card = build(report({ proposalPrecision: 0.7 })); // >=0.6 floor, <0.8 target
    expect(gateStatus(card, 'gate.capability_proposal_precision')).toBe('warning');
    const metric = card.metrics.find((m) => m.id === 'capability.proposal_precision');
    expect(metric?.passed).toBe(false);
  });

  it('does not gate or emit a metric when the sample is insufficient (null rate)', () => {
    const card = build(report({ proposalPrecision: null }));
    expect(gateStatus(card, 'gate.capability_proposal_precision')).toBe('pass');
    expect(card.metrics.some((m) => m.id === 'capability.proposal_precision')).toBe(false);
    // All rates null -> no capability metrics -> group omitted entirely.
    expect(card.metricGroups.some((g) => g.group === 'capability_precision')).toBe(false);
  });

  it('warns on a high recall-miss volume without blocking', () => {
    const card = build(report({ proposalPrecision: 0.95, recallMiss: 7 }));
    expect(gateStatus(card, 'gate.capability_recall_miss')).toBe('warning');
    // recall-miss is a warning gate, so on its own it must not block.
    const card2 = build(report({ proposalPrecision: 0.95, recallMiss: 0 }));
    expect(gateStatus(card2, 'gate.capability_recall_miss')).toBe('pass');
  });
});
