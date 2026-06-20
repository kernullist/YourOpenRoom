import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AoiInterestProfile,
  AoiInterestTopic,
  AoiKiraOutcomeEvent,
  AoiWorkspaceSnapshot,
} from '../aoiAutonomyTypes';
import { loadAoiActiveOpportunities } from '../aoiAutonomyStore';
import {
  buildAoiCuriosityCandidates,
  runAoiCuriosityEngineForSession,
  toAoiOpportunityUpsertInput,
} from '../aoiCuriosityEngine';
import { buildAoiFollowThroughLearningSummary } from '../aoiFollowThroughLearning';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiResearchRunSummary } from '../aoiResearchTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-curiosity-engine-test-'));
  tempRoots.push(root);
  return root;
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: partial.id ?? 'memory-re-001',
    scope: partial.scope ?? 'user',
    type: partial.type ?? 'preference',
    status: partial.status ?? 'active',
    content: partial.content ?? 'User is interested in reverse engineering toolchain updates.',
    normalizedContent:
      partial.normalizedContent ?? 'user is interested in reverse engineering toolchain updates',
    importance: partial.importance ?? 0.82,
    confidence: partial.confidence ?? 0.85,
    hits: partial.hits ?? 3,
    createdAt: partial.createdAt ?? NOW - 100_000,
    updatedAt: partial.updatedAt ?? NOW - 50_000,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['episode-001'],
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    tags: partial.tags ?? ['interest', 'reverse-engineering'],
    entities: partial.entities ?? ['Reverse Engineering'],
    ...partial,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'topic-re',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.9,
    importance: partial.importance ?? 0.88,
    noveltyPreference: partial.noveltyPreference ?? 0.74,
    currentInfoPreference: partial.currentInfoPreference ?? 0.93,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW - 100_000,
    updatedAt: partial.updatedAt ?? NOW - 60_000,
    ...partial,
  };
}

function makeProfile(topics: AoiInterestTopic[] = [makeTopic()]): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    topics,
    generatedAt: NOW,
    sourceMemoryCount: topics.flatMap((topic) => topic.memoryIds).length,
    warnings: [],
  };
}

function makeResearchRun(partial: Partial<AoiResearchRunSummary> = {}): AoiResearchRunSummary {
  return {
    id: partial.id ?? 'research-re-001',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    request: partial.request ?? 'Reverse engineering trend watch',
    title: partial.title ?? 'Reverse Engineering Trend Watch',
    mode: partial.mode ?? 'standard',
    language: partial.language ?? 'ko',
    recency: partial.recency ?? 'month',
    maxSources: partial.maxSources ?? 5,
    createdAt: partial.createdAt ?? NOW - 40 * 24 * 60 * 60 * 1000,
    updatedAt: partial.updatedAt ?? NOW - 35 * 24 * 60 * 60 * 1000,
    completedAt: partial.completedAt ?? NOW - 35 * 24 * 60 * 60 * 1000,
    status: partial.status ?? 'completed',
    phase: partial.phase ?? 'completed',
    statusMessage: partial.statusMessage ?? 'Completed',
    sourceCounts: partial.sourceCounts ?? {
      planned: 5,
      candidates: 4,
      accepted: 1,
      failed: 0,
    },
    artifactAvailability: partial.artifactAvailability ?? {
      manifest: true,
      report: false,
      sources: false,
      evidence: false,
    },
    claimCount: partial.claimCount ?? 2,
    warningCount: partial.warningCount ?? 0,
    verificationWarningCount: partial.verificationWarningCount ?? 0,
    ...partial,
  };
}

