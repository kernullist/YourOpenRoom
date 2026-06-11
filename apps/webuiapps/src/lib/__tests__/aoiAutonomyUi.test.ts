import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import {
  canShowAoiProposalPrimaryAction,
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

  it('redacts local private paths from proposal display text', () => {
    expect(
      sanitizeAoiProposalDisplayText('Read F:\\kernullist\\YourOpenRoom\\private\\report.md now'),
    ).toBe('Read [local path] now');
  });
});
