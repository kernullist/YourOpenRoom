// @vitest-environment node
//
// The HTTP plumbing and the routes the workbench uses after a session exists.
// Node environment: this exercises real IncomingMessage-shaped streams and the
// fs-backed stores.
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

import {
  IDA_SQL_API_PREFIX,
  createIdaSqlMiddleware,
  getIdaSqlRoute,
  idaSqlPlugin,
  loadIdaSqlConfig,
  resolveIdaSqlRoute,
  saveIdaSqlConfig,
} from '../idaSqlPlugin';
import { ensureAoiHostBridgeToken, AOI_HOST_BRIDGE_AUTH_HEADER } from '../aoiHostBridgeAuth';
import {
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';
import {
  IdaSqlSessionManager,
  type IdaSqlChildHandle,
  type IdaSqlSessionDeps,
} from '../idaSqlSession';
import { normalizeIdaSqlConfig } from '../idaSqlConfig';
import { IDA_SQL_ANALYSIS_CAPABILITY } from '../idaSqlTypes';

const tempRoots: string[] = [];

interface Fixture {
  home: string;
  sessionsDir: string;
  configFile: string;
  binDir: string;
  binaryPath: string;
  token: string;
}

function makeFixture(): Fixture {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'ida-lab-mw-'));
  tempRoots.push(home);
  const sessionsDir = join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const binDir = join(home, 'binaries');
  fs.mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, 'client.exe');
  fs.writeFileSync(binaryPath, 'MZ');
  const idasqlPath = join(home, 'idasql.exe');
  fs.writeFileSync(idasqlPath, 'stub');
  const configFile = join(home, 'config.json');
  saveIdaSqlConfig(
    configFile,
    normalizeIdaSqlConfig({
      idasqlExePath: idasqlPath,
      binaryRoots: [{ id: 'bins', path: binDir, label: 'Binaries' }],
    }),
  );
  const token = ensureAoiHostBridgeToken(home, { generateToken: () => 'c'.repeat(64) }).token;
  saveAoiHostBridgeKillSwitchState(
    home,
    setAoiHostBridgeCapability(
      { version: 1, globalPanic: false, entries: {}, updatedAt: 0 },
      IDA_SQL_ANALYSIS_CAPABILITY,
      true,
      1000,
    ),
  );
  return { home, sessionsDir, configFile, binDir, binaryPath, token };
}

function makeManager(): { manager: IdaSqlSessionManager; statusOk: () => void } {
  let ok = true;
  const deps: IdaSqlSessionDeps = {
    spawnProcess(): IdaSqlChildHandle {
      return { pid: 1234, onExit() {}, onOutput() {}, kill() {} };
    },
    async httpRequest(url) {
      if (url.endsWith('/status')) {
        if (!ok) {
          throw new Error('ECONNREFUSED');
        }
        return { status: 200, text: '{"idasql":"1.0"}' };
      }
      return { status: 200, text: '{"results":[]}' };
    },
    now: () => Date.now(),
    sleep: async () => {},
    isPortFree: async () => true,
  };
  return {
    manager: new IdaSqlSessionManager(deps),
    statusOk: () => {
      ok = true;
    },
  };
}

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  res: ServerResponse;
}

function makeRequest(params: {
  method: string;
  url: string;
  body?: unknown;
  token?: string | null;
  remoteAddress?: string;
  rawBody?: string;
}): { req: IncomingMessage; send: () => void } {
  const emitter = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  const headers: Record<string, string> = {};
  if (params.token) {
    headers[AOI_HOST_BRIDGE_AUTH_HEADER] = params.token;
  }
  Object.assign(emitter, {
    method: params.method,
    url: params.url,
    headers,
    socket: { remoteAddress: params.remoteAddress ?? '127.0.0.1' },
    destroy: () => {},
  });
  const payload =
    params.rawBody !== undefined
      ? params.rawBody
      : params.body === undefined
        ? ''
        : JSON.stringify(params.body);
  return {
    req: emitter,
    send: () => {
      if (payload) {
        emitter.emit('data', Buffer.from(payload));
      }
      emitter.emit('end');
    },
  };
}

function makeResponse(onEnd: (result: FakeResponse) => void): FakeResponse {
  const result: FakeResponse = {
    status: 0,
    headers: {},
    body: '',
    res: null as unknown as ServerResponse,
  };
  result.res = {
    writeHead(status: number, headers?: Record<string, string>) {
      result.status = status;
      result.headers = headers ?? {};
      return result.res;
    },
    end(chunk?: string) {
      result.body = chunk ?? '';
      onEnd(result);
      return result.res;
    },
  } as unknown as ServerResponse;
  return result;
}