function makeKiraOutcome(partial: Partial<AoiKiraOutcomeEvent> = {}): AoiKiraOutcomeEvent {
  return {
    version: 1,
    id: partial.id ?? 'kira-outcome-001',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    kind: partial.kind ?? 'kira_validation_failed',
    workId: partial.workId ?? 'work-001',
    workRef: partial.workRef ?? 'kira:work-001',
    workTitle: partial.workTitle ?? 'Strengthen Kira settings access',
    projectName: partial.projectName ?? 'YourOpenRoom',
    validationSummary: partial.validationSummary ?? 'pnpm build:test failed in ChatPanel.',
    changedFilesSummary: partial.changedFilesSummary ?? 'ChatPanel and Aoi autonomy files changed.',
    evidenceRefs: partial.evidenceRefs ?? ['kira:work-001', 'validation:build-test'],
    reviewApproved: partial.reviewApproved ?? false,
    validationPassed: partial.validationPassed ?? false,
    integrated: partial.integrated ?? false,
    reviewerNotes: partial.reviewerNotes ?? ['Validation must pass before integration.'],
    createdAt: partial.createdAt ?? NOW - 2_000,
    dedupeKey: partial.dedupeKey ?? 'kira:work-001:validation-failed',
    ...partial,
  };
}

function makeWorkspaceSnapshot(partial: Partial<AoiWorkspaceSnapshot> = {}): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: partial.collectedAt ?? NOW - 1_000,
    workspaceLabel: partial.workspaceLabel ?? 'YourOpenRoom',
    sourceIds: partial.sourceIds ?? ['workspace_git', 'workspace_build'],
    git: partial.git,
    validation: partial.validation ?? {
      version: 1,
      command: 'pnpm --filter @openroom/webuiapps run build:test',
      result: 'failed',
      completedAt: NOW - 1_000,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'failed',
      staleReason: 'Last build:test failed.',
      evidenceRefs: ['validation:build-test'],
    },
    freshness: partial.freshness ?? 'failed',
    evidenceRefs: partial.evidenceRefs ?? ['workspace:YourOpenRoom'],
    warnings: partial.warnings ?? [],
    ...partial,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi Curiosity Engine', () => {
  it('creates an interest-based curiosity candidate with generated evidence', () => {
    const result = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [makeMemory()],
      interestProfile: makeProfile(),
      maxCandidates: 4,
    });
    const candidate = result.candidates.find((item) => item.signalKind === 'interest');

    expect(candidate).toBeDefined();
    expect(candidate?.sourceKind).toBe('interest');
    expect(candidate?.title).toContain('Reverse Engineering');
    expect(candidate?.curiosityQuestion).toContain('fresh Reverse Engineering');
    expect(candidate?.evidenceRefs).toEqual(
      expect.arrayContaining(['generated_by:curiosity_engine', 'interest_topic:topic-re']),
    );
    expect(toAoiOpportunityUpsertInput(candidate!)).toMatchObject({
      sourceKind: 'interest',
      status: 'active',
      dedupeKey: 'curiosity:interest:reverse-engineering',
    });
  });

  it('boosts accepted follow-through signals in candidate ranking only', () => {
    const baseline = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [makeMemory()],
      interestProfile: makeProfile(),
      maxCandidates: 4,
    }).candidates.find((item) => item.signalKind === 'interest');
    const followThroughLearning = buildAoiFollowThroughLearningSummary({
      sessionPath: SESSION_PATH,
      followThroughEvents: [
        {
          version: 1,
          id: 'follow-through-accepted-re',
          sessionPath: SESSION_PATH,
          opportunityId: 'opp-re-accepted',
          sourceKind: 'interest',
          topicKey: 'interest:reverse-engineering',
          sourceKey: 'interest',
          deliveryMode: 'dashboard',
          action: 'accepted',
          feedbackCategory: 'useful',
          result: 'positive',
          timingLabel: 'accepted in test',
          evidenceRefs: ['test:accepted-follow-through'],
          createdAt: NOW - 1_000,
          actionAuthority: 'display_only',
          mutationCount: 0,
        },
      ],
      now: NOW,
    });
    const learned = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [makeMemory()],
      interestProfile: makeProfile(),
      followThroughLearning,
      maxCandidates: 4,
    }).candidates.find((item) => item.signalKind === 'interest');

    expect(learned?.rank.feedbackFactor).toBeGreaterThan(baseline?.rank.feedbackFactor ?? 0);
    expect(learned?.rank.score).toBeGreaterThan(baseline?.rank.score ?? 0);
    expect(learned).not.toHaveProperty('actionAuthority');
    expect(learned).not.toHaveProperty('mutationCount');
  });

  it('creates a stale research follow-up candidate with cannot-know evidence', () => {
    const result = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      researchRuns: [makeResearchRun()],
      maxCandidates: 3,
    });
    const candidate = result.candidates.find((item) => item.signalKind === 'research');

    expect(candidate).toBeDefined();
    expect(candidate?.sourceKind).toBe('research');
    expect(candidate?.cannotKnow).toEqual(
      expect.arrayContaining(['research result may be stale and needs freshness verification']),
    );
    expect(candidate?.evidenceNeed).toContain('Need fresh verification');
    expect(candidate?.suggestedNextAction).toContain('do not start a new research run');
  });

  it('creates a Kira validation failure candidate without granting mutation authority', () => {
    const result = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      kiraOutcomes: [makeKiraOutcome()],
      maxCandidates: 3,
    });
    const candidate = result.candidates.find((item) => item.signalKind === 'kira');
    const upsertInput = toAoiOpportunityUpsertInput(candidate!);

    expect(candidate).toBeDefined();
    expect(candidate?.risk).toBe('medium');
    expect(candidate?.deliveryRecommendation).toBe('inline_card');
    expect(candidate?.suggestedNextAction).toContain('read-only');
    expect(upsertInput).not.toHaveProperty('actionAuthority');
    expect(upsertInput).not.toHaveProperty('mutationCount');
  });

  it('suppresses duplicate candidates with the same semantic key', () => {
    const result = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      interestProfile: makeProfile([
        makeTopic({ id: 'topic-re-a' }),
        makeTopic({
          id: 'topic-re-b',
          label: 'RE',
          normalizedLabel: 'reverse engineering',
          confidence: 0.86,
        }),
      ]),
      maxCandidates: 5,
    });
    const interestCandidates = result.candidates.filter((item) => item.signalKind === 'interest');

    expect(interestCandidates).toHaveLength(1);
    expect(result.suppressed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dedupeKey: 'curiosity:interest:reverse-engineering',
          reason: 'duplicate',
        }),
      ]),
    );
  });

  it('keeps private source bodies out of candidate text and reports cannot-know', () => {
    const privateMemory = makeMemory({
      id: 'memory-private-001',
      tags: ['private', 'reverse-engineering'],
      content: 'private credential secret_token=super-secret-value',
      entities: ['Private RE Notes'],
    });
    const result = buildAoiCuriosityCandidates({
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [privateMemory],
      interestProfile: makeProfile([
        makeTopic({
          id: 'topic-private-re',
          memoryIds: ['memory-private-001'],
          evidenceRefs: ['memory:memory-private-001', 'private:metadata-only'],
        }),
      ]),
      maxCandidates: 5,
    });
    const interestCandidate = result.candidates.find((item) => item.signalKind === 'interest');
    const serialized = JSON.stringify(result);

    expect(interestCandidate?.cannotKnow.join(' ')).toContain('private source body withheld');
    expect(interestCandidate?.evidenceNeed).toContain('private memory bodies are withheld');
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('secret_token');
    expect(serialized).not.toContain('Private RE Notes');
  });

  it('upserts generated candidates into the display-only Opportunity Inbox', () => {
    const root = makeTempRoot();
    const run = runAoiCuriosityEngineForSession({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [makeMemory()],
      interestProfile: makeProfile(),
      researchRuns: [makeResearchRun()],
      workspaceSnapshot: makeWorkspaceSnapshot(),
      maxCandidates: 4,
    });
    const active = loadAoiActiveOpportunities(root, SESSION_PATH, NOW);

    expect(run.createdCount).toBeGreaterThan(0);
    expect(active.length).toBe(run.upserted.length);
    expect(active[0]).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(active.flatMap((item) => item.evidenceRefs)).toContain('generated_by:curiosity_engine');
  });
});
