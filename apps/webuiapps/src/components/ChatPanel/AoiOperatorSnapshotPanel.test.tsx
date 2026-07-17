import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AoiOperatorSnapshotPanel } from './AoiOperatorSnapshotPanel';

const SESSION_PATH = 'aoi/session-a';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

function okSummary(sessionPath = SESSION_PATH) {
  return {
    ok: true,
    sessionPath,
    summary: {
      version: 1,
      id: 'op',
      sessionPath,
      generatedAt: 1,
      topInterestLabels: ['anti-cheat'],
      readiness: 'supervised_prepare',
      interruption: 'dashboard',
      blindSpotCount: 1,
      actionAuthority: 'display_only',
      executeAllowed: false,
      summary: 'All calm.',
      evidenceRefs: [],
      cannotKnow: [],
      mutationCount: 0,
    },
  };
}

describe('AoiOperatorSnapshotPanel (P5.3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fetches and renders the display_only operator snapshot summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(okSummary())),
    );
    render(<AoiOperatorSnapshotPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-operator-snapshot-body')).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith(
      '/api/aoi-autonomy/operator/unified-snapshot?sessionPath=aoi%2Fsession-a',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(screen.getByText(`Session: ${SESSION_PATH}`)).toBeTruthy();
    expect(screen.getByText(/Readiness: supervised_prepare/)).toBeTruthy();
    expect(screen.getByText(/Authority: display_only/)).toBeTruthy();
    expect(screen.getByText(/anti-cheat/)).toBeTruthy();
  });

  it('surfaces an error when the fetch is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false)),
    );
    render(<AoiOperatorSnapshotPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByText(/Failed to load operator snapshot/)).toBeTruthy());
  });

  it('shows a no-snapshot message when the payload is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    render(<AoiOperatorSnapshotPanel sessionPath={SESSION_PATH} />);
    await waitFor(() =>
      expect(screen.getByText(/No session-matched operator snapshot available/)).toBeTruthy(),
    );
  });

  it('rejects a snapshot returned for another session', async () => {
    const payload = okSummary();
    payload.sessionPath = 'aoi/session-b';
    payload.summary.sessionPath = 'aoi/session-b';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(payload)),
    );
    render(<AoiOperatorSnapshotPanel sessionPath={SESSION_PATH} />);
    await waitFor(() =>
      expect(screen.getByText(/No session-matched operator snapshot available/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('aoi-operator-snapshot-body')).toBeNull();
  });

  it('never renders the previous session while a replacement request is pending', async () => {
    let resolveSessionB: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('session-b')) {
          return new Promise<Response>((resolve) => {
            resolveSessionB = resolve;
          });
        }
        return Promise.resolve(jsonResponse(okSummary()));
      }),
    );
    const { rerender } = render(<AoiOperatorSnapshotPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByText(`Session: ${SESSION_PATH}`)).toBeTruthy());
    rerender(<AoiOperatorSnapshotPanel sessionPath="aoi/session-b" />);
    expect(screen.queryByTestId('aoi-operator-snapshot-body')).toBeNull();
    resolveSessionB?.(jsonResponse(okSummary('aoi/session-b')));
    await waitFor(() => expect(screen.getByText('Session: aoi/session-b')).toBeTruthy());
  });
});
