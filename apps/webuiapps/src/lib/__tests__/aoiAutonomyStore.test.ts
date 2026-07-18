import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAoiObservation,
  appendAoiOutcomeSignalRecord,
  appendAoiReflection,
  applyAoiProposalDecision,
  applyAoiProposalFeedback,
  buildAoiAutonomyStatus,
  cleanupExpiredAoiFieldShadowDecisionRecords,
  createAoiAutonomyId,
  isValidAoiAutonomyId,
  loadAoiEnvironmentSourceRegistry,
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiAutonomyPolicy,
  loadAoiFieldShadowDecisionRecords,
  loadAoiFieldShadowRecordReport,
  loadAoiFollowThroughEvents,
  loadAoiFollowThroughLearningSummary,
  loadAoiObservationIndex,
  loadAoiObservations,
  loadAoiOutcomeLearningSummary,
  loadAoiOutcomeSignalRecords,
  loadAoiOperatorFeedbackLabelActions,
  loadAoiProposalDecisions,
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
  recordAoiFieldShadowDecisions,
  recordAoiOperatorFeedbackLabelAction,
  resolveAoiAutonomyPaths,
  saveAoiActiveProposals,
  updateAoiEnvironmentSource,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import {
  exportAoiOperatorTrace,
  loadAoiOperatorTimelineEvents,
  loadAoiOperatorTimelineSummary,
  recordAoiOperatorTimelineEvent,
  recordAoiProposalDecisionTimelineEvent,
} from '../aoiOperatorTimeline';
import type { AoiObservation, AoiProposal, AoiReflection } from '../aoiAutonomyTypes';
import type { AoiShadowDecision } from '../aoiShadowModeEvaluation';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-test-'));
  tempRoots.push(root);
  return root;
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-test-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Open previous research',
    body: 'A previous Aoi research run may answer this.',
    reason: 'The current topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:kernel-memory',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-001'],
    memoryIds: ['aoi-memory-001'],
    artifactRefs: ['research:aoi-research-001/report'],
    riskSignals: [],
    ...partial,
  };
}

function makeFieldShadowDecision(partial: Partial<AoiShadowDecision> = {}): AoiShadowDecision {
  const kind = partial.kind ?? 'would_propose';
  const policyResult =
    partial.policyResult ??
    (kind === 'would_prepare_approval'
      ? 'approval_required'
      : kind === 'would_stay_quiet' || kind === 'would_mark_blind_spot'
        ? 'record_only'
        : 'not_applicable');
  return {
    version: 1,
    id: partial.id ?? 'aoi-shadow-field-test',
    sessionPath: partial.sessionPath ?? 'aoi/default',
    kind,
    createdAt: partial.createdAt ?? 1000,
    ...(partial.missionId ? { missionId: partial.missionId } : {}),
    sourceRefs: partial.sourceRefs ?? ['workspace:validation'],
    sourceSummary: partial.sourceSummary ?? 'Workspace validation is stale.',
    consentState: partial.consentState ?? 'unknown',
    risk: partial.risk ?? 'low',
    policyResult,
    ...(partial.operatorMessagePreview
      ? { operatorMessagePreview: partial.operatorMessagePreview }
      : {}),
    ...(partial.silenceReason ? { silenceReason: partial.silenceReason } : {}),
    ...(partial.suggestedAction ? { suggestedAction: partial.suggestedAction } : {}),
    ...(partial.approvalBoundary ? { approvalBoundary: partial.approvalBoundary } : {}),
    mutationCount: 0,
    evidenceRefs: partial.evidenceRefs ?? ['workspace:validation-stale'],
    dedupeKey: partial.dedupeKey ?? 'digest:field-shadow-test:would_propose',
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi autonomy path guards', () => {
  it('normalizes session paths and rejects traversal or absolute paths', () => {
    expect(normalizeAoiAutonomySessionPath(' /aoi/default-mod/ ')).toBe('aoi/default-mod');
    expect(normalizeAoiAutonomySessionPath('aoi\\default')).toBe('aoi/default');
    expect(normalizeAoiAutonomySessionPath('../aoi')).toBeNull();
    expect(normalizeAoiAutonomySessionPath('aoi/../other')).toBeNull();
    expect(normalizeAoiAutonomySessionPath('C:\\Users\\secret')).toBeNull();
    expect(normalizeAoiAutonomySessionPath('aoi//default')).toBeNull();
  });

  it('resolves all storage paths under the session autonomy directory', () => {
    const root = makeTempRoot();
    const paths = resolveAoiAutonomyPaths(root, 'aoi/default');

    expect(paths.root).toBe(resolve(root, 'aoi/default/aoi-autonomy'));
    expect(paths.policy).toBe(join(paths.root, 'policy.json'));
    expect(paths.activeProposals).toBe(join(paths.root, 'proposals', 'active.json'));
    expect(() => resolveAoiAutonomyPaths(root, '../escape')).toThrow(/sessionPath/);
  });

  it('creates stable path-safe ids', () => {
    const id = createAoiAutonomyId('bad prefix!', 1000);

    expect(id).toMatch(/^bad-prefix-/);
    expect(isValidAoiAutonomyId(id)).toBe(true);
    expect(isValidAoiAutonomyId('../bad')).toBe(false);
  });
});

