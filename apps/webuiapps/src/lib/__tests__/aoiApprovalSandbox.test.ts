import { describe, expect, it } from 'vitest';

import {
  createAoiApprovalSandboxApprovalReceipt,
  createAoiApprovalSandboxPreview,
  hasAoiApprovalSandboxRecoveryEvidence,
  validateAoiApprovalSandboxApproval,
} from '../aoiApprovalSandbox';

describe('aoiApprovalSandbox', () => {
  function makePreview(
    partial: Partial<Parameters<typeof createAoiApprovalSandboxPreview>[0]> = {},
  ) {
    return createAoiApprovalSandboxPreview({
      targetKind: 'app',
      targetId: 'kira:apply_model_settings',
      intendedMutation: 'Apply Kira model settings.',
      dryRunSummary: 'Kira settings would be updated after user approval.',
      requiredAuthorityDecisionId: 'authority:kira-settings-001',
      expectedMutationCount: 1,
      recoveryPlan: {
        kind: 'manual_recovery',
        available: true,
        summary: 'Restore the previous Kira model settings from the attached baseline.',
        evidenceRefs: ['recovery:kira-settings-baseline'],
      },
      rollback: {
        required: true,
        note: 'Restore the previous Kira model settings and rerun the settings audit.',
        evidenceRefs: ['rollback:kira-settings-baseline'],
      },
      postActionValidation: {
        kind: 'check',
        label: 'Verify Kira settings audit.',
        check: 'Read Kira settings and confirm the expected values.',
        evidenceRefs: ['validation:kira-settings-audit'],
      },
      env: {
        FORCE_COLOR: '0',
      },
      evidenceRefs: ['preview:kira-settings-001'],
      ...partial,
    });
  }

  it('invalidates approval when the prepared preview changes', () => {
    const preview = makePreview();
    const approval = createAoiApprovalSandboxApprovalReceipt(preview, {
      approvedAt: 1000,
      expiresAt: 5000,
      evidenceRefs: ['approval:kira-settings-001'],
    });
    const changed = makePreview({
      dryRunSummary: 'Kira settings and an unrelated setting would be updated.',
    });

    const validation = validateAoiApprovalSandboxApproval({
      preview: changed,
      approval,
      now: 2000,
    });

    expect(validation.approved).toBe(false);
    expect(validation.blockedReasons).toEqual(
      expect.arrayContaining(['approval_preview_changed', 'approval_fingerprint_changed']),
    );
  });

  it('invalidates approval when the command environment changes', () => {
    const preview = makePreview();
    const approval = createAoiApprovalSandboxApprovalReceipt(preview, {
      approvedAt: 1000,
      expiresAt: 5000,
    });
    const changed = makePreview({
      env: {
        FORCE_COLOR: '1',
      },
    });

    const validation = validateAoiApprovalSandboxApproval({
      preview: changed,
      approval,
      now: 2000,
    });

    expect(validation.approved).toBe(false);
    expect(validation.blockedReasons).toContain('approval_env_changed');
  });

  it('blocks mutation-capable previews with placeholder rollback evidence', () => {
    const preview = makePreview({
      recoveryPlan: {
        kind: 'manual_recovery',
        available: false,
        summary: 'TODO',
        evidenceRefs: [],
      },
      rollback: {
        required: true,
        note: 'placeholder',
        evidenceRefs: [],
      },
    });
    const approval = createAoiApprovalSandboxApprovalReceipt(preview, {
      approvedAt: 1000,
      expiresAt: 5000,
    });

    const validation = validateAoiApprovalSandboxApproval({
      preview,
      approval,
      now: 2000,
    });

    expect(hasAoiApprovalSandboxRecoveryEvidence(preview)).toBe(false);
    expect(validation.approved).toBe(false);
    expect(validation.blockedReasons).toContain('rollback_recovery_evidence_missing');
  });

  it('blocks expired approvals', () => {
    const preview = makePreview();
    const approval = createAoiApprovalSandboxApprovalReceipt(preview, {
      approvedAt: 1000,
      expiresAt: 1500,
    });

    const validation = validateAoiApprovalSandboxApproval({
      preview,
      approval,
      now: 2000,
    });

    expect(validation.approved).toBe(false);
    expect(validation.blockedReasons).toContain('approval_expired');
  });

  it('invalidates pending approval when connector authority is revoked', () => {
    const preview = makePreview();
    const approval = createAoiApprovalSandboxApprovalReceipt(preview, {
      approvedAt: 1000,
      expiresAt: 5000,
    });

    const validation = validateAoiApprovalSandboxApproval({
      preview,
      approval,
      now: 2000,
      connectorAuthorityState: 'revoked',
    });

    expect(validation.approved).toBe(false);
    expect(validation.blockedReasons).toContain('connector_authority_revoked');
  });
});
