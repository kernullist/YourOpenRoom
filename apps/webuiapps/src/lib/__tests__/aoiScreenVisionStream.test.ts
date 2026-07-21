// SV3.1 -- screen-vision ledger: consent-gated, redacted-at-boundary, bounded,
// no pixel field, fail-closed on read.
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AOI_SCREEN_VISION_SOURCE_ID,
  buildAoiScreenVisionStreamSummary,
  checkAoiScreenVisionStreamConsent,
  describeAoiScreenVisionStreamSummary,
  loadAoiScreenVisionEvents,
  loadAoiScreenVisionStreamSummary,
  normalizeAoiScreenVisionEvent,
  pruneAoiScreenVisionEvents,
  recordAoiScreenVisionEvent,
  resolveAoiScreenVisionStreamPaths,
  type AoiScreenVisionEvent,
} from '../aoiScreenVisionStream';
import { updateAoiEnvironmentSource } from '../aoiAutonomyStore';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-screen-vision-test-'));
  tempRoots.push(root);
  return root;
}

function consentScreenVision(root: string, now = NOW): void {
  updateAoiEnvironmentSource(root, SESSION_PATH, {
    sourceId: AOI_SCREEN_VISION_SOURCE_ID,
    patch: {
      enabled: true,
      consentReason: 'User enabled screen vision for this session.',
      lastReviewedAt: now,
    },
    now,
  });
}

function revokeScreenVision(root: string, now = NOW): void {
  updateAoiEnvironmentSource(root, SESSION_PATH, {
    sourceId: AOI_SCREEN_VISION_SOURCE_ID,
    patch: { enabled: false },
    now,
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('SV3.1 screen-vision consent gate', () => {
  it('records nothing while the source is dark (default OFF)', () => {
    const root = makeTempRoot();
    const result = recordAoiScreenVisionEvent(
      root,
      SESSION_PATH,
      { summaryText: 'editing code', appId: 'code' },
      NOW,
    );
    expect(result.recorded).toBe(false);
    expect(result.event).toBeNull();
    expect(result.reasons).toContain('source_disabled');
    const paths = resolveAoiScreenVisionStreamPaths(root, SESSION_PATH);
    expect(fs.existsSync(paths.events)).toBe(false);
    expect(checkAoiScreenVisionStreamConsent(root, SESSION_PATH, NOW).allowed).toBe(false);
  });

  it('hides already-captured summaries after consent is revoked (fail-closed read)', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    expect(
      recordAoiScreenVisionEvent(
        root,
        SESSION_PATH,
        { summaryText: 'editing code', appId: 'code' },
        NOW,
      ).recorded,
    ).toBe(true);
    expect(loadAoiScreenVisionEvents(root, SESSION_PATH, NOW)).toHaveLength(1);

    revokeScreenVision(root, NOW + 1000);

    expect(loadAoiScreenVisionEvents(root, SESSION_PATH, NOW + 2000)).toHaveLength(0);
    const summary = loadAoiScreenVisionStreamSummary(root, SESSION_PATH, NOW + 2000);
    expect(summary.consented).toBe(false);
    expect(summary.activeEventCount).toBe(0);
    expect(summary.cannotKnow.join(' ')).toContain('not consented');
  });
});

describe('SV3.1 redaction at the record boundary', () => {
  it('redacts secrets/emails/urls before storing and drops raw text', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    const result = recordAoiScreenVisionEvent(
      root,
      SESSION_PATH,
      {
        summaryText:
          'Reading gloryo@naver.com inbox at https://mail.example.com token sk-ABCDEF0123456789',
        details: ['password = hunter2super', 'reply drafted'],
        appId: 'mail',
        channel: 'local',
        modelId: 'local-vlm',
        confidence: 0.9,
      },
      NOW,
    );
    expect(result.recorded).toBe(true);
    const stored = result.event as AoiScreenVisionEvent;
    expect(stored.summaryText).toContain('[email]');
    expect(stored.summaryText).toContain('[url]');
    expect(stored.summaryText).not.toContain('sk-ABCDEF0123456789');
    expect(stored.details.join(' ')).not.toContain('hunter2super');
    expect(stored.details).toContain('reply drafted');
    // Persisted bytes on disk carry no raw secret either.
    const paths = resolveAoiScreenVisionStreamPaths(root, SESSION_PATH);
    const onDisk = fs.readFileSync(paths.events, 'utf-8');
    expect(onDisk).not.toContain('sk-ABCDEF0123456789');
    expect(onDisk).not.toContain('gloryo@naver.com');
  });

  it('rejects an event whose summary is empty after redaction', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    const result = recordAoiScreenVisionEvent(root, SESSION_PATH, { summaryText: '   ' }, NOW);
    expect(result.recorded).toBe(false);
    expect(result.reasons).toContain('empty_summary');
  });
});

describe('SV3.1 event shape + normalization', () => {
  it('has no pixel/image field and carries display-only zero-mutation metadata', () => {
    const { event } = normalizeAoiScreenVisionEvent(
      { summaryText: 'editing code', appId: 'code', channel: 'cloud', modelId: 'gpt-vision' },
      SESSION_PATH,
      NOW,
    );
    expect(event).not.toBeNull();
    const keys = Object.keys(event as AoiScreenVisionEvent);
    expect(keys).not.toContain('image');
    expect(keys).not.toContain('pixels');
    expect(keys).not.toContain('frame');
    expect(keys).not.toContain('screenshot');
    expect((event as AoiScreenVisionEvent).privacyState).toBe('redacted_summary');
    expect((event as AoiScreenVisionEvent).actionAuthority).toBe('display_only');
    expect((event as AoiScreenVisionEvent).mutationCount).toBe(0);
    expect((event as AoiScreenVisionEvent).channel).toBe('cloud');
    expect((event as AoiScreenVisionEvent).evidenceRefs).toContain('app:code');
  });

  it('defaults an unknown channel to local, drops a bad appId, and clamps confidence', () => {
    const { event } = normalizeAoiScreenVisionEvent(
      { summaryText: 'browsing', appId: 'bad id!', channel: 'satellite', confidence: 5 },
      SESSION_PATH,
      NOW,
    );
    expect(event?.channel).toBe('local');
    expect(event?.appId).toBeNull();
    expect(event?.confidence).toBe(1);
    expect(event?.modelId).toBe('unknown');
  });

  it('rejects an invalid session path', () => {
    const { event, reasons } = normalizeAoiScreenVisionEvent(
      { summaryText: 'x' },
      '../escape',
      NOW,
    );
    expect(event).toBeNull();
    expect(reasons).toContain('invalid_session_path');
  });
});

