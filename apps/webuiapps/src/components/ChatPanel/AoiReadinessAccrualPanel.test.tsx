import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AoiReadinessAccrualPanel } from './AoiReadinessAccrualPanel';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function okReadiness() {
  return {
    ok: true,
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
    render(<AoiReadinessAccrualPanel />);
    await waitFor(() => expect(screen.getByTestId('aoi-readiness-accrual-body')).toBeTruthy());
    expect(screen.getByText(/Field samples: 4/)).toBeTruthy();
    expect(screen.getByText(/Direct-chat ready: no/)).toBeTruthy();
    expect(screen.getByText(/field_evidence_missing/)).toBeTruthy();
  });

  it('surfaces an error when the fetch is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false)),
    );
    render(<AoiReadinessAccrualPanel />);
    await waitFor(() => expect(screen.getByText(/Failed to load readiness accrual/)).toBeTruthy());
  });

  it('shows a no-readiness message when the payload is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    render(<AoiReadinessAccrualPanel />);
    await waitFor(() => expect(screen.getByText(/No readiness accrual available/)).toBeTruthy());
  });
});
