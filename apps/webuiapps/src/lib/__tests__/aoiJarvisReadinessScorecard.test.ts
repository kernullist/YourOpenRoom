import { describe, expect, it } from 'vitest';
import { buildAoiFeedbackCompression } from '../aoiFeedbackCompression';
import { buildAoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';
import { normalizeAoiFollowThroughEvent } from '../aoiFollowThroughLearning';
import { createAoiOperatorFeedbackLabelAction } from '../aoiOperatorFeedbackInbox';
import { buildAoiOutcomeLearningSummary } from '../aoiOutcomeLearning';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

describe('buildAoiJarvisReadinessScorecard feedback compression gate', () => {
  it('blocks trust increase when feedback compression only has passive outcomes', () => {
    const passiveEvent = normalizeAoiFollowThroughEvent(
      {
        id: 'readiness-passive-positive',
        opportunityId: 'opportunity-readiness-passive',
        topicKey: 'topic:reverse-engineering',
        sourceKey: 'browser_context',
        deliveryMode: 'dashboard',
        action: 'accepted',
        result: 'positive',
        timingLabel: 'operator opened card without explicit label',
        evidenceRefs: ['passive:opened-card'],
        createdAt: NOW - 1_000,
      },
      SESSION_PATH,
      NOW,
    );
    const feedbackCompression = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      followThroughEvents: passiveEvent ? [passiveEvent] : [],
      now: NOW,
    });
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      feedbackCompression,
      directChatOptInEnabled: true,
      now: NOW,
    });

    expect(feedbackCompression.trustIncreaseAllowed).toBe(false);
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.feedback_compression_trust_label'),
    ).toMatchObject({
      status: 'block',
    });
    expect(scorecard.visibility.directChat).toBe('blocked');
    expect(scorecard.visibility.directChatBlockedReasons.join(' ')).toContain(
      'feedback compression requires explicit positive labels',
    );
    expect(scorecard.visibility.workOrderPrepareBlockedReasons.join(' ')).toContain(
      'feedback compression requires explicit positive labels',
    );
    expect(scorecard.recommendations.map((item) => item.id)).toContain(
      'recommendation.feedback_compression_trust_gate',
    );
  });

  it('passes the compression trust gate for explicit useful labels without granting execution authority', () => {
    const label = createAoiOperatorFeedbackLabelAction({
      sessionPath: SESSION_PATH,
      decisionRecordId: 'record-useful',
      decisionId: 'decision-useful',
      opportunityId: 'opportunity-useful',
      topicKey: 'topic:reverse-engineering',
      sourceKey: 'browser_context',
      deliveryMode: 'direct_chat',
      label: 'useful',
      sourceKinds: ['browser_context'],
      evidenceRefs: ['operator-feedback:useful'],
      now: NOW,
    });
    const feedbackCompression = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      labelActions: [label],
      now: NOW,
    });
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      feedbackCompression,
      directChatOptInEnabled: true,
      now: NOW,
    });

    expect(feedbackCompression.trustIncreaseAllowed).toBe(true);
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.feedback_compression_trust_label'),
    ).toMatchObject({
      status: 'pass',
    });
    expect(scorecard.actionAuthority).toBe('display_only');
    expect(scorecard.mutationCount).toBe(0);
  });

  it('blocks trust increase when outcome learning has only passive outcomes', () => {
    const outcomeLearning = buildAoiOutcomeLearningSummary({
      sessionPath: SESSION_PATH,
      outcomes: [
        {
          sessionPath: SESSION_PATH,
          eventId: 'outcome-opened-readiness',
          sourceProposalId: 'proposal-readiness-outcome',
          outcomeKind: 'proposal_opened',
        },
      ],
      now: NOW,
    });
    const explicitOutcomeLearning = buildAoiOutcomeLearningSummary({
      sessionPath: SESSION_PATH,
      outcomes: [
        {
          sessionPath: SESSION_PATH,
          eventId: 'outcome-approved-explicit-readiness',
          sourceProposalId: 'proposal-readiness-explicit',
          outcomeKind: 'work_order_approved',
          explicitLabelRef: 'operator-feedback:useful-readiness',
          explicitLabel: 'useful',
        },
      ],
      now: NOW,
    });
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      outcomeLearning,
      directChatOptInEnabled: true,
      now: NOW,
    });
    const explicitScorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      outcomeLearning: explicitOutcomeLearning,
      directChatOptInEnabled: true,
      now: NOW,
    });

    expect(outcomeLearning.trustIncreaseAllowed).toBe(false);
    expect(
      scorecard.gates.find((gate) => gate.id === 'gate.outcome_only_trust_increase_block'),
    ).toMatchObject({
      status: 'block',
    });
    expect(scorecard.canIncreaseTrust).toBe(false);
    expect(scorecard.visibility.directChatBlockedReasons.join(' ')).toContain(
      'outcome-only learning cannot raise trust',
    );
    expect(scorecard.recommendations.map((item) => item.id)).toContain(
      'recommendation.outcome_only_trust_gate',
    );
    expect(
      explicitScorecard.gates.find((gate) => gate.id === 'gate.outcome_only_trust_increase_block'),
    ).toMatchObject({
      status: 'pass',
    });
  });
});

describe('buildAoiJarvisReadinessScorecard cognition grounding gate (SA5.2)', () => {
  function makeCognitionScorecard(canSupportPromotion: boolean) {
    return {
      version: 1,
      sessionPath: SESSION_PATH,
      generatedAt: NOW,
      score: canSupportPromotion ? 88 : 20,
      level: canSupportPromotion ? 'live_grounded' : 'ungrounded',
      gateStatus: canSupportPromotion ? 'pass' : 'blocked',
      canSupportPromotion,
      metrics: [],
      gates: [],
      recommendations: [],
      evidenceRefs: ['situation:situation-test'],
      cannotKnow: [],
      actionAuthority: 'display_only',
      mutationCount: 0,
    } as never;
  }

  it('blocks the readiness gate when cognition grounding failed (tighten-only)', () => {
    const scorecard = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      cognitionReadiness: makeCognitionScorecard(false),
    });

    const gate = scorecard.gates.find((item) => item.id === 'gate.cognition_grounding');
    expect(gate).toMatchObject({ status: 'block' });
    expect(gate?.blockerRefs).toContain('cognition-readiness:blocked');
    expect(scorecard.gateStatus).toBe('blocked');
    expect(scorecard.canIncreaseTrust).toBe(false);
  });

  it('adds only a pass gate when grounding holds -- never lifts anything', () => {
    const baseline = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    const withCognition = buildAoiJarvisReadinessScorecard({
      sessionPath: SESSION_PATH,
      now: NOW,
      cognitionReadiness: makeCognitionScorecard(true),
    });

    const gate = withCognition.gates.find((item) => item.id === 'gate.cognition_grounding');
    expect(gate).toMatchObject({ status: 'pass' });
    expect(withCognition.score).toBeLessThanOrEqual(baseline.score);
    expect(withCognition.level).toBe(baseline.level);
    expect(withCognition.canIncreaseTrust).toBe(baseline.canIncreaseTrust);
  });
});
