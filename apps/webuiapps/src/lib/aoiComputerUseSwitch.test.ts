import { describe, expect, it } from 'vitest';
import {
  AOI_COMPUTER_USE_CAPABILITY,
  engageAoiHostBridgePanic,
  isAoiHostBridgeCapabilityEnabled,
  normalizeAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from './aoiHostBridgeKillSwitch';

// Computer-Use is the one capability that ships ON. That exception has to behave
// exactly like a switch: on until switched off, off once switched off, and off
// under panic like everything else.
describe('the Computer-Use switch', () => {
  it('is on before anyone has configured anything', () => {
    // The point of a default-on switch is that the feature works without being
    // discovered first.
    expect(isAoiHostBridgeCapabilityEnabled(null, AOI_COMPUTER_USE_CAPABILITY)).toBe(true);
    const fresh = normalizeAoiHostBridgeKillSwitchState(null);
    expect(isAoiHostBridgeCapabilityEnabled(fresh, AOI_COMPUTER_USE_CAPABILITY)).toBe(true);
  });

  it('does not turn anything else on', () => {
    // The exception is one key wide.
    const fresh = normalizeAoiHostBridgeKillSwitchState(null);
    for (const key of ['os_desktop_input_foreground', 'os_browser_drive_task', 'os_file_delete']) {
      expect(isAoiHostBridgeCapabilityEnabled(fresh, key), key).toBe(false);
    }
  });

  it('stays off once switched off', () => {
    const off = setAoiHostBridgeCapability(null, AOI_COMPUTER_USE_CAPABILITY, false, 1);
    expect(isAoiHostBridgeCapabilityEnabled(off, AOI_COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('remembers being off across a save and reload', () => {
    // The failure this guards against is specific: for a default-on key,
    // "absent" means ON, so a normalizer that dropped the stored false would
    // turn the feature back on by itself.
    const off = setAoiHostBridgeCapability(null, AOI_COMPUTER_USE_CAPABILITY, false, 1);
    const roundTripped = normalizeAoiHostBridgeKillSwitchState(JSON.parse(JSON.stringify(off)));
    expect(isAoiHostBridgeCapabilityEnabled(roundTripped, AOI_COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('can be switched back on after being off', () => {
    const off = setAoiHostBridgeCapability(null, AOI_COMPUTER_USE_CAPABILITY, false, 1);
    const on = setAoiHostBridgeCapability(off, AOI_COMPUTER_USE_CAPABILITY, true, 2);
    expect(isAoiHostBridgeCapabilityEnabled(on, AOI_COMPUTER_USE_CAPABILITY)).toBe(true);
  });

  it('is overridden by panic like everything else', () => {
    // Panic is the one-switch stop; a default-on capability must not be an
    // exception to it.
    const panicked = engageAoiHostBridgePanic(normalizeAoiHostBridgeKillSwitchState(null), 1);
    expect(isAoiHostBridgeCapabilityEnabled(panicked, AOI_COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('returns to its prior state when panic clears', () => {
    // Panic deliberately does not clear the toggles, so an operator who had
    // switched Computer-Use OFF must not find it back ON after panicking.
    const off = setAoiHostBridgeCapability(null, AOI_COMPUTER_USE_CAPABILITY, false, 1);
    const panicked = engageAoiHostBridgePanic(off, 2);
    const cleared = { ...panicked, globalPanic: false };
    expect(isAoiHostBridgeCapabilityEnabled(cleared, AOI_COMPUTER_USE_CAPABILITY)).toBe(false);
  });

  it('discards a non-boolean entry rather than reading it as a decision', () => {
    const raw = {
      version: 1,
      globalPanic: false,
      entries: { [AOI_COMPUTER_USE_CAPABILITY]: 'nope' },
      updatedAt: 0,
    };
    const state = normalizeAoiHostBridgeKillSwitchState(raw);
    // Garbage is not an OFF decision, so the default applies.
    expect(isAoiHostBridgeCapabilityEnabled(state, AOI_COMPUTER_USE_CAPABILITY)).toBe(true);
  });
});
