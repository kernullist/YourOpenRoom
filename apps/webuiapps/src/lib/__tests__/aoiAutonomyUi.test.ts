import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { decideAoiMission } from '../aoiAutonomyClient';
import {
  AOI_AUTONOMY_PANEL_SETTINGS_KEY,
  buildAoiBlockedStateSummary,
  buildAoiBlockedProactiveExplanation,
  buildAoiAutonomyNotificationBadge,
  buildAoiMissionPanelSummary,
  buildAoiMissionResumePrompt,
  buildAoiProposalActionPresentation,
  buildAoiProposalInspectorSummary,
  buildAoiProactiveExplanation,
  buildAoiRecoveryPreviewSummary,
  canShowAoiProposalPrimaryAction,
  getAoiSafeAlternativeForReasons,
  loadAoiAutonomyPanelSettings,
  saveAoiAutonomyPanelSettings,
  sanitizeAoiProposalDisplayText,
  selectAoiInlineProposal,
} from '../aoiAutonomyUi';
import type { AoiAutonomyPolicy, AoiMissionState, AoiProposal } from '../aoiAutonomyTypes';

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    level: 'L3',
    updatedAt: 1000,
    ...partial,
  };
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'aoi-proposal-ui-test-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Open matching research',
    body: 'A completed Aoi research report may answer the current question.',
    reason: 'The current topic overlaps with a completed research run.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:memory',
    confidence: 0.72,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: true,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-ui-test'],
    memoryIds: ['aoi-memory-ui-test'],
    artifactRefs: ['research:aoi-research-ui-test/report'],
    riskSignals: [],
    ...partial,
  };
}

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    status: 'waiting_on_research',
    activeGoalId: 'aoi-goal-ui-test',
    focusSummary: 'Refresh Windows kernel security research',
    waitingOn: 'research',
    lastMeaningfulEventRef: 'goal-progress:ui-test',
    nextRecommendedAction: {
      kind: 'inspect_research',
      label: 'Inspect research run status.',
      reason: 'A research run is linked to the mission.',
      ref: 'research:aoi-research-ui-test',
    },
    evidenceRefs: [
      'goal:aoi-goal-ui-test',
      'research:aoi-research-ui-test',
      'proposal:aoi-proposal-ui-test-001',
    ],
    sourceRefs: {
      goalRef: 'goal:aoi-goal-ui-test',
      proposalRef: 'proposal:aoi-proposal-ui-test-001',
      researchRunRef: 'research:aoi-research-ui-test',
    },
    transitions: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...partial,
  };
}

