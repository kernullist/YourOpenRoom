import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  checkAoiProposalPolicy,
  getAoiToolAutonomyPolicy,
  isAoiToolAllowedAtLevel,
  normalizeAoiAutonomyPolicy,
  requiresAoiProposalApproval,
} from '../aoiAutonomyPolicy';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-test-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Open previous research',
    body: 'A previous Aoi research run may answer this.',
    reason: 'The current topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:kernel-memory',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-001'],
    memoryIds: ['aoi-memory-001'],
    artifactRefs: ['research:aoi-research-001/report'],
    riskSignals: [],
    ...partial,
  };
}

describe('Aoi autonomy policy defaults', () => {
  it('keeps autonomy conservative and preview-only by default', () => {
    expect(DEFAULT_AOI_AUTONOMY_POLICY.enabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.previewMode).toBe(true);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.level).toBe('L1');
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveSuggestionsEnabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.maxActiveProposals).toBeLessThanOrEqual(8);
  });

  it('normalizes partial policy values with bounded numeric limits', () => {
    const policy = normalizeAoiAutonomyPolicy(
      {
        enabled: true,
        previewMode: false,
        level: 'L4',
        proactiveSuggestionsEnabled: true,
        confidenceFloor: 99,
        maxActiveProposals: 0,
        defaultCooldownMs: 1,
      },
      DEFAULT_AOI_AUTONOMY_POLICY,
      1234,
    );

    expect(policy).toMatchObject({
      version: 1,
      enabled: true,
      previewMode: false,
      level: 'L4',
      proactiveSuggestionsEnabled: true,
      confidenceFloor: 1,
      maxActiveProposals: 1,
      defaultCooldownMs: 60_000,
      updatedAt: 1234,
    });
  });
});

describe('Aoi autonomy tool policy', () => {
  it('allows only registered tools at sufficient autonomy levels', () => {
    expect(getAoiToolAutonomyPolicy('get_research_status')).toMatchObject({
      maxLevel: 'L3',
      requiresApproval: false,
    });
    expect(isAoiToolAllowedAtLevel('get_research_status', 'L2')).toBe(false);
    expect(isAoiToolAllowedAtLevel('get_research_status', 'L3')).toBe(true);
    expect(isAoiToolAllowedAtLevel('file_write', 'L4')).toBe(false);
    expect(isAoiToolAllowedAtLevel('file_write', 'L5')).toBe(true);
  });

  it('blocks unknown tools by default', () => {
    const unknown = getAoiToolAutonomyPolicy('remote_shell');

    expect(unknown.blocked).toBe(true);
    expect(isAoiToolAllowedAtLevel('remote_shell', 'L5')).toBe(false);
    expect(requiresAoiProposalApproval('remote_shell')).toBe(true);
  });
});

describe('checkAoiProposalPolicy()', () => {
  const policy = normalizeAoiAutonomyPolicy(
    {
      enabled: true,
      previewMode: true,
      level: 'L4',
      confidenceFloor: 0.55,
      maxActiveProposals: 4,
    },
    DEFAULT_AOI_AUTONOMY_POLICY,
    2000,
  );

  it('accepts an evidence-backed proposal within the active autonomy level', () => {
    expect(checkAoiProposalPolicy({ policy, proposal: makeProposal() })).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('blocks proposals when autonomy is neither enabled nor in preview mode', () => {
    const disabled = normalizeAoiAutonomyPolicy(
      { enabled: false, previewMode: false, level: 'L4' },
      DEFAULT_AOI_AUTONOMY_POLICY,
      2000,
    );

    expect(
      checkAoiProposalPolicy({ policy: disabled, proposal: makeProposal() }).reasons,
    ).toContain('autonomy_disabled');
  });

  it('blocks low-confidence and evidence-free proposals', () => {
    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ confidence: 0.1, evidenceRefs: [] }),
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['confidence_below_floor', 'missing_evidence_refs']),
    );
  });

  it('blocks duplicate active proposals by cooldown key', () => {
    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ id: 'proposal-new-001' }),
      activeProposals: [makeProposal({ id: 'proposal-existing-001' })],
    });

    expect(result.reasons).toContain('duplicate_active_proposal');
  });

  it('uses dismissed and snoozed decisions as cooldown evidence for the same key', () => {
    const recentDecision: AoiProposalDecision = {
      version: 1,
      id: 'decision-test-001',
      proposalId: 'proposal-old-001',
      sessionPath: 'aoi/default',
      cooldownKey: 'research:kernel-memory',
      action: 'dismiss',
      actor: 'user',
      createdAt: 2500,
      previousStatus: 'active',
      nextStatus: 'dismissed',
    };

    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ id: 'proposal-new-001' }),
      recentDecisions: [recentDecision],
      now: 3000,
    });

    expect(result.reasons).toContain('cooldown_active');
  });

  it('blocks unknown suggested tools and high-risk proposals without approval', () => {
    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({
        risk: 'high',
        requiresUserApproval: false,
        suggestedTools: ['remote_shell'],
        requiredAutonomyLevel: 'L5',
      }),
    });

    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'autonomy_level_too_low',
        'tool_blocked:remote_shell',
        'high_risk_requires_approval',
      ]),
    );
  });
});
