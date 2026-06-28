import { describe, expect, it } from 'vitest';

import { buildAoiAdaptiveAcceptancePack } from '../aoiAdaptiveAcceptanceCuration';
import {
  buildAoiOperatorPromotionReviewResult,
  buildAoiOperatorReviewQueue,
} from '../aoiOperatorPromotionReview';
import { buildAoiTracePromotionReport } from '../aoiTracePromotion';

const SESSION = 'aoi/default';
const NOW = 1_800_000_000_000;

function emptyTraceReport() {
  return buildAoiTracePromotionReport({ sessionPath: SESSION, traceExports: [], now: NOW });
}

function emptyAdaptivePack() {
  return buildAoiAdaptiveAcceptancePack({
    sessionPath: SESSION,
    labelActions: [],
    traceExports: [],
    now: NOW,
  });
}

describe('buildAoiOperatorReviewQueue', () => {
  it('summarizes an empty candidate set with a vacuous full pass rate', () => {
    const queue = buildAoiOperatorReviewQueue({
      sessionPath: SESSION,
      traceReport: emptyTraceReport(),
      adaptivePack: emptyAdaptivePack(),
      now: NOW,
    });

    expect(queue.traceCandidateCount).toBe(0);
    expect(queue.adaptiveCandidateCount).toBe(0);
    expect(queue.candidates).toEqual([]);
    // ratio of 0/0 is the vacuous 1; the scorecard separately requires
    // tracePromotionCandidateCount > 0, so an empty queue cannot unlock anything.
    expect(queue.promotedReplayPassRate).toBe(1);
    expect(queue.actionAuthority).toBe('display_only');
    expect(queue.mutationCount).toBe(0);
  });
});

describe('buildAoiOperatorPromotionReviewResult validation', () => {
  it('rejects an unknown action', () => {
    const result = buildAoiOperatorPromotionReviewResult({
      traceReport: emptyTraceReport(),
      adaptivePack: emptyAdaptivePack(),
      request: {
        kind: 'trace',
        candidateId: 'x',
        // @ts-expect-error testing runtime validation of an invalid action value
        action: 'bogus',
      },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_action');
    }
  });

  it('rejects an unknown kind', () => {
    const result = buildAoiOperatorPromotionReviewResult({
      traceReport: emptyTraceReport(),
      adaptivePack: emptyAdaptivePack(),
      request: {
        // @ts-expect-error testing runtime validation of an invalid kind value
        kind: 'unknown',
        candidateId: 'x',
        action: 'defer',
      },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_kind');
    }
  });

  it('reports candidate_not_found for an unknown trace candidate', () => {
    const result = buildAoiOperatorPromotionReviewResult({
      traceReport: emptyTraceReport(),
      adaptivePack: emptyAdaptivePack(),
      request: { kind: 'trace', candidateId: 'missing', action: 'defer' },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('candidate_not_found');
    }
  });

  it('reports candidate_not_found for an unknown adaptive candidate', () => {
    const result = buildAoiOperatorPromotionReviewResult({
      traceReport: emptyTraceReport(),
      adaptivePack: emptyAdaptivePack(),
      request: { kind: 'adaptive', candidateId: 'missing', action: 'defer' },
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('candidate_not_found');
    }
  });
});
