import { describe, expect, it } from 'vitest';
import {
  feedbackMemoryProposalFixture,
  feedbackRefreshProposalFixture,
  highRiskProcedureProposalFixture,
  makeFeedbackDecisionFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  applyAoiFeedbackCalibrationToProposal,
  checkAoiEnvironmentSourceOperation,
  checkAoiProposalPolicy,
  compareAoiAutonomyLevel,
  getDefaultAoiEnvironmentSourceRegistry,
  evaluateAoiProposalExecution,
  getAoiFeedbackAdjustedCooldownMs,
  isAoiEnvironmentSourceEnabled,
  getAoiProposalFeedbackPriorityBoost,
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
    expect(getAoiToolAutonomyPolicy('create_kira_work')).toMatchObject({
      maxLevel: 'L4',
      requiresApproval: true,
    });
    expect(isAoiToolAllowedAtLevel('get_research_status', 'L2')).toBe(false);
    expect(isAoiToolAllowedAtLevel('get_research_status', 'L3')).toBe(true);
    for (const blockedTool of ['file_write', 'file_patch', 'file_delete', 'run_command']) {
      expect(isAoiToolAllowedAtLevel(blockedTool, 'L4')).toBe(false);
      expect(isAoiToolAllowedAtLevel(blockedTool, 'L5')).toBe(false);
    }
  });

  it('blocks unknown tools by default', () => {
    const unknown = getAoiToolAutonomyPolicy('remote_shell');

    expect(unknown.blocked).toBe(true);
    expect(isAoiToolAllowedAtLevel('remote_shell', 'L5')).toBe(false);
    expect(requiresAoiProposalApproval('remote_shell')).toBe(true);
  });
});

describe('Aoi environment source policy', () => {
  it('creates conservative defaults and keeps unknown sources fail-closed', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    expect(registry.sources.map((source) => source.kind)).toEqual([
      'workspace_git',
      'workspace_build',
      'kira_board',
      'research_runs',
      'app_state',
      'browser_context',
      'manual_note',
    ]);
    expect(isAoiEnvironmentSourceEnabled(registry, 'research-runs')).toBe(true);
    expect(isAoiEnvironmentSourceEnabled(registry, 'workspace-git')).toBe(false);
    expect(
      checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: 'unknown-source',
        operation: 'summarize',
      }),
    ).toMatchObject({
      allowed: false,
      reasons: ['unknown_source'],
    });
  });

  it('requires explicit target consent for browser and private sources', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    const blocked = checkAoiEnvironmentSourceOperation({
      registry: {
        ...registry,
        sources: registry.sources.map((source) =>
          source.id === 'browser-context'
            ? {
                ...source,
                enabled: true,
                consentReason: undefined,
              }
            : source,
        ),
      },
      sourceId: 'browser-context',
      operation: 'summarize',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('explicit_target_scope_required');

    const allowed = checkAoiEnvironmentSourceOperation({
      registry: {
        ...registry,
        sources: registry.sources.map((source) =>
          source.id === 'browser-context'
            ? {
                ...source,
                enabled: true,
                scope: 'explicit_target',
                consentReason: 'User attached the current page for this mission.',
              }
            : source,
        ),
      },
      sourceId: 'browser-context',
      operation: 'summarize',
    });
    expect(allowed).toMatchObject({
      allowed: true,
      reasons: [],
    });
  });

  it('blocks disabled sources and disallowed operations', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    expect(
      checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: 'workspace-git',
        operation: 'status',
      }).reasons,
    ).toContain('source_disabled');
    expect(
      checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: 'manual-note',
        operation: 'diff',
      }).reasons,
    ).toContain('operation_not_allowed:diff');
  });
});