describe('Aoi autonomy policy storage', () => {
  it('loads conservative defaults and saves normalized policy', () => {
    const root = makeTempRoot();

    expect(loadAoiAutonomyPolicy(root, 'aoi/default')).toMatchObject({
      enabled: false,
      previewMode: true,
      level: 'L1',
    });

    const saved = saveAoiAutonomyPolicy(
      root,
      'aoi/default',
      { enabled: true, level: 'L4', maxActiveProposals: 2 },
      1234,
    );

    expect(saved).toMatchObject({
      enabled: true,
      level: 'L4',
      maxActiveProposals: 2,
      updatedAt: 1234,
    });
    expect(loadAoiAutonomyPolicy(root, 'aoi/default')).toMatchObject(saved);
  });
});

describe('Aoi outcome learning storage', () => {
  it('persists outcome signals and appends durable follow-through learning events', () => {
    const root = makeTempRoot();
    const outcome = appendAoiOutcomeSignalRecord(
      root,
      {
        sessionPath: 'aoi/default',
        eventId: 'outcome-work-order-approved',
        sourceProposalId: 'proposal-outcome-store',
        sourceWorkOrderId: 'work-order-outcome-store',
        outcomeKind: 'work_order_approved',
        topicKey: 'topic:reverse-engineering',
        sourceKey: 'source:work-order',
        evidenceRefs: ['proposal:proposal-outcome-store'],
      },
      2000,
    );
    const replay = appendAoiOutcomeSignalRecord(
      root,
      {
        sessionPath: 'aoi/default',
        eventId: 'outcome-work-order-approved',
        sourceProposalId: 'proposal-outcome-store',
        sourceWorkOrderId: 'work-order-outcome-store',
        outcomeKind: 'work_order_approved',
        topicKey: 'topic:reverse-engineering',
        sourceKey: 'source:work-order',
        evidenceRefs: ['proposal:proposal-outcome-store'],
      },
      2500,
    );
    const paths = resolveAoiAutonomyPaths(root, 'aoi/default');
    const outcomes = loadAoiOutcomeSignalRecords(root, 'aoi/default', 3000);
    const outcomeSummary = loadAoiOutcomeLearningSummary(root, 'aoi/default', 3000);
    const followThroughEvents = loadAoiFollowThroughEvents(root, 'aoi/default', 3000);
    const followThroughSummary = loadAoiFollowThroughLearningSummary(root, 'aoi/default', 3000);

    expect(fs.existsSync(paths.outcomeSignals)).toBe(true);
    expect(replay.id).toBe(outcome.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      id: outcome.id,
      outcomeKind: 'work_order_approved',
      signalKind: 'passive_outcome',
      confidence: 0.42,
      mutationCount: 0,
    });
    expect(outcomeSummary.trustIncreaseAllowed).toBe(false);
    expect(outcomeSummary.previousSuggestionOutcomeLabels.join(' ')).toContain(
      'proposal proposal-outcome-store',
    );
    expect(followThroughEvents[0]).toMatchObject({
      outcomeKind: 'work_order_approved',
      learningSignalKind: 'passive_outcome',
      outcomeSignalId: outcome.id,
      confidence: 0.42,
    });
    expect(followThroughEvents).toHaveLength(1);
    expect(followThroughSummary.recentEvents[0]?.outcomeKind).toBe('work_order_approved');
  });
});

