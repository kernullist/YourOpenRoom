import { describe, expect, it } from 'vitest';

import {
  buildAoiCapabilityPrompt,
  decideAoiConnectorAuthority,
  decideAoiCapabilityBrokerAuthority,
  getAoiAppCapabilityManifest,
  summarizeAoiAppCapabilityAuthority,
} from '../aoiCapabilityRegistry';
import type { AoiSourceFreshnessContract } from '../aoiSourceFreshnessContract';
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
      previewEvidenceRefs: ['preview:kira-settings-001'],
      targetEvidenceRefs: ['target:kira-settings:model-settings'],
      mutationConsentReceiptRefs: ['consent:kira-settings-001'],
      rollbackEvidenceRefs: ['rollback:kira-settings-001'],
      apps: [KIRA_APP],
    });

    expect(decision.blockedReasons).toEqual([]);
    expect(decision).toMatchObject({
      allowedBand: 'execute',
      rollbackEvidenceRequirement: 'satisfied',
      canExecute: true,
      auditRequired: true,
      mutationCount: 0,
      unauthorizedMutationCount: 0,
    });
    expect(decision.requiredConsent.mutation).toBe('satisfied');
    expect(decision.auditEvent).toMatchObject({
      decisionId: decision.authorityDecisionId,
      connectorKind: 'app_capability',
      mutationIntent: 'execute_after_authority',
      mutationCount: 0,
    });
  });

  it('rejects reused approval when target and preview proof do not match the mutation', () => {
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

    expect(decision.canExecute).toBe(false);
    expect(decision.blockedReasons).toContain('approval_target_preview_mismatch');
    expect(decision.auditEvent.blockedReasons).toContain('approval_target_preview_mismatch');
  });

  it('blocks missing app capabilities instead of falling back to inspect authority', () => {
    const decision = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'NOT_A_REAL_ACTION',
      requestedBand: 'execute',
      apps: [KIRA_APP],
    });

    expect(decision.canExecute).toBe(false);
    expect(decision.blockedReasons).toContain('unknown_capability');
    expect(decision.sourceState).toBe('unknown');
    expect(decision.cannotKnow.join(' ')).toContain('unregistered app capability');
    expect(decision.auditEvent.blockedReasons).toContain('unknown_capability');
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
    expect(decision.requiredConsent.mutation).toBe('not_required');
  });

  it('allows observe while execute remains blocked for a mutation-capable app capability', () => {
    const observe = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'APPLY_MODEL_SETTINGS',
      requestedBand: 'observe',
      apps: [KIRA_APP],
    });
    const execute = decideAoiCapabilityBrokerAuthority({
      appReference: 'kira',
      actionType: 'APPLY_MODEL_SETTINGS',
      requestedBand: 'execute',
      apps: [KIRA_APP],
    });

    expect(observe.blockedReasons).toEqual([]);
    expect(observe.allowedBand).toBe('observe');
    expect(observe.canExecute).toBe(false);
    expect(execute.blockedReasons).toEqual(
      expect.arrayContaining(['approval_required', 'rollback_evidence_required']),
    );
    expect(execute.allowedBand).toBe('request_approval');
  });

  it('turns disconnected personal sources into blind spots with cannot-know audit evidence', () => {
    const gmail = makeSourceContract({
      sourceId: 'gmail-metadata',
      sourceKind: 'gmail_metadata',
      sourceLabel: 'Gmail metadata',
      consentState: 'disconnected',
      freshnessState: 'disconnected',
      cannotKnow: [
        {
          version: 1,
          code: 'source_disconnected',
          statement:
            'Aoi cannot know current Gmail metadata because Gmail is disconnected; disconnected is not evidence of an empty inbox.',
          evidenceRefs: ['gmail:disconnected'],
        },
      ],
    });

    const decision = decideAoiConnectorAuthority({
      connectorKind: 'personal_source',
      sourceId: 'gmail-metadata',
      requestedBand: 'metadata_only',
      sourceFreshnessContracts: [gmail],
    });

    expect(decision.sourceState).toBe('disconnected');
    expect(decision.blockedReasons).toContain('source_disconnected');
    expect(decision.cannotKnow.join(' ')).toContain('not evidence of an empty inbox');
    expect(decision.auditEvent.blockedReasons).toContain('source_disconnected');
    expect(decision.bodyContentAuthorized).toBe(false);
  });

  it('blocks body access when personal source consent has been revoked', () => {
    const notes = makeSourceContract({
      sourceId: 'notes-metadata',
      sourceKind: 'notes_metadata',
      sourceLabel: 'Notes metadata',
      consentState: 'revoked',
      freshnessState: 'revoked',
      bodyAccessState: 'body_disabled',
      cannotKnow: [
        {
          version: 1,
          code: 'consent_revoked',
          statement: 'Aoi cannot use Notes metadata because source consent is revoked.',
          evidenceRefs: ['notes:revoked'],
        },
      ],
    });

    const decision = decideAoiConnectorAuthority({
      connectorKind: 'personal_source',
      sourceId: 'notes-metadata',
      requestedBand: 'body_content',
      sourceFreshnessContracts: [notes],
      bodyContentConsentReceiptRefs: ['old-revoked-receipt'],
    });

    expect(decision.sourceState).toBe('revoked');
    expect(decision.requiredConsent.bodyContent).toBe('revoked');
    expect(decision.blockedReasons).toEqual(
      expect.arrayContaining(['source_revoked', 'body_content_consent_required']),
    );
    expect(decision.bodyContentAuthorized).toBe(false);
    expect(JSON.stringify(decision)).not.toContain('private body text');
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
    expect(prompt).toContain('Connector Authority Registry v3');
    expect(prompt).toContain('mutationCount/unauthorizedMutationCount must remain 0');
  });
});

function makeSourceContract(
  partial: Partial<AoiSourceFreshnessContract>,
): AoiSourceFreshnessContract {
  return {
    version: 1,
    id: `source-freshness:${partial.sourceId ?? 'source'}`,
    sourceId: partial.sourceId ?? 'source',
    sourceKind: partial.sourceKind ?? 'gmail_metadata',
    sourceLabel: partial.sourceLabel ?? 'Source',
    consentState: partial.consentState ?? 'granted',
    dataScope: partial.dataScope ?? 'metadata only',
    scopeState: partial.scopeState ?? 'metadata_only',
    bodyAccessState: partial.bodyAccessState ?? 'body_disabled',
    freshnessState: partial.freshnessState ?? 'fresh',
    signalFreshness: partial.signalFreshness ?? 'fresh',
    staleAfterMs: partial.staleAfterMs ?? 60_000,
    cannotKnow: partial.cannotKnow ?? [],
    evidenceRefs: partial.evidenceRefs ?? ['source:test'],
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}
