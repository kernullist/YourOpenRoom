import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadAoiFollowThroughEvents,
  upsertAoiOpportunity,
  type AoiOpportunityUpsertInput,
} from '../aoiAutonomyStore';
import { buildAoiDeliberationRunPanelSummary } from '../aoiAutonomyUi';
import {
  buildAoiDeliberationRun,
  loadAoiDeliberationRuns,
  runAoiDeliberationForSession,
} from '../aoiDeliberationRun';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiResearchRunSummary } from '../aoiResearchTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-deliberation-run-test-'));
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
    content: partial.content ?? 'Reverse engineering tooling updates matter for current work.',
    normalizedContent:
      partial.normalizedContent ?? 'reverse engineering tooling updates matter for current work',
    importance: partial.importance ?? 0.86,
    confidence: partial.confidence ?? 0.84,
    hits: partial.hits ?? 2,
    createdAt: partial.createdAt ?? NOW - DAY_MS,
    updatedAt: partial.updatedAt ?? NOW - 60_000,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['episode-001'],
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    tags: partial.tags ?? ['interest', 'reverse-engineering'],
    entities: partial.entities ?? ['Reverse Engineering'],
    ...partial,
  };
}

function makeResearchRun(partial: Partial<AoiResearchRunSummary> = {}): AoiResearchRunSummary {
  return {
    id: partial.id ?? 'research-re-001',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    request: partial.request ?? 'Reverse engineering update check',
    title: partial.title ?? 'Reverse Engineering Update Check',
    mode: partial.mode ?? 'standard',
    language: partial.language ?? 'ko',
    recency: partial.recency ?? 'week',
    maxSources: partial.maxSources ?? 5,
    createdAt: partial.createdAt ?? NOW - DAY_MS,
    updatedAt: partial.updatedAt ?? NOW - 30_000,
    completedAt: partial.completedAt ?? NOW - 30_000,
    status: partial.status ?? 'completed',
    phase: partial.phase ?? 'completed',
    statusMessage: partial.statusMessage ?? 'Completed with fresh sources.',
    sourceCounts: partial.sourceCounts ?? {
      planned: 5,
      candidates: 4,
      accepted: 2,
      failed: 0,
    },
    artifactAvailability: partial.artifactAvailability ?? {
      manifest: true,
      report: true,
      sources: true,
      evidence: true,
    },
    claimCount: partial.claimCount ?? 2,
    warningCount: partial.warningCount ?? 0,
    verificationWarningCount: partial.verificationWarningCount ?? 0,
    ...partial,
  };
}

