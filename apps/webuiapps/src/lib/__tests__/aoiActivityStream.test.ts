import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AOI_ACTIVITY_FRESH_WINDOW_MS,
  AOI_ACTIVITY_SOURCE_ID,
  buildAoiActivityStreamSummary,
  checkAoiActivityStreamConsent,
  createAoiActivityObservations,
  describeAoiActivityStreamSummary,
  loadAoiActivityEvents,
  loadAoiActivityStreamSummary,
  normalizeAoiActivityEvent,
  pruneAoiActivityEvents,
  recordAoiActivityEvent,
  resolveAoiActivityStreamPaths,
} from '../aoiActivityStream';
import { loadAoiEnvironmentSourceRegistry, updateAoiEnvironmentSource } from '../aoiAutonomyStore';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-activity-stream-test-'));
  tempRoots.push(root);
  return root;
}

function consentActivitySource(root: string, now = NOW): void {
  updateAoiEnvironmentSource(root, SESSION_PATH, {
    sourceId: AOI_ACTIVITY_SOURCE_ID,
    patch: {
      enabled: true,
      consentReason: 'User enabled live activity awareness for this session.',
      lastReviewedAt: now,
    },
    now,
  });
}

function revokeActivitySource(root: string, now = NOW): void {
  updateAoiEnvironmentSource(root, SESSION_PATH, {
    sourceId: AOI_ACTIVITY_SOURCE_ID,
    patch: { enabled: false },
    now,
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi activity stream consent gate', () => {
  it('records nothing while the source is dark (default OFF)', () => {
    const root = makeTempRoot();

    const result = recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_opened', appId: 'musicapp' },
      NOW,
    );

    expect(result.recorded).toBe(false);
    expect(result.event).toBeNull();
    expect(result.reasons).toContain('source_disabled');
    expect(result.reasons).toContain('explicit_target_scope_required');
    const paths = resolveAoiActivityStreamPaths(root, SESSION_PATH);
    expect(fs.existsSync(paths.events)).toBe(false);
    expect(checkAoiActivityStreamConsent(root, SESSION_PATH, NOW).allowed).toBe(false);
  });

  it('hides already-captured events after consent is revoked (fail-closed read)', () => {
    const root = makeTempRoot();
    consentActivitySource(root);
    expect(
      recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW)
        .recorded,
    ).toBe(true);
    expect(loadAoiActivityEvents(root, SESSION_PATH, NOW)).toHaveLength(1);

    revokeActivitySource(root, NOW + 1000);

    expect(loadAoiActivityEvents(root, SESSION_PATH, NOW + 2000)).toHaveLength(0);
    const summary = loadAoiActivityStreamSummary(root, SESSION_PATH, NOW + 2000);
    expect(summary.consented).toBe(false);
    expect(summary.activeEventCount).toBe(0);
    expect(summary.cannotKnow.join(' ')).toContain('not consented');
  });
});

describe('Aoi activity stream metadata-only capture', () => {
  it('records normalized metadata and bumps the source lastObservedAt', () => {
    const root = makeTempRoot();
    consentActivitySource(root);

    const result = recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_action', appId: 'MusicApp', actionType: 'play_track' },
      NOW,
    );

    expect(result.recorded).toBe(true);
    expect(result.event).toMatchObject({
      version: 1,
      sessionPath: SESSION_PATH,
      kind: 'app_action',
      appId: 'musicapp',
      actionType: 'PLAY_TRACK',
      summary: 'app action: musicapp PLAY_TRACK.',
      privacyState: 'metadata_only',
      actionAuthority: 'display_only',
      mutationCount: 0,
      observedAt: NOW,
      expiresAt: NOW + 24 * HOUR_MS,
    });
    expect(result.event?.evidenceRefs).toContain(`environment-source:${AOI_ACTIVITY_SOURCE_ID}`);
    expect(result.event?.evidenceRefs).toContain('app:musicapp');

    const registry = loadAoiEnvironmentSourceRegistry(root, SESSION_PATH, NOW + 1);
    const source = registry.sources.find((item) => item.id === AOI_ACTIVITY_SOURCE_ID);
    expect(source?.lastObservedAt).toBe(NOW);
  });

  it('never persists caller free text, params, or content fields', () => {
    const root = makeTempRoot();
    consentActivitySource(root);

    const malicious = {
      kind: 'app_action',
      appId: 'notesapp',
      actionType: 'CREATE_NOTE',
      params: { body: 'secret diary body text' },
      content: 'password=hunter2',
      summary: 'attacker-controlled summary with C:\\Users\\secret\\path',
    } as Record<string, unknown>;
    const result = recordAoiActivityEvent(root, SESSION_PATH, malicious, NOW);

    expect(result.recorded).toBe(true);
    const paths = resolveAoiActivityStreamPaths(root, SESSION_PATH);
    const persisted = fs.readFileSync(paths.events, 'utf-8');
    expect(persisted).not.toContain('secret diary');
    expect(persisted).not.toContain('hunter2');
    expect(persisted).not.toContain('attacker-controlled');
    expect(persisted).not.toContain('C:\\\\Users');
    expect(result.event?.summary).toBe('app action: notesapp CREATE_NOTE.');
  });

  it('rejects invalid kinds and app ids fail-closed', () => {
    const root = makeTempRoot();
    consentActivitySource(root);

    expect(
      recordAoiActivityEvent(root, SESSION_PATH, { kind: 'keylog', appId: 'musicapp' }, NOW)
        .reasons,
    ).toContain('invalid_activity_kind');
    expect(
      recordAoiActivityEvent(
        root,
        SESSION_PATH,
        { kind: 'app_opened', appId: 'C:\\Users\\secret' },
        NOW,
      ).reasons,
    ).toContain('invalid_app_id');
    expect(loadAoiActivityEvents(root, SESSION_PATH, NOW)).toHaveLength(0);
  });

  it('drops malformed action types but keeps the action occurrence', () => {
    const { event, reasons } = normalizeAoiActivityEvent(
      { kind: 'app_action', appId: 'musicapp', actionType: 'play track!' },
      SESSION_PATH,
      NOW,
    );
    expect(reasons).toEqual([]);
    expect(event?.actionType).toBeNull();
    expect(event?.summary).toBe('app action: musicapp UNSPECIFIED_ACTION.');
  });

  it('accepts chat_turn without an app id', () => {
    const { event } = normalizeAoiActivityEvent({ kind: 'chat_turn' }, SESSION_PATH, NOW);
    expect(event).toMatchObject({
      kind: 'chat_turn',
      appId: null,
      summary: 'chat turn observed.',
    });
  });
});

