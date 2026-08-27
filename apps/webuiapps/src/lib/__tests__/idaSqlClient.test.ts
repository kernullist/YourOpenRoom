import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachIdaSqlGuiSession,
  browseIdaSqlPath,
  createIdaSqlGrant,
  deleteIdaSqlGrant,
  fetchIdaSqlConfig,
  fetchIdaSqlGrants,
  fetchIdaSqlGuiWindow,
  fetchIdaSqlHealth,
  fetchIdaSqlSessionOutput,
  fetchIdaSqlSessions,
  findIdaSqlBinaries,
  previewIdaSqlSession,
  runIdaSqlApproval,
  runIdaSqlQuery,
  saveIdaSqlConfigPatch,
  stopIdaSqlSession,
} from '../idaSqlClient';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

const recorded: Recorded[] = [];
let nextResponse: { status: number; payload: unknown } = { status: 200, payload: { ok: true } };

const originalFetch = globalThis.fetch;

beforeEach(() => {
  recorded.length = 0;
  nextResponse = { status: 200, payload: { ok: true } };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return {
      status: nextResponse.status,
      json: async () => nextResponse.payload,
    } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('idaSqlClient error shaping', () => {
  it('throws with the error code, the deny reasons and the detail', async () => {
    nextResponse = {
      status: 403,
      payload: {
        ok: false,
        error: 'capability_disabled',
        denyReasons: ['capability_disabled'],
        detail: 'capability_disabled:os_ida_analysis',
      },
    };
    await expect(fetchIdaSqlSessions()).rejects.toThrow(
      /capability_disabled \[capability_disabled\]: capability_disabled:os_ida_analysis/,
    );
  });

  it('falls back to the HTTP status when no error code is given', async () => {
    nextResponse = { status: 500, payload: { ok: false } };
    await expect(fetchIdaSqlHealth()).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the body is not an envelope at all', async () => {
    nextResponse = { status: 200, payload: 'nope' };
    await expect(fetchIdaSqlConfig()).rejects.toThrow(/ida-sql request failed/);
  });
});

describe('idaSqlClient requests', () => {
  it('reads health, config, sessions and grants over GET', async () => {
    nextResponse = { status: 200, payload: { ok: true, health: { configured: true } } };
    await fetchIdaSqlHealth();
    nextResponse = { status: 200, payload: { ok: true, config: { writeEnabled: false } } };
    await fetchIdaSqlConfig();
    nextResponse = { status: 200, payload: { ok: true, sessions: [{ id: 'ida-1' }] } };
    expect(await fetchIdaSqlSessions()).toHaveLength(1);
    nextResponse = { status: 200, payload: { ok: true, grants: [] } };
    expect(await fetchIdaSqlGrants()).toEqual([]);
    expect(recorded.map((entry) => entry.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(recorded[0].url).toContain('/api/ida-sql/health');
  });

  it('defaults an empty session list when the field is absent', async () => {
    nextResponse = { status: 200, payload: { ok: true } };
    expect(await fetchIdaSqlSessions()).toEqual([]);
  });

  it('sends a config patch as POST', async () => {
    nextResponse = { status: 200, payload: { ok: true, config: { writeEnabled: true } } };
    await saveIdaSqlConfigPatch({ writeEnabled: true });
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].body).toEqual({ writeEnabled: true });
  });

  it('omits the path parameter when browsing the roots', async () => {
    nextResponse = { status: 200, payload: { ok: true, browse: { entries: [] } } };
    await browseIdaSqlPath('');
    expect(recorded[0].url).toBe('/api/ida-sql/browse');
  });

  it('passes find, path and depth when searching', async () => {
    nextResponse = { status: 200, payload: { ok: true, browse: { entries: [] } } };
    await findIdaSqlBinaries({ find: 'tavern', path: 'F:\\games', depth: 4 });
    expect(recorded[0].url).toContain('find=tavern');
    expect(recorded[0].url).toContain('depth=4');
  });

  it('only sends write when a write session was asked for', async () => {
    nextResponse = { status: 200, payload: { ok: true, preview: { allowed: true } } };
    await previewIdaSqlSession({ binaryPath: 'F:\\a.exe' });
    expect(recorded[0].body).toEqual({ binaryPath: 'F:\\a.exe' });

    recorded.length = 0;
    await previewIdaSqlSession({ binaryPath: 'F:\\a.exe', mode: 'gui', write: true });
    expect(recorded[0].body).toEqual({ binaryPath: 'F:\\a.exe', mode: 'gui', write: true });
  });

  it('separates a needs-approval answer from a query result', async () => {
    nextResponse = {
      status: 200,
      payload: { ok: true, needsApproval: true, preview: { sql: 'UPDATE funcs SET name = 1' } },
    };
    const held = await runIdaSqlQuery({ sessionId: 'ida-1', sql: 'UPDATE funcs SET name = 1' });
    expect(held.query).toBeNull();
    expect(held.writePreview?.sql).toContain('UPDATE');

    nextResponse = { status: 200, payload: { ok: true, query: { sessionId: 'ida-1' } } };
    const ran = await runIdaSqlQuery({ sessionId: 'ida-1', sql: 'SELECT 1' });
    expect(ran.writePreview).toBeNull();
    expect(ran.query?.sessionId).toBe('ida-1');
  });

  it('returns the session, query, pid and detail an approval run produced', async () => {
    nextResponse = {
      status: 200,
      payload: { ok: true, launchedPid: 77, detail: 'IDA is starting.' },
    };
    const result = await runIdaSqlApproval('a'.repeat(64));
    expect(result.launchedPid).toBe(77);
    expect(result.detail).toContain('starting');
    expect(result.session).toBeNull();
    expect(result.query).toBeNull();
  });

  it('sends the session id as a query parameter on stop', async () => {
    nextResponse = { status: 200, payload: { ok: true } };
    await stopIdaSqlSession('ida-9');
    expect(recorded[0].method).toBe('DELETE');
    expect(recorded[0].url).toContain('sessionId=ida-9');
  });

  it('attaches with only the hints it was given', async () => {
    nextResponse = { status: 200, payload: { ok: true, session: { id: 'ida-2' } } };
    await attachIdaSqlGuiSession({});
    expect(recorded[0].body).toEqual({});
    recorded.length = 0;
    await attachIdaSqlGuiSession({ binaryPath: 'F:\\a.exe', port: 8137 });
    expect(recorded[0].body).toEqual({ binaryPath: 'F:\\a.exe', port: 8137 });
  });

  it('reads the idasql output tail for one session', async () => {
    nextResponse = { status: 200, payload: { ok: true, output: 'usage: idasql [options]' } };
    expect(await fetchIdaSqlSessionOutput('ida-1')).toContain('usage: idasql');
    expect(recorded[0].url).toContain('/session-output?sessionId=ida-1');
    // An absent field reads as empty rather than throwing.
    nextResponse = { status: 200, payload: { ok: true } };
    expect(await fetchIdaSqlSessionOutput('ida-1')).toBe('');
  });

  it('creates and deletes a standing grant', async () => {
    nextResponse = { status: 200, payload: { ok: true, grant: { id: 'g1' } } };
    expect((await createIdaSqlGrant({ rootId: 'bins' })).id).toBe('g1');
    recorded.length = 0;
    nextResponse = { status: 200, payload: { ok: true, removed: true } };
    await deleteIdaSqlGrant('g1');
    expect(recorded[0].method).toBe('DELETE');
    expect(recorded[0].url).toContain('grantId=g1');
  });
});

describe('fetchIdaSqlGuiWindow', () => {
  it('reads the remembered measurement, and reports "not yet" as not found', async () => {
    // The route answers null while the launch's own measurement is still waiting
    // for IDA to draw, so the UI has to be able to tell that apart from a real
    // answer without treating it as an error.
    nextResponse = { status: 200, payload: { ok: true, window: null, detail: '' } };
    const pending = await fetchIdaSqlGuiWindow(4242);
    expect(pending.found).toBe(false);
    expect(pending.detail).toBe('');
    expect(recorded[recorded.length - 1].url).toContain('/gui-window?pid=4242');

    nextResponse = {
      status: 200,
      payload: {
        ok: true,
        window: { found: true, flashed: true, left: 3645, top: 667 },
        detail: 'Its taskbar button is flashing and it opened on another monitor at 3645,667.',
      },
    };
    const settled = await fetchIdaSqlGuiWindow(4242);
    expect(settled.found).toBe(true);
    expect(settled.detail).toContain('3645,667');
  });

  it('does not invent a hit from a malformed body', async () => {
    for (const payload of [
      { ok: true },
      { ok: true, window: 'yes' },
      { ok: true, window: { found: 'true' } },
      { ok: true, window: null, detail: 42 },
    ]) {
      nextResponse = { status: 200, payload };
      const answer = await fetchIdaSqlGuiWindow(1);
      expect(answer.found, JSON.stringify(payload)).toBe(false);
      expect(typeof answer.detail).toBe('string');
    }
  });
});
