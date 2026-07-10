import { describe, expect, it } from 'vitest';
import {
  parseAoiOperatorSnapshotResponse,
  summarizeAoiOperatorSnapshotHeadline,
} from '../aoiOperatorSnapshotPanelModel';
import type { AoiUnifiedOperatorSnapshotSummary } from '../aoiUnifiedOperatorModel';

function summary(
  over: Partial<AoiUnifiedOperatorSnapshotSummary> = {},
): AoiUnifiedOperatorSnapshotSummary {
  return {
    version: 1,
    id: 'op-1',
    sessionPath: 'aoi/default',
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
    expect(parseAoiOperatorSnapshotResponse({ ok: true, summary: s })).toEqual(s);
  });

  it('returns null when not ok, missing summary, or malformed', () => {
    expect(parseAoiOperatorSnapshotResponse({ ok: false, summary: summary() })).toBeNull();
    expect(parseAoiOperatorSnapshotResponse({ ok: true })).toBeNull();
    expect(parseAoiOperatorSnapshotResponse({ ok: true, summary: 'nope' })).toBeNull();
    expect(parseAoiOperatorSnapshotResponse(null)).toBeNull();
    expect(parseAoiOperatorSnapshotResponse('not-an-object')).toBeNull();
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