describe('Aoi field shadow dogfooding storage', () => {
  it('persists field shadow decisions append-only, deduped, and privacy-redacted', () => {
    const root = makeTempRoot();
    const paths = resolveAoiAutonomyPaths(root, 'aoi/default');
    const privateDecision = makeFieldShadowDecision({
      id: 'aoi-shadow-field-private',
      dedupeKey: 'digest:field-shadow-private:would_propose',
      sourceSummary:
        'Do not leak the mail body: private-roadmap@example.com C:\\Users\\secret\\mail.txt api_key=sk-test-veryprivatevalue.',
      sourceRefs: ['workspace:validation', 'file:C:\\Users\\secret\\mail.txt'],
      evidenceRefs: ['workspace:validation-stale', 'token:github_pat_veryprivatevalue12345'],
      operatorMessagePreview: 'Validation is stale for private-roadmap@example.com; preview only.',
      suggestedAction: 'Prepare a validation command preview; do not run it.',
    });
    const duplicateDecision = makeFieldShadowDecision({
      ...privateDecision,
      id: 'aoi-shadow-field-private-duplicate',
      createdAt: 1200,
    });
    const quietDecision = makeFieldShadowDecision({
      id: 'aoi-shadow-field-quiet',
      kind: 'would_stay_quiet',
      dedupeKey: 'digest:field-shadow-quiet:would_stay_quiet',
      sourceSummary: 'A low relevance source matched too-much feedback.',
      sourceRefs: ['digest:fyi'],
      evidenceRefs: ['feedback:too-much-field-shadow'],
      silenceReason: 'Recent too-much feedback suppresses similar FYI updates.',
    });

    const report = recordAoiFieldShadowDecisions(root, {
      sessionPath: ' /aoi/default/ ',
      sessionId: 'field-private@example.com',
      decisions: [privateDecision, duplicateDecision, quietDecision],
      now: 3000,
      evidenceRefs: ['field-session:dogfood-001'],
    });
    const records = loadAoiFieldShadowDecisionRecords(root, 'aoi/default', 3000);
    const loadedReport = loadAoiFieldShadowRecordReport(root, 'aoi/default', 3000);
    const storedJson = fs.readFileSync(paths.fieldShadowRecords, 'utf-8');

    expect(report.totalRecordCount).toBe(2);
    expect(report.dedupedRecordCount).toBe(1);
    expect(report.activeRecordCount).toBe(2);
    expect(report.zeroMutation).toBe(true);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.dedupeKey)).toEqual(
      expect.arrayContaining([
        'digest:field-shadow-private:would_propose',
        'digest:field-shadow-quiet:would_stay_quiet',
      ]),
    );
    expect(records.every((record) => record.subsystemOrigin === 'digest')).toBe(true);
    expect(records.every((record) => record.mutationCount === 0)).toBe(true);
    expect(loadedReport.session.id).toBe(report.session.id);
    expect(loadedReport.records.every((record) => record.sessionId === report.session.id)).toBe(
      true,
    );
    expect(storedJson).not.toContain('private-roadmap@example.com');
    expect(storedJson).not.toContain('C:\\Users\\secret\\mail.txt');
    expect(storedJson).not.toContain('Do not leak the mail body');
    expect(storedJson).not.toContain('sk-test-veryprivatevalue');
    expect(storedJson).not.toContain('github_pat_veryprivatevalue12345');
    expect(storedJson).toContain('[redacted-private-body]');
    expect(storedJson).toContain('[email]');
  });

  it('excludes expired field shadow records from active reports and cleans them explicitly', () => {
    const root = makeTempRoot();
    const oldDecision = makeFieldShadowDecision({
      id: 'aoi-shadow-field-old',
      dedupeKey: 'digest:field-shadow-old:would_propose',
      sourceSummary: 'Old shadow decision.',
    });
    const freshDecision = makeFieldShadowDecision({
      id: 'aoi-shadow-field-fresh',
      dedupeKey: 'health:field-shadow-fresh:gmail',
      kind: 'would_mark_blind_spot',
      sourceRefs: ['health:personal_signals:gmail_disconnected', 'gmail-metadata'],
      evidenceRefs: ['environment-source:gmail-metadata'],
      sourceSummary: 'Gmail metadata is disconnected.',
      consentState: 'disconnected',
    });

    recordAoiFieldShadowDecisions(root, {
      sessionPath: 'aoi/default',
      decisions: [oldDecision],
      now: 1000,
      retentionMs: 100,
    });
    recordAoiFieldShadowDecisions(root, {
      sessionPath: 'aoi/default',
      decisions: [freshDecision],
      now: 1200,
      retentionMs: 1000,
    });

    const report = loadAoiFieldShadowRecordReport(root, 'aoi/default', 1200);
    const retainedRecords = cleanupExpiredAoiFieldShadowDecisionRecords(root, 'aoi/default', 1200);
    const afterCleanup = loadAoiFieldShadowRecordReport(root, 'aoi/default', 1200);

    expect(report.totalRecordCount).toBe(2);
    expect(report.activeRecordCount).toBe(1);
    expect(report.expiredRecordCount).toBe(1);
    expect(report.activeRecords[0]).toMatchObject({
      decisionKind: 'would_mark_blind_spot',
      subsystemOrigin: 'health',
      privacyState: 'metadata_only',
    });
    expect(retainedRecords).toHaveLength(1);
    expect(retainedRecords[0]?.dedupeKey).toBe('health:field-shadow-fresh:gmail');
    expect(afterCleanup.totalRecordCount).toBe(1);
    expect(afterCleanup.expiredRecordCount).toBe(0);
  });

  it('persists operator feedback label actions as append-only field evidence', () => {
    const root = makeTempRoot();
    const report = recordAoiFieldShadowDecisions(root, {
      sessionPath: 'aoi/default',
      decisions: [
        makeFieldShadowDecision({
          id: 'aoi-shadow-feedback-label',
          dedupeKey: 'digest:feedback-label:would_propose',
          sourceRefs: ['browser-context'],
          evidenceRefs: ['environment-source:browser-context'],
        }),
      ],
      now: 1000,
    });
    const record = report.records[0];
    if (!record) {
      throw new Error('Expected field shadow record.');
    }

    const wrongSource = recordAoiOperatorFeedbackLabelAction(root, {
      sessionPath: 'aoi/default',
      decisionRecordId: record.id,
      decisionId: record.decisionId,
      label: 'wrong_source',
      sourceKinds: ['browser_context'],
      evidenceRefs: record.evidenceRefs,
      now: 2000,
    });
    const unsafe = recordAoiOperatorFeedbackLabelAction(root, {
      sessionPath: 'aoi/default',
      decisionRecordId: record.id,
      decisionId: record.decisionId,
      label: 'unsafe',
      sourceKinds: ['browser_context'],
      note: 'Keep this gated.',
      evidenceRefs: record.evidenceRefs,
      now: 3000,
    });
    const labels = loadAoiOperatorFeedbackLabelActions(root, 'aoi/default');

    expect(labels.map((label) => label.id)).toEqual([wrongSource.id, unsafe.id]);
    expect(labels.map((label) => label.label)).toEqual(['wrong_source', 'unsafe']);
    expect(labels[0]?.calibrationEligible).toBe(true);
    expect(labels[1]?.safetyTightening).toBe(true);
    expect(labels.every((label) => label.mutationCount === 0)).toBe(true);
  });
});

