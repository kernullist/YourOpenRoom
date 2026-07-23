import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS } from '../aoiAutonomyUi';
import {
  AOI_DEFAULT_AUTONOMY_MODE,
  AOI_FULL_MODE_HOST_CAPABILITIES,
  aoiAutonomyModeHostCapabilities,
  applyAoiAutonomyModeToPanel,
  applyAoiAutonomyModeToPolicy,
  inferAoiAutonomyMode,
  isAoiAutonomyMode,
} from '../aoiAutonomyMode';

const NOW = 1_000;

describe('applyAoiAutonomyModeToPolicy', () => {
  it('full mode enables behavioral, network, and capture flags', () => {
    const policy = applyAoiAutonomyModeToPolicy(DEFAULT_AOI_AUTONOMY_POLICY, 'full', NOW);
    expect(policy.enabled).toBe(true);
    expect(policy.allowNetwork).toBe(true);
    expect(policy.proactiveSuggestionsEnabled).toBe(true);
    expect(policy.agenticReflectionEnabled).toBe(true);
    expect(policy.fieldShadowCaptureEnabled).toBe(true);
    expect(policy.proactiveBriefing.enabled).toBe(true);
    expect(policy.proactiveBriefing.allowBackgroundScout).toBe(true);
    expect(policy.proactiveBriefing.directChatHookOptIn).toBe(true);
  });

  it('balanced mode enables behavior and network but not privacy capture', () => {
    const policy = applyAoiAutonomyModeToPolicy(DEFAULT_AOI_AUTONOMY_POLICY, 'balanced', NOW);
    expect(policy.enabled).toBe(true);
    expect(policy.allowNetwork).toBe(true);
    expect(policy.proactiveBriefing.enabled).toBe(true);
    expect(policy.fieldShadowCaptureEnabled).toBe(false);
    expect(policy.agenticReflectionEnabled).toBe(false);
  });

  it('off mode disables proactive behavior', () => {
    const policy = applyAoiAutonomyModeToPolicy(DEFAULT_AOI_AUTONOMY_POLICY, 'off', NOW);
    expect(policy.enabled).toBe(false);
    expect(policy.allowNetwork).toBe(false);
    expect(policy.proactiveBriefing.enabled).toBe(false);
    expect(policy.fieldShadowCaptureEnabled).toBe(false);
  });

  it('never weakens safety guards, even in full mode', () => {
    const guarded = {
      ...DEFAULT_AOI_AUTONOMY_POLICY,
      previewMode: true,
      requireApprovalForHighRisk: true,
      requireEvidenceRefs: true,
      duplicateCheckEnabled: true,
      cooldownCheckEnabled: true,
    };
    const policy = applyAoiAutonomyModeToPolicy(guarded, 'full', NOW);
    expect(policy.previewMode).toBe(true);
    expect(policy.requireApprovalForHighRisk).toBe(true);
    expect(policy.requireEvidenceRefs).toBe(true);
    expect(policy.duplicateCheckEnabled).toBe(true);
    expect(policy.cooldownCheckEnabled).toBe(true);
  });

  it('stamps updatedAt', () => {
    const policy = applyAoiAutonomyModeToPolicy(DEFAULT_AOI_AUTONOMY_POLICY, 'full', NOW);
    expect(policy.updatedAt).toBe(NOW);
  });
});

describe('inferAoiAutonomyMode round-trips', () => {
  it('infers the mode that was applied', () => {
    for (const mode of ['off', 'balanced', 'full'] as const) {
      const policy = applyAoiAutonomyModeToPolicy(DEFAULT_AOI_AUTONOMY_POLICY, mode, NOW);
      expect(inferAoiAutonomyMode(policy)).toBe(mode);
    }
  });
});

describe('aoiAutonomyModeHostCapabilities', () => {
  it('returns the full capability set only for full mode', () => {
    expect(aoiAutonomyModeHostCapabilities('full')).toEqual(AOI_FULL_MODE_HOST_CAPABILITIES);
    expect(aoiAutonomyModeHostCapabilities('full').length).toBe(12);
    expect(aoiAutonomyModeHostCapabilities('balanced')).toEqual([]);
    expect(aoiAutonomyModeHostCapabilities('off')).toEqual([]);
  });
});

describe('applyAoiAutonomyModeToPanel', () => {
  it('enables desktop notifications for proactive modes', () => {
    expect(
      applyAoiAutonomyModeToPanel(DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS, 'full').notificationsEnabled,
    ).toBe(true);
    expect(
      applyAoiAutonomyModeToPanel(DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS, 'balanced')
        .notificationsEnabled,
    ).toBe(true);
    expect(
      applyAoiAutonomyModeToPanel(DEFAULT_AOI_AUTONOMY_PANEL_SETTINGS, 'off').notificationsEnabled,
    ).toBe(false);
  });
});

describe('mode helpers', () => {
  it('default mode is full', () => {
    expect(AOI_DEFAULT_AUTONOMY_MODE).toBe('full');
  });

  it('validates mode values', () => {
    expect(isAoiAutonomyMode('full')).toBe(true);
    expect(isAoiAutonomyMode('balanced')).toBe(true);
    expect(isAoiAutonomyMode('off')).toBe(true);
    expect(isAoiAutonomyMode('nope')).toBe(false);
    expect(isAoiAutonomyMode(undefined)).toBe(false);
  });
});
