import { describe, expect, it } from 'vitest';
import type { AoiOutcomeSignalKind } from '../aoiAutonomyTypes';
import {
  buildAoiFollowThroughEventFromOutcomeSignal,
  buildAoiOutcomeLearningSummary,
  normalizeAoiOutcomeSignalRecord,
} from '../aoiOutcomeLearning';
import { buildAoiOutcomeSignalTimelineEventInput } from '../aoiOperatorTimeline';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

const EXPECTED_POLICY: Record<
  AoiOutcomeSignalKind,
  {
    confidence: number;
    target: string;
    direction: string;
    result: string;
  }
> = {
  proposal_opened: {
    confidence: 0.24,
    target: 'topic',
    direction: 'boost',
    result: 'positive',
  },
  proposal_ignored: {
    confidence: 0.16,
    target: 'timing',
    direction: 'suppress',
    result: 'soft_negative',
  },
  direct_chat_dismissed: {
    confidence: 0.32,
    target: 'timing',
    direction: 'suppress',
    result: 'negative',
  },
  work_order_approved: {
    confidence: 0.42,
    target: 'readiness',
    direction: 'boost',
    result: 'positive',
  },
  work_order_rejected: {
    confidence: 0.48,
    target: 'readiness',
    direction: 'suppress',
    result: 'negative',
  },
  validation_run: {
    confidence: 0.38,
    target: 'readiness',
    direction: 'boost',
    result: 'positive',
  },
  commit_created: {
    confidence: 0.44,
    target: 'readiness',
    direction: 'boost',
    result: 'positive',
  },
  user_correction: {
    confidence: 0.62,
    target: 'source',
    direction: 'risk_up',
    result: 'negative',
  },
};

