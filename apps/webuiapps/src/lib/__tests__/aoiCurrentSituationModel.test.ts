import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAoiCurrentSituation,
  loadAoiCurrentSituation,
  resolveAoiCurrentSituationPaths,
  saveAoiCurrentSituation,
} from '../aoiCurrentSituationModel';
import { buildAoiIntentState } from '../aoiIntentInference';
import {
  buildAoiActivityStreamSummary,
  normalizeAoiActivityEvent,
  type AoiActivityEvent,
} from '../aoiActivityStream';
import {
  buildAoiScreenVisionStreamSummary,
  normalizeAoiScreenVisionEvent,
  type AoiScreenVisionEvent,
} from '../aoiScreenVisionStream';
import type {
  AoiMissionState,
  AoiPersonalSignalMetadataSummary,
  AoiWorkspaceSnapshot,
} from '../aoiAutonomyTypes';
import type { AoiResearchRunSummary } from '../aoiResearchTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-situation-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspaceSnapshot(): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: NOW - 5 * 60 * 1000,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git'],
    git: {
      version: 1,
      branchName: 'main',
      branchChanged: false,
      isDirty: true,
      changedFileCount: 4,
      stagedFileCount: 1,
      unstagedFileCount: 3,
      untrackedFileCount: 0,
      statusSummary: 'dirty: 4 changed, 1 staged',
      changedFiles: [],
    },
    validation: {
      version: 1,
      result: 'passed',
      touchedFileScopes: [],
      freshness: 'fresh',
      evidenceRefs: ['workspace:validation:latest'],
    },
    freshness: 'fresh',
    evidenceRefs: [`workspace:snapshot:${NOW - 5 * 60 * 1000}`],
    warnings: [],
  };
}

function makeActivitySummary(now: number) {
  const events = [
    normalizeAoiActivityEvent(
      { kind: 'app_opened', appId: 'musicapp', observedAt: now - 2 * 60 * 1000 },
      SESSION_PATH,
      now - 2 * 60 * 1000,
    ).event,
    normalizeAoiActivityEvent(
      {
        kind: 'app_action',
        appId: 'musicapp',
        actionType: 'PLAY_TRACK',
        observedAt: now - 60 * 1000,
      },
      SESSION_PATH,
      now - 60 * 1000,
    ).event,
  ].filter((event): event is AoiActivityEvent => event !== null);
  return buildAoiActivityStreamSummary({ sessionPath: SESSION_PATH, events, now });
}

function makeScreenVisionSummary(now: number) {
  const events = [
    normalizeAoiScreenVisionEvent(
      {
        summaryText: 'Editing an anti-cheat driver in the editor',
        appId: 'code',
        observedAt: now - 60 * 1000,
      },
      SESSION_PATH,
      now - 60 * 1000,
    ).event,
  ].filter((event): event is AoiScreenVisionEvent => event !== null);
  return buildAoiScreenVisionStreamSummary({ sessionPath: SESSION_PATH, events, now });
}

function makeCalendarSummary(): AoiPersonalSignalMetadataSummary {
  return {
    version: 1,
    sourceId: 'calendar-metadata',
    kind: 'calendar_metadata',
    label: 'Calendar metadata',
    displayName: 'Calendar',
    summary: 'Calendar metadata: 1 upcoming of 3; Standup at 10:00 (reminder 15m).',
    relevanceText: 'calendar metadata',
    evidenceRefs: ['personal-signal:calendar_metadata'],
    scoreReasons: [],
    updatedAt: NOW - 10 * 60 * 1000,
    freshness: 'fresh',
    confidence: 0.8,
    redactionState: 'redacted',
  };
}

function makeMission(): AoiMissionState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    status: 'active',
    activeGoalId: 'goal-77',
    focusSummary: 'Harden the kernel telemetry path',
    waitingOn: 'none',
    nextRecommendedAction: 'continue',
    evidenceRefs: ['proposal:p-1'],
    sourceRefs: {},
    transitions: [],
    createdAt: NOW - 60 * 60 * 1000,
    updatedAt: NOW - 30 * 60 * 1000,
  } as never;
}

function makeRun(partial: Partial<AoiResearchRunSummary>): AoiResearchRunSummary {
  return {
    id: 'aoi-research-777',
    sessionPath: SESSION_PATH,
    request: 'kernel anti-cheat research',
    mode: 'quick',
    language: 'en',
    recency: 'any',
    maxSources: 4,
    createdAt: NOW - 1000,
    updatedAt: NOW - 500,
    status: 'running',
    phase: 'searching',
    statusMessage: 'running',
    sourceCounts: { discovered: 0, fetched: 0, cited: 0 },
    warningCount: 0,
    verificationWarningCount: 0,
    ...partial,
  } as AoiResearchRunSummary;
}

