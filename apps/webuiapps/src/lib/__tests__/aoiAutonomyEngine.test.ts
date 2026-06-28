import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  checkAoiProposalPolicy,
  getDefaultAoiEnvironmentSourceRegistry,
} from '../aoiAutonomyPolicy';
import { loadAoiActiveGoals, saveAoiActiveGoals } from '../aoiAutonomyGoals';
import {
  runAoiAutonomyBackgroundTick,
  runAoiAutonomyTick,
  type AoiAutonomyReflectionChat,
} from '../aoiAutonomyEngine';
import {
  appendAoiProposalDecision,
  beginAoiAutonomyTick,
  buildAoiAutonomyStatus,
  loadAoiActiveProposals,
  loadAoiAutonomyTickState,
  loadAoiCommandAuditRecords,
  loadAoiObservations,
  loadAoiReflections,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
  updateAoiEnvironmentSource,
} from '../aoiAutonomyStore';
import { loadAoiAutonomySchedulerState, runAoiAutonomyWakeup } from '../aoiAutonomyScheduler';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import { loadAoiMissionState, saveAoiMissionState } from '../aoiAutonomyMission';
import { buildAoiContextRouterResult } from '../aoiContextRouter';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import { loadServerAoiMemories } from '../aoiMemoryServerWriter';
import { buildAoiResearchArtifactPaths, type AoiResearchManifest } from '../aoiResearchTypes';
import { buildAoiTrustCalibrationProfile } from '../aoiTrustCalibration';
import { buildAoiOperatorHealthState } from '../aoiOperatorHealthServer';
import {
  loadAoiProactiveBriefFieldEvents,
  saveAoiInterestProfile,
} from '../aoiProactiveBriefStore';
import type {
  AoiProactiveBriefScoutResult,
  RunAoiProactiveBriefScoutInput,
} from '../aoiProactiveBriefScout';
import { loadAoiProactiveTrendSnapshots } from '../aoiProactiveTrendAdvisor';
import type {
  AoiGoal,
  AoiAutonomyTickResult,
  AoiEnvironmentSourceRegistry,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiMissionState,
  AoiProposal,
  AoiProposalDecision,
  AoiProactiveBriefCandidate,
  AoiWorkspaceSnapshot,
} from '../aoiAutonomyTypes';
import type { LLMConfig } from '../llmModels';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-engine-test-'));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function enablePolicy(root: string, level: 'L3' | 'L4' = 'L4'): void {
  saveAoiAutonomyPolicy(
    root,
    SESSION_PATH,
    {
      enabled: true,
      previewMode: true,
      level,
      confidenceFloor: 0.55,
      maxActiveProposals: 8,
      maxProposalsPerTick: 4,
    },
    NOW,
  );
}

function makeManifest(partial: Partial<AoiResearchManifest> = {}): AoiResearchManifest {
  const id = partial.id ?? 'aoi-research-done-001';
  return {
    version: 1,
    id,
    sessionPath: SESSION_PATH,
    request: 'Windows kernel driver security research',
    mode: 'standard',
    language: 'ko',
    recency: 'month',
    maxSources: 12,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    completedAt: NOW - 5_000,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'completed',
    sourceCounts: {
      planned: 10,
      candidates: 10,
      accepted: 6,
      failed: 0,
    },
    artifactPaths: buildAoiResearchArtifactPaths(id),
    artifactAvailability: {
      manifest: true,
      report: true,
      sources: false,
      evidence: false,
    },
    reportTitle: 'Windows kernel driver security research',
    claimCount: 4,
    ...partial,
  };
}

function writeResearchManifest(root: string, manifest: AoiResearchManifest): void {
  writeJson(
    join(root, SESSION_PATH, 'aoi-research', 'runs', manifest.id, 'manifest.json'),
    manifest,
  );
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: 'memory-stale-001',
    scope: 'agent',
    type: 'fact',
    status: 'active',
    content:
      'Windows kernel driver security research was completed with useful current-info findings.',
    normalizedContent:
      'windows kernel driver security research was completed with useful current-info findings.',
    importance: 0.8,
    confidence: 0.82,
    hits: 0,
    createdAt: NOW - 60 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 45 * 24 * 60 * 60 * 1000,
    permanent: true,
    sourceEpisodeIds: ['episode-research-001'],
    sessionPath: SESSION_PATH,
    tags: ['research', 'aoi-research', 'windows', 'kernel', 'security'],
    entities: [],
    ...partial,
  };
}

function writeMemory(root: string, memory: AoiMemoryEntry): void {
  writeJson(join(root, 'aoi', 'memory-v2', 'memories', `${memory.id}.json`), memory);
}

function makeInterestTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-reverse-engineering',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'malware reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.88,
    importance: partial.importance ?? 0.86,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.94,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW - 10_000,
    updatedAt: partial.updatedAt ?? NOW - 5_000,
  };
}

function saveInterestProfile(
  root: string,
  topic: AoiInterestTopic = makeInterestTopic(),
): AoiInterestProfile {
  return saveAoiInterestProfile(
    root,
    SESSION_PATH,
    {
      version: 1,
      sessionPath: SESSION_PATH,
      topics: [topic],
      generatedAt: NOW,
      sourceMemoryCount: 1,
      warnings: [],
    },
    NOW,
  );
}

function makeProactiveBriefCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-scheduler-trend',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    topicId: partial.topicId ?? 'aoi-interest-reverse-engineering',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Scheduler persisted reversing trend',
    hook: partial.hook ?? 'A current-info scout found a reversing trend.',
    summary: partial.summary ?? 'Two public sources discuss the same reversing angle.',
    whyForOperator:
      partial.whyForOperator ?? 'This matches the saved reverse engineering interest.',
    noveltyReason: partial.noveltyReason ?? 'Two public sources agree on a new technical angle.',
    sources: partial.sources ?? [
      {
        title: 'Reversing trend source',
        url: 'https://research.example.com/re/scheduler-trend',
        host: 'research.example.com',
        publishedAt: '2027-01-14T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Public source snippet.',
      },
      {
        title: 'Second reversing source',
        url: 'https://security.example.net/re/scheduler-trend',
        host: 'security.example.net',
        publishedAt: '2027-01-13T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Second public source snippet.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? [
      'source:research.example.com',
      'source:security.example.net',
    ],
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    score: partial.score ?? 0.86,
    confidence: partial.confidence ?? 0.86,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: NOW,
      newestSourceAt: '2027-01-14T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    expiresAt: partial.expiresAt ?? NOW + 14 * 24 * 60 * 60 * 1000,
  };
}

function makeScoutResult(
  partial: Partial<AoiProactiveBriefScoutResult> = {},
): AoiProactiveBriefScoutResult {
  return {
    ok: partial.ok ?? true,
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    mode: 'quick',
    createdCandidates: partial.createdCandidates ?? [],
    skippedTopics: partial.skippedTopics ?? [],
    warnings: partial.warnings ?? [],
    sourceFreshness: partial.sourceFreshness ?? [],
    sourceHonestyRecords: partial.sourceHonestyRecords ?? [],
    fieldEvents: partial.fieldEvents ?? [],
    cannotKnow: partial.cannotKnow ?? [],
    currentClaimAllowed: partial.currentClaimAllowed ?? true,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-existing-001',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: 'Open matching research',
    body: 'The completed research can answer the current topic.',
    reason: 'The latest message overlaps with a completed research run.',
    trigger: 'research_followup',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    cooldownKey: 'research-followup:aoi-research-done-001',
    confidence: 0.82,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['research:aoi-research-done-001/report'],
    memoryIds: [],
    artifactRefs: ['research:aoi-research-done-001/report'],
    riskSignals: [],
    ...partial,
  };
}

function makeSchedulerTickResult(
  root: string,
  partial: Partial<AoiAutonomyTickResult> = {},
): AoiAutonomyTickResult {
  const now = typeof partial.status?.updatedAt === 'number' ? partial.status.updatedAt : NOW;
  return {
    ok: true,
    sessionPath: SESSION_PATH,
    reason: 'app',
    status: buildAoiAutonomyStatus(root, SESSION_PATH, now),
    tickState: loadAoiAutonomyTickState(root, SESSION_PATH, now),
    skipped: false,
    newObservationCount: 0,
    newReflectionCount: 0,
    newActiveProposalCount: 0,
    blockedProposalCount: 0,
    blockedProposals: [],
    warnings: [],
    ...partial,
  };
}

function makeSchedulerWorkspaceSnapshot(sourceIds: string[]): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: NOW,
    workspaceLabel: 'YourOpenRoom',
    sourceIds,
    validation: {
      version: 1,
      result: 'unknown',
      touchedFileScopes: [],
      freshness: 'unknown',
      evidenceRefs: [],
    },
    freshness: 'unknown',
    evidenceRefs: sourceIds.map((sourceId) => `workspace:${sourceId}`),
    warnings: [],
  };
}

