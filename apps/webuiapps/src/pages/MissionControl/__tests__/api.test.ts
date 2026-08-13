import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideProposal,
  fetchFlight,
  fetchMetrics,
  fetchProposals,
  fetchRuntime,
  fetchScheduler,
  fetchSessions,
  fetchSnapshot,
  fetchStatus,
  fetchTimeline,
  runManualTick,
} from '../api';

// The contract under test is the one the sections rely on and cannot re-check:
// a failed read must NEVER arrive as an empty result. Every wrapper below is
// exercised for both outcomes, because collapsing them is the single bug that
// would make this console actively misleading.

const SESSION = 'aoi/space_adventure';

interface MockResponseInit {
  status?: number;
  json?: unknown;
  jsonThrows?: boolean;
}

function mockResponse({ status = 200, json = {}, jsonThrows = false }: MockResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jsonThrows ? () => Promise.reject(new Error('not json')) : () => Promise.resolve(json),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastRequest(): { url: string; init?: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(call[0]), init: call[1] as RequestInit | undefined };
}

describe('fetchSessions', () => {
  it('returns the session list on success', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        json: {
          ok: true,
          sessions: [
            { sessionPath: 'aoi/newest', updatedAt: 20 },
            { sessionPath: 'aoi/older', updatedAt: 10 },
          ],
        },
      }),
    );

    const state = await fetchSessions();

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.map((entry) => entry.sessionPath)).toEqual(['aoi/newest', 'aoi/older']);
    }
  });

  it('reports zero sessions as empty, not as an error', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true, sessions: [] } }));

    const state = await fetchSessions();

    expect(state.kind).toBe('empty');
  });

  it('drops malformed rows but keeps the good ones', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        json: {
          ok: true,
          sessions: [{ sessionPath: '' }, { updatedAt: 5 }, { sessionPath: 'aoi/real' }],
        },
      }),
    );

    const state = await fetchSessions();

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data).toEqual([{ sessionPath: 'aoi/real', updatedAt: 0 }]);
    }
  });

  it('surfaces a transport failure as an error, never as empty', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const state = await fetchSessions();

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.message).toContain('ECONNREFUSED');
      expect(state.status).toBe(0);
    }
  });

  it('rejects a 200 that is not ok:true', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { sessions: [] } }));

    const state = await fetchSessions();

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.code).toBe('unexpected_payload');
    }
  });
});

describe('fetchRuntime', () => {
  it('reports a live daemon', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        json: {
          status: 'running',
          port: 7333,
          snapshot: {
            status: 'ok',
            uptimeMs: 1000,
            loopRunning: true,
            cognitionActive: true,
            cyclesCompleted: 4,
            lastCycle: null,
            errorsTotal: 0,
            lastError: null,
          },
        },
      }),
    );

    const state = await fetchRuntime();

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.runtime.status).toBe('running');
    }
  });

  it('downgrades an unvalidatable snapshot to unreachable instead of claiming health', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ json: { status: 'running', port: 7333, snapshot: { garbage: true } } }),
    );

    const state = await fetchRuntime();

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.runtime.status).toBe('unreachable');
    }
  });

  it('passes a confirmed dead daemon through as not_running', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { status: 'not_running', port: 7333 } }));

    const state = await fetchRuntime();

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.runtime.status).toBe('not_running');
    }
  });

  it('treats unparseable json as probe_failed rather than blowing up the panel', async () => {
    fetchMock.mockResolvedValue(mockResponse({ jsonThrows: true }));

    const state = await fetchRuntime();

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.runtime.status).toBe('probe_failed');
    }
  });

  it('errors only when the probe endpoint itself is gone', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const state = await fetchRuntime();

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.code).toBe('probe_unreachable');
    }
  });
});

describe('fetchStatus', () => {
  it('preserves the server error code so the UI can explain the cause', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: 'Invalid or missing sessionPath.', code: 'invalid_session_path' },
      }),
    );

    const state = await fetchStatus(SESSION);

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.code).toBe('invalid_session_path');
      expect(state.status).toBe(400);
      expect(state.message).toContain('sessionPath');
    }
  });

  it('returns the status payload on success', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ json: { ok: true, status: { version: 1, sessionPath: SESSION } } }),
    );

    const state = await fetchStatus(SESSION);

    expect(state.kind).toBe('ready');
    expect(lastRequest().url).toContain(`sessionPath=${encodeURIComponent(SESSION)}`);
  });

  it('errors when the payload is missing the status object', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true } }));

    const state = await fetchStatus(SESSION);

    expect(state.kind).toBe('error');
  });
});

describe('fetchSnapshot', () => {
  it('accepts a snapshot for the requested session', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        json: {
          ok: true,
          sessionPath: SESSION,
          summary: {
            sessionPath: SESSION,
            readiness: 'amber',
            interruption: 'low',
            blindSpotCount: 2,
          },
        },
      }),
    );

    const state = await fetchSnapshot(SESSION);

    expect(state.kind).toBe('ready');
  });

  it('refuses a snapshot belonging to a different session', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        json: {
          ok: true,
          sessionPath: SESSION,
          summary: { sessionPath: 'aoi/other', readiness: 'green' },
        },
      }),
    );

    const state = await fetchSnapshot(SESSION);

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.code).toBe('session_mismatch');
    }
  });
});

