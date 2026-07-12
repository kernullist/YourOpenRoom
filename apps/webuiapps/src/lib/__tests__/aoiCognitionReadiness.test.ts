import { describe, expect, it } from 'vitest';
import {
  buildAoiCognitionReadinessScorecard,
  formatAoiCognitionReadinessScorecard,
} from '../aoiCognitionReadiness';
import { buildAoiCurrentSituation, type AoiCurrentSituation } from '../aoiCurrentSituationModel';
import { buildAoiIntentState } from '../aoiIntentInference';
import {
  buildAoiActivityStreamSummary,
  normalizeAoiActivityEvent,
  type AoiActivityEvent,
} from '../aoiActivityStream';
import type { AoiProposal } from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function makeActivitySummary(now: number) {
  const events = [
    normalizeAoiActivityEvent(
      { kind: 'app_opened', appId: 'musicapp', observedAt: now - 2 * 60 * 1000 },
      SESSION_PATH,
      now - 2 * 60 * 1000,
    ).event,
    normalizeAoiActivityEvent(
      {
        kind: 'app_action',
        appId: 'musicapp',
        actionType: 'PLAY_TRACK',
        observedAt: now - 60 * 1000,
      },
      SESSION_PATH,
      now - 60 * 1000,
    ).event,
  ].filter((event): event is AoiActivityEvent => event !== null);
  return buildAoiActivityStreamSummary({ sessionPath: SESSION_PATH, events, now });
}

function makeLiveSituationAndIntent() {
  const activitySummary = makeActivitySummary(NOW);
  const intentState = buildAoiIntentState({
    sessionPath: SESSION_PATH,
    now: NOW,
    activitySummary,
  });
  const situation = buildAoiCurrentSituation({
    sessionPath: SESSION_PATH,
    now: NOW,
    intentState,
    activitySummary,
    lastUserMessageAt: NOW - 3 * 60 * 1000,
  });
  return { situation, intentState };
}

function makeProposal(partial: {
  id: string;
  createdAt: number;
  evidenceRefs: string[];
}): AoiProposal {
  return partial as never;
}