describe('Aoi activity stream retention', () => {
  it('prunes expired events and compacts past the hard cap', () => {
    const root = makeTempRoot();
    consentActivitySource(root);

    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'oldapp' }, NOW);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_opened', appId: 'newapp' },
      NOW + 25 * HOUR_MS,
    );
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_focused', appId: 'newapp' },
      NOW + 25 * HOUR_MS + 1000,
    );

    const retained = pruneAoiActivityEvents(root, SESSION_PATH, NOW + 25 * HOUR_MS + 2000);
    expect(retained).toHaveLength(2);
    expect(retained.every((event) => event.appId === 'newapp')).toBe(true);

    const busyNow = NOW + 26 * HOUR_MS;
    for (let index = 0; index < 510; index += 1) {
      recordAoiActivityEvent(
        root,
        SESSION_PATH,
        { kind: 'app_action', appId: 'busyapp', actionType: 'TICK', observedAt: busyNow + index },
        busyNow,
      );
    }
    const paths = resolveAoiActivityStreamPaths(root, SESSION_PATH);
    const lineCount = fs.readFileSync(paths.events, 'utf-8').split(/\r?\n/).filter(Boolean).length;
    expect(lineCount).toBeLessThanOrEqual(500);
    const newest = loadAoiActivityEvents(root, SESSION_PATH, busyNow, 1)[0];
    expect(newest?.observedAt).toBe(busyNow + 509);
  });

  it('skips corrupt ledger lines instead of failing', () => {
    const root = makeTempRoot();
    consentActivitySource(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);
    const paths = resolveAoiActivityStreamPaths(root, SESSION_PATH);
    fs.appendFileSync(paths.events, 'not-json\n{"version":9}\n[1,2]\n', 'utf-8');

    const events = loadAoiActivityEvents(root, SESSION_PATH, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.appId).toBe('musicapp');
  });

  it('treats an unreadable ledger file as empty', () => {
    const root = makeTempRoot();
    consentActivitySource(root);
    const paths = resolveAoiActivityStreamPaths(root, SESSION_PATH);
    fs.mkdirSync(paths.events, { recursive: true });

    expect(loadAoiActivityEvents(root, SESSION_PATH, NOW)).toHaveLength(0);
  });

  it('rejects invalid session paths across the API surface', () => {
    const root = makeTempRoot();

    expect(() => resolveAoiActivityStreamPaths(root, '')).toThrow('sessionPath');
    expect(normalizeAoiActivityEvent({ kind: 'chat_turn' }, '', NOW).reasons).toContain(
      'invalid_session_path',
    );
    expect(checkAoiActivityStreamConsent(root, '', NOW).reasons).toContain('invalid_session_path');
    expect(() => loadAoiActivityEvents(root, '', NOW)).toThrow('sessionPath');
    expect(() => pruneAoiActivityEvents(root, '', NOW)).toThrow('sessionPath');
    expect(() => loadAoiActivityStreamSummary(root, '', NOW)).toThrow('sessionPath');
    expect(() => buildAoiActivityStreamSummary({ sessionPath: '', events: [], now: NOW })).toThrow(
      'sessionPath',
    );
  });
});