describe('Aoi environment source registry storage', () => {
  it('loads default registry without creating a separate settings island', () => {
    const root = makeTempRoot();
    const registry = loadAoiEnvironmentSourceRegistry(root, 'aoi/default', 1000);
    const paths = resolveAoiAutonomyPaths(root, 'aoi/default');

    expect(paths.environmentSources).toBe(join(paths.root, 'environment-sources.json'));
    expect(registry).toMatchObject({
      version: 1,
      sessionPath: 'aoi/default',
      updatedAt: 1000,
    });
    expect(registry.sources.map((source) => source.id)).toEqual([
      'workspace-git',
      'workspace-build',
      'kira-board',
      'research-runs',
      'app-state',
      'app-activity',
      'browser-context',
      'process-activity',
      'manual-note',
      'calendar-metadata',
      'gmail-metadata',
      'notes-metadata',
    ]);
    expect(registry.sources.find((source) => source.id === 'app-activity')).toMatchObject({
      enabled: false,
      kind: 'app_activity',
      risk: 'high',
      privateByDefault: true,
      scope: 'explicit_target',
      allowedOperations: ['read_metadata', 'summarize_counts'],
    });
    expect(registry.sources.find((source) => source.id === 'browser-context')).toMatchObject({
      enabled: false,
      risk: 'high',
      privateByDefault: true,
      scope: 'explicit_target',
    });
    expect(registry.sources.find((source) => source.id === 'calendar-metadata')).toMatchObject({
      enabled: false,
      kind: 'calendar_metadata',
      allowedOperations: ['status', 'read_metadata', 'summarize_counts'],
      privateByDefault: false,
      scope: 'explicit_target',
    });
    expect(registry.sources.find((source) => source.id === 'gmail-metadata')).toMatchObject({
      enabled: false,
      kind: 'gmail_metadata',
      privateByDefault: true,
      scope: 'explicit_target',
    });
    expect(registry.sources.find((source) => source.id === 'notes-metadata')).toMatchObject({
      enabled: false,
      kind: 'notes_metadata',
      privateByDefault: true,
      scope: 'explicit_target',
    });
  });

  it('updates source state through the autonomy store and keeps status counts current', () => {
    const root = makeTempRoot();

    const updated = updateAoiEnvironmentSource(root, 'aoi/default', {
      sourceId: 'workspace-git',
      patch: {
        enabled: true,
        consentReason: 'User enabled git metadata for the current mission.',
        lastObservedAt: 1500,
      },
      now: 2000,
    });

    expect(updated.sources.find((source) => source.id === 'workspace-git')).toMatchObject({
      enabled: true,
      consentReason: 'User enabled git metadata for the current mission.',
      lastObservedAt: 1500,
      updatedAt: 2000,
    });
    expect(loadAoiEnvironmentSourceRegistry(root, 'aoi/default', 3000)).toMatchObject(updated);

    const status = buildAoiAutonomyStatus(root, 'aoi/default', 4000);
    expect(status).toMatchObject({
      // +1 source vs the prior default set: the HP1 process-activity source,
      // which is high-risk and private-by-default (both counts +1), default off.
      environmentSourceCount: 12,
      enabledEnvironmentSourceCount: 5,
      highRiskEnvironmentSourceCount: 5,
      privateEnvironmentSourceCount: 5,
      lastEnvironmentSourceObservedAt: 1500,
    });
  });

  it('stores and clears explicit personal source consent review state', () => {
    const root = makeTempRoot();

    const enabled = updateAoiEnvironmentSource(root, 'aoi/default', {
      sourceId: 'notes-metadata',
      patch: {
        enabled: true,
        consentReason: 'User enabled note metadata for the current mission.',
        lastReviewedAt: 2500,
        lastObservedAt: 2600,
      },
      now: 3000,
    });
    expect(enabled.sources.find((source) => source.id === 'notes-metadata')).toMatchObject({
      enabled: true,
      consentReason: 'User enabled note metadata for the current mission.',
      lastReviewedAt: 2500,
      lastObservedAt: 2600,
    });

    const cleared = updateAoiEnvironmentSource(root, 'aoi/default', {
      sourceId: 'notes-metadata',
      patch: {
        enabled: false,
        consentReason: undefined,
        lastReviewedAt: undefined,
        lastObservedAt: undefined,
      },
      now: 4000,
    });
    const notesSource = cleared.sources.find((source) => source.id === 'notes-metadata');
    expect(notesSource).toMatchObject({
      enabled: false,
      updatedAt: 4000,
    });
    expect(notesSource?.consentReason).toBeUndefined();
    expect(notesSource?.lastReviewedAt).toBeUndefined();
    expect(notesSource?.lastObservedAt).toBeUndefined();
  });

  it('does not let source updates rewrite structural policy metadata', () => {
    const root = makeTempRoot();

    const updated = updateAoiEnvironmentSource(root, 'aoi/default', {
      sourceId: 'browser-context',
      patch: {
        enabled: true,
        kind: 'app_state',
        label: 'Low risk browser',
        risk: 'low',
        scope: 'session',
        allowedOperations: ['diff'],
        privateByDefault: false,
        consentReason: '',
      },
      now: 3000,
    });
    const browserSource = updated.sources.find((source) => source.id === 'browser-context');

    expect(browserSource).toMatchObject({
      enabled: true,
      kind: 'browser_context',
      label: 'Explicit browser page context',
      risk: 'high',
      scope: 'explicit_target',
      allowedOperations: ['summarize', 'read_metadata'],
      privateByDefault: true,
      updatedAt: 3000,
    });
    expect(browserSource?.consentReason).toBeUndefined();
  });

  it('rejects unknown source updates', () => {
    const root = makeTempRoot();

    expect(() =>
      updateAoiEnvironmentSource(root, 'aoi/default', {
        sourceId: 'missing-source',
        patch: {
          enabled: true,
        },
      }),
    ).toThrow(/not found/);
  });
});