describe('buildAoiCurrentSituation', () => {
  it('fuses all consented sources into evidence-cited segments with a headline', () => {
    const activitySummary = makeActivitySummary(NOW);
    const intentState = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary,
      workspaceSnapshot: makeWorkspaceSnapshot(),
    });
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      mission: makeMission(),
      intentState,
      activitySummary,
      workspaceSnapshot: makeWorkspaceSnapshot(),
      personalMetadata: [makeCalendarSummary()],
      researchRuns: [makeRun({})],
      lastUserMessageAt: NOW - 3 * 60 * 1000,
    });

    expect(situation.segments.map((segment) => segment.kind).sort()).toEqual([
      'activity',
      'calendar',
      'conversation',
      'intent',
      'mission',
      'research',
      'workspace',
    ]);
    // EVERY segment cites evidence -- the grounding invariant.
    expect(situation.segments.every((segment) => segment.evidenceRefs.length > 0)).toBe(true);
    expect(situation.headline).toContain('active app musicapp');
    expect(situation.headline).toContain('branch main');
    expect(situation.intent).not.toBeNull();
    expect(situation.focusItems.length).toBeGreaterThan(0);
    expect(situation.focusItems.length).toBeLessThanOrEqual(5);
    expect(situation.focusItems.every((item) => item.evidenceRefs.length > 0)).toBe(true);
    expect(situation).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
      staleAt: NOW + 30 * 60 * 1000,
    });
    expect(situation.confidence).toBeGreaterThan(0.6);
    expect(situation.evidenceRefs).toContain(`workspace:snapshot:${NOW - 5 * 60 * 1000}`);
  });

  it('drops uncited segments and explains them as cannotKnow (fail-closed grounding)', () => {
    const snapshot = makeWorkspaceSnapshot();
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      mission: { ...makeMission(), evidenceRefs: [], activeGoalId: undefined } as never,
      workspaceSnapshot: { ...snapshot, evidenceRefs: [] },
    });

    expect(situation.segments.some((segment) => segment.kind === 'mission')).toBe(false);
    expect(situation.segments.some((segment) => segment.kind === 'workspace')).toBe(false);
    expect(situation.cannotKnow.join(' ')).toContain('mission');
    expect(situation.cannotKnow.join(' ')).toContain('workspace');
  });

  it('fuses a consented screen-vision summary as an evidence-cited segment (SV5.1b)', () => {
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      screenVisionSummary: makeScreenVisionSummary(NOW),
    });
    const segment = situation.segments.find((item) => item.kind === 'screen_vision');
    expect(segment).toBeDefined();
    expect(segment?.freshness).toBe('fresh');
    expect(segment?.evidenceRefs.length).toBeGreaterThan(0);
    expect(segment?.evidenceRefs.some((ref) => ref.startsWith('screen:'))).toBe(true);
  });

  it('states a cannotKnow when the screen-vision source is not consented (SV5.1b)', () => {
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      screenVisionSummary: buildAoiScreenVisionStreamSummary({
        sessionPath: SESSION_PATH,
        events: [],
        consented: false,
        now: NOW,
      }),
    });
    expect(situation.segments.some((segment) => segment.kind === 'screen_vision')).toBe(false);
    expect(situation.cannotKnow.join(' ')).toContain('screen-vision source is not consented');
  });

  it('describes a fully dark session honestly', () => {
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      activitySummary: buildAoiActivityStreamSummary({
        sessionPath: SESSION_PATH,
        events: [],
        consented: false,
        now: NOW,
      }),
    });

    expect(situation.segments).toHaveLength(0);
    expect(situation.headline).toContain('situation unknown');
    expect(situation.intent).toBeNull();
    expect(situation.cannotKnow.join(' ')).toContain('not consented');
    expect(situation.cannotKnow.join(' ')).toContain('workspace');
    expect(situation.confidence).toBeLessThan(0.3);
  });

  it('treats a stale intent state as absent and surfaces its cannotKnow', () => {
    const activitySummary = makeActivitySummary(NOW - 60 * 60 * 1000);
    const staleIntent = {
      ...buildAoiIntentState({
        sessionPath: SESSION_PATH,
        now: NOW - 60 * 60 * 1000,
        activitySummary,
      }),
      staleAt: NOW - 1,
    };
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      intentState: staleIntent,
    });

    expect(situation.intent).toBeNull();
    expect(situation.segments.some((segment) => segment.kind === 'intent')).toBe(false);
  });

  it('ranks fresh live activity above decayed slower segments in the focus list', () => {
    const activitySummary = makeActivitySummary(NOW);
    // Age the mission by 18h (12h half-life) so decay -- not base weight --
    // decides the ordering against minute-fresh activity.
    const agedMission = { ...makeMission(), updatedAt: NOW - 18 * 60 * 60 * 1000 };
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      mission: agedMission as never,
      activitySummary,
    });

    const activityIndex = situation.focusItems.findIndex(
      (item) => item.sourceKind === 'app_activity',
    );
    const missionIndex = situation.focusItems.findIndex(
      (item) => item.sourceKind === 'mission_state',
    );
    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(missionIndex).toBeGreaterThanOrEqual(0);
    expect(activityIndex).toBeLessThan(missionIndex);
  });

  it('includes only recent research runs', () => {
    const oldRun = makeRun({
      status: 'completed',
      completedAt: NOW - 3 * 60 * 60 * 1000,
    });
    const withoutRecent = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      researchRuns: [oldRun],
    });
    expect(withoutRecent.segments.some((segment) => segment.kind === 'research')).toBe(false);

    const recentRun = makeRun({ status: 'completed', completedAt: NOW - 30 * 60 * 1000 });
    const withRecent = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      researchRuns: [recentRun],
    });
    const research = withRecent.segments.find((segment) => segment.kind === 'research');
    expect(research?.evidenceRefs).toContain('research:aoi-research-777');
  });

  it('rejects an invalid session path', () => {
    expect(() => buildAoiCurrentSituation({ sessionPath: '' })).toThrow('sessionPath');
  });

  it('truncates long mission text, ages conversation to stale, and skips non-calendar metadata', () => {
    const longFocus = 'harden the kernel telemetry path '.repeat(12);
    const gmailSummary: AoiPersonalSignalMetadataSummary = {
      ...makeCalendarSummary(),
      sourceId: 'gmail-metadata',
      kind: 'gmail_metadata',
      label: 'Gmail metadata',
      summary: 'Gmail metadata: connected=true; unread=3',
    };
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      mission: { ...makeMission(), focusSummary: longFocus } as never,
      personalMetadata: [gmailSummary, makeCalendarSummary()],
      lastUserMessageAt: NOW - 60 * 60 * 1000,
    });

    const missionSegment = situation.segments.find((segment) => segment.kind === 'mission');
    expect(missionSegment?.summary.length).toBeLessThanOrEqual(220);
    expect(missionSegment?.summary.endsWith('...')).toBe(true);
    const conversation = situation.segments.find((segment) => segment.kind === 'conversation');
    expect(conversation?.freshness).toBe('stale');
    expect(conversation?.summary).toBe('Last user message 60m ago.');
    // The gmail entry is skipped -- only calendar metadata becomes a segment.
    expect(situation.segments.filter((segment) => segment.kind === 'calendar')).toHaveLength(1);
  });
});

