import { describe, expect, it } from 'vitest';
import type {
  AoiNonVoiceJarvisAxisId,
  AoiNonVoiceJarvisScorecard,
} from '../aoiNonVoiceJarvisScorecard';
import {
  buildAoiNonVoiceScorecardRoute,
  describeAoiNonVoiceEvidenceClass,
  labelAoiNonVoiceEvidenceClass,
  parseAoiNonVoiceScorecardResponse,
  selectAoiNonVoiceNextEvidenceAction,
} from '../aoiNonVoiceScorecardPanelModel';

const SESSION_PATH = 'aoi/session-a';
const MANIFEST = 'a'.repeat(64);
const AXES: Array<[AoiNonVoiceJarvisAxisId, string, number]> = [
  ['runtime_reliability', 'Runtime reliability', 10],
  ['situation_grounding', 'Situation grounding', 15],
  ['memory_personalization', 'Memory and personalization', 15],
  ['cognition_goal_continuity', 'Cognition and goal continuity', 15],
  ['action_validation_recovery', 'Action validation and recovery', 20],
  ['proactive_usefulness', 'Proactive usefulness', 10],
  ['outcome_learning_calibration', 'Outcome learning and calibration', 10],
  ['operator_field_truth', 'Operator field truth', 5],
];
const GATE_IDS = [
  'gate.safety_integrity',
  'gate.canonical_session',
  'gate.live_evidence_class',
  'gate.real_closed_loop',
  'gate.rollback_recovery',
  'gate.cognition_grounding',
  'gate.manifest_integrity',
  'gate.broad_validation',
  'gate.axis_minimum_evidence',
];

function scorecard(
  overrides: Partial<AoiNonVoiceJarvisScorecard> = {},
): AoiNonVoiceJarvisScorecard {
  return {
    version: 1,
    id: 'scorecard-1',
    sessionPath: SESSION_PATH,
    generatedAt: 1_800_000_000_000,
    lastValidatedAt: 1_799_999_000_000,
    evidenceClass: 'live_field',
    manifestFingerprint: MANIFEST,
    voiceExcluded: true,
    rawScore: 92,
    score: 89,
    scoreCap: 89,
    level: 'blocked_high_score',
    claimEligible: false,
    axes: AXES.map(([id, label, weight]) => ({
      version: 1,
      id,
      label,
      weight,
      rawScore: weight - 1,
      score: weight - 1,
      minimumEvidenceMet: true,
      sampleCount: 5,
      evidenceRefs: [`evidence:${id}`],
      blockers: [],
      nextEvidenceAction: `Collect ${id} evidence.`,
    })),
    hardGates: GATE_IDS.map((id) => ({
      version: 1,
      id,
      label: id.replace(/^gate\./, '').replace(/_/g, ' '),
      passed: id !== 'gate.broad_validation',
      reason: id === 'gate.broad_validation' ? 'validation stale' : 'passed',
      evidenceRefs: [],
    })),
    failedHardGateIds: ['gate.broad_validation'],
    recommendations: ['Run the current broad validation suite.'],
    evidenceRefs: ['manifest:field'],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...overrides,
  };
}

function response(item = scorecard()) {
  return {
    ok: true,
    sessionPath: SESSION_PATH,
    evidenceClass: item.evidenceClass,
    scorecard: item,
  };
}

describe('Aoi non-voice scorecard panel model', () => {
  it('encodes the requested session and evidence class', () => {
    expect(buildAoiNonVoiceScorecardRoute('aoi/session one', 'controlled_real')).toBe(
      '/api/aoi-autonomy/operator/non-voice-scorecard?sessionPath=aoi%2Fsession+one&evidenceClass=controlled_real',
    );
  });

  it('accepts a canonical session- and evidence-matched response', () => {
    expect(parseAoiNonVoiceScorecardResponse(response(), SESSION_PATH, 'live_field')).toMatchObject(
      {
        requestedSessionPath: SESSION_PATH,
        resolvedSessionPath: SESSION_PATH,
        requestedEvidenceClass: 'live_field',
        resolvedEvidenceClass: 'live_field',
        scorecard: { score: 89, claimEligible: false },
      },
    );
  });

  it('rejects cross-session, cross-class, and nested provenance drift', () => {
    expect(
      parseAoiNonVoiceScorecardResponse(
        { ...response(), sessionPath: 'aoi/session-b' },
        SESSION_PATH,
        'live_field',
      ),
    ).toBeNull();
    expect(
      parseAoiNonVoiceScorecardResponse(
        { ...response(), evidenceClass: 'synthetic' },
        SESSION_PATH,
        'live_field',
      ),
    ).toBeNull();
    expect(
      parseAoiNonVoiceScorecardResponse(
        response(scorecard({ sessionPath: 'aoi/session-b' })),
        SESSION_PATH,
        'live_field',
      ),
    ).toBeNull();
  });

  it('rejects an impossible 90+ display when the server claim gate is blocked', () => {
    expect(
      parseAoiNonVoiceScorecardResponse(
        response(scorecard({ rawScore: 97, score: 97, scoreCap: 100 })),
        SESSION_PATH,
        'live_field',
      ),
    ).toBeNull();
  });

  it('preserves the canonical strict-greater-than-90 boundary', () => {
    const base = scorecard();
    const exactNinety = scorecard({
      rawScore: 90,
      score: 90,
      scoreCap: 100,
      level: 'field_capable',
      claimEligible: false,
      axes: base.axes.map((axis, index) =>
        index === 0 ? { ...axis, rawScore: axis.rawScore - 2, score: axis.score - 2 } : axis,
      ),
      hardGates: base.hardGates.map((gate) => ({ ...gate, passed: true, reason: 'passed' })),
      failedHardGateIds: [],
      recommendations: [],
    });
    expect(
      parseAoiNonVoiceScorecardResponse(response(exactNinety), SESSION_PATH, 'live_field'),
    ).not.toBeNull();
    expect(exactNinety.claimEligible).toBe(false);
  });

  it('rejects malformed axes, inconsistent gate ids, and writable payloads', () => {
    const malformedAxes = scorecard({ axes: scorecard().axes.slice(0, 7) });
    expect(
      parseAoiNonVoiceScorecardResponse(response(malformedAxes), SESSION_PATH, 'live_field'),
    ).toBeNull();
    const inconsistentGates = scorecard({ failedHardGateIds: [] });
    expect(
      parseAoiNonVoiceScorecardResponse(response(inconsistentGates), SESSION_PATH, 'live_field'),
    ).toBeNull();
    const writable = scorecard({ actionAuthority: 'execute' as 'display_only' });
    expect(
      parseAoiNonVoiceScorecardResponse(response(writable), SESSION_PATH, 'live_field'),
    ).toBeNull();
  });

  it('labels evidence classes plainly and selects the exact next action', () => {
    expect(labelAoiNonVoiceEvidenceClass('live_field')).toBe('LIVE FIELD');
    expect(labelAoiNonVoiceEvidenceClass('controlled_real')).toBe('CONTROLLED REAL');
    expect(labelAoiNonVoiceEvidenceClass('synthetic')).toBe('SYNTHETIC');
    expect(describeAoiNonVoiceEvidenceClass('controlled_real')).toContain('cannot substitute');
    expect(selectAoiNonVoiceNextEvidenceAction(scorecard())).toBe(
      'Run the current broad validation suite.',
    );
  });
});
