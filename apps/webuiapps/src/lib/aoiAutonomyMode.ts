import type { AoiAutonomyPolicy } from './aoiAutonomyTypes';
import type { AoiAutonomyPanelSettings } from './aoiAutonomyUi';

// A single "autonomy mode" that bundles the many individual autonomy toggles
// into one choice. This keeps the Advanced tab manageable and drives the
// fresh-install default without flipping the safe baseline constants.
//
// - off:      Aoi does nothing proactive.
// - balanced: proactive suggestions, briefing, scouting, direct chat, and
//             network thinking are on; privacy capture stays off.
// - full:     balanced plus agentic reflection, field-shadow capture, and the
//             host-PC capabilities (enabled via the normal kill-switch/consent
//             path, not by weakening the fail-closed constant).
//
// Safety guards (previewMode, requireApprovalForHighRisk, requireEvidenceRefs,
// duplicate/cooldown checks) are NEVER weakened by a mode -- irreversible host
// actions still require per-action approval even in full mode.
export type AoiAutonomyMode = 'off' | 'balanced' | 'full';

export const AOI_AUTONOMY_MODES: readonly AoiAutonomyMode[] = ['off', 'balanced', 'full'];

// Fresh-install default. Applied at the user-session policy load choke point,
// not by editing DEFAULT_AOI_AUTONOMY_POLICY (which stays a safe baseline).
export const AOI_DEFAULT_AUTONOMY_MODE: AoiAutonomyMode = 'full';

// Host-bridge capability keys enabled by full mode. Mirrors the capability list
// in AoiHostBridgeSettingsPanel; enabling still goes through the kill-switch and
// consent path so a lost/corrupt config fails closed.
export const AOI_FULL_MODE_HOST_CAPABILITIES: readonly string[] = [
  'process_activity',
  'desktop_activity',
  'screen_vision',
  'os_browser_read',
  'os_browser_drive',
  'os_browser_drive_standing',
  'os_browser_drive_task',
  'os_process_spawn',
  'os_file_read',
  'os_file_write',
  'os_process_kill',
  'os_file_delete',
];

export function isAoiAutonomyMode(value: unknown): value is AoiAutonomyMode {
  return value === 'off' || value === 'balanced' || value === 'full';
}

// Apply a mode to a policy. Behavioral/capability flags follow the mode; safety
// guard fields are preserved from `base` and never weakened here.
export function applyAoiAutonomyModeToPolicy(
  base: AoiAutonomyPolicy,
  mode: AoiAutonomyMode,
  now: number,
): AoiAutonomyPolicy {
  const proactive = mode !== 'off';
  const full = mode === 'full';
  return {
    ...base,
    enabled: proactive,
    allowNetwork: proactive,
    proactiveSuggestionsEnabled: proactive,
    agenticReflectionEnabled: full,
    fieldShadowCaptureEnabled: full,
    proactiveBriefing: {
      ...base.proactiveBriefing,
      enabled: proactive,
      allowBackgroundScout: proactive,
      directChatHookOptIn: proactive,
    },
    updatedAt: now,
  };
}

export function applyAoiAutonomyModeToPanel(
  base: AoiAutonomyPanelSettings,
  mode: AoiAutonomyMode,
): AoiAutonomyPanelSettings {
  return {
    ...base,
    notificationsEnabled: mode !== 'off',
  };
}

// Host capabilities that a mode wants enabled (empty unless full).
export function aoiAutonomyModeHostCapabilities(mode: AoiAutonomyMode): readonly string[] {
  return mode === 'full' ? AOI_FULL_MODE_HOST_CAPABILITIES : [];
}

// Best-effort inference of the current mode from a policy, for display in the
// preset selector. Full requires the capture/reflection flags; any proactive
// enablement without them reads as balanced.
export function inferAoiAutonomyMode(policy: AoiAutonomyPolicy): AoiAutonomyMode {
  if (!policy.enabled) {
    return 'off';
  }
  if (policy.fieldShadowCaptureEnabled && policy.agenticReflectionEnabled) {
    return 'full';
  }
  return 'balanced';
}

export function aoiAutonomyModeLabel(mode: AoiAutonomyMode): string {
  switch (mode) {
    case 'off': {
      return 'Off';
    }
    case 'balanced': {
      return 'Balanced';
    }
    case 'full':
    default: {
      return 'Full';
    }
  }
}
