import { describe, expect, it } from 'vitest';
import {
  AOI_BROWSER_DRIVE_APPROVAL_TTL_MS,
  buildAoiBrowserDriveActApprovalPreview,
  makeAoiBrowserDriveStoreApprovalGate,
  recordAoiBrowserDriveActPendingApproval,
} from '../aoiBrowserDriveApproval';
import { AOI_BROWSER_DRIVE_CAPABILITY } from '../aoiBrowserDrive';
import { computeAoiBrowserDriveActionFingerprint } from '../aoiBrowserDriveExecutor';
import {
  approveAoiHostBridgeApproval,
  DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE,
  type AoiHostBridgeApprovalStoreData,
} from '../aoiHostBridgeApprovalStore';
import {
  addAoiBrowserDriveStandingGrant,
  type AoiBrowserDriveStandingGrantStore,
} from '../aoiBrowserDriveStandingGrant';
import type { AoiBrowserDrivePlan } from '../aoiBrowserDrivePlan';
import type { AoiBrowserDriveActionRequest } from '../aoiBrowserDriveAction';

function plan(...actions: AoiBrowserDriveActionRequest[]): AoiBrowserDrivePlan {
  return {
    goal: 'check the dashboard',
    steps: actions.map((action, index) => ({ description: `step ${index}`, action })),
  };
}

const clickStep: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#refresh' };