describe('buildAoiCognitionReadinessScorecard', () => {
  it('reaches live_grounded when live signals flow, intent is cited, and proposals cite context', () => {
    const { situation, intentState } = makeLiveSituationAndIntent();
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation,
      situationSampleCount: 5,
      intentState,
      consentedSituationSourceIds: ['app-activity'],
      proposals: [
        makeProposal({
          id: 'p-1',
          createdAt: NOW - 1000,
          evidenceRefs: ['research:r1', `situation:${situation.id}`],
        }),
        makeProposal({
          id: 'p-2',
          createdAt: NOW - 2000,
          evidenceRefs: ['activity:aoi-activity-1'],
        }),
      ],
    });

    expect(scorecard.level).toBe('live_grounded');
    expect(scorecard.gateStatus).toBe('pass');
    expect(scorecard.canSupportPromotion).toBe(true);
    expect(scorecard.score).toBeGreaterThanOrEqual(85);
    expect(scorecard.evidenceRefs).toContain(`situation:${situation.id}`);
    expect(scorecard).toMatchObject({ actionAuthority: 'display_only', mutationCount: 0 });
  });

  it('is ungrounded with honest cannotKnow when no situation exists', () => {
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
    });

    expect(scorecard.level).toBe('ungrounded');
    expect(scorecard.cannotKnow.join(' ')).toContain('No current-situation brief');
    expect(scorecard.metrics.find((m) => m.key === 'grounded_citation_rate')?.status).toBe(
      'no_sample',
    );
    expect(scorecard.canSupportPromotion).toBe(true);
  });

  it('blocks hard on an uncited segment (grounding invariant)', () => {
    const { situation } = makeLiveSituationAndIntent();
    const corrupted: AoiCurrentSituation = {
      ...situation,
      segments: [
        ...situation.segments,
        { ...situation.segments[0], kind: 'workspace', evidenceRefs: [] },
      ],
    };
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation: corrupted,
      situationSampleCount: 5,
    });

    expect(scorecard.gateStatus).toBe('blocked');
    expect(scorecard.canSupportPromotion).toBe(false);
    expect(scorecard.level).toBe('ungrounded');
    expect(scorecard.score).toBeLessThanOrEqual(30);
    expect(scorecard.gates.find((g) => g.key === 'uncited_segment_zero')?.blocked).toBe(true);
  });

  it('blocks hard on a fresh claim whose salience has fully faded', () => {
    const { situation } = makeLiveSituationAndIntent();
    const staleClaim: AoiCurrentSituation = {
      ...situation,
      segments: [{ ...situation.segments[0], freshness: 'fresh', salienceScore: 0.001 }],
    };
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation: staleClaim,
    });

    expect(scorecard.gates.find((g) => g.key === 'stale_claim_zero')?.blocked).toBe(true);
    expect(scorecard.gateStatus).toBe('blocked');
  });

  it('blocks hard on a current intent without evidence', () => {
    const { situation, intentState } = makeLiveSituationAndIntent();
    const uncitedIntent = {
      ...intentState,
      current: intentState.current ? { ...intentState.current, evidenceRefs: [] } : null,
    };
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation,
      intentState: uncitedIntent,
    });

    expect(scorecard.gates.find((g) => g.key === 'uncited_intent_zero')?.blocked).toBe(true);
    expect(scorecard.canSupportPromotion).toBe(false);
  });

  it('treats an empty proposal window as no_sample and gates nothing', () => {
    const { situation, intentState } = makeLiveSituationAndIntent();
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation,
      situationSampleCount: 3,
      intentState,
      proposals: [
        makeProposal({
          id: 'old',
          createdAt: NOW - 48 * 60 * 60 * 1000,
          evidenceRefs: ['memory:m1'],
        }),
      ],
    });

    const metric = scorecard.metrics.find((m) => m.key === 'proposal_live_citation_rate');
    expect(metric?.status).toBe('no_sample');
    expect(scorecard.gates.find((g) => g.key === 'proposal_live_citation_floor')?.blocked).toBe(
      false,
    );
  });

  it('blocks when recent proposals mostly ignore the live context', () => {
    const { situation, intentState } = makeLiveSituationAndIntent();
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation,
      intentState,
      proposals: [
        makeProposal({ id: 'p-1', createdAt: NOW - 1000, evidenceRefs: ['memory:m1'] }),
        makeProposal({ id: 'p-2', createdAt: NOW - 1000, evidenceRefs: ['memory:m2'] }),
        makeProposal({
          id: 'p-3',
          createdAt: NOW - 1000,
          evidenceRefs: [`situation:${situation.id}`],
        }),
      ],
    });

    const metric = scorecard.metrics.find((m) => m.key === 'proposal_live_citation_rate');
    expect(metric?.status).toBe('blocked');
    expect(scorecard.gateStatus).toBe('blocked');
  });

  it('warns on partial source coverage with a recommendation', () => {
    const { situation, intentState } = makeLiveSituationAndIntent();
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation,
      situationSampleCount: 3,
      intentState,
      consentedSituationSourceIds: ['app-activity', 'workspace-git', 'calendar-metadata'],
    });

    const metric = scorecard.metrics.find((m) => m.key === 'source_coverage_rate');
    expect(metric?.status).toBe('warning');
    expect(metric?.value).toBeCloseTo(1 / 3, 2);
    expect(scorecard.recommendations.join(' ')).toContain('produced no situation segment');
    expect(scorecard.gateStatus).toBe('warning');
  });

  it('never claims live grounding from a stale situation', () => {
    const { situation, intentState } = makeLiveSituationAndIntent();
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW + 60 * 60 * 1000,
      situation,
      situationSampleCount: 5,
      intentState,
    });

    expect(scorecard.level).toBe('ungrounded');
    expect(scorecard.cannotKnow.join(' ')).toContain('stale');
    expect(scorecard.recommendations.join(' ')).toContain('wakeup');
  });

  it('rejects an invalid session path and formats a compact line', () => {
    expect(() => buildAoiCognitionReadinessScorecard({ sessionPath: '' })).toThrow('sessionPath');

    const { situation, intentState } = makeLiveSituationAndIntent();
    const scorecard = buildAoiCognitionReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      situation,
      intentState,
    });
    const line = formatAoiCognitionReadinessScorecard(scorecard);
    expect(line).toContain(`score=${scorecard.score}`);
    expect(line).toContain(`level=${scorecard.level}`);
    expect(line).toContain('grounded_citation_rate=1');
  });
});