function withContextSourcePatch(
  registry: AoiEnvironmentSourceRegistry,
  sourceId: string,
  patch: Partial<AoiEnvironmentSourceRegistry['sources'][number]>,
): AoiEnvironmentSourceRegistry {
  return {
    ...registry,
    sources: registry.sources.map((source) =>
      source.id === sourceId
        ? {
            ...source,
            ...patch,
          }
        : source,
    ),
  };
}

function makeDecision(partial: Partial<AoiProposalDecision> = {}): AoiProposalDecision {
  return {
    version: 1,
    id: 'decision-test-001',
    proposalId: 'proposal-old-001',
    sessionPath: SESSION_PATH,
    cooldownKey: 'research-followup:aoi-research-done-001',
    action: 'dismiss',
    actor: 'user',
    createdAt: NOW - 1_000,
    previousStatus: 'active',
    nextStatus: 'dismissed',
    ...partial,
  };
}

function makeGoal(partial: Partial<AoiGoal> = {}): AoiGoal {
  return {
    version: 1,
    id: 'aoi-goal-attention-001',
    sessionPath: SESSION_PATH,
    title: 'Track background Aoi attention',
    userIntentSummary: 'Keep relevant Aoi background events visible without noisy interruption.',
    sourceRefs: ['research:aoi-research-done-001'],
    status: 'active',
    createdAt: NOW - 120_000,
    updatedAt: NOW - 120_000,
    lastCheckedAt: NOW - 120_000,
    confidence: 0.84,
    risk: 'low',
    owner: 'aoi',
    plan: {
      version: 1,
      id: 'aoi-plan-attention-001',
      goalId: 'aoi-goal-attention-001',
      sessionPath: SESSION_PATH,
      createdAt: NOW - 120_000,
      updatedAt: NOW - 120_000,
      sourceRefs: ['research:aoi-research-done-001'],
      steps: [
        {
          version: 1,
          id: 'step-attention-001',
          kind: 'research',
          title: 'Inspect completed research signal',
          status: 'in_progress',
          expectedEvidence: ['research:aoi-research-done-001/report'],
          allowedActionKind: 'read_research_artifact',
          requiredAutonomyLevel: 'L3',
          doneCriteria: ['Research report has been reviewed.'],
          evidenceRefs: ['research:aoi-research-done-001'],
          risk: 'low',
        },
      ],
    },
    ...partial,
  };
}

function makeMission(partial: Partial<AoiMissionState> = {}): AoiMissionState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    status: 'waiting_on_research',
    activeGoalId: 'aoi-goal-attention-001',
    focusSummary: 'Track background Aoi attention',
    waitingOn: 'research',
    lastMeaningfulEventRef: 'research:aoi-research-done-001',
    nextRecommendedAction: {
      kind: 'inspect_research',
      label: 'Inspect research run status.',
      reason: 'A research run is linked to the mission.',
      ref: 'research:aoi-research-done-001',
    },
    evidenceRefs: ['goal:aoi-goal-attention-001', 'research:aoi-research-done-001'],
    sourceRefs: {
      goalRef: 'goal:aoi-goal-attention-001',
      researchRunRef: 'research:aoi-research-done-001',
    },
    transitions: [],
    createdAt: NOW - 120_000,
    updatedAt: NOW - 120_000,
    ...partial,
  };
}

function makeKiraOutcomeGoal(partial: Partial<AoiGoal> = {}): AoiGoal {
  return makeGoal({
    id: 'aoi-goal-kira-outcome-001',
    title: 'Learn from reviewed Kira work',
    userIntentSummary:
      'Delegate one implementation step to Kira and learn from the reviewed result.',
    sourceRefs: ['proposal:proposal-kira-origin-001'],
    plan: {
      version: 1,
      id: 'aoi-plan-kira-outcome-001',
      goalId: 'aoi-goal-kira-outcome-001',
      sessionPath: SESSION_PATH,
      createdAt: NOW - 120_000,
      updatedAt: NOW - 120_000,
      sourceRefs: ['proposal:proposal-kira-origin-001'],
      steps: [
        {
          version: 1,
          id: 'step-context-kira-outcome-001',
          kind: 'read',
          title: 'Confirm implementation context',
          status: 'done',
          expectedEvidence: ['observation:context-ready'],
          allowedActionKind: 'none',
          requiredAutonomyLevel: 'L2',
          doneCriteria: ['Context was reviewed.'],
          evidenceRefs: ['observation:context-ready'],
          risk: 'low',
        },
        {
          version: 1,
          id: 'step-kira-outcome-001',
          kind: 'handoff_kira',
          title: 'Delegate reviewed implementation to Kira',
          status: 'in_progress',
          expectedEvidence: ['kira-work:work-kira-outcome-001'],
          allowedActionKind: 'create_kira_work',
          requiredAutonomyLevel: 'L4',
          doneCriteria: ['Kira reviewer approved the validated result.'],
          evidenceRefs: ['proposal:proposal-kira-origin-001'],
          risk: 'medium',
        },
      ],
    },
    ...partial,
  });
}

function makeKiraOriginProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return makeProposal({
    id: 'proposal-kira-origin-001',
    status: 'executed',
    title: 'Create Kira outcome work',
    body: 'Create one supervised Kira implementation work item.',
    reason: 'The user approved a Kira handoff.',
    trigger: 'goal_continuation',
    cooldownKey: 'goal-continuation:kira-outcome',
    risk: 'medium',
    requiredAutonomyLevel: 'L4',
    requiresUserApproval: true,
    suggestedTools: ['create_kira_work'],
    evidenceRefs: ['goal:aoi-goal-kira-outcome-001'],
    artifactRefs: [
      'goal:aoi-goal-kira-outcome-001',
      'goal:aoi-goal-kira-outcome-001/step:step-kira-outcome-001',
    ],
    riskSignals: ['goal-continuation'],
    acceptAction: {
      kind: 'create_kira_work',
      params: {
        projectName: 'YourOpenRoom',
        title: 'Implement Kira outcome learning fixture',
        objective: 'Implement one reviewed fixture.',
        scope: ['Aoi Kira outcome learning'],
      },
    },
    ...partial,
  });
}

function writeKiraOutcomeRecords(
  root: string,
  options: {
    workStatus?: string;
    attemptStatus?: string;
    reviewApproved?: boolean;
    validationFailed?: boolean;
    clarification?: boolean;
    reviewerNotes?: string[];
    integrationStatus?: string;
  } = {},
): void {
  const dataDir = join(root, SESSION_PATH, 'apps', 'kira', 'data');
  const work = {
    id: 'work-kira-outcome-001',
    type: 'work',
    projectName: 'YourOpenRoom',
    title: 'Implement Kira outcome learning fixture',
    description: [
      '# Aoi supervised handoff',
      '',
      '## Aoi audit',
      '- Source proposal: proposal-kira-origin-001',
      '- Requires Kira reviewer approval before integration.',
    ].join('\n'),
    status: options.workStatus ?? 'done',
    assignee: '',
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...(options.clarification
      ? {
          clarification: {
            status: 'pending',
            summary: 'Kira needs one user clarification.',
            questions: [{ question: 'Which follow-up should Kira do first?' }],
          },
        }
      : {}),
  };
  const attempt = {
    id: 'attempt-kira-outcome-001',
    workId: work.id,
    attemptNo: 1,
    status: options.attemptStatus ?? 'approved',
    startedAt: NOW - 9_000,
    finishedAt: NOW - 2_000,
    changedFiles: ['apps/webuiapps/src/lib/aoiKiraOutcomeLearning.ts'],
    patchedFiles: ['apps/webuiapps/src/lib/aoiKiraOutcomeLearning.ts'],
    commandsRun: ['pnpm test -- aoiKiraOutcomeLearning'],
    validationReruns: {
      passed: options.validationFailed ? [] : ['pnpm test -- aoiKiraOutcomeLearning'],
      failed: options.validationFailed ? ['pnpm test -- aoiKiraOutcomeLearning'] : [],
    },
    toolCommandEvents: [
      {
        id: 'cmd-kira-outcome-001',
        command: 'pnpm test -- aoiKiraOutcomeLearning',
        status: options.validationFailed ? 'failed' : 'completed',
        exitCode: options.validationFailed ? 1 : 0,
      },
    ],
    integration: {
      status: options.integrationStatus ?? 'committed',
      message: 'Integrated reviewed fixture.',
      commitHash: 'abcdef1234567890',
    },
  };
  writeJson(join(dataDir, 'works', `${work.id}.json`), work);
  writeJson(join(dataDir, 'attempts', `${work.id}-1.json`), attempt);
  if (typeof options.reviewApproved === 'boolean') {
    writeJson(join(dataDir, 'reviews', `${work.id}-1.json`), {
      id: 'review-kira-outcome-001',
      workId: work.id,
      attemptNo: 1,
      approved: options.reviewApproved,
      createdAt: NOW - 1_000,
      summary: options.reviewApproved
        ? 'Reviewer approved the validated fixture.'
        : 'Reviewer rejected the fixture.',
      findings: options.reviewApproved
        ? []
        : [
            {
              severity: 'medium',
              message: 'Reviewer found a missing edge case.',
              file: 'apps/webuiapps/src/lib/aoiKiraOutcomeLearning.ts',
              line: 42,
            },
          ],
      missingValidation: options.validationFailed ? ['Failed targeted validation.'] : [],
      nextWorkerInstructions: options.reviewerNotes ?? [],
      residualRisk: options.reviewerNotes ?? [],
      filesChecked: ['apps/webuiapps/src/lib/aoiKiraOutcomeLearning.ts'],
      evidenceChecked: [
        {
          file: 'apps/webuiapps/src/lib/aoiKiraOutcomeLearning.ts',
          reason: 'Primary changed file.',
          method: 'review',
        },
      ],
    });
  }
}

