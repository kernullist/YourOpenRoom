import { describe, expect, it } from 'vitest';
import { buildAoiRealFieldCapture } from '../aoiRealFieldCapture';
import { buildAoiProactiveBriefScoutProviderMissingReplay } from '../aoiProactiveBriefScout';
import type {
  AoiInterruptionGovernorDecision,
  AoiMissionState,
  AoiOperatorTimelineEvent,
  AoiOpportunity,
  AoiWorkspaceSnapshot,
} from '../aoiAutonomyTypes';
import type { AoiSourceFreshnessContract } from '../aoiSourceFreshnessContract';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function makeWorkspaceSnapshot(): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: NOW - 1_000,
    workspaceLabel: 'YourOpenRoom workspace at C:\\Users\\secret\\YourOpenRoom',
    sourceIds: ['workspace-git', 'workspace-build'],
    git: {
      version: 1,
      branchName: 'codex/real-field-capture',
      branchChanged: false,
      isDirty: true,
      changedFileCount: 2,
      stagedFileCount: 0,
      unstagedFileCount: 2,
      untrackedFileCount: 0,
      statusSummary: 'modified apps/webuiapps/src/lib/aoiRealFieldCapture.ts',
      changedFiles: [],
    },
    validation: {
      version: 1,
      command: 'pnpm exec vitest run src/lib/__tests__/aoiRealFieldCapture.test.ts',
      result: 'passed',
      completedAt: NOW - 800,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'fresh',
      evidenceRefs: ['workspace:validation:real-field'],
    },
    freshness: 'fresh',
    evidenceRefs: ['workspace:git-status', 'workspace:validation:real-field'],
    warnings: [],
  };
}