describe('Aoi autonomy observations and reflections', () => {
  it('appends and loads observations and reflections latest-first', () => {
    const root = makeTempRoot();
    const observation: AoiObservation = {
      version: 1,
      id: 'observation-test-001',
      source: 'research_run',
      sessionPath: 'aoi/default',
      createdAt: 1000,
      summary: 'Research completed.',
      memoryIds: ['memory-1'],
      artifactRefs: ['research:run-1/report'],
      proposalIds: [],
      riskSignals: [],
      dedupeKey: 'research_run:run-1',
    };
    const reflection: AoiReflection = {
      version: 1,
      id: 'reflection-test-001',
      observationIds: ['observation-test-001'],
      sessionPath: 'aoi/default',
      createdAt: 1500,
      kind: 'opportunity',
      claim: 'Open the completed report when the user asks about the same topic.',
      evidenceRefs: ['observation:observation-test-001'],
      confidence: 0.82,
      risk: 'low',
      proposedMemoryCandidates: [],
      proposedActions: ['read_research_artifact'],
    };

    appendAoiObservation(root, observation);
    appendAoiReflection(root, reflection);

    expect(loadAoiObservations(root, 'aoi/default')).toEqual([observation]);
    expect(loadAoiObservationIndex(root, 'aoi/default').entries).toHaveLength(1);
    expect(loadAoiReflections(root, 'aoi/default')).toEqual([reflection]);
  });
});

