import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadAoiOperatorAdaptiveReviewStates,
  loadAoiOperatorTracePromotionDecisions,
  recordAoiFieldShadowDecisions,
  recordAoiOperatorFeedbackLabelAction,
  resolveAoiAutonomyPaths,
} from '../aoiAutonomyStore';
import {
  applyAoiOperatorPromotionReview,
  loadAoiOperatorReviewQueue,
} from '../aoiOperatorPromotionReviewServer';
import type { AoiOperatorTraceExport } from '../aoiAutonomyTypes';
import type { AoiShadowDecision } from '../aoiShadowModeEvaluation';

const SESSION = 'aoi/default';
const NOW = 5000;
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-operator-review-'));
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

function makeFieldShadowDecision(partial: Partial<AoiShadowDecision> = {}): AoiShadowDecision {
  return {
    version: 1,
    id: 'aoi-shadow-review-candidate',
    sessionPath: SESSION,
    kind: 'would_propose',
    createdAt: 1000,
    sourceRefs: ['workspace:validation'],
    sourceSummary: 'Workspace validation is stale.',
    consentState: 'unknown',
    risk: 'low',
    policyResult: 'not_applicable',
    mutationCount: 0,
    evidenceRefs: ['workspace:validation-stale'],
    dedupeKey: 'digest:field-shadow-review:would_propose',
    ...partial,
  };
}

function writeTraceExport(
  root: string,
  record: { decisionId: string; evidenceRefs: string[] },
  options: { blocked?: boolean } = {},
): void {
  const summary = options.blocked
    ? 'Operator note: forward the raw body to leaked@example.com immediately.'
    : 'Operator marked the workspace validation suggestion as useful.';
  const traceExport: AoiOperatorTraceExport = {
    version: 1,
    id: 'aoi-trace-export-review-1',
    sessionPath: SESSION,
    exportedAt: 2500,
    eventCount: 1,
    sourceEventIds: ['aoi-timeline-review-1'],
    events: [
      {
        version: 1,
        id: 'aoi-timeline-review-1',
        sessionPath: SESSION,
        kind: 'feedback_recorded',
        visibility: 'operator_visible',
        createdAt: 2400,
        title: 'Operator labeled a useful proposal',
        summary,
        redactionState: options.blocked ? 'none' : 'synthetic',
        evidenceRefs: [`shadow-decision:${record.decisionId}`, ...record.evidenceRefs],
        relatedRefs: [],
      },
    ],
    redactionSummary: {
      totalReplacementCount: options.blocked ? 0 : 1,
      localPathCount: 0,
      urlCount: 0,
      emailCount: 0,
      privateFieldCount: options.blocked ? 0 : 1,
      syntheticLabels: options.blocked ? {} : { '[redacted-field:1]': 'redacted' },
    },
    privacyNotes: [],
  };
  const dir = resolveAoiAutonomyPaths(root, SESSION).timelineExportsDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, `${traceExport.id}.json`),
    JSON.stringify(traceExport, null, 2),
    'utf-8',
  );
}

// Seed one labeled field decision (and optionally a matching trace export) so the
// review queue has trace + adaptive candidates to operate on.
function seedReviewEvidence(
  root: string,
  options: { withTrace?: boolean; blocked?: boolean } = {},
): {
  decisionId: string;
} {
  const report = recordAoiFieldShadowDecisions(root, {
    sessionPath: SESSION,
    decisions: [makeFieldShadowDecision()],
    now: 1000,
  });
  const record = report.records[0];
  if (!record) {
    throw new Error('Expected a field shadow record.');
  }
  recordAoiOperatorFeedbackLabelAction(root, {
    sessionPath: SESSION,
    decisionRecordId: record.id,
    decisionId: record.decisionId,
    label: 'useful',
    sourceKinds: ['workspace_build'],
    evidenceRefs: record.evidenceRefs,
    now: 2000,
  });
  if (options.withTrace !== false) {
    writeTraceExport(root, record, { blocked: options.blocked ?? false });
  }
  return { decisionId: record.decisionId };
}

describe('loadAoiOperatorReviewQueue', () => {
  it('lists trace + adaptive candidates with a 0 pass rate before any review', () => {
    const root = makeRoot();
    seedReviewEvidence(root);

    const queue = loadAoiOperatorReviewQueue(root, SESSION, NOW);

    expect(queue.candidates.some((candidate) => candidate.kind === 'trace')).toBe(true);
    expect(queue.candidates.some((candidate) => candidate.kind === 'adaptive')).toBe(true);
    expect(queue.promotedCount).toBe(0);
    expect(queue.promotedReplayPassRate).toBe(0);
  });

  it('throws on an invalid sessionPath', () => {
    const root = makeRoot();
    expect(() => loadAoiOperatorReviewQueue(root, '../escape', NOW)).toThrow(/sessionPath/i);
  });
});

