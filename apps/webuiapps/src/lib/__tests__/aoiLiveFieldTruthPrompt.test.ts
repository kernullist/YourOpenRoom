import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AoiNonVoiceJarvisScorecard } from '../aoiNonVoiceJarvisScorecard';
import {
  buildAoiLiveFieldTruthPrompt,
  loadAoiLiveFieldTruth,
  shouldLoadAoiLiveFieldTruth,
  verifyAoiLiveFieldArtifactFacts,
} from '../aoiLiveFieldTruthPrompt';

function buildScorecard(): AoiNonVoiceJarvisScorecard {
  const axes = [
    ['runtime_reliability', 10, 8],
    ['situation_grounding', 15, 9],
    ['memory_personalization', 15, 9],
    ['cognition_goal_continuity', 15, 9],
    ['action_validation_recovery', 20, 12],
    ['proactive_usefulness', 10, 5],
    ['outcome_learning_calibration', 10, 5],
    ['operator_field_truth', 5, 3.2],
  ] as const;
  const hardGates = [
    ['gate.safety_integrity', true],
    ['gate.canonical_session', true],
    ['gate.live_evidence_class', true],
    ['gate.real_closed_loop', false],
    ['gate.rollback_recovery', false],
    ['gate.cognition_grounding', false],
    ['gate.manifest_integrity', false],
    ['gate.broad_validation', false],
    ['gate.axis_minimum_evidence', false],
  ] as const;

  return {
    version: 1,
    id: 'scorecard-test',
    sessionPath: 'aoi/space_adventure',
    generatedAt: 1_700_000_000_000,
    lastValidatedAt: 1_700_000_000_000,
    evidenceClass: 'live_field',
    manifestFingerprint: 'a'.repeat(64),
    voiceExcluded: true,
    rawScore: 60.2,
    score: 60.2,
    scoreCap: 89,
    level: 'developing',
    claimEligible: false,
    axes: axes.map(([id, weight, score], index) => ({
      version: 1,
      id,
      label: id,
      weight,
      rawScore: score,
      score,
      minimumEvidenceMet: index === 0,
      sampleCount: 1,
      evidenceRefs: [],
      blockers: index === 0 ? [] : [`${id} blocker`],
      nextEvidenceAction: `collect ${id} evidence`,
    })),
    hardGates: hardGates.map(([id, passed]) => ({
      version: 1,
      id,
      label: id,
      passed,
      reason: passed ? 'passed' : `${id} failed`,
      evidenceRefs: [],
    })),
    failedHardGateIds: hardGates.filter(([, passed]) => !passed).map(([id]) => id),
    recommendations: ['collect live evidence'],
    evidenceRefs: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

describe('aoiLiveFieldTruthPrompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects current non-voice scorecard requests without matching unrelated Aoi chat', () => {
    expect(shouldLoadAoiLiveFieldTruth('현재 live-field 점수와 hard gate를 정리해줘')).toBe(true);
    expect(shouldLoadAoiLiveFieldTruth('How close is Aoi to JARVIS now?')).toBe(true);
    expect(shouldLoadAoiLiveFieldTruth('Aoi에게 음악을 틀어 달라고 해줘')).toBe(false);
  });

  it('marks the canonical snapshot as authoritative over historical documents', () => {
    const prompt = buildAoiLiveFieldTruthPrompt(buildScorecard());

    expect(prompt).toContain('Current score: 60.2/100');
    expect(prompt).toContain('level=developing');
    expect(prompt).toContain('gate.real_closed_loop');
    expect(prompt).toContain('overrides older progress-ledger or document values');
  });

  it('loads and validates the canonical live-field response', async () => {
    const scorecard = buildScorecard();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          sessionPath: scorecard.sessionPath,
          evidenceClass: 'live_field',
          scorecard,
        }),
    } as Response);

    const result = await loadAoiLiveFieldTruth(scorecard.sessionPath, { timeoutMs: 1_000 });

    expect(result.scorecard.score).toBe(60.2);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain(
      '/api/aoi-autonomy/operator/non-voice-scorecard?',
    );
  });

  it('verifies current score, judgment, and every failed gate in artifact content', () => {
    const scorecard = buildScorecard();
    const complete = [
      'score 60.2',
      'level developing',
      'claimEligible false',
      ...scorecard.failedHardGateIds,
    ].join('\n');

    expect(verifyAoiLiveFieldArtifactFacts(complete, scorecard)).toEqual([]);
    expect(
      verifyAoiLiveFieldArtifactFacts(
        [
          '## Score & Judgment',
          '60.2/100',
          '## Current Judgment',
          'developing',
          'claimEligible false',
          ...scorecard.failedHardGateIds,
        ].join('\n'),
        scorecard,
      ),
    ).toEqual([]);
    expect(verifyAoiLiveFieldArtifactFacts('score 26.55', scorecard)).toContain(
      'read-back content does not contain the current score 60.2',
    );
    expect(
      verifyAoiLiveFieldArtifactFacts(
        `score 160.2\nlevel developing\nunrelated false\n${scorecard.failedHardGateIds.join('\n')}`,
        scorecard,
      ),
    ).toEqual(
      expect.arrayContaining([
        'read-back content does not contain the current score 60.2',
        'read-back content does not contain the current claimEligible value false',
      ]),
    );
    expect(
      verifyAoiLiveFieldArtifactFacts(
        `evidence sample 60.2\ndeveloping notes\nclaimEligible false\n${scorecard.failedHardGateIds.join('\n')}`,
        scorecard,
      ),
    ).toEqual(
      expect.arrayContaining([
        'read-back content does not contain the current score 60.2',
        'read-back content does not contain the current level developing',
      ]),
    );
  });
});