const TEST_LLM_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'http://localhost',
  model: 'test-model',
};

function reflectionChat(content: string): AoiAutonomyReflectionChat {
  return (async () => ({
    content,
    toolCalls: [],
  })) as AoiAutonomyReflectionChat;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runAoiAutonomyTick()', () => {
  it('creates a deterministic proposal to open a matching completed research report', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    const reflections = loadAoiReflections(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(result.newReflectionCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'research_followup',
      cooldownKey: 'research-followup:aoi-research-done-001',
      suggestedTools: ['read_research_artifact'],
      requiresUserApproval: false,
    });
    expect(proposals[0].evidenceRefs).toContain('research:aoi-research-done-001/report');
    expect(proposals[0].acceptAction).toMatchObject({
      kind: 'read_research_artifact',
      params: {
        runId: 'aoi-research-done-001',
        artifact: 'report',
      },
    });
    expect(reflections[0]).toMatchObject({
      kind: 'opportunity',
      claim: expect.stringContaining('Open the matching Aoi research report'),
      evidenceRefs: expect.arrayContaining(['research:aoi-research-done-001/report']),
      proposedActions: expect.arrayContaining(['read_research_artifact']),
    });
  });

  it('creates a bounded recovery proposal for failed or timed-out research', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(
      root,
      makeManifest({
        id: 'aoi-research-fail-001',
        status: 'failed',
        phase: 'failed',
        completedAt: undefined,
        artifactAvailability: {
          manifest: true,
          report: false,
          sources: false,
          evidence: false,
        },
        error: {
          code: 'research_run_timeout',
          message: 'Timed out while reading sources.',
          phase: 'reading_sources',
          createdAt: NOW - 4_000,
        },
      }),
    );

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'failure_recovery',
      risk: 'medium',
      requiredAutonomyLevel: 'L4',
      requiresUserApproval: true,
      suggestedTools: ['start_research'],
    });
    expect(proposals[0].recoveryPreview).toMatchObject({
      failureKind: 'research_failed',
      sourceRef: 'research:aoi-research-fail-001',
      retryCount: 0,
      maxRetryCount: 1,
      cooldownActive: false,
    });
    expect(proposals[0].recoveryPreview?.nonGoals).toEqual(
      expect.arrayContaining(['Do not execute file writes, patches, deletes, or shell commands.']),
    );
    expect(proposals[0].riskSignals).toEqual(
      expect.arrayContaining(['failure-recovery', 'research_failed']),
    );
  });

  it('suppresses repeated recovery proposals for the same failure source', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(
      root,
      makeManifest({
        id: 'aoi-research-fail-guard-001',
        status: 'failed',
        phase: 'failed',
        completedAt: undefined,
        artifactAvailability: {
          manifest: true,
          report: false,
          sources: false,
          evidence: false,
        },
        error: {
          code: 'research_run_timeout',
          message: 'Timed out while reading sources.',
          phase: 'reading_sources',
          createdAt: NOW - 4_000,
        },
      }),
    );

    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      now: NOW,
    });
    const second = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      now: NOW + 1_000,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH).filter(
      (proposal) => proposal.trigger === 'failure_recovery',
    );
    expect(proposals).toHaveLength(1);
    expect(second.newActiveProposalCount).toBe(0);
    expect(second.warnings).not.toContain('proposal_rejected_evidence');
  });

  it('proposes fresh research when current-info asks match stale permanent research memory', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(root, makeMemory());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'turn',
      latestUserMessage: '최신 Windows kernel driver security 동향 조사해줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'stale_research_memory',
      cooldownKey: 'research-refresh:memory-stale-001',
      suggestedTools: ['start_research'],
      requiresUserApproval: true,
    });
    expect(proposals[0].evidenceRefs).toEqual(['memory:memory-stale-001']);
  });

  it('proposes approval-gated procedure promotion for repeated successful research memories', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(
      root,
      makeMemory({
        id: 'memory-research-success-001',
        tags: ['permanent', 'research', 'aoi-research', 'completed', 'windows'],
        updatedAt: NOW - 10_000,
      }),
    );
    writeMemory(
      root,
      makeMemory({
        id: 'memory-research-success-002',
        content: 'Aoi completed research "Windows kernel exploit mitigation trends".',
        normalizedContent: 'aoi completed research "windows kernel exploit mitigation trends".',
        tags: ['permanent', 'research', 'aoi-research', 'completed', 'kernel'],
        updatedAt: NOW - 8_000,
      }),
    );

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: '이 반복 research workflow를 절차로 저장해줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    const procedure = proposals.find(
      (proposal) => proposal.cooldownKey === 'procedure:repeated-research-workflow',
    );
    expect(result.newActiveProposalCount).toBeGreaterThanOrEqual(1);
    expect(procedure).toMatchObject({
      trigger: 'procedure_candidate',
      requiresUserApproval: true,
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['save_memory'],
    });
    expect(procedure?.evidenceRefs).toEqual(
      expect.arrayContaining([
        'memory:memory-research-success-001',
        'memory:memory-research-success-002',
      ]),
    );
    expect(procedure?.acceptAction).toMatchObject({
      kind: 'save_memory',
      params: {
        type: 'procedure',
      },
    });
  });

  it('proposes approval-gated procedure promotion for repeated reviewed Kira outcomes', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-success-001',
        scope: 'project',
        type: 'action',
        content: 'Kira completed reviewed project work "Add autonomy controls".',
        normalizedContent: 'kira completed reviewed project work "add autonomy controls".',
        permanent: undefined,
        tags: ['kira', 'automation', 'completed', 'reviewed'],
        updatedAt: NOW - 10_000,
      }),
    );
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-success-002',
        scope: 'project',
        type: 'action',
        content: 'Kira completed reviewed project work "Fix validation evidence".',
        normalizedContent: 'kira completed reviewed project work "fix validation evidence".',
        permanent: undefined,
        tags: ['kira', 'automation', 'completed', 'reviewed'],
        updatedAt: NOW - 8_000,
      }),
    );

    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Kira 반복 review workflow를 절차로 저장해줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    const procedure = proposals.find(
      (proposal) => proposal.cooldownKey === 'procedure:repeated-kira-review-workflow',
    );
    expect(procedure).toMatchObject({
      trigger: 'procedure_candidate',
      requiresUserApproval: true,
      suggestedTools: ['save_memory'],
    });
    expect(procedure?.evidenceRefs).toEqual(
      expect.arrayContaining(['memory:memory-kira-success-001', 'memory:memory-kira-success-002']),
    );
  });

  it('suppresses duplicate proposals that share an active cooldown key', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());
    saveAoiActiveProposals(root, SESSION_PATH, [makeProposal()]);

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.blockedProposalCount).toBe(1);
    expect(result.blockedProposals[0].reasons).toContain('duplicate_active_proposal');
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toHaveLength(1);
  });

  it('honors a recent dismissed cooldown decision', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());
    appendAoiProposalDecision(root, makeDecision());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.blockedProposalCount).toBe(1);
    expect(result.blockedProposals[0].reasons).toContain('cooldown_active');
  });

  it('keeps deterministic proposals when optional LLM reflection returns malformed JSON', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      llmConfig: TEST_LLM_CONFIG,
      reflectionChat: reflectionChat('not json'),
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(1);
    expect(result.warnings).toContain('reflection_json_missing');
    expect(loadAoiActiveProposals(root, SESSION_PATH)[0].trigger).toBe('research_followup');
  });

  it('rejects LLM proposals that cite hallucinated evidence refs', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    const llmJson = JSON.stringify({
      reflections: [],
      proposals: [
        {
          title: 'Open missing memory',
          body: 'This cites memory that was not supplied.',
          reason: 'The evidence ref is not in the observation set.',
          cooldownKey: 'llm:missing-memory',
          confidence: 0.9,
          risk: 'low',
          requiredAutonomyLevel: 'L2',
          requiresUserApproval: false,
          suggestedTools: ['read_research_artifact'],
          evidenceRefs: ['memory:ghost'],
        },
      ],
    });

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: '검토해줘',
      llmConfig: TEST_LLM_CONFIG,
      reflectionChat: reflectionChat(llmJson),
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.warnings).toContain('proposal_rejected_no_known_evidence');
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toEqual([]);
  });

  it('blocks high-risk LLM proposals that exceed the configured policy level', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    const llmJson = JSON.stringify({
      reflections: [],
      proposals: [
        {
          title: 'Run workspace command',
          body: 'Inspect the local workspace through a command.',
          reason: 'The user asked for inspection.',
          cooldownKey: 'llm:run-command',
          confidence: 0.9,
          risk: 'high',
          requiredAutonomyLevel: 'L5',
          requiresUserApproval: true,
          suggestedTools: ['run_command'],
          evidenceRefs: ['observation:latest-user-message'],
        },
      ],
    });

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'workspace 상태 확인해줘',
      llmConfig: TEST_LLM_CONFIG,
      reflectionChat: reflectionChat(llmJson),
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.blockedProposalCount).toBe(1);
    expect(result.blockedProposals[0].reasons).toEqual(
      expect.arrayContaining(['autonomy_level_too_low', 'tool_blocked:run_command']),
    );
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toEqual([]);
  });

  it('keeps high-risk proposals approval-gated despite positive trust calibration', () => {
    const proposal = makeProposal({
      id: 'proposal-high-risk-positive-calibration',
      trigger: 'research_followup',
      risk: 'high',
      requiredAutonomyLevel: 'L5',
      requiresUserApproval: false,
      suggestedTools: ['read_research_artifact'],
      evidenceRefs: ['research:aoi-research-done-001/report'],
      acceptAction: {
        kind: 'read_research_artifact',
        params: {
          runId: 'aoi-research-done-001',
          artifact: 'report',
        },
      },
    });
    const trustCalibrationProfile = buildAoiTrustCalibrationProfile({
      sessionPath: SESSION_PATH,
      proposals: [proposal],
      decisions: Array.from({ length: 8 }, (_, index) =>
        makeDecision({
          id: `decision-positive-high-risk-${index}`,
          proposalId: proposal.id,
          cooldownKey: proposal.cooldownKey,
          action: 'accept',
          nextStatus: 'accepted',
          feedbackCategory: 'useful',
          proposalTrigger: proposal.trigger,
          proposalRisk: proposal.risk,
          actionKind: proposal.acceptAction?.kind,
          suggestedTools: proposal.suggestedTools,
          evidenceRefs: proposal.evidenceRefs,
          createdAt: NOW - 10_000 + index,
        }),
      ),
      now: NOW,
    });
    const policyResult = checkAoiProposalPolicy({
      policy: {
        ...DEFAULT_AOI_AUTONOMY_POLICY,
        enabled: true,
        previewMode: true,
        level: 'L5',
        requireApprovalForHighRisk: true,
      },
      proposal,
      trustCalibrationProfile,
      now: NOW,
    });

    expect(policyResult.allowed).toBe(false);
    expect(policyResult.reasons).toContain('high_risk_requires_approval');
    expect(
      trustCalibrationProfile.triggerCalibrations.find(
        (item) => item.triggerKind === 'research_followup',
      )?.usefulnessScore,
    ).toBeLessThanOrEqual(trustCalibrationProfile.interruptionPolicy.positiveLearningCap);
  });
});

