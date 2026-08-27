import { beforeEach, describe, expect, it } from 'vitest';
import {
  IdaSqlSessionManager,
  looksLikeIdaSqlStatus,
  parseIdaSqlQueryResponse,
  type IdaSqlChildHandle,
  type IdaSqlHttpResponse,
  type IdaSqlSessionDeps,
} from '../idaSqlSession';
import { normalizeIdaSqlConfig } from '../idaSqlConfig';
import type { IdaSqlConfigView } from '../idaSqlTypes';

const CONFIG: IdaSqlConfigView = normalizeIdaSqlConfig({
  idasqlExePath: 'C:\\ida\\idasql.exe',
  idaExePath: 'C:\\ida\\ida.exe',
  binaryRoots: [{ id: 'games', path: 'F:\\games', label: 'Games' }],
  httpPortStart: 8300,
  httpPortEnd: 8302,
});

interface SpawnCall {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface Harness {
  deps: IdaSqlSessionDeps;
  spawns: SpawnCall[];
  requests: { url: string; method: string; body?: string }[];
  killed: number;
  /** Set the /status answer for the next probes. */
  statusResponder: (url: string) => IdaSqlHttpResponse | null;
  queryResponder: (url: string, body?: string) => IdaSqlHttpResponse;
  exitLatest: (code: number | null) => void;
  emitOutput: (chunk: string) => void;
}

function makeHarness(overrides: Partial<IdaSqlSessionDeps> = {}): Harness {
  const spawns: SpawnCall[] = [];
  const requests: { url: string; method: string; body?: string }[] = [];
  let killed = 0;
  let exitListener: ((code: number | null, signal: string | null) => void) | null = null;
  let outputListener: ((chunk: string) => void) | null = null;

  const harness: Harness = {
    spawns,
    requests,
    killed,
    statusResponder: () => ({ status: 200, text: '{"idasql":"1.0"}' }),
    queryResponder: () => ({ status: 200, text: '{"results":[]}' }),
    exitLatest: (code) => exitListener?.(code, null),
    emitOutput: (chunk) => outputListener?.(chunk),
    deps: {
      spawnProcess(program, args, options): IdaSqlChildHandle {
        spawns.push({ program, args, cwd: options.cwd, env: options.env });
        return {
          pid: 4242 + spawns.length,
          onExit(listener) {
            exitListener = listener;
          },
          onOutput(listener) {
            outputListener = listener;
          },
          kill() {
            killed += 1;
            harness.killed = killed;
          },
        };
      },
      async httpRequest(url, init) {
        requests.push({
          url,
          method: init.method,
          ...(init.body === undefined ? {} : { body: init.body }),
        });
        if (url.endsWith('/status')) {
          const answer = harness.statusResponder(url);
          if (!answer) {
            throw new Error('ECONNREFUSED');
          }
          return answer;
        }
        if (url.endsWith('/query')) {
          return harness.queryResponder(url, init.body);
        }
        return { status: 200, text: '{}' };
      },
      now: () => Date.now(),
      sleep: async () => {
        // Immediate: the readiness loop must not make a test wait real seconds.
      },
      isPortFree: async () => true,
      ...overrides,
    },
  };
  return harness;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('parseIdaSqlQueryResponse', () => {
  it('reads the documented envelope', () => {
    const parsed = parseIdaSqlQueryResponse(
      JSON.stringify({
        statement_count: 1,
        results: [{ columns: ['name', 'ea'], rows: [['main', 4096]] }],
      }),
    );
    expect(parsed.resultSets).toHaveLength(1);
    expect(parsed.resultSets[0].columns).toEqual(['name', 'ea']);
    expect(parsed.resultSets[0].rows[0]).toEqual(['main', '4096']);
  });

  it('accepts row objects and infers the columns', () => {
    const parsed = parseIdaSqlQueryResponse(
      JSON.stringify({ results: [{ rows: [{ name: 'main', ea: 4096 }] }] }),
    );
    expect(parsed.resultSets[0].columns).toEqual(['name', 'ea']);
    expect(parsed.resultSets[0].rows[0]).toEqual(['main', '4096']);
  });

  it('accepts a bare array of rows', () => {
    const parsed = parseIdaSqlQueryResponse(JSON.stringify([{ name: 'main' }]));
    expect(parsed.resultSets[0].rows[0]).toEqual(['main']);
  });

  it('surfaces a non-JSON answer as an engine error instead of throwing', () => {
    const parsed = parseIdaSqlQueryResponse('near "SELCT": syntax error');
    expect(parsed.resultSets).toHaveLength(0);
    expect(parsed.engineError).toContain('syntax error');
  });

  it('carries an error field through', () => {
    const parsed = parseIdaSqlQueryResponse(JSON.stringify({ error: 'no such table: fncs' }));
    expect(parsed.engineError).toBe('no such table: fncs');
  });

  it('treats an empty body as an empty result, not an error', () => {
    expect(parseIdaSqlQueryResponse('  ')).toEqual({ resultSets: [], engineError: '' });
  });
});

describe('looksLikeIdaSqlStatus', () => {
  it('accepts an idasql-shaped answer', () => {
    expect(looksLikeIdaSqlStatus('{"idasql":"1.0"}')).toBe(true);
    expect(looksLikeIdaSqlStatus('{"database":"client.i64"}')).toBe(true);
  });

  it('rejects an unrelated local server', () => {
    expect(looksLikeIdaSqlStatus('<html>Grafana</html>')).toBe(false);
    expect(looksLikeIdaSqlStatus('{"prometheus":true}')).toBe(false);
    expect(looksLikeIdaSqlStatus('')).toBe(false);
  });

  it('rejects the generic health-check shapes half of localhost answers with', () => {
    // 'status' and 'db' were once accepted as evidence, which made every dev
    // server on 8100-8199 a candidate to receive the operator SQL.
    expect(looksLikeIdaSqlStatus('{"status":"ok"}')).toBe(false);
    expect(looksLikeIdaSqlStatus('{"status":"UP","db":"connected"}')).toBe(false);
    expect(looksLikeIdaSqlStatus('{"validation":"ida is a substring here"}')).toBe(false);
    // And still accepts something that is actually idasql-shaped.
    expect(looksLikeIdaSqlStatus('{"input_file":"client.exe","tables":31}')).toBe(true);
  });
});

describe('IdaSqlSessionManager headless lifecycle', () => {
  let harness: Harness;
  let manager: IdaSqlSessionManager;

  beforeEach(() => {
    harness = makeHarness();
    manager = new IdaSqlSessionManager(harness.deps);
  });

  it('spawns idasql with the argument vector and the IDA directory on PATH', async () => {
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(started.ok).toBe(true);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0].program).toBe('C:\\ida\\idasql.exe');
    const args = harness.spawns[0].args;
    expect(args.slice(0, 6)).toEqual([
      '-s',
      'F:\\games\\client.exe',
      '--http',
      '8300',
      '--bind',
      '127.0.0.1',
    ]);
    // Every headless session gets its own bearer token; without one the SQL
    // server answers any local caller.
    expect(args).toContain('--token');
    expect(args[args.indexOf('--token') + 1]).toMatch(/^[0-9a-f]{16,}$/);
    // The IDA directory, not idasql's own, is what goes on PATH.
    expect(harness.spawns[0].cwd).toBe('C:\\ida');
    expect(harness.spawns[0].env.PATH?.startsWith('C:\\ida')).toBe(true);
  });

  it('reports the session ready once /status answers', async () => {
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(started.session?.state).toBe('starting');
    await waitFor(() => manager.get(started.session?.id ?? '')?.state === 'ready', 'ready');
  });

  it('marks the session failed when the process exits early', async () => {
    harness.statusResponder = () => null;
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    harness.emitOutput('license error');
    harness.exitLatest(1);
    const view = manager.get(started.session?.id ?? '');
    expect(view?.state).toBe('failed');
    expect(view?.failureReason).toContain('exited');
    expect(manager.outputTail(started.session?.id ?? '')).toContain('license error');
  });

  it('allocates a distinct port per live session and refuses past the window', async () => {
    for (let index = 0; index < 3; index += 1) {
      const started = await manager.startHeadless({
        config: CONFIG,
        binaryPath: `F:\\games\\c${index}.exe`,
        write: false,
      });
      expect(started.ok).toBe(true);
    }
    const ports = harness.spawns.map((call) => call.args[3]);
    expect(new Set(ports).size).toBe(3);
    const overflow = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\c4.exe',
      write: false,
    });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe('no_free_port');
  });

  it('refuses to start without a configured idasql path', async () => {
    const started = await manager.startHeadless({
      config: normalizeIdaSqlConfig({}),
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(started.reason).toBe('idasql_path_missing');
  });

  it('queries a ready session and refuses one that is still analyzing', async () => {
    harness.statusResponder = () => null;
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    const early = await manager.query(sessionId, 'SELECT 1');
    expect(early.ok).toBe(false);
    expect(early.reason).toBe('session_starting');

    harness.statusResponder = () => ({ status: 200, text: '{"idasql":"1.0"}' });
    await waitFor(() => manager.get(sessionId)?.state === 'ready', 'ready');
    harness.queryResponder = () => ({
      status: 200,
      text: JSON.stringify({ results: [{ columns: ['n'], rows: [[1]] }] }),
    });
    const outcome = await manager.query(sessionId, 'SELECT 1');
    expect(outcome.ok).toBe(true);
    expect(outcome.resultSets[0].rows[0]).toEqual(['1']);
    expect(manager.get(sessionId)?.queryCount).toBe(1);
  });

  it('shuts a headless session down over HTTP and then kills it', async () => {
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    await waitFor(() => manager.get(sessionId)?.state === 'ready', 'ready');
    await manager.stop(sessionId);
    expect(harness.requests.some((request) => request.url.endsWith('/shutdown'))).toBe(true);
    expect(harness.killed).toBe(1);
    expect(manager.get(sessionId)?.state).toBe('stopped');
  });

  it('reaps a session idle past the timeout', async () => {
    let clock = 1_000_000;
    const idleHarness = makeHarness({ now: () => clock });
    const idleManager = new IdaSqlSessionManager(idleHarness.deps);
    const started = await idleManager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    await waitFor(() => idleManager.get(sessionId)?.state === 'ready', 'ready');
    clock += CONFIG.sessionIdleTimeoutMs + 1;
    const stopped = await idleManager.reapIdle(CONFIG);
    expect(stopped).toEqual([sessionId]);
    expect(idleManager.get(sessionId)?.failureReason).toBe('idle_timeout');
  });
});