describe('Aoi activity stream summary', () => {
  it('infers the active app newest-first and counts kinds and apps', () => {
    const root = makeTempRoot();
    consentActivitySource(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_action', appId: 'musicapp', actionType: 'PLAY_TRACK', observedAt: NOW + 1000 },
      NOW + 1000,
    );
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_opened', appId: 'notesapp', observedAt: NOW + 2000 },
      NOW + 2000,
    );
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_closed', appId: 'notesapp', observedAt: NOW + 3000 },
      NOW + 3000,
    );
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'chat_turn', observedAt: NOW + 3500 },
      NOW + 3500,
    );

    const summary = loadAoiActivityStreamSummary(root, SESSION_PATH, NOW + 4000);
    expect(summary.consented).toBe(true);
    expect(summary.activeEventCount).toBe(5);
    expect(summary.activeAppId).toBe('musicapp');
    expect(summary.lastEventAt).toBe(NOW + 3500);
    expect(summary.lastEventAgeMs).toBe(500);
    expect(summary.kindCounts.chat_turn).toBe(1);
    expect(summary.kindCounts.app_action).toBe(1);
    expect(summary.kindCounts.app_opened).toBe(2);
    // Tie on eventCount (2:2) breaks by recency, so notesapp leads the ranking.
    expect(summary.appCounts[0]).toMatchObject({ appId: 'notesapp', eventCount: 2 });
    expect(summary.appCounts).toContainEqual(
      expect.objectContaining({ appId: 'musicapp', eventCount: 2 }),
    );
    expect(summary.evidenceRefs).toContain(`environment-source:${AOI_ACTIVITY_SOURCE_ID}`);
    expect(summary.evidenceRefs.some((ref) => ref.startsWith('activity:'))).toBe(true);
    expect(summary).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
      zeroMutation: true,
    });
  });

  it('explains an empty consented stream as a cannotKnow statement', () => {
    const summary = buildAoiActivityStreamSummary({
      sessionPath: SESSION_PATH,
      events: [],
      now: NOW,
    });
    expect(summary.activeAppId).toBeNull();
    expect(summary.cannotKnow.join(' ')).toContain('no live activity');
  });
});

describe('Aoi activity tick observations (SA1.4)', () => {
  function makeConsentedSummaryRoot(): string {
    const root = makeTempRoot();
    consentActivitySource(root);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      { kind: 'app_action', appId: 'musicapp', actionType: 'PLAY_TRACK', observedAt: NOW + 1000 },
      NOW + 1000,
    );
    return root;
  }

  it('derives one display-only observation from a live summary', () => {
    const root = makeConsentedSummaryRoot();
    const summary = loadAoiActivityStreamSummary(root, SESSION_PATH, NOW + 2000);

    const observations = createAoiActivityObservations({ summary, now: NOW + 2000 });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      version: 1,
      source: 'app',
      sessionPath: SESSION_PATH,
      createdAt: NOW + 1000,
      riskSignals: ['activity-signal'],
    });
    expect(observations[0]?.summary).toContain('active app=musicapp');
    expect(observations[0]?.dedupeKey).toBe(
      `activity:musicapp:${Math.floor((NOW + 1000) / AOI_ACTIVITY_FRESH_WINDOW_MS)}`,
    );
    expect(observations[0]?.artifactRefs).toContain(`environment-source:${AOI_ACTIVITY_SOURCE_ID}`);
  });

  it('dedupe key is stable within the fresh window so ticks do not re-observe', () => {
    const root = makeConsentedSummaryRoot();
    const summary = loadAoiActivityStreamSummary(root, SESSION_PATH, NOW + 2000);

    const first = createAoiActivityObservations({ summary, now: NOW + 2000 });
    const second = createAoiActivityObservations({ summary, now: NOW + 60_000 });
    expect(first[0]?.dedupeKey).toBe(second[0]?.dedupeKey);
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it('yields no observation for a dark or empty stream', () => {
    expect(
      createAoiActivityObservations({
        summary: buildAoiActivityStreamSummary({
          sessionPath: SESSION_PATH,
          events: [],
          consented: false,
          now: NOW,
        }),
        now: NOW,
      }),
    ).toEqual([]);
    expect(
      createAoiActivityObservations({
        summary: buildAoiActivityStreamSummary({ sessionPath: SESSION_PATH, events: [], now: NOW }),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('describes the stream from validated slugs only', () => {
    const root = makeConsentedSummaryRoot();
    const summary = loadAoiActivityStreamSummary(root, SESSION_PATH, NOW + 61_000);
    const line = describeAoiActivityStreamSummary(summary);
    expect(line).toContain('active app=musicapp');
    expect(line).toContain('events=2');
    expect(line).toContain('last=1m ago');
    expect(line).toContain('top=musicapp:2');
  });
});