async function runMiddleware(
  fixture: Fixture,
  params: {
    method: string;
    url: string;
    body?: unknown;
    rawBody?: string;
    token?: string | null;
    remoteAddress?: string;
    trustLoopbackToken?: boolean;
  },
): Promise<{ handled: boolean; response: FakeResponse | null }> {
  const middleware = createIdaSqlMiddleware({
    configFile: fixture.configFile,
    sessionsDir: fixture.sessionsDir,
    openroomHome: fixture.home,
    ...(params.trustLoopbackToken === undefined
      ? {}
      : { trustLoopbackToken: params.trustLoopbackToken }),
  });
  return await new Promise((done) => {
    let settled = false;
    const response = makeResponse((result) => {
      if (!settled) {
        settled = true;
        done({ handled: true, response: result });
      }
    });
    const { req, send } = makeRequest(params);
    middleware(req, response.res, () => {
      if (!settled) {
        settled = true;
        done({ handled: false, response: null });
      }
    });
    send();
  });
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('createIdaSqlMiddleware', () => {
  it('passes an unrelated URL straight through', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, { method: 'GET', url: '/api/aoi-host/status' });
    expect(result.handled).toBe(false);
  });

  it('answers a GET, reading its params from the query string', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'GET',
      url: `${IDA_SQL_API_PREFIX}/browse?path=${encodeURIComponent(fixture.binDir)}`,
      token: fixture.token,
    });
    expect(result.response?.status).toBe(200);
    expect(result.response?.headers['Cache-Control']).toBe('no-store');
    const payload = JSON.parse(result.response?.body ?? '{}') as Record<string, unknown>;
    expect((payload.browse as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('answers a POST, reading its params from the JSON body', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'POST',
      url: `${IDA_SQL_API_PREFIX}/config`,
      body: { writeEnabled: true },
      token: fixture.token,
    });
    expect(result.response?.status).toBe(200);
    expect(loadIdaSqlConfig(fixture.configFile).writeEnabled).toBe(true);
  });

  it('rejects a caller without the token when loopback trust is off', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'GET',
      url: `${IDA_SQL_API_PREFIX}/sessions`,
    });
    expect(result.response?.status).toBe(401);
  });

  it('borrows the daemon token for a loopback caller when trust is on', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'GET',
      url: `${IDA_SQL_API_PREFIX}/sessions`,
      trustLoopbackToken: true,
    });
    expect(result.response?.status).toBe(200);
  });

  it('does not borrow the token for a non-loopback caller', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'GET',
      url: `${IDA_SQL_API_PREFIX}/sessions`,
      remoteAddress: '10.0.0.5',
      trustLoopbackToken: true,
    });
    expect(result.response?.status).toBe(401);
  });

  it('treats an unparseable body as empty rather than failing the request', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'POST',
      url: `${IDA_SQL_API_PREFIX}/query`,
      rawBody: 'not json at all',
      token: fixture.token,
    });
    // No sessionId in an empty body: the route refuses, but the server answered.
    expect(result.response?.status).toBe(404);
  });

  it('refuses a body over the size cap', async () => {
    const fixture = makeFixture();
    const result = await runMiddleware(fixture, {
      method: 'POST',
      url: `${IDA_SQL_API_PREFIX}/query`,
      rawBody: 'x'.repeat(300 * 1024),
      token: fixture.token,
    });
    // The oversized body is dropped, so the route sees {} and answers cleanly.
    expect(result.response?.status).toBe(404);
  });
});

describe('idaSqlPlugin', () => {
  it('registers the middleware on the dev server with loopback trust', () => {
    const fixture = makeFixture();
    const plugin = idaSqlPlugin({
      configFile: fixture.configFile,
      sessionsDir: fixture.sessionsDir,
      openroomHome: fixture.home,
    });
    expect(plugin.name).toBe('ida-sql');
    const used: unknown[] = [];
    const configureServer = plugin.configureServer as (server: {
      middlewares: { use: (fn: unknown) => void };
    }) => void;
    configureServer({ middlewares: { use: (fn) => used.push(fn) } });
    expect(used).toHaveLength(1);
    expect(typeof used[0]).toBe('function');
  });
});

