import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAoiIntentState,
  loadAoiIntentState,
  resolveAoiIntentStatePath,
  saveAoiIntentState,
} from '../aoiIntentInference';
import {
  buildAoiActivityStreamSummary,
  normalizeAoiActivityEvent,
  type AoiActivityEvent,
} from '../aoiActivityStream';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
import type { AoiPersonalSignalMetadataSummary, AoiWorkspaceSnapshot } from '../aoiAutonomyTypes';
import type { AoiResearchRunSummary } from '../aoiResearchTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-intent-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspaceSnapshot(partial: {
  isDirty?: boolean;
  branchChanged?: boolean;
  validationResult?: 'passed' | 'failed' | 'unknown';
}): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: NOW,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git'],
    git: {
      version: 1,
      branchName: 'main',
      branchChanged: partial.branchChanged ?? false,
      isDirty: partial.isDirty ?? false,
      changedFileCount: partial.isDirty ? 3 : 0,
      stagedFileCount: 0,
      unstagedFileCount: partial.isDirty ? 3 : 0,
      untrackedFileCount: 0,
      statusSummary: partial.isDirty ? 'dirty: 3 changed' : 'clean',
      changedFiles: [],
    },
    validation: {
      version: 1,
      result: partial.validationResult ?? 'unknown',
      touchedFileScopes: [],
      freshness: 'fresh',
      evidenceRefs: ['workspace:validation:latest'],
    },
    freshness: 'fresh',
    evidenceRefs: [`workspace:snapshot:${NOW}`],
    warnings: [],
  };
}

function makeActivityEvents(appId: string, observedAt: number): AoiActivityEvent[] {
  const opened = normalizeAoiActivityEvent(
    { kind: 'app_opened', appId, observedAt },
    SESSION_PATH,
    observedAt,
  ).event;
  const action = normalizeAoiActivityEvent(
    { kind: 'app_action', appId, actionType: 'DO_THING', observedAt: observedAt + 1000 },
    SESSION_PATH,
    observedAt + 1000,
  ).event;
  return [opened, action].filter((event): event is AoiActivityEvent => event !== null);
}

function makeActivitySummary(appId: string, lastEventAt: number, now: number) {
  return buildAoiActivityStreamSummary({
    sessionPath: SESSION_PATH,
    events: makeActivityEvents(appId, lastEventAt - 1000),
    now,
  });
}

function makeResearchRun(partial: Partial<AoiResearchRunSummary>): AoiResearchRunSummary {
  return {
    id: 'aoi-research-001',
    sessionPath: SESSION_PATH,
    request: 'test request',
    mode: 'quick',
    language: 'en',
    recency: 'any',
    maxSources: 4,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    status: 'running',
    phase: 'searching',
    statusMessage: 'running',
    sourceCounts: { discovered: 0, fetched: 0, cited: 0 },
    warningCount: 0,
    verificationWarningCount: 0,
    ...partial,
  } as AoiResearchRunSummary;
}

