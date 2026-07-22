import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAoiContextRouterResult, buildDurableMemoryCandidates } from '../aoiContextRouter';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
import { updateAoiEnvironmentSource } from '../aoiAutonomyStore';
import { loadAoiActivityStreamSummary, recordAoiActivityEvent } from '../aoiActivityStream';
import { recordAoiScreenVisionEvent } from '../aoiScreenVisionStream';
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

  it('decays out-of-window activity gradually -- low unasked, lifted when asked about', () => {
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
    // EVENT is 40 minutes old -- outside the 30-minute live window. With the
    // SA3.2 continuous decay the candidate fades to a LOW score instead of
    // vanishing at the window edge; asking about the app lifts it.
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
    const unaskedCandidate = unrelated.candidateSources.find(
      (item) => item.sourceId === 'app-activity',
    );
    expect(unaskedCandidate?.freshness).toBe('stale');
    expect(unaskedCandidate?.relevanceScore ?? 0).toBeLessThan(0.1);

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
    expect(candidate?.relevanceScore ?? 0).toBeGreaterThan(unaskedCandidate?.relevanceScore ?? 0);
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

  it('fades live activity smoothly with age instead of a window cliff (SA3.2)', () => {
    const scoreAtAge = (ageMs: number): number => {
      const root = makeTempRoot();
      consentActivity(root);
      recordAoiActivityEvent(
        root,
        SESSION_PATH,
        {
          kind: 'app_action',
          appId: 'musicapp',
          actionType: 'PLAY_TRACK',
          observedAt: NOW - ageMs,
        },
        NOW - ageMs,
      );
      // Keep the freshness CONTRACT fresh so only the candidate-side decay
      // varies with age (isolates the SA3.2 curve).
      updateAoiEnvironmentSource(root, SESSION_PATH, {
        sourceId: 'app-activity',
        patch: { lastObservedAt: NOW },
        now: NOW,
      });
      const result = buildAoiContextRouterResult({
        sessionsDir: root,
        sessionPath: SESSION_PATH,
        latestUserMessage: 'what is musicapp doing?',
        intentState: null,
        now: NOW,
      });
      return (
        result.candidateSources.find((item) => item.sourceId === 'app-activity')?.relevanceScore ??
        0
      );
    };

    const fresh = scoreAtAge(1000);
    const tenMinutes = scoreAtAge(10 * 60 * 1000);
    const twentyFiveMinutes = scoreAtAge(25 * 60 * 1000);
    const justPastWindow = scoreAtAge(31 * 60 * 1000);

    // Monotone decay: each older signal scores strictly lower.
    expect(tenMinutes).toBeLessThan(fresh);
    expect(twentyFiveMinutes).toBeLessThan(tenMinutes);
    expect(justPastWindow).toBeLessThan(twentyFiveMinutes);
    // No cliff at the window edge: crossing 30min moves the score by a small
    // continuous step, not the old discrete fresh->stale jump (~0.26+).
    expect(twentyFiveMinutes - justPastWindow).toBeLessThan(0.15);
    expect(justPastWindow).toBeGreaterThan(0);
  });

  it('tags decayed live candidates with a salience reason (SA3.2)', () => {
    const root = makeTempRoot();
    consentActivity(root);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      {
        kind: 'app_action',
        appId: 'musicapp',
        actionType: 'PLAY_TRACK',
        observedAt: NOW - 10 * 60 * 1000,
      },
      NOW - 10 * 60 * 1000,
    );

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'musicapp status',
      intentState: null,
      now: NOW,
    });
    const candidate = result.candidateSources.find((item) => item.sourceId === 'app-activity');
    expect(candidate?.scoreReasons.some((reason) => reason.startsWith('salience decay'))).toBe(
      true,
    );

    // A zero-age signal has an exactly-zero adjustment: no decay tag.
    const zeroAgeRoot = makeTempRoot();
    consentActivity(zeroAgeRoot);
    recordAoiActivityEvent(
      zeroAgeRoot,
      SESSION_PATH,
      { kind: 'app_action', appId: 'musicapp', actionType: 'PLAY_TRACK', observedAt: NOW },
      NOW,
    );
    const zeroAge = buildAoiContextRouterResult({
      sessionsDir: zeroAgeRoot,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'musicapp status',
      intentState: null,
      now: NOW,
    });
    const freshCandidate = zeroAge.candidateSources.find(
      (item) => item.sourceId === 'app-activity',
    );
    expect(freshCandidate?.scoreReasons.some((reason) => reason.startsWith('salience decay'))).toBe(
      false,
    );
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

  function consentScreenVision(root: string): void {
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'screen-vision',
      patch: {
        enabled: true,
        consentReason: 'User enabled screen vision for this session.',
        lastReviewedAt: NOW,
      },
      now: NOW,
    });
  }

  it('surfaces a fresh screen-vision candidate and boosts when the app is mentioned (SV5.1)', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    recordAoiScreenVisionEvent(
      root,
      SESSION_PATH,
      { summaryText: 'Editing an anti-cheat driver in the editor', appId: 'code' },
      NOW,
    );

    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'what is happening in code right now?',
      now: NOW + 1000,
    });
    const candidate = result.candidateSources.find((item) => item.sourceId === 'screen-vision');
    expect(candidate).toBeDefined();
    expect(candidate?.kind).toBe('screen_vision');
    expect(candidate?.scoreReasons).toContain('screen-vision-summary');
    expect(candidate?.scoreReasons).toContain('active-app-mentioned');
    expect(candidate?.scoreReasons).toContain('screen-fresh-window');
    expect(candidate?.redactionState).toBe('redacted');
  });

  it('yields no screen-vision candidate while the source is dark (fail-closed)', () => {
    const root = makeTempRoot();
    const result = buildAoiContextRouterResult({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      latestUserMessage: 'what am I doing?',
      now: NOW + 1000,
    });
    expect(result.candidateSources.some((item) => item.sourceId === 'screen-vision')).toBe(false);
  });
});