describe('buildAoiBrowserDriveActApprovalPreview', () => {
  it('builds a preview for an ACT step with the executor-matching fingerprint', () => {
    const p = plan(clickStep);
    const outcome = buildAoiBrowserDriveActApprovalPreview({
      plan: p,
      stepIndex: 0,
      hostname: 'Example.COM',
      beforeScreenshotBase64: 'AAAA',
      now: 1_000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.capability).toBe(AOI_BROWSER_DRIVE_CAPABILITY);
      expect(outcome.fingerprint).toBe(
        computeAoiBrowserDriveActionFingerprint(p.goal, 0, clickStep, 'example.com'),
      );
      expect(outcome.hostname).toBe('example.com');
      expect(outcome.targetSummary).toContain('#refresh');
      expect(outcome.targetSummary).toContain('example.com');
      expect(outcome.beforeScreenshotBase64).toBe('AAAA');
      expect(outcome.expiresAt).toBe(1_000 + AOI_BROWSER_DRIVE_APPROVAL_TTL_MS);
    }
  });

  it('rejects an out-of-range step', () => {
    const outcome = buildAoiBrowserDriveActApprovalPreview({
      plan: plan(clickStep),
      stepIndex: 9,
      now: 1,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'step_out_of_range' });
  });

  it('rejects a read step (no approval needed)', () => {
    const outcome = buildAoiBrowserDriveActApprovalPreview({
      plan: plan({ kind: 'navigate', url: 'https://example.com' }),
      stepIndex: 0,
      now: 1,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'not_an_act' });
  });

  it('rejects a forbidden step', () => {
    const outcome = buildAoiBrowserDriveActApprovalPreview({
      plan: plan({ kind: 'type', selector: '#pw', text: 'x', field: { type: 'password' } }),
      stepIndex: 0,
      now: 1,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden_step' });
  });

  it('rejects an inadmissible (over-long) plan for a benign ACT step', () => {
    const outcome = buildAoiBrowserDriveActApprovalPreview({
      plan: plan(clickStep, clickStep, clickStep),
      stepIndex: 0,
      now: 1,
      maxPlanSteps: 2,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'plan_inadmissible' });
  });
});

describe('approval store round-trip via the gate', () => {
  function makeMemStore() {
    let store: AoiHostBridgeApprovalStoreData = {
      ...DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE,
      approvals: [],
    };
    return {
      loadStore: () => store,
      saveStore: (next: AoiHostBridgeApprovalStoreData) => {
        store = next;
      },
      current: () => store,
    };
  }

  it('grants only after the operator approves, then is single-use (fail-closed otherwise)', async () => {
    const mem = makeMemStore();
    const p = plan(clickStep);
    const preview = buildAoiBrowserDriveActApprovalPreview({ plan: p, stepIndex: 0, now: 1_000 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }

    // record pending
    mem.saveStore(recordAoiBrowserDriveActPendingApproval(mem.current(), preview, 1_000).store);

    // Gate denies BEFORE the operator approves (pending != approved).
    const gate = makeAoiBrowserDriveStoreApprovalGate({
      loadStore: mem.loadStore,
      saveStore: mem.saveStore,
      now: 1_100,
    });
    const beforeApprove = await gate({
      fingerprint: preview.fingerprint,
      stepIndex: 0,
      action: clickStep,
      url: 'https://example.com/x',
    });
    expect(beforeApprove.approved).toBe(false);
    expect(beforeApprove.reason).toBe('approval_not_granted');

    // Operator approves the fingerprint.
    mem.saveStore(approveAoiHostBridgeApproval(mem.current(), preview.fingerprint, 1_200).store);

    // Now the gate grants, and CONSUMES the entry.
    const granted = await gate({
      fingerprint: preview.fingerprint,
      stepIndex: 0,
      action: clickStep,
      url: 'https://example.com/x',
    });
    expect(granted.approved).toBe(true);

    // Single-use: a second consume finds nothing.
    const replay = await gate({
      fingerprint: preview.fingerprint,
      stepIndex: 0,
      action: clickStep,
      url: 'https://example.com/x',
    });
    expect(replay.approved).toBe(false);
    expect(replay.reason).toBe('approval_missing');
  });

  it('denies an unknown fingerprint fail-closed', async () => {
    const mem = makeMemStore();
    const gate = makeAoiBrowserDriveStoreApprovalGate({
      loadStore: mem.loadStore,
      saveStore: mem.saveStore,
      now: 1,
    });
    const verdict = await gate({
      fingerprint: 'deadbeef',
      stepIndex: 0,
      action: clickStep,
      url: 'https://example.com/x',
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('approval_missing');
  });
});

describe('standing-grant fallback (P3.1)', () => {
  function makeMemStore() {
    let store: AoiHostBridgeApprovalStoreData = {
      ...DEFAULT_AOI_HOST_BRIDGE_APPROVAL_STORE,
      approvals: [],
    };
    return {
      loadStore: () => store,
      saveStore: (next: AoiHostBridgeApprovalStoreData) => {
        store = next;
      },
    };
  }

  it('grants via a live domain grant when no per-action approval exists (and consumes it)', async () => {
    const mem = makeMemStore();
    let grants: AoiBrowserDriveStandingGrantStore = addAoiBrowserDriveStandingGrant(
      null,
      { domain: 'example.com', maxActions: 2 },
      1_000,
    ).store;
    const gate = makeAoiBrowserDriveStoreApprovalGate({
      loadStore: mem.loadStore,
      saveStore: mem.saveStore,
      now: 1_100,
      standing: {
        enabled: true,
        loadGrants: () => grants,
        saveGrants: (next) => {
          grants = next;
        },
      },
    });
    const verdict = await gate({
      fingerprint: 'ff00aa',
      stepIndex: 1,
      action: clickStep,
      url: 'https://app.example.com/dashboard',
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.viaStanding).toBe(true);
    expect(grants.grants[0].usedActions).toBe(1);
  });

  it('does not use a standing grant when the fallback is disabled (toggle off)', async () => {
    const mem = makeMemStore();
    const grants = addAoiBrowserDriveStandingGrant(null, { domain: 'example.com' }, 1_000).store;
    const gate = makeAoiBrowserDriveStoreApprovalGate({
      loadStore: mem.loadStore,
      saveStore: mem.saveStore,
      now: 1_100,
      standing: { enabled: false, loadGrants: () => grants, saveGrants: () => {} },
    });
    const verdict = await gate({
      fingerprint: 'ff00aa',
      stepIndex: 1,
      action: clickStep,
      url: 'https://example.com/x',
    });
    expect(verdict.approved).toBe(false);
  });

  it('does not use a grant for a host outside its domain', async () => {
    const mem = makeMemStore();
    const grants = addAoiBrowserDriveStandingGrant(null, { domain: 'example.com' }, 1_000).store;
    const gate = makeAoiBrowserDriveStoreApprovalGate({
      loadStore: mem.loadStore,
      saveStore: mem.saveStore,
      now: 1_100,
      standing: { enabled: true, loadGrants: () => grants, saveGrants: () => {} },
    });
    const verdict = await gate({
      fingerprint: 'ff00aa',
      stepIndex: 1,
      action: clickStep,
      url: 'https://other.test/x',
    });
    expect(verdict.approved).toBe(false);
  });

  it('a real per-action approval still wins over standing (no grant consumed)', async () => {
    const mem = makeMemStore();
    const p = plan(clickStep);
    const preview = buildAoiBrowserDriveActApprovalPreview({ plan: p, stepIndex: 0, now: 1_000 });
    if (!preview.ok) {
      throw new Error('expected ok preview');
    }
    mem.saveStore(recordAoiBrowserDriveActPendingApproval(mem.loadStore(), preview, 1_000).store);
    mem.saveStore(approveAoiHostBridgeApproval(mem.loadStore(), preview.fingerprint, 1_050).store);
    let grants = addAoiBrowserDriveStandingGrant(null, { domain: 'example.com' }, 1_000).store;
    const gate = makeAoiBrowserDriveStoreApprovalGate({
      loadStore: mem.loadStore,
      saveStore: mem.saveStore,
      now: 1_100,
      standing: {
        enabled: true,
        loadGrants: () => grants,
        saveGrants: (next) => {
          grants = next;
        },
      },
    });
    const verdict = await gate({
      fingerprint: preview.fingerprint,
      stepIndex: 0,
      action: clickStep,
      url: 'https://example.com/x',
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.viaStanding).toBeUndefined();
    expect(grants.grants[0].usedActions).toBe(0);
  });
});
