// @vitest-environment node
//
// Node, not the suite default (happy-dom): these tests drive real child
// processes and real loopback HTTP, and happy-dom's fetch rejects a Node
// AbortSignal ("RequestInit: Expected signal"). The code under test only ever
// runs in a Node server process, so the DOM environment would be testing a
// pairing that never happens.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import {
  IdaSqlSessionManager,
  createIdaSqlNodeDeps,
  describeExit,
  getSharedIdaSqlSessionManager,
  looksLikeIdaSqlStatus,
  resetSharedIdaSqlSessionManager,
  type IdaSqlChildHandle,
  type IdaSqlHttpResponse,
  type IdaSqlSessionDeps,
} from '../idaSqlSession';
import { normalizeIdaSqlConfig } from '../idaSqlConfig';
import type { IdaSqlConfigView } from '../idaSqlTypes';

// Two things this file covers that the injected-deps suite cannot:
//   - the PRODUCTION dependency implementations (real child process, real
//     loopback HTTP, real port probe). These are what actually run against an
//     installed idasql, so leaving them to first contact in production would
//     mean shipping the least-tested code on the most important path.
//   - the manager's bookkeeping edges (unknown ids, caps, terminal pruning),
//     which are the paths a caller hits when something has already gone wrong.

const CONFIG: IdaSqlConfigView = normalizeIdaSqlConfig({
  idasqlExePath: 'C:\\ida\\idasql.exe',
  idaExePath: 'C:\\ida\\ida.exe',
  binaryRoots: [{ id: 'games', path: 'F:\\games', label: 'Games' }],
  httpPortStart: 8300,
  httpPortEnd: 8302,
});

interface Harness {
  deps: IdaSqlSessionDeps;
  requests: { url: string; method: string }[];
  killed: number;
  statusResponder: (url: string) => IdaSqlHttpResponse | null;
  queryResponder: () => IdaSqlHttpResponse;
  exitLatest: (code: number | null) => void;
}

