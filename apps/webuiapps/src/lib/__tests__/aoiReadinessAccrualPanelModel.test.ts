import { describe, expect, it } from 'vitest';
import {
  buildAoiReadinessAccrualRoute,
  parseAoiReadinessAccrualResponse,
  summarizeAoiReadinessAccrual,
} from '../aoiReadinessAccrualPanelModel';
import type { AoiProactiveTrendAdvisorReadiness } from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/session-a';

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
    expect(
      parseAoiReadinessAccrualResponse(
        { ok: true, sessionPath: SESSION_PATH, readiness: r },
        SESSION_PATH,
      ),
    ).toEqual(r);
  });

  it('returns null when not ok, missing, or malformed', () => {
    expect(
      parseAoiReadinessAccrualResponse(
        { ok: false, sessionPath: SESSION_PATH, readiness: readiness() },
        SESSION_PATH,
      ),
    ).toBeNull();
    expect(
      parseAoiReadinessAccrualResponse({ ok: true, sessionPath: SESSION_PATH }, SESSION_PATH),
    ).toBeNull();
    expect(
      parseAoiReadinessAccrualResponse(
        { ok: true, sessionPath: SESSION_PATH, readiness: 'nope' },
        SESSION_PATH,
      ),
    ).toBeNull();
    expect(parseAoiReadinessAccrualResponse(null, SESSION_PATH)).toBeNull();
  });

  it('fails closed when the returned session differs from the request', () => {
    expect(
      parseAoiReadinessAccrualResponse(
        { ok: true, sessionPath: 'aoi/session-b', readiness: readiness() },
        SESSION_PATH,
      ),
    ).toBeNull();
  });

  it('encodes the requested session in the route', () => {
    expect(buildAoiReadinessAccrualRoute('aoi/session one')).toBe(
      '/api/aoi-autonomy/operator/readiness-accrual?sessionPath=aoi%2Fsession+one',
    );
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