describe('IdaSqlSessionManager GUI mode', () => {
  it('launches ida.exe with the binary and records the pid', async () => {
    const harness = makeHarness();
    const manager = new IdaSqlSessionManager(harness.deps);
    const launched = await manager.launchGui({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
    });
    expect(launched.ok).toBe(true);
    expect(harness.spawns[0].program).toBe('C:\\ida\\ida.exe');
    expect(harness.spawns[0].args).toEqual(['F:\\games\\client.exe']);
  });

  it('refuses GUI mode without an ida.exe path', async () => {
    const harness = makeHarness();
    const manager = new IdaSqlSessionManager(harness.deps);
    const launched = await manager.launchGui({
      config: normalizeIdaSqlConfig({ idasqlExePath: 'C:\\ida\\idasql.exe' }),
      binaryPath: 'F:\\games\\client.exe',
    });
    expect(launched.reason).toBe('ida_path_missing');
  });

  it('attaches to the first port that answers like idasql', async () => {
    const harness = makeHarness();
    harness.statusResponder = (url) =>
      url.includes(':8137') ? { status: 200, text: '{"idasql":"1.0"}' } : null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const attached = await manager.attachGui({ binaryPathHint: 'F:\\games\\client.exe' });
    expect(attached.ok).toBe(true);
    expect(attached.session?.port).toBe(8137);
    expect(attached.session?.mode).toBe('gui');
    // A GUI process belongs to the operator: no pid means stop() can never kill it.
    expect(attached.session?.pid).toBeNull();
  });

  it('skips a port serving something that is not idasql', async () => {
    const harness = makeHarness();
    harness.statusResponder = () => ({ status: 200, text: '<html>Jenkins</html>' });
    const manager = new IdaSqlSessionManager(harness.deps);
    const attached = await manager.attachGui({});
    expect(attached.ok).toBe(false);
    expect(attached.reason).toBe('no_gui_server_found');
  });

  it('detaches a GUI session without killing anything', async () => {
    const harness = makeHarness();
    harness.statusResponder = (url) =>
      url.includes(':8100') ? { status: 200, text: '{"idasql":"1.0"}' } : null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const attached = await manager.attachGui({});
    await manager.stop(attached.session?.id ?? '');
    expect(harness.killed).toBe(0);
    expect(harness.requests.some((request) => request.url.endsWith('/shutdown'))).toBe(false);
  });
});