describe('evaluateAoiProposalExecution()', () => {
  const policy = normalizeAoiAutonomyPolicy(
    {
      enabled: true,
      previewMode: true,
      level: 'L4',
    },
    DEFAULT_AOI_AUTONOMY_POLICY,
    2000,
  );
  const acceptDecision: AoiProposalDecision = {
    version: 1,
    id: 'decision-accept-001',
    proposalId: 'proposal-test-001',
    sessionPath: 'aoi/default',
    cooldownKey: 'research:kernel-memory',
    action: 'accept',
    actor: 'user',
    createdAt: 2500,
    previousStatus: 'active',
    nextStatus: 'accepted',
  };

  it('allows accepted read-only research artifact actions at L3', () => {
    const result = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        requiredAutonomyLevel: 'L3',
        acceptAction: {
          kind: 'read_research_artifact',
          params: { runId: 'aoi-research-test-001', artifact: 'report' },
        },
      }),
      normalizeAoiAutonomyPolicy({ enabled: true, previewMode: true, level: 'L3' }),
    );

    expect(result).toMatchObject({
      allowed: true,
      readOnly: true,
      actionKind: 'read_research_artifact',
    });
  });

  it('blocks start_research without fresh explicit acceptance', () => {
    const result = evaluateAoiProposalExecution(
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW research',
            mode: 'standard',
          },
        },
      }),
      policy,
      { now: 3000, decisions: [] },
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('missing_fresh_acceptance');
  });

  it('allows start_research after fresh acceptance at L4', () => {
    const result = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW research',
            mode: 'standard',
          },
        },
      }),
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );

    expect(result.allowed).toBe(true);
    expect(result.requiresFreshAcceptance).toBe(true);
  });

  it('requires fresh explicit acceptance for procedure memory promotion', () => {
    const withoutFreshAcceptance = evaluateAoiProposalExecution(
      highRiskProcedureProposalFixture,
      policy,
      { now: 3000, decisions: [] },
    );
    expect(withoutFreshAcceptance.allowed).toBe(false);
    expect(withoutFreshAcceptance.reasons).toContain('missing_fresh_acceptance');

    const withFreshAcceptance = evaluateAoiProposalExecution(
      highRiskProcedureProposalFixture,
      policy,
      {
        now: 3000,
        decisions: [
          {
            ...acceptDecision,
            proposalId: highRiskProcedureProposalFixture.id,
            cooldownKey: highRiskProcedureProposalFixture.cooldownKey,
          },
        ],
      },
    );
    expect(withFreshAcceptance).toMatchObject({
      allowed: true,
      actionKind: 'save_memory',
      requiresFreshAcceptance: true,
    });
  });

  it('requires accepted scoped proposals for supervised Kira handoff', () => {
    const kiraProposal = makeProposal({
      status: 'active',
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['create_kira_work'],
      acceptAction: {
        kind: 'create_kira_work',
        params: {
          projectName: 'YourOpenRoom',
          objective: 'Implement one reviewed Aoi autonomy UI improvement.',
          scope: ['Aoi autonomy UI'],
          modules: ['ChatPanel', 'aoiAutonomyExecution'],
          validationProfile: 'aoi-autonomy',
        },
      },
    });

    const withoutAcceptance = evaluateAoiProposalExecution(kiraProposal, policy, {
      now: 3000,
      decisions: [],
    });
    expect(withoutAcceptance.allowed).toBe(false);
    expect(withoutAcceptance.reasons).toContain('kira_handoff_requires_accepted_proposal');
    expect(withoutAcceptance.reasons).toContain('missing_fresh_acceptance');

    const preview = evaluateAoiProposalExecution({ ...kiraProposal, status: 'accepted' }, policy, {
      now: 3000,
      decisions: [acceptDecision],
      executionMode: 'preview',
    });
    expect(preview).toMatchObject({
      allowed: true,
      actionKind: 'create_kira_work',
      requiresFreshAcceptance: false,
    });

    const execute = evaluateAoiProposalExecution({ ...kiraProposal, status: 'accepted' }, policy, {
      now: 3000,
      decisions: [acceptDecision],
    });
    expect(execute).toMatchObject({
      allowed: true,
      requiresFreshAcceptance: true,
    });
  });

  it('blocks Kira handoff with missing evidence, arbitrary paths, or broad scope', () => {
    const base = makeProposal({
      status: 'accepted',
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['create_kira_work'],
      acceptAction: {
        kind: 'create_kira_work',
        params: {
          projectName: 'YourOpenRoom',
          objective: 'Rewrite the entire repository.',
          scope: ['entire repo'],
          modules: ['Aoi autonomy'],
        },
      },
    });
    const broad = evaluateAoiProposalExecution(base, policy, {
      now: 3000,
      decisions: [acceptDecision],
    });
    expect(broad.reasons).toContain('kira_handoff_scope_too_broad');
    expect(broad.safeAlternative).toContain('Narrow');

    const pathParam = evaluateAoiProposalExecution(
      {
        ...base,
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'F:\\secret\\repo',
            objective: 'Implement one reviewed Aoi autonomy UI improvement.',
            scope: ['Aoi autonomy UI'],
          },
        },
      },
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(pathParam.reasons).toContain('action_params_include_filesystem_path');

    const missingEvidence = evaluateAoiProposalExecution(
      {
        ...base,
        evidenceRefs: [],
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'YourOpenRoom',
            objective: 'Implement one reviewed Aoi autonomy UI improvement.',
            scope: ['Aoi autonomy UI'],
          },
        },
      },
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(missingEvidence.reasons).toContain('missing_evidence_refs');
  });

  it('blocks file writes, patches, deletes, commands, unknown actions, missing evidence, and filesystem path params', () => {
    for (const blockedTool of ['file_write', 'file_patch', 'file_delete', 'run_command']) {
      const result = evaluateAoiProposalExecution(
        makeProposal({
          status: 'accepted',
          suggestedTools: [blockedTool],
          acceptAction: {
            kind: blockedTool as never,
            params: { file_path: 'F:\\secret\\out.txt' },
          },
        }),
        policy,
        { now: 3000, decisions: [acceptDecision] },
      );
      expect(result.reasons).toEqual(
        expect.arrayContaining([
          `unknown_action_kind:${blockedTool}`,
          `tool_blocked:${blockedTool}`,
          'action_params_include_filesystem_path',
        ]),
      );
    }

    const unknown = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'remote_shell' as never,
          params: {},
        },
      }),
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(unknown.reasons).toContain('unknown_action_kind:remote_shell');

    const missingEvidence = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        evidenceRefs: [],
        acceptAction: {
          kind: 'read_research_artifact',
          params: { runId: 'aoi-research-test-001', artifact: 'report' },
        },
      }),
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(missingEvidence.reasons).toContain('missing_evidence_refs');
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

  it('reinforces useful proposals without bypassing cooldown checks', () => {
    const usefulDecision = makeFeedbackDecisionFixture({
      action: 'accept',
      nextStatus: 'accepted',
      feedbackCategory: 'useful',
    });
    const tooFrequentDecision = makeFeedbackDecisionFixture({
      id: 'decision-too-frequent-001',
      feedbackCategory: 'too_frequent',
      action: 'snooze',
      nextStatus: 'snoozed',
    });
    const calibrated = applyAoiFeedbackCalibrationToProposal(feedbackMemoryProposalFixture, [
      usefulDecision,
    ]);

    expect(calibrated.confidence).toBe(feedbackMemoryProposalFixture.confidence);
    expect(getAoiProposalFeedbackPriorityBoost(calibrated, [usefulDecision])).toBeGreaterThan(0);
    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: {
          ...calibrated,
          confidence: policy.confidenceFloor - 0.01,
        },
        recentDecisions: [usefulDecision],
        now: 4000,
      }).reasons,
    ).toContain('confidence_below_floor');
    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: calibrated,
        recentDecisions: [tooFrequentDecision],
        now: tooFrequentDecision.createdAt + policy.defaultCooldownMs + 1,
      }).reasons,
    ).toContain('cooldown_active');
  });

  it('penalizes proposals that reuse memory marked as wrong', () => {
    const wrongMemoryDecision = makeFeedbackDecisionFixture({
      feedbackCategory: 'wrong_memory',
    });
    const result = checkAoiProposalPolicy({
      policy: normalizeAoiAutonomyPolicy(
        { enabled: true, previewMode: true, level: 'L4', confidenceFloor: 0.65 },
        DEFAULT_AOI_AUTONOMY_POLICY,
        4000,
      ),
      proposal: feedbackMemoryProposalFixture,
      recentDecisions: [wrongMemoryDecision],
      now: 4000,
    });

    expect(result.reasons).toContain('confidence_below_floor');
  });

  it('prefers refresh proposals after stale-memory feedback', () => {
    const staleDecision = makeFeedbackDecisionFixture({
      feedbackCategory: 'stale',
    });

    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: [staleDecision],
        now: 4000,
      }).reasons,
    ).toContain('stale_memory_requires_refresh');

    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: feedbackRefreshProposalFixture,
        recentDecisions: [staleDecision],
        now: 4000,
      }).reasons,
    ).not.toContain('stale_memory_requires_refresh');
  });

  it('escalates cooldown when proposals are marked too frequent', () => {
    const decisions = [
      makeFeedbackDecisionFixture({
        id: 'decision-too-frequent-001',
        feedbackCategory: 'too_frequent',
        action: 'dismiss',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-too-frequent-002',
        feedbackCategory: 'too_frequent',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
    ];

    expect(
      getAoiFeedbackAdjustedCooldownMs({
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: decisions,
        baseCooldownMs: policy.defaultCooldownMs,
      }),
    ).toBe(policy.defaultCooldownMs * 3);
  });

  it('maps proactive timing and evidence feedback into calibration', () => {
    const timingDecisions = [
      makeFeedbackDecisionFixture({
        id: 'decision-too-much-001',
        feedbackCategory: 'too_much',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-wrong-timing-001',
        feedbackCategory: 'wrong_timing',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
    ];
    const wrongEvidenceDecision = makeFeedbackDecisionFixture({
      id: 'decision-wrong-evidence-001',
      feedbackCategory: 'wrong_evidence',
    });

    expect(
      getAoiFeedbackAdjustedCooldownMs({
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: timingDecisions,
        baseCooldownMs: policy.defaultCooldownMs,
      }),
    ).toBe(policy.defaultCooldownMs * 3);
    expect(
      checkAoiProposalPolicy({
        policy: normalizeAoiAutonomyPolicy(
          { enabled: true, previewMode: true, level: 'L4', confidenceFloor: 0.65 },
          DEFAULT_AOI_AUTONOMY_POLICY,
          4000,
        ),
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: [wrongEvidenceDecision],
        now: 4000,
      }).reasons,
    ).toContain('confidence_below_floor');
  });

  it('treats unsafe feedback as risk escalation, never risk reduction', () => {
    const unsafeDecision = makeFeedbackDecisionFixture({
      feedbackCategory: 'unsafe',
    });
    const calibrated = applyAoiFeedbackCalibrationToProposal(feedbackMemoryProposalFixture, [
      unsafeDecision,
    ]);

    expect(calibrated.risk).toBe('medium');
    expect(calibrated.requiresUserApproval).toBe(true);
    expect(compareAoiAutonomyLevel(calibrated.requiredAutonomyLevel, 'L4')).toBeGreaterThanOrEqual(
      0,
    );
  });
});