describe('SV3.1 summary + retention', () => {
  it('summarizes channel counts, active app, latest text, and screen: evidence refs', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    recordAoiScreenVisionEvent(root, SESSION_PATH, { summaryText: 'older', appId: 'code' }, NOW);
    recordAoiScreenVisionEvent(
      root,
      SESSION_PATH,
      { summaryText: 'watching a talk', appId: 'browser', channel: 'cloud' },
      NOW + 1000,
    );
    const summary = loadAoiScreenVisionStreamSummary(root, SESSION_PATH, NOW + 2000);
    expect(summary.consented).toBe(true);
    expect(summary.activeEventCount).toBe(2);
    expect(summary.activeAppId).toBe('browser');
    expect(summary.latestSummaryText).toBe('watching a talk');
    expect(summary.channelCounts.local).toBe(1);
    expect(summary.channelCounts.cloud).toBe(1);
    expect(summary.evidenceRefs.some((ref) => ref.startsWith('screen:'))).toBe(true);
    // Always-present structural honesty.
    expect(summary.cannotKnow.join(' ')).toContain('raw screen pixels');
    expect(describeAoiScreenVisionStreamSummary(summary)).toContain('active app=browser');
  });

  it('drops events past their TTL from the active view and prunes them', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    recordAoiScreenVisionEvent(
      root,
      SESSION_PATH,
      { summaryText: 'old frame', appId: 'code' },
      NOW,
    );
    // 3h later: past the 2h TTL.
    const later = NOW + 3 * HOUR_MS;
    const summary = loadAoiScreenVisionStreamSummary(root, SESSION_PATH, later);
    expect(summary.activeEventCount).toBe(0);
    expect(summary.expiredEventCount).toBe(1);
    expect(summary.cannotKnow.join(' ')).toContain('no screen summary');

    const retained = pruneAoiScreenVisionEvents(root, SESSION_PATH, later);
    expect(retained).toHaveLength(0);
  });

  it('builds a dark summary when not consented', () => {
    const summary = buildAoiScreenVisionStreamSummary({
      sessionPath: SESSION_PATH,
      events: [],
      consented: false,
      consentReasons: ['source_disabled'],
      now: NOW,
    });
    expect(summary.consented).toBe(false);
    expect(summary.latestSummaryText).toBeNull();
    expect(summary.cannotKnow.join(' ')).toContain('not consented');
  });

  it('caps details to the maximum and drops empty ones', () => {
    const { event } = normalizeAoiScreenVisionEvent(
      {
        summaryText: 'coding',
        details: ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      },
      SESSION_PATH,
      NOW,
    );
    expect(event?.details).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('respects the load limit', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    recordAoiScreenVisionEvent(root, SESSION_PATH, { summaryText: 'one' }, NOW);
    recordAoiScreenVisionEvent(root, SESSION_PATH, { summaryText: 'two' }, NOW + 1000);
    expect(loadAoiScreenVisionEvents(root, SESSION_PATH, NOW + 2000, 1)).toHaveLength(1);
  });

  it('compacts the ledger to the hard cap', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    for (let index = 0; index < 205; index += 1) {
      recordAoiScreenVisionEvent(
        root,
        SESSION_PATH,
        { summaryText: `frame ${index}` },
        NOW + index,
      );
    }
    expect(
      loadAoiScreenVisionEvents(root, SESSION_PATH, NOW + 205, 500).length,
    ).toBeLessThanOrEqual(200);
  });

  it('skips corrupt and stale-version lines on read', () => {
    const root = makeTempRoot();
    consentScreenVision(root);
    recordAoiScreenVisionEvent(root, SESSION_PATH, { summaryText: 'valid frame' }, NOW);
    const paths = resolveAoiScreenVisionStreamPaths(root, SESSION_PATH);
    fs.appendFileSync(paths.events, 'not-json\n', 'utf-8');
    fs.appendFileSync(
      paths.events,
      `${JSON.stringify({ version: 2, observedAt: NOW })}\n`,
      'utf-8',
    );
    const events = loadAoiScreenVisionEvents(root, SESSION_PATH, NOW + 1000);
    expect(events).toHaveLength(1);
    expect(events[0].summaryText).toBe('valid frame');
  });

  it('throws on an invalid session path and fails consent closed', () => {
    const root = makeTempRoot();
    expect(() => resolveAoiScreenVisionStreamPaths(root, '../escape')).toThrow();
    expect(() => loadAoiScreenVisionEvents(root, '../escape', NOW)).toThrow();
    expect(() => loadAoiScreenVisionStreamSummary(root, '../escape', NOW)).toThrow();
    expect(() => pruneAoiScreenVisionEvents(root, '../escape', NOW)).toThrow();
    expect(checkAoiScreenVisionStreamConsent(root, '../escape', NOW)).toMatchObject({
      allowed: false,
      reasons: ['invalid_session_path'],
    });
  });
});
