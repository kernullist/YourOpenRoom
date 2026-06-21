import { describe, expect, it } from 'vitest';

import {
  buildAoiCapabilityPrompt,
  decideAoiCapabilityBrokerAuthority,
  getAoiAppCapabilityManifest,
  summarizeAoiAppCapabilityAuthority,
} from '../aoiCapabilityRegistry';
import type { AppDef } from '../appRegistry';

const KIRA_APP: AppDef = {
  appId: 18,
  appName: 'kira',
  displayName: 'Kira',
  route: '/kira',
  aliases: ['Kira Model Settings'],
  actions: [
    { name: 'OPEN_APP_WINDOW', description: 'Open Kira', params: [] },
    {
      name: 'APPLY_MODEL_SETTINGS',
      description: 'Persist Kira model settings',
      params: [{ name: 'reasoningEffort', type: 'string', description: 'Reasoning effort' }],
    },
  ],
};

describe('aoiCapabilityBroker', () => {
  it('builds structured app capability manifests from app intent contracts', () => {
    const manifest = getAoiAppCapabilityManifest('kira', [KIRA_APP]);
    const applySettings = manifest?.capabilities.find(
      (capability) => capability.actionType === 'APPLY_MODEL_SETTINGS',
    );

    expect(manifest).toMatchObject({
      appId: 18,
      appName: 'kira',
      displayName: 'Kira',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(applySettings).toMatchObject({
      id: 'kira:apply_model_settings',
      executionKind: 'app_action',
      mutationCapable: true,
      requiresApproval: true,
      rollbackEvidenceRequired: true,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(applySettings?.supportedBands).toEqual(
      expect.arrayContaining(['observe', 'summarize', 'prepare', 'preview', 'request_approval']),
    );
  });

  it('blocks app mutation execution without approval and rollback evidence', () => {
    const decision = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'APPLY_MODEL_SETTINGS',
      requestedOperation: 'apply Kira model settings',
      requestedBand: 'execute',
      apps: [KIRA_APP],
      evidenceRefs: ['chat:user-requested-kira-settings'],
    });

    expect(decision).toMatchObject({
      appId: 18,
      capabilityId: 'kira:apply_model_settings',
      requestedBand: 'execute',
      allowedBand: 'request_approval',
      mutationCapable: true,
      requiredApproval: true,
      approvalSatisfied: false,
      rollbackEvidenceRequirement: 'missing',
      canExecute: false,
      actionAuthority: 'display_only',
      mutationCount: 0,
      unauthorizedMutationCount: 0,
    });
    expect(decision.blockedReasons).toEqual(
      expect.arrayContaining(['approval_required', 'rollback_evidence_required']),
    );
  });

  it('allows mutation execution only after approval and rollback evidence are present', () => {
    const decision = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'APPLY_MODEL_SETTINGS',
      requestedOperation: 'apply Kira model settings',
      requestedBand: 'execute',
      approvalSatisfied: true,
      approvalEvidenceRefs: ['approval:kira-settings-001'],
      rollbackEvidenceRefs: ['rollback:kira-settings-001'],
      apps: [KIRA_APP],
    });

    expect(decision.blockedReasons).toEqual([]);
    expect(decision).toMatchObject({
      allowedBand: 'execute',
      rollbackEvidenceRequirement: 'satisfied',
      canExecute: true,
      mutationCount: 0,
      unauthorizedMutationCount: 0,
    });
  });

  it('allows non-mutating window actions without inventing mutation authority', () => {
    const decision = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'OPEN_APP_WINDOW',
      requestedBand: 'execute',
      apps: [KIRA_APP],
    });

    expect(decision).toMatchObject({
      capabilityId: 'kira:open_app_window',
      allowedBand: 'execute',
      mutationCapable: false,
      requiredApproval: false,
      rollbackEvidenceRequirement: 'not_required',
      canExecute: true,
      mutationCount: 0,
      unauthorizedMutationCount: 0,
    });
  });

  it('summarizes broker coverage for prompts without granting execution authority', () => {
    const summary = summarizeAoiAppCapabilityAuthority([KIRA_APP]);
    const prompt = buildAoiCapabilityPrompt(['app_action', 'get_app_state', 'file_write']);

    expect(summary).toMatchObject({
      appCount: 1,
      actionAuthority: 'display_only',
      mutationCount: 0,
      unauthorizedMutationCount: 0,
    });
    expect(summary.approvalGatedMutationCount).toBeGreaterThan(0);
    expect(summary.bandLabels).toContain('request approval');
    expect(prompt).toContain('Capability Broker v2');
    expect(prompt).toContain('mutationCount/unauthorizedMutationCount must remain 0');
  });
});