describe('runAoiAutonomyBackgroundTick()', () => {
  it('learns from reviewed Kira completion by updating goal progress, memory, relations, and follow-up', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    saveAoiActiveGoals(root, SESSION_PATH, [makeKiraOutcomeGoal()]);
    saveAoiActiveProposals(root, SESSION_PATH, [makeKiraOriginProposal()]);
    writeKiraOutcomeRecords(root, {
      reviewApproved: true,
      reviewerNotes: ['Check whether the next UI badge copy should be tightened.'],
    });

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'kira',
      now: NOW,
    });

    const goal = loadAoiActiveGoals(root, SESSION_PATH)[0];
    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    const memories = loadServerAoiMemories(root);
    const relations = loadAoiRelationIndex(root, SESSION_PATH);
    const ledger = loadServerAoiRunLedger(root, SESSION_PATH);

    expect(result.ok).toBe(true);
    expect(goal.status).toBe('active');
    expect(goal.plan.steps.find((step) => step.id === 'step-kira-outcome-001')?.status).toBe(
      'done',
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      scope: 'project',
      type: 'action',
      projectKey: 'youropenroom',
    });
    expect(memories[0].tags).toEqual(
      expect.arrayContaining(['kira-outcome', 'reviewed', 'review-approved', 'validation-passed']),
    );
    expect(proposals.some((proposal) => proposal.trigger === 'kira_outcome_followup')).toBe(true);
    expect(relations.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'kira_work', ref: 'kira-work:work-kira-outcome-001' }),
        expect.objectContaining({
          kind: 'kira_attempt',
          ref: 'kira-attempt:attempt-kira-outcome-001',
        }),
        expect.objectContaining({
          kind: 'kira_review',
          ref: 'kira-review:review-kira-outcome-001',
        }),
        expect.objectContaining({ kind: 'proposal', ref: 'proposal:proposal-kira-origin-001' }),
        expect.objectContaining({ kind: 'goal', ref: 'goal:aoi-goal-kira-outcome-001' }),
      ]),
    );
    expect(
      ledger.some((entry) =>
        entry.events.some((event) => event.type === 'kira_goal_progress_updated'),
      ),
    ).toBe(true);
  });

  it('does not duplicate Kira outcome memory or proposals when the same outcome is replayed', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    saveAoiActiveGoals(root, SESSION_PATH, [makeKiraOutcomeGoal()]);
    saveAoiActiveProposals(root, SESSION_PATH, [makeKiraOriginProposal()]);
    writeKiraOutcomeRecords(root, {
      reviewApproved: true,
      reviewerNotes: ['Check whether the next UI badge copy should be tightened.'],
    });

    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'kira',
      now: NOW,
    });
    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'kira',
      now: NOW + 1_000,
    });

    const memories = loadServerAoiMemories(root);
    const proposals = loadAoiActiveProposals(root, SESSION_PATH).filter(
      (proposal) => proposal.trigger === 'kira_outcome_followup',
    );
    const ledger = loadServerAoiRunLedger(root, SESSION_PATH);

    expect(memories).toHaveLength(1);
    expect(proposals).toHaveLength(1);
    expect(
      ledger.some((entry) =>
        entry.events.some((event) => event.type === 'kira_outcome_duplicate_ignored'),
      ),
    ).toBe(true);
  });

  it('routes Kira validation failure to recovery without completing the goal or memory', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    saveAoiActiveGoals(root, SESSION_PATH, [makeKiraOutcomeGoal()]);
    saveAoiActiveProposals(root, SESSION_PATH, [makeKiraOriginProposal()]);
    writeKiraOutcomeRecords(root, {
      workStatus: 'blocked',
      attemptStatus: 'validation_failed',
      validationFailed: true,
    });

    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'kira',
      now: NOW,
    });

    const goal = loadAoiActiveGoals(root, SESSION_PATH)[0];
    const proposals = loadAoiActiveProposals(root, SESSION_PATH);

    expect(goal.status).toBe('blocked');
    expect(goal.plan.steps.find((step) => step.id === 'step-kira-outcome-001')?.status).toBe(
      'blocked',
    );
    expect(loadServerAoiMemories(root)).toEqual([]);
    expect(proposals.some((proposal) => proposal.trigger === 'failure_recovery')).toBe(true);
  });

  it('brokers background research completion into one deduplicated attention proposal', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const first = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      now: NOW,
    });
    const second = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      now: NOW + 1_000,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH).filter(
      (proposal) => proposal.trigger === 'attention_broker',
    );
    const observations = loadAoiObservations(root, SESSION_PATH);
    const relationIndex = loadAoiRelationIndex(root, SESSION_PATH);
    const ledger = loadServerAoiRunLedger(root, SESSION_PATH);

    expect(first.newActiveProposalCount).toBe(1);
    expect(second.newActiveProposalCount).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      title: 'Review completed Aoi research',
      cooldownKey: 'attention:research_completed:research:aoi-research-done-001',
      suggestedTools: ['read_research_artifact'],
    });
    expect(
      observations.some((observation) => observation.dedupeKey.includes('research_completed')),
    ).toBe(true);
    expect(relationIndex.nodes.some((node) => node.kind === 'event')).toBe(true);
    expect(
      ledger.some((entry) =>
        entry.events.some((event) => event.type === 'attention_broker_decision'),
      ),
    ).toBe(true);
  });

  it('routes completed research as top context for research continuation', () => {
    const root = makeTempRoot();
    writeResearchManifest(root, makeManifest());
    saveAoiMissionState(root, SESSION_PATH, makeMission());

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'Windows kernel driver security research 보고서 이어서 요약해줘',
      now: NOW,
    });

    expect(result.selectedSources[0]).toMatchObject({
      sourceId: 'research-runs',
      kind: 'research_runs',
    });
    expect(result.selectedSources[0].evidenceRefs).toContain(
      'research:aoi-research-done-001/report',
    );
    expect(result.promptBlock).toContain('Aoi Context Router');
    expect(result.promptBlock).not.toContain('Aoi Mission Context');
  });

  it('suppresses user-facing attention in quiet mode while keeping observations and ledger', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      quietMode: true,
      now: NOW,
    });

    const observations = loadAoiObservations(root, SESSION_PATH);
    const ledger = loadServerAoiRunLedger(root, SESSION_PATH);

    expect(result.newActiveProposalCount).toBe(0);
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toEqual([]);
    expect(
      observations.some((observation) => observation.dedupeKey.includes('research_completed')),
    ).toBe(true);
    expect(
      ledger.some((entry) =>
        entry.events.some((event) => event.type === 'notification_suppressed'),
      ),
    ).toBe(true);
  });

  it('creates one proposal for reviewed Kira completion without creating mutation actions', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-reviewed-attention-001',
        scope: 'project',
        type: 'action',
        content: 'Kira completed reviewed work "Clarify autonomy approval states".',
        normalizedContent: 'kira completed reviewed work clarify autonomy approval states',
        permanent: undefined,
        tags: ['kira', 'automation', 'completed', 'reviewed'],
        updatedAt: NOW - 2_000,
      }),
    );

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'kira',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'attention_broker',
      title: 'Review completed Kira work',
      suggestedTools: [],
      acceptAction: {
        kind: 'open_app',
        params: {
          appName: 'kira',
        },
      },
    });
  });

  it('routes reviewed Kira work as top context for implementation follow-up', () => {
    const root = makeTempRoot();
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-reviewed-context-001',
        scope: 'project',
        type: 'action',
        content: 'Kira completed reviewed work "Clarify autonomy approval states".',
        normalizedContent: 'kira completed reviewed work clarify autonomy approval states',
        permanent: undefined,
        tags: ['kira', 'automation', 'completed', 'reviewed'],
        updatedAt: NOW - 2_000,
        confidence: 0.82,
      }),
    );

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'Kira reviewed work 구현 결과 이어서 확인하자',
      now: NOW,
    });

    expect(result.selectedSources[0]).toMatchObject({
      sourceId: 'kira-board',
      displayName: 'Kira',
    });
    expect(result.selectedSources[0].evidenceRefs).toContain(
      'memory:memory-kira-reviewed-context-001',
    );
  });

  it('uses the query embedding to surface a semantically-matching Kira memory as top context', () => {
    const root = makeTempRoot();
    // Two reviewed Kira memories that share no tokens with the query. Beta is
    // newer, so with lexical-only ranking it wins the score tie-break. The query
    // embedding matches Alpha's vector, which must flip Alpha to the top.
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-embed-alpha',
        scope: 'project',
        type: 'action',
        content: 'Alpha deployment pipeline handoff awaiting follow-up.',
        normalizedContent: 'alpha deployment pipeline handoff awaiting follow-up',
        permanent: undefined,
        tags: ['kira', 'reviewed'],
        updatedAt: NOW - 3_000,
        confidence: 0.8,
        embedding: [1, 0, 0],
      }),
    );
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-embed-beta',
        scope: 'project',
        type: 'action',
        content: 'Beta cooking recipe notes for the weekend.',
        normalizedContent: 'beta cooking recipe notes for the weekend',
        permanent: undefined,
        tags: ['kira', 'reviewed'],
        updatedAt: NOW - 2_000,
        confidence: 0.8,
        embedding: [0, 1, 0],
      }),
    );

    // "구현" triggers the Kira intent for both equally; the query shares no tokens
    // with either memory, isolating the semantic signal to the overlap term.
    const semantic = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: '구현 이어서 진행하자',
      mission: null,
      queryEmbedding: [1, 0, 0],
      now: NOW,
    });
    expect(semantic.selectedSources[0].evidenceRefs).toContain('memory:memory-kira-embed-alpha');

    // Without the query embedding, lexical overlap is zero for both, so the newer
    // memory (Beta) wins the tie-break and Alpha is no longer on top.
    const lexicalOnly = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: '구현 이어서 진행하자',
      mission: null,
      now: NOW,
    });
    expect(lexicalOnly.selectedSources[0].evidenceRefs).toContain('memory:memory-kira-embed-beta');
  });

  it('routes consented personal metadata only when relevant and omits private bodies', () => {
    const root = makeTempRoot();
    const configFile = join(root, 'config.json');
    writeJson(join(root, SESSION_PATH, 'apps', 'calendar', 'data', 'events', 'event-1.json'), {
      id: 'event-1',
      title: 'Kernel review sync',
      notes: 'calendar private notes must not leak',
      description: 'calendar long description must not leak',
      startAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
      remindBeforeMinutes: 15,
      completed: false,
      updatedAt: NOW - 1000,
    });
    writeJson(join(root, SESSION_PATH, 'apps', 'email', 'data', 'emails', 'mail-1.json'), {
      id: 'mail-1',
      folder: 'inbox',
      isRead: false,
      labelIds: ['INBOX', 'UNREAD', 'SECURITY'],
      subject: 'Gmail subject must not enter Aoi metadata summary',
      snippet: 'gmail snippet must not leak',
      content: 'gmail body must not leak',
      timestamp: NOW - 2000,
    });
    writeJson(join(root, SESSION_PATH, 'apps', 'notes', 'data', 'notes', 'note-1.json'), {
      id: 'note-1',
      title: 'Driver hardening plan',
      content: 'notes full body must not leak',
      tags: ['kernel', 'anti-cheat'],
      pinned: true,
      updatedAt: NOW - 3000,
    });
    writeJson(configFile, {
      gmail: {
        clientId: 'test-client',
        refreshToken: 'test-refresh',
        lastSyncAt: NOW - 2000,
      },
    });
    for (const sourceId of ['calendar-metadata', 'gmail-metadata', 'notes-metadata']) {
      updateAoiEnvironmentSource(root, SESSION_PATH, {
        sourceId,
        patch: {
          enabled: true,
          consentReason: `User enabled ${sourceId} metadata for this mission.`,
          lastReviewedAt: NOW - 5000,
        },
        now: NOW - 4000,
      });
    }

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile,
      latestUserMessage: '오늘 calendar 일정, Gmail unread, notes tag 상태를 요약해줘',
      now: NOW,
    });
    const calendar = result.candidateSources.find(
      (source) => source.sourceId === 'calendar-metadata',
    );
    const gmail = result.candidateSources.find((source) => source.sourceId === 'gmail-metadata');
    const notes = result.candidateSources.find((source) => source.sourceId === 'notes-metadata');
    const resultJson = JSON.stringify(result);

    expect(calendar?.summary).toContain('Kernel review sync');
    expect(calendar?.summary).toContain('reminder 15m');
    expect(resultJson).not.toContain('calendar private notes must not leak');
    expect(resultJson).not.toContain('calendar long description must not leak');
    expect(gmail?.summary).toContain('unread=1');
    expect(gmail?.summary).toContain('labels=INBOX:1');
    expect(resultJson).not.toContain('Gmail subject must not enter');
    expect(resultJson).not.toContain('gmail snippet must not leak');
    expect(resultJson).not.toContain('gmail body must not leak');
    expect(notes?.summary).toContain('Driver hardening plan');
    expect(notes?.summary).toContain('kernel');
    expect(resultJson).not.toContain('notes full body must not leak');
    expect(notes?.redactionState).toBe('redacted');
  });

  it('downranks stale context sources and attaches cannot-know statements', () => {
    const root = makeTempRoot();
    const registry = withContextSourcePatch(
      getDefaultAoiEnvironmentSourceRegistry(SESSION_PATH, NOW),
      'browser-context',
      {
        enabled: true,
        lastReviewedAt: NOW - 5_000,
        consentReason: 'Use explicit browser metadata only for this test.',
      },
    );
    const fresh = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      registry,
      latestUserMessage: 'browser page url 링크 상태를 확인해줘',
      browserContexts: [
        {
          version: 1,
          id: 'browser-fresh-context',
          sessionPath: SESSION_PATH,
          pageTitle: 'OpenRoom status page',
          urlHost: 'example.com',
          redactedUrl: 'https://example.com/status',
          purpose: 'Explicit browser metadata for status review.',
          capturedAt: NOW - 1000,
          evidenceRefs: ['browser:fresh-context'],
          redactionState: 'redacted',
        },
      ],
      now: NOW,
    });
    const stale = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      registry,
      latestUserMessage: 'browser page url 링크 상태를 확인해줘',
      browserContexts: [
        {
          version: 1,
          id: 'browser-stale-context',
          sessionPath: SESSION_PATH,
          pageTitle: 'OpenRoom status page',
          urlHost: 'example.com',
          redactedUrl: 'https://example.com/status',
          purpose: 'Explicit browser metadata for status review.',
          capturedAt: NOW - 40 * 24 * 60 * 60 * 1000,
          evidenceRefs: ['browser:stale-context'],
          redactionState: 'redacted',
        },
      ],
      now: NOW,
    });
    const freshBrowser = fresh.candidateSources.find(
      (source) => source.sourceId === 'browser-context',
    );
    const staleBrowser = stale.candidateSources.find(
      (source) => source.sourceId === 'browser-context',
    );

    expect(freshBrowser).toBeDefined();
    expect(staleBrowser).toBeDefined();
    expect(staleBrowser?.freshness).toBe('stale');
    expect(staleBrowser?.relevanceScore).toBeLessThan(freshBrowser?.relevanceScore ?? 0);
    expect(staleBrowser?.cannotKnowStatements?.join(' ')).toContain('page body');
    expect(stale.promptBlock).toContain('cannotKnow');
  });

  it('reduces workspace validation confidence when the source freshness contract is stale', () => {
    const root = makeTempRoot();
    let registry = getDefaultAoiEnvironmentSourceRegistry(SESSION_PATH, NOW);
    registry = withContextSourcePatch(registry, 'workspace-build', {
      enabled: true,
      lastObservedAt: NOW - 40 * 24 * 60 * 60 * 1000,
    });
    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      registry,
      latestUserMessage: 'workspace validation test 상태를 확인하자',
      workspaceSnapshot: {
        version: 1,
        sessionPath: SESSION_PATH,
        collectedAt: NOW - 40 * 24 * 60 * 60 * 1000,
        workspaceLabel: 'YourOpenRoom',
        sourceIds: ['workspace-build'],
        validation: {
          version: 1,
          command: 'pnpm --filter @openroom/webuiapps test',
          result: 'passed',
          completedAt: NOW - 40 * 24 * 60 * 60 * 1000,
          touchedFileScopes: ['apps/webuiapps/src/lib'],
          freshness: 'stale',
          staleReason: 'Source files changed after validation.',
          evidenceRefs: ['workspace:validation:stale'],
        },
        freshness: 'stale',
        evidenceRefs: ['workspace:snapshot:stale-validation'],
        warnings: [],
      },
      now: NOW,
    });
    const workspaceBuild = result.candidateSources.find(
      (source) => source.sourceId === 'workspace-build',
    );

    expect(workspaceBuild?.freshness).toBe('stale');
    expect(workspaceBuild?.confidence).toBeLessThan(0.76);
    expect(workspaceBuild?.scoreReasons.join(' ')).toContain('source freshness contract:stale');
  });

  it('ignores disabled personal metadata and applies intrusive feedback penalties', () => {
    const root = makeTempRoot();
    writeJson(join(root, SESSION_PATH, 'apps', 'notes', 'data', 'notes', 'note-1.json'), {
      id: 'note-1',
      title: 'Private roadmap',
      content: 'private body must not leak',
      tags: ['sensitive'],
      pinned: true,
      updatedAt: NOW - 3000,
    });

    const disabled = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'notes 상태를 봐줘',
      now: NOW,
    });
    expect(disabled.candidateSources.some((source) => source.sourceId === 'notes-metadata')).toBe(
      false,
    );

    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'notes-metadata',
      patch: {
        enabled: true,
        consentReason: 'User enabled note metadata for this mission.',
        lastReviewedAt: NOW - 5000,
      },
      now: NOW - 4000,
    });
    const base = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'notes 상태를 봐줘',
      now: NOW,
    });
    const penalized = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'notes 상태를 봐줘',
      contextFeedback: [
        {
          version: 1,
          id: 'ctx-feedback-too-intrusive',
          sessionPath: SESSION_PATH,
          sourceId: 'notes-metadata',
          feedbackCategory: 'too_much',
          evidenceRefs: ['personal-signal:notes_metadata'],
          createdAt: NOW - 1000,
        },
      ],
      now: NOW,
    });
    const wrongSource = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'notes 상태를 봐줘',
      contextFeedback: [
        {
          version: 1,
          id: 'ctx-feedback-wrong-source',
          sessionPath: SESSION_PATH,
          sourceId: 'notes-metadata',
          feedbackCategory: 'wrong_source',
          evidenceRefs: ['personal-signal:notes_metadata'],
          createdAt: NOW - 1000,
        },
      ],
      now: NOW,
    });
    const baseNotes = base.candidateSources.find((source) => source.sourceId === 'notes-metadata');
    const penalizedNotes = penalized.candidateSources.find(
      (source) => source.sourceId === 'notes-metadata',
    );
    const wrongSourceNotes = wrongSource.candidateSources.find(
      (source) => source.sourceId === 'notes-metadata',
    );

    expect(baseNotes).toBeDefined();
    expect(penalizedNotes).toBeDefined();
    expect(penalizedNotes?.relevanceScore).toBeLessThan(baseNotes?.relevanceScore ?? 0);
    expect(penalizedNotes?.scoreReasons.join(' ')).toContain('too_much');
    expect(wrongSourceNotes?.relevanceScore).toBeLessThan(baseNotes?.relevanceScore ?? 0);
    expect(wrongSourceNotes?.scoreReasons.join(' ')).toContain('wrong_source');
  });

  it('updates mission state silently for stale active-goal waiting events', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    const goal = makeGoal();
    saveAoiActiveGoals(root, SESSION_PATH, [goal]);
    saveAoiMissionState(
      root,
      SESSION_PATH,
      makeMission({
        updatedAt: NOW - 60 * 60 * 1000,
      }),
    );

    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'periodic',
      now: NOW,
    });

    const mission = loadAoiMissionState(root, SESSION_PATH);
    const ledger = loadServerAoiRunLedger(root, SESSION_PATH);

    expect(loadAoiActiveGoals(root, SESSION_PATH)[0].id).toBe(goal.id);
    expect(mission?.updatedAt).toBe(NOW);
    expect(
      ledger.some((entry) =>
        entry.events.some(
          (event) =>
            event.type === 'attention_broker_decision' &&
            event.message?.includes('update_mission_state'),
        ),
      ),
    ).toBe(true);
  });

  it('runs a bounded event-triggered tick and persists tick state', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const result = await runAoiAutonomyBackgroundTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      minIntervalMs: 60_000,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.newActiveProposalCount).toBe(1);
    expect(result.tickState).toMatchObject({
      activeTick: false,
      lastTickAt: NOW,
      nextAllowedTickAt: NOW + 60_000,
      proposalsCreatedInLastTick: 1,
    });
    expect(loadAoiAutonomyTickState(root, SESSION_PATH, NOW)).toMatchObject({
      activeTick: false,
      lastTickReason: 'research_run',
    });
    expect(loadAoiObservations(root, SESSION_PATH).length).toBeGreaterThan(0);
  });

  it('skips ticks during the per-session cooldown window', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    await runAoiAutonomyBackgroundTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      minIntervalMs: 60_000,
      now: NOW,
    });
    const skipped = await runAoiAutonomyBackgroundTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      minIntervalMs: 60_000,
      now: NOW + 1_000,
    });

    expect(skipped.skipped).toBe(true);
    expect(skipped.warnings).toContain('tick_cooldown_active');
    expect(skipped.newActiveProposalCount).toBe(0);
  });

  it('skips overlapping ticks for the same session', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    const started = beginAoiAutonomyTick(root, SESSION_PATH, {
      reason: 'manual',
      now: NOW,
      lockMs: 60_000,
    });

    const skipped = await runAoiAutonomyBackgroundTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      minIntervalMs: 0,
      now: NOW + 1_000,
    });

    expect(started.started).toBe(true);
    expect(skipped.skipped).toBe(true);
    expect(skipped.warnings).toContain('tick_already_running');
    expect(skipped.status.activeTick).toBe(true);
  });
});

