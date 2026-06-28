import { describe, expect, it } from 'vitest';

import {
  buildReviewDecisionBody,
  parseReviewQueueResponse,
  toReplayPromotionViewModel,
} from '../aoiReplayPromotionPanelModel';
import type { AoiOperatorReviewQueue } from '../aoiOperatorPromotionReview';

function queueResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    sessionPath: 'aoi/default',
    queue: {
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 5000,
      traceCandidateCount: 1,
      adaptiveCandidateCount: 1,
      promotedCount: 0,
      promotedReplayPassRate: 0,
      candidates: [
        {
          version: 1,
          kind: 'trace',
          candidateId: 'trace-1',
          title: 'useful trace',
          summary: 'a trace',
          selectedLabel: 'useful',
          acceptanceDimension: 'useful',
          privacyStatus: 'passed',
          reviewStatus: 'needs_review',
          promotable: true,
          evidenceRefs: ['trace-export:trace-1'],
        },
        {
          version: 1,
          kind: 'adaptive',
          candidateId: 'adaptive-1',
          title: 'useful adaptive candidate',
          summary: 'an adaptive candidate',
          selectedLabel: 'useful',
          acceptanceDimension: 'useful',
          privacyStatus: 'passed',
          reviewStatus: 'approved',
          promotable: true,
          evidenceRefs: ['field-shadow-record:rec1'],
        },
      ],
      actionAuthority: 'display_only',
      mutationCount: 0,
      ...overrides,
    },
  };
}

describe('parseReviewQueueResponse', () => {
  it('parses a well-formed response and drops malformed candidates', () => {
    const response = queueResponse();
    (response.queue as { candidates: unknown[] }).candidates.push({ kind: 'bogus' });
    const queue = parseReviewQueueResponse(response);

    expect(queue).not.toBeNull();
    expect(queue?.candidates).toHaveLength(2);
    expect(queue?.candidates.map((candidate) => candidate.candidateId)).toEqual([
      'trace-1',
      'adaptive-1',
    ]);
  });

  it('returns null for a non-ok or malformed payload', () => {
    expect(parseReviewQueueResponse({ ok: false })).toBeNull();
    expect(parseReviewQueueResponse({ ok: true })).toBeNull();
    expect(parseReviewQueueResponse('nope')).toBeNull();
    expect(parseReviewQueueResponse({ ok: true, queue: 42 })).toBeNull();
  });
});

describe('toReplayPromotionViewModel', () => {
  function parsed(overrides: Record<string, unknown> = {}): AoiOperatorReviewQueue {
    const queue = parseReviewQueueResponse(queueResponse(overrides));
    if (!queue) {
      throw new Error('Expected a parsed queue.');
    }
    return queue;
  }

  it('reports progress and per-candidate action availability before full promotion', () => {
    const view = toReplayPromotionViewModel(parsed());

    expect(view.total).toBe(2);
    expect(view.unlockReady).toBe(false);
    expect(view.remaining).toBe(2);
    expect(view.progressLabel).toContain('0/2');

    const trace = view.candidates.find((candidate) => candidate.candidateId === 'trace-1');
    const adaptive = view.candidates.find((candidate) => candidate.candidateId === 'adaptive-1');
    expect(trace?.canPromote).toBe(true);
    expect(trace?.isPromoted).toBe(false);
    // The adaptive candidate is already approved -> promoted, not re-promotable.
    expect(adaptive?.isPromoted).toBe(true);
    expect(adaptive?.canPromote).toBe(false);
    expect(adaptive?.statusLabel).toBe('Promoted');
  });

  it('flags unlockReady once every candidate is promoted', () => {
    const view = toReplayPromotionViewModel(
      parsed({ promotedCount: 2, promotedReplayPassRate: 1 }),
    );

    expect(view.unlockReady).toBe(true);
    expect(view.remaining).toBe(0);
    expect(view.progressLabel.toLowerCase()).toContain('gate is satisfied');
  });

  it('handles an empty candidate set without claiming the gate is satisfied', () => {
    const view = toReplayPromotionViewModel(
      parsed({
        traceCandidateCount: 0,
        adaptiveCandidateCount: 0,
        promotedReplayPassRate: 1,
        candidates: [],
      }),
    );

    expect(view.total).toBe(0);
    expect(view.unlockReady).toBe(false);
    expect(view.progressLabel.toLowerCase()).toContain('no replay candidates');
  });

  it('marks a privacy-blocked candidate as not promotable', () => {
    const view = toReplayPromotionViewModel(
      parsed({
        candidates: [
          {
            version: 1,
            kind: 'trace',
            candidateId: 'blocked-1',
            title: 'blocked trace',
            summary: 'has private data',
            selectedLabel: 'useful',
            acceptanceDimension: 'useful',
            privacyStatus: 'blocked',
            reviewStatus: 'blocked',
            promotable: false,
            evidenceRefs: [],
          },
        ],
      }),
    );

    const blocked = view.candidates[0];
    expect(blocked.canPromote).toBe(false);
    expect(blocked.statusLabel).toBe('Blocked (private data)');
  });
});

describe('buildReviewDecisionBody', () => {
  it('includes a trimmed reason when provided', () => {
    const body = buildReviewDecisionBody({
      sessionPath: 'aoi/default',
      kind: 'trace',
      candidateId: 'trace-1',
      action: 'promote',
      reason: '  reviewed and promoted  ',
    });

    expect(body).toEqual({
      sessionPath: 'aoi/default',
      kind: 'trace',
      candidateId: 'trace-1',
      action: 'promote',
      reason: 'reviewed and promoted',
    });
  });

  it('omits an empty reason', () => {
    const body = buildReviewDecisionBody({
      sessionPath: 'aoi/default',
      kind: 'adaptive',
      candidateId: 'adaptive-1',
      action: 'defer',
      reason: '   ',
    });

    expect(body.reason).toBeUndefined();
    expect(body.action).toBe('defer');
  });
});
