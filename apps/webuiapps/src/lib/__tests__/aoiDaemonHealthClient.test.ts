// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  loadAoiDaemonHealthSnapshot,
  normalizeAoiDaemonHealthSnapshot,
} from '../aoiDaemonHealthClient';

function makeHealth() {
  return {
    status: 'ok',
    uptimeMs: 10_000,
    loopRunning: true,
    cognitionActive: true,
    cyclesCompleted: 4,
    lastCycle: {
      startedAt: 9_000,
      durationMs: 100,
      sessionsConsidered: 1,
      sessionsRun: 1,
      sessionsSkipped: 0,
      errorCount: 0,
    },
    errorsTotal: 0,
    lastError: null,
  };
}

describe('Aoi daemon health client', () => {
  it('accepts the complete metadata-only daemon health shape', () => {
    expect(normalizeAoiDaemonHealthSnapshot(makeHealth())).toEqual(makeHealth());
  });

  it('rejects incomplete nested cycle and error shapes', () => {
    expect(
      normalizeAoiDaemonHealthSnapshot({ ...makeHealth(), lastCycle: { startedAt: 1 } }),
    ).toBeNull();
    expect(normalizeAoiDaemonHealthSnapshot({ ...makeHealth(), lastError: { at: 1 } })).toBeNull();
  });

  it('rejects non-loopback URLs before making a request', async () => {
    const fetchMock = vi.fn();
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(
      loadAoiDaemonHealthSnapshot('https://example.com/healthz', fetchImpl),
    ).rejects.toThrow('loopback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads and validates a loopback health response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(makeHealth()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    await expect(
      loadAoiDaemonHealthSnapshot('http://127.0.0.1:7333/healthz', fetchImpl),
    ).resolves.toEqual(makeHealth());
  });

  it('returns unavailable for loopback transport, status, or payload failures', async () => {
    const unavailable = [
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
      vi.fn(async () => new Response('offline', { status: 503 })),
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    ];
    for (const fetchMock of unavailable) {
      await expect(
        loadAoiDaemonHealthSnapshot(
          'http://127.0.0.1:7333/healthz',
          fetchMock as unknown as typeof fetch,
        ),
      ).resolves.toBeNull();
    }
  });
});
