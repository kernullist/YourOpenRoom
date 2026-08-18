import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  clearAoiHostBridgePanic,
  DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE,
  engageAoiHostBridgePanic,
  isAoiHostBridgeCapabilityEnabled,
  loadAoiHostBridgeKillSwitchState,
  normalizeAoiHostBridgeKillSwitchState,
  resolveAoiHostBridgeKillSwitchPath,
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';

const tempRoots: string[] = [];

function makeTempHome(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-killswitch-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('isAoiHostBridgeCapabilityEnabled (fail-closed)', () => {
  it('is disabled by default and for unknown keys', () => {
    expect(
      isAoiHostBridgeCapabilityEnabled(
        DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE,
        'os_process_kill',
      ),
    ).toBe(false);
    expect(isAoiHostBridgeCapabilityEnabled(null, 'os_process_kill')).toBe(false);
    expect(isAoiHostBridgeCapabilityEnabled(undefined, 'anything')).toBe(false);
  });

  it('is enabled only when the key is explicitly on and panic is off', () => {
    const enabled = setAoiHostBridgeCapability(null, 'os_process_kill', true, 1000);
    expect(isAoiHostBridgeCapabilityEnabled(enabled, 'os_process_kill')).toBe(true);
    expect(isAoiHostBridgeCapabilityEnabled(enabled, 'os_process_spawn')).toBe(false);
  });

  it('global panic overrides every per-capability enable', () => {
    let state = setAoiHostBridgeCapability(null, 'os_process_kill', true, 1000);
    state = setAoiHostBridgeCapability(state, 'os_file_write', true, 1000);
    const panicked = engageAoiHostBridgePanic(state, 2000);
    expect(isAoiHostBridgeCapabilityEnabled(panicked, 'os_process_kill')).toBe(false);
    expect(isAoiHostBridgeCapabilityEnabled(panicked, 'os_file_write')).toBe(false);
  });
});

describe('kill-switch state transitions', () => {
  it('clearing panic restores the prior per-capability enables', () => {
    let state = setAoiHostBridgeCapability(null, 'os_process_kill', true, 1000);
    state = engageAoiHostBridgePanic(state, 2000);
    expect(isAoiHostBridgeCapabilityEnabled(state, 'os_process_kill')).toBe(false);
    state = clearAoiHostBridgePanic(state, 3000);
    // The enable was preserved through panic, so it comes back on clear.
    expect(isAoiHostBridgeCapabilityEnabled(state, 'os_process_kill')).toBe(true);
  });

  it('disabling a capability removes it (never mutates the input)', () => {
    const enabled = setAoiHostBridgeCapability(null, 'os_process_kill', true, 1000);
    const disabled = setAoiHostBridgeCapability(enabled, 'os_process_kill', false, 2000);
    expect(isAoiHostBridgeCapabilityEnabled(disabled, 'os_process_kill')).toBe(false);
    // Input snapshot is untouched.
    expect(isAoiHostBridgeCapabilityEnabled(enabled, 'os_process_kill')).toBe(true);
  });

  it('rejects malformed keys', () => {
    const state = setAoiHostBridgeCapability(null, 'BadKey!', true, 1000);
    expect(state.entries).toEqual({});
  });

  it('caps the number of enabled entries', () => {
    let state = normalizeAoiHostBridgeKillSwitchState(null);
    for (let index = 0; index < 80; index += 1) {
      state = setAoiHostBridgeCapability(state, `cap-${index}`, true, 1000);
    }
    expect(Object.keys(state.entries).length).toBeLessThanOrEqual(64);
  });
});

describe('normalizeAoiHostBridgeKillSwitchState', () => {
  it('keeps boolean decisions, drops malformed entries and version mismatches', () => {
    const normalized = normalizeAoiHostBridgeKillSwitchState({
      version: 1,
      globalPanic: true,
      entries: { ok_key: true, off_key: false, 'Bad Key': true, weird: 'yes' },
      updatedAt: 42,
    });
    expect(normalized.globalPanic).toBe(true);
    // An explicit false is KEPT. For a default-on capability "absent" means on,
    // so dropping the false here would turn the feature back on by itself the
    // next time the file was read -- the operator's decision would survive
    // exactly one process lifetime. A bad key or a non-boolean is still dropped.
    expect(normalized.entries).toEqual({ ok_key: true, off_key: false });
    expect(normalized.updatedAt).toBe(42);

    expect(normalizeAoiHostBridgeKillSwitchState({ version: 2 }).entries).toEqual({});
    expect(normalizeAoiHostBridgeKillSwitchState('nope').globalPanic).toBe(false);
  });
});

describe('kill-switch persistence', () => {
  it('round-trips state and fails closed on absent/corrupt stores', () => {
    const home = makeTempHome();
    // Absent store => all-disabled default.
    expect(loadAoiHostBridgeKillSwitchState(home).entries).toEqual({});

    const saved = saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_spawn', true, 1000),
    );
    expect(saved.entries).toEqual({ os_process_spawn: true });
    expect(loadAoiHostBridgeKillSwitchState(home).entries).toEqual({ os_process_spawn: true });

    // Corrupt file => fail-closed default, not a throw.
    fs.writeFileSync(resolveAoiHostBridgeKillSwitchPath(home), '{ not json', 'utf-8');
    expect(loadAoiHostBridgeKillSwitchState(home).entries).toEqual({});
  });
});
