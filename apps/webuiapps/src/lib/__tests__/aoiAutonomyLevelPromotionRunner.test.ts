import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import {
  loadAoiAutonomyLevelPromotionGateState,
  loadAoiAutonomyPolicy,
  recordAoiFieldShadowDecisions,
  recordAoiOperatorFeedbackLabelAction,
  saveAoiAutonomyLevelPromotionGateState,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import {
  buildAoiAutonomyLevelPromotionScorecard,
  maybeRunAoiAutonomyLevelPromotion,
  runAoiAutonomyLevelPromotion,
} from '../aoiAutonomyLevelPromotionRunner';
import type { AoiAutonomyLevelPromotionConfig } from '../aoiAutonomyLevelPromotion';
import type { AoiAutonomyLevel } from '../aoiAutonomyTypes';
import type { AoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';
import type { AoiShadowDecision } from '../aoiShadowModeEvaluation';

const SESSION = 'aoi/default';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-level-promote-'));
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

function scorecard(
  overrides: Partial<AoiJarvisReadinessScorecard> = {},
): AoiJarvisReadinessScorecard {
  return {
    version: 1,
    id: 'sc-1',
    sessionPath: SESSION,
    generatedAt: 1000,
    score: 96,
    level: 'trusted_operator',
    gateStatus: 'pass',
    canIncreaseTrust: true,
    modeRecommendation: 'candidate_for_higher_trust',
    visibility: {
      version: 1,
      dashboard: 'allowed',
      inline: 'allowed',
      directChat: 'allowed',
      workOrderPrepare: 'allowed',
      directChatBlockedReasons: [],
      workOrderPrepareBlockedReasons: [],
      summary: '',
      evidenceRefs: [],
    },
    metricGroups: [],
    metrics: [],
    gates: [],
    recommendations: [],
    evidenceRefs: [],
    blockerRefs: [],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...overrides,
  };
}

function config(
  overrides: Partial<AoiAutonomyLevelPromotionConfig> = {},
): AoiAutonomyLevelPromotionConfig {
  return { enabled: true, ceiling: 'L4', minConsecutive: 1, sustainMs: 0, ...overrides };
}

function seedPolicyLevel(root: string, level: AoiAutonomyLevel): void {
  saveAoiAutonomyPolicy(root, SESSION, { ...DEFAULT_AOI_AUTONOMY_POLICY, level });
}

function makeFieldShadowDecision(partial: Partial<AoiShadowDecision> = {}): AoiShadowDecision {
  return {
    version: 1,
    id: 'aoi-shadow-promote-candidate',
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
    dedupeKey: 'digest:field-shadow-promote:would_propose',
    ...partial,
  };
}

// Seed a labeled field-shadow record (operator labels a real decision). This is
// real candidate evidence the scorecard now assembles -- but it carries NO operator
// promotion decision, so it must never be enough to reach trusted_operator.
function seedLabeledFieldEvidence(root: string): void {
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
}

describe('runAoiAutonomyLevelPromotion', () => {
  it('promotes by one level, persists the new policy + gate state, and audits it', () => {
    const root = makeRoot();
    seedPolicyLevel(root, 'L3');
    const events: Array<{ type: string }> = [];

    const decision = runAoiAutonomyLevelPromotion(root, SESSION, {
      scorecard: scorecard(),
      config: config(),
      now: 5000,
      recordLedger: (event) => events.push(event),
    });

    expect(decision.action).toBe('promote');
    expect(decision.nextLevel).toBe('L4');
    expect(loadAoiAutonomyPolicy(root, SESSION).level).toBe('L4');
    expect(loadAoiAutonomyLevelPromotionGateState(root, SESSION)?.lastManagedLevel).toBe('L4');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('autonomy_level_promoted');
  });

  it('rolls back to baseline on regression and audits it', () => {
    const root = makeRoot();
    seedPolicyLevel(root, 'L4');
    saveAoiAutonomyLevelPromotionGateState(root, SESSION, {
      version: 1,
      sessionPath: SESSION,
      baselineLevel: 'L2',
      lastManagedLevel: 'L4',
      positiveSince: null,
      consecutivePositive: 0,
      lastEvaluatedAt: 0,
      history: [],
      updatedAt: 0,
    });
    const events: Array<{ type: string }> = [];

    const decision = runAoiAutonomyLevelPromotion(root, SESSION, {
      scorecard: scorecard({
        canIncreaseTrust: false,
        level: 'field_preview',
        gateStatus: 'warning',
      }),
      config: config(),
      now: 6000,
      recordLedger: (event) => events.push(event),
    });

    expect(decision.action).toBe('rollback');
    expect(decision.nextLevel).toBe('L2');
    expect(loadAoiAutonomyPolicy(root, SESSION).level).toBe('L2');
    expect(events[0]?.type).toBe('autonomy_level_rolled_back');
  });

  it('makes no change or write when auto-promotion is disabled', () => {
    const root = makeRoot();
    seedPolicyLevel(root, 'L3');
    const events: Array<{ type: string }> = [];

    const decision = runAoiAutonomyLevelPromotion(root, SESSION, {
      scorecard: scorecard(),
      config: config({ enabled: false }),
      now: 5000,
      recordLedger: (event) => events.push(event),
    });

    expect(decision.changed).toBe(false);
    expect(loadAoiAutonomyPolicy(root, SESSION).level).toBe('L3');
    expect(loadAoiAutonomyLevelPromotionGateState(root, SESSION)).toBeNull();
    expect(events).toHaveLength(0);
  });
});

describe('maybeRunAoiAutonomyLevelPromotion', () => {
  it('is a no-op (null) when not opted in via env', () => {
    const root = makeRoot();
    seedPolicyLevel(root, 'L2');

    const result = maybeRunAoiAutonomyLevelPromotion({
      sessionsDir: root,
      sessionPath: SESSION,
      env: {},
      now: 5000,
    });

    expect(result).toBeNull();
    expect(loadAoiAutonomyPolicy(root, SESSION).level).toBe('L2');
  });

  it('runs when opted in but conservatively holds without field-readiness evidence', () => {
    const root = makeRoot();
    seedPolicyLevel(root, 'L2');

    const result = maybeRunAoiAutonomyLevelPromotion({
      sessionsDir: root,
      sessionPath: SESSION,
      env: {
        AOI_AUTONOMY_AUTO_PROMOTE: '1',
        AOI_AUTONOMY_AUTO_PROMOTE_SUSTAIN_MS: '0',
        AOI_AUTONOMY_AUTO_PROMOTE_MIN_CONSECUTIVE: '1',
      },
      now: 5000,
    });

    // An empty session has no trusted-operator readiness, so it must not promote.
    expect(result?.changed).toBe(false);
    expect(loadAoiAutonomyPolicy(root, SESSION).level).toBe('L2');
  });

  it('holds without promotion even when labeled trace-promotion candidate evidence exists', () => {
    const root = makeRoot();
    seedPolicyLevel(root, 'L2');
    seedLabeledFieldEvidence(root);

    const result = maybeRunAoiAutonomyLevelPromotion({
      sessionsDir: root,
      sessionPath: SESSION,
      env: {
        AOI_AUTONOMY_AUTO_PROMOTE: '1',
        AOI_AUTONOMY_AUTO_PROMOTE_SUSTAIN_MS: '0',
        AOI_AUTONOMY_AUTO_PROMOTE_MIN_CONSECUTIVE: '1',
      },
      now: 5000,
    });

    // Candidate evidence is now assembled into the scorecard, but no operator
    // promotion decisions exist -> promotedReplayPassRate stays < 1 -> trusted_operator
    // is unreachable -> no escalation. The conservative gate holds.
    expect(result?.changed).toBe(false);
    expect(loadAoiAutonomyPolicy(root, SESSION).level).toBe('L2');
  });
});

describe('buildAoiAutonomyLevelPromotionScorecard', () => {
  it('builds a valid display-only scorecard on an empty session below trusted_operator', () => {
    const root = makeRoot();

    const card = buildAoiAutonomyLevelPromotionScorecard(root, SESSION, 5000);

    expect(card.sessionPath).toBe(SESSION);
    expect(card.level).not.toBe('trusted_operator');
    expect(card.actionAuthority).toBe('display_only');
    expect(card.mutationCount).toBe(0);
  });

  it('assembles candidate evidence from labeled field traces yet stays below trusted_operator', () => {
    const root = makeRoot();
    seedLabeledFieldEvidence(root);

    const card = buildAoiAutonomyLevelPromotionScorecard(root, SESSION, 5000);

    // The assembler ran over real labeled evidence without throwing and produced a
    // display-only scorecard; with zero operator promotions it cannot reach the
    // trusted_operator level that would unlock auto-escalation.
    expect(card.level).not.toBe('trusted_operator');
    expect(card.actionAuthority).toBe('display_only');
    expect(card.mutationCount).toBe(0);
  });
});
