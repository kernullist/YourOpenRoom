import { describe, expect, it } from 'vitest';
import {
  AOI_APPROVAL_TTL_DEFAULT_MS,
  isAoiApprovalTtlEnabled,
  isAoiApprovalTtlTrustSatisfied,
  resolveAoiApprovalTtlMs,
  resolveAoiApprovalTtlWindowMs,
  wasAoiApprovalTtlWindowUsed,
} from '../aoiApprovalTtl';
import type { AoiJarvisReadinessScorecard } from '../aoiJarvisReadinessScorecard';
import type { AoiJarvisReadinessLevel } from '../aoiJarvisReadinessScorecard';
import type { AoiProposalDecision } from '../aoiAutonomyTypes';

// The TTL functions only read gateStatus + level off the scorecard.
function scorecard(
  gateStatus: 'pass' | 'warning' | 'blocked',
  level: AoiJarvisReadinessLevel,
): AoiJarvisReadinessScorecard {
  return { gateStatus, level } as unknown as AoiJarvisReadinessScorecard;
}

function acceptDecision(overrides: Partial<AoiProposalDecision> = {}): AoiProposalDecision {
  return {
    id: 'decision-1',
    proposalId: 'p1',
    action: 'accept',
    createdAt: 1000,
    ...overrides,
  } as unknown as AoiProposalDecision;
}

describe('isAoiApprovalTtlEnabled()', () => {
  it('is OFF unless the opt-in flag is exactly "1"', () => {
    expect(isAoiApprovalTtlEnabled({})).toBe(false);
    expect(isAoiApprovalTtlEnabled({ AOI_AUTONOMY_APPROVAL_TTL: '0' })).toBe(false);
    expect(isAoiApprovalTtlEnabled({ AOI_AUTONOMY_APPROVAL_TTL: 'true' })).toBe(false);
    expect(isAoiApprovalTtlEnabled({ AOI_AUTONOMY_APPROVAL_TTL: '1' })).toBe(true);
    expect(typeof isAoiApprovalTtlEnabled()).toBe('boolean');
  });
});

describe('resolveAoiApprovalTtlMs()', () => {
  it('defaults to 1h when unset and accepts a positive override', () => {
    expect(resolveAoiApprovalTtlMs({})).toBe(AOI_APPROVAL_TTL_DEFAULT_MS);
    expect(AOI_APPROVAL_TTL_DEFAULT_MS).toBe(60 * 60 * 1000);
    expect(resolveAoiApprovalTtlMs({ AOI_AUTONOMY_APPROVAL_TTL_MS: '120000' })).toBe(120000);
    // Floors a fractional value.
    expect(resolveAoiApprovalTtlMs({ AOI_AUTONOMY_APPROVAL_TTL_MS: '90000.7' })).toBe(90000);
  });

  it('falls back to the default for zero / negative / non-numeric (never infinite or zero)', () => {
    expect(resolveAoiApprovalTtlMs({ AOI_AUTONOMY_APPROVAL_TTL_MS: '0' })).toBe(
      AOI_APPROVAL_TTL_DEFAULT_MS,
    );
    expect(resolveAoiApprovalTtlMs({ AOI_AUTONOMY_APPROVAL_TTL_MS: '-5' })).toBe(
      AOI_APPROVAL_TTL_DEFAULT_MS,
    );
    expect(resolveAoiApprovalTtlMs({ AOI_AUTONOMY_APPROVAL_TTL_MS: 'nope' })).toBe(
      AOI_APPROVAL_TTL_DEFAULT_MS,
    );
  });
});

describe('isAoiApprovalTtlTrustSatisfied()', () => {
  it('requires a clean pass at the trusted_operator rung', () => {
    expect(isAoiApprovalTtlTrustSatisfied(scorecard('pass', 'trusted_operator'))).toBe(true);
    // A lower rung never qualifies, even on a pass.
    expect(isAoiApprovalTtlTrustSatisfied(scorecard('pass', 'supervised_prepare'))).toBe(false);
    expect(isAoiApprovalTtlTrustSatisfied(scorecard('pass', 'field_preview'))).toBe(false);
    // trusted_operator with a non-pass gate never qualifies.
    expect(isAoiApprovalTtlTrustSatisfied(scorecard('warning', 'trusted_operator'))).toBe(false);
    expect(isAoiApprovalTtlTrustSatisfied(scorecard('blocked', 'trusted_operator'))).toBe(false);
  });
});

describe('resolveAoiApprovalTtlWindowMs()', () => {
  const trusted = scorecard('pass', 'trusted_operator');

  it('returns the window only when enabled + eligible + trust satisfied', () => {
    expect(
      resolveAoiApprovalTtlWindowMs({
        enabled: true,
        eligibleAppOperation: true,
        scorecard: trusted,
        env: {},
      }),
    ).toBe(AOI_APPROVAL_TTL_DEFAULT_MS);
  });

  it('returns null when the flag is off, the action is ineligible, or trust is not satisfied', () => {
    expect(
      resolveAoiApprovalTtlWindowMs({
        enabled: false,
        eligibleAppOperation: true,
        scorecard: trusted,
      }),
    ).toBeNull();
    expect(
      resolveAoiApprovalTtlWindowMs({
        enabled: true,
        eligibleAppOperation: false,
        scorecard: trusted,
      }),
    ).toBeNull();
    expect(
      resolveAoiApprovalTtlWindowMs({ enabled: true, eligibleAppOperation: true, scorecard: null }),
    ).toBeNull();
    expect(
      resolveAoiApprovalTtlWindowMs({
        enabled: true,
        eligibleAppOperation: true,
        scorecard: scorecard('pass', 'supervised_prepare'),
      }),
    ).toBeNull();
  });
});

describe('wasAoiApprovalTtlWindowUsed()', () => {
  it('is true only when the youngest matching accept is older than the strict window', () => {
    // Youngest accept at 1000; now=1000+10min+1 -> stale -> the window was the reason.
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [acceptDecision({ createdAt: 1000 })],
        proposalId: 'p1',
        now: 1000 + 10 * 60 * 1000 + 1,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it('is false for a fresh accept within the strict window', () => {
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [acceptDecision({ createdAt: 1000 })],
        proposalId: 'p1',
        now: 1000 + 60 * 1000,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it('uses the YOUNGEST matching accept (a recent re-accept means the window was not needed)', () => {
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [
          acceptDecision({ id: 'd-old', createdAt: 1000 }),
          acceptDecision({ id: 'd-new', createdAt: 5_000_000 }),
        ],
        proposalId: 'p1',
        now: 5_060_000,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it('returns false with no matching decision, and honors the decisionId filter', () => {
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [],
        proposalId: 'p1',
        now: 9_999_999,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
    // Non-accept and other-proposal decisions are ignored.
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [
          acceptDecision({ action: 'dismiss', createdAt: 1000 }),
          acceptDecision({ proposalId: 'other', createdAt: 1000 }),
        ],
        proposalId: 'p1',
        now: 9_999_999,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
    // decisionId filter: the matching id is stale -> true; a non-matching id -> no match.
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [acceptDecision({ id: 'd-target', createdAt: 1000 })],
        proposalId: 'p1',
        decisionId: 'd-target',
        now: 1000 + 10 * 60 * 1000 + 1,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(true);
    expect(
      wasAoiApprovalTtlWindowUsed({
        decisions: [acceptDecision({ id: 'd-target', createdAt: 1000 })],
        proposalId: 'p1',
        decisionId: 'd-other',
        now: 1000 + 10 * 60 * 1000 + 1,
        freshAcceptanceMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
  });
});
