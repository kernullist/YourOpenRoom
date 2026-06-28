import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendAoiOperatorAdaptiveReviewState,
  appendAoiOperatorTracePromotionDecision,
  loadAoiOperatorAdaptiveReviewStates,
  loadAoiOperatorTracePromotionDecisions,
  resolveAoiAutonomyPaths,
} from '../aoiAutonomyStore';
import type { AoiAdaptiveAcceptanceReviewState } from '../aoiAdaptiveAcceptanceCuration';
import type { AoiTracePromotionDecision } from '../aoiTracePromotion';

const SESSION = 'aoi/default';
const OTHER_SESSION = 'aoi/other';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-operator-promotion-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function traceDecision(
  overrides: Partial<AoiTracePromotionDecision> = {},
): AoiTracePromotionDecision {
  return {
    version: 1,
    id: 'aoi-trace-promotion-decision-abc123',
    candidateId: 'aoi-trace-promotion-cand1',
    sourceTraceId: 'trace-1',
    action: 'promote',
    selectedLabel: 'useful',
    acceptanceDimension: 'useful',
    jarvisDimension: 'replayability_privacy',
    reason: 'Operator reviewed and promoted this trace.',
    actor: 'user',
    createdAt: 1000,
    evidenceRefs: ['trace-export:trace-1', 'trace-export:trace-1'],
    privacyStatus: 'passed',
    mutationCount: 0,
    ...overrides,
  };
}

function adaptiveReview(
  overrides: Partial<AoiAdaptiveAcceptanceReviewState> = {},
): AoiAdaptiveAcceptanceReviewState {
  return {
    version: 1,
    candidateId: 'aoi-adaptive-acceptance-cand1',
    status: 'approved',
    reviewedAt: 2000,
    evidenceRefs: ['field-shadow-record:rec1'],
    reason: 'Operator approved this adaptive candidate.',
    actor: 'user',
    ...overrides,
  };
}

describe('operator trace-promotion decision store', () => {
  it('appends and loads an operator decision round-trip', () => {
    const root = makeRoot();

    const saved = appendAoiOperatorTracePromotionDecision(root, SESSION, traceDecision());

    // evidenceRefs is normalized (duplicate collapsed).
    expect(saved.evidenceRefs).toEqual(['trace-export:trace-1']);
    const loaded = loadAoiOperatorTracePromotionDecisions(root, SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('aoi-trace-promotion-decision-abc123');
    expect(loaded[0].action).toBe('promote');
    expect(loaded[0].actor).toBe('user');
  });

  it('returns an empty list when nothing has been recorded', () => {
    const root = makeRoot();
    expect(loadAoiOperatorTracePromotionDecisions(root, SESSION)).toEqual([]);
  });

  it('refuses to persist a non-user (system) actor decision', () => {
    const root = makeRoot();
    expect(() =>
      appendAoiOperatorTracePromotionDecision(root, SESSION, traceDecision({ actor: 'system' })),
    ).toThrow(/human operator/i);
    expect(loadAoiOperatorTracePromotionDecisions(root, SESSION)).toEqual([]);
  });

  it('throws on a malformed decision record', () => {
    const root = makeRoot();
    const broken = traceDecision();
    // @ts-expect-error intentionally drop a required field to exercise the guard
    delete broken.candidateId;
    expect(() => appendAoiOperatorTracePromotionDecision(root, SESSION, broken)).toThrow(
      /Invalid Aoi operator trace-promotion decision/i,
    );
  });

  it('ignores a directly-written system-actor file at load time (defense in depth)', () => {
    const root = makeRoot();
    // A file that bypassed the append guard must still not count as an operator
    // promotion: the loader re-filters to actor === 'user'.
    const dir = resolveAoiAutonomyPaths(root, SESSION).operatorTracePromotionDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'aoi-trace-promotion-decision-rogue.json'),
      JSON.stringify(traceDecision({ id: 'aoi-trace-promotion-decision-rogue', actor: 'system' })),
      'utf-8',
    );
    appendAoiOperatorTracePromotionDecision(root, SESSION, traceDecision());

    const loaded = loadAoiOperatorTracePromotionDecisions(root, SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].actor).toBe('user');
  });

  it('keeps decisions isolated per session', () => {
    const root = makeRoot();
    appendAoiOperatorTracePromotionDecision(root, SESSION, traceDecision());

    expect(loadAoiOperatorTracePromotionDecisions(root, OTHER_SESSION)).toEqual([]);
  });
});

describe('operator adaptive-acceptance review-state store', () => {
  it('appends and loads an operator review state round-trip', () => {
    const root = makeRoot();

    const saved = appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview());

    expect(saved.status).toBe('approved');
    const loaded = loadAoiOperatorAdaptiveReviewStates(root, SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].candidateId).toBe('aoi-adaptive-acceptance-cand1');
    expect(loaded[0].actor).toBe('user');
  });

  it('refuses to persist a review state without a user actor', () => {
    const root = makeRoot();
    expect(() =>
      appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview({ actor: 'system' })),
    ).toThrow(/human operator/i);
    expect(() =>
      appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview({ actor: undefined })),
    ).toThrow(/Invalid Aoi operator adaptive-acceptance review state/i);
    expect(loadAoiOperatorAdaptiveReviewStates(root, SESSION)).toEqual([]);
  });

  it('is idempotent for identical review inputs and keeps re-reviews as new records', () => {
    const root = makeRoot();
    appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview());
    appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview());
    // Same anchor + reviewedAt + status -> same content-hash filename -> one record.
    expect(loadAoiOperatorAdaptiveReviewStates(root, SESSION)).toHaveLength(1);

    // A later re-review (new timestamp) is a distinct record.
    appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview({ reviewedAt: 3000 }));
    const loaded = loadAoiOperatorAdaptiveReviewStates(root, SESSION);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((state) => state.reviewedAt)).toEqual([2000, 3000]);
  });

  it('ignores a directly-written system-actor review file at load time', () => {
    const root = makeRoot();
    const dir = resolveAoiAutonomyPaths(root, SESSION).operatorAdaptiveReviewDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, 'operator-adaptive-review-rogue.json'),
      JSON.stringify(adaptiveReview({ actor: 'system' })),
      'utf-8',
    );
    appendAoiOperatorAdaptiveReviewState(root, SESSION, adaptiveReview());

    const loaded = loadAoiOperatorAdaptiveReviewStates(root, SESSION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].actor).toBe('user');
  });
});
