import { describe, expect, it } from 'vitest';
import {
  parseAoiReadinessAccrualResponse,
  summarizeAoiReadinessAccrual,
} from '../aoiReadinessAccrualPanelModel';
import type { AoiProactiveTrendAdvisorReadiness } from '../aoiAutonomyTypes';

function readiness(
  over: Partial<AoiProactiveTrendAdvisorReadiness> = {},
): AoiProactiveTrendAdvisorReadiness {
  return {
    version: 1,
    status: 'measuring',
    sampleCount: 0,
    directChatReady: false,
    directChatBlockedReasons: [],
    summary: 'measuring',
    evidenceRefs: [],
    ...over,
  };
}

describe('parseAoiReadinessAccrualResponse (P5.4)', () => {
  it('returns the readiness for a well-formed ok payload', () => {
    const r = readiness({ status: 'ready' });
    expect(parseAoiReadinessAccrualResponse({ ok: true, readiness: r })).toEqual(r);
  });

  it('returns null when not ok, missing, or malformed', () => {
    expect(parseAoiReadinessAccrualResponse({ ok: false, readiness: readiness() })).toBeNull();
    expect(parseAoiReadinessAccrualResponse({ ok: true })).toBeNull();
    expect(parseAoiReadinessAccrualResponse({ ok: true, readiness: 'nope' })).toBeNull();
    expect(parseAoiReadinessAccrualResponse(null)).toBeNull();
  });
});

describe('summarizeAoiReadinessAccrual (P5.4)', () => {
  it('reads as accruing before the gate opens', () => {
    expect(
      summarizeAoiReadinessAccrual(
        readiness({ status: 'measuring', sampleCount: 3, directChatReady: false }),
      ),
    ).toBe('measuring | 3 field sample(s) | accruing');
  });

  it('reads as ready once the gate opens', () => {
    expect(
      summarizeAoiReadinessAccrual(
        readiness({ status: 'ready', sampleCount: 12, directChatReady: true }),
      ),
    ).toBe('ready | 12 field sample(s) | direct-chat READY');
  });
});