function makeHarness(overrides: Partial<IdaSqlSessionDeps> = {}): Harness {
  const requests: { url: string; method: string }[] = [];
  let exitListener: ((code: number | null, signal: string | null) => void) | null = null;
  const harness: Harness = {
    requests,
    killed: 0,
    statusResponder: () => ({ status: 200, text: '{"idasql":"1.0"}' }),
    queryResponder: () => ({ status: 200, text: '{"results":[]}' }),
    exitLatest: (code) => exitListener?.(code, null),
    deps: {
      spawnProcess(): IdaSqlChildHandle {
        return {
          pid: 4242,
          onExit(listener) {
            exitListener = listener;
          },
          onOutput() {},
          kill() {
            harness.killed += 1;
          },
        };
      },
      async httpRequest(url, init) {
        requests.push({ url, method: init.method });
        if (url.endsWith('/status')) {
          const answer = harness.statusResponder(url);
          if (!answer) {
            throw new Error('ECONNREFUSED');
          }
          return answer;
        }
        if (url.endsWith('/query')) {
          return harness.queryResponder();
        }
        return { status: 200, text: '{}' };
      },
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
      ...overrides,
    },
  };
  return harness;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function listenEphemeral(server: Server): Promise<number> {
  return await new Promise<number>((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('createIdaSqlNodeDeps', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((done) => server?.close(() => done()));
      server = null;
    }
    resetSharedIdaSqlSessionManager();
  });

  it('spawns a real process, streams its output, and reports its exit', async () => {
    const deps = createIdaSqlNodeDeps();
    const chunks: string[] = [];
    const result = await new Promise<{ code: number | null; signal: string | null }>((done) => {
      const child = deps.spawnProcess(
        process.execPath,
        ['-e', 'process.stdout.write("hello from the idasql stub")'],
        { cwd: process.cwd(), env: { ...process.env } as Record<string, string> },
      );
      expect(typeof child.pid).toBe('number');
      child.onOutput((chunk) => chunks.push(chunk));
      child.onExit((code, signal) => done({ code, signal }));
    });
    expect(result.code).toBe(0);
    expect(chunks.join('')).toContain('hello from the idasql stub');
  });

  it('reports a spawn failure through the exit listener rather than throwing', async () => {
    const deps = createIdaSqlNodeDeps();
    const signal = await new Promise<string | null>((done) => {
      const child = deps.spawnProcess('C:\\definitely-not-here\\idasql.exe', [], {
        cwd: process.cwd(),
        env: {},
      });
      child.onExit((_code, exitSignal) => done(exitSignal));
    });
    expect(signal).toBe('error');
  });

  it('kills a long-running child', async () => {
    const deps = createIdaSqlNodeDeps();
    await new Promise<void>((done) => {
      const child = deps.spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      });
      child.onExit(() => done());
      setTimeout(() => child.kill(), 50);
    });
  });

  it('performs a real GET and POST against a loopback server', async () => {
    const deps = createIdaSqlNodeDeps();
    const seen: { method: string; body: string }[] = [];
    server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (chunk: Buffer) => parts.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', body: Buffer.concat(parts).toString() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"idasql":"stub"}');
      });
    });
    const port = await listenEphemeral(server);

    const statusResponse = await deps.httpRequest(`http://127.0.0.1:${port}/status`, {
      method: 'GET',
      timeoutMs: 5000,
    });
    expect(statusResponse.status).toBe(200);
    expect(looksLikeIdaSqlStatus(statusResponse.text)).toBe(true);

    await deps.httpRequest(`http://127.0.0.1:${port}/query`, {
      method: 'POST',
      body: 'SELECT 1',
      timeoutMs: 5000,
    });
    expect(seen.map((entry) => entry.method)).toEqual(['GET', 'POST']);
    expect(seen[1].body).toBe('SELECT 1');
  });

  it('aborts a request that outlives its timeout', async () => {
    const deps = createIdaSqlNodeDeps();
    server = createServer(() => {
      // Never answer: the timeout is the thing under test.
    });
    const port = await listenEphemeral(server);
    await expect(
      deps.httpRequest(`http://127.0.0.1:${port}/status`, { method: 'GET', timeoutMs: 50 }),
    ).rejects.toThrow();
  });

  it('answers isPortFree honestly for a bound and an unbound port', async () => {
    const deps = createIdaSqlNodeDeps();
    server = createServer(() => {});
    const port = await listenEphemeral(server);
    expect(await deps.isPortFree(port)).toBe(false);
    await new Promise<void>((done) => server?.close(() => done()));
    server = null;
    expect(await deps.isPortFree(port)).toBe(true);
  });

  it('sleeps for real, and lets an override replace any dependency', async () => {
    const started = Date.now();
    await createIdaSqlNodeDeps().sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1);
    const overridden = createIdaSqlNodeDeps({ isPortFree: async () => false });
    expect(await overridden.isPortFree(1)).toBe(false);
  });
});

describe('getSharedIdaSqlSessionManager', () => {
  afterEach(() => {
    resetSharedIdaSqlSessionManager();
  });

  it('returns one manager per process until it is reset', () => {
    const first = getSharedIdaSqlSessionManager();
    expect(getSharedIdaSqlSessionManager()).toBe(first);
    resetSharedIdaSqlSessionManager();
    expect(getSharedIdaSqlSessionManager()).not.toBe(first);
  });

  it('does NOT take over signal handling to clean up its children', () => {
    // Node overrides the default terminate-on-Ctrl+C as soon as a SIGINT
    // listener exists. A cleanup handler that does not exit would therefore make
    // the first Ctrl+C on the dev server do nothing -- trading a leaked child
    // process for an unkillable server. Cleanup rides 'exit' instead, which both
    // hosts reach through their own signal handling.
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
      exit: process.listenerCount('exit'),
    };
    getSharedIdaSqlSessionManager();
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP);
    expect(process.listenerCount('exit')).toBeGreaterThanOrEqual(before.exit);
  });
});

