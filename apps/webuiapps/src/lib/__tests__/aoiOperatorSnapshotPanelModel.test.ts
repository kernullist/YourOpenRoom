import { describe, expect, it } from 'vitest';
import {
  buildAoiOperatorSnapshotRoute,
  parseAoiOperatorSnapshotResponse,
  summarizeAoiOperatorSnapshotHeadline,
} from '../aoiOperatorSnapshotPanelModel';
import type { AoiUnifiedOperatorSnapshotSummary } from '../aoiUnifiedOperatorModel';

const SESSION_PATH = 'aoi/session-a';

function summary(
  over: Partial<AoiUnifiedOperatorSnapshotSummary> = {},
): AoiUnifiedOperatorSnapshotSummary {
  return {
    version: 1,
    id: 'op-1',
    sessionPath: SESSION_PATH,
    generatedAt: 1,
    topInterestLabels: [],
    readiness: 'unknown',
    interruption: 'blocked',
    blindSpotCount: 0,
    actionAuthority: 'display_only',
    executeAllowed: false,
    summary: 'summary text',
    evidenceRefs: [],
    cannotKnow: [],
    mutationCount: 0,
    ...over,
  };
}

describe('parseAoiOperatorSnapshotResponse (P5.3)', () => {
  it('returns the summary for a well-formed ok payload', () => {
    const s = summary({ readiness: 'ready' });
    expect(
      parseAoiOperatorSnapshotResponse(
        { ok: true, sessionPath: SESSION_PATH, summary: s },
        SESSION_PATH,
      ),
    ).toEqual(s);
  });

  it('returns null when not ok, missing summary, or malformed', () => {
    expect(
      parseAoiOperatorSnapshotResponse(
        { ok: false, sessionPath: SESSION_PATH, summary: summary() },
        SESSION_PATH,
      ),
    ).toBeNull();
    expect(
      parseAoiOperatorSnapshotResponse({ ok: true, sessionPath: SESSION_PATH }, SESSION_PATH),
    ).toBeNull();
    expect(
      parseAoiOperatorSnapshotResponse(
        { ok: true, sessionPath: SESSION_PATH, summary: 'nope' },
        SESSION_PATH,
      ),
    ).toBeNull();
    expect(parseAoiOperatorSnapshotResponse(null, SESSION_PATH)).toBeNull();
    expect(parseAoiOperatorSnapshotResponse('not-an-object', SESSION_PATH)).toBeNull();
  });

  it('fails closed when either response session differs from the request', () => {
    expect(
      parseAoiOperatorSnapshotResponse(
        { ok: true, sessionPath: 'aoi/session-b', summary: summary() },
        SESSION_PATH,
      ),
    ).toBeNull();
    expect(
      parseAoiOperatorSnapshotResponse(
        {
          ok: true,
          sessionPath: SESSION_PATH,
          summary: summary({ sessionPath: 'aoi/session-b' }),
        },
        SESSION_PATH,
      ),
    ).toBeNull();
  });

  it('encodes the requested session in the route', () => {
    expect(buildAoiOperatorSnapshotRoute('aoi/session one')).toBe(
      '/api/aoi-autonomy/operator/unified-snapshot?sessionPath=aoi%2Fsession+one',
    );
  });
});

describe('summarizeAoiOperatorSnapshotHeadline (P5.3)', () => {
  it('renders a one-line headline from readiness / interruption / blind spots', () => {
    expect(
      summarizeAoiOperatorSnapshotHeadline(
        summary({ readiness: 'ready', interruption: 'dashboard', blindSpotCount: 2 }),
      ),
    ).toBe('Readiness ready | interruption dashboard | 2 blind spot(s)');
  });
});
