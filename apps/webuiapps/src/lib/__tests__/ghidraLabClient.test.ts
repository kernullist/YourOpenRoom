// @vitest-environment node
//
// The browser client is thin, but the thin part is load-bearing: it is what turns
// the route's error CODES into the messages the app shows. A client that swallows
// `preflight_jdk` into "request failed" would undo the whole point of having a
// preflight that names what it found.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapGhidraPython,
  browseGhidraPath,
  cancelGhidraRun,
  fetchGhidraApprovals,
  fetchGhidraLabConfig,
  fetchGhidraLabHealth,
  fetchGhidraLedger,
  fetchGhidraReport,
  fetchGhidraRuns,
  fetchGhidraSessionOutput,
  fetchGhidraSessions,
  findGhidraBinaries,
  previewGhidraReport,
  previewGhidraSession,
  runGhidraApproval,
  runGhidraQuery,
  saveGhidraLabConfigRemote,
  stopGhidraSession,
} from '../ghidraLabClient';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let responder: (url: string) => { status?: number; payload: unknown } = () => ({
  payload: { ok: true },
});

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const answer = responder(String(url));
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      status: answer.status ?? 200,
      json: async () => answer.payload,
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('error envelope', () => {
  it('throws the route error code verbatim so the app can explain it', async () => {
    responder = () => ({ payload: { ok: false, error: 'preflight_jdk' } });
    await expect(fetchGhidraLabHealth()).rejects.toThrow('preflight_jdk');
  });

  it('appends the detail when the route supplied one', async () => {
    responder = () => ({
      payload: { ok: false, error: 'bootstrap_failed', detail: 'pip exited 1' },
    });
    await expect(bootstrapGhidraPython()).rejects.toThrow('bootstrap_failed: pip exited 1');
  });

  it('falls back to the deny reasons when there is no detail', async () => {
    responder = () => ({
      payload: {
        ok: false,
        error: 'blocked',
        denyReasons: ['capability_disabled', 'global_panic'],
      },
    });
    await expect(fetchGhidraSessions()).rejects.toThrow(/capability_disabled, global_panic/);
  });

  it('reports the HTTP status when the body is not the expected envelope', async () => {
    responder = () => ({ status: 502, payload: 'not json at all' });
    await expect(fetchGhidraLabConfig()).rejects.toThrow('HTTP 502');
  });

  it('survives a body that is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          status: 500,
          json: async () => {
            throw new Error('invalid json');
          },
        }) as unknown as Response,
    );
    await expect(fetchGhidraRuns()).rejects.toThrow('HTTP 500');
  });
});

describe('request shapes', () => {
  it('sends config patches as a POST body', async () => {
    responder = () => ({ payload: { ok: true, config: { maxMemMb: 8192 } } });
    const config = await saveGhidraLabConfigRemote({ maxMemMb: 8192 });
    expect(config.maxMemMb).toBe(8192);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ config: { maxMemMb: 8192 } });
  });

  it('puts browse and find parameters in the query string', async () => {
    responder = () => ({ payload: { ok: true, browse: { path: '', entries: [] } } });
    await browseGhidraPath('C:\\bins');
    expect(calls[0].url).toContain('path=');
    await findGhidraBinaries({ find: 'client', path: 'C:\\bins', depth: 4 });
    expect(calls[1].url).toContain('find=client');
    expect(calls[1].url).toContain('depth=4');
  });

  it('omits absent optional parameters rather than sending empties', async () => {
    responder = () => ({ payload: { ok: true, browse: { path: '', entries: [] } } });
    await browseGhidraPath();
    expect(calls[0].url).not.toContain('?');
    await findGhidraBinaries({ find: 'x' });
    expect(calls[1].url).not.toContain('path=');
    expect(calls[1].url).not.toContain('depth=');
  });

  it('sends a DELETE with its id in the query string', async () => {
    responder = () => ({ payload: { ok: true } });
    await stopGhidraSession('s1');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('sessionId=s1');
    await cancelGhidraRun('grun-1');
    expect(calls[1].url).toContain('runId=grun-1');
  });

  it('forwards query sub-commands and arguments', async () => {
    responder = () => ({
      payload: { ok: true, query: { rows: [], rowCount: 0, mcpTool: 'list_imports' } },
    });
    await runGhidraQuery({ sessionId: 's1', kind: 'imports', args: { binary_name: 'x.exe' } });
    expect(calls[0].body).toEqual({
      sessionId: 's1',
      kind: 'imports',
      args: { binary_name: 'x.exe' },
    });
  });

  it('defaults query args to an empty object', async () => {
    responder = () => ({ payload: { ok: true, query: { rows: [] } } });
    await runGhidraQuery({ sessionId: 's1', kind: 'metadata' });
    expect((calls[0].body as { args: unknown }).args).toEqual({});
  });
});

