import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AoiSituationPanel } from './AoiSituationPanel';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

function okSituation() {
  return {
    ok: true,
    stale: false,
    situation: {
      version: 1,
      id: 'situation-abc123',
      sessionPath: 'aoi/default',
      generatedAt: 1,
      staleAt: 2,
      headline: 'Debugging a failing validation; active app musicapp',
      segments: [
        {
          version: 1,
          kind: 'activity',
          label: 'Live app activity',
          summary: 'Live activity: active app=musicapp; events=2; last=1m ago.',
          freshness: 'fresh',
          salienceScore: 0.58,
          evidenceRefs: ['activity:aoi-activity-1'],
          cannotKnow: [],
        },
      ],
      focusItems: [
        {
          version: 1,
          title: 'Live app activity: active app=musicapp',
          sourceKind: 'app_activity',
          salienceScore: 0.58,
          evidenceRefs: ['activity:aoi-activity-1'],
        },
      ],
      intent: {
        version: 1,
        kind: 'media',
        label: 'Consuming music or video',
        confidence: 0.5,
        scoreReasons: [],
        evidenceRefs: ['activity:aoi-activity-1'],
        observedAt: 1,
      },
      confidence: 0.5,
      consentedSegmentCount: 1,
      evidenceRefs: ['activity:aoi-activity-1'],
      cannotKnow: ['Aoi cannot know the workspace state because no consented snapshot exists.'],
      actionAuthority: 'display_only',
      mutationCount: 0,
    },
  };
}

function okReadiness() {
  return {
    ok: true,
    scorecard: {
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 1,
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
    },
  };
}

function routeKeyedFetch(situationBody: unknown, readinessBody: unknown) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/cognition-readiness')) {
      return jsonResponse(readinessBody);
    }
    return jsonResponse(situationBody);
  });
}

describe('AoiSituationPanel (SA4.4)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fetches and renders the display_only situation brief with citations', async () => {
    const fetchMock = routeKeyedFetch(okSituation(), okReadiness());
    vi.stubGlobal('fetch', fetchMock);
    render(<AoiSituationPanel sessionPath="aoi/default" />);
    await waitFor(() => expect(screen.getByTestId('aoi-situation-panel-body')).toBeTruthy());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/aoi-autonomy/situation?sessionPath=aoi%2Fdefault',
    );
    expect(screen.getByText(/active app musicapp/)).toBeTruthy();
    expect(screen.getByText(/Intent: Consuming music or video/)).toBeTruthy();
    expect(screen.getByTestId('aoi-situation-focus-list').textContent).toContain(
      'activity:aoi-activity-1',
    );
    expect(screen.getByTestId('aoi-situation-cannot-know').textContent).toContain(
      'cannot know the workspace state',
    );
    // SA5.2: the grounding scorecard line renders alongside the brief.
    await waitFor(() =>
      expect(screen.getByTestId('aoi-cognition-readiness-line').textContent).toContain(
        'live_grounded (score 88, gate pass)',
      ),
    );
  });

  it('keeps the brief visible when the readiness fetch fails (best-effort line)', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/cognition-readiness')) {
        return jsonResponse({}, false);
      }
      return jsonResponse(okSituation());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AoiSituationPanel sessionPath="aoi/default" />);
    await waitFor(() => expect(screen.getByTestId('aoi-situation-panel-body')).toBeTruthy());
    expect(screen.queryByTestId('aoi-cognition-readiness-line')).toBeNull();
  });

  it('keeps the brief visible when the readiness fetch throws', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/cognition-readiness')) {
        throw new Error('network down');
      }
      return jsonResponse(okSituation());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AoiSituationPanel sessionPath="aoi/default" />);
    await waitFor(() => expect(screen.getByTestId('aoi-situation-panel-body')).toBeTruthy());
    expect(screen.queryByTestId('aoi-cognition-readiness-line')).toBeNull();
  });

  it('renders the empty state when no situation has been fused yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, situation: null, stale: null })),
    );
    render(<AoiSituationPanel sessionPath="aoi/default" />);
    await waitFor(() => expect(screen.getByText(/No situation brief yet/)).toBeTruthy());
  });

  it('surfaces an error when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false)),
    );
    render(<AoiSituationPanel sessionPath="aoi/default" />);
    await waitFor(() =>
      expect(screen.getByText(/Failed to load the situation brief/)).toBeTruthy(),
    );
  });

  it('reports a malformed payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    render(<AoiSituationPanel sessionPath="aoi/default" />);
    await waitFor(() => expect(screen.getByText(/Situation response was malformed/)).toBeTruthy());
  });
});