describe('ida-sql routes: the rest of the surface', () => {
  async function call(
    fixture: Fixture,
    manager: IdaSqlSessionManager,
    method: string,
    route: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const result = await resolveIdaSqlRoute({
      method,
      route,
      body,
      token: fixture.token,
      openroomHome: fixture.home,
      configFile: fixture.configFile,
      now: Date.now(),
      manager,
    });
    return { status: result.status, payload: result.payload as Record<string, unknown> };
  }

  it('attaches to a GUI idasql server and then detaches it', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', {
      binaryPath: fixture.binaryPath,
      port: 8100,
    });
    expect(attached.status).toBe(200);
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);

    const listed = await call(fixture, manager, 'GET', '/sessions');
    expect((listed.payload.sessions as unknown[]).length).toBe(1);

    const stopped = await call(fixture, manager, 'DELETE', '/sessions', { sessionId });
    expect(stopped.status).toBe(200);
    const stoppedList = await call(fixture, manager, 'GET', '/sessions');
    expect(
      (stoppedList.payload.sessions as { state: string }[]).every(
        (session) => session.state === 'stopped',
      ),
    ).toBe(true);
  });

  it('reports a failed attach as a conflict, not a crash', async () => {
    const fixture = makeFixture();
    const deps: IdaSqlSessionDeps = {
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async () => {
        throw new Error('ECONNREFUSED');
      },
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
    };
    const result = await call(
      fixture,
      new IdaSqlSessionManager(deps),
      'POST',
      '/sessions/attach',
      {},
    );
    expect(result.status).toBe(409);
    expect(result.payload.error).toBe('no_gui_server_found');
  });

  it('reports an unknown session id on stop', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'DELETE', '/sessions', { sessionId: 'nope' });
    expect(result.status).toBe(404);
  });

  it('lists only IDA Lab approvals', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    await call(fixture, manager, 'POST', '/sessions/preview', { binaryPath: fixture.binaryPath });
    const approvals = await call(fixture, manager, 'GET', '/approvals');
    const rows = approvals.payload.approvals as { capability: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].capability).toBe(IDA_SQL_ANALYSIS_CAPABILITY);
  });

  it('serves the diagnostics tail for a session', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/session-output', { sessionId: 'nope' });
    expect(result.status).toBe(200);
    expect(result.payload.output).toBe('');
  });

  it('lists, creates and revokes standing grants', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    expect((await call(fixture, manager, 'GET', '/grants')).payload.grants).toEqual([]);
    const created = await call(fixture, manager, 'POST', '/grants', {
      rootId: 'bins',
      label: 'Binaries',
      ttlMs: 60_000,
      maxSessions: 2,
    });
    const grantId = String((created.payload.grant as Record<string, unknown>).id);
    expect((await call(fixture, manager, 'GET', '/grants')).payload.grants).toHaveLength(1);
    const removed = await call(fixture, manager, 'DELETE', '/grants', { grantId });
    expect(removed.payload.removed).toBe(true);
    expect((await call(fixture, manager, 'GET', '/grants')).payload.grants).toEqual([]);
  });

  it('rejects an unsupported method on a route that has one', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    expect((await call(fixture, manager, 'PUT', '/config')).status).toBe(405);
    expect((await call(fixture, manager, 'PUT', '/grants')).status).toBe(405);
  });

  it('answers an unknown route with 404', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    expect((await call(fixture, manager, 'GET', '/nope')).status).toBe(404);
  });

  it('rejects an empty and an oversized query before touching the session', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8100 });
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);
    expect((await call(fixture, manager, 'POST', '/query', { sessionId, sql: '' })).status).toBe(
      400,
    );
    const long = await call(fixture, manager, 'POST', '/query', {
      sessionId,
      sql: `SELECT '${'a'.repeat(20_001)}'`,
    });
    expect(long.payload.error).toBe('sql_too_long');
  });

  it('reports a browse target that is a file, not a directory', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/browse', { path: fixture.binaryPath });
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('not_a_directory');
  });

  it('reports a missing path rather than guessing', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/browse', {
      path: join(fixture.binDir, 'gone'),
    });
    expect(result.status).toBe(403);
    expect(result.payload.error).toBe('path_not_found');
  });

  it('exposes the health problems when nothing is configured yet', async () => {
    const fixture = makeFixture();
    saveIdaSqlConfig(fixture.configFile, normalizeIdaSqlConfig({}));
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/');
    const health = result.payload.health as { configured: boolean; problems: string[] };
    expect(health.configured).toBe(false);
    expect(health.problems.join(' ')).toContain('idasql_path_missing');
  });

  it('flags a configured idasql path that no longer exists', async () => {
    const fixture = makeFixture();
    saveIdaSqlConfig(
      fixture.configFile,
      normalizeIdaSqlConfig({
        idasqlExePath: join(fixture.home, 'moved-away.exe'),
        binaryRoots: [{ id: 'bins', path: fixture.binDir, label: 'Binaries' }],
      }),
    );
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/health');
    const health = result.payload.health as { idasqlPresent: boolean; problems: string[] };
    expect(health.idasqlPresent).toBe(false);
    expect(health.problems.join(' ')).toContain('idasql_not_found');
  });
});

