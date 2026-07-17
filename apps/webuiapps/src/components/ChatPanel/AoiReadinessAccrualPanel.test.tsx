import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AoiReadinessAccrualPanel } from './AoiReadinessAccrualPanel';

const SESSION_PATH = 'aoi/session-a';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function okReadiness(sessionPath = SESSION_PATH) {
  return {
    ok: true,
    sessionPath,
    readiness: {
      version: 1,
      status: 'measuring',
      sampleCount: 4,
      directChatReady: false,
      directChatBlockedReasons: ['field_evidence_missing'],
      summary: 'Accruing field evidence.',
      evidenceRefs: [],
    },
  };
}

describe('AoiReadinessAccrualPanel (P5.4)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fetches and renders the readiness accrual', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(okReadiness())),
    );
    render(<AoiReadinessAccrualPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-readiness-accrual-body')).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith(
      '/api/aoi-autonomy/operator/readiness-accrual?sessionPath=aoi%2Fsession-a',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(screen.getByText(`Session: ${SESSION_PATH}`)).toBeTruthy();
    expect(screen.getByText(/Field samples: 4/)).toBeTruthy();
    expect(screen.getByText(/Direct-chat ready: no/)).toBeTruthy();
    expect(screen.getByText(/field_evidence_missing/)).toBeTruthy();
  });

  it('surfaces an error when the fetch is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false)),
    );
    render(<AoiReadinessAccrualPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByText(/Failed to load readiness accrual/)).toBeTruthy());
  });

  it('shows a no-readiness message when the payload is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    render(<AoiReadinessAccrualPanel sessionPath={SESSION_PATH} />);
    await waitFor(() =>
      expect(screen.getByText(/No session-matched readiness accrual available/)).toBeTruthy(),
    );
  });

  it('rejects readiness returned for another session', async () => {
    const payload = okReadiness();
    payload.sessionPath = 'aoi/session-b';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(payload)),
    );
    render(<AoiReadinessAccrualPanel sessionPath={SESSION_PATH} />);
    await waitFor(() =>
      expect(screen.getByText(/No session-matched readiness accrual available/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('aoi-readiness-accrual-body')).toBeNull();
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
        return Promise.resolve(jsonResponse(okReadiness()));
      }),
    );
    const { rerender } = render(<AoiReadinessAccrualPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByText(`Session: ${SESSION_PATH}`)).toBeTruthy());
    rerender(<AoiReadinessAccrualPanel sessionPath="aoi/session-b" />);
    expect(screen.queryByTestId('aoi-readiness-accrual-body')).toBeNull();
    resolveSessionB?.(jsonResponse(okReadiness('aoi/session-b')));
    await waitFor(() => expect(screen.getByText('Session: aoi/session-b')).toBeTruthy());
  });
});