function makeOpportunityInput(
  partial: Partial<AoiOpportunityUpsertInput> = {},
): AoiOpportunityUpsertInput {
  return {
    sourceKind: 'interest',
    title: 'Deliberate RE evidence freshness',
    curiosityQuestion: 'Is the RE evidence fresh enough to brief?',
    whyNow: 'Aoi generated this from a high-confidence interest.',
    evidenceNeed: 'Need memory and research evidence before any action.',
    suggestedNextAction: 'Summarize evidence only.',
    risk: 'low',
    confidence: 0.78,
    urgency: 0.62,
    novelty: 0.6,
    deliveryRecommendation: 'dashboard',
    evidenceRefs: ['memory:memory-re-001', 'research:research-re-001'],
    dedupeKey: 'curiosity:interest:reverse-engineering',
    ...partial,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi Deliberation Run', () => {
  it('creates a completed read-only run with enough evidence', () => {
    const root = makeTempRoot();
    const stored = upsertAoiOpportunity(root, SESSION_PATH, makeOpportunityInput(), NOW);
    const result = runAoiDeliberationForSession({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [makeMemory()],
      researchRuns: [makeResearchRun()],
      force: true,
    });
    const runs = loadAoiDeliberationRuns(root, SESSION_PATH, NOW);
    const followThroughEvents = loadAoiFollowThroughEvents(root, SESSION_PATH, NOW);
    const summary = buildAoiDeliberationRunPanelSummary({ latest: result.run, now: NOW });

    expect(result.created).toBe(true);
    expect(result.run).toMatchObject({
      opportunityId: stored.opportunity.id,
      phase: 'ready',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(result.run?.finding).toMatchObject({
      sourceQuality: 'strong',
      freshness: 'fresh',
    });
    expect(result.run?.opinion?.stance).toBe('ready_to_brief');
    expect(result.run?.safeNextAction).toContain('ask before converting');
    expect(runs).toHaveLength(1);
    expect(followThroughEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliberationRunId: result.run?.id,
          opportunityId: stored.opportunity.id,
          sourceKind: 'deliberation',
          action: 'accepted',
          result: 'positive',
          actionAuthority: 'display_only',
          mutationCount: 0,
        }),
      ]),
    );
    expect(summary.visible).toBe(true);
    expect(summary.findingLabel).toContain('usable local evidence');
  });

  it('blocks a run when research evidence is stale', () => {
    const root = makeTempRoot();
    const stored = upsertAoiOpportunity(root, SESSION_PATH, makeOpportunityInput(), NOW);
    const run = buildAoiDeliberationRun({
      sessionPath: SESSION_PATH,
      opportunity: stored.opportunity,
      now: NOW,
      memories: [makeMemory()],
      researchRuns: [
        makeResearchRun({
          updatedAt: NOW - 35 * DAY_MS,
          completedAt: NOW - 35 * DAY_MS,
        }),
      ],
    });

    expect(run.phase).toBe('blocked');
    expect(run.blockers.join(' ')).toContain('stale');
    expect(run.finding?.freshness).toBe('stale');
    expect(run.opinion?.stance).toBe('abstain');
  });

  it('fails a run when referenced sources are missing', () => {
    const root = makeTempRoot();
    const stored = upsertAoiOpportunity(
      root,
      SESSION_PATH,
      makeOpportunityInput({
        evidenceRefs: ['research:missing-run'],
        dedupeKey: 'curiosity:research:missing',
      }),
      NOW,
    );
    const run = buildAoiDeliberationRun({
      sessionPath: SESSION_PATH,
      opportunity: stored.opportunity,
      now: NOW,
      researchRuns: [],
    });

    expect(run.phase).toBe('failed');
    expect(run.blockers).toEqual(expect.arrayContaining(['all evidence sources are missing']));
    expect(run.opinion).toBeUndefined();
  });

  it('does not create an opinion when there is no substantive evidence', () => {
    const root = makeTempRoot();
    const stored = upsertAoiOpportunity(
      root,
      SESSION_PATH,
      makeOpportunityInput({
        evidenceRefs: [],
        dedupeKey: 'curiosity:manual:no-evidence',
      }),
      NOW,
    );
    const run = buildAoiDeliberationRun({
      sessionPath: SESSION_PATH,
      opportunity: stored.opportunity,
      now: NOW,
    });

    expect(run.phase).toBe('failed');
    expect(run.finding).toBeUndefined();
    expect(run.opinion).toBeUndefined();
  });

  it('keeps the display-only boundary for private or sensitive evidence', () => {
    const root = makeTempRoot();
    upsertAoiOpportunity(
      root,
      SESSION_PATH,
      makeOpportunityInput({
        evidenceRefs: ['memory:private-memory'],
        dedupeKey: 'curiosity:private-memory',
      }),
      NOW,
    );
    const result = runAoiDeliberationForSession({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: NOW,
      memories: [
        makeMemory({
          id: 'private-memory',
          tags: ['private', 'credential'],
          content: 'token=super-secret-value',
        }),
      ],
      researchRuns: [],
      force: true,
    });
    const serialized = JSON.stringify(result.run);

    expect(result.run?.phase).toBe('blocked');
    expect(result.run).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(result.run?.evidencePlan[1]).toMatchObject({
      status: 'blocked',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).toContain('private memory body withheld');
  });
});
