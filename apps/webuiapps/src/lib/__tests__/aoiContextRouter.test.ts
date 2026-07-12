import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAoiContextRouterResult, buildDurableMemoryCandidates } from '../aoiContextRouter';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
import { updateAoiEnvironmentSource } from '../aoiAutonomyStore';
import { loadAoiActivityStreamSummary, recordAoiActivityEvent } from '../aoiActivityStream';
import { buildAoiIntentState, saveAoiIntentState } from '../aoiIntentInference';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

function memory(partial: Partial<AoiMemoryEntry>): AoiMemoryEntry {
  return {
    version: 2,
    id: 'mem',
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: 'The user prefers deep kernel detail.',
    normalizedContent: 'the user prefers deep kernel detail.',
    importance: 0.7,
    confidence: 0.8,
    hits: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceEpisodeIds: ['ep-1'],
    tags: [],
    entities: [],
    ...partial,
  } as AoiMemoryEntry;
}

describe('buildDurableMemoryCandidates (P4.2)', () => {
  const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

  it('surfaces active non-kira durable memories as manual_note candidates', () => {
    const out = buildDurableMemoryCandidates({
      memories: [
        memory({
          id: 'chat-1',
          content: 'The user prefers deep kernel detail.',
          tags: ['preference'],
        }),
        memory({ id: 'kira-1', content: 'Kira completed the work.', tags: ['kira'] }),
      ],
      latestUserMessage: 'kernel detail',
      registry,
      mission: null,
      now: 1000,
    });

    // The chat/preference memory surfaces; the kira memory is excluded (its own builder).
    expect(out.map((candidate) => candidate.evidenceRefs)).toContainEqual(['memory:chat-1']);
    expect(out.some((candidate) => candidate.evidenceRefs.includes('memory:kira-1'))).toBe(false);
    expect(out.every((candidate) => candidate.kind === 'manual_note')).toBe(true);
  });

  it('excludes superseded / archived memories (active-only recall filter)', () => {
    const out = buildDurableMemoryCandidates({
      memories: [
        memory({ id: 'sup-1', status: 'superseded', tags: ['preference'] }),
        memory({ id: 'arc-1', status: 'archived', tags: ['fact'] }),
      ],
      latestUserMessage: 'anything',
      registry,
      mission: null,
      now: 1000,
    });
    expect(out).toEqual([]);
  });

  it('excludes automation-tagged memories (handled by the kira builder)', () => {
    const out = buildDurableMemoryCandidates({
      memories: [memory({ id: 'auto-1', tags: ['automation'] })],
      latestUserMessage: 'x',
      registry,
      mission: null,
      now: 1000,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when the manual-note source is disabled in the registry', () => {
    const disabled = {
      ...registry,
      sources: registry.sources.map((source) =>
        source.id === 'manual-note' ? { ...source, enabled: false } : source,
      ),
    };
    const out = buildDurableMemoryCandidates({
      memories: [memory({ id: 'chat-2', tags: ['preference'] })],
      latestUserMessage: 'kernel',
      registry: disabled,
      mission: null,
      now: 1000,
    });
    expect(out).toEqual([]);
  });
});

describe('live activity context candidates (SA1.4)', () => {
  const SESSION_PATH = 'aoi/default';
  const NOW = 1_800_000_000_000;
  const tempRoots: string[] = [];

  function makeTempRoot(): string {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-context-router-activity-test-'));
    tempRoots.push(root);
    return root;
  }

  function consentActivity(root: string): void {
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'app-activity',
      patch: {
        enabled: true,
        consentReason: 'User enabled live activity awareness for this session.',
        lastReviewedAt: NOW,
      },
      now: NOW,
    });
  }

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ranks the live activity stream as a fresh, redacted, evidence-cited candidate', () => {
    const root = makeTempRoot();
    consentActivity(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_action', appId: 'musicapp', actionType: 'PLAY_TRACK', observedAt: NOW + 1000 },
      NOW + 1000,
    );

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'what is musicapp doing right now?',
      now: NOW + 2000,
    });

    const candidate = result.candidateSources.find((item) => item.sourceId === 'app-activity');
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      kind: 'app_activity',
      freshness: 'fresh',
      redactionState: 'redacted',
      displayName: 'Live app activity',
    });
    expect(candidate?.summary).toContain('active app=musicapp');
    expect(candidate?.scoreReasons).toContain('active-app-mentioned');
    expect(candidate?.scoreReasons).toContain('app-interaction-observed');
    expect(candidate?.evidenceRefs).toContain('environment-source:app-activity');
    expect(candidate?.evidenceRefs.some((ref) => ref.startsWith('activity:'))).toBe(true);
  });

  it('produces no candidate while the source is dark (default)', () => {
    const root = makeTempRoot();

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'what am I doing?',
      now: NOW,
    });

    expect(result.candidateSources.some((item) => item.sourceId === 'app-activity')).toBe(false);
  });

  it('drops hours-old activity entirely -- stale live signals never ground "now"', () => {
    const root = makeTempRoot();
    consentActivity(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);

    // At +2h the candidate's own stale scoring, the stale freshness contract,
    // and the low-confidence penalty stack below the relevance floor.
    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'status?',
      now: NOW + 2 * 60 * 60 * 1000,
    });

    expect(result.candidateSources.some((item) => item.sourceId === 'app-activity')).toBe(false);
  });

  it('keeps out-of-window activity only when the user asks about that app (stale, penalized)', () => {
    const root = makeTempRoot();
    consentActivity(root);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      {
        kind: 'app_action',
        appId: 'musicapp',
        actionType: 'PLAY_TRACK',
        observedAt: NOW - 40 * 60 * 1000,
      },
      NOW - 40 * 60 * 1000,
    );
    // The source itself was observed just now (fresh contract), but the last
    // EVENT is 40 minutes old -- outside the 30-minute live window. The stale
    // scoring is double-weighted (builder + penalty pass), so the candidate
    // survives only with the explicit active-app mention boost.
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'app-activity',
      patch: { lastObservedAt: NOW },
      now: NOW,
    });

    const unrelated = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'status?',
      now: NOW,
    });
    expect(unrelated.candidateSources.some((item) => item.sourceId === 'app-activity')).toBe(false);

    const asking = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'what was I doing in musicapp earlier?',
      now: NOW,
    });
    const candidate = asking.candidateSources.find((item) => item.sourceId === 'app-activity');
    expect(candidate?.freshness).toBe('stale');
    expect(candidate?.scoreReasons).toContain('activity-outside-fresh-window');
    expect(candidate?.scoreReasons).toContain('active-app-mentioned');
  });

  it('boosts intent-aligned sources and ignores stale intent states (SA2.2)', () => {
    const root = makeTempRoot();
    consentActivity(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_action', appId: 'musicapp', actionType: 'PLAY_TRACK', observedAt: NOW + 1000 },
      NOW + 1000,
    );
    const intentState = buildAoiIntentState({
      sessionPath: SESSION_PATH,
      now: NOW + 2000,
      activitySummary: loadAoiActivityStreamSummary(root, SESSION_PATH, NOW + 2000),
    });
    expect(intentState.current?.kind).toBe('media');

    const withoutIntent = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'status?',
      intentState: null,
      now: NOW + 2000,
    });
    const aligned = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'status?',
      intentState,
      // A non-aligned candidate (manual_note) proves the boost is selective.
      memories: [
        memory({ id: 'note-1', content: 'status note about kernel work', tags: ['fact'] }),
      ],
      now: NOW + 2000,
    });

    const baseCandidate = withoutIntent.candidateSources.find(
      (item) => item.sourceId === 'app-activity',
    );
    const boosted = aligned.candidateSources.find((item) => item.sourceId === 'app-activity');
    expect(boosted?.scoreReasons).toContain('aligned with current intent:media');
    const noteCandidate = aligned.candidateSources.find((item) => item.kind === 'manual_note');
    expect(noteCandidate?.scoreReasons ?? []).not.toContain('aligned with current intent:media');
    expect(boosted?.relevanceScore ?? 0).toBeCloseTo(
      (baseCandidate?.relevanceScore ?? 0) + 0.12,
      2,
    );

    // A persisted-but-stale intent state must not boost anything.
    saveAoiIntentState(root, { ...intentState, staleAt: NOW + 2000 });
    const staleLoaded = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'status?',
      now: NOW + 2000,
    });
    const unboosted = staleLoaded.candidateSources.find((item) => item.sourceId === 'app-activity');
    expect(unboosted?.scoreReasons ?? []).not.toContain('aligned with current intent:media');
  });

  it('respects an injected null activity summary (no ledger read)', () => {
    const root = makeTempRoot();
    consentActivity(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'status?',
      activitySummary: null,
      now: NOW + 1000,
    });

    expect(result.candidateSources.some((item) => item.sourceId === 'app-activity')).toBe(false);
  });
});
