import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { AoiRelationshipHistoryPanel } from './AoiRelationshipHistoryPanel';

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_END = Date.UTC(2026, 6, 29);

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

function retrospective(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'aoi-retro-1',
    sessionPath: 'aoi/default',
    periodStart: PERIOD_END - 7 * DAY,
    periodEnd: PERIOD_END,
    narrative: 'We worked together in 4 session(s) this period.',
    shipped: ['commit created: companion voice'],
    stuck: [],
    researched: [],
    milestones: [],
    openNext: ['Daemon restart soak'],
    sessionCount: 4,
    empty: false,
    evidenceRefs: ['commit:abc'],
    synthesizedBy: 'deterministic',
    actionAuthority: 'display_only',
    mutationCount: 0,
    createdAt: PERIOD_END,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AoiRelationshipHistoryPanel', () => {
  it('renders the latest week, its milestones, and earlier weeks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          retrospective: retrospective(),
          history: [
            retrospective(),
            retrospective({ id: 'aoi-retro-0', narrative: 'An earlier week.' }),
          ],
          milestones: [
            {
              id: 'trust_promoted:L4',
              kind: 'trust_promoted',
              label: 'Trust was raised to L4.',
              occurredAt: PERIOD_END - DAY,
            },
          ],
          firstMetAt: PERIOD_END - 200 * DAY,
          sessionCount: 42,
        }),
      ) as unknown as typeof fetch,
    );

    render(<AoiRelationshipHistoryPanel sessionPath="aoi/default" />);

    await waitFor(() => {
      expect(screen.getByTestId('aoi-relationship-history-body')).toBeTruthy();
    });
    expect(screen.getByTestId('aoi-relationship-history-latest').textContent).toContain(
      'We worked together in 4 session(s)',
    );
    expect(screen.getByTestId('aoi-relationship-history-milestones').textContent).toContain(
      'Trust was raised to L4.',
    );
    expect(screen.getByTestId('aoi-relationship-history-past').textContent).toContain(
      'An earlier week.',
    );
    expect(screen.queryByTestId('aoi-relationship-history-empty')).toBeNull();
  });

  it('shows an explicit empty state rather than implying a shared past', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          retrospective: null,
          history: [],
          milestones: [],
          firstMetAt: null,
          sessionCount: null,
        }),
      ) as unknown as typeof fetch,
    );

    render(<AoiRelationshipHistoryPanel sessionPath="aoi/default" />);

    await waitFor(() => {
      expect(screen.getByTestId('aoi-relationship-history-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('aoi-relationship-history-latest')).toBeNull();
  });

  it('reports a malformed payload instead of rendering a partial history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false })) as unknown as typeof fetch,
    );

    render(<AoiRelationshipHistoryPanel sessionPath="aoi/default" />);

    await waitFor(() => {
      expect(screen.getByText(/malformed/i)).toBeTruthy();
    });
    expect(screen.queryByTestId('aoi-relationship-history-body')).toBeNull();
  });

  it('surfaces a failed fetch without crashing the panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    );

    render(<AoiRelationshipHistoryPanel sessionPath="aoi/default" />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load the relationship history/i)).toBeTruthy();
    });
  });
});