function makeDisconnectedGmailContract(): AoiSourceFreshnessContract {
  return {
    version: 1,
    id: 'source-contract-gmail-disconnected',
    sourceId: 'gmail-metadata',
    sourceKind: 'gmail_metadata',
    sourceLabel: 'Gmail metadata for honey@example.com',
    consentState: 'disconnected',
    dataScope: 'metadata counts only',
    scopeState: 'metadata_only',
    bodyAccessState: 'body_disabled',
    freshnessState: 'disconnected',
    signalFreshness: 'unknown',
    staleAfterMs: 60 * 60 * 1000,
    cannotKnow: [
      {
        version: 1,
        code: 'gmail_disconnected',
        statement:
          'Cannot know whether honey@example.com has new mail from C:\\Users\\secret\\Inbox because Gmail is disconnected.',
        evidenceRefs: ['gmail:disconnected', 'C:\\Users\\secret\\Inbox\\raw.eml'],
      },
    ],
    evidenceRefs: ['source:gmail-metadata', 'C:\\Users\\secret\\Inbox\\raw.eml'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeMissingNotesConsentContract(): AoiSourceFreshnessContract {
  return {
    version: 1,
    id: 'source-contract-notes-missing-consent',
    sourceId: 'notes-metadata',
    sourceKind: 'notes_metadata',
    sourceLabel: 'Notes metadata',
    consentState: 'missing',
    dataScope: 'metadata counts only',
    scopeState: 'metadata_only',
    bodyAccessState: 'metadata_only',
    freshnessState: 'fresh',
    signalFreshness: 'fresh',
    lastObservedAt: NOW - 450,
    staleAfterMs: 60 * 60 * 1000,
    cannotKnow: [],
    evidenceRefs: ['source:notes-missing-consent'],
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeMission(): AoiMissionState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    status: 'active',
    activeGoalId: 'goal-real-field-capture',
    focusSummary: 'Capture real field operations without leaking honey@example.com.',
    waitingOn: 'none',
    nextRecommendedAction: {
      kind: 'resume_mission',
      label: 'Render the real field capture dashboard.',
      reason: 'Fresh workspace evidence exists, but private source state is metadata-only.',
      ref: 'goal:real-field-capture',
    },
    evidenceRefs: ['goal:real-field-capture'],
    sourceRefs: {
      goalRef: 'goal:real-field-capture',
      workspaceSnapshotRef: 'workspace:git-status',
    },
    transitions: [],
    createdAt: NOW - 10_000,
    updatedAt: NOW - 500,
  };
}

function makeOpportunity(partial: Partial<AoiOpportunity> = {}): AoiOpportunity {
  const id = partial.id ?? 'opportunity-real-field-dashboard';
  return {
    version: 1,
    id,
    sessionPath: SESSION_PATH,
    sourceKind: 'workspace',
    title: 'Review real field capture evidence',
    curiosityQuestion: 'Can Aoi explain what it actually saw?',
    whyNow: 'Fresh workspace metadata and source honesty records exist.',
    evidenceNeed: 'Use field events and source contracts only.',
    suggestedNextAction: 'Show the dashboard panel.',
    risk: 'low',
    confidence: 0.88,
    urgency: 0.74,
    novelty: 0.8,
    deliveryRecommendation: 'dashboard',
    status: 'active',
    evidenceRefs: ['opportunity:real-field-dashboard'],
    dedupeKey: `real-field:${id}`,
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeInterruption(
  opportunity: AoiOpportunity,
  partial: Partial<AoiInterruptionGovernorDecision> = {},
): AoiInterruptionGovernorDecision {
  return {
    version: 1,
    id: `interruption-${opportunity.id}`,
    sessionPath: SESSION_PATH,
    opportunityId: opportunity.id,
    opportunityDedupeKey: opportunity.dedupeKey,
    requestedMode: opportunity.deliveryRecommendation,
    deliveryMode: 'dashboard',
    directChatAllowed: false,
    score: 0.72,
    blockedReasons: ['direct_chat_not_opted_in'],
    directChatBlockedReasons: ['direct_chat_not_opted_in'],
    evidenceRefs: [`interruption:${opportunity.id}`],
    cooldownKey: `cooldown:${opportunity.dedupeKey}`,
    modeLabel: 'Dashboard',
    summaryLabel: 'Dashboard visibility is allowed; direct chat remains gated.',
    blockedReasonLabels: ['direct chat not opted in'],
    safetyBoundaryLabel: 'Display-only dashboard update.',
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

function makeRawTimelineEvent(): AoiOperatorTimelineEvent {
  return {
    version: 1,
    id: 'timeline-raw-private-input',
    sessionPath: SESSION_PATH,
    kind: 'observation_ingested',
    visibility: 'operator_visible',
    createdAt: NOW - 1_500,
    title: 'Raw private timeline input for honey@example.com',
    summary: 'body: Please do not expose this mail body from C:\\Users\\secret\\Inbox\\raw.eml.',
    redactionState: 'none',
    evidenceRefs: ['timeline:raw-private', 'C:\\Users\\secret\\Inbox\\raw.eml'],
    relatedRefs: ['honey@example.com'],
    sourceRef: 'timeline:raw-private',
    sourceKind: 'app_state',
    risk: 'medium',
  };
}

describe('buildAoiRealFieldCapture', () => {
  it('binds live field signals into redacted events, timeline, shadow, and source honesty', () => {
    const dashboardOpportunity = makeOpportunity();
    const quietOpportunity = makeOpportunity({
      id: 'opportunity-stale-direct-chat',
      sourceKind: 'research',
      title: 'Mention stale RE trend',
      whyNow: 'A stale research summary looks interesting but is not current.',
      evidenceNeed: 'Refresh source before claiming current RE trend.',
      deliveryRecommendation: 'direct_chat',
      risk: 'medium',
      evidenceRefs: ['opportunity:stale-re-trend'],
      dedupeKey: 'real-field:stale-re-trend',
    });
    const scoutReplay = buildAoiProactiveBriefScoutProviderMissingReplay({
      sessionPath: SESSION_PATH,
      topicId: 'reverse-engineering',
      topicLabel: 'RE trend scout',
      now: NOW,
    });

    const capture = buildAoiRealFieldCapture({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshots: [makeWorkspaceSnapshot()],
      researchSignals: [
        {
          sessionPath: SESSION_PATH,
          runId: 'research-re-stale',
          title: 'RE trend research',
          summary:
            'A stale trend summary references token=secret123456789012 and honey@example.com.',
          freshness: 'stale',
          completedAt: NOW - 9 * 24 * 60 * 60 * 1000,
          evidenceRefs: ['research:re-stale'],
          cannotKnow: ['Current RE trend cannot be claimed until research refreshes.'],
          risk: 'medium',
        },
      ],
      kiraOutcomes: [
        {
          sessionPath: SESSION_PATH,
          outcomeId: 'kira-validation-blocked',
          status: 'blocked',
          summary: 'Kira validation blocked until review evidence exists.',
          validatedAt: NOW - 700,
          evidenceRefs: ['kira:blocked-validation'],
          cannotKnow: ['Cannot claim Kira integration success without validation.'],
          risk: 'medium',
        },
      ],
      appStateSignals: [
        {
          sessionPath: SESSION_PATH,
          stateId: 'kira-model-settings-open',
          summary: 'Kira Model Settings page is open at C:\\Users\\secret\\settings.json.',
          freshness: 'fresh',
          observedAt: NOW - 600,
          evidenceRefs: ['app:kira-settings'],
          risk: 'low',
        },
      ],
      personalMetadataSources: [
        {
          sessionPath: SESSION_PATH,
          sourceId: 'gmail-metadata',
          label: 'Gmail metadata',
          kind: 'gmail_metadata',
          consentState: 'disconnected',
          freshness: 'unknown',
          metadataSummary: 'Gmail configured=true; connected=false; unread=unknown.',
          bodyPreview: 'body: launch plan from honey@example.com should never leak.',
          observedAt: NOW - 500,
          evidenceRefs: ['personal:gmail-metadata'],
          risk: 'medium',
        },
      ],
      memorySignals: [
        {
          sessionPath: SESSION_PATH,
          signalId: 'memory-preference-re',
          sourceKind: 'memory',
          summary: 'Operator is interested in RE and anti-cheat engineering.',
          freshness: 'fresh',
          evidenceRefs: ['memory:preference-re'],
          observedAt: NOW - 400,
          risk: 'low',
        },
      ],
      manualSignals: [
        {
          sessionPath: SESSION_PATH,
          signalId: 'manual-current-claim-boundary',
          sourceKind: 'manual',
          summary: 'Disconnected personal sources must be blind spots, not negative evidence.',
          freshness: 'fresh',
          evidenceRefs: ['manual:current-claim-boundary'],
          observedAt: NOW - 300,
          risk: 'low',
        },
      ],
      sourceFreshnessContracts: [
        makeDisconnectedGmailContract(),
        makeMissingNotesConsentContract(),
      ],
      mission: makeMission(),
      timelineEvents: [makeRawTimelineEvent()],
      opportunities: [dashboardOpportunity, quietOpportunity],
      interruptionDecisions: [
        makeInterruption(dashboardOpportunity),
        makeInterruption(quietOpportunity, {
          deliveryMode: 'hidden',
          directChatAllowed: false,
          blockedReasons: ['stale_source', 'direct_chat_not_opted_in'],
          directChatBlockedReasons: ['stale_source', 'direct_chat_not_opted_in'],
          summaryLabel: 'Stay quiet until stale research is refreshed.',
          blockedReasonLabels: ['stale source', 'direct chat not opted in'],
        }),
      ],
      scoutSourceHonestyRecords: scoutReplay.sourceHonestyRecords,
      scoutFieldEvents: scoutReplay.fieldEvents,
    });
    const serialized = JSON.stringify(capture);

    expect(capture.fieldSignals.length).toBeGreaterThanOrEqual(8);
    expect(capture.fieldEvents.length).toBeGreaterThan(capture.fieldSignals.length);
    expect(capture.timelineEvents.length).toBeGreaterThan(capture.fieldSignals.length);
    expect(capture.shadowDecisions.length).toBe(2);
    expect(capture.sourceHonestyRecords.length).toBeGreaterThan(capture.fieldSignals.length);
    expect(capture.privateLeakCount).toBe(0);
    expect(capture.unauthorizedMutationCount).toBe(0);
    expect(capture.staleCurrentClaimCount).toBe(0);
    expect(capture.mutationCount).toBe(0);
    expect(capture.liveOperationCounts).toEqual({
      shell: 0,
      network: 0,
      gmail: 0,
      calendar: 0,
      kiraMutation: 0,
    });
    expect(capture.actionAuthority).toBe('display_only');
    expect(capture.cannotKnow.join(' ')).toContain('Current state cannot be claimed');
    expect(capture.whyQuiet.join(' ')).toContain('stale source');
    expect(capture.summary.blindSpotLabels.join(' ')).toContain('cannot claim current');
    expect(
      capture.sourceHonestyRecords.some(
        (record) =>
          record.evidenceRefs.includes('source:notes-missing-consent') &&
          record.currentClaimBlockedReasons.includes('consent:unknown'),
      ),
    ).toBe(true);
    expect(capture.sourceHonestyRecords.some((record) => !record.currentClaimAllowed)).toBe(true);
    expect(
      capture.sourceHonestyRecords.every((record) => record.actionAuthority === 'display_only'),
    ).toBe(true);
    expect(capture.timelineEvents.some((event) => event.redactionState === 'redacted')).toBe(true);
    expect(serialized).not.toContain('honey@example.com');
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('secret123456789012');
    expect(serialized.toLowerCase()).not.toContain('empty inbox');
    expect(capture.evidenceRefs).toContain('kira:blocked-validation');
    expect(capture.summary.hardFailLabels).toEqual([
      'private leaks 0',
      'unauthorized mutations 0',
      'stale current claims 0',
    ]);
  });
});