describe('Aoi autonomy UI helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the highest-value active inline proposal', () => {
    const lowValue = makeProposal({
      id: 'aoi-proposal-low',
      confidence: 0.56,
      risk: 'medium',
      updatedAt: 2000,
    });
    const highValue = makeProposal({
      id: 'aoi-proposal-high',
      confidence: 0.91,
      risk: 'low',
      evidenceRefs: ['memory:1', 'research:2', 'tool:3'],
      updatedAt: 1500,
    });

    expect(
      selectAoiInlineProposal([lowValue, highValue], makePolicy(), {
        now: 3000,
      })?.id,
    ).toBe('aoi-proposal-high');
  });

  it('hides dismissed and snoozed proposals from inline suggestions', () => {
    const dismissed = makeProposal({ id: 'aoi-proposal-dismissed' });
    const snoozed = makeProposal({ id: 'aoi-proposal-snoozed' });
    const visible = makeProposal({ id: 'aoi-proposal-visible', confidence: 0.65 });

    expect(
      selectAoiInlineProposal([dismissed, snoozed, visible], makePolicy(), {
        now: 3000,
        dismissedProposalIds: new Set([dismissed.id]),
        snoozedProposalIds: new Set([snoozed.id]),
      })?.id,
    ).toBe('aoi-proposal-visible');
  });

  it('does not expose a primary action for blocked proposals', () => {
    expect(
      canShowAoiProposalPrimaryAction(
        makeProposal({
          status: 'blocked',
          blockedReason: 'Policy level is too low.',
        }),
        3000,
      ),
    ).toBe(false);
  });

  it('keeps inline suggestions conservative with default policy', () => {
    expect(DEFAULT_AOI_AUTONOMY_POLICY.enabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveSuggestionsEnabled).toBe(false);
    expect(selectAoiInlineProposal([makeProposal()], DEFAULT_AOI_AUTONOMY_POLICY)).toBeNull();
  });

  it('suppresses proactive inline suggestions in quiet mode', () => {
    expect(
      selectAoiInlineProposal([makeProposal()], makePolicy(), {
        now: 3000,
        quietMode: true,
      }),
    ).toBeNull();
  });

  it('keeps dashboard badges quiet and ignores high-risk goal proposal nudges', () => {
    const highRiskGoalProposal = makeProposal({
      risk: 'high',
      trigger: 'goal_continuation',
      artifactRefs: ['goal:aoi-goal-ui-test'],
    });
    const lowRiskGoalProposal = makeProposal({
      id: 'aoi-proposal-low-risk-goal',
      trigger: 'goal_continuation',
      artifactRefs: ['goal:aoi-goal-ui-test'],
    });

    expect(
      buildAoiAutonomyNotificationBadge({
        proposals: [highRiskGoalProposal],
        settings: {
          panelExpanded: true,
          notificationsEnabled: false,
          quietMode: false,
          maxSuggestionsPerSession: 3,
        },
      }),
    ).toBeNull();
    expect(
      buildAoiAutonomyNotificationBadge({
        proposals: [lowRiskGoalProposal],
        settings: {
          panelExpanded: true,
          notificationsEnabled: false,
          quietMode: true,
          maxSuggestionsPerSession: 3,
        },
      }),
    ).toBeNull();
    expect(
      buildAoiAutonomyNotificationBadge({
        proposals: [lowRiskGoalProposal],
      })?.reason,
    ).toBe('goal_proposal');
    expect(
      buildAoiAutonomyNotificationBadge({
        status: {
          version: 1,
          sessionPath: 'aoi/default',
          policy: makePolicy(),
          activeProposalCount: 1,
          archivedProposalCount: 0,
          acceptedProposalCount: 0,
          snoozedProposalCount: 0,
          blockedProposalCount: 0,
          observationCount: 2,
          reflectionCount: 0,
          decisionCount: 0,
          activeTick: false,
          recentObservationCount: 2,
          proposalsCreatedInLastTick: 1,
          activeGoalCount: 0,
          updatedAt: 4000,
        },
        proposals: [
          makeProposal({
            id: 'aoi-proposal-attention',
            trigger: 'attention_broker',
            title: 'Review completed Aoi research',
            reason: 'Background research finished while you were away.',
          }),
        ],
      }),
    ).toMatchObject({
      label: '1 attention update',
      why: 'Background research finished while you were away.',
      reason: 'background_event',
    });
  });

  it('keeps proposal inspector evidence refs opt-in', () => {
    const proposal = makeProposal({
      acceptAction: {
        kind: 'read_research_artifact',
        params: { artifact: 'report' },
      },
      evidenceRefs: ['memory:aoi-memory-ui-test', 'research:aoi-research-ui-test/report'],
      suggestedTools: ['read_research_artifact'],
    });
    const collapsed = buildAoiProposalInspectorSummary({
      proposal,
      policy: makePolicy(),
      activeProposals: [makeProposal({ id: 'aoi-proposal-duplicate' })],
      includeEvidence: false,
      now: 4000,
    });
    const expanded = buildAoiProposalInspectorSummary({
      proposal,
      policy: makePolicy(),
      activeProposals: [makeProposal({ id: 'aoi-proposal-duplicate' })],
      includeEvidence: true,
      now: 4000,
    });

    expect(collapsed.evidenceRefs).toEqual([]);
    expect(expanded.evidenceRefs).toEqual(proposal.evidenceRefs);
    expect(collapsed.suggestedAction).toBe('read_research_artifact');
    expect(collapsed.policyAllowed).toBe(false);
    expect(collapsed.policyReasons).toContain('duplicate_active_proposal');
  });

  it('builds recovery preview summaries with retry and non-goal details', () => {
    const proposal = makeProposal({
      trigger: 'failure_recovery',
      recoveryPreview: {
        version: 1,
        failureKind: 'kira_validation_failed',
        rootCauseSummary: 'Observed validation failed signal from Kira.',
        evidenceRefs: ['memory:kira-failed-001'],
        proposedAction: {
          kind: 'prepare_kira_followup',
          label: 'Prepare Kira follow-up',
          reason: 'Target validation evidence only.',
        },
        whyNarrowerOrSafer: 'Bounded to one failed Kira work item.',
        retryCount: 1,
        maxRetryCount: 2,
        cooldownActive: true,
        cooldownUntil: 2000,
        sourceRef: 'memory:kira-failed-001',
        failureSignature: 'failure:kira_validation_failed:test',
        nonGoals: ['Do not create broad Kira work that fixes everything at once.'],
      },
    });

    const summary = buildAoiRecoveryPreviewSummary(proposal, true);

    expect(summary).toMatchObject({
      visible: true,
      failureKind: 'kira validation failed',
      proposedActionLabel: 'Prepare Kira follow-up',
      retryLabel: '1/2 retries used',
    });
    expect(summary.cooldownLabel).toContain('cooldown active');
    expect(summary.evidenceRefs).toEqual(['memory:kira-failed-001']);
    expect(summary.nonGoals[0]).toContain('Do not create broad Kira work');
  });

  it('persists conservative panel notification settings', () => {
    const storage = new Map<string, string>();
    const storageAdapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    const saved = saveAoiAutonomyPanelSettings(
      {
        panelExpanded: false,
        notificationsEnabled: true,
        quietMode: true,
        maxSuggestionsPerSession: 99,
      },
      storageAdapter,
    );

    expect(saved).toMatchObject({
      panelExpanded: false,
      notificationsEnabled: true,
      quietMode: true,
      maxSuggestionsPerSession: 12,
    });
    expect(storage.has(AOI_AUTONOMY_PANEL_SETTINGS_KEY)).toBe(true);
    expect(loadAoiAutonomyPanelSettings(storageAdapter)).toEqual(saved);
  });

  it('redacts local private paths from proposal display text', () => {
    expect(
      sanitizeAoiProposalDisplayText('Read F:\\kernullist\\YourOpenRoom\\private\\report.md now'),
    ).toBe('Read [local path] now');
  });

  it('redacts local paths and secrets from proactive explanations', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        reason:
          'Read F:\\kernullist\\YourOpenRoom\\private\\report.md with api_key=secret-value before suggesting the next step.',
        body: 'Token ghp_1234567890abcdefghijkl should never be shown.',
      }),
      policy: makePolicy(),
      includeEvidence: true,
    });

    expect(explanation.messageSummary).toContain('[local path]');
    expect(explanation.messageSummary).toContain('api_key=[private secret]');
    expect(explanation.messageSummary).not.toContain('secret-value');
    expect(explanation.details.join(' ')).toContain('[private secret]');
    expect(explanation.details.join(' ')).not.toContain('ghp_1234567890abcdefghijkl');
  });

  it('builds short proactive message summaries with the full explanation contract', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal(),
      policy: makePolicy(),
    });

    expect(explanation).toMatchObject({
      whyNow: 'The current topic overlaps with a completed research run.',
      whatChanged: 'A research followup proposal is ready for review.',
      evidenceSummary: '1 evidence ref attached; details stay in the panel.',
      safeNextAction: 'Approve exact action',
      approvalBoundary: 'I will not run tools or change state without explicit approval.',
      evidenceRefs: [],
      evidenceCount: 1,
      risk: 'low',
    });
    expect(explanation.messageSummary).toMatchInlineSnapshot(
      `"Why now: The current topic overlaps with a completed research run. Changed: A research followup proposal is ready for review. Evidence: 1 evidence ref attached; details stay in the panel. Next: Approve exact action Boundary: I will not run tools or change state without explicit approval."`,
    );
    expect(explanation.messageSummary.length).toBeLessThan(360);
  });

  it('includes approval boundaries for high-risk proactive explanations', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        risk: 'high',
        requiredAutonomyLevel: 'L5',
        requiresUserApproval: true,
        acceptAction: {
          kind: 'start_research',
          params: {
            query: 'high risk follow-up',
          },
        },
      }),
      policy: makePolicy({ level: 'L5' }),
    });

    expect(explanation.risk).toBe('high');
    expect(explanation.willNotDoWithoutApproval).toContain('explicit approval');
    expect(explanation.messageSummary).toContain('Boundary:');
  });

  it('explains Kira handoff boundaries without claiming direct file edits', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        status: 'accepted',
        title: 'Create one reviewed Kira work item',
        trigger: 'goal_continuation',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        suggestedTools: ['create_kira_work'],
        evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            title: 'Implement one reviewed follow-up',
          },
        },
      }),
      policy: makePolicy({ level: 'L4' }),
      hasKiraPreview: true,
    });

    expect(explanation.safeNextAction).toBe('Approve and create Kira work item');
    expect(explanation.willNotDoWithoutApproval).toContain('reviewed Kira work item');
    expect(explanation.willNotDoWithoutApproval).toContain('will not edit files');
    expect(explanation.messageSummary).toContain('Boundary:');
  });

  it('explains failed validation recovery as a narrow follow-up', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        trigger: 'failure_recovery',
        title: 'Prepare Kira validation follow-up',
        reason: 'Kira validation failed and the recovery should target evidence only.',
        risk: 'medium',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['create_kira_work'],
        evidenceRefs: ['event:kira-validation-failed-001'],
        recoveryPreview: {
          version: 1,
          failureKind: 'kira_validation_failed',
          rootCauseSummary: 'Kira validation failed after review.',
          evidenceRefs: ['event:kira-validation-failed-001'],
          proposedAction: {
            kind: 'prepare_kira_followup',
            label: 'Prepare Kira follow-up',
            reason: 'Target validation evidence only.',
          },
          whyNarrowerOrSafer: 'Bounded to one failed validation item.',
          retryCount: 0,
          maxRetryCount: 2,
          cooldownActive: false,
          sourceRef: 'event:kira-validation-failed-001',
          failureSignature: 'failure:kira_validation_failed:test',
          nonGoals: ['Do not broaden scope.'],
        },
      }),
      policy: makePolicy({ level: 'L4' }),
    });

    expect(explanation.whatChanged).toContain('narrower recovery proposal');
    expect(explanation.messageSummary).toContain('Kira validation failed');
    expect(explanation.messageSummary).toContain('Boundary:');
  });

  it('avoids confident wording when evidence is weak', () => {
    const explanation = buildAoiProactiveExplanation({
      proposal: makeProposal({
        confidence: 0.42,
        evidenceRefs: [],
        memoryIds: [],
        reason: 'The current topic might overlap with an older note.',
      }),
      policy: makePolicy(),
    });

    expect(explanation.lowEvidence).toBe(true);
    expect(explanation.confidenceLabel).toBe('low evidence');
    expect(explanation.messageSummary).toContain('Limited evidence');
    expect(explanation.messageSummary).not.toMatch(/\bready\b/i);
  });

  it('shows a narrowing alternative for broad Kira handoff policy blocks', () => {
    expect(
      getAoiSafeAlternativeForReasons(makeProposal({ requiredAutonomyLevel: 'L4' }), [
        'kira_handoff_scope_too_broad',
      ]),
    ).toContain('Narrow');
  });

  it('builds compact mission panel and prompt context', () => {
    const mission = makeMission();
    const collapsed = buildAoiMissionPanelSummary(mission);
    const expanded = buildAoiMissionPanelSummary(mission, true);
    const prompt = buildAoiMissionResumePrompt(mission);

    expect(collapsed).toMatchObject({
      visible: true,
      waitingOnLabel: 'research',
      evidenceRefs: [],
      canPause: true,
      canResume: false,
    });
    expect(expanded.evidenceRefs).toEqual(mission.evidenceRefs);
    expect(prompt).toContain('Aoi Mission Context');
    expect(prompt).toContain('research:aoi-research-ui-test');
    expect(prompt.length).toBeLessThan(900);
    expect(buildAoiMissionResumePrompt(makeMission({ status: 'completed' }))).toBe('');
  });

  it('maps proposal states to precise approval labels and mutation boundaries', () => {
    const acceptedKira = makeProposal({
      status: 'accepted',
      acceptAction: {
        kind: 'create_kira_work',
        params: {
          title: 'Implement one reviewed follow-up',
        },
      },
      suggestedTools: ['create_kira_work'],
      evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
    });
    const previewOnly = buildAoiProposalActionPresentation(acceptedKira, {
      hasKiraPreview: false,
    });
    const finalKira = buildAoiProposalActionPresentation(acceptedKira, {
      hasKiraPreview: true,
    });
    const research = buildAoiProposalActionPresentation(
      makeProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'start_research',
          params: {
            query: 'Windows kernel protection research',
          },
        },
      }),
    );
    const memory = buildAoiProposalActionPresentation(
      makeProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'save_memory',
          params: {
            candidateId: 'memory-candidate-ui-test',
          },
        },
      }),
    );

    expect(previewOnly).toMatchObject({
      visibleState: 'preview_ready',
      primaryLabel: 'Preview plan',
      primaryRole: 'preview',
      requiresPreviewBeforeFinal: true,
      finalActionAvailable: false,
    });
    expect(finalKira.primaryLabel).toBe('Approve and create Kira work item');
    expect(finalKira.visibleState).toBe('waiting_for_approval');
    expect(finalKira.finalActionAvailable).toBe(true);
    expect(finalKira.mutationBoundary).toContain('Kira work item');
    expect(finalKira.mutationBoundary).toContain('does not edit files');
    expect(research.primaryLabel).toBe('Approve and start research run');
    expect(research.mutationBoundary).toContain('research run');
    expect(memory.primaryLabel).toBe('Approve and promote memory');
    expect(memory.mutationBoundary).toContain('untrusted skill draft');
  });

  it('does not expose generic Continue labels for risky final actions', () => {
    const riskyKinds = ['create_kira_work', 'start_research', 'save_memory'] as const;

    for (const kind of riskyKinds) {
      const presentation = buildAoiProposalActionPresentation(
        makeProposal({
          status: 'accepted',
          acceptAction: {
            kind,
            params: {},
          },
        }),
        {
          hasKiraPreview: kind === 'create_kira_work',
        },
      );

      expect(presentation.primaryLabel).not.toMatch(/\bcontinue\b/i);
      expect(presentation.primaryTitle).not.toMatch(/\bcontinue\b/i);
      expect(presentation.mutationBoundary).not.toMatch(/\bcontinue\b/i);
    }
  });

  it('exposes blocked policy reason, missing evidence, and safe alternative', () => {
    const summary = buildAoiBlockedStateSummary({
      proposal: makeProposal({
        status: 'blocked',
        blockedReason: 'missing_evidence_refs',
        evidenceRefs: [],
        acceptAction: {
          kind: 'create_kira_work',
          params: {},
        },
      }),
      reasons: ['missing_evidence_refs', 'kira_handoff_requires_accepted_proposal'],
    });

    expect(summary.policyReasons).toContain('missing_evidence_refs');
    expect(summary.missingEvidence).toContain('Evidence refs are missing.');
    expect(summary.missingEvidence).toContain(
      'An accepted proposal is required before Kira handoff.',
    );
    expect(summary.safeAlternative).toContain('Accept');
  });

  it('explains blocked proposals without exposing tool execution', () => {
    const explanation = buildAoiBlockedProactiveExplanation({
      blockedProposal: {
        proposalId: 'aoi-proposal-blocked-ui-test',
        title: 'Create broad Kira work',
        reasons: ['kira_handoff_scope_too_broad'],
        evidenceRefs: ['proposal:aoi-proposal-blocked-ui-test'],
        actionKind: 'create_kira_work',
        requiredAutonomyLevel: 'L4',
        requiresUserApproval: true,
        risk: 'high',
      },
      includeEvidence: true,
    });

    expect(explanation.messageSummary).toContain('Why now:');
    expect(explanation.messageSummary).toContain('Boundary:');
    expect(explanation.safeNextAction).toContain('Narrow');
    expect(explanation.willNotDoWithoutApproval).toContain('No tools run');
    expect(explanation.evidenceRefs).toEqual(['proposal:aoi-proposal-blocked-ui-test']);
  });

  it('uses explicit mission interrupt labels and visible states', () => {
    const delegated = buildAoiMissionPanelSummary(
      makeMission({
        status: 'waiting_on_kira',
        waitingOn: 'kira',
        sourceRefs: {
          goalRef: 'goal:aoi-goal-ui-test',
          kiraWorkRef: 'kira:aoi-kira-work-ui-test',
        },
      }),
    );
    const paused = buildAoiMissionPanelSummary(makeMission({ status: 'paused' }));

    expect(delegated.visibleState).toBe('delegated_to_kira');
    expect(delegated.pauseLabel).toBe('Pause this goal');
    expect(delegated.resumeLabel).toBe('Resume');
    expect(delegated.showEvidenceLabel).toBe('Show evidence');
    expect(paused.visibleState).toBe('paused');
    expect(paused.canResume).toBe(true);
  });

  it('sends pause and resume mission client calls without dropping evidence refs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionPath: 'aoi/default',
        mission: null,
      }),
    } as Response);

    await decideAoiMission('aoi/default', {
      action: 'pause',
      reason: 'User interrupted the goal.',
      evidenceRefs: ['goal:aoi-goal-ui-test'],
    });
    await decideAoiMission('aoi/default', {
      action: 'resume',
      reason: 'User resumed the goal.',
      evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pauseBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const resumeBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));

    expect(pauseBody).toMatchObject({
      sessionPath: 'aoi/default',
      action: 'pause',
      evidenceRefs: ['goal:aoi-goal-ui-test'],
    });
    expect(resumeBody).toMatchObject({
      sessionPath: 'aoi/default',
      action: 'resume',
      evidenceRefs: ['goal:aoi-goal-ui-test', 'proposal:aoi-proposal-ui-test-001'],
    });
  });
});
