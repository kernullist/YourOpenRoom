import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AoiOperatorSnapshotPanel } from './AoiOperatorSnapshotPanel';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

function okSummary() {
  return {
    ok: true,
    summary: {
      version: 1,
      id: 'op',
      sessionPath: 'aoi/default',
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
    render(<AoiOperatorSnapshotPanel />);
    await waitFor(() => expect(screen.getByTestId('aoi-operator-snapshot-body')).toBeTruthy());
    expect(screen.getByText(/Readiness: supervised_prepare/)).toBeTruthy();
    expect(screen.getByText(/Authority: display_only/)).toBeTruthy();
    expect(screen.getByText(/anti-cheat/)).toBeTruthy();
  });

  it('surfaces an error when the fetch is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false)),
    );
    render(<AoiOperatorSnapshotPanel />);
    await waitFor(() => expect(screen.getByText(/Failed to load operator snapshot/)).toBeTruthy());
  });

  it('shows a no-snapshot message when the payload is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })),
    );
    render(<AoiOperatorSnapshotPanel />);
    await waitFor(() => expect(screen.getByText(/No operator snapshot available/)).toBeTruthy());
  });
});