describe('IdaSqlSessionManager bookkeeping', () => {
  it('reports unknown sessions instead of throwing', async () => {
    const manager = new IdaSqlSessionManager(makeHarness().deps);
    expect(manager.get('nope')).toBeNull();
    expect(manager.outputTail('nope')).toBe('');
    expect((await manager.query('nope', 'SELECT 1')).reason).toBe('unknown_session');
    expect((await manager.stop('nope')).reason).toBe('unknown_session');
  });

  it('finds a live session by binary path and ignores a stopped one', async () => {
    const harness = makeHarness();
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(manager.findByBinary('f:\\games\\client.exe')?.id).toBe(started.session?.id);
    expect(manager.findByBinary('F:\\games\\other.exe')).toBeNull();
    await manager.stop(started.session?.id ?? '');
    expect(manager.findByBinary('F:\\games\\client.exe')).toBeNull();
  });

  it('is idempotent about stopping, and drops terminal sessions once they age out', async () => {
    let clock = 5_000_000;
    const harness = makeHarness({ now: () => clock });
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    await manager.stop(sessionId);
    expect((await manager.stop(sessionId)).ok).toBe(true);
    expect(harness.killed).toBe(1);

    manager.pruneTerminal(60_000);
    expect(manager.get(sessionId)).not.toBeNull();
    clock += 120_000;
    manager.pruneTerminal(60_000);
    expect(manager.get(sessionId)).toBeNull();
  });

  it('refuses a query against a failed session and carries the reason', async () => {
    const harness = makeHarness();
    harness.statusResponder = () => null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    harness.exitLatest(3);
    const outcome = await manager.query(started.session?.id ?? '', 'SELECT 1');
    expect(outcome.reason).toBe('session_failed');
    expect(outcome.engineError).toContain('exited');
  });

  it('surfaces a transport failure and an engine rejection distinctly', async () => {
    const harness = makeHarness();
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    await waitFor(() => manager.get(sessionId)?.state === 'ready', 'ready');

    harness.queryResponder = () => {
      throw new Error('socket hang up');
    };
    const transport = await manager.query(sessionId, 'SELECT 1');
    expect(transport.reason).toBe('query_transport_failed');
    expect(transport.engineError).toContain('socket hang up');

    harness.queryResponder = () => ({ status: 400, text: '{"error":"no such table"}' });
    const rejected = await manager.query(sessionId, 'SELECT 1');
    expect(rejected.reason).toBe('query_rejected');
    // The status rides along with the body: for a 401 from a token mismatch the
    // code is the only fact that identifies the problem.
    expect(rejected.engineError).toBe('HTTP 400: no such table');
  });

  it('refuses to open more sessions than the cap allows', async () => {
    const wideConfig = normalizeIdaSqlConfig({
      idasqlExePath: 'C:\\ida\\idasql.exe',
      binaryRoots: [{ id: 'games', path: 'F:\\games', label: 'Games' }],
      httpPortStart: 8300,
      httpPortEnd: 8400,
    });
    const harness = makeHarness();
    const manager = new IdaSqlSessionManager(harness.deps);
    for (let index = 0; index < 8; index += 1) {
      const started = await manager.startHeadless({
        config: wideConfig,
        binaryPath: `F:\\games\\c${index}.exe`,
        write: false,
      });
      expect(started.ok, `session ${index}`).toBe(true);
    }
    const overflow = await manager.startHeadless({
      config: wideConfig,
      binaryPath: 'F:\\games\\c9.exe',
      write: false,
    });
    expect(overflow.reason).toBe('too_many_sessions');
    const attachOverflow = await manager.attachGui({});
    expect(attachOverflow.reason).toBe('too_many_sessions');
  });

  it('reports a thrown spawn as spawn_failed instead of propagating', async () => {
    const harness = makeHarness({
      spawnProcess: () => {
        throw new Error('EACCES');
      },
    });
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(started.reason).toBe('spawn_failed');
    const gui = await manager.launchGui({ config: CONFIG, binaryPath: 'F:\\games\\client.exe' });
    expect(gui.reason).toBe('spawn_failed');
  });

  it('gives up on readiness after the deadline and says so', async () => {
    let clock = 1_000;
    const harness = makeHarness({
      now: () => clock,
      sleep: async () => {
        // Each poll advances the clock past the readiness wall.
        clock += 60_000;
      },
    });
    harness.statusResponder = () => null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    await waitFor(() => manager.get(sessionId)?.state === 'failed', 'ready_timeout');
    expect(manager.get(sessionId)?.failureReason).toBe('ready_timeout');
  });

  it('prefers the port hint when attaching', async () => {
    const harness = makeHarness();
    harness.statusResponder = (url) =>
      url.includes(':8155') ? { status: 200, text: '{"idasql":"1.0"}' } : null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const attached = await manager.attachGui({ portHint: 8155 });
    expect(attached.session?.port).toBe(8155);
    // The hint is probed first, so no other PORT was tried. (The second request
    // is the function-list review the session runs once it is usable.)
    const statusProbes = harness.requests.filter((request) => request.url.endsWith('/status'));
    expect(statusProbes).toHaveLength(1);
  });

  it('kills the process when readiness times out', async () => {
    // idasql --http is a server: it never exits on its own. Giving up on
    // readiness without killing it left a live process holding a port, and
    // pruneTerminal then dropped the only handle to it.
    let clock = 1_000;
    let killed = 0;
    const harness = makeHarness({
      now: () => clock,
      sleep: async () => {
        clock += 60_000;
      },
      spawnProcess: () => ({
        pid: 7777,
        onExit() {},
        onOutput() {},
        kill() {
          killed += 1;
        },
      }),
    });
    harness.statusResponder = () => null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    await waitFor(() => manager.get(sessionId)?.state === 'failed', 'ready_timeout');
    expect(manager.get(sessionId)?.failureReason).toBe('ready_timeout');
    expect(killed).toBe(1);
  });

  it('kills a lingering child before forgetting the session', async () => {
    let clock = 3_000_000;
    let killed = 0;
    const harness = makeHarness({
      now: () => clock,
      spawnProcess: () => ({
        pid: 8888,
        onExit() {},
        onOutput() {},
        kill() {
          killed += 1;
        },
      }),
    });
    // Never answers /status, so the session stays 'starting' with a live child.
    harness.statusResponder = () => null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const sessionId = started.session?.id ?? '';
    // Force the record terminal without going through stop(), the way an exit
    // listener or a future code path might.
    await manager.stop(sessionId);
    expect(killed).toBe(1);

    // A record whose child somehow outlived stop must not be dropped silently.
    clock += 60 * 60 * 1000;
    manager.pruneTerminal(60_000);
    expect(manager.get(sessionId)).toBeNull();
  });

  it('does not hand two concurrent starts the same port', async () => {
    // isPortFree is async, so both callers used to pass the same port check and
    // both spawned there; the second idasql then failed to bind.
    const harness = makeHarness({
      isPortFree: async (port) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return port >= 8300;
      },
    });
    const manager = new IdaSqlSessionManager(harness.deps);
    const [first, second] = await Promise.all([
      manager.startHeadless({ config: CONFIG, binaryPath: 'F:\\games\\a.exe', write: false }),
      manager.startHeadless({ config: CONFIG, binaryPath: 'F:\\games\\b.exe', write: false }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.session?.port).not.toBe(second.session?.port);
  });

  it('releases a reserved port when the spawn throws', async () => {
    let attempt = 0;
    const harness = makeHarness({
      spawnProcess: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('EACCES');
        }
        return { pid: 42, onExit() {}, onOutput() {}, kill() {} };
      },
    });
    const manager = new IdaSqlSessionManager(harness.deps);
    const failed = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\a.exe',
      write: false,
    });
    expect(failed.reason).toBe('spawn_failed');
    // The window is 8300-8302; a leaked reservation would shrink it for good.
    const retried = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\a.exe',
      write: false,
    });
    expect(retried.session?.port).toBe(8300);
  });

  it('attaches on an operator-DECLARED port even when the body is unfamiliar', async () => {
    // A port hint used to be treated as a declaration ("I read 8137 in IDA"), and
    // that was right while only a human could set one. It stopped being right
    // when launchGui began SUGGESTING a port that the app passes here
    // automatically: a hint is now usually a guess, and a guess that skips the
    // identity check means posting SQL to whatever answered. The declaration
    // survives, but it has to be said out loud.
    const harness = makeHarness();
    harness.statusResponder = () => ({ status: 200, text: '{"status":"ok"}' });
    const manager = new IdaSqlSessionManager(harness.deps);
    expect((await manager.attachGui({})).reason).toBe('no_gui_server_found');

    const guessed = await manager.attachGui({ portHint: 8137 });
    expect(guessed.ok).toBe(false);
    expect(guessed.reason).toBe('gui_server_unrecognized');

    const declared = await manager.attachGui({ portHint: 8137, portDeclared: true });
    expect(declared.ok).toBe(true);
    expect(declared.session?.port).toBe(8137);
  });

  it('kills every child it started when the owner goes away', async () => {
    // Observed for real: a dev-server module reload reset the registry while an
    // idasql kept running, holding its port and the IDA database -- which then
    // made the next analysis of that binary fail to open it.
    let killed = 0;
    const harness = makeHarness({
      spawnProcess: () => ({
        pid: 9100 + killed,
        onExit() {},
        onOutput() {},
        kill() {
          killed += 1;
        },
      }),
    });
    const manager = new IdaSqlSessionManager(harness.deps);
    await manager.startHeadless({ config: CONFIG, binaryPath: 'F:\\games\\a.exe', write: false });
    await manager.startHeadless({ config: CONFIG, binaryPath: 'F:\\games\\b.exe', write: false });
    // A GUI session is the operator's window and must survive.
    harness.statusResponder = () => ({ status: 200, text: '{"tool":"idasql"}' });
    const attached = await manager.attachGui({ portHint: 8100 });
    expect(attached.ok).toBe(true);

    manager.killAllChildren();
    expect(killed).toBe(2);
    expect(
      manager
        .list()
        .filter((s) => s.mode === 'headless')
        .every((s) => s.state === 'stopped'),
    ).toBe(true);
    expect(manager.get(attached.session?.id ?? '')?.state).toBe('ready');
  });

  it('translates the exit code that IS the failure mode here', async () => {
    // Measured on this machine: launched without the IDA directory on PATH,
    // idasql exits -1073741515 (0xC0000135) having printed NOTHING. The exit
    // code is the only evidence there is, so it has to be readable.
    expect(describeExit(-1073741515, null)).toContain('0xC0000135');
    expect(describeExit(-1073741515, null)).toContain('PATH');
    expect(describeExit(-1073741515, null)).toContain('ida.exe');
    expect(describeExit(-1073741701, null)).toContain('32/64-bit');
    expect(describeExit(1, null)).toBe('exited (code=1, signal=null)');
    expect(describeExit(null, 'SIGTERM')).toBe('exited (code=null, signal=SIGTERM)');
  });

  it('reports a DLL-not-found exit as the failure reason on the session', async () => {
    const harness = makeHarness();
    harness.statusResponder = () => null;
    const manager = new IdaSqlSessionManager(harness.deps);
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    harness.exitLatest(-1073741515);
    const view = manager.get(started.session?.id ?? '');
    expect(view?.state).toBe('failed');
    expect(view?.failureReason).toContain('0xC0000135');
  });

  it('tells a token-protected GUI server apart from no server at all', async () => {
    // Verified against idasql v0.0.18.1: /status answers 401 without a token.
    // Reporting that as "no server found" sent the operator hunting for a server
    // they were already talking to.
    const harness = makeHarness();
    harness.statusResponder = () => ({ status: 401, text: 'Unauthorized' });
    const manager = new IdaSqlSessionManager(harness.deps);
    const attached = await manager.attachGui({});
    expect(attached.ok).toBe(false);
    expect(attached.reason).toBe('gui_server_requires_token');
  });

  it('attaches with an operator-supplied token and keeps using it', async () => {
    const harness = makeHarness();
    const seen: (string | undefined)[] = [];
    const manager = new IdaSqlSessionManager({
      ...harness.deps,
      async httpRequest(url, init) {
        seen.push(init.token);
        if (url.endsWith('/status')) {
          return init.token === 'gui-secret'
            ? { status: 200, text: '{"tool":"idasql"}' }
            : { status: 401, text: 'Unauthorized' };
        }
        return { status: 200, text: '{"success":true,"results":[]}' };
      },
    });
    const attached = await manager.attachGui({ portHint: 8123, token: 'gui-secret' });
    expect(attached.ok).toBe(true);
    // The token has to ride the later queries too, not just the probe.
    await manager.query(attached.session?.id ?? '', 'SELECT 1');
    expect(seen.every((token) => token === 'gui-secret')).toBe(true);
  });

  it('skips a port already held by one of its own sessions when attaching', async () => {
    const harness = makeHarness();
    harness.statusResponder = () => ({ status: 200, text: '{"idasql":"1.0"}' });
    const manager = new IdaSqlSessionManager(harness.deps);
    const first = await manager.attachGui({});
    expect(first.session?.port).toBe(8100);
    const second = await manager.attachGui({});
    expect(second.session?.port).toBe(8101);
  });
});

