import { describe, expect, it } from 'vitest';
import {
  buildAoiDecayApplyBody,
  parseAoiDecayApplyResponse,
  parseAoiDecayPreviewResponse,
  type AoiDecayCandidateView,
} from '../aoiMemoryDecayPanelModel';

function candidate(over: Partial<AoiDecayCandidateView> = {}): AoiDecayCandidateView {
  return {
    id: 'm1',
    contentPreview: 'an old fact',
    confidence: 0.2,
    hits: 1,
    ageMs: 100,
    reasons: ['stale'],
    ...over,
  };
}

describe('parseAoiDecayPreviewResponse (P4.1)', () => {
  it('parses an ok preview with candidates + fingerprint', () => {
    const parsed = parseAoiDecayPreviewResponse({
      ok: true,
      totalActive: 10,
      fingerprint: 'fp1',
      candidates: [candidate({ id: 'm1' })],
    });
    expect(parsed).toEqual({
      candidates: [candidate({ id: 'm1' })],
      fingerprint: 'fp1',
      totalActive: 10,
    });
  });

  it('drops candidates without an id and returns null when not ok / malformed', () => {
    const parsed = parseAoiDecayPreviewResponse({
      ok: true,
      fingerprint: 'fp',
      candidates: [{ contentPreview: 'no id' }],
    });
    expect(parsed?.candidates).toEqual([]);
    expect(parseAoiDecayPreviewResponse({ ok: false })).toBeNull();
    expect(parseAoiDecayPreviewResponse(null)).toBeNull();
    expect(parseAoiDecayPreviewResponse({ ok: true })).toBeNull();
  });
});

describe('buildAoiDecayApplyBody (P4.1)', () => {
  it('sends the exact reviewed id set paired with its fingerprint', () => {
    expect(
      buildAoiDecayApplyBody({
        candidates: [candidate({ id: 'a' }), candidate({ id: 'b' })],
        fingerprint: 'fp',
        totalActive: 2,
      }),
    ).toEqual({ ids: ['a', 'b'], approvalFingerprint: 'fp' });
  });
});

describe('parseAoiDecayApplyResponse (P4.1)', () => {
  it('parses a successful archive', () => {
    expect(
      parseAoiDecayApplyResponse({ ok: true, archivedCount: 2, changedIds: ['a', 'b'] }),
    ).toEqual({ rejected: false, archivedCount: 2, changedIds: ['a', 'b'] });
  });

  it('flags a fingerprint-drift 409 rejection', () => {
    expect(parseAoiDecayApplyResponse({ ok: false, rejected: true })).toEqual({
      rejected: true,
      archivedCount: 0,
      changedIds: [],
    });
  });

  it('returns null on a malformed payload', () => {
    expect(parseAoiDecayApplyResponse(null)).toBeNull();
  });
});
