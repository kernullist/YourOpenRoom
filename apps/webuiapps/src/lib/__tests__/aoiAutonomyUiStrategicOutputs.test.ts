import { describe, expect, it } from 'vitest';
import { buildAoiGoalWorkOrderPreviews, buildAoiStrategicBriefPanel } from '../aoiAutonomyUi';
import { createAoiBoundedWorkOrder, type AoiBoundedWorkOrder } from '../aoiBoundedWorkOrder';
import type { AoiStrategicBrief } from '../aoiAutonomyTypes';

// Unit coverage for the P1a UI-surface display-model builders. These are PURE
// (no fs / no network / no tick), so the autonomy outputs can be exercised
// offline without a running engine -- the per-tick brief and goal work orders
// only exist on a live tickResult, but the builders that shape them for the
// Advanced-tab render do not.

const NOW = 1_700_000_000_000;

function makeBrief(overrides: Partial<AoiStrategicBrief> = {}): AoiStrategicBrief {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: NOW,
    tickReason: 'periodic',
    focusSummary: 'Pursuing: harden the kernel telemetry path',
    openThreads: ['harden the kernel telemetry path'],
    blockedThreads: ['Risky delete -- needs L5 approval'],
    recentOutcomes: ['Build green: all tests pass'],
    observationHighlights: ['Branch changed'],
    evidenceRefs: ['proposal:p1'],
    acceptedCount: 1,
    blockedCount: 1,
    observationCount: 2,
    synthesizedBy: 'deterministic',
    ...overrides,
  };
}

function makePreviewOrder(
  draft: Partial<Parameters<typeof createAoiBoundedWorkOrder>[0]> = {},
): AoiBoundedWorkOrder {
  return createAoiBoundedWorkOrder({
    sessionPath: 'aoi/default',
    objective: 'Summarize the kernel telemetry module.',
    affectedSurfaces: ['kernel telemetry surface'],
    files: ['telemetry-notes.txt'],
    modules: ['kernelTelemetry'],
    allowedOperations: ['read', 'summarize'],
    risk: { level: 'low' },
    now: NOW,
    ...draft,
  });
}

describe('buildAoiStrategicBriefPanel()', () => {
  it('collapses a null or undefined brief to a hidden empty panel', () => {
    for (const input of [null, undefined]) {
      const panel = buildAoiStrategicBriefPanel(input);
      expect(panel.visible).toBe(false);
      expect(panel.synthesizedByLabel).toBe('');
      expect(panel.tickReasonLabel).toBe('');
      expect(panel.generatedAt).toBe(0);
      expect(panel.focusSummary).toBe('');
      expect(panel.openThreadLabels).toEqual([]);
      expect(panel.blockedThreadLabels).toEqual([]);
      expect(panel.recentOutcomeLabels).toEqual([]);
      expect(panel.observationHighlightLabels).toEqual([]);
      expect(panel.countsLabel).toBe('');
      expect(panel.evidenceRefs).toEqual([]);
    }
  });

  it('exposes a deterministic brief as a visible panel', () => {
    const panel = buildAoiStrategicBriefPanel(makeBrief());
    expect(panel.visible).toBe(true);
    expect(panel.synthesizedByLabel).toBe('Deterministic focus');
    expect(panel.tickReasonLabel).toBe('periodic');
    expect(panel.generatedAt).toBe(NOW);
    expect(panel.focusSummary).toContain('harden the kernel telemetry path');
    expect(panel.openThreadLabels).toEqual(['harden the kernel telemetry path']);
    expect(panel.blockedThreadLabels).toEqual(['Risky delete -- needs L5 approval']);
    expect(panel.recentOutcomeLabels).toEqual(['Build green: all tests pass']);
    expect(panel.observationHighlightLabels).toEqual(['Branch changed']);
    expect(panel.countsLabel).toBe('1 accepted, 1 blocked, 2 observations');
    expect(panel.evidenceRefs).toEqual(['proposal:p1']);
  });

  it('labels an LLM-synthesized brief distinctly', () => {
    const panel = buildAoiStrategicBriefPanel(makeBrief({ synthesizedBy: 'llm' }));
    expect(panel.synthesizedByLabel).toBe('LLM-authored focus');
  });

  it('sanitizes whitespace, dedupes, and caps thread labels', () => {
    const panel = buildAoiStrategicBriefPanel(
      makeBrief({
        // Includes a duplicate, blank/whitespace-only entries (dropped), and more
        // than six survivors so dedupe + blank-skip + cap are all exercised.
        openThreads: [
          'alpha   beta',
          'alpha   beta',
          '',
          '   ',
          'g2',
          'g3',
          'g4',
          'g5',
          'g6',
          'g7',
        ],
      }),
    );
    // Whitespace collapsed by the shared sanitizer.
    expect(panel.openThreadLabels[0]).toBe('alpha beta');
    // Blank entries dropped; duplicate collapsed; then capped to the 6-label ceiling.
    expect(panel.openThreadLabels).not.toContain('');
    expect(panel.openThreadLabels).toHaveLength(6);
    expect(new Set(panel.openThreadLabels).size).toBe(panel.openThreadLabels.length);
  });

  it('truncates an overlong focus summary', () => {
    const panel = buildAoiStrategicBriefPanel(makeBrief({ focusSummary: 'x'.repeat(400) }));
    // The shared sanitizer caps at maxLength then appends an ellipsis, so the
    // exact length is maxLength + 2; the contract we assert is that it shrank far
    // below the input and is marked as truncated.
    expect(panel.focusSummary.length).toBeLessThan(400);
    expect(panel.focusSummary.endsWith('...')).toBe(true);
  });

  it('clamps a non-finite generatedAt to 0 and keeps a finite one', () => {
    expect(buildAoiStrategicBriefPanel(makeBrief({ generatedAt: Number.NaN })).generatedAt).toBe(0);
    expect(
      buildAoiStrategicBriefPanel(makeBrief({ generatedAt: Number.POSITIVE_INFINITY })).generatedAt,
    ).toBe(0);
    expect(buildAoiStrategicBriefPanel(makeBrief({ generatedAt: 42 })).generatedAt).toBe(42);
  });

  it('never lets negative counts surface', () => {
    const panel = buildAoiStrategicBriefPanel(
      makeBrief({ acceptedCount: -5, blockedCount: -1, observationCount: 0 }),
    );
    expect(panel.countsLabel).toBe('0 accepted, 0 blocked, 0 observations');
  });
});