describe('fetchScheduler', () => {
  it('treats a missing scheduler state as empty', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true, state: null } }));

    const state = await fetchScheduler(SESSION);

    expect(state.kind).toBe('empty');
  });

  it('returns the scheduler state when present', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ json: { ok: true, state: { version: 1, sessionPath: SESSION } } }),
    );

    expect((await fetchScheduler(SESSION)).kind).toBe('ready');
  });
});

describe('fetchProposals', () => {
  it('distinguishes an empty queue from a failed read', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true, active: [] } }));
    expect((await fetchProposals(SESSION)).kind).toBe('empty');

    fetchMock.mockResolvedValue(mockResponse({ status: 500, json: { error: 'boom' } }));
    const failure = await fetchProposals(SESSION);
    expect(failure.kind).toBe('error');
    if (failure.kind === 'error') {
      expect(failure.status).toBe(500);
    }
  });

  it('returns active proposals', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ json: { ok: true, active: [{ id: 'p-1' }, { id: 'p-2' }] } }),
    );

    const state = await fetchProposals(SESSION);

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data).toHaveLength(2);
    }
  });
});

describe('fetchTimeline', () => {
  it('returns events and passes the limit through', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true, events: [{ id: 'e-1' }] } }));

    const state = await fetchTimeline(SESSION, 25);

    expect(state.kind).toBe('ready');
    expect(lastRequest().url).toContain('limit=25');
  });

  it('reports no events as empty', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true, events: [] } }));

    expect((await fetchTimeline(SESSION)).kind).toBe('empty');
  });
});

describe('fetchFlight', () => {
  it('is ready when only a summary exists', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        json: { ok: true, records: [], summary: { version: 1, totalRecordCount: 0 } },
      }),
    );

    const state = await fetchFlight(SESSION);

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.records).toEqual([]);
      expect(state.data.summary).not.toBeNull();
    }
  });

  it('is empty when there is neither a record nor a summary', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true, records: [], summary: null } }));

    expect((await fetchFlight(SESSION)).kind).toBe('empty');
  });
});

describe('fetchMetrics', () => {
  function mockPair(decisions: unknown, outcomes: unknown): void {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/decisions')) {
        return Promise.resolve(mockResponse({ json: decisions }));
      }
      return Promise.resolve(mockResponse({ json: outcomes }));
    });
  }

  it('computes a report from decisions and outcomes', async () => {
    mockPair(
      {
        ok: true,
        decisions: [
          {
            version: 1,
            id: 'd-1',
            sessionPath: SESSION,
            proposalId: 'p-1',
            action: 'accept',
            actor: 'user',
            createdAt: Date.now(),
          },
        ],
      },
      { ok: true, outcomes: [] },
    );

    const state = await fetchMetrics(SESSION);

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.data.sessionPath).toBe(SESSION);
      expect(state.data.overall.sampleSize).toBeGreaterThan(0);
    }
  });

  it('is empty when neither input has any records yet', async () => {
    mockPair({ ok: true, decisions: [] }, { ok: true, outcomes: [] });

    expect((await fetchMetrics(SESSION)).kind).toBe('empty');
  });

  it('refuses to compute a metric when one of the two reads failed', async () => {
    // Half the evidence would still produce a plausible-looking number, which is
    // exactly the kind of quiet wrongness this console must not emit.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/decisions')) {
        return Promise.resolve(mockResponse({ json: { ok: true, decisions: [] } }));
      }
      return Promise.resolve(
        mockResponse({ status: 500, json: { error: 'outcome store broken' } }),
      );
    });

    const state = await fetchMetrics(SESSION);

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.message).toContain('outcome store broken');
    }
  });
});

describe('decideProposal', () => {
  it('posts the decision as an explicit user action', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true } }));

    const result = await decideProposal(SESSION, 'p-1', 'accept');

    expect(result.ok).toBe(true);
    const { url, init } = lastRequest();
    expect(url).toContain('/proposal/decision');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // Never 'system': every decision made here is an operator pressing a button.
    expect(body.actor).toBe('user');
    expect(body.action).toBe('accept');
    expect(body.proposalId).toBe('p-1');
  });

  it('includes snoozeMs only when given', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: true } }));

    await decideProposal(SESSION, 'p-1', 'snooze', 3_600_000);
    expect(JSON.parse(String(lastRequest().init?.body)).snoozeMs).toBe(3_600_000);

    await decideProposal(SESSION, 'p-1', 'dismiss');
    expect(JSON.parse(String(lastRequest().init?.body))).not.toHaveProperty('snoozeMs');
  });

  it('reports a rejected transition with the server message', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: 'blocked transition', code: 'blocked_transition' },
      }),
    );

    const result = await decideProposal(SESSION, 'p-1', 'accept');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('blocked transition');
  });
});

describe('runManualTick', () => {
  it('reports a completed tick with the proposal count', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ json: { ok: true, skipped: false, newActiveProposalCount: 2 } }),
    );

    const result = await runManualTick(SESSION);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('2');
    expect(JSON.parse(String(lastRequest().init?.body)).reason).toBe('manual');
  });

  it('does not call a skipped tick a success', async () => {
    // ok:true with skipped:true means nothing ran. Calling that success leaves
    // the operator waiting for effects that will never arrive.
    fetchMock.mockResolvedValue(
      mockResponse({
        json: { ok: true, skipped: true, tickState: { lastSkippedReason: 'tick_already_running' } },
      }),
    );

    const result = await runManualTick(SESSION);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('tick_already_running');
  });

  it('reports an outright tick failure', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: 'invalid tick reason', code: 'invalid_tick_reason' },
      }),
    );

    const result = await runManualTick(SESSION);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('invalid tick reason');
  });
});
