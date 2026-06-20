import { describe, expect, it } from 'vitest';
import {
  AOI_JARVIS_PROACTIVE_ACCEPTANCE_SCENARIOS,
  formatAoiJarvisProactiveAcceptanceReport,
  runAoiJarvisProactiveAcceptancePack,
} from '../aoiJarvisProactiveAcceptancePack';

describe('Aoi Jarvis proactive acceptance pack', () => {
  it('passes all synthetic proactive scenarios without live connectors or mutation', () => {
    const report = runAoiJarvisProactiveAcceptancePack();
    const text = formatAoiJarvisProactiveAcceptanceReport(report);

    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'proactive-re-interest-fresh-public-dashboard',
      'proactive-direct-chat-opt-in-strong-source',
      'proactive-quiet-mode-hides-noncritical',
      'proactive-stale-source-abstains',
      'proactive-kira-validation-safe-recovery',
      'proactive-duplicate-trend-cooldown',
      'proactive-too-frequent-feedback-lowers-direct-chat',
      'proactive-accepted-research-boosts-related-topic',
      'proactive-unsafe-command-blocks-ladder',
      'proactive-mixed-research-command-split',
    ]);
    expect(report.scenarioCount).toBe(10);
    expect(report.passed).toBe(true);
    expect(report.failedMetrics).toEqual([]);
    expect(report.nextGoalCandidates).toEqual([]);
    expect(report.mutationCount).toBe(0);
    expect(report.metrics.every((metric) => metric.mutationCount === 0)).toBe(true);
    expect(report.score).toBe(1);
    expect(report.scoreLabel).toBe('synthetic_jarvis_like_pass');
    expect(text).toContain('PASS aoi-jarvis-proactive-acceptance');
    expect(text).toContain('score=100%');
  });

  it('reports required review fields for every scenario', () => {
    const report = runAoiJarvisProactiveAcceptancePack();

    for (const scenario of report.scenarios) {
      expect(scenario.version).toBe(1);
      expect(scenario.id).toMatch(/^proactive-/);
      expect(typeof scenario.passed).toBe('boolean');
      expect(scenario.evidenceRefs.length).toBeGreaterThan(0);
      expect(scenario.mutationCount).toBe(0);
      expect(scenario.privacyState).toBe('synthetic');
      expect('failedReason' in scenario).toBe(false);
    }
  });

  it('covers usefulness, timing, evidence, non-intrusion, and safety dimensions', () => {
    const report = runAoiJarvisProactiveAcceptancePack();

    expect([...new Set(report.metrics.map((metric) => metric.dimension))].sort()).toEqual([
      'evidence_backed',
      'non_intrusive',
      'safe',
      'timely',
      'useful',
    ]);
    expect(report.metrics.map((metric) => metric.id)).toEqual(
      expect.arrayContaining([
        'opportunity.uses_re_public_source',
        'direct_chat.blocked_without_opt_in',
        'quiet_mode.hidden_noncritical',
        'stale.deliberation_blocks',
        'trend.duplicate_suppressed',
        'feedback.direct_chat_sensitivity_down',
        'learning.related_topic_boosted',
        'unsafe.blocks_l4_l5',
        'mixed.research_allowed',
        'mixed.command_blocked',
      ]),
    );
  });

  it('keeps built-in fixture definitions synthetic and replayable', () => {
    expect(AOI_JARVIS_PROACTIVE_ACCEPTANCE_SCENARIOS).toHaveLength(10);
    expect(
      AOI_JARVIS_PROACTIVE_ACCEPTANCE_SCENARIOS.every(
        (scenario) =>
          scenario.version === 1 &&
          scenario.id.startsWith('proactive-') &&
          scenario.description.length > 0,
      ),
    ).toBe(true);

    const report = runAoiJarvisProactiveAcceptancePack();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('gmail:');
    expect(serialized).not.toContain('calendar:');
  });
});