describe('the reaper against a query in flight', () => {
  it('leaves a session alone while the engine still has its query', async () => {
    // The bug: lastUsedAt is stamped when a query RETURNS, so for the whole
    // duration of a slow query the session read as idle. The minimum
    // configurable idle timeout (60s) is below QUERY_TIMEOUT_MS (150s), so a
    // heavy query plus any concurrent request -- the UI polls the session list
    // -- killed the process mid-query.
    const gate: { release: (() => void) | null } = { release: null };
    const killed: number[] = [];
    let clock = 1_000_000;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({
        pid: 4242,
        onExit() {},
        onOutput() {},
        kill() {
          killed.push(4242);
        },
      }),
      async httpRequest(url, init) {
        // Only the operator's own query blocks. attachGui issues a function
        // review query of its own first, and blocking that never gets us to a
        // ready session.
        if (url.endsWith('/query') && String(init.body ?? '').includes('decompile')) {
          await new Promise<void>((done) => {
            gate.release = done;
          });
        }
        if (url.endsWith('/query')) {
          return { status: 200, text: '{"success":true,"results":[]}' };
        }
        return { status: 200, text: '{"tool":"idasql"}' };
      },
      now: () => clock,
      sleep: async () => {},
      isPortFree: async () => true,
    });

    const attached = await manager.attachGui({ portHint: 8200 });
    const sessionId = attached.session?.id ?? '';
    expect(sessionId).not.toBe('');

    const inFlight = manager.query(sessionId, 'SELECT decompile(addr) FROM funcs');
    // Give the query a turn to register itself before the clock jumps.
    await Promise.resolve();
    await Promise.resolve();

    // Now stall past the idle floor, the way a heavy query does.
    clock += 90 * 1000;
    const config = { ...CONFIG, sessionIdleTimeoutMs: 60 * 1000 };
    const reaped = await manager.reapIdle(config);
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
    expect(manager.get(sessionId)?.state).toBe('ready');

    gate.release?.();
    const result = await inFlight;
    expect(result.ok).toBe(true);

    // Once it lets go, the clock restarts from the release -- so it is NOT
    // instantly due even though 90s of stall already elapsed.
    expect(await manager.reapIdle(config)).toEqual([]);
    clock += 61 * 1000;
    expect(await manager.reapIdle(config)).toEqual([sessionId]);
  });

  it('releases the hold when the query fails, so the session can still be reaped', async () => {
    let clock = 2_000_000;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      async httpRequest(url) {
        if (url.endsWith('/query')) {
          throw new Error('socket hang up');
        }
        return { status: 200, text: '{"tool":"idasql"}' };
      },
      now: () => clock,
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const attached = await manager.attachGui({ portHint: 8201 });
    const sessionId = attached.session?.id ?? '';
    const failed = await manager.query(sessionId, 'SELECT 1');
    expect(failed.reason).toBe('query_transport_failed');

    const config = { ...CONFIG, sessionIdleTimeoutMs: 60 * 1000 };
    clock += 61 * 1000;
    expect(await manager.reapIdle(config)).toEqual([sessionId]);
  });
});