describe('responses', () => {
  it('reads a session preview', async () => {
    responder = () => ({ payload: { ok: true, preview: { allowed: true, blockReasons: [] } } });
    expect((await previewGhidraSession('C:\\bins\\a.exe')).allowed).toBe(true);
    expect((await previewGhidraReport('s1')).allowed).toBe(true);
  });

  it('returns whichever half of an approval result came back', async () => {
    responder = () => ({ payload: { ok: true, session: { id: 's1' } } });
    expect((await runGhidraApproval('f')).session?.id).toBe('s1');
    responder = () => ({ payload: { ok: true, runId: 'grun-1' } });
    expect((await runGhidraApproval('f')).runId).toBe('grun-1');
    responder = () => ({ payload: { ok: true } });
    expect(await runGhidraApproval('f')).toEqual({});
  });

  it('keeps only pending approvals, and only well-formed ones', async () => {
    responder = () => ({
      payload: {
        ok: true,
        approvals: [
          {
            approvalFingerprint: 'a',
            capability: 'os_ghidra_analysis',
            targetSummary: 'x',
            state: 'pending',
            expiresAt: 1,
          },
          {
            approvalFingerprint: 'b',
            capability: 'os_ghidra_analysis',
            targetSummary: 'y',
            state: 'consumed',
          },
          { capability: 'os_ghidra_analysis', state: 'pending' },
          'not an object',
        ],
      },
    });
    const approvals = await fetchGhidraApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approvalFingerprint).toBe('a');
  });

  it('returns empty rather than throwing when a list field is missing', async () => {
    responder = () => ({ payload: { ok: true } });
    expect(await fetchGhidraSessions()).toEqual([]);
    expect(await fetchGhidraRuns()).toEqual([]);
    expect(await fetchGhidraApprovals()).toEqual([]);
    expect(await fetchGhidraReport('r')).toBe('');
    expect(await fetchGhidraLedger('r')).toBeNull();
  });

  it('reads a report and a ledger from the artifact route', async () => {
    responder = (url) =>
      url.includes('ledger')
        ? { payload: { ok: true, ledger: { runId: 'r', anchors: [] } } }
        : { payload: { ok: true, report: '# Report' } };
    expect(await fetchGhidraReport('r')).toBe('# Report');
    expect((await fetchGhidraLedger('r'))?.runId).toBe('r');
  });

  it('reads session output and the engine tool list', async () => {
    responder = () => ({
      payload: { ok: true, output: 'boot log', engineTools: ['list_imports'] },
    });
    const out = await fetchGhidraSessionOutput('s1');
    expect(out.output).toBe('boot log');
    expect(out.engineTools).toEqual(['list_imports']);

    responder = () => ({ payload: { ok: true } });
    expect((await fetchGhidraSessionOutput('s1')).engineTools).toEqual([]);
  });

  it('reads the bootstrap detail back', async () => {
    responder = () => ({ payload: { ok: true, config: {}, detail: 'installed 0.5.0' } });
    expect((await bootstrapGhidraPython()).detail).toBe('installed 0.5.0');
  });
});