describe('current situation persistence', () => {
  it('round-trips through the atomic writer and appends bounded history', () => {
    const root = makeTempRoot();
    const situation = buildAoiCurrentSituation({
      sessionPath: SESSION_PATH,
      now: NOW,
      workspaceSnapshot: makeWorkspaceSnapshot(),
    });

    saveAoiCurrentSituation(root, situation);
    expect(loadAoiCurrentSituation(root, SESSION_PATH)).toEqual(situation);

    for (let index = 0; index < 105; index += 1) {
      saveAoiCurrentSituation(root, { ...situation, generatedAt: NOW + index });
    }
    const paths = resolveAoiCurrentSituationPaths(root, SESSION_PATH);
    const historyLines = fs.readFileSync(paths.history, 'utf-8').split(/\r?\n/).filter(Boolean);
    expect(historyLines.length).toBeLessThanOrEqual(100);
  });

  it('returns null for missing, corrupt, or non-display-only states', () => {
    const root = makeTempRoot();
    expect(loadAoiCurrentSituation(root, SESSION_PATH)).toBeNull();

    const paths = resolveAoiCurrentSituationPaths(root, SESSION_PATH);
    fs.mkdirSync(join(root, 'aoi', 'default', 'aoi-autonomy', 'situation'), { recursive: true });
    fs.writeFileSync(paths.current, 'not-json', 'utf-8');
    expect(loadAoiCurrentSituation(root, SESSION_PATH)).toBeNull();

    fs.writeFileSync(
      paths.current,
      JSON.stringify({
        version: 1,
        generatedAt: NOW,
        staleAt: NOW,
        actionAuthority: 'execute',
        mutationCount: 0,
        segments: [],
      }),
      'utf-8',
    );
    expect(loadAoiCurrentSituation(root, SESSION_PATH)).toBeNull();
  });

  it('rejects invalid session paths on the persistence surface', () => {
    const root = makeTempRoot();
    expect(() => resolveAoiCurrentSituationPaths(root, '')).toThrow('sessionPath');
    expect(loadAoiCurrentSituation(root, '..')).toBeNull();
  });
});