describe('runAoiAutonomyWakeup()', () => {
  it('runs a session-open wakeup within the configured source count budget', async () => {
    const root = makeTempRoot();
    const tickCalls: Array<{ maxGeneratedProposals?: number; llmConfigPresent: boolean }> = [];
    enablePolicy(root, 'L4');
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'workspace-git',
      patch: { enabled: true },
      now: NOW,
    });
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'workspace-build',
      patch: { enabled: true },
      now: NOW,
    });

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'session_open',
      workspaceRoot: root,
      llmConfig: TEST_LLM_CONFIG,
      sourceIds: ['workspace-git', 'workspace-build'],
      budget: {
        maxSourceCount: 1,
        maxGeneratedProposalCount: 0,
        perSourceCooldownMs: 60_000,
        wakeupCooldownMs: 0,
      },
      now: NOW,
      dependencies: {
        collectWorkspaceSnapshot: (input) =>
          makeSchedulerWorkspaceSnapshot(
            (input.registry?.sources ?? [])
              .filter((source) => source.enabled)
              .map((source) => source.id),
          ),
        runBackgroundTick: async (params) => {
          tickCalls.push({
            maxGeneratedProposals: params.maxGeneratedProposals,
            llmConfigPresent: Boolean(params.llmConfig),
          });
          return makeSchedulerTickResult(root, {
            reason: params.reason,
          });
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.record.selectedSourceIds).toEqual(['workspace-git']);
    expect(result.record.refreshedSourceIds).toEqual(['workspace-git']);
    expect(result.record.skippedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'workspace-build',
          reasons: ['max_source_count_reached'],
        }),
      ]),
    );
    expect(tickCalls).toEqual([{ maxGeneratedProposals: 0, llmConfigPresent: false }]);
    expect(
      result.state.sourceSchedules.find((item) => item.sourceId === 'workspace-git'),
    ).toMatchObject({
      refreshCount: 1,
      nextAllowedAt: NOW + 60_000,
    });
  });

  it('records disabled sources as skipped instead of refreshing them', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: ['workspace-git'],
      budget: {
        maxSourceCount: 1,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
      },
      now: NOW,
      dependencies: {
        runBackgroundTick: async (params) =>
          makeSchedulerTickResult(root, {
            reason: params.reason,
          }),
      },
    });

    expect(result.record.refreshedSourceIds).toEqual([]);
    expect(result.record.skippedSources).toEqual([
      {
        sourceId: 'workspace-git',
        reasons: ['source_disabled'],
      },
    ]);
    expect(
      result.state.sourceSchedules.find((item) => item.sourceId === 'workspace-git'),
    ).toMatchObject({
      lastResult: 'skipped',
      skipCount: 1,
    });
  });

  it('applies per-source cooldowns across repeated wakeups', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');

    await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: ['app-state'],
      budget: {
        maxSourceCount: 1,
        maxGeneratedProposalCount: 0,
        perSourceCooldownMs: 60_000,
        wakeupCooldownMs: 0,
      },
      now: NOW,
      dependencies: {
        runBackgroundTick: async (params) =>
          makeSchedulerTickResult(root, {
            reason: params.reason,
          }),
      },
    });

    const second = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: ['app-state'],
      budget: {
        maxSourceCount: 1,
        maxGeneratedProposalCount: 0,
        perSourceCooldownMs: 60_000,
        wakeupCooldownMs: 0,
      },
      now: NOW + 1_000,
      dependencies: {
        runBackgroundTick: async (params) =>
          makeSchedulerTickResult(root, {
            reason: params.reason,
          }),
      },
    });

    expect(second.record.refreshedSourceIds).toEqual([]);
    expect(second.record.skippedSources).toEqual([
      {
        sourceId: 'app-state',
        reasons: ['source_cooldown_active'],
      },
    ]);
    expect(
      second.state.sourceSchedules.find((item) => item.sourceId === 'app-state'),
    ).toMatchObject({
      refreshCount: 1,
      skipCount: 1,
    });
  });

  it('suppresses low-value quiet-mode sources while still recording the wakeup', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'browser-context',
      patch: {
        enabled: true,
        consentReason: 'User enabled this explicit browser page for metadata only.',
      },
      now: NOW,
    });

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'session_open',
      sourceIds: ['browser-context'],
      budget: {
        maxSourceCount: 1,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
      },
      quietMode: true,
      now: NOW,
      dependencies: {
        runBackgroundTick: async (params) =>
          makeSchedulerTickResult(root, {
            reason: params.reason,
          }),
      },
    });

    expect(result.record.budget.quietMode).toBe(true);
    expect(result.record.refreshedSourceIds).toEqual([]);
    expect(result.record.skippedSources).toEqual([
      {
        sourceId: 'browser-context',
        reasons: ['quiet_mode_suppressed'],
      },
    ]);
    expect(loadAoiAutonomySchedulerState(root, SESSION_PATH).recentWakeups[0].id).toBe(
      result.record.id,
    );
  });

  it('does not execute approved commands from a background wakeup', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    saveAoiActiveProposals(root, SESSION_PATH, [
      makeProposal({
        id: 'proposal-run-command-approved',
        status: 'accepted',
        title: 'Run validation command',
        body: 'A command proposal already exists, but scheduler wakeups must not execute it.',
        reason: 'The scheduler path is observe-only.',
        trigger: 'goal_continuation',
        cooldownKey: 'scheduler:no-command-execution',
        risk: 'high',
        requiredAutonomyLevel: 'L5',
        requiresUserApproval: true,
        suggestedTools: ['run_command'],
        acceptAction: {
          kind: 'run_command',
          params: {
            command: 'pnpm --filter @openroom/webuiapps test',
            cwd: root,
            purpose: 'Validate that scheduler does not execute commands.',
          },
        },
        evidenceRefs: ['proposal:proposal-run-command-approved'],
      }),
    ]);

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'health_check',
      sourceIds: ['app-state'],
      budget: {
        maxSourceCount: 1,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
      },
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect(loadAoiCommandAuditRecords(root, SESSION_PATH)).toEqual([]);
  });

  it('blocks run-now proactive scouts when the current-info provider is missing', async () => {
    const root = makeTempRoot();
    const scout = vi.fn(async () => makeScoutResult());
    enablePolicy(root, 'L4');
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          allowBackgroundScout: true,
          minScoutCooldownMs: 0,
        },
      },
      NOW,
    );

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      now: NOW,
      dependencies: {
        currentInfoProviderConfigured: () => false,
        runProactiveBriefScout: scout,
      },
    });

    expect(scout).not.toHaveBeenCalled();
    expect(result.record.proactiveScout).toMatchObject({
      requested: true,
      runNow: true,
      status: 'blocked',
      providerConfigured: false,
    });
    expect(result.record.proactiveScout?.blockedReasons).toContain('current_provider_missing');

    const health = buildAoiOperatorHealthState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile: join(root, 'missing-config.json'),
      now: NOW + 10,
    });
    expect(
      health.issues.find((issue) => issue.code === 'proactive_brief_scout_provider_missing'),
    ).toMatchObject({
      capability: 'research',
      severity: 'warning',
    });
  });

  it('does not run proactive scouts when scheduler controls are disabled', async () => {
    const root = makeTempRoot();
    const scout = vi.fn(async () => makeScoutResult());
    enablePolicy(root, 'L4');
    saveInterestProfile(root);
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: false,
          allowBackgroundScout: true,
          directChatHookOptIn: false,
          minScoutCooldownMs: 0,
        },
      },
      NOW,
    );

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      now: NOW,
      dependencies: {
        currentInfoProviderConfigured: () => true,
        runProactiveBriefScout: scout,
      },
    });

    expect(scout).not.toHaveBeenCalled();
    expect(result.record.proactiveScout).toMatchObject({
      requested: true,
      runNow: true,
      status: 'blocked',
      controlSnapshot: {
        enabled: false,
        allowBackgroundScout: true,
        directChatHookOptIn: false,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    });
    expect(result.record.proactiveScout?.blockedReasons).toContain('proactive_scouting_disabled');
    expect(
      loadAoiProactiveBriefFieldEvents(root, SESSION_PATH, NOW + 1).some(
        (event) =>
          event.policyReason === 'scheduler:blocked' &&
          event.suppressionReasons.includes('proactive_scouting_disabled'),
      ),
    ).toBe(true);
  });

  it('keeps quiet-window proactive scouts dashboard-only while recording direct-chat suppression', async () => {
    const root = makeTempRoot();
    const candidate = makeProactiveBriefCandidate({
      delivery: {
        allowedModes: ['dashboard'],
        quietModeSuppressed: true,
      },
    });
    const scout = vi.fn(async (input: RunAoiProactiveBriefScoutInput) => {
      expect(input.budget?.quietMode).toBe(true);
      expect(input.budget?.directChatHookOptIn).toBe(true);
      expect(input.budget?.maxTopicsPerWakeup).toBe(2);
      expect(input.budget?.maxNetworkCallsPerWakeup).toBe(2);
      return makeScoutResult({ createdCandidates: [candidate] });
    });
    enablePolicy(root, 'L4');
    saveInterestProfile(root);
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        confidenceFloor: 0.55,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          allowBackgroundScout: true,
          directChatHookOptIn: true,
          minScoutCooldownMs: 0,
          maxScoutRunsPerDay: 5,
          maxScoutRunsPerSession: 5,
          maxTopicsPerWakeup: 2,
          maxNetworkCallsPerWakeup: 2,
          quietWindow: {
            version: 1,
            enabled: true,
            startMinuteOfDay: 0,
            endMinuteOfDay: 0,
          },
        },
      },
      NOW,
    );

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      now: NOW,
      dependencies: {
        currentInfoProviderConfigured: () => true,
        runProactiveBriefScout: scout,
      },
    });

    expect(scout).toHaveBeenCalledTimes(1);
    expect(result.record.proactiveScout).toMatchObject({
      status: 'scouted',
      createdCandidateCount: 1,
      controlSnapshot: {
        enabled: true,
        directChatHookOptIn: true,
        quietWindowEnabled: true,
        quietWindowActive: true,
        maxTopicsPerWakeup: 2,
        maxNetworkCallsPerWakeup: 2,
        actionAuthority: 'display_only',
        mutationCount: 0,
      },
    });
    expect(result.record.proactiveScout?.warnings).toContain(
      'quiet_window_active:direct_chat_suppressed',
    );
    expect(result.record.proactiveScout?.trendDirectChatReadyCount).toBe(0);
  });

  it('persists trend snapshots when a run-now proactive scout creates candidates', async () => {
    const root = makeTempRoot();
    const candidate = makeProactiveBriefCandidate();
    const scout = vi.fn(async () => makeScoutResult({ createdCandidates: [candidate] }));
    enablePolicy(root, 'L4');
    saveInterestProfile(root);
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        confidenceFloor: 0.55,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          allowBackgroundScout: true,
          directChatHookOptIn: false,
          minScoutCooldownMs: 0,
          maxScoutRunsPerDay: 5,
          maxScoutRunsPerSession: 5,
        },
      },
      NOW,
    );

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      now: NOW,
      dependencies: {
        currentInfoProviderConfigured: () => true,
        runProactiveBriefScout: scout,
      },
    });
    const snapshots = loadAoiProactiveTrendSnapshots(root, SESSION_PATH, NOW + 1_000);

    expect(scout).toHaveBeenCalledTimes(1);
    expect(result.record.proactiveScout).toMatchObject({
      status: 'scouted',
      createdCandidateCount: 1,
      trendSnapshotCount: 1,
      trendOpinionCardCount: 1,
      trendDeliveryModes: {
        inline_card: 1,
      },
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].candidateId).toBe(candidate.id);
    expect(snapshots[0].novelty.status).toBe('new');
    expect(snapshots[0].delivery.mode).toBe('inline_card');
  });

  it('enforces proactive scout session budget even for run-now requests', async () => {
    const root = makeTempRoot();
    const scout = vi.fn(async () => makeScoutResult());
    enablePolicy(root, 'L4');
    saveInterestProfile(root);
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          allowBackgroundScout: true,
          maxScoutRunsPerDay: 5,
          maxScoutRunsPerSession: 1,
          minScoutCooldownMs: 0,
        },
      },
      NOW,
    );

    const baseWakeup = {
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh' as const,
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      dependencies: {
        currentInfoProviderConfigured: () => true,
        runProactiveBriefScout: scout,
      },
    };

    const first = await runAoiAutonomyWakeup({
      ...baseWakeup,
      now: NOW,
    });
    const second = await runAoiAutonomyWakeup({
      ...baseWakeup,
      now: NOW + 1_000,
    });

    expect(scout).toHaveBeenCalledTimes(1);
    expect(first.record.proactiveScout?.status).toBe('no_candidate');
    expect(first.state.proactiveScoutBudget).toMatchObject({
      runsThisSession: 1,
      runsToday: 1,
    });
    expect(second.record.proactiveScout).toMatchObject({
      requested: true,
      runNow: true,
      status: 'blocked',
    });
    expect(second.record.proactiveScout?.blockedReasons).toContain(
      'scout_session_budget_exhausted',
    );

    const health = buildAoiOperatorHealthState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile: join(root, 'missing-config.json'),
      now: NOW + 2_000,
    });
    expect(
      health.issues.find((issue) => issue.code === 'proactive_brief_scout_budget_exhausted'),
    ).toMatchObject({
      capability: 'research',
      severity: 'warning',
    });
  });

  it('includes proactive scout runtime in wakeup completion timing', async () => {
    const root = makeTempRoot();
    const timestamps = [NOW, NOW + 250];
    const scout = vi.fn(async () => makeScoutResult());
    enablePolicy(root, 'L4');
    saveInterestProfile(root);
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          allowBackgroundScout: true,
          minScoutCooldownMs: 0,
        },
      },
      NOW,
    );

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      dependencies: {
        now: () => timestamps.shift() ?? NOW + 250,
        currentInfoProviderConfigured: () => true,
        runProactiveBriefScout: scout,
      },
    });

    expect(scout).toHaveBeenCalledTimes(1);
    expect(result.record.proactiveScout?.status).toBe('no_candidate');
    expect(result.record.completedAt).toBe(NOW + 250);
    expect(result.record.durationMs).toBe(250);
  });

  it('honors muted proactive topics before calling the scout provider', async () => {
    const root = makeTempRoot();
    const topic = makeInterestTopic();
    const scout = vi.fn(async () => makeScoutResult());
    enablePolicy(root, 'L4');
    saveInterestProfile(root, topic);
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        enabled: true,
        proactiveSuggestionsEnabled: true,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          allowBackgroundScout: true,
          minScoutCooldownMs: 0,
          topicControls: {
            [topic.id]: {
              version: 1,
              topicId: topic.id,
              allowed: false,
              muted: true,
              pinned: false,
              updatedAt: NOW,
            },
          },
        },
      },
      NOW,
    );

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual_refresh',
      sourceIds: [],
      budget: {
        maxSourceCount: 0,
        maxBackgroundTickRuntimeMs: 0,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
        allowNetwork: true,
      },
      proactiveScout: {
        runNow: true,
      },
      now: NOW,
      dependencies: {
        currentInfoProviderConfigured: () => true,
        runProactiveBriefScout: scout,
      },
    });

    expect(scout).not.toHaveBeenCalled();
    expect(result.record.proactiveScout).toMatchObject({
      requested: true,
      runNow: true,
      status: 'blocked',
    });
    expect(result.record.proactiveScout?.blockedReasons).toContain('all_topics_muted');
    expect(
      loadAoiProactiveBriefFieldEvents(root, SESSION_PATH, NOW + 1).some(
        (event) =>
          event.kind === 'suppressed_no_topics' &&
          event.suppressionReasons.includes('all_topics_muted'),
      ),
    ).toBe(true);
  });

  it('records a failed wakeup on background tick timeout without corrupting scheduler state', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'health_check',
      sourceIds: ['app-state'],
      budget: {
        maxSourceCount: 1,
        maxBackgroundTickRuntimeMs: 1,
        maxSchedulerRuntimeMs: 1_000,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
      },
      now: NOW,
      dependencies: {
        runBackgroundTick: () => new Promise<AoiAutonomyTickResult>(() => undefined),
      },
    });

    const state = loadAoiAutonomySchedulerState(root, SESSION_PATH);

    expect(result.ok).toBe(false);
    expect(result.record.status).toBe('failed');
    expect(result.record.warnings.join(' ')).toContain('background tick exceeded runtime budget');
    expect(state.recentWakeups[0]).toMatchObject({
      id: result.record.id,
      status: 'failed',
    });
    expect(state.sourceSchedules.find((item) => item.sourceId === 'app-state')).toMatchObject({
      sourceId: 'app-state',
    });
    const health = buildAoiOperatorHealthState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile: join(root, 'config.json'),
      now: NOW + 10,
    });

    expect(health.overallStatus).toBe('degraded');
    expect(health.issues.find((issue) => issue.code === 'autonomy_tick_timeout')).toMatchObject({
      capability: 'memory',
      severity: 'error',
    });
  });

  it('does not overwrite failed state when the outer scheduler runtime budget wins the race', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');

    const result = await runAoiAutonomyWakeup({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'health_check',
      sourceIds: ['app-state'],
      budget: {
        maxSourceCount: 1,
        maxBackgroundTickRuntimeMs: 100,
        maxSchedulerRuntimeMs: 1,
        maxGeneratedProposalCount: 0,
        wakeupCooldownMs: 0,
      },
      now: NOW,
      dependencies: {
        runBackgroundTick: () =>
          new Promise<AoiAutonomyTickResult>((resolve) => {
            setTimeout(() => {
              resolve(makeSchedulerTickResult(root));
            }, 25);
          }),
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    const state = loadAoiAutonomySchedulerState(root, SESSION_PATH);

    expect(result.ok).toBe(false);
    expect(result.record.warnings).toContain('Aoi scheduler exceeded runtime budget.');
    expect(state.recentWakeups).toHaveLength(1);
    expect(state.recentWakeups[0]).toMatchObject({
      id: result.record.id,
      status: 'failed',
    });
  });
});