describe('Aoi autonomy proposal storage and decisions', () => {
  it('keeps accepted proposals active and archives dismissed proposals', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({ id: 'proposal-test-001' }),
      makeProposal({ id: 'proposal-test-002', cooldownKey: 'research:other' }),
    ]);

    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 2000,
    });
    expect(accepted.proposal.status).toBe('accepted');
    expect(
      loadAoiActiveProposals(root, 'aoi/default').find((item) => item.id === 'proposal-test-001')
        ?.status,
    ).toBe('accepted');

    const dismissed = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-002',
      action: 'dismiss',
      reason: 'not useful',
      now: 2500,
    });
    expect(dismissed.proposal.status).toBe('dismissed');
    expect(loadAoiActiveProposals(root, 'aoi/default').map((item) => item.id)).toEqual([
      'proposal-test-001',
    ]);
    expect(loadAoiArchivedProposals(root, 'aoi/default').map((item) => item.id)).toEqual([
      'proposal-test-002',
    ]);
    expect(loadAoiProposalDecisions(root, 'aoi/default')).toHaveLength(2);
  });

  it('snoozes proposals without executing actions', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'snooze',
      snoozeMs: 5000,
      now: 3000,
    });

    expect(result.proposal.status).toBe('snoozed');
    expect(result.proposal.snoozedUntil).toBe(8000);
    expect(result.decision).toMatchObject({
      action: 'snooze',
      cooldownKey: 'research:kernel-memory',
      nextStatus: 'snoozed',
      snoozedUntil: 8000,
    });
  });

  it('stores categorized feedback only when it is valid and explicit', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'dismiss',
      feedbackCategory: 'wrong_memory',
      feedbackNote: 'Used a stale project memory.',
      now: 3200,
    });

    expect(result.decision).toMatchObject({
      feedbackCategory: 'wrong_memory',
      feedbackNote: 'Used a stale project memory.',
      memoryIds: ['aoi-memory-001'],
    });
    expect(loadAoiProposalDecisions(root, 'aoi/default')[0]).toMatchObject({
      feedbackCategory: 'wrong_memory',
      feedbackNote: 'Used a stale project memory.',
    });
  });

  it('ignores malformed feedback safely', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);

    const result = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'dismiss',
      feedbackCategory: 'bad_category',
      feedbackNote: 'Should not be stored without a valid category.',
      now: 3300,
    });

    expect(result.decision.feedbackCategory).toBeUndefined();
    expect(result.decision.feedbackNote).toBeUndefined();
  });

  it('attaches optional feedback to an existing decision without creating a new decision', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);
    const dismissed = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'dismiss',
      now: 3400,
    });

    const updated = applyAoiProposalFeedback(root, 'aoi/default', {
      decisionId: dismissed.decision.id,
      feedbackCategory: 'too_frequent',
      now: 3500,
    });

    expect(updated).toMatchObject({
      id: dismissed.decision.id,
      feedbackCategory: 'too_frequent',
    });
    expect(loadAoiProposalDecisions(root, 'aoi/default')).toHaveLength(1);
    expect(loadAoiOutcomeSignalRecords(root, 'aoi/default', 3500)).toEqual([
      expect.objectContaining({
        eventId: `proposal-feedback:${dismissed.decision.id}`,
        outcomeKind: 'user_feedback',
        signalKind: 'explicit_label',
        explicitLabel: 'too_frequent',
        sourceProposalId: dismissed.proposal.id,
        sourceDecisionId: dismissed.decision.id,
      }),
    ]);
  });

  it('records correction feedback as an explicit correction and rejects label rewrites', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal()]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: 'proposal-test-001',
      action: 'accept',
      now: 3600,
    });

    applyAoiProposalFeedback(root, 'aoi/default', {
      decisionId: accepted.decision.id,
      feedbackCategory: 'wrong_source',
      feedbackNote: 'The selected source was not authoritative.',
      now: 3700,
    });

    expect(loadAoiOutcomeSignalRecords(root, 'aoi/default', 3700)[0]).toMatchObject({
      outcomeKind: 'user_correction',
      signalKind: 'explicit_correction',
      explicitLabel: 'wrong_source',
      inferredAdjustment: {
        direction: 'risk_up',
      },
    });
    expect(() =>
      applyAoiProposalFeedback(root, 'aoi/default', {
        decisionId: accepted.decision.id,
        feedbackCategory: 'useful',
        now: 3800,
      }),
    ).toThrow(/immutable/i);
  });

  it('rejects invalid proposal transitions', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [makeProposal({ status: 'accepted' })]);

    expect(() =>
      applyAoiProposalDecision(root, 'aoi/default', {
        proposalId: 'proposal-test-001',
        action: 'dismiss',
      }),
    ).toThrow(/Cannot dismiss proposal/);
  });

  it('builds a compact status summary', () => {
    const root = makeTempRoot();
    saveAoiActiveProposals(root, 'aoi/default', [
      makeProposal({ id: 'proposal-test-001', status: 'active' }),
      makeProposal({ id: 'proposal-test-002', status: 'snoozed', cooldownKey: 'research:other' }),
    ]);
    appendAoiObservation(root, {
      version: 1,
      id: 'observation-test-001',
      source: 'system',
      sessionPath: 'aoi/default',
      createdAt: 1000,
      summary: 'Observed.',
      memoryIds: [],
      artifactRefs: [],
      proposalIds: [],
      riskSignals: [],
      dedupeKey: 'system:observed',
    });

    const status = buildAoiAutonomyStatus(root, 'aoi/default', 4000);

    expect(status).toMatchObject({
      sessionPath: 'aoi/default',
      activeProposalCount: 1,
      snoozedProposalCount: 1,
      observationCount: 1,
      updatedAt: 4000,
    });
  });
});

