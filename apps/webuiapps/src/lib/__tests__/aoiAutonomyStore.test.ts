import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAoiObservation,
  appendAoiReflection,
  applyAoiProposalDecision,
  applyAoiProposalFeedback,
  buildAoiAutonomyStatus,
  createAoiAutonomyId,
  isValidAoiAutonomyId,
  loadAoiEnvironmentSourceRegistry,
  loadAoiActiveProposals,
  loadAoiArchivedProposals,
  loadAoiAutonomyPolicy,
  loadAoiObservationIndex,
  loadAoiObservations,
  loadAoiProposalDecisions,
  loadAoiReflections,
  normalizeAoiAutonomySessionPath,
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
      'browser-context',
      'manual-note',
      'calendar-metadata',
      'gmail-metadata',
      'notes-metadata',
    ]);
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
      environmentSourceCount: 10,
      enabledEnvironmentSourceCount: 5,
      highRiskEnvironmentSourceCount: 3,
      privateEnvironmentSourceCount: 3,
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
    });

    expect(updated).toMatchObject({
      id: dismissed.decision.id,
      feedbackCategory: 'too_frequent',
    });
    expect(loadAoiProposalDecisions(root, 'aoi/default')).toHaveLength(1);
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
