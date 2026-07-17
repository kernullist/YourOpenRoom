import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AoiMemoryDecayPanel } from './AoiMemoryDecayPanel';

const SESSION_PATH = 'aoi/session-a';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const PREVIEW_BODY = {
  ok: true,
  totalActive: 5,
  fingerprint: 'fp-1',
  candidates: [
    {
      id: 'm1',
      contentPreview: 'an old low-confidence fact',
      confidence: 0.2,
      hits: 1,
      ageMs: 1,
      reasons: ['stale'],
    },
  ],
};

// Route the mocked fetch by URL + method so preview / apply / restore each get their own body.
function stubFetch(handlers: Record<string, () => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: unknown) => {
      const method = (init as { method?: string } | undefined)?.method ?? 'GET';
      const key = `${method} ${String(input)}`;
      const handler = handlers[key];
      return Promise.resolve(handler ? handler() : jsonResponse({}, false));
    }),
  );
}

describe('AoiMemoryDecayPanel (P4.1)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the archive candidates from the decay preview', async () => {
    stubFetch({ 'GET /api/aoi-autonomy/memory/decay-preview': () => jsonResponse(PREVIEW_BODY) });
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-preview')).toBeTruthy());
    expect(screen.getByText(/1 archive candidate\(s\) of 5 active/)).toBeTruthy();
    expect(screen.getByText(/an old low-confidence fact/)).toBeTruthy();
    expect(screen.getByTestId('aoi-memory-decay-archive-btn')).toBeTruthy();
  });

  it('archives the reviewed set and then offers restore', async () => {
    stubFetch({
      'GET /api/aoi-autonomy/memory/decay-preview': () => jsonResponse(PREVIEW_BODY),
      'POST /api/aoi-autonomy/memory/decay-apply': () =>
        jsonResponse({
          ok: true,
          sessionPath: SESSION_PATH,
          archivedCount: 1,
          changedIds: ['m1'],
        }),
    });
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-archive-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-archive-btn'));
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-applied')).toBeTruthy());
    expect(screen.getByText(/Archived 1 memory\(ies\)/)).toBeTruthy();
    expect(screen.getByTestId('aoi-memory-decay-restore-btn')).toBeTruthy();
    const applyCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(applyCall?.[1]?.body))).toMatchObject({ sessionPath: SESSION_PATH });
  });

  it('surfaces a content-addressed drift rejection without archiving', async () => {
    stubFetch({
      'GET /api/aoi-autonomy/memory/decay-preview': () => jsonResponse(PREVIEW_BODY),
      'POST /api/aoi-autonomy/memory/decay-apply': () =>
        jsonResponse(
          {
            ok: false,
            sessionPath: SESSION_PATH,
            rejected: true,
            code: 'decay_approval_mismatch',
          },
          false,
        ),
    });
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-archive-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-archive-btn'));
    await waitFor(() => expect(screen.getByText(/reviewed set drifted/)).toBeTruthy());
    // Nothing was archived -> no applied block.
    expect(screen.queryByTestId('aoi-memory-decay-applied')).toBeNull();
  });

  it('shows an error when the preview fetch fails', async () => {
    stubFetch({});
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByText(/Failed to load decay preview/)).toBeTruthy());
  });

  it('restores archived memories and reloads the (now-empty) preview', async () => {
    let previewCalls = 0;
    stubFetch({
      'GET /api/aoi-autonomy/memory/decay-preview': () => {
        previewCalls += 1;
        return jsonResponse(
          previewCalls === 1
            ? PREVIEW_BODY
            : { ok: true, totalActive: 5, fingerprint: 'fp-2', candidates: [] },
        );
      },
      'POST /api/aoi-autonomy/memory/decay-apply': () =>
        jsonResponse({
          ok: true,
          sessionPath: SESSION_PATH,
          archivedCount: 1,
          changedIds: ['m1'],
        }),
      'POST /api/aoi-autonomy/memory/decay-restore': () => jsonResponse({ ok: true }),
    });
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-archive-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-archive-btn'));
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-restore-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-restore-btn'));
    // After restore the applied block is gone and the preview was reloaded.
    await waitFor(() => expect(screen.queryByTestId('aoi-memory-decay-applied')).toBeNull());
    expect(previewCalls).toBe(2);
    const restoreCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input).includes('decay-restore'));
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toMatchObject({ sessionPath: SESSION_PATH });
  });

  it('reports an unexpected (unparseable) archive response without archiving', async () => {
    stubFetch({
      'GET /api/aoi-autonomy/memory/decay-preview': () => jsonResponse(PREVIEW_BODY),
      'POST /api/aoi-autonomy/memory/decay-apply': () => jsonResponse(null),
    });
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-archive-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-archive-btn'));
    await waitFor(() => expect(screen.getByText(/unexpected response/)).toBeTruthy());
    expect(screen.queryByTestId('aoi-memory-decay-applied')).toBeNull();
  });

  it('surfaces a restore failure', async () => {
    stubFetch({
      'GET /api/aoi-autonomy/memory/decay-preview': () => jsonResponse(PREVIEW_BODY),
      'POST /api/aoi-autonomy/memory/decay-apply': () =>
        jsonResponse({
          ok: true,
          sessionPath: SESSION_PATH,
          archivedCount: 1,
          changedIds: ['m1'],
        }),
      'POST /api/aoi-autonomy/memory/decay-restore': () => jsonResponse({}, false),
    });
    render(<AoiMemoryDecayPanel sessionPath={SESSION_PATH} />);
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-archive-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-archive-btn'));
    await waitFor(() => expect(screen.getByTestId('aoi-memory-decay-restore-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('aoi-memory-decay-restore-btn'));
    await waitFor(() => expect(screen.getByText(/Restore failed/)).toBeTruthy());
  });
});