describe('Aoi operator timeline storage and trace export', () => {
  it('loads newest timeline events deterministically with proposal refs', () => {
    const root = makeTempRoot();
    const proposal = makeProposal();
    saveAoiActiveProposals(root, 'aoi/default', [proposal]);
    const accepted = applyAoiProposalDecision(root, 'aoi/default', {
      proposalId: proposal.id,
      action: 'accept',
      now: 2000,
    });
    const proposalEvent = recordAoiProposalDecisionTimelineEvent({
      sessionsDir: root,
      proposal: accepted.proposal,
      decision: accepted.decision,
    });
    recordAoiOperatorTimelineEvent(root, {
      sessionPath: 'aoi/default',
      kind: 'digest_item_surfaced',
      visibility: 'operator_visible',
      createdAt: 2500,
      title: 'Digest surfaced',
      summary: 'A mission update was shown.',
      digestItemId: 'digest-test-001',
      evidenceRefs: ['proposal:proposal-test-001'],
      relatedRefs: ['proposal:proposal-test-001'],
    });
    recordAoiOperatorTimelineEvent(root, {
      sessionPath: 'aoi/default',
      kind: 'source_suppressed',
      visibility: 'hidden',
      createdAt: 1500,
      title: 'Source suppressed',
      summary: 'A low relevance source was kept out of the prompt.',
      sourceRef: 'context-source:low-relevance',
      evidenceRefs: ['source:low-relevance'],
      relatedRefs: ['environment-source:manual-note'],
    });

    const newest = loadAoiOperatorTimelineEvents(root, 'aoi/default', { limit: 2 });

    expect(newest.map((event) => event.kind)).toEqual([
      'digest_item_surfaced',
      'proposal_accepted',
    ]);
    expect(newest[1]).toMatchObject({
      id: proposalEvent.id,
      proposalId: proposal.id,
      decisionId: accepted.decision.id,
      relatedRefs: expect.arrayContaining([`proposal:${proposal.id}`]),
    });
  });

  it('exports privacy-safe traces without raw paths, message bodies, or command output', () => {
    const root = makeTempRoot();
    recordAoiOperatorTimelineEvent(root, {
      sessionPath: 'aoi/default',
      kind: 'approved_command_recorded',
      visibility: 'operator_visible',
      createdAt: 1000,
      title: 'Command touched F:\\kernullist\\YourOpenRoom\\secret.txt',
      summary: 'Command output included https://private.example.local/report and user@example.com.',
      proposalId: 'proposal-test-001',
      commandAuditId: 'audit-secret-001',
      evidenceRefs: ['file:F:\\kernullist\\YourOpenRoom\\secret.txt'],
      relatedRefs: ['aoi-command-audit:audit-secret-001'],
      metadata: {
        messageBody: 'private chat body that must not be exported',
        stdoutExcerpt: 'secret command output that must not be exported',
        command: 'type F:\\kernullist\\YourOpenRoom\\secret.txt',
      },
    });
    recordAoiOperatorTimelineEvent(root, {
      sessionPath: 'aoi/default',
      kind: 'proposal_accepted',
      visibility: 'operator_visible',
      createdAt: 1200,
      title: 'Proposal accepted',
      summary: 'The user accepted the safe follow-up.',
      proposalId: 'proposal-test-001',
      evidenceRefs: ['proposal:proposal-test-001'],
      relatedRefs: ['proposal:proposal-test-001'],
    });

    const traceExport = exportAoiOperatorTrace(root, 'aoi/default', {
      now: 2000,
      persist: false,
    });
    const exportJson = JSON.stringify(traceExport);

    expect(traceExport.events.map((event) => event.kind)).toEqual([
      'approved_command_recorded',
      'proposal_accepted',
    ]);
    expect(exportJson).not.toContain('F:\\kernullist\\YourOpenRoom\\secret.txt');
    expect(exportJson).not.toContain('private chat body');
    expect(exportJson).not.toContain('secret command output');
    expect(exportJson).not.toContain('https://private.example.local/report');
    expect(exportJson).toContain('[local-path:1]');
    expect(traceExport.redactionSummary.totalReplacementCount).toBeGreaterThanOrEqual(4);
    expect(traceExport.privacyNotes.join(' ')).toContain('synthetic labels');
  });

  it('redacts personal metadata labels from trace exports', () => {
    const root = makeTempRoot();
    recordAoiOperatorTimelineEvent(root, {
      sessionPath: 'aoi/default',
      kind: 'source_selected',
      visibility: 'dashboard_only',
      createdAt: 1000,
      title: 'Source selected: Private roadmap',
      summary: 'Notes metadata: recentTitles=Private roadmap; tags=sensitive-kernel',
      sourceRef: 'context-source:notes-private-roadmap',
      sourceKind: 'notes_metadata',
      evidenceRefs: ['personal-signal:notes_metadata', 'environment-source:notes-metadata'],
      relatedRefs: ['environment-source:notes-metadata'],
      metadata: {
        recentTitles: ['Private roadmap'],
        tags: ['sensitive-kernel'],
      },
    });

    const traceExport = exportAoiOperatorTrace(root, 'aoi/default', {
      now: 2000,
      persist: false,
    });
    const exportJson = JSON.stringify(traceExport);

    expect(exportJson).not.toContain('Private roadmap');
    expect(exportJson).not.toContain('sensitive-kernel');
    expect(exportJson).toContain('[personal-metadata:');
    expect(traceExport.events[0].redactionState).toBe('synthetic');
  });

  it('summarizes last trace export redactions for the dashboard', () => {
    const root = makeTempRoot();
    recordAoiOperatorTimelineEvent(root, {
      sessionPath: 'aoi/default',
      kind: 'observation_ingested',
      visibility: 'dashboard_only',
      createdAt: 1000,
      title: 'Observation',
      summary: 'Observed C:\\Users\\secret\\mail.txt.',
      evidenceRefs: ['observation:timeline-test'],
      relatedRefs: ['observation:timeline-test'],
    });
    exportAoiOperatorTrace(root, 'aoi/default', {
      now: 1500,
    });

    const summary = loadAoiOperatorTimelineSummary(root, 'aoi/default');

    expect(summary.totalEventCount).toBe(2);
    expect(summary.exportedTraceCount).toBe(1);
    expect(summary.lastExportAt).toBe(1500);
    expect(summary.lastExportRedactionCount).toBeGreaterThanOrEqual(1);
  });
});