describe('buildAoiGoalWorkOrderPreviews()', () => {
  it('returns an empty list for null, undefined, or empty input', () => {
    expect(buildAoiGoalWorkOrderPreviews(null)).toEqual([]);
    expect(buildAoiGoalWorkOrderPreviews(undefined)).toEqual([]);
    expect(buildAoiGoalWorkOrderPreviews([])).toEqual([]);
  });

  it('maps a bounded work order to a display-only preview', () => {
    const order = makePreviewOrder();
    const previews = buildAoiGoalWorkOrderPreviews([order]);
    expect(previews).toHaveLength(1);
    const preview = previews[0];
    expect(preview.id).toBe(order.id);
    expect(preview.displayOnly).toBe(true);
    expect(preview.objectiveLabel).toContain('Summarize the kernel telemetry module.');
    // formatAoiWorkOrderStatus replaces underscores with spaces; tie the assertion
    // to the real order so it cannot drift from the builder's policy output.
    expect(preview.statusLabel).toBe(order.status.replace(/_/g, ' '));
    expect(preview.policyStatusLabel).toBe(order.policyResult.status.replace(/_/g, ' '));
    expect(preview.riskLabel).toBe(order.risk.level);
    expect(preview.requiredLevelLabel).toBe(order.approval.requiredAutonomyLevel);
    expect(preview.allowedOperationLabels).toEqual(expect.arrayContaining(['read', 'summarize']));
    expect(preview.scopeLabels.length).toBeGreaterThan(0);
    expect(preview.scopeLabels.length).toBeLessThanOrEqual(5);
    expect(preview.evidenceRefCount).toBe(order.evidenceRefs.length);
    expect(typeof preview.approvalBoundaryLabel).toBe('string');
  });

  it('dedupes work orders by id', () => {
    const order = makePreviewOrder();
    expect(buildAoiGoalWorkOrderPreviews([order, order])).toHaveLength(1);
  });

  it('caps the preview list at the ceiling', () => {
    const base = makePreviewOrder();
    const many: AoiBoundedWorkOrder[] = Array.from({ length: 8 }, (_unused, index) => ({
      ...base,
      id: `wo-${index}`,
    }));
    expect(buildAoiGoalWorkOrderPreviews(many)).toHaveLength(6);
  });

  it('falls back to the review-requirement boundary when no exact approval is set', () => {
    const base = makePreviewOrder();
    const order: AoiBoundedWorkOrder = {
      ...base,
      policyResult: { ...base.policyResult, exactNextApproval: '' },
      reviewRequirement: {
        ...base.reviewRequirement,
        approvalBoundary: 'operator review boundary',
      },
    };
    expect(buildAoiGoalWorkOrderPreviews([order])[0].approvalBoundaryLabel).toBe(
      'operator review boundary',
    );
  });

  it('re-sanitizes the objective text independent of the builder', () => {
    const base = makePreviewOrder();
    // Inject a messy objective via spread so this proves OUR sanitizer runs, not
    // the work-order builder's own normalization.
    const messy: AoiBoundedWorkOrder = { ...base, objective: 'Inspect    the    telemetry' };
    const previews = buildAoiGoalWorkOrderPreviews([messy]);
    expect(previews[0].objectiveLabel).toBe('Inspect the telemetry');
  });
});
