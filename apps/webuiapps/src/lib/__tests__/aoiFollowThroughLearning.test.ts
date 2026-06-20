import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAoiFollowThroughEvent,
  dismissAoiOpportunity,
  loadAoiFollowThroughEvents,
  loadAoiFollowThroughLearningSummary,
  loadAoiFollowThroughSummaryIndex,
  upsertAoiOpportunity,
} from '../aoiAutonomyStore';
import type { AoiFollowThroughEvent, AoiOpportunity } from '../aoiAutonomyTypes';
import {
  buildAoiFollowThroughEventFromTrendDelivery,
  buildAoiFollowThroughLearningSummary,
  scoreAoiFollowThroughLearningForOpportunity,
} from '../aoiFollowThroughLearning';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-follow-through-test-'));
  tempRoots.push(root);
  return root;
}

function makeOpportunity(partial: Partial<AoiOpportunity> = {}): AoiOpportunity {
  return {
    version: 1,
    id: 'opp-follow-through-re',
    sessionPath: SESSION_PATH,
    sourceKind: 'interest',
    title: 'Track RE latest trends',
    curiosityQuestion: 'Is there a fresh RE trend worth showing?',
    whyNow: 'RE is a high-confidence interest.',
    evidenceNeed: 'Need fresh public evidence.',
    suggestedNextAction: 'Keep this in the dashboard.',
    risk: 'low',
    confidence: 0.8,
    urgency: 0.7,
    novelty: 0.65,
    deliveryRecommendation: 'direct_chat',
    status: 'active',
    evidenceRefs: ['interest:reverse-engineering'],
    dedupeKey: 'interest:reverse-engineering',
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - 60_000,
    expiresAt: NOW + DAY_MS,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeEvent(partial: Partial<AoiFollowThroughEvent>): AoiFollowThroughEvent {
  return {
    version: 1,
    id: partial.id ?? 'follow-through-event',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    opportunityId: partial.opportunityId ?? 'opp-follow-through-re',
    sourceKind: partial.sourceKind ?? 'interest',
    topicKey: partial.topicKey ?? 'interest:reverse-engineering',
    sourceKey: partial.sourceKey ?? 'interest',
    deliveryMode: partial.deliveryMode ?? 'direct_chat',
    action: partial.action ?? 'accepted',
    feedbackCategory: partial.feedbackCategory ?? 'useful',
    result: partial.result ?? 'positive',
    timingLabel: partial.timingLabel ?? 'test event',
    evidenceRefs: partial.evidenceRefs ?? ['test:follow-through'],
    createdAt: partial.createdAt ?? NOW - 1_000,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi Follow-through Learning', () => {
  it('boosts similar useful opportunities after accepted feedback', () => {
    const opportunity = makeOpportunity();
    const summary = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [makeEvent({ action: 'accepted', result: 'positive' })],
      now: NOW,
    });
    const score = scoreAoiFollowThroughLearningForOpportunity(opportunity, summary, NOW);

    expect(score.rankingFactor).toBeGreaterThan(1);
    expect(score.suppressed).toBe(false);
    expect(score.reasonLabels.join(' ')).toContain('show more');
  });

  it('suppresses duplicate suggestions after dismissed feedback', () => {
    const opportunity = makeOpportunity();
    const summary = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        makeEvent({
          action: 'dismissed',
          result: 'negative',
          feedbackCategory: 'not_useful',
        }),
      ],
      now: NOW,
    });
    const score = scoreAoiFollowThroughLearningForOpportunity(opportunity, summary, NOW);

    expect(score.rankingFactor).toBeLessThan(1);
    expect(score.suppressed).toBe(true);
    expect(score.nextEligibleAt).toBeGreaterThan(NOW);
  });

  it('counts ignored trend delivery softly instead of as a hard dislike', () => {
    const opportunity = makeOpportunity({
      id: 'brief-candidate-001',
      dedupeKey: 'topic:reverse-engineering',
      evidenceRefs: ['proactive-brief:brief-candidate-001'],
    });
    const event = buildAoiFollowThroughEventFromTrendDelivery(
      {
        version: 1,
        id: 'trend-delivery-001',
        sessionPath: SESSION_PATH,
        kind: 'direct_chat_offered',
        snapshotId: 'trend-snapshot-001',
        candidateId: 'brief-candidate-001',
        topicId: 'topic:reverse-engineering',
        topicLabel: 'Reverse Engineering',
        deliveryMode: 'direct_chat',
        dedupeKey: 'topic:reverse-engineering',
        title: 'Fresh RE trend',
        sourceQualityStatus: 'strong',
        interestDriftStatus: 'aligned',
        suppressionReasons: [],
        sourceHosts: ['example.com'],
        evidenceRefs: ['trend-snapshot:trend-snapshot-001'],
        createdAt: NOW - 31 * 60 * 1000,
      },
      NOW,
    );
    const summary = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [event],
      now: NOW,
    });
    const score = scoreAoiFollowThroughLearningForOpportunity(opportunity, summary, NOW);

    expect(event.result).toBe('soft_negative');
    expect(score.rankingFactor).toBeLessThan(1);
    expect(score.rankingFactor).toBeGreaterThan(0.6);
    expect(score.suppressed).toBe(false);
  });

  it('keeps learning artifacts display-only and never grants execution authority', () => {
    const summary = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        makeEvent({ action: 'executed', result: 'positive', feedbackCategory: 'useful' }),
      ],
      now: NOW,
    });

    expect(summary.actionAuthority).toBe('display_only');
    expect(summary.mutationCount).toBe(0);
    expect(summary.recentEvents[0]).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(summary.trustCalibrationHints.join(' ')).toContain(
      'approval and execution gates remain unchanged',
    );
  });

  it('persists an append-only event log and bounded summary index', () => {
    const root = makeTempRoot();
    const stored = upsertAoiOpportunity(
      root,
      SESSION_PATH,
      {
        sourceKind: 'interest',
        title: 'Track RE latest trends',
        curiosityQuestion: 'Is there a fresh RE trend worth showing?',
        whyNow: 'RE is a high-confidence interest.',
        evidenceNeed: 'Need fresh public evidence.',
        suggestedNextAction: 'Keep this in the dashboard.',
        risk: 'low',
        confidence: 0.8,
        urgency: 0.7,
        novelty: 0.65,
        deliveryRecommendation: 'dashboard',
        evidenceRefs: ['interest:reverse-engineering'],
        dedupeKey: 'interest:reverse-engineering',
      },
      NOW,
    );
    dismissAoiOpportunity(root, SESSION_PATH, stored.opportunity.id, NOW + 1_000);
    appendAoiFollowThroughEvent(
      root,
      makeEvent({
        id: 'manual-follow-through-accepted',
        action: 'accepted',
        result: 'positive',
        createdAt: NOW + 2_000,
      }),
      NOW + 2_000,
    );

    const events = loadAoiFollowThroughEvents(root, SESSION_PATH, NOW + 3_000);
    const summary = loadAoiFollowThroughLearningSummary(root, SESSION_PATH, NOW + 3_000);
    const index = loadAoiFollowThroughSummaryIndex(root, SESSION_PATH);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['dismissed', 'accepted']),
    );
    expect(summary.eventCount).toBeGreaterThanOrEqual(2);
    expect(index?.entries.length).toBeLessThanOrEqual(80);
    expect(index).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
  });
});
