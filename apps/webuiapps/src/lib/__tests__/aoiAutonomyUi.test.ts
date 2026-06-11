import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import {
  AOI_AUTONOMY_PANEL_SETTINGS_KEY,
  buildAoiAutonomyNotificationBadge,
  buildAoiProposalInspectorSummary,
  canShowAoiProposalPrimaryAction,
  loadAoiAutonomyPanelSettings,
  saveAoiAutonomyPanelSettings,
  sanitizeAoiProposalDisplayText,
  selectAoiInlineProposal,
} from '../aoiAutonomyUi';
import type { AoiAutonomyPolicy, AoiProposal } from '../aoiAutonomyTypes';

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

describe('Aoi autonomy UI helpers', () => {
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
});
