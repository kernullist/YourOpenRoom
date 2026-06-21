import { describe, expect, it } from 'vitest';
import { buildAoiFeedbackCompression } from '../aoiFeedbackCompression';
import { normalizeAoiFollowThroughEvent } from '../aoiFollowThroughLearning';
import { createAoiOperatorFeedbackLabelAction } from '../aoiOperatorFeedbackInbox';
import type { AoiOperatorFeedbackLabelInput } from '../aoiOperatorFeedbackInbox';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function makeLabel(
  label: AoiOperatorFeedbackLabelInput['label'],
  partial: Partial<AoiOperatorFeedbackLabelInput> = {},
) {
  return createAoiOperatorFeedbackLabelAction({
    sessionPath: SESSION_PATH,
    decisionRecordId: partial.decisionRecordId ?? `record-${label}`,
    decisionId: partial.decisionId ?? `decision-${label}`,
    fieldEventId: partial.fieldEventId ?? `field-event-${label}`,
    opportunityId: partial.opportunityId ?? `opportunity-${label}`,
    topicKey: partial.topicKey ?? 'topic:reverse-engineering',
    sourceKey: partial.sourceKey ?? 'browser_context',
    deliveryMode: partial.deliveryMode ?? 'dashboard',
    label,
    sourceKinds: partial.sourceKinds ?? ['browser_context'],
    evidenceRefs: partial.evidenceRefs ?? [`evidence:${label}`],
    note: partial.note,
    now: partial.now ?? NOW,
  });
}

describe('buildAoiFeedbackCompression', () => {
  it('compresses explicit operator labels into topic, source, timing, direct-chat, verbosity, and trust adjustments', () => {
    const labels = [
      makeLabel('useful', { deliveryMode: 'dashboard' }),
      makeLabel('too_frequent', { deliveryMode: 'direct_chat' }),
      makeLabel('wrong_source', {
        sourceKey: 'bad_source',
        sourceKinds: ['browser_context'],
        evidenceRefs: ['source:bad', 'C:\\Users\\secret\\private.txt'],
      }),
      makeLabel('unsafe', {
        topicKey: 'topic:dangerous-action',
        note: 'body: private mail body from honey@example.com',
      }),
      makeLabel('should_have_spoken', { deliveryMode: 'direct_chat' }),
    ];
    const result = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      labelActions: labels,
      now: NOW,
    });
    const serialized = JSON.stringify(result);

    expect(result.explicitLabelCount).toBe(5);
    expect(result.passiveOutcomeCount).toBe(0);
    expect(result.topicAdjustments.some((item) => item.direction === 'increase')).toBe(true);
    expect(result.sourceAdjustments.some((item) => item.key === 'bad_source')).toBe(true);
    expect(result.sourceAdjustments.find((item) => item.key === 'bad_source')?.direction).toBe(
      'decrease',
    );
    expect(result.timingAdjustments.some((item) => item.direction === 'decrease')).toBe(true);
    expect(result.directChatSensitivity.factor).toBeLessThan(1);
    expect(result.verbosityPreference.level).toBe('shorter');
    expect(result.unsafeBlockers[0]?.blocksActionEscalation).toBe(true);
    expect(result.shouldHaveSpokenHints[0]?.directChatCandidate).toBe(true);
    expect(result.trustIncreaseAllowed).toBe(false);
    expect(result.trustIncreaseBlockedReasons.join(' ')).toContain('wrong-source');
    expect(result.trustIncreaseBlockedReasons.join(' ')).toContain('unsafe');
    expect(result.trustAdjustments[0]?.direction).toBe('block');
    expect(result.actionAuthority).toBe('display_only');
    expect(result.mutationCount).toBe(0);
    expect(serialized).not.toContain('honey@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('private mail body');
  });

  it('keeps passive outcomes low confidence and blocks trust increase without explicit labels', () => {
    const passiveEvent = normalizeAoiFollowThroughEvent(
      {
        sessionPath: SESSION_PATH,
        id: 'passive-positive-opened',
        opportunityId: 'opportunity-passive-positive',
        topicKey: 'topic:reverse-engineering',
        sourceKey: 'browser_context',
        deliveryMode: 'dashboard',
        action: 'accepted',
        result: 'positive',
        timingLabel: 'operator opened the card without explicit label',
        evidenceRefs: ['passive:opened'],
        createdAt: NOW - 1_000,
      },
      SESSION_PATH,
      NOW,
    );
    expect(passiveEvent).not.toBeNull();

    const result = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      followThroughEvents: passiveEvent ? [passiveEvent] : [],
      now: NOW,
    });

    expect(result.explicitLabelCount).toBe(0);
    expect(result.passiveOutcomeCount).toBe(1);
    expect(result.confidence).toBeLessThan(0.2);
    expect(result.topicAdjustments[0]?.confidence).toBeLessThan(0.2);
    expect(result.trustIncreaseAllowed).toBe(false);
    expect(result.trustIncreaseBlockedReasons).toContain(
      'explicit positive operator label required before trust increase',
    );
    expect(result.trustAdjustments[0]?.direction).toBe('block');
  });

  it('allows only explicit positive labels to become a trust increase candidate', () => {
    const result = buildAoiFeedbackCompression({
      sessionPath: SESSION_PATH,
      labelActions: [makeLabel('useful', { deliveryMode: 'direct_chat' })],
      now: NOW,
    });

    expect(result.trustIncreaseAllowed).toBe(true);
    expect(result.trustIncreaseBlockedReasons).toEqual([]);
    expect(result.trustAdjustments[0]?.direction).toBe('increase');
    expect(result.trustAdjustments[0]?.explicitLabelCount).toBe(1);
  });
});