describe('applyAoiOperatorPromotionReview', () => {
  it('promotes the full candidate set and drives promotedReplayPassRate to 1', () => {
    const root = makeRoot();
    seedReviewEvidence(root);

    const initial = loadAoiOperatorReviewQueue(root, SESSION, NOW);
    let queue = initial;
    for (const candidate of initial.candidates) {
      const outcome = applyAoiOperatorPromotionReview(
        root,
        SESSION,
        {
          kind: candidate.kind,
          candidateId: candidate.candidateId,
          action: 'promote',
          reason: 'Operator reviewed the redacted trace and promoted it.',
        },
        NOW,
      );
      expect(outcome.result.ok).toBe(true);
      queue = outcome.queue;
    }

    expect(queue.promotedReplayPassRate).toBe(1);
    // The persisted records are operator-authored (the store enforces actor=user).
    const traceDecisions = loadAoiOperatorTracePromotionDecisions(root, SESSION);
    const reviewStates = loadAoiOperatorAdaptiveReviewStates(root, SESSION);
    expect(traceDecisions.length).toBeGreaterThan(0);
    expect(traceDecisions.every((decision) => decision.actor === 'user')).toBe(true);
    expect(reviewStates.every((state) => state.actor === 'user')).toBe(true);
  });

  it('requires a reason to promote and persists nothing on failure', () => {
    const root = makeRoot();
    seedReviewEvidence(root);
    const queue = loadAoiOperatorReviewQueue(root, SESSION, NOW);
    const trace = queue.candidates.find((candidate) => candidate.kind === 'trace');
    if (!trace) {
      throw new Error('Expected a trace candidate.');
    }

    const outcome = applyAoiOperatorPromotionReview(
      root,
      SESSION,
      { kind: 'trace', candidateId: trace.candidateId, action: 'promote' },
      NOW,
    );

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.code).toBe('reason_required');
    }
    expect(loadAoiOperatorTracePromotionDecisions(root, SESSION)).toEqual([]);
  });

  it('reports candidate_not_found for an unknown candidate id', () => {
    const root = makeRoot();
    seedReviewEvidence(root);

    const outcome = applyAoiOperatorPromotionReview(
      root,
      SESSION,
      { kind: 'trace', candidateId: 'aoi-trace-promotion-does-not-exist', action: 'defer' },
      NOW,
    );

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.code).toBe('candidate_not_found');
    }
  });

  it('refuses to promote a privacy-blocked candidate', () => {
    const root = makeRoot();
    // No related trace -> the adaptive candidate has a blocked replay draft.
    seedReviewEvidence(root, { withTrace: false });
    const queue = loadAoiOperatorReviewQueue(root, SESSION, NOW);
    const adaptive = queue.candidates.find((candidate) => candidate.kind === 'adaptive');
    if (!adaptive) {
      throw new Error('Expected an adaptive candidate.');
    }
    expect(adaptive.promotable).toBe(false);

    const outcome = applyAoiOperatorPromotionReview(
      root,
      SESSION,
      {
        kind: 'adaptive',
        candidateId: adaptive.candidateId,
        action: 'promote',
        reason: 'Attempting to promote a blocked candidate.',
      },
      NOW,
    );

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.code).toBe('privacy_blocked');
    }
    expect(loadAoiOperatorAdaptiveReviewStates(root, SESSION)).toEqual([]);
  });

  it('refuses to promote a privacy-blocked trace candidate', () => {
    const root = makeRoot();
    seedReviewEvidence(root, { blocked: true });
    const queue = loadAoiOperatorReviewQueue(root, SESSION, NOW);
    const trace = queue.candidates.find((candidate) => candidate.kind === 'trace');
    if (!trace) {
      throw new Error('Expected a trace candidate.');
    }
    expect(trace.promotable).toBe(false);

    const outcome = applyAoiOperatorPromotionReview(
      root,
      SESSION,
      {
        kind: 'trace',
        candidateId: trace.candidateId,
        action: 'promote',
        reason: 'Attempting to promote a privacy-blocked trace.',
      },
      NOW,
    );

    expect(outcome.result.ok).toBe(false);
    if (!outcome.result.ok) {
      expect(outcome.result.code).toBe('privacy_blocked');
    }
  });
});