describe('recordAoiOperatorFeedbackLabelAction user_correction emission (P1.1)', () => {
  const SESSION = 'aoi/default';

  function recordLabel(root: string, label: string, actor?: 'user' | 'system'): void {
    recordAoiOperatorFeedbackLabelAction(root, {
      sessionPath: SESSION,
      decisionRecordId: 'rec-uc-1',
      decisionId: 'dec-uc-1',
      label: label as never,
      sourceKinds: ['workspace_build'],
      evidenceRefs: ['workspace:validation'],
      ...(actor ? { actor } : {}),
      now: 1000,
    });
  }

  it('emits a user_correction outcome for a correction label (wrong_source / unsafe)', () => {
    const root = makeTempRoot();
    recordLabel(root, 'unsafe');
    recordLabel(root, 'unsafe');

    const outcomes = loadAoiOutcomeSignalRecords(root, SESSION, 2000);
    const labels = loadAoiOperatorFeedbackLabelActions(root, SESSION);
    expect(outcomes).toHaveLength(1);
    expect(labels).toHaveLength(1);
    expect(outcomes[0].outcomeKind).toBe('user_correction');
    expect(outcomes[0].sourceDecisionId).toBe('dec-uc-1');
    expect(outcomes[0].explicitLabel).toBe('unsafe');
  });

  it('emits nothing for a non-correction label', () => {
    const root = makeTempRoot();
    recordLabel(root, 'useful');
    expect(loadAoiOutcomeSignalRecords(root, SESSION, 2000)).toHaveLength(0);
  });

  it('emits nothing for a system-authored correction label (user-authored only)', () => {
    const root = makeTempRoot();
    recordLabel(root, 'unsafe', 'system');
    expect(loadAoiOutcomeSignalRecords(root, SESSION, 2000)).toHaveLength(0);
  });
});