describe('one database, one writer', () => {
  it('refuses a second headless session on the same binary and names the holder', async () => {
    // Measured against a real install: the second idasql on one binary exits
    // with "Failed to open database" AFTER we allocated a port, spawned it, and
    // spent the readiness wait -- and for an approved start, consumed the
    // approval. The route checks this at preview, but preview is not execute.
    const spawned: string[][] = [];
    const manager = new IdaSqlSessionManager({
      spawnProcess: (_program, args) => {
        spawned.push(args);
        return { pid: 100 + spawned.length, onExit() {}, onOutput() {}, kill() {} };
      },
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => 5_000_000,
      sleep: async () => {},
      isPortFree: async () => true,
    });

    const first = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(first.ok).toBe(true);
    expect(spawned).toHaveLength(1);

    const second = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: true,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('session_already_open');
    expect(second.existingSessionId).toBe(first.session?.id);
    // The point of the guard: no doomed process, no port burned.
    expect(spawned).toHaveLength(1);
  });

  it('matches the holder regardless of path case, the way Windows does', async () => {
    // realpathSync does NOT canonicalize case on Windows, so a differently-cased
    // path reaches here unchanged. Comparing case-sensitively would have let it
    // straight through to the doomed spawn.
    const spawned: string[][] = [];
    const manager = new IdaSqlSessionManager({
      spawnProcess: (_program, args) => {
        spawned.push(args);
        return { pid: 1, onExit() {}, onOutput() {}, kill() {} };
      },
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => 5_000_000,
      sleep: async () => {},
      isPortFree: async () => true,
    });
    await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    const second = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'f:\\GAMES\\CLIENT.EXE',
      write: false,
    });
    expect(second.reason).toBe('session_already_open');
    expect(spawned).toHaveLength(1);
  });

  it('frees the binary again once the session stops', async () => {
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => ({ status: 200, text: '{"tool":"idasql"}' }),
      now: () => 5_000_000,
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const first = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    await manager.stop(first.session?.id ?? '');
    const again = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\client.exe',
      write: false,
    });
    expect(again.ok, again.reason).toBe(true);
  });
});