describe('getIdaSqlRoute', () => {
  it('normalizes trailing slashes and rejects foreign prefixes', () => {
    expect(getIdaSqlRoute(`${IDA_SQL_API_PREFIX}/grants/`)).toBe('/grants');
    expect(getIdaSqlRoute('/api/ida-sqlx/grants')).toBeNull();
    expect(getIdaSqlRoute('/api/ida-sql')).toBe('/');
  });
});

describe('ida-sql execute paths', () => {
  async function call(
    fixture: Fixture,
    manager: IdaSqlSessionManager,
    method: string,
    route: string,
    body: Record<string, unknown> = {},
    now = Date.now(),
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    const result = await resolveIdaSqlRoute({
      method,
      route,
      body,
      token: fixture.token,
      openroomHome: fixture.home,
      configFile: fixture.configFile,
      now,
      manager,
    });
    return { status: result.status, payload: result.payload as Record<string, unknown> };
  }

  function withIdaExe(fixture: Fixture): string {
    const idaPath = join(fixture.home, 'ida.exe');
    fs.writeFileSync(idaPath, 'stub');
    const current = loadIdaSqlConfig(fixture.configFile);
    saveIdaSqlConfig(fixture.configFile, { ...current, idaExePath: idaPath });
    return idaPath;
  }

  it('launches the GUI on approval and tells the operator what to do next', async () => {
    const fixture = makeFixture();
    const idaPath = withIdaExe(fixture);
    const spawned: { program: string; args: string[] }[] = [];
    const manager = new IdaSqlSessionManager({
      spawnProcess: (program, args) => {
        spawned.push({ program, args });
        return { pid: 5150, onExit() {}, onOutput() {}, kill() {} };
      },
      httpRequest: async () => ({ status: 200, text: '{}' }),
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
    });

    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      mode: 'gui',
    });
    const fingerprint = String(
      (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );
    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(200);
    expect(ran.payload.launchedPid).toBe(5150);
    expect(String(ran.payload.detail)).toContain('.http start');
    expect(spawned[0].program).toBe(idaPath);
    expect(spawned[0].args).toEqual([fixture.binaryPath]);
    // A GUI launch does not register a session; attaching is a separate step.
    expect(manager.list()).toHaveLength(0);
  });

  it('reports a GUI launch failure instead of claiming IDA opened', async () => {
    const fixture = makeFixture();
    withIdaExe(fixture);
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => {
        throw new Error('EACCES');
      },
      httpRequest: async () => ({ status: 200, text: '{}' }),
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      mode: 'gui',
    });
    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: String(
        (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
      ),
    });
    expect(ran.status).toBe(409);
    expect(ran.payload.error).toBe('spawn_failed');
  });

  it('reports a headless start failure at execute time', async () => {
    const fixture = makeFixture();
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => {
        throw new Error('EACCES');
      },
      httpRequest: async () => ({ status: 200, text: '{}' }),
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: String(
        (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
      ),
    });
    expect(ran.status).toBe(409);
    expect(ran.payload.error).toBe('spawn_failed');
  });

  it('refuses an approval whose preview has expired', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const start = Date.now();
    const previewed = await call(
      fixture,
      manager,
      'POST',
      '/sessions/preview',
      { binaryPath: fixture.binaryPath },
      start,
    );
    const fingerprint = String(
      (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );
    // Past the 5 minute approval TTL: the pending action is swept, so the run has
    // nothing to execute and must not fall back to a fresh start.
    const ran = await call(
      fixture,
      manager,
      'POST',
      '/approvals/run',
      { approvalFingerprint: fingerprint },
      start + 6 * 60 * 1000,
    );
    expect(ran.status).toBe(404);
    expect(manager.list()).toHaveLength(0);
  });

  it('refuses a run with no fingerprint at all', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const ran = await call(fixture, manager, 'POST', '/approvals/run', {});
    expect(ran.status).toBe(400);
    expect(ran.payload.error).toBe('missing_fingerprint');
  });

  it('blocks a GUI preview while ida.exe is not configured', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      mode: 'gui',
    });
    expect((previewed.payload.preview as { blockReasons: string[] }).blockReasons).toContain(
      'ida_path_missing',
    );
  });

  it('blocks a preview whose target is a folder rather than a file', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binDir,
    });
    expect((previewed.payload.preview as { blockReasons: string[] }).blockReasons).toContain(
      'binary_not_found',
    );
  });

  it('detects idalib next to the IDA binary', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    expect(
      (
        (await call(fixture, manager, 'GET', '/health')).payload.health as {
          idalibPresent: boolean;
        }
      ).idalibPresent,
    ).toBe(false);
    fs.writeFileSync(join(fixture.home, 'idalib.dll'), 'stub');
    expect(
      (
        (await call(fixture, manager, 'GET', '/health')).payload.health as {
          idalibPresent: boolean;
        }
      ).idalibPresent,
    ).toBe(true);
  });

  it('caps a find at the match limit and says it capped', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    for (let index = 0; index < 70; index += 1) {
      fs.writeFileSync(join(fixture.binDir, `capped_${index}.dll`), 'MZ');
    }
    const result = await call(fixture, manager, 'GET', '/browse', { find: 'capped_' });
    const browse = result.payload.browse as { entries: unknown[]; truncated: boolean };
    expect(browse.entries.length).toBe(60);
    expect(browse.truncated).toBe(true);
  });

  it('searches inside one subtree when a path is given', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const nested = join(fixture.binDir, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(join(nested, 'nested_target.dll'), 'MZ');
    const result = await call(fixture, manager, 'GET', '/browse', {
      find: 'nested_target',
      path: nested,
      depth: 1,
    });
    const browse = result.payload.browse as { entries: { name: string }[]; rootId: string };
    expect(browse.entries.map((entry) => entry.name)).toEqual(['nested_target.dll']);
    expect(browse.rootId).toBe('bins');
  });

  it('refuses a find rooted outside the registered roots', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const outside = join(fixture.home, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const result = await call(fixture, manager, 'GET', '/browse', {
      find: 'anything',
      path: outside,
    });
    expect(result.status).toBe(403);
  });

  it('refuses a find whose path is a file', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/browse', {
      find: 'client',
      path: fixture.binaryPath,
    });
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('not_a_directory');
  });

  it('reaps a session idle past the configured timeout on the next request', async () => {
    const fixture = makeFixture();
    const current = loadIdaSqlConfig(fixture.configFile);
    saveIdaSqlConfig(fixture.configFile, { ...current, sessionIdleTimeoutMs: 60_000 });
    let clock = 2_000_000;
    let killed = 0;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({
        pid: 4242,
        onExit() {},
        onOutput() {},
        kill() {
          killed += 1;
        },
      }),
      httpRequest: async () => ({ status: 200, text: '{"idasql":"1.0"}' }),
      now: () => clock,
      sleep: async () => {},
      isPortFree: async () => true,
    });

    const previewed = await call(
      fixture,
      manager,
      'POST',
      '/sessions/preview',
      { binaryPath: fixture.binaryPath },
      clock,
    );
    await call(
      fixture,
      manager,
      'POST',
      '/approvals/run',
      {
        approvalFingerprint: String(
          (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
        ),
      },
      clock,
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (manager.list()[0]?.state === 'ready') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(manager.list()[0]?.state).toBe('ready');

    // Still inside the window: nothing is reclaimed.
    clock += 30_000;
    await call(fixture, manager, 'GET', '/sessions', {}, clock);
    expect(manager.list()[0]?.state).toBe('ready');

    // Past it: the process is reclaimed rather than left holding a port forever.
    clock += 60_000;
    const after = await call(fixture, manager, 'GET', '/sessions', {}, clock);
    const sessions = after.payload.sessions as { state: string; failureReason: string }[];
    expect(sessions[0].state).toBe('stopped');
    expect(sessions[0].failureReason).toBe('idle_timeout');
    expect(killed).toBe(1);
  });

  it('offers a parent link only while the parent is still inside a root', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const nested = join(fixture.binDir, 'deep');
    fs.mkdirSync(nested, { recursive: true });

    const atRoot = await call(fixture, manager, 'GET', '/browse', { path: fixture.binDir });
    expect((atRoot.payload.browse as { parentPath: string }).parentPath).toBe('');

    const inside = await call(fixture, manager, 'GET', '/browse', { path: nested });
    expect((inside.payload.browse as { parentPath: string }).parentPath).toBe(fixture.binDir);
  });
});
