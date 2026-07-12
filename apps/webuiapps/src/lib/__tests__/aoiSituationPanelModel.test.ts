import { describe, expect, it } from 'vitest';
import {
  buildAoiCognitionReadinessRoute,
  buildAoiSituationPanelViewModel,
  buildAoiSituationRoute,
  parseAoiCognitionReadinessResponse,
  parseAoiSituationResponse,
  summarizeAoiCognitionReadinessLine,
} from '../aoiSituationPanelModel';
import { buildAoiCurrentSituation } from '../aoiCurrentSituationModel';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function makeSituation() {
  return buildAoiCurrentSituation({
    sessionPath: SESSION_PATH,
    now: NOW,
    mission: {
      version: 1,
      sessionPath: SESSION_PATH,
      status: 'active',
      activeGoalId: 'goal-1',
      focusSummary: 'Harden the kernel telemetry path',
      waitingOn: 'none',
      nextRecommendedAction: 'continue',
      evidenceRefs: ['proposal:p-1'],
      sourceRefs: {},
      transitions: [],
      createdAt: NOW - 1000,
      updatedAt: NOW,
    } as never,
  });
}

describe('aoiSituationPanelModel', () => {
  it('builds the session-scoped route', () => {
    expect(buildAoiSituationRoute('aoi/default')).toBe(
      '/api/aoi-autonomy/situation?sessionPath=aoi%2Fdefault',
    );
  });

  it('parses a served situation and projects the view model', () => {
    const situation = makeSituation();
    const parsed = parseAoiSituationResponse({ ok: true, situation, stale: false });
    expect(parsed?.situation?.id).toBe(situation.id);

    const view = buildAoiSituationPanelViewModel(parsed!);
    expect(view.hasSituation).toBe(true);
    expect(view.stateLabel).toBe('current');
    expect(view.headline.length).toBeGreaterThan(0);
    expect(view.focusRows.length).toBeGreaterThan(0);
    expect(view.focusRows[0].evidenceLabel).toContain('proposal:p-1');
    expect(view.evidenceCount).toBeGreaterThan(0);
  });

  it('treats a missing situation as a valid empty state', () => {
    const parsed = parseAoiSituationResponse({ ok: true, situation: null, stale: null });
    expect(parsed).toEqual({ situation: null, stale: false });
    const view = buildAoiSituationPanelViewModel(parsed!);
    expect(view.hasSituation).toBe(false);
    expect(view.headline).toContain('No situation brief yet');
  });

  it('marks a stale situation explicitly', () => {
    const parsed = parseAoiSituationResponse({ ok: true, situation: makeSituation(), stale: true });
    expect(buildAoiSituationPanelViewModel(parsed!).stateLabel).toBe('stale');
  });

  it('parses and summarizes the cognition-readiness scorecard (SA5.2)', () => {
    const scorecard = {
      version: 1,
      sessionPath: SESSION_PATH,
      generatedAt: NOW,
      score: 88,
      level: 'live_grounded',
      gateStatus: 'pass',
      canSupportPromotion: true,
      metrics: [],
      gates: [],
      recommendations: [],
      evidenceRefs: [],
      cannotKnow: [],
      actionAuthority: 'display_only',
      mutationCount: 0,
    };
    expect(buildAoiCognitionReadinessRoute('aoi/default')).toBe(
      '/api/aoi-autonomy/cognition-readiness?sessionPath=aoi%2Fdefault',
    );
    const parsed = parseAoiCognitionReadinessResponse({ ok: true, scorecard });
    expect(parsed?.score).toBe(88);
    expect(summarizeAoiCognitionReadinessLine(parsed!)).toBe(
      'Cognition readiness: live_grounded (score 88, gate pass)',
    );
    expect(parseAoiCognitionReadinessResponse({ ok: false, scorecard })).toBeNull();
    expect(
      parseAoiCognitionReadinessResponse({
        ok: true,
        scorecard: { ...scorecard, actionAuthority: 'execute' },
      }),
    ).toBeNull();
    expect(parseAoiCognitionReadinessResponse(null)).toBeNull();
  });

  it('rejects malformed payloads fail-closed', () => {
    expect(parseAoiSituationResponse(null)).toBeNull();
    expect(parseAoiSituationResponse('nope')).toBeNull();
    expect(parseAoiSituationResponse({ ok: false })).toBeNull();
    expect(
      parseAoiSituationResponse({
        ok: true,
        situation: { version: 1, actionAuthority: 'execute', segments: [] },
      }),
    ).toBeNull();
    expect(
      parseAoiSituationResponse({
        ok: true,
        situation: { version: 2, actionAuthority: 'display_only', segments: [] },
      }),
    ).toBeNull();
  });
});