describe('Aoi outcome learning', () => {
  it('normalizes each outcome kind with bounded confidence and learning effect', () => {
    for (const [outcomeKind, expected] of Object.entries(EXPECTED_POLICY) as Array<
      [AoiOutcomeSignalKind, (typeof EXPECTED_POLICY)[AoiOutcomeSignalKind]]
    >) {
      const record = normalizeAoiOutcomeSignalRecord(
        {
          sessionPath: SESSION_PATH,
          eventId: `outcome-${outcomeKind}`,
          sourceProposalId: 'proposal-outcome-001',
          outcomeKind,
          topicKey: 'topic:reverse-engineering',
          sourceKey: 'source:browser-context',
          evidenceRefs: [`evidence:${outcomeKind}`],
        },
        SESSION_PATH,
        NOW,
      );

      expect(record).not.toBeNull();
      expect(record).toMatchObject({
        outcomeKind,
        confidence: expected.confidence,
        result: expected.result,
        inferredAdjustment: {
          target: expected.target,
          direction: expected.direction,
        },
        actionAuthority: 'display_only',
        mutationCount: 0,
      });
      if (outcomeKind === 'user_correction') {
        expect(record?.signalKind).toBe('explicit_correction');
      } else {
        expect(record?.signalKind).toBe('passive_outcome');
        expect(record?.confidence).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('treats failed validation as a stronger readiness suppressor', () => {
    const record = normalizeAoiOutcomeSignalRecord(
      {
        sessionPath: SESSION_PATH,
        eventId: 'outcome-validation-failed',
        outcomeKind: 'validation_run',
        validationPassed: false,
        evidenceRefs: ['validation:failed'],
      },
      SESSION_PATH,
      NOW,
    );

    expect(record).toMatchObject({
      confidence: 0.5,
      result: 'failed',
      inferredAdjustment: {
        target: 'readiness',
        direction: 'suppress',
      },
    });
  });

  it('blocks trust increase for outcome-only signals until explicit labels or field readiness exist', () => {
    const passive = normalizeAoiOutcomeSignalRecord(
      {
        sessionPath: SESSION_PATH,
        eventId: 'outcome-opened',
        sourceProposalId: 'proposal-outcome-001',
        outcomeKind: 'proposal_opened',
      },
      SESSION_PATH,
      NOW,
    );
    const explicit = normalizeAoiOutcomeSignalRecord(
      {
        sessionPath: SESSION_PATH,
        eventId: 'outcome-approved-explicit',
        sourceProposalId: 'proposal-outcome-002',
        outcomeKind: 'work_order_approved',
        explicitLabelRef: 'operator-feedback:useful-001',
        explicitLabel: 'useful',
      },
      SESSION_PATH,
      NOW,
    );

    const outcomeOnly = buildAoiOutcomeLearningSummary({
      sessionPath: SESSION_PATH,
      outcomes: passive ? [passive] : [],
      now: NOW,
    });
    const labelLinked = buildAoiOutcomeLearningSummary({
      sessionPath: SESSION_PATH,
      outcomes: explicit ? [explicit] : [],
      now: NOW,
    });
    const fieldReady = buildAoiOutcomeLearningSummary({
      sessionPath: SESSION_PATH,
      outcomes: passive ? [passive] : [],
      fieldReadinessEvidence: true,
      now: NOW,
    });

    expect(outcomeOnly.outcomeOnly).toBe(true);
    expect(outcomeOnly.trustIncreaseAllowed).toBe(false);
    expect(outcomeOnly.trustIncreaseBlockedReasons.join(' ')).toContain(
      'outcome-only signals cannot increase trust',
    );
    expect(labelLinked.outcomeOnly).toBe(false);
    expect(labelLinked.trustIncreaseAllowed).toBe(true);
    expect(labelLinked.explicitLabelLinkedCount).toBe(1);
    expect(fieldReady.outcomeOnly).toBe(false);
    expect(fieldReady.trustIncreaseAllowed).toBe(true);
  });

  it('projects outcome records into follow-through and timeline explanations', () => {
    const record = normalizeAoiOutcomeSignalRecord(
      {
        sessionPath: SESSION_PATH,
        eventId: 'outcome-commit-created',
        sourceProposalId: 'proposal-commit-001',
        sourceCommitRef: 'commit:abc1234',
        outcomeKind: 'commit_created',
        topicKey: 'topic:reverse-engineering',
        evidenceRefs: ['commit:abc1234'],
      },
      SESSION_PATH,
      NOW,
    );

    expect(record).not.toBeNull();
    const followThrough = buildAoiFollowThroughEventFromOutcomeSignal(record!, NOW);
    const timeline = buildAoiOutcomeSignalTimelineEventInput(record!);

    expect(followThrough).toMatchObject({
      learningSignalKind: 'passive_outcome',
      outcomeKind: 'commit_created',
      confidence: 0.44,
      trustIncreaseEligible: false,
      result: 'positive',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(timeline).toMatchObject({
      kind: 'outcome_signal_recorded',
      proposalId: 'proposal-commit-001',
      status: 'commit_created',
      sourceKind: 'outcome_learning',
      redactionState: 'none',
    });
    expect(timeline.summary).toContain('led to commit created');
    expect(timeline.summary).toContain('confidence 0.44');
  });

  it('redacts private-looking content from outcome refs and labels', () => {
    const record = normalizeAoiOutcomeSignalRecord(
      {
        sessionPath: SESSION_PATH,
        eventId: 'outcome-private-redaction',
        sourceProposalId: 'proposal-private-redaction',
        outcomeKind: 'user_correction',
        explicitLabel: 'content=private-roadmap@example.com C:\\Users\\secret\\mail.txt',
        evidenceRefs: [
          'body: private-roadmap@example.com C:\\Users\\secret\\mail.txt api_key=sk-test-veryprivatevalue',
        ],
      },
      SESSION_PATH,
      NOW,
    );
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain('private-roadmap@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret\\mail.txt');
    expect(serialized).not.toContain('sk-test-veryprivatevalue');
    expect(serialized).toContain('[private email]');
    expect(serialized).toContain('[local path]');
    expect(serialized).toContain('[redacted-token]');
  });
});