describe('buildAoiIntentState', () => {
  it('infers debugging over coding when validation fails on a dirty tree', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: makeWorkspaceSnapshot({ isDirty: true, validationResult: 'failed' }),
    });

    expect(state.current?.kind).toBe('debugging');
    expect(state.current?.evidenceRefs).toContain('workspace:validation:latest');
    expect(state.alternates.map((item) => item.kind)).toContain('coding');
    expect(state).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
      staleAt: NOW + 30 * 60 * 1000,
    });
  });

  it('combines message and workspace evidence into a confident coding intent', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: makeWorkspaceSnapshot({ isDirty: true }),
      latestUserMessage: '이 버그 고쳐줘',
    });

    expect(state.current?.kind).toBe('coding');
    expect(state.current?.confidence).toBeCloseTo(0.7, 2);
    expect(state.current?.evidenceRefs).toContain('chat:latest-user-message');
    expect(state.current?.evidenceRefs).toContain(`workspace:snapshot:${NOW}`);
  });

  it('keeps a weak message-only signal below the current-intent floor', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      latestUserMessage: 'plan the roadmap',
    });

    expect(state.current).toBeNull();
    expect(state.alternates.map((item) => item.kind)).toContain('planning');
    expect(state.cannotKnow.join(' ')).toContain('cannot state a current intent');
  });

  it('infers researching from an active run and decays completed runs', () => {
    const active = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      researchRuns: [makeResearchRun({ status: 'running' })],
    });
    expect(active.current?.kind).toBe('researching');
    expect(active.current?.evidenceRefs).toContain('research:aoi-research-001');

    const old = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      researchRuns: [
        makeResearchRun({ status: 'completed', completedAt: NOW - 3 * 60 * 60 * 1000 }),
      ],
    });
    expect(old.current).toBeNull();
  });

  it('maps live app activity to category intents', () => {
    const media = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary: makeActivitySummary('musicapp', NOW - 60_000, NOW),
    });
    expect(media.current?.kind).toBe('media');
    expect(media.current?.confidence).toBeCloseTo(0.5, 2);
    expect(media.current?.evidenceRefs.some((ref) => ref.startsWith('activity:'))).toBe(true);

    const writing = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary: makeActivitySummary('notesapp', NOW - 60_000, NOW),
    });
    expect(writing.current?.kind).toBe('writing');
  });

  it('claims idle only with a consented but silent activity stream', () => {
    const idle = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary: buildAoiActivityStreamSummary({
        sessionPath: SESSION_PATH,
        events: [],
        now: NOW,
      }),
    });
    expect(idle.current?.kind).toBe('idle');
    expect(idle.current?.evidenceRefs).toContain('environment-source:app-activity');

    const unconsented = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary: buildAoiActivityStreamSummary({
        sessionPath: SESSION_PATH,
        events: [],
        consented: false,
        now: NOW,
      }),
    });
    expect(unconsented.current).toBeNull();
    expect(unconsented.alternates.map((item) => item.kind)).not.toContain('idle');
    expect(unconsented.cannotKnow.join(' ')).toContain('idle cannot be claimed');
  });

  it('infers meeting preparation from fresh upcoming calendar metadata', () => {
    const calendar: AoiPersonalSignalMetadataSummary = {
      version: 1,
      sourceId: 'calendar-metadata',
      kind: 'calendar_metadata',
      label: 'Calendar metadata',
      displayName: 'Calendar',
      summary: 'Calendar metadata: 1 upcoming of 2; Standup at 10:00 (reminder 15m).',
      relevanceText: 'calendar metadata',
      evidenceRefs: ['personal-signal:calendar_metadata'],
      scoreReasons: [],
      updatedAt: NOW,
      freshness: 'fresh',
      confidence: 0.8,
      redactionState: 'redacted',
    };
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      personalMetadata: [calendar],
    });

    expect(state.alternates.concat(state.current ?? []).map((item) => item.kind)).toContain(
      'meeting_prep',
    );
  });

  it('adds cannotKnow when workspace signals are dark in the registry', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      registry: getDefaultAoiEnvironmentSourceRegistry(SESSION_PATH, NOW),
      workspaceSnapshot: null,
    });

    expect(state.cannotKnow.join(' ')).toContain('workspace-git source is not enabled');
  });

  it('anchors hypotheses to the active mission goal', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: makeWorkspaceSnapshot({ isDirty: true }),
      mission: {
        version: 1,
        sessionPath: SESSION_PATH,
        status: 'active',
        activeGoalId: 'goal-123',
        focusSummary: 'Ship the feature',
        waitingOn: 'none',
        nextRecommendedAction: 'continue',
        evidenceRefs: [],
        sourceRefs: {},
        transitions: [],
        createdAt: NOW - 1000,
        updatedAt: NOW,
      } as never,
    });

    expect(state.current?.evidenceRefs).toContain('goal:goal-123');
  });

  it('rejects an invalid session path', () => {
    expect(() => buildAoiIntentState({ sessionPath: '' })).toThrow('sessionPath');
  });

  it('scores branch drift and fresh completed research as secondary evidence', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: makeWorkspaceSnapshot({ isDirty: true, branchChanged: true }),
      researchRuns: [makeResearchRun({ status: 'completed', completedAt: NOW - 60 * 60 * 1000 })],
      latestUserMessage: 'research this please',
    });

    // Tie at 0.55 breaks deterministically by kind name: coding < researching.
    expect(state.current?.kind).toBe('coding');
    expect(state.current?.confidence).toBeCloseTo(0.55, 2);
    expect(state.current?.scoreReasons).toContain('workspace branch changed');
    const researching = state.alternates.find((item) => item.kind === 'researching');
    expect(researching?.confidence).toBeCloseTo(0.55, 2);
    expect(researching?.scoreReasons).toContain('message mentions research');
  });

  it('treats interaction in an unmapped app as a weak planning signal', () => {
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary: makeActivitySummary('randomapp', NOW - 60_000, NOW),
    });

    expect(state.current).toBeNull();
    const planning = state.alternates.find((item) => item.kind === 'planning');
    expect(planning?.scoreReasons).toContain('live interaction in randomapp');
  });

  it('drops a signal whose source carries no citable evidence (fail-closed grounding)', () => {
    const snapshot = makeWorkspaceSnapshot({ isDirty: true });
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: { ...snapshot, evidenceRefs: [] },
    });

    expect(state.current).toBeNull();
    expect(state.alternates.map((item) => item.kind)).not.toContain('coding');
  });
});

describe('intent state persistence', () => {
  it('round-trips the state through the atomic writer', () => {
    const root = makeTempRoot();
    const state = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: makeWorkspaceSnapshot({ isDirty: true }),
    });

    saveAoiIntentState(root, state);
    const loaded = loadAoiIntentState(root, SESSION_PATH);
    expect(loaded).toEqual(state);
  });

  it('returns null for missing, corrupt, or non-display-only states', () => {
    const root = makeTempRoot();
    expect(loadAoiIntentState(root, SESSION_PATH)).toBeNull();

    const filePath = resolveAoiIntentStatePath(root, SESSION_PATH);
    fs.mkdirSync(join(root, 'aoi', 'default', 'aoi-autonomy', 'intent'), { recursive: true });
    fs.writeFileSync(filePath, 'not-json', 'utf-8');
    expect(loadAoiIntentState(root, SESSION_PATH)).toBeNull();

    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, generatedAt: NOW, staleAt: NOW, actionAuthority: 'execute' }),
      'utf-8',
    );
    expect(loadAoiIntentState(root, SESSION_PATH)).toBeNull();
  });

  it('rejects invalid session paths across the persistence surface', () => {
    const root = makeTempRoot();
    expect(() => resolveAoiIntentStatePath(root, '')).toThrow('sessionPath');
    expect(() => loadAoiIntentState(root, '..')).not.toThrow();
    expect(loadAoiIntentState(root, '..')).toBeNull();
  });
});