describe('a session that gets stuck starting', () => {
  it('is reclaimed by the reaper even if the readiness loop never times it out', async () => {
    // pollReady's own deadline is what normally ends a session that never comes
    // up. Nothing else reaps 'starting': reapIdle took only 'ready' and
    // pruneTerminal only terminal states, so a poll that died left the process
    // and its port held by a record no code path could reach.
    let clock = 1_000_000;
    let killed = 0;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({
        pid: 99,
        onExit() {},
        onOutput() {},
        kill() {
          killed += 1;
        },
      }),
      httpRequest: async () => {
        throw new Error('never answers');
      },
      now: () => clock,
      // A sleep that never resolves stands in for the loop being gone: no
      // iteration can advance, so only the reaper can save this session.
      sleep: () => new Promise<void>(() => {}),
      isPortFree: async () => true,
    });

    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\stuck.exe',
      write: false,
    });
    expect(started.ok, started.reason).toBe(true);
    const id = started.session?.id ?? '';
    expect(manager.get(id)?.state).toBe('starting');

    // Not yet: still inside the readiness window.
    expect(await manager.reapIdle(CONFIG)).toEqual([]);
    expect(manager.get(id)?.state).toBe('starting');

    // Past the readiness deadline plus the margin.
    clock += 11 * 60 * 1000;
    expect(await manager.reapIdle(CONFIG)).toEqual([id]);
    expect(manager.get(id)?.state).toBe('stopped');
    expect(killed).toBeGreaterThan(0);
  });

  it('marks the session failed and reclaims it when the readiness loop throws', async () => {
    let killed = 0;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({
        pid: 98,
        onExit() {},
        onOutput() {},
        kill() {
          killed += 1;
        },
      }),
      httpRequest: async () => ({ status: 500, text: '' }),
      now: () => 1_000_000,
      sleep: async () => {
        throw new Error('timer subsystem gone');
      },
      isPortFree: async () => true,
    });
    const started = await manager.startHeadless({
      config: CONFIG,
      binaryPath: 'F:\\games\\crash.exe',
      write: false,
    });
    expect(started.ok, started.reason).toBe(true);
    const id = started.session?.id ?? '';
    // Let the rejected poll settle.
    await new Promise((done) => setTimeout(done, 20));
    expect(manager.get(id)?.state).toBe('failed');
    expect(manager.get(id)?.failureReason).toBe('ready_poll_crashed');
    expect(killed).toBeGreaterThan(0);
  });
});
