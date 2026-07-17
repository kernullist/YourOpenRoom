import { describe, expect, it } from 'vitest';

import { evaluateAoiHostBridgeGate } from '../aoiHostBridgeGate';
import { engageAoiHostBridgePanic, setAoiHostBridgeCapability } from '../aoiHostBridgeKillSwitch';

const ENABLED_KILL = setAoiHostBridgeCapability(null, 'os_process_kill', true, 1000);

describe('evaluateAoiHostBridgeGate', () => {
  it('allows a reversible, authenticated, enabled, consented request', () => {
    const decision = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: setAoiHostBridgeCapability(null, 'process_activity', true, 1000),
      capabilityKey: 'process_activity',
      irreversible: false,
      consent: { allowed: true, reasons: [] },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.denyReasons).toEqual([]);
  });

  it('rejects an unauthenticated caller before anything else', () => {
    const decision = evaluateAoiHostBridgeGate({
      authenticated: false,
      killSwitchState: ENABLED_KILL,
      capabilityKey: 'os_process_kill',
      irreversible: true,
      approvalSatisfied: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyReasons).toContain('not_authenticated');
  });

  it('reports global panic distinctly from a per-capability disable', () => {
    const panic = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: engageAoiHostBridgePanic(ENABLED_KILL, 2000),
      capabilityKey: 'os_process_kill',
      irreversible: true,
      approvalSatisfied: true,
    });
    expect(panic.denyReasons).toContain('host_bridge_panic');
    expect(panic.denyReasons).not.toContain('capability_disabled');

    const disabled = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: null,
      capabilityKey: 'os_process_kill',
      irreversible: true,
      approvalSatisfied: true,
    });
    expect(disabled.denyReasons).toContain('capability_disabled');
    expect(disabled.detail).toContain('capability_disabled:os_process_kill');
  });

  it('blocks when the backing source is not consented and surfaces the reasons', () => {
    const decision = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: setAoiHostBridgeCapability(null, 'process_activity', true, 1000),
      capabilityKey: 'process_activity',
      irreversible: false,
      consent: { allowed: false, reasons: ['source_disabled', 'explicit_target_scope_required'] },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyReasons).toContain('source_not_consented');
    expect(decision.detail).toContain('consent:source_disabled');
    expect(decision.detail).toContain('consent:explicit_target_scope_required');
  });

  it('requires a satisfied approval for irreversible capabilities', () => {
    const missing = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: ENABLED_KILL,
      capabilityKey: 'os_process_kill',
      irreversible: true,
      approvalSatisfied: false,
    });
    expect(missing.denyReasons).toContain('approval_required');

    const satisfied = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: ENABLED_KILL,
      capabilityKey: 'os_process_kill',
      irreversible: true,
      approvalSatisfied: true,
    });
    expect(satisfied.allowed).toBe(true);
  });

  it('treats an omitted consent input as a pass (non-source-gated capability)', () => {
    const decision = evaluateAoiHostBridgeGate({
      authenticated: true,
      killSwitchState: ENABLED_KILL,
      capabilityKey: 'os_process_kill',
      irreversible: true,
      approvalSatisfied: true,
    });
    expect(decision.allowed).toBe(true);
  });

  it('accumulates every failing layer at once', () => {
    const decision = evaluateAoiHostBridgeGate({
      authenticated: false,
      killSwitchState: null,
      capabilityKey: 'os_process_kill',
      irreversible: true,
      consent: { allowed: false, reasons: ['source_disabled'] },
      approvalSatisfied: false,
    });
    expect(decision.denyReasons).toEqual(
      expect.arrayContaining([
        'not_authenticated',
        'capability_disabled',
        'source_not_consented',
        'approval_required',
      ]),
    );
  });
});
